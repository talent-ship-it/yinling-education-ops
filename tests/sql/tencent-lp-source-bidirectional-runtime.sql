\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;
create schema internal;
create schema extensions;
create extension pgcrypto with schema extensions;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create table public.ops_state(entity text primary key,payload jsonb,version bigint,updated_at timestamptz default now(),updated_by text);
create table public.ops_mutation_log(entity text,version bigint,actor text);
create table internal.legacy_task_deadline_freezes(task_id text primary key);
create table internal.operational_contract_audit(id uuid primary key default extensions.gen_random_uuid());
create function internal.verify_ops_secret(text) returns boolean language sql as $$ select $1='synthetic-task-secret' $$;
create function internal.append_operational_contract_audit(text,text,text,text,jsonb) returns uuid language plpgsql as $$
declare result uuid;
begin insert into internal.operational_contract_audit default values returning id into result; return result; end $$;
\ir ../../supabase/migrations/20260828000600_trial_ledger_atomic.sql
\ir ../../supabase/migrations/20260830000100_trial_lp_finalize_tasks.sql
\ir ../../supabase/migrations/20261021074408_add_trial_cancelled_and_nil_statuses.sql
\ir trial-payment-lifecycle-definitions.sql
create table internal.jiaowubao_open_api_schedule_snapshot_ingest_runs(id uuid primary key,api_source_key text,revision text,state text,query jsonb);
\ir ../../supabase/migrations/20260828000500_jiaowubao_trial_sync_atomic.sql
\ir ../../supabase/migrations/20260828000700_teacher_change_trial_jiaowubao.sql
\ir ../../supabase/migrations/20260830000100_trial_lp_finalize_tasks.sql
\ir ../../supabase/migrations/20260908045717_reconcile_jiaowubao_trial_event_lifecycle.sql
\ir ../../supabase/migrations/20261025213044_hr_trial_task_follow_up_and_lp_finalized.sql

\ir ../../supabase/migrations/20261025215113_tencent_lp_source_bidirectional.sql
create function pg_temp.sync_args(p_field text,p_revision bigint,p_expected jsonb,p_value jsonb,p_before jsonb default 'null',p_version bigint default 1,p_command uuid default extensions.gen_random_uuid()) returns jsonb language sql as $$
  select jsonb_build_object('lpItemId','LP-TENCENT','identityHash',repeat('a',64),'field',p_field,'revision',p_revision,
    'expectedSystem',p_expected,'value',p_value,'before',p_before,'expectedLpVersion',p_version,'commandId',p_command);
$$;
create function pg_temp.sync_call(p_action text,p_args jsonb default '{}') returns jsonb language sql as $$
  select public.tencent_lp_source_sync_action('synthetic-task-secret','59000000-0000-4000-8000-000000000001',p_action,p_args);
$$;
insert into public.ops_state values
 ('lpItems','[{"id":"LP-TENCENT","studentId":"S-TENCENT","workflowType":"试听 LP","stage":"待跟进","trialIntake":{"planner":"Tara","requestSentAt":"2026-10-22T09:47:00.000Z"},"trialLedgerOverrides":{"planner":"Tara"},"trialSchedule":{"eventId":"synthetic-event","startsAt":"2026-10-28T04:00:00.000Z"}}]',1,now(),'fixture'),
 ('tasks','[{"id":"n2","studentId":"S-TENCENT","owner":"Ella","requestAnchorBookingId":"LP-TENCENT","anchorBookingId":"JWB:synthetic-event","ruleKey":"trial.jiaowubao.lp-materials-n2","dueAt":"2026-10-26T07:00:00.000Z","status":"today"}]',1,now(),'fixture');
do $$
declare r jsonb; args jsonb; changed jsonb; lp_version bigint;
begin
  if pg_temp.sync_call('claim')->>'claimed'<>'true' then raise exception 'Lease not acquired'; end if;
  if public.tencent_lp_source_sync_action('synthetic-task-secret','59000000-0000-4000-8000-000000000002','claim')->>'claimed'<>'false' then raise exception 'Concurrent lease accepted'; end if;
  begin perform public.tencent_lp_source_sync_action('wrong','59000000-0000-4000-8000-000000000001','claim'); raise exception 'Wrong secret accepted'; exception when insufficient_privilege then null; end;
  begin perform public.tencent_lp_source_sync_action(null,'59000000-0000-4000-8000-000000000001','claim'); raise exception 'Null secret accepted'; exception when insufficient_privilege then null; end;
  args:=pg_temp.sync_args('planner',0,'"Tara"','"Tara"');
  r:=pg_temp.sync_call('observe',args);
  if r->>'revision'<>'1' or r->'commonValue'<>'"Tara"'::jsonb then raise exception 'Initial baseline invalid'; end if;
  if pg_temp.sync_call('observe',args)->>'revision'<>'1' then raise exception 'Exact replay changed revision'; end if;
  begin perform pg_temp.sync_call('observe',args||'{"value":"Abby"}'); raise exception 'Command conflict accepted'; exception when unique_violation then null; end;
  begin perform pg_temp.sync_call('observe',pg_temp.sync_args('planner',0,'"Tara"','"Tara"')); raise exception 'Stale baseline accepted'; exception when serialization_failure then null; end;
  begin perform pg_temp.sync_call('observe',pg_temp.sync_args('planner',1,'"Tara"','"Tara"','null',99)); raise exception 'Stale LP version accepted'; exception when serialization_failure then null; end;
  begin perform pg_temp.sync_call('observe',pg_temp.sync_args('planner',1,'"Abby"','"Abby"')); raise exception 'Stale field accepted'; exception when serialization_failure then null; end;
  begin perform pg_temp.sync_call('read',jsonb_build_object('lpItemId','LP-TENCENT','identityHash',repeat('b',64))); raise exception 'Identity drift accepted'; exception when serialization_failure then null; end;
  begin perform pg_temp.sync_call('observe',pg_temp.sync_args('studentName',0,'null','"Changed"')); raise exception 'Identity field allowed'; exception when invalid_parameter_value then null; end;
  update public.ops_state set payload=jsonb_set(payload,'{0,trialLedgerOverrides,planner}','"Abby"'),version=2 where entity='lpItems';
  r:=pg_temp.sync_call('stage',pg_temp.sync_args('planner',1,'"Abby"','"Abby"','"Tara"',2));
  if r#>>'{pending,phase}'<>'planned' then raise exception 'Write plan not persisted'; end if;
  r:=pg_temp.sync_call('attempt',pg_temp.sync_args('planner',2,'"Abby"','"Abby"','"Tara"',2));
  perform pg_temp.sync_call('release'); perform pg_temp.sync_call('claim');
  if pg_temp.sync_call('read',jsonb_build_object('lpItemId','LP-TENCENT','identityHash',repeat('a',64)))#>>'{fields,0,pending,phase}'<>'attempted' then raise exception 'Unknown attempt lost across lease'; end if;
  begin perform pg_temp.sync_call('cancel',pg_temp.sync_args('planner',3,'"Abby"','null','"Tara"',2)); raise exception 'Uncertain attempt cancelled'; exception when serialization_failure then null; end;
  update public.ops_state set payload=jsonb_set(payload,'{0,trialLedgerOverrides,planner}','"Tara"'),version=3 where entity='lpItems';
  args:=pg_temp.sync_args('planner',3,'"Abby"','"Abby"','"Tara"',2);
  r:=pg_temp.sync_call('complete',args);
  if r->'commonValue'<>'"Abby"'::jsonb or (select payload#>>'{0,trialLedgerOverrides,planner}' from public.ops_state where entity='lpItems')<>'Tara' then raise exception 'Known write C overwrote newer system D'; end if;
  if pg_temp.sync_call('complete',args)->>'revision'<>'4' then raise exception 'Completion replay changed baseline'; end if;
  perform pg_temp.sync_call('stage',pg_temp.sync_args('planner',4,'"Tara"','"Tara"','"Abby"',3));
  perform pg_temp.sync_call('attempt',pg_temp.sync_args('planner',5,'"Tara"','"Tara"','"Abby"',3));
  r:=pg_temp.sync_call('complete',pg_temp.sync_args('planner',6,'"Tara"','"Tara"','"Abby"',3));
  if r->'commonValue'<>'"Tara"'::jsonb then raise exception 'Cycling baseline not advanced'; end if;
  args:=pg_temp.sync_args('planner',7,'"Tara"','"Eileen"','"Tara"',3);
  r:=pg_temp.sync_call('import',args);
  if r->'commonValue'<>'"Eileen"'::jsonb or r->>'lpVersion'<>'4' then raise exception 'Tencent conflict import failed'; end if;
  if pg_temp.sync_call('import',args)->>'revision'<>'8' or (select version from public.ops_state where entity='lpItems')<>4 then raise exception 'Import replay mutated system'; end if;
  begin perform pg_temp.sync_call('import',pg_temp.sync_args('planner',8,'"Eileen"','null','null',4)); raise exception 'Blank import allowed'; exception when invalid_parameter_value then null; end;
  r:=pg_temp.sync_call('import',pg_temp.sync_args('trialPaid',0,'null','false','null',4));
  if r->'commonValue'<>'false'::jsonb then raise exception 'Explicit false lost'; end if;
  r:=pg_temp.sync_call('import',pg_temp.sync_args('lpFinalized',0,'null','true','null',5));
  if (select payload->0->>'status' from public.ops_state where entity='tasks')<>'done' then raise exception 'Real task reconciliation bypassed'; end if;
  r:=pg_temp.sync_call('import',pg_temp.sync_args('trialLedgerNote',0,'null','"Synthetic note"','null',6));
  if r->'commonValue'<>'"Synthetic note"'::jsonb then raise exception 'Nonblank note failed'; end if;
  if (select payload#>>'{0,trialIntake,requestSentAt}' from public.ops_state where entity='lpItems')<>'2026-10-22T09:47:00.000Z' then raise exception 'Original request clock changed'; end if;
  lp_version:=(select version from public.ops_state where entity='lpItems');
  begin perform pg_temp.sync_call('stage',pg_temp.sync_args('trialPaid',1,'false','null','false',lp_version)); raise exception 'Null export allowed'; exception when serialization_failure then null; end;
  update internal.tencent_lp_source_lease set expires_at=clock_timestamp()-interval '1 second';
  begin perform pg_temp.sync_call('read',jsonb_build_object('lpItemId','LP-TENCENT','identityHash',repeat('a',64))); raise exception 'Expired lease accepted'; exception when serialization_failure then null; end;
  if public.tencent_lp_source_sync_action('synthetic-task-secret','59000000-0000-4000-8000-000000000002','claim')->>'claimed'<>'true' then raise exception 'Expired lease not reclaimable'; end if;
  begin perform pg_temp.sync_call('read',jsonb_build_object('lpItemId','LP-TENCENT','identityHash',repeat('a',64))); raise exception 'Old token accepted'; exception when serialization_failure then null; end;
  if exists(select 1 from pg_class where oid in ('internal.tencent_lp_source_baselines'::regclass,'internal.tencent_lp_source_lease'::regclass) and not relrowsecurity) then raise exception 'RLS missing'; end if;
  if exists(select 1 from pg_class p,lateral aclexplode(p.relacl) acl where p.oid in ('internal.tencent_lp_source_baselines'::regclass,'internal.tencent_lp_source_lease'::regclass) and acl.grantee<>p.relowner) then raise exception 'Private storage exposed'; end if;
  if exists(select 1 from information_schema.columns where table_schema='internal' and table_name='tencent_lp_source_baselines' and column_name in ('student_name','guardian','source_row','payload','credential')) then raise exception 'Unnecessary PII persisted'; end if;
end $$;
rollback;
