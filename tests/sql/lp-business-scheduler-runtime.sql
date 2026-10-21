\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;
do $scheduler_business$
declare versions jsonb; target jsonb; saved record; result record; task jsonb; task_id_value text; n int := 0; key_value text;
begin
  select jsonb_object_agg(entity,version) into versions from public.ops_state;
  select payload into target from public.ops_state where entity='tasks';
  begin
    perform public.begin_lp_parent_progress_scheduler_run('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000099',repeat('a',64),versions||'{"teachers":"1"}'::jsonb,(versions->>'tasks')::bigint,target,1,0);
    raise exception 'invalid_teacher_version_allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.begin_lp_parent_progress_scheduler_run('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000099',repeat('a',64),versions||'{"students":1}'::jsonb,(versions->>'tasks')::bigint,target,1,0);
    raise exception 'unknown_scheduler_source_version_allowed';
  exception when invalid_parameter_value then null; end;

  for task_id_value in select value->>'id' from jsonb_array_elements(target) where value->>'id' <> 'SCHEDULER-BUSINESS-UNKNOWN' loop
    n := n+1;
    key_value := 'lp-parent-progress:30000000-0000-4000-8000-'||lpad(n::text,12,'0');
    select jsonb_object_agg(entity,version) into versions from public.ops_state;
    select jsonb_agg(case when value->>'id'=task_id_value then (value-'legacyEvidence')||'{"dueAt":"2099-01-01T00:00:00.000Z"}'::jsonb else value end order by ordinality)
      into target from jsonb_array_elements((select payload from public.ops_state where entity='tasks')) with ordinality;
    perform public.begin_lp_parent_progress_scheduler_run('test-secret',key_value,repeat('a',64),versions,(versions->>'tasks')::bigint,target,1,1);
    perform public.put_lp_parent_progress_scheduler_tasks_authoritative('test-secret',key_value,target,'LP Scheduler');
    if not exists (select 1 from internal.legacy_task_deadline_freezes where task_id=task_id_value and thawed_at is not null) then
      raise exception 'business_task_kind_not_accepted';
    end if;
  end loop;
  select jsonb_object_agg(entity,version) into versions from public.ops_state;
  select jsonb_agg(case when value->>'id'='SCHEDULER-BUSINESS-UNKNOWN' then (value-'legacyEvidence')||'{"dueAt":"2099-01-01T00:00:00.000Z"}'::jsonb else value end order by ordinality)
    into target from jsonb_array_elements((select payload from public.ops_state where entity='tasks')) with ordinality;
  perform public.begin_lp_parent_progress_scheduler_run('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000010',repeat('b',64),versions,(versions->>'tasks')::bigint,target,1,1);
  begin
    perform public.put_lp_parent_progress_scheduler_tasks_authoritative('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000010',target,'LP Scheduler');
    raise exception 'unknown_business_task_thaw_allowed';
  exception when insufficient_privilege then null; end;

  select payload into target from public.ops_state where entity='tasks';
  perform public.begin_lp_parent_progress_scheduler_run('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000011',repeat('c',64),versions,(versions->>'tasks')::bigint,target,1,0);
  update public.ops_state set version=version+1 where entity='teachers';
  begin
    perform public.finish_lp_parent_progress_scheduler_run('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000011','no_change');
    raise exception 'no_change_ignored_teacher_version_drift';
  exception when serialization_failure then null; end;
  select jsonb_object_agg(entity,version) into versions from public.ops_state;
  perform public.begin_lp_parent_progress_scheduler_run('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000012',repeat('d',64),versions,(versions->>'tasks')::bigint,target,1,1);
  update public.ops_state set version=version+1 where entity='teachers';
  begin
    perform public.put_lp_parent_progress_scheduler_tasks_authoritative('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000012',target,'LP Scheduler');
    raise exception 'authoritative_put_ignored_teacher_version_drift';
  exception when serialization_failure then null; end;
  begin
    perform public.put_lp_parent_progress_scheduler_tasks('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000012',target,'LP Scheduler');
    raise exception 'legacy_put_bypassed_teacher_version_proof';
  exception when serialization_failure then null; end;
  update internal.lp_parent_progress_scheduler_runs set started_at=now()-interval '31 minutes'
    where run_key in ('lp-parent-progress:30000000-0000-4000-8000-000000000011','lp-parent-progress:30000000-0000-4000-8000-000000000012');
  select * into result from public.recover_stale_lp_parent_progress_scheduler_runs('test-secret');
  if result.recovered_failed <> 2 or result.recovered_no_change <> 0 then raise exception 'recovery_ignored_teacher_version_proof'; end if;
  select jsonb_object_agg(entity,version) into versions from public.ops_state;
  perform public.begin_lp_parent_progress_scheduler_run('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000013',repeat('e',64),versions,(versions->>'tasks')::bigint,target,1,0);
  perform public.finish_lp_parent_progress_scheduler_run('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000013','no_change');
  perform public.begin_lp_parent_progress_scheduler_run('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000014',repeat('f',64),versions-'teachers',(versions->>'tasks')::bigint,target,1,0);
  update public.ops_state set version=version+1 where entity='teachers';
  perform public.finish_lp_parent_progress_scheduler_run('test-secret','lp-parent-progress:30000000-0000-4000-8000-000000000014','no_change');
  if has_function_privilege('anon','internal.lp_scheduler_teacher_version_matches(jsonb)','execute') then raise exception 'scheduler_teacher_helper_exposed'; end if;
end;
$scheduler_business$;
rollback;
select 'lp_business_scheduler_runtime_ok' as result;
