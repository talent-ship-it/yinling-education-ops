-- Migration 20260819101800: enforce the deadline contract for executable To Do tasks.
--
-- `due` is historical display/evidence only.  It is never parsed here.  An
-- open task is executable only when dueAt is an exact, valid ISO instant.  A
-- pre-existing open row that cannot be repaired from authoritative data is
-- preserved in full and marked as frozen legacy evidence; it is not shown in
-- the executable To Do queue.  The 191008 manual route may later attach one
-- explicitly entered Melbourne deadline and thereby thaw that one row.

set local lock_timeout = '1s';

create or replace function internal.task_due_at_is_canonical(p_due_at text)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $task_due_at_is_canonical$
begin
  if coalesce(p_due_at, '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
    return false;
  end if;
  return pg_catalog.to_char(
    p_due_at::timestamptz at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) = p_due_at;
exception when others then
  return false;
end;
$task_due_at_is_canonical$;

revoke all on function internal.task_due_at_is_canonical(text)
  from public, anon, authenticated, service_role;

create table if not exists internal.legacy_task_deadline_freezes (
  task_id text primary key check (task_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  original_task jsonb not null check (jsonb_typeof(original_task) = 'object'),
  frozen_task jsonb not null check (jsonb_typeof(frozen_task) = 'object'),
  reason text not null check (reason = 'missing_canonical_due_at'),
  ownership text not null check (ownership in ('legacy_manual', 'managed_rule')),
  rule_key text,
  anchor_booking_id text,
  frozen_at timestamptz not null,
  thawed_at timestamptz,
  thaw_source text check (thaw_source in ('legacy_manual', 'managed_workflow')),
  thaw_actor text,
  thaw_workflow text,
  thaw_due_at text check (
    thaw_due_at is null or internal.task_due_at_is_canonical(thaw_due_at)
  ),
  thaw_command_key text check (
    thaw_command_key is null
    or thaw_command_key ~ '^legacy-task-deadline:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or thaw_command_key ~ '^lp-parent-progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  check (
    (ownership = 'legacy_manual' and rule_key is null and anchor_booking_id is null)
    or ownership = 'managed_rule'
  ),
  check (
    (thawed_at is null and thaw_source is null and thaw_actor is null
      and thaw_workflow is null and thaw_due_at is null and thaw_command_key is null)
    or (thawed_at is not null and nullif(btrim(thaw_actor), '') is not null and (
      (thaw_source = 'legacy_manual'
        and thaw_workflow is null
        and thaw_due_at is not null
        and thaw_command_key ~ '^legacy-task-deadline:')
      or (thaw_source = 'managed_workflow'
        and thaw_workflow = 'lp-parent-progress'
        and thaw_due_at is not null
        and thaw_command_key ~ '^lp-parent-progress:')
    ))
  )
);

alter table internal.legacy_task_deadline_freezes enable row level security;
revoke all on table internal.legacy_task_deadline_freezes
  from public, anon, authenticated, service_role;

-- Freeze every open row without a canonical deadline.  A pre-existing
-- legacyEvidence marker is also authoritative freeze state even when dueAt is
-- canonical: it must be explicitly thawed, never silently made executable.
-- Keep the complete pre-migration JSON in the internal evidence ledger.
do $freeze_legacy_task_deadlines$
declare
  task_state public.ops_state%rowtype;
  next_payload jsonb;
  item record;
  frozen jsonb;
  frozen_at_value timestamptz;
begin
  select * into task_state
  from public.ops_state
  where entity = 'tasks'
  for update;
  if task_state.entity is null then
    raise exception using errcode = 'P0002', message = 'tasks_ops_state_missing';
  end if;
  if jsonb_typeof(task_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'tasks_payload_invalid';
  end if;

  next_payload := '[]'::jsonb;
  for item in
    select value, ordinality
    from jsonb_array_elements(task_state.payload) with ordinality
    order by ordinality
  loop
    frozen := item.value;
    if (coalesce(item.value ->> 'status', '') <> 'done'
          and not internal.task_due_at_is_canonical(item.value ->> 'dueAt'))
       or item.value ? 'legacyEvidence' then
      if item.value #>> '{legacyEvidence,state}' = 'frozen'
         and item.value #>> '{legacyEvidence,reason}' = 'missing_canonical_due_at'
         and internal.task_due_at_is_canonical(item.value #>> '{legacyEvidence,frozenAt}') then
        frozen_at_value := (item.value #>> '{legacyEvidence,frozenAt}')::timestamptz;
      else
        frozen_at_value := clock_timestamp();
        frozen := item.value || jsonb_build_object(
          'legacyEvidence', jsonb_strip_nulls(jsonb_build_object(
            'state', 'frozen',
            'reason', 'missing_canonical_due_at',
            'sourceDue', item.value -> 'due',
            'sourceDueAt', item.value -> 'dueAt',
            'frozenAt', pg_catalog.to_char(
              frozen_at_value at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          ))
        );
      end if;
      insert into internal.legacy_task_deadline_freezes (
        task_id, original_task, frozen_task, reason, ownership,
        rule_key, anchor_booking_id, frozen_at
      ) values (
        item.value ->> 'id', item.value, frozen,
        'missing_canonical_due_at',
        case when item.value ? 'ruleKey' or item.value ? 'anchorBookingId'
          then 'managed_rule' else 'legacy_manual' end,
        nullif(btrim(item.value ->> 'ruleKey'), ''),
        nullif(btrim(item.value ->> 'anchorBookingId'), ''),
        frozen_at_value
      ) on conflict (task_id) do nothing;
    end if;
    next_payload := next_payload || jsonb_build_array(frozen);
  end loop;

  if next_payload is distinct from task_state.payload then
    update public.ops_state
    set payload = next_payload,
        version = version + 1,
        updated_at = clock_timestamp(),
        updated_by = 'deadline-invariant-migration'
    where entity = 'tasks';
    insert into public.ops_mutation_log(entity, version, actor)
    select 'tasks', version, 'deadline-invariant-migration'
    from public.ops_state where entity = 'tasks';
  end if;
end;
$freeze_legacy_task_deadlines$;

create or replace function internal.enforce_ops_task_canonical_deadlines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $enforce_ops_task_canonical_deadlines$
declare
  task jsonb;
  old_task jsonb;
  freeze_record internal.legacy_task_deadline_freezes%rowtype;
  task_id_value text;
  status_value text;
  has_evidence boolean;
  frozen boolean;
  command_key_value text;
  command_task_id_value text;
  managed_workflow_value text;
  managed_source_sha256_value text;
  managed_target_sha256_value text;
  managed_actor_value text;
  updated_count integer;
begin
  if new.entity <> 'tasks' then return new; end if;
  if jsonb_typeof(new.payload) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'tasks_payload_invalid';
  end if;
  if exists (
    select 1 from jsonb_array_elements(new.payload) item(value)
    where jsonb_typeof(value) is distinct from 'object'
       or nullif(btrim(value ->> 'id'), '') is null
  ) or exists (
    select 1 from jsonb_array_elements(new.payload) item(value)
    group by value ->> 'id' having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'tasks_payload_invalid';
  end if;

  if tg_op = 'UPDATE' then
    for old_task in
      select value
      from jsonb_array_elements(coalesce(old.payload, '[]'::jsonb)) item(value)
      where exists (
        select 1 from internal.legacy_task_deadline_freezes ledger
        where ledger.task_id = value ->> 'id'
      )
    loop
      if not exists (
        select 1
        from jsonb_array_elements(new.payload) item(value)
        where value ->> 'id' = old_task ->> 'id'
      ) then
        raise exception using errcode = '42501', message = 'legacy_task_evidence_delete_forbidden';
      end if;
    end loop;
  end if;

  for task in select value from jsonb_array_elements(new.payload) item(value)
  loop
    task_id_value := nullif(btrim(task ->> 'id'), '');
    if task_id_value is null then
      raise exception using errcode = '22023', message = 'task_id_invalid';
    end if;
    status_value := coalesce(task ->> 'status', '');
    has_evidence := task ? 'legacyEvidence';
    frozen := has_evidence and coalesce(task #>> '{legacyEvidence,state}', '') = 'frozen';
    if has_evidence and (
      not frozen
      or task #>> '{legacyEvidence,reason}' <> 'missing_canonical_due_at'
      or not internal.task_due_at_is_canonical(task #>> '{legacyEvidence,frozenAt}')
    ) then
      raise exception using errcode = '22023', message = 'legacy_task_evidence_invalid';
    end if;

    old_task := null;
    if tg_op = 'UPDATE' then
      select value into old_task
      from jsonb_array_elements(coalesce(old.payload, '[]'::jsonb)) item(value)
      where value ->> 'id' = task_id_value;
    end if;

    select * into freeze_record
    from internal.legacy_task_deadline_freezes ledger
    where ledger.task_id = task_id_value;

    if has_evidence and (
      freeze_record.task_id is null
      or freeze_record.thawed_at is not null
      or freeze_record.frozen_task is distinct from task
    ) then
      raise exception using errcode = '42501', message = 'legacy_task_evidence_not_active';
    end if;

    if old_task is null then
      if has_evidence or freeze_record.task_id is not null then
        raise exception using errcode = '42501', message = 'legacy_task_evidence_insert_forbidden';
      end if;
    elsif freeze_record.task_id is not null
       and freeze_record.thawed_at is null
       and old_task is not distinct from task then
      -- Unrelated state writes may carry frozen evidence through byte-for-byte.
      continue;
    elsif freeze_record.task_id is not null
       and freeze_record.thawed_at is null then
      if freeze_record.frozen_task is distinct from old_task
         or old_task #>> '{legacyEvidence,state}' <> 'frozen'
         or task ? 'legacyEvidence'
         or not internal.task_due_at_is_canonical(task ->> 'dueAt') then
        raise exception using errcode = '42501', message = 'legacy_task_evidence_immutable';
      end if;

      if freeze_record.ownership = 'legacy_manual' then
        command_key_value := current_setting('app.legacy_task_deadline_command_key', true);
        command_task_id_value := current_setting('app.legacy_task_deadline_task_id', true);
        if coalesce(command_key_value, '')
             !~ '^legacy-task-deadline:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           or command_task_id_value is distinct from task_id_value
           or (old_task - 'dueAt' - 'legacyEvidence')
             is distinct from (task - 'dueAt' - 'legacyEvidence') then
          raise exception using errcode = '42501', message = 'legacy_task_manual_thaw_requires_191008_command';
        end if;
        update internal.legacy_task_deadline_freezes ledger
        set thawed_at = clock_timestamp(),
            thaw_source = 'legacy_manual',
            thaw_actor = left(coalesce(new.updated_by, ''), 120),
            thaw_due_at = task ->> 'dueAt',
            thaw_command_key = command_key_value
        where ledger.task_id = task_id_value
          and ledger.thawed_at is null
          and ledger.thaw_command_key is null;
      else
        if (freeze_record.rule_key is not null
              and task ->> 'ruleKey' is distinct from freeze_record.rule_key)
           or (freeze_record.anchor_booking_id is not null
              and task ->> 'anchorBookingId' is distinct from freeze_record.anchor_booking_id)
           or nullif(btrim(task ->> 'ruleKey'), '') is null
           or nullif(btrim(task ->> 'anchorBookingId'), '') is null
           or (old_task - 'dueAt' - 'legacyEvidence')
             is distinct from (task - 'dueAt' - 'legacyEvidence') then
          raise exception using errcode = '42501', message = 'managed_task_authoritative_identity_changed';
        end if;
        command_key_value := current_setting('app.managed_task_deadline_command_key', true);
        managed_workflow_value := current_setting('app.managed_task_deadline_workflow', true);
        managed_source_sha256_value := current_setting('app.managed_task_deadline_source_sha256', true);
        managed_target_sha256_value := current_setting('app.managed_task_deadline_target_sha256', true);
        managed_actor_value := current_setting('app.managed_task_deadline_actor', true);
        if managed_workflow_value is distinct from 'lp-parent-progress'
           or coalesce(command_key_value, '')
             !~ '^lp-parent-progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           or managed_actor_value is distinct from 'LP Scheduler'
           or new.updated_by is distinct from managed_actor_value
           or coalesce(managed_source_sha256_value, '') !~ '^[a-f0-9]{64}$'
           or managed_source_sha256_value is distinct from
             encode(extensions.digest(old.payload::text, 'sha256'), 'hex')
           or coalesce(managed_target_sha256_value, '') !~ '^[a-f0-9]{64}$'
           or managed_target_sha256_value is distinct from
             encode(extensions.digest(new.payload::text, 'sha256'), 'hex')
           or task ->> 'ruleKey' !~ '^trial\.parent-progress-sync\.[1-9][0-9]*$'
           or not exists (
             select 1
             from internal.lp_parent_progress_scheduler_runs scheduler_run
             where scheduler_run.run_key = command_key_value
               and scheduler_run.outcome = 'running'
               and scheduler_run.actor = managed_actor_value
               and scheduler_run.target_tasks_digest = managed_target_sha256_value
               and scheduler_run.task_version_before = old.version
           ) then
          raise exception using errcode = '42501', message = 'managed_task_thaw_requires_authoritative_workflow';
        end if;
        update internal.legacy_task_deadline_freezes ledger
        set thawed_at = clock_timestamp(),
            thaw_source = 'managed_workflow',
            thaw_actor = left(coalesce(new.updated_by, ''), 120),
            thaw_workflow = managed_workflow_value,
            thaw_due_at = task ->> 'dueAt',
            thaw_command_key = command_key_value
        where ledger.task_id = task_id_value
          and ledger.thawed_at is null
          and ledger.thaw_command_key is null;
      end if;
      get diagnostics updated_count = row_count;
      if updated_count <> 1 then
        raise exception using errcode = '40001', message = 'legacy_task_thaw_conflict';
      end if;
    end if;

    if status_value <> 'done' and not internal.task_due_at_is_canonical(task ->> 'dueAt') then
      raise exception using errcode = '22023', message = 'open_task_requires_canonical_due_at';
    end if;
    if (task ? 'ruleKey' or task ? 'anchorBookingId')
       and (nullif(btrim(task ->> 'ruleKey'), '') is null
         or nullif(btrim(task ->> 'anchorBookingId'), '') is null) then
      raise exception using errcode = '22023', message = 'managed_task_anchor_required';
    end if;
  end loop;
  return new;
end;
$enforce_ops_task_canonical_deadlines$;

drop trigger if exists ops_state_enforce_task_canonical_deadlines on public.ops_state;
create trigger ops_state_enforce_task_canonical_deadlines
before insert or update of payload on public.ops_state
for each row execute function internal.enforce_ops_task_canonical_deadlines();

revoke all on function internal.enforce_ops_task_canonical_deadlines()
  from public, anon, authenticated, service_role;

-- The ordinary app-state writer never receives a managed thaw capability.
-- This replacement LP scheduler commit is narrow because its run ledger has
-- already bound the authoritative bookings/lpItems versions and the complete
-- target task digest.  The transaction-local capability is set only after all
-- locks, OCC checks and digest checks pass, and the trigger consumes it while
-- validating each exact dueAt-only thaw.
create or replace function public.put_lp_parent_progress_scheduler_tasks_authoritative(
  p_secret text,
  p_run_key text,
  p_tasks jsonb,
  p_actor text
)
returns setof public.ops_state
language plpgsql
security definer
set search_path = ''
as $put_lp_parent_progress_scheduler_tasks_authoritative$
declare
  run_row internal.lp_parent_progress_scheduler_runs%rowtype;
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
     or coalesce(p_run_key, '')
       !~ '^lp-parent-progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_actor is distinct from 'LP Scheduler' then
    raise exception using errcode = '22023', message = 'invalid_lp_parent_progress_scheduler_commit';
  end if;

  select * into run_row
  from internal.lp_parent_progress_scheduler_runs scheduler_run
  where scheduler_run.run_key = p_run_key
  for update;
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

  perform set_config('app.managed_task_deadline_workflow', 'lp-parent-progress', true);
  perform set_config('app.managed_task_deadline_command_key', p_run_key, true);
  perform set_config(
    'app.managed_task_deadline_source_sha256',
    encode(extensions.digest(task_state.payload::text, 'sha256'), 'hex'),
    true
  );
  perform set_config('app.managed_task_deadline_target_sha256', run_row.target_tasks_digest, true);
  perform set_config('app.managed_task_deadline_actor', 'LP Scheduler', true);

  update public.ops_state state
  set payload = p_tasks,
      version = state.version + 1,
      updated_at = clock_timestamp(),
      updated_by = 'LP Scheduler'
  where state.entity = 'tasks'
  returning * into saved_task_state;
  insert into public.ops_mutation_log(entity, version, actor)
  values ('tasks', saved_task_state.version, saved_task_state.updated_by);

  saved_audit := internal.append_operational_contract_audit(
    'lp.parent_progress_scheduler_finish',
    'LP Scheduler',
    'scheduler',
    p_run_key,
    jsonb_build_object(
      'outcome', 'applied',
      'taskVersionBefore', run_row.task_version_before,
      'taskVersionAfter', saved_task_state.version,
      'processedCount', run_row.processed_count,
      'changedCount', run_row.changed_count,
      'managedDeadlineCapability', true,
      'targetTasksSha256', run_row.target_tasks_digest
    )
  );
  update internal.lp_parent_progress_scheduler_runs scheduler_run
  set task_version_after = saved_task_state.version,
      outcome = 'applied',
      error_code = null,
      finished_at = clock_timestamp(),
      finished_audit_id = saved_audit
  where scheduler_run.run_key = p_run_key;
  return next saved_task_state;
  return;
end;
$put_lp_parent_progress_scheduler_tasks_authoritative$;

revoke all on function public.put_lp_parent_progress_scheduler_tasks_authoritative(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.put_lp_parent_progress_scheduler_tasks_authoritative(text, text, jsonb, text)
  to anon, authenticated;

-- Replace the 191008 writer so a manual thaw is one transaction spanning the
-- public task projection, the immutable freeze ledger, the command ledger and
-- operational audit.  A browser still supplies only Melbourne wall-clock
-- input; it never supplies UTC dueAt or a task projection.
create or replace function public.mutate_legacy_task_deadline_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_expected_versions jsonb,
  p_actor text
)
returns table (
  command_key text,
  action text,
  applied boolean,
  task_id text,
  due_at text,
  task_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $mutate_legacy_task_deadline_atomic$
declare
  student_state public.ops_state%rowtype;
  task_state public.ops_state%rowtype;
  saved_task_state public.ops_state%rowtype;
  prior internal.legacy_task_deadline_commands%rowtype;
  freeze_record internal.legacy_task_deadline_freezes%rowtype;
  expected_students_version bigint;
  expected_tasks_version bigint;
  identity_value jsonb;
  current_task jsonb;
  committed_task jsonb;
  projection jsonb;
  due_at_value text;
  action_value text;
  command_applied boolean;
  evidence_thawed boolean := false;
  audit_id uuid;
  committed_at timestamptz;
  payload_hash text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  perform internal.validate_legacy_task_deadline_intent(p_command_intent);
  if coalesce(p_command_key, '')
       !~ '^legacy-task-deadline:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'students' - 'tasks' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'students') is distinct from 'number'
     or coalesce(p_expected_versions ->> 'students', '') !~ '^[1-9][0-9]*$'
     or jsonb_typeof(p_expected_versions -> 'tasks') is distinct from 'number'
     or coalesce(p_expected_versions ->> 'tasks', '') !~ '^[1-9][0-9]*$'
     or coalesce(p_actor, '') not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023', message = 'invalid_legacy_task_deadline_command';
  end if;
  begin
    expected_students_version := (p_expected_versions ->> 'students')::bigint;
    expected_tasks_version := (p_expected_versions ->> 'tasks')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_legacy_task_deadline_command';
  end;

  select * into student_state from public.ops_state state
  where state.entity = 'students' for update;
  select * into task_state from public.ops_state state
  where state.entity = 'tasks' for update;
  if student_state.entity is null or task_state.entity is null
     or jsonb_typeof(student_state.payload) is distinct from 'array'
     or jsonb_typeof(task_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'legacy_task_deadline_state_missing';
  end if;

  select * into prior from internal.legacy_task_deadline_commands command
  where command.command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent
       or prior.actor <> p_actor
       or prior.action <> p_command_intent ->> 'action'
       or prior.task_id <> p_command_intent ->> 'taskId' then
      raise exception using errcode = '23505', message = 'legacy_task_deadline_idempotency_conflict';
    end if;
    return query select prior.command_key, prior.action, false, prior.task_id,
      prior.due_at, task_state, prior.audit_id;
    return;
  end if;

  if student_state.version is distinct from expected_students_version
     or task_state.version is distinct from expected_tasks_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  identity_value := internal.legacy_task_deadline_identity(
    student_state.payload,
    task_state.payload,
    p_command_intent ->> 'taskId'
  );
  current_task := identity_value -> 'task';
  action_value := p_command_intent ->> 'action';
  if action_value <> 'set' then
    raise exception using errcode = '22023', message = 'legacy_task_deadline_clear_disabled';
  end if;

  due_at_value := pg_catalog.to_char(
    internal.legacy_task_deadline_melbourne_instant(p_command_intent ->> 'melbourneDateTime')
      at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  committed_task := (current_task - 'legacyEvidence')
    || jsonb_build_object('dueAt', due_at_value);
  command_applied := committed_task is distinct from current_task;

  if current_task #>> '{legacyEvidence,state}' = 'frozen' then
    select * into freeze_record
    from internal.legacy_task_deadline_freezes ledger
    where ledger.task_id = identity_value ->> 'taskId'
    for update;
    if freeze_record.task_id is null
       or freeze_record.ownership <> 'legacy_manual'
       or freeze_record.frozen_task is distinct from current_task
       or freeze_record.thawed_at is not null
       or freeze_record.thaw_command_key is not null then
      raise exception using errcode = '40001', message = 'legacy_task_deadline_freeze_conflict';
    end if;
    perform set_config('app.legacy_task_deadline_command_key', p_command_key, true);
    perform set_config('app.legacy_task_deadline_task_id', identity_value ->> 'taskId', true);
    evidence_thawed := true;
  end if;

  committed_at := clock_timestamp();
  if command_applied then
    projection := internal.legacy_task_deadline_replace(
      task_state.payload,
      identity_value ->> 'taskId',
      committed_task
    );
    update public.ops_state state set
      payload = projection,
      version = state.version + 1,
      updated_at = committed_at,
      updated_by = p_actor
    where state.entity = 'tasks'
    returning * into saved_task_state;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved_task_state.version, p_actor);
  else
    saved_task_state := task_state;
  end if;

  if evidence_thawed then
    select * into freeze_record
    from internal.legacy_task_deadline_freezes ledger
    where ledger.task_id = identity_value ->> 'taskId';
    if freeze_record.thawed_at is null
       or freeze_record.thaw_source <> 'legacy_manual'
       or freeze_record.thaw_actor <> p_actor
       or freeze_record.thaw_workflow is not null
       or freeze_record.thaw_due_at <> due_at_value
       or freeze_record.thaw_command_key <> p_command_key then
      raise exception using errcode = '40001', message = 'legacy_task_deadline_freeze_commit_missing';
    end if;
  end if;

  payload_hash := encode(extensions.digest(pg_catalog.convert_to(
    p_command_intent::text || chr(31) || current_task::text || chr(31) || committed_task::text,
    'UTF8'
  ), 'sha256'), 'hex');
  audit_id := internal.append_operational_contract_audit(
    case when command_applied then 'legacy_task_deadline.set'
      else 'legacy_task_deadline.set_unchanged' end,
    p_actor,
    'task',
    identity_value ->> 'taskId',
    jsonb_build_object(
      'commandKey', p_command_key,
      'action', action_value,
      'melbourneDateTime', p_command_intent ->> 'melbourneDateTime',
      'dueAt', due_at_value,
      'applied', command_applied,
      'legacyEvidenceThawed', evidence_thawed,
      'versionsBefore', p_expected_versions,
      'versionsAfter', jsonb_build_object(
        'students', student_state.version,
        'tasks', saved_task_state.version
      ),
      'payloadSha256', payload_hash
    )
  );
  insert into internal.legacy_task_deadline_commands (
    command_key, command_intent, command_hash, action, task_id,
    melbourne_datetime, due_at, applied, prior_task, committed_task,
    students_version, tasks_version, actor, applied_at, audit_id
  ) values (
    p_command_key, p_command_intent, payload_hash, action_value,
    identity_value ->> 'taskId',
    p_command_intent ->> 'melbourneDateTime',
    due_at_value, command_applied, current_task, committed_task,
    student_state.version, saved_task_state.version, p_actor, committed_at, audit_id
  );
  return query select p_command_key, action_value, command_applied,
    identity_value ->> 'taskId', due_at_value, saved_task_state, audit_id;
end;
$mutate_legacy_task_deadline_atomic$;

revoke all on function public.mutate_legacy_task_deadline_atomic(text, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mutate_legacy_task_deadline_atomic(text, text, jsonb, jsonb, text)
  to anon, authenticated;

-- Pure migration contract: historical copy is evidence, never a deadline.
do $task_deadline_invariant_fixture$
declare
  legacy jsonb := '{"id":"TSK-LEGACY","due":"发布后立即","status":"waiting"}'::jsonb;
  frozen jsonb;
begin
  if internal.task_due_at_is_canonical(legacy ->> 'due')
     or internal.task_due_at_is_canonical('2026-02-30T08:00:00.000Z')
     or not internal.task_due_at_is_canonical('2026-08-19T08:00:00.000Z') then
    raise exception 'task_deadline_canonical_fixture_failed';
  end if;
  frozen := legacy || jsonb_build_object(
    'legacyEvidence', jsonb_build_object(
      'state', 'frozen', 'reason', 'missing_canonical_due_at',
      'frozenAt', '2026-08-19T08:00:00.000Z'
    )
  );
  if frozen #>> '{legacyEvidence,state}' <> 'frozen'
     or frozen ->> 'due' <> '发布后立即'
     or frozen ? 'dueAt' then
    raise exception 'task_deadline_legacy_evidence_fixture_failed';
  end if;
end;
$task_deadline_invariant_fixture$;
