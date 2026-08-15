-- Completing a managed exam reminder changes one task and the corresponding
-- durable student exam step. The browser supplies only an opaque command,
-- action, task id and two OCC versions. Identity, recipient, clock and both
-- full projections are derived independently from locked authoritative state.

create table if not exists internal.exam_follow_up_commands (
  command_key text primary key check (
    command_key ~ '^exam-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('complete', 'undo')),
  task_id text not null check (length(task_id) between 1 and 120),
  student_id text not null check (length(student_id) between 1 and 120),
  exam_id text not null check (length(exam_id) between 1 and 120),
  follow_up_kind text not null check (
    follow_up_kind in ('exam_care', 'exam_recall', 'exam_results_follow_up')
  ),
  completion_command_key text not null check (
    completion_command_key ~ '^exam-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  prior_task jsonb not null check (jsonb_typeof(prior_task) = 'object'),
  prior_follow_up_state_exists boolean not null,
  prior_follow_up_state jsonb,
  committed_task jsonb not null check (jsonb_typeof(committed_task) = 'object'),
  committed_follow_up_state_exists boolean not null,
  committed_follow_up_state jsonb,
  student_version bigint not null check (student_version > 0),
  task_version bigint not null check (task_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  check (
    (prior_follow_up_state_exists and jsonb_typeof(prior_follow_up_state) is not distinct from 'object')
    or (not prior_follow_up_state_exists and prior_follow_up_state is null)
  ),
  check (
    (committed_follow_up_state_exists and jsonb_typeof(committed_follow_up_state) is not distinct from 'object')
    or (not committed_follow_up_state_exists and committed_follow_up_state is null)
  ),
  check (
    (action = 'complete' and completion_command_key = command_key)
    or action = 'undo'
  )
);

alter table internal.exam_follow_up_commands enable row level security;
revoke all on table internal.exam_follow_up_commands from public, anon, authenticated, service_role;

create or replace function internal.validate_exam_follow_up_intent(p_intent jsonb)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if jsonb_typeof(p_intent) is distinct from 'object'
     or p_intent - 'action' - 'taskId' - 'completionCommandKey' <> '{}'::jsonb
     or coalesce(p_intent ->> 'action', '') not in ('complete', 'undo')
     or coalesce(p_intent ->> 'taskId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or (p_intent ->> 'action' = 'complete' and p_intent ? 'completionCommandKey')
     or (p_intent ->> 'action' = 'undo' and (
       coalesce(p_intent ->> 'completionCommandKey', '')
         !~ '^exam-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     )) then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_intent';
  end if;
end;
$$;

revoke all on function internal.validate_exam_follow_up_intent(jsonb)
  from public, anon, authenticated, service_role;

-- Resolves the managed task/student/exam binding and verifies that its
-- recipient fields are the exact owner/planner projection used at creation.
create or replace function internal.exam_follow_up_identity(
  p_students jsonb,
  p_tasks jsonb,
  p_task_id text
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  task jsonb;
  student jsonb;
  exam jsonb;
  rule_parts text[];
  exam_id text;
  suffix text;
  follow_up_kind text;
  expected_recipient text;
  follow_up_exists boolean;
  follow_up_state jsonb;
  step record;
begin
  if jsonb_typeof(p_students) is distinct from 'array'
     or jsonb_typeof(p_tasks) is distinct from 'array'
     or coalesce(p_task_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or exists (select 1 from jsonb_array_elements(p_students) item(value)
       where jsonb_typeof(item.value) is distinct from 'object'
          or nullif(trim(item.value ->> 'id'), '') is null)
     or exists (select 1 from jsonb_array_elements(p_students) item(value)
       group by item.value ->> 'id' having count(*) > 1)
     or exists (select 1 from jsonb_array_elements(p_tasks) item(value)
       where jsonb_typeof(item.value) is distinct from 'object'
          or nullif(trim(item.value ->> 'id'), '') is null)
     or exists (select 1 from jsonb_array_elements(p_tasks) item(value)
       group by item.value ->> 'id' having count(*) > 1) then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_state';
  end if;

  select item.value into task from jsonb_array_elements(p_tasks) item(value)
  where item.value ->> 'id' = p_task_id;
  if task is null then
    raise exception using errcode = '22023', message = 'exam_follow_up_task_not_found';
  end if;
  rule_parts := pg_catalog.regexp_match(
    coalesce(task ->> 'ruleKey', ''), '^exam:([^:]+):(care|recall|results)$'
  );
  if task ->> 'category' is distinct from '考试'
     or rule_parts is null
     or task ->> 'anchorBookingId' is distinct from 'exam:' || rule_parts[1]
     or nullif(trim(task ->> 'studentId'), '') is null then
    raise exception using errcode = '22023', message = 'exam_follow_up_task_identity_conflict';
  end if;
  exam_id := rule_parts[1];
  suffix := rule_parts[2];
  follow_up_kind := case suffix
    when 'care' then 'exam_care'
    when 'recall' then 'exam_recall'
    else 'exam_results_follow_up' end;

  select item.value into student from jsonb_array_elements(p_students) item(value)
  where item.value ->> 'id' = task ->> 'studentId';
  if student is null then
    raise exception using errcode = '22023', message = 'exam_follow_up_student_not_found';
  end if;
  if student ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'exam_follow_up_archived_student';
  end if;
  if jsonb_typeof(student -> 'exams') is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(student -> 'exams') item(value)
       where jsonb_typeof(item.value) is distinct from 'object'
          or nullif(trim(item.value ->> 'id'), '') is null)
     or exists (select 1 from jsonb_array_elements(student -> 'exams') item(value)
       group by item.value ->> 'id' having count(*) > 1) then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_history';
  end if;
  select item.value into exam from jsonb_array_elements(student -> 'exams') item(value)
  where item.value ->> 'id' = exam_id;
  if exam is null then
    raise exception using errcode = '22023', message = 'exam_follow_up_exam_not_found';
  end if;

  expected_recipient := nullif(trim(case when suffix = 'results'
    then student ->> 'planner' else student ->> 'owner' end), '');
  if expected_recipient is null
     or expected_recipient ~ '^(待分配|待确认|未知|角色待配置[:：])'
     or lower(trim(coalesce(task ->> 'owner', ''))) <> lower(expected_recipient)
     or jsonb_typeof(task -> 'assignees') is distinct from 'array'
     or jsonb_array_length(task -> 'assignees') <> 1
     or lower(trim(coalesce(task #>> '{assignees,0}', ''))) <> lower(expected_recipient)
     or jsonb_typeof(task -> 'watchers') is distinct from 'array'
     or jsonb_array_length(task -> 'watchers') <> 1
     or lower(trim(coalesce(task #>> '{watchers,0}', ''))) <> lower('Ops Admin') then
    raise exception using errcode = '22023', message = 'exam_follow_up_recipient_conflict';
  end if;

  follow_up_exists := exam ? 'followUpState';
  if follow_up_exists and jsonb_typeof(exam -> 'followUpState') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_state';
  end if;
  follow_up_state := case when follow_up_exists then exam -> 'followUpState' else '{}'::jsonb end;
  if follow_up_state - 'exam_care' - 'exam_recall' - 'exam_results_follow_up' <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_state';
  end if;
  for step in select key, value from jsonb_each(follow_up_state) loop
    if jsonb_typeof(step.value) is distinct from 'object'
       or coalesce(step.value ->> 'status', '') not in ('pending', 'completed', 'not_required')
       or (step.value ->> 'status' = 'completed' and nullif(step.value ->> 'completedAt', '') is null) then
      raise exception using errcode = '22023', message = 'invalid_exam_follow_up_state';
    end if;
    if step.value ->> 'status' = 'completed' then
      begin
        perform (step.value ->> 'completedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'invalid_exam_follow_up_state';
      end;
    end if;
  end loop;

  return jsonb_build_object(
    'taskId', p_task_id,
    'studentId', task ->> 'studentId',
    'examId', exam_id,
    'followUpKind', follow_up_kind,
    'task', task,
    'followUpStateExists', follow_up_exists,
    'followUpState', follow_up_state
  );
end;
$$;

revoke all on function internal.exam_follow_up_identity(jsonb, jsonb, text)
  from public, anon, authenticated, service_role;

-- Applies a previously derived task and whole follow-up-state snapshot while
-- preserving every unrelated row, exam field and array position.
create or replace function internal.exam_follow_up_replace(
  p_students jsonb,
  p_tasks jsonb,
  p_identity jsonb,
  p_next_task jsonb,
  p_next_follow_up_state_exists boolean,
  p_next_follow_up_state jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  next_students jsonb;
  next_tasks jsonb;
begin
  if jsonb_typeof(p_identity) is distinct from 'object'
     or jsonb_typeof(p_next_task) is distinct from 'object'
     or (p_next_follow_up_state_exists and jsonb_typeof(p_next_follow_up_state) is distinct from 'object')
     or (not p_next_follow_up_state_exists and p_next_follow_up_state is not null) then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_replacement';
  end if;

  select jsonb_agg(
    case when student.value ->> 'id' = p_identity ->> 'studentId' then
      (student.value - 'exams') || jsonb_build_object('exams', (
        select jsonb_agg(
          case when exam.value ->> 'id' = p_identity ->> 'examId' then
            (exam.value - 'followUpState') || case when p_next_follow_up_state_exists
              then jsonb_build_object('followUpState', p_next_follow_up_state)
              else '{}'::jsonb end
          else exam.value end
          order by exam.ordinality
        )
        from jsonb_array_elements(student.value -> 'exams') with ordinality exam(value, ordinality)
      ))
    else student.value end
    order by student.ordinality
  ) into next_students
  from jsonb_array_elements(p_students) with ordinality student(value, ordinality);

  select jsonb_agg(
    case when task.value ->> 'id' = p_identity ->> 'taskId'
      then p_next_task else task.value end
    order by task.ordinality
  ) into next_tasks
  from jsonb_array_elements(p_tasks) with ordinality task(value, ordinality);

  return jsonb_build_object('students', next_students, 'tasks', next_tasks);
end;
$$;

revoke all on function internal.exam_follow_up_replace(jsonb, jsonb, jsonb, jsonb, boolean, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.get_exam_follow_up_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_actor text
)
returns table (
  command_key text,
  action text,
  task_id text,
  student_id text,
  exam_id text,
  follow_up_kind text,
  completion_command_key text,
  audit_entry_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  prior internal.exam_follow_up_commands%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  perform internal.validate_exam_follow_up_intent(p_command_intent);
  if coalesce(p_command_key, '')
       !~ '^exam-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_replay_lookup';
  end if;
  select * into prior from internal.exam_follow_up_commands c where c.command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent
     or prior.actor <> trim(p_actor)
     or prior.action <> p_command_intent ->> 'action'
     or prior.task_id <> p_command_intent ->> 'taskId' then
    raise exception using errcode = '23505', message = 'exam_follow_up_idempotency_conflict';
  end if;
  return query select prior.command_key, prior.action, prior.task_id,
    prior.student_id, prior.exam_id, prior.follow_up_kind,
    prior.completion_command_key, prior.audit_id;
end;
$$;

revoke all on function public.get_exam_follow_up_command_result(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_exam_follow_up_command_result(text, text, jsonb, text)
  to anon, authenticated;

-- The server-only undo lookup returns the immutable completion before-image.
-- It is actor-bound and the mutating RPC rechecks every field under row locks.
create or replace function public.get_exam_follow_up_completion_context(
  p_secret text,
  p_completion_command_key text,
  p_actor text
)
returns table (
  command_key text,
  task_id text,
  student_id text,
  exam_id text,
  follow_up_kind text,
  prior_task jsonb,
  prior_follow_up_state_exists boolean,
  prior_follow_up_state jsonb,
  committed_task jsonb,
  committed_follow_up_state jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  completion internal.exam_follow_up_commands%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_completion_command_key, '')
       !~ '^exam-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_completion_lookup';
  end if;
  select * into completion from internal.exam_follow_up_commands c
  where c.command_key = p_completion_command_key;
  if completion.command_key is null then return; end if;
  if completion.action <> 'complete' or completion.actor <> trim(p_actor)
     or not completion.committed_follow_up_state_exists then
    raise exception using errcode = '42501', message = 'exam_follow_up_completion_forbidden';
  end if;
  return query select completion.command_key, completion.task_id,
    completion.student_id, completion.exam_id, completion.follow_up_kind,
    completion.prior_task, completion.prior_follow_up_state_exists,
    completion.prior_follow_up_state, completion.committed_task,
    completion.committed_follow_up_state;
end;
$$;

revoke all on function public.get_exam_follow_up_completion_context(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_exam_follow_up_completion_context(text, text, text)
  to anon, authenticated;

create or replace function public.mutate_exam_follow_up_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_action text,
  p_expected_versions jsonb,
  p_students jsonb,
  p_tasks jsonb,
  p_prepared_at text,
  p_actor text
)
returns table (
  command_key text,
  action text,
  applied boolean,
  task_id text,
  student_id text,
  exam_id text,
  follow_up_kind text,
  completion_command_key text,
  students_row public.ops_state,
  tasks_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  student_state public.ops_state%rowtype;
  task_state public.ops_state%rowtype;
  saved_student_state public.ops_state%rowtype;
  saved_task_state public.ops_state%rowtype;
  prior internal.exam_follow_up_commands%rowtype;
  completion internal.exam_follow_up_commands%rowtype;
  expected_student_version bigint;
  expected_task_version bigint;
  prepared_at_value timestamptz;
  identity_value jsonb;
  current_task jsonb;
  current_follow_up_state_exists boolean;
  current_follow_up_state jsonb;
  prior_task_value jsonb;
  prior_follow_up_state_exists_value boolean;
  prior_follow_up_state_value jsonb;
  committed_task_value jsonb;
  committed_follow_up_state_exists_value boolean;
  committed_follow_up_state_value jsonb;
  completion_command_key_value text;
  projection jsonb;
  audit_id uuid;
  committed_at timestamptz;
  payload_hash text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  perform internal.validate_exam_follow_up_intent(p_command_intent);
  if coalesce(p_command_key, '')
       !~ '^exam-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_action is distinct from p_command_intent ->> 'action'
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'students' - 'tasks' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'students') is distinct from 'number'
     or coalesce(p_expected_versions ->> 'students', '') !~ '^[1-9][0-9]*$'
     or jsonb_typeof(p_expected_versions -> 'tasks') is distinct from 'number'
     or coalesce(p_expected_versions ->> 'tasks', '') !~ '^[1-9][0-9]*$'
     or jsonb_typeof(p_students) is distinct from 'array'
     or jsonb_typeof(p_tasks) is distinct from 'array'
     or coalesce(p_prepared_at, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_command';
  end if;
  begin
    expected_student_version := (p_expected_versions ->> 'students')::bigint;
    expected_task_version := (p_expected_versions ->> 'tasks')::bigint;
    prepared_at_value := p_prepared_at::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_command';
  end;
  if expected_student_version < 1 or expected_task_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_command';
  end if;

  -- Global order for this two-row transaction: students -> tasks.
  select * into student_state from public.ops_state s where s.entity = 'students' for update;
  select * into task_state from public.ops_state s where s.entity = 'tasks' for update;
  if student_state.entity is null or task_state.entity is null
     or jsonb_typeof(student_state.payload) is distinct from 'array'
     or jsonb_typeof(task_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'exam_follow_up_state_missing';
  end if;

  select * into prior from internal.exam_follow_up_commands c where c.command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent
       or prior.actor <> trim(p_actor)
       or prior.action <> p_action
       or prior.task_id <> p_command_intent ->> 'taskId' then
      raise exception using errcode = '23505', message = 'exam_follow_up_idempotency_conflict';
    end if;
    return query select prior.command_key, prior.action, false, prior.task_id,
      prior.student_id, prior.exam_id, prior.follow_up_kind,
      prior.completion_command_key, student_state, task_state, prior.audit_id;
    return;
  end if;

  -- Fresh commands must carry a recent server-issued projection clock. Replays
  -- above remain valid indefinitely after an unknown transport outcome.
  if prepared_at_value < clock_timestamp() - interval '15 minutes'
     or prepared_at_value > clock_timestamp() + interval '2 minutes' then
    raise exception using errcode = '22023', message = 'invalid_exam_follow_up_command';
  end if;
  if student_state.version is distinct from expected_student_version
     or task_state.version is distinct from expected_task_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  identity_value := internal.exam_follow_up_identity(
    student_state.payload, task_state.payload, p_command_intent ->> 'taskId'
  );
  current_task := identity_value -> 'task';
  current_follow_up_state_exists := (identity_value ->> 'followUpStateExists')::boolean;
  current_follow_up_state := identity_value -> 'followUpState';

  if p_action = 'complete' then
    if coalesce(current_task ->> 'status', '') not in ('overdue', 'today', 'upcoming', 'waiting')
       or current_follow_up_state -> (identity_value ->> 'followUpKind') ->> 'status'
         in ('completed', 'not_required') then
      raise exception using errcode = '40001', message = 'exam_follow_up_action_conflict';
    end if;
    prior_task_value := current_task;
    prior_follow_up_state_exists_value := current_follow_up_state_exists;
    prior_follow_up_state_value := case when current_follow_up_state_exists
      then current_follow_up_state else null end;
    committed_task_value := current_task || jsonb_build_object(
      'status', 'done',
      'tone', 'green',
      'closedAt', p_prepared_at,
      'result', '已由当前操作员确认完成'
    );
    committed_follow_up_state_exists_value := true;
    committed_follow_up_state_value := current_follow_up_state || jsonb_build_object(
      identity_value ->> 'followUpKind', jsonb_build_object(
        'status', 'completed',
        'completedAt', p_prepared_at,
        'completedBy', trim(p_actor)
      )
    );
    completion_command_key_value := p_command_key;
  else
    select * into completion from internal.exam_follow_up_commands c
    where c.command_key = p_command_intent ->> 'completionCommandKey';
    if completion.command_key is null
       or completion.action <> 'complete'
       or completion.actor <> trim(p_actor)
       or completion.task_id <> identity_value ->> 'taskId'
       or completion.student_id <> identity_value ->> 'studentId'
       or completion.exam_id <> identity_value ->> 'examId'
       or completion.follow_up_kind <> identity_value ->> 'followUpKind' then
      raise exception using errcode = '42501', message = 'exam_follow_up_completion_forbidden';
    end if;
    if current_task is distinct from completion.committed_task
       or not current_follow_up_state_exists
       or current_follow_up_state is distinct from completion.committed_follow_up_state then
      raise exception using errcode = '40001', message = 'exam_follow_up_undo_conflict';
    end if;
    prior_task_value := current_task;
    prior_follow_up_state_exists_value := current_follow_up_state_exists;
    prior_follow_up_state_value := current_follow_up_state;
    committed_task_value := completion.prior_task;
    committed_follow_up_state_exists_value := completion.prior_follow_up_state_exists;
    committed_follow_up_state_value := completion.prior_follow_up_state;
    completion_command_key_value := completion.command_key;
  end if;

  projection := internal.exam_follow_up_replace(
    student_state.payload,
    task_state.payload,
    identity_value,
    committed_task_value,
    committed_follow_up_state_exists_value,
    committed_follow_up_state_value
  );
  if p_students is distinct from projection -> 'students' then
    raise exception using errcode = '22023', message = 'exam_follow_up_student_payload_mismatch';
  end if;
  if p_tasks is distinct from projection -> 'tasks' then
    raise exception using errcode = '22023', message = 'exam_follow_up_task_payload_mismatch';
  end if;

  committed_at := clock_timestamp();
  update public.ops_state set
    payload = projection -> 'students',
    version = version + 1,
    updated_at = committed_at,
    updated_by = left(trim(p_actor), 120)
  where entity = 'students'
  returning * into saved_student_state;
  update public.ops_state set
    payload = projection -> 'tasks',
    version = version + 1,
    updated_at = committed_at,
    updated_by = left(trim(p_actor), 120)
  where entity = 'tasks'
  returning * into saved_task_state;
  insert into public.ops_mutation_log(entity, version, actor) values
    ('students', saved_student_state.version, left(trim(p_actor), 120)),
    ('tasks', saved_task_state.version, left(trim(p_actor), 120));

  payload_hash := encode(extensions.digest(pg_catalog.convert_to(
    p_command_intent::text || chr(31) || p_students::text || chr(31) || p_tasks::text,
    'UTF8'
  ), 'sha256'), 'hex');
  audit_id := internal.append_operational_contract_audit(
    case when p_action = 'complete'
      then 'exam_follow_up.completed' else 'exam_follow_up.undone' end,
    left(trim(p_actor), 120),
    'task',
    identity_value ->> 'taskId',
    jsonb_build_object(
      'commandKey', p_command_key,
      'action', p_action,
      'completionCommandKey', completion_command_key_value,
      'studentId', identity_value ->> 'studentId',
      'examId', identity_value ->> 'examId',
      'followUpKind', identity_value ->> 'followUpKind',
      'versionsBefore', p_expected_versions,
      'versionsAfter', jsonb_build_object(
        'students', saved_student_state.version,
        'tasks', saved_task_state.version
      ),
      'payloadSha256', payload_hash
    )
  );
  insert into internal.exam_follow_up_commands (
    command_key, command_intent, command_hash, action, task_id, student_id,
    exam_id, follow_up_kind, completion_command_key, prior_task,
    prior_follow_up_state_exists, prior_follow_up_state, committed_task,
    committed_follow_up_state_exists, committed_follow_up_state,
    student_version, task_version, actor, applied_at, audit_id
  ) values (
    p_command_key, p_command_intent, payload_hash, p_action,
    identity_value ->> 'taskId', identity_value ->> 'studentId',
    identity_value ->> 'examId', identity_value ->> 'followUpKind',
    completion_command_key_value, prior_task_value,
    prior_follow_up_state_exists_value, prior_follow_up_state_value,
    committed_task_value, committed_follow_up_state_exists_value,
    committed_follow_up_state_value, saved_student_state.version,
    saved_task_state.version, left(trim(p_actor), 120), committed_at, audit_id
  );
  return query select p_command_key, p_action, true,
    identity_value ->> 'taskId', identity_value ->> 'studentId',
    identity_value ->> 'examId', identity_value ->> 'followUpKind',
    completion_command_key_value, saved_student_state, saved_task_state, audit_id;
end;
$$;

revoke all on function public.mutate_exam_follow_up_atomic(text, text, jsonb, text, jsonb, jsonb, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mutate_exam_follow_up_atomic(text, text, jsonb, text, jsonb, jsonb, jsonb, text, text)
  to anon, authenticated;

-- Executable pure fixture pins managed identity, exact recipient routing and
-- whole-state replacement without touching live ops_state rows.
do $exam_follow_up_contract_fixture$
declare
  fixture_students jsonb := '[{"id":"STU-1","owner":"Abby","planner":"Tara","status":"在读","exams":[{"id":"EXM-1","subject":"Maths","examType":"selective","examMonth":"2026-09","followUpState":{"exam_recall":{"status":"pending"}}}]}]'::jsonb;
  fixture_tasks jsonb := '[{"id":"TSK-1","title":"Maths考试回忆","owner":"Abby","assignees":["Abby"],"watchers":["Ops Admin"],"studentId":"STU-1","due":"2026-09-01 18:00","status":"upcoming","tone":"amber","category":"考试","trigger":"fixture","ruleKey":"exam:EXM-1:recall","anchorBookingId":"exam:EXM-1"}]'::jsonb;
  identity_value jsonb;
  next_task jsonb;
  next_state jsonb;
  projection jsonb;
begin
  identity_value := internal.exam_follow_up_identity(fixture_students, fixture_tasks, 'TSK-1');
  if identity_value ->> 'studentId' <> 'STU-1'
     or identity_value ->> 'examId' <> 'EXM-1'
     or identity_value ->> 'followUpKind' <> 'exam_recall' then
    raise exception 'exam_follow_up_identity_fixture_failed';
  end if;
  next_task := identity_value -> 'task' || jsonb_build_object(
    'status', 'done', 'tone', 'green',
    'closedAt', '2026-08-15T00:00:00.000Z',
    'result', '已由当前操作员确认完成'
  );
  next_state := identity_value -> 'followUpState' || jsonb_build_object(
    'exam_recall', jsonb_build_object(
      'status', 'completed', 'completedAt', '2026-08-15T00:00:00.000Z', 'completedBy', 'Abby'
    )
  );
  projection := internal.exam_follow_up_replace(
    fixture_students, fixture_tasks, identity_value, next_task, true, next_state
  );
  if projection #>> '{students,0,exams,0,followUpState,exam_recall,status}' <> 'completed'
     or projection #>> '{tasks,0,status}' <> 'done'
     or projection #>> '{tasks,0,result}' <> '已由当前操作员确认完成' then
    raise exception 'exam_follow_up_projection_fixture_failed';
  end if;
end;
$exam_follow_up_contract_fixture$;
