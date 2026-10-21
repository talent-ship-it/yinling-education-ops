\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-handover-schedule-history-cache-runtime.sql

create temporary table fixture_batched_history_before as
  select public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']) as input,
    (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) as state,
    (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) as sources,
    (select jsonb_agg(to_jsonb(r) order by id) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r) as runs,
    (select jsonb_agg(to_jsonb(c) order by source_key) from internal.wecom_schedule_latest_complete_source c) as cache;

\ir ../../supabase/migrations/20261021085243_batch_wecom_handover_schedule_history_reads.sql
set plan_cache_mode = force_generic_plan;

do $batched_reader_parity$
declare before_row fixture_batched_history_before%rowtype; input jsonb; source jsonb; entry jsonb; receipt jsonb;
begin
  select * into before_row from fixture_batched_history_before;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
  if input is distinct from before_row.input then raise exception 'batched_reader_changed_input'; end if;
  if (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) is distinct from before_row.state
      or (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) is distinct from before_row.sources
      or (select jsonb_agg(to_jsonb(r) order by id) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r) is distinct from before_row.runs
      or (select jsonb_agg(to_jsonb(c) order by source_key) from internal.wecom_schedule_latest_complete_source c) is distinct from before_row.cache then
    raise exception 'batched_reader_modified_native_evidence';
  end if;
  select value into source from jsonb_array_elements(input->'sources') where value->>'sourceMessageId'='bot:lp-draft:one';
  entry := jsonb_build_object('sourceMessageId','bot:lp-draft:one','sourceRevision',source->>'sourceRevision',
    'snapshotRevision','cache-current','checkedAt',now(),'status','no_match','matchedStudentId',null,'candidates','[]'::jsonb);
  receipt := public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','cache-current',input->>'inputRevision',jsonb_build_array(entry));
  if receipt <> '{"checkedCount":1,"matchedCount":0,"candidateCount":0}'::jsonb then
    raise exception 'batched_save_reconstitution_failed';
  end if;
  if not (select proconfig @> array['search_path=""','statement_timeout=12s','work_mem=32MB']
      from pg_proc where oid='public.read_wecom_handover_schedule_input(text,text,text[])'::regprocedure)
      or not (select proconfig @> array['search_path=""','statement_timeout=13s','work_mem=32MB']
        from pg_proc where oid='public.save_wecom_handover_schedule_evidence(text,text,text,jsonb,text)'::regprocedure) then
    raise exception 'batched_rpc_local_budgets_missing';
  end if;
  if has_function_privilege('service_role','public.read_wecom_handover_schedule_input(text,text,text[])','execute')
      or has_function_privilege('public','public.read_wecom_handover_schedule_input(text,text,text[])','execute')
      or not has_function_privilege('anon','public.read_wecom_handover_schedule_input(text,text,text[])','execute') then
    raise exception 'batched_reader_privileges_changed';
  end if;
  begin
    perform public.read_wecom_handover_schedule_input('bad','cache-current',array['bot:lp-draft:one']);
    raise exception 'batched_reader_secret_guard_missing';
  exception when insufficient_privilege then null;
  end;
end;
$batched_reader_parity$;

begin;
do $current_keys_outside_history_range$
declare historical uuid; outside_current uuid; audit uuid; input jsonb;
begin
  historical := internal.fixture_wecom_schedule_run('batched-current-old-history','2099-01-04','2099-01-04','2099-01-12T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('batched-current-outside','2099-01-04'),
      internal.fixture_wecom_history_record('batched-history-retained','2099-01-04')));
  outside_current := internal.fixture_wecom_schedule_run('batched-current-outside','2099-04-01','2099-04-01','2098-12-01T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('batched-current-outside','2099-04-01')));
  if (select run_id from internal.wecom_schedule_latest_complete_source
      where source_key='jwb-open-api:schedule:batched-current-outside') is distinct from historical then
    raise exception 'outside_current_fixture_did_not_preserve_newer_history';
  end if;
  audit := internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  update internal.jiaowubao_open_api_schedule_snapshot_current
    set run_id=outside_current,revision='batched-current-outside',row_count=1,rows_sha256='sha256:'||repeat('d',64),
      payload_sha256='sha256:'||repeat('e',64),audit_id=audit where api_source_key='jwb-open-api-schedule';
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','batched-current-outside',array['bot:lp-draft:one']);
  if exists(select 1 from jsonb_array_elements(input->'events') e where e->>'eventId'='jwb-open-api:schedule:batched-current-outside')
      or not exists(select 1 from jsonb_array_elements(input->'events') e where e->>'eventId'='jwb-open-api:schedule:batched-history-retained')
      or not exists(select 1 from jsonb_array_elements(input->'coverage') c
        where (c->>'startsAt')::timestamptz='2099-01-04T00:00:00+11' and (c->>'historical')::boolean)
      or exists(select 1 from jsonb_array_elements(input->'coverage') c where not(c->>'historical')::boolean) then
    raise exception 'current_key_outside_history_range_revived_old_event';
  end if;
end;
$current_keys_outside_history_range$;
rollback;

do $distinct_raw_date_validation$
declare kind text; row jsonb; repeated jsonb; valid_unselected jsonb;
begin
  foreach kind in array array['missing','null','empty','duplicate-invalid','nontrial-unselected'] loop
    begin
      row := internal.fixture_wecom_history_record('batched-invalid-'||kind,'not-a-date');
      if kind='missing' then row := row #- '{record,dated}';
      elsif kind='null' then row := jsonb_set(row,'{record,dated}','null');
      elsif kind='empty' then row := jsonb_set(row,'{record,dated}','""');
      end if;
      if kind='nontrial-unselected' then
        row := jsonb_set(row,'{record,course_title}','"English"');
      end if;
      repeated := jsonb_set(row,'{sourceKey}',to_jsonb('jwb-open-api:schedule:batched-invalid-duplicate-'||kind));
      valid_unselected := internal.fixture_wecom_history_record('batched-valid-unselected-'||kind,'2099-06-01');
      perform internal.fixture_wecom_schedule_run('batched-invalid-'||kind,'2099-01-04','2099-01-04','2099-01-13T00:00:00Z',
        jsonb_build_array(valid_unselected,row,repeated));
      perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
      raise exception 'distinct_date_map_silently_dropped_invalid_source_%',kind;
    exception when invalid_parameter_value then
      if sqlerrm <> 'wecom_schedule_invalid_source_date' then raise; end if;
    end;
  end loop;
end;
$distinct_raw_date_validation$;
