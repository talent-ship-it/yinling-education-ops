-- Restore the approved Tencent roster boundary.
--
-- Tencent remains the authority for formal student existence, except for the
-- explicitly rejected source status `不活跃 + 无课时`.  Those rows remain in the
-- immutable source snapshot, but must not create a current formal student,
-- reserve a JWB account, force a duplicate-resolution task, or invalidate an
-- otherwise-current peer.  Existing student IDs referenced by historical
-- operations remain governed by the canonical archive-preservation path.
--
-- This is deliberately a forward patch over the deployed 20260817000800
-- master-authoritative implementation.  It does not require, apply, or
-- assume any unapproved 20260818 performance follow-up migration.  It also
-- does not rewrite source evidence or delete any historical student row.

set local lock_timeout = '1s';

-- Duplicate review has to use the same current-roster eligibility as the
-- TypeScript planner.  A blank-status row may still be resolved to any one
-- of the six source statuses; if it is resolved to the excluded one, it is
-- subsequently omitted from the formal roster in the normal way.
create or replace function internal.student_import_master_duplicate_candidates(
  p_master internal.student_import_source_rows,
  p_students public.ops_state
)
returns jsonb
language sql
stable
set search_path = ''
as $inactive_no_hours_duplicate_candidates$
  with eligible as (
    select row_item.value as row_value,
      row_item.value -> 'sourceRow' as source_row,
      row_item.value ->> 'sourceRow' as source_row_text,
      internal.student_import_name_key(row_item.value ->> 'name') as name_key
    from jsonb_array_elements(p_master.rows) row_item(value)
    where internal.student_import_name_key(row_item.value ->> 'name') <> ''
      and trim(coalesce(row_item.value ->> 'status', '')) <> '不活跃 + 无课时'
  ), duplicate_groups as (
    select name_key,
      jsonb_agg(source_row order by internal.student_import_utf16_sort_key(source_row_text)) as source_rows,
      jsonb_agg(row_value order by internal.student_import_utf16_sort_key(source_row_text)) as source_values
    from eligible group by name_key having count(*) > 1
  ), group_options as (
    select g.*,
      internal.student_import_master_duplicate_key(
        p_master.source_id, p_master.revision, p_students.version, g.source_rows
      ) as group_key
    from duplicate_groups g
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'resolutionGroupKey', group_key,
    'sourceRows', source_rows,
    'options', (
      select coalesce(jsonb_agg(option_value order by option_value ->> 'resolutionKey'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'resolutionKey', internal.student_import_master_duplicate_key(
            p_master.source_id, p_master.revision, p_students.version, source_rows,
            'select', source_value ->> 'sourceRow', case when trim(coalesce(source_value ->> 'status', '')) = '' then status_value else null end
          ),
          'decision', 'select',
          'selectedSourceRow', source_value -> 'sourceRow',
          'selectedStatus', case when trim(coalesce(source_value ->> 'status', '')) = '' then to_jsonb(status_value) else null end
        ) as option_value
        from jsonb_array_elements(source_values) source_value
        cross join lateral unnest(case
          when trim(coalesce(source_value ->> 'status', '')) = '' then array[
            '在读', '不活跃 + 无课时', '活跃 + 无课时', '活跃 + 有课时',
            '不活跃 + 有课时', '在读 + 加课待排'
          ]::text[] else array[null]::text[] end
        ) status_value
        union all
        select jsonb_build_object(
          'resolutionKey', internal.student_import_master_duplicate_key(
            p_master.source_id, p_master.revision, p_students.version, source_rows, 'ignore'
          ),
          'decision', 'ignore'
        )
      ) options
    )
  ) order by group_key), '[]'::jsonb)
  from group_options
$inactive_no_hours_duplicate_candidates$;

revoke all on function internal.student_import_master_duplicate_candidates(
  internal.student_import_source_rows, public.ops_state
) from public, anon, authenticated;

-- Keep malformed member IDs fail-closed for every source row, but only
-- current formal candidates participate in the uniqueness reservation.  An
-- excluded row cannot reserve or collide with an active peer's JWB account.
create or replace function internal.student_import_master_jwb_member_id_error(
  p_master_rows jsonb,
  p_jwb_rows jsonb,
  p_identity_links jsonb
)
returns text
language sql
immutable
set search_path = ''
as $inactive_no_hours_member_id_error$
  select case
    when jsonb_typeof(p_master_rows) <> 'array'
      or jsonb_typeof(p_jwb_rows) <> 'array'
      or jsonb_typeof(p_identity_links) <> 'array'
    then 'invalid_student_import_master_jwb_member_id'
    when exists (
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
    ) then 'invalid_student_import_master_jwb_member_id'
    when (
      select count(*)
      from jsonb_array_elements(p_master_rows) master(value)
      where internal.student_import_display_name(master.value ->> 'name') <> ''
        and trim(coalesce(master.value ->> 'status', '')) <> '不活跃 + 无课时'
        and nullif(internal.student_import_source_key(master.value -> 'jwbMemId'), '') is not null
    ) <> (
      select count(distinct internal.student_import_source_key(master.value -> 'jwbMemId'))
      from jsonb_array_elements(p_master_rows) master(value)
      where internal.student_import_display_name(master.value ->> 'name') <> ''
        and trim(coalesce(master.value ->> 'status', '')) <> '不活跃 + 无课时'
        and nullif(internal.student_import_source_key(master.value -> 'jwbMemId'), '') is not null
    ) then 'duplicate_student_import_master_jwb_member_id'
    else null
  end
$inactive_no_hours_member_id_error$;

revoke all on function internal.student_import_master_jwb_member_id_error(jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- The hardened base owns formal creation and referenced-history preservation.
-- Restore its early skip and ensure the set-based lookup maps do not let an
-- excluded row reserve a JWB member ID or make an active same-name row look
-- ambiguous.
do $restore_inactive_no_hours_base_projection$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_base_projection_missing';
  end if;

  anchor := E'    if clean_name = \'\' then\n      continue;\n    end if;';
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_base_projection_skip_anchor_mismatch';
  end if;
  definition := replace(definition, anchor,
    E'    if clean_name = \'\' or row_value ->> \'status\' = \'不活跃 + 无课时\' then\n      continue;\n    end if;');

  anchor := $declared_member_ids_anchor$  select coalesce(jsonb_object_agg(member_id, 'true'::jsonb), '{}'::jsonb)
  into declared_member_ids
  from (
    select distinct nullif(internal.student_import_source_key(master -> 'jwbMemId'), '') as member_id
    from jsonb_array_elements(p_resolved_master_rows) master
  ) declared
  where member_id is not null;$declared_member_ids_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_base_projection_declared_member_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $declared_member_ids_replacement$  select coalesce(jsonb_object_agg(member_id, 'true'::jsonb), '{}'::jsonb)
  into declared_member_ids
  from (
    select distinct nullif(internal.student_import_source_key(master -> 'jwbMemId'), '') as member_id
    from jsonb_array_elements(p_resolved_master_rows) master
    where internal.student_import_display_name(master ->> 'name') <> ''
      and master ->> 'status' <> '不活跃 + 无课时'
  ) declared
  where member_id is not null;$declared_member_ids_replacement$);

  anchor := $master_auto_name_anchor$    where internal.student_import_display_name(master ->> 'name') <> ''
      and nullif(internal.student_import_source_key(master -> 'jwbMemId'), '') is null
$master_auto_name_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_base_projection_auto_name_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $master_auto_name_replacement$    where internal.student_import_display_name(master ->> 'name') <> ''
      and master ->> 'status' <> '不活跃 + 无课时'
      and nullif(internal.student_import_source_key(master -> 'jwbMemId'), '') is null
$master_auto_name_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection_170008_base(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if position('row_value ->> ''status'' = ''不活跃 + 无课时''' in definition) = 0
     or position('master ->> ''status'' <> ''不活跃 + 无课时''' in definition) = 0 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_base_projection_patch_verification_failed';
  end if;
end;
$restore_inactive_no_hours_base_projection$;

-- Reviewed identity links attached to an excluded row are historical source
-- evidence only.  Remove them before the optional-JWB safety pass so they
-- cannot consume a JWB row or downgrade an active peer's valid link.  Unknown
-- or malformed links are intentionally retained for the existing fail-closed
-- validators.
do $restore_inactive_no_hours_safe_links$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_projection_wrapper_missing';
  end if;

  -- 170008's deployed wrapper declares `safe_identity_links` immediately
  -- before its JSONB result accumulator.  Replace only that declaration so
  -- this patch also remains compatible with a later local optimization that
  -- changed the accumulator type; it never requires that optimization.
  anchor := $wrapper_declaration_anchor$  safe_identity_links jsonb := '[]'::jsonb;$wrapper_declaration_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_safe_links_declaration_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $wrapper_declaration_replacement$  effective_identity_links jsonb := '[]'::jsonb;
  safe_identity_links jsonb := '[]'::jsonb;$wrapper_declaration_replacement$);

  anchor := $safe_links_comment_anchor$  -- A reviewed master→existing identity remains useful when its optional JWB
$safe_links_comment_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_safe_links_initialization_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $safe_links_comment_replacement$  select coalesce(jsonb_agg(link.value order by link.ordinality), '[]'::jsonb)
  into effective_identity_links
  from jsonb_array_elements(p_identity_links) with ordinality link(value, ordinality)
  where not (
    jsonb_typeof(link.value) = 'object'
    and link.value - 'masterSourceRow' - 'studentId' - 'jwbSourceRow' - 'matchStrategy' = '{}'::jsonb
    and internal.student_import_source_key(link.value -> 'masterSourceRow') is not null
    and exists (
      select 1
      from jsonb_array_elements(p_resolved_master_rows) master(value)
      where internal.student_import_source_key(master.value -> 'sourceRow') =
          internal.student_import_source_key(link.value -> 'masterSourceRow')
        and master.value ->> 'status' = '不活跃 + 无课时'
    )
  );

  -- A reviewed master→existing identity remains useful when its optional JWB
$safe_links_comment_replacement$);

  -- 170008 has exactly one input expansion for the optional-link safety
  -- pass.  Count the narrow expansion rather than an accumulator-specific
  -- following CTE, so the migration applies directly to 170008.
  anchor := $safe_links_input_anchor$    from jsonb_array_elements(p_identity_links) with ordinality link(value, ordinality)$safe_links_input_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_safe_links_input_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $safe_links_input_replacement$    from jsonb_array_elements(effective_identity_links) with ordinality link(value, ordinality)$safe_links_input_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if position('effective_identity_links jsonb := ''[]''::jsonb' in definition) = 0
     or position('into effective_identity_links' in definition) = 0
     or position('jsonb_array_elements(effective_identity_links) with ordinality link(value, ordinality)' in definition) = 0 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_safe_links_patch_verification_failed';
  end if;
end;
$restore_inactive_no_hours_safe_links$;

-- The atomic commit independently proves the formal roster and validates
-- revision-bound links.  Reapply the same eligibility condition at that
-- boundary, rather than trusting a client projection to have omitted rows.
do $restore_inactive_no_hours_commit_boundary$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_commit_missing';
  end if;

  anchor := $formal_roster_anchor$    where internal.student_import_display_name(eligible_master_row ->> 'name') <> ''
$formal_roster_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 3 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_commit_formal_roster_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $formal_roster_replacement$    where internal.student_import_display_name(eligible_master_row ->> 'name') <> ''
      and eligible_master_row ->> 'status' <> '不活跃 + 无课时'
$formal_roster_replacement$);

  -- Do not change 170008's identity-link source-existence check.  An
  -- excluded source row still exists in the immutable Tencent snapshot, and
  -- its reviewed link may identify a referenced historical student.  The
  -- wrapper removes a structurally valid excluded-row link before current
  -- projection; treating that source as missing here would incorrectly block
  -- the otherwise-safe commit.

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)'::regprocedure
  ) into definition;
  if position('eligible_master_row ->> ''status'' <> ''不活跃 + 无课时''' in definition) = 0 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_commit_patch_verification_failed';
  end if;
end;
$restore_inactive_no_hours_commit_boundary$;

-- Source ingestion accepts raw archival rows, while its blank-status and
-- JWB-member-ID checks must only use rows that could become formal students.
-- Otherwise an excluded same-name/duplicate-ID row would prevent a current
-- peer from even reaching the planner.
do $restore_inactive_no_hours_source_ingest$
declare
  definition text;
  anchor text;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.put_student_import_source_rows(text,text,text,text,jsonb,text)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_source_ingest_missing';
  end if;

  anchor := $blank_status_anchor$        where sibling ->> 'sourceRow' <> blank_row ->> 'sourceRow'
          and internal.student_import_name_key(sibling ->> 'name') =
$blank_status_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_source_blank_status_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $blank_status_replacement$        where sibling ->> 'sourceRow' <> blank_row ->> 'sourceRow'
          and trim(coalesce(sibling ->> 'status', '')) <> '不活跃 + 无课时'
          and internal.student_import_name_key(sibling ->> 'name') =
$blank_status_replacement$);

  anchor := $member_id_uniqueness_anchor$  if p_source_kind = 'master' and (
    (select count(*)
     from jsonb_array_elements(p_rows) master_row(value)
     where nullif(internal.student_import_source_key(master_row.value -> 'jwbMemId'), '') is not null) <>
    (select count(distinct internal.student_import_source_key(master_row.value -> 'jwbMemId'))
     from jsonb_array_elements(p_rows) master_row(value)
     where nullif(internal.student_import_source_key(master_row.value -> 'jwbMemId'), '') is not null)
  ) then
    raise exception using errcode = '22023', message = 'duplicate_student_import_master_jwb_member_id';
  end if;
$member_id_uniqueness_anchor$;
  count_anchor := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if count_anchor <> 1 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_source_member_id_anchor_mismatch';
  end if;
  definition := replace(definition, anchor, $member_id_uniqueness_replacement$  if p_source_kind = 'master' and (
    (select count(*)
     from jsonb_array_elements(p_rows) master_row(value)
     where internal.student_import_display_name(master_row.value ->> 'name') <> ''
       and trim(coalesce(master_row.value ->> 'status', '')) <> '不活跃 + 无课时'
       and nullif(internal.student_import_source_key(master_row.value -> 'jwbMemId'), '') is not null) <>
    (select count(distinct internal.student_import_source_key(master_row.value -> 'jwbMemId'))
     from jsonb_array_elements(p_rows) master_row(value)
     where internal.student_import_display_name(master_row.value ->> 'name') <> ''
       and trim(coalesce(master_row.value ->> 'status', '')) <> '不活跃 + 无课时'
       and nullif(internal.student_import_source_key(master_row.value -> 'jwbMemId'), '') is not null)
  ) then
    raise exception using errcode = '22023', message = 'duplicate_student_import_master_jwb_member_id';
  end if;
$member_id_uniqueness_replacement$);

  execute definition;

  select pg_catalog.pg_get_functiondef(
    'public.put_student_import_source_rows(text,text,text,text,jsonb,text)'::regprocedure
  ) into definition;
  if position('trim(coalesce(sibling ->> ''status'', '''')) <> ''不活跃 + 无课时''' in definition) = 0
     or position('internal.student_import_display_name(master_row.value ->> ''name'') <> ''''' in definition) = 0 then
    raise exception using errcode = 'P0001', message = 'inactive_no_hours_source_ingest_patch_verification_failed';
  end if;
end;
$restore_inactive_no_hours_source_ingest$;
