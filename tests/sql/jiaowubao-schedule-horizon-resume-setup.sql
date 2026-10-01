\ir assert-disposable-database.sql

create schema internal;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end;
$roles$;

create or replace function internal.verify_ops_secret(p_secret text)
returns boolean language sql stable set search_path = '' as $$
  select p_secret = 'schedule-horizon-fixture-secret'
$$;

create or replace function internal.assert_jiaowubao_open_api_schedule_snapshot_page(p_rows jsonb)
returns void language plpgsql set search_path = '' as $$
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 100
     or exists(select 1 from jsonb_array_elements(p_rows) item
       where jsonb_typeof(item) <> 'object' or not (item ?& array['sourceKey','record']::text[])) then
    raise exception using errcode = '22023', message = 'schedule_page_invalid';
  end if;
end;
$$;

create table internal.jiaowubao_open_api_schedule_snapshot_current (
  api_source_key text primary key,
  run_id uuid not null,
  revision text not null,
  row_count integer not null
);

create table internal.jiaowubao_open_api_schedule_snapshot_ingest_items (
  run_id uuid not null,
  source_key text not null,
  item jsonb not null,
  primary key(run_id,source_key)
);

create table internal.jiaowubao_open_api_schedule_sync_leases (
  api_source_key text primary key,
  run_key text not null,
  lease_expires_at timestamptz not null
);
insert into internal.jiaowubao_open_api_schedule_sync_leases(api_source_key,run_key,lease_expires_at)
  values('jwb-open-api-schedule',
    'jwb-open-api-schedule-sync:1760000000000:00000000-0000-4000-8000-000000000001',
    clock_timestamp() + interval '10 minutes');
