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

commit;
