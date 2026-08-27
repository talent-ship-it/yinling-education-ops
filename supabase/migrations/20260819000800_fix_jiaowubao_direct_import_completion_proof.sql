-- Repair the completion proof's PL/pgSQL/SQL name collision and keep the
-- expensive 40k-row authority proof single-execution. The staging-to-complete
-- BEFORE UPDATE guard remains the authoritative atomic assertion boundary.

set local lock_timeout = '1s';

create or replace function internal.jiaowubao_direct_import_assert_complete(p_run_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_complete$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  current_master internal.student_import_source_rows%rowtype;
  students_payload jsonb;
  teachers_payload jsonb;
  workbook_count integer;
  chunk_count integer;
  minimum_chunk_index integer;
  maximum_chunk_index integer;
  supplemental_count integer;
  schedule_count integer;
  participant_count integer;
  leave_makeup_count integer;
begin
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_run_not_found';
  end if;
  if saved_run.state <> 'staging' then
    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_run_not_staging';
  end if;

  select * into current_master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master'
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_direct_import_master_source_unavailable';
  end if;
  if current_master.source_id <> saved_run.master_source_id
     or current_master.revision <> saved_run.master_revision
     or current_master.rows_sha256 <> saved_run.master_rows_sha256 then
    raise exception using errcode = '40900', message = 'jiaowubao_direct_import_master_source_changed';
  end if;

  select state_row.payload into students_payload
  from public.ops_state state_row
  where state_row.entity = 'students'
  for share;
  select state_row.payload into teachers_payload
  from public.ops_state state_row
  where state_row.entity = 'teachers'
  for share;
  perform internal.jiaowubao_direct_import_validate_projection(
    p_run_id, current_master.rows, students_payload, teachers_payload
  );

  select count(*) into workbook_count
  from internal.jiaowubao_direct_import_workbooks workbook
  where workbook.run_id = p_run_id;
  if workbook_count <> 7 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_workbook_manifest_incomplete';
  end if;

  select count(*), min(chunk.chunk_index), max(chunk.chunk_index)
  into chunk_count, minimum_chunk_index, maximum_chunk_index
  from internal.jiaowubao_direct_import_chunks chunk
  where chunk.run_id = p_run_id;
  if chunk_count <> saved_run.expected_chunk_count
     or minimum_chunk_index <> 0
     or maximum_chunk_index <> saved_run.expected_chunk_count - 1 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_manifest_incomplete';
  end if;
  if exists (
    select 1
    from internal.jiaowubao_direct_import_chunks chunk
    where chunk.run_id = p_run_id
      and chunk.source_record_counts is distinct from saved_run.source_record_counts
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_record_counts_mismatch';
  end if;
  if not exists (
    select 1
    from internal.operational_contract_audit audit_entry
    where audit_entry.id = saved_run.staging_audit_id
      and audit_entry.action = 'jiaowubao_direct_import.started'
      and audit_entry.actor = saved_run.staged_by
      and audit_entry.target_type = 'jiaowubao_direct_import_run'
      and audit_entry.target_id = saved_run.id::text
      and audit_entry.metadata ->> 'sourceId' = saved_run.source_id
      and audit_entry.metadata ->> 'revision' = saved_run.revision
      and audit_entry.metadata ->> 'masterSourceId' = saved_run.master_source_id
      and audit_entry.metadata ->> 'masterRevision' = saved_run.master_revision
      and audit_entry.metadata ->> 'masterRowsSha256' = saved_run.master_rows_sha256
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_staging_audit_invalid';
  end if;
  if exists (
    select 1
    from internal.jiaowubao_direct_import_chunks chunk
    left join internal.operational_contract_audit audit_entry on audit_entry.id = chunk.audit_id
    where chunk.run_id = p_run_id
      and (
        audit_entry.id is null
        or audit_entry.action <> 'jiaowubao_direct_import.chunk_staged'
        or audit_entry.actor <> saved_run.staged_by
        or audit_entry.target_type <> 'jiaowubao_direct_import_run'
        or audit_entry.target_id <> saved_run.id::text
        or audit_entry.metadata ->> 'sourceId' <> saved_run.source_id
        or audit_entry.metadata ->> 'revision' <> saved_run.revision
        or audit_entry.metadata ->> 'chunkIndex' <> chunk.chunk_index::text
        or audit_entry.metadata ->> 'chunkSha256' <> chunk.chunk_sha256
        or audit_entry.metadata ->> 'projectionSha256' <> chunk.projection_sha256
      )
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_audit_invalid';
  end if;
  if exists (
    with chunk_rows as (
      select
        chunk.chunk_index,
        chunk.source_record_count,
        chunk.projected_record_counts,
        coalesce(supplemental.row_count, 0)::integer as supplemental_count,
        coalesce(schedule_event.row_count, 0)::integer as schedule_count,
        coalesce(participant.row_count, 0)::integer as participant_count,
        coalesce(leave_makeup.row_count, 0)::integer as leave_makeup_count
      from internal.jiaowubao_direct_import_chunks chunk
      left join (
        select chunk_index, count(*)::integer as row_count
        from internal.jiaowubao_direct_supplemental_records
        where run_id = p_run_id group by chunk_index
      ) supplemental on supplemental.chunk_index = chunk.chunk_index
      left join (
        select chunk_index, count(*)::integer as row_count
        from internal.jiaowubao_direct_schedule_events
        where run_id = p_run_id group by chunk_index
      ) schedule_event on schedule_event.chunk_index = chunk.chunk_index
      left join (
        select schedule_event.chunk_index, count(*)::integer as row_count
        from internal.jiaowubao_direct_schedule_event_participants participant
        join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
        where schedule_event.run_id = p_run_id group by schedule_event.chunk_index
      ) participant on participant.chunk_index = chunk.chunk_index
      left join (
        select chunk_index, count(*)::integer as row_count
        from internal.jiaowubao_direct_leave_makeup_events
        where run_id = p_run_id group by chunk_index
      ) leave_makeup on leave_makeup.chunk_index = chunk.chunk_index
      where chunk.run_id = p_run_id
    )
    select 1
    from chunk_rows chunk_proof
    where chunk_proof.source_record_count <> chunk_proof.supplemental_count + chunk_proof.schedule_count + chunk_proof.leave_makeup_count
       or chunk_proof.projected_record_counts is distinct from jsonb_build_object(
         'supplementalRecords', chunk_proof.supplemental_count,
         'scheduleEvents', chunk_proof.schedule_count,
         'scheduleParticipants', chunk_proof.participant_count,
         'leaveMakeups', chunk_proof.leave_makeup_count
       )
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_projection_proof_invalid';
  end if;
  if exists (
    select 1
    from (
      select source_key from internal.jiaowubao_direct_supplemental_records where run_id = p_run_id
      union all select source_key from internal.jiaowubao_direct_schedule_events where run_id = p_run_id
      union all select source_key from internal.jiaowubao_direct_leave_makeup_events where run_id = p_run_id
    ) source_keys
    group by source_key
    having count(*) <> 1
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_source_key_proof_invalid';
  end if;
  -- Aggregate every source kind back from the persisted relational rows.  A
  -- supplemental total alone is not sufficient: it would allow a quick-list
  -- row to stand in for a student snapshot (or any other same-total swap).
  -- The per-workbook proof independently binds the raw source reference to
  -- the immutable seven-file manifest.
  if exists (
    with persisted_source_counts as (
      select persisted_row.source_kind, count(*)::integer as row_count
      from (
        select case record.record_kind
          when 'contract' then 'contract_history'
          else record.record_kind
        end as source_kind
        from internal.jiaowubao_direct_supplemental_records record
        where record.run_id = p_run_id
        union all
        select 'schedule_event'::text
        from internal.jiaowubao_direct_schedule_events schedule_event
        where schedule_event.run_id = p_run_id
        union all
        select 'leave_makeup'::text
        from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
        where leave_makeup_event.run_id = p_run_id
      ) persisted_row
      group by persisted_row.source_kind
    )
    select 1
    from jsonb_each_text(saved_run.source_record_counts) expected(source_kind, row_count)
    left join persisted_source_counts persisted using (source_kind)
    where coalesce(persisted.row_count, 0) <> expected.row_count::integer
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_source_kind_counts_mismatch';
  end if;
  if exists (
    with persisted_workbook_counts as (
      select persisted_row.workbook_kind, count(*)::integer as row_count
      from (
        select record.source_workbook as workbook_kind
        from internal.jiaowubao_direct_supplemental_records record
        where record.run_id = p_run_id
        union all
        select schedule_event.source_workbook
        from internal.jiaowubao_direct_schedule_events schedule_event
        where schedule_event.run_id = p_run_id
        union all
        select leave_makeup_event.source_workbook
        from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
        where leave_makeup_event.run_id = p_run_id
      ) persisted_row
      group by persisted_row.workbook_kind
    )
    select 1
    from internal.jiaowubao_direct_import_workbooks workbook
    left join persisted_workbook_counts persisted
      on persisted.workbook_kind = workbook.workbook_kind
    where workbook.run_id = p_run_id
      and coalesce(persisted.row_count, 0) <> workbook.row_count
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_workbook_row_counts_mismatch';
  end if;
  -- Every persisted raw row must still reconstruct to the canonical
  -- PostgreSQL digest accepted from its staged preflight record. This binds
  -- the run ledger to the relational history rather than relying on counts
  -- alone. Participant hashes are separately derived from their one source
  -- schedule cell plus the explicitly retained display name.
  if exists (
    select 1
    from internal.jiaowubao_direct_supplemental_records record
    where record.run_id = p_run_id
      and record.record_sha256 <> encode(extensions.digest(jsonb_build_object(
        'kind', case record.record_kind when 'contract' then 'contract_history' else record.record_kind end,
        'sourceKey', record.source_key,
        'sourceRefs', record.source_payload #> '{_directImport,sourceRefs}',
        'sourceDigest', record.source_payload #>> '{_directImport,sourceDigest}',
        'studentRelationship', record.source_payload #> '{_directImport,studentRelationship}',
        'payload', record.source_payload - '_directImport'
      )::text, 'sha256'), 'hex')
  ) or exists (
    select 1
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = p_run_id
      and schedule_event.record_sha256 <> encode(extensions.digest(jsonb_build_object(
        'kind', 'schedule_event',
        'sourceKey', schedule_event.source_key,
        'sourceRefs', schedule_event.source_payload #> '{_directImport,sourceRefs}',
        'sourceDigest', schedule_event.source_payload #>> '{_directImport,sourceDigest}',
        'studentRelationship', schedule_event.source_payload #> '{_directImport,studentRelationship}',
        'payload', schedule_event.source_payload - '_directImport'
      )::text, 'sha256'), 'hex')
  ) or exists (
    select 1
    from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
    where leave_makeup_event.run_id = p_run_id
      and leave_makeup_event.record_sha256 <> encode(extensions.digest(jsonb_build_object(
        'kind', 'leave_makeup',
        'sourceKey', leave_makeup_event.source_key,
        'sourceRefs', leave_makeup_event.source_payload #> '{_directImport,sourceRefs}',
        'sourceDigest', leave_makeup_event.source_payload #>> '{_directImport,sourceDigest}',
        'studentRelationship', leave_makeup_event.source_payload #> '{_directImport,studentRelationship}',
        'payload', leave_makeup_event.source_payload - '_directImport'
      )::text, 'sha256'), 'hex')
  ) or exists (
    select 1
    from internal.jiaowubao_direct_schedule_event_participants participant
    join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
    where schedule_event.run_id = p_run_id
      and participant.record_sha256 <> encode(extensions.digest(jsonb_build_object(
        'sourceKey', schedule_event.source_key,
        'participantKey', participant.participant_key,
        'sourceDisplayName', participant.source_display_name,
        'sourceDigest', schedule_event.source_payload #>> '{_directImport,sourceDigest}'
      )::text, 'sha256'), 'hex')
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_raw_record_digest_proof_invalid';
  end if;

  select count(*) into supplemental_count
  from internal.jiaowubao_direct_supplemental_records record
  where record.run_id = p_run_id;
  select count(*) into schedule_count
  from internal.jiaowubao_direct_schedule_events schedule_event
  where schedule_event.run_id = p_run_id;
  select count(*) into participant_count
  from internal.jiaowubao_direct_schedule_event_participants participant
  join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant.event_id
  where schedule_event.run_id = p_run_id;
  select count(*) into leave_makeup_count
  from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event
  where leave_makeup_event.run_id = p_run_id;

  if supplemental_count <> (saved_run.expected_counts ->> 'supplementalRecords')::integer
     or schedule_count <> (saved_run.expected_counts ->> 'scheduleEvents')::integer
     or participant_count <> (saved_run.expected_counts ->> 'scheduleParticipants')::integer
     or leave_makeup_count <> (saved_run.expected_counts ->> 'leaveMakeups')::integer then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_record_counts_mismatch';
  end if;

  -- A partially parsed class cell may remain display-only, but it cannot
  -- subtract teacher availability until at least one exact, current Tencent
  -- student participant proves the event's classroom relationship.
  if exists (
    select 1
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = p_run_id
      and schedule_event.availability_effect = 'blocks_teacher_ava'
      and not exists (
        select 1
        from internal.jiaowubao_direct_schedule_event_participants participant
        where participant.event_id = schedule_event.id
          and participant.resolution_state = 'attached'
      )
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_block_participants_unresolved';
  end if;
end;
$jiaowubao_direct_import_assert_complete$;

revoke all on function internal.jiaowubao_direct_import_assert_complete(uuid)
  from public, anon, authenticated;

create or replace function internal.complete_jiaowubao_direct_import(
  p_run_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $complete_jiaowubao_direct_import$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  completion_audit_entry_id uuid;
  payload_hash text;
begin
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or char_length(p_actor) > 120 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_invalid';
  end if;
  perform internal.jiaowubao_direct_import_assert_staging(p_run_id);
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;
  if saved_run.staged_by <> p_actor then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_mismatch';
  end if;
  payload_hash := internal.jiaowubao_direct_import_payload_sha256(p_run_id);
  completion_audit_entry_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.completed', p_actor,
    'jiaowubao_direct_import_run', p_run_id::text,
    jsonb_build_object(
      'sourceId', saved_run.source_id,
      'revision', saved_run.revision,
      'payloadSha256', payload_hash,
      'chunkCount', saved_run.expected_chunk_count,
      'recordCounts', saved_run.source_record_counts,
      'expectedCounts', saved_run.expected_counts,
      'masterSourceId', saved_run.master_source_id,
      'masterRevision', saved_run.master_revision,
      'masterRowsSha256', saved_run.master_rows_sha256
    )
  );
  update internal.jiaowubao_direct_import_runs run_state
  set state = 'complete', payload_sha256 = payload_hash,
      completed_at = now(), completion_audit_id = completion_audit_entry_id
  where run_state.id = p_run_id
  returning * into saved_run;
  return jsonb_build_object(
    'runId', saved_run.id,
    'sourceId', saved_run.source_id,
    'revision', saved_run.revision,
    'state', saved_run.state,
    'payloadSha256', saved_run.payload_sha256,
    'chunkCount', saved_run.expected_chunk_count,
    'recordCounts', saved_run.source_record_counts,
    'expectedCounts', saved_run.expected_counts
  );
end;
$complete_jiaowubao_direct_import$;

revoke all on function internal.complete_jiaowubao_direct_import(uuid, text)
  from public, anon, authenticated;
