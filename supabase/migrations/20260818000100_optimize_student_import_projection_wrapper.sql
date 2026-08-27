-- The Tencent-master import must complete within the hosted request budget.
--
-- 20260817000800 made the hardened base projection set-based, but its outer
-- active-ledger wrapper still looked up the current student and matched JWB
-- row by re-expanding the full JSON arrays for every projected student.  On
-- the real 543-master / 1038-JWB / 502-current-state input that is enough to
-- exhaust the request budget before the commit reaches its atomic update.
--
-- Keep every identity, package, snapshot, and number-allocation rule exactly
-- as-is.  This forward patch only builds two first-ordinal lookup maps once
-- after the base projection has succeeded, then uses O(1) JSON lookups inside
-- the existing wrapper loop.  The dynamic anchors deliberately fail closed if
-- a future migration has changed the audited wrapper shape.

set local lock_timeout = '1s';

do $student_import_projection_wrapper_lookup_maps$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_projection_wrapper_missing';
  end if;

  anchor := $projection_declarations$  source_contract numeric;
  safe_identity_links jsonb := '[]'::jsonb;
$projection_declarations$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_projection_wrapper_map_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_declarations_replacement$  source_contract numeric;
  current_student_by_id jsonb := '{}'::jsonb;
  matched_jwb_by_source jsonb := '{}'::jsonb;
  safe_identity_links jsonb := '[]'::jsonb;
$projection_declarations_replacement$);

  anchor := $base_projection_anchor$  base_projection := internal.student_import_canonical_projection_170008_base(
    p_master_source_id,
    p_resolved_master_rows,
    p_jwb_rows,
    p_current_students,
    safe_identity_links,
    p_referenced_student_ids
  );
$base_projection_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_projection_wrapper_base_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, anchor || $projection_lookup_maps$

  -- Preserve the original `SELECT ... INTO` first-array-element behavior for
  -- malformed duplicate keys as well as normal valid input.  The hardened
  -- base continues to own source-shape validation; these maps only replace
  -- repeated read-only lookup work after it has returned successfully.
  select coalesce(jsonb_object_agg(student_id, student_value), '{}'::jsonb)
  into current_student_by_id
  from (
    select distinct on (student.value ->> 'id')
      student.value ->> 'id' as student_id,
      student.value as student_value
    from jsonb_array_elements(p_current_students) with ordinality student(value, ordinal)
    where student.value ->> 'id' is not null
    order by student.value ->> 'id', student.ordinal
  ) current_student_map;

  select coalesce(jsonb_object_agg(source_key, jwb_value), '{}'::jsonb)
  into matched_jwb_by_source
  from (
    select distinct on (internal.student_import_source_key(jwb.value -> 'sourceRow'))
      internal.student_import_source_key(jwb.value -> 'sourceRow') as source_key,
      jwb.value as jwb_value
    from jsonb_array_elements(p_jwb_rows) with ordinality jwb(value, ordinal)
    where nullif(internal.student_import_source_key(jwb.value -> 'sourceRow'), '') is not null
    order by internal.student_import_source_key(jwb.value -> 'sourceRow'), jwb.ordinal
  ) matched_jwb_map;
$projection_lookup_maps$);

  anchor := $projection_lookup_anchor$    existing_student := null;
    select student into existing_student
    from jsonb_array_elements(p_current_students) student
    where student ->> 'id' = base_student ->> 'id';

    matched_jwb := null;
    if base_student ? 'jwbSourceRow' then
      select jwb into matched_jwb
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_source_key(jwb -> 'sourceRow') =
        internal.student_import_source_key(base_student -> 'jwbSourceRow');
    end if;
$projection_lookup_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_projection_wrapper_lookup_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $projection_lookup_replacement$    existing_student := current_student_by_id -> (base_student ->> 'id');
    matched_jwb := case when base_student ? 'jwbSourceRow' then
      matched_jwb_by_source -> internal.student_import_source_key(
        base_student -> 'jwbSourceRow'
      )
      else null
    end;
$projection_lookup_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if position('current_student_by_id jsonb := ''{}''::jsonb' in definition) = 0
     or position('matched_jwb_by_source jsonb := ''{}''::jsonb' in definition) = 0
     or position('existing_student := current_student_by_id -> (base_student ->> ''id'');' in definition) = 0
     or position('matched_jwb_by_source -> internal.student_import_source_key(' in definition) = 0
     or position('existing_student := null;' in definition) <> 0
     or position('select student into existing_student' in definition) <> 0
     or position('select jwb into matched_jwb' in definition) <> 0 then
    raise exception using errcode = 'P0001', message = 'student_import_projection_wrapper_lookup_patch_verification_failed';
  end if;
end;
$student_import_projection_wrapper_lookup_maps$;
