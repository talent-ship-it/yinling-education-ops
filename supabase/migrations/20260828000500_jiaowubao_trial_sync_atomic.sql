-- Project one immutable Jiaowubao trial snapshot into LP/task state in one
-- idempotent OCC transaction. The browser supplies only source references;
-- the application server re-reads the raw snapshot and derives both arrays.

create table if not exists internal.jiaowubao_trial_sync_commands (
  command_key uuid primary key,
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  snapshot_revision text not null check (snapshot_revision ~ '^sha256:[a-f0-9]{64}$'),
  matches jsonb not null check (jsonb_typeof(matches) = 'array'),
  lp_item_ids jsonb not null check (jsonb_typeof(lp_item_ids) = 'array'),
  student_ids jsonb not null check (jsonb_typeof(student_ids) = 'array'),
  lp_items_version bigint not null check (lp_items_version > 0),
  tasks_version bigint not null check (tasks_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied boolean not null,
  applied_at timestamptz not null default clock_timestamp(),
  audit_id uuid not null references internal.operational_contract_audit(id) on delete restrict
);
alter table internal.jiaowubao_trial_sync_commands enable row level security;
revoke all on table internal.jiaowubao_trial_sync_commands from public, anon, authenticated, service_role;

create or replace function internal.jiaowubao_trial_sync_previous_task_allowed(
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
    and coalesce(p_task ->> 'ruleKey', '') like 'trial.jiaowubao.%'
    and (
      exists (
        select 1 from jsonb_array_elements(p_matches) match
        where match ->> 'lpItemId' = p_task ->> 'requestAnchorBookingId'
      )
      or exists (
        select 1 from jsonb_array_elements(p_matches) match
        where 'JWB:' || (match ->> 'eventId') = p_task ->> 'anchorBookingId'
      )
      or exists (
        select 1
        from jsonb_array_elements(p_matches) match
        join jsonb_array_elements(p_lp_items) lp on lp ->> 'id' = match ->> 'lpItemId'
        where nullif(lp -> 'trialSchedule' ->> 'eventId', '') is not null
          and 'JWB:' || (lp -> 'trialSchedule' ->> 'eventId') = p_task ->> 'anchorBookingId'
      )
    )
$$;
revoke all on function internal.jiaowubao_trial_sync_previous_task_allowed(jsonb, jsonb, jsonb)
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
            lower(coalesce(nullif(btrim(lp #>> '{trialIntake,planner}'), ''), nullif(btrim(lp #>> '{fields,planner}'), '')))
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

create or replace function public.get_jiaowubao_trial_sync_command_result(
  p_secret text,
  p_command_uuid text,
  p_command_intent jsonb,
  p_actor text
)
returns table(
  command_key text,
  snapshot_revision text,
  lp_item_ids jsonb,
  student_ids jsonb,
  lp_items_row public.ops_state,
  tasks_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  prior internal.jiaowubao_trial_sync_commands%rowtype;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(lower(btrim(p_command_uuid)), '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or nullif(btrim(p_actor), '') is null or length(btrim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_trial_sync_replay_lookup';
  end if;

  select * into l from public.ops_state where entity = 'lpItems' for share;
  select * into t from public.ops_state where entity = 'tasks' for share;
  select * into prior
  from internal.jiaowubao_trial_sync_commands ledger
  where ledger.command_key = lower(btrim(p_command_uuid))::uuid;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent or prior.actor <> btrim(p_actor) then
    raise exception using errcode = '23505', message = 'jiaowubao_trial_sync_idempotency_conflict';
  end if;
  if l.entity is null or t.entity is null
     or l.version < prior.lp_items_version or t.version < prior.tasks_version then
    raise exception using errcode = '55000', message = 'jiaowubao_trial_sync_replay_version_regressed';
  end if;
  return query select prior.command_key::text, prior.snapshot_revision,
    prior.lp_item_ids, prior.student_ids, l, t, prior.audit_id;
end;
$$;
revoke all on function public.get_jiaowubao_trial_sync_command_result(text, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_jiaowubao_trial_sync_command_result(text, text, jsonb, text)
  to anon, authenticated;

create or replace function public.sync_jiaowubao_trial_matches_atomic(
  p_secret text,
  p_command_uuid text,
  p_command_intent jsonb,
  p_snapshot_revision text,
  p_matches jsonb,
  p_expected_versions jsonb,
  p_next_lp_items jsonb,
  p_next_tasks jsonb,
  p_actor text
)
returns table(
  command_key text,
  applied boolean,
  snapshot_revision text,
  lp_item_ids jsonb,
  student_ids jsonb,
  lp_items_row public.ops_state,
  tasks_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  command_uuid uuid;
  prior internal.jiaowubao_trial_sync_commands%rowtype;
  pointer internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  saved_l public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  lp_ids jsonb;
  target_student_ids jsonb;
  match_count integer;
  changed boolean;
  payload_hash text;
  audit_id_value uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(lower(btrim(p_command_uuid)), '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_snapshot_revision !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent - 'snapshotRevision' - 'window' - 'matches' - 'expectedVersions' <> '{}'::jsonb
     or p_command_intent ->> 'snapshotRevision' is distinct from p_snapshot_revision
     or jsonb_typeof(p_command_intent -> 'window') is distinct from 'object'
     or (p_command_intent -> 'window') - 'startsAt' - 'endsAt' <> '{}'::jsonb
     or coalesce(p_command_intent #>> '{window,startsAt}', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     or coalesce(p_command_intent #>> '{window,endsAt}', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     or p_command_intent -> 'matches' is distinct from p_matches
     or p_command_intent -> 'expectedVersions' is distinct from p_expected_versions
     or jsonb_typeof(p_matches) is distinct from 'array'
     or jsonb_array_length(p_matches) not between 1 and 24
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'lpItems' - 'tasks' <> '{}'::jsonb
     or coalesce(p_expected_versions ->> 'lpItems', '') !~ '^[1-9][0-9]*$'
     or coalesce(p_expected_versions ->> 'tasks', '') !~ '^[1-9][0-9]*$'
     or jsonb_typeof(p_next_lp_items) is distinct from 'array'
     or jsonb_typeof(p_next_tasks) is distinct from 'array'
     or nullif(btrim(p_actor), '') is null or length(btrim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_trial_sync_request';
  end if;
  command_uuid := lower(btrim(p_command_uuid))::uuid;
  begin
    if (p_command_intent #>> '{window,endsAt}')::timestamptz
         <= (p_command_intent #>> '{window,startsAt}')::timestamptz
       or (p_command_intent #>> '{window,endsAt}')::timestamptz
         > (p_command_intent #>> '{window,startsAt}')::timestamptz + interval '32 days' then
      raise exception using errcode = '22023', message = 'jiaowubao_trial_sync_window_invalid';
    end if;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception using errcode = '22023', message = 'jiaowubao_trial_sync_window_invalid';
  end;
  if exists (
    select 1 from jsonb_array_elements(p_matches) match
    where jsonb_typeof(match) <> 'object'
      or match - 'lpItemId' - 'eventId' - 'startsAt' <> '{}'::jsonb
      or coalesce(match ->> 'lpItemId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      or coalesce(match ->> 'eventId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      or coalesce(match ->> 'startsAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  ) then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_trial_sync_matches';
  end if;
  begin
    if exists (
      select 1 from jsonb_array_elements(p_matches) match
      where (match ->> 'startsAt')::timestamptz
          < (p_command_intent #>> '{window,startsAt}')::timestamptz
         or (match ->> 'startsAt')::timestamptz
          >= (p_command_intent #>> '{window,endsAt}')::timestamptz
    ) then
      raise exception using errcode = '22023', message = 'jiaowubao_trial_sync_match_outside_window';
    end if;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_trial_sync_matches';
  end;
  select count(*) into match_count from jsonb_array_elements(p_matches);
  if (select count(distinct match ->> 'lpItemId') from jsonb_array_elements(p_matches) match) <> match_count
     or (select count(distinct match ->> 'eventId') from jsonb_array_elements(p_matches) match) <> match_count then
    raise exception using errcode = '22023', message = 'duplicate_jiaowubao_trial_sync_matches';
  end if;

  -- Writers always own the lpItems -> tasks suffix in this order. Read the
  -- ledger only after both locks so an in-flight same-key commit is observed.
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  select * into prior
  from internal.jiaowubao_trial_sync_commands ledger
  where ledger.command_key = command_uuid;
  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent or prior.actor <> btrim(p_actor) then
      raise exception using errcode = '23505', message = 'jiaowubao_trial_sync_idempotency_conflict';
    end if;
    return query select prior.command_key::text, false, prior.snapshot_revision,
      prior.lp_item_ids, prior.student_ids, l, t, prior.audit_id;
    return;
  end if;
  if l.entity is null or t.entity is null
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_trial_sync_state_missing';
  end if;
  if l.version <> (p_expected_versions ->> 'lpItems')::bigint
     or t.version <> (p_expected_versions ->> 'tasks')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  select * into pointer
  from internal.jiaowubao_open_api_schedule_snapshot_current current_pointer
  where current_pointer.api_source_key = 'jwb-open-api-schedule'
  for share;
  if pointer.api_source_key is null or pointer.revision is distinct from p_snapshot_revision then
    raise exception using errcode = '55000', message = 'jiaowubao_trial_sync_snapshot_revision_conflict';
  end if;

  if exists (select 1 from jsonb_array_elements(l.payload) item where nullif(item ->> 'id', '') is null)
     or exists (select 1 from jsonb_array_elements(p_next_lp_items) item where nullif(item ->> 'id', '') is null)
     or exists (select 1 from jsonb_array_elements(t.payload) item where nullif(item ->> 'id', '') is null)
     or exists (select 1 from jsonb_array_elements(p_next_tasks) item where nullif(item ->> 'id', '') is null)
     or exists (select 1 from jsonb_array_elements(l.payload) item group by item ->> 'id' having count(*) > 1)
     or exists (select 1 from jsonb_array_elements(p_next_lp_items) item group by item ->> 'id' having count(*) > 1)
     or exists (select 1 from jsonb_array_elements(t.payload) item group by item ->> 'id' having count(*) > 1)
     or exists (select 1 from jsonb_array_elements(p_next_tasks) item group by item ->> 'id' having count(*) > 1) then
    raise exception using errcode = '55000', message = 'jiaowubao_trial_sync_state_invalid';
  end if;
  if jsonb_array_length(l.payload) <> jsonb_array_length(p_next_lp_items)
     or exists (
       select 1 from jsonb_array_elements(l.payload) current_lp
       where not exists (select 1 from jsonb_array_elements(p_next_lp_items) next_lp where next_lp ->> 'id' = current_lp ->> 'id')
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_trial_sync_lp_identity_changed';
  end if;

  select jsonb_agg(match ->> 'lpItemId' order by match ->> 'lpItemId')
  into lp_ids from jsonb_array_elements(p_matches) match;
  select jsonb_agg(lp ->> 'studentId' order by lp ->> 'studentId')
  into target_student_ids
  from jsonb_array_elements(p_matches) match
  join jsonb_array_elements(l.payload) lp on lp ->> 'id' = match ->> 'lpItemId'
  where lp ->> 'workflowType' = '试听 LP'
    and coalesce(lp ->> 'stage', '') <> '完成'
    and nullif(lp ->> 'studentId', '') is not null;
  if target_student_ids is null or jsonb_array_length(target_student_ids) <> match_count then
    raise exception using errcode = 'P0002', message = 'jiaowubao_trial_sync_lp_not_found';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(l.payload) before_lp
    join jsonb_array_elements(p_next_lp_items) after_lp on after_lp ->> 'id' = before_lp ->> 'id'
    where not exists (select 1 from jsonb_array_elements(p_matches) match where match ->> 'lpItemId' = before_lp ->> 'id')
      and before_lp is distinct from after_lp
  ) or exists (
    select 1
    from jsonb_array_elements(p_matches) match
    join jsonb_array_elements(l.payload) before_lp on before_lp ->> 'id' = match ->> 'lpItemId'
    join jsonb_array_elements(p_next_lp_items) after_lp on after_lp ->> 'id' = match ->> 'lpItemId'
    where (before_lp - 'trialSchedule') is distinct from (after_lp - 'trialSchedule')
      or after_lp -> 'trialSchedule' ->> 'source' <> 'jiaowubao-open-api'
      or after_lp -> 'trialSchedule' ->> 'sourceRevision' <> p_snapshot_revision
      or after_lp -> 'trialSchedule' ->> 'eventId' <> match ->> 'eventId'
      or after_lp -> 'trialSchedule' ->> 'startsAt' <> match ->> 'startsAt'
      or coalesce(after_lp -> 'trialSchedule' ->> 'endsAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
      or coalesce(after_lp -> 'trialSchedule' ->> 'matchedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
      or nullif(btrim(after_lp -> 'trialSchedule' ->> 'teacherName'), '') is null
      or not (after_lp -> 'trialSchedule' ? 'plannerHint')
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_trial_sync_lp_projection_invalid';
  end if;

  if exists (
    with before_tasks as (
      select task ->> 'id' as id, task from jsonb_array_elements(t.payload) task
    ), after_tasks as (
      select task ->> 'id' as id, task from jsonb_array_elements(p_next_tasks) task
    ), changed_tasks as (
      select coalesce(before_tasks.id, after_tasks.id) as id,
        before_tasks.task as before_task, after_tasks.task as after_task
      from before_tasks full join after_tasks using (id)
      where before_tasks.task is distinct from after_tasks.task
    )
    select 1 from changed_tasks change
    where not (
      (
        (change.before_task is null or internal.jiaowubao_trial_sync_previous_task_allowed(change.before_task, p_matches, l.payload))
        and (change.after_task is null or internal.jiaowubao_trial_sync_generated_task_valid(change.after_task, p_matches, l.payload))
        and (change.before_task is not null or change.after_task is not null)
        and coalesce(change.before_task ->> 'ruleKey', change.after_task ->> 'ruleKey', '') like 'trial.jiaowubao.%'
      )
      or internal.jiaowubao_trial_sync_manual_completion_valid(change.before_task, change.after_task, p_matches)
    )
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_trial_sync_task_projection_invalid';
  end if;

  changed := p_next_lp_items is distinct from l.payload or p_next_tasks is distinct from t.payload;
  saved_l := l;
  saved_t := t;
  if p_next_lp_items is distinct from l.payload then
    update public.ops_state set payload = p_next_lp_items, version = l.version + 1,
      updated_at = now(), updated_by = btrim(p_actor)
    where entity = 'lpItems' returning * into saved_l;
    insert into public.ops_mutation_log(entity, version, actor)
      values ('lpItems', saved_l.version, saved_l.updated_by);
  end if;
  if p_next_tasks is distinct from t.payload then
    update public.ops_state set payload = p_next_tasks, version = t.version + 1,
      updated_at = now(), updated_by = btrim(p_actor)
    where entity = 'tasks' returning * into saved_t;
    insert into public.ops_mutation_log(entity, version, actor)
      values ('tasks', saved_t.version, saved_t.updated_by);
  end if;

  payload_hash := encode(extensions.digest(jsonb_build_object(
    'commandIntent', p_command_intent,
    'lpItems', p_next_lp_items,
    'tasks', p_next_tasks
  )::text, 'sha256'), 'hex');
  audit_id_value := internal.append_operational_contract_audit(
    'trial.jiaowubao.sync_atomic', btrim(p_actor), 'jiaowubao_trial_sync', command_uuid::text,
    jsonb_build_object(
      'snapshotRevision', p_snapshot_revision,
      'matches', p_matches,
      'lpItemIds', lp_ids,
      'studentIds', target_student_ids,
      'applied', changed,
      'versionsBefore', p_expected_versions,
      'versionsAfter', jsonb_build_object('lpItems', saved_l.version, 'tasks', saved_t.version),
      'payloadSha256', payload_hash
    )
  );
  insert into internal.jiaowubao_trial_sync_commands(
    command_key, command_intent, command_hash, snapshot_revision, matches,
    lp_item_ids, student_ids, lp_items_version, tasks_version, actor, applied, audit_id
  ) values (
    command_uuid, p_command_intent, payload_hash, p_snapshot_revision, p_matches,
    lp_ids, target_student_ids, saved_l.version, saved_t.version, btrim(p_actor), changed, audit_id_value
  );
  return query select command_uuid::text, changed, p_snapshot_revision,
    lp_ids, target_student_ids, saved_l, saved_t, audit_id_value;
end;
$$;
revoke all on function public.sync_jiaowubao_trial_matches_atomic(
  text, text, jsonb, text, jsonb, jsonb, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.sync_jiaowubao_trial_matches_atomic(
  text, text, jsonb, text, jsonb, jsonb, jsonb, jsonb, text
) to anon, authenticated;
