-- Tencent Docs K12 workbook subject taxonomy: replace legacy VCE/state labels
-- with the live high-exam subject sheets.  This is a forward repair of the
-- commit-time contract; source parsing/authority functions were updated in 1000.

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
  if k12.sheet_names <> '["在职总表","Local English","ABC华裔English","Maths&Science","奖学金","AEAS","青少英语","AMC数学竞赛","科学竞赛","雅思PTE","IB","高考 English EAL","高考 Humanities","高考 LOTE","高考中文","高考地理","高考心理学","高考法律","高考数学","高考化学","高考物理","高考生物","高考经济","高考会计","高考商科","高考计算机","高考设计","高考日语","高考法语","已离职教师"]'::jsonb
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
