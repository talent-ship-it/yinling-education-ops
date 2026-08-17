-- A reviewed exception to strict student/JWB full-name equality. This does
-- not restore fuzzy matching: it accepts only a JWB display name with one
-- trailing, ASCII-letter-only parenthetical annotation, e.g. `张三（VIC）`.
-- The master name may contain no parentheses; removal must leave the exact
-- full master name and that relaxed body must be one-to-one across both full
-- source snapshots. The durable link states the exception strategy itself.

-- PostgreSQL bracket ranges can be collation-sensitive. First establish that
-- every character is a one-byte UTF-8 ASCII code point, then evaluate the
-- letter range under C collation. This stays byte-for-byte equivalent to the
-- TypeScript `/^[A-Za-z]+$/` predicate regardless of database ICU/locale.
create or replace function internal.student_import_ascii_latin_letters(
  p_value text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    char_length(p_value) > 0
    and char_length(p_value) = octet_length(p_value)
    and (p_value collate "C") ~ '^[A-Za-z]+$',
    false
  )
$$;

revoke all on function internal.student_import_ascii_latin_letters(text)
  from public, anon, authenticated;

create or replace function internal.student_import_jwb_latin_parenthetical_annotation_key(
  p_name text
)
returns text
language sql
immutable
set search_path = ''
as $$
  with display as (
    select internal.student_import_display_name(p_name) as value
  ), parsed as (
    select value,
      pg_catalog.regexp_replace(
        value, '^[^()]+\(([^()]*)\)$', '\1'
      ) as annotation
    from display
  )
  select case
    when value ~ '^[^()]+\([^()]+\)$'
      and internal.student_import_ascii_latin_letters(annotation)
    then internal.student_import_name_key(
      pg_catalog.regexp_replace(value, '\([^()]+\)$', '')
    )
    else ''::text
  end
  from parsed
$$;

revoke all on function internal.student_import_jwb_latin_parenthetical_annotation_key(text)
  from public, anon, authenticated;

-- Every JWB row participates in collision detection. An exact `张三` row and
-- a `张三（VIC）` row are therefore two possible accounts, not one relaxed key.
create or replace function internal.student_import_jwb_annotation_relaxed_name_key(
  p_name text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    nullif(internal.student_import_jwb_latin_parenthetical_annotation_key(p_name), ''),
    internal.student_import_name_key(p_name)
  )
$$;

revoke all on function internal.student_import_jwb_annotation_relaxed_name_key(text)
  from public, anon, authenticated;

-- Keep every existing strict link strict. The only cross-name link admitted
-- by this shared trigger/projection boundary is an explicitly labelled,
-- globally unique, JWB trailing-Latin-annotation pair.
create or replace function internal.student_import_identity_link_names_mismatch(
  p_master_rows jsonb,
  p_jwb_rows jsonb,
  p_links jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_master_rows) <> 'array'
      or jsonb_typeof(p_jwb_rows) <> 'array'
      or jsonb_typeof(p_links) <> 'array'
    then true
    else exists (
      select 1
      from jsonb_array_elements(p_links) link(value)
      left join lateral (
        select master_row.value as row_value
        from jsonb_array_elements(p_master_rows) master_row(value)
        where internal.student_import_source_key(master_row.value -> 'sourceRow') =
          internal.student_import_source_key(link.value -> 'masterSourceRow')
      ) master_match on true
      left join lateral (
        select jwb_row.value as row_value
        from jsonb_array_elements(p_jwb_rows) jwb_row(value)
        where internal.student_import_source_key(jwb_row.value -> 'sourceRow') =
          internal.student_import_source_key(link.value -> 'jwbSourceRow')
      ) jwb_match on true
      where (
        -- The legacy/default branch remains exact complete-name equality.
        not (link.value ? 'matchStrategy')
        and link.value ? 'jwbSourceRow'
        and (
          master_match.row_value is null
          or jwb_match.row_value is null
          or internal.student_import_name_key(master_match.row_value ->> 'name') = ''
          or internal.student_import_name_key(master_match.row_value ->> 'name') <>
             internal.student_import_name_key(jwb_match.row_value ->> 'name')
        )
      ) or (
        link.value ? 'matchStrategy'
        and (
          jsonb_typeof(link.value -> 'matchStrategy') <> 'string'
          or link.value ->> 'matchStrategy' <>
             'jwb_latin_parenthetical_annotation_v1'
          or not (link.value ? 'jwbSourceRow')
          or master_match.row_value is null
          or jwb_match.row_value is null
          or position('(' in internal.student_import_display_name(
            master_match.row_value ->> 'name'
          )) > 0
          or position(')' in internal.student_import_display_name(
            master_match.row_value ->> 'name'
          )) > 0
          or internal.student_import_name_key(master_match.row_value ->> 'name') = ''
          -- An annotation strategy is meaningful only for a non-exact pair.
          or internal.student_import_name_key(master_match.row_value ->> 'name') =
             internal.student_import_name_key(jwb_match.row_value ->> 'name')
          or internal.student_import_name_key(master_match.row_value ->> 'name') <>
             internal.student_import_jwb_latin_parenthetical_annotation_key(
               jwb_match.row_value ->> 'name'
             )
          -- Master collision detection is global, including excluded rows and
          -- a literal annotated master display name. For example, both
          -- `张三` and `张三（VIC）` reserve the relaxed key `张三`, so the
          -- reviewed body link is not allowed to shadow the strict owner.
          or 1 <> (
            select count(*)
            from jsonb_array_elements(p_master_rows) candidate(value)
            where internal.student_import_jwb_annotation_relaxed_name_key(
              candidate.value ->> 'name'
            ) = internal.student_import_name_key(master_match.row_value ->> 'name')
          )
          -- JWB uniqueness is global and treats exact-body rows as collisions.
          or 1 <> (
            select count(*)
            from jsonb_array_elements(p_jwb_rows) candidate(value)
            where internal.student_import_jwb_annotation_relaxed_name_key(
              candidate.value ->> 'name'
            ) = internal.student_import_name_key(master_match.row_value ->> 'name')
          )
        )
      )
    )
  end
$$;

revoke all on function internal.student_import_identity_link_names_mismatch(jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- Keep the original reviewed-master/current-student exact-name contract, and
-- add the source-wide current-student collision proof for the sole annotation
-- exception. An existing literal `张三（VIC）` is a distinct strict record; it
-- must prevent a `张三` body candidate instead of being silently folded into
-- it. Reviewed creates are included too, even though they do not have a
-- current target row yet.
create or replace function internal.student_import_identity_link_existing_names_mismatch(
  p_master_rows jsonb,
  p_students jsonb,
  p_links jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_master_rows) <> 'array'
      or jsonb_typeof(p_students) <> 'array'
      or jsonb_typeof(p_links) <> 'array'
    then true
    else exists (
      select 1
      from jsonb_array_elements(p_links) link(value)
      left join lateral (
        select master_row.value as row_value
        from jsonb_array_elements(p_master_rows) master_row(value)
        where internal.student_import_source_key(master_row.value -> 'sourceRow') =
          internal.student_import_source_key(link.value -> 'masterSourceRow')
      ) master_match on true
      left join lateral (
        select current_student.value as row_value
        from jsonb_array_elements(p_students) current_student(value)
        where jsonb_typeof(current_student.value -> 'id') = 'string'
          and internal.student_import_js_trim(current_student.value ->> 'id') =
            internal.student_import_js_trim(link.value ->> 'studentId')
      ) current_match on true
      where master_match.row_value is null
        or internal.student_import_name_key(master_match.row_value ->> 'name') = ''
        or (
          current_match.row_value is not null
          and internal.student_import_name_key(master_match.row_value ->> 'name') <>
            internal.student_import_name_key(current_match.row_value ->> 'name')
        )
        or (
          link.value ->> 'matchStrategy' =
            'jwb_latin_parenthetical_annotation_v1'
          and exists (
            select 1
            from jsonb_array_elements(p_students) candidate(value)
            where jsonb_typeof(candidate.value -> 'id') = 'string'
              and internal.student_import_js_trim(candidate.value ->> 'id') <>
                internal.student_import_js_trim(link.value ->> 'studentId')
              and internal.student_import_jwb_annotation_relaxed_name_key(
                candidate.value ->> 'name'
              ) = internal.student_import_name_key(
                master_match.row_value ->> 'name'
              )
          )
        )
    )
  end
$$;

revoke all on function internal.student_import_identity_link_existing_names_mismatch(jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- Keep the current trigger name for compatibility, but have it evaluate the
-- revised closed strategy contract above. Existing master/current-student
-- name checks remain strict through the companion helper.
create or replace function internal.enforce_student_import_identity_link_exact_names()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  master_rows jsonb;
  jwb_rows jsonb;
  current_students jsonb;
begin
  select source.rows into master_rows
  from internal.student_import_source_rows source
  where source.source_kind = 'master'
    and source.source_id = new.master_source_id
    and source.revision = new.master_revision;
  select source.rows into jwb_rows
  from internal.student_import_source_rows source
  where source.source_kind = 'jwb'
    and source.source_id = new.jwb_source_id
    and source.revision = new.jwb_revision;
  select state.payload into current_students
  from public.ops_state state
  where state.entity = 'students'
    and state.version = new.students_version;

  if master_rows is null or jwb_rows is null or current_students is null
     or internal.student_import_identity_link_names_mismatch(
       master_rows, jwb_rows, new.links
     )
     or internal.student_import_identity_link_existing_names_mismatch(
       master_rows, current_students, new.links
     ) then
    raise exception using
      errcode = '22023',
      message = 'student_import_identity_link_name_mismatch';
  end if;
  if internal.student_import_identity_link_master_jwb_member_id_conflict(
    master_rows, new.links
  ) then
    raise exception using
      errcode = '22023',
      message = 'student_import_identity_link_master_jwb_member_id_conflict';
  end if;
  return new;
end;
$$;

revoke all on function internal.enforce_student_import_identity_link_exact_names()
  from public, anon, authenticated;

-- The existing canonical projection is the final commit/replay authority.
-- It already invokes the helper redefined above; allow only the new explicit
-- strategy key through its source-link shape validator.
do $annotation_projection_patch$
declare
  function_definition text;
  validation_anchor text := $anchor$
       or link - 'masterSourceRow' - 'studentId' - 'jwbSourceRow' <> '{}'::jsonb
$anchor$;
  validation_replacement text := $replacement$
       or link - 'masterSourceRow' - 'studentId' - 'jwbSourceRow' - 'matchStrategy' <> '{}'::jsonb
$replacement$;
  anchor_count integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into function_definition;
  if function_definition is null then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_projection_missing';
  end if;
  anchor_count := (
    length(function_definition) - length(replace(function_definition, validation_anchor, ''))
  ) / length(validation_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_projection_validation_anchor_mismatch';
  end if;
  function_definition := replace(
    function_definition, validation_anchor, validation_replacement
  );
  execute function_definition;
  if position('matchStrategy' in pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  )) = 0 then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_projection_patch_verification_failed';
  end if;
end;
$annotation_projection_patch$;

-- Preserve a strategy-bearing link if an older exact-review route later adds
-- another strict link. Without this patch those routes' canonicalization
-- would silently drop `matchStrategy`, after which the link-set trigger would
-- correctly fail the cross-name pair but leave the UX needlessly blocked.
do $annotation_existing_review_writer_patch$
declare
  function_signature text;
  function_definition text;
  jwb_fragment text := $fragment$
    'jwbSourceRow', case
      when link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null'
      then link -> 'jwbSourceRow' else null end
$fragment$;
  replacement_fragment text := $replacement$
    'jwbSourceRow', case
      when link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null'
      then link -> 'jwbSourceRow' else null end,
    'matchStrategy', case
      when link ? 'matchStrategy'
       and link ->> 'matchStrategy' = 'jwb_latin_parenthetical_annotation_v1'
      then link ->> 'matchStrategy' else null end
$replacement$;
  anchor_count integer;
begin
  foreach function_signature in array array[
    'public.put_student_import_identity_review_decision(text,text,text,text)',
    'public.put_student_import_identity_review_pair(text,text,text,text,text,text,text)',
    'public.put_student_import_identity_links(text,jsonb,jsonb,text)'
  ] loop
    select pg_catalog.pg_get_functiondef(function_signature::regprocedure)
      into function_definition;
    if function_definition is null then
      raise exception using errcode = 'P0001',
        message = 'student_import_annotation_existing_writer_missing';
    end if;
    anchor_count := (
      length(function_definition) - length(replace(function_definition, jwb_fragment, ''))
    ) / length(jwb_fragment);
    if anchor_count <> 1 then
      raise exception using errcode = 'P0001',
        message = 'student_import_annotation_existing_writer_anchor_mismatch';
    end if;
    execute replace(function_definition, jwb_fragment, replacement_fragment);
  end loop;
end;
$annotation_existing_review_writer_patch$;

-- The two earlier bulk-review workflows share one planner. Make its active
-- link canonicalization retain the explicit strategy so a later exact batch
-- cannot erase an accepted annotation link.
do $annotation_bulk_plan_patch$
declare
  function_definition text;
  allowed_fields_anchor text := $allowed$
         or item.value - 'masterSourceRow' - 'jwbSourceRow' - 'studentId' <> '{}'::jsonb
$allowed$;
  allowed_fields_replacement text := $allowed_replacement$
         or item.value - 'masterSourceRow' - 'jwbSourceRow' - 'studentId' - 'matchStrategy' <> '{}'::jsonb
$allowed_replacement$;
  active_link_anchor text := $active_link$
        'jwbSourceRow', case
          when item.value ? 'jwbSourceRow'
           and jsonb_typeof(item.value -> 'jwbSourceRow') <> 'null'
          then item.value -> 'jwbSourceRow' else null end
$active_link$;
  active_link_replacement text := $active_link_replacement$
        'jwbSourceRow', case
          when item.value ? 'jwbSourceRow'
           and jsonb_typeof(item.value -> 'jwbSourceRow') <> 'null'
          then item.value -> 'jwbSourceRow' else null end,
        'matchStrategy', case
          when item.value ? 'matchStrategy'
           and item.value ->> 'matchStrategy' = 'jwb_latin_parenthetical_annotation_v1'
          then item.value ->> 'matchStrategy' else null end
$active_link_replacement$;
  candidate_link_anchor text := $candidate_link$
    select jsonb_build_object(
        'masterSourceRow', item.value -> 'masterSourceRow',
        'jwbSourceRow', item.value -> 'jwbSourceRow',
        'studentId', item.value ->> 'studentId'
      ) as link,
$candidate_link$;
  candidate_link_replacement text := $candidate_link_replacement$
    select jsonb_strip_nulls(jsonb_build_object(
        'masterSourceRow', item.value -> 'masterSourceRow',
        'jwbSourceRow', item.value -> 'jwbSourceRow',
        'studentId', item.value ->> 'studentId',
        'matchStrategy', case
          when item.value ? 'matchStrategy'
           and item.value ->> 'matchStrategy' = 'jwb_latin_parenthetical_annotation_v1'
          then item.value ->> 'matchStrategy' else null end
      )) as link,
$candidate_link_replacement$;
  anchor_count integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_identity_bulk_merge_plan(jsonb,jsonb)'::regprocedure
  ) into function_definition;
  if function_definition is null then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_bulk_plan_missing';
  end if;
  anchor_count := (
    length(function_definition) - length(replace(function_definition, allowed_fields_anchor, ''))
  ) / length(allowed_fields_anchor);
  if anchor_count <> 2 then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_bulk_plan_allowed_fields_anchor_mismatch';
  end if;
  function_definition := replace(
    function_definition, allowed_fields_anchor, allowed_fields_replacement
  );
  anchor_count := (
    length(function_definition) - length(replace(function_definition, active_link_anchor, ''))
  ) / length(active_link_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_bulk_plan_active_link_anchor_mismatch';
  end if;
  function_definition := replace(
    function_definition, active_link_anchor, active_link_replacement
  );
  anchor_count := (
    length(function_definition) - length(replace(
      function_definition, candidate_link_anchor, ''
    ))
  ) / length(candidate_link_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_bulk_plan_candidate_link_anchor_mismatch';
  end if;
  execute replace(
    function_definition, candidate_link_anchor, candidate_link_replacement
  );
end;
$annotation_bulk_plan_patch$;

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

  if exists (
      select 1 from jsonb_array_elements(p_master_rows) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or internal.student_import_source_key(item.value -> 'sourceRow') is null
    )
    or (select count(*) from jsonb_array_elements(p_master_rows)) <>
      (select count(distinct internal.student_import_source_key(item.value -> 'sourceRow'))
       from jsonb_array_elements(p_master_rows) item(value))
    or exists (
      select 1 from jsonb_array_elements(p_resolved_master_rows) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or internal.student_import_source_key(item.value -> 'sourceRow') is null
    )
    or (select count(*) from jsonb_array_elements(p_resolved_master_rows)) <>
      (select count(distinct internal.student_import_source_key(item.value -> 'sourceRow'))
       from jsonb_array_elements(p_resolved_master_rows) item(value))
    or exists (
      select 1
      from jsonb_array_elements(p_resolved_master_rows) resolved(value)
      where not exists (
        select 1
        from jsonb_array_elements(p_master_rows) raw(value)
        where internal.student_import_source_key(raw.value -> 'sourceRow') =
          internal.student_import_source_key(resolved.value -> 'sourceRow')
      )
    )
    or exists (
      select 1 from jsonb_array_elements(p_jwb_rows) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or internal.student_import_source_key(item.value -> 'sourceRow') is null
    )
    or (select count(*) from jsonb_array_elements(p_jwb_rows)) <>
      (select count(distinct internal.student_import_source_key(item.value -> 'sourceRow'))
       from jsonb_array_elements(p_jwb_rows) item(value))
    or exists (
      select 1 from jsonb_array_elements(p_students) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or jsonb_typeof(item.value -> 'id') <> 'string'
        or nullif(trim(item.value ->> 'id'), '') is null
        or item.value ->> 'id' <> trim(item.value ->> 'id')
        or length(item.value ->> 'id') > 240
    )
    or (select count(*) from jsonb_array_elements(p_students)) <>
      (select count(distinct item.value ->> 'id')
       from jsonb_array_elements(p_students) item(value)) then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_annotation_candidate_rows';
  end if;

  with master_raw as materialized (
    select item.value as row_value,
      item.value -> 'sourceRow' as source_row,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_name_key(item.value ->> 'name') as name_key,
      internal.student_import_display_name(item.value ->> 'name') as display_name,
      internal.student_import_jwb_annotation_relaxed_name_key(
        item.value ->> 'name'
      ) as collision_key
    from jsonb_array_elements(p_master_rows) item(value)
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
    select item.value as row_value,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      trim(coalesce(item.value ->> 'status', '')) as status
    from jsonb_array_elements(p_resolved_master_rows) item(value)
  -- Every active raw master row owns its deterministic student ID, including
  -- rows with parentheses that are deliberately ineligible for this narrow
  -- annotation rule.  Candidate eligibility below remains restricted to
  -- `master_basis`; ownership must not be, or a reviewed link could borrow
  -- another active row's ID and make the later canonical projection collide.
  ), resolved_active_master as materialized (
    select master_raw.source_key,
      internal.student_import_student_id(
        p_master_source_id, master_raw.source_row
      ) as derived_student_id
    from master_raw
    join resolved_master_raw using (source_key)
    where resolved_master_raw.status in (
      '在读', '活跃 + 无课时', '活跃 + 有课时',
      '不活跃 + 有课时', '在读 + 加课待排'
    )
  ), owner_basis as materialized (
    select resolved_active_master.*,
      count(*) over (partition by derived_student_id) as derived_owner_count
    from resolved_active_master
  ), candidate_master as materialized (
    select master_basis.*,
      owner_basis.derived_student_id,
      owner_basis.derived_owner_count
    from master_basis
    join owner_basis using (source_key)
  ), eligible_master as materialized (
    select * from candidate_master
    where name_key <> ''
      and name_key_count = 1
      and collision_key_count = 1
      and derived_owner_count = 1
  ), jwb_raw as materialized (
    select item.value as row_value,
      item.value -> 'sourceRow' as source_row,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_jwb_latin_parenthetical_annotation_key(
        item.value ->> 'name'
      ) as annotation_key,
      internal.student_import_jwb_annotation_relaxed_name_key(
        item.value ->> 'name'
      ) as collision_key
    from jsonb_array_elements(p_jwb_rows) item(value)
  ), jwb_basis as materialized (
    select jwb_raw.*,
      count(*) over (partition by collision_key) as collision_key_count
    from jwb_raw
  ), eligible_jwb as materialized (
    select * from jwb_basis
    where annotation_key <> '' and collision_key_count = 1
  ), student_raw as materialized (
    select item.value ->> 'id' as student_id,
      internal.student_import_name_key(item.value ->> 'name') as name_key,
      internal.student_import_jwb_annotation_relaxed_name_key(
        item.value ->> 'name'
      ) as collision_key
    from jsonb_array_elements(p_students) item(value)
  ), student_basis as materialized (
    select student_raw.*,
      count(*) over (partition by name_key) as name_key_count
    from student_raw
  ), unique_student as materialized (
    select * from student_basis
    where name_key <> '' and name_key_count = 1
  ), active_link_basis as materialized (
    select internal.student_import_source_key(link.value -> 'masterSourceRow') as master_key,
      case when link.value ? 'jwbSourceRow'
        then internal.student_import_source_key(link.value -> 'jwbSourceRow')
        else null end as jwb_key,
      trim(link.value ->> 'studentId') as student_id
    from jsonb_array_elements(p_active_links) link(value)
  ), paired as materialized (
    select master.source_row as master_source_row,
      master.source_key as master_source_key,
      master.name_key,
      master.derived_student_id,
      jwb.source_row as jwb_source_row,
      jwb.source_key as jwb_source_key,
      existing.student_id as existing_student_id
    from eligible_master master
    join eligible_jwb jwb on jwb.annotation_key = master.name_key
    left join unique_student existing on existing.name_key = master.name_key
  ), selected as materialized (
    select paired.*,
      coalesce(paired.existing_student_id, paired.derived_student_id) as target_student_id
    from paired
    where not exists (
      select 1 from student_raw current_student
      where current_student.student_id = paired.derived_student_id
        and paired.existing_student_id is null
    )
  ), safe as materialized (
    select selected.*
    from selected
    where not exists (
      select 1 from owner_basis owner
      where owner.derived_student_id = selected.target_student_id
        and owner.source_key <> selected.master_source_key
    )
    -- A current literal annotation name (or a second current body name) is a
    -- source-wide identity collision. The selected target itself is allowed;
    -- no other current record may share this relaxed body.
    and not exists (
      select 1 from student_raw existing_collision
      where existing_collision.collision_key = selected.name_key
        and existing_collision.student_id <> selected.target_student_id
    )
    and not exists (
      select 1 from active_link_basis active_link
      where active_link.master_key = selected.master_source_key
         or active_link.jwb_key = selected.jwb_source_key
         or active_link.student_id = selected.target_student_id
    )
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

create or replace function internal.student_import_identity_annotation_candidate_fingerprint(
  p_candidates jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'sha256:' || encode(extensions.digest(
    internal.student_import_stable_value(jsonb_build_object(
      'contract', 'student-import-identity-annotation-candidates-v1',
      'candidates', p_candidates
    )), 'sha256'
  ), 'hex')
$$;

revoke all on function internal.student_import_identity_annotation_candidate_fingerprint(jsonb)
  from public, anon, authenticated;

create or replace function internal.student_import_identity_annotation_review_key(
  p_master_source_id text,
  p_master_revision text,
  p_master_rows_sha256 text,
  p_jwb_source_id text,
  p_jwb_revision text,
  p_jwb_rows_sha256 text,
  p_students_version bigint,
  p_review_epoch bigint,
  p_active_link_fingerprint text,
  p_duplicate_resolution_fingerprint text,
  p_candidate_fingerprint text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'sha256:' || encode(extensions.digest(
    internal.student_import_stable_value(jsonb_build_object(
      'contract', 'student-import-identity-annotation-review-v1',
      'strategy', 'jwb_latin_parenthetical_annotation_v1',
      'master', jsonb_build_object(
        'sourceId', p_master_source_id,
        'revision', p_master_revision,
        'rowsSha256', p_master_rows_sha256
      ),
      'jwb', jsonb_build_object(
        'sourceId', p_jwb_source_id,
        'revision', p_jwb_revision,
        'rowsSha256', p_jwb_rows_sha256
      ),
      'studentsVersion', p_students_version,
      'reviewEpoch', p_review_epoch,
      'activeLinkFingerprint', p_active_link_fingerprint,
      'duplicateResolutionFingerprint', p_duplicate_resolution_fingerprint,
      'candidateFingerprint', p_candidate_fingerprint
    )), 'sha256'
  ), 'hex')
$$;

revoke all on function internal.student_import_identity_annotation_review_key(
  text, text, text, text, text, text, bigint, bigint, text, text, text
) from public, anon, authenticated;

create table if not exists internal.student_import_identity_annotation_review_commands (
  confirmation_key text primary key
    check (confirmation_key ~ '^sha256:[a-f0-9]{64}$'),
  master_source_id text not null check (length(master_source_id) between 1 and 160),
  master_revision text not null check (length(master_revision) between 1 and 240),
  master_rows_sha256 text not null check (master_rows_sha256 ~ '^[a-f0-9]{64}$'),
  jwb_source_id text not null check (length(jwb_source_id) between 1 and 160),
  jwb_revision text not null check (length(jwb_revision) between 1 and 240),
  jwb_rows_sha256 text not null check (jwb_rows_sha256 ~ '^[a-f0-9]{64}$'),
  students_version bigint not null check (students_version between 0 and 9007199254740991),
  review_epoch bigint not null check (review_epoch between 0 and 9007199254740991),
  duplicate_resolution_fingerprint text not null check (duplicate_resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  candidate_fingerprint text not null check (candidate_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  before_link_fingerprint text not null check (before_link_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  after_link_fingerprint text not null check (after_link_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  before_link_count integer not null check (before_link_count between 0 and 10000),
  requested_count integer not null check (requested_count > 0 and requested_count <= 10000),
  newly_applied_count integer not null check (newly_applied_count > 0),
  already_applied_count integer not null check (already_applied_count >= 0),
  final_count integer not null check (final_count > 0 and final_count <= 10000),
  confirmed_by text not null check (length(confirmed_by) between 1 and 120),
  confirmed_at timestamptz not null default now(),
  audit_id uuid not null unique references internal.operational_contract_audit(id),
  check (requested_count = newly_applied_count + already_applied_count),
  check (final_count = before_link_count + newly_applied_count)
);

alter table internal.student_import_identity_annotation_review_commands enable row level security;
revoke all on table internal.student_import_identity_annotation_review_commands
  from public, anon, authenticated;

create or replace function internal.reject_student_import_identity_annotation_review_command_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000',
    message = 'student_import_identity_annotation_review_command_immutable';
end;
$$;

drop trigger if exists reject_student_import_identity_annotation_review_command_mutation
  on internal.student_import_identity_annotation_review_commands;
create trigger reject_student_import_identity_annotation_review_command_mutation
before update or delete on internal.student_import_identity_annotation_review_commands
for each row execute function internal.reject_student_import_identity_annotation_review_command_mutation();

revoke all on function internal.reject_student_import_identity_annotation_review_command_mutation()
  from public, anon, authenticated;

-- Preview exposes counts and one state-bound opaque key only. The candidate
-- rows, identities and matching rule are all re-derived inside the database.
create or replace function public.get_student_import_identity_annotation_review_preview(
  p_secret text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  active_links jsonb := '[]'::jsonb;
  active_fingerprint text;
  duplicate_snapshot jsonb;
  resolved_master_rows jsonb;
  candidates jsonb;
  candidate_fingerprint text;
  confirmation_key text;
  review_epoch bigint;
  saved_matches_current boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into jwb
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'jwb';
  select * into master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master';
  select * into saved
  from internal.student_import_identity_link_sets identity_state
  where identity_state.singleton;
  select * into students_state
  from public.ops_state state_row
  where state_row.entity = 'students';

  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002',
      message = 'student_import_source_rows_unavailable';
  end if;
  if students_state.entity is null
     or jsonb_typeof(students_state.payload) <> 'array'
     or students_state.version < 0
     or students_state.version > 9007199254740991 then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;

  review_epoch := coalesce(saved.review_epoch, 0);
  if review_epoch < 0 or review_epoch > 9007199254740991 then
    raise exception using errcode = '55000',
      message = 'student_import_identity_review_epoch_invalid';
  end if;
  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version then
    saved_matches_current := true;
    active_links := saved.links;
  end if;

  active_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', active_links
  )::text, 'sha256'), 'hex');
  if saved_matches_current and (
    saved.link_count <> jsonb_array_length(active_links)
    or saved.link_fingerprint <> active_fingerprint
  ) then
    raise exception using errcode = '55000',
      message = 'student_import_identity_annotation_review_linkset_invalid';
  end if;

  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, students_state
  );
  resolved_master_rows := internal.student_import_identity_resolved_master_rows(
    master.rows, duplicate_snapshot
  );
  if internal.student_import_identity_link_names_mismatch(
      resolved_master_rows, jwb.rows, active_links
    ) or internal.student_import_identity_link_names_mismatch(
      master.rows, jwb.rows, active_links
    ) or internal.student_import_identity_link_existing_names_mismatch(
      resolved_master_rows, students_state.payload, active_links
    ) or internal.student_import_identity_link_existing_names_mismatch(
      master.rows, students_state.payload, active_links
    ) then
    raise exception using errcode = '55000',
      message = 'student_import_identity_annotation_review_existing_links_invalid';
  end if;

  candidates := internal.student_import_identity_annotation_candidates(
    master.source_id, master.rows, resolved_master_rows, jwb.rows,
    students_state.payload, active_links
  );
  candidate_fingerprint :=
    internal.student_import_identity_annotation_candidate_fingerprint(candidates);
  confirmation_key := internal.student_import_identity_annotation_review_key(
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch, active_fingerprint,
    duplicate_snapshot ->> 'fingerprint', candidate_fingerprint
  );

  return jsonb_build_object(
    'confirmationKey', confirmation_key,
    'candidateCount', jsonb_array_length(candidates),
    'pendingCount', jsonb_array_length(candidates),
    'alreadyLinkedCount', 0,
    'currentLinkCount', jsonb_array_length(active_links),
    'resultingLinkCount', jsonb_array_length(active_links)
      + jsonb_array_length(candidates),
    'canSubmit', jsonb_array_length(candidates) > 0
  );
end;
$$;

revoke all on function public.get_student_import_identity_annotation_review_preview(text)
  from public, anon, authenticated;
grant execute on function public.get_student_import_identity_annotation_review_preview(text)
  to anon, authenticated;

-- A confirmation may only add the complete, freshly re-derived candidate
-- set. It cannot accept source rows, names, IDs, match rules or a partial
-- selection from the browser.
create or replace function public.put_student_import_identity_annotation_review(
  p_secret text,
  p_confirmation_key text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  prior_command internal.student_import_identity_annotation_review_commands%rowtype;
  active_links jsonb := '[]'::jsonb;
  active_fingerprint text;
  duplicate_snapshot jsonb;
  resolved_master_rows jsonb;
  candidates jsonb;
  candidate_fingerprint text;
  expected_key text;
  combined_links jsonb;
  after_fingerprint text;
  audit_entry_id uuid;
  review_epoch bigint;
  saved_matches_current boolean := false;
  before_link_count integer;
  requested_count integer;
  newly_applied_count integer;
  already_applied_count integer;
  final_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_confirmation_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_annotation_review_request';
  end if;

  -- All identity-review writers use this lock order. The source rows are
  -- locked JWB then master, followed by the singleton link set and students.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_identity_link_set:singleton', 0
  ));
  select * into jwb
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'jwb'
  for update;
  select * into master
  from internal.student_import_source_rows source_state
  where source_state.source_kind = 'master'
  for update;
  select * into saved
  from internal.student_import_identity_link_sets identity_state
  where identity_state.singleton
  for update;
  select * into students_state
  from public.ops_state state_row
  where state_row.entity = 'students'
  for update;

  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002',
      message = 'student_import_source_rows_unavailable';
  end if;
  if students_state.entity is null
     or jsonb_typeof(students_state.payload) <> 'array'
     or students_state.version < 0
     or students_state.version > 9007199254740991 then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;

  review_epoch := coalesce(saved.review_epoch, 0);
  if review_epoch < 0 or review_epoch > 9007199254740991 then
    raise exception using errcode = '55000',
      message = 'student_import_identity_review_epoch_invalid';
  end if;
  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version then
    saved_matches_current := true;
    active_links := saved.links;
  end if;

  active_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', active_links
  )::text, 'sha256'), 'hex');
  if saved_matches_current and (
    saved.link_count <> jsonb_array_length(active_links)
    or saved.link_fingerprint <> active_fingerprint
  ) then
    raise exception using errcode = '55000',
      message = 'student_import_identity_annotation_review_linkset_invalid';
  end if;

  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, students_state
  );

  -- A lost response may replay only the exact immutable command and its
  -- resulting link set. Any source, duplicate-decision or link-set drift
  -- makes the old opaque key fail closed.
  select * into prior_command
  from internal.student_import_identity_annotation_review_commands command
  where command.confirmation_key = p_confirmation_key
  for update;
  if found then
    if prior_command.master_source_id <> master.source_id
       or prior_command.master_revision <> master.revision
       or prior_command.master_rows_sha256 <> master.rows_sha256
       or prior_command.jwb_source_id <> jwb.source_id
       or prior_command.jwb_revision <> jwb.revision
       or prior_command.jwb_rows_sha256 <> jwb.rows_sha256
       or prior_command.students_version <> students_state.version
       or prior_command.review_epoch <> review_epoch
       or prior_command.duplicate_resolution_fingerprint <>
          duplicate_snapshot ->> 'fingerprint'
       or not saved_matches_current
       or saved.link_fingerprint <> prior_command.after_link_fingerprint
       or saved.link_count <> prior_command.final_count
       or saved.audit_id <> prior_command.audit_id then
      raise exception using errcode = '40001',
        message = 'student_import_identity_annotation_review_replay_conflict';
    end if;
    return jsonb_build_object(
      'confirmationKey', prior_command.confirmation_key,
      'fingerprint', prior_command.after_link_fingerprint,
      'count', prior_command.final_count,
      'requestedCount', prior_command.requested_count,
      'newlyAppliedCount', prior_command.newly_applied_count,
      'alreadyAppliedCount', prior_command.already_applied_count,
      'finalCount', prior_command.final_count,
      'unchanged', true
    );
  end if;

  resolved_master_rows := internal.student_import_identity_resolved_master_rows(
    master.rows, duplicate_snapshot
  );
  if internal.student_import_identity_link_names_mismatch(
      resolved_master_rows, jwb.rows, active_links
    ) or internal.student_import_identity_link_names_mismatch(
      master.rows, jwb.rows, active_links
    ) or internal.student_import_identity_link_existing_names_mismatch(
      resolved_master_rows, students_state.payload, active_links
    ) or internal.student_import_identity_link_existing_names_mismatch(
      master.rows, students_state.payload, active_links
    ) then
    raise exception using errcode = '23503',
      message = 'student_import_identity_annotation_review_existing_links_invalid';
  end if;

  candidates := internal.student_import_identity_annotation_candidates(
    master.source_id, master.rows, resolved_master_rows, jwb.rows,
    students_state.payload, active_links
  );
  candidate_fingerprint :=
    internal.student_import_identity_annotation_candidate_fingerprint(candidates);
  expected_key := internal.student_import_identity_annotation_review_key(
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch, active_fingerprint,
    duplicate_snapshot ->> 'fingerprint', candidate_fingerprint
  );
  if expected_key <> p_confirmation_key then
    raise exception using errcode = '23503',
      message = 'student_import_identity_annotation_review_unavailable';
  end if;

  requested_count := jsonb_array_length(candidates);
  before_link_count := jsonb_array_length(active_links);
  newly_applied_count := requested_count;
  already_applied_count := 0;
  final_count := before_link_count + newly_applied_count;
  if requested_count <= 0
     or final_count > 10000 then
    raise exception using errcode = '23503',
      message = 'student_import_identity_annotation_review_empty';
  end if;

  select coalesce(jsonb_agg(item.value order by
    internal.student_import_utf16_sort_key(
      internal.student_import_source_key(item.value -> 'masterSourceRow')
    ),
    internal.student_import_utf16_sort_key(coalesce(
      internal.student_import_source_key(item.value -> 'jwbSourceRow'), ''
    )),
    internal.student_import_utf16_sort_key(item.value ->> 'studentId')
  ), '[]'::jsonb)
  into combined_links
  from jsonb_array_elements(active_links || candidates) item(value);

  if jsonb_array_length(combined_links) <> final_count
     or jsonb_array_length(combined_links) <> (
       select count(distinct internal.student_import_source_key(
         item.value -> 'masterSourceRow'
       ))
       from jsonb_array_elements(combined_links) item(value)
     )
     or jsonb_array_length(combined_links) <> (
       select count(distinct trim(item.value ->> 'studentId'))
       from jsonb_array_elements(combined_links) item(value)
     )
     or (
       select count(*) from jsonb_array_elements(combined_links) item(value)
       where item.value ? 'jwbSourceRow'
     ) <> (
       select count(distinct internal.student_import_source_key(
         item.value -> 'jwbSourceRow'
       ))
       from jsonb_array_elements(combined_links) item(value)
       where item.value ? 'jwbSourceRow'
     ) then
    raise exception using errcode = '23505',
      message = 'student_import_identity_annotation_review_combined_conflict';
  end if;

  -- Validate the final durable representation before recording audit
  -- evidence. The link-set trigger repeats these checks at the write
  -- boundary; retaining this explicit guard makes the failure deterministic.
  if internal.student_import_identity_link_names_mismatch(
      resolved_master_rows, jwb.rows, combined_links
    ) or internal.student_import_identity_link_names_mismatch(
      master.rows, jwb.rows, combined_links
    ) or internal.student_import_identity_link_existing_names_mismatch(
      resolved_master_rows, students_state.payload, combined_links
    ) or internal.student_import_identity_link_existing_names_mismatch(
      master.rows, students_state.payload, combined_links
    ) or internal.student_import_identity_link_master_jwb_member_id_conflict(
      master.rows, combined_links
    ) then
    raise exception using errcode = '23503',
      message = 'student_import_identity_annotation_review_combined_invalid';
  end if;

  after_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', combined_links
  )::text, 'sha256'), 'hex');

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.identity_annotation_review_confirmed',
    p_actor,
    'student_import_identity_annotation_review',
    p_confirmation_key,
    jsonb_build_object(
      'confirmationKey', p_confirmation_key,
      'matchStrategy', 'jwb_latin_parenthetical_annotation_v1',
      'masterSourceId', master.source_id,
      'masterRevision', master.revision,
      'masterRowsSha256', master.rows_sha256,
      'jwbSourceId', jwb.source_id,
      'jwbRevision', jwb.revision,
      'jwbRowsSha256', jwb.rows_sha256,
      'studentsVersion', students_state.version,
      'reviewEpoch', review_epoch,
      'duplicateResolutionFingerprint', duplicate_snapshot ->> 'fingerprint',
      'candidateFingerprint', candidate_fingerprint,
      'beforeLinkFingerprint', active_fingerprint,
      'afterLinkFingerprint', after_fingerprint,
      'beforeLinkCount', before_link_count,
      'requestedCount', requested_count,
      'newlyAppliedCount', newly_applied_count,
      'alreadyAppliedCount', already_applied_count,
      'finalCount', final_count
    )
  );

  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, review_epoch, links, link_count, link_fingerprint,
    updated_by, updated_at, audit_id
  ) values (
    true, master.source_id, master.revision, jwb.source_id, jwb.revision,
    students_state.version, review_epoch,
    combined_links, final_count, after_fingerprint,
    left(trim(p_actor), 120), now(), audit_entry_id
  ) on conflict (singleton) do update set
    master_source_id = excluded.master_source_id,
    master_revision = excluded.master_revision,
    jwb_source_id = excluded.jwb_source_id,
    jwb_revision = excluded.jwb_revision,
    students_version = excluded.students_version,
    review_epoch = excluded.review_epoch,
    links = excluded.links,
    link_count = excluded.link_count,
    link_fingerprint = excluded.link_fingerprint,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at,
    audit_id = excluded.audit_id;

  insert into internal.student_import_identity_annotation_review_commands (
    confirmation_key,
    master_source_id, master_revision, master_rows_sha256,
    jwb_source_id, jwb_revision, jwb_rows_sha256,
    students_version, review_epoch,
    duplicate_resolution_fingerprint, candidate_fingerprint,
    before_link_fingerprint, after_link_fingerprint, before_link_count,
    requested_count, newly_applied_count, already_applied_count, final_count,
    confirmed_by, confirmed_at, audit_id
  ) values (
    p_confirmation_key,
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch,
    duplicate_snapshot ->> 'fingerprint', candidate_fingerprint,
    active_fingerprint, after_fingerprint, before_link_count,
    requested_count, newly_applied_count, already_applied_count, final_count,
    left(trim(p_actor), 120), now(), audit_entry_id
  );

  return jsonb_build_object(
    'confirmationKey', p_confirmation_key,
    'fingerprint', after_fingerprint,
    'count', final_count,
    'requestedCount', requested_count,
    'newlyAppliedCount', newly_applied_count,
    'alreadyAppliedCount', already_applied_count,
    'finalCount', final_count,
    'unchanged', false
  );
end;
$$;

revoke all on function public.put_student_import_identity_annotation_review(
  text, text, text
) from public, anon, authenticated;
grant execute on function public.put_student_import_identity_annotation_review(
  text, text, text
) to anon, authenticated;

-- This migration must keep its timeout local to the two bulk operations.
do $annotation_timeout_guard$
declare
  preview_config text[];
  mutation_config text[];
begin
  select proconfig into preview_config
  from pg_catalog.pg_proc
  where oid =
    'public.get_student_import_identity_annotation_review_preview(text)'::regprocedure;
  select proconfig into mutation_config
  from pg_catalog.pg_proc
  where oid =
    'public.put_student_import_identity_annotation_review(text,text,text)'::regprocedure;
  if not ('statement_timeout=8s' = any(coalesce(preview_config, array[]::text[])))
     or not ('statement_timeout=8s' = any(coalesce(mutation_config, array[]::text[]))) then
    raise exception using errcode = 'P0001',
      message = 'student_import_identity_annotation_review_timeout_guard_missing';
  end if;
end;
$annotation_timeout_guard$;

-- Migration-time proof for the closed predicate and its final projection
-- boundary. These fixtures are intentionally adversarial: no digit, space,
-- Chinese annotation, second segment, prefix segment or global collision can
-- become a durable cross-name link.
do $annotation_fixtures$
declare
  candidates jsonb;
  projection jsonb;
begin
  if internal.student_import_jwb_latin_parenthetical_annotation_key(
      'Learner(VIC)'
    ) <> 'learner'
     or internal.student_import_jwb_latin_parenthetical_annotation_key(
       'Learner（VIC）'
     ) <> 'learner'
     or internal.student_import_jwb_latin_parenthetical_annotation_key(
       'Learner(G10)'
     ) <> ''
     or internal.student_import_jwb_latin_parenthetical_annotation_key(
       'Learner(É)'
     ) <> ''
     or internal.student_import_jwb_latin_parenthetical_annotation_key(
       'Learner(AB CD)'
     ) <> ''
     or internal.student_import_jwb_latin_parenthetical_annotation_key(
       'Learner(VIC)(NSW)'
     ) <> ''
     or internal.student_import_jwb_latin_parenthetical_annotation_key(
       '(VIC)Learner'
     ) <> ''
     or internal.student_import_jwb_latin_parenthetical_annotation_key(
       'Learner(中文)'
     ) <> ''
     or internal.student_import_jwb_latin_parenthetical_annotation_key(
       'Learner(VIC) suffix'
     ) <> ''
     or internal.student_import_jwb_latin_parenthetical_annotation_key(
       'Learner'
     ) <> '' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_annotation_key_fixture_mismatch';
  end if;

  candidates := internal.student_import_identity_annotation_candidates(
    'annotation-fixture',
    '[{"sourceRow":"M-1","name":"Learner","status":"在读"}]'::jsonb,
    '[{"sourceRow":"M-1","name":"Learner","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-1","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb
  );
  if jsonb_array_length(candidates) <> 1
     or candidates #>> '{0,masterSourceRow}' <> 'M-1'
     or candidates #>> '{0,jwbSourceRow}' <> 'J-1'
     or candidates #>> '{0,matchStrategy}' <>
        'jwb_latin_parenthetical_annotation_v1'
     or candidates #>> '{0,studentId}' <>
        internal.student_import_student_id(
          'annotation-fixture', to_jsonb('M-1'::text)
        ) then
    raise exception using errcode = '22023',
      message = 'student_import_identity_annotation_candidate_fixture_mismatch';
  end if;

  if jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-fixture',
      '[{"sourceRow":"M-2","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-2","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-2","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"},{"sourceRow":"J-3","name":"Learner","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb
    )) <> 0
     or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-fixture',
      '[{"sourceRow":"M-3","name":"Learner(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-3","name":"Learner(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-4","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb
    )) <> 0
     -- A duplicate suppressed by a separate master-resolution decision still
     -- participates in source-wide identity uniqueness.
     or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-fixture',
     '[{"sourceRow":"M-6","name":"Learner","status":"在读"},{"sourceRow":"M-7","name":"Learner","status":"不活跃 + 无课时"}]'::jsonb,
      '[{"sourceRow":"M-6","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-7","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb
    )) <> 0
     -- A strict master owner of the literal annotated name shadows the body.
     or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-fixture',
      '[{"sourceRow":"M-10","name":"Learner","status":"在读"},{"sourceRow":"M-11","name":"Learner(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-10","name":"Learner","status":"在读"},{"sourceRow":"M-11","name":"Learner(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-10","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb
    )) <> 0
     -- An existing literal annotation name also owns that relaxed body;
     -- candidates cannot silently create or reuse a separate body identity.
     or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-fixture',
      '[{"sourceRow":"M-12","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-12","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-12","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[{"id":"STU-ANNOTATED-LEARNER","name":"Learner(VIC)"}]'::jsonb,
      '[]'::jsonb
    )) <> 0
     -- An active master that has parentheses cannot be an annotation
     -- candidate, but it still owns its deterministic ID and must prevent a
     -- different master from linking an existing same-name record to it.
     or jsonb_array_length(internal.student_import_identity_annotation_candidates(
      'annotation-fixture',
      '[{"sourceRow":"M-8","name":"Learner","status":"在读"},{"sourceRow":"M-9","name":"Other(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"M-8","name":"Learner","status":"在读"},{"sourceRow":"M-9","name":"Other(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-8","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'id', internal.student_import_student_id(
          'annotation-fixture', to_jsonb('M-9'::text)
        ),
        'name', 'Learner'
      )),
      '[]'::jsonb
    )) <> 0 then
    raise exception using errcode = '22023',
      message = 'student_import_identity_annotation_collision_fixture_mismatch';
  end if;

  projection := internal.student_import_canonical_projection(
    'annotation-fixture',
    '[{"sourceRow":"M-4","name":"Learner","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-5","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'masterSourceRow', 'M-4',
      'jwbSourceRow', 'J-5',
      'studentId', internal.student_import_student_id(
        'annotation-fixture', to_jsonb('M-4'::text)
      ),
      'matchStrategy', 'jwb_latin_parenthetical_annotation_v1'
    )),
    '[]'::jsonb
  );
  if projection #>> '{0,jwbMatchStatus}' <> 'matched'
     or projection #>> '{0,jwbSourceRow}' <> 'J-5' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_annotation_projection_fixture_mismatch';
  end if;

  begin
    perform internal.student_import_canonical_projection(
      'annotation-fixture',
      '[{"sourceRow":"M-5","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-6","name":"Learner(G10)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'masterSourceRow', 'M-5',
        'jwbSourceRow', 'J-6',
        'studentId', internal.student_import_student_id(
          'annotation-fixture', to_jsonb('M-5'::text)
        ),
        'matchStrategy', 'jwb_latin_parenthetical_annotation_v1'
      )),
      '[]'::jsonb
    );
    raise exception using errcode = '22023',
      message = 'student_import_identity_annotation_invalid_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'student_import_identity_link_name_mismatch' then
      raise;
    end if;
  end;

  begin
    perform internal.student_import_canonical_projection(
      'annotation-fixture',
      '[{"sourceRow":"M-13","name":"Learner","status":"在读"},{"sourceRow":"M-14","name":"Learner(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-13","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'masterSourceRow', 'M-13',
        'jwbSourceRow', 'J-13',
        'studentId', internal.student_import_student_id(
          'annotation-fixture', to_jsonb('M-13'::text)
        ),
        'matchStrategy', 'jwb_latin_parenthetical_annotation_v1'
      )),
      '[]'::jsonb
    );
    raise exception using errcode = '22023',
      message = 'student_import_identity_annotation_master_shadow_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'student_import_identity_link_name_mismatch' then
      raise;
    end if;
  end;

  begin
    perform internal.student_import_canonical_projection(
      'annotation-fixture',
      '[{"sourceRow":"M-15","name":"Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-15","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[{"id":"STU-ANNOTATED-LEARNER","name":"Learner(VIC)"}]'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'masterSourceRow', 'M-15',
        'jwbSourceRow', 'J-15',
        'studentId', internal.student_import_student_id(
          'annotation-fixture', to_jsonb('M-15'::text)
        ),
        'matchStrategy', 'jwb_latin_parenthetical_annotation_v1'
      )),
      '[]'::jsonb
    );
    raise exception using errcode = '22023',
      message = 'student_import_identity_annotation_existing_shadow_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'student_import_identity_link_name_mismatch' then
      raise;
    end if;
  end;
end;
$annotation_fixtures$;
