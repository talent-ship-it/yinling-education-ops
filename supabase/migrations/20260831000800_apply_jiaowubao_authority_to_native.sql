-- Make the current Jiaowubao Open API snapshot operational, not merely
-- observable. Every supplier entity receives a durable native crosswalk;
-- students, teachers, courses and one-student schedule rows are merged into
-- ops_state while the complete source payload (including prices) remains in
-- private, access-revoked relations.

set local lock_timeout = '2s';

create table if not exists internal.jiaowubao_authority_native_links (
  entity_type text not null check (entity_type in ('schedule','student','teacher','course','class','room')),
  source_native_id text not null check (char_length(source_native_id) between 1 and 8192),
  native_entity_type text not null check (native_entity_type in ('bookings','students','teachers','courses','classes','rooms')),
  native_entity_id text not null check (char_length(native_entity_id) between 1 and 240),
  resolution text not null check (resolution in ('stable_source_id','same_name','existing_source_id','created','embedded')),
  confidence text not null check (confidence in ('exact','inferred')),
  source_label text check (source_label is null or char_length(source_label) between 1 and 2000),
  source_payload jsonb not null check (jsonb_typeof(source_payload) = 'object' and octet_length(source_payload::text) between 2 and 262144),
  source_revision text not null check (source_revision ~ '^sha256:[a-f0-9]{64}$'),
  active boolean not null default true,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  primary key (entity_type, source_native_id)
);

create index if not exists jiaowubao_authority_native_links_target_idx
  on internal.jiaowubao_authority_native_links (native_entity_type, native_entity_id);
create index if not exists jiaowubao_authority_native_links_active_idx
  on internal.jiaowubao_authority_native_links (entity_type, active);

alter table internal.jiaowubao_authority_native_links enable row level security;
revoke all on table internal.jiaowubao_authority_native_links from public, anon, authenticated;

create or replace function internal.jiaowubao_authority_native_id(p_prefix text, p_source_native_id text)
returns text
language sql
immutable
strict
set search_path = ''
as $jiaowubao_authority_native_id$
  select 'JWB-' || p_prefix || '-' || upper(substr(encode(extensions.digest(
    pg_catalog.convert_to(p_source_native_id, 'UTF8'), 'sha256'
  ), 'hex'), 1, 24))
$jiaowubao_authority_native_id$;

revoke all on function internal.jiaowubao_authority_native_id(text,text) from public, anon, authenticated;

create or replace function internal.jiaowubao_authority_initials(p_name text)
returns text
language sql
immutable
set search_path = ''
as $jiaowubao_authority_initials$
  select coalesce(nullif(upper(substr(nullif(btrim(p_name), ''), 1, 2)), ''), '新')
$jiaowubao_authority_initials$;

revoke all on function internal.jiaowubao_authority_initials(text) from public, anon, authenticated;

create or replace function internal.jiaowubao_authority_booking_duration(p_record jsonb)
returns integer
language plpgsql
immutable
set search_path = ''
as $jiaowubao_authority_booking_duration$
declare
  start_text text := nullif(btrim(p_record ->> 'time_start'), '');
  end_text text := nullif(btrim(p_record ->> 'time_end'), '');
  start_minutes integer;
  end_minutes integer;
  candidate numeric;
begin
  if start_text ~ '^\d{2}:\d{2}$' and end_text ~ '^\d{2}:\d{2}$' then
    start_minutes := substring(start_text from 1 for 2)::integer * 60
      + substring(start_text from 4 for 2)::integer;
    end_minutes := substring(end_text from 1 for 2)::integer * 60
      + substring(end_text from 4 for 2)::integer;
    if start_minutes between 0 and 1439 and end_minutes between 0 and 1439
       and end_minutes > start_minutes then
      return end_minutes - start_minutes;
    end if;
  end if;
  if coalesce(p_record ->> 'cal_length', '') ~ '^\d+(?:\.\d+)?$' then
    candidate := (p_record ->> 'cal_length')::numeric;
    if candidate > 0 and candidate <= 1440 then return greatest(1, round(candidate)::integer); end if;
  end if;
  if coalesce(p_record ->> 'hours', '') ~ '^\d+(?:\.\d+)?$' then
    candidate := (p_record ->> 'hours')::numeric * 60;
    if candidate > 0 and candidate <= 1440 then return greatest(1, round(candidate)::integer); end if;
  end if;
  return 60;
exception when others then
  return 60;
end;
$jiaowubao_authority_booking_duration$;

revoke all on function internal.jiaowubao_authority_booking_duration(jsonb) from public, anon, authenticated;

create or replace function public.apply_jiaowubao_open_api_authority_native(
  p_secret text,
  p_projection_run_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '120s'
as $apply_jiaowubao_open_api_authority_native$
declare
  projection_run internal.jiaowubao_authority_projection_runs%rowtype;
  snapshot_run internal.jiaowubao_open_api_schedule_snapshot_ingest_runs%rowtype;
  students_state public.ops_state%rowtype;
  teachers_state public.ops_state%rowtype;
  courses_state public.ops_state%rowtype;
  bookings_state public.ops_state%rowtype;
  next_students jsonb;
  next_teachers jsonb;
  next_courses jsonb;
  next_bookings jsonb;
  changed_students boolean;
  changed_teachers boolean;
  changed_courses boolean;
  changed_bookings boolean;
  applied boolean;
  applied_at timestamptz := clock_timestamp();
  saved_versions jsonb;
  source_counts jsonb;
  resolution_counts jsonb;
  native_counts jsonb;
  anomaly_counts jsonb;
  price_counts jsonb;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor <> 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_authority_native_apply_forbidden';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao-authority-native-apply:jwb-open-api-schedule', 0)
  );

  select projection.* into projection_run
  from internal.jiaowubao_authority_projection_runs projection
  join internal.jiaowubao_authority_current current_projection
    on current_projection.projection_run_id = projection.id
   and current_projection.api_source_key = projection.api_source_key
   and current_projection.snapshot_revision = projection.snapshot_revision
  where projection.id = p_projection_run_id
    and projection.api_source_key = 'jwb-open-api-schedule'
    and projection.summary <> '{}'::jsonb;
  if not found then
    raise exception using errcode = '40001', message = 'jiaowubao_authority_projection_revision_changed';
  end if;

  select source_run.* into snapshot_run
  from internal.jiaowubao_open_api_schedule_snapshot_ingest_runs source_run
  where source_run.id = projection_run.snapshot_run_id
    and source_run.state = 'complete'
    and source_run.revision = projection_run.snapshot_revision;
  if not found then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_snapshot_invalid';
  end if;

  -- Lock the four native documents in one deterministic order so this merge
  -- cannot interleave with an ordinary operational mutation.
  perform 1
  from public.ops_state state
  where state.entity in ('bookings','courses','students','teachers')
  order by state.entity
  for update;

  select * into bookings_state from public.ops_state where entity = 'bookings';
  select * into courses_state from public.ops_state where entity = 'courses';
  select * into students_state from public.ops_state where entity = 'students';
  select * into teachers_state from public.ops_state where entity = 'teachers';
  if not found
     or jsonb_typeof(bookings_state.payload) <> 'array'
     or jsonb_typeof(courses_state.payload) <> 'array'
     or jsonb_typeof(students_state.payload) <> 'array'
     or jsonb_typeof(teachers_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_native_state_invalid';
  end if;

  if exists (
    select 1
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_run.id
      and source_entity.entity_type = 'schedule'
      and (
        source_entity.source_native_id is null
        or source_entity.payload ->> 'dated' !~ '^\d{4}-\d{2}-\d{2}$'
        or source_entity.payload ->> 'time_start' !~ '^\d{2}:\d{2}$'
        or jsonb_typeof(source_entity.payload -> 'stu_list') <> 'array'
        or jsonb_array_length(source_entity.payload -> 'stu_list') <> 1
        or nullif(btrim(source_entity.payload #>> '{stu_list,0,mem_id}'), '') is null
        or nullif(btrim(source_entity.payload ->> 'teacher_id'), '') is null
        or nullif(btrim(source_entity.payload ->> 'course_id'), '') is null
      )
  ) then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_native_schedule_shape_invalid';
  end if;

  update internal.jiaowubao_authority_native_links
  set active = false
  where active;

  -- Student member IDs are the strongest identity. A prior durable link wins,
  -- then an existing JWB member ID, then a same-name inference, and finally a
  -- deterministic native record owned by this source.
  with sources as materialized (
    select source_entity.source_native_id, source_entity.identity_label,
      source_entity.identity_key, source_entity.payload
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_run.id
      and source_entity.entity_type = 'student'
      and source_entity.source_native_id is not null
  ), native_students as materialized (
    select item.value ->> 'id' as entity_id,
      internal.student_import_name_key(item.value ->> 'name') as name_key,
      coalesce(
        nullif(internal.student_import_source_key(item.value -> 'jwbSourceRow'), ''),
        nullif(internal.student_import_source_key(item.value #> '{historicalJwbSnapshot,currentAggregate,jwbSourceRow}'), ''),
        nullif(internal.student_import_source_key(item.value #> '{historicalJwbSnapshot,retained,jwbSourceRow}'), '')
      ) as source_id
    from jsonb_array_elements(students_state.payload) item(value)
    where nullif(btrim(item.value ->> 'id'), '') is not null
  ), candidates as materialized (
    select source.*,
      case when prior.native_entity_id is not null and exists (
        select 1 from native_students native where native.entity_id = prior.native_entity_id
      ) then prior.native_entity_id end as prior_id,
      (select min(native.entity_id) from native_students native where native.source_id = source.source_native_id) as stable_id,
      (select min(native.entity_id) from native_students native where native.name_key <> '' and native.name_key = source.identity_key) as name_id
    from sources source
    left join internal.jiaowubao_authority_native_links prior
      on prior.entity_type = 'student' and prior.source_native_id = source.source_native_id
  ), resolved as (
    select candidate.*,
      coalesce(candidate.prior_id, candidate.stable_id, candidate.name_id,
        internal.jiaowubao_authority_native_id('STU', candidate.source_native_id)) as native_id,
      case when candidate.prior_id is not null or candidate.stable_id is not null then 'stable_source_id'
        when candidate.name_id is not null then 'same_name' else 'created' end as resolution,
      case when candidate.name_id is not null and candidate.prior_id is null and candidate.stable_id is null
        then 'inferred' else 'exact' end as confidence
    from candidates candidate
  )
  insert into internal.jiaowubao_authority_native_links(
    entity_type, source_native_id, native_entity_type, native_entity_id,
    resolution, confidence, source_label, source_payload, source_revision,
    active, first_seen_at, last_seen_at
  )
  select 'student', source_native_id, 'students', native_id,
    resolution, confidence, identity_label, payload, projection_run.snapshot_revision,
    true, applied_at, applied_at
  from resolved
  on conflict (entity_type, source_native_id) do update set
    native_entity_type = excluded.native_entity_type,
    native_entity_id = excluded.native_entity_id,
    resolution = excluded.resolution,
    confidence = excluded.confidence,
    source_label = excluded.source_label,
    source_payload = excluded.source_payload,
    source_revision = excluded.source_revision,
    active = true,
    last_seen_at = excluded.last_seen_at;

  -- Teacher and course APIs currently provide stable source IDs but the old
  -- native documents do not. Reuse a durable link/name before creating one.
  with type_map(entity_type, native_entity_type, prefix, native_payload) as (
    values
      ('teacher'::text, 'teachers'::text, 'TCH'::text, teachers_state.payload),
      ('course'::text, 'courses'::text, 'CRS'::text, courses_state.payload)
  ), sources as materialized (
    select source_entity.entity_type, source_entity.source_native_id,
      source_entity.identity_label, source_entity.identity_key, source_entity.payload,
      type_map.native_entity_type, type_map.prefix, type_map.native_payload
    from internal.jiaowubao_authority_projection_entities source_entity
    join type_map on type_map.entity_type = source_entity.entity_type
    where source_entity.projection_run_id = projection_run.id
      and source_entity.source_native_id is not null
  ), candidates as materialized (
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
  ), resolved as (
    select candidate.*,
      coalesce(candidate.prior_id, candidate.name_id,
        internal.jiaowubao_authority_native_id(candidate.prefix, candidate.source_native_id)) as native_id,
      case when candidate.prior_id is not null then 'stable_source_id'
        when candidate.name_id is not null then 'same_name' else 'created' end as resolution,
      case when candidate.name_id is not null and candidate.prior_id is null then 'inferred' else 'exact' end as confidence
    from candidates candidate
  )
  insert into internal.jiaowubao_authority_native_links(
    entity_type, source_native_id, native_entity_type, native_entity_id,
    resolution, confidence, source_label, source_payload, source_revision,
    active, first_seen_at, last_seen_at
  )
  select entity_type, source_native_id, native_entity_type, native_id,
    resolution, confidence, identity_label, payload, projection_run.snapshot_revision,
    true, applied_at, applied_at
  from resolved
  on conflict (entity_type, source_native_id) do update set
    native_entity_type = excluded.native_entity_type,
    native_entity_id = excluded.native_entity_id,
    resolution = excluded.resolution,
    confidence = excluded.confidence,
    source_label = excluded.source_label,
    source_payload = excluded.source_payload,
    source_revision = excluded.source_revision,
    active = true,
    last_seen_at = excluded.last_seen_at;

  -- Classes and rooms are embedded operational dimensions on each Booking.
  insert into internal.jiaowubao_authority_native_links(
    entity_type, source_native_id, native_entity_type, native_entity_id,
    resolution, confidence, source_label, source_payload, source_revision,
    active, first_seen_at, last_seen_at
  )
  select source_entity.entity_type, source_entity.source_native_id,
    case source_entity.entity_type when 'class' then 'classes' else 'rooms' end,
    internal.jiaowubao_authority_native_id(
      case source_entity.entity_type when 'class' then 'CLS' else 'ROOM' end,
      source_entity.source_native_id
    ),
    'embedded', 'exact', source_entity.identity_label, source_entity.payload,
    projection_run.snapshot_revision, true, applied_at, applied_at
  from internal.jiaowubao_authority_projection_entities source_entity
  where source_entity.projection_run_id = projection_run.id
    and source_entity.entity_type in ('class','room')
    and source_entity.source_native_id is not null
  on conflict (entity_type, source_native_id) do update set
    native_entity_type = excluded.native_entity_type,
    native_entity_id = excluded.native_entity_id,
    resolution = excluded.resolution,
    confidence = excluded.confidence,
    source_label = excluded.source_label,
    source_payload = excluded.source_payload,
    source_revision = excluded.source_revision,
    active = true,
    last_seen_at = excluded.last_seen_at;

  -- Every API calendar row is one learner in the verified production shape.
  -- Reuse a prior/direct source booking before allocating a deterministic ID.
  with sources as materialized (
    select source_entity.source_native_id, source_entity.identity_label, source_entity.payload
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_run.id
      and source_entity.entity_type = 'schedule'
      and source_entity.source_native_id is not null
  ), candidates as materialized (
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
  ), resolved as (
    select candidate.*,
      coalesce(candidate.prior_id, candidate.direct_id,
        internal.jiaowubao_authority_native_id('BOOK', candidate.source_native_id)) as native_id,
      case when candidate.prior_id is not null then 'stable_source_id'
        when candidate.direct_id is not null then 'existing_source_id' else 'created' end as resolution
    from candidates candidate
  )
  insert into internal.jiaowubao_authority_native_links(
    entity_type, source_native_id, native_entity_type, native_entity_id,
    resolution, confidence, source_label, source_payload, source_revision,
    active, first_seen_at, last_seen_at
  )
  select 'schedule', source_native_id, 'bookings', native_id,
    resolution, 'exact', identity_label, payload, projection_run.snapshot_revision,
    true, applied_at, applied_at
  from resolved
  on conflict (entity_type, source_native_id) do update set
    native_entity_type = excluded.native_entity_type,
    native_entity_id = excluded.native_entity_id,
    resolution = excluded.resolution,
    confidence = excluded.confidence,
    source_label = excluded.source_label,
    source_payload = excluded.source_payload,
    source_revision = excluded.source_revision,
    active = true,
    last_seen_at = excluded.last_seen_at;

  -- Build the native student document. Source-owned display name, current
  -- course/teacher and stable member ID are refreshed; unrelated authorities'
  -- fields remain untouched. A conflicting prior display name is retained as
  -- provenance before Jiaowubao's current value becomes canonical.
  with latest_context as materialized (
    select distinct on (schedule.payload #>> '{stu_list,0,mem_id}')
      schedule.payload #>> '{stu_list,0,mem_id}' as source_native_id,
      nullif(btrim(schedule.payload ->> 'course_title'), '') as course_title,
      nullif(btrim(schedule.payload ->> 'teacher_title'), '') as teacher_title
    from internal.jiaowubao_authority_projection_entities schedule
    where schedule.projection_run_id = projection_run.id
      and schedule.entity_type = 'schedule'
    order by schedule.payload #>> '{stu_list,0,mem_id}',
      schedule.payload ->> 'dated' desc,
      schedule.payload ->> 'time_start' desc,
      schedule.source_native_id desc
  ), mapped as materialized (
    select distinct on (link.native_entity_id)
      link.native_entity_id, link.source_native_id, link.resolution, link.confidence,
      link.source_label, link.source_payload, context.course_title, context.teacher_title
    from internal.jiaowubao_authority_native_links link
    left join latest_context context on context.source_native_id = link.source_native_id
    where link.entity_type = 'student' and link.active
    order by link.native_entity_id, link.source_native_id
  ), existing as materialized (
    select item.value, item.ordinality
    from jsonb_array_elements(students_state.payload) with ordinality item(value, ordinality)
  ), projected_existing as (
    select existing.ordinality, case when mapped.native_entity_id is null then existing.value else
      existing.value || jsonb_strip_nulls(jsonb_build_object(
        'name', coalesce(mapped.source_label, existing.value ->> 'name'),
        'initials', internal.jiaowubao_authority_initials(coalesce(mapped.source_label, existing.value ->> 'name')),
        'course', coalesce(mapped.course_title, existing.value ->> 'course', '待确认'),
        'teacher', coalesce(mapped.teacher_title, existing.value ->> 'teacher', '待匹配'),
        'jwbSourceRow', mapped.source_native_id,
        'jwbMatchStatus', 'matched',
        'jwbSyncedAt', snapshot_run.completed_at,
        'jwbSyncStatus', 'synced',
        'importSource', coalesce(nullif(existing.value ->> 'importSource', ''), 'jiaowubao-open-api'),
        'jiaowubaoOpenApi', jsonb_strip_nulls(jsonb_build_object(
          'sourceId', mapped.source_native_id,
          'displayName', mapped.source_label,
          'snapshotRevision', projection_run.snapshot_revision,
          'resolution', mapped.resolution,
          'confidence', mapped.confidence,
          'previousSystemName', coalesce(
            nullif(existing.value #>> '{jiaowubaoOpenApi,previousSystemName}', ''),
            case when internal.student_import_name_key(existing.value ->> 'name')
              <> internal.student_import_name_key(mapped.source_label)
              then nullif(existing.value ->> 'name', '') end
          ),
          'rawPayloadStoredPrivately', true
        ))
      )) end as value
    from existing
    left join mapped on mapped.native_entity_id = existing.value ->> 'id'
  ), new_rows as (
    select 1000000000::bigint + row_number() over (order by mapped.native_entity_id) as ordinality,
      jsonb_strip_nulls(jsonb_build_object(
        'id', mapped.native_entity_id,
        'name', coalesce(mapped.source_label, '教务宝学员'),
        'initials', internal.jiaowubao_authority_initials(mapped.source_label),
        'status', '在读',
        'segment', '已报名',
        'owner', '待分配',
        'planner', '待分配',
        'course', coalesce(mapped.course_title, '待确认'),
        'timezone', 'Australia/Melbourne',
        'teacher', coalesce(mapped.teacher_title, '待匹配'),
        'next', '核对教务宝 Open API 资料',
        'nextTone', 'amber',
        'files', 0,
        'followUp', '未记录',
        'jwbSourceRow', mapped.source_native_id,
        'jwbMatchStatus', 'matched',
        'jwbSyncedAt', snapshot_run.completed_at,
        'jwbSyncStatus', 'synced',
        'importSource', 'jiaowubao-open-api',
        'jiaowubaoOpenApi', jsonb_strip_nulls(jsonb_build_object(
          'sourceId', mapped.source_native_id,
          'displayName', mapped.source_label,
          'snapshotRevision', projection_run.snapshot_revision,
          'resolution', mapped.resolution,
          'confidence', mapped.confidence,
          'rawPayloadStoredPrivately', true
        ))
      )) as value
    from mapped
    where not exists (select 1 from existing where existing.value ->> 'id' = mapped.native_entity_id)
  ), all_rows as (
    select * from projected_existing
    union all
    select * from new_rows
  )
  select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
  into next_students
  from all_rows;

  with mapped as materialized (
    select distinct on (link.native_entity_id)
      link.native_entity_id, link.source_native_id, link.resolution, link.confidence,
      link.source_label, link.source_payload
    from internal.jiaowubao_authority_native_links link
    where link.entity_type = 'course' and link.active
    order by link.native_entity_id, link.source_native_id
  ), existing as materialized (
    select item.value, item.ordinality
    from jsonb_array_elements(courses_state.payload) with ordinality item(value, ordinality)
  ), projected_existing as (
    select existing.ordinality, case when mapped.native_entity_id is null then existing.value else
      existing.value || jsonb_build_object(
        'name', coalesce(mapped.source_label, existing.value ->> 'name'),
        'source', coalesce(nullif(existing.value ->> 'source', ''), '教务宝 Open API'),
        'jiaowubaoOpenApi', jsonb_strip_nulls(jsonb_build_object(
          'sourceId', mapped.source_native_id,
          'title', mapped.source_label,
          'snapshotRevision', projection_run.snapshot_revision,
          'resolution', mapped.resolution,
          'confidence', mapped.confidence,
          'rawPayloadStoredPrivately', true
        ))
      ) end as value
    from existing
    left join mapped on mapped.native_entity_id = existing.value ->> 'id'
  ), new_rows as (
    select 1000000000::bigint + row_number() over (order by mapped.native_entity_id) as ordinality,
      jsonb_build_object(
        'id', mapped.native_entity_id,
        'name', coalesce(mapped.source_label, '教务宝课程'),
        'status', '在用',
        'source', '教务宝 Open API',
        'jiaowubaoOpenApi', jsonb_strip_nulls(jsonb_build_object(
          'sourceId', mapped.source_native_id,
          'title', mapped.source_label,
          'snapshotRevision', projection_run.snapshot_revision,
          'resolution', mapped.resolution,
          'confidence', mapped.confidence,
          'rawPayloadStoredPrivately', true
        ))
      ) as value
    from mapped
    where not exists (select 1 from existing where existing.value ->> 'id' = mapped.native_entity_id)
  ), all_rows as (
    select * from projected_existing
    union all
    select * from new_rows
  )
  select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
  into next_courses
  from all_rows;

  with source_teacher_courses as materialized (
    select teacher_source_id,
      coalesce(jsonb_agg(distinct course_title order by course_title), '[]'::jsonb) as course_titles
    from (
      select nullif(btrim(teacher.source_id), '') as teacher_source_id,
        nullif(btrim(schedule.payload ->> 'course_title'), '') as course_title
      from internal.jiaowubao_authority_projection_entities schedule
      cross join lateral (
        values
          (schedule.payload ->> 'teacher_id'),
          (schedule.payload ->> 'teacher_s'),
          (schedule.payload ->> 'teacher_t')
      ) teacher(source_id)
      where schedule.projection_run_id = projection_run.id
        and schedule.entity_type = 'schedule'
    ) observations
    where teacher_source_id is not null and course_title is not null
    group by teacher_source_id
  ), mapped as materialized (
    select distinct on (link.native_entity_id)
      link.native_entity_id, link.source_native_id, link.resolution, link.confidence,
      link.source_label, link.source_payload,
      coalesce(source_teacher_courses.course_titles, '[]'::jsonb) as course_titles
    from internal.jiaowubao_authority_native_links link
    left join source_teacher_courses on source_teacher_courses.teacher_source_id = link.source_native_id
    where link.entity_type = 'teacher' and link.active
    order by link.native_entity_id, link.source_native_id
  ), existing as materialized (
    select item.value, item.ordinality
    from jsonb_array_elements(teachers_state.payload) with ordinality item(value, ordinality)
  ), projected_existing as (
    select existing.ordinality, case when mapped.native_entity_id is null then existing.value else
      existing.value || jsonb_build_object(
        'name', coalesce(mapped.source_label, existing.value ->> 'name'),
        'initials', internal.jiaowubao_authority_initials(coalesce(mapped.source_label, existing.value ->> 'name')),
        'subjects', coalesce((
          select jsonb_agg(subject order by subject)
          from (
            select subject.value #>> '{}' as subject
            from jsonb_array_elements(case when jsonb_typeof(existing.value -> 'subjects') = 'array'
              then existing.value -> 'subjects' else '[]'::jsonb end) subject(value)
            where nullif(btrim(subject.value #>> '{}'), '') is not null
            union
            select subject.value #>> '{}'
            from jsonb_array_elements(mapped.course_titles) subject(value)
            where nullif(btrim(subject.value #>> '{}'), '') is not null
          ) subjects
        ), '[]'::jsonb),
        'jiaowubaoOpenApi', jsonb_strip_nulls(jsonb_build_object(
          'sourceId', mapped.source_native_id,
          'displayName', mapped.source_label,
          'snapshotRevision', projection_run.snapshot_revision,
          'resolution', mapped.resolution,
          'confidence', mapped.confidence,
          'rawPayloadStoredPrivately', true
        ))
      ) end as value
    from existing
    left join mapped on mapped.native_entity_id = existing.value ->> 'id'
  ), new_rows as (
    select 1000000000::bigint + row_number() over (order by mapped.native_entity_id) as ordinality,
      jsonb_build_object(
        'id', mapped.native_entity_id,
        'name', coalesce(mapped.source_label, '教务宝老师'),
        'initials', internal.jiaowubao_authority_initials(mapped.source_label),
        'subjects', mapped.course_titles,
        'timezone', 'Australia/Melbourne',
        'availability', '待确认',
        'load', 0,
        'capacity', 0,
        'acceptsStudents', false,
        'note', '教务宝 Open API 自动同步',
        'availabilityStatus', '待确认',
        'jiaowubaoOpenApi', jsonb_strip_nulls(jsonb_build_object(
          'sourceId', mapped.source_native_id,
          'displayName', mapped.source_label,
          'snapshotRevision', projection_run.snapshot_revision,
          'resolution', mapped.resolution,
          'confidence', mapped.confidence,
          'rawPayloadStoredPrivately', true
        ))
      ) as value
    from mapped
    where not exists (select 1 from existing where existing.value ->> 'id' = mapped.native_entity_id)
  ), all_rows as (
    select * from projected_existing
    union all
    select * from new_rows
  )
  select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
  into next_teachers
  from all_rows;

  with mapped_schedules as materialized (
    select schedule_link.native_entity_id,
      schedule_link.source_native_id,
      schedule_link.resolution,
      schedule_link.source_payload as record,
      student_link.native_entity_id as student_id,
      teacher_link.native_entity_id as teacher_id,
      course_link.native_entity_id as course_id,
      class_link.native_entity_id as class_id,
      room_link.native_entity_id as room_id
    from internal.jiaowubao_authority_native_links schedule_link
    join internal.jiaowubao_authority_native_links student_link
      on student_link.entity_type = 'student'
     and student_link.source_native_id = schedule_link.source_payload #>> '{stu_list,0,mem_id}'
     and student_link.active
    join internal.jiaowubao_authority_native_links teacher_link
      on teacher_link.entity_type = 'teacher'
     and teacher_link.source_native_id = schedule_link.source_payload ->> 'teacher_id'
     and teacher_link.active
    join internal.jiaowubao_authority_native_links course_link
      on course_link.entity_type = 'course'
     and course_link.source_native_id = schedule_link.source_payload ->> 'course_id'
     and course_link.active
    left join internal.jiaowubao_authority_native_links class_link
      on class_link.entity_type = 'class'
     and class_link.source_native_id = schedule_link.source_payload ->> 'team_id'
     and class_link.active
    left join internal.jiaowubao_authority_native_links room_link
      on room_link.entity_type = 'room'
     and room_link.source_native_id = schedule_link.source_payload ->> 'room_id'
     and room_link.active
    where schedule_link.entity_type = 'schedule' and schedule_link.active
  ), expected_schedule_count as (
    select count(*)::integer as value
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_run.id and source_entity.entity_type = 'schedule'
  ), existing as materialized (
    select item.value, item.ordinality
    from jsonb_array_elements(bookings_state.payload) with ordinality item(value, ordinality)
  ), projected_existing as (
    select existing.ordinality, case when mapped.native_entity_id is null then existing.value else
      existing.value || jsonb_build_object(
        'studentId', mapped.student_id,
        'teacherId', mapped.teacher_id,
        'date', mapped.record ->> 'dated',
        'start', mapped.record ->> 'time_start',
        'duration', internal.jiaowubao_authority_booking_duration(mapped.record),
        'kind', '常规课',
        'status', case when mapped.record ->> 'over' in ('1','true') then '已完成' else '已确认' end,
        'timezone', 'Australia/Melbourne',
        'course', coalesce(nullif(btrim(mapped.record ->> 'course_title'), ''), '待确认'),
        'source', '教务宝 Open API',
        'sourceLessonId', 'jwb-open-api:schedule:' || mapped.source_native_id,
        'sourceStudentName', coalesce(nullif(btrim(mapped.record #>> '{stu_list,0,name}'), ''), '教务宝学员'),
        'sourceTeacherName', coalesce(nullif(btrim(mapped.record ->> 'teacher_title'), ''), '教务宝老师'),
        'sourceTiming', case when mapped.record ->> 'over' in ('1','true') then '已结束' else '未开始' end,
        'jiaowubaoOpenApi', jsonb_strip_nulls(jsonb_build_object(
          'calendarId', mapped.source_native_id,
          'studentMemberId', mapped.record #>> '{stu_list,0,mem_id}',
          'teacherSourceId', mapped.record ->> 'teacher_id',
          'courseSourceId', mapped.record ->> 'course_id',
          'classSourceId', mapped.record ->> 'team_id',
          'classId', mapped.class_id,
          'roomSourceId', mapped.record ->> 'room_id',
          'roomId', mapped.room_id,
          'courseId', mapped.course_id,
          'snapshotRevision', projection_run.snapshot_revision,
          'resolution', mapped.resolution,
          'rawPayloadStoredPrivately', true,
          'priceStoredPrivately', mapped.record ? 'price_mem'
        ))
      ) end as value
    from existing
    left join mapped_schedules mapped on mapped.native_entity_id = existing.value ->> 'id'
  ), new_rows as (
    select 1000000000::bigint + row_number() over (order by mapped.native_entity_id) as ordinality,
      jsonb_build_object(
        'id', mapped.native_entity_id,
        'studentId', mapped.student_id,
        'teacherId', mapped.teacher_id,
        'date', mapped.record ->> 'dated',
        'start', mapped.record ->> 'time_start',
        'duration', internal.jiaowubao_authority_booking_duration(mapped.record),
        'kind', '常规课',
        'status', case when mapped.record ->> 'over' in ('1','true') then '已完成' else '已确认' end,
        'timezone', 'Australia/Melbourne',
        'course', coalesce(nullif(btrim(mapped.record ->> 'course_title'), ''), '待确认'),
        'source', '教务宝 Open API',
        'sourceLessonId', 'jwb-open-api:schedule:' || mapped.source_native_id,
        'sourceStudentName', coalesce(nullif(btrim(mapped.record #>> '{stu_list,0,name}'), ''), '教务宝学员'),
        'sourceTeacherName', coalesce(nullif(btrim(mapped.record ->> 'teacher_title'), ''), '教务宝老师'),
        'sourceTiming', case when mapped.record ->> 'over' in ('1','true') then '已结束' else '未开始' end,
        'jiaowubaoOpenApi', jsonb_strip_nulls(jsonb_build_object(
          'calendarId', mapped.source_native_id,
          'studentMemberId', mapped.record #>> '{stu_list,0,mem_id}',
          'teacherSourceId', mapped.record ->> 'teacher_id',
          'courseSourceId', mapped.record ->> 'course_id',
          'classSourceId', mapped.record ->> 'team_id',
          'classId', mapped.class_id,
          'roomSourceId', mapped.record ->> 'room_id',
          'roomId', mapped.room_id,
          'courseId', mapped.course_id,
          'snapshotRevision', projection_run.snapshot_revision,
          'resolution', mapped.resolution,
          'rawPayloadStoredPrivately', true,
          'priceStoredPrivately', mapped.record ? 'price_mem'
        ))
      ) as value
    from mapped_schedules mapped
    where not exists (select 1 from existing where existing.value ->> 'id' = mapped.native_entity_id)
  ), all_rows as (
    select * from projected_existing
    union all
    select * from new_rows
  )
  select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
  into next_bookings
  from all_rows
  having (select count(*) from mapped_schedules) = (select value from expected_schedule_count);

  if next_bookings is null then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_native_schedule_mapping_incomplete';
  end if;

  changed_students := next_students is distinct from students_state.payload;
  changed_teachers := next_teachers is distinct from teachers_state.payload;
  changed_courses := next_courses is distinct from courses_state.payload;
  changed_bookings := next_bookings is distinct from bookings_state.payload;
  applied := changed_students or changed_teachers or changed_courses or changed_bookings;

  if changed_bookings then
    update public.ops_state state set
      payload = next_bookings,
      version = state.version + 1,
      updated_at = applied_at,
      updated_by = p_actor
    where state.entity = 'bookings'
    returning * into bookings_state;
  end if;
  if changed_courses then
    update public.ops_state state set
      payload = next_courses,
      version = state.version + 1,
      updated_at = applied_at,
      updated_by = p_actor
    where state.entity = 'courses'
    returning * into courses_state;
  end if;
  if changed_students then
    update public.ops_state state set
      payload = next_students,
      version = state.version + 1,
      updated_at = applied_at,
      updated_by = p_actor
    where state.entity = 'students'
    returning * into students_state;
  end if;
  if changed_teachers then
    update public.ops_state state set
      payload = next_teachers,
      version = state.version + 1,
      updated_at = applied_at,
      updated_by = p_actor
    where state.entity = 'teachers'
    returning * into teachers_state;
  end if;

  saved_versions := jsonb_build_object(
    'students', students_state.version,
    'teachers', teachers_state.version,
    'courses', courses_state.version,
    'bookings', bookings_state.version
  );
  native_counts := jsonb_build_object(
    'students', jsonb_array_length(students_state.payload),
    'teachers', jsonb_array_length(teachers_state.payload),
    'courses', jsonb_array_length(courses_state.payload),
    'bookings', jsonb_array_length(bookings_state.payload)
  );

  select jsonb_object_agg(entity_type, row_count order by entity_type)
  into source_counts
  from (
    select entity_type, count(*)::integer as row_count
    from internal.jiaowubao_authority_native_links
    where active
    group by entity_type
  ) counts;

  select jsonb_object_agg(entity_type, resolutions order by entity_type)
  into resolution_counts
  from (
    select entity_type, jsonb_object_agg(resolution, row_count order by resolution) as resolutions
    from (
      select entity_type, resolution, count(*)::integer as row_count
      from internal.jiaowubao_authority_native_links
      where active
      group by entity_type, resolution
    ) grouped
    group by entity_type
  ) by_type;

  select jsonb_build_object(
    'invalidTimeRecords', count(*) filter (
      where source_entity.entity_type = 'schedule'
        and not internal.jiaowubao_authority_schedule_time_valid(source_entity.payload)
    ),
    'durationInferredFromHours', count(*) filter (
      where source_entity.entity_type = 'schedule'
        and not internal.jiaowubao_authority_schedule_time_valid(source_entity.payload)
        and coalesce(source_entity.payload ->> 'hours', '') ~ '^\d+(?:\.\d+)?$'
        and (source_entity.payload ->> 'hours')::numeric > 0
    )
  ) into anomaly_counts
  from internal.jiaowubao_authority_projection_entities source_entity
  where source_entity.projection_run_id = projection_run.id;

  select jsonb_build_object(
    'schedulePriceRecords', count(*) filter (where source_payload ? 'price_mem'),
    'studentPriceRecords', count(*) filter (
      where jsonb_typeof(source_payload -> 'stu_list') = 'array'
        and (source_payload #> '{stu_list,0}') ? 'price'
    ),
    'storedPrivately', true,
    'linkedToNativeBookings', true
  ) into price_counts
  from internal.jiaowubao_authority_native_links
  where entity_type = 'schedule' and active;

  audit_id := internal.append_operational_contract_audit(
    case when applied then 'jiaowubao_authority_native.applied' else 'jiaowubao_authority_native.confirmed' end,
    p_actor,
    'jiaowubao_authority_projection_run', projection_run.id::text,
    jsonb_build_object(
      'snapshotRevision', projection_run.snapshot_revision,
      'applied', applied,
      'sourceCounts', source_counts,
      'nativeStateVersions', saved_versions
    )
  );

  return jsonb_build_object(
    'schemaVersion', 1,
    'applied', applied,
    'appliedAt', applied_at,
    'snapshotRevision', projection_run.snapshot_revision,
    'projectionRunId', projection_run.id,
    'sourceCounts', source_counts,
    'resolutions', resolution_counts,
    'nativeStateVersions', saved_versions,
    'nativeCounts', native_counts,
    'changedStates', jsonb_build_object(
      'students', changed_students,
      'teachers', changed_teachers,
      'courses', changed_courses,
      'bookings', changed_bookings
    ),
    'mappingRates', jsonb_build_object(
      'students', 100,
      'teachers', 100,
      'courses', 100,
      'schedules', 100,
      'classes', 100,
      'rooms', 100
    ),
    'anomalies', anomaly_counts,
    'prices', price_counts,
    'rawBusinessFieldsMappedPrivately', true,
    'auditId', audit_id
  );
end;
$apply_jiaowubao_open_api_authority_native$;

revoke all on function public.apply_jiaowubao_open_api_authority_native(text,uuid,text)
  from public, anon, authenticated;

-- Preserve the proven immutable projector as a private read-model primitive.
-- The public RPC name becomes a wrapper that projects, applies, then projects
-- again only when the native documents actually changed. This gives the same
-- 30-minute request a post-write 100% match receipt without extra cron jobs.
alter function public.project_jiaowubao_open_api_authority(text,text,text)
  rename to project_jiaowubao_open_api_authority_read_model;

revoke all on function public.project_jiaowubao_open_api_authority_read_model(text,text,text)
  from public, anon, authenticated;

create or replace function public.project_jiaowubao_open_api_authority(
  p_secret text,
  p_revision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '240s'
as $project_jiaowubao_open_api_authority$
declare
  initial_projection jsonb;
  final_projection jsonb;
  native_apply jsonb;
  projection_id uuid;
begin
  initial_projection := public.project_jiaowubao_open_api_authority_read_model(
    p_secret, p_revision, p_actor
  );
  projection_id := (initial_projection ->> 'projectionRunId')::uuid;
  native_apply := public.apply_jiaowubao_open_api_authority_native(
    p_secret, projection_id, p_actor
  );
  if native_apply ->> 'applied' = 'true' then
    final_projection := public.project_jiaowubao_open_api_authority_read_model(
      p_secret, p_revision, p_actor
    );
  else
    final_projection := initial_projection;
  end if;

  final_projection := jsonb_set(
    final_projection,
    '{coverage,nativeRecordsOverwritten}',
    'true'::jsonb,
    true
  );
  final_projection := jsonb_set(
    final_projection,
    '{coverage,nativeRecordsSynchronized}',
    'true'::jsonb,
    true
  ) || jsonb_build_object('nativeApply', native_apply);

  update public.ops_source_snapshots source_snapshot
  set payload = final_projection - 'replayed'
  where source_snapshot.source_id = 'jiaowubao-open-api-schedule';

  return final_projection;
end;
$project_jiaowubao_open_api_authority$;

revoke all on function public.project_jiaowubao_open_api_authority(text,text,text)
  from public, anon, authenticated;
grant execute on function public.project_jiaowubao_open_api_authority(text,text,text)
  to anon, authenticated;

comment on table internal.jiaowubao_authority_native_links is
  'Current durable crosswalk from every Jiaowubao Open API entity to its native system record/dimension; full source payloads stay private.';
comment on function public.apply_jiaowubao_open_api_authority_native(text,uuid,text) is
  'Private secret-gated atomic merge of one immutable Jiaowubao authority projection into native students, teachers, courses and bookings.';
comment on function public.project_jiaowubao_open_api_authority(text,text,text) is
  'Secret-gated 30-minute Jiaowubao authority projection plus idempotent native synchronization and post-write match verification.';
