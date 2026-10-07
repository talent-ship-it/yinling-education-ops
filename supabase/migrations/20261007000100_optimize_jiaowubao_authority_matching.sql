set local lock_timeout = '2s';

do $patch_authority_matching$
declare
  target_oid regprocedure;
  definition text;
  anchor text;
  replacement text;
begin
  target_oid := 'public.project_jiaowubao_open_api_authority_read_model(text,text,text)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(target_oid);
  anchor := $anchor$  ), stats as materialized (
    select source_entity.source_key,
      (select count(*)::integer from system_students system_student
        where system_student.jwb_member_id = source_entity.source_native_id) as source_id_match_count,
      (select min(system_student.entity_id) from system_students system_student
        where system_student.jwb_member_id = source_entity.source_native_id) as source_id_entity_id,
      (select min(system_student.name_key) from system_students system_student
        where system_student.jwb_member_id = source_entity.source_native_id) as source_id_name_key,
      (select count(*)::integer from internal.jiaowubao_authority_projection_entities peer
        where peer.projection_run_id = projection_id and peer.entity_type = 'student'
          and peer.identity_key <> '' and peer.identity_key = source_entity.identity_key) as source_name_count,
      (select count(*)::integer from system_students system_student
        where system_student.name_key <> '' and system_student.name_key = source_entity.identity_key) as system_name_count,
      (select min(system_student.entity_id) from system_students system_student
        where system_student.name_key <> '' and system_student.name_key = source_entity.identity_key) as name_entity_id
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_id and source_entity.entity_type = 'student'
  )$anchor$;
  replacement := $replacement$  ), native_ids as materialized (
    select jwb_member_id, count(*)::integer as match_count,
      min(entity_id) as entity_id, min(name_key) as name_key
    from system_students group by jwb_member_id
  ), native_names as materialized (
    select name_key, count(*)::integer as match_count, min(entity_id) as entity_id
    from system_students where name_key <> '' group by name_key
  ), source_names as materialized (
    select identity_key, count(*)::integer as match_count
    from internal.jiaowubao_authority_projection_entities
    where projection_run_id = projection_id and entity_type = 'student' and identity_key <> ''
    group by identity_key
  ), stats as materialized (
    select source_entity.source_key,
      coalesce(native_ids.match_count, 0) as source_id_match_count,
      native_ids.entity_id as source_id_entity_id,
      native_ids.name_key as source_id_name_key,
      coalesce(source_names.match_count, 0) as source_name_count,
      coalesce(native_names.match_count, 0) as system_name_count,
      native_names.entity_id as name_entity_id
    from internal.jiaowubao_authority_projection_entities source_entity
    left join native_ids on native_ids.jwb_member_id = source_entity.source_native_id
    left join native_names on native_names.name_key = source_entity.identity_key
    left join source_names on source_names.identity_key = source_entity.identity_key
    where source_entity.projection_run_id = projection_id and source_entity.entity_type = 'student'
  )$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_matching_anchor_mismatch';
  end if;
  execute replace(definition, anchor, replacement);
  target_oid := 'public.project_jiaowubao_open_api_authority_read_model(text,text,text)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(target_oid);
  anchor := $anchor$  ), stats as materialized (
    select source_entity.entity_type, source_entity.source_key,
      (select count(*)::integer from internal.jiaowubao_authority_projection_entities peer
        where peer.projection_run_id = projection_id and peer.entity_type = source_entity.entity_type
          and peer.identity_key <> '' and peer.identity_key = source_entity.identity_key) as source_name_count,
      (select count(*)::integer from system_entities system_entity
        where system_entity.entity_type = source_entity.entity_type
          and system_entity.name_key <> '' and system_entity.name_key = source_entity.identity_key) as system_name_count,
      (select min(system_entity.entity_id) from system_entities system_entity
        where system_entity.entity_type = source_entity.entity_type
          and system_entity.name_key <> '' and system_entity.name_key = source_entity.identity_key) as name_entity_id
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_id
      and source_entity.entity_type in ('teacher','course')
  )$anchor$;
  replacement := $replacement$  ), native_names as materialized (
    select entity_type, name_key, count(*)::integer as match_count, min(entity_id) as entity_id
    from system_entities where name_key <> '' group by entity_type, name_key
  ), source_names as materialized (
    select entity_type, identity_key, count(*)::integer as match_count
    from internal.jiaowubao_authority_projection_entities
    where projection_run_id = projection_id and entity_type in ('teacher','course') and identity_key <> ''
    group by entity_type, identity_key
  ), stats as materialized (
    select source_entity.entity_type, source_entity.source_key,
      coalesce(source_names.match_count, 0) as source_name_count,
      coalesce(native_names.match_count, 0) as system_name_count,
      native_names.entity_id as name_entity_id
    from internal.jiaowubao_authority_projection_entities source_entity
    left join native_names on native_names.entity_type = source_entity.entity_type
      and native_names.name_key = source_entity.identity_key
    left join source_names on source_names.entity_type = source_entity.entity_type
      and source_names.identity_key = source_entity.identity_key
    where source_entity.projection_run_id = projection_id
      and source_entity.entity_type in ('teacher','course')
  )$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_matching_anchor_mismatch';
  end if;
  execute replace(definition, anchor, replacement);
  target_oid := 'public.project_jiaowubao_open_api_authority_read_model(text,text,text)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(target_oid);
  anchor := $anchor$  ), stats as materialized (
    select source_entity.source_key,
      (select count(*)::integer from system_bookings system_booking
        where system_booking.source_lesson_id in (
          source_entity.source_native_id,
          'jwb-open-api:schedule:' || source_entity.source_native_id
        )) as match_count,
      (select min(system_booking.entity_id) from system_bookings system_booking
        where system_booking.source_lesson_id in (
          source_entity.source_native_id,
          'jwb-open-api:schedule:' || source_entity.source_native_id
        )) as entity_id
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_id and source_entity.entity_type = 'schedule'
  )$anchor$;
  replacement := $replacement$  ), booking_ids as materialized (
    select source_lesson_id, count(*)::integer as match_count, min(entity_id) as entity_id
    from system_bookings group by source_lesson_id
  ), stats as materialized (
    select source_entity.source_key,
      coalesce(direct.match_count, 0) + coalesce(prefixed.match_count, 0) as match_count,
      least(direct.entity_id, prefixed.entity_id) as entity_id
    from internal.jiaowubao_authority_projection_entities source_entity
    left join booking_ids direct on direct.source_lesson_id = source_entity.source_native_id
    left join booking_ids prefixed on prefixed.source_lesson_id = 'jwb-open-api:schedule:' || source_entity.source_native_id
    where source_entity.projection_run_id = projection_id and source_entity.entity_type = 'schedule'
  )$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_matching_anchor_mismatch';
  end if;
  execute replace(definition, anchor, replacement);
  target_oid := 'public.apply_jiaowubao_open_api_authority_native(text,uuid,text)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(target_oid);
  anchor := $anchor$  ), candidates as materialized (
    select source.*,
      case when prior.native_entity_id is not null and exists (
        select 1 from native_students native where native.entity_id = prior.native_entity_id
      ) then prior.native_entity_id end as prior_id,
      (select min(native.entity_id) from native_students native where native.source_id = source.source_native_id) as stable_id,
      (select min(native.entity_id) from native_students native where native.name_key <> '' and native.name_key = source.identity_key) as name_id
    from sources source
    left join internal.jiaowubao_authority_native_links prior
      on prior.entity_type = 'student' and prior.source_native_id = source.source_native_id
$anchor$;
  replacement := $replacement$  ), native_ids as materialized (
    select distinct entity_id from native_students
  ), stable_ids as materialized (
    select source_id, min(entity_id) as entity_id from native_students group by source_id
  ), native_names as materialized (
    select name_key, min(entity_id) as entity_id from native_students where name_key <> '' group by name_key
  ), candidates as materialized (
    select source.*, native_ids.entity_id as prior_id,
      stable_ids.entity_id as stable_id, native_names.entity_id as name_id
    from sources source
    left join internal.jiaowubao_authority_native_links prior
      on prior.entity_type = 'student' and prior.source_native_id = source.source_native_id
    left join native_ids on native_ids.entity_id = prior.native_entity_id
    left join stable_ids on stable_ids.source_id = source.source_native_id
    left join native_names on native_names.name_key = source.identity_key
$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_matching_anchor_mismatch';
  end if;
  execute replace(definition, anchor, replacement);
  target_oid := 'public.apply_jiaowubao_open_api_authority_native(text,uuid,text)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(target_oid);
  anchor := $anchor$  ), candidates as materialized (
    select source.*,
      case when prior.native_entity_id is not null and exists (
        select 1 from jsonb_array_elements(source.native_payload) native(value)
        where native.value ->> 'id' = prior.native_entity_id
      ) then prior.native_entity_id end as prior_id,
      (select min(native.value ->> 'id')
       from jsonb_array_elements(source.native_payload) native(value)
       where internal.student_import_name_key(native.value ->> 'name') = source.identity_key
         and source.identity_key <> '') as name_id
    from sources source
    left join internal.jiaowubao_authority_native_links prior
      on prior.entity_type = source.entity_type and prior.source_native_id = source.source_native_id
$anchor$;
  replacement := $replacement$  ), native_entities as materialized (
    select type_map.entity_type, native.value ->> 'id' as entity_id,
      internal.student_import_name_key(native.value ->> 'name') as name_key
    from type_map cross join lateral jsonb_array_elements(type_map.native_payload) native(value)
  ), native_ids as materialized (
    select distinct entity_type, entity_id from native_entities
  ), native_names as materialized (
    select entity_type, name_key, min(entity_id) as entity_id
    from native_entities where name_key <> '' group by entity_type, name_key
  ), candidates as materialized (
    select source.*, native_ids.entity_id as prior_id, native_names.entity_id as name_id
    from sources source
    left join internal.jiaowubao_authority_native_links prior
      on prior.entity_type = source.entity_type and prior.source_native_id = source.source_native_id
    left join native_ids on native_ids.entity_type = source.entity_type and native_ids.entity_id = prior.native_entity_id
    left join native_names on native_names.entity_type = source.entity_type and native_names.name_key = source.identity_key
$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_matching_anchor_mismatch';
  end if;
  execute replace(definition, anchor, replacement);
  target_oid := 'public.apply_jiaowubao_open_api_authority_native(text,uuid,text)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(target_oid);
  anchor := $anchor$  ), candidates as materialized (
    select source.*,
      case when prior.native_entity_id is not null and exists (
        select 1 from jsonb_array_elements(bookings_state.payload) booking(value)
        where booking.value ->> 'id' = prior.native_entity_id
      ) then prior.native_entity_id end as prior_id,
      (select min(booking.value ->> 'id')
       from jsonb_array_elements(bookings_state.payload) booking(value)
       where booking.value ->> 'sourceLessonId' in (
         source.source_native_id,
         'jwb-open-api:schedule:' || source.source_native_id
       )) as direct_id
    from sources source
    left join internal.jiaowubao_authority_native_links prior
      on prior.entity_type = 'schedule' and prior.source_native_id = source.source_native_id
$anchor$;
  replacement := $replacement$  ), native_bookings as materialized (
    select booking.value ->> 'id' as entity_id, booking.value ->> 'sourceLessonId' as source_lesson_id
    from jsonb_array_elements(bookings_state.payload) booking(value)
  ), native_ids as materialized (
    select distinct entity_id from native_bookings
  ), source_ids as materialized (
    select source_lesson_id, min(entity_id) as entity_id from native_bookings group by source_lesson_id
  ), candidates as materialized (
    select source.*, native_ids.entity_id as prior_id,
      least(direct.entity_id, prefixed.entity_id) as direct_id
    from sources source
    left join internal.jiaowubao_authority_native_links prior
      on prior.entity_type = 'schedule' and prior.source_native_id = source.source_native_id
    left join native_ids on native_ids.entity_id = prior.native_entity_id
    left join source_ids direct on direct.source_lesson_id = source.source_native_id
    left join source_ids prefixed on prefixed.source_lesson_id = 'jwb-open-api:schedule:' || source.source_native_id
$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_matching_anchor_mismatch';
  end if;
  execute replace(definition, anchor, replacement);
end;
$patch_authority_matching$;

alter function public.project_jiaowubao_open_api_authority_read_model(text,text,text)
  set enable_nestloop = off;
alter function public.project_jiaowubao_open_api_authority_read_model(text,text,text)
  set jit = off;
alter function public.apply_jiaowubao_open_api_authority_native(text,uuid,text)
  set enable_nestloop = off;
alter function public.apply_jiaowubao_open_api_authority_native(text,uuid,text)
  set jit = off;

do $reuse_normalized_authority$
declare
  target_oid regprocedure := 'public.project_jiaowubao_open_api_authority_read_model(text,text,text)'::regprocedure;
  definition text;
  anchor text;
  replacement text;
begin
  definition := pg_catalog.pg_get_functiondef(target_oid);
  anchor := $anchor$  projection_id uuid := gen_random_uuid();$anchor$;
  replacement := $replacement$  projection_id uuid := gen_random_uuid();
  normalized_projection_id uuid;$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_normalized_reuse_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  anchor := $anchor$  insert into internal.jiaowubao_authority_projection_entities(
    projection_run_id, entity_type, source_key, source_native_id, source_id_present,
    identity_label, identity_key, payload, evidence_count, identity_variant_count,
    match_status, conflict_type
  )
  select projection_id, 'schedule',$anchor$;
  replacement := $replacement$  select existing_projection.id into normalized_projection_id
  from internal.jiaowubao_authority_projection_runs existing_projection
  where existing_projection.snapshot_run_id = current_row.run_id
    and existing_projection.snapshot_revision = p_revision
    and existing_projection.api_source_key = current_row.api_source_key
    and existing_projection.summary <> '{}'::jsonb
  order by existing_projection.projected_at desc, existing_projection.id
  limit 1;

  if normalized_projection_id is not null then
    insert into internal.jiaowubao_authority_projection_entities(
      projection_run_id, entity_type, source_key, source_native_id, source_id_present,
      identity_label, identity_key, payload, evidence_count, identity_variant_count,
      match_status, match_strategy, conflict_type
    )
    select projection_id, entity_type, source_key, source_native_id, source_id_present,
      identity_label, identity_key, payload, evidence_count, identity_variant_count,
      case when entity_type in ('class','room') then 'source_only' else 'unmatched' end,
      case when entity_type in ('class','room') then 'source_only' else null end,
      case when entity_type in ('class','room') then null else 'not_found' end
    from internal.jiaowubao_authority_projection_entities
    where projection_run_id = normalized_projection_id;
  else
  insert into internal.jiaowubao_authority_projection_entities(
    projection_run_id, entity_type, source_key, source_native_id, source_id_present,
    identity_label, identity_key, payload, evidence_count, identity_variant_count,
    match_status, conflict_type
  )
  select projection_id, 'schedule',$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_normalized_reuse_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  anchor := $anchor$  -- Match students by their stable Jiaowubao member ID first.$anchor$;
  replacement := $replacement$  end if;

  -- Match students by their stable Jiaowubao member ID first.$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_normalized_reuse_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  execute definition;
end;
$reuse_normalized_authority$;

do $reuse_authority_name_keys$
declare
  target_oid regprocedure := 'public.project_jiaowubao_open_api_authority_read_model(text,text,text)'::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(target_oid);
  name_expression text;
  anchor text;
  replacement text;
begin
  foreach name_expression in array array[
    $$item_row.item -> 'record' ->> 'course_title'$$,
    $$student_value.value ->> 'name'$$,
    $$grouped.latest_payload ->> 'name'$$,
    $$teacher_value.identity_label$$,
    $$grouped.latest_payload ->> 'teacher_title'$$,
    $$dimension.identity_label$$,
    $$grouped.latest_payload ->> 'title'$$,
    $$item_value.value ->> 'name'$$
  ] loop
    anchor := 'internal.student_import_name_key(' || name_expression || ')';
    if position(anchor in definition) = 0 then
      raise exception using errcode = '55000', message = 'jiaowubao_authority_name_cache_anchor_mismatch';
    end if;
    definition := replace(definition, anchor,
      '(normalized_names ->> coalesce(' || name_expression || ', ''''))');
  end loop;
  if position('internal.student_import_name_key(' in definition) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_name_cache_anchor_mismatch';
  end if;
  anchor := $anchor$  normalized_projection_id uuid;$anchor$;
  replacement := $replacement$  normalized_projection_id uuid;
  normalized_names jsonb;$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_name_cache_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  anchor := $anchor$  select existing_projection.id into normalized_projection_id$anchor$;
  replacement := $replacement$  with source_records as materialized (
    select item -> 'record' as record
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_items
    where run_id = current_row.run_id
  ), name_candidates as (
    select item.value ->> 'name' as name
    from (values ('students'::text), ('teachers'::text), ('courses'::text)) state(entity)
    cross join lateral jsonb_array_elements(native_state_payloads_value -> state.entity) item(value)
    union all
    select dimension.name
    from source_records source
    cross join lateral (values
      (source.record ->> 'course_title'), (source.record ->> 'teacher_title'),
      (source.record ->> 'teacher_s_title'), (source.record ->> 'teacher_t_title'),
      (source.record ->> 'team_title'), (source.record ->> 'room_title')
    ) dimension(name)
    union all
    select student.value ->> 'name'
    from source_records source
    cross join lateral jsonb_array_elements(case
      when jsonb_typeof(source.record -> 'stu_list') = 'array'
      then source.record -> 'stu_list' else '[]'::jsonb end) student(value)
  ), distinct_names as materialized (
    select distinct variant.name
    from name_candidates candidate
    cross join lateral (values (coalesce(candidate.name, '')), (coalesce(btrim(candidate.name), ''))) variant(name)
  )
  select jsonb_object_agg(name, internal.student_import_name_key(name))
  into normalized_names from distinct_names;

  select existing_projection.id into normalized_projection_id$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_name_cache_anchor_mismatch';
  end if;
  execute replace(definition, anchor, replacement);
end;
$reuse_authority_name_keys$;

do $insert_authority_schedule_matches$
declare
  target_oid regprocedure := 'public.project_jiaowubao_open_api_authority_read_model(text,text,text)'::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(target_oid);
  anchor text;
  replacement text;
begin
  anchor := $anchor$  normalized_names jsonb;$anchor$;
  replacement := $replacement$  normalized_names jsonb;
  native_schedule_matches jsonb;$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_schedule_insert_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  anchor := $anchor$  select existing_projection.id into normalized_projection_id$anchor$;
  replacement := $replacement$  with booking_ids as materialized (
    select nullif(btrim(booking.value ->> 'sourceLessonId'), '') as source_lesson_id,
      count(*)::integer as match_count, min(booking.value ->> 'id') as entity_id
    from jsonb_array_elements(native_state_payloads_value -> 'bookings') booking(value)
    where nullif(btrim(booking.value ->> 'id'), '') is not null
    group by nullif(btrim(booking.value ->> 'sourceLessonId'), '')
  ), source_ids as materialized (
    select distinct item -> 'record' ->> 'cal_id' as source_native_id
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_items
    where run_id = current_row.run_id and item -> 'record' ->> 'cal_id' is not null
  ), matches as (
    select source.source_native_id,
      coalesce(direct.match_count, 0) + coalesce(prefixed.match_count, 0) as match_count,
      least(direct.entity_id, prefixed.entity_id) as entity_id
    from source_ids source
    left join booking_ids direct on direct.source_lesson_id = source.source_native_id
    left join booking_ids prefixed on prefixed.source_lesson_id = 'jwb-open-api:schedule:' || source.source_native_id
  )
  select coalesce(jsonb_object_agg(source_native_id, jsonb_build_object(
    'match_status', case when match_count = 1 then 'matched' when match_count > 1 then 'conflict' else 'unmatched' end,
    'match_strategy', case when match_count = 1 then 'source_id' else null end,
    'matched_entity_id', case when match_count = 1 then entity_id else null end,
    'conflict_type', case when match_count > 1 then 'source_id_matches_multiple' when match_count = 0 then 'not_found' else null end
  )), '{}'::jsonb) into native_schedule_matches from matches;

  select existing_projection.id into normalized_projection_id$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_schedule_insert_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  anchor := $anchor$      match_status, match_strategy, conflict_type
    )
    select projection_id, entity_type, source_key, source_native_id, source_id_present,
      identity_label, identity_key, payload, evidence_count, identity_variant_count,
      case when entity_type in ('class','room') then 'source_only' else 'unmatched' end,
      case when entity_type in ('class','room') then 'source_only' else null end,
      case when entity_type in ('class','room') then null else 'not_found' end$anchor$;
  replacement := $replacement$      match_status, match_strategy, matched_entity_id, conflict_type
    )
    select projection_id, entity_type, source_key, source_native_id, source_id_present,
      identity_label, identity_key, payload, evidence_count, identity_variant_count,
      case when entity_type = 'schedule' then native_schedule_matches -> source_native_id ->> 'match_status'
        when entity_type in ('class','room') then 'source_only' else 'unmatched' end,
      case when entity_type = 'schedule' then native_schedule_matches -> source_native_id ->> 'match_strategy'
        when entity_type in ('class','room') then 'source_only' else null end,
      case when entity_type = 'schedule' then native_schedule_matches -> source_native_id ->> 'matched_entity_id' else null end,
      case when entity_type = 'schedule' then native_schedule_matches -> source_native_id ->> 'conflict_type'
        when entity_type in ('class','room') then null else 'not_found' end$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_schedule_insert_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  anchor := $anchor$    match_status, conflict_type
  )
  select projection_id, 'schedule',$anchor$;
  replacement := $replacement$    match_status, match_strategy, matched_entity_id, conflict_type
  )
  select projection_id, 'schedule',$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_schedule_insert_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  anchor := $anchor$    item_row.item -> 'record', 1, 1, 'unmatched', 'not_found'$anchor$;
  replacement := $replacement$    item_row.item -> 'record', 1, 1,
    native_schedule_matches -> (item_row.item -> 'record' ->> 'cal_id') ->> 'match_status',
    native_schedule_matches -> (item_row.item -> 'record' ->> 'cal_id') ->> 'match_strategy',
    native_schedule_matches -> (item_row.item -> 'record' ->> 'cal_id') ->> 'matched_entity_id',
    native_schedule_matches -> (item_row.item -> 'record' ->> 'cal_id') ->> 'conflict_type'$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_schedule_insert_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  anchor := $anchor$  with system_bookings as materialized (
    select booking_value.value ->> 'id' as entity_id,
      nullif(btrim(booking_value.value ->> 'sourceLessonId'), '') as source_lesson_id
    from jsonb_array_elements(native_state_payloads_value -> 'bookings') booking_value(value)
    where nullif(btrim(booking_value.value ->> 'id'), '') is not null
  ), booking_ids as materialized (
    select source_lesson_id, count(*)::integer as match_count, min(entity_id) as entity_id
    from system_bookings group by source_lesson_id
  ), stats as materialized (
    select source_entity.source_key,
      coalesce(direct.match_count, 0) + coalesce(prefixed.match_count, 0) as match_count,
      least(direct.entity_id, prefixed.entity_id) as entity_id
    from internal.jiaowubao_authority_projection_entities source_entity
    left join booking_ids direct on direct.source_lesson_id = source_entity.source_native_id
    left join booking_ids prefixed on prefixed.source_lesson_id = 'jwb-open-api:schedule:' || source_entity.source_native_id
    where source_entity.projection_run_id = projection_id and source_entity.entity_type = 'schedule'
  )
  update internal.jiaowubao_authority_projection_entities source_entity
  set match_status = case when stats.match_count = 1 then 'matched'
      when stats.match_count > 1 then 'conflict' else 'unmatched' end,
    match_strategy = case when stats.match_count = 1 then 'source_id' else null end,
    matched_entity_id = case when stats.match_count = 1 then stats.entity_id else null end,
    conflict_type = case when stats.match_count > 1 then 'source_id_matches_multiple'
      when stats.match_count = 0 then 'not_found' else null end
  from stats
  where source_entity.projection_run_id = projection_id
    and source_entity.entity_type = 'schedule'
    and source_entity.source_key = stats.source_key;

$anchor$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_schedule_insert_anchor_mismatch';
  end if;
  execute replace(definition, anchor, '');
end;
$insert_authority_schedule_matches$;

do $reuse_native_validation$
declare
  target_oid regprocedure := 'public.apply_jiaowubao_open_api_authority_native(text,uuid,text)'::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(target_oid);
  anchor text;
  replacement text;
begin
  anchor := $anchor$      type_map.native_entity_type, type_map.prefix, type_map.native_payload$anchor$;
  replacement := $replacement$      type_map.native_entity_type, type_map.prefix$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0
     or position('source.native_payload' in definition) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_native_validation_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);
  anchor := $anchor$      and internal.jiaowubao_authority_native_schedule_skip_reason(
        projection_run.id,
        source_entity.source_key,
        source_entity.source_native_id,
        source_entity.payload
      ) is null$anchor$;
  replacement := $replacement$      and not exists (
        select 1 from internal.jiaowubao_authority_native_quarantine quarantine
        where quarantine.projection_run_id = projection_run.id
          and quarantine.source_revision = projection_run.snapshot_revision
          and quarantine.entity_type = source_entity.entity_type
          and quarantine.source_key = source_entity.source_key
          and quarantine.active
      )$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_native_validation_anchor_mismatch';
  end if;
  execute replace(definition, anchor, replacement);
end;
$reuse_native_validation$;

do $group_authority_validation$
declare
  definition text;
  anchor text;
  replacement text;
begin
  definition := pg_catalog.pg_get_functiondef('internal.jiaowubao_authority_native_schedule_skip_reason(uuid,text,text,jsonb)'::regprocedure);
  anchor := 'p_record jsonb)';
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_group_validation_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, 'p_record jsonb, p_has_duplicate_source boolean)');
  anchor := $anchor$  if exists (
    select 1
    from internal.jiaowubao_authority_projection_entities peer
    where peer.projection_run_id = p_projection_run_id
      and peer.entity_type = 'schedule'
      and peer.source_native_id = p_source_native_id
      and peer.source_key <> p_source_key
  ) then$anchor$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_group_validation_anchor_mismatch';
  end if;
  execute replace(definition, anchor, '  if p_has_duplicate_source then');

  definition := pg_catalog.pg_get_functiondef('public.apply_jiaowubao_open_api_authority_native(text,uuid,text)'::regprocedure);
  anchor := $anchor$  with candidates as materialized (
    select source_entity.*,
      case
        when source_entity.entity_type = 'schedule' then
          internal.jiaowubao_authority_native_schedule_skip_reason(
            projection_run.id,
            source_entity.source_key,
            source_entity.source_native_id,
            source_entity.payload
          )
        when source_entity.source_native_id is null then 'missing_source_id'
        else null
      end as skip_reason
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_run.id
  )$anchor$;
  replacement := $replacement$  with source_counts as materialized (
    select source_native_id, count(*) > 1 as has_duplicate_source
    from internal.jiaowubao_authority_projection_entities
    where projection_run_id = projection_run.id and entity_type = 'schedule'
    group by source_native_id
  ), candidates as materialized (
    select source_entity.*,
      case
        when source_entity.entity_type = 'schedule' then
          internal.jiaowubao_authority_native_schedule_skip_reason(
            projection_run.id,
            source_entity.source_key,
            source_entity.source_native_id,
            source_entity.payload,
            coalesce(source_counts.has_duplicate_source, false)
          )
        when source_entity.source_native_id is null then 'missing_source_id'
        else null
      end as skip_reason
    from internal.jiaowubao_authority_projection_entities source_entity
    left join source_counts on source_entity.entity_type = 'schedule'
      and source_counts.source_native_id = source_entity.source_native_id
    where source_entity.projection_run_id = projection_run.id
  )$replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_group_validation_anchor_mismatch';
  end if;
  execute replace(definition, anchor, replacement);
end;
$group_authority_validation$;

revoke all on function internal.jiaowubao_authority_native_schedule_skip_reason(uuid,text,text,jsonb,boolean)
  from public, anon, authenticated, service_role;

alter function public.project_jiaowubao_open_api_authority_read_model(text,text,text)
  set work_mem = '16MB';
alter function public.apply_jiaowubao_open_api_authority_native(text,uuid,text)
  set work_mem = '16MB';

do $skip_reused_source_names$
declare
  target_oid regprocedure := 'public.project_jiaowubao_open_api_authority_read_model(text,text,text)'::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(target_oid);
  anchor text;
  projection_lookup text;
  replacement text;
begin
  projection_lookup := $lookup$  select existing_projection.id into normalized_projection_id
  from internal.jiaowubao_authority_projection_runs existing_projection
  where existing_projection.snapshot_run_id = current_row.run_id
    and existing_projection.snapshot_revision = p_revision
    and existing_projection.api_source_key = current_row.api_source_key
    and existing_projection.summary <> '{}'::jsonb
  order by existing_projection.projected_at desc, existing_projection.id
  limit 1;

$lookup$;
  if position(projection_lookup in definition) = 0
     or position(projection_lookup in substr(definition, position(projection_lookup in definition) + char_length(projection_lookup))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_source_names_anchor_mismatch';
  end if;
  definition := replace(definition, projection_lookup, '');
  anchor := $anchor$  with source_records as materialized (
    select item -> 'record' as record
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_items
    where run_id = current_row.run_id
  ), name_candidates as ($anchor$;
  replacement := projection_lookup || $replacement$  with source_records as materialized (
    select item -> 'record' as record
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_items
    where run_id = current_row.run_id and normalized_projection_id is null
  ), name_candidates as ($replacement$;
  if position(anchor in definition) = 0
     or position(anchor in substr(definition, position(anchor in definition) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_source_names_anchor_mismatch';
  end if;
  execute replace(definition, anchor, replacement);
end;
$skip_reused_source_names$;
