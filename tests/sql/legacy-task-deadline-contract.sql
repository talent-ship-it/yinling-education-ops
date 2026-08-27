\set ON_ERROR_STOP on

-- Disposable execution contract for the manual legacy-task deadline repair.
--
-- Run only against a local/staging database that has public.ops_state and the
-- operational audit baseline. The entire schema/data exercise rolls back:
--   psql ... -f tests/sql/legacy-task-deadline-contract.sql

begin;

-- Some small local baselines intentionally omit the mutation receipt table.
-- Production has it; this transaction-local fallback lets the command body
-- run end-to-end without weakening the production migration.
create table if not exists public.ops_mutation_log (
  entity text not null,
  version bigint not null,
  actor text not null
);

\ir ../../supabase/migrations/20260819100800_manual_legacy_task_deadline_atomic.sql

-- `ileaudit` intentionally has a minimal audit stub. Mirror the production
-- writer inside this rollback-only transaction so every deadline ledger row
-- points at a real immutable audit receipt, as it must in production.
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
  if nullif(trim(p_action), '') is null
     or nullif(trim(p_actor), '') is null
     or nullif(trim(p_target_type), '') is null
     or nullif(trim(p_target_id), '') is null
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_audit_entry';
  end if;

  insert into internal.operational_contract_audit (
    action, actor, target_type, target_id, metadata
  ) values (
    left(trim(p_action), 120),
    left(trim(p_actor), 120),
    left(trim(p_target_type), 80),
    left(trim(p_target_id), 240),
    coalesce(p_metadata, '{}'::jsonb)
  ) returning id into saved_id;

  return saved_id;
end;
$fixture_append_operational_contract_audit$;

-- The fixture never uses an operational secret. Rollback restores the local
-- verifier definition after exercising the ordinary secret-gated RPC body.
create or replace function internal.verify_ops_secret(p_secret text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_secret = 'legacy-task-deadline-fixture-secret';
$$;

do $legacy_task_deadline_contract$
declare
  set_receipt record;
  replay_receipt record;
  identical_receipt record;
  identical_lookup_receipt record;
  identical_replay_receipt record;
  clear_receipt record;
  missing_clear_receipt record;
  missing_clear_lookup_receipt record;
  missing_clear_replay_receipt record;
  current_task_row public.ops_state%rowtype;
  audit_count bigint;
  ledger_count bigint;
  current_students_version bigint;
  current_tasks_version bigint;
  caught_state text;
  caught_message text;
begin
  insert into public.ops_state (entity, payload, version, updated_by) values
    ('students', jsonb_build_array(jsonb_build_object(
      'id', 'STU-LEGACY-FIXTURE', 'name', 'Fixture Student', 'status', '在读'
    )), 7, 'Fixture'),
    ('tasks', jsonb_build_array(jsonb_build_object(
      'id', 'TSK-LEGACY-FIXTURE',
      'title', '核对历史交接信息',
      'owner', 'Abby',
      'studentId', 'STU-LEGACY-FIXTURE',
      'due', '发布后立即',
      'status', 'waiting',
      'tone', 'red',
      'category', 'LP',
      'trigger', '历史导入'
    )), 7, 'Fixture')
  on conflict (entity) do update set
    payload = excluded.payload,
    version = excluded.version,
    updated_at = clock_timestamp(),
    updated_by = excluded.updated_by;

  select * into set_receipt
  from public.mutate_legacy_task_deadline_atomic(
    'legacy-task-deadline-fixture-secret',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174000',
    jsonb_build_object(
      'action', 'set',
      'taskId', 'TSK-LEGACY-FIXTURE',
      'melbourneDateTime', '2026-08-19T18:00'
    ),
    jsonb_build_object('students', 7, 'tasks', 7),
    'Nixon'
  );
  if not set_receipt.applied
     or set_receipt.due_at <> '2026-08-19T08:00:00.000Z'
     or (set_receipt.task_row).version <> 8
     or set_receipt.audit_entry_id is null then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_set_receipt_failed';
  end if;

  select * into current_task_row from public.ops_state where entity = 'tasks';
  if current_task_row.version <> 8
     or current_task_row.payload #>> '{0,due}' <> '发布后立即'
     or current_task_row.payload #>> '{0,dueAt}' <> '2026-08-19T08:00:00.000Z'
     or current_task_row.payload #>> '{0,status}' <> 'waiting' then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_projection_changed_more_than_due_at';
  end if;

  -- Replay intentionally carries obsolete OCC versions; ledger identity must
  -- win after both state rows are locked and must not add a second audit row.
  select * into replay_receipt
  from public.mutate_legacy_task_deadline_atomic(
    'legacy-task-deadline-fixture-secret',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174000',
    jsonb_build_object(
      'action', 'set',
      'taskId', 'TSK-LEGACY-FIXTURE',
      'melbourneDateTime', '2026-08-19T18:00'
    ),
    jsonb_build_object('students', 1, 'tasks', 1),
    'Nixon'
  );
  if replay_receipt.applied
     or replay_receipt.due_at <> set_receipt.due_at
     or (replay_receipt.task_row).version <> 8
     or replay_receipt.audit_entry_id <> set_receipt.audit_entry_id then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_replay_failed';
  end if;

  -- An already-identical set is still a first-class command: it must receive
  -- one audit/ledger receipt without incrementing the task version.
  select * into identical_receipt
  from public.mutate_legacy_task_deadline_atomic(
    'legacy-task-deadline-fixture-secret',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174002',
    jsonb_build_object(
      'action', 'set',
      'taskId', 'TSK-LEGACY-FIXTURE',
      'melbourneDateTime', '2026-08-19T18:00'
    ),
    jsonb_build_object('students', 7, 'tasks', 8),
    'Nixon'
  );
  if identical_receipt.applied
     or identical_receipt.due_at <> '2026-08-19T08:00:00.000Z'
     or (identical_receipt.task_row).version <> 8
     or identical_receipt.audit_entry_id is null then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_set_identical_receipt_failed';
  end if;
  update public.ops_state set
    payload = jsonb_set(payload, '{0,title}', to_jsonb('后续工作流修改'::text)),
    version = version + 1,
    updated_at = clock_timestamp(),
    updated_by = 'Fixture workflow'
  where entity = 'tasks';
  select * into identical_lookup_receipt
  from public.get_legacy_task_deadline_command_result(
    'legacy-task-deadline-fixture-secret',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174002',
    jsonb_build_object(
      'action', 'set',
      'taskId', 'TSK-LEGACY-FIXTURE',
      'melbourneDateTime', '2026-08-19T18:00'
    ),
    'Nixon'
  );
  if identical_lookup_receipt.applied
     or identical_lookup_receipt.audit_entry_id <> identical_receipt.audit_entry_id then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_set_identical_lookup_failed';
  end if;
  select * into identical_replay_receipt
  from public.mutate_legacy_task_deadline_atomic(
    'legacy-task-deadline-fixture-secret',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174002',
    jsonb_build_object(
      'action', 'set',
      'taskId', 'TSK-LEGACY-FIXTURE',
      'melbourneDateTime', '2026-08-19T18:00'
    ),
    jsonb_build_object('students', 1, 'tasks', 1),
    'Nixon'
  );
  if identical_replay_receipt.applied
     or (identical_replay_receipt.task_row).version <> 9
     or identical_replay_receipt.audit_entry_id <> identical_receipt.audit_entry_id then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_set_identical_replay_failed';
  end if;

  select * into clear_receipt
  from public.mutate_legacy_task_deadline_atomic(
    'legacy-task-deadline-fixture-secret',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174001',
    jsonb_build_object('action', 'clear', 'taskId', 'TSK-LEGACY-FIXTURE'),
    jsonb_build_object('students', 7, 'tasks', 9),
    'Ops Admin'
  );
  if not clear_receipt.applied
     or clear_receipt.due_at is not null
     or (clear_receipt.task_row).version <> 10 then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_clear_receipt_failed';
  end if;
  select * into current_task_row from public.ops_state where entity = 'tasks';
  if current_task_row.payload #>> '{0,due}' <> '发布后立即'
     or current_task_row.payload #> '{0,dueAt}' is not null
     or current_task_row.payload #>> '{0,status}' <> 'waiting' then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_clear_projection_failed';
  end if;

  -- Clearing an absent dueAt gets the same immutable no-op receipt guarantee.
  select * into missing_clear_receipt
  from public.mutate_legacy_task_deadline_atomic(
    'legacy-task-deadline-fixture-secret',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174003',
    jsonb_build_object('action', 'clear', 'taskId', 'TSK-LEGACY-FIXTURE'),
    jsonb_build_object('students', 7, 'tasks', 10),
    'Ops Admin'
  );
  if missing_clear_receipt.applied
     or (missing_clear_receipt.task_row).version <> 10
     or missing_clear_receipt.audit_entry_id is null then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_clear_missing_receipt_failed';
  end if;
  update public.ops_state set
    payload = jsonb_set(payload, '{0,title}', to_jsonb('后来再次变更'::text)),
    version = version + 1,
    updated_at = clock_timestamp(),
    updated_by = 'Fixture workflow'
  where entity = 'tasks';
  select * into missing_clear_lookup_receipt
  from public.get_legacy_task_deadline_command_result(
    'legacy-task-deadline-fixture-secret',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174003',
    jsonb_build_object('action', 'clear', 'taskId', 'TSK-LEGACY-FIXTURE'),
    'Ops Admin'
  );
  if missing_clear_lookup_receipt.applied
     or missing_clear_lookup_receipt.audit_entry_id <> missing_clear_receipt.audit_entry_id then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_clear_missing_lookup_failed';
  end if;
  select * into missing_clear_replay_receipt
  from public.mutate_legacy_task_deadline_atomic(
    'legacy-task-deadline-fixture-secret',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174003',
    jsonb_build_object('action', 'clear', 'taskId', 'TSK-LEGACY-FIXTURE'),
    jsonb_build_object('students', 1, 'tasks', 1),
    'Ops Admin'
  );
  if missing_clear_replay_receipt.applied
     or (missing_clear_replay_receipt.task_row).version <> 11
     or missing_clear_replay_receipt.audit_entry_id <> missing_clear_receipt.audit_entry_id then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_clear_missing_replay_failed';
  end if;

  -- The public RPC is intentionally secret-gated even though its execution
  -- grant is needed by the server-side PostgREST client.
  begin
    perform public.mutate_legacy_task_deadline_atomic(
      'wrong-fixture-secret',
      'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174004',
      jsonb_build_object(
        'action', 'set',
        'taskId', 'TSK-LEGACY-FIXTURE',
        'melbourneDateTime', '2026-08-19T18:00'
      ),
      jsonb_build_object('students', 7, 'tasks', 11),
      'Nixon'
    );
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_bad_secret_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'invalid_ops_secret' then
      raise;
    end if;
  end;

  -- A command key is immutable: changing its time after a successful write
  -- must fail even when replay is allowed to bypass obsolete OCC versions.
  begin
    perform public.mutate_legacy_task_deadline_atomic(
      'legacy-task-deadline-fixture-secret',
      'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174000',
      jsonb_build_object(
        'action', 'set',
        'taskId', 'TSK-LEGACY-FIXTURE',
        'melbourneDateTime', '2026-08-19T19:00'
      ),
      jsonb_build_object('students', 1, 'tasks', 1),
      'Nixon'
    );
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_idempotency_conflict_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '23505' or caught_message <> 'legacy_task_deadline_idempotency_conflict' then
      raise;
    end if;
  end;

  -- The database repeats every eligibility guard under the state-row locks;
  -- these direct RPC calls prove a browser/service pre-check cannot bypass it.
  update public.ops_state set
    payload = jsonb_set(payload, '{0,ruleKey}', to_jsonb('fixture-rule'::text), true),
    version = version + 1,
    updated_at = clock_timestamp(),
    updated_by = 'Fixture workflow'
  where entity = 'tasks';
  select version into current_students_version from public.ops_state where entity = 'students';
  select version into current_tasks_version from public.ops_state where entity = 'tasks';
  begin
    perform public.mutate_legacy_task_deadline_atomic(
      'legacy-task-deadline-fixture-secret',
      'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174004',
      jsonb_build_object(
        'action', 'set',
        'taskId', 'TSK-LEGACY-FIXTURE',
        'melbourneDateTime', '2026-08-19T18:00'
      ),
      jsonb_build_object('students', current_students_version, 'tasks', current_tasks_version),
      'Nixon'
    );
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_managed_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '22023' or caught_message <> 'legacy_task_deadline_task_not_legacy' then
      raise;
    end if;
  end;

  update public.ops_state set
    payload = jsonb_set(payload #- '{0,ruleKey}', '{0,status}', to_jsonb('done'::text), true),
    version = version + 1,
    updated_at = clock_timestamp(),
    updated_by = 'Fixture workflow'
  where entity = 'tasks';
  select version into current_students_version from public.ops_state where entity = 'students';
  select version into current_tasks_version from public.ops_state where entity = 'tasks';
  begin
    perform public.mutate_legacy_task_deadline_atomic(
      'legacy-task-deadline-fixture-secret',
      'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174005',
      jsonb_build_object(
        'action', 'set',
        'taskId', 'TSK-LEGACY-FIXTURE',
        'melbourneDateTime', '2026-08-19T18:00'
      ),
      jsonb_build_object('students', current_students_version, 'tasks', current_tasks_version),
      'Nixon'
    );
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_done_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '22023' or caught_message <> 'legacy_task_deadline_task_closed' then
      raise;
    end if;
  end;

  update public.ops_state set
    payload = jsonb_set(payload, '{0,status}', to_jsonb('waiting'::text), true),
    version = version + 1,
    updated_at = clock_timestamp(),
    updated_by = 'Fixture workflow'
  where entity = 'tasks';
  update public.ops_state set
    payload = jsonb_set(payload, '{0,importArchived}', 'true'::jsonb, true),
    version = version + 1,
    updated_at = clock_timestamp(),
    updated_by = 'Fixture workflow'
  where entity = 'students';
  select version into current_students_version from public.ops_state where entity = 'students';
  select version into current_tasks_version from public.ops_state where entity = 'tasks';
  begin
    perform public.mutate_legacy_task_deadline_atomic(
      'legacy-task-deadline-fixture-secret',
      'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174006',
      jsonb_build_object(
        'action', 'set',
        'taskId', 'TSK-LEGACY-FIXTURE',
        'melbourneDateTime', '2026-08-19T18:00'
      ),
      jsonb_build_object('students', current_students_version, 'tasks', current_tasks_version),
      'Nixon'
    );
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_archived_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '42501' or caught_message <> 'legacy_task_deadline_archived_student' then
      raise;
    end if;
  end;

  select count(*) into audit_count
  from internal.operational_contract_audit
  where action in (
    'legacy_task_deadline.set',
    'legacy_task_deadline.set_unchanged',
    'legacy_task_deadline.cleared',
    'legacy_task_deadline.clear_missing'
  )
    and target_id = 'TSK-LEGACY-FIXTURE';
  if audit_count <> 4 then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_audit_count_failed';
  end if;
  select count(*) into ledger_count
  from internal.legacy_task_deadline_commands
  where command_key in (
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174000',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174001',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174002',
    'legacy-task-deadline:123e4567-e89b-42d3-a456-426614174003'
  );
  if ledger_count <> 4 then
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_rejected_commands_created_receipt';
  end if;

  -- The direct SQL conversion independently rejects both seasonal edge cases.
  begin
    perform internal.legacy_task_deadline_melbourne_instant('2026-10-04T02:30');
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_dst_gap_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '22023' or caught_message <> 'legacy_task_deadline_melbourne_time_nonexistent' then
      raise;
    end if;
  end;
  begin
    perform internal.legacy_task_deadline_melbourne_instant('2026-04-05T02:30');
    raise exception using errcode = 'P0001', message = 'legacy_task_deadline_dst_overlap_not_rejected';
  exception when others then
    get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text;
    if caught_state <> '22023' or caught_message <> 'legacy_task_deadline_melbourne_time_ambiguous' then
      raise;
    end if;
  end;
end;
$legacy_task_deadline_contract$;

rollback;
