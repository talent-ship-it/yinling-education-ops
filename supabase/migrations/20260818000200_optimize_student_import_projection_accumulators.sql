-- The formal import's two canonical-projection loops append a full JSONB
-- array on every row.  Each append copies the complete accumulated payload,
-- so real 543-row roster output grows quadratically even after lookup maps
-- remove the per-row source scans.  Keep loop order and every validation
-- branch unchanged; buffer the already-built row JSONB values in native
-- PostgreSQL arrays and convert each ordered buffer to JSONB once at return.

set local lock_timeout = '1s';

do $student_import_base_projection_accumulator_buffer$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_base_projection_accumulator_function_missing';
  end if;

  anchor := $base_declaration_anchor$  formal_students jsonb := '[]'::jsonb;
  manual_trials jsonb := '[]'::jsonb;
$base_declaration_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_base_projection_accumulator_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $base_declaration_replacement$  formal_student_items jsonb[] := array[]::jsonb[];
  manual_trials jsonb := '[]'::jsonb;
$base_declaration_replacement$);

  anchor := '    formal_students := formal_students || jsonb_build_array(record_value);';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_base_projection_accumulator_append_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '    formal_student_items := array_append(formal_student_items, record_value);');

  anchor := '  record_value := formal_students || manual_trials || referenced_archives;';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_base_projection_accumulator_return_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '  record_value := coalesce(to_jsonb(formal_student_items), ''[]''::jsonb) || manual_trials || referenced_archives;');

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if position('formal_student_items jsonb[]' in definition) = 0
     or position('formal_student_items := array_append(formal_student_items, record_value);' in definition) = 0
     or position('coalesce(to_jsonb(formal_student_items), ''[]''::jsonb)' in definition) = 0
     or position('formal_students := formal_students || jsonb_build_array(record_value);' in definition) <> 0 then
    raise exception using errcode = 'P0001', message = 'student_import_base_projection_accumulator_patch_verification_failed';
  end if;
end;
$student_import_base_projection_accumulator_buffer$;

do $student_import_outer_projection_accumulator_buffer$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_outer_projection_accumulator_function_missing';
  end if;

  -- Keep every wrapper declaration that earlier/later migrations own
  -- (including effective_identity_links and either lookup-map naming) and
  -- replace only the result accumulator declaration.  20260822000700 puts
  -- its maps between safe_identity_links and result, so the old contiguous
  -- declaration anchor was not forward-safe.
  anchor := '  result jsonb := ''[]''::jsonb;';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_outer_projection_accumulator_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '  projection_items jsonb[] := array[]::jsonb[];');

  anchor := '      result := result || jsonb_build_array(base_student);';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_outer_projection_accumulator_base_append_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '      projection_items := array_append(projection_items, base_student);');

  anchor := '    result := result || jsonb_build_array(record_value);';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_outer_projection_accumulator_record_append_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '    projection_items := array_append(projection_items, record_value);');

  anchor := '  return result;';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_outer_projection_accumulator_return_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '  return coalesce(to_jsonb(projection_items), ''[]''::jsonb);');

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if position('projection_items jsonb[]' in definition) = 0
     or position('projection_items := array_append(projection_items, base_student);' in definition) = 0
     or position('projection_items := array_append(projection_items, record_value);' in definition) = 0
     or position('return coalesce(to_jsonb(projection_items), ''[]''::jsonb);' in definition) = 0
     or position('result := result || jsonb_build_array(' in definition) <> 0 then
    raise exception using errcode = 'P0001', message = 'student_import_outer_projection_accumulator_patch_verification_failed';
  end if;
end;
$student_import_outer_projection_accumulator_buffer$;
