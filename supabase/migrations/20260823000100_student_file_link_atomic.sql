-- Ordinary file-center registrations update the canonical file index and the
-- student's file counter as one replay-safe command.  Keep this in a new
-- migration: the already-deployed operational contract remains unchanged.

create table if not exists internal.student_file_link_commands (
  command_key text primary key
    check (command_key ~ '^file-link:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  file_id text not null unique check (length(file_id) between 1 and 160),
  student_id text not null check (length(student_id) between 1 and 120),
  file_record jsonb not null check (jsonb_typeof(file_record) = 'object'),
  student_file_count bigint not null check (student_file_count between 0 and 1000000),
  files_version bigint not null check (files_version > 0),
  students_version bigint not null check (students_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  audit_id uuid not null references internal.operational_contract_audit(id),
  created_at timestamptz not null default now()
);

alter table internal.student_file_link_commands enable row level security;
revoke all on table internal.student_file_link_commands from public, anon, authenticated;

create or replace function public.put_student_file_link_atomic(
  p_secret text,
  p_command_key text,
  p_student_id text,
  p_file_title text,
  p_file_type text,
  p_source text,
  p_expected_versions jsonb,
  p_actor text
)
returns table (
  command_key text,
  applied boolean,
  file_record jsonb,
  files_row public.ops_state,
  students_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  files_state public.ops_state%rowtype;
  students_state public.ops_state%rowtype;
  saved_files_state public.ops_state%rowtype;
  saved_students_state public.ops_state%rowtype;
  prior internal.student_file_link_commands%rowtype;
  current_student jsonb;
  next_student jsonb;
  next_students jsonb;
  next_files jsonb;
  saved_file_record jsonb;
  expected_files_version bigint;
  expected_students_version bigint;
  current_file_count bigint;
  canonical_title text;
  canonical_source text;
  canonical_actor text;
  file_id text;
  command_digest text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^file-link:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or nullif(trim(p_student_id), '') is null or length(trim(p_student_id)) > 120
     or nullif(trim(p_file_title), '') is null
     or length(trim(p_file_title)) > 180
     or nullif(trim(p_file_type), '') is null
     or p_file_type not in ('Learning Plan', '学校资料', 'Report 资料', '成绩单', '课堂反馈', 'FU', '续课 FU', '资料链接', '其他')
     or nullif(trim(p_source), '') is null
     or length(trim(p_source)) > 500
     or nullif(trim(p_actor), '') is null then
    raise exception using errcode = '22023', message = 'invalid_student_file_link_command';
  end if;
  begin
    expected_files_version := (p_expected_versions ->> 'files')::bigint;
    expected_students_version := (p_expected_versions ->> 'students')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_student_file_link_payload';
  end;
  if jsonb_typeof(p_expected_versions) <> 'object'
     or p_expected_versions - 'files' - 'students' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'files') <> 'number'
     or jsonb_typeof(p_expected_versions -> 'students') <> 'number'
     or (p_expected_versions ->> 'files') !~ '^[1-9][0-9]*$'
     or (p_expected_versions ->> 'students') !~ '^[1-9][0-9]*$'
     or expected_files_version is null or expected_files_version < 1
     or expected_students_version is null or expected_students_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_student_file_link_payload';
  end if;

  canonical_title := left(trim(p_file_title), 180);
  canonical_source := left(trim(p_source), 500);
  canonical_actor := left(trim(p_actor), 120);
  command_digest := encode(extensions.digest(
    jsonb_build_object(
      'studentId', trim(p_student_id),
      'fileTitle', canonical_title,
      'fileType', p_file_type,
      'source', canonical_source,
      'actor', canonical_actor
    )::text,
    'sha256'
  ), 'hex');

  -- Keep the same global order as the other student/file atomic contracts.
  select * into files_state from public.ops_state s where s.entity = 'files' for update;
  select * into students_state from public.ops_state s where s.entity = 'students' for update;
  if files_state.entity is null or students_state.entity is null
     or jsonb_typeof(files_state.payload) <> 'array'
     or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'student_file_link_state_unavailable';
  end if;
  if (select count(*) from jsonb_array_elements(students_state.payload) student
      where student ->> 'id' = trim(p_student_id)) <> 1 then
    raise exception using errcode = '22023', message = 'student_file_link_student_not_found';
  end if;
  current_student := (
    select student from jsonb_array_elements(students_state.payload) student
    where student ->> 'id' = trim(p_student_id) limit 1
  );
  if current_student ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'archived_student_file_link_read_only';
  end if;

  select * into prior
  from internal.student_file_link_commands c
  where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    if prior.command_hash <> command_digest
       or prior.student_id <> trim(p_student_id)
       or prior.actor <> canonical_actor then
      raise exception using errcode = '23505', message = 'student_file_link_idempotency_conflict';
    end if;
    if (select count(*) from jsonb_array_elements(files_state.payload) item(value)
        where item.value = prior.file_record) <> 1
       or (select count(*) from jsonb_array_elements(students_state.payload) item(value)
           where item.value ->> 'id' = prior.student_id
             and item.value -> 'files' = to_jsonb(prior.student_file_count)) <> 1 then
      raise exception using errcode = '55000', message = 'student_file_link_replay_index_mismatch';
    end if;
    return query select prior.command_key, false, prior.file_record,
      files_state, students_state, prior.audit_id;
    return;
  end if;

  if files_state.version is distinct from expected_files_version
     or students_state.version is distinct from expected_students_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if jsonb_typeof(current_student -> 'files') <> 'number'
     or (current_student ->> 'files')::numeric <> trunc((current_student ->> 'files')::numeric)
     or (current_student ->> 'files')::numeric < 0
     or (current_student ->> 'files')::numeric >= 1000000 then
    raise exception using errcode = '22023', message = 'invalid_student_file_count';
  end if;
  current_file_count := (current_student ->> 'files')::bigint;

  file_id := 'FIL-' || gen_random_uuid()::text;
  saved_file_record := jsonb_build_object(
    'id', file_id,
    'studentId', trim(p_student_id),
    'title', canonical_title,
    'type', p_file_type,
    'source', canonical_source,
    'addedAt', now()
  );
  if exists (select 1 from jsonb_array_elements(files_state.payload) item(value)
             where item.value ->> 'id' = file_id) then
    raise exception using errcode = '23505', message = 'student_file_link_file_id_conflict';
  end if;

  next_files := jsonb_build_array(saved_file_record) || files_state.payload;
  next_student := jsonb_set(current_student, '{files}', to_jsonb(current_file_count + 1), false);
  select jsonb_agg(case when student ->> 'id' = trim(p_student_id) then next_student else student end order by ordinality)
  into next_students
  from jsonb_array_elements(students_state.payload) with ordinality source(student, ordinality);

  update public.ops_state s set payload = next_files, version = s.version + 1,
    updated_at = now(), updated_by = canonical_actor
  where s.entity = 'files' returning s.* into saved_files_state;
  update public.ops_state s set payload = next_students, version = s.version + 1,
    updated_at = now(), updated_by = canonical_actor
  where s.entity = 'students' returning s.* into saved_students_state;
  audit_id := internal.append_operational_contract_audit(
    'student_file_link.created', canonical_actor, 'student', trim(p_student_id),
    jsonb_build_object(
      'fileId', file_id,
      'fileType', p_file_type,
      'filesVersion', saved_files_state.version,
      'studentsVersion', saved_students_state.version
    )
  );
  insert into internal.student_file_link_commands (
    command_key, command_hash, file_id, student_id, file_record,
    student_file_count, files_version, students_version, actor, audit_id
  ) values (
    lower(p_command_key), command_digest, file_id, trim(p_student_id), saved_file_record,
    current_file_count + 1, saved_files_state.version, saved_students_state.version,
    canonical_actor, audit_id
  );
  return query select lower(p_command_key), true, saved_file_record,
    saved_files_state, saved_students_state, audit_id;
end;
$$;

revoke all on function public.put_student_file_link_atomic(text, text, text, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.put_student_file_link_atomic(text, text, text, text, text, text, jsonb, text)
  to anon, authenticated;
