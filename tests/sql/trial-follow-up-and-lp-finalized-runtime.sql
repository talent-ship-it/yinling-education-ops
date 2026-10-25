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
create temporary table payment_function_security as
select proacl,prosecdef,proconfig from pg_proc where oid='public.mutate_trial_payment_task_lifecycle_tx(text,text,jsonb,text,text,jsonb,text,text)'::regprocedure;
\ir ../../supabase/migrations/20261025213044_hr_trial_task_follow_up_and_lp_finalized.sql
\ir ../../supabase/migrations/20261025213044_hr_trial_task_follow_up_and_lp_finalized.sql

do $$
declare
  receipt record; command text:='46000000-0000-4000-8000-000000000001';
  request_at text:='2026-10-20T02:15:00.000Z';
  tasks jsonb; lp jsonb; task jsonb; matches jsonb;
  version_before bigint; finalized_result text:='试听台账已确认LP定稿';
  short_lp jsonb;
begin
  if internal.trial_ledger_value_valid('lpFinalized','true') is distinct from true
    or internal.trial_ledger_value_valid('lpFinalized','false') is distinct from true
    or internal.trial_ledger_value_valid('lpFinalized','null') is distinct from true
    or internal.trial_ledger_value_valid('lpFinalized','"true"') is distinct from false
    or internal.trial_ledger_stored_value('{"trialLpFinalized":false}','lpFinalized') is distinct from 'false'::jsonb
    or internal.trial_ledger_stored_value('{}','lpFinalized') is distinct from 'null'::jsonb
    or internal.trial_ledger_value_valid('resultStatus','"NIL"') is distinct from true then raise exception 'LP finalized field contract failed'; end if;
  lp:=jsonb_build_object('id','LP-FOLLOW','studentId','S-FOLLOW','workflowType','试听 LP','stage','待跟进','trialIntake',jsonb_build_object('planner','Tara','requestSentAt',request_at),
    'fields','{"writingRequired":true}'::jsonb, 'trialLedgerOverrides','{"planner":"Eileen"}'::jsonb,
    'trialSchedule',jsonb_build_object('source','jiaowubao-open-api','sourceRevision','sha256:'||repeat('a',64),'eventId','evt-follow','startsAt','2026-10-28T04:00:00.000Z','endsAt','2026-10-28T05:00:00.000Z','teacherName','Synthetic Teacher','studentName','Synthetic Child'));
  tasks:='[{"id":"n3","studentId":"S-FOLLOW","owner":"Ella","title":"N-3","requestAnchorBookingId":"LP-FOLLOW","anchorBookingId":"JWB:evt-follow","ruleKey":"trial.jiaowubao.lp-finalize-tomorrow-n3","dueAt":"2026-10-25T07:00:00.000Z","status":"overdue","completionNote":"保留备注"},
    {"id":"n2","studentId":"S-FOLLOW","owner":"Ella","title":"N-2","requestAnchorBookingId":"LP-FOLLOW","anchorBookingId":"JWB:evt-follow","ruleKey":"trial.jiaowubao.lp-materials-n2","dueAt":"2026-10-26T07:00:00.000Z","status":"today"},
    {"id":"manual","studentId":"S-FOLLOW","owner":"Ella","title":"Manual","requestAnchorBookingId":"LP-FOLLOW","anchorBookingId":"JWB:evt-follow","ruleKey":"trial.jiaowubao.lp-materials-n2","dueAt":"2026-10-26T07:00:00.000Z","status":"done","result":"人工完成"},
    {"id":"old-event","studentId":"S-FOLLOW","owner":"Ella","title":"Old","requestAnchorBookingId":"LP-FOLLOW","anchorBookingId":"JWB:old","ruleKey":"trial.jiaowubao.lp-materials-n2","dueAt":"2026-10-26T07:00:00.000Z","status":"today"}]';
  select jsonb_agg(value||'{"watchers":["Ops Admin"],"assignees":["Ella","Ops Admin"]}'::jsonb order by ordinality) into tasks from jsonb_array_elements(tasks) with ordinality;
  if internal.trial_lp_finalize_tasks(tasks,lp,true,now())->0->>'status' <> 'done' then raise exception 'Direct helper failed'; end if;
  insert into public.ops_state values('lpItems',jsonb_build_array(lp),1,now(),'fixture'),('tasks',tasks,1,now(),'fixture'),
    ('students','[{"id":"S-FOLLOW","name":"Synthetic Child","owner":"Ella","planner":"Tara"}]',1,now(),'fixture');
  select * into receipt from public.mutate_trial_ledger_field_atomic('synthetic-task-secret',command,
    '{"lpItemId":"LP-FOLLOW","field":"lpFinalized","expectedValue":null,"value":true}','LP-FOLLOW','lpFinalized','null','true','Ella');
  if not receipt.applied or internal.trial_ledger_stored_value((receipt.lp_items_row).payload->0,'lpFinalized')<>'true'::jsonb then raise exception 'Finalize field did not commit'; end if;
  if (select count(*) from public.ops_state s,lateral jsonb_array_elements(s.payload) t where s.entity='tasks' and t->>'result'=finalized_result)<>2 then raise exception 'Finalize tasks did not close'; end if;
  if (select version from public.ops_state where entity='tasks')<>2 then raise exception 'Task version did not advance once'; end if;
  select * into receipt from public.mutate_trial_ledger_field_atomic('synthetic-task-secret',command,
    '{"lpItemId":"LP-FOLLOW","field":"lpFinalized","expectedValue":null,"value":true}','LP-FOLLOW','lpFinalized','null','true','Ella');
  if receipt.applied or (select version from public.ops_state where entity='tasks')<>2 then raise exception 'Finalize replay changed tasks'; end if;
  select * into receipt from public.mutate_trial_ledger_field_atomic('synthetic-task-secret','46000000-0000-4000-8000-000000000002',
    '{"lpItemId":"LP-FOLLOW","field":"lpFinalized","expectedValue":true,"value":false}','LP-FOLLOW','lpFinalized','true','false','Ella');
  if not receipt.applied or (select version from public.ops_state where entity='tasks')<>3 then raise exception 'Uncheck did not restore tasks once'; end if;
  if (select count(*) from public.ops_state s,lateral jsonb_array_elements(s.payload) t where s.entity='tasks' and t->>'status'='done')<>1 then raise exception 'Manual completion was changed or automatic tasks did not reopen'; end if;
  if (select payload#>>'{0,trialIntake,requestSentAt}' from public.ops_state where entity='lpItems')<>request_at then raise exception 'Original request clock reset'; end if;
  if (select payload->2 from public.ops_state where entity='tasks')<>tasks->2 or (select payload->3 from public.ops_state where entity='tasks')<>tasks->3 then raise exception 'Unrelated task evidence changed'; end if;
  version_before:=(select version from public.ops_state where entity='lpItems');
  begin
    perform public.mutate_trial_ledger_field_atomic('synthetic-task-secret','46000000-0000-4000-8000-000000000003',
      '{"lpItemId":"LP-FOLLOW","field":"lpFinalized","expectedValue":true,"value":false}','LP-FOLLOW','lpFinalized','true','false','Ella');
    raise exception 'Stale field OCC accepted';
  exception when sqlstate '40001' then null; end;
  if (select version from public.ops_state where entity='lpItems')<>version_before then raise exception 'OCC failure partially committed'; end if;
  select * into receipt from public.mutate_trial_ledger_field_atomic('synthetic-task-secret','46000000-0000-4000-8000-000000000004',
    '{"lpItemId":"LP-FOLLOW","field":"lpFinalized","expectedValue":false,"value":null}','LP-FOLLOW','lpFinalized','false','null','Ella');
  if (receipt.lp_items_row).payload->0 ? 'trialLpFinalized' then raise exception 'Nullable finalized reset failed'; end if;
  task:=tasks->0||'{"id":"review","ruleKey":"trial.jiaowubao.request-follow-up-n3","watchers":["Ops Admin"],"assignees":["Ella","Ops Admin"]}';
  matches:='[{"lpItemId":"LP-FOLLOW","eventId":"evt-follow"}]';
  if internal.jiaowubao_trial_sync_generated_task_valid(task,matches,jsonb_build_array(lp)) is distinct from true then raise exception 'N-3 review rejected'; end if;
  if internal.jiaowubao_trial_sync_generated_task_valid(task,matches,jsonb_build_array(jsonb_set(lp,'{fields}','{}'))) is true then raise exception 'Unnecessary N-3 review accepted'; end if;
  task:=task||'{"ruleKey":"trial.jiaowubao.payment-n2","owner":"Eileen","assignees":["Eileen"]}';
  if internal.jiaowubao_trial_sync_generated_task_valid(task,matches,jsonb_build_array(lp)) is distinct from true then raise exception 'Ledger planner override rejected'; end if;
  short_lp:=jsonb_set(lp,'{trialIntake,requestSentAt}','"2026-10-27T02:00:00.000Z"');
  task:=tasks->0||jsonb_build_object('status','done','result',finalized_result);
  if internal.trial_lp_finalize_tasks(jsonb_build_array(task),short_lp,false,now())->0->>'status'<>'done' then raise exception 'Short-notice obsolete N-3 revived'; end if;
  insert into internal.legacy_task_deadline_freezes values('n3');
  select * into receipt from public.mutate_trial_ledger_field_atomic('synthetic-task-secret','46000000-0000-4000-8000-000000000005',
    '{"lpItemId":"LP-FOLLOW","field":"resultStatus","expectedValue":null,"value":"被家长取消"}','LP-FOLLOW','resultStatus','null','"被家长取消"','Ella');
  if not receipt.applied or (select payload->0->>'status' from public.ops_state where entity='tasks')='done' then raise exception 'Cancellation altered frozen task'; end if;
  if (select payload->1->>'result' from public.ops_state where entity='tasks')<>'关联试听已取消'
    or (select payload->2->>'result' from public.ops_state where entity='tasks')<>'人工完成'
    or (select payload->3->>'result' from public.ops_state where entity='tasks')<>'关联试听已取消' then raise exception 'Cancellation failed to converge only open related tasks'; end if;
  if internal.trial_lp_finalize_tasks((select payload from public.ops_state where entity='tasks'),lp||'{"resultStatus":"被家长取消"}'::jsonb,false,now())->1->>'status'<>'done' then raise exception 'Cancelled task revived'; end if;
  if exists (select 1 from pg_proc p,lateral aclexplode(p.proacl) acl where p.oid='internal.trial_lp_finalize_tasks(jsonb,jsonb,boolean,timestamptz)'::regprocedure and acl.privilege_type='EXECUTE' and acl.grantee<>p.proowner) then raise exception 'Internal task projector exposed'; end if;
end $$;
do $$
declare receipt record; before_tasks jsonb; before_version bigint;
begin
  update public.ops_state set payload = jsonb_build_array((payload->0)-'resultStatus') where entity='lpItems';
  before_tasks := '[{"id":"nonterminal-source-task","studentId":"S-FOLLOW","requestAnchorBookingId":"LP-FOLLOW","anchorBookingId":"JWB:evt-follow","ruleKey":"trial.jiaowubao.prep-n1","status":"today","dueAt":"2026-10-27T07:00:00.000Z"}]'::jsonb;
  update public.ops_state set payload=before_tasks where entity='tasks';
  before_version := (select version from public.ops_state where entity='tasks');
  select * into receipt from public.mutate_trial_ledger_field_atomic('synthetic-task-secret','46000000-0000-4000-8000-000000000006',
    '{"lpItemId":"LP-FOLLOW","field":"resultStatus","expectedValue":null,"value":"NIL"}','LP-FOLLOW','resultStatus','null','"NIL"','Ella');
  if not receipt.applied or (select payload from public.ops_state where entity='tasks') is distinct from before_tasks then raise exception 'NIL implied cancellation'; end if;
  select * into receipt from public.mutate_trial_ledger_field_atomic('synthetic-task-secret','46000000-0000-4000-8000-000000000007',
    '{"lpItemId":"LP-FOLLOW","field":"resultStatus","expectedValue":"NIL","value":"延迟待安排"}','LP-FOLLOW','resultStatus','"NIL"','"延迟待安排"','Ella');
  if not receipt.applied or (receipt.lp_items_row).payload->0->>'resultStatus'<>'延迟待安排'
    or (select payload from public.ops_state where entity='tasks') is distinct from before_tasks
    or (select version from public.ops_state where entity='tasks')<>before_version then raise exception 'Delayed result changed scheduling tasks'; end if;
end $$;

do $$
declare
  receipt record;
  initial_lp jsonb; initial_task jsonb; changed jsonb;
  expected jsonb := '{"bookings":1,"students":1,"lpItems":1,"tasks":1,"teachers":1}';
  command text := 'trial-payment-complete:47000000-0000-4000-8000-000000000001';
  intent jsonb := '{"action":"complete","taskId":"TASK-PLANNER-FOLLOW"}';
  revision text := 'sha256:' || repeat('a',64);
  source_run uuid := '47000000-0000-4000-8000-000000000099';
  before_payload jsonb; before_count integer;
  first_audit uuid;
begin
  if (select row(proacl,prosecdef,proconfig) from pg_proc where oid='public.mutate_trial_payment_task_lifecycle_tx(text,text,jsonb,text,text,jsonb,text,text)'::regprocedure)
    is distinct from (select row(proacl,prosecdef,proconfig) from payment_function_security) then raise exception 'Payment function security changed'; end if;
  initial_lp := jsonb_build_object('id','LP-PLANNER-FOLLOW','studentId','S-PLANNER-FOLLOW','workflowType','试听 LP','stage','待资料',
    'trialIntake','{"planner":"Tara"}'::jsonb,'trialLedgerOverrides','{"planner":"Eileen"}'::jsonb,
    'fields','{"trialPaymentMethod":"后置付费试听","planner":"Tara"}'::jsonb,
    'trialSchedule',jsonb_build_object('source','jiaowubao-open-api','sourceRevision',revision,'eventId','event-planner-follow'));
  initial_task := '{"id":"TASK-PLANNER-FOLLOW","studentId":"S-PLANNER-FOLLOW","owner":"Eileen","assignees":["Eileen"],"watchers":["Ops Admin"],
    "category":"试听","ruleKey":"trial.jiaowubao.payment-n2","anchorBookingId":"JWB:event-planner-follow","requestAnchorBookingId":"LP-PLANNER-FOLLOW",
    "status":"today","dueAt":"2026-10-20T00:00:00.000Z"}'::jsonb;
  update public.ops_state set payload=jsonb_build_array(initial_lp),version=1 where entity='lpItems';
  update public.ops_state set payload=jsonb_build_array(initial_task),version=1 where entity='tasks';
  insert into public.ops_state(entity,payload,version,updated_by) values
    ('students','[{"id":"S-PLANNER-FOLLOW","owner":"Ella","planner":"Tara"}]',1,'fixture'),
    ('bookings','[]',1,'fixture'),('teachers','[]',1,'fixture')
    on conflict(entity) do update set payload=excluded.payload,version=excluded.version,updated_by=excluded.updated_by;
  insert into internal.jiaowubao_open_api_schedule_snapshot_current values('jwb-open-api-schedule',source_run,revision,now());
  insert into internal.jiaowubao_open_api_schedule_snapshot_ingest_items values(source_run,'event-planner-follow');
  select count(*) into before_count from internal.operational_contract_audit;
  select jsonb_agg(to_jsonb(s) order by entity) into before_payload from public.ops_state s;
  begin
    perform public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected,'Tara','staff');
    raise exception 'Previous planner retained completion authority';
  exception when insufficient_privilege then null; end;
  begin
    update public.ops_state set payload=jsonb_build_array(initial_task || '{"owner":"Tara","assignees":["Tara"]}'::jsonb) where entity='tasks';
    perform public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected,'Tara','staff');
    raise exception 'Stale recipients retained previous planner authority';
  exception when insufficient_privilege then null; end;
  for changed in select value from jsonb_array_elements(jsonb_build_array(
    initial_task || '{"owner":"Tara","assignees":["Tara"]}'::jsonb,
    initial_task || '{"assignees":["Eileen","Tara"]}'::jsonb,
    initial_task || '{"watchers":["Ops Admin","Tara"]}'::jsonb,
    initial_task || '{"requestAnchorBookingId":"OTHER-LP"}'::jsonb,
    initial_task || '{"anchorBookingId":"JWB:other-event"}'::jsonb
  )) loop
    begin
      update public.ops_state set payload=jsonb_build_array(changed) where entity='tasks';
      perform public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected,'Eileen','staff');
      raise exception 'Drifted payment task authority accepted';
    exception when insufficient_privilege then null; end;
  end loop;
  for changed in select value from jsonb_array_elements(jsonb_build_array(
    initial_lp || '{"stage":"完成"}'::jsonb,
    jsonb_set(initial_lp,'{trialSchedule,eventId}','"other-event"'),
    jsonb_set(initial_lp,'{trialSchedule,sourceRevision}','"sha256:invalid"')
  )) loop
    begin
      update public.ops_state set payload=jsonb_build_array(changed) where entity='lpItems';
      perform public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected,'Eileen','staff');
      raise exception 'Drifted LP authority accepted';
    exception when insufficient_privilege then null; end;
  end loop;
  begin
    update public.ops_state set payload=jsonb_build_array(initial_lp,initial_lp) where entity='lpItems';
    perform public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected,'Eileen','staff');
    raise exception 'Ambiguous LP authority accepted';
  exception when insufficient_privilege then null; end;
  begin
    update public.ops_state set payload=jsonb_set(payload,'{0,importArchived}','true') where entity='students';
    perform public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected,'Eileen','staff');
    raise exception 'Archived student payment accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected,'Eileen','teacher');
    raise exception 'Teacher payment authority accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected || '{"tasks":2}', 'Eileen','staff');
    raise exception 'Stale payment versions accepted';
  exception when serialization_failure then null; end;
  begin
    update internal.jiaowubao_open_api_schedule_snapshot_current set revision='sha256:'||repeat('b',64);
    perform public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected,'Eileen','staff');
    raise exception 'Stale source revision accepted';
  exception when sqlstate '55000' then null; end;
  if (select jsonb_agg(to_jsonb(s) order by entity) from public.ops_state s) is distinct from before_payload
    or (select count(*) from internal.operational_contract_audit) <> before_count then raise exception 'Denied payment changed state or audit'; end if;
  select * into receipt from public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected,'Eileen','staff');
  if not receipt.applied or (receipt.lp_items_row).payload->0->>'trialPaid'<>'true'
    or (receipt.tasks_row).payload->0->>'status'<>'done'
    or (receipt.tasks_row).payload->0->>'result'<>'已由规划老师确认试听付款'
    or (receipt.tasks_row).version<>2 or (receipt.lp_items_row).version<>2 then raise exception 'Replacement planner did not complete atomically'; end if;
  first_audit := receipt.audit_entry_id;
  select * into receipt from public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'complete','TASK-PLANNER-FOLLOW',expected,'Eileen','staff');
  if receipt.applied or receipt.audit_entry_id<>first_audit or (receipt.tasks_row).version<>2
    or (select count(*) from internal.operational_contract_audit)<>before_count+1 then raise exception 'Payment replay duplicated writes'; end if;
  command := 'trial-payment-reopen:47000000-0000-4000-8000-000000000002';
  intent := '{"action":"reopen","taskId":"TASK-PLANNER-FOLLOW"}';
  expected := expected || '{"lpItems":2,"tasks":2}';
  begin
    perform public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'reopen','TASK-PLANNER-FOLLOW',expected,'Tara','staff');
    raise exception 'Previous planner retained reopen authority';
  exception when insufficient_privilege then null; end;
  select * into receipt from public.mutate_trial_payment_task_lifecycle_tx('synthetic-task-secret',command,intent,'reopen','TASK-PLANNER-FOLLOW',expected,'Eileen','staff');
  if not receipt.applied or (receipt.lp_items_row).payload->0->>'trialPaid'<>'false'
    or (receipt.tasks_row).payload->0->>'status'='done'
    or (receipt.tasks_row).payload->0 ? 'closedAt'
    or (receipt.tasks_row).version<>3 or (receipt.lp_items_row).version<>3 then raise exception 'Replacement planner did not reopen atomically'; end if;
end $$;

rollback;
