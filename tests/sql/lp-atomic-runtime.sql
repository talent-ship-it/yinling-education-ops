\set ON_ERROR_STOP on

-- Disposable local execution contract for migration 20260819101600.
-- It rebuilds only fixture schemas in the selected database; never run this
-- against production. Example:
--   createdb lp_atomic_fixture
--   psql lp_atomic_fixture -f tests/sql/lp-atomic-runtime.sql

drop schema if exists internal cascade;
drop schema if exists extensions cascade;
drop table if exists public.ops_mutation_log cascade;
drop table if exists public.ops_state cascade;

create schema internal;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists dblink with schema extensions;
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
create table public.ops_mutation_log (entity text not null, version bigint not null, actor text not null);
create table internal.operational_contract_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  action text not null,
  actor text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null,
  created_at timestamptz not null default now()
);
create function internal.verify_ops_secret(p_secret text)
returns boolean language sql immutable set search_path = ''
as $$ select p_secret = 'lp-atomic-fixture-secret' $$;
create function internal.append_operational_contract_audit(
  p_action text, p_actor text, p_target_type text, p_target_id text, p_metadata jsonb default '{}'::jsonb
) returns uuid language plpgsql set search_path = '' as $$
declare saved uuid;
begin
  insert into internal.operational_contract_audit(action, actor, target_type, target_id, metadata)
  values (p_action, p_actor, p_target_type, p_target_id, p_metadata)
  returning id into saved;
  return saved;
end;
$$;

\ir ../../supabase/migrations/20260819101600_lp_create_revision_atomic.sql

-- Models the existing FU attachment lock prefix. If LP ever regresses to
-- students -> files, this async transaction and the LP writer form the exact
-- deadlock cycle that prompted the global files -> students order.
create function internal.lp_fixture_attachment_lock()
returns boolean language plpgsql set search_path = '' as $$
begin
  perform 1 from public.ops_state where entity = 'files' for update;
  perform pg_sleep(0.25);
  perform 1 from public.ops_state where entity = 'students' for update;
  return true;
end;
$$;

insert into public.ops_state(entity, payload, version, updated_by) values
  ('students', '[{"id":"STU-1","name":"Existing Trial","owner":"Abby","planner":"Tara","files":0},{"id":"STU-2","name":"Enrollment","owner":"Abby","planner":"Tara","files":0}]', 1, 'fixture'),
  ('lpItems', '[]', 1, 'fixture'),
  ('tasks', '[]', 1, 'fixture'),
  ('files', '[]', 1, 'fixture');

do $lp_atomic_runtime$
declare
  trial_fields jsonb := '{"responsibleOperations":"Abby","specifiedContentStatus":"无需指定","preparationFollowUp":"否","isUniversityStudent":false,"assignedTeacher":"Abby","subject":"English","oneSentenceDescription":"Trial","locationTimezone":"Australia/Melbourne","contactPerson":"家长","timeMentioned":false,"studentNameKnown":true,"trialPaymentMethod":"免费试听"}';
  handover_fields jsonb := '{"responsibleOperations":"Abby","specifiedContentStatus":"无需指定","preparationFollowUp":"否","isUniversityStudent":false,"planner":"Tara","coursePackage":"20h","subject":"English","enrollmentHandoverNotes":"Completed"}';
  expected jsonb;
  intent jsonb;
  receipt record;
  replay record;
  provisional_student_id text;
  trial_lp_id text;
  due_at timestamptz;
  started_at timestamptz;
  finished_at timestamptz;
  expected_six timestamptz;
  caught_state text;
  caught_message text;
  versions jsonb;
  handover_assignees jsonb;
  lock_connection text;
  lock_result boolean;
begin
  expected := '{"students":1,"lpItems":1,"tasks":1,"files":1}';
  intent := jsonb_build_object('operation','create','studentId','STU-1','workflowType','试听 LP','fields',trial_fields,'expectedVersions',expected);
  lock_connection := format(
    'host=127.0.0.1 port=%s dbname=%s user=%s',
    current_setting('port'), current_database(), current_user
  );
  perform extensions.dblink_connect('lp_attachment_lock', lock_connection);
  perform extensions.dblink_send_query('lp_attachment_lock', 'select internal.lp_fixture_attachment_lock()');
  perform pg_sleep(0.05);
  perform set_config('deadlock_timeout', '100ms', true);
  started_at := clock_timestamp();
  select * into receipt from public.mutate_lp_atomic(
    'lp-atomic-fixture-secret','00000000-0000-4000-8000-000000000001',intent,'create','STU-1',null,null,'试听 LP',trial_fields,null,
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',expected,'Abby'
  );
  finished_at := clock_timestamp();
  select locked into lock_result
  from extensions.dblink_get_result('lp_attachment_lock') as result(locked boolean);
  perform extensions.dblink_disconnect('lp_attachment_lock');
  if lock_result is distinct from true then raise exception 'lp_attachment_lock_probe_failed'; end if;
  if not receipt.applied or receipt.student_id <> 'STU-1'
     or (receipt.students_row).version <> 2 or (receipt.lp_items_row).version <> 2
     or (receipt.tasks_row).version <> 2 or (receipt.files_row).version <> 1 then
    raise exception 'lp_existing_create_receipt_failed';
  end if;
  trial_lp_id := receipt.lp_item_id;
  select (task ->> 'dueAt')::timestamptz into due_at
  from jsonb_array_elements((receipt.tasks_row).payload) task
  where task ->> 'ruleKey' = 'trial.parent-follow-up';
  expected_six := (((started_at at time zone 'Australia/Melbourne')::date + time '18:00') at time zone 'Australia/Melbourne');
  if started_at < expected_six then
    if due_at is distinct from expected_six then raise exception 'lp_parent_follow_up_before_six_failed'; end if;
  elsif due_at < started_at or due_at > finished_at then
    raise exception 'lp_parent_follow_up_after_six_failed';
  end if;

  expected := '{"students":2,"lpItems":2,"tasks":2,"files":1}';
  intent := jsonb_build_object(
    'operation','create',
    'provisionalIntake','{"course":"Year 8 English","guardianWechat":"Daisy","owner":"Abby","planner":"Tara"}'::jsonb,
    'workflowType','试听 LP','fields',trial_fields,'expectedVersions',expected
  );
  select * into receipt from public.mutate_lp_atomic(
    'lp-atomic-fixture-secret','00000000-0000-4000-8000-000000000002',intent,'create',null,
    '{"course":"Year 8 English","guardianWechat":"Daisy","owner":"Abby","planner":"Tara"}',null,'试听 LP',trial_fields,null,
    '{"owner":"Abby","planner":"Tara","mayReassign":true}',expected,'Nixon'
  );
  provisional_student_id := receipt.student_id;
  if not receipt.applied or provisional_student_id !~ '^STU-PROVISIONAL-[a-f0-9]{24}$'
     or not exists (select 1 from jsonb_array_elements((receipt.students_row).payload) x where x ->> 'id' = provisional_student_id)
     or not exists (select 1 from jsonb_array_elements((receipt.lp_items_row).payload) x where x ->> 'studentId' = provisional_student_id)
     or not exists (select 1 from jsonb_array_elements((receipt.tasks_row).payload) x where x ->> 'studentId' = provisional_student_id) then
    raise exception 'lp_provisional_atomic_projection_failed';
  end if;
  select * into replay from public.mutate_lp_atomic(
    'lp-atomic-fixture-secret','00000000-0000-4000-8000-000000000002',intent,'create',null,
    '{"course":"Year 8 English","guardianWechat":"Daisy","owner":"Abby","planner":"Tara"}',null,'试听 LP',trial_fields,null,
    '{"owner":"Abby","planner":"Tara","mayReassign":true}',expected,'Nixon'
  );
  if replay.applied or replay.student_id <> provisional_student_id
     or (replay.students_row).version <> (receipt.students_row).version then
    raise exception 'lp_provisional_replay_failed';
  end if;

  expected := '{"students":3,"lpItems":3,"tasks":3,"files":1}';
  intent := jsonb_build_object('operation','create','studentId','STU-1','workflowType','试听 LP','fields',trial_fields || '{"responsibleOperations":"Ella"}','expectedVersions',expected);
  begin
    perform public.mutate_lp_atomic(
      'lp-atomic-fixture-secret','00000000-0000-4000-8000-000000000003',intent,'create','STU-1',null,null,'试听 LP',trial_fields || '{"responsibleOperations":"Ella"}',null,
      '{"owner":"Ella","planner":"Tara","mayReassign":false}',expected,'Abby'
    );
    raise exception 'lp_assignment_spoof_was_accepted';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'lp_assignment_forbidden' then raise; end if;
  end;

  intent := jsonb_build_object('operation','create','studentId','STU-2','workflowType','学生报名交接','fields',handover_fields,'expectedVersions',expected);
  select * into receipt from public.mutate_lp_atomic(
    'lp-atomic-fixture-secret','00000000-0000-4000-8000-000000000004',intent,'create','STU-2',null,null,'学生报名交接',handover_fields,null,
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',expected,'Abby'
  );
  select task -> 'assignees' into handover_assignees
  from jsonb_array_elements((receipt.tasks_row).payload) task
  where task ->> 'anchorBookingId' = receipt.lp_item_id and task ->> 'ruleKey' = 'lp.handover';
  if not (handover_assignees @> '["Abby","Tara"]'::jsonb) then
    raise exception 'lp_handover_planner_assignee_failed';
  end if;

  expected := '{"students":4,"lpItems":4,"tasks":4,"files":1}';
  intent := jsonb_build_object('operation','revise','studentId','STU-1','lpItemId',trial_lp_id,'fields','{"documentUrl":"https://docs.qq.com/doc/runtime"}'::jsonb,'revisionNote','Runtime revision','expectedVersions',expected);
  select * into receipt from public.mutate_lp_atomic(
    'lp-atomic-fixture-secret','00000000-0000-4000-8000-000000000005',intent,'revise','STU-1',null,trial_lp_id,null,
    '{"documentUrl":"https://docs.qq.com/doc/runtime"}', 'Runtime revision',
    '{"owner":"Abby","planner":"Tara","mayReassign":false}',expected,'Abby'
  );
  if not receipt.applied or (receipt.students_row).version <> 5 or (receipt.lp_items_row).version <> 5
     or (receipt.tasks_row).version <> 4 or (receipt.files_row).version <> 2
     or not exists (select 1 from jsonb_array_elements((receipt.files_row).payload) x where x ->> 'studentId' = 'STU-1') then
    raise exception 'lp_revision_atomic_projection_failed';
  end if;

  select jsonb_object_agg(entity, version) into versions from public.ops_state;
  if versions is distinct from '{"students":5,"lpItems":5,"tasks":4,"files":2}'::jsonb then
    raise exception 'lp_final_versions_failed: %', versions;
  end if;
  if (select count(*) from internal.lp_atomic_commands) <> 4
     or (select count(*) from internal.operational_contract_audit) <> 4 then
    raise exception 'lp_ledger_audit_count_failed';
  end if;
end;
$lp_atomic_runtime$;

select 'lp_atomic_runtime_ok' as result;
