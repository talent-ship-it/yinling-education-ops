-- Forward-only teacher import authority repair.
-- Scope: teacher name normalization, exact-name source/subject closure, and
-- the teacher import commit RPC. No other operational entity is changed.

create or replace function internal.teacher_import_clean_text(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- NORMALIZE is PostgreSQL's SQL-special grammar and is rewritten by the
  -- parser to pg_catalog.normalize, so it remains pinned with search_path=''.
  select nullif(pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.translate(
      normalize(coalesce(p_value, ''), NFKC),
      U&'\200B\200C\200D\FEFF',
      ''
    ),
    -- ECMAScript WhiteSpace + LineTerminator, matching JS /[\s\u3000]+/.
    U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]+',
    ' ',
    'g'
  )), '')
$$;

-- JavaScript String.prototype.trim() deliberately differs from cleanText:
-- active reviewed availability is retained byte-for-byte whenever trimming
-- only the ECMAScript edge whitespace leaves a value.
create or replace function internal.teacher_import_js_trim(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(pg_catalog.btrim(
    coalesce(p_value, ''),
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  ), '')
$$;

create or replace function internal.teacher_import_initials(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  normalized_name text := normalize(coalesce(p_name, ''), NFKC);
  trimmed_name text;
  tokens text[];
  result text;
begin
  trimmed_name := pg_catalog.btrim(
    normalized_name,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  );
  select coalesce(pg_catalog.array_agg(token order by token_order), '{}'::text[])
  into tokens
  from pg_catalog.unnest(pg_catalog.regexp_split_to_array(
    trimmed_name,
    U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF\00B7\30FB_-]+'
  )) with ordinality split(token, token_order)
  where token <> '';

  if pg_catalog.cardinality(tokens) > 1 then
    result := pg_catalog.substring(tokens[1] from 1 for 1)
      || pg_catalog.substring(tokens[2] from 1 for 1);
  else
    result := pg_catalog.substring(coalesce(tokens[1], p_name, '') from 1 for 2);
  end if;
  return pg_catalog.translate(result, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
end;
$$;

create or replace function internal.teacher_import_timezone_for_location(p_location text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  location_key text := pg_catalog.translate(
    normalize(coalesce(p_location, ''), NFKC),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz'
  );
begin
  if location_key ~ '(^|[^a-z0-9_])(melbourne|vic|victoria)([^a-z0-9_]|$)'
     or pg_catalog.position('墨尔本' in location_key) > 0
     or pg_catalog.position('维州' in location_key) > 0 then
    return 'Australia/Melbourne';
  elsif location_key ~ '(^|[^a-z0-9_])(sydney|nsw|new south wales|canberra|act)([^a-z0-9_]|$)'
     or pg_catalog.position('悉尼' in location_key) > 0
     or pg_catalog.position('新州' in location_key) > 0
     or pg_catalog.position('堪培拉' in location_key) > 0 then
    return 'Australia/Sydney';
  elsif location_key ~ '(^|[^a-z0-9_])(brisbane|qld|queensland)([^a-z0-9_]|$)'
     or pg_catalog.position('布里斯班' in location_key) > 0
     or pg_catalog.position('昆州' in location_key) > 0 then
    return 'Australia/Brisbane';
  elsif location_key ~ '(^|[^a-z0-9_])(adelaide|sa|south australia)([^a-z0-9_]|$)'
     or pg_catalog.position('阿德莱德' in location_key) > 0
     or pg_catalog.position('南澳' in location_key) > 0 then
    return 'Australia/Adelaide';
  elsif location_key ~ '(^|[^a-z0-9_])(perth|wa|western australia)([^a-z0-9_]|$)'
     or pg_catalog.position('珀斯' in location_key) > 0
     or pg_catalog.position('西澳' in location_key) > 0 then
    return 'Australia/Perth';
  elsif location_key ~ '(^|[^a-z0-9_])(hobart|tas|tasmania)([^a-z0-9_]|$)'
     or pg_catalog.position('霍巴特' in location_key) > 0
     or pg_catalog.position('塔州' in location_key) > 0 then
    return 'Australia/Hobart';
  elsif location_key ~ '(^|[^a-z0-9_])(darwin|nt|northern territory)([^a-z0-9_]|$)'
     or pg_catalog.position('达尔文' in location_key) > 0
     or pg_catalog.position('北领地' in location_key) > 0 then
    return 'Australia/Darwin';
  elsif location_key ~ '(^|[^a-z0-9_])(china|beijing|shanghai|guangzhou|shenzhen)([^a-z0-9_]|$)'
     or pg_catalog.position('中国' in location_key) > 0
     or pg_catalog.position('北京' in location_key) > 0
     or pg_catalog.position('上海' in location_key) > 0
     or pg_catalog.position('广州' in location_key) > 0
     or pg_catalog.position('深圳' in location_key) > 0 then
    return 'Asia/Shanghai';
  end if;
  return null;
end;
$$;

create or replace function internal.teacher_import_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- NORMALIZE is PostgreSQL's SQL-special grammar and is rewritten by the
  -- parser to pg_catalog.normalize, so it remains pinned with search_path=''.
  select pg_catalog.translate(
    pg_catalog.btrim(pg_catalog.regexp_replace(
      pg_catalog.translate(
        normalize(coalesce(p_name, ''), NFKC),
        U&'\200B\200C\200D\FEFF',
        ''
      ),
      -- ECMAScript WhiteSpace + LineTerminator, matching JS /[\s\u3000]+/.
      U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]+',
      ' ',
      'g'
    )),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz'
  )
$$;

-- New canonical IDs are bound to the exact normalized name, which is the
-- authority identity boundary.  They deliberately do not depend on a row
-- number: rows may be reordered or reused without changing or repurposing an
-- existing teacher ID.
create or replace function internal.teacher_import_authoritative_id(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'TEA-TX-A-' || encode(extensions.digest(
    pg_catalog.convert_to(internal.teacher_import_name_key(p_name), 'UTF8'),
    'sha256'
  ), 'hex')
$$;

do $$
begin
  if internal.teacher_import_name_key('老师，A：B') <>
       internal.teacher_import_name_key('老师,A:B') then
    raise exception using errcode = '22023',
      message = 'teacher_name_contract_fixture_mismatch_fullwidth_punctuation';
  end if;
  if internal.teacher_import_name_key('ASCII CASE') <> 'ascii case'
     or internal.teacher_import_name_key('Oﬁ ＆ CO') <> 'ofi & co'
     or internal.teacher_import_name_key('ÉLODIE') <> 'Élodie'
     or internal.teacher_import_name_key('İSTANBUL') <> 'İstanbul'
     or internal.teacher_import_name_key('ΑΒΓ ABC') <> 'ΑΒΓ abc'
     or internal.teacher_import_name_key('White' || chr(160) || 'Space') <>
        'white space' then
    raise exception using errcode = '22023',
      message = 'teacher_name_contract_fixture_mismatch_nfkc_ascii_case_runtime';
  end if;
  if internal.teacher_import_authoritative_id('老师，A：B') <>
       internal.teacher_import_authoritative_id('老师,A:B')
     or internal.teacher_import_authoritative_id(' Ｎi，：老师 ') <>
       'TEA-TX-A-ed62142be3bc6f1f3c19457d0d78fee6210f3e287cd6df153c4ea5b131f98b68'
     or internal.teacher_import_authoritative_id('Subject Only') <>
       'TEA-TX-A-831126c3f6b9995b27b548aa86b83cd9b5b64f871a01e75c655f2e213a35eb2a' then
    raise exception using errcode = '22023',
      message = 'teacher_authoritative_id_contract_fixture_mismatch';
  end if;
end;
$$;

create or replace function internal.teacher_import_authoritative_ref_basis(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources
)
returns table (
  name_key text,
  workbook text,
  source_id text,
  source_row jsonb,
  ref_kind text,
  workbook_order integer,
  ref_order bigint
)
language sql
stable
set search_path = ''
as $$
  with roster as materialized (
    select
      internal.teacher_import_name_key(roster_row ->> 'name') as name_key,
      'k12'::text as workbook,
      p_k12.source_id as source_id,
      roster_row -> 'sourceRow' as source_row,
      'roster'::text as ref_kind,
      1 as workbook_order,
      roster_ordinality as ref_order
    from jsonb_array_elements(p_k12.roster_rows) with ordinality
      as roster_rows(roster_row, roster_ordinality)

    union all

    select
      internal.teacher_import_name_key(roster_row ->> 'name'),
      'university',
      p_university.source_id,
      roster_row -> 'sourceRow',
      'roster',
      2,
      roster_ordinality
    from jsonb_array_elements(p_university.roster_rows) with ordinality
      as roster_rows(roster_row, roster_ordinality)
  ), subject_names as materialized (
    select
      subject_name.name_key,
      subject_name.workbook,
      subject_name.source_id,
      subject_name.workbook_order,
      min(subject_name.subject_ordinality) as ref_order
    from (
      select
        internal.teacher_import_name_key(subject_row ->> 'name') as name_key,
        'k12'::text as workbook,
        p_k12.source_id as source_id,
        1 as workbook_order,
        subject_ordinality
      from jsonb_array_elements(p_k12.subject_rows) with ordinality
        as subject_rows(subject_row, subject_ordinality)
      where subject_row ->> 'sheetName' = any(array[
        'Local English','ABC华裔English','Maths&Science','VCE数学科学','VCE其他',
        '奖学金','AEAS','青少英语','QCE','HSC','WACE','SACE','AMC数学竞赛',
        '科学竞赛','雅思PTE','IB'
      ])

      union all

      select
        internal.teacher_import_name_key(subject_row ->> 'name'),
        'university',
        p_university.source_id,
        2,
        subject_ordinality
      from jsonb_array_elements(p_university.subject_rows) with ordinality
        as subject_rows(subject_row, subject_ordinality)
      where subject_row ->> 'sheetName' = any(array[
        'Engineering','商科','IT','理科','文科（含论文辅导）','教育学','其他科目'
      ])
    ) subject_name
    where subject_name.name_key <> ''
    group by
      subject_name.name_key,
      subject_name.workbook,
      subject_name.source_id,
      subject_name.workbook_order
  ), authoritative_refs as materialized (
    select
      roster.name_key,
      roster.workbook,
      roster.source_id,
      roster.source_row,
      roster.ref_kind,
      roster.workbook_order,
      roster.ref_order
    from roster

    union all

    select
      subject_name.name_key,
      subject_name.workbook,
      subject_name.source_id || '#subjects',
      to_jsonb(
        'name:' || encode(extensions.digest(
          pg_catalog.convert_to(subject_name.name_key, 'UTF8'), 'sha256'
        ), 'hex')
      ),
      'subject_name',
      subject_name.workbook_order,
      subject_name.ref_order
    from subject_names subject_name
    where not exists (
      select 1
      from roster
      where roster.workbook = subject_name.workbook
        and roster.name_key = subject_name.name_key
    )
  )
  select
    authoritative_refs.name_key,
    authoritative_refs.workbook,
    authoritative_refs.source_id,
    authoritative_refs.source_row,
    authoritative_refs.ref_kind,
    authoritative_refs.workbook_order,
    authoritative_refs.ref_order
  from authoritative_refs
  order by
    authoritative_refs.workbook_order,
    authoritative_refs.ref_order,
    authoritative_refs.ref_kind collate "C",
    authoritative_refs.name_key collate "C"
$$;

-- One row for every active roster row, or one deterministic synthetic row per
-- workbook/name when the name exists only in a subject tab.  This is the
-- complete locked-source basis for the server-owned operational projection.
create or replace function internal.teacher_import_authoritative_row_basis(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources
)
returns table (
  name_key text,
  workbook text,
  source_id text,
  source_row jsonb,
  ref_kind text,
  workbook_order integer,
  ref_order bigint,
  row_name text,
  availability_text text,
  capacity_text text,
  location text
)
language sql
stable
set search_path = ''
as $$
  with roster as materialized (
    select
      internal.teacher_import_name_key(roster_row ->> 'name') as name_key,
      'k12'::text as workbook,
      p_k12.source_id as source_id,
      roster_row -> 'sourceRow' as source_row,
      'roster'::text as ref_kind,
      1 as workbook_order,
      roster_ordinality as ref_order,
      internal.teacher_import_clean_text(roster_row ->> 'name') as row_name,
      case when jsonb_typeof(roster_row -> 'availabilityText') = 'string'
        then internal.teacher_import_clean_text(roster_row ->> 'availabilityText') end,
      case when jsonb_typeof(roster_row -> 'capacityText') = 'string'
        then internal.teacher_import_clean_text(roster_row ->> 'capacityText') end,
      case when jsonb_typeof(roster_row #> '{attributes,location}') = 'string'
        then internal.teacher_import_clean_text(roster_row #>> '{attributes,location}') end
    from jsonb_array_elements(p_k12.roster_rows) with ordinality
      as roster_rows(roster_row, roster_ordinality)

    union all

    select
      internal.teacher_import_name_key(roster_row ->> 'name'),
      'university',
      p_university.source_id,
      roster_row -> 'sourceRow',
      'roster',
      2,
      roster_ordinality,
      internal.teacher_import_clean_text(roster_row ->> 'name'),
      case when jsonb_typeof(roster_row -> 'availabilityText') = 'string'
        then internal.teacher_import_clean_text(roster_row ->> 'availabilityText') end,
      case when jsonb_typeof(roster_row -> 'capacityText') = 'string'
        then internal.teacher_import_clean_text(roster_row ->> 'capacityText') end,
      case when jsonb_typeof(roster_row #> '{attributes,location}') = 'string'
        then internal.teacher_import_clean_text(roster_row #>> '{attributes,location}') end
    from jsonb_array_elements(p_university.roster_rows) with ordinality
      as roster_rows(roster_row, roster_ordinality)
  ), raw_subject_names as materialized (
    select
      internal.teacher_import_name_key(subject_row ->> 'name') as name_key,
      'k12'::text as workbook,
      p_k12.source_id as source_id,
      1 as workbook_order,
      subject_ordinality,
      internal.teacher_import_clean_text(subject_row ->> 'name') as row_name
    from jsonb_array_elements(p_k12.subject_rows) with ordinality
      as subject_rows(subject_row, subject_ordinality)
    where subject_row ->> 'sheetName' = any(array[
      'Local English','ABC华裔English','Maths&Science','VCE数学科学','VCE其他',
      '奖学金','AEAS','青少英语','QCE','HSC','WACE','SACE','AMC数学竞赛',
      '科学竞赛','雅思PTE','IB'
    ])

    union all

    select
      internal.teacher_import_name_key(subject_row ->> 'name'),
      'university',
      p_university.source_id,
      2,
      subject_ordinality,
      internal.teacher_import_clean_text(subject_row ->> 'name')
    from jsonb_array_elements(p_university.subject_rows) with ordinality
      as subject_rows(subject_row, subject_ordinality)
    where subject_row ->> 'sheetName' = any(array[
      'Engineering','商科','IT','理科','文科（含论文辅导）','教育学','其他科目'
    ])
  ), subject_names as materialized (
    select
      raw_subject_names.name_key,
      raw_subject_names.workbook,
      raw_subject_names.source_id,
      raw_subject_names.workbook_order,
      min(raw_subject_names.subject_ordinality) as ref_order,
      (pg_catalog.array_agg(
        raw_subject_names.row_name order by raw_subject_names.subject_ordinality
      ))[1] as row_name
    from raw_subject_names
    where raw_subject_names.name_key <> ''
    group by
      raw_subject_names.name_key,
      raw_subject_names.workbook,
      raw_subject_names.source_id,
      raw_subject_names.workbook_order
  )
  select
    roster.name_key,
    roster.workbook,
    roster.source_id,
    roster.source_row,
    roster.ref_kind,
    roster.workbook_order,
    roster.ref_order,
    roster.row_name,
    roster.availability_text,
    roster.capacity_text,
    roster.location
  from roster

  union all

  select
    subject_name.name_key,
    subject_name.workbook,
    subject_name.source_id || '#subjects',
    to_jsonb(
      'name:' || encode(extensions.digest(
        pg_catalog.convert_to(subject_name.name_key, 'UTF8'), 'sha256'
      ), 'hex')
    ),
    'subject_name',
    subject_name.workbook_order,
    subject_name.ref_order,
    subject_name.row_name,
    null::text,
    null::text,
    null::text
  from subject_names subject_name
  where not exists (
    select 1
    from roster
    where roster.workbook = subject_name.workbook
      and roster.name_key = subject_name.name_key
  )
$$;

create or replace function internal.teacher_import_authoritative_subject_basis(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources
)
returns table (
  name_key text,
  sheet_name text,
  workbook_order integer,
  sheet_order bigint
)
language sql
stable
set search_path = ''
as $$
  with subject_membership as materialized (
    select
      internal.teacher_import_name_key(subject_row ->> 'name') as name_key,
      subject_row ->> 'sheetName' as sheet_name,
      1 as workbook_order,
      sheet_position as sheet_order
    from jsonb_array_elements(p_k12.subject_rows) as subject_rows(subject_row)
    join jsonb_array_elements_text(p_k12.sheet_names) with ordinality
      as sheets(sheet_name, sheet_position)
      on sheets.sheet_name = subject_row ->> 'sheetName'
     and sheet_position between 2 and 17

    union all

    select
      internal.teacher_import_name_key(subject_row ->> 'name'),
      subject_row ->> 'sheetName',
      2,
      sheet_position
    from jsonb_array_elements(p_university.subject_rows) as subject_rows(subject_row)
    join jsonb_array_elements_text(p_university.sheet_names) with ordinality
      as sheets(sheet_name, sheet_position)
      on sheets.sheet_name = subject_row ->> 'sheetName'
     and sheet_position between 2 and 8
  )
  select
    subject_membership.name_key,
    subject_membership.sheet_name,
    min(subject_membership.workbook_order)::integer as workbook_order,
    min(subject_membership.sheet_order)::bigint as sheet_order
  from subject_membership
  where subject_membership.name_key <> ''
  group by subject_membership.name_key, subject_membership.sheet_name
  order by
    workbook_order,
    sheet_order,
    subject_membership.sheet_name collate "C",
    subject_membership.name_key collate "C"
$$;

-- Subject detail follows source-row order, not tab display order. Keep the
-- first cleaned occurrence for each exact name/detail across k12 then
-- university so duplicate roster rows or repeated subject rows cannot repeat
-- the rendered detail.
create or replace function internal.teacher_import_authoritative_detail_basis(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources
)
returns table (
  name_key text,
  detail text,
  workbook_order integer,
  detail_order bigint
)
language sql
stable
set search_path = ''
as $$
  with raw_details as materialized (
    select
      internal.teacher_import_name_key(subject_row ->> 'name') as name_key,
      internal.teacher_import_clean_text(subject_row ->> 'subjectDetail') as detail,
      1 as workbook_order,
      subject_ordinality as detail_order
    from jsonb_array_elements(p_k12.subject_rows) with ordinality
      as subject_rows(subject_row, subject_ordinality)
    where subject_row ->> 'sheetName' = any(array[
      'Local English','ABC华裔English','Maths&Science','VCE数学科学','VCE其他',
      '奖学金','AEAS','青少英语','QCE','HSC','WACE','SACE','AMC数学竞赛',
      '科学竞赛','雅思PTE','IB'
    ])

    union all

    select
      internal.teacher_import_name_key(subject_row ->> 'name'),
      internal.teacher_import_clean_text(subject_row ->> 'subjectDetail'),
      2,
      subject_ordinality
    from jsonb_array_elements(p_university.subject_rows) with ordinality
      as subject_rows(subject_row, subject_ordinality)
    where subject_row ->> 'sheetName' = any(array[
      'Engineering','商科','IT','理科','文科（含论文辅导）','教育学','其他科目'
    ])
  ), ranked_details as materialized (
    select
      raw_details.*,
      row_number() over (
        partition by
          pg_catalog.convert_to(raw_details.name_key, 'UTF8'),
          pg_catalog.convert_to(raw_details.detail, 'UTF8')
        order by raw_details.workbook_order, raw_details.detail_order
      ) as occurrence_rank
    from raw_details
    where raw_details.name_key <> ''
      and raw_details.detail is not null
  )
  select
    ranked_details.name_key,
    ranked_details.detail,
    ranked_details.workbook_order,
    ranked_details.detail_order
  from ranked_details
  where ranked_details.occurrence_rank = 1
  order by
    ranked_details.workbook_order,
    ranked_details.detail_order,
    ranked_details.name_key collate "C",
    ranked_details.detail collate "C"
$$;

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
    left join lateral (
      select existing_teacher
      from jsonb_array_elements(p_existing_teachers) existing_teacher
      where internal.teacher_import_name_key(existing_teacher ->> 'name') = authority.name_key
      order by pg_catalog.convert_to(existing_teacher ->> 'id', 'UTF8')
      limit 1
    ) existing on true
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
      existing_teacher,
      case when jsonb_typeof(existing_teacher -> 'location') = 'string'
        then internal.teacher_import_clean_text(existing_teacher ->> 'location') end
        as expected_location,
      case when jsonb_typeof(existing_teacher -> 'availabilitySourceText') = 'string'
        then internal.teacher_import_clean_text(existing_teacher ->> 'availabilitySourceText') end
        as availability_source_text,
      case when jsonb_typeof(existing_teacher -> 'capacitySourceText') = 'string'
        then internal.teacher_import_clean_text(existing_teacher ->> 'capacitySourceText') end
        as capacity_source_text
    from jsonb_array_elements(p_existing_teachers) existing_teacher
    where not exists (
      select 1
      from active_expected
      where active_expected.teacher_id = existing_teacher ->> 'id'
    )
  ), historical_expected as materialized (
    select
      historical_values.existing_teacher ->> 'id' as teacher_id,
      internal.teacher_import_name_key(historical_values.existing_teacher ->> 'name') as name_key,
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
    select 1
    from internal.teacher_import_expected_operational_fragments(
      p_k12, p_university, p_existing_teachers
    ) expected
    left join lateral jsonb_array_elements(p_teachers) teacher
      on teacher ->> 'id' = expected.teacher_id
    where coalesce((
      select jsonb_object_agg(field.key, field.value)
      from jsonb_each(teacher) field
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
    select 1
    from (
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
    ) expected
    join jsonb_array_elements(p_teachers) teacher on exists (
      select 1
      from jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
      join jsonb_array_elements(authoritative_refs) basis
        on teacher_ref ->> 'workbook' = basis ->> 'workbook'
       and teacher_ref ->> 'sourceId' = basis ->> 'sourceId'
       and trim(teacher_ref ->> 'sourceRow') = trim(basis ->> 'sourceRow')
      where basis ->> 'nameKey' = expected.name_key
    )
    where teacher -> 'subjects' is distinct from expected.expected_subjects
       or teacher -> 'sourceCategories' is distinct from expected.expected_subjects
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_authoritative_subject_mismatch';
  end if;

  -- Departments come from every current authority workbook, including roster-
  -- only teachers. Subject detail is the cleaned first-seen subject-row union;
  -- absence is represented by an absent key, never JSON null.
  if exists (
    select 1
    from (
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
    ) expected
    join jsonb_array_elements(p_teachers) teacher on exists (
      select 1
      from jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
      join jsonb_array_elements(authoritative_refs) basis
        on teacher_ref ->> 'workbook' = basis ->> 'workbook'
       and teacher_ref ->> 'sourceId' = basis ->> 'sourceId'
       and trim(teacher_ref ->> 'sourceRow') = trim(basis ->> 'sourceRow')
      where basis ->> 'nameKey' = expected.name_key
    )
    where teacher -> 'departments' is distinct from expected.expected_departments
       or (expected.expected_detail is null and teacher ? 'subjectDetail')
       or (expected.expected_detail is not null and
           pg_catalog.convert_to(teacher ->> 'subjectDetail', 'UTF8') is distinct from
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

-- Executable authority fixture: width punctuation merges globally, subject-
-- only names receive one deterministic ref per workbook, subject membership
-- is an ordered union, unrelated refs survive, and absent teachers are kept
-- without stale teaching authority.
do $$
declare
  k12_fixture internal.teacher_import_sources%rowtype;
  university_fixture internal.teacher_import_sources%rowtype;
  existing_fixture jsonb;
  plan_fixture jsonb;
  reference_count integer;
  name_count integer;
  membership_count integer;
  detail_count integer;
  tamper_field text;
  tamper_index integer;
  tamper_value jsonb;
  expected_fragment jsonb;
  non_string_existing jsonb;
  non_string_plan jsonb;
begin
  k12_fixture.source_id := 'fixture-k12';
  k12_fixture.sheet_names := '["在职总表","Local English","ABC华裔English","Maths&Science","VCE数学科学","VCE其他","奖学金","AEAS","青少英语","QCE","HSC","WACE","SACE","AMC数学竞赛","科学竞赛","雅思PTE","IB","已离职教师"]'::jsonb;
  k12_fixture.roster_rows := jsonb_build_array(
    jsonb_build_object(
      'sourceRow', 'ä', 'name', 'Shared，Teacher',
      'availabilityText', ' Second　AVA ', 'capacityText', 'Duplicate Capacity',
      'attributes', jsonb_build_object('location', ' QLD ')
    ),
    jsonb_build_object(
      'sourceRow', 2, 'name', 'Roster Only',
      'availabilityText', ' Roster　AVA ', 'capacityText', ' Roster Capacity ',
      'attributes', jsonb_build_object('location', ' Sydney ')
    ),
    jsonb_build_object(
      'sourceRow', chr(160) || 'z' || chr(160), 'name', 'Shared,Teacher',
      'availabilityText', ' First AVA ', 'capacityText', ' Duplicate Capacity ',
      'attributes', jsonb_build_object('location', ' NSW ')
    )
  );
  k12_fixture.subject_rows := jsonb_build_array(
    jsonb_build_object(
      'sourceRow', 10, 'name', 'Shared,Teacher', 'sheetName', 'IB',
      'subjectDetail', ' Ｋ12　Focus '
    ),
    jsonb_build_object(
      'sourceRow', 11, 'name', 'Subject Only', 'sheetName', 'IB',
      'subjectDetail', ' Essay' || chr(160) || '  Detail '
    ),
    jsonb_build_object(
      'sourceRow', 12, 'name', 'Subject Only', 'sheetName', 'Local English',
      'subjectDetail', ' Local' || chr(8203) || ' Detail '
    ),
    jsonb_build_object(
      'sourceRow', 13, 'name', 'Subject Only', 'sheetName', 'Local English',
      'subjectDetail', 'Ｅｓｓａｙ Detail'
    )
  );

  university_fixture.source_id := 'fixture-university';
  university_fixture.sheet_names := '["大学老师在职总表","Engineering","商科","IT","理科","文科（含论文辅导）","教育学","其他科目"]'::jsonb;
  university_fixture.roster_rows := jsonb_build_array(
    jsonb_build_object(
      'sourceRow', 3, 'name', 'Shared,Teacher',
      'availabilityText', 'Second AVA', 'capacityText', ' University　Capacity ',
      'attributes', jsonb_build_object('location', ' WA ')
    )
  );
  university_fixture.subject_rows := jsonb_build_array(
    jsonb_build_object(
      'sourceRow', 20, 'name', 'Shared,Teacher', 'sheetName', 'Engineering',
      'subjectDetail', E' Uni\tDetail '
    ),
    jsonb_build_object(
      'sourceRow', 21, 'name', 'Subject Only', 'sheetName', 'Engineering',
      'subjectDetail', 'Essay Detail'
    ),
    jsonb_build_object(
      'sourceRow', 22, 'name', 'Subject Only', 'sheetName', 'Engineering',
      'subjectDetail', ' Research' || chr(8203) || ' Skills '
    )
  );

  select count(*), count(distinct basis.name_key)
  into reference_count, name_count
  from internal.teacher_import_authoritative_ref_basis(k12_fixture, university_fixture) basis;
  select count(*) into membership_count
  from internal.teacher_import_authoritative_subject_basis(k12_fixture, university_fixture);
  select count(*) into detail_count
  from internal.teacher_import_authoritative_detail_basis(k12_fixture, university_fixture);
  if reference_count <> 6 or name_count <> 3 or membership_count <> 5 or detail_count <> 5
     or (
       select string_agg(basis.detail, '；' order by basis.workbook_order, basis.detail_order)
       from internal.teacher_import_authoritative_detail_basis(k12_fixture, university_fixture) basis
       where basis.name_key = internal.teacher_import_name_key('Shared,Teacher')
     ) <> 'K12 Focus；Uni Detail'
     or (
       select string_agg(basis.detail, '；' order by basis.workbook_order, basis.detail_order)
       from internal.teacher_import_authoritative_detail_basis(k12_fixture, university_fixture) basis
       where basis.name_key = internal.teacher_import_name_key('Subject Only')
     ) <> 'Essay Detail；Local Detail；Research Skills'
     or not exists (
       select 1
       from internal.teacher_import_authoritative_ref_basis(k12_fixture, university_fixture) basis
       where basis.source_id = 'fixture-k12#subjects'
         and basis.source_row = to_jsonb(
           'name:831126c3f6b9995b27b548aa86b83cd9b5b64f871a01e75c655f2e213a35eb2a'::text
         )
     ) then
    raise exception using errcode = '22023', message = 'teacher_authority_basis_fixture_mismatch';
  end if;
  if internal.teacher_import_js_trim(chr(160) || ' reviewed ' || chr(65279)) <> 'reviewed'
     or internal.teacher_import_initials('élodie-smith') <> 'éS'
     or internal.teacher_import_initials('ｒｏｓｔｅｒ　only') <> 'RO'
     or internal.teacher_import_timezone_for_location('Argentina') is not null
     or internal.teacher_import_timezone_for_location('ACT / Canberra') <> 'Australia/Sydney'
     or internal.teacher_import_timezone_for_location('中国广州') <> 'Asia/Shanghai' then
    raise exception using errcode = '22023',
      message = 'teacher_operational_primitive_fixture_mismatch';
  end if;

  existing_fixture := jsonb_build_array(
    jsonb_build_object(
      'id', 'TEA-SHARED', 'name', 'Shared,Teacher',
      'initials', ' ＳＴ ',
      'availability', '　Reviewed ＡＶＡ　',
      'availabilityStatus', '可接新生',
      'timezone', ' Australia/Melbourne ',
      'load', 1.5, 'capacity', 3, 'acceptsStudents', true,
      'note', ' Reviewed　note ', 'location', ' ＶＩＣ ',
      'availabilitySourceText', 'stale availability',
      'capacitySourceText', 'stale capacity',
      'payrollHistory', jsonb_build_array(jsonb_build_object('period', 'legacy-payroll')),
      'availabilityWindows', jsonb_build_array(jsonb_build_object('month', '2026-07')),
      'capacityAssignments', jsonb_build_object('legacy', 2),
      'teacherSourceRefs', jsonb_build_array(
        jsonb_build_object('workbook', 'k12', 'sourceId', 'legacy-source', 'sourceRow', 'L1')
      )
    ),
    jsonb_build_object(
      'id', 'TEA-HISTORICAL', 'name', ' Historical　Teacher ',
      'initials', ' ｈｔ ',
      'availability', ' Historical　AVA ',
      'availabilityStatus', '可接新生',
      'timezone', ' ',
      'load', 2, 'capacity', -1, 'acceptsStudents', true,
      'note', ' Historical　note ', 'location', ' Brisbane ',
      'availabilitySourceText', ' Old　AVA ',
      'capacitySourceText', ' Old　Capacity ',
      'payrollHistory', jsonb_build_array(jsonb_build_object('period', 'historical-payroll')),
      'departments', jsonb_build_array('中小学'),
      'teacherSourceRefs', jsonb_build_array(
        jsonb_build_object('workbook', 'k12', 'sourceId', 'fixture-k12', 'sourceRow', 2),
        jsonb_build_object('workbook', 'university', 'sourceId', 'legacy-source', 'sourceRow', 'H1')
      )
    )
  );
  plan_fixture := jsonb_build_array(
    jsonb_build_object(
      'id', 'TEA-SHARED', 'name', 'Shared,Teacher',
      'initials', 'ST',
      'availability', '　Reviewed ＡＶＡ　',
      'availabilityStatus', '可接新生',
      'timezone', 'Australia/Melbourne',
      'load', 1.5, 'capacity', 3,
      'note', 'Reviewed note', 'location', 'VIC',
      'availabilitySourceText', 'First AVA；Second AVA',
      'capacitySourceText', 'Duplicate Capacity；University Capacity',
      'payrollHistory', jsonb_build_array(jsonb_build_object('period', 'legacy-payroll')),
      'availabilityWindows', jsonb_build_array(jsonb_build_object('month', '2026-07')),
      'capacityAssignments', jsonb_build_object('legacy', 2),
      'subjects', jsonb_build_array('IB', 'Engineering'),
      'subjectDetail', 'K12 Focus；Uni Detail',
      'departments', jsonb_build_array('中小学', '大学'),
      'sourceCategories', jsonb_build_array('IB', 'Engineering'),
      'acceptsStudents', true,
      'teacherSourceRefs', jsonb_build_array(
        jsonb_build_object(
          'workbook', 'k12', 'sourceId', 'fixture-k12',
          'sourceRow', chr(160) || 'z' || chr(160)
        ),
        jsonb_build_object('workbook', 'k12', 'sourceId', 'fixture-k12', 'sourceRow', 'ä'),
        jsonb_build_object('workbook', 'k12', 'sourceId', 'legacy-source', 'sourceRow', 'L1'),
        jsonb_build_object('workbook', 'university', 'sourceId', 'fixture-university', 'sourceRow', 3)
      )
    ),
    jsonb_build_object(
      'id', internal.teacher_import_authoritative_id('Roster Only'), 'name', 'Roster Only',
      'initials', 'RO', 'availability', '待老师按月提交',
      'availabilityStatus', '待确认', 'timezone', 'Australia/Sydney',
      'load', 0, 'capacity', 0,
      'note', '待教务审核教师资料与月度 AVA', 'location', 'Sydney',
      'availabilitySourceText', 'Roster AVA',
      'capacitySourceText', 'Roster Capacity',
      'subjects', '[]'::jsonb, 'departments', jsonb_build_array('中小学'),
      'sourceCategories', '[]'::jsonb,
      'acceptsStudents', false,
      'teacherSourceRefs', jsonb_build_array(
        jsonb_build_object('workbook', 'k12', 'sourceId', 'fixture-k12', 'sourceRow', 2)
      )
    ),
    jsonb_build_object(
      'id', internal.teacher_import_authoritative_id('Subject Only'), 'name', 'Subject Only',
      'initials', 'SO', 'availability', '待老师按月提交',
      'availabilityStatus', '待确认', 'timezone', 'Australia/Melbourne',
      'load', 0, 'capacity', 0,
      'note', '待教务审核教师资料与月度 AVA',
      'subjects', jsonb_build_array('Local English', 'IB', 'Engineering'),
      'subjectDetail', 'Essay Detail；Local Detail；Research Skills',
      'departments', jsonb_build_array('中小学', '大学'),
      'sourceCategories', jsonb_build_array('Local English', 'IB', 'Engineering'),
      'acceptsStudents', false,
      'teacherSourceRefs', jsonb_build_array(
        jsonb_build_object(
          'workbook', 'k12', 'sourceId', 'fixture-k12#subjects',
          'sourceRow', 'name:831126c3f6b9995b27b548aa86b83cd9b5b64f871a01e75c655f2e213a35eb2a'
        ),
        jsonb_build_object(
          'workbook', 'university', 'sourceId', 'fixture-university#subjects',
          'sourceRow', 'name:831126c3f6b9995b27b548aa86b83cd9b5b64f871a01e75c655f2e213a35eb2a'
        )
      )
    ),
    jsonb_build_object(
      'id', 'TEA-HISTORICAL', 'name', 'Historical Teacher',
      'initials', 'ht', 'availability', 'Historical AVA',
      'timezone', 'Australia/Brisbane', 'load', 2, 'capacity', 0,
      'note', 'Historical note', 'location', 'Brisbane',
      'availabilitySourceText', 'Old AVA',
      'capacitySourceText', 'Old Capacity',
      'payrollHistory', jsonb_build_array(jsonb_build_object('period', 'historical-payroll')),
      'subjects', '[]'::jsonb, 'departments', '[]'::jsonb,
      'sourceCategories', '[]'::jsonb, 'availabilityStatus', '暂停接新',
      'acceptsStudents', false,
      'teacherSourceRefs', jsonb_build_array(
        jsonb_build_object('workbook', 'university', 'sourceId', 'legacy-source', 'sourceRow', 'H1')
      )
    )
  );

  if existing_fixture #>> '{1,teacherSourceRefs,0,sourceRow}' <> '2'
     or plan_fixture #>> '{1,teacherSourceRefs,0,sourceRow}' <> '2'
     or plan_fixture #>> '{1,id}' <>
        internal.teacher_import_authoritative_id('Roster Only') then
    raise exception using errcode = '22023', message = 'teacher_direct_row_reuse_fixture_mismatch';
  end if;

  select expected.expected_operational
  into expected_fragment
  from internal.teacher_import_expected_operational_fragments(
    k12_fixture, university_fixture, existing_fixture
  ) expected
  where expected.teacher_id = 'TEA-SHARED';
  if expected_fragment ->> 'availabilitySourceText' <> 'First AVA；Second AVA'
     or expected_fragment ->> 'capacitySourceText' <>
        'Duplicate Capacity；University Capacity'
     or expected_fragment ->> 'availability' <> '　Reviewed ＡＶＡ　'
     or expected_fragment ->> 'location' <> 'VIC' then
    raise exception using errcode = '22023',
      message = 'teacher_operational_projection_fixture_mismatch';
  end if;

  perform internal.assert_teacher_import_authoritative_plan(
    k12_fixture, university_fixture, existing_fixture, plan_fixture
  );

  -- Non-string historical optional values are removed, never stringified.
  non_string_existing := jsonb_set(existing_fixture, '{1,location}', '42'::jsonb);
  non_string_plan := jsonb_set(
    plan_fixture, '{3,timezone}', to_jsonb('Australia/Melbourne'::text)
  );
  non_string_plan := jsonb_set(
    non_string_plan, '{3}', (non_string_plan -> 3) - 'location'
  );
  perform internal.assert_teacher_import_authoritative_plan(
    k12_fixture, university_fixture, non_string_existing, non_string_plan
  );

  begin
    perform internal.assert_teacher_import_authoritative_plan(
      k12_fixture,
      university_fixture,
      existing_fixture,
      jsonb_set(plan_fixture, '{0,departments}', jsonb_build_array('中小学'))
    );
    raise exception using errcode = 'P0001',
      message = 'teacher_authoritative_departments_rejection_fixture_did_not_fail';
  exception
    when foreign_key_violation then
      if sqlerrm <> 'teacher_import_authoritative_metadata_mismatch' then raise; end if;
  end;

  begin
    perform internal.assert_teacher_import_authoritative_plan(
      k12_fixture,
      university_fixture,
      existing_fixture,
      jsonb_set(plan_fixture, '{0,subjectDetail}', to_jsonb('stale detail'::text))
    );
    raise exception using errcode = 'P0001',
      message = 'teacher_authoritative_stale_detail_rejection_fixture_did_not_fail';
  exception
    when foreign_key_violation then
      if sqlerrm <> 'teacher_import_authoritative_metadata_mismatch' then raise; end if;
  end;

  begin
    perform internal.assert_teacher_import_authoritative_plan(
      k12_fixture,
      university_fixture,
      existing_fixture,
      jsonb_set(plan_fixture, '{1,subjectDetail}', to_jsonb('fabricated detail'::text))
    );
    raise exception using errcode = 'P0001',
      message = 'teacher_authoritative_fabricated_detail_rejection_fixture_did_not_fail';
  exception
    when foreign_key_violation then
      if sqlerrm <> 'teacher_import_authoritative_metadata_mismatch' then raise; end if;
  end;

  begin
    perform internal.assert_teacher_import_authoritative_plan(
      k12_fixture,
      university_fixture,
      existing_fixture,
      jsonb_set(plan_fixture, '{2}', (plan_fixture -> 2) - 'subjectDetail')
    );
    raise exception using errcode = 'P0001',
      message = 'teacher_authoritative_missing_detail_rejection_fixture_did_not_fail';
  exception
    when foreign_key_violation then
      if sqlerrm <> 'teacher_import_authoritative_metadata_mismatch' then raise; end if;
  end;

  begin
    perform internal.assert_teacher_import_authoritative_plan(
      k12_fixture,
      university_fixture,
      existing_fixture,
      jsonb_set(plan_fixture, '{3,departments}', jsonb_build_array('中小学'))
    );
    raise exception using errcode = '22023', message = 'teacher_historical_departments_rejection_fixture_did_not_fail';
  exception
    when foreign_key_violation then
      if sqlerrm <> 'teacher_import_historical_authority_not_cleared' then
        raise;
      end if;
  end;

  begin
    perform internal.assert_teacher_import_authoritative_plan(
      k12_fixture,
      university_fixture,
      existing_fixture,
      jsonb_set(plan_fixture, '{3,availabilityStatus}', to_jsonb('待确认'::text))
    );
    raise exception using errcode = '22023', message = 'teacher_historical_status_rejection_fixture_did_not_fail';
  exception
    when foreign_key_violation then
      if sqlerrm <> 'teacher_import_operational_projection_mismatch' then
        raise;
      end if;
  end;

  -- Normalized identity equality is not permission to choose display bytes:
  -- a multi-row active name preserves the exact existing display name.
  begin
    perform internal.assert_teacher_import_authoritative_plan(
      k12_fixture,
      university_fixture,
      existing_fixture,
      jsonb_set(plan_fixture, '{0,name}', to_jsonb('Shared，Teacher'::text))
    );
    raise exception using errcode = '22023',
      message = 'teacher_operational_display_name_rejection_fixture_did_not_fail';
  exception
    when foreign_key_violation then
      if sqlerrm <> 'teacher_import_operational_projection_mismatch' then raise; end if;
  end;

  for tamper_field in
    select unnest(array['payrollHistory','availabilityWindows','capacityAssignments']::text[])
  loop
    begin
      perform internal.assert_teacher_import_authoritative_plan(
        k12_fixture,
        university_fixture,
        existing_fixture,
        jsonb_set(
          plan_fixture,
          array['0', tamper_field],
          jsonb_build_object('tampered', true)
        )
      );
      raise exception using errcode = '22023', message = 'teacher_unmanaged_field_rejection_fixture_did_not_fail';
    exception
      when foreign_key_violation then
        if sqlerrm <> 'teacher_import_existing_unmanaged_fields_changed' then
          raise;
        end if;
    end;

    begin
      perform internal.assert_teacher_import_authoritative_plan(
        k12_fixture,
        university_fixture,
        existing_fixture,
        jsonb_set(
          plan_fixture,
          array['1', tamper_field],
          jsonb_build_object('fabricated', true)
        )
      );
      raise exception using errcode = '22023', message = 'teacher_new_unmanaged_field_rejection_fixture_did_not_fail';
    exception
      when foreign_key_violation then
        if sqlerrm <> 'teacher_import_new_teacher_unmanaged_fields' then
          raise;
        end if;
    end;
  end loop;

  -- Every operational field is independently server-owned for both active
  -- and historical records. Keep each mutation wire-valid so only the exact
  -- projection assertion can reject it.
  for tamper_index in select unnest(array[0, 2, 3]::integer[])
  loop
    for tamper_field in select unnest(array[
      'name','initials','availability','availabilityStatus','timezone',
      'load','capacity','acceptsStudents','note','location',
      'availabilitySourceText','capacitySourceText'
    ]::text[])
    loop
      tamper_value := case tamper_field
        when 'name' then to_jsonb(case tamper_index
          when 0 then 'Shared，Teacher'
          when 2 then 'Subject　Only'
          else 'Historical　Teacher' end::text)
        when 'initials' then to_jsonb('XX'::text)
        when 'availability' then to_jsonb('tampered availability'::text)
        when 'availabilityStatus' then to_jsonb(case when tamper_index = 0
          then '待确认' else '可接新生' end::text)
        when 'timezone' then to_jsonb('Australia/Perth'::text)
        when 'load' then '99'::jsonb
        when 'capacity' then '99'::jsonb
        when 'acceptsStudents' then case when tamper_index = 0
          then 'false'::jsonb else 'true'::jsonb end
        when 'note' then to_jsonb('tampered note'::text)
        when 'location' then to_jsonb('Perth'::text)
        when 'availabilitySourceText' then to_jsonb('tampered source AVA'::text)
        else to_jsonb('tampered source capacity'::text)
      end;
      begin
        perform internal.assert_teacher_import_authoritative_plan(
          k12_fixture,
          university_fixture,
          existing_fixture,
          jsonb_set(
            plan_fixture,
            array[tamper_index::text, tamper_field],
            tamper_value
          )
        );
        raise exception using errcode = '22023',
          message = 'teacher_operational_field_rejection_fixture_did_not_fail';
      exception
        when foreign_key_violation then
          if sqlerrm <> 'teacher_import_operational_projection_mismatch' then raise; end if;
      end;
    end loop;
  end loop;

  for tamper_field in select unnest(array[
    'location','availabilitySourceText','capacitySourceText'
  ]::text[])
  loop
    begin
      perform internal.assert_teacher_import_authoritative_plan(
        k12_fixture,
        university_fixture,
        existing_fixture,
        jsonb_set(plan_fixture, '{0}', (plan_fixture -> 0) - tamper_field)
      );
      raise exception using errcode = '22023',
        message = 'teacher_operational_optional_removal_fixture_did_not_fail';
    exception
      when foreign_key_violation then
        if sqlerrm <> 'teacher_import_operational_projection_mismatch' then raise; end if;
    end;

    begin
      perform internal.assert_teacher_import_authoritative_plan(
        k12_fixture,
        university_fixture,
        existing_fixture,
        jsonb_set(
          plan_fixture,
          array['2', tamper_field],
          to_jsonb('fabricated optional'::text)
        )
      );
      raise exception using errcode = '22023',
        message = 'teacher_operational_optional_fabrication_fixture_did_not_fail';
    exception
      when foreign_key_violation then
        if sqlerrm <> 'teacher_import_operational_projection_mismatch' then raise; end if;
    end;
  end loop;

  begin
    perform internal.assert_teacher_import_authoritative_plan(
      k12_fixture,
      university_fixture,
      existing_fixture,
      jsonb_set(plan_fixture, '{1,id}', to_jsonb('TEA-WRONG'::text))
    );
    raise exception using errcode = '22023', message = 'teacher_authoritative_id_rejection_fixture_did_not_fail';
  exception
    when foreign_key_violation then
      if sqlerrm <> 'teacher_import_authoritative_id_mismatch' then
        raise;
      end if;
  end;

  -- The row itself may move to the new name-hash ID, but the former owner's
  -- durable historical ID cannot be renamed and repurposed with it.
  begin
    perform internal.assert_teacher_import_authoritative_plan(
      k12_fixture,
      university_fixture,
      existing_fixture,
      jsonb_set(
        jsonb_set(
          plan_fixture - 1,
          '{2,name}',
          to_jsonb('Roster Only'::text)
        ),
        '{2,teacherSourceRefs}',
        jsonb_build_array(
          jsonb_build_object('workbook', 'university', 'sourceId', 'legacy-source', 'sourceRow', 'H1'),
          jsonb_build_object('workbook', 'k12', 'sourceId', 'fixture-k12', 'sourceRow', 2)
        )
      )
    );
    raise exception using errcode = '22023', message = 'teacher_id_reuse_rejection_fixture_did_not_fail';
  exception
    when foreign_key_violation then
      if sqlerrm <> 'teacher_import_existing_id_name_changed' then
        raise;
      end if;
  end;

  begin
    perform internal.assert_teacher_import_authoritative_plan(
      k12_fixture,
      university_fixture,
      existing_fixture,
      jsonb_set(plan_fixture, '{0,subjects}', '[]'::jsonb)
    );
    raise exception using errcode = '22023', message = 'teacher_authority_rejection_fixture_did_not_fail';
  exception
    when foreign_key_violation then
      if sqlerrm <> 'teacher_import_authoritative_subject_mismatch' then
        raise;
      end if;
  end;
end;
$$;

-- Validate the complete ImportedTeacherRecord wire shape before any payload is
-- hashed or can reach the locked authority assertion. Missing keys and JSON
-- null are distinct from every mandatory type and therefore fail closed.
create or replace function internal.assert_teacher_import_plan_shape(p_teachers jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  teacher jsonb;
  teacher_ref jsonb;
  optional_field text;
begin
  if jsonb_typeof(p_teachers) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
  end if;
  if jsonb_array_length(p_teachers) < 1
     or jsonb_array_length(p_teachers) > 10000 then
    raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
  end if;

  for teacher in select value from jsonb_array_elements(p_teachers)
  loop
    if jsonb_typeof(teacher) is distinct from 'object'
       or jsonb_typeof(teacher -> 'id') is distinct from 'string'
       or internal.teacher_import_clean_text(teacher ->> 'id') is null
       or jsonb_typeof(teacher -> 'name') is distinct from 'string'
       or internal.teacher_import_name_key(teacher ->> 'name') = ''
       or jsonb_typeof(teacher -> 'initials') is distinct from 'string'
       or internal.teacher_import_clean_text(teacher ->> 'initials') is null
       or jsonb_typeof(teacher -> 'subjects') is distinct from 'array'
       or jsonb_typeof(teacher -> 'departments') is distinct from 'array'
       or jsonb_typeof(teacher -> 'sourceCategories') is distinct from 'array'
       or jsonb_typeof(teacher -> 'teacherSourceRefs') is distinct from 'array'
       or jsonb_typeof(teacher -> 'availability') is distinct from 'string'
       or internal.teacher_import_clean_text(teacher ->> 'availability') is null
       or jsonb_typeof(teacher -> 'availabilityStatus') is distinct from 'string'
       or not coalesce(
         teacher ->> 'availabilityStatus' in ('可接新生', '暂停接新', '待确认'),
         false
       )
       or jsonb_typeof(teacher -> 'timezone') is distinct from 'string'
       or internal.teacher_import_clean_text(teacher ->> 'timezone') is null
       or jsonb_typeof(teacher -> 'load') is distinct from 'number'
       or jsonb_typeof(teacher -> 'capacity') is distinct from 'number'
       or jsonb_typeof(teacher -> 'acceptsStudents') is distinct from 'boolean'
       or jsonb_typeof(teacher -> 'note') is distinct from 'string'
       or internal.teacher_import_clean_text(teacher ->> 'note') is null then
      raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
    end if;

    if (teacher ->> 'load')::numeric < 0
       or (teacher ->> 'capacity')::numeric < 0 then
      raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
    end if;

    foreach optional_field in array array[
      'subjectDetail', 'location', 'availabilitySourceText', 'capacitySourceText'
    ]::text[]
    loop
      if teacher ? optional_field and (
        jsonb_typeof(teacher -> optional_field) is distinct from 'string'
        or internal.teacher_import_clean_text(teacher ->> optional_field) is null
      ) then
        raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
      end if;
    end loop;

    if exists (
      select 1
      from jsonb_array_elements(teacher -> 'subjects') subject
      where jsonb_typeof(subject) is distinct from 'string'
         or internal.teacher_import_clean_text(subject #>> '{}') is null
    ) or exists (
      select 1
      from jsonb_array_elements(teacher -> 'sourceCategories') category
      where jsonb_typeof(category) is distinct from 'string'
         or internal.teacher_import_clean_text(category #>> '{}') is null
    ) or exists (
      select 1
      from jsonb_array_elements(teacher -> 'departments') department
      where jsonb_typeof(department) is distinct from 'string'
         or not coalesce(department #>> '{}' in ('中小学', '大学'), false)
    ) or jsonb_array_length(teacher -> 'departments') <> (
      select count(distinct department #>> '{}')
      from jsonb_array_elements(teacher -> 'departments') department
    ) then
      raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
    end if;

    for teacher_ref in select value from jsonb_array_elements(teacher -> 'teacherSourceRefs')
    loop
      if jsonb_typeof(teacher_ref) is distinct from 'object' then
        raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
      end if;
      if jsonb_typeof(teacher_ref -> 'workbook') is distinct from 'string'
         or not coalesce(teacher_ref ->> 'workbook' in ('k12', 'university'), false)
         or jsonb_typeof(teacher_ref -> 'sourceId') is distinct from 'string'
         or internal.teacher_import_clean_text(teacher_ref ->> 'sourceId') is null
         or (
           jsonb_typeof(teacher_ref -> 'sourceRow') is distinct from 'string'
           and jsonb_typeof(teacher_ref -> 'sourceRow') is distinct from 'number'
         )
         or internal.teacher_import_clean_text(teacher_ref ->> 'sourceRow') is null
         or teacher_ref - 'workbook' - 'sourceId' - 'sourceRow' is distinct from '{}'::jsonb then
        raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
      end if;
    end loop;
  end loop;

  if (select count(*) from jsonb_array_elements(p_teachers)) <>
       (select count(distinct teacher ->> 'id') from jsonb_array_elements(p_teachers) teacher)
     or (
       select count(*)
       from jsonb_array_elements(p_teachers) teacher
       cross join lateral jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
     ) <> (
       select count(distinct jsonb_build_array(
         teacher_ref ->> 'workbook',
         teacher_ref ->> 'sourceId',
         trim(teacher_ref ->> 'sourceRow')
       ))
       from jsonb_array_elements(p_teachers) teacher
       cross join lateral jsonb_array_elements(teacher -> 'teacherSourceRefs') teacher_ref
     ) then
    raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
  end if;
end;
$$;

-- Executable shape fixture proves every mandatory key rejects both omission
-- and JSON null, optional imported text rejects null/blank, and department
-- values are a unique closed enum.
do $$
declare
  valid_teacher jsonb;
  mandatory_field text;
  optional_field text;
begin
  valid_teacher := jsonb_build_object(
    'id', 'TEA-SHAPE',
    'name', 'Shape Teacher',
    'initials', 'ST',
    'subjects', '[]'::jsonb,
    'departments', '[]'::jsonb,
    'sourceCategories', '[]'::jsonb,
    'teacherSourceRefs', '[]'::jsonb,
    'availability', '待老师按月提交',
    'availabilityStatus', '待确认',
    'timezone', 'Australia/Melbourne',
    'load', 0,
    'capacity', 0,
    'acceptsStudents', false,
    'note', '待教务审核教师资料与月度 AVA'
  );
  perform internal.assert_teacher_import_plan_shape(jsonb_build_array(valid_teacher));

  foreach mandatory_field in array array[
    'id','name','initials','subjects','departments','sourceCategories',
    'teacherSourceRefs','availability','availabilityStatus','timezone','load',
    'capacity','acceptsStudents','note'
  ]::text[]
  loop
    begin
      perform internal.assert_teacher_import_plan_shape(
        jsonb_build_array(valid_teacher - mandatory_field)
      );
      raise exception using errcode = 'P0001',
        message = 'teacher_shape_missing_field_fixture_did_not_fail';
    exception
      when invalid_parameter_value then
        if sqlerrm <> 'invalid_teacher_import_commit' then raise; end if;
    end;

    begin
      perform internal.assert_teacher_import_plan_shape(jsonb_build_array(
        jsonb_set(valid_teacher, array[mandatory_field], 'null'::jsonb)
      ));
      raise exception using errcode = 'P0001',
        message = 'teacher_shape_null_field_fixture_did_not_fail';
    exception
      when invalid_parameter_value then
        if sqlerrm <> 'invalid_teacher_import_commit' then raise; end if;
    end;
  end loop;

  foreach optional_field in array array[
    'subjectDetail','location','availabilitySourceText','capacitySourceText'
  ]::text[]
  loop
    begin
      perform internal.assert_teacher_import_plan_shape(jsonb_build_array(
        jsonb_set(valid_teacher, array[optional_field], 'null'::jsonb)
      ));
      raise exception using errcode = 'P0001',
        message = 'teacher_shape_optional_null_fixture_did_not_fail';
    exception
      when invalid_parameter_value then
        if sqlerrm <> 'invalid_teacher_import_commit' then raise; end if;
    end;

    begin
      perform internal.assert_teacher_import_plan_shape(jsonb_build_array(
        jsonb_set(
          valid_teacher,
          array[optional_field],
          to_jsonb((' ' || chr(8203) || chr(12288))::text)
        )
      ));
      raise exception using errcode = 'P0001',
        message = 'teacher_shape_optional_blank_fixture_did_not_fail';
    exception
      when invalid_parameter_value then
        if sqlerrm <> 'invalid_teacher_import_commit' then raise; end if;
    end;
  end loop;

  begin
    perform internal.assert_teacher_import_plan_shape(jsonb_build_array(
      jsonb_set(valid_teacher, '{departments}', '["中小学","中小学"]'::jsonb)
    ));
    raise exception using errcode = 'P0001',
      message = 'teacher_shape_duplicate_department_fixture_did_not_fail';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'invalid_teacher_import_commit' then raise; end if;
  end;

  begin
    perform internal.assert_teacher_import_plan_shape(jsonb_build_array(
      jsonb_set(valid_teacher, '{departments}', '["其他"]'::jsonb)
    ));
    raise exception using errcode = 'P0001',
      message = 'teacher_shape_invalid_department_fixture_did_not_fail';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'invalid_teacher_import_commit' then raise; end if;
  end;
end;
$$;

revoke all on function internal.teacher_import_clean_text(text)
  from public, anon, authenticated;
revoke all on function internal.teacher_import_js_trim(text)
  from public, anon, authenticated;
revoke all on function internal.teacher_import_initials(text)
  from public, anon, authenticated;
revoke all on function internal.teacher_import_timezone_for_location(text)
  from public, anon, authenticated;
revoke all on function internal.teacher_import_name_key(text)
  from public, anon, authenticated;
revoke all on function internal.teacher_import_authoritative_id(text)
  from public, anon, authenticated;
revoke all on function internal.teacher_import_authoritative_ref_basis(
  internal.teacher_import_sources, internal.teacher_import_sources
) from public, anon, authenticated;
revoke all on function internal.teacher_import_authoritative_row_basis(
  internal.teacher_import_sources, internal.teacher_import_sources
) from public, anon, authenticated;
revoke all on function internal.teacher_import_authoritative_subject_basis(
  internal.teacher_import_sources, internal.teacher_import_sources
) from public, anon, authenticated;
revoke all on function internal.teacher_import_authoritative_detail_basis(
  internal.teacher_import_sources, internal.teacher_import_sources
) from public, anon, authenticated;
revoke all on function internal.teacher_import_expected_operational_fragments(
  internal.teacher_import_sources, internal.teacher_import_sources, jsonb
) from public, anon, authenticated;
revoke all on function internal.assert_teacher_import_authoritative_plan(
  internal.teacher_import_sources, internal.teacher_import_sources, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function internal.assert_teacher_import_plan_shape(jsonb)
  from public, anon, authenticated;

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
  authority_reference_count integer;
  authority_name_count integer;
  authority_subject_membership_count integer;
  replaying_prior boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_plan_fingerprint, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_expected_teacher_version is null or p_expected_teacher_version < 0
     or p_actor not in ('Nixon', 'Ops Admin')
     or jsonb_typeof(p_source_revisions) is distinct from 'object'
     or nullif(p_source_revisions ->> 'k12', '') is null
     or nullif(p_source_revisions ->> 'university', '') is null then
    raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
  end if;

  perform internal.assert_teacher_import_plan_shape(p_teachers);

  teachers_hash := encode(extensions.digest(p_teachers::text, 'sha256'), 'hex');
  select * into prior
  from internal.teacher_import_commits commit_row
  where commit_row.plan_fingerprint = p_plan_fingerprint
  for update;
  if found then
    if prior.k12_revision <> p_source_revisions ->> 'k12'
       or prior.university_revision <> p_source_revisions ->> 'university'
       or prior.teachers_sha256 <> teachers_hash then
      raise exception using errcode = '23505', message = 'teacher_import_fingerprint_conflict';
    end if;
    replaying_prior := true;
  end if;

  select * into k12
  from internal.teacher_import_sources source_row
  where source_row.workbook = 'k12'
  for update;
  select * into university
  from internal.teacher_import_sources source_row
  where source_row.workbook = 'university'
  for update;
  select * into current_state
  from public.ops_state state_row
  where state_row.entity = 'teachers'
  for update;

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

  -- This assertion is evaluated only after both source rows and the canonical
  -- teacher state are locked.  It derives the complete exact-name union from
  -- server-owned JSON and ignores all legacy decision tables.
  perform internal.assert_teacher_import_authoritative_plan(
    k12, university, current_state.payload, p_teachers
  );

  select count(*), count(distinct basis.name_key)
  into authority_reference_count, authority_name_count
  from internal.teacher_import_authoritative_ref_basis(k12, university) basis;
  select count(*)
  into authority_subject_membership_count
  from internal.teacher_import_authoritative_subject_basis(k12, university);

  if replaying_prior then
    return query select
      'teachers'::text,
      prior.teachers_version,
      prior.committed_at,
      prior.committed_by,
      false;
    return;
  end if;

  update public.ops_state state_row set
    payload = p_teachers,
    version = state_row.version + 1,
    updated_at = now(),
    updated_by = left(trim(p_actor), 80)
  where state_row.entity = 'teachers'
  returning state_row.* into current_state;

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
      'identityPolicy', 'exact_normalized_name',
      'authorityReferenceCount', authority_reference_count,
      'authorityNameCount', authority_name_count,
      'authoritySubjectMembershipCount', authority_subject_membership_count,
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

revoke all on function public.commit_teacher_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.commit_teacher_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)
  to anon, authenticated;
