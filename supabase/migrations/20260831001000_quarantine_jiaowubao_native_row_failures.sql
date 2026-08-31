-- A malformed Jiaowubao row must not roll back an otherwise valid authority
-- refresh. Keep every rejected source payload private, record one stable
-- reason, and continue the native merge with the eligible rows.

set local lock_timeout = '2s';

create table if not exists internal.jiaowubao_authority_native_quarantine (
  source_revision text not null check (source_revision ~ '^sha256:[a-f0-9]{64}$'),
  projection_run_id uuid not null references internal.jiaowubao_authority_projection_runs(id) on delete restrict,
  entity_type text not null check (entity_type in ('schedule','student','teacher','course','class','room')),
  source_key text not null check (source_key ~ '^sha256:[a-f0-9]{64}$'),
  source_native_id text check (source_native_id is null or char_length(source_native_id) between 1 and 8192),
  reason text not null check (reason in (
    'missing_source_id','invalid_source_id','invalid_payload','invalid_date',
    'invalid_start_time','invalid_student_list','participant_count_not_one',
    'missing_student_id','missing_teacher_id','missing_course_id',
    'duplicate_source_id','native_relationship_missing'
  )),
  source_label text check (source_label is null or char_length(source_label) between 1 and 2000),
  source_payload jsonb not null check (
    jsonb_typeof(source_payload) = 'object'
    and octet_length(source_payload::text) between 2 and 262144
  ),
  active boolean not null default true,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  primary key (source_revision, entity_type, source_key)
);

create index if not exists jiaowubao_authority_native_quarantine_active_idx
  on internal.jiaowubao_authority_native_quarantine (entity_type, reason)
  where active;

alter table internal.jiaowubao_authority_native_quarantine enable row level security;
revoke all on table internal.jiaowubao_authority_native_quarantine
  from public, anon, authenticated, service_role;

create or replace function internal.jiaowubao_authority_native_schedule_skip_reason(
  p_projection_run_id uuid,
  p_source_key text,
  p_source_native_id text,
  p_record jsonb
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $jiaowubao_authority_native_schedule_skip_reason$
declare
  date_text text;
  parsed_date date;
  start_text text;
begin
  if p_source_native_id is null or nullif(btrim(p_source_native_id), '') is null then
    return 'missing_source_id';
  end if;
  if p_source_native_id <> btrim(p_source_native_id) then
    return 'invalid_source_id';
  end if;
  if jsonb_typeof(p_record) is distinct from 'object' then
    return 'invalid_payload';
  end if;

  date_text := nullif(btrim(p_record ->> 'dated'), '');
  if date_text is null or date_text !~ '^\d{4}-\d{2}-\d{2}$' then
    return 'invalid_date';
  end if;
  begin
    parsed_date := date_text::date;
  exception when others then
    return 'invalid_date';
  end;
  if pg_catalog.to_char(parsed_date, 'YYYY-MM-DD') <> date_text then
    return 'invalid_date';
  end if;

  start_text := nullif(btrim(p_record ->> 'time_start'), '');
  if start_text is null or start_text !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    return 'invalid_start_time';
  end if;
  if jsonb_typeof(p_record -> 'stu_list') is distinct from 'array' then
    return 'invalid_student_list';
  end if;
  if jsonb_array_length(p_record -> 'stu_list') <> 1 then
    return 'participant_count_not_one';
  end if;
  if nullif(btrim(p_record #>> '{stu_list,0,mem_id}'), '') is null then
    return 'missing_student_id';
  end if;
  if nullif(btrim(p_record ->> 'teacher_id'), '') is null then
    return 'missing_teacher_id';
  end if;
  if nullif(btrim(p_record ->> 'course_id'), '') is null then
    return 'missing_course_id';
  end if;
  if exists (
    select 1
    from internal.jiaowubao_authority_projection_entities peer
    where peer.projection_run_id = p_projection_run_id
      and peer.entity_type = 'schedule'
      and peer.source_native_id = p_source_native_id
      and peer.source_key <> p_source_key
  ) then
    return 'duplicate_source_id';
  end if;
  return null;
end;
$jiaowubao_authority_native_schedule_skip_reason$;

revoke all on function internal.jiaowubao_authority_native_schedule_skip_reason(uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;

-- Patch the deployed native merge instead of copying its large reviewed body.
-- Every anchor is exact and unique; any definition drift aborts this migration.
do $patch_jiaowubao_native_row_quarantine$
declare
  target_oid regprocedure := to_regprocedure(
    'public.apply_jiaowubao_open_api_authority_native(text,uuid,text)'
  );
  source_definition text;
  patched_definition text;
  fail_fast_anchor text := $fail_fast_anchor$
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
$fail_fast_anchor$;
  quarantine_block text := $quarantine_block$
  -- Quarantine only the source entities that cannot be written. Prior active
  -- failures remain as history but are no longer counted as current.
  update internal.jiaowubao_authority_native_quarantine
  set active = false
  where active;

  with candidates as materialized (
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
  )
  insert into internal.jiaowubao_authority_native_quarantine(
    source_revision, projection_run_id, entity_type, source_key,
    source_native_id, reason, source_label, source_payload,
    active, first_seen_at, last_seen_at
  )
  select projection_run.snapshot_revision, projection_run.id,
    candidate.entity_type, candidate.source_key, candidate.source_native_id,
    candidate.skip_reason, candidate.identity_label, candidate.payload,
    true, applied_at, applied_at
  from candidates candidate
  where candidate.skip_reason is not null
  on conflict (source_revision, entity_type, source_key) do update set
    projection_run_id = excluded.projection_run_id,
    source_native_id = excluded.source_native_id,
    reason = excluded.reason,
    source_label = excluded.source_label,
    source_payload = excluded.source_payload,
    active = true,
    last_seen_at = excluded.last_seen_at;
$quarantine_block$;
  schedule_source_anchor text := $schedule_source_anchor$      and source_entity.entity_type = 'schedule'
      and source_entity.source_native_id is not null
  ), candidates as materialized ($schedule_source_anchor$;
  schedule_source_replacement text := $schedule_source_replacement$      and source_entity.entity_type = 'schedule'
      and source_entity.source_native_id is not null
      and internal.jiaowubao_authority_native_schedule_skip_reason(
        projection_run.id,
        source_entity.source_key,
        source_entity.source_native_id,
        source_entity.payload
      ) is null
  ), candidates as materialized ($schedule_source_replacement$;
  expected_count_anchor text := $expected_count_anchor$  ), expected_schedule_count as (
    select count(*)::integer as value
    from internal.jiaowubao_authority_projection_entities source_entity
    where source_entity.projection_run_id = projection_run.id and source_entity.entity_type = 'schedule'
  ), existing as materialized ($expected_count_anchor$;
  expected_count_replacement text := $expected_count_replacement$  ), existing as materialized ($expected_count_replacement$;
  aggregate_anchor text := $aggregate_anchor$  from all_rows
  having (select count(*) from mapped_schedules) = (select value from expected_schedule_count);$aggregate_anchor$;
  aggregate_replacement text := $aggregate_replacement$  from all_rows;$aggregate_replacement$;
  incomplete_anchor text := $incomplete_anchor$
  if next_bookings is null then
    raise exception using errcode = '55000', message = 'jiaowubao_authority_native_schedule_mapping_incomplete';
  end if;
$incomplete_anchor$;
begin
  if target_oid is null then
    raise exception using errcode = '55000', message = 'jiaowubao_native_row_quarantine_target_missing';
  end if;

  select pg_catalog.pg_get_functiondef(target_oid) into source_definition;
  if source_definition is null
     or position(fail_fast_anchor in source_definition) = 0
     or position(schedule_source_anchor in source_definition) = 0
     or position(expected_count_anchor in source_definition) = 0
     or position(aggregate_anchor in source_definition) = 0
     or position(incomplete_anchor in source_definition) = 0
     or position(fail_fast_anchor in substr(source_definition,
       position(fail_fast_anchor in source_definition) + char_length(fail_fast_anchor))) <> 0
     or position(schedule_source_anchor in substr(source_definition,
       position(schedule_source_anchor in source_definition) + char_length(schedule_source_anchor))) <> 0
     or position(expected_count_anchor in substr(source_definition,
       position(expected_count_anchor in source_definition) + char_length(expected_count_anchor))) <> 0
     or position(aggregate_anchor in substr(source_definition,
       position(aggregate_anchor in source_definition) + char_length(aggregate_anchor))) <> 0
     or position(incomplete_anchor in substr(source_definition,
       position(incomplete_anchor in source_definition) + char_length(incomplete_anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_native_row_quarantine_anchor_mismatch';
  end if;

  patched_definition := replace(source_definition, fail_fast_anchor, quarantine_block);
  patched_definition := replace(patched_definition, schedule_source_anchor, schedule_source_replacement);
  patched_definition := replace(patched_definition, expected_count_anchor, expected_count_replacement);
  patched_definition := replace(patched_definition, aggregate_anchor, aggregate_replacement);
  patched_definition := replace(patched_definition, incomplete_anchor, '');
  if patched_definition = source_definition
     or position('jiaowubao_authority_native_schedule_shape_invalid' in patched_definition) <> 0
     or position('jiaowubao_authority_native_schedule_mapping_incomplete' in patched_definition) <> 0
     or position('internal.jiaowubao_authority_native_schedule_skip_reason' in patched_definition) = 0
     or position('insert into internal.jiaowubao_authority_native_quarantine' in patched_definition) = 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_native_row_quarantine_patch_failed';
  end if;
  execute patched_definition;

  select pg_catalog.pg_get_functiondef(target_oid) into patched_definition;
  if position('jiaowubao_authority_native_schedule_shape_invalid' in patched_definition) <> 0
     or position('jiaowubao_authority_native_schedule_mapping_incomplete' in patched_definition) <> 0
     or position('internal.jiaowubao_authority_native_schedule_skip_reason' in patched_definition) = 0
     or position('insert into internal.jiaowubao_authority_native_quarantine' in patched_definition) = 0
     or position('expected_schedule_count' in patched_definition) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_native_row_quarantine_postcheck_failed';
  end if;
end;
$patch_jiaowubao_native_row_quarantine$;

revoke all on function public.apply_jiaowubao_open_api_authority_native(text,uuid,text)
  from public, anon, authenticated, service_role;

-- The public receipt distinguishes successfully written rows from skipped
-- rows. A batch with a skip can never claim a false 100% match rate.
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
  native_matches jsonb;
  native_mapping_rates jsonb;
  native_skips jsonb;
  native_matched_count integer;
  native_skipped_count integer;
  skipped_price_count integer;
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

  with entity_types(entity_type) as (
    values ('schedule'::text), ('student'::text), ('teacher'::text),
      ('course'::text), ('class'::text), ('room'::text)
  ), linked as (
    select entity_type.entity_type, count(link.source_native_id)::integer as matched
    from entity_types entity_type
    left join internal.jiaowubao_authority_native_links link
      on link.entity_type = entity_type.entity_type and link.active
    group by entity_type.entity_type
  ), skipped as (
    select entity_type.entity_type, count(quarantine.source_key)::integer as skipped
    from entity_types entity_type
    left join internal.jiaowubao_authority_native_quarantine quarantine
      on quarantine.entity_type = entity_type.entity_type and quarantine.active
    group by entity_type.entity_type
  ), counts as (
    select linked.entity_type, linked.matched, skipped.skipped,
      linked.matched + skipped.skipped as total
    from linked join skipped using (entity_type)
  )
  select jsonb_object_agg(entity_type, jsonb_build_object(
      'total', total,
      'matched', matched,
      'unmatched', skipped,
      'conflict', 0,
      'sourceOnly', skipped,
      'matchRate', case when total = 0 then 0
        else round(matched::numeric * 100 / total, 2) end,
      'basis', 'durable_source_id_crosswalk_with_quarantine'
    ) order by entity_type),
    sum(matched)::integer,
    sum(skipped)::integer
  into native_matches, native_matched_count, native_skipped_count
  from counts;

  select coalesce(jsonb_object_agg(entity_type, reasons order by entity_type), '{}'::jsonb)
  into native_skips
  from (
    select entity_type,
      jsonb_object_agg(reason, row_count order by reason) as reasons
    from (
      select entity_type, reason, count(*)::integer as row_count
      from internal.jiaowubao_authority_native_quarantine
      where active
      group by entity_type, reason
    ) grouped
    group by entity_type
  ) by_type;

  select count(*)::integer
  into skipped_price_count
  from internal.jiaowubao_authority_native_quarantine quarantine
  where quarantine.active
    and quarantine.entity_type = 'schedule'
    and (
      quarantine.source_payload ? 'price_mem'
      or (
        jsonb_typeof(quarantine.source_payload -> 'stu_list') = 'array'
        and jsonb_array_length(quarantine.source_payload -> 'stu_list') > 0
        and (quarantine.source_payload #> '{stu_list,0}') ? 'price'
      )
    );

  native_mapping_rates := jsonb_build_object(
    'students', native_matches #> '{student,matchRate}',
    'teachers', native_matches #> '{teacher,matchRate}',
    'courses', native_matches #> '{course,matchRate}',
    'schedules', native_matches #> '{schedule,matchRate}',
    'classes', native_matches #> '{class,matchRate}',
    'rooms', native_matches #> '{room,matchRate}'
  );
  native_apply := jsonb_set(native_apply, '{mappingRates}', native_mapping_rates, true);
  native_apply := jsonb_set(
    native_apply,
    '{prices,skippedPriceRecords}',
    to_jsonb(skipped_price_count),
    true
  );
  native_apply := native_apply || jsonb_build_object(
    'rowFailurePolicy', 'skip_and_record',
    'skippedRows', native_skipped_count,
    'skipped', native_skips,
    'batchContinuedAfterSkips', native_skipped_count > 0,
    'quarantinedSourcePayloadsStoredPrivately', true
  );

  final_projection := jsonb_set(final_projection, '{matches}', native_matches, true);
  final_projection := jsonb_set(
    final_projection,
    '{coverage,matchedEntityRows}',
    to_jsonb(native_matched_count),
    true
  );
  final_projection := jsonb_set(
    final_projection,
    '{coverage,sourceOnlyEntityRows}',
    to_jsonb(native_skipped_count),
    true
  );
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
  );
  final_projection := jsonb_set(
    final_projection,
    '{coverage,nativeMatchBasis}',
    '"durable_source_id_crosswalk_with_quarantine"'::jsonb,
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

comment on table internal.jiaowubao_authority_native_quarantine is
  'Private history of individual Jiaowubao authority entities skipped during native synchronization, including exact reason and source payload.';
comment on function internal.jiaowubao_authority_native_schedule_skip_reason(uuid,text,text,jsonb) is
  'Returns one deterministic row-level rejection reason, or null when a Jiaowubao schedule can be written natively.';
comment on function public.apply_jiaowubao_open_api_authority_native(text,uuid,text) is
  'Secret-gated native authority merge that quarantines malformed individual source entities and continues with every eligible row.';
comment on function public.project_jiaowubao_open_api_authority(text,text,text) is
  'Secret-gated 30-minute Jiaowubao synchronization with native matches and explicit row-level skip counts/reasons.';
