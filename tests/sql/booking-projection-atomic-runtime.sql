\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

-- Disposable PostgreSQL 16 execution fixture for migration 20260819101900.
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
as $$ select p_secret = 'booking-projection-fixture-secret' $$;
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

-- Minimal recurrence/JWB predecessor contract required by forward 191019.
create function internal.booking_recurrence_interval_days(p_booking jsonb)
returns integer language plpgsql immutable set search_path = '' as $$
declare result integer := coalesce((p_booking ->> 'recurrenceIntervalDays')::integer, 7);
begin
  if result not between 1 and 365 then raise exception 'invalid interval'; end if;
  return result;
end;
$$;
create function internal.booking_recurrence_source_end_date(p_booking jsonb)
returns date language plpgsql immutable set search_path = '' as $$
declare start_date date := (p_booking ->> 'date')::date; by_count date; by_date date;
begin
  if coalesce(p_booking ->> 'recurring', 'false') <> 'true' then return start_date; end if;
  if p_booking ? 'repeatCount' then
    by_count := start_date + (((p_booking ->> 'repeatCount')::integer - 1)
      * internal.booking_recurrence_interval_days(p_booking));
  end if;
  if nullif(p_booking ->> 'recurrenceEndDate', '') is not null then
    by_date := (p_booking ->> 'recurrenceEndDate')::date;
  end if;
  if by_count is not null and by_date is not null then return least(by_count, by_date); end if;
  return coalesce(by_count, by_date);
end;
$$;
create function internal.booking_recurrence_occurrence_count(p_booking jsonb)
returns integer language sql immutable set search_path = '' as $$
  select case when internal.booking_recurrence_source_end_date(p_booking) is null then null
    else ((internal.booking_recurrence_source_end_date(p_booking) - (p_booking ->> 'date')::date)
      / internal.booking_recurrence_interval_days(p_booking)) + 1 end
$$;
create table internal.jiaowubao_direct_import_runs(id bigint primary key);
create table internal.jiaowubao_direct_current_schedule_blocks(
  teacher_id text not null,
  student_ids text[] not null,
  occupied_range tstzrange not null
);

-- Minimal faithful seam for the already-deployed 12-argument booking core.
-- The runtime below exercises the new wider transaction around this seam.
create function public.mutate_booking_capacity_atomic(
  p_secret text, p_command_key text, p_command_intent jsonb, p_action text,
  p_booking_id text, p_expected_versions jsonb, p_bookings jsonb,
  p_teachers jsonb, p_changed_teacher_ids jsonb, p_student_id text,
  p_teacher_id text, p_actor text
)
returns table (
  command_key text, action text, applied boolean, booking_id text,
  bookings_row public.ops_state, teachers_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql security definer set search_path = '' as $$
declare b public.ops_state%rowtype; h public.ops_state%rowtype; saved_b public.ops_state%rowtype;
  saved_h public.ops_state%rowtype; audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception 'invalid_ops_secret'; end if;
  select * into b from public.ops_state where entity = 'bookings' for update;
  select * into h from public.ops_state where entity = 'teachers' for update;
  if b.version <> (p_expected_versions ->> 'bookings')::bigint
     or h.version <> (p_expected_versions ->> 'teachers')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  update public.ops_state set payload = p_bookings, version = b.version + 1,
    updated_at = now(), updated_by = p_actor where entity = 'bookings' returning * into saved_b;
  if h.payload is distinct from p_teachers then
    update public.ops_state set payload = p_teachers, version = h.version + 1,
      updated_at = now(), updated_by = p_actor where entity = 'teachers' returning * into saved_h;
  else saved_h := h; end if;
  audit_id := internal.append_operational_contract_audit(
    'booking_capacity_' || p_action, p_actor, 'booking', p_booking_id, '{}'::jsonb
  );
  return query select p_command_key, p_action, true, p_booking_id, saved_b, saved_h, audit_id;
end;
$$;

\ir ../../supabase/migrations/20260819101900_booking_trial_projection_atomic.sql

insert into public.ops_state(entity, payload, version, updated_by) values
  ('bookings', '[]', 1, 'fixture'),
  ('students', '[{"id":"STU-1","name":"Trial Student","owner":"Abby","planner":"Tara","teacher":"待匹配","status":"线索","next":"确认试听","nextTone":"blue"}]', 1, 'fixture'),
  ('lpItems', '[{"id":"LP-REQ-1","studentId":"STU-1","workflowType":"试听 LP","requestedAt":"2099-01-01T00:00:00.000Z","fields":{"trialPaymentMethod":"付费试听（未付费）"}}]', 1, 'fixture'),
  ('tasks', '[
    {"id":"REQ-1","title":"发送家长试听跟进请求","owner":"Abby","studentId":"STU-1","due":"2099-01-01 18:00","dueAt":"2099-01-01T07:00:00.000Z","status":"upcoming","tone":"blue","category":"试听","trigger":"request","ruleKey":"trial.parent-follow-up","anchorBookingId":"LP-REQ-1"},
    {"id":"REQ-2","title":"完成试听排课","owner":"Abby","studentId":"STU-1","due":"2099-01-02 12:00","dueAt":"2099-01-02T01:00:00.000Z","status":"upcoming","tone":"red","category":"排课","trigger":"request","ruleKey":"trial.scheduling","anchorBookingId":"LP-REQ-1"},
    {"id":"ESC-1","title":"家长未回复","owner":"Abby","studentId":"STU-1","due":"2099-01-01 20:00","dueAt":"2099-01-01T09:00:00.000Z","status":"upcoming","tone":"red","category":"试听","trigger":"request","ruleKey":"trial.teaching-control-escalation","anchorBookingId":"LP-REQ-1"}
  ]', 1, 'fixture'),
  ('teachers', '[{"id":"TEA-1","name":"Teacher One","newStudentCapacity":1,"capacityAssignments":[]}]', 1, 'fixture');

do $runtime$
declare
  booking jsonb := '{"id":"BOOK-1","studentId":"STU-1","teacherId":"TEA-1","date":"2099-01-10","start":"10:00","duration":60,"kind":"试听","status":"待确认","timezone":"Australia/Melbourne","recurring":false,"repeatCount":1,"course":"English","teacherSubjectId":"Local English","requestedAt":"2099-01-01T00:00:00.000Z"}';
  intent jsonb;
  receipt record;
  replay record;
  before_versions jsonb;
  after_versions jsonb;
  caught_state text;
  caught_message text;
begin
  intent := jsonb_build_object('action','upsert','bookingId','BOOK-1','booking',
    jsonb_build_object('studentId','STU-1','teacherId','TEA-1','date','2099-01-10','start','10:00','duration',60,'kind','试听','timezone','Australia/Melbourne','recurring',false,'repeatCount',1,'subjectId','English','teacherSubjectId','Local English'));
  select * into receipt from public.mutate_booking_projection_atomic(
    'booking-projection-fixture-secret',
    'booking-capacity:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    intent, 'create', 'BOOK-1',
    '{"bookings":1,"students":1,"lpItems":1,"tasks":1,"teachers":1}',
    jsonb_build_array(booking),
    (select payload from public.ops_state where entity = 'teachers'),
    '[]', 'STU-1', 'TEA-1', 'staff', 'Abby'
  );
  if not receipt.applied
     or (receipt.bookings_row).version <> 2
     or (receipt.students_row).version <> 2
     or (receipt.lp_items_row).version <> 1
     or (receipt.tasks_row).version <> 2
     or (receipt.teachers_row).version <> 1 then
    raise exception 'booking_projection_create_versions_failed';
  end if;
  if not exists (
    select 1 from jsonb_array_elements((receipt.students_row).payload) value
    where value ->> 'id' = 'STU-1' and value ->> 'teacher' = 'Teacher One'
      and value ->> 'status' = '活跃 + 无课时'
      and value ->> 'next' = '完成 LP 与 N-2 检查'
  ) then raise exception 'booking_projection_student_failed'; end if;
  if not exists (
    select 1 from jsonb_array_elements((receipt.tasks_row).payload) value
    where value ->> 'id' = 'REQ-1' and value ->> 'anchorBookingId' = 'BOOK-1'
  ) or not exists (
    select 1 from jsonb_array_elements((receipt.tasks_row).payload) value
    where value ->> 'id' = 'ESC-1' and value ->> 'status' = 'done'
      and value ->> 'result' = '试听已完成排课，升级任务自动关闭'
  ) or not exists (
    select 1 from jsonb_array_elements((receipt.tasks_row).payload) value
    where value ->> 'anchorBookingId' = 'BOOK-1' and value ->> 'ruleKey' = 'trial.minimum'
  ) then raise exception 'booking_projection_trial_link_failed'; end if;

  -- Stale expected versions are ignored only after exact actor+intent replay.
  select * into replay from public.mutate_booking_projection_atomic(
    'booking-projection-fixture-secret',
    'booking-capacity:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    intent, 'create', 'BOOK-1',
    '{"bookings":1,"students":1,"lpItems":1,"tasks":1,"teachers":1}',
    jsonb_build_array(booking),
    (select payload from public.ops_state where entity = 'teachers'),
    '[]', 'STU-1', 'TEA-1', 'staff', 'Abby'
  );
  if replay.applied or (replay.bookings_row).version <> 2
     or (replay.students_row).version <> 2 or (replay.tasks_row).version <> 2 then
    raise exception 'booking_projection_replay_failed';
  end if;

  select jsonb_object_agg(entity, version) into before_versions from public.ops_state;
  begin
    perform public.mutate_booking_projection_atomic(
      'booking-projection-fixture-secret',
      'booking-capacity:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      jsonb_build_object('action','upsert','bookingId','BOOK-2','booking',intent -> 'booking'),
      'create', 'BOOK-2',
      '{"bookings":2,"students":2,"lpItems":1,"tasks":2,"teachers":1}',
      (select payload || jsonb_build_array(booking || jsonb_build_object(
        'id','BOOK-2','date','2020-01-01','requestedAt','2020-01-01T00:00:00.000Z'
      )) from public.ops_state where entity = 'bookings'),
      (select payload from public.ops_state where entity = 'teachers'),
      '[]', 'STU-1', 'TEA-1', 'staff', 'Abby'
    );
    raise exception 'booking_projection_failure_was_accepted';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '22023' or caught_message <> 'invalid_booking_projection_trial_clock' then raise; end if;
  end;
  select jsonb_object_agg(entity, version) into after_versions from public.ops_state;
  if after_versions is distinct from before_versions
     or exists (select 1 from jsonb_array_elements((select payload from public.ops_state where entity='bookings')) value where value ->> 'id'='BOOK-2')
     or (select count(*) from internal.operational_contract_audit) <> 1 then
    raise exception 'booking_projection_failure_did_not_roll_back';
  end if;

  -- A caller cannot smuggle students/tasks through the semantic command.
  begin
    perform public.mutate_booking_projection_atomic(
      'booking-projection-fixture-secret',
      'booking-capacity:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      intent || jsonb_build_object('tasks', jsonb_build_array(jsonb_build_object('id','FORGED'))),
      'update', 'BOOK-1',
      '{"bookings":2,"students":2,"lpItems":1,"tasks":2,"teachers":1}',
      (select payload from public.ops_state where entity = 'bookings'),
      (select payload from public.ops_state where entity = 'teachers'),
      '[]', 'STU-1', 'TEA-1', 'staff', 'Abby'
    );
    raise exception 'booking_projection_derived_forgery_was_accepted';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '22023' or caught_message <> 'invalid_booking_projection_command' then raise; end if;
  end;

  intent := jsonb_build_object('action','delete','bookingId','BOOK-1');
  select * into receipt from public.mutate_booking_projection_atomic(
    'booking-projection-fixture-secret',
    'booking-capacity:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    intent, 'delete', 'BOOK-1',
    '{"bookings":2,"students":2,"lpItems":1,"tasks":2,"teachers":1}',
    '[]', (select payload from public.ops_state where entity = 'teachers'),
    '[]', 'STU-1', 'TEA-1', 'staff', 'Abby'
  );
  if not receipt.applied or exists (
    select 1 from jsonb_array_elements((receipt.tasks_row).payload) value
    where value ->> 'anchorBookingId' = 'BOOK-1' and value ->> 'status' <> 'done'
  ) then raise exception 'booking_projection_delete_close_failed'; end if;

  select * into replay from public.get_booking_projection_command_result(
    'booking-projection-fixture-secret',
    'booking-capacity:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    intent, 'Abby'
  );
  if replay.booking_id <> 'BOOK-1' or (replay.bookings_row).version <> 3
     or (replay.students_row).version <> 3 or (replay.tasks_row).version <> 3
     or (replay.teachers_row).version <> 1 then
    raise exception 'booking_projection_lookup_rows_failed';
  end if;
  if replay.teacher_id <> 'TEA-1' or replay.previous_teacher_id <> 'TEA-1'
     or replay.actor_role <> 'staff'
     or replay.booking_version <> 3 or replay.student_version <> 3
     or replay.task_version <> 3 then
    raise exception 'booking_projection_lookup_authority_failed';
  end if;
  if not exists (
    select 1 from jsonb_array_elements((replay.students_row).payload) value
    where value ->> 'id' = 'STU-1' and value ->> 'teacher' = '待匹配'
      and value ->> 'next' = '确认首次排课'
  ) then raise exception 'booking_projection_delete_student_rebuild_failed'; end if;
  if (select count(*) from internal.booking_projection_commands) <> 2
     or (select count(*) from internal.operational_contract_audit) <> 2 then
    raise exception 'booking_projection_ledger_count_failed';
  end if;
end;
$runtime$;

-- Recurring occurrence cancellation: only the last effective lesson releases
-- capacity and closes the linked request/escalation workflow.
update public.ops_state set payload = '[{
  "id":"BOOK-SERIES","studentId":"STU-1","teacherId":"TEA-1",
  "date":"2099-01-10","start":"10:00","duration":60,"kind":"试听",
  "status":"待确认","timezone":"Australia/Melbourne","recurring":true,
  "repeatCount":3,"recurrenceIntervalDays":7,"recurrenceEndDate":"2099-01-24",
  "course":"English","teacherSubjectId":"Local English",
  "requestedAt":"2099-01-01T00:00:00.000Z"
}]', version = 10 where entity = 'bookings';
update public.ops_state set payload = '[
  {"id":"STU-1","name":"Trial Student","owner":"Abby","teacher":"Teacher One","status":"活跃 + 无课时","next":"完成 LP 与 N-2 检查","nextTone":"amber"}
]', version = 10 where entity = 'students';
update public.ops_state set payload = '[
  {"id":"REQ-1","owner":"Abby","studentId":"STU-1","due":"2099-01-01 18:00","dueAt":"2099-01-01T07:00:00.000Z","status":"upcoming","tone":"blue","ruleKey":"trial.parent-follow-up","anchorBookingId":"BOOK-SERIES","requestAnchorBookingId":"LP-REQ-1"},
  {"id":"REQ-2","owner":"Abby","studentId":"STU-1","due":"2099-01-02 12:00","dueAt":"2099-01-02T01:00:00.000Z","status":"upcoming","tone":"red","ruleKey":"trial.scheduling","anchorBookingId":"BOOK-SERIES","requestAnchorBookingId":"LP-REQ-1"},
  {"id":"ESC-1","owner":"Abby","studentId":"STU-1","due":"2099-01-01 20:00","dueAt":"2099-01-01T09:00:00.000Z","status":"upcoming","tone":"red","ruleKey":"trial.teaching-control-escalation","anchorBookingId":"LP-REQ-1"}
]', version = 10 where entity = 'tasks';
update public.ops_state set payload = '[
  {"id":"TEA-1","name":"Teacher One","newStudentCapacity":0,"capacityAssignments":["STU-1"]}
]', version = 10 where entity = 'teachers';

do $recurring_runtime$
declare
  series jsonb := (select payload -> 0 from public.ops_state where entity = 'bookings');
  next_series jsonb;
  receipt record;
  caught_state text;
  caught_message text;
begin
  insert into internal.jiaowubao_direct_current_schedule_blocks(teacher_id, student_ids, occupied_range)
  values ('TEA-1', array['STU-1'], tstzrange('2099-01-16T23:00:00Z', '2099-01-17T00:00:00Z', '[)'));
  begin
    perform internal.assert_jiaowubao_direct_booking_interval_available('STU-1', 'TEA-1', series);
    raise exception 'booking_projection_jwb_conflict_was_accepted';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> 'P0001' or caught_message <> 'jiaowubao_direct_import_schedule_conflict' then raise; end if;
  end;

  next_series := series || jsonb_build_object('occurrenceOverrides', jsonb_build_array(
    jsonb_build_object('occurrenceId','BOOK-SERIES:2099-01-17','status','cancelled')
  ));
  -- The exact same imported collision is absent once that occurrence is
  -- cancelled; the guard must not reject the removal operation.
  perform internal.assert_jiaowubao_direct_booking_interval_available('STU-1', 'TEA-1', next_series);
  delete from internal.jiaowubao_direct_current_schedule_blocks;

  select * into receipt from public.mutate_booking_projection_atomic(
    'booking-projection-fixture-secret',
    'booking-capacity:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    jsonb_build_object('action','cancel_occurrence','bookingId','BOOK-SERIES','occurrenceId','BOOK-SERIES:2099-01-17'),
    'update', 'BOOK-SERIES',
    '{"bookings":10,"students":10,"lpItems":1,"tasks":10,"teachers":10}',
    jsonb_build_array(next_series),
    (select payload from public.ops_state where entity = 'teachers'),
    '[]', 'STU-1', 'TEA-1', 'staff', 'Abby'
  );
  if not receipt.applied
     or not internal.booking_projection_has_active_relationship(
       (receipt.bookings_row).payload -> 0, 'STU-1', 'TEA-1'
     )
     or (receipt.teachers_row).version <> 10
     or exists (
       select 1 from jsonb_array_elements((receipt.tasks_row).payload) task(value)
       where task.value ->> 'status' = 'done'
         and task.value ->> 'result' = '试听课次已全部取消'
     ) then
    raise exception 'booking_projection_middle_cancel_failed';
  end if;

  series := (receipt.bookings_row).payload -> 0;
  next_series := series || jsonb_build_object('occurrenceOverrides',
    (series -> 'occurrenceOverrides') || jsonb_build_array(
      jsonb_build_object('occurrenceId','BOOK-SERIES:2099-01-10','status','cancelled')
    ));
  select * into receipt from public.mutate_booking_projection_atomic(
    'booking-projection-fixture-secret',
    'booking-capacity:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    jsonb_build_object('action','cancel_occurrence','bookingId','BOOK-SERIES','occurrenceId','BOOK-SERIES:2099-01-10'),
    'update', 'BOOK-SERIES',
    jsonb_build_object(
      'bookings',(select version from public.ops_state where entity='bookings'),
      'students',(select version from public.ops_state where entity='students'),
      'lpItems',(select version from public.ops_state where entity='lpItems'),
      'tasks',(select version from public.ops_state where entity='tasks'),
      'teachers',(select version from public.ops_state where entity='teachers')
    ),
    jsonb_build_array(next_series),
    (select payload from public.ops_state where entity = 'teachers'),
    '[]', 'STU-1', 'TEA-1', 'staff', 'Abby'
  );
  if not internal.booking_projection_has_active_relationship(
    (receipt.bookings_row).payload -> 0, 'STU-1', 'TEA-1'
  ) then raise exception 'booking_projection_penultimate_cancel_released_relationship'; end if;

  series := (receipt.bookings_row).payload -> 0;
  next_series := series || jsonb_build_object('occurrenceOverrides',
    (series -> 'occurrenceOverrides') || jsonb_build_array(
      jsonb_build_object('occurrenceId','BOOK-SERIES:2099-01-24','status','cancelled')
    ));
  select * into receipt from public.mutate_booking_projection_atomic(
    'booking-projection-fixture-secret',
    'booking-capacity:0000000000000000000000000000000000000000000000000000000000000000',
    jsonb_build_object('action','cancel_occurrence','bookingId','BOOK-SERIES','occurrenceId','BOOK-SERIES:2099-01-24'),
    'update', 'BOOK-SERIES',
    jsonb_build_object(
      'bookings',(select version from public.ops_state where entity='bookings'),
      'students',(select version from public.ops_state where entity='students'),
      'lpItems',(select version from public.ops_state where entity='lpItems'),
      'tasks',(select version from public.ops_state where entity='tasks'),
      'teachers',(select version from public.ops_state where entity='teachers')
    ),
    jsonb_build_array(next_series),
    '[{"id":"TEA-1","name":"Teacher One","newStudentCapacity":1,"capacityAssignments":[]}]',
    '["TEA-1"]', 'STU-1', 'TEA-1', 'staff', 'Abby'
  );
  if internal.booking_projection_has_active_relationship(
       (receipt.bookings_row).payload -> 0, 'STU-1', 'TEA-1'
     )
     or not exists (
       select 1 from jsonb_array_elements((receipt.students_row).payload) student(value)
       where student.value ->> 'id' = 'STU-1'
         and student.value ->> 'teacher' = '待匹配'
         and student.value ->> 'next' = '确认首次排课'
     )
     or not exists (
       select 1 from jsonb_array_elements((receipt.teachers_row).payload) teacher(value)
       where teacher.value ->> 'id' = 'TEA-1'
         and teacher.value ->> 'newStudentCapacity' = '1'
         and teacher.value -> 'capacityAssignments' = '[]'::jsonb
     )
     or (select count(*) from jsonb_array_elements((receipt.tasks_row).payload) task(value)
       where task.value ->> 'id' in ('REQ-1','REQ-2','ESC-1')) <> 3
     or exists (
       select 1 from jsonb_array_elements((receipt.tasks_row).payload) task(value)
       where task.value ->> 'id' in ('REQ-1','REQ-2','ESC-1')
         and task.value ->> 'status' <> 'done'
     ) then
    raise exception 'booking_projection_last_cancel_failed';
  end if;

  -- Four exact 14-day source dates are represented by this end bound; an
  -- override on the third date must not silently become a weekly occurrence.
  series := jsonb_build_object(
    'id','BOOK-14','studentId','STU-1','teacherId','TEA-1','date','2099-01-10',
    'start','10:00','duration',60,'kind','试听','timezone','Australia/Melbourne',
    'recurring',true,'recurrenceIntervalDays',14,'recurrenceEndDate','2099-03-01',
    'occurrenceOverrides',jsonb_build_array(
      jsonb_build_object('occurrenceId','BOOK-14:2099-02-07','status','cancelled')
    )
  );
  if internal.booking_recurrence_occurrence_count(series) <> 4
     or not internal.booking_projection_has_active_relationship(series, 'STU-1', 'TEA-1') then
    raise exception 'booking_projection_fourteen_day_bound_failed';
  end if;
end;
$recurring_runtime$;

-- A trial moved from teacher/student A to B reprojects both sides, then a
-- trial-to-regular edit closes already-relinked request tasks and a later LP
-- escalation without changing their identities.
update public.ops_state set payload = '[{
  "id":"BOOK-MOVE","studentId":"STU-A","teacherId":"TEA-A",
  "date":"2099-02-10","start":"10:00","duration":60,"kind":"试听",
  "status":"待确认","timezone":"Australia/Melbourne","recurring":false,
  "repeatCount":1,"course":"English","teacherSubjectId":"Local English",
  "requestedAt":"2099-02-01T00:00:00.000Z"
}]', version = 30 where entity = 'bookings';
update public.ops_state set payload = '[
  {"id":"STU-A","name":"Student A","owner":"Abby","teacher":"Teacher A","status":"活跃 + 无课时","next":"完成 LP 与 N-2 检查","nextTone":"amber"},
  {"id":"STU-B","name":"Student B","owner":"Tara","teacher":"待匹配","status":"线索","next":"确认试听","nextTone":"blue"}
]', version = 30 where entity = 'students';
update public.ops_state set payload = '[
  {"id":"LP-A","studentId":"STU-A","workflowType":"试听 LP"},
  {"id":"LP-B","studentId":"STU-B","workflowType":"试听 LP"}
]', version = 30 where entity = 'lpItems';
update public.ops_state set payload = '[
  {"id":"REQ-A1","owner":"Abby","studentId":"STU-A","due":"2099-02-01 18:00","dueAt":"2099-02-01T07:00:00.000Z","status":"upcoming","tone":"blue","ruleKey":"trial.parent-follow-up","anchorBookingId":"BOOK-MOVE","requestAnchorBookingId":"LP-A"},
  {"id":"ESC-A","owner":"Abby","studentId":"STU-A","due":"2099-02-02 18:00","dueAt":"2099-02-02T07:00:00.000Z","status":"upcoming","tone":"red","ruleKey":"trial.teaching-control-escalation","anchorBookingId":"LP-A"},
  {"id":"REQ-B1","owner":"Tara","studentId":"STU-B","due":"2099-02-01 18:00","dueAt":"2099-02-01T07:00:00.000Z","status":"upcoming","tone":"blue","ruleKey":"trial.parent-follow-up","anchorBookingId":"LP-B"},
  {"id":"REQ-B2","owner":"Tara","studentId":"STU-B","due":"2099-02-02 12:00","dueAt":"2099-02-02T01:00:00.000Z","status":"upcoming","tone":"red","ruleKey":"trial.scheduling","anchorBookingId":"LP-B"},
  {"id":"ESC-B","owner":"Tara","studentId":"STU-B","due":"2099-02-02 18:00","dueAt":"2099-02-02T07:00:00.000Z","status":"upcoming","tone":"red","ruleKey":"trial.teaching-control-escalation","anchorBookingId":"LP-B"}
]', version = 30 where entity = 'tasks';
update public.ops_state set payload = '[
  {"id":"TEA-A","name":"Teacher A","newStudentCapacity":0,"capacityAssignments":["STU-A"]},
  {"id":"TEA-B","name":"Teacher B","newStudentCapacity":1,"capacityAssignments":[]}
]', version = 30 where entity = 'teachers';

do $move_runtime$
declare
  moved jsonb := '{
    "id":"BOOK-MOVE","studentId":"STU-B","teacherId":"TEA-B",
    "date":"2099-02-10","start":"10:00","duration":60,"kind":"试听",
    "status":"待确认","timezone":"Australia/Melbourne","recurring":false,
    "repeatCount":1,"course":"English","teacherSubjectId":"Local English",
    "requestedAt":"2099-02-01T00:00:00.000Z"
  }';
  regular jsonb;
  receipt record;
begin
  select * into receipt from public.mutate_booking_projection_atomic(
    'booking-projection-fixture-secret',
    'booking-capacity:1111111111111111111111111111111111111111111111111111111111111111',
    jsonb_build_object('action','upsert','bookingId','BOOK-MOVE','booking',
      jsonb_build_object('studentId','STU-B','teacherId','TEA-B')),
    'update', 'BOOK-MOVE',
    '{"bookings":30,"students":30,"lpItems":30,"tasks":30,"teachers":30}',
    jsonb_build_array(moved),
    '[
      {"id":"TEA-A","name":"Teacher A","newStudentCapacity":1,"capacityAssignments":[]},
      {"id":"TEA-B","name":"Teacher B","newStudentCapacity":0,"capacityAssignments":["STU-B"]}
    ]',
    '["TEA-A","TEA-B"]', 'STU-B', 'TEA-B', 'staff', 'Abby'
  );
  if not exists (
       select 1 from jsonb_array_elements((receipt.students_row).payload) student(value)
       where student.value ->> 'id' = 'STU-A'
         and student.value ->> 'teacher' = '待匹配'
         and student.value ->> 'next' = '确认首次排课'
     ) or not exists (
       select 1 from jsonb_array_elements((receipt.students_row).payload) student(value)
       where student.value ->> 'id' = 'STU-B'
         and student.value ->> 'teacher' = 'Teacher B'
         and student.value ->> 'status' = '活跃 + 无课时'
         and student.value ->> 'next' = '完成 LP 与 N-2 检查'
     ) or not exists (
       select 1 from jsonb_array_elements((receipt.tasks_row).payload) task(value)
       where task.value ->> 'id' = 'REQ-A1' and task.value ->> 'status' = 'done'
         and task.value ->> 'anchorBookingId' = 'BOOK-MOVE:retired:STU-A'
     ) or not exists (
       select 1 from jsonb_array_elements((receipt.tasks_row).payload) task(value)
       where task.value ->> 'id' = 'REQ-B1' and task.value ->> 'studentId' = 'STU-B'
         and task.value ->> 'anchorBookingId' = 'BOOK-MOVE'
         and task.value ->> 'requestAnchorBookingId' = 'LP-B'
     ) or not exists (
       select 1 from jsonb_array_elements((receipt.tasks_row).payload) task(value)
       where task.value ->> 'id' = 'ESC-A' and task.value ->> 'status' = 'done'
     ) then
    raise exception 'booking_projection_move_double_projection_failed';
  end if;

  -- Simulate the authoritative escalation scheduler adding a new source-LP
  -- task after request tasks were already relinked to the booking.
  update public.ops_state set
    payload = payload || jsonb_build_array(jsonb_build_object(
      'id','ESC-B-LATE','owner','Tara','studentId','STU-B',
      'due','2099-02-03 18:00','dueAt','2099-02-03T07:00:00.000Z',
      'status','upcoming','tone','red','ruleKey','trial.parent-no-reply-follow-up',
      'anchorBookingId','LP-B'
    )),
    version = version + 1
  where entity = 'tasks';
  regular := moved || jsonb_build_object('kind','常规课','packageId','PKG-1');
  select * into receipt from public.mutate_booking_projection_atomic(
    'booking-projection-fixture-secret',
    'booking-capacity:2222222222222222222222222222222222222222222222222222222222222222',
    jsonb_build_object('action','upsert','bookingId','BOOK-MOVE','booking',
      jsonb_build_object('studentId','STU-B','teacherId','TEA-B','kind','常规课')),
    'update', 'BOOK-MOVE',
    jsonb_build_object(
      'bookings',(select version from public.ops_state where entity='bookings'),
      'students',(select version from public.ops_state where entity='students'),
      'lpItems',(select version from public.ops_state where entity='lpItems'),
      'tasks',(select version from public.ops_state where entity='tasks'),
      'teachers',(select version from public.ops_state where entity='teachers')
    ),
    jsonb_build_array(regular),
    (select payload from public.ops_state where entity = 'teachers'),
    '[]', 'STU-B', 'TEA-B', 'staff', 'Abby'
  );
  if (select count(*) from jsonb_array_elements((receipt.tasks_row).payload) task(value)
       where task.value ->> 'id' in ('REQ-B1','REQ-B2','ESC-B-LATE')) <> 3
     or exists (
       select 1 from jsonb_array_elements((receipt.tasks_row).payload) task(value)
       where task.value ->> 'id' in ('REQ-B1','REQ-B2','ESC-B-LATE')
         and task.value ->> 'status' <> 'done'
     ) or not exists (
       select 1 from jsonb_array_elements((receipt.tasks_row).payload) task(value)
       where task.value ->> 'id' = 'ESC-B-LATE'
         and task.value ->> 'result' = '试听已改为其他课程类型'
     ) then
    raise exception 'booking_projection_relinked_transition_close_failed';
  end if;
end;
$move_runtime$;

-- READ COMMITTED regression: a students/tasks-only writer is allowed to own
-- the first row in its own lock subset before replay begins.  Replay must lock
-- bookings before it waits on students, yet all five returned rows must still
-- come from the one statement snapshot that predates the writer commit.
create or replace function internal.booking_projection_probe_booking_share_lock()
returns boolean
language plpgsql
set search_path = ''
as $probe$
begin
  perform set_config('lock_timeout', '100ms', true);
  begin
    update public.ops_state set updated_at = updated_at where entity = 'bookings';
  exception when lock_not_available then
    return true;
  end;
  return false;
end;
$probe$;

do $replay_concurrency$
declare
  connection_string text := format(
    'dbname=%L host=%L port=%s',
    current_database(), current_setting('unix_socket_directories'), current_setting('port')
  );
  replay_intent jsonb := jsonb_build_object(
    'action','upsert','bookingId','BOOK-MOVE','booking',
    jsonb_build_object('studentId','STU-B','teacherId','TEA-B','kind','常规课')
  );
  replay_sql text;
  reader_pid integer;
  send_status integer;
  attempt integer;
  reader_waiting boolean := false;
  booking_lock_held boolean;
  before_b bigint;
  before_s bigint;
  before_l bigint;
  before_t bigint;
  before_h bigint;
  got_b bigint;
  got_s bigint;
  got_l bigint;
  got_t bigint;
  got_h bigint;
begin
  select
    max(version) filter (where entity = 'bookings'),
    max(version) filter (where entity = 'students'),
    max(version) filter (where entity = 'lpItems'),
    max(version) filter (where entity = 'tasks'),
    max(version) filter (where entity = 'teachers')
  into before_b, before_s, before_l, before_t, before_h
  from public.ops_state;

  perform extensions.dblink_connect('booking_mix_writer', connection_string);
  perform extensions.dblink_exec('booking_mix_writer', pg_temp.disposable_database_assertion_sql());
  perform extensions.dblink_connect('booking_mix_reader', connection_string);
  perform extensions.dblink_exec('booking_mix_reader', pg_temp.disposable_database_assertion_sql());
  perform extensions.dblink_connect('booking_mix_probe', connection_string);
  perform extensions.dblink_exec('booking_mix_probe', pg_temp.disposable_database_assertion_sql());
  select pid into reader_pid
  from extensions.dblink('booking_mix_reader', 'select pg_backend_pid()') result(pid integer);

  perform extensions.dblink_exec('booking_mix_writer', 'begin');
  perform held.entity
  from extensions.dblink(
    'booking_mix_writer',
    'select entity from public.ops_state where entity = ''students'' for update'
  ) held(entity text);

  replay_sql := format(
    'select (bookings_row).version, (students_row).version, (lp_items_row).version, '
      || '(tasks_row).version, (teachers_row).version '
      || 'from public.get_booking_projection_command_result(%L,%L,%L::jsonb,%L)',
    'booking-projection-fixture-secret',
    'booking-capacity:2222222222222222222222222222222222222222222222222222222222222222',
    replay_intent::text,
    'Abby'
  );
  select extensions.dblink_send_query('booking_mix_reader', replay_sql) into send_status;
  if send_status <> 1 then raise exception 'booking_projection_replay_async_start_failed'; end if;

  for attempt in 1..500 loop
    select coalesce(wait_event_type = 'Lock', false) into reader_waiting
    from pg_catalog.pg_stat_activity where pid = reader_pid;
    exit when reader_waiting;
    perform pg_sleep(0.01);
  end loop;
  if not reader_waiting then raise exception 'booking_projection_replay_did_not_wait_in_order'; end if;

  select result.locked into booking_lock_held
  from extensions.dblink(
    'booking_mix_probe',
    'select internal.booking_projection_probe_booking_share_lock()'
  ) result(locked boolean);
  if booking_lock_held is not true then
    raise exception 'booking_projection_replay_did_not_lock_bookings_before_students';
  end if;

  perform extensions.dblink_exec(
    'booking_mix_writer',
    'update public.ops_state set version = version + 100 where entity = ''students'''
  );
  perform extensions.dblink_exec(
    'booking_mix_writer',
    'update public.ops_state set version = version + 100 where entity = ''tasks'''
  );
  perform extensions.dblink_exec('booking_mix_writer', 'commit');

  for attempt in 1..500 loop
    exit when extensions.dblink_is_busy('booking_mix_reader') = 0;
    perform pg_sleep(0.01);
  end loop;
  if extensions.dblink_is_busy('booking_mix_reader') <> 0 then
    raise exception 'booking_projection_replay_did_not_finish';
  end if;
  select result.bookings, result.students, result.lp_items, result.tasks, result.teachers
  into got_b, got_s, got_l, got_t, got_h
  from extensions.dblink_get_result('booking_mix_reader') result(
    bookings bigint, students bigint, lp_items bigint, tasks bigint, teachers bigint
  );

  if array[got_b, got_s, got_l, got_t, got_h]
       is distinct from array[before_b, before_s, before_l, before_t, before_h]
     or (select version from public.ops_state where entity = 'students') <> before_s + 100
     or (select version from public.ops_state where entity = 'tasks') <> before_t + 100 then
    raise exception 'booking_projection_replay_returned_mixed_snapshot';
  end if;
  perform extensions.dblink_disconnect('booking_mix_probe');
  perform extensions.dblink_disconnect('booking_mix_reader');
  perform extensions.dblink_disconnect('booking_mix_writer');
exception when others then
  begin perform extensions.dblink_exec('booking_mix_writer', 'rollback'); exception when others then null; end;
  begin perform extensions.dblink_disconnect('booking_mix_probe'); exception when others then null; end;
  begin perform extensions.dblink_disconnect('booking_mix_reader'); exception when others then null; end;
  begin perform extensions.dblink_disconnect('booking_mix_writer'); exception when others then null; end;
  raise;
end;
$replay_concurrency$;

select 'booking_projection_atomic_runtime_ok' as result;
