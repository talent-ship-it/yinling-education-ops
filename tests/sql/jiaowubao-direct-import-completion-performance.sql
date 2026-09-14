\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Local-only scale/semantic contract for the optimized completion proof.
-- It builds 39,743 distinct parsed events, times the real private validator,
-- exercises both Melbourne DST rejection paths, and rolls back everything.

begin;

\ir ../../supabase/migrations/20260819000100_create_jiaowubao_direct_import_projection.sql
\ir ../../supabase/migrations/20260819000600_fix_jiaowubao_direct_import_envelope_precedence.sql
\ir ../../supabase/migrations/20260819000700_fix_jiaowubao_direct_import_stage_alias_ambiguity.sql
\ir ../../supabase/migrations/20260819000800_fix_jiaowubao_direct_import_completion_proof.sql
\ir ../../supabase/migrations/20260819000900_optimize_jiaowubao_direct_import_completion_proof.sql

do $jiaowubao_direct_import_completion_performance$
declare
  test_run_id uuid;
  test_audit_id uuid;
  benchmark_started_at timestamptz;
  benchmark_elapsed_ms numeric;
  failure_message text;
begin
  test_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.performance_fixture',
    'Completion performance fixture',
    'jiaowubao_direct_import_run',
    'local-only',
    '{}'::jsonb
  );

  insert into internal.jiaowubao_direct_import_runs (
    source_id,
    revision,
    format,
    source_timezone,
    source_timezone_basis,
    master_source_id,
    master_revision,
    master_rows_sha256,
    expected_chunk_count,
    source_record_counts,
    expected_counts,
    state,
    staged_by,
    staging_audit_id
  ) values (
    'jiaowubao-static-excel',
    'sha256:' || repeat('9', 64),
    'jiaowubao-direct-import-v1',
    'Australia/Melbourne',
    'local rollback performance fixture',
    'master',
    'local-fixture',
    repeat('8', 64),
    1,
    jsonb_build_object(
      'student_snapshot', 0,
      'quick_list', 0,
      'contract_history', 0,
      'hour_balance', 0,
      'class_membership', 0,
      'schedule_event', 39743,
      'leave_makeup', 0
    ),
    jsonb_build_object(
      'supplementalRecords', 0,
      'scheduleEvents', 39743,
      'scheduleParticipants', 0,
      'leaveMakeups', 0
    ),
    'staging',
    'Completion performance fixture',
    test_audit_id
  )
  returning id into test_run_id;

  -- The schedule table is deliberately bound to a ledgered chunk even though
  -- this fixture calls only the projection validator, not full completion.
  insert into internal.jiaowubao_direct_import_chunks (
    run_id,
    chunk_index,
    chunk_sha256,
    source_record_counts,
    source_record_count,
    content_bytes,
    projection_sha256,
    projected_record_counts,
    audit_id
  ) values (
    test_run_id,
    0,
    repeat('5', 64),
    jsonb_build_object('schedule_event', 39743),
    39743,
    1,
    repeat('4', 64),
    jsonb_build_object(
      'supplementalRecords', 0,
      'scheduleEvents', 39743,
      'scheduleParticipants', 0,
      'leaveMakeups', 0
    ),
    test_audit_id
  );

  insert into internal.jiaowubao_direct_schedule_events (
    run_id,
    chunk_index,
    source_key,
    source_row,
    source_cell,
    source_date,
    source_timezone,
    source_timezone_basis,
    time_parse_status,
    time_parse_reason,
    dst_resolution,
    source_local_start,
    source_local_end,
    starts_at,
    ends_at,
    teacher_resolution,
    teacher_id,
    teacher_display_name,
    subject_resolution,
    availability_effect,
    source_payload,
    record_sha256
  )
  select
    test_run_id,
    0,
    'performance:schedule:' || event_number::text,
    event_number,
    'A' || event_number::text,
    date '2026-08-19',
    'Australia/Melbourne',
    'fixture wall clock interpreted in Australia/Melbourne',
    'parsed',
    null,
    'unambiguous',
    (time '00:00' + event_number * interval '1 second')::time(0),
    (time '12:00' + event_number * interval '1 second')::time(0),
    (date '2026-08-19' + (time '00:00' + event_number * interval '1 second')::time)
      at time zone 'Australia/Melbourne',
    (date '2026-08-19' + (time '12:00' + event_number * interval '1 second')::time)
      at time zone 'Australia/Melbourne',
    case when event_number <= 27011 then 'exact_name' else 'unresolved' end,
    case when event_number <= 27011 then 'teacher-1' end,
    case when event_number <= 27011 then 'Teacher 1' end,
    'unresolved',
    'display_only',
    jsonb_build_object(
      'source',
      case when event_number <= 27011
        then jsonb_build_object('teacher', 'Teacher 1')
        else jsonb_build_object()
      end
    ),
    repeat('7', 64)
  from generate_series(1, 39743) event_number;

  benchmark_started_at := clock_timestamp();
  perform internal.jiaowubao_direct_import_validate_projection(
    test_run_id,
    '[]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('id', 'teacher-1', 'name', 'Teacher 1'))
  );
  benchmark_elapsed_ms := extract(epoch from (clock_timestamp() - benchmark_started_at)) * 1000;

  raise notice 'jiaowubao completion proof: 39743 events in % ms', round(benchmark_elapsed_ms, 3);
  if benchmark_elapsed_ms > 1000 then
    raise exception using
      errcode = 'P0001',
      message = 'jiaowubao_direct_import_completion_performance_regression';
  end if;

  -- Normal Melbourne wall clocks must retain their exact claimed instants.
  perform internal.jiaowubao_direct_import_assert_unambiguous_schedule_time(
    'parsed',
    date '2026-08-19',
    'Australia/Melbourne',
    time '09:00',
    time '10:00',
    timestamp '2026-08-19 09:00' at time zone 'Australia/Melbourne',
    timestamp '2026-08-19 10:00' at time zone 'Australia/Melbourne',
    'unambiguous'
  );

  -- Melbourne repeats 02:30 when daylight saving ends. PostgreSQL's default
  -- conversion round-trips, but the adjacent-transition candidate makes the
  -- wall clock correctly fail the strict uniqueness proof.
  begin
    perform internal.jiaowubao_direct_import_assert_unambiguous_schedule_time(
      'parsed',
      date '2026-04-05',
      'Australia/Melbourne',
      time '02:30',
      time '03:30',
      timestamp '2026-04-05 02:30' at time zone 'Australia/Melbourne',
      timestamp '2026-04-05 03:30' at time zone 'Australia/Melbourne',
      'unambiguous'
    );
    raise exception using errcode = 'P0001', message = 'ambiguous_wall_clock_was_accepted';
  exception
    when sqlstate '22023' then
      get stacked diagnostics failure_message = message_text;
      if failure_message <> 'jiaowubao_direct_import_schedule_time_proof_invalid' then
        raise;
      end if;
  end;

  -- Melbourne skips 02:30 when daylight saving begins. No candidate can
  -- round-trip to the source wall clock.
  begin
    perform internal.jiaowubao_direct_import_assert_unambiguous_schedule_time(
      'parsed',
      date '2026-10-04',
      'Australia/Melbourne',
      time '02:30',
      time '03:30',
      timestamp '2026-10-04 02:30' at time zone 'Australia/Melbourne',
      timestamp '2026-10-04 03:30' at time zone 'Australia/Melbourne',
      'unambiguous'
    );
    raise exception using errcode = 'P0001', message = 'nonexistent_wall_clock_was_accepted';
  exception
    when sqlstate '22023' then
      get stacked diagnostics failure_message = message_text;
      if failure_message <> 'jiaowubao_direct_import_schedule_time_proof_invalid' then
        raise;
      end if;
  end;

  -- The set-based completion validator must reject the same repeated wall
  -- clock even though the table's ordinary round-trip check accepts it.
  insert into internal.jiaowubao_direct_schedule_events (
    run_id,
    chunk_index,
    source_key,
    source_row,
    source_cell,
    source_date,
    source_timezone,
    source_timezone_basis,
    time_parse_status,
    dst_resolution,
    source_local_start,
    source_local_end,
    starts_at,
    ends_at,
    teacher_resolution,
    subject_resolution,
    availability_effect,
    source_payload,
    record_sha256
  ) values (
    test_run_id,
    0,
    'semantic:ambiguous-schedule',
    39744,
    'A39744',
    date '2026-04-05',
    'Australia/Melbourne',
    'fixture repeated wall clock',
    'parsed',
    'unambiguous',
    time '02:30',
    time '03:30',
    timestamp '2026-04-05 02:30' at time zone 'Australia/Melbourne',
    timestamp '2026-04-05 03:30' at time zone 'Australia/Melbourne',
    'unresolved',
    'unresolved',
    'display_only',
    jsonb_build_object('source', jsonb_build_object()),
    repeat('6', 64)
  );

  begin
    perform internal.jiaowubao_direct_import_validate_projection(
      test_run_id,
      '[]'::jsonb,
      '[]'::jsonb,
      jsonb_build_array(jsonb_build_object('id', 'teacher-1', 'name', 'Teacher 1'))
    );
    raise exception using errcode = 'P0001', message = 'ambiguous_schedule_projection_was_accepted';
  exception
    when sqlstate '22023' then
      get stacked diagnostics failure_message = message_text;
      if failure_message <> 'jiaowubao_direct_import_schedule_time_proof_invalid' then
        raise;
      end if;
  end;
end;
$jiaowubao_direct_import_completion_performance$;

rollback;
