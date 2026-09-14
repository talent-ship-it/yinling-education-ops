\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

begin;

drop schema if exists internal cascade;
drop schema if exists extensions cascade;
drop table if exists public.ops_mutation_log cascade;
drop table if exists public.ops_state cascade;

create schema internal;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end;
$$;

create table public.ops_state (
  entity text primary key,
  payload jsonb not null,
  version bigint not null,
  updated_at timestamptz not null default now(),
  updated_by text not null
);
create table public.ops_mutation_log (
  entity text not null,
  version bigint not null,
  actor text not null
);
create table internal.operational_contract_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  action text not null,
  actor text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null,
  created_at timestamptz not null default now()
);
create or replace function internal.verify_ops_secret(p_secret text)
returns boolean language sql immutable security invoker set search_path = ''
as $$ select p_secret = 'test-secret' $$;
create or replace function internal.append_operational_contract_audit(
  p_action text, p_actor text, p_target_type text, p_target_id text, p_metadata jsonb default '{}'::jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare saved uuid;
begin
  insert into internal.operational_contract_audit(action, actor, target_type, target_id, metadata)
  values (p_action, p_actor, p_target_type, p_target_id, p_metadata)
  returning id into saved;
  return saved;
end;
$$;

\ir ../../supabase/migrations/20260819101700_lp_parent_progress_scheduler.sql

insert into public.ops_state(entity, payload, version, updated_by) values
  ('bookings', '[]', 1, 'fixture'),
  ('lpItems', '[]', 1, 'fixture'),
  ('tasks', '[]', 1, 'fixture');

-- A stale run whose target is exactly current state is safely no_change.
select * from public.begin_lp_parent_progress_scheduler_run(
  'test-secret', 'lp-parent-progress:00000000-0000-4000-8000-000000000001',
  repeat('0', 64), '{"bookings":1,"lpItems":1,"tasks":1}', 1, '[]', 0, 0
);
update internal.lp_parent_progress_scheduler_runs
set started_at = now() - interval '31 minutes'
where run_key = 'lp-parent-progress:00000000-0000-4000-8000-000000000001';
do $$
declare result record; run_state text;
begin
  select * into result from public.recover_stale_lp_parent_progress_scheduler_runs('test-secret');
  select outcome into run_state from internal.lp_parent_progress_scheduler_runs
  where run_key = 'lp-parent-progress:00000000-0000-4000-8000-000000000001';
  if result.recovered_no_change <> 1 or result.recovered_failed <> 0 or run_state <> 'no_change' then
    raise exception 'lp_scheduler_stale_no_change_recovery_failed';
  end if;
end;
$$;

-- Task write and applied ledger transition are one transaction. A later
-- failed finish replay (simulating an unknown HTTP response) cannot downgrade it.
select * from public.begin_lp_parent_progress_scheduler_run(
  'test-secret', 'lp-parent-progress:00000000-0000-4000-8000-000000000002',
  repeat('1', 64), '{"bookings":1,"lpItems":1,"tasks":1}', 1,
  '[{"id":"TSK-1","ruleKey":"trial.parent-progress-sync.1"}]', 1, 1
);
select * from public.put_lp_parent_progress_scheduler_tasks(
  'test-secret', 'lp-parent-progress:00000000-0000-4000-8000-000000000002',
  '[{"id":"TSK-1","ruleKey":"trial.parent-progress-sync.1"}]', 'LP Scheduler'
);
select * from public.finish_lp_parent_progress_scheduler_run(
  'test-secret', 'lp-parent-progress:00000000-0000-4000-8000-000000000002',
  'failed', 'simulated_unknown_response'
);
do $$
declare run_state text; before_version bigint; after_version bigint; current_version bigint;
begin
  select outcome, task_version_before, task_version_after into run_state, before_version, after_version
  from internal.lp_parent_progress_scheduler_runs
  where run_key = 'lp-parent-progress:00000000-0000-4000-8000-000000000002';
  select version into current_version from public.ops_state where entity = 'tasks';
  if run_state <> 'applied' or before_version <> 1 or after_version <> 2 or current_version <> 2 then
    raise exception 'lp_scheduler_atomic_applied_replay_failed';
  end if;
end;
$$;

-- A stale run with no exact no-change proof converges to failed, never applied.
select * from public.begin_lp_parent_progress_scheduler_run(
  'test-secret', 'lp-parent-progress:00000000-0000-4000-8000-000000000003',
  repeat('2', 64), '{"bookings":1,"lpItems":1,"tasks":2}', 2,
  '[{"id":"TSK-DIFFERENT"}]', 1, 1
);
update internal.lp_parent_progress_scheduler_runs
set started_at = now() - interval '31 minutes'
where run_key = 'lp-parent-progress:00000000-0000-4000-8000-000000000003';
select * from public.recover_stale_lp_parent_progress_scheduler_runs('test-secret');
do $$
declare run_state text; error_value text;
begin
  select outcome, error_code into run_state, error_value
  from internal.lp_parent_progress_scheduler_runs
  where run_key = 'lp-parent-progress:00000000-0000-4000-8000-000000000003';
  if run_state <> 'failed' or error_value <> 'stale_unfinished_run' then
    raise exception 'lp_scheduler_stale_failure_recovery_failed';
  end if;
end;
$$;

rollback;
