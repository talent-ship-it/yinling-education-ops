\set ON_ERROR_STOP on
\ir assert-disposable-database.sql


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

insert into public.ops_state(entity,payload,version,updated_by) values ('teachers','[]',1,'fixture');
update public.ops_state set payload = '[
  {"id":"SCHEDULER-BUSINESS-1","studentId":"STU-1","status":"waiting","ruleKey":"lp.scheduling","anchorBookingId":"LP-1"},
  {"id":"SCHEDULER-BUSINESS-2","studentId":"STU-1","status":"waiting","ruleKey":"lp.modification-review","anchorBookingId":"LP-1"},
  {"id":"SCHEDULER-BUSINESS-3","studentId":"STU-1","status":"waiting","ruleKey":"lp.modification-review.2","anchorBookingId":"LP-1"},
  {"id":"SCHEDULER-BUSINESS-4","studentId":"STU-1","status":"waiting","ruleKey":"lp.first-lesson-finalize-n2","anchorBookingId":"LP-1"},
  {"id":"SCHEDULER-BUSINESS-5","studentId":"STU-1","status":"waiting","ruleKey":"lp.first-lesson-prep-n1","anchorBookingId":"LP-1"},
  {"id":"SCHEDULER-BUSINESS-UNKNOWN","studentId":"STU-1","status":"waiting","ruleKey":"lp.unknown","anchorBookingId":"LP-1"}
]' where entity='tasks';
