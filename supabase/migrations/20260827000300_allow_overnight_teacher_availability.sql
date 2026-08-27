-- The original teacher AVA submission function rejected every cross-midnight
-- interval because it compared wall-clock strings. Replace only that function
-- and normalize an overnight end into the following day before overlap checks.

create or replace function public.submit_teacher_availability_atomic(
  p_secret text,
  p_submission_key text,
  p_expected_teacher_version bigint,
  p_teacher_id text,
  p_month text,
  p_timezone text,
  p_additional_students integer,
  p_slots jsonb,
  p_notes text,
  p_actor text
)
returns table (
  submission_key text,
  submission_id bigint,
  teacher_id text,
  status text,
  applied boolean,
  submitted_at timestamptz,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  teacher_state public.ops_state%rowtype;
  current_teacher jsonb;
  prior internal.teacher_availability_submission_commands%rowtype;
  saved_submission public.teacher_availability_submissions%rowtype;
  slot jsonb;
  other_slot jsonb;
  slot_index integer;
  other_index integer;
  week_shift integer;
  slot_day integer;
  other_day integer;
  slot_start integer;
  slot_end integer;
  other_start integer;
  other_end integer;
  month_start date;
  actor_teacher_count integer;
  payload_hash text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_submission_key, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_expected_teacher_version is null or p_expected_teacher_version < 1
     or nullif(trim(p_teacher_id), '') is null or p_teacher_id <> trim(p_teacher_id)
     or coalesce(p_month, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
     or nullif(trim(p_timezone), '') is null or p_timezone <> trim(p_timezone)
     or length(p_timezone) > 100 or p_timezone !~ '^[A-Za-z0-9_+./-]+$'
     or not exists (select 1 from pg_catalog.pg_timezone_names zone where zone.name = p_timezone)
     or p_additional_students is null or p_additional_students not between 0 and 100
     or p_slots is null or jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) > 64
     or (p_notes is not null and (p_notes <> trim(p_notes) or length(p_notes) > 1000 or p_notes = ''))
     or nullif(trim(p_actor), '') is null or p_actor <> trim(p_actor) or length(p_actor) > 120 then
    raise exception using errcode = '22023', message = 'invalid_teacher_availability_submission';
  end if;
  begin
    month_start := (p_month || '-01')::date;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_teacher_availability_submission_month';
  end;

  if jsonb_array_length(p_slots) > 0 then
    for slot_index in 0..jsonb_array_length(p_slots) - 1
    loop
      slot := p_slots -> slot_index;
      if jsonb_typeof(slot) <> 'object'
         or slot - 'day' - 'start' - 'end' <> '{}'::jsonb
         or jsonb_typeof(slot -> 'day') is distinct from 'number'
         or (slot ->> 'day')::numeric <> trunc((slot ->> 'day')::numeric)
         or (slot ->> 'day')::integer not between 0 and 6
         or coalesce(slot ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or coalesce(slot ->> 'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or slot ->> 'start' = slot ->> 'end' then
        raise exception using errcode = '22023', message = 'invalid_teacher_availability_submission_slot';
      end if;
      slot_day := (slot ->> 'day')::integer;
      slot_start := slot_day * 1440
        + substring(slot ->> 'start', 1, 2)::integer * 60
        + substring(slot ->> 'start', 4, 2)::integer;
      slot_end := slot_day * 1440
        + substring(slot ->> 'end', 1, 2)::integer * 60
        + substring(slot ->> 'end', 4, 2)::integer;
      if slot_end < slot_start then slot_end := slot_end + 1440; end if;

      if slot_index > 0 then
        for other_index in 0..slot_index - 1
        loop
          other_slot := p_slots -> other_index;
          other_day := (other_slot ->> 'day')::integer;
          other_start := other_day * 1440
            + substring(other_slot ->> 'start', 1, 2)::integer * 60
            + substring(other_slot ->> 'start', 4, 2)::integer;
          other_end := other_day * 1440
            + substring(other_slot ->> 'end', 1, 2)::integer * 60
            + substring(other_slot ->> 'end', 4, 2)::integer;
          if other_end < other_start then other_end := other_end + 1440; end if;
          for week_shift in -1..1
          loop
            if slot_start < other_end + week_shift * 10080
               and other_start + week_shift * 10080 < slot_end then
              raise exception using errcode = '22023', message = 'overlapping_teacher_availability_submission_slots';
            end if;
          end loop;
        end loop;
      end if;
    end loop;
  end if;

  payload_hash := encode(extensions.digest(jsonb_build_object(
    'teacherId', p_teacher_id,
    'month', p_month,
    'timezone', p_timezone,
    'additionalStudents', p_additional_students,
    'slots', p_slots,
    'notes', p_notes
  )::text, 'sha256'), 'hex');

  select * into teacher_state
  from public.ops_state s
  where s.entity = 'teachers'
  for update;
  if teacher_state.entity is null or jsonb_typeof(teacher_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'teachers_state_unavailable';
  end if;
  select count(*) into actor_teacher_count
  from jsonb_array_elements(teacher_state.payload) teacher
  where lower(trim(teacher ->> 'name')) = lower(trim(p_actor));
  if actor_teacher_count <> 1 then
    raise exception using errcode = '42501', message = 'teacher_availability_submit_identity_mismatch';
  end if;
  current_teacher := (
    select teacher
    from jsonb_array_elements(teacher_state.payload) teacher
    where lower(trim(teacher ->> 'name')) = lower(trim(p_actor))
    limit 1
  );
  if current_teacher ->> 'id' is distinct from p_teacher_id then
    raise exception using errcode = '42501', message = 'teacher_availability_submit_identity_mismatch';
  end if;

  select * into prior
  from internal.teacher_availability_submission_commands command
  where command.submission_key = p_submission_key;
  if prior.submission_key is not null then
    if prior.command_hash <> payload_hash
       or prior.teacher_id <> p_teacher_id
       or prior.actor <> p_actor then
      raise exception using errcode = '23505', message = 'teacher_availability_submission_idempotency_conflict';
    end if;
    select * into saved_submission
    from public.teacher_availability_submissions submission
    where submission.id = prior.submission_id;
    if not found then
      raise exception using errcode = '55000', message = 'teacher_availability_submission_replay_missing';
    end if;
    return query select prior.submission_key, saved_submission.id,
      saved_submission.teacher_id, saved_submission.status, false,
      saved_submission.submitted_at, prior.audit_id;
    return;
  end if;

  if teacher_state.version <> p_expected_teacher_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if exists (
    select 1
    from public.teacher_availability_submissions submission
    where submission.teacher_id = p_teacher_id
      and submission.submission_month = p_month
      and submission.status = 'pending'
  ) then
    raise exception using errcode = '23505', message = 'teacher_availability_pending_submission_exists';
  end if;
  if month_start < date_trunc('month', current_date)::date
     or month_start > (date_trunc('month', current_date) + interval '12 months')::date then
    raise exception using errcode = '22023', message = 'teacher_availability_submission_month_out_of_range';
  end if;

  insert into public.teacher_availability_submissions (
    teacher_id, teacher_name, submission_month, availability_timezone,
    additional_students, availability_slots, notes, status,
    submitted_at, reviewed_at, reviewed_by, review_note
  ) values (
    p_teacher_id, current_teacher ->> 'name', p_month, p_timezone,
    p_additional_students, p_slots, p_notes, 'pending',
    now(), null, null, null
  ) returning * into saved_submission;

  audit_id := internal.append_operational_contract_audit(
    'teacher_availability.submitted', p_actor, 'teacher_availability_submission',
    saved_submission.id::text,
    jsonb_build_object(
      'submissionKey', p_submission_key,
      'teacherId', p_teacher_id,
      'month', p_month,
      'teacherVersion', teacher_state.version,
      'status', 'pending'
    )
  );
  insert into internal.teacher_availability_submission_commands (
    submission_key, command_hash, submission_id, teacher_id,
    teacher_version, actor, audit_id
  ) values (
    p_submission_key, payload_hash, saved_submission.id, p_teacher_id,
    teacher_state.version, p_actor, audit_id
  );

  return query select p_submission_key, saved_submission.id,
    saved_submission.teacher_id, saved_submission.status, true,
    saved_submission.submitted_at, audit_id;
end;
$$;

revoke all on function public.submit_teacher_availability_atomic(
  text, text, bigint, text, text, text, integer, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.submit_teacher_availability_atomic(
  text, text, bigint, text, text, text, integer, jsonb, text, text
) to anon, authenticated;
