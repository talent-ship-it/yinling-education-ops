-- Immutable, period-scoped evidence for the monthly 教务宝 completed-lesson
-- worksheet. This is intentionally independent from schedule authority and
-- ops_state: importing a source fact must never change contract hours,
-- balances, bookings, payroll approvals, students, or teachers.

create table if not exists internal.jiaowubao_completed_lesson_snapshot_runs (
  id uuid primary key default gen_random_uuid(),
  api_source_key text not null check (api_source_key = 'jwb-open-api-completed-lessons'),
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  revision text not null check (revision ~ '^sha256:[a-f0-9]{64}$'),
  query jsonb not null check (jsonb_typeof(query) = 'object' and octet_length(query::text) between 2 and 32768),
  expected_page_count integer not null check (expected_page_count between 0 and 60),
  expected_row_count integer not null check (expected_row_count between 0 and 6000),
  expected_current_revision text check (expected_current_revision is null or expected_current_revision ~ '^sha256:[a-f0-9]{64}$'),
  external_manifest_sha256 text not null check (external_manifest_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  source_metadata jsonb not null check (jsonb_typeof(source_metadata) = 'object' and octet_length(source_metadata::text) between 2 and 32768),
  state text not null default 'staging' check (state in ('staging', 'complete', 'aborted')),
  canonical_rows_sha256 text check (canonical_rows_sha256 is null or canonical_rows_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  payload_sha256 text check (payload_sha256 is null or payload_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  staged_by text not null check (staged_by = btrim(staged_by) and staged_by = 'Ops Admin'),
  staged_at timestamptz not null default now(),
  staging_audit_id uuid not null references internal.operational_contract_audit(id),
  completed_at timestamptz,
  completion_audit_id uuid references internal.operational_contract_audit(id),
  aborted_at timestamptz,
  abort_audit_id uuid references internal.operational_contract_audit(id),
  check (
    (state = 'staging' and canonical_rows_sha256 is null and payload_sha256 is null and completed_at is null and completion_audit_id is null and aborted_at is null and abort_audit_id is null)
    or (state = 'complete' and canonical_rows_sha256 is not null and payload_sha256 is not null and completed_at is not null and completion_audit_id is not null and aborted_at is null and abort_audit_id is null)
    or (state = 'aborted' and canonical_rows_sha256 is null and payload_sha256 is null and completed_at is null and completion_audit_id is null and aborted_at is not null and abort_audit_id is not null)
  )
);
alter table internal.jiaowubao_completed_lesson_snapshot_runs enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_snapshot_runs from public, anon, authenticated;
create unique index if not exists jiaowubao_completed_lesson_snapshot_active_revision
  on internal.jiaowubao_completed_lesson_snapshot_runs(period_month, revision)
  where state in ('staging', 'complete');

create table if not exists internal.jiaowubao_completed_lesson_snapshot_pages (
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
alter table internal.jiaowubao_completed_lesson_snapshot_pages enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_snapshot_pages from public, anon, authenticated;

create table if not exists internal.jiaowubao_completed_lesson_snapshot_items (
  run_id uuid not null references internal.jiaowubao_completed_lesson_snapshot_runs(id) on delete restrict,
  page_index integer not null,
  item_index integer not null check (item_index between 0 and 99),
  -- A source key contains three independently validated gateway IDs. Each ID
  -- may be 160 characters, so the complete key can be just over 500 chars.
  source_key text not null check (source_key ~ '^jwb-open-api:lesson:[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'),
  canonical_json text not null check (octet_length(canonical_json) between 2 and 8192),
  item_sha256 text not null check (item_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  item jsonb not null check (jsonb_typeof(item) = 'object'),
  staged_at timestamptz not null default now(),
  primary key (run_id, page_index, item_index),
  unique (run_id, source_key),
  foreign key (run_id, page_index) references internal.jiaowubao_completed_lesson_snapshot_pages(run_id, page_index) on delete restrict
);
alter table internal.jiaowubao_completed_lesson_snapshot_items enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_snapshot_items from public, anon, authenticated;

create table if not exists internal.jiaowubao_completed_lesson_snapshot_current (
  api_source_key text not null check (api_source_key = 'jwb-open-api-completed-lessons'),
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  run_id uuid not null references internal.jiaowubao_completed_lesson_snapshot_runs(id),
  revision text not null check (revision ~ '^sha256:[a-f0-9]{64}$'),
  row_count integer not null check (row_count between 0 and 6000),
  rows_sha256 text not null check (rows_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  published_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  primary key (api_source_key, period_month)
);
alter table internal.jiaowubao_completed_lesson_snapshot_current enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_snapshot_current from public, anon, authenticated;

create table if not exists internal.jiaowubao_completed_lesson_sync_leases (
  period_month date primary key check (period_month = date_trunc('month', period_month)::date),
  run_key text not null check (run_key = btrim(run_key) and char_length(run_key) between 1 and 240),
  acquired_at timestamptz not null,
  lease_expires_at timestamptz not null check (lease_expires_at > acquired_at)
);
alter table internal.jiaowubao_completed_lesson_sync_leases enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_sync_leases from public, anon, authenticated;

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
  if new.state is distinct from old.state
     or new.canonical_rows_sha256 is distinct from old.canonical_rows_sha256
     or new.payload_sha256 is distinct from old.payload_sha256
     or new.completed_at is distinct from old.completed_at
     or new.completion_audit_id is distinct from old.completion_audit_id
     or new.aborted_at is distinct from old.aborted_at
     or new.abort_audit_id is distinct from old.abort_audit_id then
    raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_run_immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_jiaowubao_completed_lesson_snapshot_run on internal.jiaowubao_completed_lesson_snapshot_runs;
create trigger guard_jiaowubao_completed_lesson_snapshot_run
before update or delete on internal.jiaowubao_completed_lesson_snapshot_runs
for each row execute function internal.guard_jiaowubao_completed_lesson_snapshot_run();
revoke all on function internal.guard_jiaowubao_completed_lesson_snapshot_run() from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_completed_lesson_snapshot_page()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     and pg_catalog.current_setting('internal.jiaowubao_completed_lesson_snapshot_abort_run_id', true) is not distinct from old.run_id::text then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_page_immutable';
end;
$$;
drop trigger if exists guard_jiaowubao_completed_lesson_snapshot_page on internal.jiaowubao_completed_lesson_snapshot_pages;
create trigger guard_jiaowubao_completed_lesson_snapshot_page
before update or delete on internal.jiaowubao_completed_lesson_snapshot_pages
for each row execute function internal.guard_jiaowubao_completed_lesson_snapshot_page();
revoke all on function internal.guard_jiaowubao_completed_lesson_snapshot_page() from public, anon, authenticated;

create or replace function internal.guard_jiaowubao_completed_lesson_snapshot_item()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     and pg_catalog.current_setting('internal.jiaowubao_completed_lesson_snapshot_abort_run_id', true) is not distinct from old.run_id::text then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_item_immutable';
end;
$$;
drop trigger if exists guard_jiaowubao_completed_lesson_snapshot_item on internal.jiaowubao_completed_lesson_snapshot_items;
create trigger guard_jiaowubao_completed_lesson_snapshot_item
before update or delete on internal.jiaowubao_completed_lesson_snapshot_items
for each row execute function internal.guard_jiaowubao_completed_lesson_snapshot_item();
revoke all on function internal.guard_jiaowubao_completed_lesson_snapshot_item() from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_completed_lesson_snapshot_envelope(p_envelope jsonb)
returns void language plpgsql stable set search_path = '' as $$
declare
  month_text text;
  month_start date;
  month_end date;
  expected_page_count integer;
  expected_row_count integer;
begin
  if p_envelope is null or jsonb_typeof(p_envelope) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  if p_envelope - ARRAY['apiSourceKey','month','revision','query','expectedPageCount','expectedRowCount','expectedCurrentRevision','externalManifestSha256','sourceMetadata']::text[] <> '{}'::jsonb
     or not (p_envelope ?& ARRAY['apiSourceKey','month','revision','query','expectedPageCount','expectedRowCount','expectedCurrentRevision','externalManifestSha256','sourceMetadata']::text[]) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  if jsonb_typeof(p_envelope -> 'apiSourceKey') is distinct from 'string'
     or p_envelope ->> 'apiSourceKey' is distinct from 'jwb-open-api-completed-lessons'
     or jsonb_typeof(p_envelope -> 'month') is distinct from 'string'
     or jsonb_typeof(p_envelope -> 'revision') is distinct from 'string'
     or coalesce(p_envelope ->> 'revision', '') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'expectedPageCount') is distinct from 'number'
     or coalesce(p_envelope ->> 'expectedPageCount', '') !~ '^(0|[1-9][0-9]?)$'
     or jsonb_typeof(p_envelope -> 'expectedRowCount') is distinct from 'number'
     or coalesce(p_envelope ->> 'expectedRowCount', '') !~ '^(0|[1-9][0-9]{0,3})$'
     or jsonb_typeof(p_envelope -> 'externalManifestSha256') is distinct from 'string'
     or p_envelope ->> 'externalManifestSha256' is distinct from p_envelope ->> 'revision'
     or coalesce(p_envelope ->> 'externalManifestSha256', '') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_envelope -> 'sourceMetadata') is distinct from 'object'
     or lower(p_envelope::text) ~ '"(sk|secret|token|password|authorization|cookie)"\s*:' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  if jsonb_typeof(p_envelope -> 'expectedCurrentRevision') is distinct from 'null' then
    if jsonb_typeof(p_envelope -> 'expectedCurrentRevision') is distinct from 'string'
       or coalesce(p_envelope ->> 'expectedCurrentRevision', '') !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
    end if;
  end if;
  expected_page_count := (p_envelope ->> 'expectedPageCount')::integer;
  expected_row_count := (p_envelope ->> 'expectedRowCount')::integer;
  if expected_page_count not between 0 and 60
     or expected_row_count not between 0 and 6000
     or (expected_row_count = 0) is distinct from (expected_page_count = 0) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  if (p_envelope -> 'sourceMetadata') - ARRAY['exportFormat','manifestSha256','recordsSha256']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'sourceMetadata') ?& ARRAY['exportFormat','manifestSha256','recordsSha256']::text[])
     or jsonb_typeof(p_envelope -> 'sourceMetadata' -> 'exportFormat') is distinct from 'string'
     or p_envelope -> 'sourceMetadata' ->> 'exportFormat' is distinct from 'jiaowubao-completed-lesson-export/v1'
     or jsonb_typeof(p_envelope -> 'sourceMetadata' -> 'manifestSha256') is distinct from 'string'
     or p_envelope -> 'sourceMetadata' ->> 'manifestSha256' is distinct from p_envelope ->> 'revision'
     or jsonb_typeof(p_envelope -> 'sourceMetadata' -> 'recordsSha256') is distinct from 'string'
     or coalesce(p_envelope -> 'sourceMetadata' ->> 'recordsSha256', '') !~ '^sha256:[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  month_text := p_envelope ->> 'month';
  if coalesce(month_text, '') !~ '^\d{4}-\d{2}$' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  month_start := to_date(month_text || '-01', 'YYYY-MM-DD');
  if to_char(month_start, 'YYYY-MM-DD') is distinct from month_text || '-01' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
  month_end := (month_start + interval '1 month - 1 day')::date;
  if jsonb_typeof(p_envelope -> 'query') is distinct from 'object'
     or (p_envelope -> 'query') - ARRAY['start','end','sign','over','limit']::text[] <> '{}'::jsonb
     or not ((p_envelope -> 'query') ?& ARRAY['start','end','sign','over','limit']::text[])
     or jsonb_typeof(p_envelope -> 'query' -> 'start') is distinct from 'string'
     or jsonb_typeof(p_envelope -> 'query' -> 'end') is distinct from 'string'
     or jsonb_typeof(p_envelope -> 'query' -> 'sign') is distinct from 'number'
     or jsonb_typeof(p_envelope -> 'query' -> 'over') is distinct from 'number'
     or jsonb_typeof(p_envelope -> 'query' -> 'limit') is distinct from 'number'
     or p_envelope -> 'query' ->> 'start' is distinct from to_char(month_start, 'YYYY-MM-DD')
     or p_envelope -> 'query' ->> 'end' is distinct from to_char(month_end, 'YYYY-MM-DD')
     or p_envelope -> 'query' ->> 'sign' is distinct from '-1'
     or p_envelope -> 'query' ->> 'over' is distinct from '1'
     or p_envelope -> 'query' ->> 'limit' is distinct from '100' then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_envelope_invalid';
  end if;
end;
$$;
revoke all on function internal.assert_jiaowubao_completed_lesson_snapshot_envelope(jsonb) from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_completed_lesson_snapshot_page(p_rows jsonb, p_period_month date)
returns void language plpgsql stable set search_path = '' as $$
declare month_start text := to_char(p_period_month, 'YYYY-MM-DD'); month_end text := to_char((p_period_month + interval '1 month - 1 day')::date, 'YYYY-MM-DD');
begin
  if p_rows is null or p_period_month is null or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) not between 1 and 100
     or octet_length(p_rows::text) > 2097152
     or exists (
       select 1 from jsonb_array_elements(p_rows) item_value
       where jsonb_typeof(item_value) is distinct from 'object'
          or item_value - ARRAY['sourceKey','record']::text[] <> '{}'::jsonb
          or not (item_value ?& ARRAY['sourceKey','record']::text[])
          or jsonb_typeof(item_value -> 'sourceKey') is distinct from 'string'
          or coalesce(item_value ->> 'sourceKey', '') !~ '^jwb-open-api:lesson:[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or jsonb_typeof(item_value -> 'record') is distinct from 'object'
          or not (item_value -> 'record' ?& ARRAY['sourceKey','completed','branchId','calendarId','memberId','memberName','lessonDate','timeTitle','hours','lessonType','isTrial','attendanceCode','attendanceTitle','courseId','courseTitle','teamId','teamTitle','teacherId','teacherName','completedAt']::text[])
          or (item_value -> 'record') - ARRAY['sourceKey','completed','branchId','calendarId','memberId','memberName','lessonDate','timeTitle','hours','lessonType','isTrial','attendanceCode','attendanceTitle','courseId','courseTitle','teamId','teamTitle','teacherId','teacherName','completedAt']::text[] <> '{}'::jsonb
          or jsonb_typeof(item_value -> 'record' -> 'sourceKey') is distinct from 'string'
          or (item_value -> 'record' ->> 'sourceKey') is distinct from (item_value ->> 'sourceKey')
          or jsonb_typeof(item_value -> 'record' -> 'completed') is distinct from 'boolean'
          or item_value -> 'record' -> 'completed' is distinct from 'true'::jsonb
          or jsonb_typeof(item_value -> 'record' -> 'branchId') is distinct from 'string'
          or jsonb_typeof(item_value -> 'record' -> 'calendarId') is distinct from 'string'
          or jsonb_typeof(item_value -> 'record' -> 'memberId') is distinct from 'string'
          or coalesce(item_value -> 'record' ->> 'branchId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or coalesce(item_value -> 'record' ->> 'calendarId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or coalesce(item_value -> 'record' ->> 'memberId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$'
          or item_value ->> 'sourceKey' is distinct from ('jwb-open-api:lesson:' || item_value -> 'record' ->> 'branchId' || ':' || item_value -> 'record' ->> 'calendarId' || ':' || item_value -> 'record' ->> 'memberId')
          or jsonb_typeof(item_value -> 'record' -> 'lessonDate') is distinct from 'string'
          or coalesce(item_value -> 'record' ->> 'lessonDate', '') !~ '^\d{4}-\d{2}-\d{2}$'
          or item_value -> 'record' ->> 'lessonDate' < month_start
          or item_value -> 'record' ->> 'lessonDate' > month_end
          or case when jsonb_typeof(item_value -> 'record' -> 'lessonDate') = 'string'
            and item_value -> 'record' ->> 'lessonDate' ~ '^\d{4}-\d{2}-\d{2}$'
            then to_char(to_date(item_value -> 'record' ->> 'lessonDate', 'YYYY-MM-DD'), 'YYYY-MM-DD') is distinct from item_value -> 'record' ->> 'lessonDate'
            else true end
          or case when jsonb_typeof(item_value -> 'record' -> 'hours') = 'number'
            and item_value -> 'record' ->> 'hours' ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$'
            then (item_value -> 'record' ->> 'hours')::numeric not between 0 and 24 else true end
          or jsonb_typeof(item_value -> 'record' -> 'isTrial') is distinct from 'boolean'
          or case when jsonb_typeof(item_value -> 'record' -> 'lessonType') = 'null'
              then item_value -> 'record' -> 'isTrial' is distinct from 'false'::jsonb
            when jsonb_typeof(item_value -> 'record' -> 'lessonType') = 'number'
              and item_value -> 'record' ->> 'lessonType' ~ '^[0-9]{1,2}$'
              then (item_value -> 'record' ->> 'lessonType')::integer not between 0 and 99
                or ((item_value -> 'record' ->> 'lessonType')::integer = 3) is distinct from (item_value -> 'record' -> 'isTrial' = 'true'::jsonb)
            else true end
          or case when jsonb_typeof(item_value -> 'record' -> 'attendanceCode') = 'null' then false
            when jsonb_typeof(item_value -> 'record' -> 'attendanceCode') = 'number'
              and item_value -> 'record' ->> 'attendanceCode' ~ '^-?(0|[1-9][0-9]?)$'
              then (item_value -> 'record' ->> 'attendanceCode')::integer not between -1 and 99
            else true end
          or exists (
            select 1 from unnest(ARRAY['memberName','timeTitle','attendanceTitle','courseId','courseTitle','teamId','teamTitle','teacherId','teacherName','completedAt']) field_name
            where jsonb_typeof(item_value -> 'record' -> field_name) not in ('string','null')
          )
          or octet_length((item_value -> 'record')::text) > 8192
     )
     or exists (select 1 from jsonb_array_elements(p_rows) item_value group by item_value ->> 'sourceKey' having count(*) > 1) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_page_invalid';
  end if;
end;
$$;
revoke all on function internal.assert_jiaowubao_completed_lesson_snapshot_page(jsonb,date) from public, anon, authenticated;

create or replace function public.get_jiaowubao_completed_lesson_snapshot_preflight(p_secret text, p_month text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare month_value date; saved internal.jiaowubao_completed_lesson_snapshot_current%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or coalesce(p_month, '') !~ '^\d{4}-\d{2}$' then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_preflight_forbidden'; end if;
  month_value := to_date(p_month || '-01', 'YYYY-MM-DD');
  if to_char(month_value, 'YYYY-MM') is distinct from p_month then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  select * into saved from internal.jiaowubao_completed_lesson_snapshot_current current_pointer
  where current_pointer.api_source_key = 'jwb-open-api-completed-lessons' and current_pointer.period_month = month_value;
  return jsonb_build_object('apiSourceKey','jwb-open-api-completed-lessons','month',p_month,'current',case when found then jsonb_build_object('revision',saved.revision,'rowCount',saved.row_count,'publishedAt',saved.published_at) else null end);
end;
$$;
revoke all on function public.get_jiaowubao_completed_lesson_snapshot_preflight(text,text,text) from public, anon, authenticated;
grant execute on function public.get_jiaowubao_completed_lesson_snapshot_preflight(text,text,text) to anon, authenticated;

create or replace function public.begin_jiaowubao_completed_lesson_snapshot_ingest(p_secret text, p_envelope jsonb, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.jiaowubao_completed_lesson_snapshot_runs%rowtype; audit_id uuid; supersede_audit_id uuid; run_id uuid := gen_random_uuid(); month_value date;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_actor_forbidden'; end if;
  perform internal.assert_jiaowubao_completed_lesson_snapshot_envelope(p_envelope);
  month_value := to_date((p_envelope ->> 'month') || '-01', 'YYYY-MM-DD');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-completed-lessons:' || month_value::text, 0));
  select * into saved from internal.jiaowubao_completed_lesson_snapshot_runs run_row
  where run_row.period_month = month_value and run_row.revision = p_envelope ->> 'revision' and run_row.state in ('staging','complete') for update;
  if found then
    if saved.query is not distinct from p_envelope -> 'query'
       and saved.expected_page_count = (p_envelope ->> 'expectedPageCount')::integer
       and saved.expected_row_count = (p_envelope ->> 'expectedRowCount')::integer
       and saved.expected_current_revision is not distinct from p_envelope ->> 'expectedCurrentRevision'
       and saved.external_manifest_sha256 is not distinct from p_envelope ->> 'externalManifestSha256'
       and saved.source_metadata is not distinct from p_envelope -> 'sourceMetadata' then
      return jsonb_build_object('runId',saved.id,'state',saved.state,'replayed',true);
    end if;
    if saved.state = 'staging'
       and saved.query is not distinct from p_envelope -> 'query'
       and saved.expected_page_count = (p_envelope ->> 'expectedPageCount')::integer
       and saved.expected_row_count = (p_envelope ->> 'expectedRowCount')::integer
       and saved.external_manifest_sha256 is not distinct from p_envelope ->> 'externalManifestSha256'
       and saved.source_metadata is not distinct from p_envelope -> 'sourceMetadata'
       and saved.expected_current_revision is distinct from p_envelope ->> 'expectedCurrentRevision' then
      supersede_audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot_ingest.superseded',p_actor,'jiaowubao_completed_lesson_snapshot_run',saved.id::text,jsonb_build_object('month',to_char(month_value,'YYYY-MM'),'revision',saved.revision));
      perform pg_catalog.set_config('internal.jiaowubao_completed_lesson_snapshot_abort_run_id',saved.id::text,true);
      delete from internal.jiaowubao_completed_lesson_snapshot_items where run_id = saved.id;
      delete from internal.jiaowubao_completed_lesson_snapshot_pages where run_id = saved.id;
      update internal.jiaowubao_completed_lesson_snapshot_runs set state='aborted',aborted_at=clock_timestamp(),abort_audit_id=supersede_audit_id where id=saved.id;
    else
      raise exception using errcode = '23505', message = 'jiaowubao_completed_lesson_snapshot_envelope_conflict';
    end if;
  end if;
  audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot_ingest.started',p_actor,'jiaowubao_completed_lesson_snapshot_run',run_id::text,jsonb_build_object('month',p_envelope ->> 'month','revision',p_envelope ->> 'revision','expectedPageCount',(p_envelope ->> 'expectedPageCount')::integer,'expectedRowCount',(p_envelope ->> 'expectedRowCount')::integer));
  insert into internal.jiaowubao_completed_lesson_snapshot_runs(id,api_source_key,period_month,revision,query,expected_page_count,expected_row_count,expected_current_revision,external_manifest_sha256,source_metadata,staged_by,staging_audit_id)
  values(run_id,'jwb-open-api-completed-lessons',month_value,p_envelope ->> 'revision',p_envelope -> 'query',(p_envelope ->> 'expectedPageCount')::integer,(p_envelope ->> 'expectedRowCount')::integer,p_envelope ->> 'expectedCurrentRevision',p_envelope ->> 'externalManifestSha256',p_envelope -> 'sourceMetadata',p_actor,audit_id);
  return jsonb_build_object('runId',run_id,'state','staging','replayed',false);
end;
$$;
revoke all on function public.begin_jiaowubao_completed_lesson_snapshot_ingest(text,jsonb,text) from public, anon, authenticated;
grant execute on function public.begin_jiaowubao_completed_lesson_snapshot_ingest(text,jsonb,text) to anon, authenticated;

create or replace function public.stage_jiaowubao_completed_lesson_snapshot_page(p_secret text, p_run_id uuid, p_page_index integer, p_rows jsonb, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_completed_lesson_snapshot_runs%rowtype; saved internal.jiaowubao_completed_lesson_snapshot_pages%rowtype; audit_id uuid; page_hash text; row_count_value integer;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or p_page_index is null or p_page_index not between 0 and 59 then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_stage_forbidden'; end if;
  select * into run_state from internal.jiaowubao_completed_lesson_snapshot_runs run_row where run_row.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_completed_lesson_snapshot_run_not_found'; end if;
  if run_state.state is distinct from 'staging' then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_run_not_staging'; end if;
  if p_page_index >= run_state.expected_page_count then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_page_index_invalid'; end if;
  perform internal.assert_jiaowubao_completed_lesson_snapshot_page(p_rows, run_state.period_month);
  page_hash := 'sha256:' || encode(extensions.digest(p_rows::text,'sha256'),'hex');
  row_count_value := jsonb_array_length(p_rows);
  select * into saved from internal.jiaowubao_completed_lesson_snapshot_pages page_row where page_row.run_id = p_run_id and page_row.page_index = p_page_index for update;
  if found then
    if saved.rows is distinct from p_rows then raise exception using errcode = '23505', message = 'jiaowubao_completed_lesson_snapshot_page_conflict'; end if;
    return jsonb_build_object('runId',p_run_id,'pageIndex',p_page_index,'rowCount',saved.row_count,'replayed',true);
  end if;
  audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot_ingest.page_staged',p_actor,'jiaowubao_completed_lesson_snapshot_run',p_run_id::text,jsonb_build_object('pageIndex',p_page_index,'rowCount',row_count_value,'pageSha256',page_hash));
  insert into internal.jiaowubao_completed_lesson_snapshot_pages(run_id,page_index,page_sha256,rows,row_count,content_bytes,audit_id)
  values(p_run_id,p_page_index,page_hash,p_rows,row_count_value,octet_length(p_rows::text),audit_id);
  insert into internal.jiaowubao_completed_lesson_snapshot_items(run_id,page_index,item_index,source_key,canonical_json,item_sha256,item)
  select p_run_id,p_page_index,ordinality - 1,item_value ->> 'sourceKey',item_value::text,'sha256:' || encode(extensions.digest(item_value::text,'sha256'),'hex'),item_value -> 'record'
  from jsonb_array_elements(p_rows) with ordinality page_items(item_value, ordinality);
  return jsonb_build_object('runId',p_run_id,'pageIndex',p_page_index,'rowCount',row_count_value,'replayed',false);
end;
$$;
revoke all on function public.stage_jiaowubao_completed_lesson_snapshot_page(text,uuid,integer,jsonb,text) from public, anon, authenticated;
grant execute on function public.stage_jiaowubao_completed_lesson_snapshot_page(text,uuid,integer,jsonb,text) to anon, authenticated;

create or replace function public.complete_jiaowubao_completed_lesson_snapshot_ingest(p_secret text, p_run_id uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_completed_lesson_snapshot_runs%rowtype; current_row internal.jiaowubao_completed_lesson_snapshot_current%rowtype; observed_current_revision text; page_count integer; row_count_value integer; rows_hash text; payload_hash text; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_complete_forbidden'; end if;
  select * into run_state from internal.jiaowubao_completed_lesson_snapshot_runs run_row where run_row.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_completed_lesson_snapshot_run_not_found'; end if;
  if run_state.state = 'complete' then return jsonb_build_object('runId',p_run_id,'state','complete','rowCount',run_state.expected_row_count,'rowsSha256',run_state.canonical_rows_sha256,'payloadSha256',run_state.payload_sha256,'replayed',true); end if;
  if run_state.state is distinct from 'staging' then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_run_not_staging'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-completed-lessons:' || run_state.period_month::text, 0));
  select * into current_row from internal.jiaowubao_completed_lesson_snapshot_current current_pointer where current_pointer.api_source_key = 'jwb-open-api-completed-lessons' and current_pointer.period_month = run_state.period_month for update;
  observed_current_revision := case when found then current_row.revision else null end;
  if observed_current_revision is distinct from run_state.expected_current_revision then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_current_pointer_conflict'; end if;
  select count(*)::integer,coalesce(sum(page_row.row_count),0)::integer into page_count,row_count_value from internal.jiaowubao_completed_lesson_snapshot_pages page_row where page_row.run_id = p_run_id;
  if page_count <> run_state.expected_page_count or row_count_value <> run_state.expected_row_count or exists(select 1 from generate_series(0,run_state.expected_page_count - 1) expected_page where not exists(select 1 from internal.jiaowubao_completed_lesson_snapshot_pages page_row where page_row.run_id = p_run_id and page_row.page_index = expected_page)) then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_pages_incomplete'; end if;
  select 'sha256:' || encode(extensions.digest(coalesce(string_agg(item_row.canonical_json,'' order by item_row.page_index,item_row.item_index),''),'sha256'),'hex') into rows_hash from internal.jiaowubao_completed_lesson_snapshot_items item_row where item_row.run_id = p_run_id;
  select 'sha256:' || encode(extensions.digest(coalesce(string_agg(page_row.page_sha256,'' order by page_row.page_index),''),'sha256'),'hex') into payload_hash from internal.jiaowubao_completed_lesson_snapshot_pages page_row where page_row.run_id = p_run_id;
  audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot_ingest.completed',p_actor,'jiaowubao_completed_lesson_snapshot_run',p_run_id::text,jsonb_build_object('month',to_char(run_state.period_month,'YYYY-MM'),'revision',run_state.revision,'pageCount',page_count,'rowCount',row_count_value,'rowsSha256',rows_hash,'payloadSha256',payload_hash));
  update internal.jiaowubao_completed_lesson_snapshot_runs set state='complete',canonical_rows_sha256=rows_hash,payload_sha256=payload_hash,completed_at=clock_timestamp(),completion_audit_id=audit_id where id=p_run_id;
  insert into internal.jiaowubao_completed_lesson_snapshot_current(api_source_key,period_month,run_id,revision,row_count,rows_sha256,payload_sha256,audit_id)
  values('jwb-open-api-completed-lessons',run_state.period_month,p_run_id,run_state.revision,row_count_value,rows_hash,payload_hash,audit_id)
  on conflict(api_source_key,period_month) do update set run_id=excluded.run_id,revision=excluded.revision,row_count=excluded.row_count,rows_sha256=excluded.rows_sha256,payload_sha256=excluded.payload_sha256,published_at=clock_timestamp(),audit_id=excluded.audit_id;
  return jsonb_build_object('runId',p_run_id,'state','complete','rowCount',row_count_value,'rowsSha256',rows_hash,'payloadSha256',payload_hash,'replayed',false);
end;
$$;
revoke all on function public.complete_jiaowubao_completed_lesson_snapshot_ingest(text,uuid,text) from public, anon, authenticated;
grant execute on function public.complete_jiaowubao_completed_lesson_snapshot_ingest(text,uuid,text) to anon, authenticated;

create or replace function public.abort_jiaowubao_completed_lesson_snapshot_ingest(p_secret text, p_run_id uuid, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare run_state internal.jiaowubao_completed_lesson_snapshot_runs%rowtype; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_abort_forbidden'; end if;
  select * into run_state from internal.jiaowubao_completed_lesson_snapshot_runs run_row where run_row.id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_completed_lesson_snapshot_run_not_found'; end if;
  if run_state.staged_by is distinct from p_actor then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_actor_mismatch'; end if;
  if run_state.state is distinct from 'staging' then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_run_not_staging'; end if;
  audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot_ingest.aborted',p_actor,'jiaowubao_completed_lesson_snapshot_run',p_run_id::text,jsonb_build_object('month',to_char(run_state.period_month,'YYYY-MM'),'revision',run_state.revision));
  perform pg_catalog.set_config('internal.jiaowubao_completed_lesson_snapshot_abort_run_id',p_run_id::text,true);
  delete from internal.jiaowubao_completed_lesson_snapshot_items where run_id=p_run_id;
  delete from internal.jiaowubao_completed_lesson_snapshot_pages where run_id=p_run_id;
  update internal.jiaowubao_completed_lesson_snapshot_runs set state='aborted',aborted_at=clock_timestamp(),abort_audit_id=audit_id where id=p_run_id;
  return jsonb_build_object('runId',p_run_id,'state','aborted');
end;
$$;
revoke all on function public.abort_jiaowubao_completed_lesson_snapshot_ingest(text,uuid,text) from public, anon, authenticated;
grant execute on function public.abort_jiaowubao_completed_lesson_snapshot_ingest(text,uuid,text) to anon, authenticated;

create or replace function public.confirm_jiaowubao_completed_lesson_snapshot_current(p_secret text, p_month text, p_revision text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare month_value date; current_row internal.jiaowubao_completed_lesson_snapshot_current%rowtype; confirmation_audit_id uuid; confirmed_at timestamptz := clock_timestamp();
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or coalesce(p_month, '') !~ '^\d{4}-\d{2}$' or coalesce(p_revision, '') !~ '^sha256:[a-f0-9]{64}$' then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_confirmation_forbidden'; end if;
  month_value := to_date(p_month || '-01','YYYY-MM-DD');
  if to_char(month_value,'YYYY-MM') is distinct from p_month then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-completed-lessons:' || month_value::text, 0));
  select * into current_row from internal.jiaowubao_completed_lesson_snapshot_current current_pointer where current_pointer.api_source_key = 'jwb-open-api-completed-lessons' and current_pointer.period_month = month_value for update;
  if not found then raise exception using errcode = 'P0002', message = 'jiaowubao_completed_lesson_snapshot_current_not_found'; end if;
  if current_row.revision is distinct from p_revision then raise exception using errcode = '55000', message = 'jiaowubao_completed_lesson_snapshot_current_pointer_conflict'; end if;
  confirmation_audit_id := internal.append_operational_contract_audit('jiaowubao_completed_lesson_snapshot.confirmed_unchanged',p_actor,'jiaowubao_completed_lesson_snapshot_run',current_row.run_id::text,jsonb_build_object('month',p_month,'revision',p_revision,'rowCount',current_row.row_count,'confirmedAt',confirmed_at));
  update internal.jiaowubao_completed_lesson_snapshot_current set published_at=confirmed_at,audit_id=confirmation_audit_id where api_source_key = 'jwb-open-api-completed-lessons' and period_month = month_value;
  return jsonb_build_object('confirmed',true,'revision',p_revision,'rowCount',current_row.row_count,'publishedAt',confirmed_at);
end;
$$;
revoke all on function public.confirm_jiaowubao_completed_lesson_snapshot_current(text,text,text,text) from public, anon, authenticated;
grant execute on function public.confirm_jiaowubao_completed_lesson_snapshot_current(text,text,text,text) to anon, authenticated;

-- The browser never receives a whole 6,000-row month in one response.  This
-- reader slices the already immutable source pointer into 250-row pages and
-- pins every continuation request to the revision returned by its first page.
create or replace function public.get_jiaowubao_completed_lesson_snapshot_page(
  p_secret text,
  p_month text,
  p_page_index integer,
  p_expected_revision text,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  month_value date;
  current_row internal.jiaowubao_completed_lesson_snapshot_current%rowtype;
  page_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin'
     or coalesce(p_month, '') !~ '^\d{4}-\d{2}$'
     or p_page_index is null or p_page_index not between 0 and 23
     or (p_page_index > 0 and p_expected_revision is null)
     or (p_expected_revision is not null and p_expected_revision !~ '^sha256:[a-f0-9]{64}$') then
    raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_snapshot_reader_forbidden';
  end if;
  month_value := to_date(p_month || '-01','YYYY-MM-DD');
  if to_char(month_value,'YYYY-MM') is distinct from p_month then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  select * into current_row
    from internal.jiaowubao_completed_lesson_snapshot_current current_pointer
   where current_pointer.api_source_key = 'jwb-open-api-completed-lessons'
     and current_pointer.period_month = month_value;
  if not found then
    if p_page_index <> 0 or p_expected_revision is not null then
      raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_page_invalid';
    end if;
    return jsonb_build_object(
      'state','absent','month',p_month,'revision',null,'rowCount',0,
      'pageIndex',0,'pageCount',0,'publishedAt',null,'items','[]'::jsonb
    );
  end if;
  page_count := case when current_row.row_count = 0 then 0 else ceil(current_row.row_count::numeric / 250)::integer end;
  if p_expected_revision is not null and current_row.revision is distinct from p_expected_revision then
    return jsonb_build_object(
      'state','reset','month',p_month,'revision',current_row.revision,
      'rowCount',current_row.row_count,'pageIndex',p_page_index,'pageCount',page_count,
      'publishedAt',current_row.published_at,'items','[]'::jsonb
    );
  end if;
  if (current_row.row_count = 0 and p_page_index <> 0)
     or (current_row.row_count > 0 and p_page_index >= page_count) then
    raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_page_invalid';
  end if;
  return jsonb_build_object(
    'state','complete','month',p_month,'revision',current_row.revision,
    'rowCount',current_row.row_count,'pageIndex',p_page_index,'pageCount',page_count,
    'publishedAt',current_row.published_at,
    'items',coalesce((
      select jsonb_agg(jsonb_build_object('sourceKey',item_row.source_key,'record',item_row.item) order by item_row.page_index,item_row.item_index)
      from (
        select source_key,item,page_index,item_index
          from internal.jiaowubao_completed_lesson_snapshot_items
         where run_id = current_row.run_id
         order by page_index,item_index
         offset p_page_index * 250
         limit 250
      ) item_row
    ),'[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_jiaowubao_completed_lesson_snapshot_page(text,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.get_jiaowubao_completed_lesson_snapshot_page(text,text,integer,text,text) to anon, authenticated;

create or replace function public.claim_jiaowubao_completed_lesson_sync_lease(p_secret text, p_month text, p_run_key text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare month_value date; saved internal.jiaowubao_completed_lesson_sync_leases%rowtype; now_at timestamptz := clock_timestamp();
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or coalesce(p_month, '') !~ '^\d{4}-\d{2}$' or coalesce(p_run_key, '') !~ '^jwb-completed-lessons-sync:[0-9]{10,16}:[0-9]{4}-[0-9]{2}$' then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_sync_lease_forbidden'; end if;
  month_value := to_date(p_month || '-01','YYYY-MM-DD');
  if to_char(month_value,'YYYY-MM') is distinct from p_month then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-completed-lessons-sync:' || month_value::text, 0));
  select * into saved from internal.jiaowubao_completed_lesson_sync_leases lease_row where lease_row.period_month = month_value for update;
  if found and saved.lease_expires_at > now_at then return jsonb_build_object('acquired',false,'runKey',saved.run_key,'retryAfterSeconds',greatest(1,ceil(extract(epoch from saved.lease_expires_at-now_at))::integer)); end if;
  insert into internal.jiaowubao_completed_lesson_sync_leases(period_month,run_key,acquired_at,lease_expires_at) values(month_value,p_run_key,now_at,now_at+interval '10 minutes') on conflict(period_month) do update set run_key=excluded.run_key,acquired_at=excluded.acquired_at,lease_expires_at=excluded.lease_expires_at;
  return jsonb_build_object('acquired',true,'runKey',p_run_key,'retryAfterSeconds',0);
end;
$$;
revoke all on function public.claim_jiaowubao_completed_lesson_sync_lease(text,text,text,text) from public, anon, authenticated;
grant execute on function public.claim_jiaowubao_completed_lesson_sync_lease(text,text,text,text) to anon, authenticated;

create or replace function public.release_jiaowubao_completed_lesson_sync_lease(p_secret text, p_month text, p_run_key text, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare month_value date; saved internal.jiaowubao_completed_lesson_sync_leases%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_actor is distinct from 'Ops Admin' or coalesce(p_month, '') !~ '^\d{4}-\d{2}$' or coalesce(p_run_key, '') !~ '^jwb-completed-lessons-sync:[0-9]{10,16}:[0-9]{4}-[0-9]{2}$' then raise exception using errcode = '42501', message = 'jiaowubao_completed_lesson_sync_lease_forbidden'; end if;
  month_value := to_date(p_month || '-01','YYYY-MM-DD');
  if to_char(month_value,'YYYY-MM') is distinct from p_month then raise exception using errcode = '22023', message = 'jiaowubao_completed_lesson_snapshot_month_invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jiaowubao-completed-lessons-sync:' || month_value::text, 0));
  select * into saved from internal.jiaowubao_completed_lesson_sync_leases lease_row where lease_row.period_month = month_value for update;
  if not found or saved.run_key is distinct from p_run_key then return jsonb_build_object('released',false); end if;
  update internal.jiaowubao_completed_lesson_sync_leases set lease_expires_at=clock_timestamp() where period_month = month_value;
  return jsonb_build_object('released',true);
end;
$$;
revoke all on function public.release_jiaowubao_completed_lesson_sync_lease(text,text,text,text) from public, anon, authenticated;
grant execute on function public.release_jiaowubao_completed_lesson_sync_lease(text,text,text,text) to anon, authenticated;

comment on table internal.jiaowubao_completed_lesson_snapshot_runs is 'Private immutable month-scoped JWB over=1 lesson evidence; never a payroll or operations projection.';
comment on table internal.jiaowubao_completed_lesson_snapshot_current is 'Private current pointer per calendar month for complete JWB lesson evidence.';
