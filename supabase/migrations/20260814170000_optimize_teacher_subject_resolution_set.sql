-- Keep teacher subject resolution and atomic commit below the hosted anon
-- statement timeout.  Normalise each roster/subject row once, classify all
-- matching modes set-wise, and materialise only blocker groups plus their
-- closed roster references.  Single-key writes hash the closed assignment set
-- once; commit hashes only already-selected decisions and verifies full group
-- coverage from the same basis.

create or replace function internal.teacher_import_subject_hard_candidate_basis(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources
)
returns table (
  workbook_order integer,
  subject_ordinality bigint,
  subject_ref jsonb,
  subject_ref_key jsonb,
  resolution_group_key text,
  roster_ref jsonb,
  roster_ref_key jsonb,
  candidate_source_row text,
  roster_ordinality bigint
)
language sql
stable
set search_path = ''
as $$
  with roster_raw as materialized (
    select
      'k12'::text as workbook,
      p_k12.source_id as source_id,
      roster_entry.roster_ordinality,
      roster_entry.roster_row
    from jsonb_array_elements(p_k12.roster_rows) with ordinality
      roster_entry(roster_row, roster_ordinality)
    union all
    select
      'university',
      p_university.source_id,
      roster_entry.roster_ordinality,
      roster_entry.roster_row
    from jsonb_array_elements(p_university.roster_rows) with ordinality
      roster_entry(roster_row, roster_ordinality)
  ), roster as materialized (
    select
      roster_raw.workbook,
      roster_raw.source_id,
      roster_raw.roster_ordinality,
      roster_raw.roster_row,
      internal.teacher_import_name_key(roster_raw.roster_row ->> 'name') as name_key,
      internal.teacher_import_operational_name_key(roster_raw.roster_row ->> 'name') as operational_name_key,
      internal.teacher_import_name_key(
        coalesce(roster_raw.roster_row ->> 'availabilityText', '') || ' '
          || coalesce(roster_raw.roster_row ->> 'capacityText', '')
      ) as source_text_key
    from roster_raw
  ), subject_raw as materialized (
    select
      0 as workbook_order,
      'k12'::text as workbook,
      p_k12.source_id as source_id,
      subject_entry.subject_ordinality,
      subject_entry.subject_row
    from jsonb_array_elements(p_k12.subject_rows) with ordinality
      subject_entry(subject_row, subject_ordinality)
    where subject_row ->> 'sheetName' = any(array[
      'Local English','ABC华裔English','Maths&Science','VCE数学科学','VCE其他',
      '奖学金','AEAS','青少英语','QCE','HSC','WACE','SACE','AMC数学竞赛',
      '科学竞赛','雅思PTE','IB'
    ])
    union all
    select
      1,
      'university',
      p_university.source_id,
      subject_entry.subject_ordinality,
      subject_entry.subject_row
    from jsonb_array_elements(p_university.subject_rows) with ordinality
      subject_entry(subject_row, subject_ordinality)
    where subject_row ->> 'sheetName' = any(array[
      'Engineering','商科','IT','理科','文科（含论文辅导）','教育学','其他科目'
    ])
  ), subjects as materialized (
    select
      subject_raw.workbook_order,
      subject_raw.workbook,
      subject_raw.source_id,
      subject_raw.subject_ordinality,
      subject_raw.subject_row,
      internal.teacher_import_name_key(subject_raw.subject_row ->> 'name') as name_key,
      internal.teacher_import_operational_name_key(subject_raw.subject_row ->> 'name') as operational_name_key,
      internal.teacher_import_name_key(regexp_replace(
        subject_raw.subject_row ->> 'name', '\s*\([^()]*\)\s*$', ''
      )) as nickname_base,
      internal.teacher_import_name_key(substring(
        subject_raw.subject_row ->> 'name' from '\(([^()]*)\)\s*$'
      )) as nickname_annotation
    from subject_raw
  ), match_counts as materialized (
    select
      s.workbook_order,
      s.workbook,
      s.source_id,
      s.subject_ordinality,
      s.subject_row,
      s.name_key,
      s.operational_name_key,
      s.nickname_base,
      s.nickname_annotation,
      count(*) filter (
        where r.roster_row is not null and r.name_key = s.name_key
      ) as exact_count,
      count(*) filter (
        where r.roster_row is not null
          and r.operational_name_key = s.operational_name_key
      ) as operational_count,
      count(*) filter (
        where r.roster_row is not null
          and s.nickname_annotation <> ''
          and r.name_key = s.nickname_base
          and r.source_text_key like '%' || s.nickname_annotation || '老师%'
      ) as nickname_count
    from subjects s
    left join roster r on r.workbook = s.workbook
    group by
      s.workbook_order,
      s.workbook,
      s.source_id,
      s.subject_ordinality,
      s.subject_row,
      s.name_key,
      s.operational_name_key,
      s.nickname_base,
      s.nickname_annotation
  ), blocking_subjects as materialized (
    select
      m.*,
      jsonb_build_object(
        'workbook', m.workbook,
        'sourceId', m.source_id,
        'sheetName', m.subject_row ->> 'sheetName',
        'sourceRow', m.subject_row -> 'sourceRow'
      ) as subject_ref,
      jsonb_build_object(
        'type', 'subject',
        'workbook', m.workbook,
        'sourceId', m.source_id,
        'sheetName', m.subject_row ->> 'sheetName',
        'sourceRow', m.subject_row -> 'sourceRow'
      ) as subject_ref_key
    from match_counts m
    where m.exact_count > 1
      or (
        m.exact_count = 0
        and (
          m.operational_count > 1
          or (m.operational_count = 0 and m.nickname_count <> 1)
        )
      )
  ), blocking_options as materialized (
    select
      b.*,
      internal.teacher_import_hard_key(
        'subject_assignment', p_k12.revision, p_university.revision,
        jsonb_build_array(b.subject_ref_key)
      ) as resolution_group_key
    from blocking_subjects b
  ), candidate_assignments as materialized (
    select
      b.*,
      r.roster_row,
      r.roster_ordinality as candidate_roster_ordinality,
      case
        when b.exact_count > 1 or b.operational_count > 1
          then trim(r.roster_row ->> 'sourceRow')
        else null
      end as ordered_source_row
    from blocking_options b
    join roster r on r.workbook = b.workbook
    where
      (b.exact_count > 1 and r.name_key = b.name_key)
      or (
        b.exact_count = 0
        and b.operational_count > 1
        and r.operational_name_key = b.operational_name_key
      )
      or (
        b.exact_count = 0
        and b.operational_count = 0
        and b.nickname_count <> 1
      )

  )
  select
    a.workbook_order,
    a.subject_ordinality,
    a.subject_ref,
    a.subject_ref_key,
    a.resolution_group_key,
    jsonb_build_object(
      'workbook', a.workbook,
      'sourceId', a.source_id,
      'sourceRow', a.roster_row -> 'sourceRow'
    ) as roster_ref,
    jsonb_build_object(
      'type', 'roster',
      'workbook', a.workbook,
      'sourceId', a.source_id,
      'sourceRow', a.roster_row -> 'sourceRow'
    ) as roster_ref_key,
    a.ordered_source_row as candidate_source_row,
    a.candidate_roster_ordinality as roster_ordinality
  from candidate_assignments a
  order by
    a.workbook_order,
    a.subject_ordinality,
    a.ordered_source_row collate "C" nulls last,
    a.candidate_roster_ordinality;
$$;

create or replace function internal.teacher_import_subject_hard_candidate_rows(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources,
  p_decision text,
  p_resolution_key text
)
returns table (
  candidate jsonb,
  workbook_order integer,
  subject_ordinality bigint,
  decision_order integer,
  candidate_source_row text,
  roster_ordinality bigint
)
language sql
stable
set search_path = ''
as $$
  with basis as materialized (
    select *
    from internal.teacher_import_subject_hard_candidate_basis(p_k12, p_university)
  ), first_in_group as materialized (
    select distinct on (b.resolution_group_key collate "C")
      b.*
    from basis b
    order by
      b.resolution_group_key collate "C",
      b.candidate_source_row collate "C" nulls last,
      b.roster_ordinality
  ), ignore_keys as materialized (
    select
      internal.teacher_import_hard_key(
        'subject_assignment', p_k12.revision, p_university.revision,
        jsonb_build_array(b.subject_ref_key), 'ignore'
      ) as resolution_key,
      b.*
    from first_in_group b
    where p_decision is null or p_decision = 'ignore'
  ), assignment_keys as materialized (
    select
      internal.teacher_import_hard_key(
        'subject_assignment', p_k12.revision, p_university.revision,
        jsonb_build_array(b.subject_ref_key, b.roster_ref_key), 'assign'
      ) as resolution_key,
      b.*
    from basis b
    where p_decision is null or p_decision = 'assign'
  ), options as (
    select
      jsonb_build_object(
        'resolutionKey', i.resolution_key,
        'resolutionGroupKey', i.resolution_group_key,
        'kind', 'subject_assignment',
        'decision', 'ignore',
        'subjectRef', i.subject_ref
      ) as candidate,
      i.workbook_order,
      i.subject_ordinality,
      0 as decision_order,
      null::text as candidate_source_row,
      null::bigint as roster_ordinality
    from ignore_keys i
    where p_resolution_key is null or i.resolution_key = p_resolution_key

    union all

    select
      jsonb_build_object(
        'resolutionKey', a.resolution_key,
        'resolutionGroupKey', a.resolution_group_key,
        'kind', 'subject_assignment',
        'decision', 'assign',
        'subjectRef', a.subject_ref,
        'rosterRef', a.roster_ref
      ),
      a.workbook_order,
      a.subject_ordinality,
      1,
      a.candidate_source_row,
      a.roster_ordinality
    from assignment_keys a
    where p_resolution_key is null or a.resolution_key = p_resolution_key
  )
  select
    options.candidate,
    options.workbook_order,
    options.subject_ordinality,
    options.decision_order,
    options.candidate_source_row,
    options.roster_ordinality
  from options
  order by
    options.workbook_order,
    options.subject_ordinality,
    options.decision_order,
    options.candidate_source_row collate "C" nulls last,
    options.roster_ordinality;
$$;

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
  subject_candidates jsonb;
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

  -- Commit validation still receives the complete closed option set, but all
  -- roster/subject keys and blocker counts are now computed once set-wise.
  select coalesce(jsonb_agg(
    subject_candidate.candidate order by
      subject_candidate.workbook_order,
      subject_candidate.subject_ordinality,
      subject_candidate.decision_order,
      subject_candidate.candidate_source_row collate "C" nulls last,
      subject_candidate.roster_ordinality
  ), '[]'::jsonb)
  into subject_candidates
  from internal.teacher_import_subject_hard_candidate_rows(
    p_k12, p_university, null, null
  ) subject_candidate;

  return candidates || subject_candidates;
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
  resolved_candidate jsonb;
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

  select subject_candidate.candidate
  into resolved_candidate
  from internal.teacher_import_subject_hard_candidate_rows(
    p_k12, p_university, p_decision, p_resolution_key
  ) subject_candidate
  limit 1;

  return resolved_candidate;
end;
$$;

create or replace function public.commit_teacher_import_plan_atomic(
  p_secret text,
  p_plan_fingerprint text,
  p_expected_teacher_version bigint,
  p_source_revisions jsonb,
  p_teachers jsonb,
  p_actor text
)
returns table (
  entity text,
  version bigint,
  updated_at timestamptz,
  updated_by text,
  applied boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_state public.ops_state%rowtype;
  prior internal.teacher_import_commits%rowtype;
  k12 internal.teacher_import_sources%rowtype;
  university internal.teacher_import_sources%rowtype;
  teachers_hash text;
  audit_entry_id uuid;
  removed_teacher_id text;
  subject_hard_basis jsonb;
  replaying_prior boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_plan_fingerprint, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_expected_teacher_version is null or p_expected_teacher_version < 0
     or p_actor not in ('Nixon', 'Ops Admin')
     or jsonb_typeof(p_source_revisions) <> 'object'
     or nullif(p_source_revisions ->> 'k12', '') is null
     or nullif(p_source_revisions ->> 'university', '') is null
     or jsonb_typeof(p_teachers) <> 'array'
     or jsonb_array_length(p_teachers) < 1
     or jsonb_array_length(p_teachers) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_teachers) t
       where jsonb_typeof(t) <> 'object'
          or jsonb_typeof(t -> 'id') <> 'string'
          or nullif(trim(t ->> 'id'), '') is null
          or jsonb_typeof(t -> 'name') <> 'string'
          or nullif(trim(t ->> 'name'), '') is null
          or jsonb_typeof(t -> 'initials') <> 'string'
          or nullif(trim(t ->> 'initials'), '') is null
          or jsonb_typeof(t -> 'subjects') <> 'array'
          or jsonb_typeof(t -> 'timezone') <> 'string'
          or nullif(trim(t ->> 'timezone'), '') is null
          or jsonb_typeof(t -> 'availability') <> 'string'
          or jsonb_typeof(t -> 'load') <> 'number'
          or (t ->> 'load')::numeric < 0
          or jsonb_typeof(t -> 'capacity') <> 'number'
          or (t ->> 'capacity')::numeric < 0
          or jsonb_typeof(t -> 'acceptsStudents') <> 'boolean'
          or jsonb_typeof(t -> 'note') <> 'string'
          or (t ? 'teacherSourceRefs' and jsonb_typeof(t -> 'teacherSourceRefs') <> 'array')
          or exists (
            select 1
            from jsonb_array_elements(
              case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
                then t -> 'teacherSourceRefs' else '[]'::jsonb end
            ) ref
            where jsonb_typeof(ref) <> 'object'
               or ref ->> 'workbook' not in ('k12', 'university')
               or jsonb_typeof(ref -> 'sourceId') <> 'string'
               or nullif(trim(ref ->> 'sourceId'), '') is null
               or jsonb_typeof(ref -> 'sourceRow') not in ('string', 'number')
               or nullif(trim(ref ->> 'sourceRow'), '') is null
               or ref - 'workbook' - 'sourceId' - 'sourceRow' <> '{}'::jsonb
          )
     )
     or (select count(*) from jsonb_array_elements(p_teachers)) <>
        (select count(distinct t ->> 'id') from jsonb_array_elements(p_teachers) t)
     or (
       select count(*)
       from jsonb_array_elements(p_teachers) t
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
           then t -> 'teacherSourceRefs' else '[]'::jsonb end
       ) ref
     ) <> (
       select count(distinct jsonb_build_array(
         ref ->> 'workbook', ref ->> 'sourceId', ref ->> 'sourceRow'
       ))
       from jsonb_array_elements(p_teachers) t
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
           then t -> 'teacherSourceRefs' else '[]'::jsonb end
       ) ref
     ) then
    raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
  end if;

  teachers_hash := encode(extensions.digest(p_teachers::text, 'sha256'), 'hex');
  select * into prior
  from internal.teacher_import_commits c
  where c.plan_fingerprint = p_plan_fingerprint
  for update;
  if found then
    if prior.k12_revision <> p_source_revisions ->> 'k12'
       or prior.university_revision <> p_source_revisions ->> 'university'
       or prior.teachers_sha256 <> teachers_hash then
      raise exception using errcode = '23505', message = 'teacher_import_fingerprint_conflict';
    end if;
    -- Do not return yet.  A replay is successful only after the current
    -- sources, decisions and canonical teachers row are locked and proven to
    -- still be the exact state produced by this command.
    replaying_prior := true;
  end if;

  select * into k12 from internal.teacher_import_sources s
  where s.workbook = 'k12' for update;
  select * into university from internal.teacher_import_sources s
  where s.workbook = 'university' for update;
  select * into current_state from public.ops_state s
  where s.entity = 'teachers' for update;

  if k12.workbook is null or university.workbook is null then
    raise exception using errcode = 'P0002', message = 'teacher_import_sources_unavailable';
  end if;
  if k12.revision <> p_source_revisions ->> 'k12'
     or university.revision <> p_source_revisions ->> 'university' then
    raise exception using errcode = '40001', message = 'teacher_import_source_changed';
  end if;
  if k12.sheet_names <> '["在职总表","Local English","ABC华裔English","Maths&Science","VCE数学科学","VCE其他","奖学金","AEAS","青少英语","QCE","HSC","WACE","SACE","AMC数学竞赛","科学竞赛","雅思PTE","IB","已离职教师"]'::jsonb
     or university.sheet_names <> '["大学老师在职总表","Engineering","商科","IT","理科","文科（含论文辅导）","教育学","其他科目"]'::jsonb then
    raise exception using errcode = '22023', message = 'teacher_import_sheet_contract_changed';
  end if;
  if current_state.entity is null or jsonb_typeof(current_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'teachers_state_unavailable';
  end if;
  if replaying_prior then
    if current_state.version <> prior.teachers_version
       or encode(extensions.digest(current_state.payload::text, 'sha256'), 'hex') <>
          prior.teachers_sha256 then
      raise exception using errcode = '40001', message = 'teacher_import_idempotent_state_changed';
    end if;
  elsif current_state.version <> p_expected_teacher_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  -- Materialise the set-based subject basis once under the source locks.  It
  -- contains only blocker group keys and allowed roster references, not the
  -- thousands of opaque option hashes formerly built for commit validation.
  select coalesce(jsonb_agg(jsonb_build_object(
    'resolutionGroupKey', basis.resolution_group_key,
    'subjectRef', basis.subject_ref,
    'subjectRefKey', basis.subject_ref_key,
    'rosterRef', basis.roster_ref,
    'rosterRefKey', basis.roster_ref_key
  ) order by
    basis.workbook_order,
    basis.subject_ordinality,
    basis.candidate_source_row collate "C" nulls last,
    basis.roster_ordinality
  ), '[]'::jsonb)
  into subject_hard_basis
  from internal.teacher_import_subject_hard_candidate_basis(k12, university) basis;

  -- Revalidate the few selected keys only.  Identity choices use their cheap
  -- grouped resolver; subject choices must belong to the once-computed basis
  -- and their exact selected key is recomputed from the stored closed refs.
  if exists (
    select 1
    from internal.teacher_import_hard_resolutions r
    where r.k12_source_id = k12.source_id
      and r.k12_revision = k12.revision
      and r.university_source_id = university.source_id
      and r.university_revision = university.revision
      and (
        (
          r.kind in ('same_workbook_identity', 'cross_workbook_identity')
          and internal.teacher_import_hard_candidate_by_key(
            k12, university, r.resolution_key, r.decision
          ) is distinct from jsonb_build_object(
            'resolutionKey', r.resolution_key,
            'resolutionGroupKey', r.resolution_group_key,
            'kind', r.kind,
            'decision', r.decision,
            'sourceRefs', r.source_refs
          )
        )
        or (
          r.kind = 'subject_assignment'
          and not exists (
            select 1
            from jsonb_array_elements(subject_hard_basis) basis
            where basis ->> 'resolutionGroupKey' = r.resolution_group_key
              and basis -> 'subjectRef' is not distinct from r.subject_ref
              and case r.decision
                when 'ignore' then
                  r.roster_ref is null
                  and internal.teacher_import_hard_key(
                    'subject_assignment', k12.revision, university.revision,
                    jsonb_build_array(basis -> 'subjectRefKey'), 'ignore'
                  ) = r.resolution_key
                when 'assign' then
                  basis -> 'rosterRef' is not distinct from r.roster_ref
                  and internal.teacher_import_hard_key(
                    'subject_assignment', k12.revision, university.revision,
                    jsonb_build_array(
                      basis -> 'subjectRefKey', basis -> 'rosterRefKey'
                    ), 'assign'
                  ) = r.resolution_key
                else false
              end
          )
        )
      )
  ) then
    raise exception using errcode = '40001', message = 'teacher_import_hard_resolutions_changed';
  end if;

  -- Every current identity or subject blocker group still needs exactly one
  -- revision-bound row.  The table's unique group key prevents double choice.
  if exists (
    select 1
    from (
      select internal.teacher_import_hard_key(
        case when identity_group.workbook_count = 2
          then 'cross_workbook_identity' else 'same_workbook_identity' end,
        k12.revision,
        university.revision,
        identity_group.ref_keys
      ) as resolution_group_key
      from (
        select
          count(distinct workbook) as workbook_count,
          jsonb_agg(jsonb_build_object(
            'type', 'roster',
            'workbook', workbook,
            'sourceId', source_id,
            'sourceRow', source_row -> 'sourceRow'
          ) order by
            workbook collate "C",
            source_id collate "C",
            trim(source_row ->> 'sourceRow') collate "C"
          ) as ref_keys
        from (
          select 'k12'::text as workbook, k12.source_id as source_id, source_row
          from jsonb_array_elements(k12.roster_rows) source_row
          union all
          select 'university', university.source_id, source_row
          from jsonb_array_elements(university.roster_rows) source_row
        ) roster
        group by internal.teacher_import_name_key(source_row ->> 'name')
        having count(*) > 1
          and not (
            count(*) = 2
            and count(*) filter (where workbook = 'k12') = 1
            and count(*) filter (where workbook = 'university') = 1
            and count(distinct internal.teacher_import_database_name_key(source_row ->> 'name')) = 1
          )
      ) identity_group

      union all

      select distinct basis ->> 'resolutionGroupKey'
      from jsonb_array_elements(subject_hard_basis) basis
    ) candidate_group
    where not exists (
      select 1
      from internal.teacher_import_hard_resolutions r
      where r.resolution_group_key = candidate_group.resolution_group_key
        and r.k12_source_id = k12.source_id
        and r.k12_revision = k12.revision
        and r.university_source_id = university.source_id
        and r.university_revision = university.revision
    )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_hard_resolution_required';
  end if;

  -- The V1 two-row cross-workbook contract remains authoritative for simple
  -- pairs.  A separate plan cannot bypass the required confirmation merely
  -- because its output keeps the rows apart.
  if exists (
    select 1
    from (
      select internal.teacher_import_name_key(row ->> 'name') as name_key,
        (jsonb_agg(row) filter (where workbook = 'k12')) -> 0 as k12_row,
        (jsonb_agg(row) filter (where workbook = 'university')) -> 0 as university_row
      from (
        select 'k12'::text as workbook, row from jsonb_array_elements(k12.roster_rows) row
        union all
        select 'university', row from jsonb_array_elements(university.roster_rows) row
      ) roster
      group by internal.teacher_import_name_key(row ->> 'name')
      having count(*) = 2
        and count(*) filter (where workbook = 'k12') = 1
        and count(*) filter (where workbook = 'university') = 1
        and count(distinct internal.teacher_import_database_name_key(row ->> 'name')) = 1
    ) pair
    where not exists (
      select 1 from internal.teacher_import_identity_links l
      where l.k12_source_id = k12.source_id
        and l.k12_revision = k12.revision
        and l.k12_source_row = trim(pair.k12_row ->> 'sourceRow')
        and l.university_source_id = university.source_id
        and l.university_revision = university.revision
        and l.university_source_row = trim(pair.university_row ->> 'sourceRow')
    )
    and not exists (
      select 1 from jsonb_array_elements(current_state.payload) existing_teacher
      where exists (
        select 1 from jsonb_array_elements(coalesce(existing_teacher -> 'teacherSourceRefs', '[]'::jsonb)) ref
        where ref ->> 'workbook' = 'k12'
          and ref ->> 'sourceId' = k12.source_id
          and trim(ref ->> 'sourceRow') = trim(pair.k12_row ->> 'sourceRow')
      )
      and exists (
        select 1 from jsonb_array_elements(coalesce(existing_teacher -> 'teacherSourceRefs', '[]'::jsonb)) ref
        where ref ->> 'workbook' = 'university'
          and ref ->> 'sourceId' = university.source_id
          and trim(ref ->> 'sourceRow') = trim(pair.university_row ->> 'sourceRow')
      )
    )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_identity_link_required';
  end if;

  -- Validate that the replacement actually implements every current V2
  -- identity partition and subject assignment.  The saved decision is not a
  -- waiver; it is an invariant the payload must satisfy.
  if exists (
    select 1
    from internal.teacher_import_hard_resolutions r
    where r.k12_source_id = k12.source_id
      and r.k12_revision = k12.revision
      and r.university_source_id = university.source_id
      and r.university_revision = university.revision
      and r.kind in ('same_workbook_identity', 'cross_workbook_identity')
      and case r.decision
        when 'merge' then (
          select count(*)
          from jsonb_array_elements(p_teachers) teacher
          where (
            select count(*)
            from jsonb_array_elements(coalesce(teacher -> 'teacherSourceRefs', '[]'::jsonb)) teacher_ref
            join jsonb_array_elements(r.source_refs) decision_ref
              on teacher_ref ->> 'workbook' = decision_ref ->> 'workbook'
             and teacher_ref ->> 'sourceId' = decision_ref ->> 'sourceId'
             and trim(teacher_ref ->> 'sourceRow') = trim(decision_ref ->> 'sourceRow')
          ) = jsonb_array_length(r.source_refs)
        ) <> 1
        when 'separate' then exists (
          select 1
          from jsonb_array_elements(p_teachers) teacher
          where (
            select count(*)
            from jsonb_array_elements(coalesce(teacher -> 'teacherSourceRefs', '[]'::jsonb)) teacher_ref
            join jsonb_array_elements(r.source_refs) decision_ref
              on teacher_ref ->> 'workbook' = decision_ref ->> 'workbook'
             and teacher_ref ->> 'sourceId' = decision_ref ->> 'sourceId'
             and trim(teacher_ref ->> 'sourceRow') = trim(decision_ref ->> 'sourceRow')
          ) > 1
        )
        else true
      end
  ) then
    raise exception using errcode = '40001', message = 'teacher_import_hard_resolutions_changed';
  end if;
  if exists (
    select 1
    from internal.teacher_import_hard_resolutions r
    where r.k12_source_id = k12.source_id
      and r.k12_revision = k12.revision
      and r.university_source_id = university.source_id
      and r.university_revision = university.revision
      and r.kind = 'subject_assignment'
      and r.decision = 'assign'
      and not exists (
        select 1
        from jsonb_array_elements(p_teachers) teacher
        where exists (
          select 1 from jsonb_array_elements(coalesce(teacher -> 'teacherSourceRefs', '[]'::jsonb)) ref
          where ref ->> 'workbook' = r.roster_ref ->> 'workbook'
            and ref ->> 'sourceId' = r.roster_ref ->> 'sourceId'
            and trim(ref ->> 'sourceRow') = trim(r.roster_ref ->> 'sourceRow')
        )
        and exists (
          select 1 from jsonb_array_elements_text(coalesce(teacher -> 'subjects', '[]'::jsonb)) subject
          where subject = r.subject_ref ->> 'sheetName'
        )
      )
  ) then
    raise exception using errcode = '40001', message = 'teacher_import_hard_resolutions_changed';
  end if;

  -- A workbook refresh cannot silently remove a canonical teacher. It may
  -- only update linked teachers or add new ones; deactivation remains an
  -- explicit operational workflow so bookings/payroll/history keep identity.
  select old_teacher ->> 'id' into removed_teacher_id
  from jsonb_array_elements(current_state.payload) old_teacher
  where nullif(trim(old_teacher ->> 'id'), '') is not null
    and not exists (
      select 1 from jsonb_array_elements(p_teachers) new_teacher
      where new_teacher ->> 'id' = old_teacher ->> 'id'
    )
  limit 1;
  if removed_teacher_id is not null then
    raise exception using errcode = '23503', message = 'teacher_import_existing_teacher_removed';
  end if;

  -- Every current roster row must be represented exactly once by its stable
  -- source reference in the server-computed replacement.
  if exists (
    select 1
    from (
      select 'k12'::text as workbook, k12.source_id as source_id, row
      from jsonb_array_elements(k12.roster_rows) row
      union all
      select 'university'::text, university.source_id, row
      from jsonb_array_elements(university.roster_rows) row
    ) roster
    where (
      select count(*)
      from jsonb_array_elements(p_teachers) t
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
          then t -> 'teacherSourceRefs' else '[]'::jsonb end
      ) ref
      where ref ->> 'workbook' = roster.workbook
        and ref ->> 'sourceId' = roster.source_id
        and trim(ref ->> 'sourceRow') = trim(roster.row ->> 'sourceRow')
    ) <> 1
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_roster_reference_mismatch';
  end if;

  -- A canonical teacher may own current rows from both workbooks only when an
  -- administrator confirmed either the exact V1 pair or one complete current
  -- V2 cross-workbook merge group. This prevents a client-crafted payload from
  -- using same-name merging as a shortcut while allowing closed 1+N merges.
  if exists (
    select 1
    from jsonb_array_elements(p_teachers) t
    where exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
          then t -> 'teacherSourceRefs' else '[]'::jsonb end
      ) ref
      where ref ->> 'workbook' = 'k12'
        and ref ->> 'sourceId' = k12.source_id
        and exists (
          select 1 from jsonb_array_elements(k12.roster_rows) r
          where trim(r ->> 'sourceRow') = trim(ref ->> 'sourceRow')
        )
    )
    and exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
          then t -> 'teacherSourceRefs' else '[]'::jsonb end
      ) ref
      where ref ->> 'workbook' = 'university'
        and ref ->> 'sourceId' = university.source_id
        and exists (
          select 1 from jsonb_array_elements(university.roster_rows) r
          where trim(r ->> 'sourceRow') = trim(ref ->> 'sourceRow')
        )
    )
    and not exists (
      select 1
      from internal.teacher_import_identity_links l
      where l.k12_source_id = k12.source_id
        and l.k12_revision = k12.revision
        and l.university_source_id = university.source_id
        and l.university_revision = university.revision
        and l.decision = 'merge'
        and exists (
          select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
          where ref ->> 'workbook' = 'k12'
            and ref ->> 'sourceId' = l.k12_source_id
            and trim(ref ->> 'sourceRow') = l.k12_source_row
        )
        and exists (
          select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
          where ref ->> 'workbook' = 'university'
            and ref ->> 'sourceId' = l.university_source_id
            and trim(ref ->> 'sourceRow') = l.university_source_row
        )
    )
    and not exists (
      select 1
      from internal.teacher_import_hard_resolutions r
      where r.k12_source_id = k12.source_id
        and r.k12_revision = k12.revision
        and r.university_source_id = university.source_id
        and r.university_revision = university.revision
        and r.kind = 'cross_workbook_identity'
        and r.decision = 'merge'
        and (
          select count(*)
          from jsonb_array_elements(
            case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
              then t -> 'teacherSourceRefs' else '[]'::jsonb end
          ) teacher_ref
          join jsonb_array_elements(r.source_refs) decision_ref
            on teacher_ref ->> 'workbook' = decision_ref ->> 'workbook'
           and teacher_ref ->> 'sourceId' = decision_ref ->> 'sourceId'
           and trim(teacher_ref ->> 'sourceRow') = trim(decision_ref ->> 'sourceRow')
        ) = jsonb_array_length(r.source_refs)
        and not exists (
          select 1
          from jsonb_array_elements(
            case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
              then t -> 'teacherSourceRefs' else '[]'::jsonb end
          ) teacher_ref
          where teacher_ref ->> 'sourceId' in (k12.source_id, university.source_id)
            and exists (
              select 1
              from jsonb_array_elements(k12.roster_rows) source_row
              where teacher_ref ->> 'workbook' = 'k12'
                and teacher_ref ->> 'sourceId' = k12.source_id
                and trim(teacher_ref ->> 'sourceRow') = trim(source_row ->> 'sourceRow')
              union all
              select 1
              from jsonb_array_elements(university.roster_rows) source_row
              where teacher_ref ->> 'workbook' = 'university'
                and teacher_ref ->> 'sourceId' = university.source_id
                and trim(teacher_ref ->> 'sourceRow') = trim(source_row ->> 'sourceRow')
            )
            and not exists (
              select 1 from jsonb_array_elements(r.source_refs) decision_ref
              where teacher_ref ->> 'workbook' = decision_ref ->> 'workbook'
                and teacher_ref ->> 'sourceId' = decision_ref ->> 'sourceId'
                and trim(teacher_ref ->> 'sourceRow') = trim(decision_ref ->> 'sourceRow')
            )
        )
    )
    and not exists (
      select 1
      from jsonb_array_elements(current_state.payload) existing_teacher
      where existing_teacher ->> 'id' = t ->> 'id'
        and exists (
          select 1 from jsonb_array_elements(
            case when jsonb_typeof(existing_teacher -> 'teacherSourceRefs') = 'array'
              then existing_teacher -> 'teacherSourceRefs' else '[]'::jsonb end
          ) ref
          where ref ->> 'workbook' = 'k12'
            and ref ->> 'sourceId' = k12.source_id
            and exists (
              select 1 from jsonb_array_elements(k12.roster_rows) r
              where trim(r ->> 'sourceRow') = trim(ref ->> 'sourceRow')
            )
        )
        and exists (
          select 1 from jsonb_array_elements(
            case when jsonb_typeof(existing_teacher -> 'teacherSourceRefs') = 'array'
              then existing_teacher -> 'teacherSourceRefs' else '[]'::jsonb end
          ) ref
          where ref ->> 'workbook' = 'university'
            and ref ->> 'sourceId' = university.source_id
            and exists (
              select 1 from jsonb_array_elements(university.roster_rows) r
              where trim(r ->> 'sourceRow') = trim(ref ->> 'sourceRow')
            )
        )
    )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_identity_link_required';
  end if;

  -- Conversely, every current decision must match the submitted grouping: a
  -- merge pair appears on exactly one canonical teacher, while a separate
  -- pair must never appear together. This also rejects stale pre-decision
  -- plans racing a newly-saved administrator choice.
  if exists (
    select 1
    from internal.teacher_import_identity_links l
    where l.k12_source_id = k12.source_id
      and l.k12_revision = k12.revision
      and l.university_source_id = university.source_id
      and l.university_revision = university.revision
      and case l.decision
        when 'merge' then (
        select count(*)
        from jsonb_array_elements(p_teachers) t
        where exists (
          select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
          where ref ->> 'workbook' = 'k12'
            and ref ->> 'sourceId' = l.k12_source_id
            and trim(ref ->> 'sourceRow') = l.k12_source_row
        )
        and exists (
          select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
          where ref ->> 'workbook' = 'university'
            and ref ->> 'sourceId' = l.university_source_id
            and trim(ref ->> 'sourceRow') = l.university_source_row
        )
        ) <> 1
        when 'separate' then exists (
          select 1
          from jsonb_array_elements(p_teachers) t
          where exists (
            select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
            where ref ->> 'workbook' = 'k12'
              and ref ->> 'sourceId' = l.k12_source_id
              and trim(ref ->> 'sourceRow') = l.k12_source_row
          )
          and exists (
            select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
            where ref ->> 'workbook' = 'university'
              and ref ->> 'sourceId' = l.university_source_id
              and trim(ref ->> 'sourceRow') = l.university_source_row
          )
        )
        else true
      end
  ) then
    raise exception using errcode = '40001', message = 'teacher_import_identity_links_changed';
  end if;

  if replaying_prior then
    return query select
      'teachers'::text,
      prior.teachers_version,
      prior.committed_at,
      prior.committed_by,
      false;
    return;
  end if;

  update public.ops_state s set
    payload = p_teachers,
    version = s.version + 1,
    updated_at = now(),
    updated_by = left(trim(p_actor), 80)
  where s.entity = 'teachers'
  returning s.* into current_state;

  insert into public.ops_mutation_log(entity, version, actor)
  values ('teachers', current_state.version, current_state.updated_by);

  audit_entry_id := internal.append_operational_contract_audit(
    'teacher_import.committed',
    p_actor,
    'ops_state',
    'teachers',
    jsonb_build_object(
      'planFingerprint', p_plan_fingerprint,
      'k12Revision', k12.revision,
      'universityRevision', university.revision,
      'beforeVersion', p_expected_teacher_version,
      'afterVersion', current_state.version,
      'teacherCount', jsonb_array_length(p_teachers),
      'teachersSha256', teachers_hash
    )
  );

  insert into internal.teacher_import_commits (
    plan_fingerprint, k12_revision, university_revision, teachers_version,
    teachers_sha256, committed_by, committed_at, audit_id
  ) values (
    p_plan_fingerprint, k12.revision, university.revision,
    current_state.version, teachers_hash, left(trim(p_actor), 120),
    current_state.updated_at, audit_entry_id
  );

  return query select
    current_state.entity,
    current_state.version,
    current_state.updated_at,
    current_state.updated_by,
    true;
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

-- The prior hotfix exposed a three-argument internal overload.  All callers
-- above now use the four-argument filtered form, so remove the obsolete body.
drop function if exists internal.teacher_import_subject_hard_candidate_rows(
  internal.teacher_import_sources, internal.teacher_import_sources, text
);

revoke all on function internal.teacher_import_subject_hard_candidate_basis(
  internal.teacher_import_sources, internal.teacher_import_sources
) from public, anon, authenticated;
revoke all on function internal.teacher_import_subject_hard_candidate_rows(
  internal.teacher_import_sources, internal.teacher_import_sources, text, text
) from public, anon, authenticated;
revoke all on function internal.teacher_import_hard_candidates(
  internal.teacher_import_sources, internal.teacher_import_sources
) from public, anon, authenticated;
revoke all on function internal.teacher_import_hard_candidate_by_key(
  internal.teacher_import_sources, internal.teacher_import_sources, text, text
) from public, anon, authenticated;
revoke all on function public.commit_teacher_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.commit_teacher_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)
  to anon, authenticated;
