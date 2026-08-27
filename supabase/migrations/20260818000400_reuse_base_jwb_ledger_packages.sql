-- The hardened base projection has already canonicalized current JWB package
-- rows with the final student ID.  The master-authoritative wrapper used to
-- canonicalize that identical current ledger a second time before selecting
-- its active PKG-JWB rows.  Reuse the base result instead: global validation
-- and the base canonicalizer remain unchanged, while the wrapper only filters
-- its already-canonical current JWB packages in their existing ordinal order.

set local lock_timeout = '1s';

do $student_import_reuse_base_jwb_ledger_packages$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_reuse_base_jwb_ledger_wrapper_missing';
  end if;

  anchor := $active_jwb_packages_anchor$    active_jwb_packages := case
      when matched_jwb is not null
       and matched_jwb ? 'lessonPackages'
       and current_coverage in ('complete', 'partial')
        then internal.student_import_canonical_jwb_packages(
          base_student ->> 'id', matched_jwb -> 'lessonPackages'
        )
      else '[]'::jsonb
    end;$active_jwb_packages_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_reuse_base_jwb_ledger_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $active_jwb_packages_replacement$    active_jwb_packages := case
      when matched_jwb is not null
       and matched_jwb ? 'lessonPackages'
       and current_coverage in ('complete', 'partial')
        then coalesce((
          select jsonb_agg(package.value order by package.ordinal)
          from jsonb_array_elements(coalesce(base_student -> 'lessonPackages', '[]'::jsonb))
            with ordinality package(value, ordinal)
          where coalesce(package.value ->> 'id', '') like 'PKG-JWB-%'
        ), '[]'::jsonb)
      else '[]'::jsonb
    end;$active_jwb_packages_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if position('from jsonb_array_elements(coalesce(base_student -> ''lessonPackages'', ''[]''::jsonb))' in definition) = 0
     or position('where coalesce(package.value ->> ''id'', '''') like ''PKG-JWB-%''' in definition) = 0
     or position(anchor in definition) <> 0 then
    raise exception using errcode = 'P0001', message = 'student_import_reuse_base_jwb_ledger_patch_verification_failed';
  end if;
end;
$student_import_reuse_base_jwb_ledger_packages$;
