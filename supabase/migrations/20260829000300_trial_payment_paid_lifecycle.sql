-- Keep the payment task and LP paid flag in one idempotent transaction. The
-- forward wrapper also teaches booking reconciliation that an explicit
-- trialPaid=true value is authoritative, including administrator confirmation.

set local lock_timeout = '1s';

create table if not exists internal.trial_payment_lifecycle_commands (
  command_key text primary key check (
    command_key ~ '^trial-payment-(complete|reopen):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_sha256 text not null check (command_sha256 ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('complete', 'reopen')),
  task_id text not null,
  anchor_id text not null,
  student_id text not null,
  lp_item_id text not null,
  task_version bigint not null check (task_version > 0),
  lp_items_version bigint not null check (lp_items_version > 0),
  actor text not null,
  applied_at timestamptz not null default now(),
  audit_id uuid not null unique references internal.operational_contract_audit(id) on delete restrict,
  check (command_key like 'trial-payment-' || action || ':%')
);

alter table internal.trial_payment_lifecycle_commands enable row level security;
revoke all on table internal.trial_payment_lifecycle_commands
  from public, anon, authenticated, service_role;

create or replace function public.get_trial_payment_lifecycle_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_action text,
  p_task_id text,
  p_actor text
)
returns table (
  command_key text,
  action text,
  task_id text,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  prior internal.trial_payment_lifecycle_commands%rowtype;
  command_hash text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_action, '') not in ('complete', 'reopen')
     or coalesce(p_command_key, '') !~ ('^trial-payment-' || p_action || ':[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent is distinct from jsonb_build_object('action', p_action, 'taskId', p_task_id)
     or coalesce(p_task_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     or nullif(btrim(p_actor), '') is null
     or char_length(btrim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_trial_payment_lifecycle_receipt_query';
  end if;
  command_hash := encode(extensions.digest(jsonb_build_object(
    'intent', p_command_intent,
    'actor', btrim(p_actor)
  )::text, 'sha256'), 'hex');
  select * into prior
  from internal.trial_payment_lifecycle_commands commands
  where commands.command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_sha256 is distinct from command_hash
     or prior.command_intent is distinct from p_command_intent
     or prior.action is distinct from p_action
     or prior.task_id is distinct from p_task_id
     or prior.actor is distinct from btrim(p_actor) then
    raise exception using errcode = '23505', message = 'trial_payment_lifecycle_idempotency_conflict';
  end if;
  return query select prior.command_key, prior.action, prior.task_id, prior.audit_id;
end;
$function$;

revoke all on function public.get_trial_payment_lifecycle_command_result(
  text, text, jsonb, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.get_trial_payment_lifecycle_command_result(
  text, text, jsonb, text, text, text
) to anon, authenticated;

create or replace function public.mutate_trial_payment_task_lifecycle_tx(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_action text,
  p_task_id text,
  p_expected_versions jsonb,
  p_actor text,
  p_actor_role text
)
returns table (
  command_key text,
  applied boolean,
  action text,
  task_id text,
  anchor_id text,
  student_id text,
  lp_item_id text,
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
  saved_l public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  prior internal.trial_payment_lifecycle_commands%rowtype;
  task_item jsonb;
  student_item jsonb;
  lp_item jsonb;
  pointer internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
  next_lp_items jsonb;
  next_tasks jsonb;
  kind_value text;
  anchor_id_value text;
  event_id_value text;
  student_id_value text;
  lp_item_id_value text;
  planner_value text;
  method_value text;
  changed_at timestamptz;
  command_hash text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_action, '') not in ('complete', 'reopen')
     or coalesce(p_command_key, '') !~ ('^trial-payment-' || p_action || ':[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent is distinct from jsonb_build_object('action', p_action, 'taskId', p_task_id)
     or coalesce(p_task_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     or nullif(btrim(p_actor), '') is null
     or char_length(btrim(p_actor)) > 120
     or coalesce(p_actor_role, '') not in ('admin', 'limited-admin', 'staff', 'teacher')
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'bookings' - 'students' - 'lpItems' - 'tasks' - 'teachers' <> '{}'::jsonb
     or coalesce(p_expected_versions ->> 'bookings', '') !~ '^[1-9][0-9]*$'
     or coalesce(p_expected_versions ->> 'students', '') !~ '^[1-9][0-9]*$'
     or coalesce(p_expected_versions ->> 'lpItems', '') !~ '^[1-9][0-9]*$'
     or coalesce(p_expected_versions ->> 'tasks', '') !~ '^[1-9][0-9]*$'
     or coalesce(p_expected_versions ->> 'teachers', '') !~ '^[1-9][0-9]*$' then
    raise exception using errcode = '22023', message = 'invalid_trial_payment_lifecycle_command';
  end if;
  command_hash := encode(extensions.digest(jsonb_build_object(
    'intent', p_command_intent,
    'actor', btrim(p_actor)
  )::text, 'sha256'), 'hex');

  select * into prior
  from internal.trial_payment_lifecycle_commands commands
  where commands.command_key = p_command_key;
  if prior.command_key is not null and (
       prior.command_sha256 is distinct from command_hash
       or prior.command_intent is distinct from p_command_intent
       or prior.action is distinct from p_action
       or prior.task_id is distinct from p_task_id
       or prior.actor is distinct from btrim(p_actor)
     ) then
    raise exception using errcode = '23505', message = 'trial_payment_lifecycle_idempotency_conflict';
  end if;

  -- Match the shared global lock order used by booking and trial schedulers.
  select * into b from public.ops_state where entity = 'bookings' for update;
  select * into s from public.ops_state where entity = 'students' for update;
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  select * into h from public.ops_state where entity = 'teachers' for update;
  if b.entity is null or s.entity is null or l.entity is null or t.entity is null or h.entity is null then
    raise exception using errcode = '55000', message = 'trial_payment_state_missing';
  end if;
  if prior.command_key is not null then
    return query select prior.command_key, false, prior.action, prior.task_id,
      prior.anchor_id, prior.student_id, prior.lp_item_id, b, s, l, t, h, prior.audit_id;
    return;
  end if;

  select * into prior
  from internal.trial_payment_lifecycle_commands commands
  where commands.command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_sha256 is distinct from command_hash
       or prior.command_intent is distinct from p_command_intent
       or prior.action is distinct from p_action
       or prior.task_id is distinct from p_task_id
       or prior.actor is distinct from btrim(p_actor) then
      raise exception using errcode = '23505', message = 'trial_payment_lifecycle_idempotency_conflict';
    end if;
    return query select prior.command_key, false, prior.action, prior.task_id,
      prior.anchor_id, prior.student_id, prior.lp_item_id, b, s, l, t, h, prior.audit_id;
    return;
  end if;
  if jsonb_typeof(b.payload) is distinct from 'array'
     or jsonb_typeof(s.payload) is distinct from 'array'
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array'
     or jsonb_typeof(h.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_payment_state_invalid';
  end if;
  if coalesce(p_actor_role, '') not in ('staff', 'admin') then
    raise exception using errcode = '42501', message = 'trial_payment_role_forbidden';
  end if;
  if (select count(*) from jsonb_array_elements(t.payload) item(value)
      where item.value ->> 'id' = p_task_id) <> 1 then
    raise exception using errcode = 'P0002', message = 'trial_payment_task_not_found';
  end if;
  select item.value into task_item
  from jsonb_array_elements(t.payload) item(value)
  where item.value ->> 'id' = p_task_id;

  anchor_id_value := task_item ->> 'anchorBookingId';
  student_id_value := task_item ->> 'studentId';
  if task_item ->> 'category' <> '试听'
     or task_item -> 'watchers' is distinct from jsonb_build_array('Ops Admin') then
    raise exception using errcode = '42501', message = 'trial_payment_task_forbidden';
  end if;
  if task_item ->> 'ruleKey' in ('trial.payment-n2', 'trial.payment-urgent') then
    kind_value := 'booking';
  elsif task_item ->> 'ruleKey' = 'trial.jiaowubao.payment-n2'
        and coalesce(anchor_id_value, '') ~ '^JWB:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
        and coalesce(task_item ->> 'requestAnchorBookingId', '') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' then
    kind_value := 'jiaowubao';
  else
    raise exception using errcode = '42501', message = 'trial_payment_task_forbidden';
  end if;
  if (select count(*) from jsonb_array_elements(s.payload) item(value)
      where item.value ->> 'id' = student_id_value
        and item.value ->> 'importArchived' is distinct from 'true') <> 1 then
    raise exception using errcode = '42501', message = 'trial_payment_student_forbidden';
  end if;
  select item.value into student_item
  from jsonb_array_elements(s.payload) item(value)
  where item.value ->> 'id' = student_id_value;

  if kind_value = 'booking' then
    if (select count(*) from jsonb_array_elements(b.payload) item(value)
        where item.value ->> 'id' = anchor_id_value
          and item.value ->> 'studentId' = student_id_value
          and item.value ->> 'kind' = '试听') <> 1 then
      raise exception using errcode = '42501', message = 'trial_payment_booking_forbidden';
    end if;
    lp_item := internal.trial_payment_lp_for_student(
      l.payload, t.payload, student_id_value, anchor_id_value
    );
    lp_item_id_value := lp_item ->> 'id';
    planner_value := nullif(btrim(student_item ->> 'planner'), '');
    method_value := nullif(btrim(lp_item #>> '{fields,trialPaymentMethod}'), '');
    if jsonb_typeof(lp_item) is distinct from 'object'
       or coalesce(lp_item_id_value, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
       or lp_item ->> 'studentId' is distinct from student_id_value
       or (lp_item ->> 'workflowType' in ('试听 LP', '换老师试听')) is not true
       or lp_item ->> 'stage' = '完成'
       or nullif(planner_value, '') is null
       or task_item ->> 'owner' is distinct from planner_value
       or task_item -> 'assignees' is distinct from jsonb_build_array(planner_value)
       or (p_actor_role <> 'admin' and planner_value is distinct from btrim(p_actor))
       or (method_value in ('后置付费试听', '付费试听（已付费）', '付费试听（未付费）', '在读学生付费试听')) is not true
       or (p_action = 'reopen' and method_value = '付费试听（已付费）') then
      raise exception using errcode = '42501', message = 'trial_payment_booking_authority_forbidden';
    end if;
  else
    event_id_value := substring(anchor_id_value from 5);
    lp_item_id_value := task_item ->> 'requestAnchorBookingId';
    if (select count(*) from jsonb_array_elements(l.payload) item(value)
        where item.value ->> 'id' = lp_item_id_value
          and item.value ->> 'studentId' = student_id_value
          and item.value ->> 'workflowType' = '试听 LP'
          and item.value ->> 'stage' is distinct from '完成') <> 1 then
      raise exception using errcode = '42501', message = 'trial_payment_lp_forbidden';
    end if;
    select item.value into lp_item
    from jsonb_array_elements(l.payload) item(value)
    where item.value ->> 'id' = lp_item_id_value
      and item.value ->> 'studentId' = student_id_value
      and item.value ->> 'workflowType' = '试听 LP'
      and item.value ->> 'stage' is distinct from '完成';
    planner_value := case lower(coalesce(
      nullif(btrim(lp_item #>> '{trialIntake,planner}'), ''),
      nullif(btrim(lp_item #>> '{fields,planner}'), ''),
      nullif(btrim(student_item ->> 'planner'), '')
    ))
      when 'tara' then 'Tara'
      when 'eileen' then 'Eileen'
      when 'abby' then 'Abby'
      else null
    end;
    method_value := nullif(btrim(lp_item #>> '{fields,trialPaymentMethod}'), '');
    if lp_item #>> '{trialSchedule,source}' is distinct from 'jiaowubao-open-api'
       or coalesce(lp_item #>> '{trialSchedule,sourceRevision}', '') !~ '^sha256:[a-f0-9]{64}$'
       or lp_item #>> '{trialSchedule,eventId}' is distinct from event_id_value
       or nullif(planner_value, '') is null
       or task_item ->> 'owner' is distinct from planner_value
       or task_item -> 'assignees' is distinct from jsonb_build_array(planner_value)
       or (p_actor_role <> 'admin' and planner_value is distinct from btrim(p_actor))
       or (method_value in ('后置付费试听', '付费试听（未付费）', '在读学生付费试听')) is not true then
      raise exception using errcode = '42501', message = 'trial_payment_jiaowubao_authority_forbidden';
    end if;
    select * into pointer
    from internal.jiaowubao_open_api_schedule_snapshot_current current_pointer
    where current_pointer.api_source_key = 'jwb-open-api-schedule'
    for share;
    if pointer.api_source_key is null
       or pointer.revision is distinct from lp_item #>> '{trialSchedule,sourceRevision}'
       or (select count(*)
           from internal.jiaowubao_open_api_schedule_snapshot_ingest_items source_item
           where source_item.run_id = pointer.run_id
             and source_item.source_key = event_id_value) <> 1 then
      raise exception using errcode = '55000', message = 'trial_payment_jiaowubao_source_changed';
    end if;
  end if;

  if b.version <> (p_expected_versions ->> 'bookings')::bigint
     or s.version <> (p_expected_versions ->> 'students')::bigint
     or l.version <> (p_expected_versions ->> 'lpItems')::bigint
     or t.version <> (p_expected_versions ->> 'tasks')::bigint
     or h.version <> (p_expected_versions ->> 'teachers')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if p_action = 'complete'
     and (task_item ->> 'status' in ('overdue', 'today', 'upcoming', 'waiting')) is not true then
    raise exception using errcode = '22023', message = 'trial_payment_task_not_open';
  end if;
  if p_action = 'reopen' and (
       task_item ->> 'status' is distinct from 'done'
       or task_item ->> 'tone' is distinct from 'green'
       or (task_item ->> 'result' in ('已由规划老师确认试听付款', '已由管理员确认试听付款')) is not true
       or coalesce(task_item ->> 'closedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     ) then
    raise exception using errcode = '22023', message = 'trial_payment_task_not_reopenable';
  end if;

  if p_action = 'reopen' then
    if exists (
      select 1
      from jsonb_array_elements(t.payload) item(value)
      where item.value ->> 'studentId' = student_id_value
        and (
          kind_value = 'booking'
            and item.value ->> 'anchorBookingId' = anchor_id_value
            and item.value ->> 'ruleKey' in ('trial.payment-n2', 'trial.payment-urgent')
            and item.value ->> 'result' in ('已由规划老师确认试听付款', '已由管理员确认试听付款')
          or kind_value = 'jiaowubao' and item.value ->> 'id' = p_task_id
        )
        and coalesce(item.value ->> 'dueAt', '') !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    ) then
      raise exception using errcode = '22023', message = 'trial_payment_task_deadline_invalid';
    end if;
    begin
      perform (item.value ->> 'dueAt')::timestamptz
      from jsonb_array_elements(t.payload) item(value)
      where item.value ->> 'studentId' = student_id_value
        and (
          kind_value = 'booking'
            and item.value ->> 'anchorBookingId' = anchor_id_value
            and item.value ->> 'ruleKey' in ('trial.payment-n2', 'trial.payment-urgent')
            and item.value ->> 'result' in ('已由规划老师确认试听付款', '已由管理员确认试听付款')
          or kind_value = 'jiaowubao' and item.value ->> 'id' = p_task_id
        );
    exception when others then
      raise exception using errcode = '22023', message = 'trial_payment_task_deadline_invalid';
    end;
  end if;

  changed_at := clock_timestamp();
  select coalesce(jsonb_agg(
    case
      when p_action = 'complete'
           and item.value ->> 'studentId' = student_id_value
           and (
             kind_value = 'booking'
               and item.value ->> 'anchorBookingId' = anchor_id_value
               and item.value ->> 'ruleKey' in ('trial.payment-n2', 'trial.payment-urgent')
               and (
                 item.value ->> 'id' = p_task_id
                 or item.value ->> 'status' in ('overdue', 'today', 'upcoming', 'waiting')
               )
             or kind_value = 'jiaowubao' and item.value ->> 'id' = p_task_id
           )
        then (item.value - 'completionOutcome') || jsonb_build_object(
          'status', 'done',
          'tone', 'green',
          'result', case when p_actor_role = 'admin'
            then '已由管理员确认试听付款'
            else '已由规划老师确认试听付款' end,
          'closedAt', internal.trial_payment_iso(changed_at)
        )
      when p_action = 'reopen'
           and item.value ->> 'studentId' = student_id_value
           and item.value ->> 'result' in ('已由规划老师确认试听付款', '已由管理员确认试听付款')
           and (
             kind_value = 'booking'
               and item.value ->> 'anchorBookingId' = anchor_id_value
               and item.value ->> 'ruleKey' in ('trial.payment-n2', 'trial.payment-urgent')
             or kind_value = 'jiaowubao' and item.value ->> 'id' = p_task_id
           )
        then (item.value - 'closedAt' - 'result' - 'completionOutcome') || jsonb_build_object(
          'status', internal.trial_payment_task_status((item.value ->> 'dueAt')::timestamptz, changed_at),
          'tone', case item.value ->> 'ruleKey'
            when 'trial.payment-urgent' then 'red'
            when 'trial.payment-n2' then 'amber'
            else 'blue' end
        )
      else item.value
    end order by item.ordinality
  ), '[]'::jsonb) into next_tasks
  from jsonb_array_elements(t.payload) with ordinality item(value, ordinality);

  select coalesce(jsonb_agg(
    case when item.value ->> 'id' = lp_item_id_value
      then item.value || jsonb_build_object('trialPaid', p_action = 'complete')
      else item.value end order by item.ordinality
  ), '[]'::jsonb) into next_lp_items
  from jsonb_array_elements(l.payload) with ordinality item(value, ordinality);

  if next_tasks is not distinct from t.payload then
    raise exception using errcode = '55000', message = 'trial_payment_lifecycle_projection_invalid';
  end if;
  if next_lp_items is distinct from l.payload then
    update public.ops_state set
      payload = next_lp_items,
      version = l.version + 1,
      updated_at = now(),
      updated_by = left(btrim(p_actor), 120)
    where entity = 'lpItems'
    returning * into saved_l;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('lpItems', saved_l.version, saved_l.updated_by);
  else
    saved_l := l;
  end if;

  update public.ops_state set
    payload = next_tasks,
    version = t.version + 1,
    updated_at = now(),
    updated_by = left(btrim(p_actor), 120)
  where entity = 'tasks'
  returning * into saved_t;
  insert into public.ops_mutation_log(entity, version, actor)
  values ('tasks', saved_t.version, saved_t.updated_by);

  audit_id := internal.append_operational_contract_audit(
    case when p_action = 'complete' then 'trial_payment_complete' else 'trial_payment_reopen' end,
    btrim(p_actor),
    'task',
    p_task_id,
    jsonb_build_object(
      'kind', kind_value,
      'anchorId', anchor_id_value,
      'studentId', student_id_value,
      'lpItemId', lp_item_id_value,
      'trialPaid', p_action = 'complete'
    )
  );
  insert into internal.trial_payment_lifecycle_commands(
    command_key, command_intent, command_sha256, action, task_id,
    anchor_id, student_id, lp_item_id, task_version, lp_items_version,
    actor, applied_at, audit_id
  ) values (
    p_command_key, p_command_intent, command_hash, p_action, p_task_id,
    anchor_id_value, student_id_value, lp_item_id_value, saved_t.version, saved_l.version,
    left(btrim(p_actor), 120), changed_at, audit_id
  );
  return query select p_command_key, true, p_action, p_task_id,
    anchor_id_value, student_id_value, lp_item_id_value,
    b, s, saved_l, saved_t, h, audit_id;
end;
$function$;

revoke all on function public.mutate_trial_payment_task_lifecycle_tx(
  text, text, jsonb, text, text, jsonb, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mutate_trial_payment_task_lifecycle_tx(
  text, text, jsonb, text, text, jsonb, text, text
) to anon, authenticated;

-- Clone the currently active note/Can't Do-preserving projection, then layer
-- the explicit LP paid flag on top without editing an applied migration.
do $clone_trial_payment_projection$
declare
  target oid;
  definition text;
  cloned text;
begin
  if to_regprocedure('internal.reconcile_trial_payment_tasks_for_booking_base_20260829000300(jsonb,jsonb,jsonb,jsonb,text,jsonb,timestamptz)') is null then
    target := to_regprocedure('internal.reconcile_trial_payment_tasks_for_booking(jsonb,jsonb,jsonb,jsonb,text,jsonb,timestamptz)');
    if target is null then
      raise exception using errcode = '42883', message = 'trial_payment_booking_projection_not_found';
    end if;
    definition := pg_get_functiondef(target);
    cloned := replace(
      definition,
      'FUNCTION internal.reconcile_trial_payment_tasks_for_booking(',
      'FUNCTION internal.reconcile_trial_payment_tasks_for_booking_base_20260829000300('
    );
    if cloned is not distinct from definition then
      raise exception using errcode = '55000', message = 'trial_payment_booking_projection_clone_shape_changed';
    end if;
    execute cloned;
  end if;
end;
$clone_trial_payment_projection$;

revoke all on function internal.reconcile_trial_payment_tasks_for_booking_base_20260829000300(
  jsonb, jsonb, jsonb, jsonb, text, jsonb, timestamptz
) from public, anon, authenticated, service_role;

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
  projected jsonb;
  lp_item jsonb;
  booking_id_value text;
  student_id_value text;
  closed_at text;
begin
  projected := internal.reconcile_trial_payment_tasks_for_booking_base_20260829000300(
    p_tasks,
    p_lp_items,
    p_booking,
    p_previous_booking,
    p_action,
    p_students,
    p_now
  );
  booking_id_value := p_booking ->> 'id';
  student_id_value := p_booking ->> 'studentId';
  lp_item := internal.trial_payment_lp_for_student(
    p_lp_items, projected, student_id_value, booking_id_value
  );
  if p_action <> 'delete'
     and jsonb_typeof(lp_item -> 'trialPaid') = 'boolean'
     and (lp_item ->> 'trialPaid')::boolean then
    closed_at := internal.trial_payment_iso(p_now);
    select coalesce(jsonb_agg(
      case when item.value ->> 'anchorBookingId' = booking_id_value
                  and item.value ->> 'studentId' = student_id_value
                  and item.value ->> 'ruleKey' in ('trial.payment-n2', 'trial.payment-urgent')
                  and item.value ->> 'completionOutcome' is distinct from 'cannot_do'
        then (item.value - 'completionOutcome') || jsonb_build_object(
          'status', 'done',
          'tone', 'green',
          'result', case when item.value ->> 'result' in (
            '已由规划老师确认试听付款', '已由管理员确认试听付款'
          ) then item.value ->> 'result' else '试听台账已标记付费，收费提醒自动关闭' end,
          'closedAt', case when coalesce(item.value ->> 'closedAt', '') ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
            then item.value ->> 'closedAt' else closed_at end
        ) else item.value end order by item.ordinality
    ), '[]'::jsonb) into projected
    from jsonb_array_elements(projected) with ordinality item(value, ordinality);
  end if;
  return projected;
end;
$function$;

revoke all on function internal.reconcile_trial_payment_tasks_for_booking(
  jsonb, jsonb, jsonb, jsonb, text, jsonb, timestamptz
) from public, anon, authenticated, service_role;
