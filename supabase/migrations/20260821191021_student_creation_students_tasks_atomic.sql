-- Forward-only P1 correction: creating a student owns the students/tasks
-- projection in one server command.  The browser submits semantic fields and
-- OCC versions only; IDs, defaults and task rows are derived here.

create table if not exists internal.student_creation_commands (
  command_key text primary key check (command_key ~ '^student-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  student_id text not null check (student_id ~ '^STU-[a-f0-9]{24}$'),
  task_ids jsonb not null check (jsonb_typeof(task_ids) = 'array'),
  students_version bigint not null check (students_version > 0),
  tasks_version bigint not null check (tasks_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default clock_timestamp(),
  audit_id uuid not null references internal.operational_contract_audit(id) on delete restrict
);
alter table internal.student_creation_commands enable row level security;
revoke all on table internal.student_creation_commands from public, anon, authenticated, service_role;

create or replace function internal.validate_student_creation_fields(p_fields jsonb)
returns void language plpgsql stable security invoker set search_path = '' as $function$
begin
  if jsonb_typeof(p_fields) is distinct from 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_fields) key) not in (
       array['course','grade','guardianWechat','location','lpNeed','name','notes','owner','planner','segment','timezone']::text[],
       array['course','grade','guardianWechat','location','lpNeed','name','notes','owner','planner','remainingHours','segment','timezone']::text[]
     )
     or exists (select 1 from jsonb_each(p_fields) item where item.key <> 'remainingHours' and jsonb_typeof(item.value) is distinct from 'string')
     or (p_fields ? 'remainingHours' and (jsonb_typeof(p_fields -> 'remainingHours') is distinct from 'number' or (p_fields ->> 'remainingHours')::numeric < 0))
     or length(p_fields ->> 'name') > 240
     or nullif(btrim(p_fields ->> 'course'), '') is null or length(p_fields ->> 'course') > 240
     or p_fields ->> 'segment' not in ('试听', '已报名')
     or p_fields ->> 'lpNeed' not in ('待确认', '无需LP', '试听LP', '新生LP', '老生新LP', '代课LP', 'LP修改')
     or nullif(btrim(p_fields ->> 'owner'), '') is null or length(p_fields ->> 'owner') > 120
     or nullif(btrim(p_fields ->> 'planner'), '') is null or length(p_fields ->> 'planner') > 120
     or nullif(btrim(p_fields ->> 'grade'), '') is null or length(p_fields ->> 'grade') > 120
     or nullif(btrim(p_fields ->> 'location'), '') is null or length(p_fields ->> 'location') > 120
     or nullif(btrim(p_fields ->> 'timezone'), '') is null or length(p_fields ->> 'timezone') > 100
     or length(p_fields ->> 'guardianWechat') > 240 or length(p_fields ->> 'notes') > 4000 then
    raise exception using errcode = '22023', message = 'invalid_student_creation_fields';
  end if;
  if (p_fields ->> 'segment' = '已报名' and nullif(btrim(p_fields ->> 'name'), '') is null)
     or (p_fields ->> 'segment' = '试听' and nullif(btrim(p_fields ->> 'name'), '') is null and nullif(btrim(p_fields ->> 'guardianWechat'), '') is null)
     or p_fields ->> 'owner' not in ('Nixon', 'Ops Admin', 'Abby', 'Ella', 'Molly', 'Thea', 'Tiffany', 'Tara', 'Eileen', '思佳')
     or p_fields ->> 'planner' not in ('待分配', 'Tara', 'Eileen')
     or p_fields ->> 'timezone' not in ('Australia/Melbourne', 'Australia/Adelaide', 'Australia/Sydney', 'Australia/Canberra', 'Australia/Hobart', 'Australia/Brisbane', 'Australia/Perth', 'Pacific/Auckland', 'Asia/Shanghai', 'America/Argentina/Buenos_Aires', 'Europe/Sarajevo') then
    raise exception using errcode = '22023', message = 'invalid_student_creation_authority_fields';
  end if;
end;
$function$;
revoke all on function internal.validate_student_creation_fields(jsonb) from public, anon, authenticated, service_role;

-- Keep the two-row student command snapshot in one statement.  This is the
-- students -> tasks suffix of the global bookings -> operations -> students
-- -> tasks -> teachers order used by the legacy operation command.
create or replace function internal.lock_student_creation_state()
returns table(students_state public.ops_state, tasks_state public.ops_state)
language plpgsql volatile security definer set search_path = '' as $function$
declare receipt_rows public.ops_state[]; locked_count integer;
begin
  -- Match 191019 exactly: ordered_locks owns the physical lock order while
  -- stable_snapshot returns the statement-start rows, never an EvalPlanQual
  -- replacement row obtained after a lock wait.
  with desired(entity, lock_order) as (
    values ('students'::text, 1), ('tasks'::text, 2)
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
  if locked_count <> 2 or cardinality(receipt_rows) <> 2 then
    raise exception using errcode = '55000', message = 'student_creation_state_missing';
  end if;
  students_state := receipt_rows[1];
  tasks_state := receipt_rows[2];
  return next;
end;
$function$;
revoke all on function internal.lock_student_creation_state() from public, anon, authenticated, service_role;

create or replace function public.get_student_creation_command_result(
  p_secret text, p_command_key text, p_command_intent jsonb, p_actor text
)
returns table(command_key text, student_id text, task_ids jsonb,
  students_row public.ops_state, tasks_row public.ops_state, audit_entry_id uuid)
language plpgsql volatile security definer set search_path = '' as $function$
declare prior internal.student_creation_commands%rowtype; state_row record;
  students_state public.ops_state%rowtype; tasks_state public.ops_state%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if coalesce(p_command_key, '') !~ '^student-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or nullif(btrim(p_actor), '') is null or length(btrim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_student_creation_replay_lookup';
  end if;
  -- A receipt is authoritative even when a current projection row is
  -- temporarily unavailable.  Rows are returned only from this locked read.
  select * into state_row from internal.lock_student_creation_state();
  students_state := state_row.students_state;
  tasks_state := state_row.tasks_state;
  -- Re-read after the lock so an empty pre-lock lookup cannot hide a commit
  -- that completed while this replay waited for students -> tasks.
  select * into prior from internal.student_creation_commands as ledger where ledger.command_key = lower(btrim(p_command_key));
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent or prior.actor <> btrim(p_actor) then
    raise exception using errcode = '23505', message = 'student_creation_idempotency_conflict';
  end if;
  if students_state.version < prior.students_version or tasks_state.version < prior.tasks_version then
    raise exception using errcode = '55000', message = 'student_creation_replay_version_regressed';
  end if;
  return query select prior.command_key, prior.student_id, prior.task_ids,
    case when students_state.entity is null then null::public.ops_state else students_state end,
    case when tasks_state.entity is null then null::public.ops_state else tasks_state end,
    prior.audit_id;
end;
$function$;
revoke all on function public.get_student_creation_command_result(text, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.get_student_creation_command_result(text, text, jsonb, text) to anon, authenticated;

create or replace function public.create_student_with_tasks_atomic(
  p_secret text, p_command_key text, p_command_intent jsonb,
  p_student_fields jsonb, p_expected_versions jsonb, p_actor text
)
returns table(command_key text, applied boolean, student_id text, task_ids jsonb,
  students_row public.ops_state, tasks_row public.ops_state, audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $function$
declare students_state public.ops_state%rowtype; tasks_state public.ops_state%rowtype;
  saved_students public.ops_state%rowtype; saved_tasks public.ops_state%rowtype;
  prior internal.student_creation_commands%rowtype;
  command_uuid text := lower(btrim(p_command_key)); student_id_value text;
  initial_task_id text; lp_task_id text; next_students jsonb; next_tasks jsonb;
  student_item jsonb; initial_task jsonb; lp_task jsonb; task_ids_value jsonb := '[]'::jsonb;
  created_at timestamptz := clock_timestamp(); melbourne_date text; due_at text; display_name text;
  payload_hash text; audit_id_value uuid; status_value text; next_value text; assignee_ids jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if command_uuid !~ '^student-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'students' - 'tasks' <> '{}'::jsonb
     or coalesce(p_expected_versions ->> 'students', '') !~ '^[1-9][0-9]*$'
     or coalesce(p_expected_versions ->> 'tasks', '') !~ '^[1-9][0-9]*$'
     or nullif(btrim(p_actor), '') is null or length(btrim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_student_creation_request';
  end if;
  perform internal.validate_student_creation_fields(p_student_fields);
  if btrim(p_actor) not in ('Nixon', 'Ops Admin') and btrim(p_actor) is distinct from btrim(p_student_fields ->> 'owner') then
    raise exception using errcode = '42501', message = 'student_creation_owner_scope_forbidden';
  end if;
  if p_command_intent is distinct from jsonb_build_object('studentFields', p_student_fields, 'expectedVersions', p_expected_versions) then
    raise exception using errcode = '22023', message = 'student_creation_intent_mismatch';
  end if;

  -- Writers acquire exclusive locks directly in the global suffix order.
  -- Never take the reader helper's SHARE locks here: two writers that both
  -- hold SHARE and then convert to UPDATE can deadlock during lock upgrade.
  -- The rows below are therefore the current rows after each lock is held,
  -- not the reader helper's statement-start snapshot.
  select * into students_state from public.ops_state where entity = 'students' for update;
  select * into tasks_state from public.ops_state where entity = 'tasks' for update;
  -- This is the first actor/intent ledger read after the writer locks. It
  -- closes the unknown-result retry race before the OCC check/projection.
  select * into prior from internal.student_creation_commands as ledger where ledger.command_key = command_uuid;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor <> btrim(p_actor) then
      raise exception using errcode = '23505', message = 'student_creation_idempotency_conflict';
    end if;
    return query select prior.command_key, false, prior.student_id, prior.task_ids,
      students_state, tasks_state, prior.audit_id;
    return;
  end if;
  if students_state.entity is null or tasks_state.entity is null
     or jsonb_typeof(students_state.payload) is distinct from 'array'
     or jsonb_typeof(tasks_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'student_creation_state_missing';
  end if;
  if students_state.version <> (p_expected_versions ->> 'students')::bigint
     or tasks_state.version <> (p_expected_versions ->> 'tasks')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if exists (select 1 from jsonb_array_elements(students_state.payload) item group by item.value ->> 'id' having count(*) > 1)
     or exists (select 1 from jsonb_array_elements(tasks_state.payload) item group by item.value ->> 'id' having count(*) > 1) then
    raise exception using errcode = '55000', message = 'student_creation_state_invalid';
  end if;

  student_id_value := 'STU-' || pg_catalog.left(encode(extensions.digest(command_uuid, 'sha256'), 'hex'), 24);
  if exists (select 1 from jsonb_array_elements(students_state.payload) item where item.value ->> 'id' = student_id_value) then
    raise exception using errcode = '23505', message = 'student_creation_id_collision';
  end if;
  melbourne_date := pg_catalog.to_char(created_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD');
  display_name := coalesce(nullif(btrim(p_student_fields ->> 'name'), ''), nullif(btrim(p_student_fields ->> 'guardianWechat'), ''));
  if display_name is null then raise exception using errcode = '22023', message = 'student_creation_display_name_missing'; end if;
  status_value := case when p_student_fields ->> 'segment' = '试听' then '活跃 + 无课时' else '在读' end;
  next_value := case when p_student_fields ->> 'segment' = '试听' then '完成试听交接'
    when p_student_fields ->> 'lpNeed' = '无需LP' then '确认首次排课'
    else '创建' || (p_student_fields ->> 'lpNeed') end;
  assignee_ids := jsonb_build_array(btrim(p_student_fields ->> 'owner'));
  if nullif(btrim(p_student_fields ->> 'planner'), '') is not null
     and btrim(p_student_fields ->> 'planner') <> '待分配'
     and btrim(p_student_fields ->> 'planner') <> btrim(p_student_fields ->> 'owner') then
    assignee_ids := assignee_ids || jsonb_build_array(btrim(p_student_fields ->> 'planner'));
  end if;
  student_item := jsonb_build_object(
    'id', student_id_value, 'name', display_name,
    'initials', pg_catalog.upper(pg_catalog.left(display_name, 2)),
    'status', status_value, 'segment', p_student_fields ->> 'segment',
    'owner', btrim(p_student_fields ->> 'owner'), 'planner', btrim(p_student_fields ->> 'planner'),
    'course', btrim(p_student_fields ->> 'course'), 'grade', btrim(p_student_fields ->> 'grade'),
    'gradeBaseYear', extract(year from created_at at time zone 'Australia/Melbourne')::integer,
    'location', btrim(p_student_fields ->> 'location'), 'timezone', btrim(p_student_fields ->> 'timezone'),
    'guardianWechat', btrim(coalesce(p_student_fields ->> 'guardianWechat', '')),
    'teacher', '待匹配', 'next', next_value, 'nextTone', 'blue', 'files', 0,
    'lpNeed', p_student_fields ->> 'lpNeed', 'followUp', '未记录',
    'notes', coalesce(p_student_fields ->> 'notes', '无特殊备注')
  );
  if p_student_fields ? 'remainingHours' then student_item := student_item || jsonb_build_object('remainingHours', p_student_fields -> 'remainingHours'); end if;
  initial_task_id := 'TSK-' || pg_catalog.left(encode(extensions.digest(command_uuid || chr(31) || 'student.initial-handover', 'sha256'), 'hex'), 24);
  due_at := pg_catalog.to_char((((melbourne_date::date + time '18:00') at time zone 'Australia/Melbourne') at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  initial_task := jsonb_build_object('id', initial_task_id,
    'title', case when p_student_fields ->> 'segment' = '试听' then '完成试听交接与老师匹配' else '确认首次排课与资料' end,
    'owner', btrim(p_student_fields ->> 'owner'), 'assignees', assignee_ids,
    'watchers', jsonb_build_array('Ops Admin'), 'studentId', student_id_value,
    'due', melbourne_date || ' 18:00', 'dueAt', due_at,
    'status', case when melbourne_date < pg_catalog.to_char(created_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD') then 'overdue' else 'today' end,
    'tone', 'amber', 'category', case when p_student_fields ->> 'segment' = '试听' then '试听' else '排课' end,
    'trigger', '新建学生记录', 'ruleKey', 'student.initial-handover', 'anchorBookingId', 'student:' || student_id_value);
  next_tasks := jsonb_build_array(initial_task); task_ids_value := task_ids_value || jsonb_build_array(initial_task_id);
  if p_student_fields ->> 'lpNeed' <> '无需LP' then
    lp_task_id := 'TSK-' || pg_catalog.left(encode(extensions.digest(command_uuid || chr(31) || 'student.create-lp', 'sha256'), 'hex'), 24);
    due_at := pg_catalog.to_char(((((created_at at time zone 'Australia/Melbourne')::date + 1 + time '18:00') at time zone 'Australia/Melbourne') at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    lp_task := jsonb_build_object('id', lp_task_id, 'title', '创建' || (p_student_fields ->> 'lpNeed'),
      'owner', btrim(p_student_fields ->> 'owner'), 'assignees', assignee_ids,
      'watchers', jsonb_build_array('Ops Admin'), 'studentId', student_id_value,
      'due', pg_catalog.to_char((created_at at time zone 'Australia/Melbourne')::date + 1, 'YYYY-MM-DD') || ' 18:00', 'dueAt', due_at,
      'status', 'upcoming', 'tone', 'amber', 'category', 'LP', 'trigger', '建档时选择需要 LP',
      'ruleKey', 'student.create-lp', 'anchorBookingId', 'student:' || student_id_value);
    next_tasks := next_tasks || jsonb_build_array(lp_task); task_ids_value := task_ids_value || jsonb_build_array(lp_task_id);
  end if;
  next_students := jsonb_build_array(student_item) || students_state.payload;
  next_tasks := next_tasks || tasks_state.payload;
  payload_hash := encode(extensions.digest(jsonb_build_object('commandIntent', p_command_intent, 'students', next_students, 'tasks', next_tasks)::text, 'sha256'), 'hex');
  update public.ops_state set payload = next_students, version = version + 1, updated_at = now(), updated_by = btrim(p_actor) where entity = 'students' returning * into saved_students;
  insert into public.ops_mutation_log(entity, version, actor) values ('students', saved_students.version, saved_students.updated_by);
  update public.ops_state set payload = next_tasks, version = version + 1, updated_at = now(), updated_by = btrim(p_actor) where entity = 'tasks' returning * into saved_tasks;
  insert into public.ops_mutation_log(entity, version, actor) values ('tasks', saved_tasks.version, saved_tasks.updated_by);
  audit_id_value := internal.append_operational_contract_audit('student.create_with_tasks', btrim(p_actor), 'student', student_id_value,
    jsonb_build_object('commandKey', command_uuid, 'taskIds', task_ids_value, 'versionsBefore', p_expected_versions, 'payloadSha256', payload_hash));
  insert into internal.student_creation_commands(command_key, command_intent, command_hash, student_id, task_ids, students_version, tasks_version, actor, audit_id)
    values (command_uuid, p_command_intent, payload_hash, student_id_value, task_ids_value, saved_students.version, saved_tasks.version, btrim(p_actor), audit_id_value);
  return query select command_uuid, true, student_id_value, task_ids_value, saved_students, saved_tasks, audit_id_value;
end;
$function$;
revoke all on function public.create_student_with_tasks_atomic(text, text, jsonb, jsonb, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.create_student_with_tasks_atomic(text, text, jsonb, jsonb, jsonb, text) to anon, authenticated;
