-- The optional-JWB safe-link pass must retain its exact/approved-v1/
-- cross-name downgrade boundary, but it was normalizing the same master/JWB
-- display names multiple times while building source and collision relations.
-- Materialize each raw row's display/key basis once using the already-proven
-- 170006 from-display helpers; all link predicates, source counts, ordering,
-- and downgrade/fail-closed decisions remain unchanged.

set local lock_timeout = '1s';

do $student_import_safe_link_normalization$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_safe_link_normalization_wrapper_missing';
  end if;

  anchor := $safe_link_cte_anchor$  with links as (
    select link.value as raw_link,
      link.ordinality as ordinal,
      internal.student_import_source_key(link.value -> 'masterSourceRow') as master_key,
      internal.student_import_source_key(link.value -> 'jwbSourceRow') as jwb_key,
      jsonb_typeof(link.value) = 'object' and link.value ? 'jwbSourceRow' as has_jwb_leg
    from jsonb_array_elements(p_identity_links) with ordinality link(value, ordinality)
  ), master_rows as (
    select internal.student_import_source_key(master.value -> 'sourceRow') as source_key,
      count(*)::integer as source_count,
      (jsonb_agg(master.value order by master.ordinality) -> 0) as row_value
    from jsonb_array_elements(p_resolved_master_rows) with ordinality master(value, ordinality)
    group by internal.student_import_source_key(master.value -> 'sourceRow')
  ), jwb_rows as (
    select internal.student_import_source_key(jwb.value -> 'sourceRow') as source_key,
      count(*)::integer as source_count,
      (jsonb_agg(jwb.value order by jwb.ordinality) -> 0) as row_value
    from jsonb_array_elements(p_jwb_rows) with ordinality jwb(value, ordinality)
    group by internal.student_import_source_key(jwb.value -> 'sourceRow')
  ), master_link_counts as (
    select master_key, count(*)::integer as link_count
    from links
    where master_key is not null and master_key <> ''
    group by master_key
  ), jwb_link_counts as (
    select jwb_key, count(*)::integer as link_count
    from links
    where has_jwb_leg and jwb_key is not null
    group by jwb_key
  ), master_annotation_counts as (
    select internal.student_import_jwb_annotation_relaxed_name_key(
      master.value ->> 'name'
    ) as relaxed_key,
      count(*)::integer as row_count
    from jsonb_array_elements(p_resolved_master_rows) master(value)
    group by internal.student_import_jwb_annotation_relaxed_name_key(master.value ->> 'name')
  ), jwb_annotation_counts as (
    select internal.student_import_jwb_annotation_relaxed_name_key(
      jwb.value ->> 'name'
    ) as relaxed_key,
      count(*)::integer as row_count
    from jsonb_array_elements(p_jwb_rows) jwb(value)
    group by internal.student_import_jwb_annotation_relaxed_name_key(jwb.value ->> 'name')
  ), evaluated_links as ($safe_link_cte_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_safe_link_normalization_cte_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $safe_link_cte_replacement$  with links as (
    select link.value as raw_link,
      link.ordinality as ordinal,
      internal.student_import_source_key(link.value -> 'masterSourceRow') as master_key,
      internal.student_import_source_key(link.value -> 'jwbSourceRow') as jwb_key,
      jsonb_typeof(link.value) = 'object' and link.value ? 'jwbSourceRow' as has_jwb_leg
    from jsonb_array_elements(p_identity_links) with ordinality link(value, ordinality)
  ), master_source_values as materialized (
    select internal.student_import_source_key(master.value -> 'sourceRow') as source_key,
      master.value as row_value,
      master.ordinality as ordinal,
      internal.student_import_display_name(master.value ->> 'name') as display_name
    from jsonb_array_elements(p_resolved_master_rows) with ordinality master(value, ordinality)
  ), master_normalized as materialized (
    select source_key, row_value, ordinal, display_name,
      internal.student_import_annotation_name_key_from_display_name(
        display_name
      ) as name_key,
      internal.student_import_jwb_annotation_key_from_display(
        display_name
      ) as annotation_key
    from master_source_values
  ), master_rows as materialized (
    select source_key,
      count(*)::integer as source_count,
      (array_agg(row_value order by ordinal))[1] as row_value,
      (array_agg(display_name order by ordinal))[1] as display_name,
      (array_agg(name_key order by ordinal))[1] as name_key,
      (array_agg(annotation_key order by ordinal))[1] as annotation_key
    from master_normalized
    group by source_key
  ), jwb_source_values as materialized (
    select internal.student_import_source_key(jwb.value -> 'sourceRow') as source_key,
      jwb.value as row_value,
      jwb.ordinality as ordinal,
      internal.student_import_display_name(jwb.value ->> 'name') as display_name
    from jsonb_array_elements(p_jwb_rows) with ordinality jwb(value, ordinality)
  ), jwb_normalized as materialized (
    select source_key, row_value, ordinal, display_name,
      internal.student_import_annotation_name_key_from_display_name(
        display_name
      ) as name_key,
      internal.student_import_jwb_annotation_key_from_display(
        display_name
      ) as annotation_key
    from jwb_source_values
  ), jwb_rows as materialized (
    select source_key,
      count(*)::integer as source_count,
      (array_agg(row_value order by ordinal))[1] as row_value,
      (array_agg(display_name order by ordinal))[1] as display_name,
      (array_agg(name_key order by ordinal))[1] as name_key,
      (array_agg(annotation_key order by ordinal))[1] as annotation_key
    from jwb_normalized
    group by source_key
  ), master_link_counts as (
    select master_key, count(*)::integer as link_count
    from links
    where master_key is not null and master_key <> ''
    group by master_key
  ), jwb_link_counts as (
    select jwb_key, count(*)::integer as link_count
    from links
    where has_jwb_leg and jwb_key is not null
    group by jwb_key
  ), master_annotation_counts as (
    select coalesce(nullif(annotation_key, ''), name_key) as relaxed_key,
      count(*)::integer as row_count
    from master_normalized
    group by coalesce(nullif(annotation_key, ''), name_key)
  ), jwb_annotation_counts as (
    select coalesce(nullif(annotation_key, ''), name_key) as relaxed_key,
      count(*)::integer as row_count
    from jwb_normalized
    group by coalesce(nullif(annotation_key, ''), name_key)
  ), evaluated_links as ($safe_link_cte_replacement$);

  anchor := $safe_link_key_lookup_anchor$      internal.student_import_name_key(master_rows.row_value ->> 'name') as master_name_key,
      internal.student_import_name_key(jwb_rows.row_value ->> 'name') as jwb_name_key,
      internal.student_import_jwb_latin_parenthetical_annotation_key(
        jwb_rows.row_value ->> 'name'
      ) as jwb_annotation_key,
      internal.student_import_display_name(master_rows.row_value ->> 'name') as master_display_name$safe_link_key_lookup_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_safe_link_normalization_key_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $safe_link_key_lookup_replacement$      master_rows.name_key as master_name_key,
      jwb_rows.name_key as jwb_name_key,
      jwb_rows.annotation_key as jwb_annotation_key,
      master_rows.display_name as master_display_name$safe_link_key_lookup_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if position('master_source_values as materialized' in definition) = 0
     or position('jwb_source_values as materialized' in definition) = 0
     or position('internal.student_import_annotation_name_key_from_display_name(' in definition) = 0
     or position('internal.student_import_jwb_annotation_key_from_display(' in definition) = 0
     or position('master_rows.name_key as master_name_key' in definition) = 0
     or position('jwb_rows.annotation_key as jwb_annotation_key' in definition) = 0
     or position(anchor in definition) <> 0 then
    raise exception using errcode = 'P0001', message = 'student_import_safe_link_normalization_patch_verification_failed';
  end if;
end;
$student_import_safe_link_normalization$;
