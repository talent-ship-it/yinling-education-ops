\set ON_ERROR_STOP on

-- These non-login roles are only migration-grant fixtures on a disposable
-- local cluster. The production roles already exist in the target project.
do $roles$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
end;
$roles$;

-- Disposable PG runtime contract for 20260821191021/22. Run against a fresh
-- local database (the entire fixture is rollback-safe); never run in prod.
drop schema if exists internal cascade;
drop schema if exists extensions cascade;
drop table if exists public.ops_mutation_log cascade;
drop table if exists public.ops_state cascade;
create schema internal;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
create table public.ops_state(entity text primary key, payload jsonb not null, version bigint not null, updated_at timestamptz not null default now(), updated_by text not null);
create table public.ops_mutation_log(entity text not null, version bigint not null, actor text not null);
create table internal.operational_contract_audit(id uuid primary key default extensions.gen_random_uuid(), action text not null, actor text not null, target_type text not null, target_id text not null, metadata jsonb not null, created_at timestamptz not null default now());
create function internal.verify_ops_secret(p_secret text) returns boolean language sql immutable set search_path = '' as $$ select p_secret = 'student-operation-fixture-secret' $$;
create function internal.append_operational_contract_audit(p_action text,p_actor text,p_target_type text,p_target_id text,p_metadata jsonb default '{}'::jsonb) returns uuid language plpgsql set search_path = '' as $$ declare saved uuid; begin insert into internal.operational_contract_audit(action,actor,target_type,target_id,metadata) values(p_action,p_actor,p_target_type,p_target_id,p_metadata) returning id into saved; return saved; end $$;

\ir ../../supabase/migrations/20260819101200_teacher_absence_creation_atomic.sql
\ir ../../supabase/migrations/20260821191021_student_creation_students_tasks_atomic.sql
\ir ../../supabase/migrations/20260821191022_legacy_operation_task_atomic.sql

insert into public.ops_state(entity,payload,version,updated_by) values
 ('bookings','[{"id":"B-LEGACY","studentId":"S-LEGACY","teacherId":"T-1","date":"2026-08-21","start":"17:00","duration":60,"timezone":"Australia/Melbourne","kind":"常规课","teacherSubjectId":"Maths"}]',1,'fixture'),
 ('students','[{"id":"S-LEGACY","name":"Legacy Student","owner":"Abby","planner":"Tara","status":"在读"}]',1,'fixture'),
 ('tasks','[]',1,'fixture'),('operations','[]',1,'fixture'),('teachers','[]',1,'fixture');

do $runtime$
declare r record; replay record; caught text; before_students bigint; before_tasks bigint;
  fields jsonb := '{"name":"Runtime Student","course":"Year 8 English","segment":"试听","guardianWechat":"","lpNeed":"试听LP","owner":"Abby","planner":"Tara","grade":"待确认","location":"VIC","timezone":"Australia/Melbourne","notes":"无特殊备注"}'::jsonb;
  intent jsonb := jsonb_build_object('studentFields', fields, 'expectedVersions', jsonb_build_object('students',1,'tasks',1));
  stale_intent jsonb := jsonb_build_object('studentFields', fields, 'expectedVersions', jsonb_build_object('students',99,'tasks',99));
  op_intent jsonb := '{"type":"学生请假","detail":"fixture","studentId":"S-LEGACY","eventStart":"2026-08-21","eventEnd":"2026-08-21"}';
  legacy_versions jsonb := '{"bookings":1,"operations":1,"students":2,"tasks":2,"teachers":1}';
begin
  -- Half-write rollback: the second projection raises after the first update;
  -- both versions and payloads must remain unchanged.
  create function pg_temp.fail_task_projection() returns trigger language plpgsql as $$ begin if new.entity = 'tasks' then raise exception 'fixture_half_write'; end if; return new; end $$;
  create trigger fail_task_projection after update on public.ops_state for each row execute function pg_temp.fail_task_projection();
  begin select * into r from public.create_student_with_tasks_atomic('student-operation-fixture-secret','student-create:123e4567-e89b-42d3-a456-426614174000',intent,fields,'{"students":1,"tasks":1}','Nixon'); exception when others then if sqlerrm <> 'fixture_half_write' then raise; end if; end;
  drop trigger fail_task_projection on public.ops_state;
  select version into before_students from public.ops_state where entity='students'; select version into before_tasks from public.ops_state where entity='tasks';
  if before_students <> 1 or before_tasks <> 1 then raise exception 'half_write_rollback_failed'; end if;

  -- Stale OCC is fail-closed and also leaves both rows untouched.
  begin select * into r from public.create_student_with_tasks_atomic('student-operation-fixture-secret','student-create:123e4567-e89b-42d3-a456-426614174001',stale_intent,fields,'{"students":99,"tasks":99}','Nixon'); exception when serialization_failure then null; end;
  if (select version from public.ops_state where entity='students') <> 1 then raise exception 'stale_occ_mutated_state'; end if;
  begin select * into r from public.create_student_with_tasks_atomic('student-operation-fixture-secret','student-create:123e4567-e89b-42d3-a456-426614174002',jsonb_build_object('studentFields',jsonb_set(fields,'{owner}','"Tiffany"'),'expectedVersions','{"students":1,"tasks":1}'::jsonb),jsonb_set(fields,'{owner}','"Tiffany"'),'{"students":1,"tasks":1}','Abby'); exception when insufficient_privilege then null; end;
  if (select version from public.ops_state where entity='students') <> 1 then raise exception 'student_actor_scope_spoof_mutated_state'; end if;

  select * into r from public.create_student_with_tasks_atomic('student-operation-fixture-secret','student-create:123e4567-e89b-42d3-a456-426614174000',intent,fields,'{"students":1,"tasks":1}','Nixon');
  if not r.applied then raise exception 'student_apply_failed'; end if;
  if (select count(*) from jsonb_array_elements((select payload from public.ops_state where entity = 'tasks')) item
      where item.value ->> 'studentId' = r.student_id
        and item.value -> 'assignees' = '["Abby","Tara"]'::jsonb
        and item.value -> 'watchers' = '["Ops Admin"]'::jsonb) <> 2 then
    raise exception 'student_planner_task_projection_failed';
  end if;
  select * into replay from public.get_student_creation_command_result('student-operation-fixture-secret','student-create:123e4567-e89b-42d3-a456-426614174000',intent,'Nixon');
  if replay.command_key is null or (replay.students_row).version <> 2 then raise exception 'unknown_result_replay_failed'; end if;
  begin select * into replay from public.get_student_creation_command_result('student-operation-fixture-secret','student-create:123e4567-e89b-42d3-a456-426614174000',intent,'Forged Actor'); exception when unique_violation then null; end;

  -- Legacy operations/tasks has the same rollback/OCC/replay/actor guarantees.
  create trigger fail_task_projection after update on public.ops_state for each row execute function pg_temp.fail_task_projection();
  begin select * into r from public.mutate_legacy_operation_task_atomic('student-operation-fixture-secret','operation-task-create:123e4567-e89b-42d3-a456-426614174000',op_intent,'学生请假','fixture','S-LEGACY',null,'2026-08-21','2026-08-21',null,legacy_versions,'Nixon'); exception when others then if sqlerrm <> 'fixture_half_write' then raise; end if; end;
  drop trigger fail_task_projection on public.ops_state;
  begin select * into r from public.mutate_legacy_operation_task_atomic('student-operation-fixture-secret','operation-task-create:123e4567-e89b-42d3-a456-426614174001',op_intent,'学生请假','fixture','S-LEGACY',null,'2026-08-21','2026-08-21',null,'{"bookings":1,"operations":99,"students":2,"tasks":99,"teachers":1}','Nixon'); exception when serialization_failure then null; end;
  if (select version from public.ops_state where entity='operations') <> 1 or (select version from public.ops_state where entity='tasks') <> 2 then raise exception 'legacy_stale_occ_mutated_state'; end if;
  begin select * into r from public.mutate_legacy_operation_task_atomic('student-operation-fixture-secret','operation-task-create:123e4567-e89b-42d3-a456-426614174002',op_intent,'学生请假','fixture','S-LEGACY',null,'2026-08-21','2026-08-21',null,legacy_versions,'Tiffany'); exception when insufficient_privilege then null; end;
  if (select version from public.ops_state where entity='operations') <> 1 or (select version from public.ops_state where entity='tasks') <> 2 then raise exception 'legacy_actor_scope_spoof_mutated_state'; end if;
  select * into r from public.mutate_legacy_operation_task_atomic('student-operation-fixture-secret','operation-task-create:123e4567-e89b-42d3-a456-426614174000',op_intent,'学生请假','fixture','S-LEGACY',null,'2026-08-21','2026-08-21',null,legacy_versions,'Nixon');
  if not r.applied then raise exception 'legacy_apply_failed'; end if;
  if (select count(*) from jsonb_array_elements((select payload from public.ops_state where entity = 'tasks')) item
      where item.value ->> 'studentId' = 'S-LEGACY'
        and item.value ->> 'ruleKey' = 'operation.学生请假.legacy'
        and item.value -> 'assignees' = '["Abby","Tara"]'::jsonb
        and item.value -> 'watchers' = '["Ops Admin"]'::jsonb) <> 1 then
    raise exception 'legacy_planner_task_projection_failed';
  end if;
  select * into replay from public.get_legacy_operation_task_command_result('student-operation-fixture-secret','operation-task-create:123e4567-e89b-42d3-a456-426614174000',op_intent,'Nixon');
  if replay.command_key is null or (replay.operations_row).version <> 2 then raise exception 'legacy_unknown_result_replay_failed'; end if;
  begin select * into replay from public.get_legacy_operation_task_command_result('student-operation-fixture-secret','operation-task-create:123e4567-e89b-42d3-a456-426614174000',op_intent,'Forged Actor'); exception when unique_violation then null; end;
end;
$runtime$;
rollback;
