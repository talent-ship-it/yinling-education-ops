-- Preserve the fail-closed student import contract while making a missing
-- source actionable. The DETAIL contains only the source kind, never rows or
-- student data, so the server can distinguish master/JWB readiness safely.
create or replace function public.get_latest_student_import_source_rows(
  p_secret text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  link_set internal.student_import_identity_link_sets%rowtype;
  students_state public.ops_state%rowtype;
  duplicate_snapshot jsonb;
  fu_attachment_snapshot jsonb;
  missing_sources text[] := array[]::text[];
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into master from internal.student_import_source_rows s where s.source_kind = 'master';
  select * into jwb from internal.student_import_source_rows s where s.source_kind = 'jwb';
  select * into link_set from internal.student_import_identity_link_sets l where l.singleton;
  select * into students_state from public.ops_state s where s.entity = 'students';
  if master.source_kind is null then
    missing_sources := array_append(missing_sources, 'master');
  end if;
  if jwb.source_kind is null then
    missing_sources := array_append(missing_sources, 'jwb');
  end if;
  if cardinality(missing_sources) > 0 then
    raise exception using
      errcode = 'P0002',
      message = 'student_import_source_rows_unavailable',
      detail = 'missing_sources=' || array_to_string(missing_sources, ',');
  end if;
  if students_state.entity is null or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(master, students_state);
  fu_attachment_snapshot := internal.student_fu_attachment_reference_snapshot();

  return jsonb_build_object(
    'master', jsonb_build_object(
      'sourceId', master.source_id,
      'revision', master.revision,
      'rows', master.rows
    ),
    'jwb', jsonb_build_object(
      'sourceId', jwb.source_id,
      'revision', jwb.revision,
      'rows', jwb.rows
    ),
    'identityLinks', case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and link_set.students_version = students_state.version
       and link_set.link_count = 0
      then link_set.links else '[]'::jsonb end,
    'identityLinkFingerprint', case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and link_set.students_version = students_state.version
       and link_set.link_count = 0
      then link_set.link_fingerprint else 'sha256:' || repeat('0', 64) end,
    'masterDuplicateResolutions', duplicate_snapshot -> 'decisions',
    'masterDuplicateResolutionFingerprint', duplicate_snapshot ->> 'fingerprint',
    'fuAttachmentReferences', fu_attachment_snapshot
  );
end;
$$;

revoke all on function public.get_latest_student_import_source_rows(text)
  from public, anon, authenticated;
grant execute on function public.get_latest_student_import_source_rows(text)
  to anon, authenticated;
