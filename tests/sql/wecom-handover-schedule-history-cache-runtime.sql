\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
\ir wecom-handover-schedule-evidence-runtime.sql

create function internal.fixture_wecom_history_record(p_id text,p_date text)
returns jsonb language sql as $$
  select jsonb_set(internal.fixture_wecom_schedule_record(p_id,p_date),'{record,course_title}','"试听 English"');
$$;
create temporary table fixture_history_cache_runs(kind text primary key,id uuid);
insert into fixture_history_cache_runs values
  ('seed-old',internal.fixture_wecom_schedule_run('cache-seed-old','2098-12-31','2099-01-06','2099-01-01T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('seed-history','2098-12-31'),
      internal.fixture_wecom_history_record('seed-move','2099-01-01'),internal.fixture_wecom_history_record('current-wins','2099-01-01'),
      internal.fixture_wecom_history_record('cancelled','2099-01-02')))),
  ('seed-new',internal.fixture_wecom_schedule_run('cache-seed-new','2099-04-01','2099-04-01','2099-01-05T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('seed-move','2099-04-01'),
      internal.fixture_wecom_history_record('current-wins','2099-04-01')))),
  ('current',internal.fixture_wecom_schedule_run('cache-current','2099-01-02','2099-01-03','2099-01-02T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('current-wins','2099-01-02'))));
create temporary table fixture_history_native_before as
  select (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) as state,
    (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) as sources,
    (select jsonb_agg(to_jsonb(r) order by id) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r) as runs;

\ir ../../supabase/migrations/20261021080306_stabilize_wecom_handover_schedule_history_plan.sql

do $cache_behavior$
declare current_run uuid; historical uuid; newest uuid; input jsonb; before_row fixture_history_native_before%rowtype; audit uuid; saved_cache jsonb; row_count bigint;
begin
  select id into current_run from fixture_history_cache_runs where kind='current';
  select id into historical from fixture_history_cache_runs where kind='seed-old';
  select * into before_row from fixture_history_native_before;
  if (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) is distinct from before_row.state
      or (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) is distinct from before_row.sources
      or (select jsonb_agg(to_jsonb(r) order by id) from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs r) is distinct from before_row.runs then
    raise exception 'cache_backfill_modified_native_evidence';
  end if;
  if (select run_id from internal.wecom_schedule_latest_complete_source where source_key='jwb-open-api:schedule:seed-move')
      is distinct from (select id from fixture_history_cache_runs where kind='seed-new')
      or (select run_id from internal.wecom_schedule_latest_complete_source where source_key='jwb-open-api:schedule:seed-history') is distinct from historical then
    raise exception 'latest_complete_source_backfill_failed';
  end if;
  if has_table_privilege('anon','internal.wecom_schedule_latest_complete_source','select')
      or has_table_privilege('authenticated','internal.wecom_schedule_latest_complete_source','insert')
      or has_table_privilege('service_role','internal.wecom_schedule_latest_complete_source','select')
      or has_function_privilege('anon','internal.index_wecom_schedule_complete_run()','execute')
      or not (select relrowsecurity from pg_class where oid='internal.wecom_schedule_latest_complete_source'::regclass) then
    raise exception 'latest_complete_source_privacy_failed';
  end if;
  audit := internal.append_operational_contract_audit('fixture.pointer','fixture','fixture','fixture','{}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key,run_id,revision,row_count,rows_sha256,payload_sha256,audit_id)
    values('jwb-open-api-schedule',current_run,'cache-current',1,'sha256:'||repeat('d',64),'sha256:'||repeat('e',64),audit);
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
  if jsonb_array_length(input->'events')<>2
      or exists(select 1 from jsonb_array_elements(input->'events') e where e->>'eventId' in
        ('jwb-open-api:schedule:seed-move','jwb-open-api:schedule:cancelled'))
      or not exists(select 1 from jsonb_array_elements(input->'events') e where e->>'eventId'='jwb-open-api:schedule:current-wins'
        and e->>'sourceRunId'=current_run::text and not(e->>'historical')::boolean) then
    raise exception 'latest_cache_current_precedence_or_reschedule_failed';
  end if;
  newest := internal.fixture_wecom_schedule_run('cache-older-completion','2099-05-01','2099-05-01','2098-12-01T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('seed-history','2099-05-01')));
  if (select run_id from internal.wecom_schedule_latest_complete_source where source_key='jwb-open-api:schedule:seed-history') is distinct from historical then
    raise exception 'older_completion_replaced_newer_source';
  end if;
  newest := internal.fixture_wecom_schedule_run('cache-incremental','2099-05-01','2099-05-01','2099-01-06T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('seed-history','2099-05-01')));
  if (select run_id from internal.wecom_schedule_latest_complete_source where source_key='jwb-open-api:schedule:seed-history') is distinct from newest then
    raise exception 'complete_trigger_not_incremental';
  end if;
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
  if jsonb_array_length(input->'events')<>1 then raise exception 'incremental_move_outside_range_revived_old_event'; end if;
  select to_jsonb(c) into saved_cache from internal.wecom_schedule_latest_complete_source c where source_key='jwb-open-api:schedule:seed-history';
  delete from internal.wecom_schedule_latest_complete_source where source_key='jwb-open-api:schedule:seed-history';
  begin
    perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
    raise exception 'missing_historical_cache_was_accepted';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'wecom_schedule_latest_source_missing' then raise; end if;
  end;
  insert into internal.wecom_schedule_latest_complete_source select * from jsonb_populate_record(null::internal.wecom_schedule_latest_complete_source,saved_cache);
  select count(*) into row_count from internal.wecom_schedule_latest_complete_source;
  perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
  if (select count(*) from internal.wecom_schedule_latest_complete_source)<>row_count then raise exception 'read_mutated_private_cache'; end if;
  begin
    perform public.read_wecom_handover_schedule_input('bad','cache-current',array['bot:lp-draft:one']);
    raise exception 'new_read_secret_guard_missing';
  exception when insufficient_privilege then null; end;
end;
$cache_behavior$;

begin;
do $strict_complete_date_validation$
begin
  perform internal.fixture_wecom_schedule_run('cache-invalid-date','2099-01-04','2099-01-04','2099-01-07T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('bad-unselected-source-day','not-a-date')));
  begin
    perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
    raise exception 'out_of_window_invalid_date_silently_dropped';
  exception when invalid_parameter_value then
    if sqlerrm <> 'wecom_schedule_invalid_source_date' then raise; end if;
  end;
end;
$strict_complete_date_validation$;
rollback;

create temporary table fixture_trial_course_cases as
  select value->>'course' as course,(value->>'expected')::boolean as expected
  from jsonb_array_elements($trial_cases$[
    {"course":"trial","expected":true},{"course":"TRIAL","expected":true},
    {"course":"中文trial中文","expected":true},{"course":"trialish","expected":false},
    {"course":"xtrial","expected":false},{"course":"pre_trial","expected":false},
    {"course":"ＴＲＩＡＬ","expected":false},{"course":"TRİAL","expected":false},
    {"course":"ſtrial","expected":false},{"course":"Ktrial","expected":false},
    {"course":"trialſ","expected":false},{"course":"trialK","expected":false},
    {"course":"étrialé","expected":true},{"course":"试听 English","expected":true},
    {"course":"视听 English","expected":true},{"course":"English","expected":false}
  ]$trial_cases$::jsonb);
do $trial_predicate_parity$
begin
  if exists(select 1 from fixture_trial_course_cases where internal.is_wecom_schedule_trial_record(
      jsonb_build_object('course_title',course,'stu_list','[]'::jsonb)) is distinct from expected)
      or internal.is_wecom_schedule_trial_record('{"course_title":"English","stu_list":[{"name":"试听学员Ｂ"}]}') is not true
      or internal.is_wecom_schedule_trial_record('{"course_title":"English","stu_list":[{"name":"Actual Student A"}]}') is not false
      or internal.is_wecom_schedule_trial_record('{"course_title":"English","stu_list":null}') is not true then
    raise exception 'trial_predicate_typescript_parity_failed';
  end if;
end;
$trial_predicate_parity$;

begin;
do $nontrial_clock_boundary$
declare input jsonb; row jsonb;
begin
  row := jsonb_set(internal.fixture_wecom_history_record('invalid-nontrial','2099-01-04'),'{record,course_title}','"English"');
  row := jsonb_set(row,'{record,time_start}','"17:00"');
  perform internal.fixture_wecom_schedule_run('cache-invalid-nontrial','2099-01-04','2099-01-04','2099-01-07T00:00:00Z',jsonb_build_array(row));
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
  if exists(select 1 from jsonb_array_elements(input->'events') e where e->>'eventId'='jwb-open-api:schedule:invalid-nontrial')
      or not exists(select 1 from jsonb_array_elements(input->'coverage') c where (c->>'startsAt')::timestamptz='2099-01-04T00:00:00+11') then
    raise exception 'unrelated_nontrial_clock_changed_trial_coverage';
  end if;
  row := jsonb_set(internal.fixture_wecom_history_record('invalid-trial','2099-01-05'),'{record,time_start}','"17:00"');
  perform internal.fixture_wecom_schedule_run('cache-invalid-trial','2099-01-05','2099-01-05','2099-01-08T00:00:00Z',jsonb_build_array(row));
  begin
    perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
    raise exception 'invalid_trial_clock_was_accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'wecom_schedule_invalid_source_event' then raise; end if;
  end;
end;
$nontrial_clock_boundary$;
rollback;

begin;
do $unknown_participants_fail_closed$
declare row jsonb;
begin
  row := jsonb_set(internal.fixture_wecom_history_record('unknown-members','2099-01-04'),'{record,course_title}','"English"');
  row := jsonb_set(row,'{record,stu_list}','null');
  perform internal.fixture_wecom_schedule_run('cache-unknown-participants','2099-01-04','2099-01-04','2099-01-07T00:00:00Z',jsonb_build_array(row));
  begin
    perform public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
    raise exception 'unknown_participants_silently_filtered';
  exception when invalid_parameter_value then
    if sqlerrm <> 'wecom_schedule_invalid_source_event' then raise; end if;
  end;
end;
$unknown_participants_fail_closed$;
rollback;

do $complete_index_rollback$
declare before_count bigint; one uuid; two uuid;
begin
  select count(*) into before_count from internal.wecom_schedule_latest_complete_source;
  begin
    perform internal.fixture_wecom_schedule_run('cache-rollback','2099-06-01','2099-06-01','2099-01-09T00:00:00Z',
      jsonb_build_array(internal.fixture_wecom_history_record('rollback-only','2099-06-01')));
    raise exception using errcode='P0002',message='synthetic_rollback';
  exception when no_data_found then null;
  end;
  if (select count(*) from internal.wecom_schedule_latest_complete_source)<>before_count then
    raise exception 'rolled_back_completion_left_cache_metadata';
  end if;
  one := internal.fixture_wecom_schedule_run('cache-tie-one','2099-06-01','2099-06-01','2099-01-10T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('tie-key','2099-06-01')));
  two := internal.fixture_wecom_schedule_run('cache-tie-two','2099-06-01','2099-06-01','2099-01-10T00:00:00Z',
    jsonb_build_array(internal.fixture_wecom_history_record('tie-key','2099-06-01')));
  if (select run_id from internal.wecom_schedule_latest_complete_source where source_key='jwb-open-api:schedule:tie-key')<>greatest(one,two) then
    raise exception 'latest_source_uuid_tie_breaker_failed';
  end if;
end;
$complete_index_rollback$;

do $save_reconstitutes_optimized_input$
declare input jsonb; source jsonb; entry jsonb; result jsonb; before_state jsonb; before_sources jsonb;
begin
  input := public.read_wecom_handover_schedule_input('wecom-fixture-secret','cache-current',array['bot:lp-draft:one']);
  select value into source from jsonb_array_elements(input->'sources') where value->>'sourceMessageId'='bot:lp-draft:one';
  entry := jsonb_build_object('sourceMessageId','bot:lp-draft:one','sourceRevision',source->>'sourceRevision',
    'snapshotRevision','cache-current','checkedAt',now(),'status','no_match','matchedStudentId',null,'candidates','[]'::jsonb);
  select jsonb_object_agg(entity,to_jsonb(s)) into before_state from public.ops_state s;
  select jsonb_agg(to_jsonb(m) order by message_id) into before_sources from internal.wecom_archive_messages m;
  result := public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','cache-current',input->>'inputRevision',jsonb_build_array(entry));
  if result <> '{"checkedCount":1,"matchedCount":0,"candidateCount":0}'::jsonb then raise exception 'optimized_save_receipt_failed'; end if;
  perform public.save_wecom_handover_schedule_evidence('wecom-fixture-secret','cache-current',input->>'inputRevision',jsonb_build_array(entry));
  if (select count(*) from internal.wecom_handover_schedule_evidence)<>1
      or (select jsonb_object_agg(entity,to_jsonb(s)) from public.ops_state s) is distinct from before_state
      or (select jsonb_agg(to_jsonb(m) order by message_id) from internal.wecom_archive_messages m) is distinct from before_sources then
    raise exception 'optimized_save_replay_or_native_immutability_failed';
  end if;
  if not (select proconfig @> array['search_path=""','statement_timeout=10s','work_mem=32MB']
      from pg_proc where oid='public.read_wecom_handover_schedule_input(text,text,text[])'::regprocedure)
      or not (select proconfig @> array['search_path=""','statement_timeout=12s','work_mem=32MB']
        from pg_proc where oid='public.save_wecom_handover_schedule_evidence(text,text,text,jsonb,text)'::regprocedure) then
    raise exception 'optimized_rpc_local_settings_missing';
  end if;
end;
$save_reconstitutes_optimized_input$;
