-- Hotfix for teacher resolution writes that exceeded the hosted statement timeout.
--
-- The V1 resolver now aggregates each roster to one row per unique legacy
-- name key before joining the workbooks.  V2 writes resolve one opaque option
-- with decision-specific early exit instead of constructing every subject to
-- roster option.  Full candidate construction remains closed and deterministic
-- but aggregates each subject group's options once rather than repeatedly
-- copying a growing JSONB array.

create or replace function internal.teacher_import_hard_candidates(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  candidates jsonb := '[]'::jsonb;
  identity_group record;
  identity_kind text;
  identity_refs jsonb;
  identity_ref_keys jsonb;
  identity_group_key text;
  identity_decision text;
  subject_record record;
  roster_rows jsonb;
  candidate_rows jsonb;
  subject_ref jsonb;
  roster_ref jsonb;
  subject_group_key text;
  subject_candidates jsonb;
  nickname_base text;
  nickname_annotation text;
  roster_row jsonb;
begin
  -- Every conservative-name duplicate is one non-overlapping closed group.
  -- Mixed groups use a single cross-workbook decision, including 1+N cases.
  for identity_group in
    select
      internal.teacher_import_name_key(source_row ->> 'name') as name_key,
      count(distinct workbook) as workbook_count,
      count(*) filter (where workbook = 'k12') as k12_count,
      count(*) filter (where workbook = 'university') as university_count,
      jsonb_agg(
        jsonb_build_object(
          'workbook', workbook,
          'sourceId', source_id,
          'sourceRow', source_row -> 'sourceRow'
        ) order by workbook collate "C", source_id collate "C", trim(source_row ->> 'sourceRow') collate "C"
      ) as refs,
      jsonb_agg(jsonb_build_object(
        'type', 'roster', 'workbook', workbook, 'sourceId', source_id,
        'sourceRow', source_row -> 'sourceRow'
      ) order by workbook collate "C", source_id collate "C", trim(source_row ->> 'sourceRow') collate "C") as ref_keys
    from (
      select 'k12'::text as workbook, p_k12.source_id as source_id, source_row
      from jsonb_array_elements(p_k12.roster_rows) source_row
      union all
      select 'university', p_university.source_id, source_row
      from jsonb_array_elements(p_university.roster_rows) source_row
    ) roster
    group by internal.teacher_import_name_key(source_row ->> 'name')
    having count(*) > 1
      and not (
        count(*) = 2
        and count(*) filter (where workbook = 'k12') = 1
        and count(*) filter (where workbook = 'university') = 1
        and count(distinct internal.teacher_import_database_name_key(source_row ->> 'name')) = 1
      )
  loop
    identity_kind := case when identity_group.workbook_count = 2
      then 'cross_workbook_identity' else 'same_workbook_identity' end;
    identity_refs := identity_group.refs;
    identity_ref_keys := identity_group.ref_keys;
    identity_group_key := internal.teacher_import_hard_key(
      identity_kind, p_k12.revision, p_university.revision, identity_ref_keys
    );
    foreach identity_decision in array array['separate', 'merge']
    loop
      candidates := candidates || jsonb_build_array(jsonb_build_object(
        'resolutionKey', internal.teacher_import_hard_key(
          identity_kind, p_k12.revision, p_university.revision,
          identity_ref_keys, identity_decision
        ),
        'resolutionGroupKey', identity_group_key,
        'kind', identity_kind,
        'decision', identity_decision,
        'sourceRefs', identity_refs
      ));
    end loop;
  end loop;

  -- Subject aliases expose only current roster rows from the same workbook.
  -- Exact/known-operational unique matches remain automatic and therefore do
  -- not become administrator choices.
  for subject_record in
    select 'k12'::text as workbook, p_k12.source_id as source_id,
      p_k12.subject_rows as all_subject_rows, subject_row
    from jsonb_array_elements(p_k12.subject_rows) subject_row
    where subject_row ->> 'sheetName' = any(array[
      'Local English','ABC华裔English','Maths&Science','VCE数学科学','VCE其他',
      '奖学金','AEAS','青少英语','QCE','HSC','WACE','SACE','AMC数学竞赛',
      '科学竞赛','雅思PTE','IB'
    ])
    union all
    select 'university', p_university.source_id,
      p_university.subject_rows, subject_row
    from jsonb_array_elements(p_university.subject_rows) subject_row
    where subject_row ->> 'sheetName' = any(array[
      'Engineering','商科','IT','理科','文科（含论文辅导）','教育学','其他科目'
    ])
  loop
    roster_rows := case when subject_record.workbook = 'k12'
      then p_k12.roster_rows else p_university.roster_rows end;
    select coalesce(jsonb_agg(row_value order by trim(row_value ->> 'sourceRow') collate "C"), '[]'::jsonb)
    into candidate_rows
    from jsonb_array_elements(roster_rows) row_value
    where internal.teacher_import_name_key(row_value ->> 'name') =
      internal.teacher_import_name_key(subject_record.subject_row ->> 'name');
    if jsonb_array_length(candidate_rows) = 1 then
      continue;
    end if;
    if jsonb_array_length(candidate_rows) = 0 then
      select coalesce(jsonb_agg(row_value order by trim(row_value ->> 'sourceRow') collate "C"), '[]'::jsonb)
      into candidate_rows
      from jsonb_array_elements(roster_rows) row_value
      where internal.teacher_import_operational_name_key(row_value ->> 'name') =
        internal.teacher_import_operational_name_key(subject_record.subject_row ->> 'name');
      if jsonb_array_length(candidate_rows) = 1 then
        continue;
      end if;
    end if;
    if jsonb_array_length(candidate_rows) = 0 then
      nickname_base := internal.teacher_import_name_key(regexp_replace(
        subject_record.subject_row ->> 'name', '\s*\([^()]*\)\s*$', ''
      ));
      nickname_annotation := internal.teacher_import_name_key(substring(
        subject_record.subject_row ->> 'name' from '\(([^()]*)\)\s*$'
      ));
      if nickname_annotation <> '' then
        select coalesce(jsonb_agg(row_value), '[]'::jsonb)
        into candidate_rows
        from jsonb_array_elements(roster_rows) row_value
        where internal.teacher_import_name_key(row_value ->> 'name') = nickname_base
          and internal.teacher_import_name_key(
            coalesce(row_value ->> 'availabilityText', '') || ' ' || coalesce(row_value ->> 'capacityText', '')
          ) like '%' || nickname_annotation || '老师%';
        if jsonb_array_length(candidate_rows) = 1 then
          continue;
        end if;
        if jsonb_array_length(candidate_rows) > 1 then
          candidate_rows := '[]'::jsonb;
        end if;
      end if;
    end if;
    if jsonb_array_length(candidate_rows) = 0 then
      candidate_rows := roster_rows;
    end if;

    subject_ref := jsonb_build_object(
      'workbook', subject_record.workbook,
      'sourceId', subject_record.source_id,
      'sheetName', subject_record.subject_row ->> 'sheetName',
      'sourceRow', subject_record.subject_row -> 'sourceRow'
    );
    subject_group_key := internal.teacher_import_hard_key(
      'subject_assignment', p_k12.revision, p_university.revision,
      jsonb_build_array(jsonb_build_object(
        'type', 'subject', 'workbook', subject_record.workbook,
        'sourceId', subject_record.source_id,
        'sheetName', subject_record.subject_row ->> 'sheetName',
        'sourceRow', subject_record.subject_row -> 'sourceRow'
      ))
    );
    -- Build each subject group's assignment options once.  Appending one JSON
    -- object at a time copied the entire growing candidates array for every
    -- roster row, making the fallback-to-all-roster closed set quadratic.
    select coalesce(jsonb_agg(option order by roster_ordinality), '[]'::jsonb)
    into subject_candidates
    from (
      select roster_ordinality, jsonb_build_object(
        'resolutionKey', internal.teacher_import_hard_key(
          'subject_assignment', p_k12.revision, p_university.revision,
          jsonb_build_array(
            jsonb_build_object(
              'type', 'subject', 'workbook', subject_record.workbook,
              'sourceId', subject_record.source_id,
              'sheetName', subject_record.subject_row ->> 'sheetName',
              'sourceRow', subject_record.subject_row -> 'sourceRow'
            ),
            jsonb_build_object(
              'type', 'roster', 'workbook', subject_record.workbook,
              'sourceId', subject_record.source_id,
              'sourceRow', candidate_roster_row -> 'sourceRow'
            )
          ), 'assign'
        ),
        'resolutionGroupKey', subject_group_key,
        'kind', 'subject_assignment',
        'decision', 'assign',
        'subjectRef', subject_ref,
        'rosterRef', jsonb_build_object(
          'workbook', subject_record.workbook,
          'sourceId', subject_record.source_id,
          'sourceRow', candidate_roster_row -> 'sourceRow'
        )
      ) as option
      from jsonb_array_elements(candidate_rows) with ordinality
        candidate_row(candidate_roster_row, roster_ordinality)
    ) assignment_options;
    candidates := candidates || jsonb_build_array(jsonb_build_object(
      'resolutionKey', internal.teacher_import_hard_key(
        'subject_assignment', p_k12.revision, p_university.revision,
        jsonb_build_array(jsonb_build_object(
          'type', 'subject', 'workbook', subject_record.workbook,
          'sourceId', subject_record.source_id,
          'sheetName', subject_record.subject_row ->> 'sheetName',
          'sourceRow', subject_record.subject_row -> 'sourceRow'
        )), 'ignore'
      ),
      'resolutionGroupKey', subject_group_key,
      'kind', 'subject_assignment',
      'decision', 'ignore',
      'subjectRef', subject_ref
    )) || subject_candidates;
  end loop;
  return candidates;
end;
$$;

create or replace function internal.teacher_import_hard_candidate_by_key(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources,
  p_resolution_key text,
  p_decision text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  identity_group record;
  identity_kind text;
  identity_refs jsonb;
  identity_ref_keys jsonb;
  identity_group_key text;
  subject_record record;
  roster_rows jsonb;
  candidate_rows jsonb;
  subject_ref jsonb;
  roster_ref jsonb;
  subject_ref_key jsonb;
  subject_group_key text;
  nickname_base text;
  nickname_annotation text;
  roster_row jsonb;
begin
  if p_decision in ('merge', 'separate') then
    for identity_group in
      select
        internal.teacher_import_name_key(source_row ->> 'name') as name_key,
        count(distinct workbook) as workbook_count,
        jsonb_agg(
          jsonb_build_object(
            'workbook', workbook,
            'sourceId', source_id,
            'sourceRow', source_row -> 'sourceRow'
          ) order by workbook collate "C", source_id collate "C", trim(source_row ->> 'sourceRow') collate "C"
        ) as refs,
        jsonb_agg(jsonb_build_object(
          'type', 'roster', 'workbook', workbook, 'sourceId', source_id,
          'sourceRow', source_row -> 'sourceRow'
        ) order by workbook collate "C", source_id collate "C", trim(source_row ->> 'sourceRow') collate "C") as ref_keys
      from (
        select 'k12'::text as workbook, p_k12.source_id as source_id, source_row
        from jsonb_array_elements(p_k12.roster_rows) source_row
        union all
        select 'university', p_university.source_id, source_row
        from jsonb_array_elements(p_university.roster_rows) source_row
      ) roster
      group by internal.teacher_import_name_key(source_row ->> 'name')
      having count(*) > 1
        and not (
          count(*) = 2
          and count(*) filter (where workbook = 'k12') = 1
          and count(*) filter (where workbook = 'university') = 1
          and count(distinct internal.teacher_import_database_name_key(source_row ->> 'name')) = 1
        )
    loop
      identity_kind := case when identity_group.workbook_count = 2
        then 'cross_workbook_identity' else 'same_workbook_identity' end;
      identity_refs := identity_group.refs;
      identity_ref_keys := identity_group.ref_keys;
      if internal.teacher_import_hard_key(
        identity_kind, p_k12.revision, p_university.revision,
        identity_ref_keys, p_decision
      ) <> p_resolution_key then
        continue;
      end if;
      identity_group_key := internal.teacher_import_hard_key(
        identity_kind, p_k12.revision, p_university.revision, identity_ref_keys
      );
      return jsonb_build_object(
        'resolutionKey', p_resolution_key,
        'resolutionGroupKey', identity_group_key,
        'kind', identity_kind,
        'decision', p_decision,
        'sourceRefs', identity_refs
      );
    end loop;
    return null;
  end if;

  if p_decision not in ('assign', 'ignore') then
    return null;
  end if;

  for subject_record in
    select 'k12'::text as workbook, p_k12.source_id as source_id,
      subject_row
    from jsonb_array_elements(p_k12.subject_rows) subject_row
    where subject_row ->> 'sheetName' = any(array[
      'Local English','ABC华裔English','Maths&Science','VCE数学科学','VCE其他',
      '奖学金','AEAS','青少英语','QCE','HSC','WACE','SACE','AMC数学竞赛',
      '科学竞赛','雅思PTE','IB'
    ])
    union all
    select 'university', p_university.source_id,
      subject_row
    from jsonb_array_elements(p_university.subject_rows) subject_row
    where subject_row ->> 'sheetName' = any(array[
      'Engineering','商科','IT','理科','文科（含论文辅导）','教育学','其他科目'
    ])
  loop
    roster_rows := case when subject_record.workbook = 'k12'
      then p_k12.roster_rows else p_university.roster_rows end;
    select coalesce(jsonb_agg(row_value order by trim(row_value ->> 'sourceRow') collate "C"), '[]'::jsonb)
    into candidate_rows
    from jsonb_array_elements(roster_rows) row_value
    where internal.teacher_import_name_key(row_value ->> 'name') =
      internal.teacher_import_name_key(subject_record.subject_row ->> 'name');
    if jsonb_array_length(candidate_rows) = 1 then
      continue;
    end if;
    if jsonb_array_length(candidate_rows) = 0 then
      select coalesce(jsonb_agg(row_value order by trim(row_value ->> 'sourceRow') collate "C"), '[]'::jsonb)
      into candidate_rows
      from jsonb_array_elements(roster_rows) row_value
      where internal.teacher_import_operational_name_key(row_value ->> 'name') =
        internal.teacher_import_operational_name_key(subject_record.subject_row ->> 'name');
      if jsonb_array_length(candidate_rows) = 1 then
        continue;
      end if;
    end if;
    if jsonb_array_length(candidate_rows) = 0 then
      nickname_base := internal.teacher_import_name_key(regexp_replace(
        subject_record.subject_row ->> 'name', '\s*\([^()]*\)\s*$', ''
      ));
      nickname_annotation := internal.teacher_import_name_key(substring(
        subject_record.subject_row ->> 'name' from '\(([^()]*)\)\s*$'
      ));
      if nickname_annotation <> '' then
        select coalesce(jsonb_agg(row_value), '[]'::jsonb)
        into candidate_rows
        from jsonb_array_elements(roster_rows) row_value
        where internal.teacher_import_name_key(row_value ->> 'name') = nickname_base
          and internal.teacher_import_name_key(
            coalesce(row_value ->> 'availabilityText', '') || ' ' || coalesce(row_value ->> 'capacityText', '')
          ) like '%' || nickname_annotation || '老师%';
        if jsonb_array_length(candidate_rows) = 1 then
          continue;
        end if;
        if jsonb_array_length(candidate_rows) > 1 then
          candidate_rows := '[]'::jsonb;
        end if;
      end if;
    end if;
    if jsonb_array_length(candidate_rows) = 0 then
      candidate_rows := roster_rows;
    end if;

    subject_ref := jsonb_build_object(
      'workbook', subject_record.workbook,
      'sourceId', subject_record.source_id,
      'sheetName', subject_record.subject_row ->> 'sheetName',
      'sourceRow', subject_record.subject_row -> 'sourceRow'
    );
    subject_ref_key := jsonb_build_object(
      'type', 'subject', 'workbook', subject_record.workbook,
      'sourceId', subject_record.source_id,
      'sheetName', subject_record.subject_row ->> 'sheetName',
      'sourceRow', subject_record.subject_row -> 'sourceRow'
    );
    subject_group_key := internal.teacher_import_hard_key(
      'subject_assignment', p_k12.revision, p_university.revision,
      jsonb_build_array(subject_ref_key)
    );
    if p_decision = 'ignore' then
      if internal.teacher_import_hard_key(
        'subject_assignment', p_k12.revision, p_university.revision,
        jsonb_build_array(subject_ref_key), 'ignore'
      ) = p_resolution_key then
        return jsonb_build_object(
          'resolutionKey', p_resolution_key,
          'resolutionGroupKey', subject_group_key,
          'kind', 'subject_assignment',
          'decision', 'ignore',
          'subjectRef', subject_ref
        );
      end if;
      continue;
    end if;

    for roster_row in select value from jsonb_array_elements(candidate_rows)
    loop
      if internal.teacher_import_hard_key(
        'subject_assignment', p_k12.revision, p_university.revision,
        jsonb_build_array(
          subject_ref_key,
          jsonb_build_object(
            'type', 'roster', 'workbook', subject_record.workbook,
            'sourceId', subject_record.source_id,
            'sourceRow', roster_row -> 'sourceRow'
          )
        ), 'assign'
      ) <> p_resolution_key then
        continue;
      end if;
      roster_ref := jsonb_build_object(
        'workbook', subject_record.workbook,
        'sourceId', subject_record.source_id,
        'sourceRow', roster_row -> 'sourceRow'
      );
      return jsonb_build_object(
        'resolutionKey', p_resolution_key,
        'resolutionGroupKey', subject_group_key,
        'kind', 'subject_assignment',
        'decision', 'assign',
        'subjectRef', subject_ref,
        'rosterRef', roster_ref
      );
    end loop;
  end loop;
  return null;
end;
$$;

create or replace function public.put_teacher_import_identity_link(
  p_secret text,
  p_resolution_key text,
  p_decision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k12 internal.teacher_import_sources%rowtype;
  university internal.teacher_import_sources%rowtype;
  k12_row jsonb;
  university_row jsonb;
  k12_row_key text;
  university_row_key text;
  canonical_material bytea;
  expected_key text;
  refs jsonb;
  existing internal.teacher_import_identity_links%rowtype;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_resolution_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_decision not in ('merge', 'separate')
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023', message = 'invalid_teacher_identity_link_request';
  end if;

  select * into k12 from internal.teacher_import_sources s where s.workbook = 'k12' for update;
  select * into university from internal.teacher_import_sources s where s.workbook = 'university' for update;
  if k12.workbook is null or university.workbook is null then
    raise exception using errcode = 'P0002', message = 'teacher_import_sources_unavailable';
  end if;

  -- Resolve the opaque key only against current server-owned rows. The caller
  -- cannot nominate names, source rows or a teacher id.
  with k12_unique as materialized (
    select
      internal.teacher_import_database_name_key(row_value ->> 'name') as name_key,
      (jsonb_agg(row_value order by trim(row_value ->> 'sourceRow') collate "C")) -> 0 as row
    from jsonb_array_elements(k12.roster_rows) row_value
    group by internal.teacher_import_database_name_key(row_value ->> 'name')
    having count(*) = 1
  ), university_unique as materialized (
    select
      internal.teacher_import_database_name_key(row_value ->> 'name') as name_key,
      (jsonb_agg(row_value order by trim(row_value ->> 'sourceRow') collate "C")) -> 0 as row
    from jsonb_array_elements(university.roster_rows) row_value
    group by internal.teacher_import_database_name_key(row_value ->> 'name')
    having count(*) = 1
  )
  select kr.row, ur.row, trim(kr.row ->> 'sourceRow'), trim(ur.row ->> 'sourceRow')
  into k12_row, university_row, k12_row_key, university_row_key
  from k12_unique kr
  join university_unique ur using (name_key)
  where encode(extensions.digest(
      convert_to('teacher-import-identity-link-v1', 'UTF8') || decode('00', 'hex')
      || convert_to(k12.revision, 'UTF8') || decode('00', 'hex')
      || convert_to(k12.source_id, 'UTF8') || decode('00', 'hex')
      || convert_to(trim(kr.row ->> 'sourceRow'), 'UTF8') || decode('00', 'hex')
      || convert_to(university.revision, 'UTF8') || decode('00', 'hex')
      || convert_to(university.source_id, 'UTF8') || decode('00', 'hex')
      || convert_to(trim(ur.row ->> 'sourceRow'), 'UTF8'),
      'sha256'
    ), 'hex') = substring(p_resolution_key from 8)
  limit 1;

  if k12_row is null or university_row is null then
    raise exception using errcode = '23503', message = 'teacher_identity_resolution_unavailable';
  end if;

  canonical_material := convert_to('teacher-import-identity-link-v1', 'UTF8') || decode('00', 'hex')
    || convert_to(k12.revision, 'UTF8') || decode('00', 'hex')
    || convert_to(k12.source_id, 'UTF8') || decode('00', 'hex')
    || convert_to(k12_row_key, 'UTF8') || decode('00', 'hex')
    || convert_to(university.revision, 'UTF8') || decode('00', 'hex')
    || convert_to(university.source_id, 'UTF8') || decode('00', 'hex')
    || convert_to(university_row_key, 'UTF8');
  expected_key := 'sha256:' || encode(extensions.digest(canonical_material, 'sha256'), 'hex');
  if expected_key <> p_resolution_key then
    raise exception using errcode = '23503', message = 'teacher_identity_resolution_unavailable';
  end if;

  refs := jsonb_build_array(
    jsonb_build_object('workbook', 'k12', 'sourceId', k12.source_id, 'sourceRow', k12_row -> 'sourceRow'),
    jsonb_build_object('workbook', 'university', 'sourceId', university.source_id, 'sourceRow', university_row -> 'sourceRow')
  );

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teacher_import_identity_link:' || p_resolution_key, 0));
  select * into existing from internal.teacher_import_identity_links l
  where l.resolution_key = p_resolution_key for update;
  if found then
    if existing.source_refs <> refs or existing.decision <> p_decision then
      raise exception using errcode = '23505', message = 'teacher_identity_link_conflict';
    end if;
    return jsonb_build_object('resolutionKey', existing.resolution_key, 'decision', existing.decision, 'unchanged', true);
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'teacher_import.identity_link_confirmed',
    p_actor,
    'teacher_import_identity_link',
    p_resolution_key,
    jsonb_build_object(
      'resolutionKey', p_resolution_key,
      'decision', p_decision,
      'k12Revision', k12.revision,
      'universityRevision', university.revision,
      'sourceRefs', refs
    )
  );

  insert into internal.teacher_import_identity_links (
    resolution_key, decision,
    k12_source_id, k12_revision, k12_source_row,
    university_source_id, university_revision, university_source_row,
    source_refs, confirmed_by, confirmed_at, audit_id
  ) values (
    p_resolution_key, p_decision,
    k12.source_id, k12.revision, k12_row_key,
    university.source_id, university.revision, university_row_key,
    refs, left(trim(p_actor), 120), now(), audit_entry_id
  );

  return jsonb_build_object('resolutionKey', p_resolution_key, 'decision', p_decision, 'unchanged', false);
end;
$$;

create or replace function public.put_teacher_import_hard_resolution(
  p_secret text,
  p_resolution_key text,
  p_decision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k12 internal.teacher_import_sources%rowtype;
  university internal.teacher_import_sources%rowtype;
  candidate jsonb;
  existing internal.teacher_import_hard_resolutions%rowtype;
  group_existing internal.teacher_import_hard_resolutions%rowtype;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_resolution_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_decision not in ('merge', 'separate', 'assign', 'ignore')
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023', message = 'invalid_teacher_hard_resolution_request';
  end if;

  -- Lock both complete sources before resolving the opaque key.  The caller
  -- cannot nominate a name, row, workbook, sheet, or teacher target.
  select * into k12 from internal.teacher_import_sources s
  where s.workbook = 'k12' for update;
  select * into university from internal.teacher_import_sources s
  where s.workbook = 'university' for update;
  if k12.workbook is null or university.workbook is null then
    raise exception using errcode = 'P0002', message = 'teacher_import_sources_unavailable';
  end if;

  candidate := internal.teacher_import_hard_candidate_by_key(
    k12, university, p_resolution_key, p_decision
  );
  if candidate is null then
    raise exception using errcode = '23503', message = 'teacher_hard_resolution_unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('teacher_import_hard_resolution:' || (candidate ->> 'resolutionGroupKey'), 0)
  );
  select * into existing
  from internal.teacher_import_hard_resolutions r
  where r.resolution_key = p_resolution_key for update;
  if found then
    if existing.decision <> p_decision
       or existing.k12_revision <> k12.revision
       or existing.university_revision <> university.revision then
      raise exception using errcode = '23505', message = 'teacher_hard_resolution_conflict';
    end if;
    return jsonb_build_object(
      'resolutionKey', existing.resolution_key,
      'decision', existing.decision,
      'unchanged', true
    );
  end if;
  select * into group_existing
  from internal.teacher_import_hard_resolutions r
  where r.resolution_group_key = candidate ->> 'resolutionGroupKey' for update;
  if found then
    raise exception using errcode = '23505', message = 'teacher_hard_resolution_conflict';
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'teacher_import.hard_resolution_confirmed',
    p_actor,
    'teacher_import_hard_resolution',
    p_resolution_key,
    jsonb_build_object(
      'resolutionKey', p_resolution_key,
      'resolutionGroupKey', candidate ->> 'resolutionGroupKey',
      'kind', candidate ->> 'kind',
      'decision', p_decision,
      'k12Revision', k12.revision,
      'universityRevision', university.revision,
      'sourceRefs', candidate -> 'sourceRefs',
      'subjectRef', candidate -> 'subjectRef',
      'rosterRef', candidate -> 'rosterRef'
    )
  );
  insert into internal.teacher_import_hard_resolutions (
    resolution_key, resolution_group_key, kind, decision,
    k12_source_id, k12_revision, university_source_id, university_revision,
    source_refs, subject_ref, roster_ref,
    confirmed_by, confirmed_at, audit_id
  ) values (
    p_resolution_key, candidate ->> 'resolutionGroupKey', candidate ->> 'kind', p_decision,
    k12.source_id, k12.revision, university.source_id, university.revision,
    candidate -> 'sourceRefs', candidate -> 'subjectRef', candidate -> 'rosterRef',
    left(trim(p_actor), 120), now(), audit_entry_id
  );
  return jsonb_build_object(
    'resolutionKey', p_resolution_key,
    'decision', p_decision,
    'unchanged', false
  );
end;
$$;

-- The single-key resolver must return the exact same closed subject options as
-- the complete candidate contract while rejecting an opaque key that was not
-- produced by the current revisions.
do $$
declare
  k12_fixture internal.teacher_import_sources%rowtype;
  university_fixture internal.teacher_import_sources%rowtype;
  fixture_candidates jsonb;
  fixture_option jsonb;
begin
  k12_fixture.source_id := 'fixture-subject-k12';
  k12_fixture.revision := 'k12-subject-r1';
  k12_fixture.roster_rows := jsonb_build_array(
    jsonb_build_object('sourceRow', 10, 'name', 'Alpha Teacher'),
    jsonb_build_object('sourceRow', 20, 'name', 'Beta Teacher'),
    jsonb_build_object('sourceRow', 25, 'name', 'Ｗｉｄｔｈ Teacher')
  );
  k12_fixture.subject_rows := jsonb_build_array(
    jsonb_build_object('sourceRow', 30, 'name', 'Missing Teacher', 'sheetName', 'IB')
  );
  university_fixture.source_id := 'fixture-subject-university';
  university_fixture.revision := 'university-subject-r1';
  university_fixture.roster_rows := jsonb_build_array(
    jsonb_build_object('sourceRow', 40, 'name', 'University Teacher'),
    jsonb_build_object('sourceRow', 45, 'name', 'Width Teacher')
  );
  university_fixture.subject_rows := '[]'::jsonb;

  fixture_candidates := internal.teacher_import_hard_candidates(k12_fixture, university_fixture);
  if jsonb_array_length(fixture_candidates) <> 6 then
    raise exception using errcode = '22023', message = 'teacher_hard_candidate_by_key_fixture_option_count';
  end if;
  for fixture_option in select value from jsonb_array_elements(fixture_candidates)
  loop
    if internal.teacher_import_hard_candidate_by_key(
      k12_fixture, university_fixture,
      fixture_option ->> 'resolutionKey', fixture_option ->> 'decision'
    ) is distinct from fixture_option then
      raise exception using errcode = '22023', message = 'teacher_hard_candidate_by_key_fixture_mismatch';
    end if;
  end loop;
  if internal.teacher_import_hard_candidate_by_key(
    k12_fixture, university_fixture,
    'sha256:' || repeat('0', 64), 'assign'
  ) is not null then
    raise exception using errcode = '22023', message = 'teacher_hard_candidate_by_key_fixture_unknown_key';
  end if;
end;
$$;

revoke all on function internal.teacher_import_hard_candidates(
  internal.teacher_import_sources, internal.teacher_import_sources
) from public, anon, authenticated;
revoke all on function internal.teacher_import_hard_candidate_by_key(
  internal.teacher_import_sources, internal.teacher_import_sources, text, text
) from public, anon, authenticated;
revoke all on function public.put_teacher_import_identity_link(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.put_teacher_import_hard_resolution(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.put_teacher_import_identity_link(text, text, text, text)
  to anon, authenticated;
grant execute on function public.put_teacher_import_hard_resolution(text, text, text, text)
  to anon, authenticated;
