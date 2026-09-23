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

create table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs (
  id uuid primary key,
  api_source_key text not null,
  revision text not null,
  state text not null,
  query jsonb not null
);

create table internal.jiaowubao_open_api_schedule_snapshot_current (
  api_source_key text primary key,
  run_id uuid not null references internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id),
  revision text not null,
  row_count integer not null,
  published_at timestamptz not null,
  audit_id uuid not null references internal.operational_contract_audit(id)
);

create table internal.jiaowubao_open_api_schedule_sync_leases (
  api_source_key text primary key,
  run_key text not null,
  acquired_at timestamptz not null,
  lease_expires_at timestamptz not null
);

create or replace function public.begin_jiaowubao_open_api_schedule_snapshot_ingest(
  p_secret text, p_envelope jsonb, p_actor text
) returns jsonb language sql security definer set search_path = '' as $$
  select '{}'::jsonb
$$;

create or replace function public.stage_jiaowubao_open_api_schedule_snapshot_page(
  p_secret text, p_run_id uuid, p_page_index integer, p_rows jsonb, p_actor text
) returns jsonb language sql security definer set search_path = '' as $$
  select '{}'::jsonb
$$;

create or replace function public.complete_jiaowubao_open_api_schedule_snapshot_ingest(
  p_secret text, p_run_id uuid, p_actor text
) returns jsonb language sql security definer set search_path = '' as $$
  select '{}'::jsonb
$$;

create or replace function public.confirm_jiaowubao_open_api_schedule_snapshot_current(
  p_secret text, p_api_source_key text, p_revision text, p_actor text
) returns jsonb language sql security definer set search_path = '' as $$
  select '{}'::jsonb
$$;

create or replace function public.project_jiaowubao_open_api_authority(
  p_secret text,
  p_revision text,
  p_actor text
)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('revision', p_revision)
$$;

create or replace function public.sync_jiaowubao_trial_matches_atomic_v2(
  p_secret text,
  p_command_uuid text,
  p_command_intent jsonb,
  p_snapshot_revision text,
  p_matches jsonb,
  p_revocations jsonb,
  p_expected_versions jsonb,
  p_next_lp_items jsonb,
  p_next_tasks jsonb,
  p_actor text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare pointer internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
begin
  select * into pointer
  from internal.jiaowubao_open_api_schedule_snapshot_current current_pointer
  where current_pointer.api_source_key = 'jwb-open-api-schedule';
  if not found or pointer.published_at < clock_timestamp() - interval '2 hours' then
    raise exception using errcode = '55000', message = 'stale';
  end if;
  return '{}'::jsonb;
end;
$$;

insert into internal.operational_contract_audit(
  id, action, actor, target_type, target_id, detail
) values (
  'a0000000-0000-4000-8000-000000000001',
  'fixture.seed', 'Ops Admin', 'fixture', 'seed-a', '{}'
);

insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(
  id, api_source_key, revision, state, query
) values (
  '10000000-0000-4000-8000-000000000001',
  'jwb-open-api-schedule', 'sha256:' || repeat('a', 64), 'complete',
  '{"start":"2026-09-23","end":"2026-12-24"}'
);

insert into internal.jiaowubao_open_api_schedule_snapshot_current(
  api_source_key, run_id, revision, row_count, published_at, audit_id
) values (
  'jwb-open-api-schedule', '10000000-0000-4000-8000-000000000001',
  'sha256:' || repeat('a', 64), 12, '2026-09-23T00:00:00Z',
  'a0000000-0000-4000-8000-000000000001'
);
