-- PostgreSQL gives the generic JSON `->` operator a different precedence than
-- subtraction.  Parenthesize nested JSONB values before removing each
-- allowed key set; without this, a valid envelope fails before our reviewed
-- shape errors can be raised, and the first valid chunk fails the same way.

set local lock_timeout = '1s';

create or replace function internal.jiaowubao_direct_import_assert_envelope(p_envelope jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_envelope$
declare
  expected_workbook_kinds text[] := ARRAY[
    'quick_list', 'students', 'contracts', 'hours',
    'class_members', 'schedule', 'leave_makeups'
  ];
begin
  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_envelope,
    ARRAY[
      'format', 'sourceId', 'revision', 'sourceTimezone', 'sourceTimezoneBasis',
      'masterSource', 'workbooks', 'recordCounts', 'expectedCounts', 'chunkCount'
    ],
    'jiaowubao_direct_import_envelope_shape_invalid'
  );
  if jsonb_typeof(p_envelope -> 'format') <> 'string'
     or p_envelope ->> 'format' <> 'jiaowubao-direct-import-v1'
     or jsonb_typeof(p_envelope -> 'sourceId') <> 'string'
     or p_envelope ->> 'sourceId' <> 'jiaowubao-static-excel'
     or jsonb_typeof(p_envelope -> 'revision') <> 'string'
     or nullif(btrim(p_envelope ->> 'revision'), '') is null
     or p_envelope ->> 'revision' <> btrim(p_envelope ->> 'revision')
     or char_length(p_envelope ->> 'revision') > 240
     or jsonb_typeof(p_envelope -> 'sourceTimezone') <> 'string'
     or p_envelope ->> 'sourceTimezone' <> 'Australia/Melbourne'
     or jsonb_typeof(p_envelope -> 'sourceTimezoneBasis') <> 'string'
     or nullif(btrim(p_envelope ->> 'sourceTimezoneBasis'), '') is null
     or p_envelope ->> 'sourceTimezoneBasis' <> btrim(p_envelope ->> 'sourceTimezoneBasis')
     or char_length(p_envelope ->> 'sourceTimezoneBasis') > 1000
     or jsonb_typeof(p_envelope -> 'chunkCount') <> 'number'
     or (p_envelope ->> 'chunkCount')::numeric <> trunc((p_envelope ->> 'chunkCount')::numeric)
     or (p_envelope ->> 'chunkCount')::numeric not between 1 and 512 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_envelope_shape_invalid';
  end if;
  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_envelope -> 'masterSource',
    ARRAY['sourceId', 'revision', 'rowsSha256'],
    'jiaowubao_direct_import_master_source_shape_invalid'
  );
  if jsonb_typeof(p_envelope -> 'masterSource' -> 'sourceId') <> 'string'
     or nullif(btrim(p_envelope -> 'masterSource' ->> 'sourceId'), '') is null
     or jsonb_typeof(p_envelope -> 'masterSource' -> 'revision') <> 'string'
     or nullif(btrim(p_envelope -> 'masterSource' ->> 'revision'), '') is null
     or jsonb_typeof(p_envelope -> 'masterSource' -> 'rowsSha256') <> 'string'
     or p_envelope -> 'masterSource' ->> 'rowsSha256' !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_master_source_shape_invalid';
  end if;
  if jsonb_typeof(p_envelope -> 'recordCounts') <> 'object'
     or not (p_envelope -> 'recordCounts' ?& ARRAY[
       'student_snapshot', 'quick_list', 'contract_history', 'hour_balance',
       'class_membership', 'schedule_event', 'leave_makeup'
     ])
     or (p_envelope -> 'recordCounts') - ARRAY[
       'student_snapshot', 'quick_list', 'contract_history', 'hour_balance',
       'class_membership', 'schedule_event', 'leave_makeup'
     ]::text[] <> '{}'::jsonb
     or exists (
       select 1 from jsonb_each(p_envelope -> 'recordCounts') record_count(key, value)
       where jsonb_typeof(record_count.value) <> 'number'
          or (record_count.value #>> '{}')::numeric < 0
          or (record_count.value #>> '{}')::numeric > 200000
          or (record_count.value #>> '{}')::numeric <> trunc((record_count.value #>> '{}')::numeric)
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_record_counts_shape_invalid';
  end if;
  if jsonb_typeof(p_envelope -> 'expectedCounts') <> 'object'
     or not (p_envelope -> 'expectedCounts' ?& ARRAY[
       'supplementalRecords', 'scheduleEvents', 'scheduleParticipants', 'leaveMakeups'
     ])
     or (p_envelope -> 'expectedCounts') - ARRAY[
       'supplementalRecords', 'scheduleEvents', 'scheduleParticipants', 'leaveMakeups'
     ]::text[] <> '{}'::jsonb
     or exists (
       select 1 from jsonb_each(p_envelope -> 'expectedCounts') expected_count(key, value)
       where jsonb_typeof(expected_count.value) <> 'number'
          or (expected_count.value #>> '{}')::numeric < 0
          or (expected_count.value #>> '{}')::numeric > 500000
          or (expected_count.value #>> '{}')::numeric <> trunc((expected_count.value #>> '{}')::numeric)
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_expected_counts_shape_invalid';
  end if;
  if (p_envelope -> 'expectedCounts' ->> 'supplementalRecords')::integer <>
       (p_envelope -> 'recordCounts' ->> 'student_snapshot')::integer
       + (p_envelope -> 'recordCounts' ->> 'quick_list')::integer
       + (p_envelope -> 'recordCounts' ->> 'contract_history')::integer
       + (p_envelope -> 'recordCounts' ->> 'hour_balance')::integer
       + (p_envelope -> 'recordCounts' ->> 'class_membership')::integer
     or (p_envelope -> 'expectedCounts' ->> 'scheduleEvents')::integer <>
       (p_envelope -> 'recordCounts' ->> 'schedule_event')::integer
     or (p_envelope -> 'expectedCounts' ->> 'leaveMakeups')::integer <>
       (p_envelope -> 'recordCounts' ->> 'leave_makeup')::integer then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_expected_counts_source_mismatch';
  end if;
  if jsonb_typeof(p_envelope -> 'workbooks') <> 'array'
     or jsonb_array_length(p_envelope -> 'workbooks') <> 7
     or exists (
       select 1
       from jsonb_array_elements(p_envelope -> 'workbooks') with ordinality workbook(value, ordinal)
       where jsonb_typeof(workbook.value) <> 'object'
          or workbook.value - ARRAY['kind', 'workbookName', 'workbookSha256', 'sheetName', 'sourceRecordCount']::text[] <> '{}'::jsonb
          or not (workbook.value ?& ARRAY['kind', 'workbookName', 'workbookSha256', 'sheetName', 'sourceRecordCount'])
          or jsonb_typeof(workbook.value -> 'kind') <> 'string'
          or workbook.value ->> 'kind' <> expected_workbook_kinds[workbook.ordinal]
          or jsonb_typeof(workbook.value -> 'workbookName') <> 'string'
          or nullif(btrim(workbook.value ->> 'workbookName'), '') is null
          or jsonb_typeof(workbook.value -> 'workbookSha256') <> 'string'
          or workbook.value ->> 'workbookSha256' !~ '^[a-f0-9]{64}$'
          or jsonb_typeof(workbook.value -> 'sheetName') <> 'string'
          or nullif(btrim(workbook.value ->> 'sheetName'), '') is null
          or jsonb_typeof(workbook.value -> 'sourceRecordCount') <> 'number'
          or (workbook.value ->> 'sourceRecordCount')::numeric < 0
          or (workbook.value ->> 'sourceRecordCount')::numeric > 200000
          or (workbook.value ->> 'sourceRecordCount')::numeric <> trunc((workbook.value ->> 'sourceRecordCount')::numeric)
     )
     or exists (
       select 1
       from jsonb_array_elements(p_envelope -> 'workbooks') workbook(value)
       where (workbook.value ->> 'kind' = 'students' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'student_snapshot')::integer)
          or (workbook.value ->> 'kind' = 'quick_list' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'quick_list')::integer)
          or (workbook.value ->> 'kind' = 'contracts' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'contract_history')::integer)
          or (workbook.value ->> 'kind' = 'hours' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'hour_balance')::integer)
          or (workbook.value ->> 'kind' = 'class_members' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'class_membership')::integer)
          or (workbook.value ->> 'kind' = 'schedule' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'schedule_event')::integer)
          or (workbook.value ->> 'kind' = 'leave_makeups' and (workbook.value ->> 'sourceRecordCount')::integer <> (p_envelope -> 'recordCounts' ->> 'leave_makeup')::integer)
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_workbook_manifest_invalid';
  end if;
end;
$jiaowubao_direct_import_assert_envelope$;

revoke all on function internal.jiaowubao_direct_import_assert_envelope(jsonb)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_import_assert_staging_chunk(
  p_run_id uuid,
  p_chunk jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_import_assert_staging_chunk$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  expected_contract jsonb := jsonb_build_object(
    'storage', 'server_only_relational_staging',
    'studentAuthority', 'tencent_master',
    'studentCreation', 'forbidden',
    'studentMatching', 'server_side_current_tencent_only',
    'scheduleProjection', 'read_only_imported_schedule_event',
    'scheduleBookingExpansion', 'forbidden',
    'sourceMutation', 'forbidden'
  );
begin
  perform internal.jiaowubao_direct_import_assert_staging(p_run_id);
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;

  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_chunk,
    ARRAY['format', 'revision', 'contract', 'sourceTimezone', 'sourceTimezoneBasis', 'workbooks', 'recordCounts', 'chunk', 'records'],
    'jiaowubao_direct_import_chunk_shape_invalid'
  );
  if jsonb_typeof(p_chunk -> 'format') <> 'string'
     or p_chunk ->> 'format' <> 'jiaowubao-direct-staging-v1'
     or jsonb_typeof(p_chunk -> 'revision') <> 'string'
     or p_chunk ->> 'revision' <> saved_run.revision
     or p_chunk -> 'contract' is distinct from expected_contract
     or jsonb_typeof(p_chunk -> 'sourceTimezone') <> 'string'
     or p_chunk ->> 'sourceTimezone' <> saved_run.source_timezone
     or jsonb_typeof(p_chunk -> 'sourceTimezoneBasis') <> 'string'
     or p_chunk ->> 'sourceTimezoneBasis' <> saved_run.source_timezone_basis
     or p_chunk -> 'recordCounts' is distinct from saved_run.source_record_counts
     or jsonb_typeof(p_chunk -> 'chunk') <> 'object'
     or (p_chunk -> 'chunk') - ARRAY['index', 'count']::text[] <> '{}'::jsonb
     or not (p_chunk -> 'chunk' ?& ARRAY['index', 'count'])
     or jsonb_typeof(p_chunk -> 'chunk' -> 'index') <> 'number'
     or jsonb_typeof(p_chunk -> 'chunk' -> 'count') <> 'number'
     or (p_chunk -> 'chunk' ->> 'index')::numeric <> trunc((p_chunk -> 'chunk' ->> 'index')::numeric)
     or (p_chunk -> 'chunk' ->> 'count')::numeric <> trunc((p_chunk -> 'chunk' ->> 'count')::numeric)
     or (p_chunk -> 'chunk' ->> 'index')::integer not between 0 and 511
     or (p_chunk -> 'chunk' ->> 'count')::integer <> saved_run.expected_chunk_count
     or jsonb_typeof(p_chunk -> 'records') <> 'array'
     or jsonb_array_length(p_chunk -> 'records') not between 1 and 1500
     or octet_length(p_chunk::text) > 2097152 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_shape_invalid';
  end if;
  if jsonb_typeof(p_chunk -> 'workbooks') <> 'array'
     or jsonb_array_length(p_chunk -> 'workbooks') <> 7
     or exists (
       select 1
       from jsonb_array_elements(p_chunk -> 'workbooks') workbook(value)
       full join internal.jiaowubao_direct_import_workbooks stored
         on stored.run_id = p_run_id and stored.workbook_kind = workbook.value ->> 'kind'
       where jsonb_typeof(workbook.value) <> 'object'
          or workbook.value - ARRAY['kind', 'workbookName', 'workbookSha256', 'sheetName', 'sourceRecordCount']::text[] <> '{}'::jsonb
          or not (workbook.value ?& ARRAY['kind', 'workbookName', 'workbookSha256', 'sheetName', 'sourceRecordCount'])
          or stored.run_id is null
          or stored.workbook_name <> workbook.value ->> 'workbookName'
          or stored.workbook_sha256 <> workbook.value ->> 'workbookSha256'
          or stored.sheet_name <> workbook.value ->> 'sheetName'
          or stored.row_count <> (workbook.value ->> 'sourceRecordCount')::integer
     ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_workbook_manifest_mismatch';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_chunk -> 'records') record(value)
    where jsonb_typeof(record.value) <> 'object'
       or record.value - ARRAY['kind', 'sourceKey', 'sourceRefs', 'sourceDigest', 'studentRelationship', 'payload']::text[] <> '{}'::jsonb
       or not (record.value ?& ARRAY['kind', 'sourceKey', 'sourceRefs', 'sourceDigest', 'studentRelationship', 'payload'])
       or jsonb_typeof(record.value -> 'kind') <> 'string'
       or record.value ->> 'kind' not in (
         'student_snapshot', 'quick_list', 'contract_history', 'hour_balance',
         'class_membership', 'schedule_event', 'leave_makeup'
       )
       or jsonb_typeof(record.value -> 'sourceKey') <> 'string'
       or record.value ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
       or jsonb_typeof(record.value -> 'sourceDigest') <> 'string'
       or record.value ->> 'sourceDigest' !~ '^[a-f0-9]{64}$'
       or jsonb_typeof(record.value -> 'sourceRefs') <> 'array'
       or jsonb_array_length(record.value -> 'sourceRefs') <> 1
       or jsonb_typeof(record.value -> 'payload') <> 'object'
       or octet_length((record.value -> 'payload')::text) > 131072
       or jsonb_typeof(record.value -> 'payload' -> 'source') <> 'object'
       or jsonb_typeof(record.value -> 'payload' -> 'staging') <> 'object'
       or jsonb_typeof(record.value -> 'studentRelationship') <> 'object'
       or (record.value -> 'studentRelationship') - ARRAY['state', 'automaticAttachment', 'sourceIdentity']::text[] <> '{}'::jsonb
       or not (record.value -> 'studentRelationship' ?& ARRAY['state', 'automaticAttachment', 'sourceIdentity'])
       or record.value -> 'studentRelationship' ->> 'automaticAttachment' <> 'forbidden'
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_record_shape_invalid';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_chunk -> 'records') record(value)
    cross join lateral jsonb_array_elements(record.value -> 'sourceRefs') source_ref(value)
    where jsonb_typeof(source_ref.value) <> 'object'
       or source_ref.value - ARRAY['workbook', 'row', 'cell']::text[] <> '{}'::jsonb
       or not (source_ref.value ?& ARRAY['workbook', 'row'])
       or jsonb_typeof(source_ref.value -> 'workbook') <> 'string'
       or source_ref.value ->> 'workbook' not in (
         'quick_list', 'students', 'contracts', 'hours', 'class_members', 'schedule', 'leave_makeups'
       )
       or jsonb_typeof(source_ref.value -> 'row') <> 'number'
       or (source_ref.value ->> 'row')::numeric <> trunc((source_ref.value ->> 'row')::numeric)
       or (source_ref.value ->> 'row')::integer not between 1 and 1000000
       or (source_ref.value ? 'cell' and (
         jsonb_typeof(source_ref.value -> 'cell') <> 'string'
         or source_ref.value ->> 'cell' !~ '^[A-Z]{1,3}[1-9][0-9]{0,5}$'
       ))
       or (record.value ->> 'kind' = 'student_snapshot' and source_ref.value ->> 'workbook' <> 'students')
       or (record.value ->> 'kind' = 'quick_list' and source_ref.value ->> 'workbook' <> 'quick_list')
       or (record.value ->> 'kind' = 'contract_history' and source_ref.value ->> 'workbook' <> 'contracts')
       or (record.value ->> 'kind' = 'hour_balance' and source_ref.value ->> 'workbook' <> 'hours')
       or (record.value ->> 'kind' = 'class_membership' and source_ref.value ->> 'workbook' <> 'class_members')
       or (record.value ->> 'kind' = 'schedule_event' and (source_ref.value ->> 'workbook' <> 'schedule' or not (source_ref.value ? 'cell')))
       or (record.value ->> 'kind' = 'leave_makeup' and source_ref.value ->> 'workbook' <> 'leave_makeups')
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_source_ref_invalid';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_chunk -> 'records') record(value)
    group by record.value ->> 'sourceKey'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_duplicate_source_key';
  end if;
end;
$jiaowubao_direct_import_assert_staging_chunk$;

revoke all on function internal.jiaowubao_direct_import_assert_staging_chunk(uuid, jsonb)
  from public, anon, authenticated;
