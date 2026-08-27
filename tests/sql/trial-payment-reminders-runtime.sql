\set ON_ERROR_STOP on

-- Compile 191020 against the real 191019 migration seam, then exercise all
-- payment reminder writes in a disposable PostgreSQL transaction fixture.
\ir booking-projection-atomic-runtime.sql
\ir ../../supabase/migrations/20260819102000_trial_payment_reminders_authoritative.sql

do $acl_contract$
begin
  if not has_function_privilege(
    'anon',
    'public.reconcile_trial_payment_tasks_authoritative(text,text,jsonb,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.reconcile_trial_payment_tasks_authoritative(text,text,jsonb,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'anon',
    'public.complete_trial_payment_task_atomic(text,text,jsonb,text,jsonb,text,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'authenticated',
    'public.complete_trial_payment_task_atomic(text,text,jsonb,text,jsonb,text,text)',
    'EXECUTE'
  ) then
    raise exception 'trial_payment_postgrest_roles_missing_execute';
  end if;
  if has_function_privilege(
    'service_role',
    'public.reconcile_trial_payment_tasks_authoritative(text,text,jsonb,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'service_role',
    'public.complete_trial_payment_task_atomic(text,text,jsonb,text,jsonb,text,text)',
    'EXECUTE'
  ) then
    raise exception 'trial_payment_service_role_execute_not_revoked';
  end if;
end;
$acl_contract$;

set role anon;
do $anon_reaches_secret_gate$
declare caught_message text;
begin
  begin
    perform * from public.reconcile_trial_payment_tasks_authoritative(
      'wrong-secret',
      'trial-payment-reconcile:11111111-1111-4111-8111-111111111111',
      '{}'::jsonb,
      'Trial Payment Scheduler'
    );
    raise exception 'anon_reconcile_secret_gate_missing';
  exception when sqlstate '42501' then
    get stacked diagnostics caught_message = message_text;
    if caught_message <> 'invalid_ops_secret' then raise; end if;
  end;
  begin
    perform * from public.complete_trial_payment_task_atomic(
      'wrong-secret',
      'trial-payment-complete:11111111-1111-4111-8111-111111111111',
      '{"action":"complete","taskId":"TASK-X"}'::jsonb,
      'TASK-X',
      '{}'::jsonb,
      'Tara',
      'staff'
    );
    raise exception 'anon_completion_secret_gate_missing';
  exception when sqlstate '42501' then
    get stacked diagnostics caught_message = message_text;
    if caught_message <> 'invalid_ops_secret' then raise; end if;
  end;
end;
$anon_reaches_secret_gate$;
reset role;

truncate table internal.trial_payment_reconcile_runs,
  internal.trial_payment_completion_commands,
  public.ops_mutation_log,
  public.ops_state;

insert into public.ops_state(entity, payload, version, updated_by) values
  ('bookings', '[]', 100, 'fixture'),
  ('students', '[]', 100, 'fixture'),
  ('lpItems', '[]', 100, 'fixture'),
  ('tasks', '[]', 100, 'fixture'),
  ('teachers', '[]', 100, 'fixture');

do $runtime$
declare
  now_value timestamptz := date_trunc('second', clock_timestamp());
  urgent_start timestamptz := date_trunc('second', clock_timestamp() + interval '12 hours');
  paid_start timestamptz := date_trunc('second', clock_timestamp() + interval '36 hours');
  bookings jsonb;
  expected jsonb := '{"bookings":100,"students":100,"lpItems":100,"tasks":100,"teachers":100}';
  first_receipt record;
  replay_receipt record;
  stable_receipt record;
  completion_receipt record;
  completion_replay record;
  completion_audit_id uuid;
  urgent_task_id text;
  tasks_after_first jsonb;
  task_version_after_first bigint;
  caught_state text;
  caught_message text;
  expected_n2 timestamptz;
begin
  bookings := jsonb_build_array(
    jsonb_build_object(
      'id','BOOK-U1','studentId','STU-U','kind','试听',
      'date',to_char(urgent_start at time zone 'Australia/Melbourne','YYYY-MM-DD'),
      'start',to_char(urgent_start at time zone 'Australia/Melbourne','HH24:MI:SS'),
      'timezone','Australia/Melbourne'
    ),
    jsonb_build_object(
      'id','BOOK-U2','studentId','STU-U','kind','试听',
      'date',to_char(urgent_start at time zone 'Australia/Melbourne','YYYY-MM-DD'),
      'start',to_char(urgent_start at time zone 'Australia/Melbourne','HH24:MI:SS'),
      'timezone','Australia/Melbourne'
    ),
    jsonb_build_object(
      'id','BOOK-MISSING','studentId','STU-MISSING','kind','试听',
      'date',to_char(urgent_start at time zone 'Australia/Melbourne','YYYY-MM-DD'),
      'start',to_char(urgent_start at time zone 'Australia/Melbourne','HH24:MI:SS'),
      'timezone','Australia/Melbourne'
    ),
    jsonb_build_object(
      'id','BOOK-NULL','studentId','STU-NULL','kind','试听',
      'date',to_char(urgent_start at time zone 'Australia/Melbourne','YYYY-MM-DD'),
      'start',to_char(urgent_start at time zone 'Australia/Melbourne','HH24:MI:SS'),
      'timezone','Australia/Melbourne'
    ),
    jsonb_build_object(
      'id','BOOK-PAID','studentId','STU-PAID','kind','试听',
      'date',to_char(paid_start at time zone 'Australia/Melbourne','YYYY-MM-DD'),
      'start',to_char(paid_start at time zone 'Australia/Melbourne','HH24:MI:SS'),
      'timezone','Australia/Melbourne'
    )
  );
  update public.ops_state set payload = bookings where entity = 'bookings';
  update public.ops_state set payload = '[
    {"id":"STU-U","name":"Unpaid","owner":"Abby","planner":"Tara"},
    {"id":"STU-MISSING","name":"Missing","owner":"Abby","planner":"Tara"},
    {"id":"STU-NULL","name":"Null","owner":"Abby","planner":"Tara"},
    {"id":"STU-PAID","name":"Paid","owner":"Abby","planner":"Tara"}
  ]'::jsonb where entity = 'students';
  update public.ops_state set payload = '[
    {"id":"LP-U1","studentId":"STU-U","workflowType":"试听 LP","requestedAt":"2026-01-01T00:00:00.000Z","fields":{"trialPaymentMethod":"付费试听（未付费）"}},
    {"id":"LP-U2","studentId":"STU-U","workflowType":"试听 LP","requestedAt":"2026-12-01T00:00:00.000Z","fields":{"trialPaymentMethod":"免费试听"}},
    {"id":"LP-MISSING","studentId":"STU-MISSING","workflowType":"试听 LP","fields":{}},
    {"id":"LP-NULL","studentId":"STU-NULL","workflowType":"试听 LP","fields":{"trialPaymentMethod":null}},
    {"id":"LP-PAID","studentId":"STU-PAID","workflowType":"试听 LP","fields":{"trialPaymentMethod":"付费试听（已付费）"}}
  ]'::jsonb where entity = 'lpItems';
  update public.ops_state set payload = '[
    {"id":"LINK-U1","studentId":"STU-U","ruleKey":"trial.scheduling","anchorBookingId":"BOOK-U1","requestAnchorBookingId":"LP-U1"},
    {"id":"LINK-U2","studentId":"STU-U","ruleKey":"trial.scheduling","anchorBookingId":"BOOK-U2","requestAnchorBookingId":"LP-U2"},
    {"id":"LINK-MISSING","studentId":"STU-MISSING","ruleKey":"trial.scheduling","anchorBookingId":"BOOK-MISSING","requestAnchorBookingId":"LP-MISSING"},
    {"id":"LINK-NULL","studentId":"STU-NULL","ruleKey":"trial.scheduling","anchorBookingId":"BOOK-NULL","requestAnchorBookingId":"LP-NULL"},
    {"id":"LINK-PAID","studentId":"STU-PAID","ruleKey":"trial.scheduling","anchorBookingId":"BOOK-PAID","requestAnchorBookingId":"LP-PAID"}
  ]'::jsonb where entity = 'tasks';

  select * into first_receipt from public.reconcile_trial_payment_tasks_authoritative(
    'booking-projection-fixture-secret',
    'trial-payment-reconcile:11111111-1111-4111-8111-111111111111',
    expected,
    'Trial Payment Scheduler'
  );
  tasks_after_first := (first_receipt.tasks_row).payload;
  task_version_after_first := (first_receipt.tasks_row).version;
  if not first_receipt.applied or first_receipt.changed_count <> 3
     or task_version_after_first <> 101 then
    raise exception 'trial_payment_first_reconcile_receipt_failed';
  end if;

  -- Two LPs for the same student deliberately have opposite payment methods;
  -- the newer LP-U2 must not be guessed for BOOK-U1.
  if (select count(*) from jsonb_array_elements(tasks_after_first) item(value)
      where item.value ->> 'anchorBookingId' = 'BOOK-U1'
        and item.value ->> 'ruleKey' in ('trial.payment-n2','trial.payment-urgent')) <> 2
     or exists (
       select 1 from jsonb_array_elements(tasks_after_first) item(value)
       where item.value ->> 'anchorBookingId' = 'BOOK-U2'
         and item.value ->> 'ruleKey' in ('trial.payment-n2','trial.payment-urgent')
     ) then
    raise exception 'trial_payment_booking_specific_lp_binding_failed';
  end if;
  if exists (
       select 1 from jsonb_array_elements(tasks_after_first) item(value)
       where item.value ->> 'studentId' in ('STU-MISSING','STU-NULL')
         and item.value ->> 'ruleKey' in ('trial.payment-n2','trial.payment-urgent')
     ) then
    raise exception 'trial_payment_missing_or_null_materialised';
  end if;
  if not exists (
       select 1 from jsonb_array_elements(tasks_after_first) item(value)
       where item.value ->> 'anchorBookingId' = 'BOOK-PAID'
         and item.value ->> 'ruleKey' = 'trial.payment-n2'
         and item.value ->> 'status' = 'done'
         and item.value ->> 'result' = '试听已付费，收费提醒自动关闭'
     ) or exists (
       select 1 from jsonb_array_elements(tasks_after_first) item(value)
       where item.value ->> 'anchorBookingId' = 'BOOK-PAID'
         and item.value ->> 'ruleKey' = 'trial.payment-urgent'
     ) then
    raise exception 'trial_payment_paid_projection_failed';
  end if;
  if exists (
       select 1 from jsonb_array_elements(tasks_after_first) item(value)
       where item.value ->> 'anchorBookingId' = 'BOOK-U1'
         and item.value ->> 'ruleKey' in ('trial.payment-n2','trial.payment-urgent')
         and (
           item.value ->> 'owner' <> 'Tara'
           or item.value -> 'assignees' <> '["Tara"]'::jsonb
           or item.value -> 'watchers' <> '["Ops Admin"]'::jsonb
           or item.value ->> 'requestAnchorBookingId' <> 'LP-U1'
         )
     ) then
    raise exception 'trial_payment_recipient_or_source_binding_failed';
  end if;
  if not exists (
       select 1 from jsonb_array_elements(tasks_after_first) item(value)
       where item.value ->> 'anchorBookingId' = 'BOOK-U1'
         and item.value ->> 'ruleKey' = 'trial.payment-urgent'
         and item.value ->> 'tone' = 'red'
         and (item.value ->> 'dueAt')::timestamptz = urgent_start - interval '24 hours'
     ) then
    raise exception 'trial_payment_urgent_deadline_failed';
  end if;
  expected_n2 := (
    ((urgent_start at time zone 'Australia/Melbourne')::date - 2 + time '18:00')
    at time zone 'Australia/Melbourne'
  );
  if not exists (
       select 1 from jsonb_array_elements(tasks_after_first) item(value)
       where item.value ->> 'anchorBookingId' = 'BOOK-U1'
         and item.value ->> 'ruleKey' = 'trial.payment-n2'
         and (item.value ->> 'dueAt')::timestamptz = expected_n2
     ) then
    raise exception 'trial_payment_melbourne_n2_deadline_failed';
  end if;

  -- Same command replays before OCC and never duplicates or increments.
  select * into replay_receipt from public.reconcile_trial_payment_tasks_authoritative(
    'booking-projection-fixture-secret',
    'trial-payment-reconcile:11111111-1111-4111-8111-111111111111',
    expected,
    'Trial Payment Scheduler'
  );
  if replay_receipt.applied or (replay_receipt.tasks_row).version <> 101
     or (select count(*) from internal.trial_payment_reconcile_runs) <> 1 then
    raise exception 'trial_payment_reconcile_replay_failed';
  end if;

  -- A distinct scheduler tick over unchanged authority is a true no-op. This
  -- catches closedAt clock drift on already-paid task projection.
  select * into stable_receipt from public.reconcile_trial_payment_tasks_authoritative(
    'booking-projection-fixture-secret',
    'trial-payment-reconcile:22222222-2222-4222-8222-222222222222',
    '{"bookings":100,"students":100,"lpItems":100,"tasks":101,"teachers":100}',
    'Trial Payment Scheduler'
  );
  if stable_receipt.applied or stable_receipt.changed_count <> 0
     or (stable_receipt.tasks_row).version <> 101 then
    raise exception 'trial_payment_stable_reconcile_not_idempotent';
  end if;

  select item.value ->> 'id' into urgent_task_id
  from jsonb_array_elements((stable_receipt.tasks_row).payload) item(value)
  where item.value ->> 'anchorBookingId' = 'BOOK-U1'
    and item.value ->> 'ruleKey' = 'trial.payment-urgent';

  -- A non-staff signed role cannot make the first write, even when its actor
  -- name matches the current planner. Role drift is permitted only on replay.
  begin
    perform * from public.complete_trial_payment_task_atomic(
      'booking-projection-fixture-secret',
      'trial-payment-complete:77777777-7777-4777-8777-777777777777',
      jsonb_build_object('action','complete','taskId',urgent_task_id),
      urgent_task_id,
      '{"bookings":100,"students":100,"lpItems":100,"tasks":101,"teachers":100}',
      'Tara',
      'teacher'
    );
    raise exception 'trial_payment_nonstaff_first_submit_was_accepted';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'trial_payment_role_forbidden' then raise; end if;
  end;
  if (select version from public.ops_state where entity = 'tasks') <> 101
     or (select count(*) from internal.trial_payment_completion_commands) <> 0 then
    raise exception 'trial_payment_nonstaff_first_submit_changed_state';
  end if;

  -- Student operations ownership and teaching-control observation do not grant
  -- completion authority; only the locked current planner may complete.
  begin
    perform * from public.complete_trial_payment_task_atomic(
      'booking-projection-fixture-secret',
      'trial-payment-complete:33333333-3333-4333-8333-333333333333',
      jsonb_build_object('action','complete','taskId',urgent_task_id),
      urgent_task_id,
      '{"bookings":100,"students":100,"lpItems":100,"tasks":101,"teachers":100}',
      'Abby',
      'staff'
    );
    raise exception 'trial_payment_wrong_actor_was_accepted';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'trial_payment_task_forbidden' then raise; end if;
  end;
  if (select version from public.ops_state where entity = 'tasks') <> 101
     or (select count(*) from internal.trial_payment_completion_commands) <> 0 then
    raise exception 'trial_payment_wrong_actor_changed_state';
  end if;

  select * into completion_receipt from public.complete_trial_payment_task_atomic(
    'booking-projection-fixture-secret',
    'trial-payment-complete:44444444-4444-4444-8444-444444444444',
    jsonb_build_object('action','complete','taskId',urgent_task_id),
    urgent_task_id,
    '{"bookings":100,"students":100,"lpItems":100,"tasks":101,"teachers":100}',
    'Tara',
    'staff'
  );
  if not completion_receipt.applied or (completion_receipt.tasks_row).version <> 102
     or (select count(*) from jsonb_array_elements((completion_receipt.tasks_row).payload) item(value)
         where item.value ->> 'anchorBookingId' = 'BOOK-U1'
           and item.value ->> 'ruleKey' in ('trial.payment-n2','trial.payment-urgent')
           and item.value ->> 'status' = 'done'
           and item.value ->> 'result' = '已由规划老师确认试听付款') <> 2 then
    raise exception 'trial_payment_planner_completion_failed';
  end if;
  completion_audit_id := completion_receipt.audit_entry_id;
  select * into completion_replay from public.complete_trial_payment_task_atomic(
    'booking-projection-fixture-secret',
    'trial-payment-complete:44444444-4444-4444-8444-444444444444',
    jsonb_build_object('action','complete','taskId',urgent_task_id),
    urgent_task_id,
    '{"bookings":100,"students":100,"lpItems":100,"tasks":101,"teachers":100}',
    'Tara',
    'staff'
  );
  if completion_replay.applied or (completion_replay.tasks_row).version <> 102
     or (select count(*) from internal.trial_payment_completion_commands) <> 1 then
    raise exception 'trial_payment_completion_replay_failed';
  end if;

  -- A lost response can be retried after all current authority has drifted.
  -- The exact actor+intent ledger receipt must win before task/planner/LP/OCC
  -- validation; returned state is current and lets the route fail closed on PII.
  update public.ops_state set
    payload = (select jsonb_agg(
      case when item.value ->> 'id' = 'STU-U'
        then item.value || '{"planner":"Molly"}'::jsonb
        else item.value end order by item.ordinality
    ) from jsonb_array_elements(payload) with ordinality item(value, ordinality)),
    version = version + 1
  where entity = 'students';
  update public.ops_state set
    payload = (select jsonb_agg(
      case when item.value ->> 'id' = 'LP-U1'
        then jsonb_set(item.value, '{fields,trialPaymentMethod}', '"免费试听"'::jsonb, true)
        else item.value end order by item.ordinality
    ) from jsonb_array_elements(payload) with ordinality item(value, ordinality)),
    version = version + 1
  where entity = 'lpItems';
  update public.ops_state set
    payload = (select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
      from jsonb_array_elements(payload) with ordinality item(value, ordinality)
      where item.value ->> 'id' <> urgent_task_id),
    version = version + 1
  where entity = 'tasks';
  select * into completion_replay from public.complete_trial_payment_task_atomic(
    'booking-projection-fixture-secret',
    'trial-payment-complete:44444444-4444-4444-8444-444444444444',
    jsonb_build_object('action','complete','taskId',urgent_task_id),
    urgent_task_id,
    '{"bookings":100,"students":100,"lpItems":100,"tasks":101,"teachers":100}',
    'Tara',
    'teacher'
  );
  if completion_replay.applied
     or completion_replay.audit_entry_id is distinct from completion_audit_id
     or completion_replay.student_id <> 'STU-U'
     or (completion_replay.students_row).version <> 101
     or (completion_replay.lp_items_row).version <> 101
     or (completion_replay.tasks_row).version <> 103
     or exists (
       select 1 from jsonb_array_elements((completion_replay.tasks_row).payload) item(value)
       where item.value ->> 'id' = urgent_task_id
     )
     or (select count(*) from internal.trial_payment_completion_commands) <> 1 then
    raise exception 'trial_payment_completion_drift_replay_failed';
  end if;
end;
$runtime$;

-- Force two first submissions to pass the pre-lock ledger lookup before either
-- can acquire bookings. After releasing the holder, exactly one applies and
-- the waiter must observe the ledger in the post-lock recheck.
truncate table internal.trial_payment_completion_commands, public.ops_mutation_log;
update public.ops_state set payload = '[{
  "id":"BOOK-RACE","studentId":"STU-RACE","kind":"试听",
  "date":"2026-08-23","start":"10:00:00","timezone":"Australia/Melbourne"
}]'::jsonb, version = 200 where entity = 'bookings';
update public.ops_state set payload = '[{
  "id":"STU-RACE","name":"Race","owner":"Abby","planner":"Tara"
}]'::jsonb, version = 200 where entity = 'students';
update public.ops_state set payload = '[{
  "id":"LP-RACE","studentId":"STU-RACE","workflowType":"试听 LP",
  "fields":{"trialPaymentMethod":"付费试听（未付费）"}
}]'::jsonb, version = 200 where entity = 'lpItems';
update public.ops_state set payload = '[
  {
    "id":"LINK-RACE","studentId":"STU-RACE","ruleKey":"trial.scheduling",
    "anchorBookingId":"BOOK-RACE","requestAnchorBookingId":"LP-RACE"
  },
  {
    "id":"TASK-RACE","studentId":"STU-RACE","category":"试听",
    "ruleKey":"trial.payment-urgent","anchorBookingId":"BOOK-RACE",
    "requestAnchorBookingId":"LP-RACE","owner":"Tara",
    "assignees":["Tara"],"watchers":["Ops Admin"],
    "status":"upcoming","tone":"red"
  }
]'::jsonb, version = 200 where entity = 'tasks';
update public.ops_state set payload = '[]'::jsonb, version = 200 where entity = 'teachers';

do $completion_concurrency$
declare
  connection_string text := format(
    'dbname=%L host=%L port=%s',
    current_database(), current_setting('unix_socket_directories'), current_setting('port')
  );
  completion_sql text := format(
    'select applied, (tasks_row).version, audit_entry_id '
      || 'from public.complete_trial_payment_task_atomic(%L,%L,%L::jsonb,%L,%L::jsonb,%L,%L)',
    'booking-projection-fixture-secret',
    'trial-payment-complete:55555555-5555-4555-8555-555555555555',
    '{"action":"complete","taskId":"TASK-RACE"}',
    'TASK-RACE',
    '{"bookings":200,"students":200,"lpItems":200,"tasks":200,"teachers":200}',
    'Tara',
    'staff'
  );
  first_pid integer;
  second_pid integer;
  first_waiting boolean := false;
  second_waiting boolean := false;
  attempt integer;
  send_status integer;
  first_applied boolean;
  second_applied boolean;
  first_version bigint;
  second_version bigint;
  first_audit uuid;
  second_audit uuid;
begin
  perform extensions.dblink_connect('trial_payment_holder', connection_string);
  perform extensions.dblink_connect('trial_payment_first', connection_string);
  perform extensions.dblink_connect('trial_payment_second', connection_string);
  perform extensions.dblink_exec('trial_payment_holder', 'begin');
  perform held.entity from extensions.dblink(
    'trial_payment_holder',
    'select entity from public.ops_state where entity = ''bookings'' for update'
  ) held(entity text);
  select pid into first_pid from extensions.dblink(
    'trial_payment_first', 'select pg_backend_pid()'
  ) result(pid integer);
  select pid into second_pid from extensions.dblink(
    'trial_payment_second', 'select pg_backend_pid()'
  ) result(pid integer);
  select extensions.dblink_send_query('trial_payment_first', completion_sql) into send_status;
  if send_status <> 1 then raise exception 'trial_payment_first_async_start_failed'; end if;
  select extensions.dblink_send_query('trial_payment_second', completion_sql) into send_status;
  if send_status <> 1 then raise exception 'trial_payment_second_async_start_failed'; end if;

  for attempt in 1..500 loop
    select coalesce(wait_event_type = 'Lock', false) into first_waiting
      from pg_catalog.pg_stat_activity where pid = first_pid;
    select coalesce(wait_event_type = 'Lock', false) into second_waiting
      from pg_catalog.pg_stat_activity where pid = second_pid;
    exit when first_waiting and second_waiting;
    perform pg_sleep(0.01);
  end loop;
  if not first_waiting or not second_waiting then
    raise exception 'trial_payment_concurrent_calls_did_not_reach_locked_seam';
  end if;
  perform extensions.dblink_exec('trial_payment_holder', 'commit');

  for attempt in 1..500 loop
    exit when extensions.dblink_is_busy('trial_payment_first') = 0
      and extensions.dblink_is_busy('trial_payment_second') = 0;
    perform pg_sleep(0.01);
  end loop;
  if extensions.dblink_is_busy('trial_payment_first') <> 0
     or extensions.dblink_is_busy('trial_payment_second') <> 0 then
    raise exception 'trial_payment_concurrent_calls_did_not_finish';
  end if;
  select result.applied, result.tasks_version, result.audit_id
    into first_applied, first_version, first_audit
  from extensions.dblink_get_result('trial_payment_first') result(
    applied boolean, tasks_version bigint, audit_id uuid
  );
  select result.applied, result.tasks_version, result.audit_id
    into second_applied, second_version, second_audit
  from extensions.dblink_get_result('trial_payment_second') result(
    applied boolean, tasks_version bigint, audit_id uuid
  );
  if first_applied = second_applied
     or array[first_version, second_version] is distinct from array[201::bigint, 201::bigint]
     or first_audit is distinct from second_audit
     or (select count(*) from internal.trial_payment_completion_commands) <> 1
     or (select count(*) from public.ops_mutation_log where entity = 'tasks') <> 1 then
    raise exception 'trial_payment_concurrent_double_submit_not_idempotent';
  end if;
  perform extensions.dblink_disconnect('trial_payment_holder');
  perform extensions.dblink_disconnect('trial_payment_first');
  perform extensions.dblink_disconnect('trial_payment_second');
exception when others then
  begin perform extensions.dblink_exec('trial_payment_holder', 'rollback'); exception when others then null; end;
  begin perform extensions.dblink_disconnect('trial_payment_holder'); exception when others then null; end;
  begin perform extensions.dblink_disconnect('trial_payment_first'); exception when others then null; end;
  begin perform extensions.dblink_disconnect('trial_payment_second'); exception when others then null; end;
  raise;
end;
$completion_concurrency$;

do $window_contract$
declare
  booking jsonb := '{
    "id":"BOOK-WINDOW","studentId":"STU-WINDOW","kind":"试听",
    "date":"2026-08-23","start":"10:00:00","timezone":"Australia/Melbourne"
  }';
  students jsonb := '[{"id":"STU-WINDOW","owner":"Abby","planner":"Tara"}]';
  lp_items jsonb := '[{
    "id":"LP-WINDOW","studentId":"STU-WINDOW","workflowType":"试听 LP",
    "fields":{"trialPaymentMethod":"付费试听（未付费）"}
  }]';
  links jsonb := '[{
    "id":"LINK-WINDOW","studentId":"STU-WINDOW","ruleKey":"trial.scheduling",
    "anchorBookingId":"BOOK-WINDOW","requestAnchorBookingId":"LP-WINDOW"
  }]';
  trial_start timestamptz := '2026-08-23 10:00:00 Australia/Melbourne'::timestamptz;
  projected jsonb;
begin
  projected := internal.reconcile_trial_payment_tasks_for_booking(
    links, lp_items, booking, null, 'update', students,
    trial_start - interval '72 hours'
  );
  if exists (
    select 1 from jsonb_array_elements(projected) item(value)
    where item.value ->> 'ruleKey' = 'trial.payment-n2'
  ) then raise exception 'trial_payment_exact_72h_boundary_failed'; end if;

  projected := internal.reconcile_trial_payment_tasks_for_booking(
    links, lp_items, booking, null, 'update', students,
    trial_start - interval '72 hours' + interval '1 millisecond'
  );
  if (select count(*) from jsonb_array_elements(projected) item(value)
      where item.value ->> 'ruleKey' = 'trial.payment-n2') <> 1 then
    raise exception 'trial_payment_72h_minus_1ms_entry_failed';
  end if;

  projected := internal.reconcile_trial_payment_tasks_for_booking(
    links, lp_items, booking, null, 'update', students,
    trial_start - interval '10 days'
  );
  if exists (
    select 1 from jsonb_array_elements(projected) item(value)
    where item.value ->> 'ruleKey' = 'trial.payment-n2'
  ) then raise exception 'trial_payment_far_future_materialised'; end if;

  -- An unavailable planner pauses open reminders; a later authoritative
  -- reassignment rebuilds the same deterministic rules for only the new planner.
  projected := internal.reconcile_trial_payment_tasks_for_booking(
    links, lp_items, booking, null, 'update', students,
    trial_start - interval '48 hours'
  );
  projected := internal.reconcile_trial_payment_tasks_for_booking(
    projected, lp_items, booking, null, 'update',
    '[{"id":"STU-WINDOW","owner":"Abby","planner":"待分配"}]'::jsonb,
    trial_start - interval '47 hours'
  );
  if not exists (
    select 1 from jsonb_array_elements(projected) item(value)
    where item.value ->> 'ruleKey' = 'trial.payment-n2'
      and item.value ->> 'status' = 'done'
      and item.value ->> 'result' = '规划账号未配置，收费提醒暂停'
  ) then raise exception 'trial_payment_invalid_planner_not_paused'; end if;
  projected := internal.reconcile_trial_payment_tasks_for_booking(
    projected, lp_items, booking, null, 'update',
    '[{"id":"STU-WINDOW","owner":"Abby","planner":"Molly"}]'::jsonb,
    trial_start - interval '46 hours'
  );
  if (select count(*) from jsonb_array_elements(projected) item(value)
      where item.value ->> 'ruleKey' = 'trial.payment-n2'
        and item.value ->> 'owner' = 'Molly'
        and item.value -> 'assignees' = '["Molly"]'::jsonb
        and item.value ->> 'status' <> 'done') <> 1
     or exists (
       select 1 from jsonb_array_elements(projected) item(value)
       where item.value ->> 'ruleKey' = 'trial.payment-n2'
         and item.value ->> 'owner' = 'Tara'
     ) then
    raise exception 'trial_payment_planner_reassignment_failed';
  end if;
end;
$window_contract$;

select 'trial_payment_reminders_runtime_ok' as result;
