-- `jwbMemId` is the normalized import field for the authoritative Tencent
-- master-sheet column `教务宝学员编号`. It is intentionally a narrow
-- disambiguator, not a second identity rule: it may choose only a JWB row
-- whose complete safe-normalized display name still equals the master row.

create or replace function internal.student_import_master_jwb_member_id_error(
  p_master_rows jsonb,
  p_jwb_rows jsonb,
  p_identity_links jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  master_item record;
  master_row jsonb;
  matched_jwb jsonb;
  master_source_key text;
  member_id text;
  match_count integer;
begin
  if jsonb_typeof(p_master_rows) <> 'array'
     or jsonb_typeof(p_jwb_rows) <> 'array'
     or jsonb_typeof(p_identity_links) <> 'array' then
    return 'invalid_student_import_master_jwb_member_id';
  end if;

  -- Blank spreadsheet cells are absence. Every non-blank value, including
  -- one on an otherwise excluded master row, uses the same source-key
  -- contract as JWB `mem_id` / normalized JWB `sourceRow`.
  if exists (
    select 1
    from jsonb_array_elements(p_master_rows) master(value)
    where master.value ? 'jwbMemId'
      and (
        jsonb_typeof(master.value -> 'jwbMemId') not in ('string', 'number', 'null')
        or (
          jsonb_typeof(master.value -> 'jwbMemId') = 'number'
          and internal.student_import_source_key(master.value -> 'jwbMemId') is null
        )
        or (
          jsonb_typeof(master.value -> 'jwbMemId') = 'string'
          and nullif(internal.student_import_source_key(master.value -> 'jwbMemId'), '') is not null
          and master.value ->> 'jwbMemId' <> internal.student_import_source_key(master.value -> 'jwbMemId')
        )
      )
  ) then
    return 'invalid_student_import_master_jwb_member_id';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(p_master_rows) master(value)
    where nullif(internal.student_import_source_key(master.value -> 'jwbMemId'), '') is not null
  ) <> (
    select count(distinct internal.student_import_source_key(master.value -> 'jwbMemId'))
    from jsonb_array_elements(p_master_rows) master(value)
    where nullif(internal.student_import_source_key(master.value -> 'jwbMemId'), '') is not null
  ) then
    return 'duplicate_student_import_master_jwb_member_id';
  end if;

  for master_item in
    select master.value
    from jsonb_array_elements(p_master_rows) master(value)
  loop
    master_row := master_item.value;
    member_id := nullif(internal.student_import_source_key(master_row -> 'jwbMemId'), '');
    if member_id is null then
      continue;
    end if;
    master_source_key := internal.student_import_source_key(master_row -> 'sourceRow');

    select count(*) into match_count
    from jsonb_array_elements(p_jwb_rows) jwb(value)
    where internal.student_import_source_key(jwb.value -> 'sourceRow') = member_id;
    if match_count <> 1 then
      return 'invalid_student_import_master_jwb_member_id';
    end if;

    select jwb.value into matched_jwb
    from jsonb_array_elements(p_jwb_rows) jwb(value)
    where internal.student_import_source_key(jwb.value -> 'sourceRow') = member_id;
    if internal.student_import_name_key(master_row ->> 'name') = ''
       or internal.student_import_name_key(master_row ->> 'name') <>
          internal.student_import_name_key(matched_jwb ->> 'name') then
      return 'student_import_master_jwb_member_id_name_mismatch';
    end if;

    -- A saved manual identity review cannot silently override an explicit
    -- source member ID, and another master cannot consume its JWB row.
    if exists (
      select 1
      from jsonb_array_elements(p_identity_links) link(value)
      where link.value ? 'jwbSourceRow'
        and internal.student_import_source_key(link.value -> 'jwbSourceRow') = member_id
        and internal.student_import_source_key(link.value -> 'masterSourceRow') <> master_source_key
    ) or exists (
      select 1
      from jsonb_array_elements(p_identity_links) link(value)
      where link.value ? 'jwbSourceRow'
        and internal.student_import_source_key(link.value -> 'masterSourceRow') = master_source_key
        and internal.student_import_source_key(link.value -> 'jwbSourceRow') <> member_id
    ) then
      return 'student_import_master_jwb_member_id_identity_link_conflict';
    end if;
  end loop;

  return null;
end;
$$;

revoke all on function internal.student_import_master_jwb_member_id_error(jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- Reject a reviewed-link conflict at the link write boundary as well. The
-- broader projection helper above independently protects historical rows and
-- commit/replay, so no old review evidence is deleted or rewritten.
create or replace function internal.student_import_identity_link_master_jwb_member_id_conflict(
  p_master_rows jsonb,
  p_links jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_master_rows) <> 'array'
      or jsonb_typeof(p_links) <> 'array'
    then true
    else exists (
      select 1
      from jsonb_array_elements(p_links) link(value)
      join lateral (
        select master.value as row_value
        from jsonb_array_elements(p_master_rows) master(value)
        where internal.student_import_source_key(master.value -> 'sourceRow') =
          internal.student_import_source_key(link.value -> 'masterSourceRow')
      ) master_match on true
      where link.value ? 'jwbSourceRow'
        and nullif(internal.student_import_source_key(master_match.row_value -> 'jwbMemId'), '') is not null
        and internal.student_import_source_key(link.value -> 'jwbSourceRow') <>
          internal.student_import_source_key(master_match.row_value -> 'jwbMemId')
    ) or exists (
      select 1
      from jsonb_array_elements(p_master_rows) master(value)
      join lateral jsonb_array_elements(p_links) link(value) on true
      where nullif(internal.student_import_source_key(master.value -> 'jwbMemId'), '') is not null
        and link.value ? 'jwbSourceRow'
        and internal.student_import_source_key(link.value -> 'jwbSourceRow') =
          internal.student_import_source_key(master.value -> 'jwbMemId')
        and internal.student_import_source_key(link.value -> 'masterSourceRow') <>
          internal.student_import_source_key(master.value -> 'sourceRow')
    )
  end
$$;

revoke all on function internal.student_import_identity_link_master_jwb_member_id_conflict(jsonb, jsonb)
  from public, anon, authenticated;

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
  if internal.student_import_identity_link_master_jwb_member_id_conflict(
    master_rows, new.links
  ) then
    raise exception using
      errcode = '22023',
      message = 'student_import_identity_link_master_jwb_member_id_conflict';
  end if;
  return new;
end;
$$;

revoke all on function internal.enforce_student_import_identity_link_exact_names()
  from public, anon, authenticated;

-- Accept the normalized optional source field at the durable source boundary.
-- The browser parser maps the Tencent header to this field and removes blank
-- cells before calling this RPC; this SQL guard independently treats direct
-- blank/null values as absence and rejects every other malformed value.
do $master_jwb_member_id_source_patch$
declare
  function_definition text;
  patched_definition text;
  allowed_fields_anchor text := $allowed_fields$
              r - 'sourceRow' - 'name' - 'status' - 'attributes' <> '{}'::jsonb
$allowed_fields$;
  allowed_fields_replacement text := $allowed_fields_replacement$
              r - 'sourceRow' - 'name' - 'status' - 'jwbMemId' - 'attributes' <> '{}'::jsonb
$allowed_fields_replacement$;
  validation_anchor text := $validation_anchor$
              or (r ? 'attributes' and jsonb_typeof(r -> 'attributes') <> 'object')
$validation_anchor$;
  validation_clause text := $validation_clause$
              or (r ? 'jwbMemId' and (
                jsonb_typeof(r -> 'jwbMemId') not in ('string', 'number', 'null')
                or (jsonb_typeof(r -> 'jwbMemId') = 'number'
                  and internal.student_import_source_key(r -> 'jwbMemId') is null)
                or (jsonb_typeof(r -> 'jwbMemId') = 'string'
                  and nullif(internal.student_import_source_key(r -> 'jwbMemId'), '') is not null
                  and r ->> 'jwbMemId' <> internal.student_import_source_key(r -> 'jwbMemId'))
              ))
$validation_clause$;
  uniqueness_anchor text := E'  if p_source_kind = \'jwb\' then\n';
  uniqueness_clause text := $uniqueness_clause$
  if p_source_kind = 'master' and (
    (select count(*)
     from jsonb_array_elements(p_rows) master_row(value)
     where nullif(internal.student_import_source_key(master_row.value -> 'jwbMemId'), '') is not null) <>
    (select count(distinct internal.student_import_source_key(master_row.value -> 'jwbMemId'))
     from jsonb_array_elements(p_rows) master_row(value)
     where nullif(internal.student_import_source_key(master_row.value -> 'jwbMemId'), '') is not null)
  ) then
    raise exception using errcode = '22023', message = 'duplicate_student_import_master_jwb_member_id';
  end if;
$uniqueness_clause$;
  anchor_count integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.put_student_import_source_rows(text,text,text,text,jsonb,text)'::regprocedure
  ) into function_definition;
  if function_definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_master_jwb_member_id_source_function_missing';
  end if;
  anchor_count := (
    length(function_definition) - length(replace(function_definition, allowed_fields_anchor, ''))
  ) / length(allowed_fields_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_master_jwb_member_id_allowed_fields_anchor_mismatch';
  end if;
  function_definition := replace(function_definition, allowed_fields_anchor, allowed_fields_replacement);
  anchor_count := (
    length(function_definition) - length(replace(function_definition, validation_anchor, ''))
  ) / length(validation_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_master_jwb_member_id_validation_anchor_mismatch';
  end if;
  function_definition := replace(function_definition, validation_anchor, validation_clause || validation_anchor);
  anchor_count := (
    length(function_definition) - length(replace(function_definition, uniqueness_anchor, ''))
  ) / length(uniqueness_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_master_jwb_member_id_uniqueness_anchor_mismatch';
  end if;
  patched_definition := replace(function_definition, uniqueness_anchor, uniqueness_clause || uniqueness_anchor);
  execute patched_definition;
  if position('jwbMemId' in pg_catalog.pg_get_functiondef(
    'public.put_student_import_source_rows(text,text,text,text,jsonb,text)'::regprocedure
  )) = 0 then
    raise exception using errcode = 'P0001', message = 'student_import_master_jwb_member_id_source_patch_verification_failed';
  end if;
end;
$master_jwb_member_id_source_patch$;

-- The database-owned canonical projection is the commit/replay authority.
-- Patch its current locked body rather than reconstructing it and risking a
-- regression of the prior student-number and exact-name safeguards.
do $master_jwb_member_id_projection_patch$
declare
  function_definition text;
  patched_definition text;
  declaration_anchor text := $declaration_anchor$
  linked boolean;
  preserve_existing_aggregate boolean;
$declaration_anchor$;
  declaration_replacement text := $declaration_replacement$
  linked boolean;
  master_jwb_member_id text;
  master_jwb_member_id_error text;
  preserve_existing_aggregate boolean;
$declaration_replacement$;
  validation_anchor text := $projection_validation_anchor$
  for master_item in
$projection_validation_anchor$;
  validation_clause text := $projection_validation_clause$
  master_jwb_member_id_error := internal.student_import_master_jwb_member_id_error(
    p_resolved_master_rows, p_jwb_rows, p_identity_links
  );
  if master_jwb_member_id_error is not null then
    raise exception using errcode = '22023', message = master_jwb_member_id_error;
  end if;

$projection_validation_clause$;
  matching_anchor text := $matching_anchor$
    name_key := internal.student_import_name_key(clean_name);
    matched_jwb := null;
    if linked and identity_link ? 'jwbSourceRow' then
      select jwb into matched_jwb
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_source_key(jwb -> 'sourceRow') =
        internal.student_import_source_key(identity_link -> 'jwbSourceRow');
      if matched_jwb is null then
        raise exception using errcode = '22023', message = 'invalid_student_import_linked_jwb';
      end if;
    elsif not linked then
      select count(*) into master_name_count
      from jsonb_array_elements(p_resolved_master_rows) candidate
      where internal.student_import_display_name(candidate ->> 'name') <> ''
        and candidate ->> 'status' <> '不活跃 + 无课时'
        and internal.student_import_name_key(candidate ->> 'name') = name_key
        and not exists (
          select 1 from jsonb_array_elements(p_identity_links) link
          where internal.student_import_source_key(link -> 'masterSourceRow') =
            internal.student_import_source_key(candidate -> 'sourceRow')
        );
      select count(*) into jwb_name_count
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_display_name(jwb ->> 'name') <> ''
        and internal.student_import_name_key(jwb ->> 'name') = name_key
        and not exists (
          select 1 from jsonb_array_elements(p_identity_links) link
          where link ? 'jwbSourceRow'
            and internal.student_import_source_key(link -> 'jwbSourceRow') =
              internal.student_import_source_key(jwb -> 'sourceRow')
        );
      if master_name_count = 1 and jwb_name_count = 1 then
        select jwb into matched_jwb
        from jsonb_array_elements(p_jwb_rows) jwb
        where internal.student_import_name_key(jwb ->> 'name') = name_key
          and not exists (
            select 1 from jsonb_array_elements(p_identity_links) link
            where link ? 'jwbSourceRow'
              and internal.student_import_source_key(link -> 'jwbSourceRow') =
                internal.student_import_source_key(jwb -> 'sourceRow')
          );
      end if;
    else
      master_name_count := 1;
      jwb_name_count := 0;
    end if;

$matching_anchor$;
  matching_replacement text := $matching_replacement$
    name_key := internal.student_import_name_key(clean_name);
    master_jwb_member_id := nullif(
      internal.student_import_source_key(row_value -> 'jwbMemId'), ''
    );
    matched_jwb := null;
    if linked and identity_link ? 'jwbSourceRow' then
      select jwb into matched_jwb
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_source_key(jwb -> 'sourceRow') =
        internal.student_import_source_key(identity_link -> 'jwbSourceRow');
      if matched_jwb is null then
        raise exception using errcode = '22023', message = 'invalid_student_import_linked_jwb';
      end if;
    elsif master_jwb_member_id is not null then
      select jwb into matched_jwb
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_source_key(jwb -> 'sourceRow') = master_jwb_member_id;
      master_name_count := 1;
      jwb_name_count := 1;
    elsif not linked then
      select count(*) into master_name_count
      from jsonb_array_elements(p_resolved_master_rows) candidate
      where internal.student_import_display_name(candidate ->> 'name') <> ''
        and candidate ->> 'status' <> '不活跃 + 无课时'
        and internal.student_import_name_key(candidate ->> 'name') = name_key
        and not (
          candidate ? 'jwbMemId'
          and nullif(internal.student_import_source_key(candidate -> 'jwbMemId'), '') is not null
        )
        and not exists (
          select 1 from jsonb_array_elements(p_identity_links) link
          where internal.student_import_source_key(link -> 'masterSourceRow') =
            internal.student_import_source_key(candidate -> 'sourceRow')
        );
      select count(*) into jwb_name_count
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_display_name(jwb ->> 'name') <> ''
        and internal.student_import_name_key(jwb ->> 'name') = name_key
        and not exists (
          select 1 from jsonb_array_elements(p_identity_links) link
          where link ? 'jwbSourceRow'
            and internal.student_import_source_key(link -> 'jwbSourceRow') =
              internal.student_import_source_key(jwb -> 'sourceRow')
        )
        and not exists (
          select 1
          from jsonb_array_elements(p_resolved_master_rows) authoritative_master
          where nullif(internal.student_import_source_key(
            authoritative_master -> 'jwbMemId'
          ), '') = internal.student_import_source_key(jwb -> 'sourceRow')
        );
      if master_name_count = 1 and jwb_name_count = 1 then
        select jwb into matched_jwb
        from jsonb_array_elements(p_jwb_rows) jwb
        where internal.student_import_name_key(jwb ->> 'name') = name_key
          and not exists (
            select 1 from jsonb_array_elements(p_identity_links) link
            where link ? 'jwbSourceRow'
              and internal.student_import_source_key(link -> 'jwbSourceRow') =
                internal.student_import_source_key(jwb -> 'sourceRow')
          )
          and not exists (
            select 1
            from jsonb_array_elements(p_resolved_master_rows) authoritative_master
            where nullif(internal.student_import_source_key(
              authoritative_master -> 'jwbMemId'
            ), '') = internal.student_import_source_key(jwb -> 'sourceRow')
          );
      end if;
    else
      master_name_count := 1;
      jwb_name_count := 0;
    end if;

$matching_replacement$;
  anchor_count integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into function_definition;
  if function_definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_master_jwb_member_id_projection_missing';
  end if;
  anchor_count := (
    length(function_definition) - length(replace(function_definition, declaration_anchor, ''))
  ) / length(declaration_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_master_jwb_member_id_declaration_anchor_mismatch';
  end if;
  function_definition := replace(function_definition, declaration_anchor, declaration_replacement);
  anchor_count := (
    length(function_definition) - length(replace(function_definition, validation_anchor, ''))
  ) / length(validation_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_master_jwb_member_id_validation_anchor_mismatch';
  end if;
  function_definition := replace(function_definition, validation_anchor, validation_clause || validation_anchor);
  anchor_count := (
    length(function_definition) - length(replace(function_definition, matching_anchor, ''))
  ) / length(matching_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_master_jwb_member_id_matching_anchor_mismatch';
  end if;
  patched_definition := replace(function_definition, matching_anchor, matching_replacement);
  execute patched_definition;
  if position('student_import_master_jwb_member_id_error' in pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  )) = 0 then
    raise exception using errcode = 'P0001', message = 'student_import_master_jwb_member_id_projection_patch_verification_failed';
  end if;
end;
$master_jwb_member_id_projection_patch$;

revoke all on function public.put_student_import_source_rows(text, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.put_student_import_source_rows(text, text, text, text, jsonb, text)
  to anon, authenticated;
revoke all on function internal.student_import_canonical_projection(text, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- Fixtures prove that an ID resolves a same-name duplicate but cannot match a
-- different name, and cannot be duplicated across master source rows.
do $master_jwb_member_id_fixtures$
declare
  projection jsonb;
begin
  projection := internal.student_import_canonical_projection(
    'master-jwb-member-id-fixture',
    '[{"sourceRow":"M-1","name":"Exact Learner","status":"在读","jwbMemId":"J-2"}]'::jsonb,
    '[{"sourceRow":"J-1","name":"exact learner","remainingHours":1,"contractHours":1,"packageCoverage":"none"},{"sourceRow":"J-2","name":"exact learner","remainingHours":2,"contractHours":2,"packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb
  );
  if projection #>> '{0,jwbMatchStatus}' <> 'matched'
     or projection #>> '{0,jwbSourceRow}' <> 'J-2' then
    raise exception using errcode = '22023', message = 'student_import_master_jwb_member_id_fixture_mismatch';
  end if;

  begin
    perform internal.student_import_canonical_projection(
      'master-jwb-member-id-fixture',
      '[{"sourceRow":"M-2","name":"Exact Learner","status":"在读","jwbMemId":"J-3"}]'::jsonb,
      '[{"sourceRow":"J-3","name":"Different Learner","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb
    );
    raise exception using errcode = '22023', message = 'student_import_master_jwb_member_id_name_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'student_import_master_jwb_member_id_name_mismatch' then
      raise;
    end if;
  end;

  begin
    perform internal.student_import_canonical_projection(
      'master-jwb-member-id-fixture',
      '[{"sourceRow":"M-3","name":"First Learner","status":"在读","jwbMemId":"J-4"},{"sourceRow":"M-4","name":"Second Learner","status":"在读","jwbMemId":"J-4"}]'::jsonb,
      '[{"sourceRow":"J-4","name":"First Learner","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb
    );
    raise exception using errcode = '22023', message = 'student_import_master_jwb_member_id_duplicate_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'duplicate_student_import_master_jwb_member_id' then
      raise;
    end if;
  end;

  begin
    perform internal.student_import_canonical_projection(
      'master-jwb-member-id-fixture',
      '[{"sourceRow":"M-5","name":"Excluded Learner","status":"不活跃 + 无课时","jwbMemId":"J-MISSING"}]'::jsonb,
      '[{"sourceRow":"J-5","name":"Excluded Learner","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb
    );
    raise exception using errcode = '22023',
      message = 'student_import_master_jwb_member_id_excluded_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'invalid_student_import_master_jwb_member_id' then
      raise;
    end if;
  end;
end;
$master_jwb_member_id_fixtures$;
