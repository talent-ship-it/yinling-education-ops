-- Align the remaining trial-handbook semantics:
--   * every trial ledger row starts at “试听未进行”;
--   * “收试卷” does not exist until “发试卷” is actually completed.
-- The browser then creates the dependent task from the completion instant.

alter function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  rename to mutate_lp_atomic_before_trial_handbook_follow_up_defaults;
revoke all on function public.mutate_lp_atomic_before_trial_handbook_follow_up_defaults(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
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
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  saved_l public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  next_l jsonb;
  next_t jsonb;
begin
  select * into delegated
  from public.mutate_lp_atomic_before_trial_handbook_follow_up_defaults(
    p_secret, p_command_uuid, p_command_intent, p_operation, p_student_id,
    p_provisional_intake, p_lp_item_id, p_workflow_type, p_fields,
    p_revision_note, p_authorized_assignment, p_expected_versions, p_actor
  );
  if delegated.command_key is null then
    raise exception using errcode = '55000', message = 'lp_atomic_result_missing';
  end if;

  if p_operation <> 'create' or p_workflow_type not in ('试听 LP', '换老师试听') then
    return query select delegated.command_key, delegated.operation, delegated.applied,
      delegated.student_id, delegated.lp_item_id, delegated.students_row,
      delegated.lp_items_row, delegated.tasks_row, delegated.files_row,
      delegated.audit_entry_id;
    return;
  end if;

  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  if l.entity is null or t.entity is null
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_follow_up_state_missing';
  end if;

  next_l := (
    select coalesce(jsonb_agg(
      case when item.value ->> 'id' = delegated.lp_item_id
        and nullif(trim(item.value ->> 'resultStatus'), '') is null
        then item.value || jsonb_build_object('resultStatus', '试听未进行')
        else item.value
      end order by item.ordinality
    ), '[]'::jsonb)
    from jsonb_array_elements(l.payload) with ordinality item(value, ordinality)
  );

  next_t := case when p_workflow_type = '试听 LP' then (
    select coalesce(jsonb_agg(task.value order by task.ordinality), '[]'::jsonb)
    from jsonb_array_elements(t.payload) with ordinality task(value, ordinality)
    where not (
      task.value ->> 'anchorBookingId' = delegated.lp_item_id
      and task.value ->> 'ruleKey' = 'trial.manual-request.paper-receive'
      and coalesce(task.value ->> 'status', '') <> 'done'
      and not (task.value ? 'legacyEvidence')
      and not exists (
        select 1 from internal.legacy_task_deadline_freezes evidence
        where evidence.task_id = task.value ->> 'id'
      )
    )
  ) else t.payload end;

  if next_l is distinct from l.payload then
    update public.ops_state
    set payload = next_l, version = l.version + 1, updated_at = now(), updated_by = trim(p_actor)
    where entity = 'lpItems'
    returning * into saved_l;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('lpItems', saved_l.version, saved_l.updated_by);
  else
    saved_l := l;
  end if;

  if next_t is distinct from t.payload then
    update public.ops_state
    set payload = next_t, version = t.version + 1, updated_at = now(), updated_by = trim(p_actor)
    where entity = 'tasks'
    returning * into saved_t;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('tasks', saved_t.version, saved_t.updated_by);
  else
    saved_t := t;
  end if;

  return query select delegated.command_key, delegated.operation, delegated.applied,
    delegated.student_id, delegated.lp_item_id, delegated.students_row,
    saved_l, saved_t, delegated.files_row, delegated.audit_entry_id;
end;
$$;
revoke all on function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.mutate_lp_atomic(text, text, jsonb, text, text, jsonb, text, text, jsonb, text, jsonb, jsonb, text)
  to anon, authenticated;

-- Backfill only missing trial results; never overwrite a human result.
with projected as (
  select coalesce(jsonb_agg(
    case when item.value ->> 'workflowType' in ('试听 LP', '换老师试听')
      and nullif(trim(item.value ->> 'resultStatus'), '') is null
      then item.value || jsonb_build_object('resultStatus', '试听未进行')
      else item.value
    end order by item.ordinality
  ), '[]'::jsonb) as payload
  from public.ops_state state
  cross join lateral jsonb_array_elements(state.payload) with ordinality item(value, ordinality)
  where state.entity = 'lpItems'
), saved as (
  update public.ops_state state
  set payload = projected.payload,
      version = state.version + 1,
      updated_at = now(),
      updated_by = 'migration:trial-result-default'
  from projected
  where state.entity = 'lpItems'
    and projected.payload is distinct from state.payload
  returning state.entity, state.version, state.updated_by
)
insert into public.ops_mutation_log(entity, version, actor)
select entity, version, updated_by from saved;

-- Repair pre-existing generated “收试卷” tasks without touching frozen or
-- completed evidence. An open source task removes the premature follow-up;
-- a completed source task rebases it to closedAt + 24 hours.
with source as (
  select state.payload
  from public.ops_state state
  where state.entity = 'tasks'
), projected as (
  select coalesce(jsonb_agg(
    case
      when receive.value ->> 'ruleKey' = 'trial.manual-request.paper-receive'
        and coalesce(receive.value ->> 'status', '') <> 'done'
        and not (receive.value ? 'legacyEvidence')
        and send.value ->> 'status' = 'done'
        and coalesce(send.value ->> 'closedAt', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      then receive.value || jsonb_build_object(
        'due', to_char(((send.value ->> 'closedAt')::timestamptz + interval '24 hours') at time zone 'Asia/Shanghai', 'YYYY"年"MM"月"DD"日" HH24:MI'),
        'dueAt', to_char(((send.value ->> 'closedAt')::timestamptz + interval '24 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'status', case
          when (((send.value ->> 'closedAt')::timestamptz + interval '24 hours') at time zone 'Australia/Melbourne')::date
            < (now() at time zone 'Australia/Melbourne')::date then 'overdue'
          when (((send.value ->> 'closedAt')::timestamptz + interval '24 hours') at time zone 'Australia/Melbourne')::date
            = (now() at time zone 'Australia/Melbourne')::date then 'today'
          else 'upcoming'
        end,
        'tone', case
          when (((send.value ->> 'closedAt')::timestamptz + interval '24 hours') at time zone 'Australia/Melbourne')::date
            < (now() at time zone 'Australia/Melbourne')::date then 'red'
          when (((send.value ->> 'closedAt')::timestamptz + interval '24 hours') at time zone 'Australia/Melbourne')::date
            = (now() at time zone 'Australia/Melbourne')::date then 'amber'
          else 'blue'
        end
      )
      else receive.value
    end order by receive.ordinality
  ) filter (where not (
    receive.value ->> 'ruleKey' = 'trial.manual-request.paper-receive'
    and coalesce(receive.value ->> 'status', '') <> 'done'
    and not (receive.value ? 'legacyEvidence')
    and send.value is not null
    and coalesce(send.value ->> 'status', '') <> 'done'
  )), '[]'::jsonb) as payload
  from source
  cross join lateral jsonb_array_elements(source.payload) with ordinality receive(value, ordinality)
  left join lateral (
    select candidate.value
    from jsonb_array_elements(source.payload) candidate(value)
    where candidate.value ->> 'anchorBookingId' = receive.value ->> 'anchorBookingId'
      and candidate.value ->> 'studentId' = receive.value ->> 'studentId'
      and candidate.value ->> 'ruleKey' = 'trial.manual-request.paper-send'
    limit 1
  ) send on true
), saved as (
  update public.ops_state state
  set payload = projected.payload,
      version = state.version + 1,
      updated_at = now(),
      updated_by = 'migration:trial-paper-follow-up-clock'
  from projected
  where state.entity = 'tasks'
    and projected.payload is distinct from state.payload
  returning state.entity, state.version, state.updated_by
)
insert into public.ops_mutation_log(entity, version, actor)
select entity, version, updated_by from saved;
