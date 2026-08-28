-- A teacher-change trial is a schedulable trial, but it is not an ordinary
-- trial intake and must never inherit the ordinary trial payment authority.
-- The JWB teacher label must exactly prove the requested replacement teacher.

create or replace function internal.trial_teacher_evidence_key(p_value text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  with normalized as (
    select lower(regexp_replace(btrim(coalesce(p_value, '')), '[[:space:][:punct:]]+', '', 'g')) as value
  )
  select case
    when value in (
      '', '待核对', '待核对老师映射', '待定', '未知', '未知老师',
      '未安排', '未填写', 'na', 'none', 'tba', 'unknown'
    ) then null
    else value
  end
  from normalized
$$;
revoke all on function internal.trial_teacher_evidence_key(text)
  from public, anon, authenticated, service_role;

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

create or replace function internal.jiaowubao_trial_sync_manual_completion_valid(
  p_before jsonb,
  p_after jsonb,
  p_matches jsonb
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select jsonb_typeof(p_before) = 'object'
    and jsonb_typeof(p_after) = 'object'
    and p_before ->> 'id' = p_after ->> 'id'
    and p_before ->> 'ruleKey' in (
      'trial.scheduling',
      'trial.manual-request.parent-progress-24h',
      'trial.manual-request.scheduling-alert-36h',
      'trial.manual-request.parent-progress-48h'
    )
    and (p_before - 'status' - 'tone' - 'completionOutcome' - 'result' - 'closedAt')
      = (p_after - 'status' - 'tone' - 'completionOutcome' - 'result' - 'closedAt')
    and p_after ->> 'status' = 'done'
    and p_after ->> 'tone' = 'green'
    and p_after ->> 'completionOutcome' = 'done'
    and p_after ->> 'closedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and exists (
      select 1 from jsonb_array_elements(p_matches) match
      where match ->> 'lpItemId' = p_after ->> 'anchorBookingId'
        and p_after ->> 'result' = '教务宝真实排课已匹配：' || (match ->> 'eventId')
    )
$$;
revoke all on function internal.jiaowubao_trial_sync_manual_completion_valid(jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- Keep the already-audited atomic writer intact and make two surgical,
-- assertion-guarded changes to its definition. The migration fails closed if
-- the expected previous definition is not installed.
do $migration$
declare
  original_definition text;
  patched_definition text;
  workflow_before text := $needle$where lp ->> 'workflowType' = '试听 LP'$needle$;
  workflow_after text := $needle$where lp ->> 'workflowType' in ('试听 LP', '换老师试听')$needle$;
  teacher_before text := $needle$or not (after_lp -> 'trialSchedule' ? 'plannerHint')$needle$;
  teacher_after text := $needle$or not (after_lp -> 'trialSchedule' ? 'plannerHint')
      or (
        before_lp ->> 'workflowType' = '换老师试听'
        and (
          internal.trial_teacher_evidence_key(before_lp #>> '{fields,newTeacher}') is null
          or internal.trial_teacher_evidence_key(after_lp #>> '{trialSchedule,teacherName}')
            is distinct from internal.trial_teacher_evidence_key(before_lp #>> '{fields,newTeacher}')
        )
      )$needle$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.sync_jiaowubao_trial_matches_atomic(text,text,jsonb,text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure
  ) into original_definition;
  if original_definition is null or strpos(original_definition, workflow_before) = 0
     or strpos(original_definition, teacher_before) = 0 then
    raise exception using errcode = '55000', message = 'teacher_change_trial_sync_base_definition_missing';
  end if;
  patched_definition := replace(original_definition, workflow_before, workflow_after);
  patched_definition := replace(patched_definition, teacher_before, teacher_after);
  if patched_definition = original_definition
     or strpos(patched_definition, workflow_before) > 0
     or strpos(patched_definition, workflow_after) = 0
     or strpos(patched_definition, teacher_after) = 0 then
    raise exception using errcode = '55000', message = 'teacher_change_trial_sync_patch_failed';
  end if;
  execute patched_definition;
end
$migration$;

revoke all on function public.sync_jiaowubao_trial_matches_atomic(
  text, text, jsonb, text, jsonb, jsonb, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.sync_jiaowubao_trial_matches_atomic(
  text, text, jsonb, text, jsonb, jsonb, jsonb, jsonb, text
) to anon, authenticated;
