\set ON_ERROR_STOP on

-- Run against a disposable database at the actual 20260818000500 predecessor
-- shape. Capture canonical projection outputs/errors before the safe-link
-- normalization patch, then require JSONB, `::text`, SQLSTATE, and SQLERRM
-- parity after it. This covers exact links, reviewed v1 annotations, optional
-- JWB downgrade cases, link reuse, and malformed reviewed-link input.
begin;

-- The fixture is repeatable both from a true 170005 predecessor and from a
-- local database where this forward-only patch was already applied. In the
-- latter case, reconstruct the exact audited predecessor CTE *inside this
-- enclosing transaction*, capture its baseline, apply 170006 again, then
-- roll back. This never changes the durable local or production function.
do $restore_safe_link_normalization_predecessor$
declare
  definition text;
  original_prefix text;
  postpatch_key_anchor text;
  original_key_anchor text;
  start_position integer;
  end_position integer;
  count_anchor integer;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001',
      message = 'student_import_safe_link_predecessor_fixture_wrapper_missing';
  end if;

  original_prefix := $original_safe_link_prefix$  with links as (
    select link.value as raw_link,
      link.ordinality as ordinal,
      internal.student_import_source_key(link.value -> 'masterSourceRow') as master_key,
      internal.student_import_source_key(link.value -> 'jwbSourceRow') as jwb_key,
      jsonb_typeof(link.value) = 'object' and link.value ? 'jwbSourceRow' as has_jwb_leg
    from jsonb_array_elements(p_identity_links) with ordinality link(value, ordinality)
  ), master_rows as (
    select internal.student_import_source_key(master.value -> 'sourceRow') as source_key,
      count(*)::integer as source_count,
      (jsonb_agg(master.value order by master.ordinality) -> 0) as row_value
    from jsonb_array_elements(p_resolved_master_rows) with ordinality master(value, ordinality)
    group by internal.student_import_source_key(master.value -> 'sourceRow')
  ), jwb_rows as (
    select internal.student_import_source_key(jwb.value -> 'sourceRow') as source_key,
      count(*)::integer as source_count,
      (jsonb_agg(jwb.value order by jwb.ordinality) -> 0) as row_value
    from jsonb_array_elements(p_jwb_rows) with ordinality jwb(value, ordinality)
    group by internal.student_import_source_key(jwb.value -> 'sourceRow')
  ), master_link_counts as (
    select master_key, count(*)::integer as link_count
    from links
    where master_key is not null and master_key <> ''
    group by master_key
  ), jwb_link_counts as (
    select jwb_key, count(*)::integer as link_count
    from links
    where has_jwb_leg and jwb_key is not null
    group by jwb_key
  ), master_annotation_counts as (
    select internal.student_import_jwb_annotation_relaxed_name_key(
      master.value ->> 'name'
    ) as relaxed_key,
      count(*)::integer as row_count
    from jsonb_array_elements(p_resolved_master_rows) master(value)
    group by internal.student_import_jwb_annotation_relaxed_name_key(master.value ->> 'name')
  ), jwb_annotation_counts as (
    select internal.student_import_jwb_annotation_relaxed_name_key(
      jwb.value ->> 'name'
    ) as relaxed_key,
      count(*)::integer as row_count
    from jsonb_array_elements(p_jwb_rows) jwb(value)
    group by internal.student_import_jwb_annotation_relaxed_name_key(jwb.value ->> 'name')
  ), evaluated_links as ($original_safe_link_prefix$;
  postpatch_key_anchor := $postpatch_key_anchor$      master_rows.name_key as master_name_key,
      jwb_rows.name_key as jwb_name_key,
      jwb_rows.annotation_key as jwb_annotation_key,
      master_rows.display_name as master_display_name$postpatch_key_anchor$;
  original_key_anchor := $original_key_anchor$      internal.student_import_name_key(master_rows.row_value ->> 'name') as master_name_key,
      internal.student_import_name_key(jwb_rows.row_value ->> 'name') as jwb_name_key,
      internal.student_import_jwb_latin_parenthetical_annotation_key(
        jwb_rows.row_value ->> 'name'
      ) as jwb_annotation_key,
      internal.student_import_display_name(master_rows.row_value ->> 'name') as master_display_name$original_key_anchor$;

  if position('master_source_values as materialized' in definition) = 0 then
    if position(original_prefix in definition) = 0
       or position(original_key_anchor in definition) = 0 then
      raise exception using errcode = 'P0001',
        message = 'student_import_safe_link_predecessor_fixture_unknown_shape';
    end if;
    return;
  end if;

  count_anchor := (length(definition) - length(replace(definition, '  with links as (', ''))) / length('  with links as (');
  if count_anchor <> 1
     or (length(definition) - length(replace(definition, '  ), evaluated_links as (', ''))) / length('  ), evaluated_links as (') <> 1
     or (length(definition) - length(replace(definition, postpatch_key_anchor, ''))) / length(postpatch_key_anchor) <> 1
     or position('jwb_source_values as materialized' in definition) = 0
     or position('internal.student_import_annotation_name_key_from_display_name(' in definition) = 0
     or position('internal.student_import_jwb_annotation_key_from_display(' in definition) = 0 then
    raise exception using errcode = 'P0001',
      message = 'student_import_safe_link_predecessor_fixture_postpatch_anchor_mismatch';
  end if;

  start_position := position('  with links as (' in definition);
  end_position := position('  ), evaluated_links as (' in definition);
  if end_position <= start_position then
    raise exception using errcode = 'P0001',
      message = 'student_import_safe_link_predecessor_fixture_cte_bounds_mismatch';
  end if;
  definition := substring(definition from 1 for start_position - 1)
    || original_prefix
    || substring(definition from end_position + length('  ), evaluated_links as ('));
  definition := replace(definition, postpatch_key_anchor, original_key_anchor);
  execute definition;

  select pg_catalog.pg_get_functiondef(
    'internal.student_import_canonical_projection(text,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ) into definition;
  if position(original_prefix in definition) = 0
     or position(original_key_anchor in definition) = 0
     or position('master_source_values as materialized' in definition) <> 0 then
    raise exception using errcode = 'P0001',
      message = 'student_import_safe_link_predecessor_fixture_restore_verification_failed';
  end if;
end;
$restore_safe_link_normalization_predecessor$;

do $safe_link_from_display_helper_equivalence$
declare
  sample_name text;
  display_name text;
begin
  foreach sample_name in array array[
    'Exact', 'Anne(VIC)', '  Ａnne   (VIC) ', '张三', '张（三）',
    'Anne(中文)', 'Anne(VIC)(NSW)'
  ]
  loop
    display_name := internal.student_import_display_name(sample_name);
    if internal.student_import_name_key(sample_name) is distinct from
         internal.student_import_annotation_name_key_from_display_name(display_name)
       or internal.student_import_jwb_latin_parenthetical_annotation_key(sample_name)
          is distinct from internal.student_import_jwb_annotation_key_from_display(display_name) then
      raise exception using errcode = 'P0001',
        message = 'student_import_safe_link_from_display_helper_parity_failed';
    end if;
  end loop;
end;
$safe_link_from_display_helper_equivalence$;

create temporary table safe_link_cases (
  case_name text primary key,
  master_rows jsonb not null,
  jwb_rows jsonb not null,
  current_students jsonb not null,
  identity_links jsonb not null,
  expected_status text
) on commit drop;

insert into safe_link_cases(
  case_name, master_rows, jwb_rows, current_students, identity_links, expected_status
)
values
  (
    'exact_link',
    '[{"sourceRow":"M-EXACT","name":"Exact","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-EXACT","name":"Exact","packageCoverage":"none","remainingHours":3,"contractHours":4}]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'masterSourceRow', 'M-EXACT',
      'jwbSourceRow', 'J-EXACT',
      'studentId', internal.student_import_student_id(
        'safe-link-fixture', to_jsonb('M-EXACT'::text)
      )
    )),
    'matched'
  ),
  (
    'approved_v1_annotation',
    '[{"sourceRow":"M-ANNO","name":"Anne","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-ANNO","name":"Anne(VIC)","packageCoverage":"none","remainingHours":3,"contractHours":4}]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'masterSourceRow', 'M-ANNO',
      'jwbSourceRow', 'J-ANNO',
      'studentId', internal.student_import_student_id(
        'safe-link-fixture', to_jsonb('M-ANNO'::text)
      ),
      'matchStrategy', 'jwb_latin_parenthetical_annotation_v1'
    )),
    'matched'
  ),
  (
    'cross_name_jwb_downgrade',
    '[{"sourceRow":"M-ALICE","name":"Alice","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-BOB","name":"Bob","packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'masterSourceRow', 'M-ALICE',
      'jwbSourceRow', 'J-BOB',
      'studentId', internal.student_import_student_id(
        'safe-link-fixture', to_jsonb('M-ALICE'::text)
      )
    )),
    'unmatched'
  ),
  (
    'stale_jwb_downgrade',
    '[{"sourceRow":"M-STALE","name":"Stale","status":"在读"}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'masterSourceRow', 'M-STALE',
      'jwbSourceRow', 'J-MISSING',
      'studentId', internal.student_import_student_id(
        'safe-link-fixture', to_jsonb('M-STALE'::text)
      )
    )),
    'unmatched'
  ),
  (
    'cross_name_member_id_downgrade',
    '[{"sourceRow":"M-MEMBER","name":"Alice","status":"在读","jwbMemId":"J-BOB"}]'::jsonb,
    '[{"sourceRow":"J-BOB","name":"Bob","packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'masterSourceRow', 'M-MEMBER',
      'jwbSourceRow', 'J-BOB',
      'studentId', internal.student_import_student_id(
        'safe-link-fixture', to_jsonb('M-MEMBER'::text)
      )
    )),
    'unmatched'
  ),
  (
    'duplicate_jwb_link',
    '[
      {"sourceRow":"M-ONE","name":"One","status":"在读"},
      {"sourceRow":"M-TWO","name":"Two","status":"在读"}
    ]'::jsonb,
    '[{"sourceRow":"J-SHARED","name":"One","packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(
      jsonb_build_object(
        'masterSourceRow', 'M-ONE',
        'jwbSourceRow', 'J-SHARED',
        'studentId', internal.student_import_student_id(
          'safe-link-fixture', to_jsonb('M-ONE'::text)
        )
      ),
      jsonb_build_object(
        'masterSourceRow', 'M-TWO',
        'jwbSourceRow', 'J-SHARED',
        'studentId', internal.student_import_student_id(
          'safe-link-fixture', to_jsonb('M-TWO'::text)
        )
      )
    ),
    null
  ),
  (
    'malformed_strategy_fails_closed',
    '[{"sourceRow":"M-BAD","name":"Exact","status":"在读"}]'::jsonb,
    '[{"sourceRow":"J-BAD","name":"Exact","packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'masterSourceRow', 'M-BAD',
      'jwbSourceRow', 'J-BAD',
      'studentId', internal.student_import_student_id(
        'safe-link-fixture', to_jsonb('M-BAD'::text)
      ),
      'matchStrategy', 'not_a_reviewed_strategy'
    )),
    null
  ),
  (
    'annotation_collision_downgrade',
    '[
      {"sourceRow":"M-ANNE","name":"Anne","status":"在读"},
      {"sourceRow":"M-OTHER","name":"Anne","status":"在读"}
    ]'::jsonb,
    '[{"sourceRow":"J-ANNE","name":"Anne(VIC)","packageCoverage":"none"}]'::jsonb,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'masterSourceRow', 'M-ANNE',
      'jwbSourceRow', 'J-ANNE',
      'studentId', internal.student_import_student_id(
        'safe-link-fixture', to_jsonb('M-ANNE'::text)
      ),
      'matchStrategy', 'jwb_latin_parenthetical_annotation_v1'
    )),
    null
  );

create temporary table safe_link_baseline (
  case_name text primary key,
  projection jsonb,
  error_state text,
  error_message text
) on commit drop;

do $safe_link_baseline$
declare
  case_item safe_link_cases%rowtype;
  result jsonb;
  result_state text;
  result_message text;
begin
  for case_item in select * from safe_link_cases order by case_name loop
    result := null;
    result_state := null;
    result_message := null;
    begin
      result := internal.student_import_canonical_projection(
        'safe-link-fixture', case_item.master_rows, case_item.jwb_rows,
        case_item.current_students, case_item.identity_links, '[]'::jsonb
      );
    exception when others then
      result_state := SQLSTATE;
      result_message := SQLERRM;
    end;
    insert into safe_link_baseline(case_name, projection, error_state, error_message)
    values (case_item.case_name, result, result_state, result_message);
  end loop;
end;
$safe_link_baseline$;

\ir ../../supabase/migrations/20260818000600_optimize_safe_identity_link_normalization.sql

do $safe_link_normalization_parity$
declare
  case_item safe_link_cases%rowtype;
  baseline safe_link_baseline%rowtype;
  actual_projection jsonb;
  actual_state text;
  actual_message text;
begin
  for case_item in select * from safe_link_cases order by case_name loop
    select * into baseline from safe_link_baseline where case_name = case_item.case_name;
    actual_projection := null;
    actual_state := null;
    actual_message := null;
    begin
      actual_projection := internal.student_import_canonical_projection(
        'safe-link-fixture', case_item.master_rows, case_item.jwb_rows,
        case_item.current_students, case_item.identity_links, '[]'::jsonb
      );
    exception when others then
      actual_state := SQLSTATE;
      actual_message := SQLERRM;
    end;
    if actual_state is distinct from baseline.error_state
       or actual_message is distinct from baseline.error_message
       or actual_projection is distinct from baseline.projection
       or (actual_state is null and actual_projection::text <> baseline.projection::text) then
      raise exception using errcode = 'P0001', message = format(
        'student_import_safe_link_normalization_parity_failed:%s:%s:%s:%s:%s',
        case_item.case_name,
        coalesce(baseline.error_state, 'ok'), coalesce(baseline.error_message, 'ok'),
        coalesce(actual_state, 'ok'), coalesce(actual_message, 'ok')
      );
    end if;
    if actual_state is null and case_item.expected_status is not null
       and (actual_projection #>> '{0,jwbMatchStatus}') is distinct from case_item.expected_status then
      raise exception using errcode = 'P0001', message = format(
        'student_import_safe_link_normalization_boundary_failed:%s', case_item.case_name
      );
    end if;
  end loop;
end;
$safe_link_normalization_parity$;

rollback;
