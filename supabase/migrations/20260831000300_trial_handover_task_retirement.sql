-- Trial LP creation used to emit a generic "LP handover" task before the
-- trial-specific task projector ran.  The accepted workflow starts directly
-- with the conditional intake tasks plus the JWB-controlled scheduling pair,
-- so retire that generic task for new and existing trials.  Completed and
-- frozen rows remain immutable operational evidence.

alter function internal.trial_scheduling_policy_tasks(jsonb, text)
  rename to trial_scheduling_policy_tasks_before_handover_retirement;
revoke all on function internal.trial_scheduling_policy_tasks_before_handover_retirement(jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function internal.trial_scheduling_policy_tasks(
  p_tasks jsonb,
  p_lp_item_id text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(task.value order by task.ordinality), '[]'::jsonb)
  from jsonb_array_elements(
    internal.trial_scheduling_policy_tasks_before_handover_retirement(
      p_tasks,
      p_lp_item_id
    )
  ) with ordinality task(value, ordinality)
  where not (
    task.value ->> 'anchorBookingId' = p_lp_item_id
    and task.value ->> 'ruleKey' = 'lp.handover'
    and coalesce(task.value ->> 'status', '') <> 'done'
    and not (task.value ? 'legacyEvidence')
    and not exists (
      select 1
      from internal.legacy_task_deadline_freezes evidence
      where evidence.task_id = task.value ->> 'id'
    )
  )
$$;
revoke all on function internal.trial_scheduling_policy_tasks(jsonb, text)
  from public, anon, authenticated, service_role;

do $migration$
declare
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  next_t jsonb;
  saved public.ops_state%rowtype;
begin
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  if l.entity is null or t.entity is null
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_handover_retirement_state_missing';
  end if;

  next_t := (
    select coalesce(jsonb_agg(task.value order by task.ordinality), '[]'::jsonb)
    from jsonb_array_elements(t.payload) with ordinality task(value, ordinality)
    where not (
      coalesce(task.value ->> 'status', '') <> 'done'
      and not (task.value ? 'legacyEvidence')
      and not exists (
        select 1
        from internal.legacy_task_deadline_freezes evidence
        where evidence.task_id = task.value ->> 'id'
      )
      and (
        task.value ->> 'ruleKey' = 'lp.handover'
        or btrim(coalesce(task.value ->> 'title', '')) like '试听 LP：核对交接信息%'
      )
      and exists (
        select 1
        from jsonb_array_elements(l.payload) lp(value)
        where lp.value ->> 'id' = task.value ->> 'anchorBookingId'
          and lp.value ->> 'workflowType' = '试听 LP'
      )
    )
  );

  if next_t is distinct from t.payload then
    update public.ops_state
    set payload = next_t,
        version = t.version + 1,
        updated_at = now(),
        updated_by = 'migration:trial-handover-task-retirement'
    where entity = 'tasks'
    returning * into saved;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved.version, saved.updated_by);
  end if;
end;
$migration$;
