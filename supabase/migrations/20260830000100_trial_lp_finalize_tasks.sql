-- Permit the server-recomputed N-3 LP finalize reminder while retaining the
-- existing atomic Jiaowubao task projection checks and teacher-change guard.

create or replace function internal.jiaowubao_trial_sync_generated_task_valid(
  p_task jsonb,
  p_matches jsonb,
  p_lp_items jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_typeof(p_task) = 'object'
    and p_task ->> 'ruleKey' in (
      'trial.jiaowubao.lp-finalize-tomorrow-n3',
      'trial.jiaowubao.lp-materials-n2',
      'trial.jiaowubao.prep-n1',
      'trial.jiaowubao.payment-n2',
      'trial.jiaowubao.today'
    )
    and nullif(btrim(p_task ->> 'id'), '') is not null
    and nullif(btrim(p_task ->> 'title'), '') is not null
    and nullif(btrim(p_task ->> 'owner'), '') is not null
    and jsonb_typeof(p_task -> 'assignees') = 'array'
    and p_task -> 'watchers' = jsonb_build_array('Ops Admin')
    and not (p_task ? 'legacyEvidence')
    and p_task ->> 'status' in ('overdue', 'today', 'upcoming', 'waiting', 'done')
    and p_task ->> 'dueAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and exists (
      select 1
      from jsonb_array_elements(p_matches) match
      join jsonb_array_elements(p_lp_items) lp on lp ->> 'id' = match ->> 'lpItemId'
      where p_task ->> 'requestAnchorBookingId' = match ->> 'lpItemId'
        and p_task ->> 'anchorBookingId' = 'JWB:' || (match ->> 'eventId')
        and p_task ->> 'studentId' = lp ->> 'studentId'
        and (
          p_task ->> 'ruleKey' <> 'trial.jiaowubao.payment-n2'
          or (
            lp ->> 'workflowType' = '试听 LP'
            and lower(coalesce(nullif(btrim(lp #>> '{trialIntake,planner}'), ''), nullif(btrim(lp #>> '{fields,planner}'), '')))
              in ('tara', 'eileen', 'abby')
            and p_task ->> 'owner' = case lower(coalesce(
              nullif(btrim(lp #>> '{trialIntake,planner}'), ''),
              nullif(btrim(lp #>> '{fields,planner}'), '')
            )) when 'tara' then 'Tara' when 'eileen' then 'Eileen' when 'abby' then 'Abby' end
            and p_task -> 'assignees' = jsonb_build_array(case lower(coalesce(
              nullif(btrim(lp #>> '{trialIntake,planner}'), ''),
              nullif(btrim(lp #>> '{fields,planner}'), '')
            )) when 'tara' then 'Tara' when 'eileen' then 'Eileen' when 'abby' then 'Abby' end)
          )
        )
    )
$$;
revoke all on function internal.jiaowubao_trial_sync_generated_task_valid(jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;
