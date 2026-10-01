begin;

create or replace function internal.assert_jiaowubao_completed_lesson_snapshot_page(p_rows jsonb, p_period_month date)
returns void language plpgsql stable set search_path = '' as $$
declare month_start text := to_char(p_period_month,'YYYY-MM-DD'); month_end text := to_char((p_period_month + interval '1 month - 1 day')::date,'YYYY-MM-DD');
begin
  if p_rows is null or p_period_month is null or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 or octet_length(p_rows::text) > 2097152
     or exists (
       select 1 from jsonb_array_elements(p_rows) wrapper
       where jsonb_typeof(wrapper) is distinct from 'object'
          or wrapper - ARRAY['sourceKey','record']::text[] <> '{}'::jsonb
          or not (wrapper ?& ARRAY['sourceKey','record']::text[])
          or coalesce(wrapper ->> 'sourceKey','') !~ '^jwb-open-api:lesson:(~|[A-Za-z0-9][A-Za-z0-9._-]{0,159}):[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or jsonb_typeof(wrapper -> 'record') is distinct from 'object'
          or (wrapper -> 'record') - ARRAY['kind','sourceKey','completed','branchId','calendarId','memberId','memberName','lessonDate','timeTitle','hours','hoursIssue','lessonType','isTrial','attendanceCode','attendanceTitle','courseId','courseTitle','teamId','teamTitle','teachers','completedAt']::text[] <> '{}'::jsonb
          or not ((wrapper -> 'record') ?& ARRAY['kind','sourceKey','completed','branchId','calendarId','memberId','memberName','lessonDate','timeTitle','hours','lessonType','isTrial','attendanceCode','attendanceTitle','courseId','courseTitle','teamId','teamTitle','teachers','completedAt']::text[])
          or wrapper -> 'record' ->> 'kind' is distinct from 'lesson'
          or wrapper -> 'record' ->> 'sourceKey' is distinct from wrapper ->> 'sourceKey'
          or wrapper -> 'record' -> 'completed' is distinct from 'true'::jsonb
          or jsonb_typeof(wrapper -> 'record' -> 'branchId') is distinct from 'string'
          or jsonb_typeof(wrapper -> 'record' -> 'calendarId') is distinct from 'string'
          or jsonb_typeof(wrapper -> 'record' -> 'memberId') is distinct from 'string'
          or coalesce(wrapper -> 'record' ->> 'branchId','') !~ '^(~|[A-Za-z0-9][A-Za-z0-9._-]{0,159})$'
          or coalesce(wrapper -> 'record' ->> 'branchId','') ~ '^0+$'
          or coalesce(wrapper -> 'record' ->> 'calendarId','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or coalesce(wrapper -> 'record' ->> 'calendarId','') ~ '^0+$'
          or coalesce(wrapper -> 'record' ->> 'memberId','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or coalesce(wrapper -> 'record' ->> 'memberId','') ~ '^0+$'
          or (wrapper -> 'record' ->> 'sourceKey') is distinct from (
            'jwb-open-api:lesson:'
            || (wrapper -> 'record' ->> 'branchId')
            || ':' || (wrapper -> 'record' ->> 'calendarId')
            || ':' || (wrapper -> 'record' ->> 'memberId')
          )
          or coalesce(wrapper -> 'record' ->> 'lessonDate','') !~ '^\d{4}-\d{2}-\d{2}$'
          or wrapper -> 'record' ->> 'lessonDate' < month_start or wrapper -> 'record' ->> 'lessonDate' > month_end
          or case when jsonb_typeof(wrapper -> 'record' -> 'lessonDate') = 'string'
                    and wrapper -> 'record' ->> 'lessonDate' ~ '^\d{4}-\d{2}-\d{2}$'
                 then to_char(to_date(wrapper -> 'record' ->> 'lessonDate','YYYY-MM-DD'),'YYYY-MM-DD') is distinct from wrapper -> 'record' ->> 'lessonDate'
                 else true end
          or case
               when wrapper -> 'record' ? 'hoursIssue' then
                 case wrapper -> 'record' ->> 'hoursIssue'
                   when 'missing' then jsonb_typeof(wrapper -> 'record' -> 'hours') is distinct from 'null'
                   when 'non_numeric' then jsonb_typeof(wrapper -> 'record' -> 'hours') is distinct from 'null'
                   when 'out_of_range' then
                     case when jsonb_typeof(wrapper -> 'record' -> 'hours') = 'number'
                          then (wrapper -> 'record' ->> 'hours')::numeric between 0 and 24
                            or abs((wrapper -> 'record' ->> 'hours')::numeric) > 1.7976931348623157e308::numeric
                          else true end
                   else true
                 end
               when jsonb_typeof(wrapper -> 'record' -> 'hours') = 'number'
                 and wrapper -> 'record' ->> 'hours' ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$'
               then (wrapper -> 'record' ->> 'hours')::numeric not between 0 and 24
               else true end
          or jsonb_typeof(wrapper -> 'record' -> 'lessonType') not in ('number','null')
          or (jsonb_typeof(wrapper -> 'record' -> 'lessonType') = 'number' and wrapper -> 'record' ->> 'lessonType' !~ '^[1-5]$')
          or jsonb_typeof(wrapper -> 'record' -> 'isTrial') is distinct from 'boolean'
          or (wrapper -> 'record' ->> 'isTrial') is distinct from case when wrapper -> 'record' ->> 'lessonType' = '3' then 'true' else 'false' end
          or jsonb_typeof(wrapper -> 'record' -> 'teachers') is distinct from 'array'
          or jsonb_array_length(wrapper -> 'record' -> 'teachers') > 3
          or exists (select 1 from jsonb_array_elements(wrapper -> 'record' -> 'teachers') teacher where jsonb_typeof(teacher) is distinct from 'object' or teacher - ARRAY['role','id','name']::text[] <> '{}'::jsonb or not (teacher ?& ARRAY['role','id','name']::text[]) or teacher ->> 'role' not in ('primary','assistant','third') or jsonb_typeof(teacher -> 'id') not in ('string','null') or jsonb_typeof(teacher -> 'name') not in ('string','null'))
          or exists (select 1 from jsonb_array_elements(wrapper -> 'record' -> 'teachers') teacher group by teacher ->> 'role' having count(*) > 1)
          or exists (select 1 from unnest(ARRAY['memberName','timeTitle','attendanceTitle','courseId','courseTitle','teamId','teamTitle','completedAt']) field_name where jsonb_typeof(wrapper -> 'record' -> field_name) not in ('string','null'))
          or octet_length((wrapper -> 'record')::text) > 8192
     )
     or exists (select 1 from jsonb_array_elements(p_rows) wrapper group by wrapper ->> 'sourceKey' having count(*) > 1) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_page_invalid';
  end if;
end;
$$;
revoke all on function internal.assert_jiaowubao_completed_lesson_snapshot_page(jsonb,date) from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page(p_rows jsonb, p_period_month date)
returns void language plpgsql stable set search_path = '' as $$
declare month_start text := to_char(p_period_month,'YYYY-MM-DD'); month_end text := to_char((p_period_month + interval '1 month - 1 day')::date,'YYYY-MM-DD');
begin
  if p_rows is null or p_period_month is null or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 or octet_length(p_rows::text) > 2097152
     or exists (
       select 1 from jsonb_array_elements(p_rows) wrapper
       where jsonb_typeof(wrapper) is distinct from 'object'
          or wrapper - ARRAY['sourceKey','record']::text[] <> '{}'::jsonb
          or not (wrapper ?& ARRAY['sourceKey','record']::text[])
          or coalesce(wrapper ->> 'sourceKey','') !~ '^jwb-open-api:schedule:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or jsonb_typeof(wrapper -> 'record') is distinct from 'object'
          or (wrapper -> 'record') - ARRAY['kind','sourceKey','completed','calendarId','lessonDate','timeTitle','courseId','courseTitle','teamId','teamTitle','teachers','completedAt']::text[] <> '{}'::jsonb
          or not ((wrapper -> 'record') ?& ARRAY['kind','sourceKey','completed','calendarId','lessonDate','timeTitle','courseId','courseTitle','teamId','teamTitle','teachers','completedAt']::text[])
          or wrapper -> 'record' ->> 'kind' is distinct from 'schedule'
          or wrapper -> 'record' ->> 'sourceKey' is distinct from wrapper ->> 'sourceKey'
          or wrapper -> 'record' -> 'completed' is distinct from 'true'::jsonb
          or coalesce(wrapper -> 'record' ->> 'calendarId','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or (wrapper -> 'record' ->> 'sourceKey') is distinct from (
            'jwb-open-api:schedule:' || (wrapper -> 'record' ->> 'calendarId')
          )
          or coalesce(wrapper -> 'record' ->> 'lessonDate','') !~ '^\d{4}-\d{2}-\d{2}$'
          or wrapper -> 'record' ->> 'lessonDate' < month_start or wrapper -> 'record' ->> 'lessonDate' > month_end
          or case when jsonb_typeof(wrapper -> 'record' -> 'lessonDate') = 'string'
                    and wrapper -> 'record' ->> 'lessonDate' ~ '^\d{4}-\d{2}-\d{2}$'
                 then to_char(to_date(wrapper -> 'record' ->> 'lessonDate','YYYY-MM-DD'),'YYYY-MM-DD') is distinct from wrapper -> 'record' ->> 'lessonDate'
                 else true end
          or jsonb_typeof(wrapper -> 'record' -> 'teachers') is distinct from 'array'
          or jsonb_array_length(wrapper -> 'record' -> 'teachers') > 3
          or exists (select 1 from jsonb_array_elements(wrapper -> 'record' -> 'teachers') teacher where jsonb_typeof(teacher) is distinct from 'object' or teacher - ARRAY['role','id','name','hours','hoursIssue']::text[] <> '{}'::jsonb or not (teacher ?& ARRAY['role','id','name','hours']::text[]) or teacher ->> 'role' not in ('primary','assistant','third') or jsonb_typeof(teacher -> 'id') not in ('string','null') or jsonb_typeof(teacher -> 'name') not in ('string','null') or case when teacher ? 'hoursIssue' then case teacher ->> 'hoursIssue' when 'missing' then jsonb_typeof(teacher -> 'hours') is distinct from 'null' when 'non_numeric' then jsonb_typeof(teacher -> 'hours') is distinct from 'null' when 'out_of_range' then case when jsonb_typeof(teacher -> 'hours') = 'number' then (teacher ->> 'hours')::numeric between 0 and 24 or abs((teacher ->> 'hours')::numeric) > 1.7976931348623157e308::numeric else true end else true end when jsonb_typeof(teacher -> 'hours') = 'null' then false when jsonb_typeof(teacher -> 'hours') = 'number' and teacher ->> 'hours' ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$' then (teacher ->> 'hours')::numeric not between 0 and 24 else true end)
          or exists (select 1 from jsonb_array_elements(wrapper -> 'record' -> 'teachers') teacher group by teacher ->> 'role' having count(*) > 1)
          or exists (select 1 from unnest(ARRAY['timeTitle','courseId','courseTitle','teamId','teamTitle','completedAt']) field_name where jsonb_typeof(wrapper -> 'record' -> field_name) not in ('string','null'))
          or octet_length((wrapper -> 'record')::text) > 8192
     )
     or exists (select 1 from jsonb_array_elements(p_rows) wrapper group by wrapper ->> 'sourceKey' having count(*) > 1) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_schedule_page_invalid';
  end if;
end;
$$;
revoke all on function internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page(jsonb,date) from public, anon, authenticated;

create or replace function internal.jiaowubao_payroll_name_keys(p_name text)
returns text[] language sql immutable set search_path = '' as $$
  with runs as (
    select match[1] as chinese_run
    from pg_catalog.regexp_matches(
      internal.student_import_display_name(p_name) collate "C",
      '([㐀-䶿一-鿿豈-﫿𠀀-𯿿]+)', 'g'
    ) match
  ), auto as (
    select case when count(*) = 1
      and (pg_catalog.char_length(max(chinese_run)) >= 2 or pg_catalog.octet_length(max(chinese_run)) > 3)
      then max(chinese_run) else ''::text end as value
    from runs
  )
  select coalesce(pg_catalog.array_agg(distinct key.value) filter (where key.value <> ''), array[]::text[])
  from auto
  cross join lateral pg_catalog.unnest(array[
    internal.student_import_name_key(p_name),
    auto.value,
    internal.student_import_jwb_latin_parenthetical_annotation_key(p_name)
  ]) key(value)
$$;
revoke all on function internal.jiaowubao_payroll_name_keys(text) from public, anon, authenticated;

create or replace function internal.jiaowubao_payroll_role_matches_teacher(
  p_role jsonb,
  p_teachers jsonb,
  p_teacher_id text
)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  source_candidates text[];
  name_candidates text[];
  role_name_keys text[] := internal.jiaowubao_payroll_name_keys(p_role ->> 'name');
begin
  select coalesce(pg_catalog.array_agg(distinct profile.value ->> 'id'), array[]::text[])
    into source_candidates
  from pg_catalog.jsonb_array_elements(p_teachers) profile(value)
  cross join lateral (values
    (profile.value ->> 'jwbSourceRow'),
    (profile.value #>> '{jiaowubaoOpenApi,sourceId}'),
    (profile.value #>> '{historicalJwbSnapshot,currentAggregate,jwbSourceRow}'),
    (profile.value #>> '{historicalJwbSnapshot,retained,jwbSourceRow}')
  ) source_id(value)
  where profile.value ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    and nullif(pg_catalog.btrim(profile.value ->> 'name'), '') is not null
    and source_id.value = p_role ->> 'id';
  select coalesce(pg_catalog.array_agg(distinct profile.value ->> 'id'), array[]::text[])
    into name_candidates
  from pg_catalog.jsonb_array_elements(p_teachers) profile(value)
  where profile.value ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    and internal.jiaowubao_payroll_name_keys(profile.value ->> 'name') && role_name_keys;
  if pg_catalog.cardinality(source_candidates) > 1 or pg_catalog.cardinality(name_candidates) > 1 then return false; end if;
  if pg_catalog.cardinality(source_candidates) = 1
     and pg_catalog.cardinality(name_candidates) = 1
     and source_candidates[1] is distinct from name_candidates[1] then return false; end if;
  return coalesce(source_candidates[1], name_candidates[1]) = p_teacher_id;
end;
$$;
revoke all on function internal.jiaowubao_payroll_role_matches_teacher(jsonb,jsonb,text) from public, anon, authenticated;

create or replace function internal.jiaowubao_payroll_source_role_index(p_run_id uuid, p_revision text, p_teachers jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  with roster as materialized (
    select profile.value ->> 'id' as teacher_id,
      internal.jiaowubao_payroll_name_keys(profile.value ->> 'name') as name_keys,
      array(
        select distinct source_id.value
        from pg_catalog.unnest(array[
          profile.value ->> 'jwbSourceRow',
          profile.value #>> '{jiaowubaoOpenApi,sourceId}',
          profile.value #>> '{historicalJwbSnapshot,currentAggregate,jwbSourceRow}',
          profile.value #>> '{historicalJwbSnapshot,retained,jwbSourceRow}'
        ]) source_id(value)
        where source_id.value ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      ) as source_ids
    from pg_catalog.jsonb_array_elements(p_teachers) profile(value)
    where profile.value ->> 'id' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      and nullif(pg_catalog.btrim(profile.value ->> 'name'), '') is not null
  ), roles as materialized (
    select event_row.calendar_id, event_row.event, role.value as teacher,
      role.ordinality as role_index,
      internal.jiaowubao_payroll_name_keys(role.value ->> 'name') as name_keys
    from internal.jiaowubao_completed_lesson_snapshot_schedule_events event_row
    cross join lateral pg_catalog.jsonb_array_elements(event_row.event -> 'teachers') with ordinality role(value, ordinality)
    where event_row.run_id = p_run_id
  ), candidates as (
    select role.*,
      coalesce((select pg_catalog.array_agg(distinct profile.teacher_id)
        from roster profile where role.teacher ->> 'id' = any(profile.source_ids)), array[]::text[]) as source_ids,
      coalesce((select pg_catalog.array_agg(distinct profile.teacher_id)
        from roster profile where profile.name_keys && role.name_keys), array[]::text[]) as name_ids
    from roles role
  ), resolved as (
    select candidate.*,
      case when pg_catalog.cardinality(candidate.source_ids) > 1
          or pg_catalog.cardinality(candidate.name_ids) > 1
          or (pg_catalog.cardinality(candidate.source_ids) = 1
            and pg_catalog.cardinality(candidate.name_ids) = 1
            and candidate.source_ids[1] is distinct from candidate.name_ids[1])
        then null else coalesce(candidate.source_ids[1], candidate.name_ids[1]) end as resolved_id,
      array(select distinct teacher_id from pg_catalog.unnest(candidate.source_ids || candidate.name_ids) teacher_id) as candidate_ids
    from candidates candidate
  ), by_teacher as (
    select candidate_id,
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'calendarId', role.calendar_id, 'event', role.event,
        'teacher', role.teacher, 'resolvedId', role.resolved_id
      ) order by role.calendar_id, role.role_index) as role_entries
    from resolved role
    cross join lateral pg_catalog.unnest(role.candidate_ids) candidate_id
    group by candidate_id
  )
  select pg_catalog.jsonb_build_object(
    'runId', p_run_id::text, 'revision', p_revision,
    'byTeacher', coalesce((select pg_catalog.jsonb_object_agg(candidate_id, role_entries)
      from by_teacher), '{}'::jsonb)
  )
$$;
revoke all on function internal.jiaowubao_payroll_source_role_index(uuid,text,jsonb) from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_payroll_source_summary(
  p_summary jsonb,
  p_teachers jsonb,
  p_source_role_index jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  month_value date;
  current_pointer internal.jiaowubao_completed_lesson_snapshot_current%rowtype;
  teacher_profile jsonb;
  teacher_id text := p_summary ->> 'teacherId';
  source_event record;
  event_count integer := 0;
  member_count integer;
  branch_count integer;
  trial_count integer;
  trial_value boolean;
  role_hour numeric;
  source_hours numeric := 0;
  trial_hours numeric := 0;
  calendars text[] := array[]::text[];
  expected_keys text[];
  submitted_keys text[];
begin
  if p_summary ->> 'source' is distinct from 'jiaowubao-completed-lessons'
     or coalesce(p_summary ->> 'month', '') !~ '^\d{4}-(0[1-9]|1[0-2])$'
     or coalesce(teacher_id, '') = ''
     or coalesce(p_summary ->> 'sourceRevision', '') !~ '^sha256:[a-f0-9]{64}$'
     or coalesce(p_summary ->> 'sourceProjectionRevision', '') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_summary -> 'lines') is distinct from 'array'
     or jsonb_typeof(p_teachers) is distinct from 'array'
     or jsonb_typeof(p_source_role_index) is distinct from 'object' then
    raise exception using errcode = '55000', message = 'jiaowubao_payroll_source_unverified';
  end if;
  month_value := to_date(p_summary ->> 'month' || '-01', 'YYYY-MM-DD');
  if to_char(month_value, 'YYYY-MM') is distinct from p_summary ->> 'month' then
    raise exception using errcode = '55000', message = 'jiaowubao_payroll_source_unverified';
  end if;
  select pointer.* into current_pointer
  from internal.jiaowubao_completed_lesson_snapshot_current pointer
  where pointer.api_source_key = 'jwb-open-api-completed-lessons'
    and pointer.period_month = month_value
  for share;
  if not found or current_pointer.revision is distinct from p_summary ->> 'sourceRevision'
     or p_source_role_index ->> 'runId' is distinct from current_pointer.run_id::text
     or p_source_role_index ->> 'revision' is distinct from current_pointer.revision then
    raise exception using errcode = '55000', message = 'jiaowubao_payroll_source_stale';
  end if;
  select profile.value into teacher_profile
  from jsonb_array_elements(p_teachers) profile(value)
  where profile.value ->> 'id' = teacher_id
  limit 1;
  if not found or (
    select count(*) from jsonb_array_elements(p_teachers) profile(value)
    where profile.value ->> 'id' = teacher_id
  ) <> 1 then
    raise exception using errcode = '55000', message = 'jiaowubao_payroll_teacher_unverified';
  end if;
  if teacher_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     or nullif(btrim(teacher_profile ->> 'name'), '') is null then
    raise exception using errcode = '55000', message = 'jiaowubao_payroll_teacher_unverified';
  end if;
  for source_event in
    select item.value ->> 'calendarId' as calendar_id,
      item.value -> 'event' as event,
      item.value -> 'teacher' as teacher,
      item.value ->> 'resolvedId' as resolved_id
    from pg_catalog.jsonb_array_elements(coalesce(p_source_role_index -> 'byTeacher' -> teacher_id, '[]'::jsonb)) item(value)
  loop
    if source_event.resolved_id is distinct from teacher_id then
      raise exception using errcode = '55000', message = 'jiaowubao_payroll_teacher_unverified';
    end if;
    if source_event.calendar_id = any(calendars)
       or jsonb_typeof(source_event.teacher -> 'hours') is distinct from 'number'
       or source_event.teacher ? 'hoursIssue' then
      raise exception using errcode = '55000', message = 'jiaowubao_payroll_teacher_hours_unresolved';
    end if;
    role_hour := (source_event.teacher ->> 'hours')::numeric;
    if role_hour not between 0 and 24 then
      raise exception using errcode = '55000', message = 'jiaowubao_payroll_teacher_hours_unresolved';
    end if;
    select count(*)::integer,
           count(distinct lesson.item ->> 'branchId')::integer,
           count(distinct lesson.item ->> 'isTrial')::integer,
           bool_or(lesson.item ->> 'isTrial' = 'true')
      into member_count, branch_count, trial_count, trial_value
    from internal.jiaowubao_completed_lesson_snapshot_items lesson
    where lesson.run_id = current_pointer.run_id
      and lesson.item ->> 'calendarId' = source_event.calendar_id;
    if member_count = 0 or branch_count <> 1 or trial_count <> 1
       or exists (
         select 1 from internal.jiaowubao_completed_lesson_snapshot_items lesson
         where lesson.run_id = current_pointer.run_id
           and lesson.item ->> 'calendarId' = source_event.calendar_id
           and (
             lesson.item ->> 'branchId' = '~'
             or lesson.item ->> 'lessonDate' is distinct from source_event.event ->> 'lessonDate'
             or (source_event.event ->> 'timeTitle' is not null and lesson.item ->> 'timeTitle' is not null
               and lesson.item ->> 'timeTitle' is distinct from source_event.event ->> 'timeTitle')
             or (source_event.event ->> 'courseTitle' is not null and lesson.item ->> 'courseTitle' is not null
               and lesson.item ->> 'courseTitle' is distinct from source_event.event ->> 'courseTitle')
             or (source_event.event ->> 'teamTitle' is not null and lesson.item ->> 'teamTitle' is not null
               and lesson.item ->> 'teamTitle' is distinct from source_event.event ->> 'teamTitle')
             or jsonb_array_length(lesson.item -> 'teachers') is distinct from jsonb_array_length(source_event.event -> 'teachers')
             or exists (
               select 1 from jsonb_array_elements(source_event.event -> 'teachers') schedule_teacher
               where not exists (
                 select 1 from jsonb_array_elements(lesson.item -> 'teachers') lesson_teacher
                 where lesson_teacher ->> 'role' = schedule_teacher ->> 'role'
                   and lesson_teacher ->> 'id' is not distinct from schedule_teacher ->> 'id'
                   and lesson_teacher ->> 'name' is not distinct from schedule_teacher ->> 'name'
               )
             )
             or jsonb_typeof(lesson.item -> 'hours') is distinct from 'number'
             or lesson.item ? 'hoursIssue'
             or case when jsonb_typeof(lesson.item -> 'hours') = 'number'
               then (lesson.item ->> 'hours')::numeric not between 0 and 24
               else true end
           )
       ) then
      raise exception using errcode = '55000', message = 'jiaowubao_payroll_student_hours_unresolved';
    end if;
    calendars := array_append(calendars, source_event.calendar_id);
    event_count := event_count + 1;
    source_hours := source_hours + role_hour;
    if trial_value then trial_hours := trial_hours + role_hour; end if;
  end loop;
  if event_count = 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_payroll_teacher_unverified';
  end if;
  select coalesce(array_agg(lesson.source_key order by lesson.source_key), array[]::text[])
    into expected_keys
  from internal.jiaowubao_completed_lesson_snapshot_items lesson
  where lesson.run_id = current_pointer.run_id
    and lesson.item ->> 'calendarId' = any(calendars);
  select coalesce(array_agg(line.value ->> 'sourceKey' order by line.value ->> 'sourceKey'), array[]::text[])
    into submitted_keys
  from jsonb_array_elements(p_summary -> 'lines') line(value);
  if expected_keys is distinct from submitted_keys
     or exists (
       select 1 from jsonb_array_elements(p_summary -> 'lines') line(value)
       left join internal.jiaowubao_completed_lesson_snapshot_items lesson
         on lesson.run_id = current_pointer.run_id
        and lesson.source_key = line.value ->> 'sourceKey'
       where line.value -> 'evidenceOnly' is distinct from 'true'::jsonb
         or lesson.source_key is null
         or jsonb_typeof(line.value -> 'hours') is distinct from 'number'
         or case when jsonb_typeof(line.value -> 'hours') = 'number'
           then (line.value ->> 'hours')::numeric is distinct from (lesson.item ->> 'hours')::numeric
           else true end
     )
     or jsonb_typeof(p_summary -> 'sourceHours') is distinct from 'number'
     or jsonb_typeof(p_summary -> 'teacherTotalHours') is distinct from 'number'
     or jsonb_typeof(p_summary -> 'sourceLessonCount') is distinct from 'number'
     or jsonb_typeof(p_summary -> 'trialLessons') is distinct from 'number'
     or jsonb_typeof(p_summary -> 'lessons') is distinct from 'number' then
    raise exception using errcode = '55000', message = 'jiaowubao_payroll_source_unverified';
  end if;
  if (p_summary ->> 'sourceHours')::numeric is distinct from round(source_hours, 4)
     or (p_summary ->> 'teacherTotalHours')::numeric is distinct from round(source_hours, 4)
     or (p_summary ->> 'sourceLessonCount')::numeric is distinct from event_count
     or (p_summary ->> 'trialLessons')::numeric is distinct from round(trial_hours, 4)
     or (p_summary ->> 'lessons')::numeric is distinct from round(source_hours - trial_hours, 4) then
    raise exception using errcode = '55000', message = 'jiaowubao_payroll_source_unverified';
  end if;
end;
$$;
revoke all on function internal.assert_jiaowubao_payroll_source_summary(jsonb,jsonb,jsonb) from public, anon, authenticated;

create or replace function public.put_scoped_ops_state(
  p_secret text,
  p_entity text,
  p_payload jsonb,
  p_expected_version bigint,
  p_actor text,
  p_scope_versions jsonb default null
)
returns table (
  entity text,
  payload jsonb,
  version bigint,
  updated_at timestamptz,
  updated_by text
)
language plpgsql security definer set search_path = '' as $$
declare
  saved public.ops_state%rowtype;
  current_payroll public.ops_state%rowtype;
  state_row public.ops_state%rowtype;
  students_row public.ops_state%rowtype;
  teachers_row public.ops_state%rowtype;
  candidate jsonb;
  previous jsonb;
  month_text text;
  active_month text;
  source_pointer internal.jiaowubao_completed_lesson_snapshot_current%rowtype;
  source_role_index jsonb;
  projection_text text;
  projection_revision text;
  has_changed_jiaowubao boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_entity = 'payroll' then
    if p_actor is distinct from 'Nixon' and p_actor is distinct from 'Ops Admin' then
      raise exception using errcode = '42501', message = 'jiaowubao_payroll_actor_forbidden';
    end if;
    if jsonb_typeof(p_payload) is distinct from 'array' or p_expected_version is null then
      raise exception using errcode = '55000', message = 'jiaowubao_payroll_source_unverified';
    end if;
    select state.* into current_payroll from public.ops_state state where state.entity = 'payroll';
    if not found then raise exception using errcode = 'P0002', message = 'payroll_ops_state_missing'; end if;
    for candidate in
      select entry.value from jsonb_array_elements(p_payload) entry(value)
      where entry.value ->> 'source' = 'jiaowubao-completed-lessons'
    loop
      select entry.value into previous
      from jsonb_array_elements(current_payroll.payload) entry(value)
      where entry.value ->> 'id' = candidate ->> 'id'
      limit 1;
      if previous is distinct from candidate then has_changed_jiaowubao := true; end if;
    end loop;
    if has_changed_jiaowubao then
      for state_row in
        select state.* from public.ops_state state
        where state.entity in ('bookings','students','teachers')
        order by state.entity
        for share
      loop
        if state_row.entity = 'students' then students_row := state_row; end if;
        if state_row.entity = 'teachers' then teachers_row := state_row; end if;
      end loop;
      if students_row.entity is null or teachers_row.entity is null
         or students_row.updated_at is null or teachers_row.updated_at is null
         or students_row.version < 0 or teachers_row.version < 0 then
        raise exception using errcode = '55000', message = 'jiaowubao_payroll_projection_unverified';
      end if;
      projection_text := format('[{"entity":"students","version":%s,"updatedAt":"%s"},{"entity":"teachers","version":%s,"updatedAt":"%s"}]',
        students_row.version,
        to_char(students_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        teachers_row.version,
        to_char(teachers_row.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
      projection_revision := 'sha256:' || encode(extensions.digest(projection_text, 'sha256'), 'hex');
      for month_text in
        select distinct entry.value ->> 'month'
        from jsonb_array_elements(p_payload) entry(value)
        where entry.value ->> 'source' = 'jiaowubao-completed-lessons'
          and not exists (
            select 1 from jsonb_array_elements(current_payroll.payload) prior(value)
            where prior.value ->> 'id' = entry.value ->> 'id'
              and prior.value = entry.value
          )
        order by 1
      loop
        if coalesce(month_text, '') !~ '^\d{4}-(0[1-9]|1[0-2])$' then
          raise exception using errcode = '55000', message = 'jiaowubao_payroll_source_unverified';
        end if;
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
          'jiaowubao-completed-lessons:' || (month_text || '-01')::date::text, 0
        ));
      end loop;
    end if;
    select state.* into current_payroll from public.ops_state state
    where state.entity = 'payroll' for update;
    if current_payroll.version is distinct from p_expected_version then
      raise exception using errcode = '40001', message = 'version_conflict';
    end if;
    if exists (
      select 1 from jsonb_array_elements(current_payroll.payload) prior(value)
      where prior.value ->> 'source' = 'jiaowubao-completed-lessons'
        and not exists (
          select 1 from jsonb_array_elements(p_payload) next(value)
          where next.value ->> 'id' = prior.value ->> 'id'
            and next.value ->> 'source' = 'jiaowubao-completed-lessons'
        )
    ) then
      raise exception using errcode = '55000', message = 'jiaowubao_payroll_source_cannot_change';
    end if;
    if has_changed_jiaowubao then
      for candidate in
        select entry.value from jsonb_array_elements(p_payload) entry(value)
        where entry.value ->> 'source' = 'jiaowubao-completed-lessons'
        order by entry.value ->> 'month'
      loop
        select entry.value into previous
        from jsonb_array_elements(current_payroll.payload) entry(value)
        where entry.value ->> 'id' = candidate ->> 'id'
        limit 1;
        if previous is distinct from candidate then
          if candidate ->> 'sourceProjectionRevision' is distinct from projection_revision then
            raise exception using errcode = '55000', message = 'jiaowubao_payroll_projection_stale';
          end if;
          if active_month is distinct from candidate ->> 'month' then
            active_month := candidate ->> 'month';
            select pointer.* into source_pointer
            from internal.jiaowubao_completed_lesson_snapshot_current pointer
            where pointer.api_source_key = 'jwb-open-api-completed-lessons'
              and pointer.period_month = (active_month || '-01')::date
            for share;
            if not found or source_pointer.revision is distinct from candidate ->> 'sourceRevision' then
              raise exception using errcode = '55000', message = 'jiaowubao_payroll_source_stale';
            end if;
            source_role_index := internal.jiaowubao_payroll_source_role_index(
              source_pointer.run_id,source_pointer.revision,teachers_row.payload);
          end if;
          perform internal.assert_jiaowubao_payroll_source_summary(candidate, teachers_row.payload, source_role_index);
        end if;
      end loop;
    end if;
  end if;
  select committed.* into saved
  from public.put_scoped_ops_state_without_authoritative_audit(
    p_secret, p_entity, p_payload, p_expected_version, p_actor, p_scope_versions
  ) committed;
  if not found then raise exception using errcode = 'P0002', message = 'ops_state_commit_missing'; end if;
  perform internal.append_operational_contract_audit(
    'ops_state.' || saved.entity || '.updated',
    saved.updated_by,
    'ops_state',
    saved.entity,
    jsonb_build_object(
      'versionBefore', p_expected_version,
      'versionAfter', saved.version,
      'payloadSha256', encode(extensions.digest(p_payload::text, 'sha256'), 'hex')
    )
  );
  return query select saved.entity, saved.payload, saved.version, saved.updated_at, saved.updated_by;
end;
$$;
revoke all on function public.put_scoped_ops_state(text,text,jsonb,bigint,text,jsonb) from public;
grant execute on function public.put_scoped_ops_state(text,text,jsonb,bigint,text,jsonb) to anon, authenticated;

commit;
