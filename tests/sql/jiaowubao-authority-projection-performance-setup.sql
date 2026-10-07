\ir assert-disposable-database.sql

create schema if not exists internal;

do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$roles$;

create or replace function internal.verify_ops_secret(p_secret text)
returns boolean language sql stable set search_path = '' as $$
  select p_secret = 'projection-job-fixture-secret'
$$;

create table internal.operational_contract_audit (
  id uuid primary key,
  action text not null,
  actor text not null,
  target_type text not null,
  target_id text not null,
  detail jsonb not null
);

create or replace function internal.append_operational_contract_audit(
  p_action text,
  p_actor text,
  p_target_type text,
  p_target_id text,
  p_detail jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare saved_id uuid := pg_catalog.gen_random_uuid();
begin
  insert into internal.operational_contract_audit(
    id, action, actor, target_type, target_id, detail
  ) values (
    saved_id, p_action, p_actor, p_target_type, p_target_id, p_detail
  );
  return saved_id;
end;
$$;

create schema extensions;
create extension pgcrypto with schema extensions;
create table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs (
 id uuid primary key, api_source_key text not null, revision text not null, state text not null,
 query jsonb not null, completed_at timestamptz not null, expected_row_count integer not null
);
create table internal.jiaowubao_open_api_schedule_snapshot_current (
 api_source_key text primary key, run_id uuid not null references internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id),
 revision text not null, row_count integer not null, published_at timestamptz not null
);
create table internal.jiaowubao_open_api_schedule_snapshot_ingest_items (
 run_id uuid not null references internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id),
 source_key text not null, item jsonb not null, primary key(run_id, source_key)
);
create table public.ops_state (
 entity text primary key, payload jsonb not null, version integer not null,
 updated_at timestamptz not null default clock_timestamp(), updated_by text not null default 'Ops Admin'
);
create table public.ops_source_snapshots (
 source_id text primary key, title text, source_type text, url text, modified_at timestamptz,
 synced_at timestamptz, row_count integer, status text, payload jsonb
);
create or replace function internal.student_import_display_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(regexp_replace(
    replace(replace(replace(replace(
      normalize(coalesce(p_name, ''), NFKC),
      chr(8203), ''), chr(8204), ''), chr(8205), ''), chr(65279), ''),
    '[[:space:]　]+', ' ', 'g'
  ))
$$;
create or replace function internal.student_import_js_trim(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(
    coalesce(p_value, ''),
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32)
      || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194)
      || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199)
      || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233)
      || chr(8239) || chr(8287) || chr(12288) || chr(65279)
  )
$$;
create or replace function internal.student_import_source_key(p_source_row jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case jsonb_typeof(p_source_row)
    when 'number' then case
      when (p_source_row #>> '{}')::numeric = trunc((p_source_row #>> '{}')::numeric)
       and abs((p_source_row #>> '{}')::numeric) <= 9007199254740991
      then trunc((p_source_row #>> '{}')::numeric)::text
      else null end
    when 'string' then internal.student_import_js_trim(p_source_row #>> '{}')
    else null
  end
$$;
create or replace function internal.student_import_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.translate(
    internal.student_import_display_name(p_name),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz'
  )
$$;

revoke all on function internal.student_import_name_key(text)
  from public, anon, authenticated;

create function internal.fixture_seed_authority(p_rows integer, p_bookings integer, p_students integer, p_teachers integer, p_courses integer)
returns void language plpgsql as $$
begin
  truncate public.ops_source_snapshots, internal.jiaowubao_authority_current,
    internal.jiaowubao_authority_projection_entities, internal.jiaowubao_authority_projection_runs,
    internal.jiaowubao_authority_native_links, internal.jiaowubao_authority_native_quarantine,
    internal.jiaowubao_open_api_schedule_snapshot_current,
    internal.jiaowubao_open_api_schedule_snapshot_ingest_items,
    internal.jiaowubao_open_api_schedule_snapshot_ingest_runs,
    internal.operational_contract_audit, public.ops_state;
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs values (
    '10000000-0000-4000-8000-000000000001', 'jwb-open-api-schedule', 'sha256:' || repeat('a', 64),
    'complete', '{"start":"2026-09-01","end":"2026-12-02"}', '2026-10-07T00:00:00Z', p_rows);
  insert into internal.jiaowubao_open_api_schedule_snapshot_current values (
    'jwb-open-api-schedule', '10000000-0000-4000-8000-000000000001',
    'sha256:' || repeat('a', 64), p_rows, '2026-10-07T00:00:00Z');
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items
  select '10000000-0000-4000-8000-000000000001', 'jwb-open-api:schedule:' || i,
    jsonb_build_object('record', jsonb_build_object(
      'cal_id', i::text, 'dated', '2026-10-01', 'time_start', '12:00', 'time_end', '13:00',
      'teacher_id', 't' || (i % 102), 'teacher_title', 'Teacher ' || (i % 102),
      'course_id', 'c' || (i % 70), 'course_title', 'Course ' || (i % 70),
      'stu_list', jsonb_build_array(jsonb_build_object('mem_id', 's' || (i % 1109), 'name', 'Student ' || (i % 1109))),
      'hours', 1, 'teacher_hour', 1, 'over', '1'))
  from generate_series(1, p_rows) i;
  insert into public.ops_state(entity, payload, version)
  select 'students', jsonb_agg(jsonb_build_object('id', 'stu' || i, 'name', 'Student ' || i, 'jwbSourceRow', 's' || i)), 1
    from generate_series(0, p_students - 1) i
  union all select 'teachers', jsonb_agg(jsonb_build_object('id', 'tea' || i, 'name', 'Teacher ' || i, 'subjects', jsonb_build_array('English'))), 1
    from generate_series(0, p_teachers - 1) i
  union all select 'courses', jsonb_agg(jsonb_build_object('id', 'cou' || i, 'name', 'Course ' || i)), 1
    from generate_series(0, p_courses - 1) i
  union all select 'bookings', jsonb_agg(jsonb_build_object(
    'id', 'book' || i, 'sourceLessonId', i::text, 'studentId', 'stu' || (i % 1109), 'teacherId', 'tea' || (i % 102),
    'course', 'Course ' || (i % 70), 'date', '2026-10-01', 'start', '12:00', 'duration', 60,
    'status', '已确认', 'unrelated', 'preserved')), 1
    from generate_series(1, p_bookings) i;
end;
$$;

create function internal.fixture_authority_result()
returns jsonb language plpgsql as $$
begin
  return (select jsonb_build_object(
    'states', (select jsonb_object_agg(entity, jsonb_build_object('payload', payload, 'version', version)) from public.ops_state),
    'entities', (select jsonb_agg(to_jsonb(e) - 'projection_run_id' order by entity_type, source_key)
      from internal.jiaowubao_authority_projection_entities e
      where projection_run_id = (select projection_run_id from internal.jiaowubao_authority_current)),
    'links', (select jsonb_agg(to_jsonb(l) - array['first_seen_at','last_seen_at'] order by entity_type, source_native_id)
      from internal.jiaowubao_authority_native_links l),
    'quarantine', (select jsonb_agg(to_jsonb(q) - array['first_seen_at','last_seen_at','projection_run_id'] order by entity_type, source_key)
      from internal.jiaowubao_authority_native_quarantine q)
  ));
end;
$$;

create function internal.fixture_authority_edges()
returns void language plpgsql as $$
begin
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
  set item = jsonb_set(item, '{record,time_start}', '"invalid"') where source_key = 'jwb-open-api:schedule:2';
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
  set item = jsonb_set(item, '{record,stu_list}', '[]') where source_key = 'jwb-open-api:schedule:3';
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
  set item = jsonb_set(item, '{record,stu_list,0,name}', '""') where source_key = 'jwb-open-api:schedule:4';
  update public.ops_state set payload = payload ||
    '[{"id":"duplicate-book-1","sourceLessonId":"jwb-open-api:schedule:1"},{"id":"duplicate-book-5","sourceLessonId":"5"}]'
  where entity = 'bookings';
  update public.ops_state set payload = payload || '[{"id":"duplicate-student-1","name":"Student 1","jwbSourceRow":"s1"}]'
  where entity = 'students';
  update public.ops_state set payload = payload || '[{"id":"duplicate-teacher-1","name":"Teacher 1"}]' where entity = 'teachers';
  update public.ops_state set payload = payload || '[{"id":"duplicate-course-1","name":"Course 1"}]' where entity = 'courses';
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
  set item = jsonb_set(jsonb_set(item, '{record,stu_list,0,mem_id}', '"s1"'),
    '{record,stu_list,0,name}', to_jsonb(' Ｓｔｕｄｅｎｔ' || chr(160) || '1' || chr(8203) || ' '))
  where source_key = 'jwb-open-api:schedule:9';
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
  set item = jsonb_set(jsonb_set(item, '{record,stu_list,0,mem_id}', '"s1"'),
    '{record,stu_list,0,name}', '"Different Student 1"')
  where source_key = 'jwb-open-api:schedule:10';
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_items
  set item = jsonb_set(jsonb_set(jsonb_set(item,
    '{record,teacher_title}', to_jsonb(' Ｔｅａｃｈｅｒ' || chr(160) || '6 ')),
    '{record,course_title}', to_jsonb(' Course' || chr(12288) || '6' || chr(8203) || ' ')),
    '{record,stu_list,0,name}', to_jsonb(' Student' || chr(160) || '6 '))
  where source_key = 'jwb-open-api:schedule:6';
end;
$$;

create function internal.fixture_authority_native_edit()
returns void language plpgsql as $$
begin
  update public.ops_state set payload = (
    select jsonb_agg(case when item ->> 'id' = 'book7'
      then item || '{"id":"renamed-book7","sourceLessonId":"jwb-open-api:schedule:7"}'::jsonb
      else item end order by ordinality)
    from jsonb_array_elements(payload) with ordinality source(item, ordinality)
  ), version = version + 1 where entity = 'bookings';
end;
$$;
