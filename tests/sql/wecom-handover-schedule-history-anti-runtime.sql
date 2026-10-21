\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-handover-schedule-title-runtime.sql

do $copy_original_reader$
begin
  execute replace(pg_get_functiondef('public.read_wecom_handover_schedule_input(text,text,text[])'::regprocedure),
    'public.read_wecom_handover_schedule_input(', 'internal.fixture_wecom_read_before_anti(');
end;
$copy_original_reader$;
revoke all on function internal.fixture_wecom_read_before_anti(text,text,text[]) from public, anon, authenticated, service_role;

create temporary table fixture_anti_reader_before as
  select public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:lp-draft:one','bot:title-only:one']) as input,
    public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',null) as pending,
    (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) as state,
    (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) as sources,
    (select jsonb_agg(to_jsonb(c) order by id) from internal.wecom_trial_handover_cases c) as cases,
    (select jsonb_agg(to_jsonb(c) order by source_message_id) from internal.wecom_lp_confirmations c) as confirmations,
    (select jsonb_agg(to_jsonb(e) order by source_message_id) from internal.wecom_handover_schedule_evidence e) as evidence,
    (select revision from internal.wecom_handover_schedule_epoch where singleton) as epoch,
    (select jsonb_agg(to_jsonb(r) order by id) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r) as runs,
    (select jsonb_agg(to_jsonb(i) order by run_id,source_key) from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i) as items,
    (select jsonb_agg(to_jsonb(c) order by source_key) from internal.wecom_schedule_latest_complete_source c) as cache;

\ir ../../supabase/migrations/20261021112432_avoid_wecom_schedule_current_key_nested_loop.sql
set enable_indexscan=on;

do $anti_complete_input_and_native_parity$
declare before_row fixture_anti_reader_before%rowtype; input jsonb; pending jsonb; mode text;
begin
  select * into before_row from fixture_anti_reader_before;
  foreach mode in array array['force_custom_plan','force_generic_plan'] loop
    perform set_config('plan_cache_mode',mode,true);
    input:=public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:lp-draft:one','bot:title-only:one']);
    pending:=public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',null);
    if input is distinct from before_row.input or pending is distinct from before_row.pending then
      raise exception 'anti_complete_projection_input_changed_%',mode;
    end if;
    if current_setting('enable_indexscan') <> 'on' then raise exception 'anti_reader_leaked_local_setting'; end if;
  end loop;
  if (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) is distinct from before_row.state
      or (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) is distinct from before_row.sources
      or (select jsonb_agg(to_jsonb(c) order by id) from internal.wecom_trial_handover_cases c) is distinct from before_row.cases
      or (select jsonb_agg(to_jsonb(c) order by source_message_id) from internal.wecom_lp_confirmations c) is distinct from before_row.confirmations
      or (select jsonb_agg(to_jsonb(e) order by source_message_id) from internal.wecom_handover_schedule_evidence e) is distinct from before_row.evidence
      or (select revision from internal.wecom_handover_schedule_epoch where singleton) <> before_row.epoch
      or (select jsonb_agg(to_jsonb(r) order by id) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r) is distinct from before_row.runs
      or (select jsonb_agg(to_jsonb(i) order by run_id,source_key) from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i) is distinct from before_row.items
      or (select jsonb_agg(to_jsonb(c) order by source_key) from internal.wecom_schedule_latest_complete_source c) is distinct from before_row.cache then
    raise exception 'anti_reader_modified_native_evidence';
  end if;
  if not(select proconfig @> array['search_path=""','statement_timeout=12s','work_mem=32MB','enable_indexscan=off']
      from pg_proc where oid='public.read_wecom_handover_schedule_input(text,text,text[])'::regprocedure)
      or not(select proconfig @> array['search_path=""','statement_timeout=13s','work_mem=32MB']
      from pg_proc where oid='public.save_wecom_handover_schedule_evidence(text,text,text,jsonb,text)'::regprocedure) then
    raise exception 'anti_rpc_local_budgets_changed';
  end if;
  if has_function_privilege('public','public.read_wecom_handover_schedule_input(text,text,text[])','execute')
      or has_function_privilege('service_role','public.read_wecom_handover_schedule_input(text,text,text[])','execute')
      or not has_function_privilege('anon','public.read_wecom_handover_schedule_input(text,text,text[])','execute')
      or not has_function_privilege('authenticated','public.read_wecom_handover_schedule_input(text,text,text[])','execute') then
    raise exception 'anti_rpc_privileges_changed';
  end if;
  begin
    perform public.read_wecom_handover_schedule_input('bad','retained-current',array['bot:lp-draft:one']);
    raise exception 'anti_reader_secret_guard_missing';
  exception when insufficient_privilege then null; end;
end;
$anti_complete_input_and_native_parity$;

begin;
do $anti_current_outside_range_nontrial_suppression$
declare historical uuid; current_run uuid; audit uuid; input jsonb; mode text;
begin
  historical:=internal.fixture_wecom_schedule_run('anti-history-outside','2099-01-04','2099-01-04','2100-01-01T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('anti-current-outside','2099-01-04')));
  current_run:=internal.fixture_wecom_schedule_run('anti-current-outside','2099-04-01','2099-04-01','2098-01-01T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_schedule_record('anti-current-outside','2099-04-01')));
  if (select run_id from internal.wecom_schedule_latest_complete_source where source_key='jwb-open-api:schedule:anti-current-outside') <> historical then
    raise exception 'anti_outside_fixture_did_not_keep_newer_history';
  end if;
  audit:=internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  update internal.jiaowubao_open_api_schedule_snapshot_current set run_id=current_run,revision='anti-current-outside',row_count=1,
    rows_sha256='sha256:'||repeat('d',64),payload_sha256='sha256:'||repeat('e',64),audit_id=audit where api_source_key='jwb-open-api-schedule';
  foreach mode in array array['force_custom_plan','force_generic_plan'] loop
    perform set_config('plan_cache_mode',mode,true);
    input:=public.read_wecom_handover_schedule_input('wecom-fixture-secret','anti-current-outside',array['bot:title-only:one']);
    if input is distinct from internal.fixture_wecom_read_before_anti('wecom-fixture-secret','anti-current-outside',array['bot:title-only:one'])
        or exists(select 1 from jsonb_array_elements(input->'events') e where e->>'eventId'='jwb-open-api:schedule:anti-current-outside')
        or exists(select 1 from jsonb_array_elements(input->'coverage') c where not(c->>'historical')::boolean) then
      raise exception 'anti_current_outside_nontrial_key_did_not_suppress_history_%',mode;
    end if;
  end loop;
end;
$anti_current_outside_range_nontrial_suppression$;
rollback;

begin;
do $anti_empty_current_run_keeps_authoritative_coverage$
declare current_run uuid; audit uuid; input jsonb; mode text;
begin
  current_run:=internal.fixture_wecom_schedule_run('anti-empty-current','2099-01-04','2099-01-04','2098-01-01T00:00:00Z','[]');
  audit:=internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  update internal.jiaowubao_open_api_schedule_snapshot_current set run_id=current_run,revision='anti-empty-current',row_count=0,
    rows_sha256='sha256:'||repeat('d',64),payload_sha256='sha256:'||repeat('e',64),audit_id=audit where api_source_key='jwb-open-api-schedule';
  foreach mode in array array['force_custom_plan','force_generic_plan'] loop
    perform set_config('plan_cache_mode',mode,true);
    input:=public.read_wecom_handover_schedule_input('wecom-fixture-secret','anti-empty-current',array['bot:title-only:one']);
    if input is distinct from internal.fixture_wecom_read_before_anti('wecom-fixture-secret','anti-empty-current',array['bot:title-only:one'])
        or not exists(select 1 from jsonb_array_elements(input->'coverage') c where (c->>'startsAt')::timestamptz='2099-01-04T00:00:00+11'::timestamptz and not(c->>'historical')::boolean)
        or exists(select 1 from jsonb_array_elements(input->'events') e where (e->>'sourceDate')='2099-01-04') then
      raise exception 'anti_empty_current_run_changed_coverage_or_revived_history_%',mode;
    end if;
  end loop;
end;
$anti_empty_current_run_keeps_authoritative_coverage$;
rollback;

begin;
do $anti_nontrial_missing_latest_still_fails_closed$
declare row jsonb; reader text;
begin
  row:=internal.fixture_wecom_schedule_record('anti-nontrial-missing-cache','2099-01-04');
  perform internal.fixture_wecom_schedule_run('anti-nontrial-missing-cache','2099-01-04','2099-01-04','2100-01-01T00:00:00Z',jsonb_build_array(row));
  delete from internal.wecom_schedule_latest_complete_source where source_key=row->>'sourceKey';
  foreach reader in array array['public.read_wecom_handover_schedule_input','internal.fixture_wecom_read_before_anti'] loop
    begin
      execute 'select '||reader||'($1,$2,$3)' using 'wecom-fixture-secret','retained-current',array['bot:title-only:one'];
      raise exception 'anti_nontrial_missing_latest_was_accepted';
    exception when object_not_in_prerequisite_state then
      if sqlerrm <> 'wecom_schedule_latest_source_missing' then raise; end if;
    end;
  end loop;
end;
$anti_nontrial_missing_latest_still_fails_closed$;
rollback;

begin;
do $anti_strict_source_validation$
declare row jsonb; repeated jsonb; kind text; reader text; expected_error text;
begin
  foreach kind in array array['missing','null','empty','duplicate-invalid','nontrial-unselected','invalid-trial-clock','unknown-participants'] loop
    begin
      row:=internal.fixture_wecom_history_record('anti-invalid-'||kind,'not-a-date');
      expected_error:='wecom_schedule_invalid_source_date';
      if kind='missing' then row:=row#-'{record,dated}';
      elsif kind='null' then row:=jsonb_set(row,'{record,dated}','null');
      elsif kind='empty' then row:=jsonb_set(row,'{record,dated}','""');
      elsif kind='nontrial-unselected' then row:=jsonb_set(row,'{record,course_title}','"English"');
      elsif kind='invalid-trial-clock' then
        row:=jsonb_set(jsonb_set(row,'{record,dated}','"2099-01-04"'),'{record,time_start}','"17:00"');
        expected_error:='wecom_schedule_invalid_source_event';
      elsif kind='unknown-participants' then
        row:=jsonb_set(jsonb_set(row,'{record,dated}','"2099-01-04"'),'{record,stu_list}','null');
        expected_error:='wecom_schedule_invalid_source_event';
      end if;
      repeated:=jsonb_set(row,'{sourceKey}',to_jsonb('jwb-open-api:schedule:anti-invalid-repeat-'||kind));
      perform internal.fixture_wecom_schedule_run('anti-invalid-'||kind,'2099-01-04','2099-01-04','2100-01-01T00:00:00Z',
        jsonb_build_array(internal.fixture_wecom_history_record('anti-valid-unselected-'||kind,'2099-06-01'),row,repeated));
      foreach reader in array array['public.read_wecom_handover_schedule_input','internal.fixture_wecom_read_before_anti'] loop
        begin
          execute 'select '||reader||'($1,$2,$3)' using 'wecom-fixture-secret','retained-current',array['bot:title-only:one'];
          raise exception 'anti_invalid_source_was_filtered_%',kind;
        exception when invalid_parameter_value then
          if sqlerrm <> expected_error then raise; end if;
        end;
      end loop;
      raise exception using errcode='P0002',message='anti_invalid_fixture_rollback';
    exception when no_data_found then null; end;
  end loop;
end;
$anti_strict_source_validation$;
rollback;

select 'wecom_handover_schedule_history_anti_runtime_ok' as result;
