-- Forward-only P1 correction: student leave/stop and teacher replacement are
-- semantic commands. The database locks the complete authority scope and
-- rebuilds both projections in the same transaction. No caller may provide
-- operation or task rows.

drop function if exists public.mutate_legacy_operation_task_atomic(text, text, jsonb, jsonb, jsonb, jsonb, text);

create table if not exists internal.legacy_operation_task_commands (
  command_key text primary key check (command_key ~ '^operation-task-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  operation_ids jsonb not null check (jsonb_typeof(operation_ids) = 'array'),
  affected_student_ids jsonb not null check (jsonb_typeof(affected_student_ids) = 'array'),
  affected_occurrence_count integer not null check (affected_occurrence_count > 0),
  generated_task_count integer not null check (generated_task_count > 0),
  bookings_version bigint not null check (bookings_version > 0),
  operations_version bigint not null check (operations_version > 0),
  students_version bigint not null check (students_version > 0),
  tasks_version bigint not null check (tasks_version > 0),
  teachers_version bigint not null check (teachers_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default clock_timestamp(),
  audit_id uuid not null references internal.operational_contract_audit(id) on delete restrict
);
alter table internal.legacy_operation_task_commands enable row level security;
revoke all on table internal.legacy_operation_task_commands from public, anon, authenticated, service_role;

-- One statement snapshot and the global lock order used by all readers/writers.
create or replace function internal.lock_legacy_operation_task_state()
returns table(bookings_state public.ops_state, operations_state public.ops_state,
  students_state public.ops_state, tasks_state public.ops_state,
  teachers_state public.ops_state)
language plpgsql volatile security definer set search_path = '' as $function$
declare receipt_rows public.ops_state[]; locked_count integer;
begin
  -- Match the 191019 contract exactly: desired fixes the global rank,
  -- ordered_locks is MATERIALIZED so LockRows runs in that order, and
  -- stable_snapshot is MATERIALIZED so returned values are from the single
  -- statement snapshot taken before any wait/EvalPlanQual replacement row.
  with desired(entity, lock_order) as (
    values
      ('bookings'::text, 1),
      ('operations'::text, 2),
      ('students'::text, 3),
      ('tasks'::text, 4),
      ('teachers'::text, 5)
  ),
  ordered_locks as materialized (
    select state.ctid as locked_ctid, desired.lock_order
    from desired
    join public.ops_state state on state.entity = desired.entity
    order by desired.lock_order
    for share of state
  ),
  stable_snapshot as materialized (
    select array_agg(state order by desired.lock_order) as rows
    from desired
    join public.ops_state state on state.entity = desired.entity
  )
  select stable_snapshot.rows, (select count(*)::integer from ordered_locks)
    into receipt_rows, locked_count
    from stable_snapshot;
  if locked_count <> 5 or cardinality(receipt_rows) <> 5 then
    raise exception using errcode = '55000', message = 'operation_task_state_missing';
  end if;
  bookings_state := receipt_rows[1];
  operations_state := receipt_rows[2];
  students_state := receipt_rows[3];
  tasks_state := receipt_rows[4];
  teachers_state := receipt_rows[5];
  return next;
end;
$function$;
revoke all on function internal.lock_legacy_operation_task_state() from public, anon, authenticated, service_role;

-- Resolve every source occurrence from authoritative recurrence and override
-- rows. A moved occurrence can have a source date before the requested target
-- range, so the source loop is widened in both directions before resolution.
create or replace function internal.legacy_operation_task_projection(
  p_command_key text, p_bookings jsonb, p_students jsonb, p_teachers jsonb,
  p_type text, p_detail text, p_student_id text, p_teacher_id text,
  p_event_start text, p_event_end text, p_source_booking_id text,
  p_now timestamptz
) returns jsonb
language plpgsql stable security invoker set search_path = '' as $function$
declare
  booking jsonb; override_item jsonb; occurrence jsonb; student_item jsonb;
  groups jsonb := '{}'::jsonb; generated_ops jsonb := '[]'::jsonb; generated_tasks jsonb := '[]'::jsonb;
  group_item jsonb; group_value jsonb; subject text; student_id text; occurrence_id text;
  base_date date; source_start date; source_end date; source_date date; target_date date;
  interval_days integer; repeats integer; i integer; operation_id text; task_id text;
  first_at text; due_date date; due_at_value timestamptz; due_at_text text; status_value text; owner text;
  affected_count integer := 0; task_count integer := 0; candidate_ids jsonb; planner text; assignee_ids jsonb;
begin
  if p_type not in ('学生请假', '停课', '换老师') or nullif(btrim(p_detail), '') is null
     or p_event_start !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or p_event_end !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_event_start > p_event_end then
    raise exception using errcode = '22023', message = 'invalid_operation_task_semantic_command';
  end if;
  if p_type in ('学生请假', '停课') and nullif(btrim(p_student_id), '') is null then
    raise exception using errcode = '22023', message = 'operation_task_student_required';
  end if;
  if p_type = '换老师' and (nullif(btrim(p_student_id), '') is null or nullif(btrim(p_teacher_id), '') is null) then
    raise exception using errcode = '22023', message = 'operation_task_teacher_replacement_identity_required';
  end if;
  due_date := (p_now at time zone 'Australia/Melbourne')::date;
  due_at_value := ((due_date + time '18:00') at time zone 'Australia/Melbourne');
  due_at_text := to_char(due_at_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  for booking in select value from jsonb_array_elements(coalesce(p_bookings, '[]'::jsonb)) item(value) loop
    if p_source_booking_id is not null and booking ->> 'id' is distinct from p_source_booking_id then continue; end if;
    begin base_date := (booking ->> 'date')::date; exception when others then raise exception using errcode = '22023', message = 'operation_task_booking_date_invalid'; end;
    source_start := p_event_start::date; source_end := p_event_end::date;
    -- Moved overrides map a source occurrence id to a target date. Include
    -- the source side even when it is before eventStart.
    for override_item in select value from jsonb_array_elements(case when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array' then booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value) loop
      begin
        source_date := right(override_item ->> 'occurrenceId', 10)::date;
        target_date := coalesce((override_item ->> 'date')::date, source_date);
        if target_date between p_event_start::date and p_event_end::date then
          source_start := least(source_start, source_date); source_end := greatest(source_end, source_date);
        end if;
      exception when others then raise exception using errcode = '22023', message = 'operation_task_override_date_invalid'; end;
    end loop;
    interval_days := internal.teacher_absence_recurrence_interval(booking);
    repeats := internal.teacher_absence_occurrence_count(booking, source_end);
    if repeats < 1 then continue; end if;
    for i in 0..repeats - 1 loop
      source_date := base_date + i * case when interval_days = 0 then 0 else interval_days end;
      if source_date < source_start or source_date > source_end then continue; end if;
      occurrence_id := coalesce(booking ->> 'id', '') || ':' || to_char(source_date, 'YYYY-MM-DD');
      occurrence := internal.teacher_absence_resolve_occurrence(booking, occurrence_id);
      if occurrence is null or occurrence ->> 'status' in ('cancelled', 'leave')
         or (occurrence ->> 'date')::date not between p_event_start::date and p_event_end::date
         or occurrence ->> 'studentId' is distinct from p_student_id then continue; end if;
      if p_type = '换老师' and occurrence ->> 'teacherId' is distinct from p_teacher_id then continue; end if;
      if p_type in ('学生请假', '停课') and p_teacher_id is not null and occurrence ->> 'teacherId' is distinct from p_teacher_id then continue; end if;
      student_id := occurrence ->> 'studentId';
      subject := nullif(btrim(booking ->> 'teacherSubjectId'), '');
      if p_type = '换老师' and subject is null then raise exception using errcode = '22023', message = 'operation_task_teacher_subject_missing'; end if;
      first_at := to_char((occurrence ->> 'startsAt')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      group_value := coalesce(groups -> student_id, jsonb_build_object('studentId', student_id, 'affectedOccurrenceIds', '[]'::jsonb, 'subjects', '[]'::jsonb));
      group_value := group_value || jsonb_build_object(
        'affectedOccurrenceIds', (group_value -> 'affectedOccurrenceIds') || jsonb_build_array(occurrence_id),
        'subjects', case when subject is null or (group_value -> 'subjects') @> jsonb_build_array(subject) then group_value -> 'subjects' else (group_value -> 'subjects') || jsonb_build_array(subject) end,
        'firstAffectedAt', case when group_value ->> 'firstAffectedAt' is null or first_at < group_value ->> 'firstAffectedAt' then first_at else group_value ->> 'firstAffectedAt' end
      );
      groups := jsonb_set(groups, array[student_id], group_value, true); affected_count := affected_count + 1;
    end loop;
  end loop;
  if groups = '{}'::jsonb then raise exception using errcode = '22023', message = 'operation_task_occurrence_not_found'; end if;

  for group_item in select value from jsonb_each(groups) item(key, value) order by item.key collate "C" loop
    student_id := group_item ->> 'studentId';
    select value into student_item from jsonb_array_elements(coalesce(p_students, '[]'::jsonb)) item(value) where value ->> 'id' = student_id limit 1;
    if student_item is null then raise exception using errcode = '22023', message = 'operation_task_student_not_found'; end if;
    if p_type = '换老师' then candidate_ids := internal.teacher_absence_candidate_ids(p_bookings, p_teachers, p_teacher_id, group_item);
    else candidate_ids := '[]'::jsonb; end if;
    group_value := group_item || jsonb_build_object('candidateTeacherIds', candidate_ids);
    groups := jsonb_set(groups, array[student_id], group_value, true);
    operation_id := 'OPS-' || left(encode(extensions.digest(p_command_key || chr(31) || student_id, 'sha256'), 'hex'), 24);
    generated_ops := generated_ops || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'id', operation_id, 'studentId', student_id, 'type', p_type, 'detail', btrim(p_detail), 'status', '待处理',
      'createdAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'submittedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'teacherId', p_teacher_id, 'eventStart', p_event_start, 'eventEnd', p_event_end,
      'firstAffectedAt', group_value ->> 'firstAffectedAt', 'affectedLessonCount', jsonb_array_length(group_value -> 'affectedOccurrenceIds'),
      'affectedOccurrenceIds', group_value -> 'affectedOccurrenceIds', 'subjectIds', group_value -> 'subjects',
      'recommendedTeacherIds', candidate_ids, 'sourceBookingId', p_source_booking_id, 'creationCommandKey', p_command_key
    )));
    owner := coalesce(nullif(btrim(student_item ->> 'owner'), ''), '待分配');
    planner := nullif(btrim(student_item ->> 'planner'), '');
    assignee_ids := jsonb_build_array(owner);
    if planner is not null and planner <> '待分配' and planner <> owner then
      assignee_ids := assignee_ids || jsonb_build_array(planner);
    end if;
    task_id := 'TSK-' || left(encode(extensions.digest(p_command_key || chr(31) || student_id || chr(31) || 'legacy-operation', 'sha256'), 'hex'), 24);
    status_value := case when due_date < (p_now at time zone 'Australia/Melbourne')::date then 'overdue' when due_date = (p_now at time zone 'Australia/Melbourne')::date then 'today' else 'upcoming' end;
    generated_tasks := generated_tasks || jsonb_build_array(jsonb_build_object(
      'id', task_id, 'title', p_type || '：' || btrim(p_detail), 'owner', owner, 'assignees', assignee_ids,
      'watchers', jsonb_build_array('Ops Admin'), 'studentId', student_id, 'due', to_char(due_date, 'YYYY-MM-DD') || ' 18:00', 'dueAt', due_at_text,
      'createdAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'submittedAt', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'status', status_value, 'tone', case when status_value = 'overdue' then 'red' when status_value = 'today' then 'amber' else 'amber' end,
      'category', '请假代课', 'trigger', p_type || '记录后自动生成', 'ruleKey', 'operation.' || p_type || '.legacy', 'anchorBookingId', operation_id
    ));
    task_count := task_count + 1;
  end loop;
  return jsonb_build_object(
    'groups', coalesce((select jsonb_agg(value order by key collate "C") from jsonb_each(groups)), '[]'::jsonb),
    'operations', generated_ops, 'tasks', generated_tasks,
    'operationIds', coalesce((select jsonb_agg(value ->> 'id' order by value ->> 'id' collate "C") from jsonb_array_elements(generated_ops) item(value)), '[]'::jsonb),
    'affectedStudentIds', coalesce((select jsonb_agg(value ->> 'studentId' order by value ->> 'studentId' collate "C") from jsonb_array_elements(generated_ops) item(value)), '[]'::jsonb),
    'affectedOccurrenceCount', affected_count, 'generatedTaskCount', task_count
  );
end;
$function$;
revoke all on function internal.legacy_operation_task_projection(text, jsonb, jsonb, jsonb, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated, service_role;

create or replace function public.get_legacy_operation_task_command_result(
  p_secret text, p_command_key text, p_command_intent jsonb, p_actor text
)
returns table(command_key text, operation_ids jsonb, affected_student_ids jsonb,
  operations_row public.ops_state, tasks_row public.ops_state, audit_entry_id uuid)
language plpgsql volatile security definer set search_path = '' as $function$
declare prior internal.legacy_operation_task_commands%rowtype; state_row record;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if coalesce(p_command_key, '') !~ '^operation-task-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object' or nullif(btrim(p_actor), '') is null or length(btrim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_operation_task_replay_lookup';
  end if;
  select * into state_row from internal.lock_legacy_operation_task_state();
  -- Re-read after waiting on the ordered locks. An empty pre-lock read must
  -- never turn a committed concurrent command into a false unknown result.
  select * into prior from internal.legacy_operation_task_commands as ledger where ledger.command_key = lower(btrim(p_command_key));
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent or prior.actor <> btrim(p_actor) then raise exception using errcode = '23505', message = 'operation_task_idempotency_conflict'; end if;
  if (state_row.operations_state).version < prior.operations_version or (state_row.tasks_state).version < prior.tasks_version then
    raise exception using errcode = '55000', message = 'operation_task_replay_version_regressed';
  end if;
  return query select prior.command_key, prior.operation_ids, prior.affected_student_ids, state_row.operations_state, state_row.tasks_state, prior.audit_id;
end;
$function$;
revoke all on function public.get_legacy_operation_task_command_result(text, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.get_legacy_operation_task_command_result(text, text, jsonb, text) to anon, authenticated;

create or replace function public.mutate_legacy_operation_task_atomic(
  p_secret text, p_command_key text, p_command_intent jsonb,
  p_type text, p_detail text, p_student_id text, p_teacher_id text,
  p_event_start text, p_event_end text, p_source_booking_id text,
  p_expected_versions jsonb, p_actor text
)
returns table(command_key text, applied boolean, operation_ids jsonb, affected_student_ids jsonb,
  affected_occurrence_count integer, generated_task_count integer,
  operations_row public.ops_state, tasks_row public.ops_state, audit_entry_id uuid)
language plpgsql volatile security definer set search_path = '' as $function$
declare b public.ops_state%rowtype; o public.ops_state%rowtype; s public.ops_state%rowtype; t public.ops_state%rowtype; h public.ops_state%rowtype;
  saved_operations public.ops_state%rowtype; saved_tasks public.ops_state%rowtype; prior internal.legacy_operation_task_commands%rowtype;
  intent jsonb; projection jsonb; now_value timestamptz; payload_hash text; audit_id_value uuid;
  actor_value text := btrim(p_actor); command_uuid text := lower(btrim(p_command_key));
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  intent := jsonb_strip_nulls(jsonb_build_object('type', nullif(btrim(p_type), ''), 'detail', nullif(btrim(p_detail), ''), 'studentId', nullif(btrim(p_student_id), ''), 'teacherId', nullif(btrim(p_teacher_id), ''), 'eventStart', p_event_start, 'eventEnd', p_event_end, 'sourceBookingId', nullif(btrim(p_source_booking_id), '')));
  if command_uuid !~ '^operation-task-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object' or p_command_intent is distinct from intent
     or p_type not in ('学生请假', '停课', '换老师') or nullif(btrim(p_detail), '') is null or length(btrim(p_detail)) > 2000
     or p_event_start !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_event_end !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p_event_start > p_event_end
     or (p_type in ('学生请假', '停课') and nullif(btrim(p_student_id), '') is null)
     or (p_type = '换老师' and (nullif(btrim(p_student_id), '') is null or nullif(btrim(p_teacher_id), '') is null))
     or actor_value not in ('Nixon', 'Ops Admin', 'Abby', 'Ella', 'Molly', 'Thea', 'Tiffany', 'Tara', 'Eileen', '思佳')
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or not p_expected_versions ?& array['bookings', 'operations', 'students', 'tasks', 'teachers']
     or p_expected_versions - 'bookings' - 'operations' - 'students' - 'tasks' - 'teachers' <> '{}'::jsonb
     or exists (select 1 from jsonb_each(p_expected_versions) version_item(key, value) where jsonb_typeof(value) is distinct from 'number' or value #>> '{}' !~ '^[1-9][0-9]*$' or (value #>> '{}')::numeric > 9007199254740991) then
    raise exception using errcode = '22023', message = 'invalid_operation_task_request';
  end if;
  -- Writers acquire exclusive locks directly in the complete global order.
  -- Do not call the reader helper first: two writers holding the full SHARE
  -- set and then converting it to UPDATE can deadlock during conversion.
  -- Each row below is read after its exclusive lock is held, so projection
  -- and OCC use current rows after any preceding writer commits.
  select * into b from public.ops_state where entity = 'bookings' for update;
  select * into o from public.ops_state where entity = 'operations' for update;
  select * into s from public.ops_state where entity = 'students' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  select * into h from public.ops_state where entity = 'teachers' for update;
  -- This is the first actor/intent ledger read after all writer locks. It
  -- closes the unknown-result retry race before any OCC or projection work.
  select * into prior from internal.legacy_operation_task_commands as ledger where ledger.command_key = command_uuid;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor <> actor_value then raise exception using errcode = '23505', message = 'operation_task_idempotency_conflict'; end if;
    return query select prior.command_key, false, prior.operation_ids, prior.affected_student_ids, prior.affected_occurrence_count, prior.generated_task_count, o, t, prior.audit_id;
    return;
  end if;
  if b.entity is null or o.entity is null or s.entity is null or t.entity is null or h.entity is null
     or jsonb_typeof(b.payload) is distinct from 'array' or jsonb_typeof(o.payload) is distinct from 'array'
     or jsonb_typeof(s.payload) is distinct from 'array' or jsonb_typeof(t.payload) is distinct from 'array'
     or jsonb_typeof(h.payload) is distinct from 'array' then raise exception using errcode = '55000', message = 'operation_task_state_missing'; end if;
  if b.version <> (p_expected_versions ->> 'bookings')::bigint or o.version <> (p_expected_versions ->> 'operations')::bigint
     or s.version <> (p_expected_versions ->> 'students')::bigint or t.version <> (p_expected_versions ->> 'tasks')::bigint
     or h.version <> (p_expected_versions ->> 'teachers')::bigint then raise exception using errcode = '40001', message = 'version_conflict'; end if;
  if p_source_booking_id is not null and not exists (select 1 from jsonb_array_elements(b.payload) item where item.value ->> 'id' = p_source_booking_id) then raise exception using errcode = '22023', message = 'operation_task_source_booking_not_found'; end if;
  if not exists (select 1 from jsonb_array_elements(s.payload) item where item.value ->> 'id' = p_student_id and coalesce(item.value ->> 'importArchived', 'false') <> 'true' and coalesce(item.value ->> 'status', '') not in ('已归档', 'archived')) then raise exception using errcode = '42501', message = 'operation_task_student_scope_forbidden'; end if;
  if actor_value not in ('Nixon', 'Ops Admin') and not exists (select 1 from jsonb_array_elements(s.payload) item where item.value ->> 'id' = p_student_id and btrim(item.value ->> 'owner') = actor_value) then raise exception using errcode = '42501', message = 'operation_task_actor_scope_forbidden'; end if;
  if p_type = '换老师' and not exists (select 1 from jsonb_array_elements(h.payload) item where item.value ->> 'id' = p_teacher_id) then raise exception using errcode = '22023', message = 'operation_task_source_teacher_not_found'; end if;
  now_value := clock_timestamp();
  projection := internal.legacy_operation_task_projection(command_uuid, b.payload, s.payload, h.payload, p_type, p_detail, p_student_id, p_teacher_id, p_event_start, p_event_end, p_source_booking_id, now_value);
  if jsonb_array_length(projection -> 'operations') = 0 or jsonb_array_length(projection -> 'tasks') = 0 then raise exception using errcode = '22023', message = 'operation_task_projection_empty'; end if;
  if exists (select 1 from jsonb_array_elements(projection -> 'operations') added join jsonb_array_elements(o.payload) existing on existing.value ->> 'id' = added.value ->> 'id')
     or exists (select 1 from jsonb_array_elements(projection -> 'tasks') added join jsonb_array_elements(t.payload) existing on existing.value ->> 'id' = added.value ->> 'id') then raise exception using errcode = '23505', message = 'operation_task_projection_id_collision'; end if;
  update public.ops_state set payload = (projection -> 'operations') || o.payload, version = o.version + 1, updated_at = now(), updated_by = actor_value where entity = 'operations' returning * into saved_operations;
  insert into public.ops_mutation_log(entity, version, actor) values ('operations', saved_operations.version, saved_operations.updated_by);
  update public.ops_state set payload = (projection -> 'tasks') || t.payload, version = t.version + 1, updated_at = now(), updated_by = actor_value where entity = 'tasks' returning * into saved_tasks;
  insert into public.ops_mutation_log(entity, version, actor) values ('tasks', saved_tasks.version, saved_tasks.updated_by);
  payload_hash := encode(extensions.digest(jsonb_build_object('commandIntent', p_command_intent, 'expectedVersions', p_expected_versions, 'projection', projection)::text, 'sha256'), 'hex');
  audit_id_value := internal.append_operational_contract_audit('operation.legacy_operation_task_create', actor_value, 'operation', projection -> 'operationIds' ->> 0,
    jsonb_build_object('commandKey', command_uuid, 'operationIds', projection -> 'operationIds', 'affectedStudentIds', projection -> 'affectedStudentIds', 'affectedOccurrenceCount', projection -> 'affectedOccurrenceCount', 'generatedTaskCount', projection -> 'generatedTaskCount', 'versionsBefore', p_expected_versions, 'payloadSha256', payload_hash));
  insert into internal.legacy_operation_task_commands(command_key, command_intent, command_hash, operation_ids, affected_student_ids, affected_occurrence_count, generated_task_count, bookings_version, operations_version, students_version, tasks_version, teachers_version, actor, audit_id)
    values (command_uuid, p_command_intent, payload_hash, projection -> 'operationIds', projection -> 'affectedStudentIds', (projection ->> 'affectedOccurrenceCount')::integer, (projection ->> 'generatedTaskCount')::integer, b.version, saved_operations.version, s.version, saved_tasks.version, h.version, actor_value, audit_id_value);
  return query select command_uuid, true, projection -> 'operationIds', projection -> 'affectedStudentIds', (projection ->> 'affectedOccurrenceCount')::integer, (projection ->> 'generatedTaskCount')::integer, saved_operations, saved_tasks, audit_id_value;
end;
$function$;
revoke all on function public.mutate_legacy_operation_task_atomic(text, text, jsonb, text, text, text, text, text, text, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.mutate_legacy_operation_task_atomic(text, text, jsonb, text, text, text, text, text, text, text, jsonb, text) to anon, authenticated;
