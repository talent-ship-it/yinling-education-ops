-- Creating a teacher-departure workflow is one five-entity decision. The
-- browser supplies only the departing teacher, effective date, detail,
-- idempotency key and five OCC versions. The server derives the complete
-- student/occurrence closure, candidate set, operations and watched tasks;
-- this transaction locks every input before accepting that exact projection.

create table if not exists internal.teacher_departure_creation_commands (
  command_key text primary key
    check (command_key ~ '^teacher-departure-create:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  source_teacher_id text not null check (length(source_teacher_id) between 1 and 120),
  effective_date date not null,
  operation_ids jsonb not null check (jsonb_typeof(operation_ids) = 'array'),
  affected_student_ids jsonb not null check (jsonb_typeof(affected_student_ids) = 'array'),
  affected_groups jsonb not null check (jsonb_typeof(affected_groups) = 'array'),
  booking_version bigint not null check (booking_version > 0),
  operation_version bigint not null check (operation_version > 0),
  student_version bigint not null check (student_version > 0),
  task_version bigint not null check (task_version > 0),
  teacher_version bigint not null check (teacher_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.teacher_departure_creation_commands enable row level security;
revoke all on table internal.teacher_departure_creation_commands from public, anon, authenticated, service_role;

-- Reuse the reviewed permanent-handover occurrence projector for each current
-- student. This gives creation and later confirmation one definition of a
-- finite, confirmed future lesson, including moved overrides.
create or replace function internal.teacher_departure_creation_projection(
  p_bookings jsonb,
  p_students jsonb,
  p_source_teacher_id text,
  p_effective_date text
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  student_item jsonb;
  student_id text;
  projection jsonb;
  groups jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_bookings) is distinct from 'array'
     or jsonb_typeof(p_students) is distinct from 'array'
     or coalesce(p_source_teacher_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or coalesce(p_effective_date, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception using errcode = '22023', message = 'invalid_teacher_departure_projection';
  end if;

  -- A count-less series that can ever resolve to the departing teacher is an
  -- explicit blocker even if its student reference is currently malformed.
  if exists (
    select 1
    from jsonb_array_elements(p_bookings) booking(value)
    where booking.value -> 'recurring' = 'true'::jsonb
      and not (booking.value ? 'repeatCount')
      and booking.value ->> 'kind' is distinct from '代课'
      and (
        booking.value ->> 'teacherId' = p_source_teacher_id
        or exists (
          select 1
          from jsonb_array_elements(case when jsonb_typeof(booking.value -> 'occurrenceOverrides') = 'array'
            then booking.value -> 'occurrenceOverrides' else '[]'::jsonb end) override_item(value)
          where case when override_item.value ? 'teacherId'
            then override_item.value ->> 'teacherId'
            else booking.value ->> 'teacherId' end = p_source_teacher_id
        )
      )
  ) then
    raise exception using errcode = '22023', message = 'unbounded_teacher_departure_series';
  end if;

  for student_item in
    select item.value
    from jsonb_array_elements(p_students) item(value)
    order by item.value ->> 'id' collate "C"
  loop
    student_id := nullif(trim(student_item ->> 'id'), '');
    if coalesce(student_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' then
      raise exception using errcode = '22023', message = 'invalid_teacher_departure_student';
    end if;
    projection := internal.permanent_teacher_replacement_occurrence_projection(
      p_bookings, student_id, p_source_teacher_id, p_effective_date, true
    );
    if jsonb_array_length(projection -> 'occurrenceIds') > 0 then
      if student_item ->> 'importArchived' = 'true'
         or coalesce(student_item ->> 'status', '') not in (
           '在读', '活跃 + 有课时', '活跃 + 无课时', '在读 + 加课待排'
         ) then
        raise exception using errcode = '42501', message = 'teacher_departure_student_read_only';
      end if;
      groups := groups || jsonb_build_array(jsonb_build_object(
        'studentId', student_id,
        'affectedOccurrenceIds', projection -> 'occurrenceIds'
      ));
    end if;
  end loop;
  return groups;
end;
$$;

revoke all on function internal.teacher_departure_creation_projection(jsonb, jsonb, text, text)
  from public, anon, authenticated, service_role;

create or replace function internal.teacher_departure_creation_tasks(
  p_command_key text,
  p_operation_id text,
  p_student_id text,
  p_student_owner text,
  p_effective_date date,
  p_submitted_at timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  definition jsonb;
  task_owner text;
  due_date date;
  due_at_text text;
  task_status text;
  task_tone text;
  result jsonb := '[]'::jsonb;
begin
  if coalesce(p_command_key, '') !~ '^teacher-departure-create:'
     or nullif(trim(p_operation_id), '') is null
     or nullif(trim(p_student_id), '') is null
     or p_effective_date is null
     or p_submitted_at is null then
    raise exception using errcode = '22023', message = 'invalid_teacher_departure_task_projection';
  end if;

  for definition in
    select item.value from jsonb_array_elements('[
      {"rule":"recommendation","title":"筛选并确认推荐老师名单","owner":"Tiffany","offset":-14,"tone":"red","trigger":"老师离职：推荐老师名单"},
      {"rule":"new-teacher-contact","title":"开启新老师沟通","owner":"student","offset":-14,"tone":"amber","trigger":"老师离职：新老师沟通"},
      {"rule":"handover","title":"确认 Handover Notes 与原老师约定 DDL","owner":"student","offset":-7,"tone":"blue","trigger":"老师离职：交接资料"},
      {"rule":"parent-contact","title":"告知家长并记录最终安排","owner":"student","offset":-7,"tone":"red","trigger":"老师离职：家长沟通"},
      {"rule":"management-watcher","title":"向龙老师汇报离职交接进度","owner":"思佳","offset":-7,"tone":"amber","trigger":"老师离职：管理确认"}
    ]'::jsonb) item(value)
  loop
    task_owner := case when definition ->> 'owner' = 'student'
      then coalesce(nullif(trim(p_student_owner), ''), '待分配')
      else definition ->> 'owner' end;
    due_date := p_effective_date + (definition ->> 'offset')::integer;
    due_at_text := pg_catalog.to_char(
      ((due_date::timestamp + interval '18 hours') at time zone 'Australia/Melbourne') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    if due_date < (p_submitted_at at time zone 'Australia/Melbourne')::date then
      task_status := 'overdue';
      task_tone := 'red';
    elsif due_date = (p_submitted_at at time zone 'Australia/Melbourne')::date then
      task_status := 'today';
      task_tone := 'amber';
    else
      task_status := 'upcoming';
      task_tone := definition ->> 'tone';
    end if;
    result := result || jsonb_build_array(jsonb_build_object(
      'id', 'TSK-DEPARTURE-' || pg_catalog.left(encode(extensions.digest(
        p_command_key || chr(31) || p_student_id || chr(31) || (definition ->> 'rule'), 'sha256'
      ), 'hex'), 24),
      'title', definition ->> 'title',
      'owner', task_owner,
      'assignees', jsonb_build_array(task_owner),
      'watchers', jsonb_build_array('Ops Admin'),
      'studentId', p_student_id,
      'due', pg_catalog.to_char(due_date, 'YYYY-MM-DD') || ' 18:00',
      'dueAt', due_at_text,
      'status', task_status,
      'tone', task_tone,
      'category', '请假代课',
      'trigger', definition ->> 'trigger',
      'ruleKey', 'teacher-departure:' || p_operation_id || ':' || (definition ->> 'rule'),
      'anchorBookingId', p_operation_id
    ));
  end loop;
  return result;
end;
$$;

revoke all on function internal.teacher_departure_creation_tasks(text, text, text, text, date, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.get_teacher_departure_creation_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_actor text
)
returns table (
  command_key text,
  source_teacher_id text,
  effective_date text,
  operation_ids jsonb,
  affected_student_ids jsonb,
  audit_entry_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  prior internal.teacher_departure_creation_commands%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^teacher-departure-create:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent - 'sourceTeacherId' - 'effectiveDate' - 'detail' <> '{}'::jsonb
     or coalesce(p_command_intent ->> 'sourceTeacherId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or coalesce(p_command_intent ->> 'effectiveDate', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or nullif(trim(p_command_intent ->> 'detail'), '') is null
     or length(trim(p_command_intent ->> 'detail')) > 2000
     or nullif(trim(p_actor), '') is null
     or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_teacher_departure_replay_lookup';
  end if;

  select * into prior from internal.teacher_departure_creation_commands c
  where c.command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent
     or prior.actor <> trim(p_actor)
     or prior.source_teacher_id <> p_command_intent ->> 'sourceTeacherId'
     or pg_catalog.to_char(prior.effective_date, 'YYYY-MM-DD') <> p_command_intent ->> 'effectiveDate' then
    raise exception using errcode = '23505', message = 'teacher_departure_creation_idempotency_conflict';
  end if;
  return query select prior.command_key, prior.source_teacher_id,
    pg_catalog.to_char(prior.effective_date, 'YYYY-MM-DD'), prior.operation_ids,
    prior.affected_student_ids, prior.audit_id;
end;
$$;

revoke all on function public.get_teacher_departure_creation_command_result(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_teacher_departure_creation_command_result(text, text, jsonb, text)
  to anon, authenticated;

create or replace function public.create_teacher_departure_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_source_teacher_id text,
  p_effective_date text,
  p_detail text,
  p_expected_versions jsonb,
  p_operations jsonb,
  p_tasks jsonb,
  p_affected_groups jsonb,
  p_submitted_at text,
  p_actor text
)
returns table (
  command_key text,
  applied boolean,
  source_teacher_id text,
  effective_date text,
  operation_ids jsonb,
  affected_student_ids jsonb,
  operations_row public.ops_state,
  tasks_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  booking_state public.ops_state%rowtype;
  operation_state public.ops_state%rowtype;
  student_state public.ops_state%rowtype;
  task_state public.ops_state%rowtype;
  teacher_state public.ops_state%rowtype;
  saved_operation_state public.ops_state%rowtype;
  saved_task_state public.ops_state%rowtype;
  prior internal.teacher_departure_creation_commands%rowtype;
  expected_booking_version bigint;
  expected_operation_version bigint;
  expected_student_version bigint;
  expected_task_version bigint;
  expected_teacher_version bigint;
  submitted_at_value timestamptz;
  expected_closure jsonb;
  supplied_closure jsonb;
  group_item jsonb;
  student_item jsonb;
  candidate_teacher jsonb;
  candidate_relationship_projection jsonb;
  candidate_already_active boolean;
  candidate_already_assigned boolean;
  affected_booking jsonb;
  student_id text;
  operation_id text;
  candidate_id text;
  occurrence_id text;
  candidate_ids jsonb;
  affected_ids jsonb;
  generated_operations jsonb := '[]'::jsonb;
  generated_tasks jsonb := '[]'::jsonb;
  expected_operations jsonb;
  expected_tasks jsonb;
  operation_ids_value jsonb := '[]'::jsonb;
  affected_student_ids_value jsonb := '[]'::jsonb;
  payload_hash text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^teacher-departure-create:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
     or coalesce(p_source_teacher_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or coalesce(p_effective_date, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or nullif(trim(p_detail), '') is null or length(trim(p_detail)) > 2000
     or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 120
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent - 'sourceTeacherId' - 'effectiveDate' - 'detail' <> '{}'::jsonb
     or p_command_intent is distinct from jsonb_build_object(
       'sourceTeacherId', trim(p_source_teacher_id),
       'effectiveDate', p_effective_date,
       'detail', trim(p_detail)
     )
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'bookings' - 'operations' - 'students' - 'tasks' - 'teachers' <> '{}'::jsonb
     or jsonb_typeof(p_operations) is distinct from 'array'
     or jsonb_typeof(p_tasks) is distinct from 'array'
     or jsonb_typeof(p_affected_groups) is distinct from 'array'
     or jsonb_array_length(p_affected_groups) = 0
     or coalesce(p_submitted_at, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
    raise exception using errcode = '22023', message = 'invalid_teacher_departure_creation_request';
  end if;
  begin
    if pg_catalog.to_char(p_effective_date::date, 'YYYY-MM-DD') <> p_effective_date then
      raise exception using errcode = '22023', message = 'invalid_teacher_departure_effective_date';
    end if;
    submitted_at_value := p_submitted_at::timestamptz;
    expected_booking_version := (p_expected_versions ->> 'bookings')::bigint;
    expected_operation_version := (p_expected_versions ->> 'operations')::bigint;
    expected_student_version := (p_expected_versions ->> 'students')::bigint;
    expected_task_version := (p_expected_versions ->> 'tasks')::bigint;
    expected_teacher_version := (p_expected_versions ->> 'teachers')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_teacher_departure_creation_types';
  end;
  if submitted_at_value < clock_timestamp() - interval '15 minutes'
     or submitted_at_value > clock_timestamp() + interval '2 minutes'
     or expected_booking_version < 1 or expected_operation_version < 1
     or expected_student_version < 1 or expected_task_version < 1
     or expected_teacher_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_teacher_departure_creation_versions';
  end if;

  payload_hash := encode(extensions.digest(jsonb_build_object(
    'commandIntent', p_command_intent,
    'expectedVersions', p_expected_versions,
    'operations', p_operations,
    'tasks', p_tasks,
    'affectedGroups', p_affected_groups,
    'submittedAt', p_submitted_at
  )::text, 'sha256'), 'hex');

  -- Global lock order for every five-entity departure creation:
  -- bookings -> operations -> students -> tasks -> teachers.
  select * into booking_state from public.ops_state s where s.entity = 'bookings' for update;
  select * into operation_state from public.ops_state s where s.entity = 'operations' for update;
  select * into student_state from public.ops_state s where s.entity = 'students' for update;
  select * into task_state from public.ops_state s where s.entity = 'tasks' for update;
  select * into teacher_state from public.ops_state s where s.entity = 'teachers' for update;
  if booking_state.entity is null or operation_state.entity is null
     or student_state.entity is null or task_state.entity is null or teacher_state.entity is null
     or jsonb_typeof(booking_state.payload) is distinct from 'array'
     or jsonb_typeof(operation_state.payload) is distinct from 'array'
     or jsonb_typeof(student_state.payload) is distinct from 'array'
     or jsonb_typeof(task_state.payload) is distinct from 'array'
     or jsonb_typeof(teacher_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'teacher_departure_creation_state_missing';
  end if;

  select * into prior from internal.teacher_departure_creation_commands c
  where c.command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent
       or prior.actor <> trim(p_actor)
       or prior.source_teacher_id <> trim(p_source_teacher_id)
       or pg_catalog.to_char(prior.effective_date, 'YYYY-MM-DD') <> p_effective_date
       or prior.affected_groups is distinct from p_affected_groups then
      raise exception using errcode = '23505', message = 'teacher_departure_creation_idempotency_conflict';
    end if;
    return query select prior.command_key, false, prior.source_teacher_id,
      pg_catalog.to_char(prior.effective_date, 'YYYY-MM-DD'), prior.operation_ids,
      prior.affected_student_ids, operation_state, task_state, prior.audit_id;
    return;
  end if;

  if booking_state.version is distinct from expected_booking_version
     or operation_state.version is distinct from expected_operation_version
     or student_state.version is distinct from expected_student_version
     or task_state.version is distinct from expected_task_version
     or teacher_state.version is distinct from expected_teacher_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if exists (
    select 1 from jsonb_array_elements(booking_state.payload) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(operation_state.payload) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(student_state.payload) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(task_state.payload) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(teacher_state.payload) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'duplicate_teacher_departure_state_identity';
  end if;
  if (select count(*) from jsonb_array_elements(teacher_state.payload) item(value)
      where item.value ->> 'id' = p_source_teacher_id) <> 1 then
    raise exception using errcode = '22023', message = 'teacher_departure_source_teacher_not_found';
  end if;
  if exists (
    select 1 from jsonb_array_elements(operation_state.payload) item(value)
    where item.value ->> 'type' = '老师离职'
      and item.value ->> 'status' = '待处理'
      and item.value ->> 'teacherId' = p_source_teacher_id
  ) then
    raise exception using errcode = '40001', message = 'teacher_departure_workflow_already_exists';
  end if;

  expected_closure := internal.teacher_departure_creation_projection(
    booking_state.payload, student_state.payload, p_source_teacher_id, p_effective_date
  );
  if jsonb_array_length(expected_closure) = 0 then
    raise exception using errcode = '22023', message = 'teacher_departure_occurrence_not_found';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_affected_groups) item(value)
    where jsonb_typeof(item.value) is distinct from 'object'
      or item.value - 'studentId' - 'operationId' - 'affectedOccurrenceIds' - 'candidateTeacherIds' <> '{}'::jsonb
      or coalesce(item.value ->> 'studentId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
      or coalesce(item.value ->> 'operationId', '') !~ '^OPS-DEPARTURE-[a-f0-9]{24}$'
      or jsonb_typeof(item.value -> 'affectedOccurrenceIds') is distinct from 'array'
      or jsonb_array_length(item.value -> 'affectedOccurrenceIds') = 0
      or jsonb_typeof(item.value -> 'candidateTeacherIds') is distinct from 'array'
      or jsonb_array_length(item.value -> 'candidateTeacherIds') = 0
  ) or (select count(*) from jsonb_array_elements(p_affected_groups)) <>
       (select count(distinct value ->> 'studentId') from jsonb_array_elements(p_affected_groups) item(value)) then
    raise exception using errcode = '22023', message = 'invalid_teacher_departure_groups';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'studentId', item.value ->> 'studentId',
    'affectedOccurrenceIds', item.value -> 'affectedOccurrenceIds'
  ) order by item.value ->> 'studentId' collate "C"), '[]'::jsonb)
  into supplied_closure
  from jsonb_array_elements(p_affected_groups) item(value);
  if supplied_closure is distinct from expected_closure then
    raise exception using errcode = '22023', message = 'teacher_departure_occurrence_closure_mismatch';
  end if;

  for group_item in
    select item.value from jsonb_array_elements(p_affected_groups) item(value)
    order by item.value ->> 'studentId' collate "C"
  loop
    student_id := group_item ->> 'studentId';
    operation_id := 'OPS-DEPARTURE-' || pg_catalog.left(encode(extensions.digest(
      p_command_key || chr(31) || student_id, 'sha256'
    ), 'hex'), 24);
    affected_ids := group_item -> 'affectedOccurrenceIds';
    candidate_ids := group_item -> 'candidateTeacherIds';
    if group_item ->> 'operationId' is distinct from operation_id
       or exists (
         select 1 from jsonb_array_elements(affected_ids) item(value)
         where jsonb_typeof(item.value) is distinct from 'string'
           or (item.value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       )
       or (select count(*) from jsonb_array_elements(affected_ids)) <>
          (select count(distinct value) from jsonb_array_elements_text(affected_ids) item(value))
       or exists (
         select 1 from jsonb_array_elements(candidate_ids) item(value)
         where jsonb_typeof(item.value) is distinct from 'string'
           or (item.value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
       )
       or (select count(*) from jsonb_array_elements(candidate_ids)) <>
          (select count(distinct value) from jsonb_array_elements_text(candidate_ids) item(value))
       or candidate_ids is distinct from (
         select coalesce(jsonb_agg(to_jsonb(value) order by value collate "C"), '[]'::jsonb)
         from jsonb_array_elements_text(candidate_ids) item(value)
       ) then
      raise exception using errcode = '22023', message = 'invalid_teacher_departure_group_identity';
    end if;
    select item.value into student_item from jsonb_array_elements(student_state.payload) item(value)
    where item.value ->> 'id' = student_id limit 1;
    if student_item is null then
      raise exception using errcode = '22023', message = 'teacher_departure_student_not_found';
    end if;
    if exists (
      select 1 from jsonb_array_elements(operation_state.payload) item(value)
      where item.value ->> 'id' = operation_id
    ) then
      raise exception using errcode = '23505', message = 'teacher_departure_operation_id_collision';
    end if;

    for occurrence_id in select value from jsonb_array_elements_text(affected_ids) item(value)
    loop
      select item.value into affected_booking
      from jsonb_array_elements(booking_state.payload) item(value)
      where item.value ->> 'id' = pg_catalog.left(occurrence_id, length(occurrence_id) - 11)
      limit 1;
      if affected_booking is null
         or nullif(trim(affected_booking ->> 'teacherSubjectId'), '') is null then
        raise exception using errcode = '22023', message = 'teacher_departure_subject_missing';
      end if;
    end loop;

    -- The authenticated server computed the exhaustive AVA/conflict closure
    -- from exactly these five versions. Holding all five locks plus OCC proves
    -- that snapshot has not drifted; the database additionally rechecks the
    -- non-temporal eligibility invariants before accepting its exact diff.
    for candidate_id in select value from jsonb_array_elements_text(candidate_ids) item(value)
    loop
      select item.value into candidate_teacher from jsonb_array_elements(teacher_state.payload) item(value)
      where item.value ->> 'id' = candidate_id limit 1;
      if candidate_teacher is null
         or candidate_id = p_source_teacher_id
         or jsonb_typeof(candidate_teacher -> 'subjects') is distinct from 'array'
         or jsonb_typeof(candidate_teacher -> 'availabilityWindows') is distinct from 'array'
         or jsonb_array_length(candidate_teacher -> 'availabilityWindows') = 0
         or (candidate_teacher ? 'capacityAssignments'
           and jsonb_typeof(candidate_teacher -> 'capacityAssignments') is distinct from 'array')
         or exists (
           select 1 from jsonb_array_elements(candidate_teacher -> 'availabilityWindows') window_item(value)
           where jsonb_typeof(window_item.value) is distinct from 'object'
             or window_item.value ->> 'teacherId' is distinct from candidate_id
         )
         or exists (
           select 1
           from jsonb_array_elements(affected_ids) affected(value)
           join jsonb_array_elements(booking_state.payload) booking(value)
             on booking.value ->> 'id' = pg_catalog.left(affected.value #>> '{}', length(affected.value #>> '{}') - 11)
           where not (candidate_teacher -> 'subjects') @> jsonb_build_array(booking.value ->> 'teacherSubjectId')
         )
         then
        raise exception using errcode = '22023', message = 'invalid_teacher_departure_candidate';
      end if;
      candidate_relationship_projection := internal.permanent_teacher_replacement_occurrence_projection(
        booking_state.payload, student_id, candidate_id, p_effective_date, false
      );
      candidate_already_active := coalesce(
        (candidate_relationship_projection ->> 'unbounded')::boolean, false
      ) or jsonb_array_length(candidate_relationship_projection -> 'occurrenceIds') > 0;
      candidate_already_assigned := coalesce(
        candidate_teacher -> 'capacityAssignments' @> jsonb_build_array(student_id), false
      );
      if not candidate_already_active and not candidate_already_assigned and (
        candidate_teacher -> 'acceptsStudents' is distinct from 'true'::jsonb
        or not case when jsonb_typeof(candidate_teacher -> 'newStudentCapacity') = 'number'
          then (candidate_teacher ->> 'newStudentCapacity')::numeric
            = trunc((candidate_teacher ->> 'newStudentCapacity')::numeric)
            and (candidate_teacher ->> 'newStudentCapacity')::numeric > 0
          else false end
      ) then
        raise exception using errcode = '22023', message = 'invalid_teacher_departure_candidate';
      end if;
    end loop;

    generated_operations := generated_operations || jsonb_build_array(jsonb_build_object(
      'id', operation_id,
      'studentId', student_id,
      'type', '老师离职',
      'detail', trim(p_detail),
      'status', '待处理',
      'createdAt', p_submitted_at,
      'teacherId', trim(p_source_teacher_id),
      'eventStart', p_effective_date,
      'eventEnd', p_effective_date,
      'affectedLessonCount', jsonb_array_length(affected_ids),
      'affectedOccurrenceIds', affected_ids,
      'recommendedTeacherIds', candidate_ids,
      'creationCommandKey', p_command_key
    ));
    generated_tasks := generated_tasks || internal.teacher_departure_creation_tasks(
      p_command_key, operation_id, student_id, student_item ->> 'owner',
      p_effective_date::date, submitted_at_value
    );
    operation_ids_value := operation_ids_value || jsonb_build_array(operation_id);
    affected_student_ids_value := affected_student_ids_value || jsonb_build_array(student_id);
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(generated_tasks) generated(value)
    join jsonb_array_elements(task_state.payload) existing(value)
      on generated.value ->> 'id' = existing.value ->> 'id'
  ) then
    raise exception using errcode = '23505', message = 'teacher_departure_task_id_collision';
  end if;
  expected_operations := generated_operations || operation_state.payload;
  expected_tasks := generated_tasks || task_state.payload;
  if p_operations is distinct from expected_operations
     or p_tasks is distinct from expected_tasks then
    raise exception using errcode = '22023', message = 'teacher_departure_payload_mismatch';
  end if;

  update public.ops_state s set payload = expected_operations, version = s.version + 1,
    updated_at = now(), updated_by = trim(p_actor)
  where s.entity = 'operations' returning s.* into saved_operation_state;
  insert into public.ops_mutation_log(entity, version, actor)
  values ('operations', saved_operation_state.version, saved_operation_state.updated_by);
  update public.ops_state s set payload = expected_tasks, version = s.version + 1,
    updated_at = now(), updated_by = trim(p_actor)
  where s.entity = 'tasks' returning s.* into saved_task_state;
  insert into public.ops_mutation_log(entity, version, actor)
  values ('tasks', saved_task_state.version, saved_task_state.updated_by);

  audit_id := internal.append_operational_contract_audit(
    'operation.teacher_departure_create', trim(p_actor), 'teacher', p_source_teacher_id,
    jsonb_build_object(
      'commandKey', p_command_key,
      'effectiveDate', p_effective_date,
      'operationIds', operation_ids_value,
      'affectedStudentIds', affected_student_ids_value,
      'affectedGroups', p_affected_groups,
      'versionsBefore', p_expected_versions,
      'versionsAfter', jsonb_build_object(
        'bookings', booking_state.version,
        'operations', saved_operation_state.version,
        'students', student_state.version,
        'tasks', saved_task_state.version,
        'teachers', teacher_state.version
      ),
      'payloadSha256', payload_hash
    )
  );
  insert into internal.teacher_departure_creation_commands (
    command_key, command_intent, command_hash, source_teacher_id, effective_date,
    operation_ids, affected_student_ids, affected_groups, booking_version,
    operation_version, student_version, task_version, teacher_version, actor, audit_id
  ) values (
    p_command_key, p_command_intent, payload_hash, p_source_teacher_id, p_effective_date::date,
    operation_ids_value, affected_student_ids_value, p_affected_groups, booking_state.version,
    saved_operation_state.version, student_state.version, saved_task_state.version,
    teacher_state.version, trim(p_actor), audit_id
  );

  return query select p_command_key, true, p_source_teacher_id, p_effective_date,
    operation_ids_value, affected_student_ids_value, saved_operation_state,
    saved_task_state, audit_id;
end;
$$;

revoke all on function public.create_teacher_departure_atomic(text, text, jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_teacher_departure_atomic(text, text, jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text)
  to anon, authenticated;

-- Executable fixtures pin the shared occurrence closure and stable task
-- projection without mutating live ops_state during migration.
do $$
declare
  fixture_bookings jsonb := '[{"id":"B-DEP","studentId":"S-1","teacherId":"T-1","date":"2026-09-01","start":"17:00","duration":60,"timezone":"Australia/Melbourne","kind":"常规课","recurring":true,"repeatCount":2,"teacherSubjectId":"Maths&Science"}]'::jsonb;
  fixture_students jsonb := '[{"id":"S-1","status":"在读","owner":"Abby"}]'::jsonb;
  projected jsonb;
  tasks jsonb;
begin
  projected := internal.teacher_departure_creation_projection(
    fixture_bookings, fixture_students, 'T-1', '2026-09-01'
  );
  if projected is distinct from '[{"studentId":"S-1","affectedOccurrenceIds":["B-DEP:2026-09-01","B-DEP:2026-09-08"]}]'::jsonb then
    raise exception 'teacher_departure_creation_fixture_projection_mismatch';
  end if;
  tasks := internal.teacher_departure_creation_tasks(
    'teacher-departure-create:123e4567-e89b-42d3-a456-426614174000',
    'OPS-DEPARTURE-0123456789abcdef01234567', 'S-1', 'Abby',
    '2026-09-01'::date, '2026-08-15T00:00:00.000Z'::timestamptz
  );
  if jsonb_array_length(tasks) <> 5
     or tasks #>> '{0,watchers,0}' <> 'Ops Admin'
     or tasks #>> '{1,owner}' <> 'Abby'
     or tasks #>> '{4,owner}' <> '思佳'
     or tasks #>> '{0,due}' <> '2026-08-18 18:00'
     or tasks #>> '{0,id}' <> 'TSK-DEPARTURE-33b1857fea16f74280c16518'
     or 'OPS-DEPARTURE-' || pg_catalog.left(encode(extensions.digest(
       'teacher-departure-create:123e4567-e89b-42d3-a456-426614174000'
         || chr(31) || 'S-1', 'sha256'
     ), 'hex'), 24) <> 'OPS-DEPARTURE-a7bff281fd38f8e19efe75c7' then
    raise exception 'teacher_departure_creation_fixture_tasks_mismatch';
  end if;
end;
$$;
