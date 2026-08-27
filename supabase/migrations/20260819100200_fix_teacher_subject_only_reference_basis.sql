-- Keep the authoritative reference basis aligned with the live K12 taxonomy.
-- Subject-only teachers use deterministic #subjects references, so this list
-- must include every retained and high-exam subject sheet.
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
    select internal.teacher_import_name_key(roster_row ->> 'name') as name_key,
      'k12'::text as workbook, p_k12.source_id as source_id,
      roster_row -> 'sourceRow' as source_row, 'roster'::text as ref_kind,
      1 as workbook_order, roster_ordinality as ref_order
    from jsonb_array_elements(p_k12.roster_rows) with ordinality as roster_rows(roster_row, roster_ordinality)
    union all
    select internal.teacher_import_name_key(roster_row ->> 'name'), 'university',
      p_university.source_id, roster_row -> 'sourceRow', 'roster', 2, roster_ordinality
    from jsonb_array_elements(p_university.roster_rows) with ordinality as roster_rows(roster_row, roster_ordinality)
  ), subject_names as materialized (
    select subject_name.name_key, subject_name.workbook, subject_name.source_id,
      subject_name.workbook_order, min(subject_name.subject_ordinality) as ref_order
    from (
      select internal.teacher_import_name_key(subject_row ->> 'name') as name_key,
        'k12'::text as workbook, p_k12.source_id as source_id, 1 as workbook_order, subject_ordinality
      from jsonb_array_elements(p_k12.subject_rows) with ordinality as subject_rows(subject_row, subject_ordinality)
      where subject_row ->> 'sheetName' = any(array[
        'Local English','ABC华裔English','Maths&Science','奖学金','AEAS','青少英语',
        'AMC数学竞赛','科学竞赛','雅思PTE','IB',
        '高考 English EAL','高考 Humanities','高考 LOTE','高考中文','高考地理','高考心理学',
        '高考法律','高考数学','高考化学','高考物理','高考生物','高考经济','高考会计',
        '高考商科','高考计算机','高考设计','高考日语','高考法语'
      ])
      union all
      select internal.teacher_import_name_key(subject_row ->> 'name'), 'university',
        p_university.source_id, 2, subject_ordinality
      from jsonb_array_elements(p_university.subject_rows) with ordinality as subject_rows(subject_row, subject_ordinality)
      where subject_row ->> 'sheetName' = any(array[
        'Engineering','商科','IT','理科','文科（含论文辅导）','教育学','其他科目'
      ])
    ) subject_name
    where subject_name.name_key <> ''
    group by subject_name.name_key, subject_name.workbook, subject_name.source_id, subject_name.workbook_order
  ), authoritative_refs as materialized (
    select roster.name_key, roster.workbook, roster.source_id, roster.source_row,
      roster.ref_kind, roster.workbook_order, roster.ref_order from roster
    union all
    select subject_name.name_key, subject_name.workbook, subject_name.source_id || '#subjects',
      to_jsonb('name:' || encode(extensions.digest(pg_catalog.convert_to(subject_name.name_key, 'UTF8'), 'sha256'), 'hex')),
      'subject_name', subject_name.workbook_order, subject_name.ref_order
    from subject_names subject_name
    where not exists (
      select 1 from roster where roster.workbook = subject_name.workbook and roster.name_key = subject_name.name_key
    )
  )
  select authoritative_refs.name_key, authoritative_refs.workbook, authoritative_refs.source_id,
    authoritative_refs.source_row, authoritative_refs.ref_kind, authoritative_refs.workbook_order, authoritative_refs.ref_order
  from authoritative_refs
  order by authoritative_refs.workbook_order, authoritative_refs.ref_order,
    authoritative_refs.ref_kind collate "C", authoritative_refs.name_key collate "C"
$$;

revoke all on function internal.teacher_import_authoritative_ref_basis(
  internal.teacher_import_sources, internal.teacher_import_sources
) from public, anon, authenticated;
