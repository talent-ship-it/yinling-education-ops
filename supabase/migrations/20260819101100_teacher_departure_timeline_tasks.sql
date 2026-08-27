-- Forward-only correction for teacher departure task timing.
--
-- The original atomic contract used effectiveDate - 7 for every handover
-- task.  This migration keeps the old deployed migration immutable, adds a
-- replacement projector, and rewires the already-deployed atomic RPC to call
-- it.  The projector uses the finite native booking occurrences and their
-- overrides, so it never invents a penultimate lesson date.

create or replace function internal.teacher_departure_creation_tasks_v2(
  p_command_key text,
  p_operation_id text,
  p_student_id text,
  p_student_owner text,
  p_source_teacher_id text,
  p_bookings jsonb,
  p_effective_date date,
  p_submitted_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  definition jsonb;
  task_owner text;
  due_date date;
  due_at_text text;
  task_status text;
  task_tone text;
  source_teacher_name text;
  lp_due_date date;
  result jsonb := '[]'::jsonb;
begin
  if coalesce(p_command_key, '') !~ '^teacher-departure-create:'
     or nullif(trim(p_operation_id), '') is null
     or nullif(trim(p_student_id), '') is null
     or nullif(trim(p_source_teacher_id), '') is null
     or jsonb_typeof(p_bookings) is distinct from 'array'
     or p_effective_date is null
     or p_submitted_at is null then
    raise exception using errcode = '22023', message = 'invalid_teacher_departure_task_projection';
  end if;

  select nullif(trim(item.value ->> 'name'), '')
    into source_teacher_name
  from public.ops_state state
  cross join lateral jsonb_array_elements(state.payload) item(value)
  where state.entity = 'teachers'
    and item.value ->> 'id' = p_source_teacher_id
  limit 1;
  if source_teacher_name is null then
    raise exception using errcode = '22023', message = 'teacher_departure_source_teacher_name_missing';
  end if;

  -- Expand every finite source date, then apply the override's effective
  -- date/time/teacher/student/status before sorting.  A moved occurrence is
  -- therefore still eligible when its actual date remains before departure.
  with booking_rows as (
    select booking.value as booking
    from jsonb_array_elements(p_bookings) booking(value)
    where booking.value ->> 'kind' is distinct from '代课'
  ), source_occurrences as (
    select
      booking,
      source_date::date as source_date,
      booking ->> 'id' || ':' || pg_catalog.to_char(source_date::date, 'YYYY-MM-DD') as occurrence_id
    from booking_rows
    cross join lateral generate_series(
      (booking ->> 'date')::date,
      case when booking ->> 'recurring' = 'true'
        then (booking ->> 'date')::date
          + (((booking ->> 'repeatCount')::integer - 1) * 7)
        else (booking ->> 'date')::date end,
      interval '7 days'
    ) source_date
  ), resolved_occurrences as (
    select
      source.occurrence_id,
      (coalesce(override.value ->> 'date', source.source_date::text))::date as lesson_date,
      coalesce(override.value ->> 'start', source.booking ->> 'start') as lesson_start,
      case when override.value ? 'teacherId'
        then case when jsonb_typeof(override.value -> 'teacherId') = 'string'
          then nullif(trim(override.value ->> 'teacherId'), '') else null end
        else nullif(trim(source.booking ->> 'teacherId'), '') end as teacher_id,
      case when override.value ? 'studentId'
        then case when jsonb_typeof(override.value -> 'studentId') = 'string'
          then nullif(trim(override.value ->> 'studentId'), '') else null end
        else nullif(trim(source.booking ->> 'studentId'), '') end as student_id,
      coalesce(override.value ->> 'status', 'confirmed') as lesson_status,
      case when override.value ? 'durationMinutes'
        and override.value -> 'durationMinutes' <> 'null'::jsonb
        then (override.value ->> 'durationMinutes')::numeric
        else (source.booking ->> 'duration')::numeric end as duration_minutes,
      coalesce(nullif(trim(source.booking ->> 'timezone'), ''), 'Australia/Melbourne') as timezone_name
    from source_occurrences source
    left join lateral (
      select item.value
      from jsonb_array_elements(case when jsonb_typeof(source.booking -> 'occurrenceOverrides') = 'array'
        then source.booking -> 'occurrenceOverrides' else '[]'::jsonb end) item(value)
      where item.value ->> 'occurrenceId' = source.occurrence_id
      limit 1
    ) override on true
  ), ranked as (
    select *,
      row_number() over (order by lesson_date, lesson_start, occurrence_id) as lesson_number,
      count(*) over () as lesson_count
    from resolved_occurrences
    where student_id = p_student_id
      and teacher_id = p_source_teacher_id
      and lesson_date < p_effective_date
      and lesson_status not in ('cancelled', 'leave')
  )
  select (
    (((lesson_date::timestamp + lesson_start::time
      + duration_minutes * interval '1 minute') at time zone timezone_name)
      at time zone 'Australia/Melbourne')::date + 1
  )
  into lp_due_date
  from ranked
  where lesson_number = lesson_count - 1;

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
      task_status := 'overdue'; task_tone := 'red';
    elsif due_date = (p_submitted_at at time zone 'Australia/Melbourne')::date then
      task_status := 'today'; task_tone := 'amber';
    else
      task_status := 'upcoming'; task_tone := definition ->> 'tone';
    end if;
    result := result || jsonb_build_array(jsonb_build_object(
      'id', 'TSK-DEPARTURE-' || pg_catalog.left(encode(extensions.digest(
        p_command_key || chr(31) || p_student_id || chr(31) || (definition ->> 'rule'), 'sha256'
      ), 'hex'), 24),
      'title', definition ->> 'title', 'owner', task_owner,
      'assignees', jsonb_build_array(task_owner), 'watchers', jsonb_build_array('Ops Admin'),
      'studentId', p_student_id, 'due', pg_catalog.to_char(due_date, 'YYYY-MM-DD') || ' 18:00',
      'dueAt', due_at_text, 'status', task_status, 'tone', task_tone,
      'category', '请假代课', 'trigger', definition ->> 'trigger',
      'ruleKey', 'teacher-departure:' || p_operation_id || ':' || (definition ->> 'rule'),
      'anchorBookingId', p_operation_id
    ));
  end loop;

  -- No exact penultimate occurrence means no LP deadline.  The absence is
  -- deliberate: a fallback date would turn missing source data into a false
  -- promise in the operations queue.
  if lp_due_date is not null then
    due_date := lp_due_date;
    due_at_text := pg_catalog.to_char(
      ((due_date::timestamp + interval '18 hours') at time zone 'Australia/Melbourne') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    if due_date < (p_submitted_at at time zone 'Australia/Melbourne')::date then
      task_status := 'overdue'; task_tone := 'red';
    elsif due_date = (p_submitted_at at time zone 'Australia/Melbourne')::date then
      task_status := 'today'; task_tone := 'amber';
    else
      task_status := 'upcoming'; task_tone := 'blue';
    end if;
    result := result || jsonb_build_array(jsonb_build_object(
      'id', 'TSK-DEPARTURE-' || pg_catalog.left(encode(extensions.digest(
        p_command_key || chr(31) || p_student_id || chr(31) || 'lp-to-new-teacher', 'sha256'
      ), 'hex'), 24),
      'title', '写 LP 给新老师', 'owner', source_teacher_name,
      'assignees', jsonb_build_array(source_teacher_name), 'watchers', jsonb_build_array('Ops Admin'),
      'studentId', p_student_id, 'due', pg_catalog.to_char(due_date, 'YYYY-MM-DD') || ' 18:00',
      'dueAt', due_at_text, 'status', task_status, 'tone', task_tone,
      'category', '请假代课', 'trigger', '老师离职：写 LP 给新老师',
      'ruleKey', 'teacher-departure:' || p_operation_id || ':lp-to-new-teacher',
      'anchorBookingId', p_operation_id
    ));
  end if;
  return result;
end;
$function$;

revoke all on function internal.teacher_departure_creation_tasks_v2(text, text, text, text, text, jsonb, date, timestamptz)
  from public, anon, authenticated, service_role;

-- Keep the public RPC signature stable while replacing only its task projector
-- call.  The guard makes this forward migration fail closed if the deployed
-- atomic contract has drifted instead of silently leaving the old offset logic.
do $migration$
declare
  function_definition text;
  rewritten text;
begin
  select pg_get_functiondef(p.oid)
    into function_definition
  from pg_proc p
  where p.oid = 'public.create_teacher_departure_atomic(text, text, jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text, text)'::regprocedure;
  if function_definition is null then
    raise exception 'teacher_departure_atomic_function_missing';
  end if;
  rewritten := regexp_replace(
    function_definition,
    'internal\.teacher_departure_creation_tasks\(\s*p_command_key,\s*operation_id,\s*student_id,\s*student_item ->> ''owner'',\s*p_effective_date::date,\s*submitted_at_value\s*\)',
    'internal.teacher_departure_creation_tasks_v2(p_command_key, operation_id, student_id, student_item ->> ''owner'', p_source_teacher_id, booking_state.payload, p_effective_date::date, submitted_at_value)',
    'n'
  );
  if rewritten = function_definition
     or position('teacher_departure_creation_tasks_v2' in rewritten) = 0 then
    raise exception 'teacher_departure_task_call_not_found';
  end if;
  execute rewritten;
end;
$migration$;

-- Executable fixture for the exact timeline and source-teacher ownership.
do $fixture$
declare
  tasks jsonb;
begin
  if not exists (
    select 1 from public.ops_state state
    cross join lateral jsonb_array_elements(state.payload) item(value)
    where state.entity = 'teachers' and item.value ->> 'id' = 'T-1'
  ) then
    return;
  end if;
  tasks := internal.teacher_departure_creation_tasks_v2(
    'teacher-departure-create:123e4567-e89b-42d3-a456-426614174000',
    'OPS-DEPARTURE-0123456789abcdef01234567', 'S-1', 'Abby', 'T-1',
    '[
      {"id":"B-HIST","studentId":"S-1","teacherId":"T-1","date":"2026-08-04","start":"17:00","duration":60,"timezone":"Australia/Melbourne","kind":"常规课"},
      {"id":"B-MOVED","studentId":"S-1","teacherId":"T-1","date":"2026-08-11","start":"17:00","duration":60,"timezone":"Australia/Melbourne","kind":"常规课","occurrenceOverrides":[{"occurrenceId":"B-MOVED:2026-08-11","date":"2026-08-25","start":"19:00"}]}
    ]'::jsonb,
    '2026-09-01'::date, '2026-08-15T00:00:00.000Z'::timestamptz
  );
  if tasks #>> '{5,title}' <> '写 LP 给新老师'
     or tasks #>> '{5,owner}' is null
     or tasks #>> '{5,due}' <> '2026-08-05 18:00'
     or tasks #>> '{5,ruleKey}' <> 'teacher-departure:OPS-DEPARTURE-0123456789abcdef01234567:lp-to-new-teacher' then
    raise exception 'teacher_departure_timeline_fixture_mismatch';
  end if;
end;
$fixture$;
