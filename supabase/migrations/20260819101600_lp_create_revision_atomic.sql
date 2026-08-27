-- Ordinary LP creation and LP revision are one authoritative command.  The
-- browser sends a narrow command; this function rebuilds LP/tasks/files and
-- the student projection while holding a stable lock order.

create table if not exists internal.lp_atomic_commands (
  command_uuid text primary key check (command_uuid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  operation text not null check (operation in ('create', 'revise')),
  student_id text not null,
  lp_item_id text not null,
  audit_id uuid not null references internal.operational_contract_audit(id),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default now()
);
alter table internal.lp_atomic_commands enable row level security;
revoke all on table internal.lp_atomic_commands from public, anon, authenticated, service_role;

create or replace function public.get_lp_atomic_command_result(
  p_secret text, p_command_uuid text, p_command_intent jsonb, p_actor text
)
returns table(command_key text, operation text, student_id text, lp_item_id text,
  students_row public.ops_state, lp_items_row public.ops_state,
  tasks_row public.ops_state, files_row public.ops_state, audit_entry_id uuid)
language plpgsql volatile security definer set search_path = '' as $function$
declare
  prior internal.lp_atomic_commands%rowtype;
  s public.ops_state%rowtype;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  f public.ops_state%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(lower(trim(p_command_uuid)), '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or nullif(trim(p_actor), '') is null then
    raise exception using errcode = '22023', message = 'invalid_lp_replay_lookup';
  end if;
  select * into prior from internal.lp_atomic_commands where command_uuid = lower(trim(p_command_uuid));
  if prior.command_uuid is null then return; end if;
  if prior.command_intent is distinct from p_command_intent or prior.actor <> trim(p_actor) then
    raise exception using errcode = '23505', message = 'lp_idempotency_conflict';
  end if;
  -- Files must be first: the existing attachment transaction locks files and
  -- then students. Every LP lock path follows that global order to avoid a
  -- files/students cycle during replay recovery.
  select * into f from public.ops_state where entity = 'files' for update;
  select * into s from public.ops_state where entity = 'students' for update;
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  return query select prior.command_uuid, prior.operation, prior.student_id, prior.lp_item_id,
    case when s.entity is null then null::public.ops_state else s end,
    case when l.entity is null then null::public.ops_state else l end,
    case when t.entity is null then null::public.ops_state else t end,
    case when f.entity is null then null::public.ops_state else f end,
    prior.audit_id;
end;
$function$;
revoke all on function public.get_lp_atomic_command_result(text,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_lp_atomic_command_result(text,text,jsonb,text)
  to anon, authenticated;

create or replace function public.mutate_lp_atomic(
  p_secret text,
  p_command_uuid text,
  p_command_intent jsonb,
  p_operation text,
  p_student_id text,
  p_provisional_intake jsonb,
  p_lp_item_id text,
  p_workflow_type text,
  p_fields jsonb,
  p_revision_note text,
  p_authorized_assignment jsonb,
  p_expected_versions jsonb,
  p_actor text
)
returns table(command_key text, operation text, applied boolean, student_id text, lp_item_id text,
  students_row public.ops_state, lp_items_row public.ops_state, tasks_row public.ops_state,
  files_row public.ops_state, audit_entry_id uuid)
language plpgsql security definer set search_path = '' as $function$
declare
  s public.ops_state%rowtype;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  f public.ops_state%rowtype;
  saved_s public.ops_state%rowtype;
  saved_l public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  saved_f public.ops_state%rowtype;
  prior internal.lp_atomic_commands%rowtype;
  student jsonb;
  item jsonb;
  next_s jsonb;
  next_l jsonb;
  next_t jsonb;
  next_f jsonb;
  lp_item jsonb;
  task_item jsonb;
  generated jsonb;
  revision jsonb;
  file_item jsonb;
  fields jsonb;
  command_key text := lower(trim(p_command_uuid));
  student_id_value text;
  provisional boolean := p_provisional_intake is not null;
  owner_value text;
  planner_value text;
  title_value text;
  lp_need_value text;
  lp_id_value text;
  task_id_value text;
  revision_id_value text;
  file_id_value text;
  rule text;
  due_instant timestamptz;
  content_due timestamptz;
  task_due timestamptz;
  created_at timestamptz;
  due_text text;
  due_at_text text;
  task_status text;
  first_workflow boolean;
  audit_id_value uuid;
  payload_hash text;
  expected_intent jsonb;
  assignment_may_reassign boolean;
  allowed_staff constant text[] := array['Abby','Ella','Molly','Thea','Tiffany','Tara','Eileen','思佳'];
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if command_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_operation not in ('create', 'revise')
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or jsonb_typeof(p_fields) is distinct from 'object'
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or jsonb_typeof(p_authorized_assignment) is distinct from 'object'
     or nullif(trim(p_actor), '') is null
     or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_lp_atomic_request';
  end if;
  if (select array_agg(key order by key) from jsonb_object_keys(p_authorized_assignment) key)
       is distinct from array['mayReassign','owner','planner']::text[]
     or jsonb_typeof(p_authorized_assignment -> 'owner') is distinct from 'string'
     or jsonb_typeof(p_authorized_assignment -> 'planner') is distinct from 'string'
     or jsonb_typeof(p_authorized_assignment -> 'mayReassign') is distinct from 'boolean'
     or nullif(trim(p_authorized_assignment ->> 'owner'), '') is null
     or length(trim(p_authorized_assignment ->> 'owner')) > 120
     or length(trim(p_authorized_assignment ->> 'planner')) > 120 then
    raise exception using errcode = '22023', message = 'invalid_lp_authorized_assignment';
  end if;
  assignment_may_reassign := (p_authorized_assignment ->> 'mayReassign')::boolean;
  if provisional then
    if p_operation <> 'create' or p_workflow_type <> '试听 LP' or nullif(trim(p_student_id), '') is not null
       or jsonb_typeof(p_provisional_intake) is distinct from 'object'
       or (select array_agg(key order by key) from jsonb_object_keys(p_provisional_intake) key)
          is distinct from array['course','guardianWechat','owner','planner']::text[]
       or exists (select 1 from jsonb_each(p_provisional_intake) x where jsonb_typeof(x.value) is distinct from 'string')
       or nullif(trim(p_provisional_intake ->> 'course'), '') is null
       or nullif(trim(p_provisional_intake ->> 'guardianWechat'), '') is null
       or length(trim(p_provisional_intake ->> 'course')) > 240
       or length(trim(p_provisional_intake ->> 'guardianWechat')) > 240
       or trim(p_provisional_intake ->> 'owner') <> all(allowed_staff)
       or trim(p_provisional_intake ->> 'planner') <> all(allowed_staff)
       or trim(p_authorized_assignment ->> 'owner') <> trim(p_provisional_intake ->> 'owner')
       or trim(p_authorized_assignment ->> 'planner') <> trim(p_provisional_intake ->> 'planner')
       or not assignment_may_reassign then
      raise exception using errcode = '22023', message = 'invalid_lp_provisional_intake';
    end if;
  elsif trim(coalesce(p_student_id, '')) !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
        or trim(p_student_id) ~* 'temp' then
    raise exception using errcode = '22023', message = 'invalid_lp_student_id';
  end if;
  if p_operation = 'create' and p_workflow_type not in ('试听 LP','老师新 LP','老师 LP 修改','换老师试听','代课 LP','学生直报（无试听）','学生报名交接') then
    raise exception using errcode = '22023', message = 'invalid_lp_workflow_type';
  end if;
  if p_operation = 'create' then
    if exists (select 1 from jsonb_object_keys(p_fields) key where key not in ('responsibleOperations','specifiedContentStatus','specialNotes','preparationFollowUp','isUniversityStudent','universityMajor','universityYear','assignedTeacher','subject','oneSentenceDescription','locationTimezone','contactPerson','timeMentioned','preferredTime','studentNameKnown','trialPaymentMethod','teacher','documentUrl','additionalNotes','basicInfo','studentFoundation','learningGoal','recommendedResources','teachingLanguage','firstLessonContent','lessonSchedule','comments','modificationRequirements','originalTeacher','newTeacher','changeReason','trialInformation','handoverFromTeacher','materialsAndContentTaught','recommendedNextContent','studentStrengthsAndLearningProfile','lastHomework','lastLessonRecordingUrl','substituteTeacher','coverageStartDate','coverageEndDate','allocatedLessonContentAndResources','handoverNotes','planner','coursePackage','purchasedHours','bonusHours','lessonFrequency','coursesAndTeachers','enrollmentHandoverNotes')) then
      raise exception using errcode = '22023', message = 'invalid_lp_field_key';
    end if;
    if exists (select 1 from jsonb_each(p_fields) x where (x.key in ('isUniversityStudent','timeMentioned','studentNameKnown') and jsonb_typeof(x.value) is distinct from 'boolean') or (x.key in ('purchasedHours','bonusHours') and jsonb_typeof(x.value) is distinct from 'number') or (x.key not in ('isUniversityStudent','timeMentioned','studentNameKnown','purchasedHours','bonusHours') and jsonb_typeof(x.value) is distinct from 'string')) then
      raise exception using errcode = '22023', message = 'invalid_lp_field_type';
    end if;
    if exists (select 1 from jsonb_each_text(p_fields) x where x.key in ('documentUrl','lastLessonRecordingUrl') and x.value !~ '^https?://[^[:space:]]+$') then
      raise exception using errcode = '22023', message = 'invalid_lp_document_url';
    end if;
    if nullif(trim(p_fields ->> 'responsibleOperations'),'') is null
       or p_fields ->> 'specifiedContentStatus' not in ('已指定','无需指定','需要跟进')
       or p_fields ->> 'preparationFollowUp' not in ('是','否')
       or jsonb_typeof(p_fields -> 'isUniversityStudent') is distinct from 'boolean'
       or ((p_fields ->> 'isUniversityStudent')::boolean and (nullif(trim(p_fields ->> 'universityMajor'),'') is null or nullif(trim(p_fields ->> 'universityYear'),'') is null)) then
      raise exception using errcode = '22023', message = 'invalid_lp_common_fields';
    end if;
    if p_workflow_type = '试听 LP' and (nullif(trim(p_fields ->> 'assignedTeacher'),'') is null or nullif(trim(p_fields ->> 'subject'),'') is null or nullif(trim(p_fields ->> 'oneSentenceDescription'),'') is null or nullif(trim(p_fields ->> 'locationTimezone'),'') is null or p_fields ->> 'contactPerson' not in ('家长','学生本人') or jsonb_typeof(p_fields -> 'timeMentioned') is distinct from 'boolean' or ((p_fields ->> 'timeMentioned')::boolean and nullif(trim(p_fields ->> 'preferredTime'),'') is null) or jsonb_typeof(p_fields -> 'studentNameKnown') is distinct from 'boolean' or p_fields ->> 'trialPaymentMethod' not in ('后置付费试听','付费试听（已付费）','付费试听（未付费）','免费试听','在读学生付费试听')) then
      raise exception using errcode = '22023', message = 'invalid_trial_lp_fields';
    end if;
    if p_workflow_type = '换老师试听' and (nullif(trim(p_fields ->> 'originalTeacher'),'') is null or nullif(trim(p_fields ->> 'newTeacher'),'') is null or nullif(trim(p_fields ->> 'subject'),'') is null or nullif(trim(p_fields ->> 'changeReason'),'') is null or nullif(trim(p_fields ->> 'trialInformation'),'') is null) then
      raise exception using errcode = '22023', message = 'invalid_teacher_change_lp_fields';
    end if;
    if p_workflow_type in ('老师新 LP','老师 LP 修改') and (nullif(trim(p_fields ->> 'teacher'),'') is null or nullif(trim(p_fields ->> 'subject'),'') is null) then
      raise exception using errcode = '22023', message = 'invalid_teacher_lp_fields';
    end if;
    if p_workflow_type = '代课 LP' and (nullif(trim(p_fields ->> 'originalTeacher'),'') is null or nullif(trim(p_fields ->> 'substituteTeacher'),'') is null or nullif(trim(p_fields ->> 'subject'),'') is null or nullif(trim(p_fields ->> 'coverageStartDate'),'') is null or nullif(trim(p_fields ->> 'coverageEndDate'),'') is null or (p_fields ->> 'coverageStartDate') !~ '^\d{4}-\d{2}-\d{2}$' or (p_fields ->> 'coverageEndDate') !~ '^\d{4}-\d{2}-\d{2}$' or (p_fields ->> 'coverageEndDate') < (p_fields ->> 'coverageStartDate') or (p_fields ? 'handoverNotes' = false and nullif(trim(p_fields ->> 'additionalNotes'),'') is null)) then
      raise exception using errcode = '22023', message = 'invalid_substitute_lp_fields';
    end if;
    if p_workflow_type = '学生直报（无试听）' and (nullif(trim(p_fields ->> 'subject'),'') is null or nullif(trim(p_fields ->> 'oneSentenceDescription'),'') is null or nullif(trim(p_fields ->> 'locationTimezone'),'') is null or p_fields ->> 'contactPerson' not in ('家长','学生本人') or jsonb_typeof(p_fields -> 'timeMentioned') is distinct from 'boolean' or ((p_fields ->> 'timeMentioned')::boolean and nullif(trim(p_fields ->> 'preferredTime'),'') is null) or nullif(trim(p_fields ->> 'lessonFrequency'),'') is null or nullif(trim(p_fields ->> 'coursesAndTeachers'),'') is null or jsonb_typeof(p_fields -> 'purchasedHours') is distinct from 'number' or jsonb_typeof(p_fields -> 'bonusHours') is distinct from 'number' or coalesce((p_fields ->> 'purchasedHours')::numeric,0) + coalesce((p_fields ->> 'bonusHours')::numeric,0) <= 0) then
      raise exception using errcode = '22023', message = 'invalid_direct_lp_fields';
    end if;
    if p_workflow_type = '学生报名交接' and (nullif(trim(p_fields ->> 'planner'),'') is null or nullif(trim(p_fields ->> 'coursePackage'),'') is null or nullif(trim(p_fields ->> 'subject'),'') is null) then
      raise exception using errcode = '22023', message = 'invalid_enrollment_handover_fields';
    end if;
  end if;
  if p_operation = 'revise' and (nullif(trim(p_lp_item_id), '') is null or (select count(*) from jsonb_object_keys(p_fields)) <> 1 or p_fields ? 'documentUrl' = false) then
    raise exception using errcode = '22023', message = 'invalid_lp_revision_fields';
  end if;
  if p_operation = 'revise' and (p_fields ->> 'documentUrl') !~ '^https?://[^[:space:]]+$' then
    raise exception using errcode = '22023', message = 'invalid_lp_document_url';
  end if;
  if (select array_agg(key order by key) from jsonb_object_keys(p_expected_versions) key)
       is distinct from array['files','lpItems','students','tasks']::text[]
     or exists (select 1 from jsonb_each(p_expected_versions) x
       where jsonb_typeof(x.value) is distinct from 'number' or x.value #>> '{}' !~ '^[1-9][0-9]*$') then
    raise exception using errcode = '22023', message = 'invalid_lp_versions';
  end if;
  expected_intent := jsonb_build_object('operation', p_operation)
    || case when provisional
      then jsonb_build_object('provisionalIntake', p_provisional_intake)
      else jsonb_build_object('studentId', trim(p_student_id))
    end;
  if p_operation = 'create' then
    expected_intent := expected_intent || jsonb_build_object('workflowType', p_workflow_type, 'fields', p_fields);
  else
    expected_intent := expected_intent || jsonb_build_object('lpItemId', trim(p_lp_item_id), 'fields', p_fields);
    if p_revision_note is not null and trim(p_revision_note) <> '' then expected_intent := expected_intent || jsonb_build_object('revisionNote', trim(p_revision_note)); end if;
  end if;
  expected_intent := expected_intent || jsonb_build_object('expectedVersions', p_expected_versions);
  if p_command_intent is distinct from expected_intent then
    raise exception using errcode = '22023', message = 'lp_intent_mismatch';
  end if;

  -- First replay gate makes a timeout safe even when a projection row is unavailable.
  select * into prior from internal.lp_atomic_commands where command_uuid = command_key;
  if prior.command_uuid is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor <> trim(p_actor) then
      raise exception using errcode = '23505', message = 'lp_idempotency_conflict';
    end if;
    select * into f from public.ops_state where entity = 'files' for update;
    select * into s from public.ops_state where entity = 'students' for update;
    select * into l from public.ops_state where entity = 'lpItems' for update;
    select * into t from public.ops_state where entity = 'tasks' for update;
    return query select prior.command_uuid, prior.operation, false, prior.student_id, prior.lp_item_id,
      case when s.entity is null then null::public.ops_state else s end,
      case when l.entity is null then null::public.ops_state else l end,
      case when t.entity is null then null::public.ops_state else t end,
      case when f.entity is null then null::public.ops_state else f end,
      prior.audit_id;
    return;
  end if;

  -- Global fixed lock order shared with FU attachments: files, students, LPs,
  -- then tasks. Do not reorder any replay/writer branch independently.
  select * into f from public.ops_state where entity = 'files' for update;
  select * into s from public.ops_state where entity = 'students' for update;
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  select * into prior from internal.lp_atomic_commands where command_uuid = command_key;
  if prior.command_uuid is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor <> trim(p_actor) then
      raise exception using errcode = '23505', message = 'lp_idempotency_conflict';
    end if;
    return query select prior.command_uuid, prior.operation, false, prior.student_id, prior.lp_item_id, s, l, t, f, prior.audit_id;
    return;
  end if;
  if s.entity is null or l.entity is null or t.entity is null or f.entity is null then
    raise exception using errcode = '55000', message = 'lp_atomic_state_missing';
  end if;
  if s.version <> (p_expected_versions ->> 'students')::bigint
     or l.version <> (p_expected_versions ->> 'lpItems')::bigint
     or t.version <> (p_expected_versions ->> 'tasks')::bigint
     or f.version <> (p_expected_versions ->> 'files')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if jsonb_typeof(s.payload) is distinct from 'array' or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array' or jsonb_typeof(f.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'lp_atomic_payload_invalid';
  end if;
  created_at := clock_timestamp();
  next_s := s.payload;
  next_l := l.payload;
  next_t := t.payload;
  next_f := f.payload;
  if provisional then
    student_id_value := 'STU-PROVISIONAL-' || left(encode(extensions.digest(command_key || chr(31) || 'student', 'sha256'), 'hex'), 24);
    if exists (select 1 from jsonb_array_elements(s.payload) x where x ->> 'id' = student_id_value) then
      raise exception using errcode = '23505', message = 'lp_provisional_student_conflict';
    end if;
    student := jsonb_build_object(
      'id', student_id_value,
      'name', trim(p_provisional_intake ->> 'guardianWechat'),
      'initials', '待',
      'status', '活跃 + 无课时',
      'segment', '试听',
      'owner', trim(p_authorized_assignment ->> 'owner'),
      'planner', trim(p_authorized_assignment ->> 'planner'),
      'course', trim(p_provisional_intake ->> 'course'),
      'grade', '待确认',
      'gradeBaseYear', extract(year from created_at at time zone 'Australia/Melbourne')::int,
      'location', 'VIC',
      'timezone', 'Australia/Melbourne',
      'guardianWechat', trim(p_provisional_intake ->> 'guardianWechat'),
      'teacher', '待匹配',
      'next', '补充学生姓名并完成 LP',
      'nextTone', 'amber',
      'files', 0,
      'lpNeed', '试听LP',
      'followUp', '未记录',
      'notes', '家长微信名临时 LP 档案，学生姓名待补'
    );
    next_s := next_s || jsonb_build_array(student);
  else
    student_id_value := trim(p_student_id);
    select value into student from jsonb_array_elements(s.payload) where value ->> 'id' = student_id_value limit 1;
    if student is null then raise exception using errcode = 'P0002', message = 'student_not_found'; end if;
    if student ->> 'importArchived' = 'true' then raise exception using errcode = '42501', message = 'student_archived'; end if;
  end if;

  owner_value := trim(p_authorized_assignment ->> 'owner');
  planner_value := trim(p_authorized_assignment ->> 'planner');
  if not provisional then
    if not assignment_may_reassign
       and (owner_value <> coalesce(student ->> 'owner', '') or planner_value <> coalesce(student ->> 'planner', '')) then
      raise exception using errcode = '42501', message = 'lp_assignment_forbidden';
    end if;
    if owner_value <> coalesce(student ->> 'owner', '') and owner_value <> all(allowed_staff) then
      raise exception using errcode = '42501', message = 'lp_owner_not_allowed';
    end if;
    if planner_value <> coalesce(student ->> 'planner', '') and planner_value <> all(allowed_staff) then
      raise exception using errcode = '42501', message = 'lp_planner_not_allowed';
    end if;
  end if;
  if p_operation = 'create' and p_workflow_type = '学生报名交接' and planner_value <> all(allowed_staff) then
    raise exception using errcode = '22023', message = 'lp_handover_planner_not_allowed';
  end if;
  if p_operation = 'create' then
    fields := p_fields || jsonb_build_object('responsibleOperations', owner_value);
    if p_workflow_type = '学生报名交接' then
      fields := fields || jsonb_build_object('planner', planner_value);
    end if;
    lp_id_value := 'LP-ATOMIC-' || left(encode(extensions.digest(command_key || chr(31) || 'lp', 'sha256'), 'hex'), 24);
    revision_id_value := 'LPR-ATOMIC-' || left(encode(extensions.digest(command_key || chr(31) || 'revision', 'sha256'), 'hex'), 24);
    title_value := case p_workflow_type when '试听 LP' then '试听 LP' when '老师新 LP' then '老师新 LP' when '老师 LP 修改' then '老师 LP 修改' when '换老师试听' then '换老师试听' when '代课 LP' then '代课 LP' when '学生直报（无试听）' then '学生直报（无试听）' else '学生报名交接' end;
    lp_need_value := case p_workflow_type when '试听 LP' then '试听LP' when '换老师试听' then '试听LP' when '老师新 LP' then '老生新LP' when '老师 LP 修改' then 'LP修改' when '代课 LP' then '代课LP' else '新生LP' end;
    due_instant := created_at + interval '24 hours';
    lp_item := jsonb_build_object(
      'id', lp_id_value, 'studentId', student_id_value, 'title', title_value || ' · ' || coalesce(student ->> 'name', student_id_value),
      'workflowType', p_workflow_type, 'stage', '待资料', 'owner', owner_value,
      'due', to_char(due_instant at time zone 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI'),
      'needsParentFollowUp', coalesce(fields ->> 'specifiedContentStatus', '') = '需要跟进',
      'needsTeacherPrep', coalesce(fields ->> 'preparationFollowUp', '') = '是',
      'fields', fields, 'revisionNumber', 1,
      'revisions', jsonb_build_array(jsonb_build_object('id', revision_id_value, 'workflowId', lp_id_value, 'number', 1, 'changedAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'changedBy', trim(p_actor), 'note', '创建 LP', 'before', '{}'::jsonb, 'after', fields)),
      'stageAudit', '[]'::jsonb, 'resultAudit', '[]'::jsonb
    );
    if p_workflow_type in ('试听 LP', '换老师试听') then
      lp_item := lp_item || jsonb_build_object('requestedAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    end if;
    if p_workflow_type = '老师 LP 修改' then
      lp_item := lp_item || jsonb_build_object('publishedDate', (created_at at time zone 'Australia/Melbourne')::date::text);
    end if;
    first_workflow := not exists (select 1 from jsonb_array_elements(l.payload) x where x ->> 'studentId' = student_id_value);
    -- Close only the lifecycle tasks the UI closes after a successful LP create.
    next_t := (select coalesce(jsonb_agg(case when x.value ->> 'studentId' = student_id_value and x.value ->> 'status' <> 'done' and (x.value ->> 'ruleKey' = 'student.create-lp' or (first_workflow and p_workflow_type in ('试听 LP','学生直报（无试听）','学生报名交接') and x.value ->> 'ruleKey' = 'student.initial-handover')) then x.value || jsonb_build_object('status','done','tone','green','result','LP 工作流已创建，任务自动关闭','closedAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) else x.value end order by x.ordinality), '[]'::jsonb) from jsonb_array_elements(t.payload) with ordinality x(value, ordinality));
    next_l := next_l || jsonb_build_array(lp_item);
    -- All task deadlines are canonical UTC dueAt values; the Chinese due text is display-only.
    rule := 'handover';
    for rule in select rules.rule_value from unnest(array['handover','specified-content','preparation-follow-up']) as rules(rule_value) where not (rules.rule_value = 'specified-content' and coalesce(fields ->> 'specifiedContentStatus','') <> '需要跟进') and not (rules.rule_value = 'preparation-follow-up' and coalesce(fields ->> 'preparationFollowUp','') <> '是') and not (p_workflow_type in ('试听 LP','换老师试听') and rules.rule_value in ('specified-content','preparation-follow-up')) loop
      if rule = 'specified-content' then
        content_due := (((created_at at time zone 'Australia/Melbourne')::date + time '18:00') at time zone 'Australia/Melbourne');
        task_due := greatest(content_due, created_at);
      else task_due := due_instant; end if;
      task_id_value := 'TSK-LP-' || left(encode(extensions.digest(lp_id_value || chr(31) || 'lp.' || rule, 'sha256'), 'hex'), 24);
      due_text := to_char(task_due at time zone 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI');
      due_at_text := to_char(task_due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      task_status := case when (task_due at time zone 'Australia/Melbourne')::date < (created_at at time zone 'Australia/Melbourne')::date then 'overdue' when (task_due at time zone 'Australia/Melbourne')::date = (created_at at time zone 'Australia/Melbourne')::date then 'today' else 'upcoming' end;
      generated := jsonb_build_object(
        'id', task_id_value,
        'title', case rule when 'handover' then title_value || '：核对交接信息' when 'specified-content' then '跟进指定内容' else '跟进老师备课' end,
        'owner', owner_value,
        'assignees', case
          when rule = 'handover' and p_workflow_type = '学生报名交接' and planner_value <> owner_value
            then jsonb_build_array(owner_value, planner_value)
          else jsonb_build_array(owner_value)
        end,
        'watchers', jsonb_build_array('Ops Admin'),
        'studentId', student_id_value,
        'due', due_text,
        'dueAt', due_at_text,
        'status', task_status,
        'tone', case rule when 'specified-content' then 'red' when 'preparation-follow-up' then 'amber' else 'blue' end,
        'category', 'LP',
        'trigger', title_value || ' 创建后自动生成',
        'ruleKey', 'lp.' || rule,
        'anchorBookingId', lp_id_value
      );
      next_t := next_t || jsonb_build_array(generated);
    end loop;
    -- Trial LPs also receive the request/escalation reminders at deterministic times.
    if p_workflow_type in ('试听 LP','换老师试听') then
      for rule in select rules.rule_value from unnest(array['trial.parent-follow-up','trial.scheduling','trial.parent-no-reply-follow-up','trial.teaching-control-escalation','trial.parent-progress-sync.1']) as rules(rule_value) loop
        task_due := case rule when 'trial.parent-follow-up' then greatest((((created_at at time zone 'Australia/Melbourne')::date + time '18:00') at time zone 'Australia/Melbourne'), created_at) when 'trial.scheduling' then created_at + interval '24 hours' when 'trial.parent-no-reply-follow-up' then created_at + interval '4 hours' when 'trial.teaching-control-escalation' then created_at + interval '8 hours' else created_at + interval '24 hours' end;
        task_id_value := 'TSK-LP-' || left(encode(extensions.digest(lp_id_value || chr(31) || rule, 'sha256'), 'hex'), 24);
        due_text := to_char(task_due at time zone 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI');
        due_at_text := to_char(task_due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
        task_status := case when (task_due at time zone 'Australia/Melbourne')::date = (created_at at time zone 'Australia/Melbourne')::date then 'today' else 'upcoming' end;
        generated := jsonb_build_object('id',task_id_value,'title',case rule when 'trial.parent-follow-up' then '发送家长试听跟进请求' when 'trial.scheduling' then '完成试听排课' when 'trial.parent-no-reply-follow-up' then '家长未回复：再次跟进' when 'trial.teaching-control-escalation' then '家长未回复：向负责人汇报' else '向家长同步试听安排进度（第 1 次）' end,'owner',owner_value,'assignees',jsonb_build_array(owner_value),'watchers',jsonb_build_array('Ops Admin'),'studentId',student_id_value,'due',due_text,'dueAt',due_at_text,'status',task_status,'tone',case when rule in ('trial.scheduling','trial.teaching-control-escalation','trial.parent-progress-sync.1') then 'red' else 'blue' end,'category',case when rule = 'trial.scheduling' then '排课' else '试听' end,'trigger','试听 LP 创建后自动生成','ruleKey',rule,'anchorBookingId',lp_id_value);
        next_t := next_t || jsonb_build_array(generated);
      end loop;
    end if;
    next_s := (select coalesce(jsonb_agg(case when x.value ->> 'id' = student_id_value then x.value || jsonb_build_object('owner',owner_value,'planner',planner_value,'lpNeed',lp_need_value,'next',title_value || ' 已创建','nextTone','amber') else x.value end order by x.ordinality), '[]'::jsonb) from jsonb_array_elements(next_s) with ordinality x(value, ordinality));
  else
    select value into item from jsonb_array_elements(l.payload) where value ->> 'id' = trim(p_lp_item_id) and value ->> 'studentId' = student_id_value limit 1;
    if item is null then raise exception using errcode = 'P0002', message = 'lp_not_found'; end if;
    fields := coalesce(item -> 'fields', '{}'::jsonb) || p_fields;
    revision_id_value := 'LPR-ATOMIC-' || left(encode(extensions.digest(command_key || chr(31) || 'revision', 'sha256'), 'hex'), 24);
    revision := jsonb_build_object('id',revision_id_value,'workflowId',trim(p_lp_item_id),'number',coalesce((item ->> 'revisionNumber')::int,1) + 1,'changedAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'changedBy',trim(p_actor),'before',coalesce(item->'fields','{}'::jsonb),'after',fields) || case when nullif(trim(p_revision_note),'') is null then '{}'::jsonb else jsonb_build_object('note',trim(p_revision_note)) end;
    lp_item := item || jsonb_build_object('fields',fields,'revisionNumber',coalesce((item ->> 'revisionNumber')::int,1)+1,'revisions',coalesce(item->'revisions','[]'::jsonb) || jsonb_build_array(revision));
    file_id_value := 'FIL-ATOMIC-' || left(encode(extensions.digest(command_key || chr(31) || 'file', 'sha256'), 'hex'), 24);
    file_item := jsonb_build_object('id',file_id_value,'studentId',student_id_value,'title',coalesce(item->>'title','Learning Plan') || ' · 版本 ' || (coalesce((item ->> 'revisionNumber')::int,1)+1)::text,'type','Learning Plan','source',p_fields->>'documentUrl','addedAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    next_l := (select coalesce(jsonb_agg(case when x.value ->> 'id' = trim(p_lp_item_id) then lp_item else x.value end order by x.ordinality), '[]'::jsonb) from jsonb_array_elements(l.payload) with ordinality x(value, ordinality));
    next_f := next_f || jsonb_build_array(file_item);
    next_s := (select coalesce(jsonb_agg(case when x.value ->> 'id' = student_id_value then x.value || jsonb_build_object('files',coalesce((x.value->>'files')::int,0)+1) else x.value end order by x.ordinality), '[]'::jsonb) from jsonb_array_elements(s.payload) with ordinality x(value, ordinality));
  end if;

  if next_s is distinct from s.payload then update public.ops_state set payload=next_s, version=s.version+1, updated_at=now(), updated_by=trim(p_actor) where entity='students' returning * into saved_s; insert into public.ops_mutation_log(entity,version,actor) values('students',saved_s.version,saved_s.updated_by); else saved_s := s; end if;
  if next_l is distinct from l.payload then update public.ops_state set payload=next_l, version=l.version+1, updated_at=now(), updated_by=trim(p_actor) where entity='lpItems' returning * into saved_l; insert into public.ops_mutation_log(entity,version,actor) values('lpItems',saved_l.version,saved_l.updated_by); else saved_l := l; end if;
  if next_t is distinct from t.payload then update public.ops_state set payload=next_t, version=t.version+1, updated_at=now(), updated_by=trim(p_actor) where entity='tasks' returning * into saved_t; insert into public.ops_mutation_log(entity,version,actor) values('tasks',saved_t.version,saved_t.updated_by); else saved_t := t; end if;
  if next_f is distinct from f.payload then update public.ops_state set payload=next_f, version=f.version+1, updated_at=now(), updated_by=trim(p_actor) where entity='files' returning * into saved_f; insert into public.ops_mutation_log(entity,version,actor) values('files',saved_f.version,saved_f.updated_by); else saved_f := f; end if;
  lp_id_value := coalesce(nullif(trim(p_lp_item_id),''), lp_id_value);
  payload_hash := encode(extensions.digest(jsonb_build_object('commandIntent',p_command_intent,'students',next_s,'lpItems',next_l,'tasks',next_t,'files',next_f)::text,'sha256'),'hex');
  audit_id_value := internal.append_operational_contract_audit('lp.atomic.' || p_operation,trim(p_actor),'student',student_id_value,jsonb_build_object('commandUuid',command_key,'lpItemId',lp_id_value,'payloadSha256',payload_hash,'versionsBefore',p_expected_versions));
  insert into internal.lp_atomic_commands(command_uuid,command_intent,command_hash,operation,student_id,lp_item_id,audit_id,actor) values(command_key,p_command_intent,payload_hash,p_operation,student_id_value,lp_id_value,audit_id_value,trim(p_actor));
  return query select command_key,p_operation,true,student_id_value,lp_id_value,saved_s,saved_l,saved_t,saved_f,audit_id_value;
end;
$function$;
revoke all on function public.mutate_lp_atomic(text,text,jsonb,text,text,jsonb,text,text,jsonb,text,jsonb,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.mutate_lp_atomic(text,text,jsonb,text,text,jsonb,text,text,jsonb,text,jsonb,jsonb,text)
  to anon, authenticated;
