\set ON_ERROR_STOP on
-- Run only in a disposable, empty LOCAL PostgreSQL database. All fixture
-- objects/data are rolled back, so the same file can run repeatedly.
begin;
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
create table internal.jiaowubao_open_api_schedule_snapshot_ingest_items(run_id uuid,source_key text);

\ir ../../supabase/migrations/20260828000500_jiaowubao_trial_sync_atomic.sql
\ir ../../supabase/migrations/20260828000700_teacher_change_trial_jiaowubao.sql
\ir ../../supabase/migrations/20260830000100_trial_lp_finalize_tasks.sql
\ir ../../supabase/migrations/20260908045717_reconcile_jiaowubao_trial_event_lifecycle.sql

create function internal.fixture_expect_failure(statement text,expected text) returns void language plpgsql as $$
declare failed boolean := false;
begin
  begin execute statement; exception when others then
    if position(expected in sqlerrm)=0 then raise exception 'Expected %, received %',expected,sqlerrm; end if;
    failed := true;
  end;
  if not failed then raise exception 'Expected failure: %',expected; end if;
end $$;

do $$
declare
  revision text := 'sha256:'||repeat('b',64);
  old_revision text := 'sha256:'||repeat('a',64);
  run_id uuid := extensions.gen_random_uuid();
  command_id text := extensions.gen_random_uuid()::text;
  source_start text := to_char(now() at time zone 'Australia/Melbourne','YYYY-MM-DD');
  source_end text := to_char((now()+interval '30 days') at time zone 'Australia/Melbourne','YYYY-MM-DD');
  future_at text := to_char((now()+interval '2 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  historical_at text := to_char((now()-interval '1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  window_value jsonb;
  schedule jsonb;
  lp jsonb;
  other_lp jsonb;
  next_lp jsonb;
  open_task jsonb;
  done_task jsonb;
  unrelated_task jsonb;
  revocations jsonb;
  matches jsonb;
  intent jsonb;
  receipt record;
  statement text;
  audit_count integer;
begin
  window_value := jsonb_build_object('startsAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char((now()+interval '7 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  schedule := jsonb_build_object('source','jiaowubao-open-api','sourceRevision',old_revision,'eventId','E-1','startsAt',future_at,
    'endsAt',to_char((now()+interval '2 days 1 hour') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'teacherName','Synthetic Teacher','plannerHint','Tara','matchedAt',window_value->>'startsAt');
  lp := jsonb_build_object('id','LP-1','studentId','S-1','workflowType','试听 LP','stage','待跟进','owner','Ella','trialSchedule',schedule);
  next_lp := lp-'trialSchedule';
  open_task := jsonb_build_object('id','OPEN','title','Synthetic reminder','owner','Ella','studentId','S-1','status','upcoming','ruleKey','trial.jiaowubao.today','anchorBookingId','JWB:E-1','requestAnchorBookingId','LP-1',
    'dueAt',future_at,'assignees',jsonb_build_array('Ella'),'watchers',jsonb_build_array('Ops Admin'));
  done_task := open_task||'{"id":"DONE","status":"done","result":"Previously completed"}'::jsonb;
  unrelated_task := open_task||'{"id":"UNRELATED","anchorBookingId":"JWB:E-2"}'::jsonb;
  revocations := jsonb_build_array(jsonb_build_object('lpItemId','LP-1','eventId','E-1','startsAt',future_at));
  intent := jsonb_build_object('snapshotRevision',revision,'window',window_value,'matches','[]'::jsonb,'revocations',revocations,'expectedVersions','{"lpItems":1,"tasks":1}'::jsonb);
  insert into public.ops_state(entity,payload,version,updated_by) values('lpItems',jsonb_build_array(lp),1,'fixture'),('tasks',jsonb_build_array(open_task,done_task,unrelated_task),1,'fixture');
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_runs values(run_id,'jwb-open-api-schedule',revision,'complete',jsonb_build_object('start',source_start,'end',source_end));
  insert into internal.jiaowubao_open_api_schedule_snapshot_current values('jwb-open-api-schedule',run_id,revision,now());
  statement := format('select * from public.sync_jiaowubao_trial_matches_atomic_v2(%L,%L,%L::jsonb,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L)',
    'local-jwb-fixture',command_id,intent,revision,'[]',revocations,'{"lpItems":1,"tasks":1}',jsonb_build_array(next_lp),jsonb_build_array(done_task,unrelated_task),'Ella');

  -- A present event may simply have moved outside the browser interval or
  -- contain an invalid time. Whole-revision identity still blocks deletion.
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items values(run_id,'E-1');
  perform internal.fixture_expect_failure(statement,'jiaowubao_trial_revocation_not_proven');
  delete from internal.jiaowubao_open_api_schedule_snapshot_ingest_items where source_key='E-1';
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set state='staging';
  perform internal.fixture_expect_failure(statement,'jiaowubao_trial_revocation_source_incomplete');
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set state='complete';
  update internal.jiaowubao_open_api_schedule_snapshot_current set published_at=now()-interval '3 hours';
  perform internal.fixture_expect_failure(statement,'jiaowubao_trial_revocation_source_incomplete');
  update internal.jiaowubao_open_api_schedule_snapshot_current set published_at=now();
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set query=jsonb_build_object('start',source_start,'end',source_start);
  perform internal.fixture_expect_failure(statement,'jiaowubao_trial_revocation_window_uncovered');
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set query=jsonb_build_object('start',source_start,'end',source_end);
  update public.ops_state set version=2 where entity='lpItems';
  perform internal.fixture_expect_failure(statement,'version_conflict');
  update public.ops_state set version=1 where entity='lpItems';

  -- An event outside the requested interval is never evidence of deletion.
  perform internal.fixture_expect_failure(replace(statement,quote_literal(intent::text),quote_literal(
    jsonb_set(intent,'{window,endsAt}',to_jsonb(future_at))::text)),'jiaowubao_trial_sync_match_outside_window');
  -- The complete source may include history, but an already-started link is
  -- still history even when the source no longer contains its ID.
  update public.ops_state set payload=jsonb_build_array(jsonb_set(lp,'{trialSchedule,startsAt}',to_jsonb(historical_at))) where entity='lpItems';
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set query=jsonb_build_object('start',to_char((now()-interval '1 day') at time zone 'Australia/Melbourne','YYYY-MM-DD'),'end',source_end);
  perform internal.fixture_expect_failure(replace(replace(statement,future_at,historical_at),window_value->>'startsAt',
    to_char((now()-interval '2 hours') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'jiaowubao_trial_revocation_not_proven');
  update public.ops_state set payload=jsonb_build_array(lp) where entity='lpItems';
  update internal.jiaowubao_open_api_schedule_snapshot_ingest_runs set query=jsonb_build_object('start',source_start,'end',source_end);

  -- Completed history cannot be removed, and cancellation cannot delete an
  -- unrelated pending task or retain one of its own stale reminders.
  perform internal.fixture_expect_failure(replace(statement,quote_literal(jsonb_build_array(done_task,unrelated_task)::text),quote_literal(jsonb_build_array(unrelated_task)::text)),'jiaowubao_trial_sync_task_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,quote_literal(jsonb_build_array(done_task,unrelated_task)::text),quote_literal(jsonb_build_array(done_task)::text)),'jiaowubao_trial_sync_task_projection_invalid');
  perform internal.fixture_expect_failure(replace(statement,quote_literal(jsonb_build_array(done_task,unrelated_task)::text),quote_literal(jsonb_build_array(open_task,done_task,unrelated_task)::text)),'jiaowubao_trial_revoked_task_retained');
  execute statement into receipt;
  if not receipt.applied then raise exception 'Revocation was not applied'; end if;
  if (select payload from public.ops_state where entity='lpItems')<>jsonb_build_array(next_lp)
    or (select payload from public.ops_state where entity='tasks')<>jsonb_build_array(done_task,unrelated_task) then raise exception 'Unexpected cancellation projection'; end if;
  if not exists(select 1 from internal.operational_contract_audit where metadata->'revocations'=revocations
      and metadata->'revokedTaskIds'='["OPEN"]'::jsonb and metadata#>'{revokedSchedules,0,schedule}'=schedule) then raise exception 'Cancellation audit missing'; end if;
  select count(*) into audit_count from internal.operational_contract_audit;
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision='sha256:'||repeat('c',64);
  execute statement into receipt;
  if receipt.applied or (select count(*) from internal.operational_contract_audit)<>audit_count then raise exception 'Replay wrote twice'; end if;
  perform internal.fixture_expect_failure(replace(statement,quote_literal('Ella'),quote_literal('Abby')),'jiaowubao_trial_sync_idempotency_conflict');

  -- Existing source-event ownership is enforced in both v1 and v2, including
  -- an already-completed competing LP, under the LP row OCC lock.
  update internal.jiaowubao_open_api_schedule_snapshot_current set revision='sha256:'||repeat('b',64);
  schedule := jsonb_set(schedule,'{sourceRevision}',to_jsonb(revision));
  other_lp := lp||jsonb_build_object('id','LP-2','stage','完成','trialSchedule',schedule);
  update public.ops_state set payload=jsonb_build_array(next_lp,other_lp),version=3 where entity='lpItems';
  update public.ops_state set payload='[]',version=3 where entity='tasks';
  matches := revocations;
  intent := jsonb_build_object('snapshotRevision',revision,'window',window_value,'matches',matches,'expectedVersions','{"lpItems":3,"tasks":3}'::jsonb);
  statement := format('select * from public.sync_jiaowubao_trial_matches_atomic_v2(%L,%L,%L::jsonb,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L)',
    'local-jwb-fixture',extensions.gen_random_uuid()::text,intent,revision,matches,'[]','{"lpItems":3,"tasks":3}',jsonb_build_array(next_lp||jsonb_build_object('trialSchedule',schedule),other_lp),'[]','Ella');
  perform internal.fixture_expect_failure(statement,'jiaowubao_trial_event_already_linked');
  statement := format('select * from public.sync_jiaowubao_trial_matches_atomic(%L,%L,%L::jsonb,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L)',
    'local-jwb-fixture',extensions.gen_random_uuid()::text,intent,revision,matches,'{"lpItems":3,"tasks":3}',jsonb_build_array(next_lp||jsonb_build_object('trialSchedule',schedule),other_lp),'[]','Ella');
  perform internal.fixture_expect_failure(statement,'jiaowubao_trial_event_already_linked');

  -- Normal v2 matching still works, including generated task insertion, and
  -- the original command intent without a revocations key remains accepted.
  update public.ops_state set payload=jsonb_build_array(next_lp) where entity='lpItems';
  statement := format('select * from public.sync_jiaowubao_trial_matches_atomic_v2(%L,%L,%L::jsonb,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L::jsonb,%L)',
    'local-jwb-fixture',extensions.gen_random_uuid()::text,intent,revision,matches,'[]','{"lpItems":3,"tasks":3}',jsonb_build_array(next_lp||jsonb_build_object('trialSchedule',schedule)),jsonb_build_array(open_task),'Ella');
  execute statement into receipt;
  if not receipt.applied then raise exception 'Normal v2 match was not applied'; end if;
  perform internal.fixture_expect_failure(replace(statement,quote_literal('local-jwb-fixture'),quote_literal('invalid-secret')),'invalid_ops_secret');
  if has_function_privilege('anon','internal.assert_jiaowubao_trial_unique_events(jsonb,jsonb)','execute')
    or has_function_privilege('authenticated','internal.jiaowubao_trial_revoked_task_allowed(jsonb,jsonb,jsonb)','execute')
    or has_function_privilege('service_role','internal.jiaowubao_trial_revoked_task_allowed(jsonb,jsonb,jsonb)','execute') then
    raise exception 'Internal helpers were exposed';
  end if;
  raise notice 'JWB lifecycle runtime: cancellation, scope, freshness, OCC, history, audit, replay and v1/v2 ownership passed';
end $$;
rollback;
