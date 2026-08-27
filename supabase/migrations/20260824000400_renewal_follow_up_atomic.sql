-- A renewal follow-up is one user intent.  Renewal state, the student's
-- follow-up history, and an optional screenshot must never be committed by
-- separate browser mutations.

create table if not exists internal.renewal_follow_up_commands (
  command_key text primary key check (
    command_key ~ '^renewal-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  renewal_id text not null check (length(renewal_id) between 1 and 120),
  student_id text not null check (length(student_id) between 1 and 120),
  task_id text,
  attachment_id uuid references internal.student_fu_attachments(id),
  file_id text unique,
  actor text not null check (length(actor) between 1 and 120),
  audit_id uuid not null references internal.operational_contract_audit(id),
  created_at timestamptz not null default now(),
  check ((attachment_id is null and file_id is null) or (attachment_id is not null and file_id is not null))
);

alter table internal.renewal_follow_up_commands
  add column if not exists task_id text;

alter table internal.renewal_follow_up_commands enable row level security;
revoke all on table internal.renewal_follow_up_commands from public, anon, authenticated;

create or replace function internal.validate_renewal_follow_up_intent(p_intent jsonb)
returns void
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  attempted_at timestamptz;
begin
  if jsonb_typeof(p_intent) is distinct from 'object'
     or p_intent - 'renewalId' - 'studentId' - 'packageId' - 'businessStatus'
       - 'result' - 'attemptedAt' - 'note' - 'renewalDateNote'
       - 'hasAttachment' - 'attachmentSha256' <> '{}'::jsonb
     or coalesce(p_intent ->> 'renewalId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or coalesce(p_intent ->> 'studentId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or (p_intent ? 'packageId' and coalesce(p_intent ->> 'packageId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$')
     or coalesce(p_intent ->> 'businessStatus', '') not in (
       'renewed', 'not_renewed_active', 'not_renewed_inactive', 'not_renewed_exam_finished'
     )
     or coalesce(p_intent ->> 'result', '') not in ('已跟进', '本次未跟进', '等待家长')
     or coalesce(p_intent ->> 'attemptedAt', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$'
     or jsonb_typeof(p_intent -> 'note') is distinct from 'string'
     or jsonb_typeof(p_intent -> 'renewalDateNote') is distinct from 'string'
     or jsonb_typeof(p_intent -> 'hasAttachment') is distinct from 'boolean'
     or length(coalesce(p_intent ->> 'note', '')) > 2000
     or length(coalesce(p_intent ->> 'renewalDateNote', '')) > 500
     or (p_intent ->> 'hasAttachment' = 'true'
       and coalesce(p_intent ->> 'attachmentSha256', '') !~ '^[a-f0-9]{64}$')
     or (p_intent ->> 'hasAttachment' = 'false' and p_intent ? 'attachmentSha256') then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_intent';
  end if;
  begin
    attempted_at := (p_intent ->> 'attemptedAt')::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_intent';
  end;
  if attempted_at is null then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_intent';
  end if;
end;
$$;

revoke all on function internal.validate_renewal_follow_up_intent(jsonb)
  from public, anon, authenticated;

create or replace function public.put_renewal_follow_up_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_renewal_id text,
  p_student_id text,
  p_package_id text,
  p_business_status text,
  p_result text,
  p_attempted_at timestamptz,
  p_note text,
  p_renewal_date_note text,
  p_file_name text,
  p_file_content_type text,
  p_file_content_base64 text,
  p_file_title text,
  p_file_sha256 text,
  p_expected_versions jsonb,
  p_actor text
)
returns table (
  command_key text,
  applied boolean,
  renewal_id text,
  student_id text,
  attachment jsonb,
  renewals_row public.ops_state,
  students_row public.ops_state,
  files_row public.ops_state,
  tasks_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  files_state public.ops_state%rowtype;
  renewals_state public.ops_state%rowtype;
  students_state public.ops_state%rowtype;
  tasks_state public.ops_state%rowtype;
  saved_files_state public.ops_state%rowtype;
  saved_renewals_state public.ops_state%rowtype;
  saved_students_state public.ops_state%rowtype;
  saved_tasks_state public.ops_state%rowtype;
  prior internal.renewal_follow_up_commands%rowtype;
  saved_attachment internal.student_fu_attachments%rowtype;
  current_student jsonb;
  current_renewal jsonb;
  current_task jsonb;
  next_student jsonb;
  next_renewal jsonb;
  next_task jsonb;
  next_students jsonb;
  next_renewals jsonb;
  next_files jsonb;
  next_tasks jsonb;
  file_record jsonb;
  attachment_payload jsonb;
  follow_up_entry jsonb;
  history jsonb;
  decoded bytea;
  expected_files_version bigint;
  expected_renewals_version bigint;
  expected_students_version bigint;
  expected_tasks_version bigint;
  current_file_count bigint;
  canonical_actor text;
  canonical_renewal_id text;
  canonical_student_id text;
  canonical_package_id text;
  resolved_package_id text;
  task_anchor text;
  canonical_note text;
  canonical_renewal_date_note text;
  command_digest text;
  actual_file_sha256 text;
  follow_up_id text;
  file_id text;
  task_id text;
  audit_id uuid;
  has_attachment boolean;
  student_changed boolean := false;
  task_changed boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~* '^renewal-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or nullif(trim(p_renewal_id), '') is null or length(trim(p_renewal_id)) > 120
     or nullif(trim(p_student_id), '') is null or length(trim(p_student_id)) > 120
     or (p_package_id is not null and (nullif(trim(p_package_id), '') is null or length(trim(p_package_id)) > 120))
     or p_business_status not in ('renewed', 'not_renewed_active', 'not_renewed_inactive', 'not_renewed_exam_finished')
     or p_result not in ('已跟进', '本次未跟进', '等待家长')
     or p_attempted_at is null
     or p_note is null or length(p_note) > 2000
     or p_renewal_date_note is null or length(p_renewal_date_note) > 500
     or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 120
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'files' - 'renewals' - 'students' - 'tasks' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'files') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'renewals') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'students') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'tasks') is distinct from 'number'
     or (p_expected_versions ->> 'files') !~ '^[1-9][0-9]*$'
     or (p_expected_versions ->> 'renewals') !~ '^[1-9][0-9]*$'
     or (p_expected_versions ->> 'students') !~ '^[1-9][0-9]*$'
     or (p_expected_versions ->> 'tasks') !~ '^[1-9][0-9]*$' then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_command';
  end if;
  begin
    expected_files_version := (p_expected_versions ->> 'files')::bigint;
    expected_renewals_version := (p_expected_versions ->> 'renewals')::bigint;
    expected_students_version := (p_expected_versions ->> 'students')::bigint;
    expected_tasks_version := (p_expected_versions ->> 'tasks')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_payload';
  end;
  if expected_files_version is null or expected_files_version < 1
     or expected_renewals_version is null or expected_renewals_version < 1
     or expected_students_version is null or expected_students_version < 1
     or expected_tasks_version is null or expected_tasks_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_payload';
  end if;

  perform internal.validate_renewal_follow_up_intent(p_command_intent);
  canonical_actor := left(trim(p_actor), 120);
  canonical_renewal_id := left(trim(p_renewal_id), 120);
  canonical_student_id := left(trim(p_student_id), 120);
  canonical_package_id := nullif(left(trim(coalesce(p_package_id, '')), 120), '');
  canonical_note := left(trim(p_note), 2000);
  canonical_renewal_date_note := left(trim(p_renewal_date_note), 500);
  if p_command_intent ->> 'renewalId' <> canonical_renewal_id
     or p_command_intent ->> 'studentId' <> canonical_student_id
     or coalesce(p_command_intent ->> 'packageId', '') <> coalesce(canonical_package_id, '')
     or p_command_intent ->> 'businessStatus' <> p_business_status
     or p_command_intent ->> 'result' <> p_result
     or (p_command_intent ->> 'attemptedAt')::timestamptz is distinct from p_attempted_at
     or p_command_intent ->> 'note' <> canonical_note
     or p_command_intent ->> 'renewalDateNote' <> canonical_renewal_date_note then
    raise exception using errcode = '22023', message = 'renewal_follow_up_intent_mismatch';
  end if;

  has_attachment := p_file_name is not null
    or p_file_content_type is not null
    or p_file_content_base64 is not null
    or p_file_title is not null
    or p_file_sha256 is not null;
  if has_attachment and (
       nullif(trim(p_file_name), '') is null
       or nullif(trim(p_file_content_type), '') is null
       or nullif(trim(p_file_content_base64), '') is null
       or nullif(trim(p_file_title), '') is null
       or nullif(trim(p_file_sha256), '') is null
     ) then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_attachment';
  end if;
  if has_attachment and p_file_content_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_attachment';
  end if;
  if has_attachment and (length(trim(p_file_name)) > 180 or length(trim(p_file_title)) > 180
     or p_file_sha256 !~ '^[a-f0-9]{64}$') then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_attachment';
  end if;
  if (p_command_intent ->> 'hasAttachment') <> (case when has_attachment then 'true' else 'false' end)
     or (has_attachment and p_command_intent ->> 'attachmentSha256' <> lower(trim(p_file_sha256))) then
    raise exception using errcode = '22023', message = 'renewal_follow_up_attachment_intent_mismatch';
  end if;
  if has_attachment then
    begin
      decoded := decode(p_file_content_base64, 'base64');
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_attachment';
    end;
    if octet_length(decoded) < 1 or octet_length(decoded) > 4194304 then
      raise exception using errcode = '22023', message = 'attachment_size_out_of_range';
    end if;
    if (p_file_content_type = 'image/jpeg' and substring(decoded from 1 for 3) <> decode('ffd8ff', 'hex'))
       or (p_file_content_type = 'image/png' and substring(decoded from 1 for 8) <> decode('89504e470d0a1a0a', 'hex'))
       or (p_file_content_type = 'image/webp' and (
         substring(decoded from 1 for 4) <> convert_to('RIFF', 'UTF8')
         or substring(decoded from 9 for 4) <> convert_to('WEBP', 'UTF8')
       )) then
      raise exception using errcode = '22023', message = 'attachment_content_type_mismatch';
    end if;
    actual_file_sha256 := encode(extensions.digest(decoded, 'sha256'), 'hex');
    if actual_file_sha256 <> lower(trim(p_file_sha256)) then
      raise exception using errcode = '22023', message = 'attachment_hash_mismatch';
    end if;
  end if;

  command_digest := encode(extensions.digest(
    jsonb_build_object('intent', p_command_intent, 'actor', canonical_actor)::text,
    'sha256'
  ), 'hex');

  -- Every renewal command takes this lock prefix.  It matches the attachment
  -- command's attachment -> files -> students order, with renewals inserted
  -- between files and students and tasks last for a stable global order.
  lock table internal.student_fu_attachments in share row exclusive mode;
  select * into files_state from public.ops_state s where s.entity = 'files' for update;
  select * into renewals_state from public.ops_state s where s.entity = 'renewals' for update;
  select * into students_state from public.ops_state s where s.entity = 'students' for update;
  select * into tasks_state from public.ops_state s where s.entity = 'tasks' for update;
  if files_state.entity is null or renewals_state.entity is null or students_state.entity is null
     or tasks_state.entity is null
     or jsonb_typeof(files_state.payload) is distinct from 'array'
     or jsonb_typeof(renewals_state.payload) is distinct from 'array'
     or jsonb_typeof(students_state.payload) is distinct from 'array'
     or jsonb_typeof(tasks_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'renewal_follow_up_state_unavailable';
  end if;
  if (select count(*) from jsonb_array_elements(students_state.payload) item
      where item.value ->> 'id' = canonical_student_id) <> 1 then
    raise exception using errcode = '22023', message = 'renewal_follow_up_student_not_found';
  end if;
  current_student := (
    select item.value from jsonb_array_elements(students_state.payload) item
    where item.value ->> 'id' = canonical_student_id limit 1
  );
  if current_student ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'archived_student_renewal_follow_up_read_only';
  end if;
  if (select count(*) from jsonb_array_elements(renewals_state.payload) item
      where item.value ->> 'id' = canonical_renewal_id) <> 1 then
    raise exception using errcode = '22023', message = 'renewal_follow_up_not_found';
  end if;
  current_renewal := (
    select item.value from jsonb_array_elements(renewals_state.payload) item
    where item.value ->> 'id' = canonical_renewal_id limit 1
  );
  if current_renewal ->> 'studentId' <> canonical_student_id then
    raise exception using errcode = '22023', message = 'renewal_follow_up_identity_conflict';
  end if;
  if canonical_package_id is not null and current_renewal ->> 'packageId' is distinct from canonical_package_id then
    raise exception using errcode = '22023', message = 'renewal_follow_up_identity_conflict';
  end if;
  resolved_package_id := coalesce(canonical_package_id, nullif(current_renewal ->> 'packageId', ''));
  if resolved_package_id is not null then
    -- Renewal package/student IDs use the same restricted identifier alphabet
    -- as the command parser.  Only ':' needs encoding for this stable anchor.
    task_anchor := 'renewal:'
      || replace(canonical_student_id, ':', '%3A')
      || ':'
      || replace(resolved_package_id, ':', '%3A');
    if (select count(*) from jsonb_array_elements(tasks_state.payload) item
        where item.value ->> 'studentId' = canonical_student_id
          and item.value ->> 'ruleKey' = 'renewal.package-depletion'
          and item.value ->> 'anchorBookingId' = task_anchor) > 1 then
      raise exception using errcode = '22023', message = 'renewal_follow_up_task_identity_conflict';
    end if;
    current_task := (
      select item.value from jsonb_array_elements(tasks_state.payload) item
      where item.value ->> 'studentId' = canonical_student_id
        and item.value ->> 'ruleKey' = 'renewal.package-depletion'
        and item.value ->> 'anchorBookingId' = task_anchor
      limit 1
    );
    task_id := nullif(current_task ->> 'id', '');
    if current_task is not null and task_id is null then
      raise exception using errcode = '22023', message = 'renewal_follow_up_task_identity_conflict';
    end if;
  end if;

  select * into prior from internal.renewal_follow_up_commands c
  where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    if prior.command_hash <> command_digest
       or prior.command_intent is distinct from p_command_intent
       or prior.renewal_id <> canonical_renewal_id
       or prior.student_id <> canonical_student_id
       or prior.actor <> canonical_actor then
      raise exception using errcode = '23505', message = 'renewal_follow_up_idempotency_conflict';
    end if;
    if prior.attachment_id is not null then
      select * into saved_attachment from internal.student_fu_attachments a where a.id = prior.attachment_id;
      if saved_attachment.id is null then
        raise exception using errcode = '55000', message = 'renewal_follow_up_replay_attachment_missing';
      end if;
      if (select count(*) from jsonb_array_elements(files_state.payload) item
          where item.value ->> 'id' = prior.file_id
            and item.value ->> 'source' = '/api/fu-attachments/' || prior.attachment_id::text
            and item.value ->> 'studentId' = canonical_student_id
            and item.value ->> 'type' = '续课 FU') <> 1 then
        raise exception using errcode = '55000', message = 'renewal_follow_up_replay_index_mismatch';
      end if;
    end if;
    attachment_payload := case when saved_attachment.id is null then null else jsonb_build_object(
      'id', saved_attachment.id, 'student_id', saved_attachment.student_id,
      'file_name', saved_attachment.file_name, 'content_type', saved_attachment.content_type,
      'byte_size', saved_attachment.byte_size, 'uploaded_by', saved_attachment.uploaded_by,
      'uploaded_at', saved_attachment.uploaded_at
    ) end;
    return query select prior.command_key, false, prior.renewal_id, prior.student_id,
      attachment_payload, renewals_state, students_state, files_state, tasks_state, prior.audit_id;
    return;
  end if;

  if files_state.version is distinct from expected_files_version
     or renewals_state.version is distinct from expected_renewals_version
     or students_state.version is distinct from expected_students_version
     or tasks_state.version is distinct from expected_tasks_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  next_renewal := (current_renewal - 'status' - 'businessStatus' - 'lastAttemptAt'
    - 'lastContactedAt' - 'followUpNote' - 'renewalDateNote'
    - 'followUpAttachmentId' - 'followUpAttachmentTitle')
    || jsonb_build_object(
      'status', p_result,
      'businessStatus', p_business_status,
      'lastAttemptAt', p_attempted_at,
      'followUpNote', canonical_note,
      'renewalDateNote', canonical_renewal_date_note
    );
  if p_result in ('已跟进', '等待家长') then
    next_renewal := next_renewal || jsonb_build_object('lastContactedAt', p_attempted_at);
  end if;

  next_student := current_student;
  if p_result in ('已跟进', '等待家长') then
    follow_up_id := 'FUH-' || substring(encode(extensions.digest(lower(p_command_key), 'sha256'), 'hex') from 1 for 24);
    if jsonb_typeof(current_student -> 'followUpHistory') is null then
      history := '[]'::jsonb;
    elsif jsonb_typeof(current_student -> 'followUpHistory') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_history';
    else
      history := current_student -> 'followUpHistory';
    end if;
    follow_up_entry := jsonb_strip_nulls(jsonb_build_object(
      'id', follow_up_id,
      'followedUpAt', p_attempted_at,
      'note', case when canonical_note = '' then '续课：' || p_result else '续课：' || p_result || ' · ' || canonical_note end,
      'recordedBy', canonical_actor
    ));
    if exists (select 1 from jsonb_array_elements(history) item where item.value ->> 'id' = follow_up_id) then
      if (select item.value from jsonb_array_elements(history) item where item.value ->> 'id' = follow_up_id limit 1)
          is distinct from follow_up_entry then
        raise exception using errcode = '23505', message = 'renewal_follow_up_history_id_conflict';
      end if;
    else
      history := history || jsonb_build_array(follow_up_entry);
    end if;
    next_student := jsonb_set(next_student, '{followUp}', to_jsonb(to_char(p_attempted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true);
    next_student := jsonb_set(next_student, '{followUpHistory}', history, true);
    student_changed := true;
  end if;

  if has_attachment then
    if jsonb_typeof(current_student -> 'files') is distinct from 'number'
       or (current_student ->> 'files')::numeric <> trunc((current_student ->> 'files')::numeric)
       or (current_student ->> 'files')::numeric < 0
       or (current_student ->> 'files')::numeric >= 1000000 then
      raise exception using errcode = '22023', message = 'invalid_student_file_count';
    end if;
    current_file_count := (current_student ->> 'files')::bigint;
    insert into internal.student_fu_attachments (
      student_id, file_name, content_type, byte_size, content, uploaded_by
    ) values (
      canonical_student_id, left(trim(p_file_name), 180), p_file_content_type,
      octet_length(decoded), decoded, canonical_actor
    ) returning * into saved_attachment;
    file_id := 'FU-' || saved_attachment.id::text;
    if exists (select 1 from jsonb_array_elements(files_state.payload) item where item.value ->> 'id' = file_id) then
      raise exception using errcode = '23505', message = 'renewal_follow_up_file_id_conflict';
    end if;
    file_record := jsonb_build_object(
      'id', file_id,
      'studentId', canonical_student_id,
      'title', left(trim(p_file_title), 180) || ' · ' || left(trim(p_file_name), 180),
      'type', '续课 FU',
      'source', '/api/fu-attachments/' || saved_attachment.id::text,
      'addedAt', saved_attachment.uploaded_at,
      'fuCategory', 'renewal_update'
    );
    next_files := jsonb_build_array(file_record) || files_state.payload;
    next_student := jsonb_set(next_student, '{files}', to_jsonb(current_file_count + 1), false);
    student_changed := true;
    next_renewal := next_renewal || jsonb_build_object(
      'followUpAttachmentId', saved_attachment.id,
      'followUpAttachmentTitle', left(trim(p_file_name), 180)
    );
  end if;

  -- Terminal renewal outcomes close only the exact automatic task for this
  -- student/package. A manually completed task is preserved as human work;
  -- the task row changes in this same transaction when an automatic task is
  -- still open (or already carries an automatic closure result).
  if p_business_status in ('renewed', 'not_renewed_inactive', 'not_renewed_exam_finished')
     and current_task is not null then
    if current_task ->> 'status' <> 'done'
       or current_task ->> 'result' in (
         '课包已续课，续课任务自动关闭',
         '课包已失效，续课任务自动关闭',
         '课包已不再进入续课提醒，任务自动关闭'
       ) then
      next_task := (current_task - 'status' - 'tone' - 'result' - 'closedAt')
        || jsonb_build_object(
          'status', 'done',
          'tone', 'green',
          'result', case when p_business_status = 'renewed'
            then '课包已续课，续课任务自动关闭'
            else '课包已失效，续课任务自动关闭' end,
          'closedAt', p_attempted_at
        );
      task_changed := true;
    end if;
  end if;

  select jsonb_agg(case when item.value ->> 'id' = canonical_renewal_id then next_renewal else item.value end order by item.ordinality)
    into next_renewals
    from jsonb_array_elements(renewals_state.payload) with ordinality item(value, ordinality);
  if student_changed then
    select jsonb_agg(case when item.value ->> 'id' = canonical_student_id then next_student else item.value end order by item.ordinality)
      into next_students
      from jsonb_array_elements(students_state.payload) with ordinality item(value, ordinality);
  else
    next_students := students_state.payload;
  end if;
  if task_changed then
    select jsonb_agg(case when item.value ->> 'id' = task_id then next_task else item.value end order by item.ordinality)
      into next_tasks
      from jsonb_array_elements(tasks_state.payload) with ordinality item(value, ordinality);
  else
    next_tasks := tasks_state.payload;
  end if;
  if has_attachment then
    update public.ops_state s set payload = next_files, version = s.version + 1,
      updated_at = now(), updated_by = canonical_actor
    where s.entity = 'files' returning s.* into saved_files_state;
  else
    saved_files_state := files_state;
  end if;
  update public.ops_state s set payload = next_renewals, version = s.version + 1,
    updated_at = now(), updated_by = canonical_actor
  where s.entity = 'renewals' returning s.* into saved_renewals_state;
  if student_changed then
    update public.ops_state s set payload = next_students, version = s.version + 1,
      updated_at = now(), updated_by = canonical_actor
    where s.entity = 'students' returning s.* into saved_students_state;
  else
    saved_students_state := students_state;
  end if;
  if task_changed then
    update public.ops_state s set payload = next_tasks, version = s.version + 1,
      updated_at = now(), updated_by = canonical_actor
    where s.entity = 'tasks' returning s.* into saved_tasks_state;
  else
    saved_tasks_state := tasks_state;
  end if;

  audit_id := internal.append_operational_contract_audit(
    'renewal_follow_up.committed', canonical_actor, 'renewal', canonical_renewal_id,
    jsonb_build_object(
      'studentId', canonical_student_id,
      'result', p_result,
      'businessStatus', p_business_status,
      'hasAttachment', has_attachment,
      'filesVersion', saved_files_state.version,
      'renewalsVersion', saved_renewals_state.version,
      'studentsVersion', saved_students_state.version,
      'tasksVersion', saved_tasks_state.version,
      'taskId', task_id
    )
  );
  insert into internal.renewal_follow_up_commands (
    command_key, command_intent, command_hash, renewal_id, student_id,
    task_id, attachment_id, file_id, actor, audit_id
  ) values (
    lower(p_command_key), p_command_intent, command_digest, canonical_renewal_id,
    canonical_student_id, task_id, case when has_attachment then saved_attachment.id else null end,
    case when has_attachment then file_id else null end, canonical_actor, audit_id
  );
  attachment_payload := case when has_attachment then jsonb_build_object(
    'id', saved_attachment.id, 'student_id', saved_attachment.student_id,
    'file_name', saved_attachment.file_name, 'content_type', saved_attachment.content_type,
    'byte_size', saved_attachment.byte_size, 'uploaded_by', saved_attachment.uploaded_by,
    'uploaded_at', saved_attachment.uploaded_at
  ) else null end;
  return query select lower(p_command_key), true, canonical_renewal_id,
    canonical_student_id, attachment_payload, saved_renewals_state,
    saved_students_state, saved_files_state, saved_tasks_state, audit_id;
end;
$$;

revoke all on function public.put_renewal_follow_up_atomic(
  text, text, jsonb, text, text, text, text, text, timestamptz, text, text,
  text, text, text, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.put_renewal_follow_up_atomic(
  text, text, jsonb, text, text, text, text, text, timestamptz, text, text,
  text, text, text, text, text, jsonb, text
) to anon, authenticated;

create or replace function public.get_renewal_follow_up_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_actor text
)
returns table (
  command_key text,
  renewal_id text,
  student_id text,
  task_id text,
  attachment_id uuid,
  audit_entry_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  prior internal.renewal_follow_up_commands%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  perform internal.validate_renewal_follow_up_intent(p_command_intent);
  if coalesce(p_command_key, '') !~* '^renewal-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_replay_lookup';
  end if;
  select * into prior from internal.renewal_follow_up_commands c
  where c.command_key = lower(p_command_key);
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent
     or prior.actor <> trim(p_actor) then
    raise exception using errcode = '23505', message = 'renewal_follow_up_idempotency_conflict';
  end if;
  return query select prior.command_key, prior.renewal_id, prior.student_id,
    prior.task_id, prior.attachment_id, prior.audit_id;
end;
$$;

revoke all on function public.get_renewal_follow_up_command_result(text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.get_renewal_follow_up_command_result(text, text, jsonb, text)
  to anon, authenticated;
