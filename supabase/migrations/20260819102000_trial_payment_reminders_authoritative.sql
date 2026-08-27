-- Paid-trial reminders are derived only from locked booking/student/LP/task
-- state. Booking mutations invoke the projection inside the existing five-row
-- transaction; a dedicated scheduler advances the <24-hour window using the
-- exact same lock order. No generic ops_state trigger or browser task payload
-- participates in this workflow.

set local lock_timeout = '1s';

create table if not exists internal.trial_payment_reconcile_runs (
  run_key text primary key check (
    run_key ~ '^trial-payment-reconcile:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  expected_versions jsonb not null check (jsonb_typeof(expected_versions) = 'object'),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  applied boolean not null,
  changed_count integer not null check (changed_count >= 0),
  booking_version bigint not null check (booking_version > 0),
  student_version bigint not null check (student_version > 0),
  lp_item_version bigint not null check (lp_item_version > 0),
  task_version bigint not null check (task_version > 0),
  teacher_version bigint not null check (teacher_version > 0),
  actor text not null check (actor = 'Trial Payment Scheduler'),
  applied_at timestamptz not null default clock_timestamp(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

create table if not exists internal.trial_payment_completion_commands (
  command_key text primary key check (
    command_key ~ '^trial-payment-complete:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_sha256 text not null check (command_sha256 ~ '^[a-f0-9]{64}$'),
  task_id text not null check (length(task_id) between 1 and 160),
  booking_id text not null check (length(booking_id) between 1 and 120),
  student_id text not null check (length(student_id) between 1 and 240),
  task_version bigint not null check (task_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default clock_timestamp(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.trial_payment_reconcile_runs enable row level security;
alter table internal.trial_payment_completion_commands enable row level security;
revoke all on table internal.trial_payment_reconcile_runs from public, anon, authenticated, service_role;
revoke all on table internal.trial_payment_completion_commands from public, anon, authenticated, service_role;

create or replace function internal.trial_payment_iso(p_value timestamptz)
returns text
language sql
immutable
set search_path = ''
as $function$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$function$;

create or replace function internal.trial_payment_task_status(
  p_due_at timestamptz,
  p_now timestamptz
)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when (p_due_at at time zone 'Australia/Melbourne')::date
       < (p_now at time zone 'Australia/Melbourne')::date then 'overdue'
    when (p_due_at at time zone 'Australia/Melbourne')::date
       = (p_now at time zone 'Australia/Melbourne')::date then 'today'
    else 'upcoming'
  end
$function$;

create or replace function internal.trial_payment_lp_for_student(
  p_lp_items jsonb,
  p_tasks jsonb,
  p_student_id text,
  p_booking_id text
)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with candidates as (
    select candidate.value, candidate.ordinality
    from jsonb_array_elements(p_lp_items) with ordinality candidate(value, ordinality)
    where candidate.value ->> 'studentId' = p_student_id
      and candidate.value ->> 'workflowType' in ('试听 LP', '换老师试听')
      and nullif(trim(candidate.value ->> 'id'), '') is not null
  ), explicit_booking_links as (
    select candidate.value, candidate.ordinality
    from candidates candidate
    where exists (
      select 1 from jsonb_array_elements(p_tasks) linked(value)
      where linked.value ->> 'anchorBookingId' = p_booking_id
        and linked.value ->> 'studentId' = p_student_id
        and linked.value ->> 'requestAnchorBookingId' = candidate.value ->> 'id'
    )
  ), legacy_lp_links as (
    select candidate.value, candidate.ordinality
    from candidates candidate
    where exists (
      select 1 from jsonb_array_elements(p_tasks) linked(value)
      where linked.value ->> 'anchorBookingId' = candidate.value ->> 'id'
        and linked.value ->> 'studentId' = p_student_id
    )
  ), selected as (
    select explicit.value, explicit.ordinality
    from explicit_booking_links explicit
    where (select count(*) from explicit_booking_links) = 1
    union all
    select legacy.value, legacy.ordinality
    from legacy_lp_links legacy
    where (select count(*) from explicit_booking_links) = 0
      and (select count(*) from legacy_lp_links) = 1
  )
  select selected.value from selected limit 1
$function$;

create or replace function internal.reconcile_trial_payment_tasks_for_booking(
  p_tasks jsonb,
  p_lp_items jsonb,
  p_booking jsonb,
  p_previous_booking jsonb,
  p_action text,
  p_students jsonb,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  working jsonb := p_tasks;
  booking jsonb := case when p_action = 'delete' then p_previous_booking else p_booking end;
  booking_id text := coalesce(p_booking ->> 'id', p_previous_booking ->> 'id');
  student_id text := booking ->> 'studentId';
  student jsonb;
  lp_item jsonb;
  existing jsonb;
  generated jsonb;
  method text;
  planner text;
  rule text;
  trial_starts_at timestamptz;
  due_at timestamptz;
  n2_due_at timestamptz;
  urgent_due_at timestamptz;
  fee_required boolean;
  paid boolean;
  paid_by_task boolean;
  n2_active boolean;
  urgent boolean;
  closed_at text := internal.trial_payment_iso(p_now);
  payment_rules constant text[] := array['trial.payment-n2', 'trial.payment-urgent'];
begin
  if jsonb_typeof(p_tasks) is distinct from 'array'
     or jsonb_typeof(p_lp_items) is distinct from 'array'
     or jsonb_typeof(p_students) is distinct from 'array'
     or p_action not in ('create', 'update', 'delete')
     or nullif(trim(booking_id), '') is null then
    raise exception using errcode = '22023', message = 'invalid_trial_payment_projection_state';
  end if;

  if p_action = 'delete' or booking ->> 'kind' <> '试听' then
    select coalesce(jsonb_agg(
      case when item.value ->> 'anchorBookingId' = booking_id
                  and item.value ->> 'ruleKey' = any(payment_rules)
                  and item.value ->> 'status' <> 'done'
        then item.value || jsonb_build_object(
          'status', 'done', 'tone', 'green',
          'result', '试听收费提醒不再适用', 'closedAt', closed_at
        ) else item.value end order by item.ordinality
    ), '[]'::jsonb) into working
    from jsonb_array_elements(working) with ordinality item(value, ordinality);
    return working;
  end if;

  begin
    trial_starts_at := (
      ((booking ->> 'date')::date + (booking ->> 'start')::time)
      at time zone (booking ->> 'timezone')
    );
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_trial_payment_booking_clock';
  end;
  if trial_starts_at is null or trial_starts_at <= p_now then
    select coalesce(jsonb_agg(
      case when item.value ->> 'anchorBookingId' = booking_id
                  and item.value ->> 'ruleKey' = any(payment_rules)
                  and item.value ->> 'status' <> 'done'
        then item.value || jsonb_build_object(
          'status', 'done', 'tone', 'green',
          'result', '试听收费提醒不再适用', 'closedAt', closed_at
        ) else item.value end order by item.ordinality
    ), '[]'::jsonb) into working
    from jsonb_array_elements(working) with ordinality item(value, ordinality);
    return working;
  end if;

  lp_item := internal.trial_payment_lp_for_student(
    p_lp_items, working, student_id, booking_id
  );
  method := nullif(trim(lp_item -> 'fields' ->> 'trialPaymentMethod'), '');
  fee_required := method in (
    '后置付费试听', '付费试听（已付费）', '付费试听（未付费）', '在读学生付费试听'
  );
  -- SQL IN returns NULL for a missing method. Fail closed: missing/null is not
  -- proof that this trial is chargeable and must not materialise a reminder.
  if fee_required is not true then
    select coalesce(jsonb_agg(
      case when item.value ->> 'anchorBookingId' = booking_id
                  and item.value ->> 'ruleKey' = any(payment_rules)
                  and item.value ->> 'status' <> 'done'
        then item.value || jsonb_build_object(
          'status', 'done', 'tone', 'green',
          'result', '试听收费提醒不再适用', 'closedAt', closed_at
        ) else item.value end order by item.ordinality
    ), '[]'::jsonb) into working
    from jsonb_array_elements(working) with ordinality item(value, ordinality);
    return working;
  end if;

  if (select count(*) from jsonb_array_elements(p_students) item(value)
      where item.value ->> 'id' = student_id) <> 1 then
    raise exception using errcode = '22023', message = 'trial_payment_student_identity_invalid';
  end if;
  select item.value into student from jsonb_array_elements(p_students) item(value)
  where item.value ->> 'id' = student_id;
  planner := nullif(trim(student ->> 'planner'), '');
  if planner is null or planner ~ '^(待分配|待确认|未知|角色待配置[:：])' then
    -- Never fall back to the operations owner: the requirement explicitly
    -- addresses only planning and teaching-control accounts.
    select coalesce(jsonb_agg(
      case when item.value ->> 'anchorBookingId' = booking_id
                  and item.value ->> 'ruleKey' = any(payment_rules)
                  and item.value ->> 'status' <> 'done'
        then item.value || jsonb_build_object(
          'status', 'done', 'tone', 'green',
          'result', '规划账号未配置，收费提醒暂停', 'closedAt', closed_at
        ) else item.value end order by item.ordinality
    ), '[]'::jsonb) into working
    from jsonb_array_elements(working) with ordinality item(value, ordinality);
    return working;
  end if;

  paid_by_task := exists (
    select 1 from jsonb_array_elements(working) item(value)
    where item.value ->> 'anchorBookingId' = booking_id
      and item.value ->> 'studentId' = student_id
      and item.value ->> 'ruleKey' = any(payment_rules)
      and item.value ->> 'status' = 'done'
      and item.value ->> 'result' = '已由规划老师确认试听付款'
      and jsonb_typeof(item.value -> 'assignees') = 'array'
      and jsonb_array_length(item.value -> 'assignees') = 1
      and item.value -> 'assignees' ->> 0 = item.value ->> 'owner'
      and nullif(trim(item.value ->> 'owner'), '') is not null
      and item.value -> 'watchers' = jsonb_build_array('Ops Admin')
  );
  paid := method = '付费试听（已付费）' or paid_by_task;
  n2_due_at := (((trial_starts_at at time zone 'Australia/Melbourne')::date - 2 + time '18:00') at time zone 'Australia/Melbourne');
  urgent_due_at := trial_starts_at - interval '24 hours';
  n2_active := trial_starts_at - p_now < interval '3 days';
  urgent := not paid and p_now > urgent_due_at and p_now < trial_starts_at;

  foreach rule in array payment_rules loop
    if rule = 'trial.payment-n2' and not n2_active then
      select coalesce(jsonb_agg(
        case when item.value ->> 'anchorBookingId' = booking_id
                    and item.value ->> 'ruleKey' = rule
                    and item.value ->> 'status' <> 'done'
          then item.value || jsonb_build_object(
            'status', 'done', 'tone', 'green',
            'result', '试听尚未进入 N-3 收费提醒窗口',
            'closedAt', closed_at
          ) else item.value end order by item.ordinality
      ), '[]'::jsonb) into working
      from jsonb_array_elements(working) with ordinality item(value, ordinality);
      continue;
    end if;
    if rule = 'trial.payment-urgent' and not urgent then
      select coalesce(jsonb_agg(
        case when item.value ->> 'anchorBookingId' = booking_id
                    and item.value ->> 'ruleKey' = rule
                    and item.value ->> 'status' <> 'done'
          then item.value || jsonb_build_object(
            'status', 'done', 'tone', 'green',
            'result', case when paid then '试听已付费，收费提醒自动关闭'
              else '试听尚未进入 24 小时强提醒窗口' end,
            'closedAt', closed_at
          ) else item.value end order by item.ordinality
      ), '[]'::jsonb) into working
      from jsonb_array_elements(working) with ordinality item(value, ordinality);
      continue;
    end if;

    due_at := case when rule = 'trial.payment-n2' then n2_due_at else urgent_due_at end;
    generated := jsonb_build_object(
      'id', 'TSK-BOOKING-' || left(encode(extensions.digest(
        booking_id || chr(31) || rule, 'sha256'
      ), 'hex'), 24),
      'title', case when rule = 'trial.payment-n2' then '确认试听收费'
        else '试听不足 24 小时仍未付款' end,
      'owner', planner,
      'assignees', jsonb_build_array(planner),
      'watchers', jsonb_build_array('Ops Admin'),
      'studentId', student_id,
      'due', to_char(due_at at time zone 'Australia/Melbourne', 'YYYY-MM-DD HH24:MI'),
      'dueAt', internal.trial_payment_iso(due_at),
      'status', internal.trial_payment_task_status(due_at, p_now),
      'tone', case when rule = 'trial.payment-n2' then 'amber' else 'red' end,
      'category', '试听',
      'trigger', case when rule = 'trial.payment-n2' then '试听前 N-2 确认收费状态'
        else '试听距开课不足 24 小时且仍未付款' end,
      'ruleKey', rule,
      'anchorBookingId', booking_id,
      'requestAnchorBookingId', lp_item ->> 'id'
    );
    if paid then
      generated := generated || jsonb_build_object(
        'status', 'done', 'tone', 'green',
        'result', case when paid_by_task then '已由规划老师确认试听付款'
          else '试听已付费，收费提醒自动关闭' end,
        'closedAt', closed_at
      );
    end if;

    select item.value into existing
    from jsonb_array_elements(working) with ordinality item(value, ordinality)
    where item.value ->> 'anchorBookingId' = booking_id
      and item.value ->> 'ruleKey' = rule
    order by case when item.value ->> 'result' = '已由规划老师确认试听付款' then 0 else 1 end,
      item.ordinality
    limit 1;
    if paid
       and existing ->> 'status' = 'done'
       and existing ->> 'result' in (
         '已由规划老师确认试听付款', '试听已付费，收费提醒自动关闭'
       ) then
      generated := generated || jsonb_build_object(
        'status', 'done', 'tone', 'green',
        'result', existing ->> 'result',
        'closedAt', existing ->> 'closedAt'
      );
    end if;
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb) into working
    from jsonb_array_elements(working) with ordinality item(value, ordinality)
    where not (item.value ->> 'anchorBookingId' = booking_id and item.value ->> 'ruleKey' = rule);
    working := working || jsonb_build_array(generated);
  end loop;

  return working;
end;
$function$;

create or replace function internal.reconcile_trial_payment_tasks(
  p_tasks jsonb,
  p_lp_items jsonb,
  p_bookings jsonb,
  p_students jsonb,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  working jsonb := p_tasks;
  booking jsonb;
  payment_rules constant text[] := array['trial.payment-n2', 'trial.payment-urgent'];
  closed_at text := internal.trial_payment_iso(p_now);
begin
  if jsonb_typeof(p_tasks) is distinct from 'array'
     or jsonb_typeof(p_lp_items) is distinct from 'array'
     or jsonb_typeof(p_bookings) is distinct from 'array'
     or jsonb_typeof(p_students) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'invalid_trial_payment_projection_state';
  end if;

  select coalesce(jsonb_agg(
    case when item.value ->> 'ruleKey' = any(payment_rules)
              and item.value ->> 'status' <> 'done'
              and not exists (
                select 1 from jsonb_array_elements(p_bookings) candidate(value)
                where candidate.value ->> 'id' = item.value ->> 'anchorBookingId'
                  and candidate.value ->> 'kind' = '试听'
              )
      then item.value || jsonb_build_object(
        'status', 'done', 'tone', 'green',
        'result', '试听收费提醒不再适用', 'closedAt', closed_at
      ) else item.value end order by item.ordinality
  ), '[]'::jsonb) into working
  from jsonb_array_elements(working) with ordinality item(value, ordinality);

  for booking in select item.value from jsonb_array_elements(p_bookings) item(value) loop
    if booking ->> 'kind' = '试听' then
      working := internal.reconcile_trial_payment_tasks_for_booking(
        working, p_lp_items, booking, null, 'update', p_students, p_now
      );
    end if;
  end loop;
  select coalesce(jsonb_agg(item.value order by
    case when coalesce(item.value ->> 'dueAt', '') ~
      '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      then item.value ->> 'dueAt' else '9999-12-31T23:59:59.999Z' end,
    item.ordinality), '[]'::jsonb) into working
  from jsonb_array_elements(working) with ordinality item(value, ordinality);
  return working;
end;
$function$;

revoke all on function internal.trial_payment_iso(timestamptz) from public, anon, authenticated, service_role;
revoke all on function internal.trial_payment_task_status(timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function internal.trial_payment_lp_for_student(jsonb, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function internal.reconcile_trial_payment_tasks_for_booking(jsonb, jsonb, jsonb, jsonb, text, jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function internal.reconcile_trial_payment_tasks(jsonb, jsonb, jsonb, jsonb, timestamptz) from public, anon, authenticated, service_role;

-- Preserve the reviewed 191019 task rebuild as a private implementation, then
-- replace its original OID with a wrapper. Existing callers therefore keep the
-- same dependency while paid-trial rows are added before the surrounding
-- booking transaction commits its locked tasks row.
do $clone_booking_trial_rebuild$
declare
  target oid;
  definition text;
  cloned text;
begin
  if to_regprocedure('internal.rebuild_booking_trial_tasks_base_191019(jsonb,jsonb,jsonb,jsonb,text,timestamptz)') is null then
    target := to_regprocedure('internal.rebuild_booking_trial_tasks(jsonb,jsonb,jsonb,jsonb,text,timestamptz)');
    if target is null then
      raise exception using errcode = '42883', message = 'booking_trial_rebuild_function_not_found';
    end if;
    definition := pg_get_functiondef(target);
    cloned := replace(
      definition,
      'FUNCTION internal.rebuild_booking_trial_tasks(',
      'FUNCTION internal.rebuild_booking_trial_tasks_base_191019('
    );
    if cloned is not distinct from definition then
      raise exception using errcode = '55000', message = 'booking_trial_rebuild_clone_shape_changed';
    end if;
    execute cloned;
  end if;
end;
$clone_booking_trial_rebuild$;

revoke all on function internal.rebuild_booking_trial_tasks_base_191019(jsonb, jsonb, jsonb, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function internal.rebuild_booking_trial_tasks(
  p_tasks jsonb,
  p_lp_items jsonb,
  p_booking jsonb,
  p_previous_booking jsonb,
  p_action text,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  students_state public.ops_state%rowtype;
  working jsonb;
begin
  -- mutate_booking_projection_atomic already holds this row FOR UPDATE in the
  -- canonical bookings -> students -> lpItems -> tasks -> teachers sequence.
  select * into students_state from public.ops_state where entity = 'students';
  if students_state.entity is null or jsonb_typeof(students_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_payment_students_state_missing';
  end if;
  working := internal.rebuild_booking_trial_tasks_base_191019(
    p_tasks, p_lp_items, p_booking, p_previous_booking, p_action, p_now
  );
  return internal.reconcile_trial_payment_tasks_for_booking(
    working, p_lp_items, p_booking, p_previous_booking, p_action,
    students_state.payload, p_now
  );
end;
$function$;

revoke all on function internal.rebuild_booking_trial_tasks(jsonb, jsonb, jsonb, jsonb, text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.reconcile_trial_payment_tasks_authoritative(
  p_secret text,
  p_run_key text,
  p_expected_versions jsonb,
  p_actor text
)
returns table (
  run_key text,
  applied boolean,
  changed_count integer,
  bookings_row public.ops_state,
  students_row public.ops_state,
  lp_items_row public.ops_state,
  tasks_row public.ops_state,
  teachers_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  b public.ops_state%rowtype;
  s public.ops_state%rowtype;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  h public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  prior internal.trial_payment_reconcile_runs%rowtype;
  next_tasks jsonb;
  applied_at timestamptz;
  source_hash text;
  changes integer;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor is distinct from 'Trial Payment Scheduler'
     or coalesce(p_run_key, '') !~ '^trial-payment-reconcile:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'bookings' - 'students' - 'lpItems' - 'tasks' - 'teachers' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'bookings') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'students') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'lpItems') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'tasks') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'teachers') is distinct from 'number' then
    raise exception using errcode = '22023', message = 'invalid_trial_payment_reconcile_command';
  end if;

  -- Same global lock order as 191019 booking mutations.
  select * into b from public.ops_state where entity = 'bookings' for update;
  select * into s from public.ops_state where entity = 'students' for update;
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  select * into h from public.ops_state where entity = 'teachers' for update;
  if b.entity is null or s.entity is null or l.entity is null or t.entity is null or h.entity is null then
    raise exception using errcode = '55000', message = 'trial_payment_state_missing';
  end if;
  select * into prior from internal.trial_payment_reconcile_runs runs
  where runs.run_key = p_run_key;
  if prior.run_key is not null then
    if prior.expected_versions is distinct from p_expected_versions or prior.actor is distinct from p_actor then
      raise exception using errcode = '23505', message = 'trial_payment_reconcile_idempotency_conflict';
    end if;
    return query select p_run_key, false, prior.changed_count, b, s, l, t, h, prior.audit_id;
    return;
  end if;
  if b.version <> (p_expected_versions ->> 'bookings')::bigint
     or s.version <> (p_expected_versions ->> 'students')::bigint
     or l.version <> (p_expected_versions ->> 'lpItems')::bigint
     or t.version <> (p_expected_versions ->> 'tasks')::bigint
     or h.version <> (p_expected_versions ->> 'teachers')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if jsonb_typeof(b.payload) is distinct from 'array'
     or jsonb_typeof(s.payload) is distinct from 'array'
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array'
     or jsonb_typeof(h.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_payment_state_invalid';
  end if;
  applied_at := clock_timestamp();
  source_hash := encode(extensions.digest(jsonb_build_object(
    'bookings', b.payload, 'students', s.payload, 'lpItems', l.payload,
    'tasks', t.payload, 'teachers', h.payload
  )::text, 'sha256'), 'hex');
  next_tasks := internal.reconcile_trial_payment_tasks(
    t.payload, l.payload, b.payload, s.payload, applied_at
  );
  select count(*)::integer into changes
  from (
    select coalesce(before.value ->> 'id', after.value ->> 'id') as id
    from jsonb_array_elements(t.payload) before(value)
    full join jsonb_array_elements(next_tasks) after(value)
      on before.value ->> 'id' = after.value ->> 'id'
    where before.value is distinct from after.value
  ) changed;
  if next_tasks is distinct from t.payload then
    update public.ops_state set payload = next_tasks, version = t.version + 1,
      updated_at = now(), updated_by = p_actor
    where entity = 'tasks' returning * into saved_t;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved_t.version, saved_t.updated_by);
  else saved_t := t; end if;
  audit_id := internal.append_operational_contract_audit(
    'trial_payment_reconcile', p_actor, 'tasks', p_run_key,
    jsonb_build_object('sourceSha256', source_hash, 'changedCount', changes)
  );
  insert into internal.trial_payment_reconcile_runs(
    run_key, expected_versions, source_sha256, applied, changed_count,
    booking_version, student_version, lp_item_version, task_version,
    teacher_version, actor, applied_at, audit_id
  ) values (
    p_run_key, p_expected_versions, source_hash, next_tasks is distinct from t.payload, changes,
    b.version, s.version, l.version, saved_t.version, h.version, p_actor, applied_at, audit_id
  );
  return query select p_run_key, next_tasks is distinct from t.payload, changes,
    b, s, l, saved_t, h, audit_id;
end;
$function$;

revoke all on function public.reconcile_trial_payment_tasks_authoritative(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reconcile_trial_payment_tasks_authoritative(text, text, jsonb, text)
  to anon, authenticated;

create or replace function public.complete_trial_payment_task_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_task_id text,
  p_expected_versions jsonb,
  p_actor text,
  p_actor_role text
)
returns table (
  command_key text,
  applied boolean,
  task_id text,
  booking_id text,
  student_id text,
  bookings_row public.ops_state,
  students_row public.ops_state,
  lp_items_row public.ops_state,
  tasks_row public.ops_state,
  teachers_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  b public.ops_state%rowtype;
  s public.ops_state%rowtype;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  h public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  prior internal.trial_payment_completion_commands%rowtype;
  task_item jsonb;
  booking_item jsonb;
  student_item jsonb;
  lp_item jsonb;
  next_tasks jsonb;
  booking_id_value text;
  student_id_value text;
  method text;
  completed_at timestamptz;
  command_hash text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^trial-payment-complete:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent is distinct from jsonb_build_object('action', 'complete', 'taskId', p_task_id)
     or nullif(trim(p_task_id), '') is null
     or nullif(trim(p_actor), '') is null
     or p_actor_role not in ('admin', 'limited-admin', 'staff', 'teacher')
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'bookings' - 'students' - 'lpItems' - 'tasks' - 'teachers' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'bookings') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'students') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'lpItems') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'tasks') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'teachers') is distinct from 'number' then
    raise exception using errcode = '22023', message = 'invalid_trial_payment_completion_command';
  end if;
  command_hash := encode(extensions.digest(jsonb_build_object(
    'intent', p_command_intent, 'actor', trim(p_actor)
  )::text, 'sha256'), 'hex');

  -- Receipt lookup intentionally precedes current task/scope reads. A command
  -- that committed before a lost response remains confirmable by the exact
  -- actor+intent even if planner, task or LP authority changed afterwards.
  select * into prior from internal.trial_payment_completion_commands commands
  where commands.command_key = p_command_key;
  if prior.command_key is not null and (
       prior.command_sha256 is distinct from command_hash
       or prior.command_intent is distinct from p_command_intent
       or prior.task_id is distinct from p_task_id
       or prior.actor is distinct from trim(p_actor)
     ) then
    raise exception using errcode = '23505', message = 'trial_payment_completion_idempotency_conflict';
  end if;

  -- Same global lock order as booking mutation and scheduler reconciliation.
  select * into b from public.ops_state where entity = 'bookings' for update;
  select * into s from public.ops_state where entity = 'students' for update;
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  select * into h from public.ops_state where entity = 'teachers' for update;
  if b.entity is null or s.entity is null or l.entity is null or t.entity is null or h.entity is null then
    raise exception using errcode = '55000', message = 'trial_payment_state_missing';
  end if;
  if prior.command_key is not null then
    return query select p_command_key, false, p_task_id, prior.booking_id,
      prior.student_id, b, s, l, t, h, prior.audit_id;
    return;
  end if;

  -- A concurrent first submit can commit while this transaction waits on the
  -- fixed row locks. Recheck the ledger before any current authority/OCC test.
  select * into prior from internal.trial_payment_completion_commands commands
  where commands.command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_sha256 is distinct from command_hash
       or prior.command_intent is distinct from p_command_intent
       or prior.task_id is distinct from p_task_id
       or prior.actor is distinct from trim(p_actor) then
      raise exception using errcode = '23505', message = 'trial_payment_completion_idempotency_conflict';
    end if;
    return query select p_command_key, false, p_task_id, prior.booking_id,
      prior.student_id, b, s, l, t, h, prior.audit_id;
    return;
  end if;
  if jsonb_typeof(b.payload) is distinct from 'array'
     or jsonb_typeof(s.payload) is distinct from 'array'
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array'
     or jsonb_typeof(h.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_payment_state_invalid';
  end if;
  -- Current signed role gates only a first write. An exact actor+intent replay
  -- has already returned above, so later role drift cannot strand its receipt.
  if p_actor_role <> 'staff' then
    raise exception using errcode = '42501', message = 'trial_payment_role_forbidden';
  end if;
  if (select count(*) from jsonb_array_elements(t.payload) item(value)
      where item.value ->> 'id' = p_task_id) <> 1 then
    raise exception using errcode = 'P0002', message = 'trial_payment_task_not_found';
  end if;
  select item.value into task_item from jsonb_array_elements(t.payload) item(value)
  where item.value ->> 'id' = p_task_id;
  booking_id_value := task_item ->> 'anchorBookingId';
  student_id_value := task_item ->> 'studentId';
  if task_item ->> 'ruleKey' not in ('trial.payment-n2', 'trial.payment-urgent')
     or task_item ->> 'category' <> '试听'
     or task_item ->> 'owner' is distinct from trim(p_actor)
     or task_item -> 'assignees' is distinct from jsonb_build_array(trim(p_actor))
     or task_item -> 'watchers' is distinct from jsonb_build_array('Ops Admin') then
    raise exception using errcode = '42501', message = 'trial_payment_task_forbidden';
  end if;
  if (select count(*) from jsonb_array_elements(b.payload) item(value)
      where item.value ->> 'id' = booking_id_value
        and item.value ->> 'studentId' = student_id_value
        and item.value ->> 'kind' = '试听') <> 1 then
    raise exception using errcode = '42501', message = 'trial_payment_booking_forbidden';
  end if;
  select item.value into booking_item from jsonb_array_elements(b.payload) item(value)
  where item.value ->> 'id' = booking_id_value;
  if (select count(*) from jsonb_array_elements(s.payload) item(value)
      where item.value ->> 'id' = student_id_value and item.value ->> 'importArchived' is distinct from 'true') <> 1 then
    raise exception using errcode = '42501', message = 'trial_payment_student_forbidden';
  end if;
  select item.value into student_item from jsonb_array_elements(s.payload) item(value)
  where item.value ->> 'id' = student_id_value;
  if nullif(trim(student_item ->> 'planner'), '') is distinct from trim(p_actor) then
    raise exception using errcode = '42501', message = 'trial_payment_planner_forbidden';
  end if;
  lp_item := internal.trial_payment_lp_for_student(
    l.payload, t.payload, student_id_value, booking_id_value
  );
  method := nullif(trim(lp_item -> 'fields' ->> 'trialPaymentMethod'), '');
  if (method in ('后置付费试听', '付费试听（已付费）', '付费试听（未付费）', '在读学生付费试听')) is not true then
    raise exception using errcode = '42501', message = 'trial_payment_method_forbidden';
  end if;

  if b.version <> (p_expected_versions ->> 'bookings')::bigint
     or s.version <> (p_expected_versions ->> 'students')::bigint
     or l.version <> (p_expected_versions ->> 'lpItems')::bigint
     or t.version <> (p_expected_versions ->> 'tasks')::bigint
     or h.version <> (p_expected_versions ->> 'teachers')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if task_item ->> 'status' = 'done' then
    raise exception using errcode = '22023', message = 'trial_payment_task_already_completed';
  end if;
  completed_at := clock_timestamp();
  select coalesce(jsonb_agg(
    case when item.value ->> 'anchorBookingId' = booking_id_value
                  and item.value ->> 'studentId' = student_id_value
                  and item.value ->> 'ruleKey' in ('trial.payment-n2', 'trial.payment-urgent')
                  and item.value ->> 'owner' = trim(p_actor)
                  and item.value -> 'assignees' = jsonb_build_array(trim(p_actor))
                  and item.value -> 'watchers' = jsonb_build_array('Ops Admin')
      then item.value || jsonb_build_object(
        'status', 'done', 'tone', 'green',
        'result', '已由规划老师确认试听付款',
        'closedAt', internal.trial_payment_iso(completed_at)
      ) else item.value end order by item.ordinality
  ), '[]'::jsonb) into next_tasks
  from jsonb_array_elements(t.payload) with ordinality item(value, ordinality);
  update public.ops_state set payload = next_tasks, version = t.version + 1,
    updated_at = now(), updated_by = left(trim(p_actor), 120)
  where entity = 'tasks' returning * into saved_t;
  insert into public.ops_mutation_log(entity, version, actor)
  values ('tasks', saved_t.version, saved_t.updated_by);
  audit_id := internal.append_operational_contract_audit(
    'trial_payment_complete', trim(p_actor), 'task', p_task_id,
    jsonb_build_object('bookingId', booking_id_value, 'studentId', student_id_value)
  );
  insert into internal.trial_payment_completion_commands(
    command_key, command_intent, command_sha256, task_id, booking_id,
    student_id, task_version, actor, applied_at, audit_id
  ) values (
    p_command_key, p_command_intent, command_hash, p_task_id, booking_id_value,
    student_id_value, saved_t.version, left(trim(p_actor), 120), completed_at, audit_id
  );
  return query select p_command_key, true, p_task_id, booking_id_value,
    student_id_value, b, s, l, saved_t, h, audit_id;
end;
$function$;

revoke all on function public.complete_trial_payment_task_atomic(text, text, jsonb, text, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_trial_payment_task_atomic(text, text, jsonb, text, jsonb, text, text)
  to anon, authenticated;
