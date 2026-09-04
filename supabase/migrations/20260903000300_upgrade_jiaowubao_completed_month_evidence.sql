-- Upgrade the unpublished v1 completed-lesson source into a single atomic
-- monthly evidence revision containing two documented `over=1` feeds:
-- participant rows from query_lesson_list and role-credit rows from
-- query_schedule_list. The latter is deliberately a private sidecar: a group
-- lesson must never multiply a teacher's schedule credit by its learners.

alter table internal.jiaowubao_completed_lesson_snapshot_runs
  add column if not exists expected_schedule_page_count integer not null default 0 check (expected_schedule_page_count between 0 and 60),
  add column if not exists expected_schedule_row_count integer not null default 0 check (expected_schedule_row_count between 0 and 6000);

alter table internal.jiaowubao_completed_lesson_snapshot_current
  add column if not exists schedule_row_count integer not null default 0 check (schedule_row_count between 0 and 6000);

-- A v1 pointer proves only query_lesson_list. The new NOT NULL default cannot
-- distinguish that missing schedule capture from a genuinely empty completed
-- query_schedule_list result. Keep the immutable v1 run/pages as history, but
-- withdraw every non-composite current pointer so readers return `absent` and
-- require a fresh atomic dual-source publication. This also makes a resumed
-- migration fail closed if 001 was applied independently before this upgrade.
delete from internal.jiaowubao_completed_lesson_snapshot_current current_pointer
using internal.jiaowubao_completed_lesson_snapshot_runs source_run
where current_pointer.run_id = source_run.id
  and source_run.source_metadata ->> 'exportFormat'
    is distinct from 'jiaowubao-completed-month-evidence/v1';

create table if not exists internal.jiaowubao_completed_lesson_snapshot_schedule_pages (
  run_id uuid not null references internal.jiaowubao_completed_lesson_snapshot_runs(id) on delete restrict,
  page_index integer not null check (page_index between 0 and 59),
  page_sha256 text not null check (page_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  row_count integer not null check (row_count between 1 and 100),
  content_bytes integer not null check (content_bytes between 1 and 2097152),
  staged_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  primary key (run_id, page_index),
  check (jsonb_array_length(rows) = row_count)
);
alter table internal.jiaowubao_completed_lesson_snapshot_schedule_pages enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_snapshot_schedule_pages from public, anon, authenticated;

create table if not exists internal.jiaowubao_completed_lesson_snapshot_schedule_events (
  run_id uuid not null references internal.jiaowubao_completed_lesson_snapshot_runs(id) on delete restrict,
  page_index integer not null,
  item_index integer not null check (item_index between 0 and 99),
  source_key text not null check (source_key ~ '^jwb-open-api:schedule:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'),
  calendar_id text not null check (calendar_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'),
  canonical_json text not null check (octet_length(canonical_json) between 2 and 8192),
  item_sha256 text not null check (item_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  event jsonb not null check (jsonb_typeof(event) = 'object'),
  staged_at timestamptz not null default now(),
  primary key (run_id, page_index, item_index),
  unique (run_id, source_key),
  unique (run_id, calendar_id),
  foreign key (run_id, page_index) references internal.jiaowubao_completed_lesson_snapshot_schedule_pages(run_id, page_index) on delete restrict
);
create index if not exists jiaowubao_completed_lesson_schedule_events_lookup
  on internal.jiaowubao_completed_lesson_snapshot_schedule_events(run_id, calendar_id);
alter table internal.jiaowubao_completed_lesson_snapshot_schedule_events enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_snapshot_schedule_events from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_completed_lesson_snapshot_run()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or old.state in ('complete', 'aborted') then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_run_immutable';
  end if;
  if new.id is distinct from old.id
     or new.api_source_key is distinct from old.api_source_key
     or new.period_month is distinct from old.period_month
     or new.revision is distinct from old.revision
     or new.query is distinct from old.query
     or new.expected_page_count is distinct from old.expected_page_count
     or new.expected_row_count is distinct from old.expected_row_count
     or new.expected_schedule_page_count is distinct from old.expected_schedule_page_count
     or new.expected_schedule_row_count is distinct from old.expected_schedule_row_count
     or new.expected_current_revision is distinct from old.expected_current_revision
     or new.external_manifest_sha256 is distinct from old.external_manifest_sha256
     or new.source_metadata is distinct from old.source_metadata
     or new.staged_by is distinct from old.staged_by
     or new.staged_at is distinct from old.staged_at
     or new.staging_audit_id is distinct from old.staging_audit_id then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_run_immutable';
  end if;
  if new.state = 'complete' and old.state = 'staging'
     and new.canonical_rows_sha256 is not null and new.payload_sha256 is not null
     and new.completed_at is not null and new.completion_audit_id is not null
     and new.aborted_at is null and new.abort_audit_id is null then
    return new;
  end if;
  if new.state = 'aborted' and old.state = 'staging'
     and new.canonical_rows_sha256 is null and new.payload_sha256 is null
     and new.completed_at is null and new.completion_audit_id is null
     and new.aborted_at is not null and new.abort_audit_id is not null
     and pg_catalog.current_setting('internal.jiaowubao_completed_lesson_snapshot_abort_run_id', true) is not distinct from old.id::text then
    return new;
  end if;
  raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_run_immutable';
end;
$$;

create or replace function internal.guard_jiaowubao_completed_lesson_snapshot_schedule_page()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     and pg_catalog.current_setting('internal.jiaowubao_completed_lesson_snapshot_abort_run_id', true) is not distinct from old.run_id::text then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_schedule_page_immutable';
end;
$$;
drop trigger if exists guard_jiaowubao_completed_lesson_snapshot_schedule_page on internal.jiaowubao_completed_lesson_snapshot_schedule_pages;
create trigger guard_jiaowubao_completed_lesson_snapshot_schedule_page
before update or delete on internal.jiaowubao_completed_lesson_snapshot_schedule_pages
for each row execute function internal.guard_jiaowubao_completed_lesson_snapshot_schedule_page();
revoke all on function internal.guard_jiaowubao_completed_lesson_snapshot_schedule_page() from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_completed_lesson_snapshot_schedule_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     and pg_catalog.current_setting('internal.jiaowubao_completed_lesson_snapshot_abort_run_id', true) is not distinct from old.run_id::text then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_schedule_event_immutable';
end;
$$;
drop trigger if exists guard_jiaowubao_completed_lesson_snapshot_schedule_event on internal.jiaowubao_completed_lesson_snapshot_schedule_events;
create trigger guard_jiaowubao_completed_lesson_snapshot_schedule_event
before update or delete on internal.jiaowubao_completed_lesson_snapshot_schedule_events
for each row execute function internal.guard_jiaowubao_completed_lesson_snapshot_schedule_event();
revoke all on function internal.guard_jiaowubao_completed_lesson_snapshot_schedule_event() from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_completed_lesson_snapshot_envelope(p_envelope jsonb)
returns void language plpgsql stable set search_path = '' as $$
declare month_text text; month_start date; month_end date; expected_page_count integer; expected_row_count integer; expected_schedule_page_count integer; expected_schedule_row_count integer;
begin
  if p_envelope is null or jsonb_typeof(p_envelope) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  if p_envelope - ARRAY['apiSourceKey','month','revision','query','expectedPageCount','expectedRowCount','expectedSchedulePageCount','expectedScheduleRowCount','expectedCurrentRevision','externalManifestSha256','sourceMetadata']::text[] <> '{}'::jsonb
     or not (p_envelope ?& ARRAY['apiSourceKey','month','revision','query','expectedPageCount','expectedRowCount','expectedSchedulePageCount','expectedScheduleRowCount','expectedCurrentRevision','externalManifestSha256','sourceMetadata']::text[]) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  if jsonb_typeof(p_envelope -> 'apiSourceKey') is distinct from 'string'
     or p_envelope ->> 'apiSourceKey' is distinct from 'jwb-open-api-completed-lessons'
     or jsonb_typeof(p_envelope -> 'month') is distinct from 'string'
     or jsonb_typeof(p_envelope -> 'revision') is distinct from 'string'
     or coalesce(p_envelope ->> 'revision','') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'expectedPageCount') is distinct from 'number'
     or coalesce(p_envelope ->> 'expectedPageCount','') !~ '^(0|[1-9][0-9]?)$'
     or jsonb_typeof(p_envelope -> 'expectedRowCount') is distinct from 'number'
     or coalesce(p_envelope ->> 'expectedRowCount','') !~ '^(0|[1-9][0-9]{0,3})$'
     or jsonb_typeof(p_envelope -> 'expectedSchedulePageCount') is distinct from 'number'
     or coalesce(p_envelope ->> 'expectedSchedulePageCount','') !~ '^(0|[1-9][0-9]?)$'
     or jsonb_typeof(p_envelope -> 'expectedScheduleRowCount') is distinct from 'number'
     or coalesce(p_envelope ->> 'expectedScheduleRowCount','') !~ '^(0|[1-9][0-9]{0,3})$'
     or jsonb_typeof(p_envelope -> 'externalManifestSha256') is distinct from 'string'
     or p_envelope ->> 'externalManifestSha256' is distinct from p_envelope ->> 'revision'
     or coalesce(p_envelope ->> 'externalManifestSha256','') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'sourceMetadata') is distinct from 'object'
     or lower(p_envelope::text) ~ '"(sk|secret|token|password|authorization|cookie)"\s*:' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  if jsonb_typeof(p_envelope -> 'expectedCurrentRevision') is distinct from 'null' then
    if jsonb_typeof(p_envelope -> 'expectedCurrentRevision') is distinct from 'string'
       or coalesce(p_envelope ->> 'expectedCurrentRevision','') !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
    end if;
  end if;
  if (p_envelope -> 'sourceMetadata') - ARRAY['exportFormat','manifestSha256','lessonManifestSha256','lessonRecordsSha256','scheduleManifestSha256','scheduleRecordsSha256','joinRule']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'sourceMetadata') ?& ARRAY['exportFormat','manifestSha256','lessonManifestSha256','lessonRecordsSha256','scheduleManifestSha256','scheduleRecordsSha256','joinRule']::text[])
     or jsonb_typeof(p_envelope -> 'sourceMetadata' -> 'exportFormat') is distinct from 'string'
     or p_envelope -> 'sourceMetadata' ->> 'exportFormat' is distinct from 'jiaowubao-completed-month-evidence/v1'
     or jsonb_typeof(p_envelope -> 'sourceMetadata' -> 'manifestSha256') is distinct from 'string'
     or p_envelope -> 'sourceMetadata' ->> 'manifestSha256' is distinct from p_envelope ->> 'revision'
     or jsonb_typeof(p_envelope -> 'sourceMetadata' -> 'lessonManifestSha256') is distinct from 'string'
     or coalesce(p_envelope -> 'sourceMetadata' ->> 'lessonManifestSha256','') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'sourceMetadata' -> 'lessonRecordsSha256') is distinct from 'string'
     or coalesce(p_envelope -> 'sourceMetadata' ->> 'lessonRecordsSha256','') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'sourceMetadata' -> 'scheduleManifestSha256') is distinct from 'string'
     or coalesce(p_envelope -> 'sourceMetadata' ->> 'scheduleManifestSha256','') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'sourceMetadata' -> 'scheduleRecordsSha256') is distinct from 'string'
     or coalesce(p_envelope -> 'sourceMetadata' ->> 'scheduleRecordsSha256','') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'sourceMetadata' -> 'joinRule') is distinct from 'string'
     or p_envelope -> 'sourceMetadata' ->> 'joinRule' is distinct from 'schedule-cal-id-v1' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  -- The structural checks above complete before these casts. Keep conversion
  -- out of the boolean chain: PostgreSQL does not promise OR short-circuiting
  -- for malformed untrusted JSON values.
  expected_page_count := (p_envelope ->> 'expectedPageCount')::integer;
  expected_row_count := (p_envelope ->> 'expectedRowCount')::integer;
  expected_schedule_page_count := (p_envelope ->> 'expectedSchedulePageCount')::integer;
  expected_schedule_row_count := (p_envelope ->> 'expectedScheduleRowCount')::integer;
  if expected_page_count not between 0 and 60
     or expected_row_count not between 0 and 6000
     or expected_schedule_page_count not between 0 and 60
     or expected_schedule_row_count not between 0 and 6000
     or (expected_row_count = 0) is distinct from (expected_page_count = 0)
     or (expected_schedule_row_count = 0) is distinct from (expected_schedule_page_count = 0) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  month_text := p_envelope ->> 'month';
  if coalesce(month_text,'') !~ '^\d{4}-\d{2}$' then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid'; end if;
  month_start := to_date(month_text || '-01','YYYY-MM-DD');
  if to_char(month_start,'YYYY-MM') is distinct from month_text then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid'; end if;
  month_end := (month_start + interval '1 month - 1 day')::date;
  if jsonb_typeof(p_envelope -> 'query') is distinct from 'object'
     or (p_envelope -> 'query') - ARRAY['lessons','schedules']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'query') ?& ARRAY['lessons','schedules']::text[])
     or jsonb_typeof(p_envelope -> 'query' -> 'lessons') is distinct from 'object'
     or (p_envelope -> 'query' -> 'lessons') - ARRAY['start','end','sign','over','limit']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'query' -> 'lessons') ?& ARRAY['start','end','sign','over','limit']::text[])
     or jsonb_typeof(p_envelope -> 'query' -> 'lessons' -> 'start') is distinct from 'string'
     or jsonb_typeof(p_envelope -> 'query' -> 'lessons' -> 'end') is distinct from 'string'
     or jsonb_typeof(p_envelope -> 'query' -> 'lessons' -> 'sign') is distinct from 'number'
     or jsonb_typeof(p_envelope -> 'query' -> 'lessons' -> 'over') is distinct from 'number'
     or jsonb_typeof(p_envelope -> 'query' -> 'lessons' -> 'limit') is distinct from 'number'
     or p_envelope -> 'query' -> 'lessons' ->> 'start' is distinct from to_char(month_start,'YYYY-MM-DD')
     or p_envelope -> 'query' -> 'lessons' ->> 'end' is distinct from to_char(month_end,'YYYY-MM-DD')
     or p_envelope -> 'query' -> 'lessons' ->> 'sign' is distinct from '-1'
     or p_envelope -> 'query' -> 'lessons' ->> 'over' is distinct from '1'
     or p_envelope -> 'query' -> 'lessons' ->> 'limit' is distinct from '100'
     or jsonb_typeof(p_envelope -> 'query' -> 'schedules') is distinct from 'object'
     or (p_envelope -> 'query' -> 'schedules') - ARRAY['start','end','over','limit','order']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'query' -> 'schedules') ?& ARRAY['start','end','over','limit','order']::text[])
     or jsonb_typeof(p_envelope -> 'query' -> 'schedules' -> 'start') is distinct from 'string'
     or jsonb_typeof(p_envelope -> 'query' -> 'schedules' -> 'end') is distinct from 'string'
     or jsonb_typeof(p_envelope -> 'query' -> 'schedules' -> 'over') is distinct from 'number'
     or jsonb_typeof(p_envelope -> 'query' -> 'schedules' -> 'limit') is distinct from 'number'
     or jsonb_typeof(p_envelope -> 'query' -> 'schedules' -> 'order') is distinct from 'string'
     or p_envelope -> 'query' -> 'schedules' ->> 'start' is distinct from to_char(month_start,'YYYY-MM-DD')
     or p_envelope -> 'query' -> 'schedules' ->> 'end' is distinct from to_char(month_end,'YYYY-MM-DD')
     or p_envelope -> 'query' -> 'schedules' ->> 'over' is distinct from '1'
     or p_envelope -> 'query' -> 'schedules' ->> 'limit' is distinct from '100'
     or p_envelope -> 'query' -> 'schedules' ->> 'order' is distinct from 'asc' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
end;
$$;

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
          or coalesce(wrapper ->> 'sourceKey','') !~ '^jwb-open-api:lesson:[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or jsonb_typeof(wrapper -> 'record') is distinct from 'object'
          or wrapper -> 'record' - ARRAY['kind','sourceKey','completed','branchId','calendarId','memberId','memberName','lessonDate','timeTitle','hours','lessonType','isTrial','attendanceCode','attendanceTitle','courseId','courseTitle','teamId','teamTitle','teachers','completedAt']::text[] <> '{}'::jsonb
          or not (wrapper -> 'record' ?& ARRAY['kind','sourceKey','completed','branchId','calendarId','memberId','memberName','lessonDate','timeTitle','hours','lessonType','isTrial','attendanceCode','attendanceTitle','courseId','courseTitle','teamId','teamTitle','teachers','completedAt']::text[])
          or wrapper -> 'record' ->> 'kind' is distinct from 'lesson'
          or wrapper -> 'record' ->> 'sourceKey' is distinct from wrapper ->> 'sourceKey'
          or wrapper -> 'record' -> 'completed' is distinct from 'true'::jsonb
          or coalesce(wrapper -> 'record' ->> 'branchId','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or coalesce(wrapper -> 'record' ->> 'calendarId','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or coalesce(wrapper -> 'record' ->> 'memberId','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or wrapper -> 'record' ->> 'sourceKey' is distinct from 'jwb-open-api:lesson:' || wrapper -> 'record' ->> 'branchId' || ':' || wrapper -> 'record' ->> 'calendarId' || ':' || wrapper -> 'record' ->> 'memberId'
          or coalesce(wrapper -> 'record' ->> 'lessonDate','') !~ '^\d{4}-\d{2}-\d{2}$'
          or wrapper -> 'record' ->> 'lessonDate' < month_start or wrapper -> 'record' ->> 'lessonDate' > month_end
          or case when jsonb_typeof(wrapper -> 'record' -> 'lessonDate') = 'string'
                    and wrapper -> 'record' ->> 'lessonDate' ~ '^\d{4}-\d{2}-\d{2}$'
                 then to_char(to_date(wrapper -> 'record' ->> 'lessonDate','YYYY-MM-DD'),'YYYY-MM-DD') is distinct from wrapper -> 'record' ->> 'lessonDate'
                 else true end
          or case when jsonb_typeof(wrapper -> 'record' -> 'hours') = 'number'
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
          or wrapper -> 'record' - ARRAY['kind','sourceKey','completed','calendarId','lessonDate','timeTitle','courseId','courseTitle','teamId','teamTitle','teachers','completedAt']::text[] <> '{}'::jsonb
          or not (wrapper -> 'record' ?& ARRAY['kind','sourceKey','completed','calendarId','lessonDate','timeTitle','courseId','courseTitle','teamId','teamTitle','teachers','completedAt']::text[])
          or wrapper -> 'record' ->> 'kind' is distinct from 'schedule'
          or wrapper -> 'record' ->> 'sourceKey' is distinct from wrapper ->> 'sourceKey'
          or wrapper -> 'record' -> 'completed' is distinct from 'true'::jsonb
          or coalesce(wrapper -> 'record' ->> 'calendarId','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or wrapper -> 'record' ->> 'sourceKey' is distinct from 'jwb-open-api:schedule:' || wrapper -> 'record' ->> 'calendarId'
          or coalesce(wrapper -> 'record' ->> 'lessonDate','') !~ '^\d{4}-\d{2}-\d{2}$'
          or wrapper -> 'record' ->> 'lessonDate' < month_start or wrapper -> 'record' ->> 'lessonDate' > month_end
          or case when jsonb_typeof(wrapper -> 'record' -> 'lessonDate') = 'string'
                    and wrapper -> 'record' ->> 'lessonDate' ~ '^\d{4}-\d{2}-\d{2}$'
                 then to_char(to_date(wrapper -> 'record' ->> 'lessonDate','YYYY-MM-DD'),'YYYY-MM-DD') is distinct from wrapper -> 'record' ->> 'lessonDate'
                 else true end
          or jsonb_typeof(wrapper -> 'record' -> 'teachers') is distinct from 'array'
          or jsonb_array_length(wrapper -> 'record' -> 'teachers') > 3
          or exists (select 1 from jsonb_array_elements(wrapper -> 'record' -> 'teachers') teacher where jsonb_typeof(teacher) is distinct from 'object' or teacher - ARRAY['role','id','name','hours']::text[] <> '{}'::jsonb or not (teacher ?& ARRAY['role','id','name','hours']::text[]) or teacher ->> 'role' not in ('primary','assistant','third') or jsonb_typeof(teacher -> 'id') not in ('string','null') or jsonb_typeof(teacher -> 'name') not in ('string','null') or case when jsonb_typeof(teacher -> 'hours') = 'null' then false when jsonb_typeof(teacher -> 'hours') = 'number' and teacher ->> 'hours' ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$' then (teacher ->> 'hours')::numeric not between 0 and 24 else true end)
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

create or replace function public.get_jiaowubao_completed_lesson_snapshot_preflight(p_secret text, p_month text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare month_value date; saved internal.jiaowubao_completed_lesson_snapshot_current%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or coalesce(p_month,'') !~ '^\d{4}-\d{2}$' then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_preflight_forbidden'; end if;
  month_value := to_date(p_month || '-01','YYYY-MM-DD');
  if to_char(month_value,'YYYY-MM') is distinct from p_month then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  select * into saved from internal.jiaowubao_completed_lesson_snapshot_current current_pointer where current_pointer.api_source_key='jwb-open-api-completed-lessons' and current_pointer.period_month=month_value;
  return jsonb_build_object('apiSourceKey','jwb-open-api-completed-lessons','month',p_month,'current',case when found then jsonb_build_object('revision',saved.revision,'rowCount',saved.row_count,'scheduleRowCount',saved.schedule_row_count,'publishedAt',saved.published_at) else null end);
end;
$$;

create or replace function public.begin_jiaowubao_completed_lesson_snapshot_ingest(p_secret text, p_envelope jsonb, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.jiaowubao_completed_lesson_snapshot_runs%rowtype; audit_id uuid; supersede_audit_id uuid; run_id uuid := gen_random_uuid(); month_value date; expected_page_count integer; expected_row_count integer; expected_schedule_page_count integer; expected_schedule_row_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_actor_forbidden'; end if;
  perform internal.assert_jiaowubao_completed_lesson_snapshot_envelope(p_envelope);
  expected_page_count := (p_envelope ->> 'expectedPageCount')::integer;
  expected_row_count := (p_envelope ->> 'expectedRowCount')::integer;
  expected_schedule_page_count := (p_envelope ->> 'expectedSchedulePageCount')::integer;
  expected_schedule_row_count := (p_envelope ->> 'expectedScheduleRowCount')::integer;
  month_value := to_date((p_envelope ->> 'month') || '-01','YYYY-MM-DD');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-completed-lessons:' || month_value::text, 0));
  select * into saved from internal.jiaowubao_completed_lesson_snapshot_runs run_row where run_row.period_month=month_value and run_row.revision=p_envelope ->> 'revision' and run_row.state in ('staging','complete') for update;
  if found then
    if saved.query is not distinct from p_envelope -> 'query'
       and saved.expected_page_count=expected_page_count
       and saved.expected_row_count=expected_row_count
       and saved.expected_schedule_page_count=expected_schedule_page_count
       and saved.expected_schedule_row_count=expected_schedule_row_count
       and saved.expected_current_revision is not distinct from p_envelope ->> 'expectedCurrentRevision'
       and saved.external_manifest_sha256 is not distinct from p_envelope ->> 'externalManifestSha256'
       and saved.source_metadata is not distinct from p_envelope -> 'sourceMetadata' then
      return jsonb_build_object('runId',saved.id,'state',saved.state,'replayed',true);
    end if;
    if saved.state='staging'
       and saved.query is not distinct from p_envelope -> 'query'
       and saved.expected_page_count=expected_page_count
       and saved.expected_row_count=expected_row_count
       and saved.expected_schedule_page_count=expected_schedule_page_count
       and saved.expected_schedule_row_count=expected_schedule_row_count
       and saved.external_manifest_sha256 is not distinct from p_envelope ->> 'externalManifestSha256'
       and saved.source_metadata is not distinct from p_envelope -> 'sourceMetadata'
       and saved.expected_current_revision is distinct from p_envelope ->> 'expectedCurrentRevision' then
      supersede_audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot_ingest.superseded',p_actor,'jiaowubao_completed_lesson_snapshot_run',saved.id::text,jsonb_build_object('month',to_char(month_value,'YYYY-MM'),'revision',saved.revision));
      perform pg_catalog.set_config('internal.jiaowubao_completed_lesson_snapshot_abort_run_id',saved.id::text,true);
      delete from internal.jiaowubao_completed_lesson_snapshot_schedule_events where run_id=saved.id;
      delete from internal.jiaowubao_completed_lesson_snapshot_schedule_pages where run_id=saved.id;
      delete from internal.jiaowubao_completed_lesson_snapshot_items where run_id=saved.id;
      delete from internal.jiaowubao_completed_lesson_snapshot_pages where run_id=saved.id;
      update internal.jiaowubao_completed_lesson_snapshot_runs set state='aborted',aborted_at=clock_timestamp(),abort_audit_id=supersede_audit_id where id=saved.id;
    else
      raise exception using errcode='23505', message='jiaowubao_completed_lesson_snapshot_envelope_conflict';
    end if;
  end if;
  audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot_ingest.started',p_actor,'jiaowubao_completed_lesson_snapshot_run',run_id::text,jsonb_build_object('month',p_envelope ->> 'month','revision',p_envelope ->> 'revision','expectedPageCount',expected_page_count,'expectedRowCount',expected_row_count,'expectedSchedulePageCount',expected_schedule_page_count,'expectedScheduleRowCount',expected_schedule_row_count));
  insert into internal.jiaowubao_completed_lesson_snapshot_runs(id,api_source_key,period_month,revision,query,expected_page_count,expected_row_count,expected_schedule_page_count,expected_schedule_row_count,expected_current_revision,external_manifest_sha256,source_metadata,staged_by,staging_audit_id)
  values(run_id,'jwb-open-api-completed-lessons',month_value,p_envelope ->> 'revision',p_envelope -> 'query',expected_page_count,expected_row_count,expected_schedule_page_count,expected_schedule_row_count,p_envelope ->> 'expectedCurrentRevision',p_envelope ->> 'externalManifestSha256',p_envelope -> 'sourceMetadata',p_actor,audit_id);
  return jsonb_build_object('runId',run_id,'state','staging','replayed',false);
end;
$$;

create or replace function public.stage_jiaowubao_completed_lesson_snapshot_schedule_page(p_secret text, p_run_id uuid, p_page_index integer, p_rows jsonb, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_completed_lesson_snapshot_runs%rowtype; saved internal.jiaowubao_completed_lesson_snapshot_schedule_pages%rowtype; audit_id uuid; page_hash text; row_count_value integer;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501', message='invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or p_page_index is null or p_page_index not between 0 and 59 then raise exception using errcode='42501', message='jiaowubao_completed_lesson_snapshot_schedule_stage_forbidden'; end if;
  select * into run_state from internal.jiaowubao_completed_lesson_snapshot_runs run_row where run_row.id=p_run_id for update;
  if not found then raise exception using errcode='P0002', message='jiaowubao_completed_lesson_snapshot_run_not_found'; end if;
  if run_state.state is distinct from 'staging' then raise exception using errcode='55000', message='jiaowubao_completed_lesson_snapshot_run_not_staging'; end if;
  if p_page_index >= run_state.expected_schedule_page_count then raise exception using errcode='22023', message='jiaowubao_completed_lesson_snapshot_schedule_page_index_invalid'; end if;
  perform internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page(p_rows,run_state.period_month);
  page_hash := 'sha256:' || encode(extensions.digest(p_rows::text,'sha256'),'hex');
  row_count_value := jsonb_array_length(p_rows);
  select * into saved from internal.jiaowubao_completed_lesson_snapshot_schedule_pages page_row where page_row.run_id=p_run_id and page_row.page_index=p_page_index for update;
  if found then
    if saved.rows is distinct from p_rows then raise exception using errcode='23505', message='jiaowubao_completed_lesson_snapshot_schedule_page_conflict'; end if;
    return jsonb_build_object('runId',p_run_id,'pageIndex',p_page_index,'rowCount',saved.row_count,'replayed',true);
  end if;
  audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot_ingest.schedule_page_staged',p_actor,'jiaowubao_completed_lesson_snapshot_run',p_run_id::text,jsonb_build_object('pageIndex',p_page_index,'rowCount',row_count_value,'pageSha256',page_hash));
  insert into internal.jiaowubao_completed_lesson_snapshot_schedule_pages(run_id,page_index,page_sha256,rows,row_count,content_bytes,audit_id) values(p_run_id,p_page_index,page_hash,p_rows,row_count_value,octet_length(p_rows::text),audit_id);
  insert into internal.jiaowubao_completed_lesson_snapshot_schedule_events(run_id,page_index,item_index,source_key,calendar_id,canonical_json,item_sha256,event)
  select p_run_id,p_page_index,ordinality-1,wrapper ->> 'sourceKey',wrapper -> 'record' ->> 'calendarId',wrapper::text,'sha256:' || encode(extensions.digest(wrapper::text,'sha256'),'hex'),wrapper -> 'record'
  from jsonb_array_elements(p_rows) with ordinality source_rows(wrapper, ordinality);
  return jsonb_build_object('runId',p_run_id,'pageIndex',p_page_index,'rowCount',row_count_value,'replayed',false);
end;
$$;
revoke all on function public.stage_jiaowubao_completed_lesson_snapshot_schedule_page(text,uuid,integer,jsonb,text) from public, anon, authenticated;
grant execute on function public.stage_jiaowubao_completed_lesson_snapshot_schedule_page(text,uuid,integer,jsonb,text) to anon, authenticated;

create or replace function public.complete_jiaowubao_completed_lesson_snapshot_ingest(p_secret text, p_run_id uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_completed_lesson_snapshot_runs%rowtype; current_row internal.jiaowubao_completed_lesson_snapshot_current%rowtype; period_month_value date; observed_current_revision text; lesson_page_count integer; lesson_row_count integer; schedule_page_count integer; schedule_row_count integer; rows_hash text; payload_hash text; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501', message='invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' then raise exception using errcode='42501', message='jiaowubao_completed_lesson_snapshot_complete_forbidden'; end if;
  -- Every function that needs both locks takes the period advisory lock first.
  -- Reading this immutable period without a row lock avoids a begin/complete
  -- lock-order deadlock while the later FOR UPDATE protects the state change.
  select period_month into period_month_value from internal.jiaowubao_completed_lesson_snapshot_runs run_row where run_row.id=p_run_id;
  if not found then raise exception using errcode='P0002', message='jiaowubao_completed_lesson_snapshot_run_not_found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-completed-lessons:' || period_month_value::text,0));
  select * into run_state from internal.jiaowubao_completed_lesson_snapshot_runs run_row where run_row.id=p_run_id for update;
  if not found then raise exception using errcode='P0002', message='jiaowubao_completed_lesson_snapshot_run_not_found'; end if;
  if run_state.state='complete' then return jsonb_build_object('runId',p_run_id,'state','complete','rowCount',run_state.expected_row_count,'scheduleRowCount',run_state.expected_schedule_row_count,'rowsSha256',run_state.canonical_rows_sha256,'payloadSha256',run_state.payload_sha256,'replayed',true); end if;
  if run_state.state is distinct from 'staging' then raise exception using errcode='55000', message='jiaowubao_completed_lesson_snapshot_run_not_staging'; end if;
  if run_state.period_month is distinct from period_month_value then raise exception using errcode='55000', message='jiaowubao_completed_lesson_snapshot_period_invalid'; end if;
  select * into current_row from internal.jiaowubao_completed_lesson_snapshot_current current_pointer where current_pointer.api_source_key='jwb-open-api-completed-lessons' and current_pointer.period_month=run_state.period_month for update;
  observed_current_revision := case when found then current_row.revision else null end;
  if observed_current_revision is distinct from run_state.expected_current_revision then raise exception using errcode='55000', message='jiaowubao_completed_lesson_snapshot_current_pointer_conflict'; end if;
  select count(*)::integer,coalesce(sum(row_count),0)::integer into lesson_page_count,lesson_row_count from internal.jiaowubao_completed_lesson_snapshot_pages where run_id=p_run_id;
  select count(*)::integer,coalesce(sum(row_count),0)::integer into schedule_page_count,schedule_row_count from internal.jiaowubao_completed_lesson_snapshot_schedule_pages where run_id=p_run_id;
  if lesson_page_count <> run_state.expected_page_count or lesson_row_count <> run_state.expected_row_count or exists(select 1 from generate_series(0,run_state.expected_page_count-1) expected_page where not exists(select 1 from internal.jiaowubao_completed_lesson_snapshot_pages where run_id=p_run_id and page_index=expected_page)) then raise exception using errcode='55000', message='jiaowubao_completed_lesson_snapshot_pages_incomplete'; end if;
  if schedule_page_count <> run_state.expected_schedule_page_count or schedule_row_count <> run_state.expected_schedule_row_count or exists(select 1 from generate_series(0,run_state.expected_schedule_page_count-1) expected_page where not exists(select 1 from internal.jiaowubao_completed_lesson_snapshot_schedule_pages where run_id=p_run_id and page_index=expected_page)) then raise exception using errcode='55000', message='jiaowubao_completed_lesson_snapshot_schedule_pages_incomplete'; end if;
  select 'sha256:' || encode(extensions.digest(coalesce((select string_agg(canonical_json,'' order by page_index,item_index) from internal.jiaowubao_completed_lesson_snapshot_items where run_id=p_run_id),'') || '|' || coalesce((select string_agg(canonical_json,'' order by page_index,item_index) from internal.jiaowubao_completed_lesson_snapshot_schedule_events where run_id=p_run_id),''),'sha256'),'hex') into rows_hash;
  select 'sha256:' || encode(extensions.digest(coalesce((select string_agg(page_sha256,'' order by page_index) from internal.jiaowubao_completed_lesson_snapshot_pages where run_id=p_run_id),'') || '|' || coalesce((select string_agg(page_sha256,'' order by page_index) from internal.jiaowubao_completed_lesson_snapshot_schedule_pages where run_id=p_run_id),''),'sha256'),'hex') into payload_hash;
  audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot_ingest.completed',p_actor,'jiaowubao_completed_lesson_snapshot_run',p_run_id::text,jsonb_build_object('month',to_char(run_state.period_month,'YYYY-MM'),'revision',run_state.revision,'pageCount',lesson_page_count,'rowCount',lesson_row_count,'schedulePageCount',schedule_page_count,'scheduleRowCount',schedule_row_count,'rowsSha256',rows_hash,'payloadSha256',payload_hash));
  update internal.jiaowubao_completed_lesson_snapshot_runs set state='complete',canonical_rows_sha256=rows_hash,payload_sha256=payload_hash,completed_at=clock_timestamp(),completion_audit_id=audit_id where id=p_run_id;
  insert into internal.jiaowubao_completed_lesson_snapshot_current(api_source_key,period_month,run_id,revision,row_count,schedule_row_count,rows_sha256,payload_sha256,audit_id) values('jwb-open-api-completed-lessons',run_state.period_month,p_run_id,run_state.revision,lesson_row_count,schedule_row_count,rows_hash,payload_hash,audit_id)
  on conflict(api_source_key,period_month) do update set run_id=excluded.run_id,revision=excluded.revision,row_count=excluded.row_count,schedule_row_count=excluded.schedule_row_count,rows_sha256=excluded.rows_sha256,payload_sha256=excluded.payload_sha256,published_at=clock_timestamp(),audit_id=excluded.audit_id;
  return jsonb_build_object('runId',p_run_id,'state','complete','rowCount',lesson_row_count,'scheduleRowCount',schedule_row_count,'rowsSha256',rows_hash,'payloadSha256',payload_hash,'replayed',false);
end;
$$;

create or replace function public.abort_jiaowubao_completed_lesson_snapshot_ingest(p_secret text, p_run_id uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_completed_lesson_snapshot_runs%rowtype; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501', message='invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' then raise exception using errcode='42501', message='jiaowubao_completed_lesson_snapshot_abort_forbidden'; end if;
  select * into run_state from internal.jiaowubao_completed_lesson_snapshot_runs run_row where run_row.id=p_run_id for update;
  if not found then raise exception using errcode='P0002', message='jiaowubao_completed_lesson_snapshot_run_not_found'; end if;
  if run_state.staged_by is distinct from p_actor or run_state.state is distinct from 'staging' then raise exception using errcode='55000', message='jiaowubao_completed_lesson_snapshot_run_not_staging'; end if;
  audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot_ingest.aborted',p_actor,'jiaowubao_completed_lesson_snapshot_run',p_run_id::text,jsonb_build_object('month',to_char(run_state.period_month,'YYYY-MM'),'revision',run_state.revision));
  perform pg_catalog.set_config('internal.jiaowubao_completed_lesson_snapshot_abort_run_id',p_run_id::text,true);
  delete from internal.jiaowubao_completed_lesson_snapshot_schedule_events where run_id=p_run_id;
  delete from internal.jiaowubao_completed_lesson_snapshot_schedule_pages where run_id=p_run_id;
  delete from internal.jiaowubao_completed_lesson_snapshot_items where run_id=p_run_id;
  delete from internal.jiaowubao_completed_lesson_snapshot_pages where run_id=p_run_id;
  update internal.jiaowubao_completed_lesson_snapshot_runs set state='aborted',aborted_at=clock_timestamp(),abort_audit_id=audit_id where id=p_run_id;
  return jsonb_build_object('runId',p_run_id,'state','aborted');
end;
$$;

create or replace function public.confirm_jiaowubao_completed_lesson_snapshot_current(p_secret text, p_month text, p_revision text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare month_value date; current_row internal.jiaowubao_completed_lesson_snapshot_current%rowtype; confirmation_audit_id uuid; confirmed_at timestamptz := clock_timestamp();
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501', message='invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or coalesce(p_month,'') !~ '^\d{4}-\d{2}$' or coalesce(p_revision,'') !~ '^sha256:[a-f0-9]{64}$' then raise exception using errcode='42501', message='jiaowubao_completed_lesson_snapshot_confirmation_forbidden'; end if;
  month_value := to_date(p_month || '-01','YYYY-MM-DD');
  if to_char(month_value,'YYYY-MM') is distinct from p_month then raise exception using errcode='22023', message='jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-completed-lessons:' || month_value::text,0));
  select * into current_row from internal.jiaowubao_completed_lesson_snapshot_current current_pointer where current_pointer.api_source_key='jwb-open-api-completed-lessons' and current_pointer.period_month=month_value for update;
  if not found then raise exception using errcode='P0002', message='jiaowubao_completed_lesson_snapshot_current_not_found'; end if;
  if current_row.revision is distinct from p_revision then raise exception using errcode='55000', message='jiaowubao_completed_lesson_snapshot_current_pointer_conflict'; end if;
  confirmation_audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot.confirmed_unchanged',p_actor,'jiaowubao_completed_lesson_snapshot_run',current_row.run_id::text,jsonb_build_object('month',p_month,'revision',p_revision,'rowCount',current_row.row_count,'scheduleRowCount',current_row.schedule_row_count,'confirmedAt',confirmed_at));
  -- A confirmation is audit activity, not a new source publication. Keeping
  -- published_at immutable lets independently paged lesson/schedule readers
  -- prove that they observed the same composite revision.
  update internal.jiaowubao_completed_lesson_snapshot_current set audit_id=confirmation_audit_id where api_source_key='jwb-open-api-completed-lessons' and period_month=month_value;
  return jsonb_build_object('confirmed',true,'revision',p_revision,'rowCount',current_row.row_count,'scheduleRowCount',current_row.schedule_row_count,'publishedAt',current_row.published_at);
end;
$$;

create or replace function public.get_jiaowubao_completed_lesson_snapshot_schedule_page(p_secret text, p_month text, p_page_index integer, p_expected_revision text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare month_value date; current_row internal.jiaowubao_completed_lesson_snapshot_current%rowtype; page_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501', message='invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or coalesce(p_month,'') !~ '^\d{4}-\d{2}$' or p_page_index is null or p_page_index not between 0 and 23 or (p_page_index > 0 and p_expected_revision is null) or (p_expected_revision is not null and p_expected_revision !~ '^sha256:[a-f0-9]{64}$') then raise exception using errcode='42501', message='jiaowubao_completed_lesson_snapshot_schedule_reader_forbidden'; end if;
  month_value := to_date(p_month || '-01','YYYY-MM-DD');
  if to_char(month_value,'YYYY-MM') is distinct from p_month then raise exception using errcode='22023', message='jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  select * into current_row from internal.jiaowubao_completed_lesson_snapshot_current current_pointer where current_pointer.api_source_key='jwb-open-api-completed-lessons' and current_pointer.period_month=month_value;
  if not found then
    if p_page_index <> 0 or p_expected_revision is not null then raise exception using errcode='22023', message='jiaowubao_completed_lesson_snapshot_schedule_page_invalid'; end if;
    return jsonb_build_object('state','absent','month',p_month,'revision',null,'rowCount',0,'pageIndex',0,'pageCount',0,'publishedAt',null,'items','[]'::jsonb);
  end if;
  page_count := case when current_row.schedule_row_count=0 then 0 else ceil(current_row.schedule_row_count::numeric / 250)::integer end;
  if p_expected_revision is not null and current_row.revision is distinct from p_expected_revision then return jsonb_build_object('state','reset','month',p_month,'revision',current_row.revision,'rowCount',current_row.schedule_row_count,'pageIndex',p_page_index,'pageCount',page_count,'publishedAt',current_row.published_at,'items','[]'::jsonb); end if;
  if (current_row.schedule_row_count=0 and p_page_index <> 0) or (current_row.schedule_row_count > 0 and p_page_index >= page_count) then raise exception using errcode='22023', message='jiaowubao_completed_lesson_snapshot_schedule_page_invalid'; end if;
  return jsonb_build_object('state','complete','month',p_month,'revision',current_row.revision,'rowCount',current_row.schedule_row_count,'pageIndex',p_page_index,'pageCount',page_count,'publishedAt',current_row.published_at,'items',coalesce((select jsonb_agg(jsonb_build_object('sourceKey',event_row.source_key,'record',event_row.event) order by event_row.page_index,event_row.item_index) from (select source_key,event,page_index,item_index from internal.jiaowubao_completed_lesson_snapshot_schedule_events where run_id=current_row.run_id order by page_index,item_index offset p_page_index * 250 limit 250) event_row),'[]'::jsonb));
end;
$$;
revoke all on function public.get_jiaowubao_completed_lesson_snapshot_schedule_page(text,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.get_jiaowubao_completed_lesson_snapshot_schedule_page(text,text,integer,text,text) to anon, authenticated;

comment on table internal.jiaowubao_completed_lesson_snapshot_schedule_events is 'Private fixed-month query_schedule_list(over=1) role-hour evidence; joined to lesson participants only as a reconciled observation.';
