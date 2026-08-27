-- Student direct-enrollment LPs are one command over the students, lpItems and
-- tasks projections. The client submits only scalar command fields; all IDs and
-- payload arrays are rebuilt from locked state in this function.

create table if not exists internal.student_direct_enrollment_commands (
  command_uuid text primary key check (command_uuid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  student_id text not null,
  package_id text not null,
  purchase_id text not null,
  lp_item_id text not null,
  task_ids jsonb not null check (jsonb_typeof(task_ids) = 'array'),
  students_version bigint not null check (students_version > 0),
  lp_items_version bigint not null check (lp_items_version > 0),
  tasks_version bigint not null check (tasks_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);
alter table internal.student_direct_enrollment_commands enable row level security;
revoke all on table internal.student_direct_enrollment_commands from public, anon, authenticated, service_role;

create or replace function public.get_student_direct_enrollment_command_result(
  p_secret text, p_command_uuid text, p_command_intent jsonb, p_actor text
)
returns table(command_key text, student_id text, package_id text, purchase_id text,
  lp_item_id text, task_ids jsonb, students_row public.ops_state,
  lp_items_row public.ops_state, tasks_row public.ops_state, audit_entry_id uuid)
language plpgsql volatile security definer set search_path = '' as $function$
declare
  prior internal.student_direct_enrollment_commands%rowtype;
  students_state public.ops_state%rowtype;
  lp_items_state public.ops_state%rowtype;
  tasks_state public.ops_state%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(lower(trim(p_command_uuid)), '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or nullif(trim(p_actor), '') is null then
    raise exception using errcode = '22023', message = 'invalid_direct_enrollment_replay_lookup';
  end if;
  select * into prior
  from internal.student_direct_enrollment_commands
  where command_uuid = lower(trim(p_command_uuid));
  if prior.command_uuid is null then return; end if;
  if prior.command_intent is distinct from p_command_intent or prior.actor <> trim(p_actor) then
    raise exception using errcode = '23505', message = 'direct_enrollment_idempotency_conflict';
  end if;
  -- Replay reads the current authoritative rows in the same fixed order. A
  -- prior receipt remains valid even if one projection is temporarily absent;
  -- the nullable row columns preserve the receipt without re-running OCC.
  select * into students_state from public.ops_state where entity = 'students' for update;
  select * into lp_items_state from public.ops_state where entity = 'lpItems' for update;
  select * into tasks_state from public.ops_state where entity = 'tasks' for update;
  return query select prior.command_uuid, prior.student_id, prior.package_id,
    prior.purchase_id, prior.lp_item_id, prior.task_ids,
    case when students_state.entity is null then null::public.ops_state else students_state end,
    case when lp_items_state.entity is null then null::public.ops_state else lp_items_state end,
    case when tasks_state.entity is null then null::public.ops_state else tasks_state end,
    prior.audit_id;
end;
$function$;
revoke all on function public.get_student_direct_enrollment_command_result(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_student_direct_enrollment_command_result(text, text, jsonb, text)
  to anon, authenticated;

create or replace function public.create_student_direct_enrollment_atomic(
  p_secret text,
  p_command_uuid text,
  p_command_intent jsonb,
  p_student_id text,
  p_lp_fields jsonb,
  p_purchased_hours numeric,
  p_bonus_hours numeric,
  p_subject text,
  p_expected_versions jsonb,
  p_actor text
)
returns table(command_key text, applied boolean, student_id text, package_id text,
  purchase_id text, lp_item_id text, task_ids jsonb, students_row public.ops_state,
  lp_items_row public.ops_state, tasks_row public.ops_state, audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $function$
declare
  students_state public.ops_state%rowtype;
  lp_items_state public.ops_state%rowtype;
  tasks_state public.ops_state%rowtype;
  bookings_state public.ops_state%rowtype;
  saved_students public.ops_state%rowtype;
  saved_lp_items public.ops_state%rowtype;
  saved_tasks public.ops_state%rowtype;
  prior internal.student_direct_enrollment_commands%rowtype;
  student_item jsonb;
  existing_packages jsonb;
  new_package jsonb;
  new_purchase jsonb;
  lp_fields jsonb;
  lp_item jsonb;
  next_students jsonb := '[]'::jsonb;
  next_lp_items jsonb;
  next_tasks jsonb := '[]'::jsonb;
  task_ids jsonb := '[]'::jsonb;
  expected_task_ids jsonb := '[]'::jsonb;
  task_item jsonb;
  generated_task jsonb;
  expected_intent jsonb;
  command_key text := lower(trim(p_command_uuid));
  package_id_value text;
  purchase_id_value text;
  lp_item_id_value text;
  revision_id_value text;
  task_id_value text;
  owner_value text;
  subject_value text := trim(p_subject);
  created_at timestamptz;
  due_at timestamptz;
  content_due_at timestamptz;
  task_due_at timestamptz;
  due_text text;
  due_at_text text;
  task_status text;
  task_tone text;
  total_contract numeric;
  total_remaining numeric;
  audit_id_value uuid;
  payload_hash text;
  first_workflow boolean;
  rule text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if command_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(trim(p_student_id), '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or trim(p_student_id) ~* 'temp'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or jsonb_typeof(p_lp_fields) is distinct from 'object'
     or p_purchased_hours is null or p_bonus_hours is null
     or p_purchased_hours < 0 or p_bonus_hours < 0
     or p_purchased_hours in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
     or p_bonus_hours in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
     or p_purchased_hours > 1000000 or p_bonus_hours > 1000000
     or p_purchased_hours + p_bonus_hours <= 0
     or nullif(subject_value, '') is null
     or length(subject_value) > 240
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or nullif(trim(p_actor), '') is null
     or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_direct_enrollment_request';
  end if;

  expected_intent := jsonb_build_object(
    'studentId', trim(p_student_id),
    'workflowType', '学生直报（无试听）',
    'fields', p_lp_fields,
    'purchasedHours', p_purchased_hours,
    'bonusHours', p_bonus_hours,
    'subject', subject_value,
    'expectedVersions', p_expected_versions
  );
  if p_command_intent is distinct from expected_intent then
    raise exception using errcode = '22023', message = 'direct_enrollment_intent_mismatch';
  end if;
  if (select array_agg(key order by key) from jsonb_object_keys(p_expected_versions) key)
       is distinct from array['lpItems','students','tasks']::text[]
     or exists (select 1 from jsonb_each(p_expected_versions) item
       where jsonb_typeof(item.value) is distinct from 'number'
          or item.value #>> '{}' !~ '^[1-9][0-9]*$') then
    raise exception using errcode = '22023', message = 'invalid_direct_enrollment_versions';
  end if;
  if (select array_agg(key order by key) from jsonb_object_keys(p_lp_fields) key)
       is distinct from array['contactPerson','coursesAndTeachers','isUniversityStudent','lessonFrequency','locationTimezone','oneSentenceDescription','preferredTime','preparationFollowUp','responsibleOperations','specialNotes','specifiedContentStatus','timeMentioned','universityMajor','universityYear']::text[] then
    raise exception using errcode = '22023', message = 'invalid_direct_enrollment_lp_fields';
  end if;
  if exists (select 1 from jsonb_each(p_lp_fields) item where jsonb_typeof(item.value) is distinct from 'string'
       and item.key not in ('isUniversityStudent','timeMentioned'))
     or exists (select 1 from jsonb_each_text(p_lp_fields) item where length(item.value) > 2_000)
     or jsonb_typeof(p_lp_fields -> 'isUniversityStudent') is distinct from 'boolean'
     or jsonb_typeof(p_lp_fields -> 'timeMentioned') is distinct from 'boolean'
     or ((p_lp_fields ->> 'timeMentioned')::boolean and nullif(trim(p_lp_fields ->> 'preferredTime'), '') is null)
     or nullif(trim(p_lp_fields ->> 'responsibleOperations'), '') is null
     or p_lp_fields ->> 'specifiedContentStatus' not in ('已指定', '无需指定', '需要跟进')
     or p_lp_fields ->> 'preparationFollowUp' not in ('是', '否')
     or p_lp_fields ->> 'contactPerson' not in ('家长', '学生本人')
     or nullif(trim(p_lp_fields ->> 'oneSentenceDescription'), '') is null
     or nullif(trim(p_lp_fields ->> 'locationTimezone'), '') is null
     or nullif(trim(p_lp_fields ->> 'lessonFrequency'), '') is null
     or nullif(trim(p_lp_fields ->> 'coursesAndTeachers'), '') is null
     or ((p_lp_fields ->> 'isUniversityStudent')::boolean and (nullif(trim(p_lp_fields ->> 'universityMajor'), '') is null or nullif(trim(p_lp_fields ->> 'universityYear'), '') is null)) then
    raise exception using errcode = '22023', message = 'invalid_direct_enrollment_lp_fields';
  end if;

  -- Check the ledger before requiring any current projection row. This is the
  -- second replay gate (the route normally resolves it first) and is what
  -- makes an uncertain write recoverable through a temporarily incomplete
  -- state snapshot.
  select * into prior from internal.student_direct_enrollment_commands where command_uuid = command_key;
  if prior.command_uuid is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor <> trim(p_actor) then
      raise exception using errcode = '23505', message = 'direct_enrollment_idempotency_conflict';
    end if;
    select * into students_state from public.ops_state where entity = 'students' for update;
    select * into lp_items_state from public.ops_state where entity = 'lpItems' for update;
    select * into tasks_state from public.ops_state where entity = 'tasks' for update;
    return query select prior.command_uuid, false, prior.student_id, prior.package_id,
      prior.purchase_id, prior.lp_item_id, prior.task_ids,
      case when students_state.entity is null then null::public.ops_state else students_state end,
      case when lp_items_state.entity is null then null::public.ops_state else lp_items_state end,
      case when tasks_state.entity is null then null::public.ops_state else tasks_state end,
      prior.audit_id;
    return;
  end if;

  -- Fixed write lock order is part of the contract: students, lpItems, tasks.
  select * into students_state from public.ops_state where entity = 'students' for update;
  select * into lp_items_state from public.ops_state where entity = 'lpItems' for update;
  select * into tasks_state from public.ops_state where entity = 'tasks' for update;
  select * into prior from internal.student_direct_enrollment_commands where command_uuid = command_key;
  if prior.command_uuid is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor <> trim(p_actor) then
      raise exception using errcode = '23505', message = 'direct_enrollment_idempotency_conflict';
    end if;
    return query select prior.command_uuid, false, prior.student_id, prior.package_id,
      prior.purchase_id, prior.lp_item_id, prior.task_ids,
      case when students_state.entity is null then null::public.ops_state else students_state end,
      case when lp_items_state.entity is null then null::public.ops_state else lp_items_state end,
      case when tasks_state.entity is null then null::public.ops_state else tasks_state end,
      prior.audit_id;
    return;
  end if;
  if students_state.entity is null or lp_items_state.entity is null or tasks_state.entity is null then
    raise exception using errcode = '55000', message = 'direct_enrollment_state_missing';
  end if;
  -- Bookings are read-only authority for student subject choices. Locking the
  -- snapshot after the three write rows prevents accepting a booking-only
  -- subject that disappeared while the command was being prepared, without
  -- adding a fourth OCC version to the narrow browser command.
  select * into bookings_state from public.ops_state where entity = 'bookings' for share;
  if bookings_state.entity is null then
    raise exception using errcode = '55000', message = 'direct_enrollment_bookings_state_missing';
  end if;

  if students_state.version <> (p_expected_versions ->> 'students')::bigint
     or lp_items_state.version <> (p_expected_versions ->> 'lpItems')::bigint
     or tasks_state.version <> (p_expected_versions ->> 'tasks')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if jsonb_typeof(students_state.payload) is distinct from 'array'
     or jsonb_typeof(lp_items_state.payload) is distinct from 'array'
     or jsonb_typeof(tasks_state.payload) is distinct from 'array'
     or jsonb_typeof(bookings_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'direct_enrollment_payload_invalid';
  end if;
  select value into student_item from jsonb_array_elements(students_state.payload)
    where value ->> 'id' = trim(p_student_id) limit 1;
  if student_item is null then raise exception using errcode = 'P0002', message = 'student_not_found'; end if;
  if student_item ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'student_archived';
  end if;

  if not (
    lower(subject_value) = lower(trim(coalesce(student_item ->> 'course', '')))
    or exists (select 1 from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb)) package_item
      cross join lateral jsonb_array_elements_text(coalesce(package_item.value -> 'subjectIds', '[]'::jsonb)) subject_item
      where lower(trim(subject_item.value)) = lower(subject_value))
    or exists (select 1 from jsonb_array_elements(bookings_state.payload) booking_item
      where booking_item.value ->> 'studentId' = trim(p_student_id)
        and (lower(trim(coalesce(booking_item.value ->> 'teacherSubjectId', ''))) = lower(subject_value)
          or lower(trim(coalesce(booking_item.value ->> 'course', ''))) = lower(subject_value)))
  ) then
    raise exception using errcode = '22023', message = 'subject_not_available';
  end if;
  if exists (select 1
    from (select coalesce((select sum((purchase.value ->> 'hours')::numeric) from jsonb_array_elements(coalesce(package_item.value -> 'purchaseRecords', '[]'::jsonb)) purchase(value)), 0) package_total,
      coalesce((package_item.value ->> 'consumedHours')::numeric, 0) consumed_hours
      from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb)) package_item
      where exists (select 1 from jsonb_array_elements_text(coalesce(package_item.value -> 'subjectIds', '[]'::jsonb)) subject_item where lower(trim(subject_item.value)) = lower(subject_value))) balances
    where round(round(package_total, 6) - round(consumed_hours, 6), 6) <> 0) then
    raise exception using errcode = '40901', message = 'subject_package_has_balance';
  end if;

  created_at := clock_timestamp();
  due_at := created_at + interval '24 hours';
  content_due_at := (((created_at at time zone 'Australia/Melbourne')::date + time '18:00') at time zone 'Australia/Melbourne');

  package_id_value := 'PKG-DIRECT-' || left(encode(extensions.digest(command_key || chr(31) || trim(p_student_id) || chr(31) || subject_value, 'sha256'), 'hex'), 24);
  purchase_id_value := 'PUR-DIRECT-' || left(encode(extensions.digest(command_key || chr(31) || 'purchase', 'sha256'), 'hex'), 24);
  lp_item_id_value := 'LP-DIRECT-' || left(encode(extensions.digest(command_key || chr(31) || 'lp', 'sha256'), 'hex'), 24);
  revision_id_value := 'LPR-DIRECT-' || left(encode(extensions.digest(command_key || chr(31) || 'revision', 'sha256'), 'hex'), 24);
  owner_value := coalesce(nullif(trim(p_lp_fields ->> 'responsibleOperations'), ''), nullif(trim(student_item ->> 'owner'), ''), '待分配');
  new_purchase := jsonb_build_object('id', purchase_id_value, 'purchasedAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'hours', p_purchased_hours + p_bonus_hours, 'purchasedHours', p_purchased_hours, 'bonusHours', p_bonus_hours);
  new_package := jsonb_build_object('id', package_id_value, 'name', subject_value || ' · 直报课包', 'subjectIds', jsonb_build_array(subject_value), 'purchaseRecords', jsonb_build_array(new_purchase), 'consumedHours', 0);
  if (select array_agg(key order by key) from jsonb_object_keys(new_purchase) key)
       is distinct from array['bonusHours','hours','id','purchasedAt','purchasedHours']::text[]
     or (select array_agg(key order by key) from jsonb_object_keys(new_package) key)
       is distinct from array['consumedHours','id','name','purchaseRecords','subjectIds']::text[] then
    raise exception using errcode = '22023', message = 'direct_enrollment_package_payload_mismatch';
  end if;
  -- Match bindSubjectToLessonPackage(): a zero-balance prior binding is
  -- removed before the new package becomes the authoritative subject owner.
  select coalesce(jsonb_agg(case when exists (select 1 from jsonb_array_elements_text(coalesce(package_item.value -> 'subjectIds', '[]'::jsonb)) old_subject(value) where lower(trim(old_subject.value)) = lower(subject_value)) then
      package_item.value || jsonb_build_object('subjectIds', coalesce((select jsonb_agg(old_subject.value order by old_subject.ordinality) from jsonb_array_elements_text(coalesce(package_item.value -> 'subjectIds', '[]'::jsonb)) with ordinality old_subject(value, ordinality) where lower(trim(old_subject.value)) <> lower(subject_value)), '[]'::jsonb))
      else package_item.value end order by package_item.ordinality), '[]'::jsonb) || jsonb_build_array(new_package)
    into existing_packages
    from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb)) with ordinality package_item(value, ordinality);
  select round(coalesce(sum(package_total), 0), 6), round(coalesce(sum(package_total - consumed_hours), 0), 6)
    into total_contract, total_remaining
    from (select coalesce((select sum((purchase.value ->> 'hours')::numeric) from jsonb_array_elements(coalesce(package_item.value -> 'purchaseRecords', '[]'::jsonb)) purchase(value)), 0) package_total,
      coalesce((package_item.value ->> 'consumedHours')::numeric, 0) consumed_hours
      from jsonb_array_elements(existing_packages) package_item(value)) package_totals;
  lp_fields := p_lp_fields || jsonb_build_object('subject', subject_value, 'purchasedHours', p_purchased_hours, 'bonusHours', p_bonus_hours);
  if (select array_agg(key order by key) from jsonb_object_keys(lp_fields) key)
       is distinct from array['bonusHours','contactPerson','coursesAndTeachers','isUniversityStudent','lessonFrequency','locationTimezone','oneSentenceDescription','preferredTime','preparationFollowUp','purchasedHours','responsibleOperations','specialNotes','specifiedContentStatus','subject','timeMentioned','universityMajor','universityYear']::text[] then
    raise exception using errcode = '22023', message = 'direct_enrollment_lp_payload_mismatch';
  end if;
  lp_item := jsonb_build_object(
    'id', lp_item_id_value, 'studentId', trim(p_student_id), 'title', '学生直报（无试听） · ' || coalesce(student_item ->> 'name', trim(p_student_id)),
    'workflowType', '学生直报（无试听）', 'stage', '待资料', 'owner', owner_value,
    'due', to_char(due_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI'),
    'needsParentFollowUp', p_lp_fields ->> 'specifiedContentStatus' = '需要跟进',
    'needsTeacherPrep', p_lp_fields ->> 'preparationFollowUp' = '是',
    'fields', lp_fields, 'revisionNumber', 1,
    'revisions', jsonb_build_array(jsonb_build_object('id', revision_id_value, 'workflowId', lp_item_id_value, 'number', 1, 'changedAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'changedBy', trim(p_actor), 'note', '创建 LP', 'before', '{}'::jsonb, 'after', lp_fields)),
    'stageAudit', '[]'::jsonb, 'resultAudit', '[]'::jsonb
  );
  if (select array_agg(key order by key) from jsonb_object_keys(lp_item) key)
       is distinct from array['due','fields','id','needsParentFollowUp','needsTeacherPrep','owner','resultAudit','revisionNumber','revisions','stage','stageAudit','studentId','title','workflowType']::text[] then
    raise exception using errcode = '22023', message = 'direct_enrollment_lp_item_payload_mismatch';
  end if;
  if (select array_agg(key order by key) from jsonb_object_keys(lp_item -> 'revisions' -> 0) key)
       is distinct from array['after','before','changedAt','changedBy','id','note','number','workflowId']::text[]
     or jsonb_typeof(lp_item -> 'stageAudit') is distinct from 'array'
     or jsonb_typeof(lp_item -> 'resultAudit') is distinct from 'array'
     or jsonb_array_length(lp_item -> 'stageAudit') <> 0
     or jsonb_array_length(lp_item -> 'resultAudit') <> 0 then
    raise exception using errcode = '22023', message = 'direct_enrollment_lp_item_payload_mismatch';
  end if;
  next_students := (select coalesce(jsonb_agg(case when value ->> 'id' = trim(p_student_id) then
    value || jsonb_build_object('lessonPackages', existing_packages, 'remainingHours', total_remaining, 'contractHours', total_contract, 'lpNeed', '新生LP', 'next', '学生直报（无试听）已创建', 'nextTone', 'amber') else value end), '[]'::jsonb) from jsonb_array_elements(students_state.payload));
  first_workflow := not exists (select 1 from jsonb_array_elements(lp_items_state.payload) value where value ->> 'studentId' = trim(p_student_id));
  next_lp_items := lp_items_state.payload || jsonb_build_array(lp_item);
  for task_item in select value from jsonb_array_elements(tasks_state.payload) loop
    if task_item ->> 'studentId' = trim(p_student_id) and task_item ->> 'status' <> 'done'
       and (task_item ->> 'ruleKey' = 'student.create-lp' or (first_workflow and task_item ->> 'ruleKey' = 'student.initial-handover')) then
      next_tasks := next_tasks || jsonb_build_array(task_item || jsonb_build_object('status', 'done', 'tone', 'green', 'result', 'LP 工作流已创建，任务自动关闭', 'closedAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    else next_tasks := next_tasks || jsonb_build_array(task_item); end if;
  end loop;
  for rule in select rules.value from jsonb_array_elements_text(jsonb_build_array('handover', case when p_lp_fields ->> 'specifiedContentStatus' = '需要跟进' then 'specified-content' else null end, case when p_lp_fields ->> 'preparationFollowUp' = '是' then 'preparation-follow-up' else null end)) as rules(value) where rules.value is not null loop
    task_id_value := 'TSK-DIRECT-' || left(encode(extensions.digest(command_key || chr(31) || rule, 'sha256'), 'hex'), 24);
    task_due_at := case when rule = 'specified-content' then content_due_at else due_at end;
    due_text := to_char(task_due_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI');
    due_at_text := to_char(task_due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    task_status := case when (task_due_at at time zone 'Australia/Melbourne')::date < (created_at at time zone 'Australia/Melbourne')::date then 'overdue' when (task_due_at at time zone 'Australia/Melbourne')::date = (created_at at time zone 'Australia/Melbourne')::date then 'today' else 'upcoming' end;
    task_tone := case when rule = 'specified-content' then 'red' when rule = 'preparation-follow-up' then 'amber' else 'blue' end;
    generated_task := jsonb_build_object('id', task_id_value, 'title', case rule when 'handover' then '学生直报（无试听）：核对交接信息' when 'specified-content' then '跟进指定内容' else '跟进老师备课' end, 'owner', owner_value, 'assignees', jsonb_build_array(owner_value), 'watchers', jsonb_build_array('Ops Admin'), 'studentId', trim(p_student_id), 'due', due_text, 'dueAt', due_at_text, 'status', task_status, 'tone', task_tone, 'category', 'LP', 'trigger', case rule when 'handover' then '学生直报（无试听）创建后自动生成' when 'specified-content' then '学生直报（无试听）指定内容需要跟进' else '学生直报（无试听）需要跟进备课' end, 'ruleKey', 'lp.' || rule, 'anchorBookingId', lp_item_id_value);
    if (select array_agg(key order by key) from jsonb_object_keys(generated_task) key)
         is distinct from array['anchorBookingId','assignees','category','due','dueAt','id','owner','ruleKey','status','studentId','title','tone','trigger','watchers']::text[] then
      raise exception using errcode = '22023', message = 'direct_enrollment_task_payload_mismatch';
    end if;
    next_tasks := next_tasks || jsonb_build_array(generated_task);
    task_ids := task_ids || jsonb_build_array(task_id_value);
  end loop;
  expected_task_ids := jsonb_build_array(
    'TSK-DIRECT-' || left(encode(extensions.digest(command_key || chr(31) || 'handover', 'sha256'), 'hex'), 24)
  );
  if p_lp_fields ->> 'specifiedContentStatus' = '需要跟进' then
    expected_task_ids := expected_task_ids || jsonb_build_array(
      'TSK-DIRECT-' || left(encode(extensions.digest(command_key || chr(31) || 'specified-content', 'sha256'), 'hex'), 24)
    );
  end if;
  if p_lp_fields ->> 'preparationFollowUp' = '是' then
    expected_task_ids := expected_task_ids || jsonb_build_array(
      'TSK-DIRECT-' || left(encode(extensions.digest(command_key || chr(31) || 'preparation-follow-up', 'sha256'), 'hex'), 24)
    );
  end if;
  if task_ids is distinct from expected_task_ids then
    raise exception using errcode = '22023', message = 'direct_enrollment_task_ids_mismatch';
  end if;

  update public.ops_state set payload = next_students, version = students_state.version + 1, updated_at = now(), updated_by = trim(p_actor) where entity = 'students' returning * into saved_students;
  insert into public.ops_mutation_log(entity, version, actor) values ('students', saved_students.version, saved_students.updated_by);
  update public.ops_state set payload = next_lp_items, version = lp_items_state.version + 1, updated_at = now(), updated_by = trim(p_actor) where entity = 'lpItems' returning * into saved_lp_items;
  insert into public.ops_mutation_log(entity, version, actor) values ('lpItems', saved_lp_items.version, saved_lp_items.updated_by);
  update public.ops_state set payload = next_tasks, version = tasks_state.version + 1, updated_at = now(), updated_by = trim(p_actor) where entity = 'tasks' returning * into saved_tasks;
  insert into public.ops_mutation_log(entity, version, actor) values ('tasks', saved_tasks.version, saved_tasks.updated_by);
  payload_hash := encode(extensions.digest(jsonb_build_object('commandIntent', p_command_intent, 'students', next_students, 'lpItems', next_lp_items, 'tasks', next_tasks)::text, 'sha256'), 'hex');
  audit_id_value := internal.append_operational_contract_audit('student.direct_enrollment_create', trim(p_actor), 'student', trim(p_student_id), jsonb_build_object('commandUuid', command_key, 'packageId', package_id_value, 'purchaseId', purchase_id_value, 'lpItemId', lp_item_id_value, 'taskIds', task_ids, 'payloadSha256', payload_hash, 'versionsBefore', p_expected_versions));
  insert into internal.student_direct_enrollment_commands(command_uuid, command_intent, command_hash, student_id, package_id, purchase_id, lp_item_id, task_ids, students_version, lp_items_version, tasks_version, actor, audit_id)
    values (command_key, p_command_intent, payload_hash, trim(p_student_id), package_id_value, purchase_id_value, lp_item_id_value, task_ids, saved_students.version, saved_lp_items.version, saved_tasks.version, trim(p_actor), audit_id_value);
  return query select command_key, true, trim(p_student_id), package_id_value, purchase_id_value, lp_item_id_value, task_ids, saved_students, saved_lp_items, saved_tasks, audit_id_value;
end;
$function$;
revoke all on function public.create_student_direct_enrollment_atomic(text,text,jsonb,text,jsonb,numeric,numeric,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_student_direct_enrollment_atomic(text,text,jsonb,text,jsonb,numeric,numeric,text,jsonb,text)
  to anon, authenticated;
