\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-handover-schedule-title-runtime.sql
\ir ../../supabase/migrations/20261021112432_avoid_wecom_schedule_current_key_nested_loop.sql
\ir ../../supabase/migrations/20260822000400_fix_jiaowubao_schedule_snapshot_completion_hash.sql
alter function public.complete_jiaowubao_open_api_schedule_snapshot_ingest(text,uuid,text) set statement_timeout='110s';

do $copy_reader_before_metadata$
begin
  execute replace(pg_get_functiondef('public.read_wecom_handover_schedule_input(text,text,text[])'::regprocedure),
    'public.read_wecom_handover_schedule_input(', 'internal.fixture_wecom_read_before_metadata(');
end;
$copy_reader_before_metadata$;
revoke all on function internal.fixture_wecom_read_before_metadata(text,text,text[]) from public, anon, authenticated, service_role;

alter table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs disable trigger guard_jiaowubao_open_api_schedule_snapshot_run;
update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r set canonical_rows_sha256=(
  select 'sha256:'||encode(extensions.digest(coalesce(string_agg(i.item::text,'' order by i.page_index,i.item_index),''),'sha256'),'hex')
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i where i.run_id=r.id) where state='complete';
alter table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs enable trigger guard_jiaowubao_open_api_schedule_snapshot_run;
update internal.jiaowubao_open_api_schedule_snapshot_current c set rows_sha256=r.canonical_rows_sha256
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id=c.run_id;
do $fixture_real_hashes$
begin
  execute replace(pg_get_functiondef('internal.fixture_wecom_schedule_run(text,text,text,timestamptz,jsonb)'::regprocedure),
    $old$canonical_rows_sha256='sha256:'||repeat('d',64)$old$,
    $new$canonical_rows_sha256=(select 'sha256:'||encode(extensions.digest(coalesce(string_agg(i.item::text,'' order by i.page_index,i.item_index),''),'sha256'),'hex') from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i where i.run_id=run)$new$);
end;
$fixture_real_hashes$;

create temporary table fixture_metadata_before as
  select public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']) as input,
    (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) as state,
    (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) as sources,
    (select jsonb_agg(to_jsonb(r) order by id) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r) as runs,
    (select jsonb_agg(to_jsonb(i) order by run_id,source_key) from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i) as items,
    (select jsonb_agg(to_jsonb(e) order by source_message_id) from internal.wecom_handover_schedule_evidence e) as evidence;

\ir ../../supabase/migrations/20261021122214_cache_wecom_schedule_run_metadata.sql

do $metadata_backfill_and_parity$
declare before_row fixture_metadata_before%rowtype; result jsonb; input jsonb; mode text; before_count bigint; prior_epoch bigint; loops integer := 0;
begin
  select * into before_row from fixture_metadata_before;
  begin
    perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
    raise exception 'metadata_missing_receipt_accepted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'wecom_schedule_run_metadata_missing' then raise; end if;
  end;
  foreach before_count in array array[0,5,null]::bigint[] loop
    begin
      perform internal.backfill_wecom_schedule_run_metadata(before_count::integer);
      raise exception 'metadata_invalid_backfill_batch_accepted';
    exception when invalid_parameter_value then null; end;
  end loop;
  select revision into prior_epoch from internal.wecom_handover_schedule_epoch where singleton;
  loop
    result := internal.backfill_wecom_schedule_run_metadata(4);
    loops := loops+1;
    if (result->>'builtRuns')::integer not between 0 and 4 or loops>100 then raise exception 'metadata_backfill_not_bounded'; end if;
    exit when result->>'remainingRuns'='0';
  end loop;
  if internal.backfill_wecom_schedule_run_metadata(1) <> '{"builtRuns":0,"builtItems":0,"remainingRuns":0}'::jsonb
      or (select revision from internal.wecom_handover_schedule_epoch where singleton) <> prior_epoch then
    raise exception 'metadata_backfill_not_idempotent_or_changed_epoch';
  end if;
  foreach mode in array array['force_custom_plan','force_generic_plan'] loop
    perform set_config('plan_cache_mode',mode,true);
    input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
    if (input-'inputRevision') is distinct from (before_row.input-'inputRevision') or (input->>'inputRevision')::bigint <> (before_row.input->>'inputRevision')::bigint+1 then raise exception 'metadata_complete_input_changed_%',mode; end if;
  end loop;
  if (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) is distinct from before_row.state
      or (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) is distinct from before_row.sources
      or (select jsonb_agg(to_jsonb(r) order by id) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r) is distinct from before_row.runs
      or (select jsonb_agg(to_jsonb(i) order by run_id,source_key) from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i) is distinct from before_row.items
      or (select jsonb_agg(to_jsonb(e) order by source_message_id) from internal.wecom_handover_schedule_evidence e) is distinct from before_row.evidence then
    raise exception 'metadata_backfill_modified_native_evidence';
  end if;
  select count(*) into before_count from internal.wecom_schedule_run_metadata;
  perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
  if (select count(*) from internal.wecom_schedule_run_metadata) <> before_count then raise exception 'metadata_reader_wrote_cache'; end if;
  if not(select proconfig @> array['search_path=""','statement_timeout=12s','work_mem=32MB','enable_indexscan=off']
      from pg_proc where oid='public.read_wecom_handover_schedule_input(text,text,text[])'::regprocedure)
      or not(select proconfig @> array['statement_timeout=13s','work_mem=32MB']
      from pg_proc where oid='public.save_wecom_handover_schedule_evidence(text,text,text,jsonb,text)'::regprocedure) then
    raise exception 'metadata_rpc_budgets_changed';
  end if;
  if exists(select 1 from unnest(array['public','anon','authenticated','service_role']) role where
      has_table_privilege(role,'internal.wecom_schedule_run_metadata','select,insert,update,delete')
      or has_function_privilege(role,'internal.refresh_wecom_schedule_run_metadata(uuid)','execute')
      or has_function_privilege(role,'internal.backfill_wecom_schedule_run_metadata(integer)','execute')
      or has_function_privilege(role,'internal.invalidate_wecom_schedule_item_metadata()','execute')
      or has_function_privilege(role,'internal.index_wecom_schedule_run_metadata()','execute')
      or has_function_privilege(role,'internal.wecom_schedule_trial_rule_fingerprint()','execute')
      or has_function_privilege(role,'internal.wecom_schedule_trial_keys_valid(jsonb,jsonb)','execute')
      or has_function_privilege(role,'internal.assert_wecom_schedule_metadata_write_isolation()','execute'))
      or not(select relrowsecurity from pg_class where oid='internal.wecom_schedule_run_metadata'::regclass) then
    raise exception 'metadata_private_privileges_exposed';
  end if;
  begin
    perform public.read_wecom_handover_schedule_input('bad','retained-current',array['bot:title-only:one']);
    raise exception 'metadata_secret_guard_missing';
  exception when insufficient_privilege then null; end;
end;
$metadata_backfill_and_parity$;

begin isolation level repeatable read read only;
do $metadata_reader_preserves_read_only_repeatable_read$
begin
  if public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one'])
      is distinct from internal.fixture_wecom_read_before_metadata('wecom-fixture-secret','retained-current',array['bot:title-only:one']) then
    raise exception 'metadata_read_only_repeatable_read_input_changed';
  end if;
end;
$metadata_reader_preserves_read_only_repeatable_read$;
rollback;

begin;
do $metadata_receipt_and_late_record_validation$
declare current_run uuid; changed_run uuid; kind text;
begin
  select run_id into current_run from internal.jiaowubao_open_api_schedule_snapshot_current where api_source_key='jwb-open-api-schedule';
  foreach kind in array array['missing','count-low','count-high','revision','hash','fewer-keys','more-keys'] loop
    begin
      if kind='missing' then delete from internal.wecom_schedule_run_metadata where run_id=current_run;
      elsif kind='count-low' then update internal.wecom_schedule_run_metadata set item_count=greatest(item_count-1,0) where run_id=current_run;
      elsif kind='count-high' then update internal.wecom_schedule_run_metadata set item_count=item_count+1 where run_id=current_run;
      elsif kind='revision' then update internal.wecom_schedule_run_metadata set revision=revision||'-stale' where run_id=current_run;
      elsif kind='hash' then update internal.wecom_schedule_run_metadata set canonical_rows_sha256='sha256:'||repeat('f',64) where run_id=current_run;
      elsif kind='fewer-keys' then update internal.wecom_schedule_run_metadata set source_dates=source_dates-(select key from jsonb_each_text(source_dates) limit 1),
        trial_source_keys=trial_source_keys-(select key from jsonb_each_text(source_dates) limit 1) where run_id=current_run;
      else update internal.wecom_schedule_run_metadata set source_dates=source_dates||'{"synthetic-extra-key":"2099-04-01"}' where run_id=current_run; end if;
      perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
      raise exception 'metadata_bad_receipt_accepted_%',kind;
    exception when object_not_in_prerequisite_state then
      if sqlerrm <> 'wecom_schedule_run_metadata_missing' then raise; end if;
    end;
  end loop;
  select id into changed_run from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs where revision='title-only-history';
  if changed_run is null then raise exception 'metadata_fixture_historical_run_missing'; end if;
  update internal.wecom_schedule_run_metadata set source_dates=(source_dates-'jwb-open-api:schedule:title-valid')
      ||'{"jwb-open-api:schedule:synthetic-absent":"2099-01-02"}',
    trial_source_keys=(trial_source_keys-'jwb-open-api:schedule:title-valid')||'{"jwb-open-api:schedule:synthetic-absent":true}' where run_id=changed_run;
  insert into internal.wecom_schedule_latest_complete_source(source_key,run_id,completed_at)
    select 'jwb-open-api:schedule:synthetic-absent',id,completed_at from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs where id=changed_run;
  begin
    perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
    raise exception 'metadata_late_source_record_missing_accepted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'wecom_schedule_source_record_missing' then raise; end if;
  end;
end;
$metadata_receipt_and_late_record_validation$;
rollback;

begin;
do $metadata_incremental_and_zero_row_coverage$
declare run uuid; input jsonb; row jsonb;
begin
  run := internal.fixture_wecom_schedule_run('metadata-empty-day','2099-01-04','2099-01-04','2100-01-01T00:00:00Z','[]');
  if not exists(select 1 from internal.wecom_schedule_run_metadata where run_id=run and item_count=0 and source_dates='{}') then
    raise exception 'metadata_zero_row_receipt_missing';
  end if;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
  if not exists(select 1 from jsonb_array_elements(input->'coverage') c where (c->>'startsAt')::timestamptz='2099-01-04T00:00:00+11'::timestamptz) then
    raise exception 'metadata_zero_row_coverage_missing';
  end if;
end;
$metadata_incremental_and_zero_row_coverage$;
rollback;

begin;
do $metadata_invalid_date_completion_remains_accepted$
declare kind text; run uuid; row jsonb;
begin
  foreach kind in array array['missing','null','empty','duplicate-invalid','nontrial-unselected'] loop
    begin
      row := internal.fixture_wecom_history_record('metadata-invalid-'||kind,'not-a-date');
      if kind='missing' then row:=row#-'{record,dated}'; elsif kind='null' then row:=jsonb_set(row,'{record,dated}','null');
      elsif kind='empty' then row:=jsonb_set(row,'{record,dated}','""');
      elsif kind='nontrial-unselected' then row:=jsonb_set(row,'{record,course_title}','"English"'); end if;
      run:=internal.fixture_wecom_schedule_run('metadata-invalid-'||kind,'2099-01-04','2099-01-04','2100-01-01T00:00:00Z',
        jsonb_build_array(internal.fixture_wecom_history_record('metadata-valid-unselected-'||kind,'2099-06-01'),row));
      if not exists(select 1 from internal.wecom_schedule_run_metadata where run_id=run) then raise exception 'metadata_invalid_date_completion_was_rejected'; end if;
      perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
      raise exception 'metadata_invalid_selected_raw_date_accepted_%',kind;
    exception when invalid_parameter_value then
      if sqlerrm <> 'wecom_schedule_invalid_source_date' then raise; end if;
    end;
  end loop;
end;
$metadata_invalid_date_completion_remains_accepted$;
rollback;

begin;
do $metadata_nontrial_missing_latest_and_owner_mutation$
declare run uuid; row jsonb; prior_epoch bigint; item internal.jiaowubao_open_api_schedule_snapshot_ingest_items%rowtype;
begin
  row:=internal.fixture_wecom_schedule_record('metadata-nontrial','2099-01-04');
  run:=internal.fixture_wecom_schedule_run('metadata-nontrial','2099-01-04','2099-01-04','2100-01-01T00:00:00Z',jsonb_build_array(row));
  delete from internal.wecom_schedule_latest_complete_source where source_key=row->>'sourceKey';
  begin
    perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
    raise exception 'metadata_nontrial_missing_latest_cache_accepted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'wecom_schedule_latest_source_missing' then raise; end if;
  end;
  select revision into prior_epoch from internal.wecom_handover_schedule_epoch where singleton;
  select * into item from internal.jiaowubao_open_api_schedule_snapshot_ingest_items where run_id=run limit 1;
  item.source_key:='jwb-open-api:schedule:metadata-owner-append';item.item_index:=item.item_index+1;
  item.item:=jsonb_set(item.item,'{sourceKey}',to_jsonb(item.source_key));item.canonical_json:=item.item::text;
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items select item.*;
  if exists(select 1 from internal.wecom_schedule_run_metadata where run_id=run)
      or (select revision from internal.wecom_handover_schedule_epoch where singleton) <> prior_epoch+1
      or public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ops Admin',true) <> '[]' then
    raise exception 'metadata_owner_append_failed_to_invalidate_receipt_and_evidence';
  end if;
  begin
    perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
    raise exception 'metadata_owner_append_stale_cache_accepted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'wecom_schedule_run_metadata_missing' then raise; end if;
  end;
end;
$metadata_nontrial_missing_latest_and_owner_mutation$;
rollback;

begin;
do $metadata_invalid_trial_validation$
declare kind text; row jsonb;
begin
  foreach kind in array array['invalid-trial-clock','unknown-participants'] loop
    begin
      row:=internal.fixture_wecom_history_record('metadata-rejected-'||kind,'2099-01-04');
      if kind='invalid-trial-clock' then row:=jsonb_set(row,'{record,time_start}','"17:00"');
      else row:=jsonb_set(jsonb_set(row,'{record,course_title}','"English"'),'{record,stu_list}','null'); end if;
      perform internal.fixture_wecom_schedule_run('metadata-rejected-'||kind,'2099-01-04','2099-01-04','2100-01-01T00:00:00Z',jsonb_build_array(row));
      perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
      raise exception 'metadata_invalid_trial_was_filtered_%',kind;
    exception when invalid_parameter_value then
      if sqlerrm <> 'wecom_schedule_invalid_source_event' then raise; end if;
    end;
  end loop;
end;
$metadata_invalid_trial_validation$;
rollback;

begin;
alter table internal.jiaowubao_open_api_schedule_snapshot_ingest_items disable trigger guard_jiaowubao_open_api_schedule_snapshot_item;
alter table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs disable trigger guard_jiaowubao_open_api_schedule_snapshot_run;
do $metadata_item_and_run_mutations$
declare run uuid; row jsonb; prior_epoch bigint; kind text;
begin
  foreach kind in array array['update','delete','run-change','missing-receipt-append'] loop
    begin
      row:=internal.fixture_wecom_history_record('metadata-mutation-'||kind,'2099-01-04');
      run:=internal.fixture_wecom_schedule_run('metadata-mutation-'||kind,'2099-01-04','2099-01-04','2100-01-01T00:00:00Z',jsonb_build_array(row));
      if kind='missing-receipt-append' then delete from internal.wecom_schedule_run_metadata where run_id=run; end if;
      select revision into prior_epoch from internal.wecom_handover_schedule_epoch where singleton;
      if kind='update' then update internal.jiaowubao_open_api_schedule_snapshot_ingest_items set item=item||'{"synthetic":true}' where run_id=run;
      elsif kind='delete' then delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_items where run_id=run;
      elsif kind='run-change' then update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set payload_sha256='sha256:'||repeat('f',64) where id=run;
      else insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items(run_id,page_index,item_index,source_key,canonical_json,item_sha256,item)
        select run_id,page_index,1,source_key||'-appended',canonical_json,item_sha256,item from internal.jiaowubao_open_api_schedule_snapshot_ingest_items where run_id=run; end if;
      if exists(select 1 from internal.wecom_schedule_run_metadata where run_id=run)
          or (select revision from internal.wecom_handover_schedule_epoch where singleton) <> prior_epoch+1 then
        raise exception 'metadata_mutation_did_not_invalidate_%',kind;
      end if;
      if kind='update' then
        perform internal.refresh_wecom_schedule_run_metadata(run);
        begin
          perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
          raise exception 'metadata_changed_raw_hash_accepted_after_rebuild';
        exception when object_not_in_prerequisite_state then
          if sqlerrm <> 'wecom_schedule_run_metadata_missing' then raise; end if;
        end;
      end if;
      raise exception using errcode='P0002',message='metadata_fixture_mutation_rollback';
    exception when no_data_found then null; end;
  end loop;
end;
$metadata_item_and_run_mutations$;
rollback;

begin;
do $metadata_current_outside_range_raw_dates_are_not_parsed$
declare run uuid; audit uuid; input jsonb; row jsonb;
begin
  row:=internal.fixture_wecom_schedule_record('title-valid','not-a-date');
  run:=internal.fixture_wecom_schedule_run('metadata-current-outside-invalid','2099-04-01','2099-04-01','2098-01-01T00:00:00Z',jsonb_build_array(row));
  audit:=internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  update internal.jiaowubao_open_api_schedule_snapshot_current set run_id=run,revision='metadata-current-outside-invalid',
    row_count=1,rows_sha256=(select canonical_rows_sha256 from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs where id=run),
    payload_sha256='sha256:'||repeat('e',64),audit_id=audit where api_source_key='jwb-open-api-schedule';
  input:=public.read_wecom_handover_schedule_input('wecom-fixture-secret','metadata-current-outside-invalid',array['bot:title-only:one']);
  if exists(select 1 from jsonb_array_elements(input->'events') e where e->>'eventId'='jwb-open-api:schedule:title-valid')
      or exists(select 1 from jsonb_array_elements(input->'coverage') c where not(c->>'historical')::boolean) then
    raise exception 'metadata_current_outside_range_keys_or_date_semantics_changed';
  end if;
end;
$metadata_current_outside_range_raw_dates_are_not_parsed$;
rollback;

begin isolation level repeatable read;
do $metadata_backfill_rejects_stale_transaction_snapshot$
begin
  begin
    perform internal.backfill_wecom_schedule_run_metadata(1);
    raise exception 'metadata_backfill_accepted_repeatable_read';
  exception when invalid_transaction_state then
    if sqlerrm <> 'wecom_schedule_metadata_requires_read_committed' then raise; end if;
  end;
end;
$metadata_backfill_rejects_stale_transaction_snapshot$;
rollback;

begin;
do $metadata_get_rejects_missing_receipts_without_json_scan$
declare input jsonb; entry jsonb; run uuid;
begin
  input:=public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
  entry:=internal.fixture_wecom_title_entry(input);
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(entry));
  if jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ops Admin',true)) <> 1 then
    raise exception 'metadata_get_fixture_has_no_current_evidence';
  end if;
  select id into run from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs
    where api_source_key='jwb-open-api-schedule' and state='complete' order by completed_at,id limit 1;
  delete from internal.wecom_schedule_run_metadata where run_id=run;
  if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ops Admin',true) <> '[]' then
    raise exception 'metadata_get_accepted_missing_complete_run_receipt';
  end if;
  delete from internal.wecom_schedule_run_metadata;
  if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ops Admin',true) <> '[]' then
    raise exception 'metadata_get_accepted_empty_receipt_table';
  end if;
end;
$metadata_get_rejects_missing_receipts_without_json_scan$;
rollback;

begin isolation level repeatable read;
do $metadata_all_write_paths_reject_repeatable_read$
declare run uuid;
begin
  select run_id into run from internal.jiaowubao_open_api_schedule_snapshot_current where api_source_key='jwb-open-api-schedule';
  begin
    perform internal.refresh_wecom_schedule_run_metadata(run);
    raise exception 'metadata_refresh_accepted_repeatable_read';
  exception when invalid_transaction_state then
    if sqlerrm <> 'wecom_schedule_metadata_requires_read_committed' then raise; end if;
  end;
  begin
    insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items(run_id,page_index,item_index,source_key,canonical_json,item_sha256,item)
      select run_id,page_index,99,source_key||'-rr',canonical_json,item_sha256,item
      from internal.jiaowubao_open_api_schedule_snapshot_ingest_items where run_id=run limit 1;
    raise exception 'metadata_item_invalidation_accepted_repeatable_read';
  exception when invalid_transaction_state then
    if sqlerrm <> 'wecom_schedule_metadata_requires_read_committed' then raise; end if;
  end;
  begin
    perform internal.fixture_wecom_schedule_run('metadata-rr-run','2099-01-04','2099-01-04','2100-01-01T00:00:00Z','[]');
    raise exception 'metadata_run_index_accepted_repeatable_read';
  exception when invalid_transaction_state then
    if sqlerrm <> 'wecom_schedule_metadata_requires_read_committed' then raise; end if;
  end;
end;
$metadata_all_write_paths_reject_repeatable_read$;
rollback;

begin;
do $metadata_trial_keys_and_rule_fingerprint$
declare run uuid; kind text; prior_fingerprint text; result jsonb; prior_epoch bigint; input jsonb; entry jsonb;
begin
  select run_id into run from internal.jiaowubao_open_api_schedule_snapshot_current where api_source_key='jwb-open-api-schedule';
  foreach kind in array array['false','null','string','extra-key'] loop
    begin
      update internal.wecom_schedule_run_metadata set trial_source_keys=case kind
        when 'false' then jsonb_build_object((select key from jsonb_each_text(source_dates) limit 1),false)
        when 'null' then jsonb_build_object((select key from jsonb_each_text(source_dates) limit 1),null)
        when 'string' then jsonb_build_object((select key from jsonb_each_text(source_dates) limit 1),'true')
        else '{"not-a-source-key":true}'::jsonb end where run_id=run;
      raise exception 'metadata_invalid_trial_map_accepted_%',kind;
    exception when check_violation then null; end;
  end loop;
  input:=public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
  entry:=internal.fixture_wecom_title_entry(input);
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(entry));
  if jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ops Admin',true)) <> 1 then
    raise exception 'metadata_rule_fixture_has_no_current_evidence';
  end if;
  select revision into prior_epoch from internal.wecom_handover_schedule_epoch where singleton;
  prior_fingerprint:=internal.wecom_schedule_trial_rule_fingerprint();
  execute replace(pg_get_functiondef('internal.is_wecom_schedule_trial_record(jsonb)'::regprocedure),
    'select case when','select case when false then false when');
  if internal.wecom_schedule_trial_rule_fingerprint()=prior_fingerprint then raise exception 'metadata_rule_fingerprint_did_not_change'; end if;
  if public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ops Admin',true) <> '[]' then
    raise exception 'metadata_changed_rule_left_old_get_evidence_visible';
  end if;
  begin
    perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
    raise exception 'metadata_prior_trial_rule_cache_accepted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'wecom_schedule_run_metadata_missing' then raise; end if;
  end;
  loop
    result:=internal.backfill_wecom_schedule_run_metadata(4);
    exit when result->>'remainingRuns'='0';
  end loop;
  if exists(select 1 from internal.wecom_schedule_run_metadata where trial_rule_fingerprint<>internal.wecom_schedule_trial_rule_fingerprint()) then
    raise exception 'metadata_changed_trial_rule_cache_not_rebuilt';
  end if;
  if (select revision from internal.wecom_handover_schedule_epoch where singleton) <= prior_epoch
      or public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ops Admin',true) <> '[]' then
    raise exception 'metadata_rule_backfill_revived_stale_get_evidence';
  end if;
  input:=public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:title-only:one']);
  entry:=internal.fixture_wecom_title_entry(input);
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(entry));
  if jsonb_array_length(public.read_wecom_handover_schedule_evidence('wecom-fixture-secret',array['bot:title-only:one'],'Ops Admin',true)) <> 1 then
    raise exception 'metadata_rule_refresh_did_not_restore_current_evidence';
  end if;
end;
$metadata_trial_keys_and_rule_fingerprint$;
rollback;

begin;
do $metadata_wide_current_run_full_parity$
declare run uuid; audit uuid; rows jsonb; input jsonb; prior_input jsonb; mode text;
begin
  select jsonb_agg(case when n%5=0 then internal.fixture_wecom_history_record('metadata-wide-'||n,('2098-12-31'::date+n)::text)
    else internal.fixture_wecom_schedule_record('metadata-wide-'||n,('2098-12-31'::date+n)::text) end order by n)
    into rows from generate_series(0,92) n;
  run:=internal.fixture_wecom_schedule_run('metadata-wide-current','2098-12-31','2099-04-02','2100-01-01T00:00:00Z',rows);
  audit:=internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  update internal.jiaowubao_open_api_schedule_snapshot_current c set run_id=run,revision='metadata-wide-current',row_count=93,
    rows_sha256=r.canonical_rows_sha256,payload_sha256=r.payload_sha256,audit_id=audit
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id=run and c.api_source_key='jwb-open-api-schedule';
  foreach mode in array array['force_custom_plan','force_generic_plan'] loop
    perform set_config('plan_cache_mode',mode,true);
    prior_input:=internal.fixture_wecom_read_before_metadata('wecom-fixture-secret','metadata-wide-current',array['bot:title-only:one']);
    input:=public.read_wecom_handover_schedule_input('wecom-fixture-secret','metadata-wide-current',array['bot:title-only:one']);
    if input is distinct from prior_input or jsonb_array_length(input->'coverage')<>65
        or exists(select 1 from jsonb_array_elements(input->'events') e where e->>'sourceRunId'<>run::text) then
      raise exception 'metadata_wide_current_full_input_changed_%',mode;
    end if;
  end loop;
end;
$metadata_wide_current_run_full_parity$;
rollback;

begin;
do $metadata_empty_current_full_parity$
declare run uuid; audit uuid; input jsonb; prior_input jsonb;
begin
  run:=internal.fixture_wecom_schedule_run('metadata-empty-current','2098-12-31','2099-04-02','2100-01-01T00:00:00Z','[]');
  audit:=internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  update internal.jiaowubao_open_api_schedule_snapshot_current c set run_id=run,revision='metadata-empty-current',row_count=0,
    rows_sha256=r.canonical_rows_sha256,payload_sha256=r.payload_sha256,audit_id=audit
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r where r.id=run and c.api_source_key='jwb-open-api-schedule';
  prior_input:=internal.fixture_wecom_read_before_metadata('wecom-fixture-secret','metadata-empty-current',array['bot:title-only:one']);
  input:=public.read_wecom_handover_schedule_input('wecom-fixture-secret','metadata-empty-current',array['bot:title-only:one']);
  if input is distinct from prior_input or input->'events'<>'[]'::jsonb or jsonb_array_length(input->'coverage')<>65
      or not exists(select 1 from internal.wecom_schedule_run_metadata where run_id=run and item_count=0 and source_dates='{}') then
    raise exception 'metadata_empty_current_full_input_changed';
  end if;
end;
$metadata_empty_current_full_parity$;
rollback;

create function internal.fixture_wecom_metadata_stage(p_label text,p_rows integer)
returns uuid language plpgsql as $$
declare run uuid; revision text; observed text; page integer; rows jsonb; audit uuid;
begin
  revision:='sha256:'||encode(extensions.digest(p_label,'sha256'),'hex');
  select c.revision into observed from internal.jiaowubao_open_api_schedule_snapshot_current c where c.api_source_key='jwb-open-api-schedule';
  audit:=internal.append_operational_contract_audit('fixture.metadata-staging','Ops Admin','fixture',p_label,'{}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(api_source_key,revision,query,expected_page_count,
    expected_row_count,expected_current_revision,external_manifest_sha256,source_metadata,staged_by,staging_audit_id)
    values('jwb-open-api-schedule',revision,jsonb_build_object('start','2099-01-01','end','2099-04-03','limit',100,'order','asc'),
      (p_rows+99)/100,p_rows,observed,revision,'{}','Ops Admin',audit) returning id into run;
  for page in 0..((p_rows+99)/100)-1 loop
    select jsonb_agg(jsonb_set(internal.fixture_wecom_history_record(p_label||'-'||n,('2099-01-01'::date+n%93)::text),
      '{record}',(internal.fixture_wecom_history_record(p_label||'-'||n,('2099-01-01'::date+n%93)::text)->'record')-'stu_list') order by n)
      into rows from generate_series(page*100,least(p_rows-1,page*100+99)) n;
    perform public.stage_jiaowubao_open_api_schedule_snapshot_page('wecom-fixture-secret',run,page,rows,'Ops Admin');
  end loop;
  return run;
end;
$$;
revoke all on function internal.fixture_wecom_metadata_stage(text,integer) from public, anon, authenticated, service_role;

begin;
do $metadata_real_completion_transaction_and_cost$
declare run uuid; n integer; started timestamptz; completed_ms numeric; refresh_ms numeric; result jsonb;
begin
  delete from internal.jiaowubao_open_api_schedule_snapshot_current where api_source_key='jwb-open-api-schedule';
  foreach n in array array[3000,6000] loop
    run:=internal.fixture_wecom_metadata_stage('metadata-real-complete-'||n,n);
    if exists(select 1 from internal.wecom_schedule_run_metadata where run_id=run) then raise exception 'metadata_staging_built_receipt'; end if;
    started:=clock_timestamp();
    result:=public.complete_jiaowubao_open_api_schedule_snapshot_ingest('wecom-fixture-secret',run,'Ops Admin');
    completed_ms:=round(extract(epoch from clock_timestamp()-started)*1000,3);
    if result->>'state'<>'complete' or not exists(select 1 from internal.wecom_schedule_run_metadata c
      join internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r on r.id=c.run_id
      where c.run_id=run and c.item_count=n and c.expected_row_count=n and c.canonical_rows_sha256=r.canonical_rows_sha256
        and c.payload_sha256=r.payload_sha256 and c.revision=r.revision and c.completed_at=r.completed_at)
        or not exists(select 1 from internal.jiaowubao_open_api_schedule_snapshot_current where run_id=run) then
      raise exception 'metadata_normal_completion_failed_to_build_and_publish';
    end if;
    started:=clock_timestamp();
    perform internal.refresh_wecom_schedule_run_metadata(run);
    refresh_ms:=round(extract(epoch from clock_timestamp()-started)*1000,3);
    raise notice 'metadata_synthetic_cost rows=% complete_ms=% refresh_ms=%',n,completed_ms,refresh_ms;
  end loop;
  if not(select proconfig @> array['statement_timeout=110s'] from pg_proc
      where oid='public.complete_jiaowubao_open_api_schedule_snapshot_ingest(text,uuid,text)'::regprocedure) then
    raise exception 'metadata_completion_budget_changed';
  end if;
end;
$metadata_real_completion_transaction_and_cost$;
rollback;

select 'wecom_handover_schedule_run_metadata_runtime_ok' as result;
