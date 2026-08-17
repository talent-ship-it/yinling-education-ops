-- Keep the v1 annotation contract unchanged, but make its candidate preview
-- linear in the source snapshots.  The original v1 query was correct, yet on
-- the production snapshot PostgreSQL chose nested loops between materialized
-- CTEs (eligible master x JWB, then x current students/owners), exhausting the
-- RPC's existing eight-second statement timeout.  This replacement retains
-- the same six-argument public contract and candidate JSON.  It normalizes a
-- display name once per source row, then looks up the already-proven-unique
-- sides through compact JSONB maps.

-- `student_import_name_key` deliberately normalizes an input display name.
-- The candidate planner needs both that key and the narrow annotation key for
-- the same source value, so use this only after the planner has materialized
-- `student_import_display_name` once. It is equivalent to the current strict
-- name-key contract in 170003, without repeating NFKC normalization.
create or replace function internal.student_import_annotation_name_key_from_display_name(
  p_display_name text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.translate(
    coalesce(p_display_name, ''),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz'
  )
$$;

revoke all on function internal.student_import_annotation_name_key_from_display_name(text)
  from public, anon, authenticated;

-- The v1 annotation helper first computes the normalized display name, then
-- re-normalizes the body after stripping its one trailing annotation. Once a
-- display name is already normalized, the only remaining body cleanup is the
-- same ASCII-space trim: the original display function has already applied
-- NFKC, removed invisibles and collapsed every whitespace run.
create or replace function internal.student_import_jwb_annotation_key_from_display(
  p_display_name text
)
returns text
language sql
immutable
set search_path = ''
as $$
  with parsed as (
    select coalesce(p_display_name, '') as value
  ), annotated as (
    select value,
      pg_catalog.regexp_replace(
        value, '^[^()]+\(([^()]*)\)$', '\1'
      ) as annotation
    from parsed
  )
  select case
    when value ~ '^[^()]+\([^()]+\)$'
      and internal.student_import_ascii_latin_letters(annotation)
    then internal.student_import_annotation_name_key_from_display_name(
      pg_catalog.btrim(pg_catalog.regexp_replace(value, '\([^()]+\)$', ''))
    )
    else ''::text
  end
  from annotated
$$;

revoke all on function internal.student_import_jwb_annotation_key_from_display(text)
  from public, anon, authenticated;

create or replace function internal.student_import_identity_annotation_candidates(
  p_master_source_id text,
  p_master_rows jsonb,
  p_resolved_master_rows jsonb,
  p_jwb_rows jsonb,
  p_students jsonb,
  p_active_links jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  candidates jsonb;
begin
  if nullif(trim(p_master_source_id), '') is null
     or length(p_master_source_id) > 160
     or jsonb_typeof(p_master_rows) <> 'array'
     or jsonb_typeof(p_resolved_master_rows) <> 'array'
     or jsonb_typeof(p_jwb_rows) <> 'array'
     or jsonb_typeof(p_students) <> 'array'
     or jsonb_typeof(p_active_links) <> 'array'
     or jsonb_array_length(p_master_rows) > 10000
     or jsonb_array_length(p_resolved_master_rows) > 10000
     or jsonb_array_length(p_jwb_rows) > 10000
     or jsonb_array_length(p_students) > 10000
     or jsonb_array_length(p_active_links) > 10000 then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_annotation_candidate_input';
  end if;

  -- Validate each JSON array once.  In particular, test resolved⊆raw through
  -- a keyed membership map rather than a correlated raw-source scan.
  if exists (
    with master_input as materialized (
      select jsonb_typeof(item.value) as value_type,
        internal.student_import_source_key(item.value -> 'sourceRow') as source_key
      from jsonb_array_elements(p_master_rows) item(value)
    ), resolved_input as materialized (
      select jsonb_typeof(item.value) as value_type,
        internal.student_import_source_key(item.value -> 'sourceRow') as source_key
      from jsonb_array_elements(p_resolved_master_rows) item(value)
    ), jwb_input as materialized (
      select jsonb_typeof(item.value) as value_type,
        internal.student_import_source_key(item.value -> 'sourceRow') as source_key
      from jsonb_array_elements(p_jwb_rows) item(value)
    ), student_input as materialized (
      select jsonb_typeof(item.value) as value_type,
        jsonb_typeof(item.value -> 'id') as id_type,
        item.value ->> 'id' as student_id
      from jsonb_array_elements(p_students) item(value)
    ), master_key_counts as materialized (
      select source_key, count(*) as row_count
      from master_input
      group by source_key
    ), resolved_key_counts as materialized (
      select source_key, count(*) as row_count
      from resolved_input
      group by source_key
    ), jwb_key_counts as materialized (
      select source_key, count(*) as row_count
      from jwb_input
      group by source_key
    ), student_id_counts as materialized (
      select student_id, count(*) as row_count
      from student_input
      group by student_id
    ), master_key_lookup as materialized (
      select coalesce(
        jsonb_object_agg(source_key, true) filter (where source_key is not null),
        '{}'::jsonb
      ) as keys_by_source
      from master_input
    ), invalid_rows as (
      select 1
      from master_input
      where value_type <> 'object' or source_key is null
      union all
      select 1
      from master_key_counts
      where row_count > 1
      union all
      select 1
      from resolved_input
      cross join master_key_lookup raw_keys
      where value_type <> 'object'
        or source_key is null
        or not (raw_keys.keys_by_source ? source_key)
      union all
      select 1
      from resolved_key_counts
      where row_count > 1
      union all
      select 1
      from jwb_input
      where value_type <> 'object' or source_key is null
      union all
      select 1
      from jwb_key_counts
      where row_count > 1
      union all
      select 1
      from student_input
      where value_type <> 'object'
        or id_type <> 'string'
        or nullif(trim(student_id), '') is null
        or student_id <> trim(student_id)
        or length(student_id) > 240
      union all
      select 1
      from student_id_counts
      where row_count > 1
    )
    select 1 from invalid_rows
  ) then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_annotation_candidate_rows';
  end if;

  with master_display as materialized (
    select item.value -> 'sourceRow' as source_row,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_display_name(item.value ->> 'name') as display_name
    from jsonb_array_elements(p_master_rows) item(value)
  ), master_name_basis as materialized (
    select master_display.*,
      internal.student_import_annotation_name_key_from_display_name(display_name) as name_key,
      internal.student_import_jwb_annotation_key_from_display(
        display_name
      ) as annotation_key
    from master_display
  ), master_raw as materialized (
    select source_row, source_key, name_key, display_name,
      coalesce(nullif(annotation_key, ''), name_key) as collision_key
    from master_name_basis
  ), master_collision_basis as materialized (
    select master_raw.*,
      count(*) over (partition by collision_key) as collision_key_count
    from master_raw
  ), master_basis as materialized (
    select master_collision_basis.*,
      count(*) over (partition by name_key) as name_key_count
    from master_collision_basis
    where position('(' in display_name) = 0
      and position(')' in display_name) = 0
  ), resolved_master_raw as materialized (
    select internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      trim(coalesce(item.value ->> 'status', '')) as status
    from jsonb_array_elements(p_resolved_master_rows) item(value)
  ), resolved_status_lookup as materialized (
    select coalesce(jsonb_object_agg(source_key, status), '{}'::jsonb) as status_by_source
    from resolved_master_raw
  ), resolved_active_master as materialized (
    select master_raw.source_key,
      internal.student_import_student_id(
        p_master_source_id, master_raw.source_row
      ) as derived_student_id
    from master_raw
    cross join resolved_status_lookup resolved
    where resolved.status_by_source ? master_raw.source_key
      and resolved.status_by_source ->> master_raw.source_key in (
        '在读', '活跃 + 无课时', '活跃 + 有课时',
        '不活跃 + 有课时', '在读 + 加课待排'
      )
  ), owner_by_id as materialized (
    select derived_student_id,
      jsonb_build_object(
        'count', count(*),
        'sourceKey', min(source_key)
      ) as owner_value
    from resolved_active_master
    group by derived_student_id
  ), active_master_owner_lookup as materialized (
    select coalesce(jsonb_object_agg(
      active_master.source_key,
      jsonb_build_object(
        'derivedStudentId', active_master.derived_student_id,
        'ownerCount', owner.owner_value ->> 'count'
      )
    ), '{}'::jsonb) as owner_by_source
    from resolved_active_master active_master
    join owner_by_id owner using (derived_student_id)
  ), owner_lookup as materialized (
    select coalesce(jsonb_object_agg(derived_student_id, owner_value), '{}'::jsonb)
      as owner_by_derived_id
    from owner_by_id
  ), candidate_master as materialized (
    select master_basis.*,
      active_owner.owner_by_source -> master_basis.source_key ->> 'derivedStudentId'
        as derived_student_id,
      (active_owner.owner_by_source -> master_basis.source_key ->> 'ownerCount')::integer
        as derived_owner_count
    from master_basis
    cross join active_master_owner_lookup active_owner
    where active_owner.owner_by_source ? master_basis.source_key
  ), eligible_master as materialized (
    select * from candidate_master
    where name_key <> ''
      and name_key_count = 1
      and collision_key_count = 1
      and derived_owner_count = 1
  ), jwb_display as materialized (
    select item.value -> 'sourceRow' as source_row,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_display_name(item.value ->> 'name') as display_name
    from jsonb_array_elements(p_jwb_rows) item(value)
  ), jwb_name_basis as materialized (
    select jwb_display.*,
      internal.student_import_annotation_name_key_from_display_name(display_name) as name_key,
      internal.student_import_jwb_annotation_key_from_display(
        display_name
      ) as annotation_key
    from jwb_display
  ), jwb_raw as materialized (
    select source_row, source_key, annotation_key,
      coalesce(nullif(annotation_key, ''), name_key) as collision_key
    from jwb_name_basis
  ), jwb_basis as materialized (
    select jwb_raw.*,
      count(*) over (partition by collision_key) as collision_key_count
    from jwb_raw
  ), eligible_jwb as materialized (
    select * from jwb_basis
    where annotation_key <> '' and collision_key_count = 1
  ), jwb_lookup as materialized (
    select coalesce(jsonb_object_agg(
      annotation_key,
      jsonb_build_object('sourceRow', source_row, 'sourceKey', source_key)
    ), '{}'::jsonb) as row_by_annotation_key
    from eligible_jwb
  ), student_display as materialized (
    select item.value ->> 'id' as student_id,
      internal.student_import_display_name(item.value ->> 'name') as display_name
    from jsonb_array_elements(p_students) item(value)
  ), student_name_basis as materialized (
    select student_display.*,
      internal.student_import_annotation_name_key_from_display_name(display_name) as name_key,
      internal.student_import_jwb_annotation_key_from_display(
        display_name
      ) as annotation_key
    from student_display
  ), student_raw as materialized (
    select student_id, name_key,
      coalesce(nullif(annotation_key, ''), name_key) as collision_key
    from student_name_basis
  ), student_basis as materialized (
    select student_raw.*,
      count(*) over (partition by name_key) as name_key_count
    from student_raw
  ), unique_student as materialized (
    select * from student_basis
    where name_key <> '' and name_key_count = 1
  ), student_name_lookup as materialized (
    select coalesce(jsonb_object_agg(name_key, student_id), '{}'::jsonb)
      as id_by_name_key
    from unique_student
  ), student_id_lookup as materialized (
    select coalesce(jsonb_object_agg(student_id, true), '{}'::jsonb) as known_ids
    from student_raw
  ), student_collision_ids as materialized (
    select collision_key,
      jsonb_object_agg(student_id, true) as ids_by_collision_key
    from student_raw
    group by collision_key
  ), student_collision_lookup as materialized (
    select coalesce(
      jsonb_object_agg(collision_key, ids_by_collision_key),
      '{}'::jsonb
    ) as ids_by_relaxed_key
    from student_collision_ids
  ), active_link_basis as materialized (
    select internal.student_import_source_key(link.value -> 'masterSourceRow') as master_key,
      case when link.value ? 'jwbSourceRow'
        then internal.student_import_source_key(link.value -> 'jwbSourceRow')
        else null end as jwb_key,
      trim(link.value ->> 'studentId') as student_id
    from jsonb_array_elements(p_active_links) link(value)
  ), active_link_lookup as materialized (
    select coalesce(
      jsonb_object_agg(master_key, true) filter (where master_key is not null),
      '{}'::jsonb
    ) as active_master_keys,
    coalesce(
      jsonb_object_agg(jwb_key, true) filter (where jwb_key is not null),
      '{}'::jsonb
    ) as active_jwb_keys,
    coalesce(
      jsonb_object_agg(student_id, true) filter (where student_id is not null),
      '{}'::jsonb
    ) as active_student_ids
    from active_link_basis
  ), paired as materialized (
    select master.source_row as master_source_row,
      master.source_key as master_source_key,
      master.name_key,
      master.derived_student_id,
      jwb.row_by_annotation_key -> master.name_key -> 'sourceRow' as jwb_source_row,
      jwb.row_by_annotation_key -> master.name_key ->> 'sourceKey' as jwb_source_key,
      case when existing.id_by_name_key ? master.name_key
        then existing.id_by_name_key ->> master.name_key else null end as existing_student_id
    from eligible_master master
    cross join jwb_lookup jwb
    cross join student_name_lookup existing
    where jwb.row_by_annotation_key ? master.name_key
  ), selected as materialized (
    select paired.*,
      coalesce(paired.existing_student_id, paired.derived_student_id) as target_student_id
    from paired
    cross join student_id_lookup current_students
    where paired.existing_student_id is not null
      or not (current_students.known_ids ? paired.derived_student_id)
  ), safe as materialized (
    select selected.*
    from selected
    cross join owner_lookup owners
    cross join student_collision_lookup current_collisions
    cross join active_link_lookup active_links
    cross join lateral (
      select owners.owner_by_derived_id -> selected.target_student_id as owner_value
    ) target_owner
    where (
      target_owner.owner_value is null
      or (
        (target_owner.owner_value ->> 'count')::integer = 1
        and target_owner.owner_value ->> 'sourceKey' = selected.master_source_key
      )
    )
    -- A current literal annotation name (or a second current body name) is a
    -- source-wide identity collision. The selected target itself is allowed;
    -- no other current record may share this relaxed body.
    and coalesce(
      (current_collisions.ids_by_relaxed_key -> selected.name_key)
        - selected.target_student_id,
      '{}'::jsonb
    ) = '{}'::jsonb
    and not (active_links.active_master_keys ? selected.master_source_key)
    and not (active_links.active_jwb_keys ? selected.jwb_source_key)
    and not (active_links.active_student_ids ? selected.target_student_id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'masterSourceRow', safe.master_source_row,
    'jwbSourceRow', safe.jwb_source_row,
    'studentId', safe.target_student_id,
    'matchStrategy', 'jwb_latin_parenthetical_annotation_v1'
  ) order by
    internal.student_import_utf16_sort_key(safe.master_source_key),
    internal.student_import_utf16_sort_key(safe.jwb_source_key),
    internal.student_import_utf16_sort_key(safe.target_student_id)
  ), '[]'::jsonb)
  into candidates
  from safe;

  if jsonb_array_length(candidates) <>
       (select count(distinct internal.student_import_source_key(
          item.value -> 'masterSourceRow'
        )) from jsonb_array_elements(candidates) item(value))
     or jsonb_array_length(candidates) <>
       (select count(distinct internal.student_import_source_key(
          item.value -> 'jwbSourceRow'
        )) from jsonb_array_elements(candidates) item(value))
     or jsonb_array_length(candidates) <>
       (select count(distinct trim(item.value ->> 'studentId')
        ) from jsonb_array_elements(candidates) item(value)) then
    raise exception using errcode = '23505',
      message = 'student_import_identity_annotation_review_candidate_conflict';
  end if;

  return candidates;
end;
$$;

revoke all on function internal.student_import_identity_annotation_candidates(
  text, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;

-- Exercise the replacement itself, not only the v1 fixtures which have
-- already run in 170005. These inputs contain no production data and cover
-- the source-wide shadow and ownership guards that the keyed lookups retain.
do $annotation_candidate_optimizer_fixture$
declare
  happy jsonb;
  owner_collision_students jsonb;
begin
  happy := internal.student_import_identity_annotation_candidates(
    'annotation-v2-fixture',
    '[{"sourceRow":"M-happy","name":"Learner","status":"在读"}]'::jsonb,
    '[{"sourceRow":"M-happy","name":"Learner","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-happy","name":"Learner （ＶＩＣ）"}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb
  );
  if jsonb_array_length(happy) <> 1
     or happy #>> '{0,masterSourceRow}' <> 'M-happy'
     or happy #>> '{0,jwbSourceRow}' <> 'J-happy'
     or happy #>> '{0,matchStrategy}' <>
       'jwb_latin_parenthetical_annotation_v1' then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_candidate_optimizer_fixture_mismatch';
  end if;

  owner_collision_students := jsonb_build_array(jsonb_build_object(
    'id', internal.student_import_student_id(
      'annotation-v2-fixture', '"M-owner"'::jsonb
    ),
    'name', 'Learner'
  ));

  if jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-v2-fixture',
      '[{"sourceRow":"M-duplicate-a","name":"Learner","status":"在读"},{"sourceRow":"M-duplicate-b","name":"Learner","status":"不活跃 + 无课时"}]'::jsonb,
      '[{"sourceRow":"M-duplicate-a","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-duplicate","name":"Learner(VIC)"}]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb
    )) <> 0
    -- A literal parenthesized raw master row reserves the strict display key.
    or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-v2-fixture',
      '[{"sourceRow":"M-shadow","name":"Learner","status":"在读"},{"sourceRow":"M-shadow-annotation","name":"Learner(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-shadow","name":"Learner","status":"在读"},{"sourceRow":"M-shadow-annotation","name":"Learner(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-shadow","name":"Learner(VIC)"}]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb
    )) <> 0
    -- A current literal annotation is likewise a distinct strict owner.
    or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-v2-fixture',
      '[{"sourceRow":"M-current","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-current","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-current","name":"Learner(VIC)"}]'::jsonb,
      '[{"id":"existing-annotation","name":"Learner(VIC)"}]'::jsonb,
      '[]'::jsonb
    )) <> 0
    -- A different active raw master keeps ownership of its derived ID.
    or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-v2-fixture',
      '[{"sourceRow":"M-owner-target","name":"Learner","status":"在读"},{"sourceRow":"M-owner","name":"Other(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-owner-target","name":"Learner","status":"在读"},{"sourceRow":"M-owner","name":"Other(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-owner","name":"Learner(VIC)"}]'::jsonb,
      owner_collision_students,
      '[]'::jsonb
    )) <> 0
    -- Active links consume their master row, JWB row, and target identity.
    or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-v2-fixture',
      '[{"sourceRow":"M-link-master","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-link-master","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-link-master","name":"Learner(VIC)"}]'::jsonb,
      '[]'::jsonb,
      '[{"masterSourceRow":"M-link-master","studentId":"other"}]'::jsonb
    )) <> 0
    or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-v2-fixture',
      '[{"sourceRow":"M-link-jwb","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-link-jwb","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-link-jwb","name":"Learner(VIC)"}]'::jsonb,
      '[]'::jsonb,
      '[{"masterSourceRow":"other","jwbSourceRow":"J-link-jwb","studentId":"other"}]'::jsonb
    )) <> 0
    or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-v2-fixture',
      '[{"sourceRow":"M-link-target","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-link-target","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-link-target","name":"Learner(VIC)"}]'::jsonb,
      '[{"id":"existing-target","name":"Learner"}]'::jsonb,
      '[{"masterSourceRow":"other","studentId":"existing-target"}]'::jsonb
    )) <> 0 then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_candidate_optimizer_fixture_mismatch';
  end if;
end;
$annotation_candidate_optimizer_fixture$;
