-- PL/pgSQL resolves a name used both as a local variable and as a SQL
-- relation alias as ambiguous. The first production-sized stage call exposed
-- this in the private chunk stager: its local item record collided with JSON
-- set aliases named item(value). The same function also contained latent
-- collisions for raw_record, participant, and source_name.
-- Keep the contract unchanged and give every such SQL row source a distinct,
-- non-variable alias so PostgreSQL can compile and execute the full function.

set local lock_timeout = '1s';

create or replace function internal.stage_jiaowubao_direct_import_chunk(
  p_run_id uuid,
  p_chunk jsonb,
  p_projection jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $stage_jiaowubao_direct_import_chunk$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  saved_chunk internal.jiaowubao_direct_import_chunks%rowtype;
  identity_record internal.jiaowubao_direct_supplemental_records%rowtype;
  item record;
  participant_item record;
  entry jsonb;
  participant jsonb;
  raw_record jsonb;
  source_ref jsonb;
  resolution jsonb;
  temporal jsonb;
  source_payload jsonb;
  records_by_key jsonb;
  source_name text;
  source_phone text;
  source_date_value date;
  time_parse_reason_value text;
  event_id uuid;
  chunk_index_value integer;
  chunk_hash text;
  projection_hash text;
  record_hash text;
  chunk_audit_id uuid;
  supplemental_count integer;
  schedule_count integer;
  participant_count integer;
  leave_makeup_count integer;
  existing_supplemental_count integer;
  existing_schedule_count integer;
  existing_participant_count integer;
  existing_leave_makeup_count integer;
  identity_match_count integer;
  projected_counts jsonb;
begin
  if nullif(btrim(p_actor), '') is null
     or p_actor <> btrim(p_actor)
     or char_length(p_actor) > 120 then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_invalid';
  end if;
  perform internal.jiaowubao_direct_import_assert_staging_chunk(p_run_id, p_chunk);
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for update;
  if saved_run.staged_by <> p_actor then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_actor_mismatch';
  end if;

  perform internal.jiaowubao_direct_import_assert_object_shape(
    p_projection,
    ARRAY['supplemental', 'scheduleEvents', 'leaveMakeups'],
    'jiaowubao_direct_import_projection_shape_invalid'
  );
  if jsonb_typeof(p_projection -> 'supplemental') <> 'array'
     or jsonb_typeof(p_projection -> 'scheduleEvents') <> 'array'
     or jsonb_typeof(p_projection -> 'leaveMakeups') <> 'array' then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_projection_shape_invalid';
  end if;
  for item in select supplemental_loop_row.value from jsonb_array_elements(p_projection -> 'supplemental') supplemental_loop_row(value) loop
    entry := item.value;
    perform internal.jiaowubao_direct_import_assert_object_shape(
      entry, ARRAY['sourceKey', 'resolution', 'identityProof'],
      'jiaowubao_direct_import_supplemental_projection_shape_invalid'
    );
    if jsonb_typeof(entry -> 'sourceKey') <> 'string'
       or entry ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
       or jsonb_typeof(entry -> 'identityProof') <> 'boolean' then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_supplemental_projection_shape_invalid';
    end if;
    perform internal.jiaowubao_direct_import_assert_resolution(
      entry -> 'resolution', 'jiaowubao_direct_import_supplemental_resolution'
    );
    if (entry -> 'resolution') ->> 'state' = 'quarantined' and entry -> 'identityProof' <> 'false'::jsonb then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_supplemental_projection_shape_invalid';
    end if;
  end loop;
  for item in select schedule_loop_row.value from jsonb_array_elements(p_projection -> 'scheduleEvents') schedule_loop_row(value) loop
    entry := item.value;
    perform internal.jiaowubao_direct_import_assert_object_shape(
      entry, ARRAY['sourceKey', 'teacherResolution', 'teacherId', 'availabilityEffect', 'participants'],
      'jiaowubao_direct_import_schedule_projection_shape_invalid'
    );
    if jsonb_typeof(entry -> 'sourceKey') <> 'string'
       or entry ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
       or jsonb_typeof(entry -> 'teacherResolution') <> 'string'
       or entry ->> 'teacherResolution' not in ('exact_name', 'unresolved', 'ambiguous', 'not_found')
       or jsonb_typeof(entry -> 'availabilityEffect') <> 'string'
       or entry ->> 'availabilityEffect' not in ('display_only', 'blocks_teacher_ava')
       or jsonb_typeof(entry -> 'participants') <> 'array' then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_projection_shape_invalid';
    end if;
    if entry ->> 'teacherResolution' = 'exact_name' then
      if jsonb_typeof(entry -> 'teacherId') <> 'string'
         or nullif(btrim(entry ->> 'teacherId'), '') is null
         or entry ->> 'teacherId' <> btrim(entry ->> 'teacherId')
         or char_length(entry ->> 'teacherId') > 240 then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_projection_shape_invalid';
      end if;
    elsif entry -> 'teacherId' <> 'null'::jsonb then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_projection_shape_invalid';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(entry -> 'participants') participant_value(value)
      where jsonb_typeof(participant_value.value) <> 'object'
         or participant_value.value - ARRAY['participantKey', 'sourceDisplayName', 'identitySupplementalSourceKey', 'resolution']::text[] <> '{}'::jsonb
         or not (participant_value.value ?& ARRAY['participantKey', 'sourceDisplayName', 'identitySupplementalSourceKey', 'resolution'])
         or jsonb_typeof(participant_value.value -> 'participantKey') <> 'string'
         or participant_value.value ->> 'participantKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
         or jsonb_typeof(participant_value.value -> 'sourceDisplayName') <> 'string'
         or nullif(btrim(participant_value.value ->> 'sourceDisplayName'), '') is null
         or participant_value.value ->> 'sourceDisplayName' <> btrim(participant_value.value ->> 'sourceDisplayName')
    ) or exists (
      select 1
      from jsonb_array_elements(entry -> 'participants') participant_value(value)
      group by participant_value.value ->> 'participantKey'
      having count(*) > 1
    ) then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_participant_projection_shape_invalid';
    end if;
    for participant_item in select value from jsonb_array_elements(entry -> 'participants') participant_value(value) loop
      participant := participant_item.value;
      perform internal.jiaowubao_direct_import_assert_participant_resolution(participant -> 'resolution');
      if (participant -> 'resolution') ->> 'state' = 'attached' then
        if jsonb_typeof(participant -> 'identitySupplementalSourceKey') <> 'string'
           or participant ->> 'identitySupplementalSourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$' then
          raise exception using errcode = '22023', message = 'jiaowubao_direct_import_participant_projection_shape_invalid';
        end if;
      elsif participant -> 'identitySupplementalSourceKey' <> 'null'::jsonb then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_participant_projection_shape_invalid';
      end if;
    end loop;
  end loop;
  for item in select leave_makeup_loop_row.value from jsonb_array_elements(p_projection -> 'leaveMakeups') leave_makeup_loop_row(value) loop
    entry := item.value;
    perform internal.jiaowubao_direct_import_assert_object_shape(
      entry, ARRAY['sourceKey', 'incidentKind', 'resolution'],
      'jiaowubao_direct_import_leave_makeup_projection_shape_invalid'
    );
    if jsonb_typeof(entry -> 'sourceKey') <> 'string'
       or entry ->> 'sourceKey' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
       or jsonb_typeof(entry -> 'incidentKind') <> 'string'
       or entry ->> 'incidentKind' not in ('leave', 'makeup', 'unknown') then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_leave_makeup_projection_shape_invalid';
    end if;
    perform internal.jiaowubao_direct_import_assert_resolution(
      entry -> 'resolution', 'jiaowubao_direct_import_leave_makeup_resolution'
    );
  end loop;

  select jsonb_object_agg(record.value ->> 'sourceKey', record.value)
  into records_by_key
  from jsonb_array_elements(p_chunk -> 'records') record(value);
  if exists (
    with raw_records as (
      select record.value ->> 'sourceKey' as source_key, record.value ->> 'kind' as kind
      from jsonb_array_elements(p_chunk -> 'records') record(value)
    ), projection_records as (
      select supplemental_projection_row.value ->> 'sourceKey' as source_key, 'supplemental'::text as projection_kind
      from jsonb_array_elements(p_projection -> 'supplemental') supplemental_projection_row(value)
      union all
      select schedule_projection_row.value ->> 'sourceKey', 'schedule_event'
      from jsonb_array_elements(p_projection -> 'scheduleEvents') schedule_projection_row(value)
      union all
      select leave_makeup_projection_row.value ->> 'sourceKey', 'leave_makeup'
      from jsonb_array_elements(p_projection -> 'leaveMakeups') leave_makeup_projection_row(value)
    )
    select 1 from projection_records group by source_key having count(*) <> 1
    union all
    select 1
    from raw_records raw_record_row
    left join projection_records projection_record on projection_record.source_key = raw_record_row.source_key
    where projection_record.source_key is null
       or (raw_record_row.kind in ('student_snapshot', 'quick_list', 'contract_history', 'hour_balance', 'class_membership') and projection_record.projection_kind <> 'supplemental')
       or (raw_record_row.kind = 'schedule_event' and projection_record.projection_kind <> 'schedule_event')
       or (raw_record_row.kind = 'leave_makeup' and projection_record.projection_kind <> 'leave_makeup')
    union all
    select 1
    from projection_records projection_record
    left join raw_records raw_record_row on raw_record_row.source_key = projection_record.source_key
    where raw_record_row.source_key is null
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_projection_coverage_invalid';
  end if;

  chunk_index_value := (p_chunk -> 'chunk' ->> 'index')::integer;
  chunk_hash := encode(extensions.digest(p_chunk::text, 'sha256'), 'hex');
  projection_hash := encode(extensions.digest(p_projection::text, 'sha256'), 'hex');
  select * into saved_chunk
  from internal.jiaowubao_direct_import_chunks chunk
  where chunk.run_id = p_run_id and chunk.chunk_index = chunk_index_value
  for update;
  if found then
    if saved_chunk.chunk_sha256 <> chunk_hash or saved_chunk.projection_sha256 <> projection_hash then
      raise exception using errcode = '23505', message = 'jiaowubao_direct_import_chunk_conflict';
    end if;
    return jsonb_build_object(
      'runId', p_run_id, 'chunkIndex', chunk_index_value,
      'state', saved_run.state, 'replayed', true
    );
  end if;
  if chunk_index_value > 0 and (
    select count(*)
    from internal.jiaowubao_direct_import_chunks prior_chunk
    where prior_chunk.run_id = p_run_id
      and prior_chunk.chunk_index between 0 and chunk_index_value - 1
  ) <> chunk_index_value then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_chunk_sequence_gap';
  end if;
  if exists (
    with incoming as (
      select record.value ->> 'sourceKey' as source_key
      from jsonb_array_elements(p_chunk -> 'records') record(value)
    ), persisted as (
      select source_key from internal.jiaowubao_direct_supplemental_records where run_id = p_run_id
      union all select source_key from internal.jiaowubao_direct_schedule_events where run_id = p_run_id
      union all select source_key from internal.jiaowubao_direct_leave_makeup_events where run_id = p_run_id
    )
    select 1 from incoming join persisted using (source_key)
  ) then
    raise exception using errcode = '23505', message = 'jiaowubao_direct_import_source_key_conflict';
  end if;

  supplemental_count := jsonb_array_length(p_projection -> 'supplemental');
  schedule_count := jsonb_array_length(p_projection -> 'scheduleEvents');
  select coalesce(sum(jsonb_array_length(schedule_count_row.value -> 'participants')), 0)::integer
  into participant_count
  from jsonb_array_elements(p_projection -> 'scheduleEvents') schedule_count_row(value);
  leave_makeup_count := jsonb_array_length(p_projection -> 'leaveMakeups');
  projected_counts := jsonb_build_object(
    'supplementalRecords', supplemental_count,
    'scheduleEvents', schedule_count,
    'scheduleParticipants', participant_count,
    'leaveMakeups', leave_makeup_count
  );
  select count(*) into existing_supplemental_count
  from internal.jiaowubao_direct_supplemental_records where run_id = p_run_id;
  select count(*) into existing_schedule_count
  from internal.jiaowubao_direct_schedule_events where run_id = p_run_id;
  select count(*) into existing_participant_count
  from internal.jiaowubao_direct_schedule_event_participants participant_row
  join internal.jiaowubao_direct_schedule_events schedule_event on schedule_event.id = participant_row.event_id
  where schedule_event.run_id = p_run_id;
  select count(*) into existing_leave_makeup_count
  from internal.jiaowubao_direct_leave_makeup_events where run_id = p_run_id;
  if existing_supplemental_count + supplemental_count > (saved_run.expected_counts ->> 'supplementalRecords')::integer
     or existing_schedule_count + schedule_count > (saved_run.expected_counts ->> 'scheduleEvents')::integer
     or existing_participant_count + participant_count > (saved_run.expected_counts ->> 'scheduleParticipants')::integer
     or existing_leave_makeup_count + leave_makeup_count > (saved_run.expected_counts ->> 'leaveMakeups')::integer then
    raise exception using errcode = '22023', message = 'jiaowubao_direct_import_projected_counts_exceeded';
  end if;

  chunk_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.chunk_staged', p_actor,
    'jiaowubao_direct_import_run', p_run_id::text,
    jsonb_build_object(
      'sourceId', saved_run.source_id,
      'revision', saved_run.revision,
      'chunkIndex', chunk_index_value,
      'chunkSha256', chunk_hash,
      'projectionSha256', projection_hash,
      'sourceRecordCount', jsonb_array_length(p_chunk -> 'records'),
      'projectedRecordCounts', projected_counts
    )
  );
  insert into internal.jiaowubao_direct_import_chunks (
    run_id, chunk_index, chunk_sha256, source_record_counts, source_record_count,
    content_bytes, projection_sha256, projected_record_counts, audit_id
  ) values (
    p_run_id, chunk_index_value, chunk_hash, saved_run.source_record_counts,
    jsonb_array_length(p_chunk -> 'records'), octet_length(p_chunk::text),
    projection_hash, projected_counts, chunk_audit_id
  );

  -- Supplemental rows are inserted first so a schedule attendee in this
  -- chunk may cite a prior phone-proven canonical identity by source key.
  for item in select supplemental_loop_row.value from jsonb_array_elements(p_projection -> 'supplemental') supplemental_loop_row(value) loop
    entry := item.value;
    raw_record := records_by_key -> (entry ->> 'sourceKey');
    source_ref := raw_record -> 'sourceRefs' -> 0;
    resolution := entry -> 'resolution';
    source_name := raw_record #>> '{payload,source,identity,name}';
    source_phone := raw_record #>> '{payload,source,identity,phone}';
    source_payload := (raw_record -> 'payload') || jsonb_build_object(
      '_directImport', jsonb_build_object(
        'sourceKey', raw_record ->> 'sourceKey',
        'sourceDigest', raw_record ->> 'sourceDigest',
        'sourceRefs', raw_record -> 'sourceRefs',
        'studentRelationship', raw_record -> 'studentRelationship'
      )
    );
    record_hash := encode(extensions.digest(raw_record::text, 'sha256'), 'hex');
    if resolution ->> 'state' = 'attached' then
      if nullif(btrim(source_name), '') is null or nullif(btrim(source_phone), '') is null then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_supplemental_source_identity_missing';
      end if;
      if entry -> 'identityProof' = 'true'::jsonb and exists (
        select 1
        from internal.jiaowubao_direct_supplemental_records existing_identity
        where existing_identity.run_id = p_run_id
          and existing_identity.resolution_state = 'attached'
          and existing_identity.identity_proof
          and existing_identity.student_id = resolution ->> 'studentId'
          and existing_identity.master_source_row = resolution ->> 'masterSourceRow'
          and internal.student_import_name_key(existing_identity.evidence_name) =
              internal.student_import_name_key(source_name)
      ) then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_duplicate_identity_proof';
      end if;
    end if;
    insert into internal.jiaowubao_direct_supplemental_records (
      run_id, chunk_index, record_kind, source_key, source_workbook, source_row, source_cell,
      resolution_state, student_id, evidence_phone, identity_proof, master_source_row,
      evidence_name, match_mode, quarantine_reason, source_payload, record_sha256
    ) values (
      p_run_id, chunk_index_value,
      case raw_record ->> 'kind'
        when 'contract_history' then 'contract'
        else raw_record ->> 'kind'
      end,
      raw_record ->> 'sourceKey', source_ref ->> 'workbook', (source_ref ->> 'row')::integer,
      source_ref ->> 'cell',
      resolution ->> 'state',
      case when resolution ->> 'state' = 'attached' then resolution ->> 'studentId' else null end,
      case when resolution ->> 'state' = 'attached' then btrim(source_phone) else null end,
      case when resolution ->> 'state' = 'attached' then (entry ->> 'identityProof')::boolean else false end,
      case when resolution ->> 'state' = 'attached' then resolution ->> 'masterSourceRow' else null end,
      case when resolution ->> 'state' = 'attached' then btrim(source_name) else null end,
      case when resolution ->> 'state' = 'attached' then 'exact_name' else null end,
      case when resolution ->> 'state' = 'quarantined' then resolution ->> 'reason' else null end,
      source_payload, record_hash
    );
  end loop;

  for item in select schedule_loop_row.value from jsonb_array_elements(p_projection -> 'scheduleEvents') schedule_loop_row(value) loop
    entry := item.value;
    raw_record := records_by_key -> (entry ->> 'sourceKey');
    source_ref := raw_record -> 'sourceRefs' -> 0;
    temporal := raw_record #> '{payload,staging,temporal}';
    -- A schedule cell's display names are evidence, not optional inferred
    -- bookings. Every source display name must therefore be represented once
    -- as either an attached participant through a phone-proven identity or a
    -- read-only quarantined participant.
    if exists (
      with raw_names as (
        select internal.student_import_name_key(source_name_row.value) as name_key, count(*)::integer as row_count
        from jsonb_array_elements_text(coalesce(raw_record #> '{payload,source,studentDisplayNames}', '[]'::jsonb)) source_name_row(value)
        group by internal.student_import_name_key(source_name_row.value)
      ), projected_names as (
        select internal.student_import_name_key(participant_value.value ->> 'sourceDisplayName') as name_key, count(*)::integer as row_count
        from jsonb_array_elements(entry -> 'participants') participant_value(value)
        group by internal.student_import_name_key(participant_value.value ->> 'sourceDisplayName')
      )
      select 1
      from raw_names
      full join projected_names using (name_key)
      where raw_names.row_count is distinct from projected_names.row_count
         or nullif(name_key, '') is null
    ) then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_coverage_invalid';
    end if;
    if jsonb_typeof(temporal) <> 'object'
       or jsonb_typeof(temporal -> 'state') <> 'string'
       or temporal ->> 'state' not in ('resolved', 'invalid')
       or jsonb_typeof(temporal -> 'sourceDate') <> 'string'
       or temporal ->> 'sourceDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or jsonb_typeof(temporal -> 'sourceTimezone') <> 'string'
       or temporal ->> 'sourceTimezone' <> 'Australia/Melbourne' then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_temporal_invalid';
    end if;
    source_date_value := (temporal ->> 'sourceDate')::date;
    if temporal ->> 'state' = 'resolved' then
      if jsonb_typeof(temporal -> 'start') <> 'string'
         or jsonb_typeof(temporal -> 'end') <> 'string'
         or jsonb_typeof(temporal -> 'sourceStartInstant') <> 'string'
         or jsonb_typeof(temporal -> 'sourceEndInstant') <> 'string' then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_temporal_invalid';
      end if;
      time_parse_reason_value := null;
    else
      if jsonb_typeof(temporal -> 'reason') <> 'string'
         or temporal ->> 'reason' not in ('invalid_time_interval', 'invalid_wall_clock', 'ambiguous_wall_clock', 'non_positive_interval') then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_temporal_invalid';
      end if;
      time_parse_reason_value := case temporal ->> 'reason'
        when 'non_positive_interval' then 'non_positive_time_interval'
        else temporal ->> 'reason'
      end;
    end if;
    source_payload := (raw_record -> 'payload') || jsonb_build_object(
      '_directImport', jsonb_build_object(
        'sourceKey', raw_record ->> 'sourceKey',
        'sourceDigest', raw_record ->> 'sourceDigest',
        'sourceRefs', raw_record -> 'sourceRefs',
        'studentRelationship', raw_record -> 'studentRelationship'
      )
    );
    record_hash := encode(extensions.digest(raw_record::text, 'sha256'), 'hex');
    insert into internal.jiaowubao_direct_schedule_events (
      run_id, chunk_index, source_key, source_workbook, source_row, source_cell,
      source_date, source_timezone, source_timezone_basis, time_parse_status,
      time_parse_reason, dst_resolution, source_local_start, source_local_end,
      starts_at, ends_at, class_name, course_name, teacher_display_name,
      teacher_resolution, teacher_id, subject_resolution, subject_id,
      availability_effect, declared_participant_count, source_payload, record_sha256
    ) values (
      p_run_id, chunk_index_value, raw_record ->> 'sourceKey', source_ref ->> 'workbook',
      (source_ref ->> 'row')::integer, source_ref ->> 'cell',
      source_date_value, temporal ->> 'sourceTimezone', saved_run.source_timezone_basis,
      case when temporal ->> 'state' = 'resolved' then 'parsed' else 'invalid_time' end,
      time_parse_reason_value,
      case when temporal ->> 'state' = 'resolved' then 'unambiguous' else null end,
      case when temporal ->> 'state' = 'resolved' then (temporal ->> 'start')::time else null end,
      case when temporal ->> 'state' = 'resolved' then (temporal ->> 'end')::time else null end,
      case when temporal ->> 'state' = 'resolved' then (temporal ->> 'sourceStartInstant')::timestamptz else null end,
      case when temporal ->> 'state' = 'resolved' then (temporal ->> 'sourceEndInstant')::timestamptz else null end,
      nullif(btrim(raw_record #>> '{payload,source,className}'), ''),
      nullif(btrim(raw_record #>> '{payload,source,course}'), ''),
      nullif(btrim(raw_record #>> '{payload,source,teacher}'), ''),
      entry ->> 'teacherResolution',
      case when entry ->> 'teacherResolution' = 'exact_name' then entry ->> 'teacherId' else null end,
      'unresolved', null,
      entry ->> 'availabilityEffect',
      case when jsonb_typeof(raw_record #> '{payload,source,declaredCount}') = 'number'
        then (raw_record #>> '{payload,source,declaredCount}')::integer else null end,
      source_payload, record_hash
    ) returning id into event_id;

    for participant_item in select value from jsonb_array_elements(entry -> 'participants') participant_value(value) loop
      participant := participant_item.value;
      if not exists (
        select 1
        from jsonb_array_elements_text(coalesce(raw_record #> '{payload,source,studentDisplayNames}', '[]'::jsonb)) source_name_value(value)
        where internal.student_import_name_key(source_name_value.value) =
          internal.student_import_name_key(participant ->> 'sourceDisplayName')
      ) then
        raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_source_name_missing';
      end if;
      if (participant -> 'resolution') ->> 'state' = 'attached' then
        select count(*) into identity_match_count
        from internal.jiaowubao_direct_supplemental_records supplemental_record
        where supplemental_record.run_id = p_run_id
          and supplemental_record.source_key = participant ->> 'identitySupplementalSourceKey'
          and supplemental_record.resolution_state = 'attached'
          and supplemental_record.identity_proof;
        if identity_match_count <> 1 then
          raise exception using errcode = '22023', message = 'jiaowubao_direct_import_schedule_participant_identity_required';
        end if;
        select * into identity_record
        from internal.jiaowubao_direct_supplemental_records supplemental_record
        where supplemental_record.run_id = p_run_id
          and supplemental_record.source_key = participant ->> 'identitySupplementalSourceKey'
          and supplemental_record.resolution_state = 'attached'
          and supplemental_record.identity_proof
        for key share;
      end if;
      insert into internal.jiaowubao_direct_schedule_event_participants (
        event_id, participant_key, source_display_name, resolution_state, student_id,
        identity_supplemental_record_id, master_source_row, evidence_name, match_mode,
        quarantine_reason, source_payload, record_sha256
      ) values (
        event_id, participant ->> 'participantKey', participant ->> 'sourceDisplayName',
        participant -> 'resolution' ->> 'state',
        case when participant -> 'resolution' ->> 'state' = 'attached' then identity_record.student_id else null end,
        case when participant -> 'resolution' ->> 'state' = 'attached' then identity_record.id else null end,
        case when participant -> 'resolution' ->> 'state' = 'attached' then identity_record.master_source_row else null end,
        case when participant -> 'resolution' ->> 'state' = 'attached' then identity_record.evidence_name else null end,
        case when participant -> 'resolution' ->> 'state' = 'attached' then 'exact_name' else null end,
        case when participant -> 'resolution' ->> 'state' = 'quarantined' then participant -> 'resolution' ->> 'reason' else null end,
        source_payload,
        encode(extensions.digest(jsonb_build_object(
          'sourceKey', raw_record ->> 'sourceKey',
          'participantKey', participant ->> 'participantKey',
          'sourceDisplayName', participant ->> 'sourceDisplayName',
          'sourceDigest', raw_record ->> 'sourceDigest'
        )::text, 'sha256'), 'hex')
      );
    end loop;
  end loop;

  for item in select leave_makeup_loop_row.value from jsonb_array_elements(p_projection -> 'leaveMakeups') leave_makeup_loop_row(value) loop
    entry := item.value;
    raw_record := records_by_key -> (entry ->> 'sourceKey');
    source_ref := raw_record -> 'sourceRefs' -> 0;
    resolution := entry -> 'resolution';
    source_name := raw_record #>> '{payload,source,identity,name}';
    source_payload := (raw_record -> 'payload') || jsonb_build_object(
      '_directImport', jsonb_build_object(
        'sourceKey', raw_record ->> 'sourceKey',
        'sourceDigest', raw_record ->> 'sourceDigest',
        'sourceRefs', raw_record -> 'sourceRefs',
        'studentRelationship', raw_record -> 'studentRelationship'
      )
    );
    record_hash := encode(extensions.digest(raw_record::text, 'sha256'), 'hex');
    if resolution ->> 'state' = 'attached' and nullif(btrim(source_name), '') is null then
      raise exception using errcode = '22023', message = 'jiaowubao_direct_import_leave_makeup_source_identity_missing';
    end if;
    insert into internal.jiaowubao_direct_leave_makeup_events (
      run_id, chunk_index, source_key, source_workbook, source_row, source_cell,
      incident_kind, source_date, source_time_text, class_name, course_name,
      teacher_display_name, resolution_state, student_id, master_source_row,
      evidence_name, match_mode, quarantine_reason, source_payload, record_sha256
    ) values (
      p_run_id, chunk_index_value, raw_record ->> 'sourceKey', source_ref ->> 'workbook',
      (source_ref ->> 'row')::integer, source_ref ->> 'cell', entry ->> 'incidentKind',
      case when raw_record #>> '{payload,source,sourceDate}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        then (raw_record #>> '{payload,source,sourceDate}')::date else null end,
      nullif(btrim(raw_record #>> '{payload,source,sourceTime}'), ''),
      nullif(btrim(raw_record #>> '{payload,source,className}'), ''),
      nullif(btrim(raw_record #>> '{payload,source,course}'), ''),
      nullif(btrim(raw_record #>> '{payload,source,teacher}'), ''),
      resolution ->> 'state',
      case when resolution ->> 'state' = 'attached' then resolution ->> 'studentId' else null end,
      case when resolution ->> 'state' = 'attached' then resolution ->> 'masterSourceRow' else null end,
      case when resolution ->> 'state' = 'attached' then btrim(source_name) else null end,
      case when resolution ->> 'state' = 'attached' then 'exact_name' else null end,
      case when resolution ->> 'state' = 'quarantined' then resolution ->> 'reason' else null end,
      source_payload, record_hash
    );
  end loop;

  return jsonb_build_object(
    'runId', p_run_id,
    'chunkIndex', chunk_index_value,
    'state', 'staging',
    'sourceRecordCount', jsonb_array_length(p_chunk -> 'records'),
    'projectedRecordCounts', projected_counts,
    'replayed', false
  );
end;
$stage_jiaowubao_direct_import_chunk$;

revoke all on function internal.stage_jiaowubao_direct_import_chunk(uuid, jsonb, jsonb, text)
  from public, anon, authenticated;
