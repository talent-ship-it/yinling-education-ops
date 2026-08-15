-- One exam edit changes the authoritative student record and the complete set
-- of managed exam reminders. The browser submits only the exam form, an opaque
-- UUID command key and two OCC versions; both projections are derived on the
-- server and independently reproduced here from locked state.

create table if not exists internal.exam_submission_commands (
  command_key text primary key check (
    command_key ~ '^exam-submit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('create', 'update')),
  student_id text not null check (length(student_id) between 1 and 120),
  exam_id text not null check (length(exam_id) between 1 and 120),
  student_version bigint not null check (student_version > 0),
  task_version bigint not null check (task_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.exam_submission_commands enable row level security;
revoke all on table internal.exam_submission_commands from public, anon, authenticated, service_role;

create or replace function internal.validate_exam_submission_intent(p_intent jsonb)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  exam jsonb;
  date_text text;
begin
  if jsonb_typeof(p_intent) is distinct from 'object'
     or p_intent - 'studentId' - 'exam' <> '{}'::jsonb
     or coalesce(p_intent ->> 'studentId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
     or jsonb_typeof(p_intent -> 'exam') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'invalid_exam_submission_intent';
  end if;
  exam := p_intent -> 'exam';
  if exam - 'id' - 'subject' - 'examType' - 'examVariant' - 'examMonth'
      - 'examDate' - 'resultDateOverride' - 'includeRecall' <> '{}'::jsonb
     or coalesce(exam ->> 'id', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
     or jsonb_typeof(exam -> 'subject') is distinct from 'string'
     or length(trim(exam ->> 'subject')) not between 1 and 200
     or jsonb_typeof(exam -> 'examType') is distinct from 'string'
     or exam ->> 'examType' not in ('scholarship', 'selective', 'aeas', 'other')
     or jsonb_typeof(exam -> 'examVariant') is distinct from 'string'
     or exam ->> 'examVariant' not in (
       'scholarship', 'selective', 'oc', 'mgs', 'gate', 'jmss', 'aeas',
       'school_interview', 'australian_university_final',
       'australian_university_assignment', 'vce', 'wace', 'hsc', 'qce',
       'sace', 'icas', 'amc', 'ielts_paper', 'ielts_computer', 'pte', 'ccl', 'other'
     )
     or coalesce(exam ->> 'examMonth', '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     or jsonb_typeof(exam -> 'includeRecall') is distinct from 'boolean'
     or (exam ? 'examDate' and jsonb_typeof(exam -> 'examDate') is distinct from 'string')
     or (exam ? 'resultDateOverride'
       and jsonb_typeof(exam -> 'resultDateOverride') is distinct from 'string') then
    raise exception using errcode = '22023', message = 'invalid_exam_submission_exam';
  end if;
  if exam ? 'examDate' then
    date_text := exam ->> 'examDate';
    begin
      if date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or pg_catalog.to_char(date_text::date, 'YYYY-MM-DD') <> date_text
         or pg_catalog.left(date_text, 7) <> exam ->> 'examMonth' then
        raise exception using errcode = '22023', message = 'invalid_exam_submission_exam_date';
      end if;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_exam_submission_exam_date';
    end;
  end if;
  if exam ? 'resultDateOverride' then
    date_text := exam ->> 'resultDateOverride';
    begin
      if date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or pg_catalog.to_char(date_text::date, 'YYYY-MM-DD') <> date_text then
        raise exception using errcode = '22023', message = 'invalid_exam_submission_result_date';
      end if;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_exam_submission_result_date';
    end;
  end if;
end;
$$;

revoke all on function internal.validate_exam_submission_intent(jsonb)
  from public, anon, authenticated, service_role;

create or replace function internal.exam_submission_result_date(p_exam jsonb)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  exam_date date;
  variant text;
  remaining integer;
  target date;
  target_month date;
  last_day integer;
begin
  if not (p_exam ? 'examDate') then return null; end if;
  exam_date := (p_exam ->> 'examDate')::date;
  if p_exam ? 'resultDateOverride' then return p_exam ->> 'resultDateOverride'; end if;
  variant := p_exam ->> 'examVariant';
  if variant in ('scholarship', 'selective', 'oc', 'mgs', 'gate', 'jmss') then
    return pg_catalog.to_char(exam_date + 30, 'YYYY-MM-DD');
  elsif variant in ('school_interview', 'ielts_computer') then
    return pg_catalog.to_char(exam_date + 3, 'YYYY-MM-DD');
  elsif variant = 'australian_university_assignment' then
    return pg_catalog.to_char(exam_date + 14, 'YYYY-MM-DD');
  elsif variant = 'pte' then
    return pg_catalog.to_char(exam_date + 1, 'YYYY-MM-DD');
  elsif variant = 'ccl' then
    return pg_catalog.to_char(exam_date + 42, 'YYYY-MM-DD');
  elsif variant in ('aeas', 'ielts_paper') then
    target := exam_date;
    remaining := 10;
    while remaining > 0 loop
      target := target + 1;
      if extract(isodow from target) between 1 and 5 then remaining := remaining - 1; end if;
    end loop;
    return pg_catalog.to_char(target, 'YYYY-MM-DD');
  elsif variant = 'australian_university_final' then
    target := pg_catalog.make_date(extract(year from exam_date)::integer, 7, 15);
    if target <= exam_date then
      target := pg_catalog.make_date(extract(year from exam_date)::integer, 12, 15);
    end if;
    if target <= exam_date then
      target := pg_catalog.make_date(extract(year from exam_date)::integer + 1, 7, 15);
    end if;
    return pg_catalog.to_char(target, 'YYYY-MM-DD');
  elsif variant in ('icas', 'amc') then
    target_month := (pg_catalog.date_trunc('month', exam_date)::date + interval '2 months')::date;
    last_day := extract(day from (target_month + interval '1 month - 1 day')::date)::integer;
    target := target_month + (least(extract(day from exam_date)::integer, last_day) - 1);
    return pg_catalog.to_char(target, 'YYYY-MM-DD');
  end if;
  return null;
end;
$$;

revoke all on function internal.exam_submission_result_date(jsonb)
  from public, anon, authenticated, service_role;

create or replace function internal.exam_submission_expected_students(
  p_students jsonb,
  p_intent jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  target_id text := p_intent ->> 'studentId';
  exam_id text := p_intent -> 'exam' ->> 'id';
  current_student jsonb;
  previous_exam jsonb;
  final_exam jsonb;
  next_exams jsonb;
  next_student jsonb;
  result_date text;
  result jsonb;
begin
  perform internal.validate_exam_submission_intent(p_intent);
  if jsonb_typeof(p_students) is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(p_students) item(value)
       where jsonb_typeof(item.value) is distinct from 'object'
          or nullif(trim(item.value ->> 'id'), '') is null)
     or exists (select 1 from jsonb_array_elements(p_students) item(value)
       group by item.value ->> 'id' having count(*) > 1) then
    raise exception using errcode = '22023', message = 'invalid_exam_submission_students';
  end if;
  select item.value into current_student
  from jsonb_array_elements(p_students) item(value)
  where item.value ->> 'id' = target_id;
  if current_student is null then
    raise exception using errcode = '22023', message = 'exam_submission_student_not_found';
  end if;
  if current_student -> 'importArchived' = 'true'::jsonb then
    raise exception using errcode = '42501', message = 'archived_student_exam_read_only';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_students) student(value)
    where student.value ? 'exams' and jsonb_typeof(student.value -> 'exams') is distinct from 'array'
  ) or exists (
    select 1
    from jsonb_array_elements(p_students) student(value),
      jsonb_array_elements(case when jsonb_typeof(student.value -> 'exams') = 'array'
        then student.value -> 'exams' else '[]'::jsonb end) exam(value)
    where jsonb_typeof(exam.value) is distinct from 'object'
       or nullif(trim(exam.value ->> 'id'), '') is null
  ) or exists (
    select 1
    from jsonb_array_elements(p_students) student(value),
      jsonb_array_elements(case when jsonb_typeof(student.value -> 'exams') = 'array'
        then student.value -> 'exams' else '[]'::jsonb end) exam(value)
    group by student.value ->> 'id', exam.value ->> 'id'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'invalid_exam_submission_history';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_students) student(value),
      jsonb_array_elements(case when jsonb_typeof(student.value -> 'exams') = 'array'
        then student.value -> 'exams' else '[]'::jsonb end) exam(value)
    where student.value ->> 'id' <> target_id and exam.value ->> 'id' = exam_id
  ) then
    raise exception using errcode = '23505', message = 'exam_submission_identity_conflict';
  end if;
  select exam.value into previous_exam
  from jsonb_array_elements(case when jsonb_typeof(current_student -> 'exams') = 'array'
    then current_student -> 'exams' else '[]'::jsonb end) exam(value)
  where exam.value ->> 'id' = exam_id;
  final_exam := p_intent -> 'exam';
  if jsonb_typeof(previous_exam -> 'followUpState') = 'object' then
    final_exam := final_exam || jsonb_build_object('followUpState', previous_exam -> 'followUpState');
  end if;
  select coalesce(jsonb_agg(item.value order by
    item.value ->> 'examMonth' collate "C",
    case when item.value ? 'examDate' then 1 else 0 end,
    coalesce(item.value ->> 'examDate', '') collate "C",
    item.value ->> 'id' collate "C"
  ), '[]'::jsonb) into next_exams
  from (
    select exam.value
    from jsonb_array_elements(case when jsonb_typeof(current_student -> 'exams') = 'array'
      then current_student -> 'exams' else '[]'::jsonb end) exam(value)
    where exam.value ->> 'id' <> exam_id
    union all
    select final_exam
  ) item;
  result_date := internal.exam_submission_result_date(final_exam);
  next_student := current_student - 'exams' - 'examSubject' - 'examDate' - 'resultDate';
  next_student := jsonb_set(next_student, '{exams}', next_exams, true);
  next_student := jsonb_set(next_student, '{examSubject}', to_jsonb(final_exam ->> 'subject'), true);
  if final_exam ? 'examDate' then
    next_student := jsonb_set(next_student, '{examDate}', to_jsonb(final_exam ->> 'examDate'), true);
  end if;
  if result_date is not null then
    next_student := jsonb_set(next_student, '{resultDate}', to_jsonb(result_date), true);
  end if;
  select jsonb_agg(case when item.value ->> 'id' = target_id then next_student else item.value end
    order by item.ordinality)
  into result
  from jsonb_array_elements(p_students) with ordinality item(value, ordinality);
  return result;
end;
$$;

revoke all on function internal.exam_submission_expected_students(jsonb, jsonb)
  from public, anon, authenticated, service_role;

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
  student jsonb;
  previous_exam jsonb;
  exam jsonb := p_intent -> 'exam';
  follow_up jsonb := '{}'::jsonb;
  step_state jsonb;
  suffix text;
  kind text;
  role_name text;
  title_text text;
  recipient text;
  due_date text;
  result_date text;
  rule_key text;
  due_instant timestamptz;
  due_at_text text;
  completed boolean;
  task jsonb;
  result jsonb := '[]'::jsonb;
begin
  perform internal.validate_exam_submission_intent(p_intent);
  select item.value into student from jsonb_array_elements(p_students) item(value)
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
  result_date := internal.exam_submission_result_date(exam);

  for suffix, kind, role_name in
    select * from (values
      ('care'::text, 'exam_care'::text, 'academic_coordinator'::text),
      ('recall'::text, 'exam_recall'::text, 'academic_coordinator'::text),
      ('results'::text, 'exam_results_follow_up'::text, 'course_planner'::text)
    ) definitions
  loop
    if not (exam ? 'examDate') then continue; end if;
    if suffix = 'recall' and exam -> 'includeRecall' is distinct from 'true'::jsonb then continue; end if;
    if suffix = 'results' and result_date is null then continue; end if;
    due_date := case when suffix = 'results' then result_date else exam ->> 'examDate' end;
    recipient := nullif(trim(case when role_name = 'academic_coordinator'
      then student ->> 'owner' else student ->> 'planner' end), '');
    if recipient is null or recipient ~ '^(待分配|待确认|未知|角色待配置[:：])' then continue; end if;
    step_state := follow_up -> kind;
    if step_state ->> 'status' = 'not_required' then continue; end if;
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
    rule_key := 'exam:' || (exam ->> 'id') || ':' || suffix;
    title_text := (exam ->> 'subject') || case suffix
      when 'care' then '考试当天关心'
      when 'recall' then '考试回忆'
      else '出分关心' end;
    due_instant := (due_date::date + time '18:00') at time zone 'Australia/Melbourne';
    due_at_text := pg_catalog.to_char(due_instant at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    task := jsonb_build_object(
      'id', 'TSK-EXAM-' || pg_catalog.left(encode(extensions.digest(
        pg_catalog.convert_to((p_intent ->> 'studentId') || chr(31) || rule_key, 'UTF8'), 'sha256'
      ), 'hex'), 24),
      'title', title_text,
      'owner', recipient,
      'assignees', jsonb_build_array(recipient),
      'watchers', jsonb_build_array('Ops Admin'),
      'studentId', p_intent ->> 'studentId',
      'due', due_date || ' 18:00',
      'dueAt', due_at_text,
      'status', case when completed then 'done'
        when due_date::date < (p_prepared_at at time zone 'Australia/Melbourne')::date then 'overdue'
        when due_date::date = (p_prepared_at at time zone 'Australia/Melbourne')::date then 'today'
        else 'upcoming' end,
      'tone', case when completed then 'green' when suffix = 'results' then 'purple' else 'amber' end,
      'category', '考试',
      'trigger', (exam ->> 'subject') || ' 考试记录 · 收件：' || recipient,
      'ruleKey', rule_key,
      'anchorBookingId', 'exam:' || (exam ->> 'id')
    );
    if completed then
      task := task || jsonb_build_object(
        'result', '考试跟进已完成',
        'closedAt', step_state ->> 'completedAt'
      );
    end if;
    result := result || jsonb_build_array(task);
  end loop;
  return result;
end;
$$;

revoke all on function internal.exam_submission_incoming_tasks(jsonb, jsonb, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function internal.exam_submission_task_due_sort(p_value text)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if nullif(trim(p_value), '') is null then return 'infinity'::timestamptz; end if;
  return p_value::timestamptz;
exception when others then
  return 'infinity'::timestamptz;
end;
$$;

revoke all on function internal.exam_submission_task_due_sort(text)
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
  task_record record;
  task jsonb;
  incoming_task jsonb;
  next_task jsonb;
  prepared jsonb := '[]'::jsonb;
  managed boolean;
  first_ordinality bigint;
  existing jsonb;
begin
  if jsonb_typeof(p_tasks) is distinct from 'array'
     or jsonb_typeof(p_incoming) is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(p_tasks) item(value)
       where jsonb_typeof(item.value) is distinct from 'object'
          or nullif(trim(item.value ->> 'id'), '') is null)
     or exists (select 1 from jsonb_array_elements(p_tasks) item(value)
       group by item.value ->> 'id' having count(*) > 1) then
    raise exception using errcode = '22023', message = 'invalid_exam_submission_tasks';
  end if;
  for task_record in
    select item.value, item.ordinality
    from jsonb_array_elements(p_tasks) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    task := task_record.value;
    managed := task ->> 'anchorBookingId' = 'exam:' || p_exam_id
      and task ->> 'ruleKey' in (
        'exam:' || p_exam_id || ':care',
        'exam:' || p_exam_id || ':recall',
        'exam:' || p_exam_id || ':results'
      );
    next_task := task;
    if managed and not exists (
      select 1 from jsonb_array_elements(p_incoming) item(value)
      where item.value ->> 'ruleKey' = task ->> 'ruleKey'
        and item.value ->> 'anchorBookingId' = task ->> 'anchorBookingId'
    ) then
      if task ->> 'status' <> 'done' then
        next_task := task || jsonb_build_object(
          'status', 'done', 'tone', 'green', 'closedAt', p_closed_at,
          'result', '考试日期或规则更新，任务自动关闭'
        );
      end if;
    elsif managed and task ->> 'status' = 'done'
       and task ->> 'result' = '考试日期或规则更新，任务自动关闭' then
      next_task := (task - 'closedAt' - 'result') || jsonb_build_object('status', 'waiting', 'tone', 'neutral');
    end if;
    prepared := prepared || jsonb_build_array(next_task);
  end loop;

  for incoming_task in select value from jsonb_array_elements(p_incoming)
  loop
    select item.ordinality into first_ordinality
    from jsonb_array_elements(prepared) with ordinality item(value, ordinality)
    where item.value ->> 'ruleKey' = incoming_task ->> 'ruleKey'
      and item.value ->> 'anchorBookingId' = incoming_task ->> 'anchorBookingId'
    order by item.ordinality limit 1;
    select item.value into existing
    from jsonb_array_elements(prepared) with ordinality item(value, ordinality)
    where item.value ->> 'ruleKey' = incoming_task ->> 'ruleKey'
      and item.value ->> 'anchorBookingId' = incoming_task ->> 'anchorBookingId'
    order by case when item.value ->> 'status' = 'done' then 0 else 1 end, item.ordinality
    limit 1;
    if existing is null then
      prepared := prepared || jsonb_build_array(incoming_task);
    else
      next_task := incoming_task || jsonb_build_object('id', existing ->> 'id');
      if existing ->> 'status' = 'done' then
        next_task := (next_task - 'result' - 'closedAt') || jsonb_build_object(
          'status', existing -> 'status', 'tone', existing -> 'tone'
        );
        if existing ? 'result' then next_task := next_task || jsonb_build_object('result', existing -> 'result'); end if;
        if existing ? 'closedAt' then next_task := next_task || jsonb_build_object('closedAt', existing -> 'closedAt'); end if;
      end if;
      select coalesce(jsonb_agg(
        case when item.ordinality = first_ordinality then next_task else item.value end
        order by item.ordinality
      ), '[]'::jsonb) into prepared
      from jsonb_array_elements(prepared) with ordinality item(value, ordinality)
      where item.ordinality = first_ordinality
         or item.value ->> 'ruleKey' is distinct from incoming_task ->> 'ruleKey'
         or item.value ->> 'anchorBookingId' is distinct from incoming_task ->> 'anchorBookingId';
    end if;
    first_ordinality := null;
    existing := null;
  end loop;

  select coalesce(jsonb_agg(item.value order by
    internal.exam_submission_task_due_sort(item.value ->> 'dueAt'), item.ordinality
  ), '[]'::jsonb) into prepared
  from jsonb_array_elements(prepared) with ordinality item(value, ordinality);
  if exists (
    select 1 from jsonb_array_elements(prepared) item(value)
    group by item.value ->> 'id' having item.value ->> 'id' is null or count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'exam_submission_task_identity_conflict';
  end if;
  return prepared;
end;
$$;

revoke all on function internal.exam_submission_reconcile_tasks(jsonb, jsonb, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.get_exam_submission_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_actor text
)
returns table (
  command_key text,
  action text,
  student_id text,
  exam_id text,
  audit_entry_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  prior internal.exam_submission_commands%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  perform internal.validate_exam_submission_intent(p_command_intent);
  if coalesce(p_command_key, '') !~ '^exam-submit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_exam_submission_replay_lookup';
  end if;
  select * into prior from internal.exam_submission_commands c where c.command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent
     or prior.actor <> trim(p_actor)
     or prior.student_id <> p_command_intent ->> 'studentId'
     or prior.exam_id <> p_command_intent -> 'exam' ->> 'id' then
    raise exception using errcode = '23505', message = 'exam_submission_idempotency_conflict';
  end if;
  return query select prior.command_key, prior.action, prior.student_id,
    prior.exam_id, prior.audit_id;
end;
$$;

revoke all on function public.get_exam_submission_command_result(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_exam_submission_command_result(text, text, jsonb, text)
  to anon, authenticated;

create or replace function public.submit_exam_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_student_id text,
  p_exam_id text,
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
  student_id text,
  exam_id text,
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
  prior internal.exam_submission_commands%rowtype;
  expected_student_version bigint;
  expected_task_version bigint;
  prepared_at_value timestamptz;
  expected_action text;
  expected_students jsonb;
  incoming_tasks jsonb;
  expected_tasks jsonb;
  audit_id uuid;
  committed_at timestamptz;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  perform internal.validate_exam_submission_intent(p_command_intent);
  if coalesce(p_command_key, '') !~ '^exam-submit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_command_intent ->> 'studentId' is distinct from p_student_id
     or p_command_intent -> 'exam' ->> 'id' is distinct from p_exam_id
     or p_action not in ('create', 'update')
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'students' - 'tasks' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'students') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'tasks') is distinct from 'number'
     or jsonb_typeof(p_students) is distinct from 'array'
     or jsonb_typeof(p_tasks) is distinct from 'array'
     or coalesce(p_prepared_at, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
     or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_exam_submission_command';
  end if;
  begin
    expected_student_version := (p_expected_versions ->> 'students')::bigint;
    expected_task_version := (p_expected_versions ->> 'tasks')::bigint;
    prepared_at_value := p_prepared_at::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_exam_submission_command';
  end;
  if expected_student_version < 1 or expected_task_version < 1
     or prepared_at_value < clock_timestamp() - interval '15 minutes'
     or prepared_at_value > clock_timestamp() + interval '2 minutes' then
    raise exception using errcode = '22023', message = 'invalid_exam_submission_command';
  end if;

  -- Global order for this two-row transaction: students -> tasks.
  select * into student_state from public.ops_state s where s.entity = 'students' for update;
  select * into task_state from public.ops_state s where s.entity = 'tasks' for update;
  if student_state.entity is null or task_state.entity is null
     or jsonb_typeof(student_state.payload) is distinct from 'array'
     or jsonb_typeof(task_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'exam_submission_state_missing';
  end if;

  select * into prior from internal.exam_submission_commands c where c.command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent
       or prior.actor <> trim(p_actor)
       or prior.student_id <> p_student_id
       or prior.exam_id <> p_exam_id
       or prior.action <> p_action then
      raise exception using errcode = '23505', message = 'exam_submission_idempotency_conflict';
    end if;
    return query select prior.command_key, prior.action, false, prior.student_id,
      prior.exam_id, student_state, task_state, prior.audit_id;
    return;
  end if;

  if student_state.version is distinct from expected_student_version
     or task_state.version is distinct from expected_task_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  expected_action := case when exists (
    select 1
    from jsonb_array_elements(student_state.payload) student(value),
      jsonb_array_elements(case when jsonb_typeof(student.value -> 'exams') = 'array'
        then student.value -> 'exams' else '[]'::jsonb end) exam(value)
    where student.value ->> 'id' = p_student_id and exam.value ->> 'id' = p_exam_id
  ) then 'update' else 'create' end;
  if p_action <> expected_action then
    raise exception using errcode = '40001', message = 'exam_submission_action_conflict';
  end if;
  expected_students := internal.exam_submission_expected_students(student_state.payload, p_command_intent);
  incoming_tasks := internal.exam_submission_incoming_tasks(
    student_state.payload, p_command_intent, prepared_at_value
  );
  expected_tasks := internal.exam_submission_reconcile_tasks(
    task_state.payload, incoming_tasks, p_exam_id, p_prepared_at
  );
  if p_students is distinct from expected_students then
    raise exception using errcode = '22023', message = 'exam_submission_student_payload_mismatch';
  end if;
  if p_tasks is distinct from expected_tasks then
    raise exception using errcode = '22023', message = 'exam_submission_task_payload_mismatch';
  end if;

  committed_at := clock_timestamp();
  update public.ops_state set
    payload = p_students,
    version = version + 1,
    updated_at = committed_at,
    updated_by = left(trim(p_actor), 120)
  where entity = 'students'
  returning * into saved_student_state;
  update public.ops_state set
    payload = p_tasks,
    version = version + 1,
    updated_at = committed_at,
    updated_by = left(trim(p_actor), 120)
  where entity = 'tasks'
  returning * into saved_task_state;
  insert into public.ops_mutation_log(entity, version, actor) values
    ('students', saved_student_state.version, left(trim(p_actor), 120)),
    ('tasks', saved_task_state.version, left(trim(p_actor), 120));
  audit_id := internal.append_operational_contract_audit(
    'exam_submission.committed', left(trim(p_actor), 120), 'student', p_student_id,
    jsonb_build_object(
      'commandKey', p_command_key,
      'action', p_action,
      'studentId', p_student_id,
      'examId', p_exam_id,
      'studentVersion', saved_student_state.version,
      'taskVersion', saved_task_state.version,
      'managedTaskCount', jsonb_array_length(incoming_tasks),
      'commandHash', encode(extensions.digest(p_command_intent::text, 'sha256'), 'hex')
    )
  );
  insert into internal.exam_submission_commands (
    command_key, command_intent, command_hash, action, student_id, exam_id,
    student_version, task_version, actor, applied_at, audit_id
  ) values (
    p_command_key, p_command_intent,
    encode(extensions.digest(p_command_intent::text, 'sha256'), 'hex'),
    p_action, p_student_id, p_exam_id, saved_student_state.version,
    saved_task_state.version, left(trim(p_actor), 120), committed_at, audit_id
  );
  return query select p_command_key, p_action, true, p_student_id, p_exam_id,
    saved_student_state, saved_task_state, audit_id;
end;
$$;

revoke all on function public.submit_exam_atomic(text, text, jsonb, text, text, text, jsonb, jsonb, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_exam_atomic(text, text, jsonb, text, text, text, jsonb, jsonb, jsonb, text, text)
  to anon, authenticated;

-- Migration-time pure fixtures keep the TypeScript and SQL projections tied
-- to the same result-date, routing, stable-id and reconciliation contracts.
do $exam_submission_contract_fixture$
declare
  fixture_students jsonb := jsonb_build_array(jsonb_build_object(
    'id', 'STU-FIXTURE', 'name', 'Fixture Student', 'owner', 'Abby',
    'planner', 'Tara', 'status', '在读', 'exams', jsonb_build_array(jsonb_build_object(
      'id', 'EXM_FIXTURE', 'subject', 'Previous', 'examType', 'selective',
      'examVariant', 'selective', 'examMonth', '2026-09',
      'examDate', '2026-09-01', 'includeRecall', true
    ))
  ));
  fixture_intent jsonb := jsonb_build_object(
    'studentId', 'STU-FIXTURE',
    'exam', jsonb_build_object(
      'id', 'EXM-FIXTURE', 'subject', 'Selective', 'examType', 'selective',
      'examVariant', 'selective', 'examMonth', '2026-09',
      'examDate', '2026-09-01', 'includeRecall', true
    )
  );
  projected_students jsonb;
  incoming jsonb;
  reconciled jsonb;
begin
  projected_students := internal.exam_submission_expected_students(fixture_students, fixture_intent);
  if projected_students #>> '{0,resultDate}' <> '2026-10-01'
     or projected_students #>> '{0,exams,0,id}' <> 'EXM-FIXTURE'
     or projected_students #>> '{0,exams,1,id}' <> 'EXM_FIXTURE' then
    raise exception 'exam_submission_student_fixture_failed';
  end if;
  incoming := internal.exam_submission_incoming_tasks(
    fixture_students, fixture_intent, '2026-08-15T00:00:00.000Z'::timestamptz
  );
  if jsonb_array_length(incoming) <> 3
     or incoming #>> '{0,owner}' <> 'Abby'
     or incoming #>> '{2,owner}' <> 'Tara'
     or incoming #>> '{0,watchers,0}' <> 'Ops Admin'
     or incoming #>> '{0,dueAt}' <> '2026-09-01T08:00:00.000Z'
     or incoming #>> '{0,id}' <> 'TSK-EXAM-f0c09a89b51b2bf60e44a7bc' then
    raise exception 'exam_submission_task_fixture_failed';
  end if;
  reconciled := internal.exam_submission_reconcile_tasks(
    jsonb_build_array(jsonb_build_object(
      'id', 'TSK-MANUAL', 'title', 'Manual', 'owner', 'Abby',
      'studentId', 'STU-FIXTURE', 'due', '待确认', 'status', 'waiting',
      'tone', 'neutral', 'category', '资料', 'trigger', '人工创建'
    )),
    incoming, 'EXM-FIXTURE', '2026-08-15T00:00:00.000Z'
  );
  if jsonb_array_length(reconciled) <> 4
     or reconciled #>> '{3,id}' <> 'TSK-MANUAL' then
    raise exception 'exam_submission_reconcile_fixture_failed';
  end if;
end;
$exam_submission_contract_fixture$;
