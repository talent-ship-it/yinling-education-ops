-- Student identities are source-owned. A total-sheet row may attach to a JWB
-- account only when the complete names are equal after the narrow shared
-- cleanup: NFKC, invisible-character removal, whitespace collapse and
-- ASCII-only case folding. Chinese-character extraction and punctuation
-- deletion are deliberately not identity rules.
create or replace function internal.student_import_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.translate(
    internal.student_import_display_name(p_name),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz'
  )
$$;

revoke all on function internal.student_import_name_key(text)
  from public, anon, authenticated;

-- The review RPCs, including the bulk review variants, call this legacy-named
-- helper. Rebind it to the same strict full-name key so no review flow can
-- revive the former contiguous-Han-run alias behavior.
create or replace function internal.student_import_master_review_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select internal.student_import_name_key(p_name)
$$;

revoke all on function internal.student_import_master_review_name_key(text)
  from public, anon, authenticated;

-- Keep the retired helper as a compatibility stub instead of dropping it:
-- deployed databases may have an internal dependency created by an older
-- hotfix. Returning an empty key makes any such unexpected call fail closed,
-- while every current automatic and review path is rebound above to the
-- strict full-name key.
create or replace function internal.student_import_cjk_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select ''::text
$$;

revoke all on function internal.student_import_cjk_name_key(text)
  from public, anon, authenticated;

-- This check is shared by the write trigger and the canonical projection.
-- It deliberately retains old reviewed rows: a historical non-exact link is
-- not deleted or rewritten, but it cannot be used to create a student import.
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
      where link.value ? 'jwbSourceRow'
        and (
          master_match.row_value is null
          or jwb_match.row_value is null
          or internal.student_import_name_key(master_match.row_value ->> 'name') = ''
          or internal.student_import_name_key(master_match.row_value ->> 'name') <>
             internal.student_import_name_key(jwb_match.row_value ->> 'name')
        )
    )
  end
$$;

revoke all on function internal.student_import_identity_link_names_mismatch(jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- A reviewed merge also asserts that the authoritative master row and its
-- current system record are the same complete name. A reviewed create points
-- to a not-yet-existing deterministic ID and is validated separately by the
-- canonical projection, so it is deliberately not treated as a mismatch here.
create or replace function internal.student_import_identity_link_existing_names_mismatch(
  p_master_rows jsonb,
  p_current_students jsonb,
  p_links jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_master_rows) <> 'array'
      or jsonb_typeof(p_current_students) <> 'array'
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
      join lateral (
        select current_student.value as row_value
        from jsonb_array_elements(p_current_students) current_student(value)
        where jsonb_typeof(current_student.value -> 'id') = 'string'
          and internal.student_import_js_trim(current_student.value ->> 'id') =
            internal.student_import_js_trim(link.value ->> 'studentId')
      ) current_match on true
      where master_match.row_value is null
        or internal.student_import_name_key(master_match.row_value ->> 'name') = ''
        or internal.student_import_name_key(master_match.row_value ->> 'name') <>
          internal.student_import_name_key(current_match.row_value ->> 'name')
    )
  end
$$;

revoke all on function internal.student_import_identity_link_existing_names_mismatch(jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- Every identity-link write path, including legacy and bulk review RPCs,
-- converges on this one table. The trigger closes all of them without
-- deleting historical rows that may now need teaching-office correction.
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
  return new;
end;
$$;

drop trigger if exists enforce_student_import_identity_link_exact_names
  on internal.student_import_identity_link_sets;
create trigger enforce_student_import_identity_link_exact_names
before insert or update on internal.student_import_identity_link_sets
for each row execute function internal.enforce_student_import_identity_link_exact_names();

revoke all on function internal.enforce_student_import_identity_link_exact_names()
  from public, anon, authenticated;

-- The final import/replay boundary must also reject a non-exact historical
-- reviewed link. Patch the live canonical projection instead of duplicating
-- its large, already-number-aware body from prior migrations.
do $$
declare
  projection_definition text;
  projection_marker text := $marker$
  -- Validate every locked JWB package ledger, including unmatched rows. A
  -- malformed nested row can therefore never hide outside the master roster.
$marker$;
  strict_link_guard text := $guard$
  if internal.student_import_identity_link_names_mismatch(
    p_resolved_master_rows, p_jwb_rows, p_identity_links
  ) or internal.student_import_identity_link_existing_names_mismatch(
    p_resolved_master_rows, p_current_students, p_identity_links
  ) then
    raise exception using
      errcode = '22023',
      message = 'student_import_identity_link_name_mismatch';
  end if;

$guard$;
begin
  projection_definition := pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  );
  if position('student_import_identity_link_names_mismatch' in projection_definition) > 0 then
    raise exception using errcode = '55000',
      message = 'student_import_exact_name_projection_already_patched';
  end if;
  if position(projection_marker in projection_definition) = 0 then
    raise exception using errcode = '55000',
      message = 'student_import_exact_name_projection_patch_anchor_missing';
  end if;
  projection_definition := replace(
    projection_definition,
    projection_marker,
    strict_link_guard || projection_marker
  );
  execute projection_definition;
  if position('student_import_identity_link_names_mismatch' in pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  )) = 0 then
    raise exception using errcode = '55000',
      message = 'student_import_exact_name_projection_patch_missing';
  end if;
end;
$$;

-- Migration-time fixtures prove the strict name rule at both the direct
-- automatic path and the reviewed-link fail-closed path.
do $$
declare
  exact_projection jsonb;
  mismatch_projection jsonb;
begin
  if internal.student_import_name_key('  Ａvery   Example  ') <> 'avery example'
     or internal.student_import_name_key('ÉLODIE') <> 'Élodie'
     or internal.student_import_name_key('张·三') =
        internal.student_import_name_key('张（三）')
     or internal.student_import_master_review_name_key('Alice 张三') =
        internal.student_import_master_review_name_key('张三')
     or internal.student_import_master_review_name_key(' Ａvery   Example ') <>
        internal.student_import_master_review_name_key('avery example') then
    raise exception using errcode = '22023',
      message = 'student_import_exact_name_review_key_fixture_mismatch';
  end if;

  exact_projection := internal.student_import_canonical_projection(
    'exact-name-fixture',
    '[{"sourceRow":"M-1","name":" Ａvery   Example ","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-1","name":"avery example","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb
  );
  if exact_projection #>> '{0,jwbMatchStatus}' <> 'matched'
     or exact_projection #>> '{0,jwbSourceRow}' <> 'J-1' then
    raise exception using errcode = '22023',
      message = 'student_import_exact_name_projection_match_fixture_mismatch';
  end if;

  mismatch_projection := internal.student_import_canonical_projection(
    'exact-name-fixture',
    '[{"sourceRow":"M-2","name":"张·三","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-2","name":"张（三）","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb
  );
  if mismatch_projection #>> '{0,jwbMatchStatus}' <> 'unmatched'
     or (mismatch_projection -> 0) ? 'jwbSourceRow' then
    raise exception using errcode = '22023',
      message = 'student_import_exact_name_projection_mismatch_fixture_mismatch';
  end if;

  begin
    perform internal.student_import_canonical_projection(
      'exact-name-fixture',
      '[{"sourceRow":"M-3","name":"张·三","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-3","name":"张（三）","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'masterSourceRow', 'M-3',
        'jwbSourceRow', 'J-3',
        'studentId', internal.student_import_student_id(
          'exact-name-fixture', to_jsonb('M-3'::text)
        )
      )),
      '[]'::jsonb
    );
    raise exception using errcode = '22023',
      message = 'student_import_exact_name_projection_review_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'student_import_identity_link_name_mismatch' then
      raise;
    end if;
  end;

  begin
    perform internal.student_import_canonical_projection(
      'exact-name-fixture',
      '[{"sourceRow":"M-4","name":"Exact Learner","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-4","name":"exact learner","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      jsonb_build_array(jsonb_build_object(
        'id', internal.student_import_student_id(
          'exact-name-fixture', to_jsonb('M-4'::text)
        ),
        'name', 'Different Current Student'
      )),
      jsonb_build_array(jsonb_build_object(
        'masterSourceRow', 'M-4',
        'jwbSourceRow', 'J-4',
        'studentId', internal.student_import_student_id(
          'exact-name-fixture', to_jsonb('M-4'::text)
        )
      )),
      '[]'::jsonb
    );
    raise exception using errcode = '22023',
      message = 'student_import_exact_name_projection_existing_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'student_import_identity_link_name_mismatch' then
      raise;
    end if;
  end;
end;
$$;
