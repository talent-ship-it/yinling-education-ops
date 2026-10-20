\ir assert-disposable-database.sql
\set ON_ERROR_STOP on
create schema internal;
create schema extensions;
create extension pgcrypto with schema extensions;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table public.ops_state(entity text primary key,payload jsonb not null,version bigint not null,updated_at timestamptz default now(),updated_by text);
create table public.ops_mutation_log(entity text,version bigint,actor text);
create table internal.operational_contract_audit(id uuid primary key default extensions.gen_random_uuid(),action text,metadata jsonb);
create function internal.verify_ops_secret(p_secret text) returns boolean language sql as $$ select p_secret='local-jwb-fixture' $$;
create function internal.append_operational_contract_audit(p_action text,p_actor text,p_target_type text,p_target_id text,p_metadata jsonb default '{}')
returns uuid language plpgsql as $$ declare result uuid; begin
  insert into internal.operational_contract_audit(action,metadata) values(p_action,p_metadata) returning id into result; return result;
end $$;
create table internal.jiaowubao_open_api_schedule_snapshot_current(api_source_key text primary key,run_id uuid,revision text,published_at timestamptz);
create table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id uuid primary key,api_source_key text,revision text,state text,query jsonb);
create table internal.jiaowubao_open_api_schedule_snapshot_ingest_items(run_id uuid,source_key text,item jsonb);

\ir ../../supabase/migrations/20260828000500_jiaowubao_trial_sync_atomic.sql
\ir ../../supabase/migrations/20260828000700_teacher_change_trial_jiaowubao.sql
\ir ../../supabase/migrations/20260830000100_trial_lp_finalize_tasks.sql
\ir ../../supabase/migrations/20260908045717_reconcile_jiaowubao_trial_event_lifecycle.sql

\ir ../../supabase/migrations/20261020113443_trial_screenshot_confirmation.sql

create table internal.jiaowubao_open_api_schedule_projection_jobs(api_source_key text primary key,revision text,state text);
create function internal.jiaowubao_schedule_projection_allows_stale_trial(p_revision text,p_actor text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from internal.jiaowubao_open_api_schedule_projection_jobs projection_job
    where projection_job.api_source_key='jwb-open-api-schedule' and projection_job.revision=p_revision and projection_job.state='authority_done')
    and p_actor is not distinct from 'Ops Admin'
$$;
revoke all on function internal.jiaowubao_schedule_projection_allows_stale_trial(text,text) from public,anon,authenticated,service_role;
do $bind_stale_trial_recovery$
declare definition text; needle text:='pointer.published_at < clock_timestamp() - interval ''2 hours''';
begin
  select pg_catalog.pg_get_functiondef('public.sync_jiaowubao_trial_matches_atomic_v2(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure) into definition;
  if strpos(definition,needle)=0 then raise exception 'fixture_trial_sync_v2_freshness_guard_changed'; end if;
  execute replace(definition,needle,'('||needle||' and not internal.jiaowubao_schedule_projection_allows_stale_trial(p_snapshot_revision,p_actor))');
end;
$bind_stale_trial_recovery$;

create temporary table fixture_v2_definition as select pg_catalog.pg_get_functiondef('public.sync_jiaowubao_trial_matches_atomic_v2(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure) as definition;
\ir ../../supabase/migrations/20261020211253_jiaowubao_trial_handover_enrichment_v3.sql
do $$ begin if (select definition from fixture_v2_definition) is distinct from pg_catalog.pg_get_functiondef('public.sync_jiaowubao_trial_matches_atomic_v2(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure) then raise exception 'Released v2 function was changed'; end if; end $$;
drop table fixture_v2_definition;

create function internal.fixture_expect_failure(statement text,expected text) returns void language plpgsql as $$
declare failed boolean := false;
begin
  begin execute statement; exception when others then
    if position(expected in sqlerrm)=0 then raise exception 'Expected %, received %',expected,sqlerrm; end if;
    failed := true;
  end;
  if not failed then raise exception 'Expected failure: %',expected; end if;
end $$;
