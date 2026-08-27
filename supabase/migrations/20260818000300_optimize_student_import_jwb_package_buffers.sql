-- The package canonicalizer appends JSONB arrays once per purchase and once
-- per package.  That repeatedly copies the already-built package payload.
-- Keep every validation, generated ID, total, and output ordering rule intact;
-- buffer the completed JSONB objects in native arrays and convert once.

set local lock_timeout = '1s';

do $student_import_jwb_package_accumulator_buffer$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_jwb_packages(text,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_package_accumulator_function_missing';
  end if;

  anchor := $declaration_anchor$  result jsonb := '[]'::jsonb;
  purchases jsonb;
$declaration_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_package_accumulator_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $declaration_replacement$  result jsonb;
  result_items jsonb[] := array[]::jsonb[];
  purchases_items jsonb[];
$declaration_replacement$);

  anchor := '    purchases := ''[]''::jsonb;';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_package_accumulator_purchase_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '    purchases_items := array[]::jsonb[];');

  anchor := '      purchases := purchases || jsonb_build_array(purchase_value);';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_package_accumulator_purchase_append_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, '      purchases_items := array_append(purchases_items, purchase_value);');

  anchor := $package_append_anchor$    result := result || jsonb_build_array(jsonb_build_object(
      'id', package_id,
      'name', clean_name,
      'subjectIds', subjects,
      'purchaseRecords', purchases,
      'consumedHours', (package_value ->> 'consumedHours')::numeric
    ));$package_append_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_package_accumulator_package_append_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $package_append_replacement$    result_items := array_append(result_items, jsonb_build_object(
      'id', package_id,
      'name', clean_name,
      'subjectIds', subjects,
      'purchaseRecords', coalesce(to_jsonb(purchases_items), '[]'::jsonb),
      'consumedHours', (package_value ->> 'consumedHours')::numeric
    ));$package_append_replacement$);

  anchor := $total_anchor$  end loop;

  select coalesce(sum((purchase.value ->> 'hours')::numeric), 0)$total_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_package_accumulator_total_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $total_replacement$  end loop;

  result := coalesce(to_jsonb(result_items), '[]'::jsonb);
  select coalesce(sum((purchase.value ->> 'hours')::numeric), 0)$total_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_jwb_packages(text,jsonb)'::regprocedure
  ) into definition;
  if position('result_items jsonb[]' in definition) = 0
     or position('purchases_items jsonb[]' in definition) = 0
     or position('purchases_items := array_append(purchases_items, purchase_value);' in definition) = 0
     or position('result_items := array_append(result_items, jsonb_build_object(' in definition) = 0
     or position('result := coalesce(to_jsonb(result_items), ''[]''::jsonb);' in definition) = 0
     or position('purchases := purchases || jsonb_build_array(purchase_value);' in definition) <> 0
     or position('result := result || jsonb_build_array(jsonb_build_object(' in definition) <> 0 then
    raise exception using errcode = 'P0001', message = 'student_import_jwb_package_accumulator_patch_verification_failed';
  end if;
end;
$student_import_jwb_package_accumulator_buffer$;
