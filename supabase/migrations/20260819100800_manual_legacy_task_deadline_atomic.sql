-- Manual repair path for legacy To Do rows that predate canonical dueAt.
--
-- Historical `due` copy is descriptive evidence only; this migration never
-- derives, backfills, or replaces it. A high-tier server route may write one
-- explicit Australia/Melbourne wall-clock deadline, or clear a prior manual
-- deadline, for an open task that has neither a ruleKey nor an anchorBookingId.
-- Rule-managed tasks remain exclusively owned by their workflow projections.

set local lock_timeout = '1s';

create table if not exists internal.legacy_task_deadline_commands (
  command_key text primary key check (
    command_key ~ '^legacy-task-deadline:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('set', 'clear')),
  task_id text not null check (task_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  melbourne_datetime text,
  due_at text check (
    due_at is null or due_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ),
  applied boolean not null,
  prior_task jsonb not null check (jsonb_typeof(prior_task) = 'object'),
  committed_task jsonb not null check (jsonb_typeof(committed_task) = 'object'),
  students_version bigint not null check (students_version > 0),
  tasks_version bigint not null check (tasks_version > 0),
  actor text not null check (actor in ('Nixon', 'Ops Admin')),
  applied_at timestamptz not null default clock_timestamp(),
  audit_id uuid not null references internal.operational_contract_audit(id) on delete restrict,
  check (
    (action = 'set'
      and melbourne_datetime ~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
      and due_at is not null)
    or (action = 'clear' and melbourne_datetime is null and due_at is null)
  ),
  check (
    (applied and prior_task is distinct from committed_task)
    or (not applied and prior_task = committed_task)
  )
);

alter table internal.legacy_task_deadline_commands enable row level security;
revoke all on table internal.legacy_task_deadline_commands from public, anon, authenticated, service_role;

-- PostgreSQL's normal timestamp conversion silently chooses one side of a DST
-- overlap. For an operator-entered deadline that would not be exact, reject
-- both a non-existent spring-forward minute and a repeated fall-back minute.
create or replace function internal.legacy_task_deadline_melbourne_instant(
  p_melbourne_datetime text
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $legacy_task_deadline_melbourne_instant$
declare
  local_wall_clock timestamp without time zone;
  candidate timestamptz;
begin
  if coalesce(p_melbourne_datetime, '')
       !~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception using errcode = '22023', message = 'legacy_task_deadline_melbourne_time_invalid';
  end if;
  begin
    local_wall_clock := p_melbourne_datetime::timestamp without time zone;
    if pg_catalog.to_char(local_wall_clock, 'YYYY-MM-DD"T"HH24:MI') <> p_melbourne_datetime then
      raise exception using errcode = '22023', message = 'legacy_task_deadline_melbourne_time_invalid';
    end if;
  exception when others then
    raise exception using errcode = '22023', message = 'legacy_task_deadline_melbourne_time_invalid';
  end;

  candidate := local_wall_clock at time zone 'Australia/Melbourne';
  if pg_catalog.to_char(
    candidate at time zone 'Australia/Melbourne',
    'YYYY-MM-DD"T"HH24:MI'
  ) <> p_melbourne_datetime then
    raise exception using errcode = '22023', message = 'legacy_task_deadline_melbourne_time_nonexistent';
  end if;
  if ((candidate - interval '1 hour') at time zone 'Australia/Melbourne') = local_wall_clock
     or ((candidate + interval '1 hour') at time zone 'Australia/Melbourne') = local_wall_clock then
    raise exception using errcode = '22023', message = 'legacy_task_deadline_melbourne_time_ambiguous';
  end if;
  return candidate;
end;
$legacy_task_deadline_melbourne_instant$;

revoke all on function internal.legacy_task_deadline_melbourne_instant(text)
  from public, anon, authenticated, service_role;

create or replace function internal.validate_legacy_task_deadline_intent(
  p_intent jsonb
)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $validate_legacy_task_deadline_intent$
begin
  if jsonb_typeof(p_intent) is distinct from 'object'
     or p_intent - 'action' - 'taskId' - 'melbourneDateTime' <> '{}'::jsonb
     or coalesce(p_intent ->> 'action', '') not in ('set', 'clear')
     or coalesce(p_intent ->> 'taskId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or (p_intent ->> 'action' = 'set' and (
       jsonb_typeof(p_intent -> 'melbourneDateTime') is distinct from 'string'
       or p_intent ->> 'melbourneDateTime'
          !~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$'
     ))
     or (p_intent ->> 'action' = 'clear' and p_intent ? 'melbourneDateTime') then
    raise exception using errcode = '22023', message = 'invalid_legacy_task_deadline_intent';
  end if;
  if p_intent ->> 'action' = 'set' then
    perform internal.legacy_task_deadline_melbourne_instant(p_intent ->> 'melbourneDateTime');
  end if;
end;
$validate_legacy_task_deadline_intent$;

revoke all on function internal.validate_legacy_task_deadline_intent(jsonb)
  from public, anon, authenticated, service_role;

-- Resolves only a legacy/manual task. A missing student record is allowed:
-- historic tasks can legitimately retain an unlinked former student ID. An
-- extant archived student remains immutable just as it is in the generic
-- ops-state transition guard.
create or replace function internal.legacy_task_deadline_identity(
  p_students jsonb,
  p_tasks jsonb,
  p_task_id text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $legacy_task_deadline_identity$
declare
  task_value jsonb;
  student_value jsonb;
  student_id_value text;
begin
  if jsonb_typeof(p_students) is distinct from 'array'
     or jsonb_typeof(p_tasks) is distinct from 'array'
     or coalesce(p_task_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or exists (
       select 1 from jsonb_array_elements(p_students) item(value)
       where jsonb_typeof(item.value) is distinct from 'object'
          or nullif(btrim(item.value ->> 'id'), '') is null
          or item.value ->> 'id' <> btrim(item.value ->> 'id')
     )
     or exists (
       select 1 from jsonb_array_elements(p_students) item(value)
       group by item.value ->> 'id' having count(*) > 1
     )
     or exists (
       select 1 from jsonb_array_elements(p_tasks) item(value)
       where jsonb_typeof(item.value) is distinct from 'object'
          or nullif(btrim(item.value ->> 'id'), '') is null
          or item.value ->> 'id' <> btrim(item.value ->> 'id')
     )
     or exists (
       select 1 from jsonb_array_elements(p_tasks) item(value)
       group by item.value ->> 'id' having count(*) > 1
     ) then
    raise exception using errcode = '55000', message = 'legacy_task_deadline_state_invalid';
  end if;

  select item.value into task_value
  from jsonb_array_elements(p_tasks) item(value)
  where item.value ->> 'id' = p_task_id;
  if task_value is null then
    raise exception using errcode = 'P0002', message = 'legacy_task_deadline_task_not_found';
  end if;
  if task_value ? 'ruleKey' or task_value ? 'anchorBookingId' then
    raise exception using errcode = '22023', message = 'legacy_task_deadline_task_not_legacy';
  end if;
  if task_value ->> 'status' = 'done' then
    raise exception using errcode = '22023', message = 'legacy_task_deadline_task_closed';
  end if;
  student_id_value := nullif(btrim(task_value ->> 'studentId'), '');
  if student_id_value is null then
    raise exception using errcode = '55000', message = 'legacy_task_deadline_task_student_invalid';
  end if;
  select item.value into student_value
  from jsonb_array_elements(p_students) item(value)
  where item.value ->> 'id' = student_id_value;
  if student_value ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'legacy_task_deadline_archived_student';
  end if;
  return jsonb_build_object(
    'taskId', p_task_id,
    'studentId', student_id_value,
    'task', task_value
  );
end;
$legacy_task_deadline_identity$;

revoke all on function internal.legacy_task_deadline_identity(jsonb, jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function internal.legacy_task_deadline_replace(
  p_tasks jsonb,
  p_task_id text,
  p_next_task jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $legacy_task_deadline_replace$
declare
  next_tasks jsonb;
begin
  if jsonb_typeof(p_tasks) is distinct from 'array'
     or coalesce(p_task_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or jsonb_typeof(p_next_task) is distinct from 'object'
     or p_next_task ->> 'id' is distinct from p_task_id then
    raise exception using errcode = '22023', message = 'legacy_task_deadline_projection_invalid';
  end if;
  select jsonb_agg(
    case when item.value ->> 'id' = p_task_id then p_next_task else item.value end
    order by item.ordinality
  ) into next_tasks
  from jsonb_array_elements(p_tasks) with ordinality item(value, ordinality);
  if next_tasks is null then
    raise exception using errcode = '22023', message = 'legacy_task_deadline_projection_invalid';
  end if;
  return next_tasks;
end;
$legacy_task_deadline_replace$;

revoke all on function internal.legacy_task_deadline_replace(jsonb, text, jsonb)
  from public, anon, authenticated, service_role;

-- Server-only replay lookup. It contains no task payload and is actor-bound;
-- the Next.js route re-authorizes from a fresh state read before returning it.
create or replace function public.get_legacy_task_deadline_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_actor text
)
returns table (
  command_key text,
  action text,
  applied boolean,
  task_id text,
  due_at text,
  audit_entry_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $get_legacy_task_deadline_command_result$
declare
  prior internal.legacy_task_deadline_commands%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  perform internal.validate_legacy_task_deadline_intent(p_command_intent);
  if coalesce(p_command_key, '')
       !~ '^legacy-task-deadline:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_actor, '') not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023', message = 'invalid_legacy_task_deadline_replay_lookup';
  end if;
  select * into prior from internal.legacy_task_deadline_commands c
  where c.command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent
     or prior.actor <> p_actor
     or prior.action <> p_command_intent ->> 'action'
     or prior.task_id <> p_command_intent ->> 'taskId' then
    raise exception using errcode = '23505', message = 'legacy_task_deadline_idempotency_conflict';
  end if;
  return query select prior.command_key, prior.action, prior.applied, prior.task_id,
    prior.due_at, prior.audit_id;
end;
$get_legacy_task_deadline_command_result$;

revoke all on function public.get_legacy_task_deadline_command_result(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_legacy_task_deadline_command_result(text, text, jsonb, text)
  to anon, authenticated;

-- One server-owned task projection and one append-only audit receipt. Every
-- accepted command, including a set-identical/clear-missing no-op, receives a
-- ledger receipt under the same locks so it can never be reinterpreted after a
-- later task edit. Neither `due` text nor any other task field may be supplied
-- or rewritten by the browser. Lock order remains students -> tasks to match
-- the other atomic operations that enforce the archived-student guard.
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
  expected_students_version bigint;
  expected_tasks_version bigint;
  identity_value jsonb;
  current_task jsonb;
  committed_task jsonb;
  projection jsonb;
  due_at_value text;
  action_value text;
  command_applied boolean;
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

  select * into student_state from public.ops_state s
  where s.entity = 'students' for update;
  select * into task_state from public.ops_state s
  where s.entity = 'tasks' for update;
  if student_state.entity is null or task_state.entity is null
     or jsonb_typeof(student_state.payload) is distinct from 'array'
     or jsonb_typeof(task_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'legacy_task_deadline_state_missing';
  end if;

  select * into prior from internal.legacy_task_deadline_commands c
  where c.command_key = p_command_key;
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
  if action_value = 'set' then
    due_at_value := pg_catalog.to_char(
      internal.legacy_task_deadline_melbourne_instant(p_command_intent ->> 'melbourneDateTime')
        at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    command_applied := current_task ->> 'dueAt' is distinct from due_at_value;
    committed_task := case when command_applied
      then current_task || jsonb_build_object('dueAt', due_at_value)
      else current_task end;
  else
    due_at_value := null;
    command_applied := current_task ? 'dueAt';
    committed_task := case when command_applied
      then current_task - 'dueAt'
      else current_task end;
  end if;

  committed_at := clock_timestamp();
  if command_applied then
    projection := internal.legacy_task_deadline_replace(
      task_state.payload,
      identity_value ->> 'taskId',
      committed_task
    );
    update public.ops_state set
      payload = projection,
      version = version + 1,
      updated_at = committed_at,
      updated_by = p_actor
    where entity = 'tasks'
    returning * into saved_task_state;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved_task_state.version, p_actor);
  else
    saved_task_state := task_state;
  end if;

  payload_hash := encode(extensions.digest(pg_catalog.convert_to(
    p_command_intent::text || chr(31) || current_task::text || chr(31) || committed_task::text,
    'UTF8'
  ), 'sha256'), 'hex');
  audit_id := internal.append_operational_contract_audit(
    case
      when action_value = 'set' and command_applied then 'legacy_task_deadline.set'
      when action_value = 'set' then 'legacy_task_deadline.set_unchanged'
      when command_applied then 'legacy_task_deadline.cleared'
      else 'legacy_task_deadline.clear_missing'
    end,
    p_actor,
    'task',
    identity_value ->> 'taskId',
    jsonb_build_object(
      'commandKey', p_command_key,
      'action', action_value,
      'melbourneDateTime', p_command_intent ->> 'melbourneDateTime',
      'dueAt', due_at_value,
      'applied', command_applied,
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
    case when action_value = 'set' then p_command_intent ->> 'melbourneDateTime' else null end,
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

-- Disposable pure fixture: it proves exact Melbourne conversion and confirms
-- that a manual repair changes only dueAt, retaining legacy `due` copy and
-- every workflow field. It never touches public.ops_state.
do $legacy_task_deadline_fixture$
declare
  fixture_students jsonb := '[{"id":"STU-LEGACY","status":"在读"}]'::jsonb;
  fixture_tasks jsonb := '[{"id":"TSK-LEGACY","title":"历史任务","owner":"Abby","studentId":"STU-LEGACY","due":"发布后立即","status":"waiting","tone":"red","category":"LP","trigger":"历史导入"}]'::jsonb;
  identity_value jsonb;
  repaired_task jsonb;
  projected_tasks jsonb;
  due_at_value text;
begin
  identity_value := internal.legacy_task_deadline_identity(
    fixture_students, fixture_tasks, 'TSK-LEGACY'
  );
  due_at_value := pg_catalog.to_char(
    internal.legacy_task_deadline_melbourne_instant('2026-08-19T18:00') at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  if due_at_value <> '2026-08-19T08:00:00.000Z' then
    raise exception 'legacy_task_deadline_fixture_timezone_failed';
  end if;
  repaired_task := identity_value -> 'task' || jsonb_build_object('dueAt', due_at_value);
  projected_tasks := internal.legacy_task_deadline_replace(
    fixture_tasks, 'TSK-LEGACY', repaired_task
  );
  if projected_tasks #>> '{0,due}' <> '发布后立即'
     or projected_tasks #>> '{0,dueAt}' <> due_at_value
     or projected_tasks #>> '{0,status}' <> 'waiting'
     or projected_tasks #>> '{0,ruleKey}' is not null
     or projected_tasks #>> '{0,anchorBookingId}' is not null then
    raise exception 'legacy_task_deadline_fixture_projection_failed';
  end if;
end;
$legacy_task_deadline_fixture$;
