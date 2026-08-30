-- Apply the revised trial-scheduling policy confirmed on 2026-08-31:
--   * create one immediate “试听待排课” task, due exactly request + 24h;
--   * keep only the first 24h parent progress update;
--   * retire the 36h/48h and teacher-reply 4h/8h chains;
--   * preserve every completed or frozen historical record;
--   * allow only the Jiaowubao projection to complete scheduling work.

create or replace function internal.trial_scheduling_policy_tasks(
  p_tasks jsonb,
  p_lp_item_id text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  projected jsonb;
  template jsonb;
  generated jsonb;
  pending_title text;
begin
  if jsonb_typeof(p_tasks) is distinct from 'array'
     or nullif(btrim(p_lp_item_id), '') is null then
    raise exception using errcode = '22023', message = 'trial_scheduling_policy_input_invalid';
  end if;

  projected := (
    select coalesce(jsonb_agg(task.value order by task.ordinality), '[]'::jsonb)
    from jsonb_array_elements(p_tasks) with ordinality task(value, ordinality)
    where not (
      task.value ->> 'anchorBookingId' = p_lp_item_id
      and task.value ->> 'ruleKey' in (
        'trial.manual-request.scheduling-alert-36h',
        'trial.manual-request.parent-progress-48h'
      )
      and coalesce(task.value ->> 'status', '') <> 'done'
      and not (task.value ? 'legacyEvidence')
      and not exists (
        select 1
        from internal.legacy_task_deadline_freezes evidence
        where evidence.task_id = task.value ->> 'id'
      )
    )
  );

  select task.value into template
  from jsonb_array_elements(projected) task(value)
  where task.value ->> 'anchorBookingId' = p_lp_item_id
    and task.value ->> 'ruleKey' = 'trial.manual-request.parent-progress-24h'
    and coalesce(task.value ->> 'status', '') <> 'done'
    and coalesce(task.value ->> 'dueAt', '')
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    and not (task.value ? 'legacyEvidence')
    and not exists (
      select 1
      from internal.legacy_task_deadline_freezes evidence
      where evidence.task_id = task.value ->> 'id'
    )
  limit 1;

  if template is null or exists (
    select 1
    from jsonb_array_elements(projected) task(value)
    where task.value ->> 'anchorBookingId' = p_lp_item_id
      and task.value ->> 'ruleKey' = 'trial.scheduling'
  ) then
    return projected;
  end if;

  pending_title := replace(
    template ->> 'title',
    '【向家长交待排课进度】',
    '【试听待排课】'
  );
  if pending_title = template ->> 'title' then
    pending_title := '《教务+教统》【试听待排课】';
  end if;

  generated := (template
    - 'completionOutcome'
    - 'completionNote'
    - 'result'
    - 'closedAt') || jsonb_build_object(
      'id', internal.trial_manual_task_id(p_lp_item_id, 'trial.scheduling'),
      'title', pending_title,
      'tone', 'red',
      'category', '排课',
      'trigger', '试听 LP 信息交接后立即生成，排课后由教务宝自动完成',
      'ruleKey', 'trial.scheduling'
    );
  return projected || jsonb_build_array(generated);
end;
$$;
revoke all on function internal.trial_scheduling_policy_tasks(jsonb, text)
  from public, anon, authenticated, service_role;

alter function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  rename to mutate_lp_atomic_before_trial_scheduling_policy;
revoke all on function public.mutate_lp_atomic_before_trial_scheduling_policy(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function public.mutate_lp_atomic(
  p_secret text,
  p_command_uuid text,
  p_command_intent jsonb,
  p_operation text,
  p_student_id text,
  p_provisional_intake jsonb,
  p_lp_item_id text,
  p_workflow_type text,
  p_fields jsonb,
  p_revision_note text,
  p_authorized_assignment jsonb,
  p_expected_versions jsonb,
  p_actor text
)
returns table(command_key text, operation text, applied boolean, student_id text, lp_item_id text,
  students_row public.ops_state, lp_items_row public.ops_state, tasks_row public.ops_state,
  files_row public.ops_state, audit_entry_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  delegated record;
  t public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  next_t jsonb;
begin
  select * into delegated
  from public.mutate_lp_atomic_before_trial_scheduling_policy(
    p_secret, p_command_uuid, p_command_intent, p_operation, p_student_id,
    p_provisional_intake, p_lp_item_id, p_workflow_type, p_fields,
    p_revision_note, p_authorized_assignment, p_expected_versions, p_actor
  );
  if delegated.command_key is null then
    raise exception using errcode = '55000', message = 'lp_atomic_result_missing';
  end if;

  if p_operation <> 'create' or p_workflow_type <> '试听 LP' then
    return query select delegated.command_key, delegated.operation, delegated.applied,
      delegated.student_id, delegated.lp_item_id, delegated.students_row,
      delegated.lp_items_row, delegated.tasks_row, delegated.files_row,
      delegated.audit_entry_id;
    return;
  end if;

  select * into t from public.ops_state where entity = 'tasks' for update;
  if t.entity is null or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_scheduling_policy_state_missing';
  end if;
  next_t := internal.trial_scheduling_policy_tasks(t.payload, delegated.lp_item_id);

  if next_t is distinct from t.payload then
    update public.ops_state
    set payload = next_t,
        version = t.version + 1,
        updated_at = now(),
        updated_by = btrim(p_actor)
    where entity = 'tasks'
    returning * into saved_t;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved_t.version, saved_t.updated_by);
  else
    saved_t := t;
  end if;

  return query select delegated.command_key, delegated.operation, delegated.applied,
    delegated.student_id, delegated.lp_item_id, delegated.students_row,
    delegated.lp_items_row, saved_t, delegated.files_row,
    delegated.audit_entry_id;
end;
$$;
revoke all on function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  to anon, authenticated;

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
      'trial.manual-request.parent-progress-24h'
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

-- Retire only still-open operational tasks. Completed and frozen rows are
-- immutable evidence and remain available in All Done/history.
do $migration$
declare
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  next_t jsonb;
  lp jsonb;
  saved public.ops_state%rowtype;
begin
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  if l.entity is null or t.entity is null
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_scheduling_policy_backfill_state_missing';
  end if;

  next_t := (
    select coalesce(jsonb_agg(task.value order by task.ordinality), '[]'::jsonb)
    from jsonb_array_elements(t.payload) with ordinality task(value, ordinality)
    where not (
      task.value ->> 'ruleKey' in (
        'trial.manual-request.scheduling-alert-36h',
        'trial.manual-request.parent-progress-48h',
        'trial.jiaowubao.teacher-reply-4h',
        'trial.jiaowubao.teacher-reply-8h'
      )
      and coalesce(task.value ->> 'status', '') <> 'done'
      and not (task.value ? 'legacyEvidence')
      and not exists (
        select 1
        from internal.legacy_task_deadline_freezes evidence
        where evidence.task_id = task.value ->> 'id'
      )
    )
  );

  for lp in
    select item.value
    from jsonb_array_elements(l.payload) item(value)
    where item.value ->> 'workflowType' = '试听 LP'
      and coalesce(item.value ->> 'stage', '') <> '完成'
      and nullif(btrim(item.value #>> '{trialSchedule,eventId}'), '') is null
  loop
    next_t := internal.trial_scheduling_policy_tasks(next_t, lp ->> 'id');
  end loop;

  if next_t is distinct from t.payload then
    update public.ops_state
    set payload = next_t,
        version = t.version + 1,
        updated_at = now(),
        updated_by = 'migration:trial-scheduling-policy'
    where entity = 'tasks'
    returning * into saved;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved.version, saved.updated_by);
  end if;
end;
$migration$;
