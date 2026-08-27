-- Create-if-missing renewal follow-up contract.
--
-- 240004 intentionally remains unchanged.  This RPC takes the same lock
-- prefix as the deployed renewal follow-up contract, derives the automatic
-- renewal projection from students.lessonPackages, and then invokes the
-- existing follow-up transaction in the same PostgreSQL transaction.  If the
-- second call fails, the projection insert/repair is rolled back with it.

-- `renewalTaskAnchor` percent-escapes a colon in an otherwise valid internal
-- identifier.  Keep the deployed intent contract's shape, while allowing
-- that exact encoded anchor to reach the legacy atomic function below.
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
     or coalesce(p_intent ->> 'renewalId', '') !~ '^[A-Za-z0-9]([A-Za-z0-9._:-]|%[0-9A-Fa-f]{2}){0,119}$'
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

create or replace function public.put_renewal_follow_up_create_if_missing_atomic(
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
  current_student jsonb;
  current_renewal jsonb;
  lesson_package jsonb;
  next_renewal jsonb;
  next_renewals jsonb;
  prior internal.renewal_follow_up_commands%rowtype;
  expected_files_version bigint;
  expected_renewals_version bigint;
  expected_students_version bigint;
  expected_tasks_version bigint;
  package_count bigint;
  renewal_count bigint;
  package_total numeric;
  package_consumed numeric;
  package_remaining numeric;
  canonical_actor text;
  canonical_renewal_id text;
  canonical_student_id text;
  canonical_package_id text;
  canonical_owner text;
  canonical_package_name text;
  expected_automatic_id text;
  adjusted_expected_versions jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  -- Keep this command envelope narrower than the projection it creates.  In
  -- particular, owner, packageName and balance are never command fields.
  if coalesce(p_command_key, '') !~* '^renewal-follow-up:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or nullif(trim(p_renewal_id), '') is null
     or length(trim(p_renewal_id)) > 120
     or nullif(trim(p_student_id), '') is null
     or length(trim(p_student_id)) > 120
     or nullif(trim(p_package_id), '') is null
     or length(trim(p_package_id)) > 120
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
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_create_if_missing_command';
  end if;

  begin
    expected_files_version := (p_expected_versions ->> 'files')::bigint;
    expected_renewals_version := (p_expected_versions ->> 'renewals')::bigint;
    expected_students_version := (p_expected_versions ->> 'students')::bigint;
    expected_tasks_version := (p_expected_versions ->> 'tasks')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_create_if_missing_versions';
  end;
  if expected_files_version is null or expected_files_version < 1
     or expected_renewals_version is null or expected_renewals_version < 1
     or expected_students_version is null or expected_students_version < 1
     or expected_tasks_version is null or expected_tasks_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_renewal_follow_up_create_if_missing_versions';
  end if;

  perform internal.validate_renewal_follow_up_intent(p_command_intent);
  canonical_actor := left(trim(p_actor), 120);
  canonical_renewal_id := left(trim(p_renewal_id), 120);
  canonical_student_id := left(trim(p_student_id), 120);
  canonical_package_id := left(trim(p_package_id), 120);
  if p_command_intent ->> 'renewalId' <> canonical_renewal_id
     or p_command_intent ->> 'studentId' <> canonical_student_id
     or p_command_intent ->> 'packageId' <> canonical_package_id
     or p_command_intent ->> 'businessStatus' <> p_business_status
     or (p_command_intent ->> 'attemptedAt')::timestamptz is distinct from p_attempted_at
     or p_command_intent ->> 'note' <> trim(p_note)
     or p_command_intent ->> 'renewalDateNote' <> trim(p_renewal_date_note) then
    raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_intent_mismatch';
  end if;

  -- This identity must be the exact automatic package anchor.  A caller
  -- cannot select a subject-only renewal or attach a package to another
  -- student's automatic row by choosing a convenient id.
  expected_automatic_id := 'REN-AUTO:renewal:'
    || replace(canonical_student_id, ':', '%3A')
    || ':'
    || replace(canonical_package_id, ':', '%3A');
  if canonical_renewal_id <> expected_automatic_id then
    raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_identity_conflict';
  end if;

  -- All renewal writes use files -> renewals -> students -> tasks.  The
  -- attachment table lock is retained as the first prefix used by 240004.
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

  -- A command-key replay must not repair or re-version the projection before
  -- the existing atomic function returns its receipt.  It also means a lost
  -- response can replay with stale OCC versions exactly like 240004.
  select * into prior from internal.renewal_follow_up_commands c
  where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    return query select * from public.put_renewal_follow_up_atomic(
      p_secret, p_command_key, p_command_intent, p_renewal_id, p_student_id,
      p_package_id, p_business_status, p_result, p_attempted_at, p_note,
      p_renewal_date_note, p_file_name, p_file_content_type,
      p_file_content_base64, p_file_title, p_file_sha256,
      p_expected_versions, p_actor
    );
    return;
  end if;

  if (select count(*) from jsonb_array_elements(students_state.payload) item
      where item.value ->> 'id' = canonical_student_id) <> 1 then
    raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_student_not_found';
  end if;
  current_student := (
    select item.value from jsonb_array_elements(students_state.payload) item
    where item.value ->> 'id' = canonical_student_id limit 1
  );
  if current_student ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'archived_student_renewal_follow_up_read_only';
  end if;
  if coalesce(trim(current_student ->> 'status'), '') not in (
    '在读', '活跃 + 有课时', '活跃 + 无课时', '在读 + 加课待排'
  ) then
    raise exception using errcode = '42501', message = 'inactive_student_renewal_follow_up_forbidden';
  end if;

  if jsonb_typeof(current_student -> 'lessonPackages') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_package_not_found';
  end if;
  select count(*) into package_count
  from jsonb_array_elements(current_student -> 'lessonPackages') item
  where item.value ->> 'id' = canonical_package_id;
  if package_count <> 1 then
    raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_package_not_found';
  end if;
  select item.value into lesson_package
  from jsonb_array_elements(current_student -> 'lessonPackages') item
  where item.value ->> 'id' = canonical_package_id
  limit 1;
  if jsonb_typeof(lesson_package -> 'subjectIds') is distinct from 'array'
     or jsonb_array_length(lesson_package -> 'subjectIds') < 1 then
    raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_package_unassociated';
  end if;
  canonical_owner := nullif(trim(current_student ->> 'owner'), '');
  canonical_package_name := nullif(trim(lesson_package ->> 'name'), '');
  if canonical_owner is null or canonical_package_name is null then
    raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_package_invalid';
  end if;
  if jsonb_typeof(lesson_package -> 'purchaseRecords') is distinct from 'array'
     or coalesce(lesson_package ->> 'consumedHours', '') !~ '^[0-9]+(\.[0-9]+)?$'
     or exists (
       select 1 from jsonb_array_elements(lesson_package -> 'purchaseRecords') purchase
       where coalesce(purchase.value ->> 'hours', '') !~ '^[0-9]+(\.[0-9]+)?$'
     ) then
    raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_package_balance_invalid';
  end if;
  select coalesce(sum((purchase.value ->> 'hours')::numeric), 0)
    into package_total
  from jsonb_array_elements(lesson_package -> 'purchaseRecords') purchase;
  package_consumed := (lesson_package ->> 'consumedHours')::numeric;
  package_remaining := round(package_total - package_consumed, 6);
  if package_remaining < 0 then
    raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_package_balance_invalid';
  end if;

  select count(*) into renewal_count
  from jsonb_array_elements(renewals_state.payload) item
  where item.value ->> 'id' = canonical_renewal_id;
  if renewal_count > 1 then
    raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_identity_conflict';
  end if;
  if renewal_count = 1 then
    current_renewal := (
      select item.value from jsonb_array_elements(renewals_state.payload) item
      where item.value ->> 'id' = canonical_renewal_id limit 1
    );
    if current_renewal ->> 'studentId' is distinct from canonical_student_id
       or current_renewal ->> 'packageId' is distinct from canonical_package_id
       or nullif(trim(current_renewal ->> 'subjectId'), '') is not null then
      raise exception using errcode = '22023', message = 'renewal_follow_up_create_if_missing_identity_conflict';
    end if;
  end if;

  if files_state.version is distinct from expected_files_version
     or renewals_state.version is distinct from expected_renewals_version
     or students_state.version is distinct from expected_students_version
     or tasks_state.version is distinct from expected_tasks_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  -- Repair only server-owned projection fields on an already-materialised
  -- automatic row.  For a missing row, the same canonical shape is inserted.
  if renewal_count = 1 then
    next_renewal := (current_renewal - 'owner' - 'packageName' - 'remaining' - 'packageId')
      || jsonb_build_object(
        'owner', canonical_owner,
        'packageName', canonical_package_name,
        'remaining', package_remaining,
        'packageId', canonical_package_id
      );
    select jsonb_agg(case when item.value ->> 'id' = canonical_renewal_id then next_renewal else item.value end order by item.ordinality)
      into next_renewals
    from jsonb_array_elements(renewals_state.payload) with ordinality item(value, ordinality);
  else
    next_renewal := jsonb_build_object(
      'id', canonical_renewal_id,
      'studentId', canonical_student_id,
      'remaining', package_remaining,
      'estimate', '待确认',
      'status', '待跟进',
      'businessStatus', 'not_renewed_active',
      'owner', canonical_owner,
      'packageId', canonical_package_id,
      'packageName', canonical_package_name
    );
    next_renewals := jsonb_build_array(next_renewal) || renewals_state.payload;
  end if;
  update public.ops_state s set payload = next_renewals, version = s.version + 1,
    updated_at = now(), updated_by = canonical_actor
  where s.entity = 'renewals';

  -- 240004 owns follow-up history/status, attachment insertion and exact task
  -- closure.  Calling it here is still one transaction and preserves its
  -- files -> renewals -> students -> tasks lock/OCC contract.
  adjusted_expected_versions := jsonb_set(
    p_expected_versions, '{renewals}', to_jsonb(renewals_state.version + 1), true
  );
  return query select * from public.put_renewal_follow_up_atomic(
    p_secret, p_command_key, p_command_intent, p_renewal_id, p_student_id,
    p_package_id, p_business_status, p_result, p_attempted_at, p_note,
    p_renewal_date_note, p_file_name, p_file_content_type,
    p_file_content_base64, p_file_title, p_file_sha256,
    adjusted_expected_versions, p_actor
  );
end;
$$;

revoke all on function public.put_renewal_follow_up_create_if_missing_atomic(
  text, text, jsonb, text, text, text, text, text, timestamptz, text, text,
  text, text, text, text, text, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.put_renewal_follow_up_create_if_missing_atomic(
  text, text, jsonb, text, text, text, text, text, timestamptz, text, text,
  text, text, text, text, text, jsonb, text
) to anon, authenticated;
