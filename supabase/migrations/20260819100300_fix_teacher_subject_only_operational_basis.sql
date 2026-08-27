-- Align the subject-only operational projection with the live K12 taxonomy.
create or replace function internal.teacher_import_authoritative_row_basis(
  p_k12 internal.teacher_import_sources, p_university internal.teacher_import_sources
)
returns table (
  name_key text, workbook text, source_id text, source_row jsonb, ref_kind text,
  workbook_order integer, ref_order bigint, row_name text, availability_text text,
  capacity_text text, location text
)
language sql stable set search_path = '' as $$
  with roster as materialized (
    select internal.teacher_import_name_key(roster_row ->> 'name') as name_key, 'k12'::text as workbook,
      p_k12.source_id as source_id, roster_row -> 'sourceRow' as source_row, 'roster'::text as ref_kind,
      1 as workbook_order, roster_ordinality as ref_order,
      internal.teacher_import_clean_text(roster_row ->> 'name') as row_name,
      case when jsonb_typeof(roster_row -> 'availabilityText') = 'string' then internal.teacher_import_clean_text(roster_row ->> 'availabilityText') end as availability_text,
      case when jsonb_typeof(roster_row -> 'capacityText') = 'string' then internal.teacher_import_clean_text(roster_row ->> 'capacityText') end as capacity_text,
      case when jsonb_typeof(roster_row #> '{attributes,location}') = 'string' then internal.teacher_import_clean_text(roster_row #>> '{attributes,location}') end as location
    from jsonb_array_elements(p_k12.roster_rows) with ordinality as roster_rows(roster_row, roster_ordinality)
    union all
    select internal.teacher_import_name_key(roster_row ->> 'name'), 'university', p_university.source_id,
      roster_row -> 'sourceRow', 'roster', 2, roster_ordinality,
      internal.teacher_import_clean_text(roster_row ->> 'name'),
      case when jsonb_typeof(roster_row -> 'availabilityText') = 'string' then internal.teacher_import_clean_text(roster_row ->> 'availabilityText') end,
      case when jsonb_typeof(roster_row -> 'capacityText') = 'string' then internal.teacher_import_clean_text(roster_row ->> 'capacityText') end,
      case when jsonb_typeof(roster_row #> '{attributes,location}') = 'string' then internal.teacher_import_clean_text(roster_row #>> '{attributes,location}') end
    from jsonb_array_elements(p_university.roster_rows) with ordinality as roster_rows(roster_row, roster_ordinality)
  ), raw_subject_names as materialized (
    select internal.teacher_import_name_key(subject_row ->> 'name') as name_key, 'k12'::text as workbook,
      p_k12.source_id as source_id, 1 as workbook_order, subject_ordinality,
      internal.teacher_import_clean_text(subject_row ->> 'name') as row_name
    from jsonb_array_elements(p_k12.subject_rows) with ordinality as subject_rows(subject_row, subject_ordinality)
    where subject_row ->> 'sheetName' = any(array[
      'Local English','ABC华裔English','Maths&Science','奖学金','AEAS','青少英语','AMC数学竞赛','科学竞赛','雅思PTE','IB',
      '高考 English EAL','高考 Humanities','高考 LOTE','高考中文','高考地理','高考心理学','高考法律','高考数学',
      '高考化学','高考物理','高考生物','高考经济','高考会计','高考商科','高考计算机','高考设计','高考日语','高考法语'
    ])
    union all
    select internal.teacher_import_name_key(subject_row ->> 'name'), 'university', p_university.source_id, 2,
      subject_ordinality, internal.teacher_import_clean_text(subject_row ->> 'name')
    from jsonb_array_elements(p_university.subject_rows) with ordinality as subject_rows(subject_row, subject_ordinality)
    where subject_row ->> 'sheetName' = any(array['Engineering','商科','IT','理科','文科（含论文辅导）','教育学','其他科目'])
  ), subject_names as materialized (
    select raw_subject_names.name_key, raw_subject_names.workbook, raw_subject_names.source_id,
      raw_subject_names.workbook_order, min(raw_subject_names.subject_ordinality) as ref_order,
      (pg_catalog.array_agg(raw_subject_names.row_name order by raw_subject_names.subject_ordinality))[1] as row_name
    from raw_subject_names where raw_subject_names.name_key <> ''
    group by raw_subject_names.name_key, raw_subject_names.workbook, raw_subject_names.source_id, raw_subject_names.workbook_order
  )
  select roster.name_key, roster.workbook, roster.source_id, roster.source_row, roster.ref_kind,
    roster.workbook_order, roster.ref_order, roster.row_name, roster.availability_text, roster.capacity_text, roster.location
  from roster
  union all
  select subject_name.name_key, subject_name.workbook, subject_name.source_id || '#subjects',
    to_jsonb('name:' || encode(extensions.digest(pg_catalog.convert_to(subject_name.name_key, 'UTF8'), 'sha256'), 'hex')),
    'subject_name', subject_name.workbook_order, subject_name.ref_order, subject_name.row_name,
    null::text, null::text, null::text
  from subject_names subject_name
  where not exists (select 1 from roster where roster.workbook = subject_name.workbook and roster.name_key = subject_name.name_key)
$$;
revoke all on function internal.teacher_import_authoritative_row_basis(
  internal.teacher_import_sources, internal.teacher_import_sources
) from public, anon, authenticated;
