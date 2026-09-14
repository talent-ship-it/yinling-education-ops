\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Local-only staging throughput fixture. It builds one maximum-sized schedule
-- chunk (1,499 events and 1,499 display participants plus one identity), runs the
-- real private stager, reports wall time, and rolls the entire fixture back.

begin;

\ir ../../supabase/migrations/20260819000100_create_jiaowubao_direct_import_projection.sql
\ir ../../supabase/migrations/20260819000600_fix_jiaowubao_direct_import_envelope_precedence.sql
\ir ../../supabase/migrations/20260819000700_fix_jiaowubao_direct_import_stage_alias_ambiguity.sql
\ir ../../supabase/migrations/20260819000800_fix_jiaowubao_direct_import_completion_proof.sql
\ir ../../supabase/migrations/20260819000900_optimize_jiaowubao_direct_import_completion_proof.sql
\ir ../../supabase/migrations/20260819001000_batch_jiaowubao_direct_import_schedule_stage.sql
\ir ../../supabase/migrations/20260819001100_resume_jiaowubao_direct_import_chunks.sql
\ir ../../supabase/migrations/20260819001200_guard_jiaowubao_direct_import_auto_abort.sql

do $jiaowubao_direct_import_stage_performance$
declare
  test_run_id uuid;
  test_audit_id uuid;
  test_records jsonb;
  test_projection_supplemental jsonb;
  test_projection_events jsonb;
  test_workbooks jsonb;
  test_record_counts jsonb;
  test_chunk jsonb;
  test_projection jsonb;
  benchmark_started_at timestamptz;
  benchmark_elapsed_ms numeric;
  replay_receipt jsonb;
begin
  test_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.stage_performance_fixture',
    'Stage performance fixture',
    'jiaowubao_direct_import_run',
    'local-only',
    '{}'::jsonb
  );

  test_workbooks := jsonb_build_array(
    jsonb_build_object('kind', 'quick_list', 'workbookName', 'quick.xlsx', 'workbookSha256', repeat('1', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'students', 'workbookName', 'students.xlsx', 'workbookSha256', repeat('2', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 1),
    jsonb_build_object('kind', 'contracts', 'workbookName', 'contracts.xlsx', 'workbookSha256', repeat('3', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'hours', 'workbookName', 'hours.xlsx', 'workbookSha256', repeat('4', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'class_members', 'workbookName', 'classes.xlsx', 'workbookSha256', repeat('5', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
    jsonb_build_object('kind', 'schedule', 'workbookName', 'schedule.xlsx', 'workbookSha256', repeat('6', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 1499),
    jsonb_build_object('kind', 'leave_makeups', 'workbookName', 'leave.xlsx', 'workbookSha256', repeat('7', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0)
  );
  test_record_counts := jsonb_build_object(
    'student_snapshot', 1,
    'quick_list', 0,
    'contract_history', 0,
    'hour_balance', 0,
    'class_membership', 0,
    'schedule_event', 1499,
    'leave_makeup', 0
  );

  insert into internal.jiaowubao_direct_import_runs (
    source_id, revision, format, source_timezone, source_timezone_basis,
    master_source_id, master_revision, master_rows_sha256,
    expected_chunk_count, source_record_counts, expected_counts,
    state, staged_by, staging_audit_id
  ) values (
    'jiaowubao-static-excel', 'sha256:' || repeat('a', 64),
    'jiaowubao-direct-import-v1', 'Australia/Melbourne', 'local fixture',
    'master', 'local-fixture', repeat('b', 64), 1,
    test_record_counts,
    jsonb_build_object(
      'supplementalRecords', 1,
      'scheduleEvents', 1499,
      'scheduleParticipants', 1499,
      'leaveMakeups', 0
    ),
    'staging', 'Stage performance fixture', test_audit_id
  ) returning id into test_run_id;

  insert into internal.jiaowubao_direct_import_workbooks (
    run_id, workbook_kind, workbook_name, workbook_sha256, sheet_name, row_count
  )
  select
    test_run_id,
    workbook.value ->> 'kind',
    workbook.value ->> 'workbookName',
    workbook.value ->> 'workbookSha256',
    workbook.value ->> 'sheetName',
    (workbook.value ->> 'sourceRecordCount')::integer
  from jsonb_array_elements(test_workbooks) workbook(value);

  select jsonb_agg(jsonb_build_object(
    'kind', 'schedule_event',
    'sourceKey', 'stage-performance:schedule:' || event_number::text,
    'sourceRefs', jsonb_build_array(jsonb_build_object(
      'workbook', 'schedule', 'row', event_number, 'cell', 'A' || event_number::text
    )),
    'sourceDigest', repeat('c', 64),
    'studentRelationship', jsonb_build_object(
      'state', 'source_event_only',
      'automaticAttachment', 'forbidden',
      'sourceIdentity', 'schedule_display_names'
    ),
    'payload', jsonb_build_object(
      'source', jsonb_build_object(
        'studentDisplayNames', jsonb_build_array('Student ' || event_number::text),
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
  ) order by event_number)
  into test_records
  from generate_series(1, 1499) event_number;

  test_records := jsonb_build_array(jsonb_build_object(
    'kind', 'student_snapshot',
    'sourceKey', 'stage-performance:student:1',
    'sourceRefs', jsonb_build_array(jsonb_build_object(
      'workbook', 'students', 'row', 2
    )),
    'sourceDigest', repeat('d', 64),
    'studentRelationship', jsonb_build_object(
      'state', 'pending_authoritative_tencent_match',
      'automaticAttachment', 'forbidden',
      'sourceIdentity', 'tabular_identity_hint'
    ),
    'payload', jsonb_build_object(
      'source', jsonb_build_object(
        'identity', jsonb_build_object('name', 'Student 1', 'phone', '0400000001')
      ),
      'staging', '{}'::jsonb
    )
  )) || test_records;

  test_projection_supplemental := jsonb_build_array(jsonb_build_object(
    'sourceKey', 'stage-performance:student:1',
    'resolution', jsonb_build_object(
      'state', 'attached',
      'studentId', 'student-1',
      'masterSourceRow', 'master-row-1',
      'reason', null
    ),
    'identityProof', true
  ));

  select jsonb_agg(jsonb_build_object(
    'sourceKey', 'stage-performance:schedule:' || event_number::text,
    'teacherResolution', 'unresolved',
    'teacherId', null,
    'availabilityEffect', 'display_only',
    'participants', jsonb_build_array(jsonb_build_object(
      'participantKey', 'participant:' || event_number::text,
      'sourceDisplayName', 'Student ' || event_number::text,
      'identitySupplementalSourceKey', case when event_number = 1
        then 'stage-performance:student:1' else null end,
      'resolution', case when event_number = 1
        then jsonb_build_object('state', 'attached', 'reason', null)
        else jsonb_build_object('state', 'quarantined', 'reason', 'unmatched_tencent_student') end
    ))
  ) order by event_number)
  into test_projection_events
  from generate_series(1, 1499) event_number;

  test_chunk := jsonb_build_object(
    'format', 'jiaowubao-direct-staging-v1',
    'revision', 'sha256:' || repeat('a', 64),
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
    'sourceTimezoneBasis', 'local fixture',
    'workbooks', test_workbooks,
    'recordCounts', test_record_counts,
    'chunk', jsonb_build_object('index', 0, 'count', 1),
    'records', test_records
  );
  test_projection := jsonb_build_object(
    'supplemental', test_projection_supplemental,
    'scheduleEvents', test_projection_events,
    'leaveMakeups', '[]'::jsonb
  );

  benchmark_started_at := clock_timestamp();
  perform internal.stage_jiaowubao_direct_import_chunk(
    test_run_id, test_chunk, test_projection, 'Stage performance fixture'
  );
  benchmark_elapsed_ms := extract(epoch from (clock_timestamp() - benchmark_started_at)) * 1000;
  raise notice 'jiaowubao stage: 1499 events + 1499 participants + 1 identity in % ms', round(benchmark_elapsed_ms, 3);

  if (select count(*) from internal.jiaowubao_direct_schedule_events event where event.run_id = test_run_id) <> 1499
     or (select count(*) from internal.jiaowubao_direct_schedule_event_participants participant
         join internal.jiaowubao_direct_schedule_events event on event.id = participant.event_id
         where event.run_id = test_run_id) <> 1499 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_stage_fixture_count_mismatch';
  end if;
  if exists (
    select 1
    from internal.jiaowubao_direct_schedule_events event
    where event.run_id = test_run_id
      and event.time_parse_reason is not null
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_resolved_reason_regression';
  end if;
  if not exists (
    select 1
    from internal.jiaowubao_direct_schedule_event_participants participant
    join internal.jiaowubao_direct_schedule_events event on event.id = participant.event_id
    join internal.jiaowubao_direct_supplemental_records identity_record
      on identity_record.id = participant.identity_supplemental_record_id
    where event.run_id = test_run_id
      and event.source_key = 'stage-performance:schedule:1'
      and participant.resolution_state = 'attached'
      and participant.student_id = 'student-1'
      and participant.master_source_row = 'master-row-1'
      and identity_record.source_key = 'stage-performance:student:1'
      and identity_record.identity_proof
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_bulk_identity_attachment_failed';
  end if;

  replay_receipt := internal.stage_jiaowubao_direct_import_chunk(
    test_run_id, test_chunk, test_projection, 'Stage performance fixture'
  );
  if replay_receipt ->> 'replayed' <> 'true'
     or (select count(*) from internal.jiaowubao_direct_schedule_events event where event.run_id = test_run_id) <> 1499
     or (select count(*) from internal.jiaowubao_direct_schedule_event_participants participant
         join internal.jiaowubao_direct_schedule_events event on event.id = participant.event_id
         where event.run_id = test_run_id) <> 1499 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_bulk_stage_replay_failed';
  end if;
end;
$jiaowubao_direct_import_stage_performance$;

rollback;
