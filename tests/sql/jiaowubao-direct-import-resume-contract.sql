\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Local-only lifecycle contract for resumable direct Jiaowubao staging.
-- It applies the full forward chain inside one outer transaction and rolls all
-- schema/data changes back. Each function call is deliberately independent:
-- in production the reviewed CLI commits after begin and after each successful
-- stage call; the durable state and exact replay behavior exercised here are
-- what make those commit boundaries safe.

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

do $jiaowubao_direct_import_resume_contract$
declare
  source_audit_id uuid;
  resume_test_run_id uuid;
  resumed_run_id uuid;
  completed_run_id uuid;
  abort_test_run_id uuid;
  reopened_test_run_id uuid;
  replay_receipt jsonb;
  abort_receipt jsonb;
  envelope jsonb;
  abort_envelope jsonb;
  workbooks jsonb;
  record_counts jsonb;
  chunk_zero jsonb;
  chunk_one jsonb;
  abort_chunk jsonb;
  projection_zero jsonb;
  projection_one jsonb;
  abort_projection jsonb;
begin
  insert into public.ops_state (entity, payload, version, updated_by) values
    ('students', '[]'::jsonb, 1, 'Resume fixture'),
    ('teachers', '[]'::jsonb, 1, 'Resume fixture'),
    ('bookings', '[]'::jsonb, 1, 'Resume fixture');
  source_audit_id := internal.append_operational_contract_audit(
    'student_import.fixture',
    'Resume fixture',
    'student_import_source',
    'master',
    '{}'::jsonb
  );
  insert into internal.student_import_source_rows (
    source_kind, source_id, revision, rows, row_count, rows_sha256,
    ingested_by, audit_id
  ) values (
    'master', 'master', 'resume-fixture', '[]'::jsonb, 0, repeat('a', 64),
    'Resume fixture', source_audit_id
  );

  workbooks := jsonb_build_array(
    jsonb_build_object('kind', 'quick_list', 'workbookName', 'quick.xlsx', 'workbookSha256', repeat('1', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'students', 'workbookName', 'students.xlsx', 'workbookSha256', repeat('2', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 2),
    jsonb_build_object('kind', 'contracts', 'workbookName', 'contracts.xlsx', 'workbookSha256', repeat('3', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'hours', 'workbookName', 'hours.xlsx', 'workbookSha256', repeat('4', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'class_members', 'workbookName', 'classes.xlsx', 'workbookSha256', repeat('5', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'schedule', 'workbookName', 'schedule.xlsx', 'workbookSha256', repeat('6', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'leave_makeups', 'workbookName', 'leave.xlsx', 'workbookSha256', repeat('7', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0)
  );
  record_counts := jsonb_build_object(
    'student_snapshot', 2,
    'quick_list', 0,
    'contract_history', 0,
    'hour_balance', 0,
    'class_membership', 0,
    'schedule_event', 0,
    'leave_makeup', 0
  );
  envelope := jsonb_build_object(
    'format', 'jiaowubao-direct-import-v1',
    'sourceId', 'jiaowubao-static-excel',
    'revision', 'sha256:' || repeat('b', 64),
    'sourceTimezone', 'Australia/Melbourne',
    'sourceTimezoneBasis', 'resume fixture',
    'masterSource', jsonb_build_object('sourceId', 'master', 'revision', 'resume-fixture', 'rowsSha256', repeat('a', 64)),
    'workbooks', workbooks,
    'recordCounts', record_counts,
    'expectedCounts', jsonb_build_object(
      'supplementalRecords', 2,
      'scheduleEvents', 0,
      'scheduleParticipants', 0,
      'leaveMakeups', 0
    ),
    'chunkCount', 2
  );

  chunk_zero := jsonb_build_object(
    'format', 'jiaowubao-direct-staging-v1',
    'revision', envelope ->> 'revision',
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
    'sourceTimezoneBasis', 'resume fixture',
    'workbooks', workbooks,
    'recordCounts', record_counts,
    'chunk', jsonb_build_object('index', 0, 'count', 2),
    'records', jsonb_build_array(jsonb_build_object(
      'kind', 'student_snapshot',
      'sourceKey', 'resume:student:0',
      'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'students', 'row', 2)),
      'sourceDigest', repeat('c', 64),
      'studentRelationship', jsonb_build_object(
        'state', 'pending_authoritative_tencent_match',
        'automaticAttachment', 'forbidden',
        'sourceIdentity', 'tabular_identity_hint'
      ),
      'payload', jsonb_build_object('source', '{}'::jsonb, 'staging', '{}'::jsonb)
    ))
  );
  chunk_one := jsonb_set(chunk_zero, '{chunk,index}', '1'::jsonb)
    || jsonb_build_object('records', jsonb_build_array(jsonb_build_object(
      'kind', 'student_snapshot',
      'sourceKey', 'resume:student:1',
      'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'students', 'row', 3)),
      'sourceDigest', repeat('d', 64),
      'studentRelationship', jsonb_build_object(
        'state', 'pending_authoritative_tencent_match',
        'automaticAttachment', 'forbidden',
        'sourceIdentity', 'tabular_identity_hint'
      ),
      'payload', jsonb_build_object('source', '{}'::jsonb, 'staging', '{}'::jsonb)
    )));
  projection_zero := jsonb_build_object(
    'supplemental', jsonb_build_array(jsonb_build_object(
      'sourceKey', 'resume:student:0',
      'resolution', jsonb_build_object(
        'state', 'quarantined', 'studentId', null, 'masterSourceRow', null,
        'reason', 'unmatched_tencent_student'
      ),
      'identityProof', false
    )),
    'scheduleEvents', '[]'::jsonb,
    'leaveMakeups', '[]'::jsonb
  );
  projection_one := jsonb_set(projection_zero, '{supplemental,0,sourceKey}', '"resume:student:1"'::jsonb);

  resume_test_run_id := internal.begin_jiaowubao_direct_import(envelope, 'Resume fixture');
  resumed_run_id := internal.begin_jiaowubao_direct_import(envelope, 'Resume fixture');
  if resumed_run_id <> resume_test_run_id then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_resume_begin_not_idempotent';
  end if;

  -- A gap is rejected before its chunk ledger/audit can be inserted.
  begin
    perform internal.stage_jiaowubao_direct_import_chunk(
      resume_test_run_id, chunk_one, projection_one, 'Resume fixture'
    );
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_resume_gap_not_rejected';
  exception when others then
    if SQLSTATE <> '22023' or SQLERRM <> 'jiaowubao_direct_import_chunk_sequence_gap' then
      raise;
    end if;
  end;

  perform internal.stage_jiaowubao_direct_import_chunk(
    resume_test_run_id, chunk_zero, projection_zero, 'Resume fixture'
  );
  if exists (
    select 1
    from internal.jiaowubao_direct_import_runs run_state
    where run_state.id = resume_test_run_id and run_state.state = 'complete'
  ) or exists (
    select 1
    from internal.jiaowubao_direct_supplemental_records supplemental_record
    join internal.jiaowubao_direct_import_runs run_state
      on run_state.id = supplemental_record.run_id
    where supplemental_record.run_id = resume_test_run_id and run_state.state = 'complete'
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_staging_visibility_regression';
  end if;

  replay_receipt := internal.stage_jiaowubao_direct_import_chunk(
    resume_test_run_id, chunk_zero, projection_zero, 'Resume fixture'
  );
  if replay_receipt ->> 'replayed' <> 'true'
     or (select count(*) from internal.jiaowubao_direct_import_chunks chunk where chunk.run_id = resume_test_run_id) <> 1 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_resume_replay_failed';
  end if;

  perform internal.stage_jiaowubao_direct_import_chunk(
    resume_test_run_id, chunk_one, projection_one, 'Resume fixture'
  );
  perform internal.complete_jiaowubao_direct_import(resume_test_run_id, 'Resume fixture');
  completed_run_id := internal.begin_jiaowubao_direct_import(envelope, 'Resume fixture');
  if completed_run_id <> resume_test_run_id
     or not exists (
       select 1
       from internal.jiaowubao_direct_import_runs run_state
       where run_state.id = resume_test_run_id and run_state.state = 'complete'
     ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_resume_completion_failed';
  end if;

  -- Abort removes every staged relation in dependency order, retains only the
  -- run/audit boundary, and lets the identical immutable revision start anew.
  abort_envelope := jsonb_set(envelope, '{revision}', to_jsonb('sha256:' || repeat('e', 64)))
    || jsonb_build_object(
      'workbooks', jsonb_set(
        jsonb_set(workbooks, '{1,sourceRecordCount}', '1'::jsonb),
        '{5,sourceRecordCount}', '1'::jsonb
      ),
      'recordCounts', jsonb_set(
        jsonb_set(record_counts, '{student_snapshot}', '1'::jsonb),
        '{schedule_event}', '1'::jsonb
      ),
      'expectedCounts', jsonb_build_object(
        'supplementalRecords', 1,
        'scheduleEvents', 1,
        'scheduleParticipants', 1,
        'leaveMakeups', 0
      ),
      'chunkCount', 1
    );
  abort_chunk := jsonb_set(chunk_zero, '{revision}', abort_envelope -> 'revision')
    || jsonb_build_object(
      'workbooks', abort_envelope -> 'workbooks',
      'recordCounts', abort_envelope -> 'recordCounts',
      'chunk', jsonb_build_object('index', 0, 'count', 1),
      'records', jsonb_build_array(
        jsonb_build_object(
          'kind', 'student_snapshot',
          'sourceKey', 'abort:student:0',
          'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'students', 'row', 2)),
          'sourceDigest', repeat('f', 64),
          'studentRelationship', jsonb_build_object(
            'state', 'pending_authoritative_tencent_match',
            'automaticAttachment', 'forbidden',
            'sourceIdentity', 'tabular_identity_hint'
          ),
          'payload', jsonb_build_object('source', '{}'::jsonb, 'staging', '{}'::jsonb)
        ),
        jsonb_build_object(
          'kind', 'schedule_event',
          'sourceKey', 'abort:schedule:0',
          'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'schedule', 'row', 2, 'cell', 'A2')),
          'sourceDigest', repeat('1', 64),
          'studentRelationship', jsonb_build_object(
            'state', 'source_event_only',
            'automaticAttachment', 'forbidden',
            'sourceIdentity', 'schedule_display_names'
          ),
          'payload', jsonb_build_object(
            'source', jsonb_build_object(
              'studentDisplayNames', jsonb_build_array('Unmatched Student'),
              'declaredCount', 1
            ),
            'staging', jsonb_build_object('temporal', jsonb_build_object(
              'state', 'resolved',
              'reason', 'ignored-on-resolved-records',
              'sourceDate', '2026-08-19',
              'sourceTimezone', 'Australia/Melbourne',
              'start', '09:00:00',
              'end', '10:00:00',
              'sourceStartInstant', '2026-08-18T23:00:00.000Z',
              'sourceEndInstant', '2026-08-19T00:00:00.000Z'
            ))
          )
        )
      )
    );
  abort_projection := jsonb_set(projection_zero, '{supplemental,0,sourceKey}', '"abort:student:0"'::jsonb)
    || jsonb_build_object('scheduleEvents', jsonb_build_array(jsonb_build_object(
      'sourceKey', 'abort:schedule:0',
      'teacherResolution', 'unresolved',
      'teacherId', null,
      'availabilityEffect', 'display_only',
      'participants', jsonb_build_array(jsonb_build_object(
        'participantKey', 'abort:participant:0',
        'sourceDisplayName', 'Unmatched Student',
        'identitySupplementalSourceKey', null,
        'resolution', jsonb_build_object('state', 'quarantined', 'reason', 'unmatched_tencent_student')
      ))
    )));
  abort_test_run_id := internal.begin_jiaowubao_direct_import(abort_envelope, 'Resume fixture');
  perform internal.stage_jiaowubao_direct_import_chunk(
    abort_test_run_id, abort_chunk, abort_projection, 'Resume fixture'
  );
  abort_receipt := internal.abort_jiaowubao_direct_import(abort_test_run_id, 'Resume fixture');
  if abort_receipt ->> 'state' <> 'aborted'
     or not exists (
       select 1
       from internal.jiaowubao_direct_import_runs run_state
       where run_state.id = abort_test_run_id
         and run_state.state = 'aborted'
         and run_state.abort_audit_id is not null
         and run_state.aborted_at is not null
     )
     or exists (select 1 from internal.jiaowubao_direct_import_workbooks workbook where workbook.run_id = abort_test_run_id)
     or exists (select 1 from internal.jiaowubao_direct_import_chunks chunk where chunk.run_id = abort_test_run_id)
     or exists (select 1 from internal.jiaowubao_direct_supplemental_records supplemental_record where supplemental_record.run_id = abort_test_run_id)
     or exists (select 1 from internal.jiaowubao_direct_schedule_events schedule_event where schedule_event.run_id = abort_test_run_id)
     or exists (select 1 from internal.jiaowubao_direct_leave_makeup_events leave_makeup_event where leave_makeup_event.run_id = abort_test_run_id)
     or exists (
       select 1
       from internal.jiaowubao_direct_schedule_event_participants participant
       join internal.jiaowubao_direct_schedule_events schedule_event
         on schedule_event.id = participant.event_id
       where schedule_event.run_id = abort_test_run_id
     ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_abort_cleanup_failed';
  end if;

  reopened_test_run_id := internal.begin_jiaowubao_direct_import(abort_envelope, 'Resume fixture');
  if reopened_test_run_id = abort_test_run_id
     or not exists (
       select 1
       from internal.jiaowubao_direct_import_runs run_state
       where run_state.id = reopened_test_run_id and run_state.state = 'staging'
     ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_abort_resume_failed';
  end if;
end;
$jiaowubao_direct_import_resume_contract$;

rollback;
