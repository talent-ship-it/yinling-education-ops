-- Server-side LP parent-progress scheduler ledger.
--
-- The scheduler route reads the authoritative lpItems/bookings/tasks rows and
-- writes through the narrow OCC-protected scheduler RPC below.  This ledger makes
-- every run resumable and auditable without exposing internal rows through the
-- Data API. Applied is finalized in the same transaction as the task write;
-- interrupted pre-write/no-change runs remain visible as `running` until the
-- bounded recovery pass safely converges them.

create table if not exists internal.lp_parent_progress_scheduler_runs (
  run_key text primary key check (
    run_key ~ '^lp-parent-progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  actor text not null check (actor = 'LP Scheduler'),
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  target_tasks_digest text not null check (target_tasks_digest ~ '^[a-f0-9]{64}$'),
  source_versions jsonb not null check (jsonb_typeof(source_versions) = 'object'),
  task_version_before bigint not null check (task_version_before > 0),
  task_version_after bigint,
  processed_count integer not null default 0 check (processed_count >= 0),
  changed_count integer not null default 0 check (changed_count >= 0),
  outcome text not null check (outcome in ('running', 'no_change', 'applied', 'failed')),
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  audit_id uuid not null references internal.operational_contract_audit(id),
  finished_audit_id uuid references internal.operational_contract_audit(id),
  check ((outcome = 'running' and finished_at is null and task_version_after is null)
      or (outcome <> 'running' and finished_at is not null)),
  check (task_version_after is null or task_version_after >= task_version_before)
);

alter table internal.lp_parent_progress_scheduler_runs enable row level security;
revoke all on table internal.lp_parent_progress_scheduler_runs from public, anon, authenticated, service_role;
create index if not exists lp_parent_progress_scheduler_runs_started_idx
  on internal.lp_parent_progress_scheduler_runs (started_at desc);

create or replace function public.begin_lp_parent_progress_scheduler_run(
  p_secret text,
  p_run_key text,
  p_source_digest text,
  p_source_versions jsonb,
  p_task_version_before bigint,
  p_target_tasks jsonb,
  p_processed_count integer,
  p_changed_count integer
) returns table(run_key text, outcome text, audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $$
declare saved_audit uuid; prior internal.lp_parent_progress_scheduler_runs%rowtype; target_digest text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_run_key, '') !~ '^lp-parent-progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_source_digest, '') !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_source_versions) is distinct from 'object'
     or p_source_versions - 'bookings' - 'lpItems' - 'tasks' <> '{}'::jsonb
     or not (p_source_versions ?& array['bookings', 'lpItems', 'tasks'])
     or exists (
       select 1 from jsonb_each(p_source_versions) version_item(key, value)
       where jsonb_typeof(value) is distinct from 'number'
          or value #>> '{}' !~ '^[1-9][0-9]*$'
          or (value #>> '{}')::numeric > 9007199254740991
     )
     or jsonb_typeof(p_target_tasks) is distinct from 'array'
     or p_task_version_before is null or p_task_version_before < 1
     or p_processed_count is null or p_processed_count < 0
     or p_changed_count is null or p_changed_count < 0 then
    raise exception using errcode = '22023', message = 'invalid_lp_parent_progress_scheduler_run';
  end if;
  if p_task_version_before <> (p_source_versions ->> 'tasks')::bigint then
    raise exception using errcode = '22023', message = 'invalid_lp_parent_progress_scheduler_run';
  end if;
  target_digest := encode(extensions.digest(p_target_tasks::text, 'sha256'), 'hex');
  select * into prior from internal.lp_parent_progress_scheduler_runs scheduler_run
  where scheduler_run.run_key = p_run_key;
  if prior.run_key is not null then
    if prior.source_digest <> p_source_digest or prior.source_versions is distinct from p_source_versions
       or prior.task_version_before <> p_task_version_before or prior.target_tasks_digest <> target_digest
       or prior.processed_count <> p_processed_count or prior.changed_count <> p_changed_count then
      raise exception using errcode = '23505', message = 'lp_parent_progress_scheduler_run_conflict';
    end if;
    return query select prior.run_key, prior.outcome, prior.audit_id;
    return;
  end if;
  saved_audit := internal.append_operational_contract_audit(
    'lp.parent_progress_scheduler_start', 'LP Scheduler', 'scheduler', p_run_key,
    jsonb_build_object('sourceDigest', p_source_digest, 'sourceVersions', p_source_versions,
                       'targetTasksDigest', target_digest, 'taskVersionBefore', p_task_version_before,
                       'processedCount', p_processed_count, 'changedCount', p_changed_count)
  );
  insert into internal.lp_parent_progress_scheduler_runs(
    run_key, actor, source_digest, target_tasks_digest, source_versions, task_version_before,
    processed_count, changed_count, outcome, audit_id
  ) values (
    p_run_key, 'LP Scheduler', p_source_digest, target_digest, p_source_versions, p_task_version_before,
    p_processed_count, p_changed_count, 'running', saved_audit
  );
  return query select p_run_key, 'running'::text, saved_audit;
end;
$$;
revoke all on function public.begin_lp_parent_progress_scheduler_run(text, text, text, jsonb, bigint, jsonb, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_lp_parent_progress_scheduler_run(text, text, text, jsonb, bigint, jsonb, integer, integer)
  to anon, authenticated;

create or replace function public.finish_lp_parent_progress_scheduler_run(
  p_secret text,
  p_run_key text,
  p_outcome text,
  p_error_code text default null
) returns table(run_key text, outcome text, audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $$
declare run_row internal.lp_parent_progress_scheduler_runs%rowtype; saved_audit uuid;
  booking_state public.ops_state%rowtype; lp_state public.ops_state%rowtype; task_state public.ops_state%rowtype;
  version_after bigint;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_run_key, '') !~ '^lp-parent-progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_outcome not in ('no_change', 'failed')
     or (p_outcome = 'failed' and p_error_code is not null and length(p_error_code) > 120) then
    raise exception using errcode = '22023', message = 'invalid_lp_parent_progress_scheduler_finish';
  end if;
  select * into run_row from internal.lp_parent_progress_scheduler_runs scheduler_run
  where scheduler_run.run_key = p_run_key for update;
  if run_row.run_key is null then
    raise exception using errcode = 'P0002', message = 'lp_parent_progress_scheduler_run_missing';
  end if;
  if run_row.outcome <> 'running' then
    return query select run_row.run_key, run_row.outcome, coalesce(run_row.finished_audit_id, run_row.audit_id);
    return;
  end if;
  if p_outcome = 'no_change' then
    -- A no-change result is proven again from locked current state. Applied is
    -- intentionally impossible here; only the atomic task-write RPC may set it.
    select * into booking_state from public.ops_state where entity = 'bookings' for update;
    select * into lp_state from public.ops_state where entity = 'lpItems' for update;
    select * into task_state from public.ops_state where entity = 'tasks' for update;
    if run_row.changed_count <> 0
       or booking_state.version <> (run_row.source_versions ->> 'bookings')::bigint
       or lp_state.version <> (run_row.source_versions ->> 'lpItems')::bigint
       or task_state.version <> run_row.task_version_before
       or encode(extensions.digest(task_state.payload::text, 'sha256'), 'hex') <> run_row.target_tasks_digest then
      raise exception using errcode = '40001', message = 'version_conflict';
    end if;
    version_after := task_state.version;
  else
    version_after := null;
  end if;
  saved_audit := internal.append_operational_contract_audit(
    'lp.parent_progress_scheduler_finish', 'LP Scheduler', 'scheduler', p_run_key,
    jsonb_build_object('outcome', p_outcome, 'taskVersionBefore', run_row.task_version_before,
                       'taskVersionAfter', version_after, 'processedCount', run_row.processed_count,
                       'changedCount', run_row.changed_count, 'errorCode', p_error_code)
  );
  update internal.lp_parent_progress_scheduler_runs scheduler_run set
    task_version_after = version_after,
    outcome = p_outcome,
    error_code = nullif(left(trim(coalesce(p_error_code, '')), 120), ''),
    finished_at = now(),
    finished_audit_id = saved_audit
  where scheduler_run.run_key = p_run_key
  returning * into run_row;
  return query select run_row.run_key, run_row.outcome, run_row.finished_audit_id;
end;
$$;
revoke all on function public.finish_lp_parent_progress_scheduler_run(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_lp_parent_progress_scheduler_run(text, text, text, text)
  to anon, authenticated;

-- The scheduler must not use the generic task PUT: lpItems or bookings could
-- change after the scheduler snapshot while the tasks version remains the
-- same.  This narrow RPC locks all three authoritative inputs and rejects any
-- source-version drift before committing the derived task projection.
create or replace function public.put_lp_parent_progress_scheduler_tasks(
  p_secret text,
  p_run_key text,
  p_tasks jsonb,
  p_actor text
) returns setof public.ops_state
language plpgsql security definer set search_path = '' as $$
declare run_row internal.lp_parent_progress_scheduler_runs%rowtype;
  booking_state public.ops_state%rowtype;
  lp_state public.ops_state%rowtype;
  task_state public.ops_state%rowtype;
  saved_task_state public.ops_state%rowtype;
  saved_audit uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if jsonb_typeof(p_tasks) is distinct from 'array'
     or coalesce(p_run_key, '') !~ '^lp-parent-progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_actor is distinct from 'LP Scheduler' then
    raise exception using errcode = '22023', message = 'invalid_lp_parent_progress_scheduler_commit';
  end if;

  -- The run row is the idempotency authority and is locked first by commit and
  -- stale recovery alike. Applied is persisted in this same transaction as the
  -- task write, so an unknown HTTP response cannot leave a successful run open.
  select * into run_row from internal.lp_parent_progress_scheduler_runs scheduler_run
  where scheduler_run.run_key = p_run_key for update;
  if run_row.run_key is null then
    raise exception using errcode = 'P0002', message = 'lp_parent_progress_scheduler_run_missing';
  end if;
  if run_row.target_tasks_digest <> encode(extensions.digest(p_tasks::text, 'sha256'), 'hex') then
    raise exception using errcode = '23505', message = 'lp_parent_progress_scheduler_run_conflict';
  end if;
  if run_row.outcome = 'applied' then
    select * into task_state from public.ops_state where entity = 'tasks';
    return next task_state;
    return;
  end if;
  if run_row.outcome <> 'running' then
    raise exception using errcode = '23505', message = 'lp_parent_progress_scheduler_run_conflict';
  end if;
  if run_row.changed_count < 1 then
    raise exception using errcode = '22023', message = 'lp_parent_progress_scheduler_commit_without_changes';
  end if;

  -- Keep the same run/source/derived lock order for every scheduler write.
  select * into booking_state from public.ops_state where entity = 'bookings' for update;
  select * into lp_state from public.ops_state where entity = 'lpItems' for update;
  select * into task_state from public.ops_state where entity = 'tasks' for update;
  if booking_state.entity is null or lp_state.entity is null or task_state.entity is null then
    raise exception using errcode = '55000', message = 'lp_parent_progress_scheduler_state_missing';
  end if;
  if booking_state.version <> (run_row.source_versions ->> 'bookings')::bigint
     or lp_state.version <> (run_row.source_versions ->> 'lpItems')::bigint
     or task_state.version <> run_row.task_version_before then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  update public.ops_state set
    payload = p_tasks,
    version = task_state.version + 1,
    updated_at = now(),
    updated_by = 'LP Scheduler'
  where entity = 'tasks'
  returning * into saved_task_state;
  insert into public.ops_mutation_log(entity, version, actor)
  values ('tasks', saved_task_state.version, saved_task_state.updated_by);
  saved_audit := internal.append_operational_contract_audit(
    'lp.parent_progress_scheduler_finish', 'LP Scheduler', 'scheduler', p_run_key,
    jsonb_build_object('outcome', 'applied', 'taskVersionBefore', run_row.task_version_before,
                       'taskVersionAfter', saved_task_state.version,
                       'processedCount', run_row.processed_count,
                       'changedCount', run_row.changed_count)
  );
  update internal.lp_parent_progress_scheduler_runs scheduler_run set
    task_version_after = saved_task_state.version,
    outcome = 'applied',
    error_code = null,
    finished_at = now(),
    finished_audit_id = saved_audit
  where scheduler_run.run_key = p_run_key;
  return next saved_task_state;
  return;
end;
$$;
revoke all on function public.put_lp_parent_progress_scheduler_tasks(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.put_lp_parent_progress_scheduler_tasks(text, text, jsonb, text)
  to anon, authenticated;

-- Converges attempts interrupted after begin. A stale run can be proven
-- `no_change` only when every locked source version and the exact target task
-- digest still match. All other stale runs become `failed`; recovery never
-- fabricates `applied`, because applied is written atomically by the commit RPC.
create or replace function public.recover_stale_lp_parent_progress_scheduler_runs(
  p_secret text
) returns table(recovered_no_change integer, recovered_failed integer)
language plpgsql security definer set search_path = '' as $$
declare run_row internal.lp_parent_progress_scheduler_runs%rowtype;
  booking_state public.ops_state%rowtype; lp_state public.ops_state%rowtype; task_state public.ops_state%rowtype;
  saved_audit uuid; no_change_count integer := 0; failed_count integer := 0; recovered_outcome text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  for run_row in
    select * from internal.lp_parent_progress_scheduler_runs scheduler_run
    where scheduler_run.outcome = 'running' and scheduler_run.started_at < clock_timestamp() - interval '30 minutes'
    order by scheduler_run.started_at
    limit 100
    for update skip locked
  loop
    select * into booking_state from public.ops_state where entity = 'bookings' for update;
    select * into lp_state from public.ops_state where entity = 'lpItems' for update;
    select * into task_state from public.ops_state where entity = 'tasks' for update;
    if run_row.changed_count = 0
       and booking_state.entity is not null and lp_state.entity is not null and task_state.entity is not null
       and booking_state.version = (run_row.source_versions ->> 'bookings')::bigint
       and lp_state.version = (run_row.source_versions ->> 'lpItems')::bigint
       and task_state.version = run_row.task_version_before
       and encode(extensions.digest(task_state.payload::text, 'sha256'), 'hex') = run_row.target_tasks_digest then
      recovered_outcome := 'no_change';
      no_change_count := no_change_count + 1;
    else
      recovered_outcome := 'failed';
      failed_count := failed_count + 1;
    end if;
    saved_audit := internal.append_operational_contract_audit(
      'lp.parent_progress_scheduler_recover', 'LP Scheduler', 'scheduler', run_row.run_key,
      jsonb_build_object('outcome', recovered_outcome, 'taskVersionBefore', run_row.task_version_before,
                         'taskVersionObserved', task_state.version,
                         'processedCount', run_row.processed_count,
                         'changedCount', run_row.changed_count,
                         'reason', case when recovered_outcome = 'no_change'
                           then 'stale_run_exact_no_change_proof' else 'stale_unfinished_run' end)
    );
    update internal.lp_parent_progress_scheduler_runs scheduler_run set
      task_version_after = case when recovered_outcome = 'no_change' then task_state.version else null end,
      outcome = recovered_outcome,
      error_code = case when recovered_outcome = 'failed' then 'stale_unfinished_run' else null end,
      finished_at = now(),
      finished_audit_id = saved_audit
    where scheduler_run.run_key = run_row.run_key and scheduler_run.outcome = 'running';
  end loop;
  return query select no_change_count, failed_count;
end;
$$;
revoke all on function public.recover_stale_lp_parent_progress_scheduler_runs(text)
  from public, anon, authenticated, service_role;
grant execute on function public.recover_stale_lp_parent_progress_scheduler_runs(text)
  to anon, authenticated;
