-- A second conservative name-only fallback handles a unique reordered ASCII
-- display name (`Alice Smith` vs `Smith Alice`). It never uses one token,
-- initials, age, surname, or edit distance; Chinese/bilingual names continue
-- to use the unique Chinese-core helper from 220005/220006.
create or replace function internal.student_import_jwb_name_token_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  with tokens as (
    select pg_catalog.lower(match[1]) as token
    from pg_catalog.regexp_matches(
      internal.student_import_display_name(p_name),
      '([A-Za-z0-9]+)',
      'g'
    ) match
  ), distinct_tokens as (
    select token from tokens group by token
  ), aggregate_value as (
    select count(*)::integer as token_count,
      pg_catalog.string_agg(token, '|' order by token) as token_key
    from distinct_tokens
  )
  select case when token_count >= 2 then token_key else ''::text end
  from aggregate_value
$$;

revoke all on function internal.student_import_jwb_name_token_key(text)
  from public, anon, authenticated;

do $$
begin
  if internal.student_import_jwb_name_token_key('Alice Smith') <> 'alice|smith'
     or internal.student_import_jwb_name_token_key('Smith Alice') <> 'alice|smith'
     or internal.student_import_jwb_name_token_key('Alice') <> ''
     or internal.student_import_jwb_name_token_key('Alice 张三') <> '' then
    raise exception using errcode = '22023', message = 'student_import_reordered_name_token_fixture_mismatch';
  end if;
end;
$$;

do $student_import_reordered_token_patch$
declare
  definition text;
  anchor text;
  replacement text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_projection_base_missing_for_reordered_token_patch';
  end if;

  anchor := '  name_key text;';
  replacement := $decl$  name_key text;
  name_token_key text;$decl$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_reordered_token_name_declaration_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := '  jwb_auto_name_entries jsonb := ''{}''::jsonb;';
  replacement := $decl$  jwb_auto_name_entries jsonb := '{}'::jsonb;
  master_auto_name_token_counts jsonb := '{}'::jsonb;
  jwb_auto_name_token_entries jsonb := '{}'::jsonb;$decl$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_reordered_token_map_declaration_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := $master_anchor$  into master_auto_name_counts
  from grouped;$master_anchor$;
  replacement := $master_map$  into master_auto_name_counts
  from grouped;

  with candidates as (
    select internal.student_import_jwb_name_token_key(master ->> 'name') as token_key
    from jsonb_array_elements(p_resolved_master_rows) master
    where internal.student_import_jwb_name_token_key(master ->> 'name') <> ''
      and internal.student_import_display_name(master ->> 'name') <> ''
      and master ->> 'status' <> '不活跃 + 无课时'
      and nullif(internal.student_import_source_key(master -> 'jwbMemId'), '') is null
      and not (link_by_master ? internal.student_import_source_key(master -> 'sourceRow'))
  ), grouped as (
    select token_key, count(*)::integer as name_count
    from candidates
    group by token_key
  )
  select coalesce(jsonb_object_agg(token_key, to_jsonb(name_count)), '{}'::jsonb)
  into master_auto_name_token_counts
  from grouped;$master_map$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_reordered_token_master_map_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := $jwb_anchor$  into jwb_auto_name_entries
  from grouped;$jwb_anchor$;
  replacement := $jwb_map$  into jwb_auto_name_entries
  from grouped;

  with candidates as (
    select internal.student_import_jwb_name_token_key(jwb.value ->> 'name') as token_key,
      jwb.value as candidate_row,
      jwb.ordinality as ordinal
    from jsonb_array_elements(p_jwb_rows) with ordinality jwb(value, ordinality)
    where internal.student_import_jwb_name_token_key(jwb.value ->> 'name') <> ''
      and internal.student_import_display_name(jwb.value ->> 'name') <> ''
      and not (linked_jwb_source_ids ? internal.student_import_source_key(jwb.value -> 'sourceRow'))
      and not (declared_member_ids ? internal.student_import_source_key(jwb.value -> 'sourceRow'))
  ), grouped as (
    select token_key, count(*)::integer as name_count,
      (jsonb_agg(candidate_row order by ordinal) -> 0) as candidate_row
    from candidates
    group by token_key
  )
  select coalesce(jsonb_object_agg(
    token_key, jsonb_build_object('count', name_count, 'row', candidate_row)
  ), '{}'::jsonb)
  into jwb_auto_name_token_entries
  from grouped;$jwb_map$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_reordered_token_jwb_map_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := '    name_key := internal.student_import_jwb_auto_name_key(clean_name);';
  replacement := $assign$    name_key := internal.student_import_jwb_auto_name_key(clean_name);
    name_token_key := internal.student_import_jwb_name_token_key(clean_name);$assign$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_reordered_token_assignment_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := $match$    elsif not linked and master_jwb_member_id_safe then
      master_name_count := coalesce((master_auto_name_counts ->> name_key)::integer, 0);
      jwb_name_count := coalesce(
        ((jwb_auto_name_entries -> name_key) ->> 'count')::integer, 0
      );
      if master_name_count = 1 and jwb_name_count = 1 then
        matched_jwb := (jwb_auto_name_entries -> name_key) -> 'row';
      end if;$match$;
  replacement := $match$    elsif not linked and master_jwb_member_id_safe then
      master_name_count := coalesce((master_auto_name_counts ->> name_key)::integer, 0);
      jwb_name_count := coalesce(
        ((jwb_auto_name_entries -> name_key) ->> 'count')::integer, 0
      );
      if master_name_count = 1 and jwb_name_count = 1 then
        matched_jwb := (jwb_auto_name_entries -> name_key) -> 'row';
      elsif name_token_key <> '' then
        master_name_count := coalesce((master_auto_name_token_counts ->> name_token_key)::integer, 0);
        jwb_name_count := coalesce(
          ((jwb_auto_name_token_entries -> name_token_key) ->> 'count')::integer, 0
        );
        if master_name_count = 1 and jwb_name_count = 1 then
          matched_jwb := (jwb_auto_name_token_entries -> name_token_key) -> 'row';
        end if;
      end if;$match$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_reordered_token_matching_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  execute definition;
end;
$student_import_reordered_token_patch$;

revoke all on function internal.student_import_canonical_projection_170008_base(
  text, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
