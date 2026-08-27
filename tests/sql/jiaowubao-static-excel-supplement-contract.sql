\set ON_ERROR_STOP on

-- Run against a disposable database migrated through the deployed
-- 20260817000800 baseline (or a newer compatible schema) with the normal
-- server-side operations secret:
--   psql ... -v ops_secret=... -f tests/sql/jiaowubao-static-excel-supplement-contract.sql
-- The fixture exercises only internal supplementary tables and rolls back.
\if :{?ops_secret}
\else
  \echo 'ops_secret psql variable is required'
  \quit
\endif

begin;
-- The small disposable 170008 database used by this contract fixture keeps
-- the audit helper as a UUID-only stub.  011 correctly records audit IDs as
-- foreign keys, so restore the deployed helper behaviour *inside this outer
-- transaction only*.  The ROLLBACK below restores the test baseline exactly.
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
as $jiaowubao_static_excel_fixture_audit$
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
  )
  returning id into saved_id;

  return saved_id;
end;
$jiaowubao_static_excel_fixture_audit$;

\ir ../../supabase/migrations/20260818001100_ingest_jiaowubao_static_excel_supplements.sql
set local app.jiaowubao_static_excel_fixture_ops_secret = :'ops_secret';

do $jiaowubao_static_excel_supplement_contract$
declare
  fixture_secret text := current_setting('app.jiaowubao_static_excel_fixture_ops_secret');
  manifest jsonb := jsonb_build_array(
    jsonb_build_object('kind', 'quick_list', 'workbookName', 'quick.xlsx', 'workbookSha256', repeat('1', 64), 'rowCount', 1),
    jsonb_build_object('kind', 'students', 'workbookName', 'students.xlsx', 'workbookSha256', repeat('2', 64), 'rowCount', 1),
    jsonb_build_object('kind', 'contracts', 'workbookName', 'contracts.xlsx', 'workbookSha256', repeat('3', 64), 'rowCount', 0),
    jsonb_build_object('kind', 'hours', 'workbookName', 'hours.xlsx', 'workbookSha256', repeat('4', 64), 'rowCount', 0),
    jsonb_build_object('kind', 'class_members', 'workbookName', 'classes.xlsx', 'workbookSha256', repeat('5', 64), 'rowCount', 1),
    jsonb_build_object('kind', 'schedule', 'workbookName', 'schedule.xlsx', 'workbookSha256', repeat('6', 64), 'rowCount', 1),
    jsonb_build_object('kind', 'leave_makeups', 'workbookName', 'leave.xlsx', 'workbookSha256', repeat('7', 64), 'rowCount', 0)
  );
  expected_counts jsonb := '{"facts":1,"contracts":0,"hours":0,"classMembers":0,"schedule":1,"leaveMakeups":0}'::jsonb;
  first_chunk jsonb;
  second_chunk jsonb;
  bad_chunk jsonb;
  mismatched_name_chunk jsonb;
  first_result jsonb;
  replay_result jsonb;
  complete_result jsonb;
  before_students jsonb;
  before_students_version bigint;
  after_students jsonb;
  after_students_version bigint;
  master_only_snapshot jsonb;
  master_source_provenance jsonb;
  caught_state text;
  caught_message text;
begin
  -- This source is Tencent-shaped test data.  The writer under test never
  -- creates a student from it and never writes the operational state store.
  perform public.put_student_import_source_rows(
    fixture_secret,
    'master',
    'tencent-static-fixture',
    'tencent-static-fixture-r1',
    jsonb_build_array(
      jsonb_build_object('sourceRow', 'M-ALLOWED', 'name', 'Allowed', 'status', '在读'),
      jsonb_build_object('sourceRow', 'M-EXCLUDED', 'name', 'Excluded', 'status', '不活跃 + 无课时')
    ),
    'Nixon'
  );

  -- The static path can use Tencent alone; absence of a legacy JWB/API
  -- source snapshot must not make static evidence imports unavailable.
  master_only_snapshot := public.get_current_student_import_master_source(fixture_secret);
  if master_only_snapshot #>> '{master,sourceId}' <> 'tencent-static-fixture'
     or jsonb_array_length(master_only_snapshot #> '{master,rows}') <> 2
     or coalesce(master_only_snapshot #>> '{master,rowsSha256}', '') !~ '^[a-f0-9]{64}$'
     or master_only_snapshot ? 'jwb' then
    raise exception using errcode = 'P0001', message = 'static_excel_fixture_master_only_reader_failed';
  end if;
  master_source_provenance := jsonb_build_object(
    'sourceId', master_only_snapshot #>> '{master,sourceId}',
    'revision', master_only_snapshot #>> '{master,revision}',
    'rowsSha256', master_only_snapshot #>> '{master,rowsSha256}'
  );

  select payload, version into before_students, before_students_version
  from public.ops_state where entity = 'students';

  first_chunk := jsonb_build_object(
    'format', 'jiaowubao-static-excel-v1',
    'sourceTimezone', 'Australia/Melbourne',
    'sourceTimezoneBasis', 'source export omitted timezone; approved Melbourne business rule',
    'masterSource', master_source_provenance,
    'workbooks', manifest,
    'recordCounts', expected_counts,
    'chunk', jsonb_build_object('index', 0, 'count', 2),
    'facts', jsonb_build_array(jsonb_build_object(
      'sourceKey', 'FACT-1',
      'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'students', 'row', 2)),
      'attachments', jsonb_build_array(jsonb_build_object(
        'state', 'attached', 'masterSourceRow', 'M-ALLOWED', 'evidenceName', 'Allowed', 'matchMode', 'exact_name'
      )),
      'payload', jsonb_build_object('kind', 'static_fact')
    )),
    'contracts', '[]'::jsonb,
    'hours', '[]'::jsonb,
    'classMembers', '[]'::jsonb,
    'schedule', '[]'::jsonb,
    'leaveMakeups', '[]'::jsonb
  );
  second_chunk := jsonb_build_object(
    'format', 'jiaowubao-static-excel-v1',
    'sourceTimezone', 'Australia/Melbourne',
    'sourceTimezoneBasis', 'source export omitted timezone; approved Melbourne business rule',
    'masterSource', master_source_provenance,
    'workbooks', manifest,
    'recordCounts', expected_counts,
    'chunk', jsonb_build_object('index', 1, 'count', 2),
    'facts', '[]'::jsonb,
    'contracts', '[]'::jsonb,
    'hours', '[]'::jsonb,
    'classMembers', '[]'::jsonb,
    'schedule', jsonb_build_array(jsonb_build_object(
      'sourceKey', 'SCHEDULE-C17',
      'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'schedule', 'row', 17, 'cell', 'C17')),
      'attachments', jsonb_build_array(
        jsonb_build_object('state', 'attached', 'masterSourceRow', 'M-ALLOWED', 'evidenceName', 'Allowed', 'matchMode', 'exact_name'),
        jsonb_build_object('state', 'quarantined', 'reason', 'review_required_annotation')
      ),
      'payload', jsonb_build_object('kind', 'static_schedule')
    )),
    'leaveMakeups', '[]'::jsonb
  );

  first_result := public.put_jiaowubao_static_excel_supplement(
    fixture_secret, 'jwb-static-fixture', 'jwb-static-fixture-r1', first_chunk, 'Nixon'
  );
  if first_result ->> 'state' <> 'staging'
     or first_result ->> 'receivedChunkCount' <> '1'
     or coalesce((first_result ->> 'replayed')::boolean, false) then
    raise exception using errcode = 'P0001', message = 'static_excel_fixture_first_chunk_failed';
  end if;

  replay_result := public.put_jiaowubao_static_excel_supplement(
    fixture_secret, 'jwb-static-fixture', 'jwb-static-fixture-r1', first_chunk, 'Nixon'
  );
  if not coalesce((replay_result ->> 'replayed')::boolean, false)
     or replay_result ->> 'receivedChunkCount' <> '1' then
    raise exception using errcode = 'P0001', message = 'static_excel_fixture_chunk_replay_failed';
  end if;

  complete_result := public.put_jiaowubao_static_excel_supplement(
    fixture_secret, 'jwb-static-fixture', 'jwb-static-fixture-r1', second_chunk, 'Nixon'
  );
  if complete_result ->> 'state' <> 'complete'
     or complete_result ->> 'receivedChunkCount' <> '2'
     or coalesce(complete_result ->> 'payloadSha256', '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = 'P0001', message = 'static_excel_fixture_completion_failed';
  end if;

  if (select count(*) from internal.jiaowubao_static_excel_records record
        join internal.jiaowubao_static_excel_batches batch on batch.id = record.batch_id
        where batch.source_id = 'jwb-static-fixture' and batch.revision = 'jwb-static-fixture-r1') <> 2
     or (select count(*) from internal.jiaowubao_static_excel_record_attachments attachment
        join internal.jiaowubao_static_excel_batches batch on batch.id = attachment.batch_id
        where batch.source_id = 'jwb-static-fixture' and batch.revision = 'jwb-static-fixture-r1') <> 3
     or (select count(*) from internal.jiaowubao_static_excel_batches
        where source_id = 'jwb-static-fixture' and revision = 'jwb-static-fixture-r1' and state = 'complete') <> 1 then
    raise exception using errcode = 'P0001', message = 'static_excel_fixture_storage_shape_failed';
  end if;

  select payload, version into after_students, after_students_version
  from public.ops_state where entity = 'students';
  if after_students is distinct from before_students
     or after_students_version is distinct from before_students_version then
    raise exception using errcode = 'P0001', message = 'static_excel_fixture_operational_state_changed';
  end if;

  bad_chunk := jsonb_build_object(
    'format', 'jiaowubao-static-excel-v1',
    'sourceTimezone', 'Australia/Melbourne',
    'sourceTimezoneBasis', 'source export omitted timezone; approved Melbourne business rule',
    'masterSource', master_source_provenance,
    'workbooks', manifest,
    'recordCounts', '{"facts":1,"contracts":0,"hours":0,"classMembers":0,"schedule":0,"leaveMakeups":0}'::jsonb,
    'chunk', jsonb_build_object('index', 0, 'count', 1),
    'facts', jsonb_build_array(jsonb_build_object(
      'sourceKey', 'FACT-EXCLUDED',
      'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'students', 'row', 3)),
      'attachments', jsonb_build_array(jsonb_build_object(
        'state', 'attached', 'masterSourceRow', 'M-EXCLUDED', 'evidenceName', 'Excluded', 'matchMode', 'exact_name'
      )),
      'payload', jsonb_build_object('kind', 'must_not_attach')
    )),
    'contracts', '[]'::jsonb,
    'hours', '[]'::jsonb,
    'classMembers', '[]'::jsonb,
    'schedule', '[]'::jsonb,
    'leaveMakeups', '[]'::jsonb
  );
  begin
    perform public.put_jiaowubao_static_excel_supplement(
      fixture_secret, 'jwb-static-fixture', 'jwb-static-fixture-excluded-r1', bad_chunk, 'Nixon'
    );
  exception when others then
    caught_state := SQLSTATE;
    caught_message := SQLERRM;
  end;
  if caught_state <> '22023'
     or caught_message <> 'static_excel_attachment_excluded_master_forbidden' then
    raise exception using errcode = 'P0001', message = 'static_excel_fixture_excluded_attachment_not_blocked';
  end if;

  -- The writer must independently reject a forged active-master source row
  -- when its source evidence name is not an exact Tencent name match.
  mismatched_name_chunk := jsonb_build_object(
    'format', 'jiaowubao-static-excel-v1',
    'sourceTimezone', 'Australia/Melbourne',
    'sourceTimezoneBasis', 'source export omitted timezone; approved Melbourne business rule',
    'masterSource', master_source_provenance,
    'workbooks', manifest,
    'recordCounts', '{"facts":1,"contracts":0,"hours":0,"classMembers":0,"schedule":0,"leaveMakeups":0}'::jsonb,
    'chunk', jsonb_build_object('index', 0, 'count', 1),
    'facts', jsonb_build_array(jsonb_build_object(
      'sourceKey', 'FACT-NAME-MISMATCH',
      'sourceRefs', jsonb_build_array(jsonb_build_object('workbook', 'students', 'row', 4)),
      'attachments', jsonb_build_array(jsonb_build_object(
        'state', 'attached', 'masterSourceRow', 'M-ALLOWED', 'evidenceName', 'Not Allowed', 'matchMode', 'exact_name'
      )),
      'payload', jsonb_build_object('kind', 'must_not_cross_attach')
    )),
    'contracts', '[]'::jsonb,
    'hours', '[]'::jsonb,
    'classMembers', '[]'::jsonb,
    'schedule', '[]'::jsonb,
    'leaveMakeups', '[]'::jsonb
  );
  caught_state := null;
  caught_message := null;
  begin
    perform public.put_jiaowubao_static_excel_supplement(
      fixture_secret, 'jwb-static-fixture', 'jwb-static-fixture-name-mismatch-r1', mismatched_name_chunk, 'Nixon'
    );
  exception when others then
    caught_state := SQLSTATE;
    caught_message := SQLERRM;
  end;
  if caught_state <> '22023'
     or caught_message <> 'static_excel_attachment_name_mismatch' then
    raise exception using errcode = 'P0001', message = 'static_excel_fixture_name_mismatch_not_blocked';
  end if;

  -- A resumable batch must begin at index zero.  The writer itself rejects a
  -- hand-crafted skip rather than leaving an unusable staging batch behind.
  caught_state := null;
  caught_message := null;
  begin
    perform public.put_jiaowubao_static_excel_supplement(
      fixture_secret, 'jwb-static-fixture-gap', 'jwb-static-fixture-gap-r1', second_chunk, 'Nixon'
    );
  exception when others then
    caught_state := SQLSTATE;
    caught_message := SQLERRM;
  end;
  if caught_state <> '22023'
     or caught_message <> 'static_excel_chunk_sequence_gap' then
    raise exception using errcode = 'P0001', message = 'static_excel_fixture_chunk_gap_not_blocked';
  end if;

  -- A Tencent revision change between chunks must fail closed.  The same
  -- Excel export can then be prepared again into a fresh revision bound to
  -- the new Tencent snapshot, rather than finishing a mixed-snapshot batch.
  perform public.put_jiaowubao_static_excel_supplement(
    fixture_secret, 'jwb-static-fixture-master-drift', 'jwb-static-fixture-master-r1', first_chunk, 'Nixon'
  );
  perform public.put_student_import_source_rows(
    fixture_secret,
    'master',
    'tencent-static-fixture',
    'tencent-static-fixture-r2',
    jsonb_build_array(
      jsonb_build_object('sourceRow', 'M-ALLOWED', 'name', 'Allowed', 'status', '在读'),
      jsonb_build_object('sourceRow', 'M-EXCLUDED', 'name', 'Excluded', 'status', '不活跃 + 无课时')
    ),
    'Nixon'
  );
  caught_state := null;
  caught_message := null;
  begin
    perform public.put_jiaowubao_static_excel_supplement(
      fixture_secret, 'jwb-static-fixture-master-drift', 'jwb-static-fixture-master-r1', second_chunk, 'Nixon'
    );
  exception when others then
    caught_state := SQLSTATE;
    caught_message := SQLERRM;
  end;
  if caught_state <> '40900'
     or caught_message <> 'static_excel_master_source_changed' then
    raise exception using errcode = 'P0001', message = 'static_excel_fixture_master_drift_not_blocked';
  end if;
end;
$jiaowubao_static_excel_supplement_contract$;

rollback;
