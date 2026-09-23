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
end;
$roles$;

create or replace function internal.verify_ops_secret(p_secret text)
returns boolean language sql stable set search_path = '' as $$
  select p_secret = 'identity-reader-fixture-secret'
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
  primary key (run_id, source_key)
);
