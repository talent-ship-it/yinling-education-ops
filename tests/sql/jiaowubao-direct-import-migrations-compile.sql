\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Disposable compile contract for the direct Jiaowubao projection.
--
-- Run only against a local/staging database whose baseline includes the
-- deployed 20260817000800 student-import and booking contracts:
--   psql ... -f tests/sql/jiaowubao-direct-import-migrations-compile.sql
--
-- It applies the direct-import forward chain inside one outer transaction and
-- deliberately rolls every schema/data change back. It never reads an Excel
-- file or connects to production. The tiny synthetic authority/run below
-- exists only inside this transaction so completion is executed end to end.

begin;

\ir ../../supabase/migrations/20260819000100_create_jiaowubao_direct_import_projection.sql
\ir ../../supabase/migrations/20260819000200_read_jiaowubao_direct_import_projection.sql
-- `ileaudit` intentionally omits the historic booking RPC that migration 003
-- patches. A mapping-only local regression can set this test-only variable;
-- normal compile-contract runs still apply the complete forward chain.
\if :{?skip_jiaowubao_booking_capacity_guard}
\else
\ir ../../supabase/migrations/20260819000300_guard_booking_capacity_against_jiaowubao_schedule.sql
\endif
\ir ../../supabase/migrations/20260819000600_fix_jiaowubao_direct_import_envelope_precedence.sql
\ir ../../supabase/migrations/20260819000700_fix_jiaowubao_direct_import_stage_alias_ambiguity.sql
\ir ../../supabase/migrations/20260819000800_fix_jiaowubao_direct_import_completion_proof.sql
\ir ../../supabase/migrations/20260819000900_optimize_jiaowubao_direct_import_completion_proof.sql
\ir ../../supabase/migrations/20260819001000_batch_jiaowubao_direct_import_schedule_stage.sql
\ir ../../supabase/migrations/20260819001100_resume_jiaowubao_direct_import_chunks.sql
\ir ../../supabase/migrations/20260819001200_guard_jiaowubao_direct_import_auto_abort.sql
\ir ../../supabase/migrations/20260819100400_read_jiaowubao_operations_readiness.sql
\ir ../../supabase/migrations/20260819100500_review_jiaowubao_schedule_label_mappings.sql
\ir ../../supabase/migrations/20260819100600_materialize_jiaowubao_schedule_mapping_candidates.sql

-- The fixture is one disposable transaction. Override only the secret check
-- so the new reader can execute its full SQL body against the synthetic
-- completed run below; rollback restores the baseline definition.
create or replace function internal.verify_ops_secret(p_secret text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_secret = 'jiaowubao-readiness-fixture-secret';
$$;

-- Some lightweight local audit fixtures provide only a UUID generator. The
-- direct-import schema correctly has foreign keys to real audit rows, so the
-- mapping runtime can opt into this transaction-local canonical writer when
-- exercising against that intentionally reduced baseline. Production-like
-- compile runs leave the deployed audit function untouched.
\if :{?use_fixture_audit_ledger}
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
\endif

do $jiaowubao_direct_import_compile_contract$
declare
  test_run_id uuid;
  test_source_audit_id uuid;
  mapping_first_page jsonb;
  mapping_second_page jsonb;
  mapping_after_confirm jsonb;
  mapping_after_revoke jsonb;
  mapping_after_authority_change jsonb;
  confirm_receipt jsonb;
  confirm_replay_receipt jsonb;
  confirm_noop_receipt jsonb;
  revoke_receipt jsonb;
  revoke_noop_receipt jsonb;
  revoke_replay_receipt jsonb;
  remapped_receipt jsonb;
  mapping_key text;
  mapping_cursor text;
  initial_decision_id uuid;
  oversized_teacher_catalog jsonb;
  oversized_subject_catalog jsonb;
  valid_envelope jsonb := jsonb_build_object(
    'format', 'jiaowubao-direct-import-v1',
    'sourceId', 'jiaowubao-static-excel',
    'revision', 'sha256:' || repeat('a', 64),
    'sourceTimezone', 'Australia/Melbourne',
    'sourceTimezoneBasis', 'fixture',
    'masterSource', jsonb_build_object(
      'sourceId', 'master',
      'revision', 'fixture',
      'rowsSha256', repeat('b', 64)
    ),
    'workbooks', jsonb_build_array(
      jsonb_build_object('kind', 'quick_list', 'workbookName', 'quick.xlsx', 'workbookSha256', repeat('c', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
      jsonb_build_object('kind', 'students', 'workbookName', 'students.xlsx', 'workbookSha256', repeat('d', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
      jsonb_build_object('kind', 'contracts', 'workbookName', 'contracts.xlsx', 'workbookSha256', repeat('e', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
      jsonb_build_object('kind', 'hours', 'workbookName', 'hours.xlsx', 'workbookSha256', repeat('f', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
      jsonb_build_object('kind', 'class_members', 'workbookName', 'classes.xlsx', 'workbookSha256', repeat('1', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0),
      jsonb_build_object('kind', 'schedule', 'workbookName', 'schedule.xlsx', 'workbookSha256', repeat('2', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 2),
      jsonb_build_object('kind', 'leave_makeups', 'workbookName', 'leave.xlsx', 'workbookSha256', repeat('3', 64), 'sheetName', 'Sheet1', 'sourceRecordCount', 0)
    ),
    'recordCounts', jsonb_build_object(
      'student_snapshot', 0,
      'quick_list', 0,
      'contract_history', 0,
      'hour_balance', 0,
      'class_membership', 0,
      'schedule_event', 2,
      'leave_makeup', 0
    ),
    'expectedCounts', jsonb_build_object(
      'supplementalRecords', 0,
      'scheduleEvents', 2,
      'scheduleParticipants', 2,
      'leaveMakeups', 0
    ),
    'chunkCount', 1
  );
  valid_chunk jsonb;
  valid_projection jsonb;
begin
  if to_regclass('internal.jiaowubao_direct_import_runs') is null
     or to_regclass('internal.jiaowubao_direct_schedule_events') is null
     or to_regclass('internal.jiaowubao_direct_schedule_event_participants') is null
     or to_regclass('internal.jiaowubao_direct_leave_makeup_events') is null then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_compile_tables_missing';
  end if;

  if to_regprocedure('internal.begin_jiaowubao_direct_import(jsonb,text)') is null
     or to_regprocedure('internal.stage_jiaowubao_direct_import_chunk(uuid,jsonb,jsonb,text)') is null
     or to_regprocedure('internal.complete_jiaowubao_direct_import(uuid,text)') is null
     or to_regprocedure('internal.abort_jiaowubao_direct_import_if_current_master_differs(uuid,text,text,text,text)') is null
     or to_regprocedure('public.get_jiaowubao_direct_schedule_window(text,timestamptz,timestamptz,text,text[],text[],integer,timestamptz,uuid,uuid)') is null
     or to_regprocedure('public.get_jiaowubao_direct_student_history(text,text,integer)') is null
     or to_regprocedure('public.get_jiaowubao_direct_operations_readiness(text,timestamptz,timestamptz,integer,integer,integer)') is null
     or to_regprocedure('public.get_jiaowubao_direct_schedule_mapping_review(text,integer,text)') is null
     or to_regprocedure('public.put_jiaowubao_direct_schedule_label_mapping(text,text,uuid,text,text,text,bigint,text)') is null then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_compile_functions_missing';
  end if;

  insert into public.ops_state (entity, payload, version, updated_by) values
    ('students', '[]'::jsonb, 1, 'Migration fixture'),
    ('teachers', jsonb_build_array(jsonb_build_object(
      'id', 'mapping-teacher-1',
      'name', 'Current Mapping Teacher',
      'subjects', jsonb_build_array('Mapping Subject A', 'Mapping Subject B')
    )), 1, 'Migration fixture'),
    ('bookings', '[]'::jsonb, 1, 'Migration fixture');
  test_source_audit_id := internal.append_operational_contract_audit(
    'student_import.fixture',
    'Migration fixture',
    'student_import_source',
    'master',
    '{}'::jsonb
  );
  insert into internal.student_import_source_rows (
    source_kind, source_id, revision, rows, row_count, rows_sha256,
    ingested_by, audit_id
  ) values (
    'master', 'master', 'fixture', '[]'::jsonb, 0, repeat('b', 64),
    'Migration fixture', test_source_audit_id
  );

  -- Regression: before 20260819000600, PostgreSQL parsed the nested JSONB
  -- key subtraction as `p_envelope -> ('recordCounts' - text[])` and a valid
  -- envelope failed with an operator error before any reviewed shape error.
  perform internal.jiaowubao_direct_import_assert_envelope(valid_envelope);
  test_run_id := internal.begin_jiaowubao_direct_import(valid_envelope, 'Migration fixture');

  valid_chunk := jsonb_build_object(
    'format', 'jiaowubao-direct-staging-v1',
    'revision', valid_envelope ->> 'revision',
    'contract', jsonb_build_object(
      'storage', 'server_only_relational_staging',
      'studentAuthority', 'tencent_master',
      'studentCreation', 'forbidden',
      'studentMatching', 'server_side_current_tencent_only',
      'scheduleProjection', 'read_only_imported_schedule_event',
      'scheduleBookingExpansion', 'forbidden',
      'sourceMutation', 'forbidden'
    ),
    'sourceTimezone', valid_envelope ->> 'sourceTimezone',
    'sourceTimezoneBasis', valid_envelope ->> 'sourceTimezoneBasis',
    'workbooks', valid_envelope -> 'workbooks',
    'recordCounts', valid_envelope -> 'recordCounts',
    'chunk', jsonb_build_object('index', 0, 'count', 1),
    'records', jsonb_build_array(
      jsonb_build_object(
        'kind', 'schedule_event',
        'sourceKey', 'jwb-mapping-fixture:schedule:1',
        'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'schedule', 'row', 2, 'cell', 'A2')),
        'sourceDigest', repeat('4', 64),
        'studentRelationship', jsonb_build_object(
          'state', 'source_event_only',
          'automaticAttachment', 'forbidden',
          'sourceIdentity', 'schedule_display_names'
        ),
        'payload', jsonb_build_object(
          'source', jsonb_build_object(
            'teacher', 'JWB Fixture Teacher',
            'course', 'JWB Fixture Course A',
            'className', 'JWB Fixture Class A',
            'studentDisplayNames', jsonb_build_array('Fixture Student A'),
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
      ),
      jsonb_build_object(
        'kind', 'schedule_event',
        'sourceKey', 'jwb-mapping-fixture:schedule:2',
        'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'schedule', 'row', 3, 'cell', 'A3')),
        'sourceDigest', repeat('5', 64),
        'studentRelationship', jsonb_build_object(
          'state', 'source_event_only',
          'automaticAttachment', 'forbidden',
          'sourceIdentity', 'schedule_display_names'
        ),
        'payload', jsonb_build_object(
          'source', jsonb_build_object(
            'teacher', 'JWB Fixture Teacher',
            'course', 'JWB Fixture Course B',
            'className', 'JWB Fixture Class B',
            'studentDisplayNames', jsonb_build_array('Fixture Student B'),
            'declaredCount', 1
          ),
          'staging', jsonb_build_object('temporal', jsonb_build_object(
            'state', 'resolved',
            'reason', 'ignored-on-resolved-records',
            'sourceDate', '2026-08-19',
            'sourceTimezone', 'Australia/Melbourne',
            'start', '10:00:00',
            'end', '11:00:00',
            'sourceStartInstant', '2026-08-19T00:00:00.000Z',
            'sourceEndInstant', '2026-08-19T01:00:00.000Z'
          ))
        )
      )
    )
  );
  perform internal.jiaowubao_direct_import_assert_staging_chunk(test_run_id, valid_chunk);
  valid_projection := jsonb_build_object(
    'supplemental', '[]'::jsonb,
    'scheduleEvents', jsonb_build_array(
      jsonb_build_object(
        'sourceKey', 'jwb-mapping-fixture:schedule:1',
        'teacherResolution', 'unresolved',
        'teacherId', null,
        'availabilityEffect', 'display_only',
        'participants', jsonb_build_array(jsonb_build_object(
          'participantKey', 'jwb-mapping-fixture:participant:1',
          'sourceDisplayName', 'Fixture Student A',
          'identitySupplementalSourceKey', null,
          'resolution', jsonb_build_object('state', 'quarantined', 'reason', 'unmatched_tencent_student')
        ))
      ),
      jsonb_build_object(
        'sourceKey', 'jwb-mapping-fixture:schedule:2',
        'teacherResolution', 'unresolved',
        'teacherId', null,
        'availabilityEffect', 'display_only',
        'participants', jsonb_build_array(jsonb_build_object(
          'participantKey', 'jwb-mapping-fixture:participant:2',
          'sourceDisplayName', 'Fixture Student B',
          'identitySupplementalSourceKey', null,
          'resolution', jsonb_build_object('state', 'quarantined', 'reason', 'unmatched_tencent_student')
        ))
      )
    ),
    'leaveMakeups', '[]'::jsonb
  );
  -- Runtime regression: this must execute the complete private stage function,
  -- not merely create it. PostgreSQL compiles the PL/pgSQL statements on this
  -- first call, which catches local-variable / SQL-alias ambiguity.
  perform internal.stage_jiaowubao_direct_import_chunk(
    test_run_id, valid_chunk, valid_projection, 'Migration fixture'
  );
  -- Runtime regression: completion reaches the persisted per-chunk proof that
  -- previously parsed `supplemental_count` as both a PL/pgSQL local and a CTE
  -- column. The run guard must execute the repaired assertion exactly once.
  perform internal.complete_jiaowubao_direct_import(test_run_id, 'Migration fixture');
  if not exists (
    select 1
    from internal.jiaowubao_direct_import_runs completed_run
    where completed_run.id = test_run_id
      and completed_run.state = 'complete'
      and completed_run.payload_sha256 ~ '^[a-f0-9]{64}$'
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_import_compile_completion_failed';
  end if;
  if (public.get_jiaowubao_direct_operations_readiness(
    'jiaowubao-readiness-fixture-secret',
    '2026-08-19T00:00:00.000Z'::timestamptz,
    '2026-08-20T00:00:00.000Z'::timestamptz,
    120,
    120,
    160
  ) ->> 'state') <> 'complete' then
    raise exception using errcode = 'P0001', message = 'jiaowubao_direct_operations_readiness_compile_failed';
  end if;
  -- A genuine paired schedule source reaches the mapping overlay. Keep this
  -- whole regression inside the outer rollback: it proves the source stays
  -- immutable while one opaque pair candidate is confirmed/replayed/revoked.
  mapping_first_page := public.get_jiaowubao_direct_schedule_mapping_review(
    'jiaowubao-readiness-fixture-secret', 1, null
  );
  if mapping_first_page ->> 'state' <> 'complete'
     or coalesce((mapping_first_page #>> '{summary,total}')::integer, -1) <> 2
     or jsonb_array_length(mapping_first_page -> 'candidates') <> 1
     or mapping_first_page ->> 'nextCursor' is null
     or coalesce((mapping_first_page #>> '{candidates,0,eventCount}')::integer, -1) <> 1 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_first_cursor_page_failed';
  end if;
  mapping_key := mapping_first_page #>> '{candidates,0,mappingKey}';
  mapping_cursor := mapping_first_page ->> 'nextCursor';
  mapping_second_page := public.get_jiaowubao_direct_schedule_mapping_review(
    'jiaowubao-readiness-fixture-secret', 1, mapping_cursor
  );
  if mapping_second_page ->> 'state' <> 'complete'
     or jsonb_array_length(mapping_second_page -> 'candidates') <> 1
     or mapping_second_page ->> 'nextCursor' is not null
     or mapping_second_page #>> '{candidates,0,mappingKey}' = mapping_key then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_second_cursor_page_failed';
  end if;

  confirm_receipt := public.put_jiaowubao_direct_schedule_label_mapping(
    'jiaowubao-readiness-fixture-secret', mapping_key,
    '00000000-0000-4000-8000-000000000001'::uuid,
    'confirm', 'mapping-teacher-1', 'Mapping Subject A', 1, 'Nixon'
  );
  if confirm_receipt ->> 'unchanged' <> 'false'
     or confirm_receipt ->> 'targetTeacherId' <> 'mapping-teacher-1'
     or confirm_receipt ->> 'targetSubjectId' <> 'Mapping Subject A' then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_confirm_failed';
  end if;
  mapping_after_confirm := public.get_jiaowubao_direct_schedule_mapping_review(
    'jiaowubao-readiness-fixture-secret', 80, null
  );
  if not exists (
    select 1
    from jsonb_array_elements(mapping_after_confirm -> 'candidates') candidate(value)
    where candidate.value ->> 'mappingKey' = mapping_key
      and candidate.value ->> 'status' = 'confirmed'
      and candidate.value ->> 'targetTeacherId' = 'mapping-teacher-1'
      and candidate.value ->> 'targetSubjectId' = 'Mapping Subject A'
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_confirm_readback_failed';
  end if;

  -- Same UUID is a replay, while a new UUID on the same state is retained as
  -- an append-only no-op receipt. Both paths prevent a command UUID from
  -- becoming reusable after state changes.
  confirm_replay_receipt := public.put_jiaowubao_direct_schedule_label_mapping(
    'jiaowubao-readiness-fixture-secret', mapping_key,
    '00000000-0000-4000-8000-000000000001'::uuid,
    'confirm', 'mapping-teacher-1', 'Mapping Subject A', 1, 'Nixon'
  );
  if confirm_replay_receipt ->> 'unchanged' <> 'true'
     or (select count(*) from internal.jiaowubao_direct_schedule_label_mapping_decisions) <> 1 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_confirm_replay_failed';
  end if;
  select id into initial_decision_id
  from internal.jiaowubao_direct_schedule_label_mapping_decisions decision_row
  where decision_row.command_key = '00000000-0000-4000-8000-000000000001'::uuid;
  confirm_noop_receipt := public.put_jiaowubao_direct_schedule_label_mapping(
    'jiaowubao-readiness-fixture-secret', mapping_key,
    '00000000-0000-4000-8000-000000000002'::uuid,
    'confirm', 'mapping-teacher-1', 'Mapping Subject A', 1, 'Nixon'
  );
  if confirm_noop_receipt ->> 'unchanged' <> 'true'
     or not exists (
       select 1
       from internal.jiaowubao_direct_schedule_label_mapping_decisions decision_row
       where decision_row.command_key = '00000000-0000-4000-8000-000000000002'::uuid
         and decision_row.supersedes_decision_id = initial_decision_id
     ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_noop_receipt_failed';
  end if;

  revoke_receipt := public.put_jiaowubao_direct_schedule_label_mapping(
    'jiaowubao-readiness-fixture-secret', mapping_key,
    '00000000-0000-4000-8000-000000000003'::uuid,
    'revoke', null, null, 1, 'Nixon'
  );
  if revoke_receipt ->> 'unchanged' <> 'false'
     or (select count(*) from internal.jiaowubao_direct_schedule_label_mapping_decisions) <> 3
     or not exists (
       select 1
       from internal.jiaowubao_direct_schedule_label_mapping_decisions decision_row
       where decision_row.command_key = '00000000-0000-4000-8000-000000000003'::uuid
         and decision_row.decision = 'revoked'
         and decision_row.supersedes_decision_id is not null
     ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_revoke_supersede_failed';
  end if;
  mapping_after_revoke := public.get_jiaowubao_direct_schedule_mapping_review(
    'jiaowubao-readiness-fixture-secret', 80, null
  );
  if not exists (
    select 1
    from jsonb_array_elements(mapping_after_revoke -> 'candidates') candidate(value)
    where candidate.value ->> 'mappingKey' = mapping_key
      and candidate.value ->> 'status' = 'revoked'
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_revoke_readback_failed';
  end if;
  revoke_noop_receipt := public.put_jiaowubao_direct_schedule_label_mapping(
    'jiaowubao-readiness-fixture-secret', mapping_key,
    '00000000-0000-4000-8000-000000000004'::uuid,
    'revoke', null, null, 1, 'Nixon'
  );
  revoke_replay_receipt := public.put_jiaowubao_direct_schedule_label_mapping(
    'jiaowubao-readiness-fixture-secret', mapping_key,
    '00000000-0000-4000-8000-000000000004'::uuid,
    'revoke', null, null, 1, 'Nixon'
  );
  if revoke_noop_receipt ->> 'unchanged' <> 'true'
     or revoke_replay_receipt ->> 'unchanged' <> 'true'
     or (select count(*) from internal.jiaowubao_direct_schedule_label_mapping_decisions) <> 4 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_revoke_replay_failed';
  end if;

  -- A fresh command with a stale authoritative teacher version must fail
  -- before it can add a decision/audit receipt.
  update public.ops_state
  set version = 2,
      updated_by = 'Migration fixture authority refresh'
  where entity = 'teachers';
  begin
    perform public.put_jiaowubao_direct_schedule_label_mapping(
      'jiaowubao-readiness-fixture-secret', mapping_key,
      '00000000-0000-4000-8000-000000000005'::uuid,
      'confirm', 'mapping-teacher-1', 'Mapping Subject A', 1, 'Nixon'
    );
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_stale_version_not_rejected';
  exception when others then
    if SQLSTATE <> '40001' or SQLERRM <> 'jiaowubao_schedule_mapping_teachers_authority_changed' then
      raise;
    end if;
  end;
  if (select count(*) from internal.jiaowubao_direct_schedule_label_mapping_decisions) <> 4 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_stale_version_wrote_receipt';
  end if;

  remapped_receipt := public.put_jiaowubao_direct_schedule_label_mapping(
    'jiaowubao-readiness-fixture-secret', mapping_key,
    '00000000-0000-4000-8000-000000000006'::uuid,
    'confirm', 'mapping-teacher-1', 'Mapping Subject A', 2, 'Nixon'
  );
  if remapped_receipt ->> 'unchanged' <> 'false' then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_reconfirm_after_refresh_failed';
  end if;
  update public.ops_state
  set version = 3,
      payload = jsonb_build_array(jsonb_build_object(
        'id', 'mapping-teacher-1',
        'name', 'Current Mapping Teacher',
        'subjects', jsonb_build_array('Mapping Subject B')
      )),
      updated_by = 'Migration fixture subject refresh'
  where entity = 'teachers';
  mapping_after_authority_change := public.get_jiaowubao_direct_schedule_mapping_review(
    'jiaowubao-readiness-fixture-secret', 80, null
  );
  if not exists (
    select 1
    from jsonb_array_elements(mapping_after_authority_change -> 'candidates') candidate(value)
    where candidate.value ->> 'mappingKey' = mapping_key
      and candidate.value ->> 'status' = 'authority_changed'
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_authority_drift_readback_failed';
  end if;
  if exists (
    select 1
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = test_run_id
      and (schedule_event.teacher_resolution <> 'unresolved'
        or schedule_event.subject_resolution <> 'unresolved'
        or schedule_event.availability_effect <> 'display_only')
  ) or (select count(*) from public.ops_state where entity = 'bookings') <> 1 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_source_or_booking_mutated';
  end if;

  -- The mapping reader is not a general teacher-catalog API. Its database
  -- bounds intentionally match the independently fail-closed browser parser:
  -- overlarge authority state must fail before a partial catalog can reach a
  -- high-tier browser response.
  select jsonb_agg(jsonb_build_object(
    'id', 'catalog-teacher-' || series.value,
    'name', 'Catalog Teacher ' || series.value,
    'subjects', jsonb_build_array('Mapping Subject B')
  )) into oversized_teacher_catalog
  from generate_series(1, 513) series(value);
  update public.ops_state
  set version = 4,
      payload = oversized_teacher_catalog,
      updated_by = 'Migration fixture oversized teacher catalog'
  where entity = 'teachers';
  begin
    perform public.get_jiaowubao_direct_schedule_mapping_review(
      'jiaowubao-readiness-fixture-secret', 80, null
    );
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_teacher_catalog_bound_not_rejected';
  exception when others then
    if SQLSTATE <> '55000' or SQLERRM <> 'jiaowubao_schedule_mapping_teacher_catalog_too_large' then
      raise;
    end if;
  end;

  select jsonb_agg(to_jsonb('Mapping Subject ' || series.value))
  into oversized_subject_catalog
  from generate_series(1, 121) series(value);
  begin
    perform 1
    from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(
      jsonb_build_array(jsonb_build_object(
        'id', 'catalog-teacher-subject-bound',
        'name', 'Catalog Teacher Subject Bound',
        'subjects', oversized_subject_catalog
      ))
    ) catalog;
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_teacher_subject_catalog_bound_not_rejected';
  exception when others then
    if SQLSTATE <> '55000' or SQLERRM <> 'jiaowubao_schedule_mapping_teacher_subject_catalog_too_large' then
      raise;
    end if;
  end;
end;
$jiaowubao_direct_import_compile_contract$;

rollback;
