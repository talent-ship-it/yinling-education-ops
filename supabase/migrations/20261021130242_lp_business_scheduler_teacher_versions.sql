create function internal.lp_scheduler_teacher_version_matches(p_versions jsonb)
returns boolean language plpgsql volatile security invoker set search_path = '' as $$
declare observed_version bigint;
begin
  if not (p_versions ? 'teachers') then return true; end if;
  select version into observed_version from public.ops_state where entity = 'teachers' for update;
  return observed_version is not null and observed_version = (p_versions ->> 'teachers')::bigint;
end;
$$;
revoke all on function internal.lp_scheduler_teacher_version_matches(jsonb) from public, anon, authenticated, service_role;

do $lp_scheduler_business_contract$
declare definition text; target record;
begin
  for target in select * from (values
    ('public.begin_lp_parent_progress_scheduler_run(text,text,text,jsonb,bigint,jsonb,integer,integer)',
      $old$p_source_versions - 'bookings' - 'lpItems' - 'tasks' <> '{}'::jsonb$old$,
      $new$p_source_versions - 'bookings' - 'lpItems' - 'tasks' - 'teachers' <> '{}'::jsonb$new$),
    ('public.finish_lp_parent_progress_scheduler_run(text,text,text,text)',
      $old$    if run_row.changed_count <> 0$old$,
      $new$    if not internal.lp_scheduler_teacher_version_matches(run_row.source_versions)
       or run_row.changed_count <> 0$new$),
    ('public.put_lp_parent_progress_scheduler_tasks_authoritative(text,text,jsonb,text)',
      $old$  if booking_state.version <> (run_row.source_versions ->> 'bookings')::bigint$old$,
      $new$  if not internal.lp_scheduler_teacher_version_matches(run_row.source_versions)
     or booking_state.version <> (run_row.source_versions ->> 'bookings')::bigint$new$),
    ('public.put_lp_parent_progress_scheduler_tasks(text,text,jsonb,text)',
      $old$  if booking_state.version <> (run_row.source_versions ->> 'bookings')::bigint$old$,
      $new$  if not internal.lp_scheduler_teacher_version_matches(run_row.source_versions)
     or booking_state.version <> (run_row.source_versions ->> 'bookings')::bigint$new$),
    ('public.recover_stale_lp_parent_progress_scheduler_runs(text)',
      $old$    if run_row.changed_count = 0$old$,
      $new$    if internal.lp_scheduler_teacher_version_matches(run_row.source_versions)
       and run_row.changed_count = 0$new$),
    ('internal.enforce_ops_task_canonical_deadlines()',
      $old$task ->> 'ruleKey' !~ '^trial\.parent-progress-sync\.[1-9][0-9]*$'$old$,
      $new$task ->> 'ruleKey' !~ '^(trial\.parent-progress-sync\.[1-9][0-9]*|lp\.(modification-review(\.[1-9][0-9]*)?|scheduling|first-lesson-finalize-n2|first-lesson-prep-n1))$'$new$)
  ) replacements(signature,old_fragment,new_fragment) loop
    definition := pg_catalog.pg_get_functiondef(target.signature::pg_catalog.regprocedure);
    if (length(definition)-length(replace(definition,target.old_fragment,'')))/length(target.old_fragment) <> 1 then
      raise exception 'lp_scheduler_business_contract_drift: %', target.signature;
    end if;
    execute replace(definition,target.old_fragment,target.new_fragment);
  end loop;
end;
$lp_scheduler_business_contract$;
