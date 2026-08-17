-- The annotation confirmation writes one combined link set.  The original
-- closed validators were correct, but their annotation branch counted every
-- master/JWB/current relaxed key once *per link*.  At 333 reviewed links that
-- became a row-times-source scan inside both the explicit confirmation guard
-- and the BEFORE trigger, exceeding the existing eight-second local timeout.
--
-- This is a forward-only performance repair.  It preserves the existing
-- helper signatures and the trigger/canonical projection boundary.  Each
-- helper below normalizes every source name once, materializes its source and
-- relaxed-key counts once, then joins/maps the complete link set against
-- those finite relations.

create or replace function internal.student_import_identity_link_names_mismatch(
  p_master_rows jsonb,
  p_jwb_rows jsonb,
  p_links jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  mismatch boolean;
begin
  if jsonb_typeof(p_master_rows) <> 'array'
     or jsonb_typeof(p_jwb_rows) <> 'array'
     or jsonb_typeof(p_links) <> 'array' then
    return true;
  end if;

  -- The common preview/first-confirmation state has no prior links.  Avoid
  -- normalizing source snapshots merely to prove an empty set is valid.
  if jsonb_array_length(p_links) = 0 then
    return false;
  end if;

  with master_display as materialized (
    select internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_display_name(item.value ->> 'name') as display_name
    from jsonb_array_elements(p_master_rows) item(value)
  ), master_rows as materialized (
    select source_key, display_name,
      internal.student_import_annotation_name_key_from_display_name(
        display_name
      ) as name_key,
      internal.student_import_jwb_annotation_key_from_display(
        display_name
      ) as annotation_key
    from master_display
  ), master_normalized as materialized (
    select source_key, display_name, name_key,
      coalesce(nullif(annotation_key, ''), name_key) as relaxed_key
    from master_rows
  ), master_relaxed_counts as materialized (
    select relaxed_key, count(*)::integer as relaxed_count
    from master_normalized
    group by relaxed_key
  ), jwb_display as materialized (
    select internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_display_name(item.value ->> 'name') as display_name
    from jsonb_array_elements(p_jwb_rows) item(value)
  ), jwb_rows as materialized (
    select source_key,
      internal.student_import_annotation_name_key_from_display_name(
        display_name
      ) as name_key,
      internal.student_import_jwb_annotation_key_from_display(
        display_name
      ) as annotation_key
    from jwb_display
  ), jwb_normalized as materialized (
    select source_key, name_key, annotation_key,
      coalesce(nullif(annotation_key, ''), name_key) as relaxed_key
    from jwb_rows
  ), jwb_relaxed_counts as materialized (
    select relaxed_key, count(*)::integer as relaxed_count
    from jwb_normalized
    group by relaxed_key
  ), links as materialized (
    select jsonb_typeof(item.value -> 'matchStrategy') as strategy_type,
      item.value ? 'matchStrategy' as has_strategy,
      item.value ? 'jwbSourceRow' as has_jwb_source,
      item.value ->> 'matchStrategy' as strategy,
      internal.student_import_source_key(item.value -> 'masterSourceRow') as master_source_key,
      internal.student_import_source_key(item.value -> 'jwbSourceRow') as jwb_source_key
    from jsonb_array_elements(p_links) item(value)
  )
  select exists (
    select 1
    from links link
    left join master_normalized master
      on master.source_key = link.master_source_key
    left join jwb_normalized jwb
      on jwb.source_key = link.jwb_source_key
    left join master_relaxed_counts master_collision
      on master_collision.relaxed_key = master.name_key
    left join jwb_relaxed_counts jwb_collision
      on jwb_collision.relaxed_key = master.name_key
    where (
      not link.has_strategy
      and link.has_jwb_source
      and (
        master.source_key is null
        or jwb.source_key is null
        or master.name_key = ''
        or master.name_key <> jwb.name_key
      )
    ) or (
      link.has_strategy
      and (
        link.strategy_type <> 'string'
        or link.strategy <> 'jwb_latin_parenthetical_annotation_v1'
        or not link.has_jwb_source
        or master.source_key is null
        or jwb.source_key is null
        or position('(' in master.display_name) > 0
        or position(')' in master.display_name) > 0
        or master.name_key = ''
        -- A strategy-bearing link must remain a non-exact, one-way pair.
        or master.name_key = jwb.name_key
        or master.name_key <> jwb.annotation_key
        -- These global counts include every raw source row.  A literal
        -- parenthesized master/JWB entry remains a strict shadow, exactly as
        -- under the original correlated predicate.
        or coalesce(master_collision.relaxed_count, 0) <> 1
        or coalesce(jwb_collision.relaxed_count, 0) <> 1
      )
    )
  ) into mismatch;

  return coalesce(mismatch, false);
end;
$$;

revoke all on function internal.student_import_identity_link_names_mismatch(jsonb, jsonb, jsonb)
  from public, anon, authenticated;

create or replace function internal.student_import_identity_link_existing_names_mismatch(
  p_master_rows jsonb,
  p_current_students jsonb,
  p_links jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  mismatch boolean;
begin
  if jsonb_typeof(p_master_rows) <> 'array'
     or jsonb_typeof(p_current_students) <> 'array'
     or jsonb_typeof(p_links) <> 'array' then
    return true;
  end if;

  if jsonb_array_length(p_links) = 0 then
    return false;
  end if;

  with master_display as materialized (
    select internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_display_name(item.value ->> 'name') as display_name
    from jsonb_array_elements(p_master_rows) item(value)
  ), master_normalized as materialized (
    select source_key,
      internal.student_import_annotation_name_key_from_display_name(
        display_name
      ) as name_key
    from master_display
  ), student_display as materialized (
    select internal.student_import_js_trim(item.value ->> 'id') as student_id,
      internal.student_import_display_name(item.value ->> 'name') as display_name
    from jsonb_array_elements(p_current_students) item(value)
    where jsonb_typeof(item.value -> 'id') = 'string'
  ), student_rows as materialized (
    select student_id,
      internal.student_import_annotation_name_key_from_display_name(
        display_name
      ) as name_key,
      internal.student_import_jwb_annotation_key_from_display(
        display_name
      ) as annotation_key
    from student_display
  ), student_normalized as materialized (
    select student_id, name_key,
      coalesce(nullif(annotation_key, ''), name_key) as relaxed_key
    from student_rows
  ), student_by_id as materialized (
    select student_id, jsonb_object_agg(name_key, true) as name_keys
    from student_normalized
    group by student_id
  ), student_relaxed_ids as materialized (
    select relaxed_key, jsonb_object_agg(student_id, true) as ids
    from (
      select distinct relaxed_key, student_id
      from student_normalized
    ) distinct_student
    group by relaxed_key
  ), links as materialized (
    select item.value ->> 'matchStrategy' as strategy,
      internal.student_import_source_key(item.value -> 'masterSourceRow') as master_source_key,
      internal.student_import_js_trim(item.value ->> 'studentId') as student_id
    from jsonb_array_elements(p_links) item(value)
  )
  select exists (
    select 1
    from links link
    left join master_normalized master
      on master.source_key = link.master_source_key
    left join student_by_id current_student
      on current_student.student_id = link.student_id
    left join student_relaxed_ids current_collision
      on current_collision.relaxed_key = master.name_key
    where master.source_key is null
      or master.name_key = ''
      or (
        current_student.name_keys is not null
        and (current_student.name_keys - master.name_key) <> '{}'::jsonb
      )
      or (
        link.strategy = 'jwb_latin_parenthetical_annotation_v1'
        and coalesce(current_collision.ids - link.student_id, '{}'::jsonb) <> '{}'::jsonb
      )
  ) into mismatch;

  return coalesce(mismatch, false);
end;
$$;

revoke all on function internal.student_import_identity_link_existing_names_mismatch(jsonb, jsonb, jsonb)
  from public, anon, authenticated;

-- `put_student_import_identity_annotation_review` already derives the whole
-- candidate set while holding all four locks, and the link-set BEFORE trigger
-- remains the authoritative write boundary.  Its former final preflight
-- repeated raw + resolved name validation and member-ID validation just before
-- inserting the exact same `combined_links`; on a 333-link batch that was the
-- timeout source.  Remove only that redundant preflight.  A trigger failure
-- aborts the surrounding transaction, including the audit insert, so this
-- does not weaken atomicity or permit a malformed durable link set.
do $annotation_confirmation_preflight_patch$
declare
  function_definition text;
  preflight_anchor text := $preflight$
  -- Validate the final durable representation before recording audit
  -- evidence. The link-set trigger repeats these checks at the write
  -- boundary; retaining this explicit guard makes the failure deterministic.
  if internal.student_import_identity_link_names_mismatch(
      resolved_master_rows, jwb.rows, combined_links
    ) or internal.student_import_identity_link_names_mismatch(
      master.rows, jwb.rows, combined_links
    ) or internal.student_import_identity_link_existing_names_mismatch(
      resolved_master_rows, students_state.payload, combined_links
    ) or internal.student_import_identity_link_existing_names_mismatch(
      master.rows, students_state.payload, combined_links
    ) or internal.student_import_identity_link_master_jwb_member_id_conflict(
      master.rows, combined_links
    ) then
    raise exception using errcode = '23503',
      message = 'student_import_identity_annotation_review_combined_invalid';
  end if;

$preflight$;
  replacement text := $replacement$
  -- The BEFORE trigger on internal.student_import_identity_link_sets is the
  -- final authoritative boundary. It revalidates this exact combined set;
  -- keeping a second raw/resolved preflight here only repeats source-wide
  -- work and cannot make an invalid row durable.
$replacement$;
  anchor_count integer;
begin
  select pg_catalog.pg_get_functiondef(
    'public.put_student_import_identity_annotation_review(text,text,text)'::regprocedure
  ) into function_definition;
  if function_definition is null then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_confirmation_put_missing';
  end if;
  anchor_count := (
    length(function_definition) - length(replace(function_definition, preflight_anchor, ''))
  ) / length(preflight_anchor);
  if anchor_count <> 1 then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_confirmation_preflight_anchor_mismatch';
  end if;
  execute replace(function_definition, preflight_anchor, replacement);
  if position('student_import_identity_annotation_review_combined_invalid' in
    pg_catalog.pg_get_functiondef(
      'public.put_student_import_identity_annotation_review(text,text,text)'::regprocedure
    )) > 0 then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_confirmation_preflight_patch_failed';
  end if;
end;
$annotation_confirmation_preflight_patch$;

-- Exercise the replacement helpers themselves, including the three shadow
-- guards that made this exception safe.  These have no production data and
-- keep the canonical projection on the same validator boundary.
do $annotation_confirmation_validator_fixture$
declare
  annotation_link jsonb := jsonb_build_array(jsonb_build_object(
    'masterSourceRow', 'M-1',
    'jwbSourceRow', 'J-1',
    'studentId', 'STU-ANNOTATION-FIXTURE',
    'matchStrategy', 'jwb_latin_parenthetical_annotation_v1'
  ));
begin
  if internal.student_import_identity_link_names_mismatch(
       '[{"sourceRow":"M-1","name":"Learner"}]'::jsonb,
       '[{"sourceRow":"J-1","name":"Learner(VIC)"}]'::jsonb,
       '[]'::jsonb
     )
     or internal.student_import_identity_link_existing_names_mismatch(
       '[{"sourceRow":"M-1","name":"Learner"}]'::jsonb,
       '[{"id":"STU-ANNOTATION-FIXTURE","name":"Learner"}]'::jsonb,
       '[]'::jsonb
     )
     or internal.student_import_identity_link_names_mismatch(
       '[{"sourceRow":"M-1","name":"Learner"}]'::jsonb,
       '[{"sourceRow":"J-1","name":"Learner(VIC)"}]'::jsonb,
       annotation_link
     )
     or internal.student_import_identity_link_existing_names_mismatch(
       '[{"sourceRow":"M-1","name":"Learner"}]'::jsonb,
       '[{"id":"STU-ANNOTATION-FIXTURE","name":"Learner"}]'::jsonb,
       annotation_link
     )
     or not internal.student_import_identity_link_names_mismatch(
       '[{"sourceRow":"M-1","name":"Learner"},{"sourceRow":"M-shadow","name":"Learner(VIC)"}]'::jsonb,
       '[{"sourceRow":"J-1","name":"Learner(VIC)"}]'::jsonb,
       annotation_link
     )
     or not internal.student_import_identity_link_names_mismatch(
       '[{"sourceRow":"M-1","name":"Learner"}]'::jsonb,
       '[{"sourceRow":"J-1","name":"Learner(VIC)"},{"sourceRow":"J-shadow","name":"Learner"}]'::jsonb,
       annotation_link
     )
     or not internal.student_import_identity_link_existing_names_mismatch(
       '[{"sourceRow":"M-1","name":"Learner"}]'::jsonb,
       '[{"id":"STU-ANNOTATION-FIXTURE","name":"Learner"},{"id":"STU-SHADOW","name":"Learner(VIC)"}]'::jsonb,
       annotation_link
     )
     or not internal.student_import_identity_link_existing_names_mismatch(
       '[{"sourceRow":"M-1","name":"Learner"}]'::jsonb,
       '[{"id":"STU-ANNOTATION-FIXTURE","name":"Different"}]'::jsonb,
       annotation_link
     )
     or not internal.student_import_identity_link_names_mismatch(
       '[{"sourceRow":"M-1","name":"Learner"}]'::jsonb,
       '[{"sourceRow":"J-1","name":"Learner(VIC)"}]'::jsonb,
       '[{"masterSourceRow":"M-1","jwbSourceRow":"J-1","studentId":"STU-ANNOTATION-FIXTURE","matchStrategy":"other"}]'::jsonb
     ) then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_confirmation_validator_fixture_mismatch';
  end if;

  -- This is the final canonical consumer of the helper. A master literal
  -- annotation shadow must still be rejected after the performance rewrite.
  begin
    perform internal.student_import_canonical_projection(
      'annotation-confirmation-fixture',
      '[{"sourceRow":"M-1","name":"Learner","status":"在读"},{"sourceRow":"M-shadow","name":"Learner(VIC)","status":"在读"}]'::jsonb,
      '[{"sourceRow":"J-1","name":"Learner(VIC)","remainingHours":1,"contractHours":1,"packageCoverage":"none"}]'::jsonb,
      '[]'::jsonb,
      annotation_link,
      '[]'::jsonb
    );
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_confirmation_projection_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'student_import_identity_link_name_mismatch' then
      raise;
    end if;
  end;

  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'internal.student_import_identity_link_sets'::regclass
      and trigger_row.tgname = 'enforce_student_import_identity_link_exact_names'
      and not trigger_row.tgisinternal
  ) then
    raise exception using errcode = 'P0001',
      message = 'student_import_annotation_confirmation_trigger_missing';
  end if;
end;
$annotation_confirmation_validator_fixture$;
