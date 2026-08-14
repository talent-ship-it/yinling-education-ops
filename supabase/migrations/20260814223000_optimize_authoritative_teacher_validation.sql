-- Forward-only performance repair for the locked authoritative teacher import.
-- The public RPC, its lock/CAS ordering, audit, signature and grants are unchanged.

create or replace function internal.teacher_import_expected_operational_fragments(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources,
  p_existing_teachers jsonb
)
returns table (
  teacher_id text,
  name_key text,
  active boolean,
  expected_operational jsonb
)
language sql
stable
set search_path = ''
as $$
  with authority_rows as materialized (
    select
      basis.*,
      pg_catalog.convert_to(basis.workbook, 'UTF8') || decode('00', 'hex') ||
      pg_catalog.convert_to(basis.source_id, 'UTF8') || decode('00', 'hex') ||
      pg_catalog.convert_to(
        internal.teacher_import_js_trim(basis.source_row #>> '{}'), 'UTF8'
      ) as reference_key
    from internal.teacher_import_authoritative_row_basis(p_k12, p_university) basis
  ), authorities as materialized (
    select
      authority_rows.name_key,
      count(*)::bigint as row_count,
      (pg_catalog.array_agg(
        authority_rows.row_name order by authority_rows.reference_key
      ))[1] as first_row_name
    from authority_rows
    group by authority_rows.name_key
  ), existing_index as materialized (
    -- Normalize every locked historical name once. The former lateral lookup
    -- repeated the NFKC/regexp contract for every authority/existing pair.
    select
      existing_teacher,
      internal.teacher_import_name_key(existing_teacher ->> 'name') as name_key
    from jsonb_array_elements(p_existing_teachers) existing_teacher
  ), existing_ranked as materialized (
    select
      existing_index.*,
      row_number() over (
        partition by pg_catalog.convert_to(existing_index.name_key, 'UTF8')
        order by pg_catalog.convert_to(existing_index.existing_teacher ->> 'id', 'UTF8')
      ) as existing_rank
    from existing_index
  ), active_base as materialized (
    select
      authority.name_key,
      authority.row_count,
      authority.first_row_name,
      existing.existing_teacher,
      coalesce(
        existing.existing_teacher ->> 'id',
        internal.teacher_import_authoritative_id(authority.name_key)
      ) as teacher_id,
      case
        when authority.row_count > 1 and existing.existing_teacher is not null
          then existing.existing_teacher ->> 'name'
        else authority.first_row_name
      end as display_name
    from authorities authority
    left join existing_ranked existing
      on existing.name_key = authority.name_key
     and existing.existing_rank = 1
  ), ranked_source_text as materialized (
    select
      authority_rows.name_key,
      source_text.kind,
      source_text.value,
      authority_rows.reference_key,
      row_number() over (
        partition by
          pg_catalog.convert_to(authority_rows.name_key, 'UTF8'),
          source_text.kind,
          pg_catalog.convert_to(source_text.value, 'UTF8')
        order by authority_rows.reference_key
      ) as occurrence_rank
    from authority_rows
    cross join lateral (values
      ('availability'::text, authority_rows.availability_text),
      ('capacity'::text, authority_rows.capacity_text)
    ) source_text(kind, value)
    where source_text.value is not null
  ), source_texts as materialized (
    select
      ranked_source_text.name_key,
      pg_catalog.string_agg(
        ranked_source_text.value, '；' order by ranked_source_text.reference_key
      ) filter (where ranked_source_text.kind = 'availability') as availability_source_text,
      pg_catalog.string_agg(
        ranked_source_text.value, '；' order by ranked_source_text.reference_key
      ) filter (where ranked_source_text.kind = 'capacity') as capacity_source_text
    from ranked_source_text
    where ranked_source_text.occurrence_rank = 1
    group by ranked_source_text.name_key
  ), source_locations as materialized (
    select
      authority_rows.name_key,
      min(authority_rows.location collate "C") as only_location,
      count(distinct pg_catalog.convert_to(authority_rows.location, 'UTF8')) as location_count
    from authority_rows
    where authority_rows.location is not null
    group by authority_rows.name_key
  ), active_values as materialized (
    select
      active_base.*,
      coalesce(
        case when jsonb_typeof(active_base.existing_teacher -> 'initials') = 'string'
          then internal.teacher_import_clean_text(active_base.existing_teacher ->> 'initials') end,
        internal.teacher_import_initials(active_base.display_name)
      ) as expected_initials,
      case
        when jsonb_typeof(active_base.existing_teacher -> 'availability') = 'string'
          and internal.teacher_import_js_trim(
            active_base.existing_teacher ->> 'availability'
          ) is not null
          then active_base.existing_teacher ->> 'availability'
        else '待老师按月提交'
      end as expected_availability,
      case
        when active_base.existing_teacher ->> 'availabilityStatus'
          in ('可接新生', '暂停接新', '待确认')
          then active_base.existing_teacher ->> 'availabilityStatus'
        else '待确认'
      end as expected_availability_status,
      case
        when jsonb_typeof(active_base.existing_teacher -> 'load') = 'number'
          and (active_base.existing_teacher ->> 'load')::numeric >= 0
          then active_base.existing_teacher -> 'load'
        else '0'::jsonb
      end as expected_load,
      case
        when jsonb_typeof(active_base.existing_teacher -> 'capacity') = 'number'
          and (active_base.existing_teacher ->> 'capacity')::numeric >= 0
          then active_base.existing_teacher -> 'capacity'
        else '0'::jsonb
      end as expected_capacity,
      case
        when jsonb_typeof(active_base.existing_teacher -> 'acceptsStudents') = 'boolean'
          then active_base.existing_teacher -> 'acceptsStudents'
        else 'false'::jsonb
      end as expected_accepts_students,
      coalesce(
        case when jsonb_typeof(active_base.existing_teacher -> 'note') = 'string'
          then internal.teacher_import_clean_text(active_base.existing_teacher ->> 'note') end,
        '待教务审核教师资料与月度 AVA'
      ) as expected_note,
      coalesce(
        case when jsonb_typeof(active_base.existing_teacher -> 'location') = 'string'
          then internal.teacher_import_clean_text(active_base.existing_teacher ->> 'location') end,
        case when source_locations.location_count = 1
          then source_locations.only_location end
      ) as expected_location,
      source_texts.availability_source_text,
      source_texts.capacity_source_text
    from active_base
    left join source_texts on source_texts.name_key = active_base.name_key
    left join source_locations on source_locations.name_key = active_base.name_key
  ), active_expected as materialized (
    select
      active_values.teacher_id,
      active_values.name_key,
      true as active,
      jsonb_build_object(
        'name', active_values.display_name,
        'initials', active_values.expected_initials,
        'availability', active_values.expected_availability,
        'availabilityStatus', active_values.expected_availability_status,
        'timezone', coalesce(
          case when jsonb_typeof(active_values.existing_teacher -> 'timezone') = 'string'
            then internal.teacher_import_clean_text(active_values.existing_teacher ->> 'timezone') end,
          internal.teacher_import_timezone_for_location(active_values.expected_location),
          'Australia/Melbourne'
        ),
        'load', active_values.expected_load,
        'capacity', active_values.expected_capacity,
        'acceptsStudents', active_values.expected_accepts_students,
        'note', active_values.expected_note
      )
      || case when active_values.expected_location is not null
        then jsonb_build_object('location', active_values.expected_location)
        else '{}'::jsonb end
      || case when active_values.availability_source_text is not null
        then jsonb_build_object(
          'availabilitySourceText', active_values.availability_source_text
        ) else '{}'::jsonb end
      || case when active_values.capacity_source_text is not null
        then jsonb_build_object('capacitySourceText', active_values.capacity_source_text)
        else '{}'::jsonb end as expected_operational
    from active_values
  ), historical_values as materialized (
    select
      existing.existing_teacher,
      existing.name_key,
      case when jsonb_typeof(existing.existing_teacher -> 'location') = 'string'
        then internal.teacher_import_clean_text(existing.existing_teacher ->> 'location') end
        as expected_location,
      case when jsonb_typeof(existing.existing_teacher -> 'availabilitySourceText') = 'string'
        then internal.teacher_import_clean_text(existing.existing_teacher ->> 'availabilitySourceText') end
        as availability_source_text,
      case when jsonb_typeof(existing.existing_teacher -> 'capacitySourceText') = 'string'
        then internal.teacher_import_clean_text(existing.existing_teacher ->> 'capacitySourceText') end
        as capacity_source_text
    from existing_index existing
    where not exists (
      select 1
      from active_expected
      where active_expected.teacher_id = existing.existing_teacher ->> 'id'
    )
  ), historical_expected as materialized (
    select
      historical_values.existing_teacher ->> 'id' as teacher_id,
      historical_values.name_key,
      false as active,
      jsonb_build_object(
        'name', internal.teacher_import_clean_text(
          historical_values.existing_teacher ->> 'name'
        ),
        'initials', coalesce(
          case when jsonb_typeof(historical_values.existing_teacher -> 'initials') = 'string'
            then internal.teacher_import_clean_text(
              historical_values.existing_teacher ->> 'initials'
            ) end,
          internal.teacher_import_initials(historical_values.existing_teacher ->> 'name')
        ),
        'availability', coalesce(
          case when jsonb_typeof(historical_values.existing_teacher -> 'availability') = 'string'
            then internal.teacher_import_clean_text(
              historical_values.existing_teacher ->> 'availability'
            ) end,
          '待老师按月提交'
        ),
        'availabilityStatus', '暂停接新',
        'timezone', coalesce(
          case when jsonb_typeof(historical_values.existing_teacher -> 'timezone') = 'string'
            then internal.teacher_import_clean_text(
              historical_values.existing_teacher ->> 'timezone'
            ) end,
          internal.teacher_import_timezone_for_location(historical_values.expected_location),
          'Australia/Melbourne'
        ),
        'load', case
          when jsonb_typeof(historical_values.existing_teacher -> 'load') = 'number'
            and (historical_values.existing_teacher ->> 'load')::numeric >= 0
            then historical_values.existing_teacher -> 'load'
          else '0'::jsonb end,
        'capacity', case
          when jsonb_typeof(historical_values.existing_teacher -> 'capacity') = 'number'
            and (historical_values.existing_teacher ->> 'capacity')::numeric >= 0
            then historical_values.existing_teacher -> 'capacity'
          else '0'::jsonb end,
        'acceptsStudents', false,
        'note', coalesce(
          case when jsonb_typeof(historical_values.existing_teacher -> 'note') = 'string'
            then internal.teacher_import_clean_text(
              historical_values.existing_teacher ->> 'note'
            ) end,
          '待教务审核教师资料与月度 AVA'
        )
      )
      || case when historical_values.expected_location is not null
        then jsonb_build_object('location', historical_values.expected_location)
        else '{}'::jsonb end
      || case when historical_values.availability_source_text is not null
        then jsonb_build_object(
          'availabilitySourceText', historical_values.availability_source_text
        ) else '{}'::jsonb end
      || case when historical_values.capacity_source_text is not null
        then jsonb_build_object(
          'capacitySourceText', historical_values.capacity_source_text
        ) else '{}'::jsonb end as expected_operational
    from historical_values
  )
  select * from active_expected
  union all
  select * from historical_expected
$$;

create or replace function internal.assert_teacher_import_authoritative_plan(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources,
  p_existing_teachers jsonb,
  p_teachers jsonb
)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  authoritative_refs jsonb;
  authoritative_subjects jsonb;
  authoritative_details jsonb;
begin
  if jsonb_typeof(p_existing_teachers) is distinct from 'array'
     or jsonb_typeof(p_teachers) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'invalid_teacher_import_authority_validation';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_k12.subject_rows) as subject_rows(subject_row)
    where subject_row ->> 'sheetName' <> all(array[
      'Local English','ABC华裔English','Maths&Science','VCE数学科学','VCE其他',
      '奖学金','AEAS','青少英语','QCE','HSC','WACE','SACE','AMC数学竞赛',
      '科学竞赛','雅思PTE','IB'
    ])
  ) or exists (
    select 1
    from jsonb_array_elements(p_university.subject_rows) as subject_rows(subject_row)
    where subject_row ->> 'sheetName' <> all(array[
      'Engineering','商科','IT','理科','文科（含论文辅导）','教育学','其他科目'
    ])
  ) then
    raise exception using errcode = '22023', message = 'teacher_import_authoritative_subject_sheet_mismatch';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'nameKey', basis.name_key,
    'workbook', basis.workbook,
    'sourceId', basis.source_id,
    'sourceRow', basis.source_row,
    'refKind', basis.ref_kind,
    'workbookOrder', basis.workbook_order,
    'refOrder', basis.ref_order
  ) order by
    basis.workbook_order,
    basis.ref_order,
    basis.ref_kind collate "C",
    basis.name_key collate "C"
  ), '[]'::jsonb)
  into authoritative_refs
  from internal.teacher_import_authoritative_ref_basis(p_k12, p_university) basis;

  select coalesce(jsonb_agg(jsonb_build_object(
    'nameKey', basis.name_key,
    'sheetName', basis.sheet_name,
    'workbookOrder', basis.workbook_order,
    'sheetOrder', basis.sheet_order
  ) order by
    basis.workbook_order,
    basis.sheet_order,
    basis.sheet_name collate "C",
    basis.name_key collate "C"
  ), '[]'::jsonb)
  into authoritative_subjects
  from internal.teacher_import_authoritative_subject_basis(p_k12, p_university) basis;

  select coalesce(jsonb_agg(jsonb_build_object(
    'nameKey', basis.name_key,
    'detail', basis.detail,
    'workbookOrder', basis.workbook_order,
    'detailOrder', basis.detail_order
  ) order by
    basis.workbook_order,
    basis.detail_order,
    basis.name_key collate "C",
    basis.detail collate "C"
  ), '[]'::jsonb)
  into authoritative_details
  from internal.teacher_import_authoritative_detail_basis(p_k12, p_university) basis;

  -- Empty conservative keys or duplicate stable refs make the server source
  -- itself ambiguous.  Never let a submitted payload choose an interpretation.
  if jsonb_array_length(authoritative_refs) = 0
     or exists (
       select 1 from jsonb_array_elements(authoritative_refs) basis
       where nullif(basis ->> 'nameKey', '') is null
          or nullif(trim(basis ->> 'sourceRow'), '') is null
     )
     or jsonb_array_length(authoritative_refs) <> (
       select count(distinct jsonb_build_array(
         basis ->> 'workbook', basis ->> 'sourceId', trim(basis ->> 'sourceRow')
       ))
       from jsonb_array_elements(authoritative_refs) basis
     ) then
    raise exception using errcode = '22023', message = 'teacher_import_authoritative_source_invalid';
  end if;

  -- Teacher IDs are durable historical primary keys.  A refresh may improve
  -- the display spelling, but it may never repurpose an existing ID for a
  -- different exact normalized name, even after current source refs were
  -- stripped while that teacher was historical.
  if exists (
    select 1
    from jsonb_array_elements(p_existing_teachers) existing_teacher
    join jsonb_array_elements(p_teachers) teacher
      on teacher ->> 'id' = existing_teacher ->> 'id'
    where internal.teacher_import_name_key(teacher ->> 'name') <>
          internal.teacher_import_name_key(existing_teacher ->> 'name')
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_existing_id_name_changed';
  end if;

  -- The import owns only the planner's managed fields.  Payroll, reviewed
  -- availability, capacity assignments and every other historical extension
  -- are server-owned and must survive byte-for-byte at the JSONB boundary.
  if exists (
    select 1
    from jsonb_array_elements(p_existing_teachers) existing_teacher
    join jsonb_array_elements(p_teachers) teacher
      on teacher ->> 'id' = existing_teacher ->> 'id'
    where (
      teacher - array[
        'id','name','subjects','subjectDetail','departments','sourceCategories',
        'teacherSourceRefs','availability','availabilityStatus',
        'availabilitySourceText','capacitySourceText','initials','timezone',
        'load','capacity','acceptsStudents','note','location'
      ]::text[]
    ) is distinct from (
      existing_teacher - array[
        'id','name','subjects','subjectDetail','departments','sourceCategories',
        'teacherSourceRefs','availability','availabilityStatus',
        'availabilitySourceText','capacitySourceText','initials','timezone',
        'load','capacity','acceptsStudents','note','location'
      ]::text[]
    )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_existing_unmanaged_fields_changed';
  end if;

  -- A newly created teacher has no historical extensions to preserve.  Its
  -- complete top-level shape must therefore be limited to the exact planner
  -- allowlist; fabricated payroll or reviewed scheduling data is forbidden.
  if exists (
    select 1
    from jsonb_array_elements(p_teachers) teacher
    where not exists (
      select 1
      from jsonb_array_elements(p_existing_teachers) existing_teacher
      where existing_teacher ->> 'id' = teacher ->> 'id'
    )
      and (
        teacher - array[
          'id','name','subjects','subjectDetail','departments','sourceCategories',
          'teacherSourceRefs','availability','availabilityStatus',
          'availabilitySourceText','capacitySourceText','initials','timezone',
          'load','capacity','acceptsStudents','note','location'
        ]::text[]
      ) is distinct from '{}'::jsonb
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_new_teacher_unmanaged_fields';
  end if;

  -- Every roster or deterministic subject-only ref is owned exactly once.
  if exists (
    select 1
    from jsonb_array_elements(authoritative_refs) basis
    where (
      select count(*)
      from jsonb_array_elements(p_teachers) teacher
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(teacher -> 'teacherSourceRefs') = 'array'
          then teacher -> 'teacherSourceRefs' else '[]'::jsonb end
      ) teacher_ref
      where teacher_ref ->> 'workbook' = basis ->> 'workbook'
        and teacher_ref ->> 'sourceId' = basis ->> 'sourceId'
        and trim(teacher_ref ->> 'sourceRow') = trim(basis ->> 'sourceRow')
    ) <> 1
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_authoritative_reference_mismatch';
  end if;

  -- Current source namespaces are replacement snapshots.  Old rows in those
  -- four namespaces cannot leak through and invented rows cannot be added.
  if exists (
    select 1
    from jsonb_array_elements(p_teachers) teacher
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(teacher -> 'teacherSourceRefs') = 'array'
        then teacher -> 'teacherSourceRefs' else '[]'::jsonb end
    ) teacher_ref
    where teacher_ref ->> 'sourceId' in (
      p_k12.source_id, p_k12.source_id || '#subjects',
      p_university.source_id, p_university.source_id || '#subjects'
    )
      and not exists (
        select 1
        from jsonb_array_elements(authoritative_refs) basis
        where teacher_ref ->> 'workbook' = basis ->> 'workbook'
          and teacher_ref ->> 'sourceId' = basis ->> 'sourceId'
          and trim(teacher_ref ->> 'sourceRow') = trim(basis ->> 'sourceRow')
      )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_authoritative_reference_mismatch';
  end if;

  -- All current refs for one exact name must land on one canonical teacher;
  -- that teacher's own display name must normalise to the same exact key.
  if exists (
    select basis ->> 'nameKey'
    from jsonb_array_elements(authoritative_refs) basis
    join jsonb_array_elements(p_teachers) teacher on exists (
      select 1
      from jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
      where teacher_ref ->> 'workbook' = basis ->> 'workbook'
        and teacher_ref ->> 'sourceId' = basis ->> 'sourceId'
        and trim(teacher_ref ->> 'sourceRow') = trim(basis ->> 'sourceRow')
    )
    group by basis ->> 'nameKey'
    having count(distinct teacher ->> 'id') <> 1
  ) or exists (
    select 1
    from jsonb_array_elements(authoritative_refs) basis
    join jsonb_array_elements(p_teachers) teacher on exists (
      select 1
      from jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
      where teacher_ref ->> 'workbook' = basis ->> 'workbook'
        and teacher_ref ->> 'sourceId' = basis ->> 'sourceId'
        and trim(teacher_ref ->> 'sourceRow') = trim(basis ->> 'sourceRow')
    )
    where internal.teacher_import_name_key(teacher ->> 'name') <> basis ->> 'nameKey'
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_authoritative_name_mismatch';
  end if;

  -- Reuse the one exact-name historical ID.  More than one historical ID for
  -- an authoritative name is ambiguous and must not be resolved by the client.
  if exists (
    select authority.name_key
    from (
      select distinct basis ->> 'nameKey' as name_key
      from jsonb_array_elements(authoritative_refs) basis
    ) authority
    join jsonb_array_elements(p_existing_teachers) existing_teacher
      on internal.teacher_import_name_key(existing_teacher ->> 'name') = authority.name_key
    group by authority.name_key
    having count(*) > 1
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_existing_name_ambiguous';
  end if;
  if exists (
    select 1
    from (
      select distinct basis ->> 'nameKey' as name_key
      from jsonb_array_elements(authoritative_refs) basis
    ) authority
    join jsonb_array_elements(p_existing_teachers) existing_teacher
      on internal.teacher_import_name_key(existing_teacher ->> 'name') = authority.name_key
    where not exists (
      select 1
      from jsonb_array_elements(p_teachers) teacher
      where teacher ->> 'id' = existing_teacher ->> 'id'
        and exists (
          select 1
          from jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
          join jsonb_array_elements(authoritative_refs) basis
            on teacher_ref ->> 'workbook' = basis ->> 'workbook'
           and teacher_ref ->> 'sourceId' = basis ->> 'sourceId'
           and trim(teacher_ref ->> 'sourceRow') = trim(basis ->> 'sourceRow')
          where basis ->> 'nameKey' = authority.name_key
        )
    )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_exact_name_existing_id_mismatch';
  end if;

  -- If no historical exact-name record exists, the one new ID is derived
  -- solely from that normalized name.  This keeps the identity stable when a
  -- row moves and prevents a reused row from overwriting a historical person.
  if exists (
    select 1
    from (
      select distinct basis ->> 'nameKey' as name_key
      from jsonb_array_elements(authoritative_refs) basis
    ) authority
    join jsonb_array_elements(p_existing_teachers) occupied
      on occupied ->> 'id' = internal.teacher_import_authoritative_id(authority.name_key)
    where not exists (
      select 1
      from jsonb_array_elements(p_existing_teachers) existing_teacher
      where internal.teacher_import_name_key(existing_teacher ->> 'name') = authority.name_key
    )
      and internal.teacher_import_name_key(occupied ->> 'name') <> authority.name_key
  ) or exists (
    select 1
    from (
      select distinct basis ->> 'nameKey' as name_key
      from jsonb_array_elements(authoritative_refs) basis
    ) authority
    join jsonb_array_elements(p_teachers) occupied
      on occupied ->> 'id' = internal.teacher_import_authoritative_id(authority.name_key)
    where not exists (
      select 1
      from jsonb_array_elements(p_existing_teachers) existing_teacher
      where internal.teacher_import_name_key(existing_teacher ->> 'name') = authority.name_key
    )
      and internal.teacher_import_name_key(occupied ->> 'name') <> authority.name_key
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_authoritative_id_collision';
  end if;

  if exists (
    select 1
    from (
      select distinct basis ->> 'nameKey' as name_key
      from jsonb_array_elements(authoritative_refs) basis
    ) authority
    where not exists (
      select 1
      from jsonb_array_elements(p_existing_teachers) existing_teacher
      where internal.teacher_import_name_key(existing_teacher ->> 'name') = authority.name_key
    )
      and not exists (
        select 1
        from jsonb_array_elements(p_teachers) teacher
        where teacher ->> 'id' = internal.teacher_import_authoritative_id(authority.name_key)
          and internal.teacher_import_name_key(teacher ->> 'name') = authority.name_key
          and exists (
            select 1
            from jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
            join jsonb_array_elements(authoritative_refs) basis
              on teacher_ref ->> 'workbook' = basis ->> 'workbook'
             and teacher_ref ->> 'sourceId' = basis ->> 'sourceId'
             and trim(teacher_ref ->> 'sourceRow') = trim(basis ->> 'sourceRow')
            where basis ->> 'nameKey' = authority.name_key
          )
      )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_authoritative_id_mismatch';
  end if;

  -- The caller cannot choose operational state, even when every submitted
  -- primitive has a valid wire type. Rebuild the exact active or historical
  -- projection from the locked current record and both locked source rows,
  -- then compare all twelve operational keys including optional key presence.
  if exists (
    with teacher_by_id as materialized (
      select teacher ->> 'id' as teacher_id, teacher
      from jsonb_array_elements(p_teachers) teacher
    )
    select 1
    from internal.teacher_import_expected_operational_fragments(
      p_k12, p_university, p_existing_teachers
    ) expected
    left join teacher_by_id on teacher_by_id.teacher_id = expected.teacher_id
    where coalesce((
      select jsonb_object_agg(field.key, field.value)
      from jsonb_each(teacher_by_id.teacher) field
      where field.key = any(array[
        'name','initials','availability','availabilityStatus','timezone',
        'load','capacity','acceptsStudents','note','location',
        'availabilitySourceText','capacitySourceText'
      ]::text[])
    ), '{}'::jsonb) is distinct from expected.expected_operational
  ) then
    raise exception using errcode = '23503',
      message = 'teacher_import_operational_projection_mismatch';
  end if;

  -- For each authoritative name, subjects and sourceCategories are exactly
  -- the de-duplicated tab memberships in workbook/sheet order.
  if exists (
    with teacher_by_name as materialized (
      -- Reference ownership and display-name equality were proven above.
      -- Index the submitted plan once instead of rejoining every name/teacher
      -- pair through the complete authoritative reference array.
      select
        teacher,
        internal.teacher_import_name_key(teacher ->> 'name') as name_key
      from jsonb_array_elements(p_teachers) teacher
    ), expected as materialized (
      select authority.name_key,
        coalesce((
          select jsonb_agg(to_jsonb(subject_basis ->> 'sheetName') order by
            (subject_basis ->> 'workbookOrder')::integer,
            (subject_basis ->> 'sheetOrder')::bigint,
            (subject_basis ->> 'sheetName') collate "C"
          )
          from jsonb_array_elements(authoritative_subjects) subject_basis
          where subject_basis ->> 'nameKey' = authority.name_key
        ), '[]'::jsonb) as expected_subjects
      from (
        select distinct basis ->> 'nameKey' as name_key
        from jsonb_array_elements(authoritative_refs) basis
      ) authority
    )
    select 1
    from expected
    join teacher_by_name on teacher_by_name.name_key = expected.name_key
    where teacher_by_name.teacher -> 'subjects' is distinct from expected.expected_subjects
       or teacher_by_name.teacher -> 'sourceCategories' is distinct from expected.expected_subjects
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_authoritative_subject_mismatch';
  end if;

  -- Departments come from every current authority workbook, including roster-
  -- only teachers. Subject detail is the cleaned first-seen subject-row union;
  -- absence is represented by an absent key, never JSON null.
  if exists (
    with teacher_by_name as materialized (
      select
        teacher,
        internal.teacher_import_name_key(teacher ->> 'name') as name_key
      from jsonb_array_elements(p_teachers) teacher
    ), expected as materialized (
      select
        authority.name_key,
        coalesce((
          select jsonb_agg(to_jsonb(department.department) order by department.workbook_order)
          from (
            select distinct
              case basis ->> 'workbook'
                when 'k12' then '中小学'
                else '大学'
              end as department,
              case basis ->> 'workbook'
                when 'k12' then 1
                else 2
              end as workbook_order
            from jsonb_array_elements(authoritative_refs) basis
            where basis ->> 'nameKey' = authority.name_key
          ) department
        ), '[]'::jsonb) as expected_departments,
        (
          select string_agg(detail_basis ->> 'detail', '；' order by
            (detail_basis ->> 'workbookOrder')::integer,
            (detail_basis ->> 'detailOrder')::bigint
          )
          from jsonb_array_elements(authoritative_details) detail_basis
          where detail_basis ->> 'nameKey' = authority.name_key
        ) as expected_detail
      from (
        select distinct basis ->> 'nameKey' as name_key
        from jsonb_array_elements(authoritative_refs) basis
      ) authority
    )
    select 1
    from expected
    join teacher_by_name on teacher_by_name.name_key = expected.name_key
    where teacher_by_name.teacher -> 'departments' is distinct from expected.expected_departments
       or (expected.expected_detail is null and teacher_by_name.teacher ? 'subjectDetail')
       or (expected.expected_detail is not null and
           pg_catalog.convert_to(teacher_by_name.teacher ->> 'subjectDetail', 'UTF8') is distinct from
           pg_catalog.convert_to(expected.expected_detail, 'UTF8'))
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_authoritative_metadata_mismatch';
  end if;

  -- A refresh may not remove an existing ID or manufacture an unreferenced
  -- teacher.  New IDs are permitted only when they own a current authority ref.
  if exists (
    select 1
    from jsonb_array_elements(p_existing_teachers) existing_teacher
    where not exists (
      select 1 from jsonb_array_elements(p_teachers) teacher
      where teacher ->> 'id' = existing_teacher ->> 'id'
    )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_existing_teacher_removed';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_teachers) teacher
    where not exists (
      select 1 from jsonb_array_elements(p_existing_teachers) existing_teacher
      where existing_teacher ->> 'id' = teacher ->> 'id'
    )
      and not exists (
        select 1
        from jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
        join jsonb_array_elements(authoritative_refs) basis
          on teacher_ref ->> 'workbook' = basis ->> 'workbook'
         and teacher_ref ->> 'sourceId' = basis ->> 'sourceId'
         and trim(teacher_ref ->> 'sourceRow') = trim(basis ->> 'sourceRow')
      )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_unreferenced_teacher_added';
  end if;

  -- Unrelated historical references are append-forbidden and removal-forbidden
  -- per ID.  Only the four current replacement namespaces may be refreshed.
  if exists (
    select 1
    from jsonb_array_elements(p_existing_teachers) existing_teacher
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(existing_teacher -> 'teacherSourceRefs') = 'array'
        then existing_teacher -> 'teacherSourceRefs' else '[]'::jsonb end
    ) existing_ref
    where existing_ref ->> 'sourceId' not in (
      p_k12.source_id, p_k12.source_id || '#subjects',
      p_university.source_id, p_university.source_id || '#subjects'
    )
      and not exists (
        select 1
        from jsonb_array_elements(p_teachers) teacher
        cross join lateral jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
        where teacher ->> 'id' = existing_teacher ->> 'id'
          and teacher_ref ->> 'workbook' = existing_ref ->> 'workbook'
          and teacher_ref ->> 'sourceId' = existing_ref ->> 'sourceId'
          and trim(teacher_ref ->> 'sourceRow') = trim(existing_ref ->> 'sourceRow')
      )
  ) or exists (
    select 1
    from jsonb_array_elements(p_teachers) teacher
    cross join lateral jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
    where teacher_ref ->> 'sourceId' not in (
      p_k12.source_id, p_k12.source_id || '#subjects',
      p_university.source_id, p_university.source_id || '#subjects'
    )
      and not exists (
        select 1
        from jsonb_array_elements(p_existing_teachers) existing_teacher
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(existing_teacher -> 'teacherSourceRefs') = 'array'
            then existing_teacher -> 'teacherSourceRefs' else '[]'::jsonb end
        ) existing_ref
        where existing_teacher ->> 'id' = teacher ->> 'id'
          and existing_ref ->> 'workbook' = teacher_ref ->> 'workbook'
          and existing_ref ->> 'sourceId' = teacher_ref ->> 'sourceId'
          and trim(existing_ref ->> 'sourceRow') = trim(teacher_ref ->> 'sourceRow')
      )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_historical_reference_mismatch';
  end if;

  -- IDs absent from today's union remain available to bookings/payroll/history,
  -- but old teaching authority is revoked until a future workbook adds them.
  if exists (
    select 1
    from jsonb_array_elements(p_teachers) teacher
    where not exists (
      select 1
      from jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
      join jsonb_array_elements(authoritative_refs) basis
        on teacher_ref ->> 'workbook' = basis ->> 'workbook'
       and teacher_ref ->> 'sourceId' = basis ->> 'sourceId'
       and trim(teacher_ref ->> 'sourceRow') = trim(basis ->> 'sourceRow')
    )
      and (
        teacher -> 'subjects' is distinct from '[]'::jsonb
        or teacher -> 'departments' is distinct from '[]'::jsonb
        or teacher -> 'sourceCategories' is distinct from '[]'::jsonb
        or teacher ? 'subjectDetail'
        or (teacher ->> 'availabilityStatus') is distinct from '暂停接新'
        or (teacher ->> 'acceptsStudents') is distinct from 'false'
      )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_historical_authority_not_cleared';
  end if;
end;
$$;

revoke all on function internal.teacher_import_expected_operational_fragments(
  internal.teacher_import_sources, internal.teacher_import_sources, jsonb
) from public, anon, authenticated;
revoke all on function internal.assert_teacher_import_authoritative_plan(
  internal.teacher_import_sources, internal.teacher_import_sources, jsonb, jsonb
) from public, anon, authenticated;

