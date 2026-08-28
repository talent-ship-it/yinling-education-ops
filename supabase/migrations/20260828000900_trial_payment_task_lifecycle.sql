-- Preserve operator notes and explicit Can't Do decisions when the booking-owned
-- payment projection is recalculated. Payment confirmation remains exclusively
-- owned by the dedicated completion RPC.

set local lock_timeout = '1s';

do $clone_trial_payment_projection$
declare
  target oid;
  definition text;
  cloned text;
begin
  if to_regprocedure('internal.reconcile_trial_payment_tasks_for_booking_base_20260828000900(jsonb,jsonb,jsonb,jsonb,text,jsonb,timestamptz)') is null then
    target := to_regprocedure('internal.reconcile_trial_payment_tasks_for_booking(jsonb,jsonb,jsonb,jsonb,text,jsonb,timestamptz)');
    if target is null then
      raise exception using errcode = '42883', message = 'trial_payment_booking_projection_not_found';
    end if;
    definition := pg_get_functiondef(target);
    cloned := replace(
      definition,
      'FUNCTION internal.reconcile_trial_payment_tasks_for_booking(',
      'FUNCTION internal.reconcile_trial_payment_tasks_for_booking_base_20260828000900('
    );
    if cloned is not distinct from definition then
      raise exception using errcode = '55000', message = 'trial_payment_booking_projection_clone_shape_changed';
    end if;
    execute cloned;
  end if;
end;
$clone_trial_payment_projection$;

revoke all on function internal.reconcile_trial_payment_tasks_for_booking_base_20260828000900(
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
begin
  projected := internal.reconcile_trial_payment_tasks_for_booking_base_20260828000900(
    p_tasks,
    p_lp_items,
    p_booking,
    p_previous_booking,
    p_action,
    p_students,
    p_now
  );

  select coalesce(jsonb_agg(
    generated.value
      || case when source_task.note_valid
        then jsonb_build_object('completionNote', source_task.value ->> 'completionNote')
        else '{}'::jsonb end
      || case when generated.value ->> 'status' in ('overdue', 'today', 'upcoming', 'waiting')
          and source_task.note_valid
          and source_task.value ->> 'status' = 'done'
          and source_task.value ->> 'tone' = 'red'
          and source_task.value ->> 'completionOutcome' = 'cannot_do'
          and source_task.value ->> 'result' = '无法完成：' || (source_task.value ->> 'completionNote')
          and source_task.value ->> 'closedAt' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        then jsonb_build_object(
          'status', 'done',
          'tone', 'red',
          'completionOutcome', 'cannot_do',
          'result', source_task.value ->> 'result',
          'closedAt', source_task.value ->> 'closedAt'
        ) else '{}'::jsonb end
    order by generated.ordinality
  ), '[]'::jsonb) into projected
  from jsonb_array_elements(projected) with ordinality generated(value, ordinality)
  left join lateral (
    select candidate.value,
      jsonb_typeof(candidate.value -> 'completionNote') = 'string'
        and candidate.value ->> 'completionNote' = btrim(candidate.value ->> 'completionNote')
        and char_length(candidate.value ->> 'completionNote') between 1 and 1000 as note_valid
    from jsonb_array_elements(p_tasks) candidate(value)
    where generated.value ->> 'ruleKey' in ('trial.payment-n2', 'trial.payment-urgent')
      and candidate.value ->> 'id' = generated.value ->> 'id'
      and candidate.value ->> 'ruleKey' = generated.value ->> 'ruleKey'
      and candidate.value ->> 'anchorBookingId' = generated.value ->> 'anchorBookingId'
      and candidate.value ->> 'requestAnchorBookingId' is not distinct from generated.value ->> 'requestAnchorBookingId'
      and candidate.value ->> 'studentId' = generated.value ->> 'studentId'
      and candidate.value ->> 'owner' = generated.value ->> 'owner'
      and candidate.value -> 'assignees' is not distinct from generated.value -> 'assignees'
      and candidate.value -> 'watchers' is not distinct from generated.value -> 'watchers'
    limit 1
  ) source_task on true;

  return projected;
end;
$function$;

revoke all on function internal.reconcile_trial_payment_tasks_for_booking(
  jsonb, jsonb, jsonb, jsonb, text, jsonb, timestamptz
) from public, anon, authenticated, service_role;
