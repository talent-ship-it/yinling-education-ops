-- Adds the calendar-month planning reminder without rewriting an already
-- deployed migration.  The legacy projections are retained under private
-- names so this forward migration changes only the active contracts.

alter function internal.exam_submission_incoming_tasks(jsonb, jsonb, timestamptz)
  rename to exam_submission_incoming_tasks_legacy_20260815;
alter function internal.exam_submission_reconcile_tasks(jsonb, jsonb, text, text)
  rename to exam_submission_reconcile_tasks_legacy_20260815;
alter function internal.exam_follow_up_identity(jsonb, jsonb, text)
  rename to exam_follow_up_identity_legacy_20260815;

create or replace function internal.exam_submission_incoming_tasks(
  p_students jsonb,
  p_intent jsonb,
  p_prepared_at timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  result jsonb;
  student jsonb;
  exam jsonb := p_intent -> 'exam';
  previous_exam jsonb;
  follow_up jsonb := '{}'::jsonb;
  step_state jsonb;
  exam_date date;
  target_month_start date;
  target_month_last_day date;
  planning_date date;
  due_instant timestamptz;
  recipient text;
  rule_key text;
  task jsonb;
  completed boolean;
begin
  result := internal.exam_submission_incoming_tasks_legacy_20260815(
    p_students, p_intent, p_prepared_at
  );
  if not (exam ? 'examDate') then return result; end if;
  select item.value into student
  from jsonb_array_elements(p_students) item(value)
  where item.value ->> 'id' = p_intent ->> 'studentId';
  if student is null then
    raise exception using errcode = '22023', message = 'exam_submission_student_not_found';
  end if;
  select item.value into previous_exam
  from jsonb_array_elements(case when jsonb_typeof(student -> 'exams') = 'array'
    then student -> 'exams' else '[]'::jsonb end) item(value)
  where item.value ->> 'id' = exam ->> 'id';
  if jsonb_typeof(previous_exam -> 'followUpState') = 'object' then
    follow_up := previous_exam -> 'followUpState';
  end if;
  recipient := nullif(trim(student ->> 'planner'), '');
  if recipient is null or recipient ~ '^(待分配|待确认|未知|角色待配置[:：])' then
    return result;
  end if;
  step_state := follow_up -> 'exam_month_planning';
  if step_state ->> 'status' = 'not_required' then return result; end if;
  completed := step_state ->> 'status' = 'completed';
  if completed then
    begin
      if nullif(step_state ->> 'completedAt', '') is null then
        raise exception using errcode = '22023', message = 'invalid_exam_submission_follow_up';
      end if;
      perform (step_state ->> 'completedAt')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_exam_submission_follow_up';
    end;
  end if;
  -- PostgreSQL date - interval month preserves the source day by carrying
  -- overflow into the following month (2026-03-31 -> 2026-03-03). Derive the
  -- target month explicitly and clamp to its final day to match TypeScript.
  exam_date := (exam ->> 'examDate')::date;
  target_month_start := (pg_catalog.date_trunc('month', exam_date) - interval '1 month')::date;
  target_month_last_day := (pg_catalog.date_trunc('month', exam_date) - interval '1 day')::date;
  planning_date := target_month_start + (
    least(extract(day from exam_date)::integer,
      extract(day from target_month_last_day)::integer) - 1
  );
  due_instant := (planning_date + time '18:00') at time zone 'Australia/Melbourne';
  rule_key := 'exam:' || (exam ->> 'id') || ':planning';
  task := jsonb_build_object(
    'id', 'TSK-EXAM-' || pg_catalog.left(encode(extensions.digest(
      pg_catalog.convert_to((p_intent ->> 'studentId') || chr(31) || rule_key, 'UTF8'), 'sha256'
    ), 'hex'), 24),
    'title', (exam ->> 'subject') || '考试前一个月规划',
    'owner', recipient,
    'assignees', jsonb_build_array(recipient),
    'watchers', jsonb_build_array('Ops Admin'),
    'studentId', p_intent ->> 'studentId',
    'due', pg_catalog.to_char(planning_date, 'YYYY-MM-DD') || ' 18:00',
    'dueAt', pg_catalog.to_char(due_instant at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'status', case when completed then 'done'
      when planning_date < (p_prepared_at at time zone 'Australia/Melbourne')::date then 'overdue'
      when planning_date = (p_prepared_at at time zone 'Australia/Melbourne')::date then 'today'
      else 'upcoming' end,
    'tone', case when completed then 'green' else 'purple' end,
    'category', '考试',
    'trigger', (exam ->> 'subject') || ' 考试记录 · 收件：' || recipient,
    'ruleKey', rule_key,
    'anchorBookingId', 'exam:' || (exam ->> 'id')
  );
  if completed then
    task := task || jsonb_build_object(
      'result', '考试跟进已完成', 'closedAt', step_state ->> 'completedAt'
    );
  end if;
  return result || jsonb_build_array(task);
end;
$$;

revoke all on function internal.exam_submission_incoming_tasks(jsonb, jsonb, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function internal.exam_submission_reconcile_tasks(
  p_tasks jsonb,
  p_incoming jsonb,
  p_exam_id text,
  p_closed_at text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  base_tasks jsonb;
  base_incoming jsonb;
  prepared jsonb;
  existing jsonb;
  incoming_planning jsonb;
  planning jsonb;
  planning_count integer;
begin
  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into base_tasks
  from jsonb_array_elements(p_tasks) with ordinality item(value, ordinality)
  where item.value ->> 'anchorBookingId' <> 'exam:' || p_exam_id
     or item.value ->> 'ruleKey' <> 'exam:' || p_exam_id || ':planning';
  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into base_incoming
  from jsonb_array_elements(p_incoming) with ordinality item(value, ordinality)
  where item.value ->> 'anchorBookingId' <> 'exam:' || p_exam_id
     or item.value ->> 'ruleKey' <> 'exam:' || p_exam_id || ':planning';
  select count(*) into planning_count
  from jsonb_array_elements(p_incoming) item(value)
  where item.value ->> 'anchorBookingId' = 'exam:' || p_exam_id
    and item.value ->> 'ruleKey' = 'exam:' || p_exam_id || ':planning';
  if planning_count > 1 then
    raise exception using errcode = '22023', message = 'invalid_exam_submission_tasks';
  end if;
  prepared := internal.exam_submission_reconcile_tasks_legacy_20260815(
    base_tasks, base_incoming, p_exam_id, p_closed_at
  );
  select item.value into existing
  from jsonb_array_elements(p_tasks) with ordinality item(value, ordinality)
  where item.value ->> 'anchorBookingId' = 'exam:' || p_exam_id
    and item.value ->> 'ruleKey' = 'exam:' || p_exam_id || ':planning'
  order by item.ordinality limit 1;
  select item.value into incoming_planning
  from jsonb_array_elements(p_incoming) with ordinality item(value, ordinality)
  where item.value ->> 'anchorBookingId' = 'exam:' || p_exam_id
    and item.value ->> 'ruleKey' = 'exam:' || p_exam_id || ':planning'
  limit 1;
  if incoming_planning is not null then
    planning := incoming_planning;
    if existing is not null then
      planning := planning || jsonb_build_object('id', existing ->> 'id');
      if existing ->> 'status' = 'done' and existing ->> 'result' <> '考试日期或规则更新，任务自动关闭' then
        planning := (planning - 'result' - 'closedAt') || jsonb_build_object(
          'status', existing -> 'status', 'tone', existing -> 'tone'
        );
        if existing ? 'result' then planning := planning || jsonb_build_object('result', existing -> 'result'); end if;
        if existing ? 'closedAt' then planning := planning || jsonb_build_object('closedAt', existing -> 'closedAt'); end if;
      end if;
    end if;
  elsif existing is not null then
    if existing ->> 'status' <> 'done' then
      planning := existing || jsonb_build_object(
        'status', 'done', 'tone', 'green', 'closedAt', p_closed_at,
        'result', '考试日期或规则更新，任务自动关闭'
      );
    else
      planning := existing;
    end if;
  end if;
  if planning is not null then prepared := prepared || jsonb_build_array(planning); end if;
  select coalesce(jsonb_agg(item.value order by
      internal.exam_submission_task_due_sort(item.value ->> 'dueAt'), item.ordinality), '[]'::jsonb)
    into prepared
  from jsonb_array_elements(prepared) with ordinality item(value, ordinality);
  if exists (select 1 from jsonb_array_elements(prepared) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1) then
    raise exception using errcode = '23505', message = 'exam_submission_task_identity_conflict';
  end if;
  return prepared;
end;
$$;

revoke all on function internal.exam_submission_reconcile_tasks(jsonb, jsonb, text, text)
  from public, anon, authenticated, service_role;

alter table internal.exam_follow_up_commands
  drop constraint if exists exam_follow_up_commands_follow_up_kind_check;
alter table internal.exam_follow_up_commands
  add constraint exam_follow_up_commands_follow_up_kind_check check (
    follow_up_kind in ('exam_care', 'exam_recall', 'exam_month_planning', 'exam_results_follow_up')
  );

-- The already-active public.mutate_exam_follow_up_atomic and its replay/context
-- readers call internal.exam_follow_up_identity by name, so the replacement
-- above extends complete/undo and replay payloads without widening ACLs.

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
  transformed_students jsonb;
  transformed_tasks jsonb;
  suffix text;
  identity jsonb;
  original_state jsonb;
  has_state boolean;
begin
  select item.value into task from jsonb_array_elements(p_tasks) item(value)
  where item.value ->> 'id' = p_task_id;
  suffix := (pg_catalog.regexp_match(coalesce(task ->> 'ruleKey', ''), '^exam:([^:]+):(planning|care|recall|results)$'))[2];
  if suffix is distinct from 'planning' then
    return internal.exam_follow_up_identity_legacy_20260815(p_students, p_tasks, p_task_id);
  end if;
  select item.value into student from jsonb_array_elements(p_students) item(value)
  where item.value ->> 'id' = task ->> 'studentId';
  select item.value into exam from jsonb_array_elements(student -> 'exams') item(value)
  where item.value ->> 'id' = (pg_catalog.regexp_match(task ->> 'ruleKey', '^exam:([^:]+):planning$'))[1];
  has_state := exam ? 'followUpState';
  original_state := case when has_state then exam -> 'followUpState' else '{}'::jsonb end;
  transformed_tasks := (
    select jsonb_agg(case when item.value ->> 'id' = p_task_id
      then item.value || jsonb_build_object('ruleKey', 'exam:' || (pg_catalog.regexp_match(task ->> 'ruleKey', '^exam:([^:]+):planning$'))[1] || ':results')
      else item.value end order by item.ordinality)
    from jsonb_array_elements(p_tasks) with ordinality item(value, ordinality)
  );
  transformed_students := (
    select jsonb_agg(case when s.value ->> 'id' = student ->> 'id' then
      (s.value - 'exams') || jsonb_build_object('exams', (
        select jsonb_agg(case when e.value ->> 'id' = exam ->> 'id' then
          e.value || case when has_state then jsonb_build_object('followUpState', original_state - 'exam_month_planning') else '{}'::jsonb end
          else e.value end order by e.ordinality)
        from jsonb_array_elements(s.value -> 'exams') with ordinality e(value, ordinality)
      )) else s.value end order by s.ordinality)
    from jsonb_array_elements(p_students) with ordinality s(value, ordinality)
  );
  identity := internal.exam_follow_up_identity_legacy_20260815(
    transformed_students, transformed_tasks, p_task_id
  );
  return identity || jsonb_build_object(
    'followUpKind', 'exam_month_planning', 'task', task,
    'followUpStateExists', has_state, 'followUpState', original_state
  );
end;
$$;

revoke all on function internal.exam_follow_up_identity(jsonb, jsonb, text)
  from public, anon, authenticated, service_role;

-- Executable date fixtures keep the SQL calendar-month clamp and Melbourne
-- offset tied to the TypeScript projection (including leap-year and DST cases).
do $exam_month_planning_fixture$
declare
  fixture_students jsonb := jsonb_build_array(jsonb_build_object(
    'id', 'STU-PLANNING-FIXTURE', 'owner', 'Abby', 'planner', 'Tara',
    'exams', '[]'::jsonb
  ));
  fixture_intent jsonb;
  incoming jsonb;
  planning jsonb;
begin
  fixture_intent := jsonb_build_object(
    'studentId', 'STU-PLANNING-FIXTURE',
    'exam', jsonb_build_object(
      'id', 'EXM-PLANNING-MARCH-2026', 'subject', 'Maths',
      'examType', 'other', 'examVariant', 'other', 'examMonth', '2026-03',
      'examDate', '2026-03-31', 'includeRecall', false
    )
  );
  incoming := internal.exam_submission_incoming_tasks(
    fixture_students, fixture_intent, '2026-01-01T00:00:00.000Z'::timestamptz
  );
  select item.value into planning from jsonb_array_elements(incoming) item(value)
  where item.value ->> 'ruleKey' = 'exam:EXM-PLANNING-MARCH-2026:planning';
  if planning ->> 'due' <> '2026-02-28 18:00'
     or planning ->> 'dueAt' <> '2026-02-28T07:00:00.000Z' then
    raise exception 'exam_month_planning_march_fixture_failed';
  end if;

  fixture_intent := jsonb_build_object(
    'studentId', 'STU-PLANNING-FIXTURE',
    'exam', jsonb_build_object(
      'id', 'EXM-PLANNING-MARCH-2028', 'subject', 'Maths',
      'examType', 'other', 'examVariant', 'other', 'examMonth', '2028-03',
      'examDate', '2028-03-31', 'includeRecall', false
    )
  );
  incoming := internal.exam_submission_incoming_tasks(
    fixture_students, fixture_intent, '2028-01-01T00:00:00.000Z'::timestamptz
  );
  select item.value into planning from jsonb_array_elements(incoming) item(value)
  where item.value ->> 'ruleKey' = 'exam:EXM-PLANNING-MARCH-2028:planning';
  if planning ->> 'due' <> '2028-02-29 18:00'
     or planning ->> 'dueAt' <> '2028-02-29T07:00:00.000Z' then
    raise exception 'exam_month_planning_leap_fixture_failed';
  end if;

  fixture_intent := jsonb_build_object(
    'studentId', 'STU-PLANNING-FIXTURE',
    'exam', jsonb_build_object(
      'id', 'EXM-PLANNING-OCTOBER-2026', 'subject', 'Maths',
      'examType', 'other', 'examVariant', 'other', 'examMonth', '2026-10',
      'examDate', '2026-10-31', 'includeRecall', false
    )
  );
  incoming := internal.exam_submission_incoming_tasks(
    fixture_students, fixture_intent, '2026-01-01T00:00:00.000Z'::timestamptz
  );
  select item.value into planning from jsonb_array_elements(incoming) item(value)
  where item.value ->> 'ruleKey' = 'exam:EXM-PLANNING-OCTOBER-2026:planning';
  if planning ->> 'due' <> '2026-09-30 18:00'
     or planning ->> 'dueAt' <> '2026-09-30T08:00:00.000Z' then
    raise exception 'exam_month_planning_dst_fixture_failed';
  end if;
end;
$exam_month_planning_fixture$;
