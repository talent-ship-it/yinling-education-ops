\ir assert-disposable-database.sql
create schema internal;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create function internal.verify_ops_secret(p_secret text) returns boolean language sql stable as $$
  select p_secret='reader-fixture-secret'
$$;
create table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs (
  id uuid primary key, api_source_key text not null, revision text not null, state text not null, query jsonb not null
);
create table internal.jiaowubao_open_api_schedule_snapshot_current (
  api_source_key text primary key, run_id uuid not null, revision text not null, row_count integer not null, published_at timestamptz not null
);
create table internal.jiaowubao_open_api_schedule_snapshot_ingest_items (
  run_id uuid not null, source_key text not null, item jsonb not null, primary key(run_id,source_key)
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


create function internal.fixture_seed_reader(p_rows integer) returns void language plpgsql as $$
begin
  truncate internal.jiaowubao_open_api_schedule_snapshot_current,
    internal.jiaowubao_open_api_schedule_snapshot_ingest_items,
    internal.jiaowubao_open_api_schedule_snapshot_ingest_runs;
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs values (
    '10000000-0000-4000-8000-000000000001','jwb-open-api-schedule','sha256:'||repeat('a',64),'complete',
    '{"start":"2026-10-02","end":"2027-01-02"}');
  insert into internal.jiaowubao_open_api_schedule_snapshot_current values (
    'jwb-open-api-schedule','10000000-0000-4000-8000-000000000001','sha256:'||repeat('a',64),p_rows,clock_timestamp());
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items
  select '10000000-0000-4000-8000-000000000001','jwb-open-api:schedule:'||i,
    jsonb_build_object('record',jsonb_build_object(
      'cal_id','different-cal-id-'||i,'dated',to_char('2026-10-02'::date+(i%93),'YYYY-MM-DD'),
      'time_start','12:00','time_end','13:00','teacher_id','t1','teacher_title','Synthetic Teacher',
      'course_title','Synthetic Course','stu_list',jsonb_build_array(jsonb_build_object('mem_id','s'||i,'name','Student '||i)),
      'fixtureExtra',(select string_agg(md5(i::text||':'||g::text),'') from generate_series(1,40) g)))
  from generate_series(1,p_rows) i;
end;
$$;
create function internal.fixture_reader_call(p_reader text,p_case jsonb) returns jsonb language plpgsql as $$
declare result jsonb; teacher_labels text[]; member_ids text[]; name_keys text[];
begin
  if p_case ? 'teacherLabels' then select array_agg(x) into teacher_labels from jsonb_array_elements_text(p_case->'teacherLabels') x; end if;
  if p_case ? 'memberIds' then select array_agg(x) into member_ids from jsonb_array_elements_text(p_case->'memberIds') x; end if;
  if p_case ? 'nameKeys' then select array_agg(x) into name_keys from jsonb_array_elements_text(p_case->'nameKeys') x; end if;
  execute format('select %s($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',p_reader)
  into result using coalesce(p_case->>'secret','reader-fixture-secret'),
    coalesce(p_case->>'start','2026-10-01T14:00:00Z')::timestamptz,
    coalesce(p_case->>'end','2026-11-01T13:00:00Z')::timestamptz,
    coalesce(p_case->>'scope','all'),teacher_labels,member_ids,coalesce((p_case->>'limit')::integer,250),
    (p_case->>'cursorStart')::timestamptz,p_case->>'cursorEvent',coalesce(p_case->>'revision','sha256:'||repeat('a',64)),name_keys;
  return jsonb_build_object('result',result);
exception when others then return jsonb_build_object('sqlstate',sqlstate,'message',sqlerrm);
end;
$$;
create function internal.fixture_assert_reader_equal(p_case jsonb) returns jsonb language plpgsql as $$
declare before_result jsonb; after_result jsonb;
begin
  before_result:=internal.fixture_reader_call('internal.fixture_reader_before',p_case);
  after_result:=internal.fixture_reader_call('public.get_jiaowubao_open_api_schedule_snapshot_window',p_case);
  assert before_result=after_result,'Reader output or SQLSTATE changed for '||p_case::text;
  return after_result;
end;
$$;
