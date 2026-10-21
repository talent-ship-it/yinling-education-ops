\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-handover-schedule-history-batch-runtime.sql

do $retained_parity_scenarios$
declare row jsonb; historical uuid; outside_current uuid; audit uuid;
begin
  row := jsonb_set(internal.fixture_wecom_history_record('retained-superseded-clock','2099-01-07'),'{record,time_start}','"17:00"');
  historical := internal.fixture_wecom_schedule_run('retained-assigned-days','2099-01-04','2099-01-08','2099-01-20T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('retained-left','2099-01-04'),
      internal.fixture_wecom_history_record('retained-hole','2099-01-05'),
      internal.fixture_wecom_history_record('retained-right','2099-01-06'),row,
      internal.fixture_wecom_history_record('retained-current-nontrial','2099-01-04'),
      jsonb_set(internal.fixture_wecom_schedule_record('retained-nontrial-clock','2099-01-08'),'{record,time_start}','"17:00"'),
      jsonb_set(jsonb_set(internal.fixture_wecom_history_record('retained-unicode','2099-01-04'),'{record,course_title}','"English"'),
        '{record,stu_list}','[{"mem_id":"SYNTHETIC-UNICODE","name":"试听学员B账号٣"}]')));
  perform internal.fixture_wecom_schedule_run('retained-empty-hole','2099-01-05','2099-01-05','2099-01-21T00:00:00Z','[]');
  perform internal.fixture_wecom_schedule_run('retained-superseded-outside','2099-04-01','2099-04-01','2099-01-22T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('retained-superseded-clock','2099-04-01')));
  outside_current := internal.fixture_wecom_schedule_run('retained-current','2099-04-01','2099-04-01','2098-12-01T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_schedule_record('retained-current-nontrial','2099-04-01')));
  if (select run_id from internal.wecom_schedule_latest_complete_source
      where source_key='jwb-open-api:schedule:retained-current-nontrial') is distinct from historical then
    raise exception 'retained_current_fixture_not_older_than_history';
  end if;
  audit := internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  update internal.jiaowubao_open_api_schedule_snapshot_current
    set run_id=outside_current,revision='retained-current',row_count=1,rows_sha256='sha256:'||repeat('d',64),
      payload_sha256='sha256:'||repeat('e',64),audit_id=audit where api_source_key='jwb-open-api-schedule';
end;
$retained_parity_scenarios$;

set enable_indexscan = on;
create temporary table fixture_retained_history_before as
  select public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:lp-draft:one']) as input,
    (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) as state,
    (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) as sources,
    (select jsonb_agg(to_jsonb(r) order by id) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r) as runs,
    (select jsonb_agg(to_jsonb(i) order by run_id,source_key) from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i) as items,
    (select jsonb_agg(to_jsonb(c) order by source_key) from internal.wecom_schedule_latest_complete_source c) as cache;

\ir ../../supabase/migrations/20261021092450_retain_wecom_handover_trial_records.sql

do $retained_reader_parity$
declare before_row fixture_retained_history_before%rowtype; input jsonb; source jsonb; entry jsonb; receipt jsonb; mode text;
begin
  select * into before_row from fixture_retained_history_before;
  foreach mode in array array['force_custom_plan','force_generic_plan'] loop
    perform set_config('plan_cache_mode',mode,true);
    input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:lp-draft:one']);
    if input is distinct from before_row.input then raise exception 'retained_reader_changed_complete_input_%',mode; end if;
    if current_setting('enable_indexscan') <> 'on' then raise exception 'retained_reader_leaked_local_guc'; end if;
  end loop;
  if (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) is distinct from before_row.state
      or (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) is distinct from before_row.sources
      or (select jsonb_agg(to_jsonb(r) order by id) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r) is distinct from before_row.runs
      or (select jsonb_agg(to_jsonb(i) order by run_id,source_key) from internal.jiaowubao_open_api_schedule_snapshot_ingest_items i) is distinct from before_row.items
      or (select jsonb_agg(to_jsonb(c) order by source_key) from internal.wecom_schedule_latest_complete_source c) is distinct from before_row.cache then
    raise exception 'retained_reader_modified_native_evidence';
  end if;
  if exists(select 1 from jsonb_array_elements(input->'events') e where e->>'eventId' in
      ('jwb-open-api:schedule:retained-hole','jwb-open-api:schedule:retained-superseded-clock',
       'jwb-open-api:schedule:retained-current-nontrial','jwb-open-api:schedule:retained-nontrial-clock'))
      or (select count(*) from jsonb_array_elements(input->'events') e where e->>'eventId' in
        ('jwb-open-api:schedule:retained-left','jwb-open-api:schedule:retained-right','jwb-open-api:schedule:retained-unicode')) <> 3
      or (select count(*) from jsonb_array_elements(input->'coverage') c
        where (c->>'startsAt')::timestamptz between '2099-01-04T00:00:00+11' and '2099-01-08T00:00:00+11'
          and (c->>'historical')::boolean) <> 5
      or exists(select 1 from jsonb_array_elements(input->'coverage') c where not(c->>'historical')::boolean) then
    raise exception 'retained_assigned_day_hole_or_current_nontrial_outside_range_changed';
  end if;
  select value into source from jsonb_array_elements(input->'sources') where value->>'sourceMessageId'='bot:lp-draft:one';
  entry := jsonb_build_object('sourceMessageId','bot:lp-draft:one','sourceRevision',source->>'sourceRevision',
    'snapshotRevision','retained-current','checkedAt',now(),'status','no_match','matchedStudentId',null,'candidates','[]'::jsonb);
  receipt := public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(entry));
  if receipt <> '{"checkedCount":1,"matchedCount":0,"candidateCount":0}'::jsonb then raise exception 'retained_save_reconstitution_failed'; end if;
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','retained-current',input->>'inputRevision',jsonb_build_array(entry));
  if (select count(*) from internal.wecom_handover_schedule_evidence) <> 1 then raise exception 'retained_save_replay_created_business_records'; end if;
  if not (select proconfig @> array['search_path=""','statement_timeout=12s','work_mem=32MB','enable_indexscan=off']
      from pg_proc where oid='public.read_wecom_handover_schedule_input(text,text,text[])'::regprocedure)
      or not (select proconfig @> array['search_path=""','statement_timeout=13s','work_mem=32MB']
        from pg_proc where oid='public.save_wecom_handover_schedule_evidence(text,text,text,jsonb,text)'::regprocedure)
      or current_setting('enable_indexscan') <> 'on' then
    raise exception 'retained_rpc_local_settings_or_restore_failed';
  end if;
  if has_function_privilege('service_role','public.read_wecom_handover_schedule_input(text,text,text[])','execute')
      or has_function_privilege('public','public.read_wecom_handover_schedule_input(text,text,text[])','execute')
      or not has_function_privilege('anon','public.read_wecom_handover_schedule_input(text,text,text[])','execute') then
    raise exception 'retained_reader_privileges_changed';
  end if;
  begin
    perform public.read_wecom_handover_schedule_input('bad','retained-current',array['bot:lp-draft:one']);
    raise exception 'retained_reader_secret_guard_missing';
  exception when insufficient_privilege then null; end;
  if current_setting('enable_indexscan') <> 'on' then raise exception 'retained_reader_error_leaked_local_guc'; end if;
end;
$retained_reader_parity$;

do $retained_strict_date_validation$
declare kind text; row jsonb; repeated jsonb;
begin
  foreach kind in array array['missing','null','empty','duplicate-invalid','nontrial-unselected'] loop
    begin
      row := internal.fixture_wecom_history_record('retained-invalid-'||kind,'not-a-date');
      if kind='missing' then row := row #- '{record,dated}';
      elsif kind='null' then row := jsonb_set(row,'{record,dated}','null');
      elsif kind='empty' then row := jsonb_set(row,'{record,dated}','""');
      end if;
      if kind='nontrial-unselected' then row := jsonb_set(row,'{record,course_title}','"English"'); end if;
      repeated := jsonb_set(row,'{sourceKey}',to_jsonb('jwb-open-api:schedule:retained-invalid-duplicate-'||kind));
      perform internal.fixture_wecom_schedule_run('retained-invalid-'||kind,'2099-01-04','2099-01-04','2099-01-30T00:00:00Z',
        jsonb_build_array(internal.fixture_wecom_history_record('retained-valid-unselected-'||kind,'2099-06-01'),row,repeated));
      perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:lp-draft:one']);
      raise exception 'retained_invalid_source_date_was_filtered_%',kind;
    exception when invalid_parameter_value then
      if sqlerrm <> 'wecom_schedule_invalid_source_date' then raise; end if;
    end;
  end loop;
end;
$retained_strict_date_validation$;

begin;
do $nontrial_stub_requires_latest_cache$
declare row jsonb;
begin
  row := internal.fixture_wecom_schedule_record('retained-nontrial-missing-cache','2099-01-04');
  perform internal.fixture_wecom_schedule_run('retained-nontrial-missing-cache','2099-01-04','2099-01-04','2099-01-30T00:00:00Z',jsonb_build_array(row));
  delete from internal.wecom_schedule_latest_complete_source where source_key='jwb-open-api:schedule:retained-nontrial-missing-cache';
  begin
    perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:lp-draft:one']);
    raise exception 'retained_nontrial_stub_bypassed_missing_cache';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'wecom_schedule_latest_source_missing' then raise; end if;
  end;
end;
$nontrial_stub_requires_latest_cache$;
rollback;

do $retained_invalid_trial_and_unknown_participants$
declare kind text; row jsonb;
begin
  foreach kind in array array['invalid-trial-clock','unknown-participants'] loop
    begin
      row := internal.fixture_wecom_history_record('retained-rejected-'||kind,'2099-01-04');
      if kind='invalid-trial-clock' then row := jsonb_set(row,'{record,time_start}','"17:00"');
      else
        row := jsonb_set(jsonb_set(row,'{record,course_title}','"English"'),'{record,stu_list}','null');
      end if;
      perform internal.fixture_wecom_schedule_run('retained-rejected-'||kind,'2099-01-04','2099-01-04','2099-01-30T00:00:00Z',jsonb_build_array(row));
      perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','retained-current',array['bot:lp-draft:one']);
      raise exception 'retained_invalid_trial_or_unknown_members_was_filtered_%',kind;
    exception when invalid_parameter_value then
      if sqlerrm <> 'wecom_schedule_invalid_source_event' then raise; end if;
    end;
  end loop;
end;
$retained_invalid_trial_and_unknown_participants$;
