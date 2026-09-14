\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
-- Run on a disposable pre-migration schema containing ops_state, app_accounts,
-- teacher absence, and the recurrence-aware departure projector.
begin;
insert into internal.app_accounts(account_id,identity_key,account_name,account_role,status,created_by,updated_by) values
 ('00000000-0000-4000-8000-000000000701',repeat('a',64),'思佳','staff','disabled','fixture','fixture'),
 ('00000000-0000-4000-8000-000000000702',repeat('b',64),'Ops Admin','limited-admin','active','fixture','fixture'),
 ('00000000-0000-4000-8000-000000000703',repeat('c',64),'Erin','staff','disabled','fixture','fixture')
on conflict (identity_key) do update set status=excluded.status;
insert into public.ops_state(entity,payload,version,updated_by) values
 ('students','[{"id":"S-ACTIVE","owner":"思佳","status":"在读"},{"id":"S-HISTORY","owner":"思佳","importArchived":true}]',1,'fixture'),
 ('tasks','[{"id":"T-ACTIVE","owner":"思佳","assignees":["思佳"],"watchers":["Ops Admin","思佳"],"status":"today"},{"id":"T-HISTORY","owner":"思佳","status":"done"}]',1,'fixture'),
 ('teachers','[{"id":"TEACHER-1","name":"Fixture Teacher"}]',1,'fixture')
on conflict(entity) do update set payload=excluded.payload,version=excluded.version;
\ir ../../supabase/migrations/20260914000200_retired_staff_assignment_guard.sql

do $assertions$
declare tasks jsonb; definition text; caught boolean := false;
begin
 definition := pg_get_functiondef('public.create_teacher_absence_atomic(text,text,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,text)'::regprocedure);
 if position('when rule = ''candidate-confirm'' then ''思佳''' in definition) > 0
    or position('when rule = ''candidate-confirm'' then ''Ops Admin''' in definition) = 0 then
   raise exception 'absence_routing_failed'; end if;
 if (select payload -> 0 ->> 'owner' from public.ops_state where entity='students') <> 'Ops Admin'
    or (select payload -> 1 ->> 'owner' from public.ops_state where entity='students') <> '思佳' then
   raise exception 'student_handover_or_history_failed'; end if;
 if (select payload -> 0 from public.ops_state where entity='tasks') <> '{"id":"T-ACTIVE","owner":"Ops Admin","assignees":["Ops Admin"],"watchers":["Ops Admin"],"status":"today"}'::jsonb
    or (select payload -> 1 ->> 'owner' from public.ops_state where entity='tasks') <> '思佳' then
   raise exception 'task_handover_or_history_failed'; end if;
 if (select count(*) from internal.operational_contract_audit where action='accounts.outstanding_work_reassigned') <> 2 then
   raise exception 'handover_audit_failed'; end if;
 begin
   update public.ops_state set payload=payload || '[{"id":"S-NEW","owner":"Erin"}]'::jsonb where entity='students';
 exception when insufficient_privilege then caught := sqlerrm='inactive_staff_assignment'; end;
 if not caught then raise exception 'disabled_new_owner_accepted'; end if;
 caught := false;
 begin
   update public.ops_state set payload=payload || '[{"id":"T-NEW","owner":"Ops Admin","assignees":["思佳"],"status":"today"}]'::jsonb where entity='tasks';
 exception when insufficient_privilege then caught := sqlerrm='inactive_staff_assignment'; end;
 if not caught then raise exception 'disabled_new_assignee_accepted'; end if;
 caught := false;
 begin
   update public.ops_state set payload=jsonb_set(payload,'{1,status}','"today"') where entity='tasks';
 exception when insufficient_privilege then caught := sqlerrm='inactive_staff_assignment'; end;
 if not caught then raise exception 'reopened_disabled_assignment_accepted'; end if;
 -- Historical attribution survives an unrelated note correction.
 update public.ops_state set payload=jsonb_set(payload,'{1,notes}','"history preserved"') where entity='tasks';
 tasks := internal.teacher_departure_creation_tasks_v2('teacher-departure-create:fixture','OP-1','S-ACTIVE','Ops Admin','TEACHER-1','[]','2099-01-01',now());
 if not exists(select 1 from jsonb_array_elements(tasks) task where task ->> 'ruleKey' like '%management-watcher' and task ->> 'owner'='Ops Admin')
    or exists(select 1 from jsonb_array_elements(tasks) task where task ->> 'owner'='思佳') then
   raise exception 'departure_routing_failed'; end if;
end;
$assertions$;
\ir ../../supabase/migrations/20260914000200_retired_staff_assignment_guard.sql
do $idempotence$
begin
 if (select version from public.ops_state where entity='students') <> 2
    or (select version from public.ops_state where entity='tasks') <> 2
    or (select count(*) from internal.operational_contract_audit where action='accounts.outstanding_work_reassigned') <> 2 then
   raise exception 'handover_not_idempotent'; end if;
end;
$idempotence$;
rollback;
