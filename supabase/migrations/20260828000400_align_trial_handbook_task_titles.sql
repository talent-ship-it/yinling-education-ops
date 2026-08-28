-- Keep every open manual-trial task aligned with the wording confirmed in the
-- Tencent handbook.  The guardian WeChat name is read from the authoritative
-- student row so the LP form does not maintain a second, diverging copy.

create or replace function internal.trial_handbook_manual_task_title(
  p_rule_key text,
  p_student_name text,
  p_guardian_wechat text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_rule_key
    when 'trial.manual-request.specified-content' then '《教务+教统》【要指定内容】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.writing' then '《教务+教统》【要写作】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.paper-send' then '《教务+教统》【发试卷】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.paper-receive' then '《教务+教统》【收试卷】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.parent-progress-24h' then '《教务+教统》【向家长交待排课进度】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.scheduling-alert-36h' then '《教务+教统》【试听排课进度反常】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    when 'trial.manual-request.parent-progress-48h' then '《教务+教统》【二次向家长交待排课进度】<' || p_student_name || '> <' || p_guardian_wechat || '>'
    else null
  end
$$;
revoke all on function internal.trial_handbook_manual_task_title(text, text, text)
  from public, anon, authenticated, service_role;

alter function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  rename to mutate_lp_atomic_before_trial_handbook_titles;
revoke all on function public.mutate_lp_atomic_before_trial_handbook_titles(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;

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
language plpgsql
security definer
set search_path = ''
as $$
declare
  delegated record;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  saved_l public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  student jsonb;
  lp_item jsonb;
  next_l jsonb;
  next_t jsonb;
  student_name text;
  guardian_wechat text;
begin
  select * into delegated
  from public.mutate_lp_atomic_before_trial_handbook_titles(
    p_secret, p_command_uuid, p_command_intent, p_operation, p_student_id,
    p_provisional_intake, p_lp_item_id, p_workflow_type, p_fields,
    p_revision_note, p_authorized_assignment, p_expected_versions, p_actor
  );
  if delegated.command_key is null then
    raise exception using errcode = '55000', message = 'lp_atomic_result_missing';
  end if;

  if p_operation <> 'create' or p_workflow_type <> '试听 LP' then
    return query select delegated.command_key, delegated.operation, delegated.applied,
      delegated.student_id, delegated.lp_item_id, delegated.students_row,
      delegated.lp_items_row, delegated.tasks_row, delegated.files_row,
      delegated.audit_entry_id;
    return;
  end if;

  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  if l.entity is null or t.entity is null
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_handbook_state_missing';
  end if;
  select value into lp_item
  from jsonb_array_elements(l.payload)
  where value ->> 'id' = delegated.lp_item_id
  limit 1;
  select value into student
  from jsonb_array_elements((delegated.students_row).payload)
  where value ->> 'id' = delegated.student_id
  limit 1;
  if lp_item is null or student is null then
    raise exception using errcode = '55000', message = 'trial_handbook_record_missing';
  end if;

  student_name := coalesce(
    nullif(trim(lp_item -> 'trialIntake' ->> 'studentName'), ''),
    nullif(trim(student ->> 'name'), ''),
    '试听学员（姓名未提到）'
  );
  guardian_wechat := coalesce(
    nullif(trim(student ->> 'guardianWechat'), ''),
    nullif(trim(student ->> 'guardian'), ''),
    '家长微信名未填写'
  );
  next_l := l.payload;
  next_t := (
    select coalesce(jsonb_agg(
      case
        when task.value ->> 'anchorBookingId' = delegated.lp_item_id
          and coalesce(task.value ->> 'status', '') <> 'done'
          and not (task.value ? 'legacyEvidence')
          and not exists (
            select 1 from internal.legacy_task_deadline_freezes evidence
            where evidence.task_id = task.value ->> 'id'
          )
          and task.value ->> 'ruleKey' in (
            'trial.manual-request.specified-content',
            'trial.manual-request.writing',
            'trial.manual-request.paper-send',
            'trial.manual-request.paper-receive',
            'trial.manual-request.parent-progress-24h',
            'trial.manual-request.scheduling-alert-36h',
            'trial.manual-request.parent-progress-48h'
          )
        then task.value || jsonb_build_object(
          'title', internal.trial_handbook_manual_task_title(
            task.value ->> 'ruleKey', student_name, guardian_wechat
          )
        )
        else task.value
      end order by task.ordinality
    ), '[]'::jsonb)
    from jsonb_array_elements(t.payload) with ordinality task(value, ordinality)
  );

  saved_l := l;
  if next_t is distinct from t.payload then
    update public.ops_state
    set payload = next_t, version = t.version + 1, updated_at = now(), updated_by = trim(p_actor)
    where entity = 'tasks'
    returning * into saved_t;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved_t.version, saved_t.updated_by);
  else
    saved_t := t;
  end if;

  return query select delegated.command_key, delegated.operation, delegated.applied,
    delegated.student_id, delegated.lp_item_id, delegated.students_row,
    saved_l, saved_t, delegated.files_row, delegated.audit_entry_id;
end;
$$;
revoke all on function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  to anon, authenticated;

-- Existing open tasks are operational state, not frozen completed evidence.
-- Normalize them once so the current To Do list also adopts the confirmed words.
with context as (
  select tasks.payload as tasks, lp_items.payload as lp_items, students.payload as students
  from public.ops_state tasks
  cross join public.ops_state lp_items
  cross join public.ops_state students
  where tasks.entity = 'tasks' and lp_items.entity = 'lpItems' and students.entity = 'students'
), projected as (
  select coalesce(jsonb_agg(
    case
      when task.value ->> 'ruleKey' in (
        'trial.manual-request.specified-content',
        'trial.manual-request.writing',
        'trial.manual-request.paper-send',
        'trial.manual-request.paper-receive',
        'trial.manual-request.parent-progress-24h',
        'trial.manual-request.scheduling-alert-36h',
        'trial.manual-request.parent-progress-48h'
      )
        and coalesce(task.value ->> 'status', '') <> 'done'
        and not (task.value ? 'legacyEvidence')
        and not exists (
          select 1 from internal.legacy_task_deadline_freezes evidence
          where evidence.task_id = task.value ->> 'id'
        )
      then task.value || jsonb_build_object(
        'title', internal.trial_handbook_manual_task_title(
          task.value ->> 'ruleKey',
          coalesce(
            nullif(trim(lp_item.value -> 'trialIntake' ->> 'studentName'), ''),
            nullif(trim(student.value ->> 'name'), ''),
            '试听学员（姓名未提到）'
          ),
          coalesce(
            nullif(trim(student.value ->> 'guardianWechat'), ''),
            nullif(trim(student.value ->> 'guardian'), ''),
            '家长微信名未填写'
          )
        )
      )
      else task.value
    end order by task.ordinality
  ), '[]'::jsonb) as payload
  from context
  cross join lateral jsonb_array_elements(context.tasks) with ordinality task(value, ordinality)
  left join lateral (
    select value
    from jsonb_array_elements(context.lp_items)
    where value ->> 'id' = task.value ->> 'anchorBookingId'
    limit 1
  ) lp_item on true
  left join lateral (
    select value
    from jsonb_array_elements(context.students)
    where value ->> 'id' = task.value ->> 'studentId'
    limit 1
  ) student on true
), saved as (
  update public.ops_state tasks
  set payload = projected.payload,
      version = tasks.version + 1,
      updated_at = now(),
      updated_by = 'migration:trial-handbook-task-titles'
  from projected
  where tasks.entity = 'tasks'
    and projected.payload is distinct from tasks.payload
  returning tasks.entity, tasks.version, tasks.updated_by
)
insert into public.ops_mutation_log(entity, version, actor)
select entity, version, updated_by from saved;
