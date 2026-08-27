\set ON_ERROR_STOP on

-- Disposable runtime contract for migration 20260819101800.
--
-- This fixture replaces its tiny local schema only inside one transaction.
-- PostgreSQL rolls every schema and data change back, including on psql exit.
-- Run against a scratch/local database only:
--   psql ... -f tests/sql/task-deadline-invariant-contract.sql

begin;

drop schema if exists internal cascade;
drop schema if exists extensions cascade;
drop table if exists public.ops_mutation_log cascade;
drop table if exists public.ops_state cascade;

create schema internal;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $fixture_roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$fixture_roles$;

create table public.ops_state (
  entity text primary key,
  payload jsonb not null,
  version bigint not null check (version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text not null
);

create table public.ops_mutation_log (
  entity text not null,
  version bigint not null,
  actor text not null
);

create table internal.operational_contract_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  action text not null,
  actor text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create or replace function internal.verify_ops_secret(p_secret text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$ select p_secret = 'task-deadline-fixture-secret' $$;

create or replace function internal.append_operational_contract_audit(
  p_action text,
  p_actor text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $fixture_append_operational_contract_audit$
declare
  saved_id uuid;
begin
  insert into internal.operational_contract_audit (
    action, actor, target_type, target_id, metadata
  ) values (
    p_action, p_actor, p_target_type, p_target_id, p_metadata
  ) returning id into saved_id;
  return saved_id;
end;
$fixture_append_operational_contract_audit$;

\ir ../../supabase/migrations/20260819100800_manual_legacy_task_deadline_atomic.sql
\ir ../../supabase/migrations/20260819101700_lp_parent_progress_scheduler.sql

insert into public.ops_state (entity, payload, version, updated_by) values
  ('students', '[{"id":"STU-DEADLINE","name":"Deadline Fixture","status":"在读"}]', 7, 'fixture'),
  ('bookings', '[]', 1, 'fixture'),
  ('lpItems', '[]', 1, 'fixture'),
  ('tasks', jsonb_build_array(
    jsonb_build_object(
      'id', 'TSK-DEADLINE-LEGACY',
      'title', '历史手工任务',
      'owner', 'Abby',
      'studentId', 'STU-DEADLINE',
      'due', '发布后立即',
      'status', 'waiting',
      'tone', 'red',
      'category', 'LP',
      'trigger', '历史导入'
    ),
    jsonb_build_object(
      'id', 'TSK-DEADLINE-MANAGED',
      'title', '规则任务',
      'owner', 'Abby',
      'studentId', 'STU-DEADLINE',
      'due', 'N-1',
      'status', 'waiting',
      'tone', 'red',
      'category', 'LP',
      'trigger', '规则投影',
      'ruleKey', 'trial.parent-progress-sync.1',
      'anchorBookingId', 'TRIAL-DEADLINE-1'
    ),
    jsonb_build_object(
      'id', 'TSK-DEADLINE-MALFORMED-MANAGED',
      'title', '锚点残缺规则任务',
      'owner', 'Abby',
      'studentId', 'STU-DEADLINE',
      'due', 'N-2',
      'status', 'waiting',
      'tone', 'red',
      'category', 'LP',
      'trigger', '历史损坏投影',
      'ruleKey', 'trial.lp-review'
    ),
    jsonb_build_object(
      'id', 'TSK-DEADLINE-EMPTY-MANAGED',
      'title', '空规则身份历史任务',
      'owner', 'Abby',
      'studentId', 'STU-DEADLINE',
      'due', 'N-3',
      'status', 'waiting',
      'tone', 'red',
      'category', 'LP',
      'trigger', '历史损坏投影',
      'ruleKey', null,
      'anchorBookingId', ''
    ),
    jsonb_build_object(
      'id', 'TSK-DEADLINE-CANONICAL',
      'title', '已有准确时间',
      'owner', 'Abby',
      'studentId', 'STU-DEADLINE',
      'due', '历史展示文字',
      'dueAt', '2026-08-20T09:00:00.000Z',
      'status', 'upcoming',
      'tone', 'blue',
      'category', 'LP',
      'trigger', '权威工作流'
    ),
    jsonb_build_object(
      'id', 'TSK-DEADLINE-CANONICAL-MARKED',
      'title', '有时间但仍冻结',
      'owner', 'Abby',
      'studentId', 'STU-DEADLINE',
      'due', '历史展示文字',
      'dueAt', '2026-08-20T09:30:00.000Z',
      'status', 'upcoming',
      'tone', 'blue',
      'category', 'LP',
      'trigger', '历史冻结投影',
      'legacyEvidence', jsonb_build_object(
        'state', 'frozen',
        'reason', 'missing_canonical_due_at',
        'frozenAt', '2026-08-19T01:00:00.000Z'
      )
    ),
    jsonb_build_object(
      'id', 'TSK-DEADLINE-DONE-HISTORY',
      'title', '已完成历史任务',
      'owner', 'Abby',
      'studentId', 'STU-DEADLINE',
      'due', '发布后立即',
      'status', 'done',
      'tone', 'green',
      'category', 'LP',
      'trigger', '历史导入'
    )
  ), 7, 'fixture');

\ir ../../supabase/migrations/20260819101800_enforce_task_canonical_deadlines.sql

do $task_deadline_freeze_contract$
declare
  task_state public.ops_state%rowtype;
  original_legacy jsonb;
  frozen_legacy jsonb;
  caught_state text;
  caught_message text;
begin
  if not internal.task_due_at_is_canonical('2026-08-20T09:00:00.000Z')
     or internal.task_due_at_is_canonical('2026-08-20T09:00:00Z')
     or internal.task_due_at_is_canonical('2026-02-30T09:00:00.000Z')
     or internal.task_due_at_is_canonical('发布后立即') then
    raise exception 'task_deadline_runtime_canonical_validation_failed';
  end if;

  select * into task_state from public.ops_state where entity = 'tasks';
  if task_state.version <> 8
     or (select count(*) from internal.legacy_task_deadline_freezes) <> 5
     or (select count(*) from internal.legacy_task_deadline_freezes where ownership = 'managed_rule') <> 3
     or (select count(*) from internal.legacy_task_deadline_freezes where thawed_at is not null) <> 0 then
    raise exception 'task_deadline_runtime_freeze_count_failed';
  end if;

  select original_task, frozen_task into original_legacy, frozen_legacy
  from internal.legacy_task_deadline_freezes
  where task_id = 'TSK-DEADLINE-LEGACY';
  if original_legacy ->> 'due' <> '发布后立即'
     or original_legacy ? 'legacyEvidence'
     or frozen_legacy #>> '{legacyEvidence,state}' <> 'frozen'
     or frozen_legacy #>> '{legacyEvidence,reason}' <> 'missing_canonical_due_at'
     or not internal.task_due_at_is_canonical(frozen_legacy #>> '{legacyEvidence,frozenAt}') then
    raise exception 'task_deadline_runtime_complete_evidence_failed';
  end if;

  if not exists (
    select 1 from internal.legacy_task_deadline_freezes
    where task_id = 'TSK-DEADLINE-MALFORMED-MANAGED'
      and ownership = 'managed_rule'
      and rule_key = 'trial.lp-review'
      and anchor_booking_id is null
      and original_task ->> 'due' = 'N-2'
      and frozen_task #>> '{legacyEvidence,state}' = 'frozen'
  ) then
    raise exception 'task_deadline_runtime_malformed_managed_evidence_failed';
  end if;

  if not exists (
    select 1 from internal.legacy_task_deadline_freezes
    where task_id = 'TSK-DEADLINE-EMPTY-MANAGED'
      and ownership = 'managed_rule'
      and rule_key is null
      and anchor_booking_id is null
      and original_task ? 'ruleKey'
      and original_task ? 'anchorBookingId'
      and original_task -> 'ruleKey' = 'null'::jsonb
      and original_task ->> 'anchorBookingId' = ''
      and frozen_task #>> '{legacyEvidence,state}' = 'frozen'
  ) then
    raise exception 'task_deadline_runtime_empty_managed_evidence_failed';
  end if;

  if task_state.payload #>> '{0,legacyEvidence,state}' <> 'frozen'
     or task_state.payload #>> '{1,legacyEvidence,state}' <> 'frozen'
     or task_state.payload #>> '{2,legacyEvidence,state}' <> 'frozen'
     or task_state.payload #>> '{3,legacyEvidence,state}' <> 'frozen'
     or task_state.payload #>> '{4,dueAt}' <> '2026-08-20T09:00:00.000Z'
     or task_state.payload #> '{4,legacyEvidence}' is not null
     or task_state.payload #>> '{5,dueAt}' <> '2026-08-20T09:30:00.000Z'
     or task_state.payload #>> '{5,legacyEvidence,state}' <> 'frozen'
     or task_state.payload #>> '{6,status}' <> 'done'
     or task_state.payload #> '{6,legacyEvidence}' is not null then
    raise exception 'task_deadline_runtime_public_projection_failed';
  end if;

  begin
    update public.ops_state state
    set payload = (
      select jsonb_agg(item.value order by item.ordinality)
      from jsonb_array_elements(state.payload) with ordinality item(value, ordinality)
      where item.value ->> 'id' <> 'TSK-DEADLINE-LEGACY'
    ), version = version + 1, updated_by = 'generic writer'
    where entity = 'tasks';
    raise exception 'task_deadline_runtime_delete_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'legacy_task_evidence_delete_forbidden' then
      raise;
    end if;
  end;

  begin
    update public.ops_state state
    set payload = (
      select jsonb_agg(
        case when item.value ->> 'id' = 'TSK-DEADLINE-LEGACY'
          then (item.value - 'legacyEvidence') || jsonb_build_object('dueAt', '2026-08-20T08:00:00.000Z')
          else item.value end
        order by item.ordinality
      ) from jsonb_array_elements(state.payload) with ordinality item(value, ordinality)
    ), version = version + 1, updated_by = 'generic writer'
    where entity = 'tasks';
    raise exception 'task_deadline_runtime_generic_manual_thaw_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'legacy_task_manual_thaw_requires_191008_command' then
      raise;
    end if;
  end;

  begin
    update public.ops_state state
    set payload = (
      select jsonb_agg(
        case when item.value ->> 'id' = 'TSK-DEADLINE-CANONICAL'
          then item.value || jsonb_build_object(
            'legacyEvidence', jsonb_build_object(
              'state', 'frozen',
              'reason', 'missing_canonical_due_at',
              'frozenAt', '2026-08-20T01:00:00.000Z'
            )
          )
          else item.value end
        order by item.ordinality
      ) from jsonb_array_elements(state.payload) with ordinality item(value, ordinality)
    ), version = version + 1, updated_by = 'generic writer'
    where entity = 'tasks';
    raise exception 'task_deadline_runtime_forged_marker_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'legacy_task_evidence_not_active' then
      raise;
    end if;
  end;
end;
$task_deadline_freeze_contract$;

do $task_deadline_manual_thaw_contract$
declare
  receipt record;
  task_state public.ops_state%rowtype;
  ledger internal.legacy_task_deadline_freezes%rowtype;
  caught_state text;
  caught_message text;
begin
  select * into receipt
  from public.mutate_legacy_task_deadline_atomic(
    'task-deadline-fixture-secret',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174010',
    jsonb_build_object(
      'action', 'set',
      'taskId', 'TSK-DEADLINE-LEGACY',
      'melbourneDateTime', '2026-08-20T18:00'
    ),
    jsonb_build_object('students', 7, 'tasks', 8),
    'Nixon'
  );
  select * into task_state from public.ops_state where entity = 'tasks';
  select * into ledger from internal.legacy_task_deadline_freezes
  where task_id = 'TSK-DEADLINE-LEGACY';
  if not receipt.applied
     or receipt.due_at <> '2026-08-20T08:00:00.000Z'
     or task_state.version <> 9
     or task_state.payload #>> '{0,dueAt}' <> receipt.due_at
     or task_state.payload #> '{0,legacyEvidence}' is not null
     or ledger.thawed_at is null
     or ledger.thaw_source <> 'legacy_manual'
     or ledger.thaw_actor <> 'Nixon'
     or ledger.thaw_workflow is not null
     or ledger.thaw_due_at <> receipt.due_at
     or ledger.thaw_command_key <> 'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174010' then
    raise exception 'task_deadline_runtime_manual_thaw_ledger_failed';
  end if;

  begin
    update public.ops_state state
    set payload = (
      select jsonb_agg(
        case when item.value ->> 'id' = 'TSK-DEADLINE-LEGACY'
          then item.value || jsonb_build_object(
            'legacyEvidence', jsonb_build_object(
              'state', 'frozen',
              'reason', 'missing_canonical_due_at',
              'frozenAt', '2026-08-20T01:00:00.000Z'
            )
          )
          else item.value end
        order by item.ordinality
      ) from jsonb_array_elements(state.payload) with ordinality item(value, ordinality)
    ), version = version + 1, updated_by = 'generic writer'
    where entity = 'tasks';
    raise exception 'task_deadline_runtime_readded_marker_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'legacy_task_evidence_not_active' then
      raise;
    end if;
  end;

  begin
    perform public.mutate_legacy_task_deadline_atomic(
      'task-deadline-fixture-secret',
      'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174011',
      jsonb_build_object('action', 'clear', 'taskId', 'TSK-DEADLINE-LEGACY'),
      jsonb_build_object('students', 7, 'tasks', 9),
      'Nixon'
    );
    raise exception 'task_deadline_runtime_clear_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '22023' or caught_message <> 'legacy_task_deadline_clear_disabled' then
      raise;
    end if;
  end;

  begin
    perform public.mutate_legacy_task_deadline_atomic(
      'task-deadline-fixture-secret',
      'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174012',
      jsonb_build_object(
        'action', 'set',
        'taskId', 'TSK-DEADLINE-MANAGED',
        'melbourneDateTime', '2026-08-20T19:00'
      ),
      jsonb_build_object('students', 7, 'tasks', 9),
      'Nixon'
    );
    raise exception 'task_deadline_runtime_managed_manual_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '22023' or caught_message <> 'legacy_task_deadline_task_not_legacy' then
      raise;
    end if;
  end;
end;
$task_deadline_manual_thaw_contract$;

do $task_deadline_managed_thaw_contract$
declare
  ledger internal.legacy_task_deadline_freezes%rowtype;
  target_tasks jsonb;
  saved_task_state public.ops_state%rowtype;
  run_outcome text;
  caught_state text;
  caught_message text;
begin
  -- Even an exact dueAt-only repair cannot use the generic app-state path.
  begin
    update public.ops_state state
    set payload = (
      select jsonb_agg(
        case when item.value ->> 'id' = 'TSK-DEADLINE-MANAGED'
          then (item.value - 'legacyEvidence')
            || jsonb_build_object('dueAt', '2026-08-20T10:00:00.000Z')
          else item.value end
        order by item.ordinality
      ) from jsonb_array_elements(state.payload) with ordinality item(value, ordinality)
    ), version = version + 1, updated_by = 'LP Scheduler'
    where entity = 'tasks';
    raise exception 'task_deadline_runtime_generic_managed_thaw_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'managed_task_thaw_requires_authoritative_workflow' then
      raise;
    end if;
  end;

  -- A projection cannot hide a title/owner/recipient change inside a thaw,
  -- even if it claims to be from the workflow actor.
  begin
    update public.ops_state state
    set payload = (
      select jsonb_agg(
        case when item.value ->> 'id' = 'TSK-DEADLINE-MANAGED'
          then (item.value - 'legacyEvidence')
            || jsonb_build_object(
              'dueAt', '2026-08-20T10:00:00.000Z',
              'title', '借解冻篡改标题'
            )
          else item.value end
        order by item.ordinality
      ) from jsonb_array_elements(state.payload) with ordinality item(value, ordinality)
    ), version = version + 1, updated_by = 'LP Scheduler'
    where entity = 'tasks';
    raise exception 'task_deadline_runtime_managed_projection_change_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'managed_task_authoritative_identity_changed' then
      raise;
    end if;
  end;

  select jsonb_agg(
    case when item.value ->> 'id' = 'TSK-DEADLINE-MANAGED'
      then (item.value - 'legacyEvidence')
        || jsonb_build_object('dueAt', '2026-08-20T10:00:00.000Z')
      else item.value end
    order by item.ordinality
  ) into target_tasks
  from public.ops_state state,
    lateral jsonb_array_elements(state.payload) with ordinality item(value, ordinality)
  where state.entity = 'tasks';

  perform public.begin_lp_parent_progress_scheduler_run(
    'task-deadline-fixture-secret',
    'lp-parent-progress:123e4567-e89b-42d3-a456-426614174020',
    repeat('a', 64),
    jsonb_build_object('bookings', 1, 'lpItems', 1, 'tasks', 9),
    9,
    target_tasks,
    1,
    1
  );
  select * into saved_task_state
  from public.put_lp_parent_progress_scheduler_tasks_authoritative(
    'task-deadline-fixture-secret',
    'lp-parent-progress:123e4567-e89b-42d3-a456-426614174020',
    target_tasks,
    'LP Scheduler'
  );

  select * into ledger from internal.legacy_task_deadline_freezes
  where task_id = 'TSK-DEADLINE-MANAGED';
  select outcome into run_outcome
  from internal.lp_parent_progress_scheduler_runs
  where run_key = 'lp-parent-progress:123e4567-e89b-42d3-a456-426614174020';
  if ledger.thawed_at is null
     or ledger.thaw_source <> 'managed_workflow'
     or ledger.thaw_actor <> 'LP Scheduler'
     or ledger.thaw_workflow <> 'lp-parent-progress'
     or ledger.thaw_due_at <> '2026-08-20T10:00:00.000Z'
     or ledger.thaw_command_key <> 'lp-parent-progress:123e4567-e89b-42d3-a456-426614174020'
     or saved_task_state.version <> 10
     or run_outcome <> 'applied' then
    raise exception 'task_deadline_runtime_managed_thaw_ledger_failed';
  end if;

  begin
    update public.ops_state state
    set payload = (
      select jsonb_agg(item.value order by item.ordinality)
      from jsonb_array_elements(state.payload) with ordinality item(value, ordinality)
      where item.value ->> 'id' <> 'TSK-DEADLINE-MANAGED'
    ), version = version + 1, updated_by = 'LP Scheduler'
    where entity = 'tasks';
    raise exception 'task_deadline_runtime_thawed_delete_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'legacy_task_evidence_delete_forbidden' then
      raise;
    end if;
  end;

  begin
    update public.ops_state state
    set payload = payload || jsonb_build_array(jsonb_build_object(
      'id', 'TSK-DEADLINE-NEW-BAD',
      'title', '新坏任务',
      'owner', 'Abby',
      'studentId', 'STU-DEADLINE',
      'due', '发布后立即',
      'status', 'waiting'
    )), version = version + 1, updated_by = 'generic writer'
    where entity = 'tasks';
    raise exception 'task_deadline_runtime_new_bad_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '22023' or caught_message <> 'open_task_requires_canonical_due_at' then
      raise;
    end if;
  end;
end;
$task_deadline_managed_thaw_contract$;

rollback;
