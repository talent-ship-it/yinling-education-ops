\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

-- Disposable concurrency seam for the 20260821191021/22 lock contract.
-- Run after student-operation-atomic-runtime.sql with -v fixture_keep_state=true has seeded a fresh local
-- database. Set session-local `student_operation.dsn` to that disposable
-- database DSN to enable dblink; without it this file is EXPLAIN-only and
-- never contacts a remote database.
explain (costs off)
with desired(entity, lock_order) as (
  values ('bookings'::text, 1), ('operations'::text, 2),
         ('students'::text, 3), ('tasks'::text, 4), ('teachers'::text, 5)
),
ordered_locks as materialized (
  select state.ctid as locked_ctid, desired.lock_order
  from desired join public.ops_state state on state.entity = desired.entity
  order by desired.lock_order
  for share of state
),
stable_snapshot as materialized (
  select array_agg(state order by desired.lock_order) as rows
  from desired join public.ops_state state on state.entity = desired.entity
)
select stable_snapshot.rows, (select count(*) from ordered_locks)
from stable_snapshot;

create extension if not exists dblink;

do $concurrency$
declare
  dsn text := current_setting('student_operation.dsn', true);
  secret text := 'student-operation-fixture-secret';
  base_students_version bigint;
  base_tasks_version bigint;
  base_student_count integer;
  base_task_count integer;
  student_command_a text;
  student_command_b text;
  student_replay text;
  student_key_a text := 'student-create:123e4567-e89b-42d3-a456-426614174020';
  student_key_b text := 'student-create:123e4567-e89b-42d3-a456-426614174021';
  student_fields_a jsonb := jsonb_build_object(
    'name', 'Dblink Student A', 'course', 'Year 8 English', 'segment', '试听',
    'guardianWechat', '', 'lpNeed', '试听LP', 'owner', 'Nixon',
    'planner', '待分配', 'grade', 'Year 8', 'location', 'VIC',
    'timezone', 'Australia/Melbourne', 'notes', 'dblink writer A'
  );
  student_fields_b jsonb := jsonb_build_object(
    'name', 'Dblink Student B', 'course', 'Year 8 English', 'segment', '试听',
    'guardianWechat', '', 'lpNeed', '试听LP', 'owner', 'Nixon',
    'planner', '待分配', 'grade', 'Year 8', 'location', 'VIC',
    'timezone', 'Australia/Melbourne', 'notes', 'dblink writer B'
  );
  student_expected_a jsonb;
  student_expected_b jsonb;
  student_intent_a jsonb;
  student_intent_b jsonb;
  lock_receipt text;
  result_a text;
  result_b text;
  replay_result text;
  after_student_version bigint;
  after_task_version bigint;
  after_student_count integer;
  after_task_count integer;
  legacy_base_bookings bigint;
  legacy_base_operations bigint;
  legacy_base_students bigint;
  legacy_base_tasks bigint;
  legacy_base_teachers bigint;
  legacy_base_operation_count integer;
  legacy_base_task_count integer;
  legacy_command_a text;
  legacy_command_b text;
  legacy_replay text;
  legacy_key_a text := 'operation-task-create:123e4567-e89b-42d3-a456-426614174020';
  legacy_key_b text := 'operation-task-create:123e4567-e89b-42d3-a456-426614174021';
  legacy_intent_a jsonb := jsonb_build_object(
    'type', '学生请假', 'detail', 'dblink legacy A', 'studentId', 'S-LEGACY',
    'eventStart', '2026-08-21', 'eventEnd', '2026-08-21'
  );
  legacy_intent_b jsonb := jsonb_build_object(
    'type', '学生请假', 'detail', 'dblink legacy B', 'studentId', 'S-LEGACY',
    'eventStart', '2026-08-21', 'eventEnd', '2026-08-21'
  );
  legacy_expected_a jsonb;
  legacy_expected_b jsonb;
begin
  if dsn is null then
    raise notice 'student_operation.dsn is unset; skipped dblink runtime run';
    return;
  end if;

  select max(version) filter (where entity = 'students'),
         max(version) filter (where entity = 'tasks'),
         max(jsonb_array_length(payload)) filter (where entity = 'students'),
         max(jsonb_array_length(payload)) filter (where entity = 'tasks')
    into base_students_version, base_tasks_version, base_student_count, base_task_count
    from public.ops_state;
  student_expected_a := jsonb_build_object('students', base_students_version, 'tasks', base_tasks_version);
  student_expected_b := jsonb_build_object('students', base_students_version + 1, 'tasks', base_tasks_version + 1);
  student_intent_a := jsonb_build_object('studentFields', student_fields_a, 'expectedVersions', student_expected_a);
  student_intent_b := jsonb_build_object('studentFields', student_fields_b, 'expectedVersions', student_expected_b);
  student_command_a := format($sql$
    select row_to_json(result)::text
    from public.create_student_with_tasks_atomic(%L,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L) result
  $sql$, secret, student_key_a, student_intent_a::text, student_fields_a::text, student_expected_a::text, 'Nixon');
  student_command_b := format($sql$
    select row_to_json(result)::text
    from public.create_student_with_tasks_atomic(%L,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L) result
  $sql$, secret, student_key_b, student_intent_b::text, student_fields_b::text, student_expected_b::text, 'Nixon');
  student_replay := format($sql$
    select row_to_json(result)::text
    from public.get_student_creation_command_result(%L,%L,%L::jsonb,%L) result
  $sql$, secret, student_key_a, student_intent_a::text, 'Nixon');

  perform dblink_connect('student-op-a', dsn);
  perform dblink_exec('student-op-a', pg_temp.disposable_database_assertion_sql());
  perform dblink_connect('student-op-b', dsn);
  perform dblink_exec('student-op-b', pg_temp.disposable_database_assertion_sql());
  perform dblink_connect('student-op-replay', dsn);
  perform dblink_exec('student-op-replay', pg_temp.disposable_database_assertion_sql());

  -- A owns the rows first. B is sent while A owns them and therefore waits;
  -- A's command commits v+1, then B sees the upgraded current rows and its
  -- expected v+1 succeeds. This is a real concurrent writer seam, not two
  -- independent sequential calls.
  perform dblink_exec('student-op-a', 'begin');
  select value into lock_receipt
    from dblink('student-op-a', $sql$
      select string_agg(locked.entity, ',' order by locked.lock_order)
      from (
        select state.entity, desired.lock_order
        from (values ('students'::text, 1), ('tasks'::text, 2)) desired(entity, lock_order)
        join public.ops_state state on state.entity = desired.entity
        order by desired.lock_order
        for update of state
      ) locked
    $sql$) as result(value text);
  if lock_receipt <> 'students,tasks' then raise exception 'student_writer_lock_order_failed'; end if;
  perform dblink_send_query('student-op-b', student_command_b);
  perform dblink_send_query('student-op-a', student_command_a);
  while dblink_is_busy('student-op-a') loop perform pg_sleep(0.01); end loop;
  select max(value) into result_a from dblink_get_result('student-op-a') as result(value text);
  if result_a is null then raise exception 'student_command_a_missing_result'; end if;
  -- dblink may expose a trailing command-complete result for a SELECT that
  -- invokes a set-returning PL/pgSQL command; consume it before COMMIT.
  perform max(value) from dblink_get_result('student-op-a') as result(value text);
  perform dblink_exec('student-op-a', 'commit');
  while dblink_is_busy('student-op-b') loop perform pg_sleep(0.01); end loop;
  select max(value) into result_b from dblink_get_result('student-op-b') as result(value text);
  if result_b is null then raise exception 'student_command_b_missing_result'; end if;

  select version, jsonb_array_length(payload) into after_student_version, after_student_count
    from public.ops_state where entity = 'students';
  select version, jsonb_array_length(payload) into after_task_version, after_task_count
    from public.ops_state where entity = 'tasks';
  if after_student_version <> base_students_version + 2
     or after_task_version <> base_tasks_version + 2
     or after_student_count <> base_student_count + 2
     or after_task_count <> base_task_count + 4 then
    raise exception 'student_two_writer_projection_or_version_failed';
  end if;

  -- Same-key replay is read back through the actor-scoped getter. It must
  -- return the one ledger receipt and leave versions/rows unchanged.
  select value into replay_result from dblink('student-op-replay', student_replay) as result(value text);
  if replay_result is null then raise exception 'student_same_key_replay_missing'; end if;
  if (select count(*) from internal.student_creation_commands where command_key = student_key_a) <> 1
     or (select version from public.ops_state where entity = 'students') <> after_student_version
     or (select version from public.ops_state where entity = 'tasks') <> after_task_version then
    raise exception 'student_same_key_replay_duplicated';
  end if;
  perform dblink_disconnect('student-op-a');
  perform dblink_disconnect('student-op-b');
  perform dblink_disconnect('student-op-replay');

  -- Repeat the same deterministic wait/commit seam for the legacy command.
  -- Its writer lock covers the complete bookings -> operations -> students ->
  -- tasks -> teachers order, proving 191022 writers cannot SHARE-upgrade
  -- deadlock and that both operation/task projections commit atomically.
  select max(version) filter (where entity = 'bookings'),
         max(version) filter (where entity = 'operations'),
         max(version) filter (where entity = 'students'),
         max(version) filter (where entity = 'tasks'),
         max(version) filter (where entity = 'teachers'),
         max(jsonb_array_length(payload)) filter (where entity = 'operations'),
         max(jsonb_array_length(payload)) filter (where entity = 'tasks')
    into legacy_base_bookings, legacy_base_operations, legacy_base_students,
         legacy_base_tasks, legacy_base_teachers, legacy_base_operation_count,
         legacy_base_task_count
    from public.ops_state;
  legacy_expected_a := jsonb_build_object(
    'bookings', legacy_base_bookings, 'operations', legacy_base_operations,
    'students', legacy_base_students, 'tasks', legacy_base_tasks,
    'teachers', legacy_base_teachers
  );
  legacy_expected_b := jsonb_build_object(
    'bookings', legacy_base_bookings, 'operations', legacy_base_operations + 1,
    'students', legacy_base_students, 'tasks', legacy_base_tasks + 1,
    'teachers', legacy_base_teachers
  );
  legacy_command_a := format($sql$
    select row_to_json(result)::text
    from public.mutate_legacy_operation_task_atomic(%L,%L,%L::jsonb,'学生请假',%L,'S-LEGACY',null,'2026-08-21','2026-08-21',null,%L::jsonb,%L) result
  $sql$, secret, legacy_key_a, legacy_intent_a::text, 'dblink legacy A', legacy_expected_a::text, 'Nixon');
  legacy_command_b := format($sql$
    select row_to_json(result)::text
    from public.mutate_legacy_operation_task_atomic(%L,%L,%L::jsonb,'学生请假',%L,'S-LEGACY',null,'2026-08-21','2026-08-21',null,%L::jsonb,%L) result
  $sql$, secret, legacy_key_b, legacy_intent_b::text, 'dblink legacy B', legacy_expected_b::text, 'Nixon');
  legacy_replay := format($sql$
    select row_to_json(result)::text
    from public.get_legacy_operation_task_command_result(%L,%L,%L::jsonb,%L) result
  $sql$, secret, legacy_key_a, legacy_intent_a::text, 'Nixon');

  perform dblink_connect('legacy-op-a', dsn);
  perform dblink_exec('legacy-op-a', pg_temp.disposable_database_assertion_sql());
  perform dblink_connect('legacy-op-b', dsn);
  perform dblink_exec('legacy-op-b', pg_temp.disposable_database_assertion_sql());
  perform dblink_connect('legacy-op-replay', dsn);
  perform dblink_exec('legacy-op-replay', pg_temp.disposable_database_assertion_sql());
  perform dblink_exec('legacy-op-a', 'begin');
  select value into lock_receipt
    from dblink('legacy-op-a', $sql$
      select string_agg(locked.entity, ',' order by locked.lock_order)
      from (
        select state.entity, desired.lock_order
        from (values ('bookings'::text, 1), ('operations'::text, 2), ('students'::text, 3),
                     ('tasks'::text, 4), ('teachers'::text, 5)) desired(entity, lock_order)
        join public.ops_state state on state.entity = desired.entity
        order by desired.lock_order
        for update of state
      ) locked
    $sql$) as result(value text);
  if lock_receipt <> 'bookings,operations,students,tasks,teachers' then raise exception 'legacy_writer_lock_order_failed'; end if;
  perform dblink_send_query('legacy-op-b', legacy_command_b);
  perform dblink_send_query('legacy-op-a', legacy_command_a);
  while dblink_is_busy('legacy-op-a') loop perform pg_sleep(0.01); end loop;
  select max(value) into result_a from dblink_get_result('legacy-op-a') as result(value text);
  if result_a is null then raise exception 'legacy_command_a_missing_result'; end if;
  perform max(value) from dblink_get_result('legacy-op-a') as result(value text);
  perform dblink_exec('legacy-op-a', 'commit');
  while dblink_is_busy('legacy-op-b') loop perform pg_sleep(0.01); end loop;
  select max(value) into result_b from dblink_get_result('legacy-op-b') as result(value text);
  if result_b is null then raise exception 'legacy_command_b_missing_result'; end if;

  if (select version from public.ops_state where entity = 'operations') <> legacy_base_operations + 2
     or (select version from public.ops_state where entity = 'tasks') <> legacy_base_tasks + 2
     or (select jsonb_array_length(payload) from public.ops_state where entity = 'operations') <> legacy_base_operation_count + 2
     or (select jsonb_array_length(payload) from public.ops_state where entity = 'tasks') <> legacy_base_task_count + 2 then
    raise exception 'legacy_two_writer_projection_or_version_failed';
  end if;
  select value into replay_result from dblink('legacy-op-replay', legacy_replay) as result(value text);
  if replay_result is null or (select count(*) from internal.legacy_operation_task_commands where command_key = legacy_key_a) <> 1 then
    raise exception 'legacy_same_key_replay_failed';
  end if;
  perform dblink_disconnect('legacy-op-a');
  perform dblink_disconnect('legacy-op-b');
  perform dblink_disconnect('legacy-op-replay');
end;
$concurrency$;
