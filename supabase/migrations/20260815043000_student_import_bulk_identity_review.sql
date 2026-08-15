-- Atomically confirm the complete current set of exact, unique-Han matches
-- that merge into exactly one existing student. This contract never creates
-- identities and never accepts names, source rows, student IDs or decisions.

-- Resolve duplicate-master decisions once before building the merge snapshot.
-- Pending duplicate groups remain absent and are never part of this batch.
create or replace function internal.student_import_identity_resolved_master_rows(
  p_master_rows jsonb,
  p_duplicate_snapshot jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  resolved_rows jsonb;
begin
  if jsonb_typeof(p_master_rows) <> 'array'
     or jsonb_typeof(p_duplicate_snapshot) <> 'object'
     or jsonb_typeof(p_duplicate_snapshot -> 'candidates') <> 'array'
     or jsonb_typeof(p_duplicate_snapshot -> 'decisions') <> 'array' then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_bulk_snapshot';
  end if;

  select coalesce(jsonb_agg(resolved_row order by
    internal.student_import_utf16_sort_key(resolved_row ->> 'sourceRow')
  ), '[]'::jsonb)
  into resolved_rows
  from (
    select case
      when matched.duplicate_decision ->> 'decision' = 'select'
       and master_row.value ->> 'sourceRow' =
         matched.duplicate_decision ->> 'selectedSourceRow'
       and nullif(matched.duplicate_decision ->> 'selectedStatus', '') is not null
      then jsonb_set(
        master_row.value, '{status}',
        to_jsonb(matched.duplicate_decision ->> 'selectedStatus'), true
      )
      else master_row.value end as resolved_row
    from jsonb_array_elements(p_master_rows) master_row(value)
    left join lateral (
      select saved_decision.value as duplicate_decision
      from jsonb_array_elements(p_duplicate_snapshot -> 'decisions')
        saved_decision(value)
      where exists (
        select 1
        from jsonb_array_elements_text(saved_decision.value -> 'sourceRows')
          source_row(value)
        where source_row.value = master_row.value ->> 'sourceRow'
      )
      limit 1
    ) matched on true
    where (
      matched.duplicate_decision is null
      or (
        matched.duplicate_decision ->> 'decision' = 'select'
        and master_row.value ->> 'sourceRow' =
          matched.duplicate_decision ->> 'selectedSourceRow'
      )
    )
    and not exists (
      select 1
      from jsonb_array_elements(p_duplicate_snapshot -> 'candidates')
        pending_candidate(value)
      where exists (
        select 1
        from jsonb_array_elements(pending_candidate.value -> 'sourceRows')
          pending_row(value)
        where internal.student_import_source_key(pending_row.value) =
          internal.student_import_source_key(master_row.value -> 'sourceRow')
      )
      and not exists (
        select 1
        from jsonb_array_elements(p_duplicate_snapshot -> 'decisions')
          saved_decision(value)
        where saved_decision.value -> 'sourceRows' =
          pending_candidate.value -> 'sourceRows'
      )
    )
  ) resolved;

  return resolved_rows;
end;
$$;

-- This is deliberately separate from student_import_identity_review_candidates.
-- The older helper computes deterministic IDs inside correlated scans and is
-- too slow at production scale. Every name key and every eligible-master
-- deterministic owner ID below is materialized exactly once.
create or replace function internal.student_import_identity_bulk_merge_candidates(
  p_master_source_id text,
  p_master_revision text,
  p_master_rows jsonb,
  p_jwb_source_id text,
  p_jwb_revision text,
  p_jwb_rows jsonb,
  p_students_version bigint,
  p_review_epoch bigint,
  p_students jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  merge_candidates jsonb;
begin
  if nullif(trim(p_master_source_id), '') is null
     or length(p_master_source_id) > 160
     or nullif(trim(p_master_revision), '') is null
     or length(p_master_revision) > 240
     or nullif(trim(p_jwb_source_id), '') is null
     or length(p_jwb_source_id) > 160
     or nullif(trim(p_jwb_revision), '') is null
     or length(p_jwb_revision) > 240
     or p_students_version is null
     or p_students_version < 0
     or p_students_version > 9007199254740991
     or p_review_epoch is null
     or p_review_epoch < 0
     or p_review_epoch > 9007199254740991
     or jsonb_typeof(p_master_rows) <> 'array'
     or jsonb_typeof(p_jwb_rows) <> 'array'
     or jsonb_typeof(p_students) <> 'array'
     or jsonb_array_length(p_master_rows) > 10000
     or jsonb_array_length(p_jwb_rows) > 10000
     or jsonb_array_length(p_students) > 10000 then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_bulk_candidate_input';
  end if;

  if exists (
      select 1 from jsonb_array_elements(p_master_rows) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or internal.student_import_source_key(item.value -> 'sourceRow') is null
    )
    or (select count(*) from jsonb_array_elements(p_master_rows)) <>
      (select count(distinct internal.student_import_source_key(item.value -> 'sourceRow'))
       from jsonb_array_elements(p_master_rows) item(value))
    or exists (
      select 1 from jsonb_array_elements(p_jwb_rows) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or internal.student_import_source_key(item.value -> 'sourceRow') is null
    )
    or (select count(*) from jsonb_array_elements(p_jwb_rows)) <>
      (select count(distinct internal.student_import_source_key(item.value -> 'sourceRow'))
       from jsonb_array_elements(p_jwb_rows) item(value))
    or exists (
      select 1 from jsonb_array_elements(p_students) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or jsonb_typeof(item.value -> 'id') <> 'string'
        or nullif(item.value ->> 'id', '') is null
        or item.value ->> 'id' <> trim(item.value ->> 'id')
        or length(item.value ->> 'id') > 240
    )
    or (select count(*) from jsonb_array_elements(p_students)) <>
      (select count(distinct item.value ->> 'id')
       from jsonb_array_elements(p_students) item(value)) then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_bulk_candidate_rows';
  end if;

  with master_raw as materialized (
    select item.value as row_value,
      item.value -> 'sourceRow' as source_row,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_master_review_name_key(item.value ->> 'name') as review_key,
      trim(coalesce(item.value ->> 'status', '')) as status
    from jsonb_array_elements(p_master_rows) item(value)
  ), master_basis as materialized (
    select master_raw.*,
      count(*) over (partition by review_key) as review_key_count
    from master_raw
  ), active_master as materialized (
    select * from master_basis
    where status in (
        '在读', '活跃 + 无课时', '活跃 + 有课时',
        '不活跃 + 有课时', '在读 + 加课待排'
      )
  ), eligible_master as materialized (
    select * from active_master
    where review_key <> '' and review_key_count = 1
  ), jwb_raw as materialized (
    select item.value as row_value,
      item.value -> 'sourceRow' as source_row,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key,
      internal.student_import_master_review_name_key(item.value ->> 'name') as review_key
    from jsonb_array_elements(p_jwb_rows) item(value)
  ), jwb_basis as materialized (
    select jwb_raw.*,
      count(*) over (partition by review_key) as review_key_count
    from jwb_raw
  ), unique_jwb as materialized (
    select * from jwb_basis
    where review_key <> '' and review_key_count = 1
  ), student_raw as materialized (
    select item.value ->> 'id' as student_id,
      internal.student_import_master_review_name_key(item.value ->> 'name') as review_key
    from jsonb_array_elements(p_students) item(value)
  ), student_basis as materialized (
    select student_raw.*,
      count(*) over (partition by review_key) as review_key_count
    from student_raw
  ), unique_student as materialized (
    select * from student_basis
    where review_key <> '' and review_key_count = 1
  ), paired as materialized (
    select master.source_row as master_source_row,
      master.source_key as master_source_key,
      master.review_key,
      jwb.source_row as jwb_source_row,
      jwb.source_key as jwb_source_key,
      student.student_id
    from eligible_master master
    join unique_jwb jwb using (review_key)
    join unique_student student using (review_key)
  ), derived_targets as materialized (
    select distinct paired.student_id
    from paired
    -- Every deterministic master identity has this fixed prefix. Most legacy
    -- existing students do not, so the expensive FNV owner map can be skipped
    -- completely without weakening the collision guard.
    where paired.student_id like 'STU-M-%'
  ), owner_basis as materialized (
    select active_master.*,
      internal.student_import_student_id(
        p_master_source_id, active_master.source_row
      ) as derived_student_id
    from active_master
    where exists (select 1 from derived_targets)
  ), safe_merges as materialized (
    select paired.*
    from paired
    where not exists (
      select 1 from owner_basis owner
      where owner.derived_student_id = paired.student_id
        and owner.source_key <> paired.master_source_key
    )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'masterSourceRow', safe_merges.master_source_row,
    'jwbSourceRow', safe_merges.jwb_source_row,
    'studentId', safe_merges.student_id
  ) order by
    internal.student_import_utf16_sort_key(safe_merges.master_source_key),
    internal.student_import_utf16_sort_key(safe_merges.jwb_source_key),
    internal.student_import_utf16_sort_key(safe_merges.student_id)
  ), '[]'::jsonb)
  into merge_candidates
  from safe_merges;

  if jsonb_array_length(merge_candidates) <>
       (select count(distinct internal.student_import_source_key(
          item.value -> 'masterSourceRow'))
        from jsonb_array_elements(merge_candidates) item(value))
     or jsonb_array_length(merge_candidates) <>
       (select count(distinct internal.student_import_source_key(
          item.value -> 'jwbSourceRow'))
        from jsonb_array_elements(merge_candidates) item(value))
     or jsonb_array_length(merge_candidates) <>
       (select count(distinct trim(item.value ->> 'studentId'))
        from jsonb_array_elements(merge_candidates) item(value)) then
    raise exception using errcode = '23505',
      message = 'student_import_identity_bulk_review_candidate_conflict';
  end if;

  return merge_candidates;
end;
$$;

revoke all on function internal.student_import_identity_resolved_master_rows(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_identity_bulk_merge_candidates(
  text, text, jsonb, text, text, jsonb, bigint, bigint, jsonb
) from public, anon, authenticated;

-- Classify the complete merge set against current reviewed links in one
-- set-based pass. Exact triples are idempotently retained; any partial reuse
-- of a master row, JWB row or target student aborts the whole batch.
create or replace function internal.student_import_identity_bulk_merge_plan(
  p_merge_candidates jsonb,
  p_active_links jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  active_basis jsonb;
  candidate_basis jsonb;
  pending_basis jsonb;
  combined_basis jsonb;
  pending_links jsonb;
  combined_links jsonb;
  merge_candidate_count integer;
  pending_merge_count integer;
  already_linked_count integer;
  plan_fingerprint text;
  has_conflict boolean;
begin
  if jsonb_typeof(p_merge_candidates) <> 'array'
     or jsonb_typeof(p_active_links) <> 'array'
     or jsonb_array_length(p_merge_candidates) > 10000
     or jsonb_array_length(p_active_links) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_merge_candidates) item(value)
       where jsonb_typeof(item.value) <> 'object'
         or item.value - 'masterSourceRow' - 'jwbSourceRow' - 'studentId' <> '{}'::jsonb
         or jsonb_typeof(item.value -> 'masterSourceRow') not in ('string', 'number')
         or jsonb_typeof(item.value -> 'jwbSourceRow') not in ('string', 'number')
         or jsonb_typeof(item.value -> 'studentId') <> 'string'
         or nullif(item.value ->> 'studentId', '') is null
         or item.value ->> 'studentId' <> trim(item.value ->> 'studentId')
         or length(item.value ->> 'studentId') > 240
     )
     or exists (
       select 1 from jsonb_array_elements(p_active_links) item(value)
       where jsonb_typeof(item.value) <> 'object'
         or item.value - 'masterSourceRow' - 'jwbSourceRow' - 'studentId' <> '{}'::jsonb
         or jsonb_typeof(item.value -> 'masterSourceRow') not in ('string', 'number')
         or jsonb_typeof(item.value -> 'studentId') <> 'string'
         or nullif(item.value ->> 'studentId', '') is null
         or item.value ->> 'studentId' <> trim(item.value ->> 'studentId')
         or length(item.value ->> 'studentId') > 240
         or (item.value ? 'jwbSourceRow'
           and jsonb_typeof(item.value -> 'jwbSourceRow') not in ('string', 'number', 'null'))
     ) then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_bulk_plan_input';
  end if;

  -- Compute each canonical source key once and retain it in an internal-only
  -- index object. Subsequent conflict/classification work never calls the
  -- source-key normalizer inside a candidate-by-active nested loop.
  select coalesce(jsonb_agg(jsonb_build_object(
    'link', basis.link,
    'masterKey', basis.master_key,
    'jwbKey', basis.jwb_key,
    'studentId', basis.student_id
  ) order by
    internal.student_import_utf16_sort_key(basis.master_key),
    internal.student_import_utf16_sort_key(coalesce(basis.jwb_key, '')),
    internal.student_import_utf16_sort_key(basis.student_id)
  ), '[]'::jsonb)
  into active_basis
  from (
    select jsonb_strip_nulls(jsonb_build_object(
        'masterSourceRow', item.value -> 'masterSourceRow',
        'studentId', item.value ->> 'studentId',
        'jwbSourceRow', case
          when item.value ? 'jwbSourceRow'
           and jsonb_typeof(item.value -> 'jwbSourceRow') <> 'null'
          then item.value -> 'jwbSourceRow' else null end
      )) as link,
      internal.student_import_source_key(item.value -> 'masterSourceRow') as master_key,
      case when item.value ? 'jwbSourceRow'
             and jsonb_typeof(item.value -> 'jwbSourceRow') <> 'null'
        then internal.student_import_source_key(item.value -> 'jwbSourceRow')
        else null end as jwb_key,
      item.value ->> 'studentId' as student_id
    from jsonb_array_elements(p_active_links) item(value)
  ) basis;

  select coalesce(jsonb_agg(jsonb_build_object(
    'link', basis.link,
    'masterKey', basis.master_key,
    'jwbKey', basis.jwb_key,
    'studentId', basis.student_id
  ) order by
    internal.student_import_utf16_sort_key(basis.master_key),
    internal.student_import_utf16_sort_key(basis.jwb_key),
    internal.student_import_utf16_sort_key(basis.student_id)
  ), '[]'::jsonb)
  into candidate_basis
  from (
    select jsonb_build_object(
        'masterSourceRow', item.value -> 'masterSourceRow',
        'jwbSourceRow', item.value -> 'jwbSourceRow',
        'studentId', item.value ->> 'studentId'
      ) as link,
      internal.student_import_source_key(item.value -> 'masterSourceRow') as master_key,
      internal.student_import_source_key(item.value -> 'jwbSourceRow') as jwb_key,
      item.value ->> 'studentId' as student_id
    from jsonb_array_elements(p_merge_candidates) item(value)
  ) basis;

  if exists (
       select 1 from jsonb_array_elements(active_basis) item(value)
       where nullif(item.value ->> 'masterKey', '') is null
         or nullif(item.value ->> 'studentId', '') is null
         or (item.value ->> 'jwbKey' is not null
           and nullif(item.value ->> 'jwbKey', '') is null)
     )
     or jsonb_array_length(active_basis) <>
       (select count(distinct item.value ->> 'masterKey')
        from jsonb_array_elements(active_basis) item(value))
     or jsonb_array_length(active_basis) <>
       (select count(distinct item.value ->> 'studentId')
        from jsonb_array_elements(active_basis) item(value))
     or (select count(*) from jsonb_array_elements(active_basis) item(value)
         where item.value ->> 'jwbKey' is not null) <>
       (select count(distinct item.value ->> 'jwbKey')
        from jsonb_array_elements(active_basis) item(value)
        where item.value ->> 'jwbKey' is not null) then
    raise exception using errcode = '23505',
      message = 'student_import_identity_bulk_review_active_links_conflict';
  end if;

  merge_candidate_count := jsonb_array_length(candidate_basis);
  if exists (
       select 1 from jsonb_array_elements(candidate_basis) item(value)
       where nullif(item.value ->> 'masterKey', '') is null
         or nullif(item.value ->> 'jwbKey', '') is null
         or nullif(item.value ->> 'studentId', '') is null
     )
     or merge_candidate_count <>
       (select count(distinct item.value ->> 'masterKey')
        from jsonb_array_elements(candidate_basis) item(value))
     or merge_candidate_count <>
       (select count(distinct item.value ->> 'jwbKey')
        from jsonb_array_elements(candidate_basis) item(value))
     or merge_candidate_count <>
       (select count(distinct item.value ->> 'studentId')
        from jsonb_array_elements(candidate_basis) item(value)) then
    raise exception using errcode = '23505',
      message = 'student_import_identity_bulk_review_candidate_conflict';
  end if;

  -- Three equality joins allow PostgreSQL to use hash joins. Any reuse whose
  -- complete triple differs is a batch-wide conflict.
  with active_index as materialized (
    select item.value ->> 'masterKey' as master_key,
      item.value ->> 'jwbKey' as jwb_key,
      item.value ->> 'studentId' as student_id
    from jsonb_array_elements(active_basis) item(value)
  ), candidate_index as materialized (
    select item.value ->> 'masterKey' as master_key,
      item.value ->> 'jwbKey' as jwb_key,
      item.value ->> 'studentId' as student_id
    from jsonb_array_elements(candidate_basis) item(value)
  ), conflicts as (
    select 1
    from candidate_index candidate
    join active_index active using (master_key)
    where row(active.master_key, active.jwb_key, active.student_id)
      is distinct from row(candidate.master_key, candidate.jwb_key, candidate.student_id)
    union all
    select 1
    from candidate_index candidate
    join active_index active using (jwb_key)
    where row(active.master_key, active.jwb_key, active.student_id)
      is distinct from row(candidate.master_key, candidate.jwb_key, candidate.student_id)
    union all
    select 1
    from candidate_index candidate
    join active_index active using (student_id)
    where row(active.master_key, active.jwb_key, active.student_id)
      is distinct from row(candidate.master_key, candidate.jwb_key, candidate.student_id)
  )
  select exists (select 1 from conflicts) into has_conflict;
  if has_conflict then
    raise exception using errcode = '23505',
      message = 'student_import_identity_bulk_review_conflict';
  end if;

  -- Exact classification is one three-column equality join, not one
  -- correlated scan per candidate.
  with active_index as materialized (
    select item.value ->> 'masterKey' as master_key,
      item.value ->> 'jwbKey' as jwb_key,
      item.value ->> 'studentId' as student_id
    from jsonb_array_elements(active_basis) item(value)
  ), candidate_index as materialized (
    select item.value,
      item.value ->> 'masterKey' as master_key,
      item.value ->> 'jwbKey' as jwb_key,
      item.value ->> 'studentId' as student_id
    from jsonb_array_elements(candidate_basis) item(value)
  ), classified as materialized (
    select candidate.value, active.master_key is not null as already_linked
    from candidate_index candidate
    left join active_index active
      on active.master_key = candidate.master_key
     and active.jwb_key = candidate.jwb_key
     and active.student_id = candidate.student_id
  )
  select
    coalesce(jsonb_agg(classified.value order by
      internal.student_import_utf16_sort_key(classified.value ->> 'masterKey'),
      internal.student_import_utf16_sort_key(classified.value ->> 'jwbKey'),
      internal.student_import_utf16_sort_key(classified.value ->> 'studentId')
    ) filter (where not classified.already_linked), '[]'::jsonb),
    count(*) filter (where not classified.already_linked)::integer,
    count(*) filter (where classified.already_linked)::integer
  into pending_basis, pending_merge_count, already_linked_count
  from classified;

  combined_basis := active_basis || pending_basis;
  select coalesce(jsonb_agg(item.value -> 'link' order by
    internal.student_import_utf16_sort_key(item.value ->> 'masterKey'),
    internal.student_import_utf16_sort_key(coalesce(item.value ->> 'jwbKey', '')),
    internal.student_import_utf16_sort_key(item.value ->> 'studentId')
  ), '[]'::jsonb)
  into combined_links
  from jsonb_array_elements(combined_basis) item(value);

  -- Avoid an equality scan against pending_basis when producing the public
  -- plan material: it is already canonical and contains only pending rows.
  select coalesce(jsonb_agg(item.value -> 'link' order by
    internal.student_import_utf16_sort_key(item.value ->> 'masterKey'),
    internal.student_import_utf16_sort_key(item.value ->> 'jwbKey'),
    internal.student_import_utf16_sort_key(item.value ->> 'studentId')
  ), '[]'::jsonb)
  into pending_links
  from jsonb_array_elements(pending_basis) item(value);

  if jsonb_array_length(combined_basis) > 10000
     or jsonb_array_length(combined_basis) <>
       jsonb_array_length(active_basis) + pending_merge_count
     or jsonb_array_length(combined_basis) <>
       (select count(distinct item.value ->> 'masterKey')
        from jsonb_array_elements(combined_basis) item(value))
     or jsonb_array_length(combined_basis) <>
       (select count(distinct item.value ->> 'studentId')
        from jsonb_array_elements(combined_basis) item(value))
     or (select count(*) from jsonb_array_elements(combined_basis) item(value)
         where item.value ->> 'jwbKey' is not null) <>
       (select count(distinct item.value ->> 'jwbKey')
        from jsonb_array_elements(combined_basis) item(value)
        where item.value ->> 'jwbKey' is not null) then
    raise exception using errcode = '23505',
      message = 'student_import_identity_bulk_review_conflict';
  end if;

  plan_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'contract', 'student-import-identity-bulk-merge-plan-v1',
    'pendingLinks', pending_links
  )::text, 'sha256'), 'hex');

  return jsonb_build_object(
    'mergeCandidateCount', merge_candidate_count,
    'pendingMergeCount', pending_merge_count,
    'alreadyLinkedMergeCount', already_linked_count,
    'currentLinkCount', jsonb_array_length(active_basis),
    'resultingLinkCount', jsonb_array_length(combined_links),
    'combinedLinks', combined_links,
    'planFingerprint', plan_fingerprint
  );
end;
$$;

create or replace function internal.student_import_identity_bulk_review_key(
  p_master_source_id text,
  p_master_revision text,
  p_master_rows_sha256 text,
  p_jwb_source_id text,
  p_jwb_revision text,
  p_jwb_rows_sha256 text,
  p_students_version bigint,
  p_review_epoch bigint,
  p_active_link_fingerprint text,
  p_duplicate_resolution_fingerprint text,
  p_plan_fingerprint text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'contract', 'student-import-identity-bulk-review-v1',
    'master', jsonb_build_object(
      'sourceId', p_master_source_id,
      'revision', p_master_revision,
      'rowsSha256', p_master_rows_sha256
    ),
    'jwb', jsonb_build_object(
      'sourceId', p_jwb_source_id,
      'revision', p_jwb_revision,
      'rowsSha256', p_jwb_rows_sha256
    ),
    'studentsVersion', p_students_version,
    'reviewEpoch', p_review_epoch,
    'activeLinkFingerprint', p_active_link_fingerprint,
    'duplicateResolutionFingerprint', p_duplicate_resolution_fingerprint,
    'planFingerprint', p_plan_fingerprint
  )::text, 'sha256'), 'hex')
$$;

revoke all on function internal.student_import_identity_bulk_merge_plan(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_identity_bulk_review_key(
  text, text, text, text, text, text, bigint, bigint, text, text, text
) from public, anon, authenticated;

create or replace function public.get_student_import_identity_bulk_review_preview(
  p_secret text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  active_links jsonb := '[]'::jsonb;
  active_fingerprint text;
  duplicate_snapshot jsonb;
  resolved_master_rows jsonb;
  merge_candidates jsonb;
  merge_plan jsonb;
  confirmation_key text;
  review_epoch bigint;
  saved_matches_current boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into jwb from internal.student_import_source_rows source_state
    where source_state.source_kind = 'jwb';
  select * into master from internal.student_import_source_rows source_state
    where source_state.source_kind = 'master';
  select * into saved from internal.student_import_identity_link_sets identity_state
    where identity_state.singleton;
  select * into students_state from public.ops_state state_row
    where state_row.entity = 'students';

  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002',
      message = 'student_import_source_rows_unavailable';
  end if;
  if students_state.entity is null
     or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  review_epoch := coalesce(saved.review_epoch, 0);
  if review_epoch < 0 or review_epoch > 9007199254740991 then
    raise exception using errcode = '55000',
      message = 'student_import_identity_review_epoch_invalid';
  end if;

  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version then
    saved_matches_current := true;
    active_links := saved.links;
  end if;

  active_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', active_links
  )::text, 'sha256'), 'hex');
  if saved_matches_current and (
    saved.link_count <> jsonb_array_length(active_links)
    or saved.link_fingerprint <> active_fingerprint
  ) then
    raise exception using errcode = '55000',
      message = 'student_import_identity_bulk_review_linkset_invalid';
  end if;

  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, students_state
  );
  resolved_master_rows := internal.student_import_identity_resolved_master_rows(
    master.rows, duplicate_snapshot
  );
  merge_candidates := internal.student_import_identity_bulk_merge_candidates(
    master.source_id, master.revision, resolved_master_rows,
    jwb.source_id, jwb.revision, jwb.rows,
    students_state.version, review_epoch, students_state.payload
  );
  merge_plan := internal.student_import_identity_bulk_merge_plan(
    merge_candidates, active_links
  );
  confirmation_key := internal.student_import_identity_bulk_review_key(
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch, active_fingerprint,
    duplicate_snapshot ->> 'fingerprint', merge_plan ->> 'planFingerprint'
  );

  return jsonb_build_object(
    'confirmationKey', confirmation_key,
    'mergeCandidateCount', (merge_plan ->> 'mergeCandidateCount')::integer,
    'pendingMergeCount', (merge_plan ->> 'pendingMergeCount')::integer,
    'alreadyLinkedMergeCount', (merge_plan ->> 'alreadyLinkedMergeCount')::integer,
    'currentLinkCount', (merge_plan ->> 'currentLinkCount')::integer,
    'resultingLinkCount', (merge_plan ->> 'resultingLinkCount')::integer,
    'canSubmit', (merge_plan ->> 'pendingMergeCount')::integer > 0
  );
end;
$$;

revoke all on function public.get_student_import_identity_bulk_review_preview(text)
  from public, anon, authenticated;
grant execute on function public.get_student_import_identity_bulk_review_preview(text)
  to anon, authenticated;

-- Immutable replay evidence makes a lost HTTP response recoverable without
-- repeating the audit or accepting an old key after any intervening change.
create table if not exists internal.student_import_identity_bulk_review_commands (
  confirmation_key text primary key
    check (confirmation_key ~ '^sha256:[a-f0-9]{64}$'),
  master_source_id text not null check (length(master_source_id) between 1 and 160),
  master_revision text not null check (length(master_revision) between 1 and 240),
  master_rows_sha256 text not null check (master_rows_sha256 ~ '^[a-f0-9]{64}$'),
  jwb_source_id text not null check (length(jwb_source_id) between 1 and 160),
  jwb_revision text not null check (length(jwb_revision) between 1 and 240),
  jwb_rows_sha256 text not null check (jwb_rows_sha256 ~ '^[a-f0-9]{64}$'),
  students_version bigint not null
    check (students_version between 0 and 9007199254740991),
  review_epoch bigint not null
    check (review_epoch between 0 and 9007199254740991),
  duplicate_resolution_fingerprint text not null
    check (duplicate_resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  plan_fingerprint text not null
    check (plan_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  before_link_fingerprint text not null
    check (before_link_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  after_link_fingerprint text not null
    check (after_link_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  before_link_count integer not null check (before_link_count between 0 and 10000),
  requested_count integer not null check (requested_count > 0 and requested_count <= 10000),
  newly_applied_count integer not null check (newly_applied_count > 0),
  already_applied_count integer not null check (already_applied_count >= 0),
  final_count integer not null check (final_count > 0 and final_count <= 10000),
  confirmed_by text not null check (length(confirmed_by) between 1 and 120),
  confirmed_at timestamptz not null default now(),
  audit_id uuid not null unique references internal.operational_contract_audit(id),
  check (requested_count = newly_applied_count + already_applied_count),
  check (final_count = before_link_count + newly_applied_count)
);

alter table internal.student_import_identity_bulk_review_commands enable row level security;
revoke all on table internal.student_import_identity_bulk_review_commands
  from public, anon, authenticated;

create or replace function internal.reject_student_import_identity_bulk_command_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000',
    message = 'student_import_identity_bulk_review_command_immutable';
end;
$$;

drop trigger if exists reject_student_import_identity_bulk_command_mutation
  on internal.student_import_identity_bulk_review_commands;
create trigger reject_student_import_identity_bulk_command_mutation
before update or delete on internal.student_import_identity_bulk_review_commands
for each row execute function internal.reject_student_import_identity_bulk_command_mutation();

revoke all on function internal.reject_student_import_identity_bulk_command_mutation()
  from public, anon, authenticated;

create or replace function public.put_student_import_identity_bulk_review(
  p_secret text,
  p_confirmation_key text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  prior_command internal.student_import_identity_bulk_review_commands%rowtype;
  active_links jsonb := '[]'::jsonb;
  active_fingerprint text;
  duplicate_snapshot jsonb;
  resolved_master_rows jsonb;
  merge_candidates jsonb;
  merge_plan jsonb;
  expected_key text;
  after_fingerprint text;
  audit_entry_id uuid;
  review_epoch bigint;
  saved_matches_current boolean := false;
  before_link_count integer;
  requested_count integer;
  newly_applied_count integer;
  already_applied_count integer;
  final_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_confirmation_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023',
      message = 'invalid_student_import_identity_bulk_review_request';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_identity_link_set:singleton', 0
  ));
  select * into jwb from internal.student_import_source_rows source_state
    where source_state.source_kind = 'jwb' for update;
  select * into master from internal.student_import_source_rows source_state
    where source_state.source_kind = 'master' for update;
  select * into saved from internal.student_import_identity_link_sets identity_state
    where identity_state.singleton for update;
  select * into students_state from public.ops_state state_row
    where state_row.entity = 'students' for update;

  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002',
      message = 'student_import_source_rows_unavailable';
  end if;
  if students_state.entity is null
     or jsonb_typeof(students_state.payload) <> 'array'
     or students_state.version < 0
     or students_state.version > 9007199254740991 then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  review_epoch := coalesce(saved.review_epoch, 0);
  if review_epoch < 0 or review_epoch > 9007199254740991 then
    raise exception using errcode = '55000',
      message = 'student_import_identity_review_epoch_invalid';
  end if;

  if saved.singleton
     and saved.master_source_id = master.source_id
     and saved.master_revision = master.revision
     and saved.jwb_source_id = jwb.source_id
     and saved.jwb_revision = jwb.revision
     and saved.students_version = students_state.version then
    saved_matches_current := true;
    active_links := saved.links;
  end if;
  active_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', active_links
  )::text, 'sha256'), 'hex');
  if saved_matches_current and (
    saved.link_count <> jsonb_array_length(active_links)
    or saved.link_fingerprint <> active_fingerprint
  ) then
    raise exception using errcode = '55000',
      message = 'student_import_identity_bulk_review_linkset_invalid';
  end if;

  -- Compute the duplicate snapshot once. It is both part of the CAS and the
  -- sole input to duplicate-resolved master rows below.
  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(
    master, students_state
  );

  select * into prior_command
  from internal.student_import_identity_bulk_review_commands command
  where command.confirmation_key = p_confirmation_key
  for update;
  if found then
    if prior_command.master_source_id <> master.source_id
       or prior_command.master_revision <> master.revision
       or prior_command.master_rows_sha256 <> master.rows_sha256
       or prior_command.jwb_source_id <> jwb.source_id
       or prior_command.jwb_revision <> jwb.revision
       or prior_command.jwb_rows_sha256 <> jwb.rows_sha256
       or prior_command.students_version <> students_state.version
       or prior_command.review_epoch <> review_epoch
       or prior_command.duplicate_resolution_fingerprint <>
          duplicate_snapshot ->> 'fingerprint'
       or not saved_matches_current
       or saved.link_fingerprint <> prior_command.after_link_fingerprint
       or saved.link_count <> prior_command.final_count
       or saved.audit_id <> prior_command.audit_id then
      raise exception using errcode = '40001',
        message = 'student_import_identity_bulk_review_replay_conflict';
    end if;
    return jsonb_build_object(
      'confirmationKey', prior_command.confirmation_key,
      'fingerprint', prior_command.after_link_fingerprint,
      'count', prior_command.final_count,
      'requestedCount', prior_command.requested_count,
      'newlyAppliedCount', prior_command.newly_applied_count,
      'alreadyAppliedCount', prior_command.already_applied_count,
      'finalCount', prior_command.final_count,
      'unchanged', true
    );
  end if;

  resolved_master_rows := internal.student_import_identity_resolved_master_rows(
    master.rows, duplicate_snapshot
  );
  -- The expensive candidate snapshot is materialized exactly once while all
  -- source/student/linkset locks are held, so the submitted key cannot race.
  merge_candidates := internal.student_import_identity_bulk_merge_candidates(
    master.source_id, master.revision, resolved_master_rows,
    jwb.source_id, jwb.revision, jwb.rows,
    students_state.version, review_epoch, students_state.payload
  );
  merge_plan := internal.student_import_identity_bulk_merge_plan(
    merge_candidates, active_links
  );
  expected_key := internal.student_import_identity_bulk_review_key(
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch, active_fingerprint,
    duplicate_snapshot ->> 'fingerprint', merge_plan ->> 'planFingerprint'
  );
  if expected_key <> p_confirmation_key then
    raise exception using errcode = '23503',
      message = 'student_import_identity_bulk_review_unavailable';
  end if;

  requested_count := (merge_plan ->> 'mergeCandidateCount')::integer;
  newly_applied_count := (merge_plan ->> 'pendingMergeCount')::integer;
  already_applied_count := (merge_plan ->> 'alreadyLinkedMergeCount')::integer;
  before_link_count := (merge_plan ->> 'currentLinkCount')::integer;
  final_count := (merge_plan ->> 'resultingLinkCount')::integer;
  if requested_count <= 0 or newly_applied_count <= 0
     or requested_count <> newly_applied_count + already_applied_count
     or final_count <> before_link_count + newly_applied_count
     or final_count <> jsonb_array_length(merge_plan -> 'combinedLinks') then
    raise exception using errcode = '23503',
      message = 'student_import_identity_bulk_review_empty';
  end if;

  after_fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', merge_plan -> 'combinedLinks'
  )::text, 'sha256'), 'hex');

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.identity_bulk_review_confirmed', p_actor,
    'student_import_identity_bulk_review', p_confirmation_key,
    jsonb_build_object(
      'confirmationKey', p_confirmation_key,
      'masterSourceId', master.source_id,
      'masterRevision', master.revision,
      'masterRowsSha256', master.rows_sha256,
      'jwbSourceId', jwb.source_id,
      'jwbRevision', jwb.revision,
      'jwbRowsSha256', jwb.rows_sha256,
      'studentsVersion', students_state.version,
      'reviewEpoch', review_epoch,
      'duplicateResolutionFingerprint', duplicate_snapshot ->> 'fingerprint',
      'planFingerprint', merge_plan ->> 'planFingerprint',
      'beforeLinkFingerprint', active_fingerprint,
      'afterLinkFingerprint', after_fingerprint,
      'beforeLinkCount', before_link_count,
      'requestedCount', requested_count,
      'newlyAppliedCount', newly_applied_count,
      'alreadyAppliedCount', already_applied_count,
      'finalCount', final_count
    )
  );

  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, review_epoch, links, link_count, link_fingerprint,
    updated_by, updated_at, audit_id
  ) values (
    true, master.source_id, master.revision, jwb.source_id, jwb.revision,
    students_state.version, review_epoch,
    merge_plan -> 'combinedLinks', final_count, after_fingerprint,
    left(trim(p_actor), 120), now(), audit_entry_id
  ) on conflict (singleton) do update set
    master_source_id = excluded.master_source_id,
    master_revision = excluded.master_revision,
    jwb_source_id = excluded.jwb_source_id,
    jwb_revision = excluded.jwb_revision,
    students_version = excluded.students_version,
    review_epoch = excluded.review_epoch,
    links = excluded.links,
    link_count = excluded.link_count,
    link_fingerprint = excluded.link_fingerprint,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at,
    audit_id = excluded.audit_id;

  insert into internal.student_import_identity_bulk_review_commands (
    confirmation_key,
    master_source_id, master_revision, master_rows_sha256,
    jwb_source_id, jwb_revision, jwb_rows_sha256,
    students_version, review_epoch,
    duplicate_resolution_fingerprint, plan_fingerprint,
    before_link_fingerprint, after_link_fingerprint, before_link_count,
    requested_count, newly_applied_count, already_applied_count, final_count,
    confirmed_by, confirmed_at, audit_id
  ) values (
    p_confirmation_key,
    master.source_id, master.revision, master.rows_sha256,
    jwb.source_id, jwb.revision, jwb.rows_sha256,
    students_state.version, review_epoch,
    duplicate_snapshot ->> 'fingerprint', merge_plan ->> 'planFingerprint',
    active_fingerprint, after_fingerprint, before_link_count,
    requested_count, newly_applied_count, already_applied_count, final_count,
    left(trim(p_actor), 120), now(), audit_entry_id
  );

  return jsonb_build_object(
    'confirmationKey', p_confirmation_key,
    'fingerprint', after_fingerprint,
    'count', final_count,
    'requestedCount', requested_count,
    'newlyAppliedCount', newly_applied_count,
    'alreadyAppliedCount', already_applied_count,
    'finalCount', final_count,
    'unchanged', false
  );
end;
$$;

revoke all on function public.put_student_import_identity_bulk_review(text, text, text)
  from public, anon, authenticated;
grant execute on function public.put_student_import_identity_bulk_review(text, text, text)
  to anon, authenticated;

-- Fail migration if either narrow public entry point ever loses its recurring
-- timeout guard. No broader database timeout is changed.
do $$
declare
  preview_config text[];
  mutation_config text[];
begin
  select proconfig into preview_config
  from pg_catalog.pg_proc
  where oid = 'public.get_student_import_identity_bulk_review_preview(text)'::regprocedure;
  select proconfig into mutation_config
  from pg_catalog.pg_proc
  where oid = 'public.put_student_import_identity_bulk_review(text,text,text)'::regprocedure;
  if not coalesce('statement_timeout=8s' = any(preview_config), false)
     or not coalesce('statement_timeout=8s' = any(mutation_config), false) then
    raise exception using errcode = '55000',
      message = 'student_import_identity_bulk_review_timeout_guard_missing';
  end if;
end;
$$;

-- Transactional semantic fixture: merge-only closure, source/existing
-- uniqueness, derived ownership, plan idempotency/conflicts and CAS drift.
do $$
declare
  one_master jsonb := '[{"sourceRow":1,"name":"张三","status":"在读"}]'::jsonb;
  one_jwb jsonb := '[{"sourceRow":11,"name":"张三"}]'::jsonb;
  one_student jsonb := '[{"id":"STU-EXISTING","name":"张三"}]'::jsonb;
  candidate_set jsonb;
  plan_value jsonb;
  exact_link jsonb;
  owner_student_id text;
  key_base text;
begin
  candidate_set := internal.student_import_identity_bulk_merge_candidates(
    'fixture-master', 'm1', one_master,
    'fixture-jwb', 'j1', one_jwb,
    7, 2, one_student
  );
  if jsonb_array_length(candidate_set) <> 1
     or candidate_set -> 0 ->> 'studentId' <> 'STU-EXISTING' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_review_unique_fixture_mismatch';
  end if;

  if jsonb_array_length(internal.student_import_identity_bulk_merge_candidates(
       'fixture-master', 'm1', one_master,
       'fixture-jwb', 'j1', one_jwb,
       7, 2, '[]'::jsonb
     )) <> 0
     or jsonb_array_length(internal.student_import_identity_bulk_merge_candidates(
       'fixture-master', 'm1', one_master,
       'fixture-jwb', 'j1', one_jwb,
       7, 2,
       '[{"id":"STU-A","name":"张三"},{"id":"STU-B","name":"张三"}]'::jsonb
     )) <> 0
     or jsonb_array_length(internal.student_import_identity_bulk_merge_candidates(
       'fixture-master', 'm1',
       '[{"sourceRow":1,"name":"张三","status":"在读"},
         {"sourceRow":2,"name":"张三","status":"活跃 + 无课时"}]'::jsonb,
       'fixture-jwb', 'j1', one_jwb,
       7, 2, one_student
     )) <> 0
     or jsonb_array_length(internal.student_import_identity_bulk_merge_candidates(
       'fixture-master', 'm1', one_master,
       'fixture-jwb', 'j1',
       '[{"sourceRow":11,"name":"张三"},{"sourceRow":12,"name":"张三"}]'::jsonb,
       7, 2, one_student
     )) <> 0
     or jsonb_array_length(internal.student_import_identity_bulk_merge_candidates(
       'fixture-master', 'm1',
       '[{"sourceRow":1,"name":"张三","status":"在读"},
         {"sourceRow":2,"name":"张三","status":"不活跃 + 无课时"}]'::jsonb,
       'fixture-jwb', 'j1', one_jwb,
       7, 2, one_student
     )) <> 0 then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_review_ambiguity_fixture_mismatch';
  end if;

  owner_student_id := internal.student_import_student_id(
    'fixture-master', '"owner-row"'::jsonb
  );
  if jsonb_array_length(internal.student_import_identity_bulk_merge_candidates(
    'fixture-master', 'm1',
    '[{"sourceRow":1,"name":"张三","status":"在读"},
      {"sourceRow":"owner-row","name":"Legacy Owner","status":"活跃 + 无课时"}]'::jsonb,
    'fixture-jwb', 'j1', one_jwb,
    7, 2, jsonb_build_array(jsonb_build_object(
      'id', owner_student_id, 'name', '张三'
    ))
  )) <> 0 then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_review_owner_fixture_mismatch';
  end if;

  owner_student_id := internal.student_import_student_id(
    'fixture-master', '1'::jsonb
  );
  if jsonb_array_length(internal.student_import_identity_bulk_merge_candidates(
    'fixture-master', 'm1', one_master,
    'fixture-jwb', 'j1', one_jwb,
    7, 2, jsonb_build_array(jsonb_build_object(
      'id', owner_student_id, 'name', '张三'
    ))
  )) <> 1 then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_review_self_owner_fixture_mismatch';
  end if;

  plan_value := internal.student_import_identity_bulk_merge_plan(
    candidate_set, '[]'::jsonb
  );
  if plan_value ->> 'mergeCandidateCount' <> '1'
     or plan_value ->> 'pendingMergeCount' <> '1'
     or plan_value ->> 'alreadyLinkedMergeCount' <> '0'
     or plan_value ->> 'resultingLinkCount' <> '1' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_review_pending_fixture_mismatch';
  end if;
  exact_link := plan_value -> 'combinedLinks';
  plan_value := internal.student_import_identity_bulk_merge_plan(
    candidate_set,
    '[{"masterSourceRow":99,"jwbSourceRow":199,"studentId":"STU-UNRELATED"}]'::jsonb
  );
  if plan_value ->> 'pendingMergeCount' <> '1'
     or plan_value ->> 'currentLinkCount' <> '1'
     or plan_value ->> 'resultingLinkCount' <> '2'
     or not (plan_value -> 'combinedLinks') @>
       '[{"masterSourceRow":99,"jwbSourceRow":199,"studentId":"STU-UNRELATED"}]'::jsonb then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_review_preserve_fixture_mismatch';
  end if;
  plan_value := internal.student_import_identity_bulk_merge_plan(
    candidate_set, exact_link
  );
  if plan_value ->> 'pendingMergeCount' <> '0'
     or plan_value ->> 'alreadyLinkedMergeCount' <> '1'
     or plan_value ->> 'resultingLinkCount' <> '1' then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_review_exact_fixture_mismatch';
  end if;

  begin
    perform internal.student_import_identity_bulk_merge_plan(
      candidate_set,
      '[{"masterSourceRow":1,"jwbSourceRow":99,"studentId":"STU-OTHER"}]'::jsonb
    );
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_review_conflict_fixture_missing';
  exception when unique_violation then
    null;
  end;

  if internal.student_import_identity_resolved_master_rows(
       '[{"sourceRow":1,"name":"张三","status":"在读"},
         {"sourceRow":2,"name":"张三","status":"不活跃 + 无课时"}]'::jsonb,
       '{"candidates":[{"sourceRows":[1,2]}],"decisions":[]}'::jsonb
     ) <> '[]'::jsonb
     or jsonb_array_length(internal.student_import_identity_resolved_master_rows(
       '[{"sourceRow":1,"name":"张三","status":"在读"},
         {"sourceRow":2,"name":"张三","status":"不活跃 + 无课时"}]'::jsonb,
       '{"candidates":[{"sourceRows":[1,2]}],
         "decisions":[{"decision":"select","sourceRows":[1,2],
           "selectedSourceRow":1,"selectedStatus":"在读"}]}'::jsonb
     )) <> 1
     or internal.student_import_identity_resolved_master_rows(
       '[{"sourceRow":1,"name":"张三","status":"在读"},
         {"sourceRow":2,"name":"张三","status":"不活跃 + 无课时"}]'::jsonb,
       '{"candidates":[{"sourceRows":[1,2]}],
         "decisions":[{"decision":"ignore","sourceRows":[1,2]}]}'::jsonb
     ) <> '[]'::jsonb then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_review_duplicate_fixture_mismatch';
  end if;

  key_base := internal.student_import_identity_bulk_review_key(
    'fixture-master', 'm1', repeat('a', 64),
    'fixture-jwb', 'j1', repeat('b', 64),
    7, 2, 'sha256:' || repeat('c', 64),
    'sha256:' || repeat('d', 64), 'sha256:' || repeat('e', 64)
  );
  if key_base = internal.student_import_identity_bulk_review_key(
       'fixture-master', 'm1', repeat('a', 64),
       'fixture-jwb', 'j1', repeat('b', 64),
       8, 2, 'sha256:' || repeat('c', 64),
       'sha256:' || repeat('d', 64), 'sha256:' || repeat('e', 64)
     )
     or key_base = internal.student_import_identity_bulk_review_key(
       'fixture-master', 'm1', repeat('a', 64),
       'fixture-jwb', 'j1', repeat('b', 64),
       7, 3, 'sha256:' || repeat('c', 64),
       'sha256:' || repeat('d', 64), 'sha256:' || repeat('e', 64)
     )
     or key_base = internal.student_import_identity_bulk_review_key(
       'fixture-master', 'm1', repeat('a', 64),
       'fixture-jwb', 'j1', repeat('b', 64),
       7, 2, 'sha256:' || repeat('f', 64),
       'sha256:' || repeat('d', 64), 'sha256:' || repeat('e', 64)
     )
     or key_base = internal.student_import_identity_bulk_review_key(
       'fixture-master', 'm1', repeat('a', 64),
       'fixture-jwb', 'j1', repeat('b', 64),
       7, 2, 'sha256:' || repeat('c', 64),
       'sha256:' || repeat('f', 64), 'sha256:' || repeat('e', 64)
     )
     or key_base = internal.student_import_identity_bulk_review_key(
       'fixture-master', 'm1', repeat('a', 64),
       'fixture-jwb', 'j1', repeat('b', 64),
       7, 2, 'sha256:' || repeat('c', 64),
       'sha256:' || repeat('d', 64), 'sha256:' || repeat('f', 64)
     ) then
    raise exception using errcode = '22023',
      message = 'student_import_identity_bulk_review_key_fixture_mismatch';
  end if;
end;
$$;
