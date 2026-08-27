-- JWB commonly stores one learner as Chinese-only in one export and as a
-- Chinese + English display name in another. Keep the strict full-name key as
-- the source identity contract, but let the canonical JWB enrichment path use
-- one unique contiguous Chinese name run as a second, fail-closed key.
create or replace function internal.student_import_jwb_auto_name_key(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  display_name text := internal.student_import_display_name(p_name);
  result text := '';
  character_value text;
  code_point integer;
  character_position integer;
  run_count integer := 0;
  in_cjk_run boolean := false;
begin
  if display_name = '' then
    return '';
  end if;
  for character_position in 1..pg_catalog.char_length(display_name) loop
    character_value := pg_catalog.substr(display_name, character_position, 1);
    code_point := pg_catalog.ascii(character_value);
    if (code_point between 13312 and 19903)
       or (code_point between 19968 and 40959)
       or (code_point between 63744 and 64255)
       or (code_point between 131072 and 195103)
       or (code_point between 196608 and 201551) then
      if not in_cjk_run then
        run_count := run_count + 1;
      end if;
      result := result || character_value;
      in_cjk_run := true;
    else
      in_cjk_run := false;
    end if;
  end loop;
  return case when run_count = 1 and pg_catalog.char_length(result) >= 2
    then result else '' end;
end;
$$;

revoke all on function internal.student_import_jwb_auto_name_key(text)
  from public, anon, authenticated;

-- The active 170008 base projection is already the reviewed canonical
-- implementation. Patch only its automatic JWB name key: explicit identity
-- links and member-ID checks continue to use the strict key.
do $bilingual_jwb_projection_patch$
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
    raise exception using errcode = 'P0001', message = 'bilingual_jwb_projection_base_missing';
  end if;

  anchor := 'name_key := internal.student_import_name_key(clean_name);';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'bilingual_jwb_name_assignment_anchor_mismatch';
  end if;
  definition := replace(
    definition,
    anchor,
    'name_key := internal.student_import_jwb_auto_name_key(clean_name);'
  );

  anchor := 'select internal.student_import_name_key(master ->> ''name'') as auto_name_key';
  replacement := 'select internal.student_import_jwb_auto_name_key(master ->> ''name'') as auto_name_key';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'bilingual_jwb_master_map_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := 'internal.student_import_name_key(jwb.value ->> ''name'') as auto_name_key';
  replacement := 'internal.student_import_jwb_auto_name_key(jwb.value ->> ''name'') as auto_name_key';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'bilingual_jwb_source_map_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  execute definition;
end;
$bilingual_jwb_projection_patch$;

revoke all on function internal.student_import_canonical_projection_170008_base(
  text, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
