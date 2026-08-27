-- The active master-authoritative wrapper used a per-student scan of the
-- complete JWB array after the base projection. Build source/id maps once so
-- the bilingual batch remains bounded at the current 602/1043 source size.
do $student_import_wrapper_lookup_patch$
declare
  definition text;
  anchor text;
  replacement text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_projection_wrapper_missing';
  end if;

  -- The chronological fresh path is already optimized by 20260818000100:
  -- it has the equivalent lookup maps under the current_* names and no old
  -- scans left to replace.  Production may instead already have this
  -- migration's student_by_id/jwb_by_source names.  Both shapes are safe
  -- no-ops here; the guard prevents this later migration from colliding with
  -- the accumulator declaration rewrite in 20260818000200.
  if (
    (
      position('current_student_by_id jsonb := ''{}''::jsonb' in definition) > 0
      and position('matched_jwb_by_source jsonb := ''{}''::jsonb' in definition) > 0
    )
    or (
      position('student_by_id jsonb := ''{}''::jsonb' in definition) > 0
      and position('jwb_by_source jsonb := ''{}''::jsonb' in definition) > 0
    )
  )
  and position('select student into existing_student' in definition) = 0
  and position('select jwb into matched_jwb' in definition) = 0 then
    return;
  end if;

  anchor := '  result jsonb := ''[]''::jsonb;';
  replacement := $decl$  jwb_by_source jsonb := '{}'::jsonb;
  student_by_id jsonb := '{}'::jsonb;
  result jsonb := '[]'::jsonb;$decl$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_projection_wrapper_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := '  base_projection := internal.student_import_canonical_projection_170008_base(';
  replacement := $lookup$  select coalesce(jsonb_object_agg(
    internal.student_import_source_key(jwb -> 'sourceRow'), jwb
  ), '{}'::jsonb)
  into jwb_by_source
  from jsonb_array_elements(p_jwb_rows) jwb;

  select coalesce(jsonb_object_agg(student ->> 'id', student), '{}'::jsonb)
  into student_by_id
  from jsonb_array_elements(p_current_students) student
  where jsonb_typeof(student -> 'id') = 'string'
    and nullif(trim(student ->> 'id'), '') is not null;

  base_projection := internal.student_import_canonical_projection_170008_base($lookup$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_projection_wrapper_lookup_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := $existing$    existing_student := null;
    select student into existing_student
    from jsonb_array_elements(p_current_students) student
    where student ->> 'id' = base_student ->> 'id';$existing$;
  replacement := $existing$    existing_student := student_by_id -> (base_student ->> 'id');$existing$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_projection_wrapper_student_lookup_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := $matched$    matched_jwb := null;
    if base_student ? 'jwbSourceRow' then
      select jwb into matched_jwb
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_source_key(jwb -> 'sourceRow') =
        internal.student_import_source_key(base_student -> 'jwbSourceRow');
    end if;$matched$;
  replacement := $matched$    matched_jwb := case
      when base_student ? 'jwbSourceRow'
        then jwb_by_source -> internal.student_import_source_key(base_student -> 'jwbSourceRow')
      else null
    end;$matched$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_projection_wrapper_jwb_lookup_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, replacement);

  execute definition;
end;
$student_import_wrapper_lookup_patch$;

revoke all on function internal.student_import_canonical_projection(
  text, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated;
