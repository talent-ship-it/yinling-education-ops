-- Complete a Jiaowubao-linked N-2 payment reminder without accepting a task
-- replacement from the browser. The existing booking payment RPC remains
-- unchanged; both commands share the actor-bound idempotency ledger.

set local lock_timeout = '1s';

alter table internal.trial_payment_completion_commands
  drop constraint if exists trial_payment_completion_commands_booking_id_check;
alter table internal.trial_payment_completion_commands
  add constraint trial_payment_completion_commands_booking_id_check
  check (length(booking_id) between 1 and 204);

create or replace function public.complete_jiaowubao_trial_payment_task_tx(
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
  pointer internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
  task_item jsonb;
  student_item jsonb;
  lp_item jsonb;
  next_tasks jsonb;
  anchor_value text;
  event_id_value text;
  lp_item_id_value text;
  student_id_value text;
  planner_value text;
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
     or nullif(btrim(p_task_id), '') is null
     or nullif(btrim(p_actor), '') is null
     or p_actor_role not in ('admin', 'limited-admin', 'staff', 'teacher')
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'bookings' - 'students' - 'lpItems' - 'tasks' - 'teachers' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'bookings') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'students') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'lpItems') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'tasks') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'teachers') is distinct from 'number' then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_trial_payment_completion_command';
  end if;
  command_hash := encode(extensions.digest(jsonb_build_object(
    'intent', p_command_intent, 'actor', btrim(p_actor)
  )::text, 'sha256'), 'hex');

  -- Recover a lost response before consulting mutable planner or LP authority.
  select * into prior
  from internal.trial_payment_completion_commands commands
  where commands.command_key = p_command_key;
  if prior.command_key is not null and (
       prior.command_sha256 is distinct from command_hash
       or prior.command_intent is distinct from p_command_intent
       or prior.task_id is distinct from p_task_id
       or prior.actor is distinct from btrim(p_actor)
     ) then
    raise exception using errcode = '23505', message = 'trial_payment_completion_idempotency_conflict';
  end if;

  -- Keep the global operational lock order shared by booking and payment RPCs.
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

  -- A concurrent first submit may commit while this transaction waits.
  select * into prior
  from internal.trial_payment_completion_commands commands
  where commands.command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_sha256 is distinct from command_hash
       or prior.command_intent is distinct from p_command_intent
       or prior.task_id is distinct from p_task_id
       or prior.actor is distinct from btrim(p_actor) then
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
  if p_actor_role not in ('staff', 'admin') then
    raise exception using errcode = '42501', message = 'trial_payment_role_forbidden';
  end if;
  if (select count(*) from jsonb_array_elements(t.payload) item(value)
      where item.value ->> 'id' = p_task_id) <> 1 then
    raise exception using errcode = 'P0002', message = 'trial_payment_task_not_found';
  end if;
  select item.value into task_item
  from jsonb_array_elements(t.payload) item(value)
  where item.value ->> 'id' = p_task_id;

  anchor_value := task_item ->> 'anchorBookingId';
  event_id_value := substring(anchor_value from 5);
  lp_item_id_value := task_item ->> 'requestAnchorBookingId';
  student_id_value := task_item ->> 'studentId';
  if task_item ->> 'ruleKey' <> 'trial.jiaowubao.payment-n2'
     or task_item ->> 'category' <> '试听'
     or coalesce(anchor_value, '') !~ '^JWB:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
     or coalesce(lp_item_id_value, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     or task_item -> 'watchers' is distinct from jsonb_build_array('Ops Admin') then
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
  method := nullif(btrim(lp_item #>> '{fields,trialPaymentMethod}'), '');
  if lp_item #>> '{trialSchedule,source}' is distinct from 'jiaowubao-open-api'
     or coalesce(lp_item #>> '{trialSchedule,sourceRevision}', '') !~ '^sha256:[a-f0-9]{64}$'
     or lp_item #>> '{trialSchedule,eventId}' is distinct from event_id_value
     or nullif(planner_value, '') is null
     or task_item ->> 'owner' is distinct from planner_value
     or task_item -> 'assignees' is distinct from jsonb_build_array(planner_value)
     or (p_actor_role <> 'admin' and planner_value is distinct from btrim(p_actor))
     or (method in ('后置付费试听', '付费试听（未付费）', '在读学生付费试听')) is not true then
    raise exception using errcode = '42501', message = 'trial_payment_jiaowubao_authority_forbidden';
  end if;

  -- The LP may only complete against the same immutable publication that
  -- produced it. A newer pointer requires a fresh JWB-to-LP sync first.
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

  if b.version <> (p_expected_versions ->> 'bookings')::bigint
     or s.version <> (p_expected_versions ->> 'students')::bigint
     or l.version <> (p_expected_versions ->> 'lpItems')::bigint
     or t.version <> (p_expected_versions ->> 'tasks')::bigint
     or h.version <> (p_expected_versions ->> 'teachers')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if (task_item ->> 'status' in ('overdue', 'today', 'upcoming', 'waiting')) is not true then
    raise exception using errcode = '22023', message = 'trial_payment_task_not_open';
  end if;

  completed_at := clock_timestamp();
  select coalesce(jsonb_agg(
    case when item.value ->> 'id' = p_task_id
              and item.value ->> 'ruleKey' = 'trial.jiaowubao.payment-n2'
              and item.value ->> 'anchorBookingId' = anchor_value
              and item.value ->> 'requestAnchorBookingId' = lp_item_id_value
              and item.value ->> 'studentId' = student_id_value
              and item.value ->> 'owner' = planner_value
              and item.value -> 'assignees' = jsonb_build_array(planner_value)
              and item.value -> 'watchers' = jsonb_build_array('Ops Admin')
      then item.value || jsonb_build_object(
        'status', 'done', 'tone', 'green',
        'result', case when p_actor_role = 'admin'
          then '已由管理员确认试听付款'
          else '已由规划老师确认试听付款' end,
        'closedAt', internal.trial_payment_iso(completed_at)
      ) else item.value end order by item.ordinality
  ), '[]'::jsonb) into next_tasks
  from jsonb_array_elements(t.payload) with ordinality item(value, ordinality);
  update public.ops_state
  set payload = next_tasks, version = t.version + 1,
      updated_at = now(), updated_by = left(btrim(p_actor), 120)
  where entity = 'tasks'
  returning * into saved_t;
  insert into public.ops_mutation_log(entity, version, actor)
  values ('tasks', saved_t.version, saved_t.updated_by);
  audit_id := internal.append_operational_contract_audit(
    'trial_payment_complete', btrim(p_actor), 'task', p_task_id,
    jsonb_build_object(
      'source', 'jiaowubao-open-api',
      'anchorId', anchor_value,
      'lpItemId', lp_item_id_value,
      'studentId', student_id_value
    )
  );
  insert into internal.trial_payment_completion_commands(
    command_key, command_intent, command_sha256, task_id, booking_id,
    student_id, task_version, actor, applied_at, audit_id
  ) values (
    p_command_key, p_command_intent, command_hash, p_task_id, anchor_value,
    student_id_value, saved_t.version, left(btrim(p_actor), 120), completed_at, audit_id
  );
  return query select p_command_key, true, p_task_id, anchor_value,
    student_id_value, b, s, l, saved_t, h, audit_id;
end;
$function$;

revoke all on function public.complete_jiaowubao_trial_payment_task_tx(
  text, text, jsonb, text, jsonb, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.complete_jiaowubao_trial_payment_task_tx(
  text, text, jsonb, text, jsonb, text, text
) to anon, authenticated;
