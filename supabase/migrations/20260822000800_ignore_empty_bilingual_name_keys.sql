-- Do not count rows whose automatic bilingual key is empty.  A display name
-- with no single contiguous CJK run is intentionally unmatched; grouping all
-- such rows under '' would manufacture a large ambiguity set and diverge from
-- the TypeScript planner (which skips empty keys).
do $student_import_empty_bilingual_key_patch$
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
    raise exception using errcode = 'P0001', message = 'student_import_projection_base_missing_for_empty_key_patch';
  end if;

  anchor := $master_anchor$      and nullif(internal.student_import_source_key(master -> 'jwbMemId'), '') is null
      and not (link_by_master ? internal.student_import_source_key(master -> 'sourceRow'))$master_anchor$;
  replacement := $master_replacement$      and nullif(internal.student_import_source_key(master -> 'jwbMemId'), '') is null
      and internal.student_import_jwb_auto_name_key(master ->> 'name') <> ''
      and not (link_by_master ? internal.student_import_source_key(master -> 'sourceRow'))$master_replacement$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_master_empty_key_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := $jwb_anchor$      and not (linked_jwb_source_ids ? internal.student_import_source_key(jwb.value -> 'sourceRow'))
      and not (declared_member_ids ? internal.student_import_source_key(jwb.value -> 'sourceRow'))$jwb_anchor$;
  replacement := $jwb_replacement$      and internal.student_import_jwb_auto_name_key(jwb.value ->> 'name') <> ''
      and not (linked_jwb_source_ids ? internal.student_import_source_key(jwb.value -> 'sourceRow'))
      and not (declared_member_ids ? internal.student_import_source_key(jwb.value -> 'sourceRow'))$jwb_replacement$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_empty_key_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  execute definition;
end;
$student_import_empty_bilingual_key_patch$;

revoke all on function internal.student_import_canonical_projection_170008_base(
  text, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;

do $$
begin
  if internal.student_import_jwb_auto_name_key('Alice 张三 王') <> '' then
    raise exception using errcode = '22023', message = 'student_import_empty_bilingual_key_fixture_mismatch';
  end if;
end;
$$;
