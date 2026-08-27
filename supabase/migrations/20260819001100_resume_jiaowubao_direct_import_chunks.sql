-- The initial direct-import contract deliberately used one client-owned
-- transaction. Production profiling showed that holding every staged chunk in
-- that transaction makes a healthy, reviewed import vulnerable to a client
-- deadline even after the set-based 010 materializer. This migration keeps
-- each bounded chunk atomic, but lets a trusted CLI commit it and resume the
-- exact same immutable run later. Readers continue to select complete runs
-- only, so committed staging evidence remains invisible to application reads.
--
-- It also replaces the per-row schedule/participant INSERT guards that
-- dominated the 40k-row schedule stage. Statement-level guards use transition
-- tables, lock each distinct parent run once, and retain the complete attached
-- identity/name proof. UPDATE remains immutable; DELETE is permitted only for
-- the controlled aborted-run cleanup path below.

set local lock_timeout = '1s';

alter table internal.jiaowubao_direct_import_runs
  add column if not exists aborted_at timestamptz,
  add column if not exists abort_audit_id uuid
    references internal.operational_contract_audit(id);

-- The original unnamed checks have PostgreSQL's deterministic default names.
-- Re-state them explicitly so historical complete rows remain valid while an
-- aborted run preserves its audit boundary without retaining raw source data.
alter table internal.jiaowubao_direct_import_runs
  drop constraint if exists jiaowubao_direct_import_runs_state_check;
alter table internal.jiaowubao_direct_import_runs
  add constraint jiaowubao_direct_import_runs_state_check
  check (state in ('staging', 'complete', 'aborted'));

alter table internal.jiaowubao_direct_import_runs
  drop constraint if exists jiaowubao_direct_import_runs_check;
alter table internal.jiaowubao_direct_import_runs
  add constraint jiaowubao_direct_import_runs_lifecycle_check check (
    (state = 'staging'
      and payload_sha256 is null
      and completed_at is null
      and completion_audit_id is null
      and aborted_at is null
      and abort_audit_id is null)
    or (state = 'complete'
      and payload_sha256 is not null
      and completed_at is not null
      and completion_audit_id is not null
      and aborted_at is null
      and abort_audit_id is null)
    or (state = 'aborted'
      and payload_sha256 is null
      and completed_at is null
      and completion_audit_id is null
      and aborted_at is not null
      and abort_audit_id is not null)
  );

-- Keep one active or completed immutable artifact per source revision while
-- allowing a cleanup-marked failed attempt to remain auditable and a fresh
-- attempt with the same reviewed revision to start afterwards.
alter table internal.jiaowubao_direct_import_runs
  drop constraint if exists jiaowubao_direct_import_runs_source_id_revision_key;
create unique index if not exists jiaowubao_direct_import_runs_active_revision_key
  on internal.jiaowubao_direct_import_runs (source_id, revision)
  where state in ('staging', 'complete');

create or replace function internal.jiaowubao_direct_import_assert_aborted(
  p_run_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_aborted$
declare
  saved_state text;
begin
  select run_state.state into saved_state
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_run_not_found';
  end if;
  if saved_state <> 'aborted' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_abort_cleanup_forbidden';
  end if;
  if current_setting('internal.jiaowubao_direct_import_abort_run_id', true)
       is distinct from p_run_id::text then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_abort_cleanup_forbidden';
  end if;
end;
$jiaowubao_direct_import_assert_aborted$;

revoke all on function internal.jiaowubao_direct_import_assert_aborted(uuid)
  from public, anon, authenticated;

-- Begin remains idempotent for the exact reviewed envelope and actor. The
-- active partial unique index makes this lookup unambiguous even after an old
-- aborted attempt with the same revision is retained for audit.
create or replace function internal.begin_jiaowubao_direct_import(
  p_envelope jsonb,
  p_actor text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $begin_jiaowubao_direct_import$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  current_master internal.student_import_source_rows%rowtype;
  audit_id uuid;
  created_run_id uuid := gen_random_uuid();
begin
  perform internal.jiaowubao_direct_import_assert_envelope(p_envelope);
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or char_length(p_actor) > 120 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('jiaowubao-direct-import:' || (p_envelope ->> 'sourceId') || ':' || (p_envelope ->> 'revision'))
  );
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.source_id = p_envelope ->> 'sourceId'
    and run_state.revision = p_envelope ->> 'revision'
    and run_state.state in ('staging', 'complete')
  for update;
  if found then
    if saved_run.format <> p_envelope ->> 'format'
       or saved_run.source_timezone <> p_envelope ->> 'sourceTimezone'
       or saved_run.source_timezone_basis <> p_envelope ->> 'sourceTimezoneBasis'
       or saved_run.master_source_id <> p_envelope -> 'masterSource' ->> 'sourceId'
       or saved_run.master_revision <> p_envelope -> 'masterSource' ->> 'revision'
       or saved_run.master_rows_sha256 <> p_envelope -> 'masterSource' ->> 'rowsSha256'
       or saved_run.expected_chunk_count <> (p_envelope ->> 'chunkCount')::integer
       or saved_run.source_record_counts is distinct from p_envelope -> 'recordCounts'
       or saved_run.expected_counts is distinct from p_envelope -> 'expectedCounts'
       or saved_run.staged_by <> p_actor
       or exists (
         select 1
         from jsonb_array_elements(p_envelope -> 'workbooks') workbook(value)
         full join internal.jiaowubao_direct_import_workbooks stored
           on stored.run_id = saved_run.id
          and stored.workbook_kind = workbook.value ->> 'kind'
         where workbook.value is null
            or stored.run_id is null
            or stored.workbook_name <> workbook.value ->> 'workbookName'
            or stored.workbook_sha256 <> workbook.value ->> 'workbookSha256'
            or stored.sheet_name <> workbook.value ->> 'sheetName'
            or stored.row_count <> (workbook.value ->> 'sourceRecordCount')::integer
       ) then
      raise exception using errcode = '23505', message = 'jiaowubao_direct_import_envelope_conflict';
    end if;
    return saved_run.id;
  end if;

  -- A staging chunk commits independently, so do not hold a Tencent-source
  -- lock while it is being uploaded. Completion takes the definitive short
  -- lock and verifies this exact source/revision/hash again before publish.
  select * into current_master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master';
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_master_source_unavailable';
  end if;
  if current_master.source_id <> p_envelope -> 'masterSource' ->> 'sourceId'
     or current_master.revision <> p_envelope -> 'masterSource' ->> 'revision'
     or current_master.rows_sha256 <> p_envelope -> 'masterSource' ->> 'rowsSha256' then
    raise exception using errcode = '40900', message = 'jiaowubao_direct_import_master_source_changed';
  end if;

  audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.started', p_actor,
    'jiaowubao_direct_import_run', created_run_id::text,
    jsonb_build_object(
      'sourceId', p_envelope ->> 'sourceId',
      'revision', p_envelope ->> 'revision',
      'chunkCount', (p_envelope ->> 'chunkCount')::integer,
      'recordCounts', p_envelope -> 'recordCounts',
      'expectedCounts', p_envelope -> 'expectedCounts',
      'masterSourceId', p_envelope -> 'masterSource' ->> 'sourceId',
      'masterRevision', p_envelope -> 'masterSource' ->> 'revision',
      'masterRowsSha256', p_envelope -> 'masterSource' ->> 'rowsSha256'
    )
  );
  insert into internal.jiaowubao_direct_import_runs (
    id, source_id, revision, format, source_timezone, source_timezone_basis,
    master_source_id, master_revision, master_rows_sha256, expected_chunk_count,
    source_record_counts, expected_counts, staged_by, staging_audit_id
  ) values (
    created_run_id,
    p_envelope ->> 'sourceId', p_envelope ->> 'revision', p_envelope ->> 'format',
    p_envelope ->> 'sourceTimezone', p_envelope ->> 'sourceTimezoneBasis',
    p_envelope -> 'masterSource' ->> 'sourceId',
    p_envelope -> 'masterSource' ->> 'revision',
    p_envelope -> 'masterSource' ->> 'rowsSha256',
    (p_envelope ->> 'chunkCount')::integer,
    p_envelope -> 'recordCounts', p_envelope -> 'expectedCounts', p_actor, audit_id
  );
  insert into internal.jiaowubao_direct_import_workbooks (
    run_id, workbook_kind, workbook_name, workbook_sha256, sheet_name, row_count
  )
  select
    created_run_id,
    workbook.value ->> 'kind',
    workbook.value ->> 'workbookName',
    workbook.value ->> 'workbookSha256',
    workbook.value ->> 'sheetName',
    (workbook.value ->> 'sourceRecordCount')::integer
  from jsonb_array_elements(p_envelope -> 'workbooks') workbook(value);
  return created_run_id;
end;
$begin_jiaowubao_direct_import$;

revoke all on function internal.begin_jiaowubao_direct_import(jsonb, text)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_run_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_run_guard$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_run_read_only';
  end if;

  if tg_op = 'INSERT' then
    if new.state <> 'staging'
       or new.payload_sha256 is not null
       or new.staging_audit_id is null
       or new.completed_at is not null
       or new.completion_audit_id is not null
       or new.aborted_at is not null
       or new.abort_audit_id is not null then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_run_must_start_staging';
    end if;
    return new;
  end if;

  if old.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_run_read_only';
  end if;
  if new.id is distinct from old.id
     or new.source_id is distinct from old.source_id
     or new.revision is distinct from old.revision
     or new.format is distinct from old.format
     or new.source_timezone is distinct from old.source_timezone
     or new.source_timezone_basis is distinct from old.source_timezone_basis
     or new.master_source_id is distinct from old.master_source_id
     or new.master_revision is distinct from old.master_revision
     or new.master_rows_sha256 is distinct from old.master_rows_sha256
     or new.expected_chunk_count is distinct from old.expected_chunk_count
     or new.source_record_counts is distinct from old.source_record_counts
     or new.expected_counts is distinct from old.expected_counts
     or new.staged_by is distinct from old.staged_by
     or new.staged_at is distinct from old.staged_at
     or new.staging_audit_id is distinct from old.staging_audit_id
     or new.state not in ('complete', 'aborted') then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_run_invalid_transition';
  end if;

  if new.state = 'complete' then
    if new.payload_sha256 is null
       or new.completed_at is null
       or new.completion_audit_id is null
       or new.aborted_at is not null
       or new.abort_audit_id is not null then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_run_invalid_transition';
    end if;
    perform internal.jiaowubao_direct_import_assert_complete(old.id);
    if not exists (
      select 1
      from internal.operational_contract_audit audit_entry
      where audit_entry.id = new.completion_audit_id
        and audit_entry.action = 'jiaowubao_direct_import.completed'
        and audit_entry.actor = old.staged_by
        and audit_entry.target_type = 'jiaowubao_direct_import_run'
        and audit_entry.target_id = old.id::text
        and audit_entry.metadata ->> 'sourceId' = old.source_id
        and audit_entry.metadata ->> 'revision' = old.revision
        and audit_entry.metadata ->> 'payloadSha256' = new.payload_sha256
        and audit_entry.metadata ->> 'masterSourceId' = old.master_source_id
        and audit_entry.metadata ->> 'masterRevision' = old.master_revision
        and audit_entry.metadata ->> 'masterRowsSha256' = old.master_rows_sha256
    ) then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_completion_audit_invalid';
    end if;
    return new;
  end if;

  if new.payload_sha256 is not null
     or new.completed_at is not null
     or new.completion_audit_id is not null
     or new.aborted_at is null
     or new.abort_audit_id is null then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_run_invalid_transition';
  end if;
  if current_setting('internal.jiaowubao_direct_import_abort_run_id', true)
       is distinct from old.id::text then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_abort_cleanup_forbidden';
  end if;
  if not exists (
    select 1
    from internal.operational_contract_audit audit_entry
    where audit_entry.id = new.abort_audit_id
      and audit_entry.action = 'jiaowubao_direct_import.aborted'
      and audit_entry.actor = old.staged_by
      and audit_entry.target_type = 'jiaowubao_direct_import_run'
      and audit_entry.target_id = old.id::text
      and audit_entry.metadata ->> 'sourceId' = old.source_id
      and audit_entry.metadata ->> 'revision' = old.revision
      and audit_entry.metadata ->> 'masterSourceId' = old.master_source_id
      and audit_entry.metadata ->> 'masterRevision' = old.master_revision
      and audit_entry.metadata ->> 'masterRowsSha256' = old.master_rows_sha256
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_abort_audit_invalid';
  end if;
  return new;
end;
$jiaowubao_direct_import_run_guard$;

revoke all on function internal.jiaowubao_direct_import_run_guard()
  from public, anon, authenticated;

create or replace function internal.abort_jiaowubao_direct_import(
  p_run_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $abort_jiaowubao_direct_import$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  abort_audit_entry_id uuid;
  participant_rows integer := 0;
  schedule_rows integer := 0;
  supplemental_rows integer := 0;
  leave_makeup_rows integer := 0;
  chunk_rows integer := 0;
  workbook_rows integer := 0;
begin
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or char_length(p_actor) > 120 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_invalid';
  end if;

  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_run_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('jiaowubao-direct-import:' || saved_run.source_id || ':' || saved_run.revision)
  );
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;
  if saved_run.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_run_not_staging';
  end if;
  if saved_run.staged_by <> p_actor then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_mismatch';
  end if;

  -- This transaction-local capability is not an authorization mechanism for a
  -- superuser; it binds the otherwise immutable state transition and every
  -- child DELETE guard to this one internal cleanup function. It disappears
  -- automatically on commit or rollback and prevents a hand-written aborted
  -- transition from releasing the active-revision slot while raw rows remain.
  perform set_config('internal.jiaowubao_direct_import_abort_run_id', p_run_id::text, true);

  abort_audit_entry_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.aborted', p_actor,
    'jiaowubao_direct_import_run', p_run_id::text,
    jsonb_build_object(
      'sourceId', saved_run.source_id,
      'revision', saved_run.revision,
      'masterSourceId', saved_run.master_source_id,
      'masterRevision', saved_run.master_revision,
      'masterRowsSha256', saved_run.master_rows_sha256,
      'stagedChunkCount', (
        select count(*)::integer
        from internal.jiaowubao_direct_import_chunks chunk
        where chunk.run_id = p_run_id
      )
    )
  );
  update internal.jiaowubao_direct_import_runs run_state
  set state = 'aborted', aborted_at = now(), abort_audit_id = abort_audit_entry_id
  where run_state.id = p_run_id;

  delete from internal.jiaowubao_direct_schedule_event_participants participant
  using internal.jiaowubao_direct_schedule_events schedule_event
  where participant.event_id = schedule_event.id
    and schedule_event.run_id = p_run_id;
  get diagnostics participant_rows = row_count;

  delete from internal.jiaowubao_direct_schedule_events schedule_event
  where schedule_event.run_id = p_run_id;
  get diagnostics schedule_rows = row_count;

  delete from internal.jiaowubao_direct_supplemental_records supplemental_record
  where supplemental_record.run_id = p_run_id;
  get diagnostics supplemental_rows = row_count;

  delete from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
  where leave_makeup_event.run_id = p_run_id;
  get diagnostics leave_makeup_rows = row_count;

  delete from internal.jiaowubao_direct_import_chunks chunk
  where chunk.run_id = p_run_id;
  get diagnostics chunk_rows = row_count;

  delete from internal.jiaowubao_direct_import_workbooks workbook
  where workbook.run_id = p_run_id;
  get diagnostics workbook_rows = row_count;

  return jsonb_build_object(
    'runId', p_run_id,
    'state', 'aborted',
    'cleared', jsonb_build_object(
      'scheduleParticipants', participant_rows,
      'scheduleEvents', schedule_rows,
      'supplementalRecords', supplemental_rows,
      'leaveMakeups', leave_makeup_rows,
      'chunks', chunk_rows,
      'workbooks', workbook_rows
    )
  );
end;
$abort_jiaowubao_direct_import$;

revoke all on function internal.abort_jiaowubao_direct_import(uuid, text)
  from public, anon, authenticated;

-- Imported schedule events have no per-row authority proof; their only write
-- precondition is that the parent run is still staging. Check that once for
-- the whole INSERT transition relation rather than taking the same run lock
-- once per event.
create or replace function internal.jiaowubao_direct_import_schedule_insert_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_schedule_insert_guard$
declare
  parent_run_id uuid;
begin
  for parent_run_id in
    select distinct inserted_schedule_event.run_id
    from inserted_schedule_events inserted_schedule_event
    order by inserted_schedule_event.run_id
  loop
    perform internal.jiaowubao_direct_import_assert_staging(parent_run_id);
  end loop;
  return null;
end;
$jiaowubao_direct_import_schedule_insert_guard$;

revoke all on function internal.jiaowubao_direct_import_schedule_insert_guard()
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_schedule_mutation_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_schedule_mutation_guard$
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_schedule_read_only';
  end if;
  perform internal.jiaowubao_direct_import_assert_aborted(old.run_id);
  return old;
end;
$jiaowubao_direct_import_schedule_mutation_guard$;

revoke all on function internal.jiaowubao_direct_import_schedule_mutation_guard()
  from public, anon, authenticated;

-- The old participant guard took an event lookup, a parent-run lock, and a
-- possible identity row lock for every row. The transition table lets us take
-- each parent run lock once, retain name evidence validation, and compare all
-- attached rows to their selected canonical identity in one set-based query.
create or replace function internal.jiaowubao_direct_import_participant_insert_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_participant_insert_guard$
declare
  parent_run_id uuid;
begin
  if exists (
    select 1
    from inserted_schedule_participant inserted_participant
    left join internal.jiaowubao_direct_schedule_events schedule_event
      on schedule_event.id = inserted_participant.event_id
    where schedule_event.id is null
  ) then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_schedule_event_not_found';
  end if;

  -- Deterministic ordering avoids lock-order inversions for any future
  -- privileged statement that legitimately inserts rows for multiple runs.
  for parent_run_id in
    select distinct schedule_event.run_id
    from inserted_schedule_participant inserted_participant
    join internal.jiaowubao_direct_schedule_events schedule_event
      on schedule_event.id = inserted_participant.event_id
    order by schedule_event.run_id
  loop
    perform internal.jiaowubao_direct_import_assert_staging(parent_run_id);
  end loop;

  -- Keep the old diagnostic ordering: source-display-name evidence is checked
  -- before the selected supplemental identity is evaluated.
  if exists (
    select 1
    from inserted_schedule_participant inserted_participant
    where inserted_participant.resolution_state = 'attached'
      and (
        nullif(btrim(inserted_participant.source_display_name), '') is null
        or internal.student_import_name_key(inserted_participant.source_display_name) <>
           internal.student_import_name_key(inserted_participant.evidence_name)
        or not exists (
          select 1
          from jsonb_array_elements_text(
            coalesce(inserted_participant.source_payload #> '{source,studentDisplayNames}', '[]'::jsonb)
          ) source_name(value)
          where internal.student_import_name_key(source_name.value) =
                internal.student_import_name_key(inserted_participant.source_display_name)
        )
      )
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_name_evidence_invalid';
  end if;

  if exists (
    select 1
    from inserted_schedule_participant inserted_participant
    join internal.jiaowubao_direct_schedule_events schedule_event
      on schedule_event.id = inserted_participant.event_id
    left join internal.jiaowubao_direct_supplemental_records identity_record
      on identity_record.id = inserted_participant.identity_supplemental_record_id
    where inserted_participant.resolution_state = 'attached'
      and (
        identity_record.id is null
        or identity_record.run_id <> schedule_event.run_id
        or identity_record.resolution_state <> 'attached'
        or identity_record.identity_proof is not true
        or nullif(btrim(identity_record.evidence_phone), '') is null
        or identity_record.student_id is distinct from inserted_participant.student_id
        or identity_record.master_source_row is distinct from inserted_participant.master_source_row
        or internal.student_import_name_key(identity_record.evidence_name) <>
           internal.student_import_name_key(inserted_participant.evidence_name)
        or internal.student_import_name_key(identity_record.evidence_name) <>
           internal.student_import_name_key(inserted_participant.source_display_name)
      )
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_identity_invalid';
  end if;
  return null;
end;
$jiaowubao_direct_import_participant_insert_guard$;

revoke all on function internal.jiaowubao_direct_import_participant_insert_guard()
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_participant_mutation_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_participant_mutation_guard$
declare
  parent_run_id uuid;
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_participant_read_only';
  end if;
  select schedule_event.run_id into parent_run_id
  from internal.jiaowubao_direct_schedule_events schedule_event
  where schedule_event.id = old.event_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_schedule_event_not_found';
  end if;
  perform internal.jiaowubao_direct_import_assert_aborted(parent_run_id);
  return old;
end;
$jiaowubao_direct_import_participant_mutation_guard$;

revoke all on function internal.jiaowubao_direct_import_participant_mutation_guard()
  from public, anon, authenticated;

drop trigger if exists jiaowubao_direct_import_schedule_guard
  on internal.jiaowubao_direct_schedule_events;
create trigger jiaowubao_direct_import_schedule_insert_guard
after insert on internal.jiaowubao_direct_schedule_events
referencing new table as inserted_schedule_events
for each statement execute function internal.jiaowubao_direct_import_schedule_insert_guard();
create trigger jiaowubao_direct_import_schedule_mutation_guard
before update or delete on internal.jiaowubao_direct_schedule_events
for each row execute function internal.jiaowubao_direct_import_schedule_mutation_guard();

drop trigger if exists jiaowubao_direct_import_participant_guard
  on internal.jiaowubao_direct_schedule_event_participants;
create trigger jiaowubao_direct_import_participant_insert_guard
after insert on internal.jiaowubao_direct_schedule_event_participants
referencing new table as inserted_schedule_participant
for each statement execute function internal.jiaowubao_direct_import_participant_insert_guard();
create trigger jiaowubao_direct_import_participant_mutation_guard
before update or delete on internal.jiaowubao_direct_schedule_event_participants
for each row execute function internal.jiaowubao_direct_import_participant_mutation_guard();

-- The remaining projections are still small enough that their existing row
-- evidence checks are appropriate. Permit only DELETE during a completed
-- abort transaction; all regular UPDATE/DELETE attempts remain immutable.
create or replace function internal.jiaowubao_direct_import_workbook_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_workbook_guard$
begin
  if tg_op = 'INSERT' then
    perform internal.jiaowubao_direct_import_assert_staging(new.run_id);
    return new;
  elsif tg_op = 'DELETE' then
    perform internal.jiaowubao_direct_import_assert_aborted(old.run_id);
    return old;
  end if;
  raise exception using errcode = '55000', message = 'jiaowubao_direct_import_workbook_read_only';
end;
$jiaowubao_direct_import_workbook_guard$;

revoke all on function internal.jiaowubao_direct_import_workbook_guard()
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_chunk_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_chunk_guard$
begin
  if tg_op = 'INSERT' then
    perform internal.jiaowubao_direct_import_assert_staging(new.run_id);
    return new;
  elsif tg_op = 'DELETE' then
    perform internal.jiaowubao_direct_import_assert_aborted(old.run_id);
    return old;
  end if;
  raise exception using errcode = '55000', message = 'jiaowubao_direct_import_chunk_read_only';
end;
$jiaowubao_direct_import_chunk_guard$;

revoke all on function internal.jiaowubao_direct_import_chunk_guard()
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_supplemental_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_supplemental_guard$
begin
  if tg_op = 'INSERT' then
    perform internal.jiaowubao_direct_import_assert_staging(new.run_id);
    perform internal.jiaowubao_direct_import_assert_supplemental_phone_evidence(
      new.resolution_state, new.evidence_phone, new.source_payload
    );
    perform internal.jiaowubao_direct_import_assert_payload_identity_name(
      new.resolution_state, new.evidence_name, new.source_payload, 'supplemental'
    );
    return new;
  elsif tg_op = 'DELETE' then
    perform internal.jiaowubao_direct_import_assert_aborted(old.run_id);
    return old;
  end if;
  raise exception using errcode = '55000', message = 'jiaowubao_direct_import_supplemental_read_only';
end;
$jiaowubao_direct_import_supplemental_guard$;

revoke all on function internal.jiaowubao_direct_import_supplemental_guard()
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_leave_makeup_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_leave_makeup_guard$
begin
  if tg_op = 'INSERT' then
    perform internal.jiaowubao_direct_import_assert_staging(new.run_id);
    perform internal.jiaowubao_direct_import_assert_payload_identity_name(
      new.resolution_state, new.evidence_name, new.source_payload, 'leave_makeup'
    );
    return new;
  elsif tg_op = 'DELETE' then
    perform internal.jiaowubao_direct_import_assert_aborted(old.run_id);
    return old;
  end if;
  raise exception using errcode = '55000', message = 'jiaowubao_direct_import_leave_makeup_read_only';
end;
$jiaowubao_direct_import_leave_makeup_guard$;

revoke all on function internal.jiaowubao_direct_import_leave_makeup_guard()
  from public, anon, authenticated;
