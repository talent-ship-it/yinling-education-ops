\set ON_ERROR_STOP on

-- Local-only contract for the guarded authority-drift auto-abort helper. It
-- proves the helper holds the current master fingerprint under lock before it
-- delegates to 011 cleanup, and never deletes staging data for a stale caller
-- observation or a run already bound to the current master.

begin;

\ir ../../supabase/migrations/20260819000100_create_jiaowubao_direct_import_projection.sql
\ir ../../supabase/migrations/20260819000200_read_jiaowubao_direct_import_projection.sql
\ir ../../supabase/migrations/20260819000300_guard_booking_capacity_against_jiaowubao_schedule.sql
\ir ../../supabase/migrations/20260819000600_fix_jiaowubao_direct_import_envelope_precedence.sql
\ir ../../supabase/migrations/20260819000700_fix_jiaowubao_direct_import_stage_alias_ambiguity.sql
\ir ../../supabase/migrations/20260819000800_fix_jiaowubao_direct_import_completion_proof.sql
\ir ../../supabase/migrations/20260819000900_optimize_jiaowubao_direct_import_completion_proof.sql
\ir ../../supabase/migrations/20260819001000_batch_jiaowubao_direct_import_schedule_stage.sql
\ir ../../supabase/migrations/20260819001100_resume_jiaowubao_direct_import_chunks.sql
\ir ../../supabase/migrations/20260819001200_guard_jiaowubao_direct_import_auto_abort.sql

do $jiaowubao_direct_import_auto_abort_contract$
declare
  master_source_audit_id uuid;
  stale_staging_audit_id uuid;
  wrong_staging_audit_id uuid;
  current_staging_audit_id uuid;
  stale_run_id uuid := gen_random_uuid();
  wrong_expected_run_id uuid := gen_random_uuid();
  current_bound_run_id uuid := gen_random_uuid();
  workbooks jsonb;
  zero_workbooks jsonb;
  record_counts jsonb;
  zero_record_counts jsonb;
  expected_counts jsonb;
  zero_expected_counts jsonb;
  stale_chunk jsonb;
  wrong_chunk jsonb;
  projection jsonb;
  wrong_projection jsonb;
  abort_receipt jsonb;
  no_op_receipt jsonb;
  current_receipt jsonb;
  current_master_hash text := repeat('a', 64);
  stale_master_hash text := repeat('b', 64);
begin
  insert into public.ops_state (entity, payload, version, updated_by) values
    ('students', '[]'::jsonb, 1, 'Auto-abort fixture'),
    ('teachers', '[]'::jsonb, 1, 'Auto-abort fixture'),
    ('bookings', '[]'::jsonb, 1, 'Auto-abort fixture');
  master_source_audit_id := internal.append_operational_contract_audit(
    'student_import.fixture',
    'Auto-abort fixture',
    'student_import_source',
    'master',
    '{}'::jsonb
  );
  insert into internal.student_import_source_rows (
    source_kind, source_id, revision, rows, row_count, rows_sha256,
    ingested_by, audit_id
  ) values (
    'master', 'current-master', 'current-revision', '[]'::jsonb, 0,
    current_master_hash, 'Auto-abort fixture', master_source_audit_id
  );

  workbooks := jsonb_build_array(
    jsonb_build_object('kind', 'quick_list', 'workbookName', 'quick.xlsx', 'workbookSha256', repeat('1', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'students', 'workbookName', 'students.xlsx', 'workbookSha256', repeat('2', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 1),
    jsonb_build_object('kind', 'contracts', 'workbookName', 'contracts.xlsx', 'workbookSha256', repeat('3', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'hours', 'workbookName', 'hours.xlsx', 'workbookSha256', repeat('4', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'class_members', 'workbookName', 'classes.xlsx', 'workbookSha256', repeat('5', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'schedule', 'workbookName', 'schedule.xlsx', 'workbookSha256', repeat('6', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'leave_makeups', 'workbookName', 'leave.xlsx', 'workbookSha256', repeat('7', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0)
  );
  zero_workbooks := jsonb_set(workbooks, '{1,sourceRecordCount}', '0'::jsonb);
  record_counts := jsonb_build_object(
    'student_snapshot', 1,
    'quick_list', 0,
    'contract_history', 0,
    'hour_balance', 0,
    'class_membership', 0,
    'schedule_event', 0,
    'leave_makeup', 0
  );
  zero_record_counts := jsonb_set(record_counts, '{student_snapshot}', '0'::jsonb);
  expected_counts := jsonb_build_object(
    'supplementalRecords', 1,
    'scheduleEvents', 0,
    'scheduleParticipants', 0,
    'leaveMakeups', 0
  );
  zero_expected_counts := jsonb_build_object(
    'supplementalRecords', 0,
    'scheduleEvents', 0,
    'scheduleParticipants', 0,
    'leaveMakeups', 0
  );
  projection := jsonb_build_object(
    'supplemental', jsonb_build_array(jsonb_build_object(
      'sourceKey', 'auto-abort:stale:student',
      'resolution', jsonb_build_object(
        'state', 'quarantined', 'studentId', null, 'masterSourceRow', null,
        'reason', 'unmatched_tencent_student'
      ),
      'identityProof', false
    )),
    'scheduleEvents', '[]'::jsonb,
    'leaveMakeups', '[]'::jsonb
  );

  stale_staging_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.started',
    'Auto-abort fixture',
    'jiaowubao_direct_import_run',
    stale_run_id::text,
    jsonb_build_object(
      'sourceId', 'jiaowubao-static-excel',
      'revision', 'sha256:' || repeat('c', 64),
      'masterSourceId', 'stale-master',
      'masterRevision', 'stale-revision',
      'masterRowsSha256', stale_master_hash
    )
  );
  insert into internal.jiaowubao_direct_import_runs (
    id, source_id, revision, format, source_timezone, source_timezone_basis,
    master_source_id, master_revision, master_rows_sha256, expected_chunk_count,
    source_record_counts, expected_counts, staged_by, staging_audit_id
  ) values (
    stale_run_id, 'jiaowubao-static-excel', 'sha256:' || repeat('c', 64),
    'jiaowubao-direct-import-v1', 'Australia/Melbourne', 'auto-abort fixture',
    'stale-master', 'stale-revision', stale_master_hash, 1,
    record_counts, expected_counts, 'Auto-abort fixture', stale_staging_audit_id
  );
  insert into internal.jiaowubao_direct_import_workbooks (
    run_id, workbook_kind, workbook_name, workbook_sha256, sheet_name, row_count
  )
  select stale_run_id, workbook.value ->> 'kind', workbook.value ->> 'workbookName',
    workbook.value ->> 'workbookSha256', workbook.value ->> 'sheetName',
    (workbook.value ->> 'sourceRecordCount')::integer
  from jsonb_array_elements(workbooks) workbook(value);
  stale_chunk := jsonb_build_object(
    'format', 'jiaowubao-direct-staging-v1',
    'revision', 'sha256:' || repeat('c', 64),
    'contract', jsonb_build_object(
      'storage', 'server_only_relational_staging',
      'studentAuthority', 'tencent_master',
      'studentCreation', 'forbidden',
      'studentMatching', 'server_side_current_tencent_only',
      'scheduleProjection', 'read_only_imported_schedule_event',
      'scheduleBookingExpansion', 'forbidden',
      'sourceMutation', 'forbidden'
    ),
    'sourceTimezone', 'Australia/Melbourne',
    'sourceTimezoneBasis', 'auto-abort fixture',
    'workbooks', workbooks,
    'recordCounts', record_counts,
    'chunk', jsonb_build_object('index', 0, 'count', 1),
    'records', jsonb_build_array(jsonb_build_object(
      'kind', 'student_snapshot',
      'sourceKey', 'auto-abort:stale:student',
      'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'students', 'row', 2)),
      'sourceDigest', repeat('d', 64),
      'studentRelationship', jsonb_build_object(
        'state', 'pending_authoritative_tencent_match',
        'automaticAttachment', 'forbidden',
        'sourceIdentity', 'tabular_identity_hint'
      ),
      'payload', jsonb_build_object('source', '{}'::jsonb, 'staging', '{}'::jsonb)
    ))
  );
  perform internal.stage_jiaowubao_direct_import_chunk(
    stale_run_id, stale_chunk, projection, 'Auto-abort fixture'
  );

  -- The expected fingerprint is exactly the locked current master and differs
  -- from the stale run binding, so cleanup is allowed.
  abort_receipt := internal.abort_jiaowubao_direct_import_if_current_master_differs(
    stale_run_id, 'Auto-abort fixture',
    'current-master', 'current-revision', current_master_hash
  );
  if abort_receipt ->> 'state' <> 'aborted'
     or abort_receipt ->> 'aborted' <> 'true'
     or not exists (
       select 1
       from internal.jiaowubao_direct_import_runs run_state
       join internal.operational_contract_audit audit_entry
         on audit_entry.id = run_state.abort_audit_id
       where run_state.id = stale_run_id
         and run_state.state = 'aborted'
         and audit_entry.action = 'jiaowubao_direct_import.aborted'
     )
     or exists (select 1 from internal.jiaowubao_direct_import_workbooks workbook where workbook.run_id = stale_run_id)
     or exists (select 1 from internal.jiaowubao_direct_import_chunks chunk where chunk.run_id = stale_run_id)
     or exists (select 1 from internal.jiaowubao_direct_supplemental_records supplemental_record where supplemental_record.run_id = stale_run_id) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_auto_abort_cleanup_failed';
  end if;

  -- A caller whose observed fingerprint is stale must not clean up otherwise
  -- valid staging evidence even though this run itself is stale against master.
  wrong_staging_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.started',
    'Auto-abort fixture',
    'jiaowubao_direct_import_run',
    wrong_expected_run_id::text,
    jsonb_build_object(
      'sourceId', 'jiaowubao-static-excel',
      'revision', 'sha256:' || repeat('e', 64),
      'masterSourceId', 'stale-master',
      'masterRevision', 'stale-revision',
      'masterRowsSha256', stale_master_hash
    )
  );
  insert into internal.jiaowubao_direct_import_runs (
    id, source_id, revision, format, source_timezone, source_timezone_basis,
    master_source_id, master_revision, master_rows_sha256, expected_chunk_count,
    source_record_counts, expected_counts, staged_by, staging_audit_id
  ) values (
    wrong_expected_run_id, 'jiaowubao-static-excel', 'sha256:' || repeat('e', 64),
    'jiaowubao-direct-import-v1', 'Australia/Melbourne', 'auto-abort fixture',
    'stale-master', 'stale-revision', stale_master_hash, 1,
    record_counts, expected_counts, 'Auto-abort fixture', wrong_staging_audit_id
  );
  insert into internal.jiaowubao_direct_import_workbooks (
    run_id, workbook_kind, workbook_name, workbook_sha256, sheet_name, row_count
  )
  select wrong_expected_run_id, workbook.value ->> 'kind', workbook.value ->> 'workbookName',
    workbook.value ->> 'workbookSha256', workbook.value ->> 'sheetName',
    (workbook.value ->> 'sourceRecordCount')::integer
  from jsonb_array_elements(workbooks) workbook(value);
  wrong_chunk := jsonb_set(stale_chunk, '{revision}', to_jsonb('sha256:' || repeat('e', 64)))
    || jsonb_build_object('records', jsonb_build_array(jsonb_build_object(
      'kind', 'student_snapshot',
      'sourceKey', 'auto-abort:wrong:student',
      'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'students', 'row', 2)),
      'sourceDigest', repeat('f', 64),
      'studentRelationship', jsonb_build_object(
        'state', 'pending_authoritative_tencent_match',
        'automaticAttachment', 'forbidden',
        'sourceIdentity', 'tabular_identity_hint'
      ),
      'payload', jsonb_build_object('source', '{}'::jsonb, 'staging', '{}'::jsonb)
    )));
  wrong_projection := jsonb_set(projection, '{supplemental,0,sourceKey}', '"auto-abort:wrong:student"'::jsonb);
  perform internal.stage_jiaowubao_direct_import_chunk(
    wrong_expected_run_id, wrong_chunk, wrong_projection, 'Auto-abort fixture'
  );
  no_op_receipt := internal.abort_jiaowubao_direct_import_if_current_master_differs(
    wrong_expected_run_id, 'Auto-abort fixture',
    'observed-master', 'current-revision', current_master_hash
  );
  if no_op_receipt ->> 'aborted' <> 'false'
     or no_op_receipt ->> 'reason' <> 'current_master_not_expected'
     or not exists (
       select 1
     from internal.jiaowubao_direct_import_runs run_state
     where run_state.id = wrong_expected_run_id and run_state.state = 'staging'
     )
     or exists (
       select 1
       from internal.jiaowubao_direct_import_runs run_state
       where run_state.id = wrong_expected_run_id
         and (run_state.abort_audit_id is not null or run_state.aborted_at is not null)
     )
     or (select count(*) from internal.jiaowubao_direct_import_chunks chunk where chunk.run_id = wrong_expected_run_id) <> 1
     or (select count(*) from internal.jiaowubao_direct_supplemental_records supplemental_record where supplemental_record.run_id = wrong_expected_run_id) <> 1 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_auto_abort_expected_mismatch_deleted';
  end if;

  -- The exact current master alone is insufficient: no cleanup occurs when
  -- the run itself is still bound to that fingerprint.
  current_staging_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.started',
    'Auto-abort fixture',
    'jiaowubao_direct_import_run',
    current_bound_run_id::text,
    jsonb_build_object(
      'sourceId', 'jiaowubao-static-excel',
      'revision', 'sha256:' || repeat('1', 64),
      'masterSourceId', 'current-master',
      'masterRevision', 'current-revision',
      'masterRowsSha256', current_master_hash
    )
  );
  insert into internal.jiaowubao_direct_import_runs (
    id, source_id, revision, format, source_timezone, source_timezone_basis,
    master_source_id, master_revision, master_rows_sha256, expected_chunk_count,
    source_record_counts, expected_counts, staged_by, staging_audit_id
  ) values (
    current_bound_run_id, 'jiaowubao-static-excel', 'sha256:' || repeat('1', 64),
    'jiaowubao-direct-import-v1', 'Australia/Melbourne', 'auto-abort fixture',
    'current-master', 'current-revision', current_master_hash, 1,
    zero_record_counts, zero_expected_counts, 'Auto-abort fixture', current_staging_audit_id
  );
  insert into internal.jiaowubao_direct_import_workbooks (
    run_id, workbook_kind, workbook_name, workbook_sha256, sheet_name, row_count
  )
  select current_bound_run_id, workbook.value ->> 'kind', workbook.value ->> 'workbookName',
    workbook.value ->> 'workbookSha256', workbook.value ->> 'sheetName',
    (workbook.value ->> 'sourceRecordCount')::integer
  from jsonb_array_elements(zero_workbooks) workbook(value);
  current_receipt := internal.abort_jiaowubao_direct_import_if_current_master_differs(
    current_bound_run_id, 'Auto-abort fixture',
    'current-master', 'current-revision', current_master_hash
  );
  if current_receipt ->> 'aborted' <> 'false'
     or current_receipt ->> 'reason' <> 'run_master_still_current'
     or not exists (
       select 1
     from internal.jiaowubao_direct_import_runs run_state
     where run_state.id = current_bound_run_id and run_state.state = 'staging'
     )
     or exists (
       select 1
       from internal.jiaowubao_direct_import_runs run_state
       where run_state.id = current_bound_run_id
         and (run_state.abort_audit_id is not null or run_state.aborted_at is not null)
     )
     or not exists (
       select 1
       from internal.student_import_source_rows source_state
       where source_state.source_kind = 'master'
         and source_state.source_id = 'current-master'
         and source_state.revision = 'current-revision'
         and source_state.rows_sha256 = current_master_hash
     ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_auto_abort_no_drift_deleted';
  end if;
end;
$jiaowubao_direct_import_auto_abort_contract$;

rollback;
