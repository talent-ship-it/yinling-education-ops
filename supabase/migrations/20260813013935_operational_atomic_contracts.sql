-- Reviewed server-side contracts for three operations that must never be
-- implemented as a sequence of independent ops_state writes:
--   1. attendance-backed lesson settlement;
--   2. teacher availability submission review/writeback; and
--   3. versioned student source import.
--   4. versioned teacher workbook import.
--
-- All mutable data remains behind OPS_API_SECRET RPCs.  The internal tables
-- are deliberately not exposed through the Data API and all public functions
-- revoke PostgreSQL's default PUBLIC execute grant before opting in the roles
-- used by the server-only Next.js store.

create table if not exists internal.operational_contract_audit (
  id uuid primary key default gen_random_uuid(),
  action text not null check (length(action) between 1 and 120),
  actor text not null check (length(actor) between 1 and 120),
  target_type text not null check (length(target_type) between 1 and 80),
  target_id text not null check (length(target_id) between 1 and 240),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

alter table internal.operational_contract_audit enable row level security;
revoke all on table internal.operational_contract_audit from public, anon, authenticated;

create or replace function internal.append_operational_contract_audit(
  p_action text,
  p_actor text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved_id uuid;
begin
  if nullif(trim(p_action), '') is null
     or nullif(trim(p_actor), '') is null
     or nullif(trim(p_target_type), '') is null
     or nullif(trim(p_target_id), '') is null
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_audit_entry';
  end if;

  insert into internal.operational_contract_audit (
    action, actor, target_type, target_id, metadata
  ) values (
    left(trim(p_action), 120),
    left(trim(p_actor), 120),
    left(trim(p_target_type), 80),
    left(trim(p_target_id), 240),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into saved_id;

  return saved_id;
end;
$$;

revoke all on function internal.append_operational_contract_audit(text, text, text, text, jsonb)
  from public, anon, authenticated;

create table if not exists internal.lesson_attendance_evidence (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique check (reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'),
  occurrence_id text not null check (occurrence_id ~ '^.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  provider text not null check (length(provider) between 1 and 80),
  captured_at timestamptz not null,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  ingested_by text not null check (length(ingested_by) between 1 and 120),
  ingested_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.lesson_attendance_evidence enable row level security;
revoke all on table internal.lesson_attendance_evidence from public, anon, authenticated;

create index if not exists lesson_attendance_evidence_occurrence_idx
  on internal.lesson_attendance_evidence (occurrence_id, captured_at desc);

create table if not exists internal.lesson_occurrence_settlements (
  occurrence_id text primary key check (occurrence_id ~ '^.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  idempotency_key text not null unique check (idempotency_key ~ '^lesson-complete:[a-f0-9]{64}$'),
  disposition text not null check (disposition in ('completed', 'abnormal')),
  attendance_reference text references internal.lesson_attendance_evidence(reference),
  override_reason text,
  callback_nonce_sha256 text unique check (callback_nonce_sha256 is null or callback_nonce_sha256 ~ '^[a-f0-9]{64}$'),
  settlement_sha256 text not null check (settlement_sha256 ~ '^[a-f0-9]{64}$'),
  occurrence_version bigint not null check (occurrence_version > 0),
  settled_by text not null check (length(settled_by) between 1 and 120),
  settled_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  check ((attendance_reference is null) <> (override_reason is null))
);

alter table internal.lesson_occurrence_settlements
  add column if not exists callback_nonce_sha256 text;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'internal.lesson_occurrence_settlements'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) ilike '%disposition%'
  loop
    execute format('alter table internal.lesson_occurrence_settlements drop constraint %I', constraint_name);
  end loop;
end;
$$;
update internal.lesson_occurrence_settlements
set disposition = 'completed'
where disposition is null or disposition not in ('completed', 'abnormal');
alter table internal.lesson_occurrence_settlements
  add constraint lesson_occurrence_settlements_disposition_check
    check (disposition in ('completed', 'abnormal')) not valid;
alter table internal.lesson_occurrence_settlements
  drop constraint if exists lesson_occurrence_settlements_callback_nonce_sha256_check;
alter table internal.lesson_occurrence_settlements
  add constraint lesson_occurrence_settlements_callback_nonce_sha256_check
    check (callback_nonce_sha256 is null or callback_nonce_sha256 ~ '^[a-f0-9]{64}$') not valid;

do $$
begin
  if exists (
    select 1
    from internal.lesson_occurrence_settlements
    where callback_nonce_sha256 is not null
    group by callback_nonce_sha256
    having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = 'duplicate_lesson_callback_nonce';
  end if;
end;
$$;

create unique index if not exists lesson_occurrence_settlements_callback_nonce_uidx
  on internal.lesson_occurrence_settlements (callback_nonce_sha256)
  where callback_nonce_sha256 is not null;

alter table internal.lesson_occurrence_settlements enable row level security;
revoke all on table internal.lesson_occurrence_settlements from public, anon, authenticated;

create or replace function public.put_lesson_attendance_evidence(
  p_secret text,
  p_reference text,
  p_occurrence_id text,
  p_captured_at timestamptz,
  p_evidence jsonb,
  p_provider text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.lesson_attendance_evidence%rowtype;
  evidence_hash text;
  audit_entry_id uuid;
  party jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_provider not in ('bbb', 'zoom', 'classin', 'voov', 'manual_import') then
    raise exception using errcode = '42501', message = 'attendance_provider_forbidden';
  end if;
  if coalesce(p_reference, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$'
     or coalesce(p_occurrence_id, '') !~ '^.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or nullif(trim(p_provider), '') is null
     or nullif(trim(p_actor), '') is null
     or p_captured_at is null
     or p_captured_at > now() + interval '5 minutes'
     or jsonb_typeof(p_evidence) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_attendance_evidence';
  end if;

  foreach party in array array[p_evidence -> 'student', p_evidence -> 'teacher']
  loop
    if party is null or party = 'null'::jsonb then
      continue;
    end if;
    if jsonb_typeof(party) <> 'object'
       or jsonb_typeof(party -> 'userId') <> 'string'
       or nullif(trim(party ->> 'userId'), '') is null
       or jsonb_typeof(party -> 'accumulatedSeconds') <> 'number'
       or (party ->> 'accumulatedSeconds')::numeric < 0
       or (
         party ? 'joinLeave'
         and jsonb_typeof(party -> 'joinLeave') <> 'array'
       ) then
      raise exception using errcode = '22023', message = 'invalid_attendance_party';
    end if;
  end loop;

  evidence_hash := encode(extensions.digest(p_evidence::text, 'sha256'), 'hex');

  select * into saved
  from internal.lesson_attendance_evidence e
  where e.reference = p_reference
  for update;

  if found then
    if saved.occurrence_id <> p_occurrence_id
       or saved.provider <> left(trim(p_provider), 80)
       or saved.captured_at <> p_captured_at
       or saved.evidence_sha256 <> evidence_hash then
      raise exception using errcode = '23505', message = 'attendance_reference_conflict';
    end if;
  else
    audit_entry_id := internal.append_operational_contract_audit(
      'lesson.attendance_ingested',
      p_actor,
      'lesson_occurrence',
      p_occurrence_id,
      jsonb_build_object('reference', p_reference, 'provider', left(trim(p_provider), 80))
    );

    insert into internal.lesson_attendance_evidence (
      reference, occurrence_id, provider, captured_at, evidence,
      evidence_sha256, ingested_by, audit_id
    ) values (
      p_reference, p_occurrence_id, left(trim(p_provider), 80), p_captured_at,
      p_evidence, evidence_hash, left(trim(p_actor), 120), audit_entry_id
    )
    returning * into saved;
  end if;

  return jsonb_build_object(
    'reference', saved.reference,
    'occurrenceId', saved.occurrence_id,
    'capturedAt', saved.captured_at,
    'evidence', saved.evidence
  );
end;
$$;

create or replace function public.get_lesson_attendance_evidence(
  p_secret text,
  p_reference text,
  p_occurrence_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  saved internal.lesson_attendance_evidence%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into saved
  from internal.lesson_attendance_evidence e
  where e.reference = p_reference
    and e.occurrence_id = p_occurrence_id;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'reference', saved.reference,
    'occurrenceId', saved.occurrence_id,
    'capturedAt', saved.captured_at,
    'evidence', saved.evidence
  );
end;
$$;

revoke all on function public.put_lesson_attendance_evidence(text, text, text, timestamptz, jsonb, text, text)
  from public, anon, authenticated;
revoke all on function public.get_lesson_attendance_evidence(text, text, text)
  from public, anon, authenticated;
grant execute on function public.put_lesson_attendance_evidence(text, text, text, timestamptz, jsonb, text, text)
  to anon, authenticated;
grant execute on function public.get_lesson_attendance_evidence(text, text, text)
  to anon, authenticated;

create or replace function public.complete_lesson_occurrence_atomic(
  p_secret text,
  p_occurrence_id text,
  p_expected_version bigint,
  p_state_versions jsonb,
  p_idempotency_key text,
  p_settlement jsonb,
  p_attendance_reference text,
  p_override_reason text,
  p_actor text,
  p_callback_nonce_sha256 text
)
returns table (
  occurrence_id text,
  idempotency_key text,
  applied boolean,
  disposition text,
  version bigint,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
<<lesson_settlement>>
declare
  booking_state public.ops_state%rowtype;
  payroll_state public.ops_state%rowtype;
  student_state public.ops_state%rowtype;
  teacher_state public.ops_state%rowtype;
  prior internal.lesson_occurrence_settlements%rowtype;
  attendance_row internal.lesson_attendance_evidence%rowtype;
  series_id text;
  source_date text;
  booking jsonb;
  existing_override jsonb;
  current_student jsonb;
  current_package jsonb;
  current_student_ledger jsonb;
  expected_student_id text;
  expected_teacher_id text;
  expected_package_id text;
  expected_subject_id text;
  expected_lesson_date text;
  expected_start text;
  current_status text;
  recurrence_offset integer;
  lesson_minutes numeric;
  lesson_hours numeric;
  current_consumed numeric;
  purchased_hours numeric;
  deduction jsonb;
  teacher_credit jsonb;
  expected_packages jsonb;
  expected_student_ledger jsonb;
  current_teacher_ledger jsonb;
  expected_teacher_ledger jsonb;
  next_students jsonb;
  next_payroll jsonb;
  next_bookings jsonb;
  next_overrides jsonb;
  completion_audit_id uuid;
  completed_at timestamptz;
  settlement_disposition text;
  attendance_is_normal boolean;
  resolving_abnormal boolean := false;
  replaying_prior boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_occurrence_id, '') !~ '^.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or coalesce(p_idempotency_key, '') !~ '^lesson-complete:[a-f0-9]{64}$'
     or nullif(trim(p_actor), '') is null
     or (p_callback_nonce_sha256 is not null and p_callback_nonce_sha256 !~ '^[a-f0-9]{64}$')
     or jsonb_typeof(p_settlement) <> 'object'
     or (nullif(trim(p_attendance_reference), '') is null)
        = (nullif(trim(p_override_reason), '') is null) then
    raise exception using errcode = '22023', message = 'invalid_lesson_settlement_request';
  end if;

  select * into prior
  from internal.lesson_occurrence_settlements s
  where s.occurrence_id = p_occurrence_id
  for update;

  if found then
    if prior.idempotency_key <> p_idempotency_key then
      raise exception using errcode = '23505', message = 'lesson_occurrence_already_settled';
    end if;
    -- An abnormal provider result is deliberately reviewable.  A later admin
    -- override may turn it into a completed settlement, but an automated
    -- callback can only replay the same nonce/result.
    if prior.disposition = 'abnormal'
       and p_callback_nonce_sha256 is null
       and nullif(trim(p_override_reason), '') is not null then
      resolving_abnormal := true;
    elsif prior.callback_nonce_sha256 is distinct from p_callback_nonce_sha256 then
      raise exception using errcode = '23505', message = 'lesson_callback_nonce_conflict';
    else
      replaying_prior := true;
    end if;
  end if;
  if exists (
    select 1 from internal.lesson_occurrence_settlements s
    where s.idempotency_key = p_idempotency_key
      and s.occurrence_id <> p_occurrence_id
  ) then
    raise exception using errcode = '23505', message = 'lesson_idempotency_key_conflict';
  end if;

  -- Lock every shared entity in a stable order before deriving or writing any
  -- balance.  This makes deduction, payroll credit and occurrence status one
  -- database transaction.
  select * into booking_state from public.ops_state where entity = 'bookings' for update;
  select * into payroll_state from public.ops_state where entity = 'payroll' for update;
  select * into student_state from public.ops_state where entity = 'students' for update;
  select * into teacher_state from public.ops_state where entity = 'teachers' for update;

  if booking_state.entity is null or payroll_state.entity is null or student_state.entity is null
     or teacher_state.entity is null
     or jsonb_typeof(booking_state.payload) <> 'array'
     or jsonb_typeof(payroll_state.payload) <> 'array'
     or jsonb_typeof(student_state.payload) <> 'array'
     or jsonb_typeof(teacher_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'lesson_state_unavailable';
  end if;
  if jsonb_typeof(p_state_versions) <> 'object'
     or coalesce(p_state_versions ->> 'bookings', '') !~ '^[0-9]+$'
     or coalesce(p_state_versions ->> 'payroll', '') !~ '^[0-9]+$'
     or coalesce(p_state_versions ->> 'students', '') !~ '^[0-9]+$'
     or coalesce(p_state_versions ->> 'teachers', '') !~ '^[0-9]+$' then
    raise exception using errcode = '22023', message = 'invalid_state_versions';
  end if;
  if booking_state.version <> p_expected_version
     or booking_state.version <> (p_state_versions ->> 'bookings')::bigint
     or payroll_state.version <> (p_state_versions ->> 'payroll')::bigint
     or student_state.version <> (p_state_versions ->> 'students')::bigint
     or teacher_state.version <> (p_state_versions ->> 'teachers')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  series_id := regexp_replace(p_occurrence_id, ':[0-9]{4}-[0-9]{2}-[0-9]{2}$', '');
  source_date := right(p_occurrence_id, 10);
  if (select count(*) from jsonb_array_elements(booking_state.payload) b where b ->> 'id' = series_id) <> 1 then
    raise exception using errcode = 'P0002', message = 'lesson_booking_not_found';
  end if;
  select b into booking
  from jsonb_array_elements(booking_state.payload) b
  where b ->> 'id' = series_id;

  if jsonb_typeof(coalesce(booking -> 'occurrenceOverrides', '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '55000', message = 'lesson_occurrence_overrides_invalid';
  end if;
  if (select count(*) from jsonb_array_elements(coalesce(booking -> 'occurrenceOverrides', '[]'::jsonb)) o where o ->> 'occurrenceId' = p_occurrence_id) > 1 then
    raise exception using errcode = '23505', message = 'duplicate_lesson_occurrence_override';
  end if;
  select o into existing_override
  from jsonb_array_elements(coalesce(booking -> 'occurrenceOverrides', '[]'::jsonb)) o
  where o ->> 'occurrenceId' = p_occurrence_id;

  expected_student_id := case when existing_override ? 'studentId'
    then nullif(existing_override ->> 'studentId', '') else nullif(booking ->> 'studentId', '') end;
  expected_teacher_id := case when existing_override ? 'teacherId'
    then nullif(existing_override ->> 'teacherId', '') else nullif(booking ->> 'teacherId', '') end;
  expected_package_id := case when existing_override ? 'packageId'
    then nullif(existing_override ->> 'packageId', '') else nullif(booking ->> 'packageId', '') end;
  expected_subject_id := case when existing_override ? 'subjectId'
    then nullif(existing_override ->> 'subjectId', '')
    else coalesce(nullif(booking ->> 'subjectId', ''), nullif(booking ->> 'course', '')) end;
  current_status := coalesce(existing_override ->> 'status', 'confirmed');

  begin
    recurrence_offset := source_date::date - (booking ->> 'date')::date;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_lesson_series_date';
  end;
  if recurrence_offset < 0
     or (
       booking -> 'recurring' is distinct from 'true'::jsonb
       and recurrence_offset <> 0
     )
     or (
       booking -> 'recurring' = 'true'::jsonb
       and recurrence_offset % 7 <> 0
     )
     or (
       booking -> 'recurring' = 'true'::jsonb
       and booking ? 'repeatCount'
       and (
         jsonb_typeof(booking -> 'repeatCount') <> 'number'
         or (booking ->> 'repeatCount')::numeric <> trunc((booking ->> 'repeatCount')::numeric)
         or (booking ->> 'repeatCount')::integer < 1
         or recurrence_offset / 7 >= (booking ->> 'repeatCount')::integer
       )
     ) then
    raise exception using errcode = '22023', message = 'lesson_occurrence_not_in_series';
  end if;

  expected_lesson_date := case when existing_override ? 'date'
    then nullif(existing_override ->> 'date', '') else source_date end;
  expected_start := case when existing_override ? 'start'
    then nullif(existing_override ->> 'start', '') else nullif(booking ->> 'start', '') end;
  begin
    lesson_minutes := case when existing_override ? 'durationMinutes'
      then (existing_override ->> 'durationMinutes')::numeric
      else coalesce(
        (booking ->> 'durationMinutes')::numeric,
        (booking ->> 'duration')::numeric
      ) end;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_lesson_duration';
  end;

  if expected_student_id is null or expected_teacher_id is null
     or expected_package_id is null or expected_subject_id is null
     or expected_lesson_date is null or expected_start is null
     or expected_lesson_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or expected_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or lesson_minutes is null or lesson_minutes <= 0
     or current_status in ('cancelled', 'leave', 'completed') then
    raise exception using errcode = '22023', message = 'lesson_occurrence_not_billable';
  end if;
  if (select count(*) from jsonb_array_elements(student_state.payload) s where s ->> 'id' = expected_student_id) <> 1
     or (select count(*) from jsonb_array_elements(teacher_state.payload) t where t ->> 'id' = expected_teacher_id) <> 1 then
    raise exception using errcode = 'P0002', message = 'lesson_party_not_found';
  end if;
  select s into current_student
  from jsonb_array_elements(student_state.payload) s
  where s ->> 'id' = expected_student_id;
  if current_student ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'archived_student_lesson_read_only';
  end if;
  if replaying_prior then
    return query select
      prior.occurrence_id,
      prior.idempotency_key,
      false,
      prior.disposition,
      prior.occurrence_version,
      prior.audit_id;
    return;
  end if;

  settlement_disposition := p_settlement ->> 'disposition';
  if settlement_disposition is null
     or settlement_disposition not in ('completed', 'abnormal')
     or p_settlement -> 'attendance' ->> 'classification' not in ('normal', 'abnormal') then
    raise exception using errcode = '22023', message = 'invalid_lesson_settlement';
  end if;
  attendance_is_normal := coalesce(p_settlement -> 'attendance' ->> 'classification' = 'normal', false);
  if (settlement_disposition = 'completed' and p_settlement -> 'applied' <> 'true'::jsonb)
     or (settlement_disposition = 'abnormal' and p_settlement -> 'applied' <> 'false'::jsonb)
     or p_settlement -> 'occurrence' ->> 'occurrenceId' <> p_occurrence_id
     or p_settlement -> 'occurrence' ->> 'seriesId' <> series_id
     or p_settlement -> 'occurrence' ->> 'sourceDate' <> source_date
     or p_settlement -> 'occurrence' ->> 'studentId' <> expected_student_id
     or p_settlement -> 'occurrence' ->> 'teacherId' <> expected_teacher_id
     or p_settlement -> 'occurrence' ->> 'packageId' <> expected_package_id
     or p_settlement -> 'occurrence' ->> 'subjectId' <> expected_subject_id
     or p_settlement -> 'occurrence' ->> 'date' <> expected_lesson_date
     or p_settlement -> 'occurrence' ->> 'start' <> expected_start
     or p_settlement -> 'occurrence' ->> 'status' <> settlement_disposition
     or (settlement_disposition = 'completed' and not attendance_is_normal)
     or (settlement_disposition = 'abnormal' and attendance_is_normal)
     or jsonb_typeof(p_settlement -> 'packages') <> 'array'
     or jsonb_typeof(p_settlement -> 'studentHoursLedger') <> 'array'
     or jsonb_typeof(p_settlement -> 'teacherPayrollLedger') <> 'array'
     or jsonb_typeof(p_settlement -> 'occurrence' -> 'scheduledDurationMinutes') <> 'number' then
    raise exception using errcode = '22023', message = 'invalid_lesson_settlement';
  end if;

  if (p_settlement -> 'occurrence' ->> 'scheduledDurationMinutes')::numeric <> lesson_minutes then
    raise exception using errcode = '22023', message = 'lesson_duration_mismatch';
  end if;
  lesson_hours := round(lesson_minutes / 60.0, 6);
  if lesson_minutes <= 0 or lesson_hours <= 0 then
    raise exception using errcode = '22023', message = 'invalid_lesson_duration';
  end if;

  if nullif(trim(p_attendance_reference), '') is not null then
    select * into attendance_row
    from internal.lesson_attendance_evidence e
    where e.reference = p_attendance_reference
      and e.occurrence_id = p_occurrence_id
    for share;
    if not found then
      raise exception using errcode = 'P0002', message = 'attendance_evidence_not_found';
    end if;
    attendance_is_normal := coalesce(attendance_row.evidence -> 'student' ->> 'userId' = expected_student_id
      and attendance_row.evidence -> 'teacher' ->> 'userId' = expected_teacher_id
      and jsonb_typeof(attendance_row.evidence -> 'student' -> 'accumulatedSeconds') = 'number'
      and jsonb_typeof(attendance_row.evidence -> 'teacher' -> 'accumulatedSeconds') = 'number'
      and (attendance_row.evidence -> 'student' ->> 'accumulatedSeconds')::numeric >= greatest(1, lesson_minutes * 60 - 300)
      and (attendance_row.evidence -> 'teacher' ->> 'accumulatedSeconds')::numeric >= greatest(1, lesson_minutes * 60 - 300), false);
    if attendance_is_normal <> (settlement_disposition = 'completed') then
      raise exception using errcode = '22023', message = 'attendance_evidence_classification_mismatch';
    end if;
  else
    if p_actor not in ('Nixon', 'Ops Admin')
       or length(trim(p_override_reason)) not between 8 and 500 then
      raise exception using errcode = '42501', message = 'attendance_override_forbidden';
    end if;
    if settlement_disposition <> 'completed' then
      raise exception using errcode = '22023', message = 'override_must_complete_lesson';
    end if;
  end if;

  -- Abnormal provider evidence is a durable, idempotent business result.  It
  -- updates only the authoritative nested occurrence override and audit; no
  -- package balance or payroll ledger is touched.
  if settlement_disposition = 'abnormal' then
    if p_callback_nonce_sha256 is null or p_actor <> 'BigBlueButton' then
      raise exception using errcode = '42501', message = 'abnormal_provider_callback_required';
    end if;
    if p_settlement -> 'packages' <> coalesce(current_student -> 'lessonPackages', '[]'::jsonb)
       or p_settlement -> 'studentHoursLedger' <> coalesce(current_student -> 'lessonLedger', '[]'::jsonb)
       or p_settlement -> 'teacherPayrollLedger' <> (
         select coalesce(jsonb_agg(e order by ordinal), '[]'::jsonb)
         from jsonb_array_elements(payroll_state.payload) with ordinality as item(e, ordinal)
         where e ->> 'kind' in ('teacher_hours', 'reversal')
       ) then
      raise exception using errcode = '22023', message = 'abnormal_settlement_mutates_financial_state';
    end if;

    if existing_override is null then
      next_overrides := coalesce(booking -> 'occurrenceOverrides', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'status', 'abnormal',
        'settledAt', attendance_row.captured_at,
        'settledBy', left(trim(p_actor), 120),
        'attendanceReference', p_attendance_reference,
        'attendanceReasons', coalesce(p_settlement -> 'attendance' -> 'reasons', '[]'::jsonb)
      ));
    else
      select jsonb_agg(
        case when o ->> 'occurrenceId' = p_occurrence_id then o || jsonb_build_object(
          'status', 'abnormal',
          'settledAt', attendance_row.captured_at,
          'settledBy', left(trim(p_actor), 120),
          'attendanceReference', p_attendance_reference,
          'attendanceReasons', coalesce(p_settlement -> 'attendance' -> 'reasons', '[]'::jsonb)
        ) else o end order by ordinal
      ) into next_overrides
      from jsonb_array_elements(coalesce(booking -> 'occurrenceOverrides', '[]'::jsonb)) with ordinality as item(o, ordinal);
    end if;
    select jsonb_agg(
      case when b ->> 'id' = series_id then jsonb_set(b, '{occurrenceOverrides}', next_overrides, true) else b end
      order by ordinal
    ) into next_bookings
    from jsonb_array_elements(booking_state.payload) with ordinality as item(b, ordinal);
    update public.ops_state s set
      payload = next_bookings,
      version = s.version + 1,
      updated_at = now(),
      updated_by = left(trim(p_actor), 80)
    where s.entity = 'bookings'
    returning s.* into booking_state;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('bookings', booking_state.version, booking_state.updated_by);
    completion_audit_id := internal.append_operational_contract_audit(
      'lesson.attendance_abnormal', p_actor, 'lesson_occurrence', p_occurrence_id,
      jsonb_build_object(
        'studentId', expected_student_id,
        'teacherId', expected_teacher_id,
        'attendanceReference', p_attendance_reference,
        'reasons', coalesce(p_settlement -> 'attendance' -> 'reasons', '[]'::jsonb),
        'bookingsVersionAfter', booking_state.version
      )
    );
    insert into internal.lesson_occurrence_settlements (
      occurrence_id, idempotency_key, disposition, attendance_reference,
      override_reason, callback_nonce_sha256, settlement_sha256, occurrence_version,
      settled_by, settled_at, audit_id
    ) values (
      p_occurrence_id, p_idempotency_key, 'abnormal', p_attendance_reference,
      null, p_callback_nonce_sha256, encode(extensions.digest(p_settlement::text, 'sha256'), 'hex'),
      booking_state.version, left(trim(p_actor), 120), attendance_row.captured_at, completion_audit_id
    );
    return query select p_occurrence_id, p_idempotency_key, true, 'abnormal'::text, booking_state.version, completion_audit_id;
    return;
  end if;

  if (select count(*) from jsonb_array_elements(p_settlement -> 'studentHoursLedger') e
      where e ->> 'kind' = 'deduction' and e ->> 'lessonId' = p_occurrence_id) <> 1
     or (select count(*) from jsonb_array_elements(p_settlement -> 'teacherPayrollLedger') e
      where e ->> 'kind' = 'teacher_hours' and e ->> 'occurrenceId' = p_occurrence_id) <> 1 then
    raise exception using errcode = '22023', message = 'invalid_lesson_ledger_entries';
  end if;
  select e into deduction
  from jsonb_array_elements(p_settlement -> 'studentHoursLedger') e
  where e ->> 'kind' = 'deduction' and e ->> 'lessonId' = p_occurrence_id;
  select e into teacher_credit
  from jsonb_array_elements(p_settlement -> 'teacherPayrollLedger') e
  where e ->> 'kind' = 'teacher_hours' and e ->> 'occurrenceId' = p_occurrence_id;

  if deduction ->> 'id' <> 'student-hours:' || p_occurrence_id
     or deduction ->> 'packageId' <> expected_package_id
     or deduction ->> 'subjectId' <> expected_subject_id
     or jsonb_typeof(deduction -> 'hours') <> 'number'
     or round((deduction ->> 'hours')::numeric, 6) <> lesson_hours
     or teacher_credit ->> 'id' <> 'teacher-hours:' || p_occurrence_id
     or teacher_credit ->> 'teacherId' <> expected_teacher_id
     or teacher_credit ->> 'studentId' <> expected_student_id
     or teacher_credit ->> 'packageId' <> expected_package_id
     or teacher_credit ->> 'subjectId' <> expected_subject_id
     or jsonb_typeof(teacher_credit -> 'payableHours') <> 'number'
     or round((teacher_credit ->> 'payableHours')::numeric, 6) <> lesson_hours
     or deduction ->> 'occurredAt' is distinct from teacher_credit ->> 'occurredAt' then
    raise exception using errcode = '22023', message = 'lesson_ledger_mismatch';
  end if;
  begin
    completed_at := (deduction ->> 'occurredAt')::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_lesson_completion_time';
  end;
  if (p_attendance_reference is not null and completed_at <> attendance_row.captured_at)
     or (p_attendance_reference is null and completed_at > now() + interval '5 minutes') then
    raise exception using errcode = '22023', message = 'lesson_completion_time_mismatch';
  end if;

  if jsonb_typeof(coalesce(current_student -> 'lessonPackages', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(current_student -> 'lessonLedger', '[]'::jsonb)) <> 'array'
     or (select count(*) from jsonb_array_elements(coalesce(current_student -> 'lessonPackages', '[]'::jsonb)) p
         where p ->> 'id' = expected_package_id) <> 1 then
    raise exception using errcode = '55000', message = 'lesson_package_state_invalid';
  end if;
  current_student_ledger := coalesce(current_student -> 'lessonLedger', '[]'::jsonb);
  if exists (
    select 1 from jsonb_array_elements(current_student_ledger) e
    where e ->> 'kind' = 'deduction' and e ->> 'lessonId' = p_occurrence_id
  ) or exists (
    select 1 from jsonb_array_elements(payroll_state.payload) e
    where e ->> 'kind' = 'teacher_hours' and e ->> 'occurrenceId' = p_occurrence_id
  ) then
    raise exception using errcode = '55000', message = 'unregistered_lesson_settlement_exists';
  end if;
  select p into current_package
  from jsonb_array_elements(current_student -> 'lessonPackages') p
  where p ->> 'id' = expected_package_id;
  if jsonb_typeof(coalesce(current_package -> 'purchaseRecords', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(current_package -> 'subjectIds', '[]'::jsonb)) <> 'array'
     or not (coalesce(current_package -> 'subjectIds', '[]'::jsonb) ? expected_subject_id)
     or jsonb_typeof(coalesce(current_package -> 'consumedHours', '0'::jsonb)) <> 'number'
     or exists (
       select 1 from jsonb_array_elements(coalesce(current_package -> 'purchaseRecords', '[]'::jsonb)) p
       where jsonb_typeof(p -> 'hours') <> 'number' or (p ->> 'hours')::numeric <= 0
     ) then
    raise exception using errcode = '55000', message = 'lesson_package_state_invalid';
  end if;
  current_consumed := coalesce((current_package ->> 'consumedHours')::numeric, 0);
  select coalesce(sum((p ->> 'hours')::numeric), 0) into purchased_hours
  from jsonb_array_elements(coalesce(current_package -> 'purchaseRecords', '[]'::jsonb)) p;
  if current_consumed + lesson_hours > purchased_hours then
    raise exception using errcode = '22003', message = 'insufficient_lesson_hours';
  end if;

  select coalesce(jsonb_agg(
    case when p ->> 'id' = expected_package_id
      then jsonb_set(p, '{consumedHours}', to_jsonb(round(current_consumed + lesson_hours, 6)), true)
      else p end order by ordinal
  ), '[]'::jsonb) into expected_packages
  from jsonb_array_elements(current_student -> 'lessonPackages') with ordinality as item(p, ordinal);
  expected_student_ledger := current_student_ledger || jsonb_build_array(deduction);

  select coalesce(jsonb_agg(e order by ordinal), '[]'::jsonb) into current_teacher_ledger
  from jsonb_array_elements(payroll_state.payload) with ordinality as item(e, ordinal)
  where e ->> 'kind' in ('teacher_hours', 'reversal');
  expected_teacher_ledger := current_teacher_ledger || jsonb_build_array(teacher_credit);

  if p_settlement -> 'packages' <> expected_packages
     or p_settlement -> 'studentHoursLedger' <> expected_student_ledger
     or p_settlement -> 'teacherPayrollLedger' <> expected_teacher_ledger then
    raise exception using errcode = '22023', message = 'lesson_settlement_not_derived_from_state';
  end if;

  select jsonb_agg(
    case when s ->> 'id' = expected_student_id
      then jsonb_set(
        jsonb_set(s, '{lessonPackages}', expected_packages, true),
        '{lessonLedger}', expected_student_ledger, true
      ) else s end
    order by ordinal
  ) into next_students
  from jsonb_array_elements(student_state.payload) with ordinality as item(s, ordinal);

  select coalesce(jsonb_agg(e order by group_order, ordinal), '[]'::jsonb) into next_payroll
  from (
    select e, 0 as group_order, ordinal
    from jsonb_array_elements(payroll_state.payload) with ordinality as existing(e, ordinal)
    where coalesce(e ->> 'kind', '') not in ('teacher_hours', 'reversal')
    union all
    select e, 1 as group_order, ordinal
    from jsonb_array_elements(expected_teacher_ledger) with ordinality as ledger(e, ordinal)
  ) merged;

  if existing_override is null then
    next_overrides := coalesce(booking -> 'occurrenceOverrides', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'status', 'completed',
      'settledAt', completed_at,
      'settledBy', left(trim(p_actor), 120),
      'attendanceReference', p_attendance_reference,
      'settlementOverrideReason', p_override_reason
    ));
  else
    select jsonb_agg(
      case when o ->> 'occurrenceId' = p_occurrence_id then (o - 'attendanceReasons') || jsonb_build_object(
        'status', 'completed',
        'settledAt', completed_at,
        'settledBy', left(trim(p_actor), 120),
        'attendanceReference', p_attendance_reference,
        'settlementOverrideReason', p_override_reason
      ) else o end order by ordinal
    ) into next_overrides
    from jsonb_array_elements(coalesce(booking -> 'occurrenceOverrides', '[]'::jsonb)) with ordinality as item(o, ordinal);
  end if;

  select jsonb_agg(
    case when b ->> 'id' = series_id then jsonb_set(b, '{occurrenceOverrides}', next_overrides, true) else b end
    order by ordinal
  ) into next_bookings
  from jsonb_array_elements(booking_state.payload) with ordinality as item(b, ordinal);

  update public.ops_state s set
    payload = next_bookings,
    version = s.version + 1,
    updated_at = now(),
    updated_by = left(trim(p_actor), 80)
  where s.entity = 'bookings'
  returning s.* into booking_state;
  update public.ops_state s set
    payload = next_students,
    version = s.version + 1,
    updated_at = now(),
    updated_by = left(trim(p_actor), 80)
  where s.entity = 'students'
  returning s.* into student_state;
  update public.ops_state s set
    payload = next_payroll,
    version = s.version + 1,
    updated_at = now(),
    updated_by = left(trim(p_actor), 80)
  where s.entity = 'payroll'
  returning s.* into payroll_state;
  insert into public.ops_mutation_log(entity, version, actor) values
    ('bookings', booking_state.version, booking_state.updated_by),
    ('students', student_state.version, student_state.updated_by),
    ('payroll', payroll_state.version, payroll_state.updated_by);

  completion_audit_id := internal.append_operational_contract_audit(
    case when p_attendance_reference is null
      then 'lesson.completed_with_override' else 'lesson.completed_from_attendance' end,
    p_actor,
    'lesson_occurrence',
    p_occurrence_id,
    jsonb_build_object(
      'studentId', expected_student_id,
      'teacherId', expected_teacher_id,
      'packageId', expected_package_id,
      'subjectId', expected_subject_id,
      'hours', lesson_hours,
      'attendanceReference', p_attendance_reference,
      'overrideReason', p_override_reason,
      'stateVersionsBefore', p_state_versions,
      'bookingsVersionAfter', booking_state.version
    )
  );

  if resolving_abnormal then
    update internal.lesson_occurrence_settlements s set
      disposition = 'completed',
      attendance_reference = nullif(trim(p_attendance_reference), ''),
      override_reason = nullif(trim(p_override_reason), ''),
      callback_nonce_sha256 = null,
      settlement_sha256 = encode(extensions.digest(p_settlement::text, 'sha256'), 'hex'),
      occurrence_version = booking_state.version,
      settled_by = left(trim(p_actor), 120),
      settled_at = completed_at,
      audit_id = completion_audit_id
    where s.occurrence_id = p_occurrence_id;
  else
    insert into internal.lesson_occurrence_settlements (
      occurrence_id, idempotency_key, disposition, attendance_reference,
      override_reason, callback_nonce_sha256, settlement_sha256, occurrence_version, settled_by,
      settled_at, audit_id
    ) values (
      p_occurrence_id, p_idempotency_key, 'completed', nullif(trim(p_attendance_reference), ''),
      nullif(trim(p_override_reason), ''), p_callback_nonce_sha256,
      encode(extensions.digest(p_settlement::text, 'sha256'), 'hex'),
      booking_state.version, left(trim(p_actor), 120), completed_at, completion_audit_id
    );
  end if;

  return query select
    p_occurrence_id,
    p_idempotency_key,
    true,
    'completed'::text,
    booking_state.version,
    completion_audit_id;
end;
$$;

revoke all on function public.complete_lesson_occurrence_atomic(text, text, bigint, jsonb, text, jsonb, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_lesson_occurrence_atomic(text, text, bigint, jsonb, text, jsonb, text, text, text, text)
  to anon, authenticated;

create table if not exists internal.student_import_source_rows (
  source_kind text primary key check (source_kind in ('master', 'jwb')),
  source_id text not null check (length(source_id) between 1 and 160),
  revision text not null check (length(revision) between 1 and 240),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  row_count integer not null check (row_count >= 0),
  rows_sha256 text not null check (rows_sha256 ~ '^[a-f0-9]{64}$'),
  ingested_by text not null check (length(ingested_by) between 1 and 120),
  ingested_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  check (jsonb_array_length(rows) = row_count)
);

alter table internal.student_import_source_rows enable row level security;
revoke all on table internal.student_import_source_rows from public, anon, authenticated;

create table if not exists internal.student_import_identity_link_sets (
  singleton boolean primary key default true check (singleton),
  master_source_id text not null check (length(master_source_id) between 1 and 160),
  master_revision text not null check (length(master_revision) between 1 and 240),
  jwb_source_id text not null check (length(jwb_source_id) between 1 and 160),
  jwb_revision text not null check (length(jwb_revision) between 1 and 240),
  students_version bigint not null check (students_version >= 0),
  links jsonb not null check (jsonb_typeof(links) = 'array'),
  link_count integer not null check (link_count >= 0),
  link_fingerprint text not null check (link_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  updated_by text not null check (length(updated_by) between 1 and 120),
  updated_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  check (jsonb_array_length(links) = link_count)
);

alter table internal.student_import_identity_link_sets
  add column if not exists students_version bigint;
update internal.student_import_identity_link_sets
set students_version = coalesce(students_version, 0)
where students_version is null;
alter table internal.student_import_identity_link_sets
  alter column students_version set not null;

alter table internal.student_import_identity_link_sets enable row level security;
revoke all on table internal.student_import_identity_link_sets from public, anon, authenticated;

create table if not exists internal.student_import_master_duplicate_resolutions (
  resolution_key text primary key check (resolution_key ~ '^sha256:[a-f0-9]{64}$'),
  resolution_group_key text not null check (resolution_group_key ~ '^sha256:[a-f0-9]{64}$'),
  master_source_id text not null check (length(master_source_id) between 1 and 160),
  master_revision text not null check (length(master_revision) between 1 and 240),
  students_version bigint not null check (students_version >= 0),
  decision text not null check (decision in ('select', 'ignore')),
  source_rows jsonb not null check (jsonb_typeof(source_rows) = 'array' and jsonb_array_length(source_rows) >= 2),
  selected_source_row jsonb,
  selected_status text check (selected_status is null or selected_status in (
    '在读', '不活跃 + 无课时', '活跃 + 无课时', '活跃 + 有课时',
    '不活跃 + 有课时', '在读 + 加课待排'
  )),
  selected_student_id text,
  confirmed_by text not null check (length(confirmed_by) between 1 and 120),
  confirmed_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  unique (resolution_group_key),
  check (
    (decision = 'ignore' and selected_source_row is null and selected_status is null and selected_student_id is null)
    or (decision = 'select' and selected_source_row is not null)
  )
);

alter table internal.student_import_master_duplicate_resolutions enable row level security;
revoke all on table internal.student_import_master_duplicate_resolutions from public, anon, authenticated;

create table if not exists internal.student_import_commits (
  plan_fingerprint text primary key check (plan_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  master_revision text not null,
  jwb_revision text not null,
  identity_link_fingerprint text not null default ('sha256:' || repeat('0', 64))
    check (identity_link_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  master_duplicate_resolution_fingerprint text not null default ('sha256:' || repeat('0', 64))
    check (master_duplicate_resolution_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  fu_attachment_fingerprint text not null default ('sha256:' || repeat('0', 64))
    check (fu_attachment_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  students_version bigint not null check (students_version > 0),
  students_sha256 text not null check (students_sha256 ~ '^[a-f0-9]{64}$'),
  bookings_version_before bigint not null check (bookings_version_before >= 0),
  bookings_version bigint not null check (bookings_version >= 0),
  bookings_sha256 text not null check (bookings_sha256 ~ '^[a-f0-9]{64}$'),
  committed_by text not null check (length(committed_by) between 1 and 120),
  committed_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.student_import_commits
  add column if not exists identity_link_fingerprint text;
update internal.student_import_commits
set identity_link_fingerprint = 'sha256:' || repeat('0', 64)
where identity_link_fingerprint is null;
alter table internal.student_import_commits
  alter column identity_link_fingerprint set default ('sha256:' || repeat('0', 64));
alter table internal.student_import_commits
  alter column identity_link_fingerprint set not null;
alter table internal.student_import_commits
  add column if not exists master_duplicate_resolution_fingerprint text;
update internal.student_import_commits
set master_duplicate_resolution_fingerprint = 'sha256:' || repeat('0', 64)
where master_duplicate_resolution_fingerprint is null;
alter table internal.student_import_commits
  alter column master_duplicate_resolution_fingerprint set default ('sha256:' || repeat('0', 64));
alter table internal.student_import_commits
  alter column master_duplicate_resolution_fingerprint set not null;
alter table internal.student_import_commits
  add column if not exists fu_attachment_fingerprint text;
update internal.student_import_commits
set fu_attachment_fingerprint = 'sha256:' || repeat('0', 64)
where fu_attachment_fingerprint is null;
alter table internal.student_import_commits
  alter column fu_attachment_fingerprint set default ('sha256:' || repeat('0', 64));
alter table internal.student_import_commits
  alter column fu_attachment_fingerprint set not null;
alter table internal.student_import_commits
  add column if not exists bookings_version_before bigint;
alter table internal.student_import_commits
  add column if not exists bookings_version bigint;
alter table internal.student_import_commits
  add column if not exists bookings_sha256 text;
-- A legacy commit has no trustworthy proof of the bookings result that was
-- produced alongside it.  Backfill an impossible sentinel so a replay fails
-- closed instead of blessing whatever bookings payload happens to exist now.
update internal.student_import_commits
set bookings_version_before = 0,
    bookings_version = 0,
    bookings_sha256 = repeat('0', 64)
where bookings_version_before is null or bookings_version is null or bookings_sha256 is null;
alter table internal.student_import_commits
  alter column bookings_version_before set not null;
alter table internal.student_import_commits
  alter column bookings_version set not null;
alter table internal.student_import_commits
  alter column bookings_sha256 set not null;
alter table internal.student_import_commits
  drop constraint if exists student_import_commits_bookings_version_before_check;
alter table internal.student_import_commits
  add constraint student_import_commits_bookings_version_before_check
  check (bookings_version_before >= 0);
alter table internal.student_import_commits
  drop constraint if exists student_import_commits_bookings_version_check;
alter table internal.student_import_commits
  add constraint student_import_commits_bookings_version_check
  check (bookings_version >= 0);
alter table internal.student_import_commits
  drop constraint if exists student_import_commits_bookings_sha256_check;
alter table internal.student_import_commits
  add constraint student_import_commits_bookings_sha256_check
  check (bookings_sha256 ~ '^[a-f0-9]{64}$');

alter table internal.student_import_commits enable row level security;
revoke all on table internal.student_import_commits from public, anon, authenticated;

alter table internal.student_fu_attachments enable row level security;
revoke all on table internal.student_fu_attachments from public, anon, authenticated;

create or replace function internal.student_fu_attachment_reference_snapshot()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with references as (
    select coalesce(jsonb_agg(student_id order by student_id), '[]'::jsonb) as student_ids
    from (
      select distinct a.student_id
      from internal.student_fu_attachments a
      order by a.student_id
    ) distinct_references
  )
  select jsonb_build_object(
    'studentIds', references.student_ids,
    'fingerprint', 'sha256:' || encode(extensions.digest(
      convert_to('student-fu-attachment-references-v1', 'UTF8')
        || decode('00', 'hex')
        || convert_to(references.student_ids::text, 'UTF8'),
      'sha256'
    ), 'hex')
  )
  from references
$$;

revoke all on function internal.student_fu_attachment_reference_snapshot()
  from public, anon, authenticated;

-- Reinstall the final PDF-capable attachment RPCs here as a production hotfix.
-- Applying this main migration alone must replace the older fail-open versions.
alter table internal.student_fu_attachments
  drop constraint if exists student_fu_attachments_content_type_check;
alter table internal.student_fu_attachments
  add constraint student_fu_attachments_content_type_check
  check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'));

create or replace function public.put_student_fu_attachment(
  p_secret text,
  p_student_id text,
  p_file_name text,
  p_content_type text,
  p_content_base64 text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  decoded bytea;
  saved internal.student_fu_attachments;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(trim(p_student_id), '') is null
     or p_content_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') then
    raise exception using errcode = '22023', message = 'unsupported_attachment_type';
  end if;
  begin
    decoded := decode(p_content_base64, 'base64');
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_attachment_base64';
  end;
  if octet_length(decoded) < 1 or octet_length(decoded) > 4194304 then
    raise exception using errcode = '22023', message = 'attachment_size_out_of_range';
  end if;
  insert into internal.student_fu_attachments (
    student_id, file_name, content_type, byte_size, content, uploaded_by
  ) values (
    left(trim(p_student_id), 120),
    left(coalesce(nullif(trim(p_file_name), ''), 'attachment'), 180),
    p_content_type, octet_length(decoded), decoded,
    left(coalesce(nullif(trim(p_actor), ''), 'unknown'), 120)
  ) returning * into saved;
  return jsonb_build_object(
    'id', saved.id, 'student_id', saved.student_id,
    'file_name', saved.file_name, 'content_type', saved.content_type,
    'byte_size', saved.byte_size, 'uploaded_by', saved.uploaded_by,
    'uploaded_at', saved.uploaded_at
  );
end;
$$;

create or replace function public.get_student_fu_attachment(
  p_secret text,
  p_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.student_fu_attachments;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select * into saved from internal.student_fu_attachments where id = p_id;
  if saved.id is null then return null; end if;
  return jsonb_build_object(
    'id', saved.id, 'student_id', saved.student_id,
    'file_name', saved.file_name, 'content_type', saved.content_type,
    'byte_size', saved.byte_size, 'uploaded_by', saved.uploaded_by,
    'uploaded_at', saved.uploaded_at,
    'content_base64', encode(saved.content, 'base64')
  );
end;
$$;

revoke all on function public.put_student_fu_attachment(text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.get_student_fu_attachment(text, uuid)
  from public, anon, authenticated;
grant execute on function public.put_student_fu_attachment(text, text, text, text, text, text)
  to anon, authenticated;
grant execute on function public.get_student_fu_attachment(text, uuid)
  to anon, authenticated;

create or replace function internal.student_import_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(trim(regexp_replace(
    replace(replace(replace(replace(
      normalize(coalesce(p_name, ''), NFKC),
      chr(8203), ''), chr(8204), ''), chr(8205), ''), chr(65279), ''),
    '[[:space:]　]+', ' ', 'g'
  )), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
$$;

-- Mirrors the JavaScript import identity primitives exactly.  PostgreSQL's
-- text iteration yields Unicode code points, so supplementary characters are
-- split back into the UTF-16 surrogate units consumed by String#charCodeAt.
create or replace function internal.student_import_fnv1a(
  p_value text,
  p_seed bigint
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  hash_value bigint := mod(p_seed, 4294967296::bigint);
  character_value text;
  code_point integer;
  code_unit integer;
  remainder_value integer;
  encoded text := '';
  digits constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
begin
  for character_value in
    select substring(coalesce(p_value, '') from position for 1)
    from generate_series(1, char_length(coalesce(p_value, ''))) position
  loop
    code_point := ascii(character_value);
    if code_point > 65535 then
      code_unit := 55296 + ((code_point - 65536) / 1024);
      hash_value := mod((hash_value # code_unit::bigint) * 16777619::bigint, 4294967296::bigint);
      code_unit := 56320 + mod(code_point - 65536, 1024);
    else
      code_unit := code_point;
    end if;
    hash_value := mod((hash_value # code_unit::bigint) * 16777619::bigint, 4294967296::bigint);
  end loop;

  if hash_value = 0 then
    encoded := '0';
  else
    while hash_value > 0 loop
      remainder_value := mod(hash_value, 36)::integer;
      encoded := substring(digits from remainder_value + 1 for 1) || encoded;
      hash_value := hash_value / 36;
    end loop;
  end if;
  return lpad(encoded, 7, '0');
end;
$$;

-- ECMAScript String#trim whitespace. Source-row text participates in stable
-- cross-runtime IDs, so locale-dependent PostgreSQL trim is not sufficient.
create or replace function internal.student_import_js_trim(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(
    coalesce(p_value, ''),
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32)
      || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194)
      || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199)
      || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233)
      || chr(8239) || chr(8287) || chr(12288) || chr(65279)
  )
$$;

create or replace function internal.student_import_source_key(p_source_row jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case jsonb_typeof(p_source_row)
    when 'number' then case
      when (p_source_row #>> '{}')::numeric = trunc((p_source_row #>> '{}')::numeric)
       and abs((p_source_row #>> '{}')::numeric) <= 9007199254740991
      then trunc((p_source_row #>> '{}')::numeric)::text
      else null end
    when 'string' then internal.student_import_js_trim(p_source_row #>> '{}')
    else null
  end
$$;

-- JWB hour values cross the JavaScript/PostgreSQL boundary.  Restrict source
-- values to exact integer micro-hours so IEEE-754 half ties cannot make the
-- TypeScript and SQL canonical projections disagree.
create or replace function internal.student_import_has_microhour_precision(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) = 'number' then
      (p_value #>> '{}')::numeric =
        trunc((p_value #>> '{}')::numeric * 1000000) / 1000000
      and abs((p_value #>> '{}')::numeric * 1000000) <= 9007199254740991
    else false
  end
$$;

-- PostgreSQL's C collation compares UTF-8 bytes, while JavaScript compares
-- strings by UTF-16 code units. Import output order is part of the exact
-- projection contract, so build a bytewise big-endian UTF-16 sort key.
create or replace function internal.student_import_utf16_sort_key(p_value text)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
declare
  result bytea := ''::bytea;
  character_value text;
  code_point integer;
  high_surrogate integer;
  low_surrogate integer;
begin
  for character_value in
    select substring(coalesce(p_value, '') from position for 1)
    from generate_series(1, char_length(coalesce(p_value, ''))) position
  loop
    code_point := ascii(character_value);
    if code_point > 65535 then
      high_surrogate := 55296 + ((code_point - 65536) / 1024);
      low_surrogate := 56320 + mod(code_point - 65536, 1024);
      result := result || decode(lpad(to_hex(high_surrogate), 4, '0'), 'hex');
      result := result || decode(lpad(to_hex(low_surrogate), 4, '0'), 'hex');
    else
      result := result || decode(lpad(to_hex(code_point), 4, '0'), 'hex');
    end if;
  end loop;
  return result;
end;
$$;

create or replace function internal.student_import_master_source_key(
  p_source_id text,
  p_source_row jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  identity_material text := '[' || to_json(trim(p_source_id))::text || ','
    || to_json(internal.student_import_source_key(p_source_row))::text || ']';
begin
  return 'MSK-N-' || internal.student_import_fnv1a(identity_material, 2166136261)
    || internal.student_import_fnv1a(reverse(identity_material), 2654435769);
end;
$$;

create or replace function internal.student_import_student_id(
  p_source_id text,
  p_source_row jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  master_key text := internal.student_import_master_source_key(p_source_id, p_source_row);
begin
  return 'STU-M-' || internal.student_import_fnv1a(master_key, 2166136261)
    || internal.student_import_fnv1a(reverse(master_key), 2654435769);
end;
$$;

create or replace function internal.student_import_display_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(regexp_replace(
    replace(replace(replace(replace(
      normalize(coalesce(p_name, ''), NFKC),
      chr(8203), ''), chr(8204), ''), chr(8205), ''), chr(65279), ''),
    '[[:space:]　]+', ' ', 'g'
  ))
$$;

create or replace function internal.student_import_is_manual_trial(p_student jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_student ->> 'importSource', '') = 'manual_trial'
    or (
      not (p_student ? 'masterSourceKey')
      and not (p_student ? 'sourceRow')
      and p_student ->> 'segment' = '试听'
    )
$$;

create or replace function internal.student_import_managed_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'id', 'name', 'status', 'sourceRow', 'masterSourceKey', 'importSource',
    'jwbMatchStatus', 'jwbSourceRow', 'remainingHours', 'contractHours',
    'contractEffectiveDate', 'lessonPackages', 'packageCoverage',
    'importArchived', 'importArchivedReason'
  ]::text[]
$$;

create or replace function internal.student_import_copy_unmanaged(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_value) = 'object'
      then p_value - internal.student_import_managed_fields()
    else '{}'::jsonb
  end
$$;

create or replace function internal.student_import_initials(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  clean_name text := internal.student_import_display_name(p_name);
  initials text;
begin
  select case
    when count(*) > 1 then string_agg(left(part, 1), '' order by position)
    else left(clean_name, 2)
  end into initials
  from regexp_split_to_table(clean_name, '[[:space:]]+') with ordinality split(part, position)
  where part <> '';

  -- PostgreSQL left(text, n) counts Unicode characters, so supplementary
  -- characters cannot be split into the invalid UTF-16 halves JS avoids.
  return translate(
    left(coalesce(nullif(initials, ''), '新'), 2),
    'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  );
end;
$$;

create or replace function internal.student_import_defaults(p_student jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  clean_name text := internal.student_import_display_name(p_student ->> 'name');
  clean_location text := case when jsonb_typeof(p_student -> 'location') = 'string'
    then trim(p_student ->> 'location') else '' end;
  clean_year text := case when jsonb_typeof(p_student -> 'year') = 'string'
    then trim(p_student ->> 'year') else '' end;
  location_key text := lower(normalize(clean_location, NFKC));
  timezone_value text := 'Australia/Melbourne';
  defaults jsonb;
begin
  if location_key ~ '(^|[^A-Za-z0-9_])(nsw|act|sydney|canberra)([^A-Za-z0-9_]|$)'
     or location_key ~ '悉尼|堪培拉' then timezone_value := 'Australia/Sydney';
  elsif location_key ~ '(^|[^A-Za-z0-9_])(qld|brisbane)([^A-Za-z0-9_]|$)'
     or location_key ~ '布里斯班' then timezone_value := 'Australia/Brisbane';
  elsif location_key ~ '(^|[^A-Za-z0-9_])(sa|adelaide)([^A-Za-z0-9_]|$)'
     or location_key ~ '阿德莱德' then timezone_value := 'Australia/Adelaide';
  elsif location_key ~ '(^|[^A-Za-z0-9_])(wa|perth)([^A-Za-z0-9_]|$)'
     or location_key ~ '珀斯' then timezone_value := 'Australia/Perth';
  elsif location_key ~ '(^|[^A-Za-z0-9_])(tas|hobart)([^A-Za-z0-9_]|$)'
     or location_key ~ '霍巴特' then timezone_value := 'Australia/Hobart';
  elsif location_key ~ '(^|[^A-Za-z0-9_])(nz|auckland|new zealand)([^A-Za-z0-9_]|$)'
     or location_key ~ '新西兰' then timezone_value := 'Pacific/Auckland';
  elsif location_key ~ '(^|[^A-Za-z0-9_])(china|shanghai)([^A-Za-z0-9_]|$)'
     or location_key ~ '中国|上海' then timezone_value := 'Asia/Shanghai';
  elsif location_key ~ '(^|[^A-Za-z0-9_])argentina([^A-Za-z0-9_]|$)'
     or location_key ~ '阿根廷' then timezone_value := 'America/Argentina/Buenos_Aires';
  elsif location_key ~ '(^|[^A-Za-z0-9_])(bosnia|sarajevo)([^A-Za-z0-9_]|$)'
     or location_key ~ '波斯尼亚' then timezone_value := 'Europe/Sarajevo';
  end if;

  defaults := jsonb_build_object(
    'initials', internal.student_import_initials(clean_name),
    'owner', '待分配', 'planner', '待分配',
    'course', '待确认', 'timezone', timezone_value, 'teacher', '待匹配',
    'next', '核对课程、课包与老师', 'nextTone', 'amber', 'files', 0,
    'segment', '已报名', 'followUp', '未记录'
  );
  if clean_location <> '' then defaults := defaults || jsonb_build_object('location', clean_location); end if;
  if clean_year <> '' then defaults := defaults || jsonb_build_object('grade', clean_year); end if;
  return defaults;
end;
$$;

create or replace function internal.student_import_canonical_manual_trial(p_student jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select internal.student_import_defaults(p_student)
    || p_student
    || jsonb_build_object(
      'status', case
        when jsonb_typeof(p_student -> 'status') = 'string'
         and trim(p_student ->> 'status') <> '' then p_student ->> 'status'
        else '在读 + 加课待排' end,
      'importSource', 'manual_trial'
    )
$$;

create or replace function internal.student_import_canonical_archive(p_student jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select internal.student_import_defaults(p_student)
    || p_student
    || jsonb_build_object(
      'status', '不活跃 + 无课时',
      'next', '历史引用归档，只读',
      'nextTone', 'neutral',
      'importArchived', true,
      'importArchivedReason', 'referenced_history'
    )
$$;

-- Matches the TypeScript stableValue contract used for projection fingerprints.
-- Unlike jsonb::text it distinguishes an omitted value from null and preserves
-- array order while sorting object keys by their C/Unicode code-point order.
create or replace function internal.student_import_stable_value(p_value jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  result text;
begin
  case jsonb_typeof(p_value)
    when 'array' then
      select '[' || coalesce(string_agg(
        internal.student_import_stable_value(item.value), ',' order by item.position
      ), '') || ']'
      into result
      from jsonb_array_elements(p_value) with ordinality item(value, position);
    when 'object' then
      select '{' || coalesce(string_agg(
        to_json(entry.key)::text || ':' || internal.student_import_stable_value(entry.value),
        ',' order by internal.student_import_utf16_sort_key(entry.key)
      ), '') || '}'
      into result
      from jsonb_each(p_value) entry(key, value);
    when 'string' then result := to_json(p_value #>> '{}')::text;
    when 'number' then result := case
      when (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
        then trunc((p_value #>> '{}')::numeric)::text
      else trim(trailing '0' from trim(trailing '.' from (p_value #>> '{}')::numeric::text))
    end;
    else result := p_value::text;
  end case;
  return result;
end;
$$;

-- FNV-1a over two JavaScript strings separated by one NUL code unit. Postgres
-- text cannot store NUL, so this mirrors `${left}\u0000${right}` explicitly.
create or replace function internal.student_import_fnv1a_pair(
  p_left text,
  p_right text,
  p_seed bigint
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  hash_value bigint := mod(p_seed, 4294967296::bigint);
  character_value text;
  code_point integer;
  code_unit integer;
  remainder_value integer;
  encoded text := '';
  digits constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
begin
  for character_value in
    select character_item from (
      select 0 as side, position, substring(coalesce(p_left, '') from position for 1) as character_item
      from generate_series(1, char_length(coalesce(p_left, ''))) position
      union all select 1, 0, null::text
      union all
      select 2, position, substring(coalesce(p_right, '') from position for 1)
      from generate_series(1, char_length(coalesce(p_right, ''))) position
    ) characters order by side, position
  loop
    code_point := coalesce(ascii(character_value), 0);
    if code_point > 65535 then
      code_unit := 55296 + ((code_point - 65536) / 1024);
      hash_value := mod((hash_value # code_unit::bigint) * 16777619::bigint, 4294967296::bigint);
      code_unit := 56320 + mod(code_point - 65536, 1024);
    else
      code_unit := code_point;
    end if;
    hash_value := mod((hash_value # code_unit::bigint) * 16777619::bigint, 4294967296::bigint);
  end loop;
  if hash_value = 0 then encoded := '0';
  else
    while hash_value > 0 loop
      remainder_value := mod(hash_value, 36)::integer;
      encoded := substring(digits from remainder_value + 1 for 1) || encoded;
      hash_value := hash_value / 36;
    end loop;
  end if;
  return lpad(encoded, 7, '0');
end;
$$;

create or replace function internal.student_import_package_id(
  p_student_id text,
  p_source_package_id jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  left_value text := trim(p_student_id);
  right_value text := internal.student_import_source_key(p_source_package_id);
begin
  return 'PKG-JWB-' || internal.student_import_fnv1a_pair(left_value, right_value, 2166136261)
    || internal.student_import_fnv1a_pair(reverse(right_value), reverse(left_value), 2654435769);
end;
$$;

create or replace function internal.student_import_purchase_id(
  p_package_id text,
  p_source_purchase_id jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  left_value text := trim(p_package_id);
  right_value text := internal.student_import_source_key(p_source_purchase_id);
begin
  return 'BUY-JWB-' || internal.student_import_fnv1a_pair(left_value, right_value, 2166136261)
    || internal.student_import_fnv1a_pair(reverse(right_value), reverse(left_value), 2654435769);
end;
$$;

create or replace function internal.student_import_canonical_jwb_packages(
  p_student_id text,
  p_packages jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  package_item record;
  purchase_item record;
  package_value jsonb;
  purchase_value jsonb;
  package_id text;
  source_package_key text;
  source_purchase_key text;
  clean_name text;
  clean_note text;
  purchased_at timestamptz;
  purchased_at_text text;
  result jsonb := '[]'::jsonb;
  purchases jsonb;
  subjects jsonb;
  purchase_total numeric;
  consumed_total numeric;
  remaining_total numeric;
begin
  if jsonb_typeof(p_packages) <> 'array'
     or jsonb_array_length(p_packages) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_student_import_jwb_packages';
  end if;

  for package_item in
    select value, position
    from jsonb_array_elements(p_packages) with ordinality item(value, position)
    order by position
  loop
    package_value := package_item.value;
    source_package_key := internal.student_import_source_key(package_value -> 'sourcePackageId');
    clean_name := internal.student_import_display_name(package_value ->> 'name');
    if jsonb_typeof(package_value) <> 'object'
       or package_value - 'sourcePackageId' - 'name' - 'subjectIds' - 'purchaseRecords' - 'consumedHours' <> '{}'::jsonb
       or source_package_key is null or length(source_package_key) not between 1 and 240
       or jsonb_typeof(package_value -> 'name') <> 'string'
       or clean_name = '' or length(clean_name) > 240
       or jsonb_typeof(package_value -> 'subjectIds') <> 'array'
       or jsonb_array_length(package_value -> 'subjectIds') not between 1 and 100
       or jsonb_typeof(package_value -> 'purchaseRecords') <> 'array'
       or jsonb_array_length(package_value -> 'purchaseRecords') not between 1 and 1000
       or not internal.student_import_has_microhour_precision(package_value -> 'consumedHours')
       or (package_value ->> 'consumedHours')::numeric < 0
       or exists (
         select 1
         from jsonb_array_elements(p_packages) with ordinality duplicate(value, position)
         where duplicate.position <> package_item.position
           and internal.student_import_source_key(duplicate.value -> 'sourcePackageId') = source_package_key
       ) then
      raise exception using errcode = '22023', message = 'invalid_student_import_jwb_package';
    end if;

    select jsonb_agg(to_jsonb(clean_subject) order by subject_position)
    into subjects
    from (
      select internal.student_import_display_name(subject.value #>> '{}') as clean_subject,
        subject.position as subject_position
      from jsonb_array_elements(package_value -> 'subjectIds') with ordinality subject(value, position)
      where jsonb_typeof(subject.value) = 'string'
    ) canonical_subjects
    where clean_subject <> '' and length(clean_subject) <= 240;
    if subjects is null
       or jsonb_array_length(subjects) <> jsonb_array_length(package_value -> 'subjectIds')
       or jsonb_array_length(subjects) <> (
         select count(distinct internal.student_import_display_name(value #>> '{}'))
         from jsonb_array_elements(package_value -> 'subjectIds')
       ) then
      raise exception using errcode = '22023', message = 'invalid_student_import_jwb_subjects';
    end if;

    package_id := internal.student_import_package_id(p_student_id, package_value -> 'sourcePackageId');
    purchases := '[]'::jsonb;
    for purchase_item in
      select value, position
      from jsonb_array_elements(package_value -> 'purchaseRecords') with ordinality item(value, position)
      order by position
    loop
      purchase_value := purchase_item.value;
      source_purchase_key := internal.student_import_source_key(purchase_value -> 'sourcePurchaseId');
      if jsonb_typeof(purchase_value) <> 'object'
         or purchase_value - 'sourcePurchaseId' - 'purchasedAt' - 'hours' - 'note' <> '{}'::jsonb
         or source_purchase_key is null or length(source_purchase_key) not between 1 and 240
         or jsonb_typeof(purchase_value -> 'purchasedAt') <> 'string'
         or not internal.student_import_has_microhour_precision(purchase_value -> 'hours')
         or (purchase_value ->> 'hours')::numeric <= 0
         or (purchase_value ? 'note' and jsonb_typeof(purchase_value -> 'note') <> 'string')
         or length(coalesce(purchase_value ->> 'note', '')) > 1000
         or exists (
           select 1
           from jsonb_array_elements(package_value -> 'purchaseRecords') with ordinality duplicate(value, position)
           where duplicate.position <> purchase_item.position
             and internal.student_import_source_key(duplicate.value -> 'sourcePurchaseId') = source_purchase_key
         ) then
        raise exception using errcode = '22023', message = 'invalid_student_import_jwb_purchase';
      end if;
      begin
        if trim(purchase_value ->> 'purchasedAt') ~ '^\d{4}-\d{2}-\d{2}$' then
          purchased_at := (trim(purchase_value ->> 'purchasedAt') || 'T00:00:00.000Z')::timestamptz;
        elsif trim(purchase_value ->> 'purchasedAt') ~ '^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$' then
          purchased_at := trim(purchase_value ->> 'purchasedAt')::timestamptz;
        else
          raise exception using errcode = '22023', message = 'invalid_student_import_jwb_purchase_date';
        end if;
      exception when others then
        raise exception using errcode = '22023', message = 'invalid_student_import_jwb_purchase_date';
      end;
      purchased_at_text := to_char(
        date_trunc('milliseconds', purchased_at at time zone 'UTC'),
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      );
      clean_note := trim(coalesce(purchase_value ->> 'note', ''));
      purchase_value := jsonb_build_object(
        'id', internal.student_import_purchase_id(package_id, purchase_value -> 'sourcePurchaseId'),
        'purchasedAt', purchased_at_text,
        'hours', (purchase_value ->> 'hours')::numeric
      );
      if clean_note <> '' then
        purchase_value := purchase_value || jsonb_build_object('note', clean_note);
      end if;
      purchases := purchases || jsonb_build_array(purchase_value);
    end loop;

    result := result || jsonb_build_array(jsonb_build_object(
      'id', package_id,
      'name', clean_name,
      'subjectIds', subjects,
      'purchaseRecords', purchases,
      'consumedHours', (package_value ->> 'consumedHours')::numeric
    ));
  end loop;

  select coalesce(sum((purchase.value ->> 'hours')::numeric), 0)
  into purchase_total
  from jsonb_array_elements(result) package(value)
  cross join lateral jsonb_array_elements(package.value -> 'purchaseRecords') purchase(value);
  select coalesce(sum((package.value ->> 'consumedHours')::numeric), 0)
  into consumed_total
  from jsonb_array_elements(result) package(value);
  remaining_total := purchase_total - consumed_total;
  if abs(purchase_total * 1000000) > 9007199254740991
     or abs(consumed_total * 1000000) > 9007199254740991
     or abs(remaining_total * 1000000) > 9007199254740991 then
    raise exception using errcode = '22023', message = 'invalid_student_import_jwb_package_total';
  end if;
  return result;
end;
$$;

create or replace function internal.student_import_package_totals(p_packages jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  contract_total numeric;
  consumed_total numeric;
  remaining_total numeric;
begin
  if jsonb_typeof(coalesce(p_packages, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_student_import_package_totals';
  end if;
  select coalesce(sum((purchase.value ->> 'hours')::numeric), 0)
  into contract_total
  from jsonb_array_elements(coalesce(p_packages, '[]'::jsonb)) package(value)
  cross join lateral jsonb_array_elements(package.value -> 'purchaseRecords') purchase(value);
  select coalesce(sum((package.value ->> 'consumedHours')::numeric), 0)
  into consumed_total
  from jsonb_array_elements(coalesce(p_packages, '[]'::jsonb)) package(value);
  remaining_total := contract_total - consumed_total;
  if abs(contract_total * 1000000) > 9007199254740991
     or abs(consumed_total * 1000000) > 9007199254740991
     or abs(remaining_total * 1000000) > 9007199254740991 then
    raise exception using errcode = '22023', message = 'invalid_student_import_package_total';
  end if;
  return jsonb_build_object(
    'contractHours', contract_total,
    'remainingHours', remaining_total
  );
end;
$$;

create or replace function internal.student_import_canonical_projection(
  p_master_source_id text,
  p_resolved_master_rows jsonb,
  p_jwb_rows jsonb,
  p_current_students jsonb,
  p_identity_links jsonb,
  p_referenced_student_ids jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  master_item record;
  row_value jsonb;
  raw_source_key text;
  master_key text;
  student_id text;
  clean_name text;
  name_key text;
  existing_student jsonb;
  matched_jwb jsonb;
  identity_link jsonb;
  formal_students jsonb := '[]'::jsonb;
  manual_trials jsonb := '[]'::jsonb;
  referenced_archives jsonb := '[]'::jsonb;
  used_student_ids text[] := array[]::text[];
  defaults_input jsonb;
  record_value jsonb;
  existing_packages jsonb;
  manual_packages jsonb;
  existing_jwb_packages jsonb;
  authoritative_packages jsonb;
  jwb_packages jsonb;
  lesson_packages jsonb;
  package_coverage text;
  totals jsonb;
  source_remaining numeric;
  source_contract numeric;
  master_name_count integer;
  jwb_name_count integer;
  linked boolean;
  preserve_existing_aggregate boolean;
begin
  -- These are the complete DB-owned fields stripped from every unmanaged
  -- overlay: 'id', 'name', 'status', 'sourceRow', 'masterSourceKey',
  -- 'importSource', 'jwbMatchStatus', 'jwbSourceRow', 'remainingHours',
  -- 'contractHours', 'contractEffectiveDate', 'lessonPackages',
  -- 'packageCoverage', 'importArchived', 'importArchivedReason'. Master
  -- attributes overlay location, year, owner and planner after existing/JWB
  -- unmanaged values. formal sourceRow order is followed by manual_trial
  -- order by student_id, then referenced_history order by student_id.
  -- Authoritative lessonPackages are delegated to the fail-closed helper,
  -- which derives every student_import_package_id and student_import_purchase_id;
  -- within purchaseRecords it uses WITH ORDINALITY (purchase_position) and
  -- retains the source_position instead of sorting either nested ledger;
  -- each purchaseRecords ledger is paired with the package consumedHours.
  if nullif(trim(p_master_source_id), '') is null
     or jsonb_typeof(p_resolved_master_rows) <> 'array'
     or jsonb_typeof(p_jwb_rows) <> 'array'
     or jsonb_typeof(p_current_students) <> 'array'
     or jsonb_typeof(p_identity_links) <> 'array'
     or jsonb_typeof(p_referenced_student_ids) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_student_import_projection_input';
  end if;

  if (select count(*) from jsonb_array_elements(p_resolved_master_rows)) <>
     (select count(distinct internal.student_import_source_key(row -> 'sourceRow'))
      from jsonb_array_elements(p_resolved_master_rows) row)
     or (select count(*) from jsonb_array_elements(p_jwb_rows)) <>
     (select count(distinct internal.student_import_source_key(row -> 'sourceRow'))
      from jsonb_array_elements(p_jwb_rows) row)
     or exists (
       select 1 from jsonb_array_elements(p_referenced_student_ids) reference
       where jsonb_typeof(reference) <> 'string' or nullif(trim(reference #>> '{}'), '') is null
     ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_projection_keys';
  end if;

  -- Validate every locked JWB package ledger, including unmatched rows. A
  -- malformed nested row can therefore never hide outside the master roster.
  perform internal.student_import_canonical_jwb_packages(
    'STU-JWB-VALIDATION', jwb -> 'lessonPackages'
  )
  from jsonb_array_elements(p_jwb_rows) jwb
  where jwb ? 'lessonPackages';

  if exists (
    select 1 from jsonb_array_elements(p_identity_links) link
    where jsonb_typeof(link) <> 'object'
       or link - 'masterSourceRow' - 'studentId' - 'jwbSourceRow' <> '{}'::jsonb
       or internal.student_import_source_key(link -> 'masterSourceRow') is null
       or jsonb_typeof(link -> 'studentId') <> 'string'
       or nullif(trim(link ->> 'studentId'), '') is null
       or (link ? 'jwbSourceRow' and internal.student_import_source_key(link -> 'jwbSourceRow') is null)
  ) or (
    select count(*) from jsonb_array_elements(p_identity_links)
  ) <> (
    select count(distinct internal.student_import_source_key(link -> 'masterSourceRow'))
    from jsonb_array_elements(p_identity_links) link
  ) or (
    select count(*) from jsonb_array_elements(p_identity_links)
  ) <> (
    select count(distinct trim(link ->> 'studentId'))
    from jsonb_array_elements(p_identity_links) link
  ) or (
    select count(*) from jsonb_array_elements(p_identity_links) link where link ? 'jwbSourceRow'
  ) <> (
    select count(distinct internal.student_import_source_key(link -> 'jwbSourceRow'))
    from jsonb_array_elements(p_identity_links) link where link ? 'jwbSourceRow'
  ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_identity_links';
  end if;

  for master_item in
    select item.value, item.position,
      internal.student_import_source_key(item.value -> 'sourceRow') as source_key
    from jsonb_array_elements(p_resolved_master_rows) with ordinality item(value, position)
    order by internal.student_import_utf16_sort_key(
      internal.student_import_source_key(item.value -> 'sourceRow')
    )
  loop
    row_value := master_item.value;
    raw_source_key := master_item.source_key;
    clean_name := internal.student_import_display_name(row_value ->> 'name');
    if jsonb_typeof(row_value) <> 'object'
       or raw_source_key is null or length(raw_source_key) not between 1 and 240
       or row_value ->> 'status' not in (
         '在读', '不活跃 + 无课时', '活跃 + 无课时', '活跃 + 有课时',
         '不活跃 + 有课时', '在读 + 加课待排'
       ) then
      raise exception using errcode = '22023', message = 'invalid_student_import_master_projection_row';
    end if;
    if clean_name = '' or row_value ->> 'status' = '不活跃 + 无课时' then
      continue;
    end if;
    if (select count(*) from jsonb_array_elements(p_resolved_master_rows) candidate
        where internal.student_import_source_key(candidate -> 'sourceRow') = raw_source_key) <> 1 then
      raise exception using errcode = '22023', message = 'duplicate_student_import_master_source_key';
    end if;

    master_key := internal.student_import_master_source_key(p_master_source_id, row_value -> 'sourceRow');
    student_id := internal.student_import_student_id(p_master_source_id, row_value -> 'sourceRow');
    identity_link := null;
    select link into identity_link
    from jsonb_array_elements(p_identity_links) link
    where internal.student_import_source_key(link -> 'masterSourceRow') = raw_source_key;
    linked := identity_link is not null;
    if linked then
      student_id := trim(identity_link ->> 'studentId');
    end if;

    existing_student := null;
    select student into existing_student
    from jsonb_array_elements(p_current_students) student
    where student ->> 'id' = student_id
      and (linked or (
        student ->> 'masterSourceKey' = master_key
        and student ->> 'id' = internal.student_import_student_id(p_master_source_id, row_value -> 'sourceRow')
      ));
    if linked and existing_student is null then
      raise exception using errcode = '22023', message = 'invalid_student_import_linked_identity';
    end if;

    name_key := internal.student_import_name_key(clean_name);
    matched_jwb := null;
    if linked and identity_link ? 'jwbSourceRow' then
      select jwb into matched_jwb
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_source_key(jwb -> 'sourceRow') =
        internal.student_import_source_key(identity_link -> 'jwbSourceRow');
      if matched_jwb is null then
        raise exception using errcode = '22023', message = 'invalid_student_import_linked_jwb';
      end if;
    elsif not linked then
      select count(*) into master_name_count
      from jsonb_array_elements(p_resolved_master_rows) candidate
      where internal.student_import_display_name(candidate ->> 'name') <> ''
        and candidate ->> 'status' <> '不活跃 + 无课时'
        and internal.student_import_name_key(candidate ->> 'name') = name_key
        and not exists (
          select 1 from jsonb_array_elements(p_identity_links) link
          where internal.student_import_source_key(link -> 'masterSourceRow') =
            internal.student_import_source_key(candidate -> 'sourceRow')
        );
      select count(*) into jwb_name_count
      from jsonb_array_elements(p_jwb_rows) jwb
      where internal.student_import_display_name(jwb ->> 'name') <> ''
        and internal.student_import_name_key(jwb ->> 'name') = name_key
        and not exists (
          select 1 from jsonb_array_elements(p_identity_links) link
          where link ? 'jwbSourceRow'
            and internal.student_import_source_key(link -> 'jwbSourceRow') =
              internal.student_import_source_key(jwb -> 'sourceRow')
        );
      if master_name_count = 1 and jwb_name_count = 1 then
        select jwb into matched_jwb
        from jsonb_array_elements(p_jwb_rows) jwb
        where internal.student_import_name_key(jwb ->> 'name') = name_key
          and not exists (
            select 1 from jsonb_array_elements(p_identity_links) link
            where link ? 'jwbSourceRow'
              and internal.student_import_source_key(link -> 'jwbSourceRow') =
                internal.student_import_source_key(jwb -> 'sourceRow')
          );
      end if;
    else
      master_name_count := 1;
      jwb_name_count := 0;
    end if;

    existing_packages := case when jsonb_typeof(existing_student -> 'lessonPackages') = 'array'
      then existing_student -> 'lessonPackages' else '[]'::jsonb end;
    select coalesce(jsonb_agg(value order by position), '[]'::jsonb) into manual_packages
    from jsonb_array_elements(existing_packages) with ordinality package(value, position)
    where coalesce(value ->> 'id', '') not like 'PKG-JWB-%';
    select coalesce(jsonb_agg(value order by position), '[]'::jsonb) into existing_jwb_packages
    from jsonb_array_elements(existing_packages) with ordinality package(value, position)
    where coalesce(value ->> 'id', '') like 'PKG-JWB-%';

    authoritative_packages := null;
    if matched_jwb is not null and matched_jwb ? 'lessonPackages' then
      authoritative_packages := internal.student_import_canonical_jwb_packages(
        student_id, matched_jwb -> 'lessonPackages'
      );
    end if;
    if matched_jwb is not null and matched_jwb ? 'packageCoverage' then
      package_coverage := matched_jwb ->> 'packageCoverage';
    elsif authoritative_packages is not null and jsonb_array_length(authoritative_packages) > 0 then
      package_coverage := 'complete';
    elsif jsonb_array_length(existing_jwb_packages) > 0 then
      package_coverage := case when existing_student ->> 'packageCoverage' in ('complete', 'partial', 'none')
        then existing_student ->> 'packageCoverage' else 'partial' end;
    elsif existing_student ->> 'packageCoverage' in ('complete', 'partial', 'none') then
      package_coverage := existing_student ->> 'packageCoverage';
    else
      package_coverage := 'none';
    end if;
    preserve_existing_aggregate := matched_jwb is null
      and existing_student ->> 'packageCoverage' in ('partial', 'none');
    if matched_jwb is not null
       and jsonb_typeof(matched_jwb -> 'remainingHours') = 'number'
       and (matched_jwb ->> 'remainingHours')::numeric < 0
       and package_coverage <> 'none' then
      raise exception using errcode = '22023', message = 'student_import_package_balance_mismatch';
    end if;
    if authoritative_packages is not null then
      jwb_packages := authoritative_packages;
    elsif matched_jwb is not null
          and (matched_jwb ? 'packageCoverage' or matched_jwb ? 'lessonPackages') then
      jwb_packages := '[]'::jsonb;
    else
      jwb_packages := existing_jwb_packages;
    end if;
    lesson_packages := manual_packages || jwb_packages;
    -- remainingHours/contractHours are Jiaowubao aggregates. Preserve manual
    -- packages in the visible ledger without adding them to that source total.
    totals := case when jsonb_array_length(jwb_packages) > 0
      then internal.student_import_package_totals(jwb_packages) else null end;
    if authoritative_packages is not null and jsonb_array_length(authoritative_packages) > 0 then
      if package_coverage = 'complete'
         and jsonb_typeof(matched_jwb -> 'remainingHours') = 'number'
         and floor((matched_jwb ->> 'remainingHours')::numeric * 1000000 + 0.5) / 1000000 <>
           (internal.student_import_package_totals(authoritative_packages) ->> 'remainingHours')::numeric then
        raise exception using errcode = '22023', message = 'student_import_package_balance_mismatch';
      end if;
      if package_coverage = 'complete'
         and jsonb_typeof(matched_jwb -> 'contractHours') = 'number'
         and floor((matched_jwb ->> 'contractHours')::numeric * 1000000 + 0.5) / 1000000 <>
           (internal.student_import_package_totals(authoritative_packages) ->> 'contractHours')::numeric then
        raise exception using errcode = '22023', message = 'student_import_package_balance_mismatch';
      end if;
    end if;

    defaults_input := jsonb_build_object('name', clean_name)
      || coalesce(row_value -> 'attributes', '{}'::jsonb);
    record_value := internal.student_import_defaults(defaults_input)
      || internal.student_import_copy_unmanaged(existing_student)
      || internal.student_import_copy_unmanaged(matched_jwb -> 'attributes')
      || internal.student_import_copy_unmanaged(row_value -> 'attributes')
      || jsonb_build_object(
        'id', student_id,
        'name', clean_name,
        'status', row_value ->> 'status',
        'sourceRow', row_value -> 'sourceRow',
        'masterSourceKey', master_key,
        'importSource', 'master',
        'jwbMatchStatus', case
          when not linked and (master_name_count > 1 or jwb_name_count > 1) then 'ambiguous'
          when matched_jwb is not null then 'matched'
          else 'unmatched'
        end
      );
    if matched_jwb is not null then
      record_value := record_value || jsonb_build_object('jwbSourceRow', matched_jwb -> 'sourceRow');
    end if;
    if (matched_jwb is not null and matched_jwb ? 'packageCoverage')
       or jsonb_array_length(jwb_packages) > 0
       or existing_student ->> 'packageCoverage' in ('complete', 'partial', 'none') then
      record_value := record_value || jsonb_build_object('packageCoverage', package_coverage);
    end if;
    source_remaining := case when jsonb_typeof(matched_jwb -> 'remainingHours') = 'number'
      then (matched_jwb ->> 'remainingHours')::numeric
      when preserve_existing_aggregate and jsonb_typeof(existing_student -> 'remainingHours') = 'number'
      then (existing_student ->> 'remainingHours')::numeric
      else null end;
    source_contract := case when jsonb_typeof(matched_jwb -> 'contractHours') = 'number'
      then (matched_jwb ->> 'contractHours')::numeric
      when preserve_existing_aggregate and jsonb_typeof(existing_student -> 'contractHours') = 'number'
      then (existing_student ->> 'contractHours')::numeric
      else null end;
    if source_remaining is not null then
      record_value := record_value || jsonb_build_object('remainingHours', source_remaining);
    elsif totals is not null then
      record_value := record_value || jsonb_build_object('remainingHours', (totals ->> 'remainingHours')::numeric);
    end if;
    if source_contract is not null then
      record_value := record_value || jsonb_build_object('contractHours', source_contract);
    elsif totals is not null then
      record_value := record_value || jsonb_build_object('contractHours', (totals ->> 'contractHours')::numeric);
    end if;
    if matched_jwb is not null
       and jsonb_typeof(matched_jwb -> 'contractEffectiveDate') = 'string'
       and trim(matched_jwb ->> 'contractEffectiveDate') <> '' then
      record_value := record_value || jsonb_build_object(
        'contractEffectiveDate', trim(matched_jwb ->> 'contractEffectiveDate')
      );
    end if;
    if jsonb_array_length(lesson_packages) > 0 then
      record_value := record_value || jsonb_build_object('lessonPackages', lesson_packages);
    end if;
    formal_students := formal_students || jsonb_build_array(record_value);
    used_student_ids := array_append(used_student_ids, student_id);
  end loop;

  select coalesce(jsonb_agg(internal.student_import_canonical_manual_trial(student)
    order by internal.student_import_utf16_sort_key(student ->> 'id')), '[]'::jsonb)
  into manual_trials
  from jsonb_array_elements(p_current_students) student
  where internal.student_import_is_manual_trial(student)
    and not (student ->> 'id' = any(used_student_ids));

  select coalesce(jsonb_agg(internal.student_import_canonical_archive(student)
    order by internal.student_import_utf16_sort_key(student ->> 'id')), '[]'::jsonb)
  into referenced_archives
  from jsonb_array_elements(p_current_students) student
  where student ->> 'id' in (
      select value #>> '{}' from jsonb_array_elements(p_referenced_student_ids) value
    )
    and not (student ->> 'id' = any(used_student_ids))
    and not internal.student_import_is_manual_trial(student);

  record_value := formal_students || manual_trials || referenced_archives;
  if jsonb_array_length(record_value) <>
     (select count(distinct student ->> 'id') from jsonb_array_elements(record_value) student) then
    raise exception using errcode = '22023', message = 'duplicate_student_import_projection_id';
  end if;
  return record_value;
end;
$$;

revoke all on function internal.student_import_fnv1a(text, bigint)
  from public, anon, authenticated;
revoke all on function internal.student_import_js_trim(text)
  from public, anon, authenticated;
revoke all on function internal.student_import_source_key(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_has_microhour_precision(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_utf16_sort_key(text)
  from public, anon, authenticated;
revoke all on function internal.student_import_master_source_key(text, jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_student_id(text, jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_display_name(text)
  from public, anon, authenticated;
revoke all on function internal.student_import_is_manual_trial(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_managed_fields()
  from public, anon, authenticated;
revoke all on function internal.student_import_copy_unmanaged(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_initials(text)
  from public, anon, authenticated;
revoke all on function internal.student_import_defaults(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_canonical_manual_trial(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_canonical_archive(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_stable_value(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_fnv1a_pair(text, text, bigint)
  from public, anon, authenticated;
revoke all on function internal.student_import_package_id(text, jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_purchase_id(text, jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_canonical_jwb_packages(text, jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_package_totals(jsonb)
  from public, anon, authenticated;
revoke all on function internal.student_import_canonical_projection(text, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;

do $$
begin
  if internal.student_import_name_key('ÉLODIE') <> 'Élodie' then
    raise exception 'student_import_name_key_ascii_fold_fixture_mismatch';
  end if;
  if internal.student_import_initials('A 😀') <> 'A😀' then
    raise exception 'student_import_initials_fixture_mismatch';
  end if;
  if internal.student_import_defaults(
       '{"name":"Timezone Learner","location":"澳洲NSW"}'::jsonb
     ) ->> 'timezone' <> 'Australia/Sydney' then
    raise exception 'student_import_timezone_ascii_boundary_fixture_mismatch';
  end if;
  if internal.student_import_source_key('1.5'::jsonb) is not null
     or internal.student_import_source_key('9007199254740992'::jsonb) is not null
     or internal.student_import_source_key('9007199254740991'::jsonb) <> '9007199254740991' then
    raise exception 'student_import_source_key_safe_integer_fixture_mismatch';
  end if;
  if internal.student_import_source_key(to_jsonb(chr(9) || 'ROW-1' || chr(160))) <> 'ROW-1' then
    raise exception 'student_import_source_key_js_trim_fixture_mismatch';
  end if;
  if not internal.student_import_has_microhour_precision('0.000124'::jsonb)
     or not internal.student_import_has_microhour_precision('-8.387851'::jsonb)
     or internal.student_import_has_microhour_precision('0.0001245'::jsonb) then
    raise exception 'student_import_microhour_precision_fixture_mismatch';
  end if;
  if not (
    internal.student_import_utf16_sort_key('😀') <
    internal.student_import_utf16_sort_key(chr(57344))
  ) then
    raise exception 'student_import_utf16_sort_key_fixture_mismatch';
  end if;
  if internal.student_import_package_id('STU-M-ABC', to_jsonb('课程-1'::text)) <>
       'PKG-JWB-1A7NMEV09CSRT7' then
    raise exception 'student_import_package_id_fixture_mismatch';
  end if;
  if internal.student_import_purchase_id(
       'PKG-JWB-1A7NMEV09CSRT7', to_jsonb('合同-1'::text)
     ) <> 'BUY-JWB-0JQMXHD01FSQMP' then
    raise exception 'student_import_purchase_id_fixture_mismatch';
  end if;
  if internal.student_import_stable_value(
       '{"a":1.0,"b":[true,null,"x"]}'::jsonb
     ) <> '{"a":1,"b":[true,null,"x"]}' then
    raise exception 'student_import_stable_value_fixture_mismatch';
  end if;
  if internal.student_import_canonical_jwb_packages(
       'STU-TIMESTAMP',
       '[{"sourcePackageId":"P","name":"Package","subjectIds":["S"],"purchaseRecords":[{"sourcePurchaseId":"B","purchasedAt":"2026-01-02T03:04:05.123999Z","hours":1}],"consumedHours":0}]'::jsonb
     ) #>> '{0,purchaseRecords,0,purchasedAt}' <> '2026-01-02T03:04:05.123Z' then
    raise exception 'student_import_purchase_timestamp_fixture_mismatch';
  end if;
  begin
    perform internal.student_import_canonical_jwb_packages(
      'STU-OVERFLOW',
      '[{"sourcePackageId":"P","name":"Package","subjectIds":["S"],"purchaseRecords":[{"sourcePurchaseId":"B1","purchasedAt":"2026-01-01","hours":9007199254.740991},{"sourcePurchaseId":"B2","purchasedAt":"2026-01-02","hours":9007199254.740991}],"consumedHours":0}]'::jsonb
    );
    raise exception 'student_import_package_aggregate_overflow_fixture_missing';
  exception when sqlstate '22023' then
    if sqlerrm <> 'invalid_student_import_jwb_package_total' then
      raise;
    end if;
  end;
end;
$$;

-- Executable projection fixture. Its inputs and expected value are the exact
-- seven-record golden used by the TypeScript twin: complete, partial, negative
-- aggregate-only, ambiguous duplicate, retained manual trial, two referenced
-- archives, and one unreferenced orphan that must be dropped.
do $$
declare
  projection_result jsonb;
  expected_projection jsonb;
begin
  projection_result := internal.student_import_canonical_projection(
    'fixture-😀',
    '[{"sourceRow":"10","name":"Ａlice　😀","status":"活跃 + 有课时","attributes":{"location":"NSW","year":"Year 8","owner":"master-owner","planner":"master-planner"}},{"sourceRow":"20","name":"Carol","status":"活跃 + 有课时","attributes":{"location":"Perth"}},{"sourceRow":"30","name":"Bob","status":"在读","attributes":{"location":"Melbourne"}},{"sourceRow":"50","name":"Dave","status":"活跃 + 无课时","attributes":{"location":"Brisbane"}}]'::jsonb,
    '[{"sourceRow":"J-A","name":"Alice 😀","remainingHours":6,"contractHours":10,"contractEffectiveDate":"2026-02-01","packageCoverage":"complete","attributes":{"jiaowubaoPackageImport":{"status":"packages_from_current_course_balances","currentTotalHours":10,"currentUsedHours":4,"currentRemainingHours":6,"adjustmentContracts":[]}},"lessonPackages":[{"sourcePackageId":"A-course","name":" 英语 ","subjectIds":["ENG","MATH"],"purchaseRecords":[{"sourcePurchaseId":"A-buy","purchasedAt":"2026-01-02","hours":10,"note":" first "}],"consumedHours":4}]},{"sourceRow":"J-C","name":"Carol","remainingHours":5,"contractHours":8,"packageCoverage":"partial","attributes":{"jiaowubaoPackageImport":{"status":"partial_packages_unresolved_course_balances","currentTotalHours":8,"currentUsedHours":3,"currentRemainingHours":5,"unresolvedCourseBalances":[{"courseId":"C-unresolved","title":"Unresolved","totalHours":2,"usedHours":1,"remainingHours":1}],"adjustmentContracts":[]}},"lessonPackages":[{"sourcePackageId":"C-course","name":"Science","subjectIds":["SCI"],"purchaseRecords":[{"sourcePurchaseId":"C-buy","purchasedAt":"2026-02-02","hours":6}],"consumedHours":2}]},{"sourceRow":"J-B1","name":"Bob","remainingHours":5,"contractHours":8,"packageCoverage":"partial","lessonPackages":[{"sourcePackageId":"B1","name":"B1","subjectIds":["SCI"],"purchaseRecords":[{"sourcePurchaseId":"B1-buy","purchasedAt":"2026-02-02","hours":8}],"consumedHours":3}],"attributes":{"jiaowubaoPackageImport":{"status":"partial_packages_unresolved_course_balances","currentTotalHours":8,"currentUsedHours":3,"currentRemainingHours":5,"unresolvedCourseBalances":[],"adjustmentContracts":[]}}},{"sourceRow":"J-B2","name":"Bob","remainingHours":4,"contractHours":8,"packageCoverage":"partial","lessonPackages":[{"sourcePackageId":"B2","name":"B2","subjectIds":["SCI"],"purchaseRecords":[{"sourcePurchaseId":"B2-buy","purchasedAt":"2026-02-02","hours":8}],"consumedHours":4}],"attributes":{"jiaowubaoPackageImport":{"status":"partial_packages_unresolved_course_balances","currentTotalHours":8,"currentUsedHours":4,"currentRemainingHours":4,"unresolvedCourseBalances":[],"adjustmentContracts":[]}}},{"sourceRow":"J-D","name":"Dave","remainingHours":-2,"contractHours":0,"packageCoverage":"none","attributes":{"jiaowubaoPackageImport":{"status":"aggregate_only_negative_balance","currentTotalHours":0,"currentUsedHours":2,"currentRemainingHours":-2,"adjustmentContracts":[]}}}]'::jsonb,
    '[{"initials":"X","owner":"old-owner","planner":"old-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"old-next","nextTone":"green","files":7,"segment":"VIP","followUp":"old-follow","id":"STU-M-05TOX2H0IZZ4GT","name":"Old A","status":"在读","sourceRow":"10","masterSourceKey":"MSK-N-0QNHCRF1EUF40P","importSource":"master","location":"old-location","grade":"old-grade","custom":"existing","lessonPackages":[{"id":"PKG-MANUAL-Z","name":"Manual","subjectIds":["MAN"],"purchaseRecords":[{"id":"BUY-MANUAL-Z","purchasedAt":"2025-01-01T00:00:00.000Z","hours":2}],"consumedHours":0},{"id":"PKG-JWB-OLD","name":"Old managed","subjectIds":["OLD"],"purchaseRecords":[{"id":"BUY-JWB-OLD","purchasedAt":"2025-01-01T00:00:00.000Z","hours":9}],"consumedHours":1}]},{"initials":"X","owner":"old-owner","planner":"old-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"old-next","nextTone":"green","files":7,"segment":"VIP","followUp":"old-follow","id":"STU-M-19XT7ZV1HRLNSV","name":"Old C","status":"在读","sourceRow":"20","masterSourceKey":"MSK-N-049X92G1N8CFQQ","importSource":"master","lessonPackages":[{"id":"PKG-MANUAL-A","name":"Manual A","subjectIds":["MAN-A"],"purchaseRecords":[{"id":"BUY-MANUAL-A","purchasedAt":"2025-02-01T00:00:00.000Z","hours":3}],"consumedHours":1},{"id":"PKG-JWB-PRESERVE","name":"Preserved managed","subjectIds":["SCI"],"purchaseRecords":[{"id":"BUY-JWB-PRESERVE","purchasedAt":"2025-02-02T00:00:00.000Z","hours":6}],"consumedHours":2}],"packageCoverage":"partial","remainingHours":4,"contractHours":6},{"initials":"X","owner":"old-owner","planner":"old-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"old-next","nextTone":"green","files":7,"segment":"试听","followUp":"old-follow","id":"TRIAL-Z","name":"  Trial　Kid ","status":""},{"initials":"X","owner":"old-owner","planner":"old-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"old-next","nextTone":"green","files":7,"segment":"VIP","followUp":"old-follow","id":"LEGACY-OVERRIDE","name":" Legacy Override ","status":"在读"},{"initials":"X","owner":"old-owner","planner":"old-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"old-next","nextTone":"green","files":7,"segment":"VIP","followUp":"old-follow","id":"LEGACY-FU","name":"Legacy FU","status":"在读"},{"initials":"X","owner":"old-owner","planner":"old-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"old-next","nextTone":"green","files":7,"segment":"VIP","followUp":"old-follow","id":"DROP-ME","name":"Drop Me","status":"在读"}]'::jsonb,
    '[]'::jsonb,
    '["LEGACY-OVERRIDE","LEGACY-FU"]'::jsonb
  );
  expected_projection := '[{"initials":"X","owner":"master-owner","planner":"master-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"old-next","nextTone":"green","files":7,"segment":"VIP","followUp":"old-follow","location":"NSW","grade":"old-grade","custom":"existing","jiaowubaoPackageImport":{"status":"packages_from_current_course_balances","currentTotalHours":10,"currentUsedHours":4,"currentRemainingHours":6,"adjustmentContracts":[]},"year":"Year 8","id":"STU-M-05TOX2H0IZZ4GT","name":"Alice 😀","status":"活跃 + 有课时","sourceRow":"10","masterSourceKey":"MSK-N-0QNHCRF1EUF40P","importSource":"master","jwbMatchStatus":"matched","jwbSourceRow":"J-A","packageCoverage":"complete","remainingHours":6,"contractHours":10,"contractEffectiveDate":"2026-02-01","lessonPackages":[{"id":"PKG-MANUAL-Z","name":"Manual","subjectIds":["MAN"],"purchaseRecords":[{"id":"BUY-MANUAL-Z","purchasedAt":"2025-01-01T00:00:00.000Z","hours":2}],"consumedHours":0},{"id":"PKG-JWB-0N2052J1KRWI9R","name":"英语","subjectIds":["ENG","MATH"],"purchaseRecords":[{"id":"BUY-JWB-1R07RJW1S1PPEY","purchasedAt":"2026-01-02T00:00:00.000Z","hours":10,"note":"first"}],"consumedHours":4}]},{"initials":"X","owner":"old-owner","planner":"old-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"old-next","nextTone":"green","files":7,"segment":"VIP","followUp":"old-follow","location":"Perth","id":"STU-M-19XT7ZV1HRLNSV","name":"Carol","status":"活跃 + 有课时","sourceRow":"20","masterSourceKey":"MSK-N-049X92G1N8CFQQ","importSource":"master","jwbMatchStatus":"matched","jwbSourceRow":"J-C","packageCoverage":"partial","remainingHours":5,"contractHours":8,"jiaowubaoPackageImport":{"status":"partial_packages_unresolved_course_balances","currentTotalHours":8,"currentUsedHours":3,"currentRemainingHours":5,"unresolvedCourseBalances":[{"courseId":"C-unresolved","title":"Unresolved","totalHours":2,"usedHours":1,"remainingHours":1}],"adjustmentContracts":[]},"lessonPackages":[{"id":"PKG-MANUAL-A","name":"Manual A","subjectIds":["MAN-A"],"purchaseRecords":[{"id":"BUY-MANUAL-A","purchasedAt":"2025-02-01T00:00:00.000Z","hours":3}],"consumedHours":1},{"id":"PKG-JWB-1XYDS9Q08QBEVA","name":"Science","subjectIds":["SCI"],"purchaseRecords":[{"id":"BUY-JWB-174K8UK01Z2R4U","purchasedAt":"2026-02-02T00:00:00.000Z","hours":6}],"consumedHours":2}]},{"initials":"BO","owner":"待分配","planner":"待分配","course":"待确认","timezone":"Australia/Melbourne","teacher":"待匹配","next":"核对课程、课包与老师","nextTone":"amber","files":0,"segment":"已报名","followUp":"未记录","location":"Melbourne","id":"STU-M-0K9QYP01BIQ2QY","name":"Bob","status":"在读","sourceRow":"30","masterSourceKey":"MSK-N-1W3RRZ90TCGWIV","importSource":"master","jwbMatchStatus":"ambiguous"},{"initials":"DA","owner":"待分配","planner":"待分配","course":"待确认","timezone":"Australia/Brisbane","teacher":"待匹配","next":"核对课程、课包与老师","nextTone":"amber","files":0,"segment":"已报名","followUp":"未记录","location":"Brisbane","id":"STU-M-0HUB6NB0OW7P1N","name":"Dave","status":"活跃 + 无课时","sourceRow":"50","masterSourceKey":"MSK-N-1QE0DTR0UMDLLP","importSource":"master","jwbMatchStatus":"matched","jwbSourceRow":"J-D","packageCoverage":"none","remainingHours":-2,"contractHours":0,"jiaowubaoPackageImport":{"status":"aggregate_only_negative_balance","currentTotalHours":0,"currentUsedHours":2,"currentRemainingHours":-2,"adjustmentContracts":[]}},{"initials":"X","owner":"old-owner","planner":"old-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"old-next","nextTone":"green","files":7,"segment":"试听","followUp":"old-follow","id":"TRIAL-Z","name":"  Trial　Kid ","status":"在读 + 加课待排","importSource":"manual_trial"},{"initials":"X","owner":"old-owner","planner":"old-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"历史引用归档，只读","nextTone":"neutral","files":7,"segment":"VIP","followUp":"old-follow","id":"LEGACY-FU","name":"Legacy FU","status":"不活跃 + 无课时","importArchived":true,"importArchivedReason":"referenced_history"},{"initials":"X","owner":"old-owner","planner":"old-planner","course":"old-course","timezone":"Pacific/Auckland","teacher":"old-teacher","next":"历史引用归档，只读","nextTone":"neutral","files":7,"segment":"VIP","followUp":"old-follow","id":"LEGACY-OVERRIDE","name":" Legacy Override ","status":"不活跃 + 无课时","importArchived":true,"importArchivedReason":"referenced_history"}]'::jsonb;
  if projection_result is distinct from expected_projection then
    raise exception 'student_import_canonical_projection_fixture_mismatch';
  end if;
end;
$$;

create or replace function internal.student_import_master_duplicate_key(
  p_source_id text,
  p_revision text,
  p_students_version bigint,
  p_source_rows jsonb,
  p_decision text default null,
  p_selected_source_row text default null,
  p_selected_status text default null
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  material bytea := convert_to('student-import-master-duplicate-resolution-v1', 'UTF8') || decode('00', 'hex')
    || convert_to(p_source_id, 'UTF8') || decode('00', 'hex')
    || convert_to(p_revision, 'UTF8') || decode('00', 'hex')
    || convert_to(p_students_version::text, 'UTF8');
  source_row text;
begin
  for source_row in
    select value #>> '{}'
    from jsonb_array_elements(p_source_rows)
    order by internal.student_import_utf16_sort_key(value #>> '{}')
  loop
    material := material || decode('00', 'hex') || convert_to(source_row, 'UTF8');
  end loop;
  if p_decision is not null then material := material || decode('00', 'hex') || convert_to(p_decision, 'UTF8'); end if;
  if p_selected_source_row is not null then material := material || decode('00', 'hex') || convert_to(p_selected_source_row, 'UTF8'); end if;
  if p_selected_status is not null then material := material || decode('00', 'hex') || convert_to(p_selected_status, 'UTF8'); end if;
  return 'sha256:' || encode(extensions.digest(material, 'sha256'), 'hex');
end;
$$;

create or replace function internal.student_import_master_duplicate_candidates(
  p_master internal.student_import_source_rows,
  p_students public.ops_state
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with eligible as (
    select row_item.value as row_value,
      row_item.value -> 'sourceRow' as source_row,
      row_item.value ->> 'sourceRow' as source_row_text,
      trim(coalesce(row_item.value ->> 'status', '')) as status,
      internal.student_import_name_key(row_item.value ->> 'name') as name_key
    from jsonb_array_elements(p_master.rows) row_item(value)
    where internal.student_import_name_key(row_item.value ->> 'name') <> ''
      and trim(coalesce(row_item.value ->> 'status', '')) <> '不活跃 + 无课时'
  ), duplicate_groups as (
    select name_key,
      jsonb_agg(source_row order by internal.student_import_utf16_sort_key(source_row_text)) as source_rows,
      jsonb_agg(row_value order by internal.student_import_utf16_sort_key(source_row_text)) as source_values
    from eligible group by name_key having count(*) > 1
  ), group_options as (
    select g.*,
      internal.student_import_master_duplicate_key(
        p_master.source_id, p_master.revision, p_students.version, g.source_rows
      ) as group_key
    from duplicate_groups g
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'resolutionGroupKey', group_key,
    'sourceRows', source_rows,
    'options', (
      select coalesce(jsonb_agg(option_value order by option_value ->> 'resolutionKey'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'resolutionKey', internal.student_import_master_duplicate_key(
            p_master.source_id, p_master.revision, p_students.version, source_rows,
            'select', source_value ->> 'sourceRow', case when trim(coalesce(source_value ->> 'status', '')) = '' then status_value else null end
          ),
          'decision', 'select',
          'selectedSourceRow', source_value -> 'sourceRow',
          'selectedStatus', case when trim(coalesce(source_value ->> 'status', '')) = '' then to_jsonb(status_value) else null end
        ) as option_value
        from jsonb_array_elements(source_values) source_value
        cross join lateral unnest(case
          when trim(coalesce(source_value ->> 'status', '')) = '' then array[
            '在读', '活跃 + 无课时', '活跃 + 有课时', '不活跃 + 有课时', '在读 + 加课待排'
          ]::text[] else array[null]::text[] end
        ) status_value
        union all
        select jsonb_build_object(
          'resolutionKey', internal.student_import_master_duplicate_key(
            p_master.source_id, p_master.revision, p_students.version, source_rows, 'ignore'
          ),
          'decision', 'ignore'
        )
      ) options
    )
  ) order by group_key), '[]'::jsonb)
  from group_options
$$;

create or replace function internal.student_import_master_duplicate_snapshot(
  p_master internal.student_import_source_rows,
  p_students public.ops_state
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  candidates jsonb := internal.student_import_master_duplicate_candidates(p_master, p_students);
  decisions jsonb;
  fingerprint text;
begin
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'decision', r.decision,
    'sourceRows', r.source_rows,
    'selectedSourceRow', r.selected_source_row,
    'selectedStatus', r.selected_status,
    'selectedStudentId', r.selected_student_id
  )) order by r.resolution_group_key), '[]'::jsonb)
  into decisions
  from internal.student_import_master_duplicate_resolutions r
  where r.master_source_id = p_master.source_id
    and r.master_revision = p_master.revision
    and r.students_version = p_students.version
    and r.selected_student_id is null
    and exists (
      select 1 from jsonb_array_elements(candidates) candidate
      where candidate ->> 'resolutionGroupKey' = r.resolution_group_key
        and exists (
          select 1 from jsonb_array_elements(candidate -> 'options') option
          where option ->> 'resolutionKey' = r.resolution_key
            and option ->> 'decision' = r.decision
        )
    );
  fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', p_master.source_id,
    'masterRevision', p_master.revision,
    'studentsVersion', p_students.version,
    'decisions', decisions
  )::text, 'sha256'), 'hex');
  return jsonb_build_object('decisions', decisions, 'fingerprint', fingerprint, 'candidates', candidates);
end;
$$;

-- Raw source rows are intentionally a distinct server-only ingest contract.
-- The existing ops_source_snapshots rows contain summaries/headers only and
-- therefore cannot safely be promoted into import input by this migration.
create or replace function public.put_student_import_source_rows(
  p_secret text,
  p_source_kind text,
  p_source_id text,
  p_revision text,
  p_rows jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.student_import_source_rows%rowtype;
  rows_hash text;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_source_kind not in ('master', 'jwb')
     or p_actor not in ('Nixon', 'Ops Admin')
     or nullif(trim(p_source_id), '') is null
     or length(trim(p_source_id)) > 160
     or nullif(trim(p_revision), '') is null
     or length(trim(p_revision)) > 240
     or nullif(trim(p_actor), '') is null
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_rows) r
       where jsonb_typeof(r) <> 'object'
          or not (r ? 'sourceRow')
          or jsonb_typeof(r -> 'sourceRow') not in ('string', 'number')
          or nullif(internal.student_import_source_key(r -> 'sourceRow'), '') is null
          or length(internal.student_import_source_key(r -> 'sourceRow')) > 240
          or (
            jsonb_typeof(r -> 'sourceRow') = 'string'
            and r ->> 'sourceRow' <> internal.student_import_source_key(r -> 'sourceRow')
          )
          or jsonb_typeof(r -> 'name') <> 'string'
          or nullif(trim(r ->> 'name'), '') is null
          or length(trim(r ->> 'name')) > 240
          or (
            p_source_kind = 'master'
            and (
              r - 'sourceRow' - 'name' - 'status' - 'attributes' <> '{}'::jsonb
              or trim(coalesce(r ->> 'status', '')) not in (
                '',
                '在读', '不活跃 + 无课时', '活跃 + 无课时', '活跃 + 有课时',
                '不活跃 + 有课时', '在读 + 加课待排'
              )
              or (r ? 'attributes' and jsonb_typeof(r -> 'attributes') <> 'object')
              or (r ? 'attributes' and r -> 'attributes' - 'location' - 'year' - 'owner' - 'planner' <> '{}'::jsonb)
              or exists (
                select 1
                from jsonb_each(coalesce(r -> 'attributes', '{}'::jsonb)) attribute(key, value)
                where jsonb_typeof(attribute.value) <> 'string'
                   or nullif(trim(attribute.value #>> '{}'), '') is null
                   or attribute.value #>> '{}' <> trim(attribute.value #>> '{}')
                   or length(trim(attribute.value #>> '{}')) > 120
              )
            )
          )
          or (
            p_source_kind = 'jwb'
            and (
              r - 'sourceRow' - 'name' - 'remainingHours' - 'contractHours'
                - 'contractEffectiveDate' - 'lessonPackages' - 'packageCoverage' - 'attributes' <> '{}'::jsonb
              or (r ? 'remainingHours' and jsonb_typeof(r -> 'remainingHours') not in ('number', 'null'))
              or (r ? 'remainingHours' and jsonb_typeof(r -> 'remainingHours') = 'number'
                and not internal.student_import_has_microhour_precision(r -> 'remainingHours'))
              or (r ? 'contractHours' and jsonb_typeof(r -> 'contractHours') not in ('number', 'null'))
              or (r ? 'contractHours' and jsonb_typeof(r -> 'contractHours') = 'number'
                and not internal.student_import_has_microhour_precision(r -> 'contractHours'))
              or (r ? 'contractHours' and jsonb_typeof(r -> 'contractHours') = 'number'
                and (r ->> 'contractHours')::numeric < 0)
              or (r ? 'contractEffectiveDate'
                and jsonb_typeof(r -> 'contractEffectiveDate') not in ('string', 'null'))
              or (r ? 'contractEffectiveDate'
                and jsonb_typeof(r -> 'contractEffectiveDate') = 'string'
                and r ->> 'contractEffectiveDate' !~ '^\d{4}-\d{2}-\d{2}$')
              or coalesce(r ->> 'packageCoverage', '') not in ('complete', 'partial', 'none')
              or (r ? 'lessonPackages' and jsonb_typeof(r -> 'lessonPackages') <> 'array')
              or (r ->> 'packageCoverage' in ('complete', 'partial')
                and coalesce(jsonb_array_length(r -> 'lessonPackages'), 0) < 1)
              or (r ->> 'packageCoverage' = 'none'
                and coalesce(jsonb_array_length(r -> 'lessonPackages'), 0) > 0)
              or (
                coalesce((r ->> 'remainingHours')::numeric, 0) < 0
                and (
                  r ->> 'packageCoverage' <> 'none'
                  or coalesce(jsonb_array_length(r -> 'lessonPackages'), 0) <> 0
                )
              )
              or not (r ? 'attributes')
              or jsonb_typeof(r -> 'attributes') <> 'object'
              or r -> 'attributes' - 'jiaowubaoPackageImport' <> '{}'::jsonb
              or jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport') <> 'object'
              or not (r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'status')
              or not (r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'currentTotalHours')
              or not (r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'currentUsedHours')
              or not (r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'currentRemainingHours')
              or not (r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'adjustmentContracts')
              or r -> 'attributes' -> 'jiaowubaoPackageImport'
                - 'status' - 'currentTotalHours' - 'currentUsedHours' - 'currentRemainingHours'
                - 'unresolvedCourseBalances' - 'adjustmentContracts' <> '{}'::jsonb
              or coalesce(r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'status', '') not in (
                'aggregate_only_missing_purchase_history',
                'aggregate_only_negative_adjustment',
                'aggregate_only_negative_balance',
                'aggregate_only_negative_balance_and_adjustment',
                'aggregate_only_no_current_courses',
                'packages_from_current_balances_with_negative_adjustment_audit',
                'packages_from_current_course_balances',
                'partial_packages_unresolved_course_balances'
              )
              or jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentTotalHours') <> 'number'
              or not internal.student_import_has_microhour_precision(
                r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentTotalHours'
              )
              or (r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'currentTotalHours')::numeric < 0
              or jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentUsedHours') <> 'number'
              or not internal.student_import_has_microhour_precision(
                r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentUsedHours'
              )
              or (r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'currentUsedHours')::numeric < 0
              or jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentRemainingHours') <> 'number'
              or not internal.student_import_has_microhour_precision(
                r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'currentRemainingHours'
              )
              or (r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'currentTotalHours')::numeric <>
                (r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'currentUsedHours')::numeric +
                (r -> 'attributes' -> 'jiaowubaoPackageImport' ->> 'currentRemainingHours')::numeric
              or (
                r -> 'attributes' -> 'jiaowubaoPackageImport' ? 'unresolvedCourseBalances'
                and jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'unresolvedCourseBalances') <> 'array'
              )
              or jsonb_array_length(coalesce(
                r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'unresolvedCourseBalances',
                '[]'::jsonb
              )) > 1000
              or exists (
                select 1
                from jsonb_array_elements(coalesce(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'unresolvedCourseBalances',
                  '[]'::jsonb
                )) unresolved
                where jsonb_typeof(unresolved) <> 'object'
                   or unresolved - 'courseId' - 'title' - 'totalHours' - 'usedHours' - 'remainingHours' <> '{}'::jsonb
                   or jsonb_typeof(unresolved -> 'courseId') <> 'string'
                   or nullif(trim(unresolved ->> 'courseId'), '') is null
                   or length(trim(unresolved ->> 'courseId')) > 240
                   or jsonb_typeof(unresolved -> 'title') <> 'string'
                   or nullif(trim(unresolved ->> 'title'), '') is null
                   or length(trim(unresolved ->> 'title')) > 240
                   or jsonb_typeof(unresolved -> 'totalHours') <> 'number'
                   or not internal.student_import_has_microhour_precision(unresolved -> 'totalHours')
                   or (unresolved ->> 'totalHours')::numeric < 0
                   or jsonb_typeof(unresolved -> 'usedHours') <> 'number'
                   or not internal.student_import_has_microhour_precision(unresolved -> 'usedHours')
                   or (unresolved ->> 'usedHours')::numeric < 0
                   or jsonb_typeof(unresolved -> 'remainingHours') <> 'number'
                   or not internal.student_import_has_microhour_precision(unresolved -> 'remainingHours')
                   or (unresolved ->> 'totalHours')::numeric <>
                     (unresolved ->> 'usedHours')::numeric + (unresolved ->> 'remainingHours')::numeric
              )
              or (
                select count(*)
                from jsonb_array_elements(coalesce(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'unresolvedCourseBalances',
                  '[]'::jsonb
                )) unresolved
              ) <> (
                select count(distinct unresolved ->> 'courseId')
                from jsonb_array_elements(coalesce(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'unresolvedCourseBalances',
                  '[]'::jsonb
                )) unresolved
              )
              or jsonb_typeof(r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'adjustmentContracts') <> 'array'
              or jsonb_array_length(
                r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'adjustmentContracts'
              ) > 1000
              or exists (
                select 1
                from jsonb_array_elements(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'adjustmentContracts'
                ) adjustment
                where jsonb_typeof(adjustment) <> 'object'
                   or adjustment - 'contractId' - 'nature' - 'courseId' - 'hoursDelta' <> '{}'::jsonb
                   or jsonb_typeof(adjustment -> 'contractId') <> 'string'
                   or nullif(trim(adjustment ->> 'contractId'), '') is null
                   or length(trim(adjustment ->> 'contractId')) > 240
                   or adjustment ->> 'nature' not in ('退费', '转出')
                   or jsonb_typeof(adjustment -> 'courseId') <> 'string'
                   or nullif(trim(adjustment ->> 'courseId'), '') is null
                   or length(trim(adjustment ->> 'courseId')) > 240
                   or jsonb_typeof(adjustment -> 'hoursDelta') <> 'number'
                   or not internal.student_import_has_microhour_precision(adjustment -> 'hoursDelta')
                   or (adjustment ->> 'hoursDelta')::numeric > 0
              )
              or (
                select count(*)
                from jsonb_array_elements(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'adjustmentContracts'
                ) adjustment
              ) <> (
                select count(distinct adjustment ->> 'contractId')
                from jsonb_array_elements(
                  r -> 'attributes' -> 'jiaowubaoPackageImport' -> 'adjustmentContracts'
                ) adjustment
              )
            )
          )
  ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_source_rows';
  end if;
  if p_source_kind = 'jwb' then
    -- Re-run the nested package canonicalizer at ingest time.  The source row
    -- contract must reject malformed IDs, dates and micro-hour values before
    -- they become locked evidence for a later plan.
    perform internal.student_import_canonical_jwb_packages(
      'STU-JWB-SOURCE-VALIDATION',
      row_value -> 'lessonPackages'
    )
    from jsonb_array_elements(p_rows) row_value
    where row_value ->> 'packageCoverage' in ('complete', 'partial');
  end if;
  if p_source_kind = 'master' and exists (
    select 1 from jsonb_array_elements(p_rows) blank_row
    where trim(coalesce(blank_row ->> 'status', '')) = ''
      and not exists (
        select 1 from jsonb_array_elements(p_rows) sibling
        where sibling ->> 'sourceRow' <> blank_row ->> 'sourceRow'
          and trim(coalesce(sibling ->> 'status', '')) <> '不活跃 + 无课时'
          and internal.student_import_name_key(sibling ->> 'name') =
            internal.student_import_name_key(blank_row ->> 'name')
      )
  ) then
    raise exception using errcode = '22023', message = 'unclosed_blank_student_master_status';
  end if;

  rows_hash := encode(extensions.digest(p_rows::text, 'sha256'), 'hex');

  -- Serialise the first insert as well as later updates for each source kind.
  -- A row lock alone cannot protect an absent row on the initial ingest.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('student_import_source:' || p_source_kind, 0)
  );
  select * into saved
  from internal.student_import_source_rows s
  where s.source_kind = p_source_kind
  for update;

  if found
     and saved.source_id = trim(p_source_id)
     and saved.revision = trim(p_revision)
     and saved.rows_sha256 = rows_hash then
    return jsonb_build_object(
      'sourceKind', saved.source_kind,
      'sourceId', saved.source_id,
      'revision', saved.revision,
      'rowCount', saved.row_count,
      'unchanged', true
    );
  end if;
  if found
     and saved.revision = trim(p_revision)
     and (saved.source_id <> trim(p_source_id) or saved.rows_sha256 <> rows_hash) then
    raise exception using errcode = '23505', message = 'student_import_revision_conflict';
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.source_ingested',
    p_actor,
    'student_import_source',
    p_source_kind,
    jsonb_build_object(
      'sourceId', left(trim(p_source_id), 160),
      'revision', left(trim(p_revision), 240),
      'rowCount', jsonb_array_length(p_rows),
      'rowsSha256', rows_hash
    )
  );

  insert into internal.student_import_source_rows (
    source_kind, source_id, revision, rows, row_count, rows_sha256,
    ingested_by, ingested_at, audit_id
  ) values (
    p_source_kind, left(trim(p_source_id), 160), left(trim(p_revision), 240),
    p_rows, jsonb_array_length(p_rows), rows_hash, left(trim(p_actor), 120),
    now(), audit_entry_id
  )
  on conflict (source_kind) do update set
    source_id = excluded.source_id,
    revision = excluded.revision,
    rows = excluded.rows,
    row_count = excluded.row_count,
    rows_sha256 = excluded.rows_sha256,
    ingested_by = excluded.ingested_by,
    ingested_at = excluded.ingested_at,
    audit_id = excluded.audit_id
  returning * into saved;

  return jsonb_build_object(
    'sourceKind', saved.source_kind,
    'sourceId', saved.source_id,
    'revision', saved.revision,
    'rowCount', saved.row_count,
    'unchanged', false
  );
end;
$$;

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
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into master from internal.student_import_source_rows s where s.source_kind = 'master';
  select * into jwb from internal.student_import_source_rows s where s.source_kind = 'jwb';
  select * into link_set from internal.student_import_identity_link_sets l where l.singleton;
  select * into students_state from public.ops_state s where s.entity = 'students';
  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002', message = 'student_import_source_rows_unavailable';
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

create or replace function public.put_student_import_master_duplicate_resolution(
  p_secret text,
  p_resolution_key text,
  p_decision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  link_set internal.student_import_identity_link_sets%rowtype;
  candidate jsonb;
  option_value jsonb;
  existing internal.student_import_master_duplicate_resolutions%rowtype;
  group_existing internal.student_import_master_duplicate_resolutions%rowtype;
  source_rows jsonb;
  selected_source_row jsonb;
  selected_status text;
  selected_student_id text;
  snapshot jsonb;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_resolution_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_decision not in ('select', 'ignore')
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023', message = 'invalid_student_master_duplicate_resolution_request';
  end if;
  select * into jwb from internal.student_import_source_rows s where s.source_kind = 'jwb' for update;
  select * into master from internal.student_import_source_rows s where s.source_kind = 'master' for update;
  select * into link_set from internal.student_import_identity_link_sets l where l.singleton for update;
  select * into students_state from public.ops_state s where s.entity = 'students' for update;
  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002', message = 'student_import_source_rows_unavailable';
  end if;
  if students_state.entity is null or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  select candidate_item.value, option_item.value
  into candidate, option_value
  from jsonb_array_elements(internal.student_import_master_duplicate_candidates(master, students_state)) candidate_item(value)
  cross join lateral jsonb_array_elements(candidate_item.value -> 'options') option_item(value)
  where option_item.value ->> 'resolutionKey' = p_resolution_key
    and option_item.value ->> 'decision' = p_decision
  limit 1;
  if candidate is null then
    raise exception using errcode = '23503', message = 'student_master_duplicate_resolution_unavailable';
  end if;
  source_rows := candidate -> 'sourceRows';
  selected_source_row := option_value -> 'selectedSourceRow';
  selected_status := option_value ->> 'selectedStatus';
  if p_decision = 'select' then
    select link ->> 'studentId' into selected_student_id
    from jsonb_array_elements(case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and link_set.students_version = students_state.version
       and link_set.link_count = 0
      then link_set.links else '[]'::jsonb end) link
    where link ->> 'masterSourceRow' = selected_source_row #>> '{}'
    order by link ->> 'studentId'
    limit 1;
    if (select count(*) from jsonb_array_elements(case
          when link_set.singleton
           and link_set.master_source_id = master.source_id
           and link_set.master_revision = master.revision
           and link_set.jwb_source_id = jwb.source_id
           and link_set.jwb_revision = jwb.revision
           and link_set.students_version = students_state.version
           and link_set.link_count = 0
          then link_set.links else '[]'::jsonb end) link
        where link ->> 'masterSourceRow' = selected_source_row #>> '{}') > 1 then
      raise exception using errcode = '23503', message = 'student_master_duplicate_identity_unavailable';
    end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student_import_master_duplicate:' || (candidate ->> 'resolutionGroupKey'), 0
  ));
  select * into existing from internal.student_import_master_duplicate_resolutions r
  where r.resolution_key = p_resolution_key for update;
  if found then
    if existing.decision <> p_decision or existing.master_revision <> master.revision
       or existing.students_version <> students_state.version then
      raise exception using errcode = '23505', message = 'student_master_duplicate_resolution_conflict';
    end if;
    snapshot := internal.student_import_master_duplicate_snapshot(master, students_state);
    return jsonb_build_object('resolutionKey', existing.resolution_key, 'decision', existing.decision,
      'fingerprint', snapshot ->> 'fingerprint', 'unchanged', true);
  end if;
  select * into group_existing from internal.student_import_master_duplicate_resolutions r
  where r.resolution_group_key = candidate ->> 'resolutionGroupKey' for update;
  if found then
    raise exception using errcode = '23505', message = 'student_master_duplicate_resolution_conflict';
  end if;
  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.master_duplicate_resolution_confirmed', p_actor,
    'student_import_master_duplicate_resolution', p_resolution_key,
    jsonb_build_object('resolutionKey', p_resolution_key,
      'resolutionGroupKey', candidate ->> 'resolutionGroupKey', 'decision', p_decision,
      'masterSourceId', master.source_id, 'masterRevision', master.revision,
      'studentsVersion', students_state.version, 'sourceRows', source_rows,
      'selectedSourceRow', selected_source_row, 'selectedStatus', selected_status,
      'selectedStudentId', selected_student_id)
  );
  insert into internal.student_import_master_duplicate_resolutions (
    resolution_key, resolution_group_key, master_source_id, master_revision,
    students_version, decision, source_rows, selected_source_row, selected_status,
    selected_student_id, confirmed_by, confirmed_at, audit_id
  ) values (
    p_resolution_key, candidate ->> 'resolutionGroupKey', master.source_id, master.revision,
    students_state.version, p_decision, source_rows, selected_source_row, selected_status,
    selected_student_id, left(trim(p_actor), 120), now(), audit_entry_id
  );
  snapshot := internal.student_import_master_duplicate_snapshot(master, students_state);
  return jsonb_build_object('resolutionKey', p_resolution_key, 'decision', p_decision,
    'fingerprint', snapshot ->> 'fingerprint', 'unchanged', false);
end;
$$;

create or replace function public.put_student_import_identity_links(
  p_secret text,
  p_source_revisions jsonb,
  p_links jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  students_state public.ops_state%rowtype;
  saved internal.student_import_identity_link_sets%rowtype;
  canonical_links jsonb;
  fingerprint text;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor not in ('Nixon', 'Ops Admin')
     or jsonb_typeof(p_source_revisions) <> 'object'
     or p_source_revisions - 'master' - 'jwb' <> '{}'::jsonb
     or jsonb_typeof(p_source_revisions -> 'master') <> 'string'
     or nullif(trim(p_source_revisions ->> 'master'), '') is null
     or length(trim(p_source_revisions ->> 'master')) > 240
     or jsonb_typeof(p_source_revisions -> 'jwb') <> 'string'
     or nullif(trim(p_source_revisions ->> 'jwb'), '') is null
     or length(trim(p_source_revisions ->> 'jwb')) > 240
     or jsonb_typeof(p_links) <> 'array'
     or jsonb_array_length(p_links) <> 0
     or exists (
       select 1 from jsonb_array_elements(p_links) link
       where jsonb_typeof(link) <> 'object'
          or link - 'masterSourceRow' - 'jwbSourceRow' - 'studentId' <> '{}'::jsonb
          or jsonb_typeof(link -> 'masterSourceRow') not in ('string', 'number')
          or nullif(trim(link ->> 'masterSourceRow'), '') is null
          or length(trim(link ->> 'masterSourceRow')) > 240
          or (jsonb_typeof(link -> 'masterSourceRow') = 'number'
            and (
              (link ->> 'masterSourceRow')::numeric <> trunc((link ->> 'masterSourceRow')::numeric)
              or abs((link ->> 'masterSourceRow')::numeric) > 9007199254740991
            ))
          or jsonb_typeof(link -> 'studentId') <> 'string'
          or nullif(trim(link ->> 'studentId'), '') is null
          or length(trim(link ->> 'studentId')) > 240
          or (link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') not in ('string', 'number', 'null'))
          or (link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null'
            and nullif(trim(link ->> 'jwbSourceRow'), '') is null)
          or (link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null'
            and length(trim(link ->> 'jwbSourceRow')) > 240)
          or (jsonb_typeof(link -> 'jwbSourceRow') = 'number'
            and (
              (link ->> 'jwbSourceRow')::numeric <> trunc((link ->> 'jwbSourceRow')::numeric)
              or abs((link ->> 'jwbSourceRow')::numeric) > 9007199254740991
            ))
     ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_identity_links';
  end if;

  select * into jwb from internal.student_import_source_rows s where s.source_kind = 'jwb' for update;
  select * into master from internal.student_import_source_rows s where s.source_kind = 'master' for update;
  select * into saved from internal.student_import_identity_link_sets l where l.singleton for update;
  select * into students_state from public.ops_state s where s.entity = 'students' for update;
  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002', message = 'student_import_source_rows_unavailable';
  end if;
  if master.revision <> p_source_revisions ->> 'master'
     or jwb.revision <> p_source_revisions ->> 'jwb' then
    raise exception using errcode = '40001', message = 'student_import_source_changed';
  end if;
  if students_state.entity is null or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  if (select count(*) from jsonb_array_elements(p_links)) <>
       (select count(distinct link ->> 'masterSourceRow') from jsonb_array_elements(p_links) link)
     or (select count(*) from jsonb_array_elements(p_links)
         where value ? 'jwbSourceRow' and jsonb_typeof(value -> 'jwbSourceRow') <> 'null') <>
       (select count(distinct link ->> 'jwbSourceRow') from jsonb_array_elements(p_links) link
        where link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null')
     or (select count(*) from jsonb_array_elements(p_links)) <>
       (select count(distinct link ->> 'studentId') from jsonb_array_elements(p_links) link)
     or exists (
       select 1 from jsonb_array_elements(p_links) link
       where not exists (
         select 1 from jsonb_array_elements(master.rows) source_row
         where source_row ->> 'sourceRow' = link ->> 'masterSourceRow'
           and source_row ->> 'status' <> '不活跃 + 无课时'
       )
       or (link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null' and not exists (
         select 1 from jsonb_array_elements(jwb.rows) source_row
         where source_row ->> 'sourceRow' = link ->> 'jwbSourceRow'
       ))
       or not exists (
         select 1 from jsonb_array_elements(students_state.payload) student
         where student ->> 'id' = link ->> 'studentId'
       )
     ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_identity_link_reference';
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'masterSourceRow', link -> 'masterSourceRow',
    'studentId', trim(link ->> 'studentId'),
    'jwbSourceRow', case
      when link ? 'jwbSourceRow' and jsonb_typeof(link -> 'jwbSourceRow') <> 'null'
      then link -> 'jwbSourceRow' else null end
  )) order by link ->> 'masterSourceRow'), '[]'::jsonb)
  into canonical_links
  from jsonb_array_elements(p_links) link;
  fingerprint := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'masterSourceId', master.source_id,
    'masterRevision', master.revision,
    'jwbSourceId', jwb.source_id,
    'jwbRevision', jwb.revision,
    'links', canonical_links
  )::text, 'sha256'), 'hex');
  if saved.singleton
     and saved.link_fingerprint = fingerprint
     and saved.students_version = students_state.version then
    return jsonb_build_object('fingerprint', fingerprint, 'count', saved.link_count, 'unchanged', true);
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.identity_links_replaced', p_actor, 'student_import_identity_links',
    fingerprint, jsonb_build_object('linkCount', jsonb_array_length(canonical_links))
  );
  insert into internal.student_import_identity_link_sets (
    singleton, master_source_id, master_revision, jwb_source_id, jwb_revision,
    students_version, links, link_count, link_fingerprint, updated_by, updated_at, audit_id
  ) values (
    true, master.source_id, master.revision, jwb.source_id, jwb.revision,
    students_state.version, canonical_links, jsonb_array_length(canonical_links), fingerprint,
    left(trim(p_actor), 120), now(), audit_entry_id
  ) on conflict (singleton) do update set
    master_source_id = excluded.master_source_id,
    master_revision = excluded.master_revision,
    jwb_source_id = excluded.jwb_source_id,
    jwb_revision = excluded.jwb_revision,
    students_version = excluded.students_version,
    links = excluded.links,
    link_count = excluded.link_count,
    link_fingerprint = excluded.link_fingerprint,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at,
    audit_id = excluded.audit_id;
  return jsonb_build_object('fingerprint', fingerprint, 'count', jsonb_array_length(canonical_links), 'unchanged', false);
end;
$$;

revoke all on function public.put_student_import_source_rows(text, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.get_latest_student_import_source_rows(text)
  from public, anon, authenticated;
revoke all on function public.put_student_import_identity_links(text, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.put_student_import_master_duplicate_resolution(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.put_student_import_source_rows(text, text, text, text, jsonb, text)
  to anon, authenticated;
grant execute on function public.get_latest_student_import_source_rows(text)
  to anon, authenticated;
grant execute on function public.put_student_import_identity_links(text, jsonb, jsonb, text)
  to anon, authenticated;
grant execute on function public.put_student_import_master_duplicate_resolution(text, text, text, text)
  to anon, authenticated;

create or replace function public.commit_student_import_plan_atomic(
  p_secret text,
  p_plan_fingerprint text,
  p_expected_student_version bigint,
  p_source_revisions jsonb,
  p_students jsonb,
  p_actor text
)
returns table (
  entity text,
  version bigint,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_state public.ops_state%rowtype;
  duplicate_decision_state public.ops_state%rowtype;
  booking_state public.ops_state%rowtype;
  locked_state public.ops_state%rowtype;
  prior internal.student_import_commits%rowtype;
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  link_set internal.student_import_identity_link_sets%rowtype;
  duplicate_snapshot jsonb;
  fu_attachment_snapshot jsonb;
  resolved_master_rows jsonb;
  referenced_student_ids jsonb;
  expected_students jsonb;
  reference_entities constant text[] := array[
    'bookings', 'files', 'lpItems', 'messages', 'operations',
    'payroll', 'renewals', 'students', 'tasks'
  ];
  referenced_removed_student_id text;
  referenced_removed_package_reference_id text;
  student_item jsonb;
  lesson_package_item jsonb;
  purchase_item jsonb;
  package_total numeric;
  package_consumed numeric;
  booking_item jsonb;
  next_booking jsonb;
  override_item jsonb;
  next_overrides jsonb;
  next_bookings jsonb := '[]'::jsonb;
  matching_package_ids text[];
  override_matching_package_ids text[];
  booking_subject text;
  override_student_id text;
  override_subject text;
  override_effective_date text;
  override_changes_assignment boolean;
  override_is_eligible boolean;
  booking_changed boolean;
  booking_backfilled boolean;
  parent_package_backfilled boolean;
  backfilled_booking_ids jsonb := '[]'::jsonb;
  unresolved_booking_ids jsonb := '[]'::jsonb;
  students_hash text;
  bookings_hash text;
  expected_bookings_version bigint;
  audit_entry_id uuid;
  replaying_prior boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_plan_fingerprint, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_expected_student_version is null or p_expected_student_version < 1
     or p_actor not in ('Nixon', 'Ops Admin')
     or jsonb_typeof(p_source_revisions) <> 'object'
     or p_source_revisions - 'master' - 'jwb' - 'identityLinks'
          - 'masterDuplicateResolutions' - 'fuAttachments' - 'bookingsVersion' <> '{}'::jsonb
     or jsonb_typeof(p_source_revisions -> 'master') <> 'string'
     or nullif(p_source_revisions ->> 'master', '') is null
     or length(trim(p_source_revisions ->> 'master')) > 240
     or jsonb_typeof(p_source_revisions -> 'jwb') <> 'string'
     or nullif(p_source_revisions ->> 'jwb', '') is null
     or length(trim(p_source_revisions ->> 'jwb')) > 240
     or jsonb_typeof(p_source_revisions -> 'identityLinks') <> 'string'
     or coalesce(p_source_revisions ->> 'identityLinks', '') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_source_revisions -> 'masterDuplicateResolutions') <> 'string'
     or coalesce(p_source_revisions ->> 'masterDuplicateResolutions', '') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_source_revisions -> 'fuAttachments') <> 'string'
     or coalesce(p_source_revisions ->> 'fuAttachments', '') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_source_revisions -> 'bookingsVersion') <> 'number'
     or (p_source_revisions ->> 'bookingsVersion')::numeric < 0
     or (p_source_revisions ->> 'bookingsVersion')::numeric <>
       trunc((p_source_revisions ->> 'bookingsVersion')::numeric)
     or (p_source_revisions ->> 'bookingsVersion')::numeric > 9007199254740991
     or jsonb_typeof(p_students) <> 'array'
     or jsonb_array_length(p_students) < 1
     or jsonb_array_length(p_students) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_students) s
       where jsonb_typeof(s) <> 'object'
          or jsonb_typeof(s -> 'id') <> 'string'
          or nullif(trim(s ->> 'id'), '') is null
          or length(trim(s ->> 'id')) > 240
          or jsonb_typeof(s -> 'name') <> 'string'
          or nullif(trim(s ->> 'name'), '') is null
          or length(trim(s ->> 'name')) > 240
          or jsonb_typeof(s -> 'initials') <> 'string'
          or nullif(trim(s ->> 'initials'), '') is null
          or length(trim(s ->> 'initials')) > 24
          or jsonb_typeof(s -> 'owner') <> 'string'
          or nullif(trim(s ->> 'owner'), '') is null
          or length(trim(s ->> 'owner')) > 120
          or jsonb_typeof(s -> 'course') <> 'string'
          or nullif(trim(s ->> 'course'), '') is null
          or length(trim(s ->> 'course')) > 240
          or jsonb_typeof(s -> 'timezone') <> 'string'
          or nullif(trim(s ->> 'timezone'), '') is null
          or length(trim(s ->> 'timezone')) > 120
          or jsonb_typeof(s -> 'teacher') <> 'string'
          or nullif(trim(s ->> 'teacher'), '') is null
          or length(trim(s ->> 'teacher')) > 240
          or jsonb_typeof(s -> 'next') <> 'string'
          or nullif(trim(s ->> 'next'), '') is null
          or length(trim(s ->> 'next')) > 500
          or coalesce(s ->> 'nextTone', '') not in (
            'neutral', 'blue', 'green', 'amber', 'red', 'purple'
          )
          or not (s ? 'files')
          or jsonb_typeof(s -> 'files') <> 'number'
          or (s ->> 'files')::numeric <> trunc((s ->> 'files')::numeric)
          or (s ->> 'files')::numeric < 0
          or (s ->> 'files')::numeric > 1000000
          or (
            coalesce(s ->> 'importSource', '') <> 'manual_trial'
            and coalesce(s ->> 'status', '') not in (
              '在读', '不活跃 + 无课时', '活跃 + 无课时', '活跃 + 有课时',
              '不活跃 + 有课时', '在读 + 加课待排'
            )
          )
          or (
            s ? 'importArchived'
            and (
              jsonb_typeof(s -> 'importArchived') <> 'boolean'
              or (s ->> 'importArchived')::boolean is not true
              or s ->> 'importArchivedReason' <> 'referenced_history'
              or s ->> 'status' <> '不活跃 + 无课时'
            )
          )
          or (not (s ? 'importArchived') and s ? 'importArchivedReason')
     )
     or (select count(*) from jsonb_array_elements(p_students)) <>
        (select count(distinct s ->> 'id') from jsonb_array_elements(p_students) s)
     or exists (
       select 1
       from jsonb_array_elements(p_students) s
       where (s ? 'remainingHours' and jsonb_typeof(s -> 'remainingHours') <> 'number')
          or (s ? 'remainingHours' and s ? 'packageCoverage'
            and not internal.student_import_has_microhour_precision(s -> 'remainingHours'))
          or (s ? 'contractHours' and jsonb_typeof(s -> 'contractHours') <> 'number')
          or (s ? 'contractHours' and s ? 'packageCoverage'
            and not internal.student_import_has_microhour_precision(s -> 'contractHours'))
          or (s ? 'contractHours' and (s ->> 'contractHours')::numeric < 0)
          or (s ? 'packageCoverage'
            and coalesce(s ->> 'packageCoverage', '') not in ('complete', 'partial', 'none'))
          or (s ? 'lessonPackages' and jsonb_typeof(s -> 'lessonPackages') <> 'array')
          or (not (s ? 'packageCoverage') and exists (
            select 1
            from jsonb_array_elements(coalesce(s -> 'lessonPackages', '[]'::jsonb)) covered_package
            where covered_package ->> 'id' like 'PKG-JWB-%'
          ))
          or (s ->> 'packageCoverage' in ('complete', 'partial') and not exists (
            select 1
            from jsonb_array_elements(coalesce(s -> 'lessonPackages', '[]'::jsonb)) covered_package
            where covered_package ->> 'id' like 'PKG-JWB-%'
          ))
          or (s ->> 'packageCoverage' = 'none' and exists (
            select 1
            from jsonb_array_elements(coalesce(s -> 'lessonPackages', '[]'::jsonb)) covered_package
            where covered_package ->> 'id' like 'PKG-JWB-%'
          ))
          or (
            s ? 'remainingHours'
            and (s ->> 'remainingHours')::numeric < 0
            and (
              coalesce(s ->> 'packageCoverage', '') <> 'none'
              or exists (
                select 1
                from jsonb_array_elements(coalesce(s -> 'lessonPackages', '[]'::jsonb)) covered_package
                where covered_package ->> 'id' like 'PKG-JWB-%'
              )
            )
          )
  ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_commit';
  end if;
  expected_bookings_version := (p_source_revisions ->> 'bookingsVersion')::bigint;

  -- Revalidate the complete package ledger at the final database boundary.
  -- The API plan is server-owned, but a bad deploy or forged service request
  -- still must not be able to persist malformed balances or identities.
  for student_item in select value from jsonb_array_elements(p_students)
  loop
    if (select count(*) from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb))) <>
       (select count(distinct lesson_package ->> 'id')
        from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb)) lesson_package) then
      raise exception using errcode = '22023', message = 'invalid_student_import_package_ids';
    end if;
    for lesson_package_item in
      select value from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb))
    loop
      if jsonb_typeof(lesson_package_item) <> 'object'
         or lesson_package_item - 'id' - 'name' - 'subjectIds' - 'purchaseRecords' - 'consumedHours' <> '{}'::jsonb
         or jsonb_typeof(lesson_package_item -> 'id') <> 'string'
         or nullif(trim(lesson_package_item ->> 'id'), '') is null
         or length(trim(lesson_package_item ->> 'id')) > 240
         or jsonb_typeof(lesson_package_item -> 'name') <> 'string'
         or nullif(trim(lesson_package_item ->> 'name'), '') is null
         or length(trim(lesson_package_item ->> 'name')) > 240
         or jsonb_typeof(lesson_package_item -> 'subjectIds') <> 'array'
         or jsonb_array_length(lesson_package_item -> 'subjectIds') < 1
         or jsonb_array_length(lesson_package_item -> 'subjectIds') > 100
         or exists (
           select 1 from jsonb_array_elements(lesson_package_item -> 'subjectIds') subject
           where jsonb_typeof(subject) <> 'string'
              or nullif(trim(subject #>> '{}'), '') is null
              or length(trim(subject #>> '{}')) > 240
         )
         or (select count(*) from jsonb_array_elements(lesson_package_item -> 'subjectIds')) <>
            (select count(distinct trim(subject #>> '{}'))
             from jsonb_array_elements(lesson_package_item -> 'subjectIds') subject)
         or jsonb_typeof(lesson_package_item -> 'purchaseRecords') <> 'array'
         or jsonb_array_length(lesson_package_item -> 'purchaseRecords') < 1
         or jsonb_array_length(lesson_package_item -> 'purchaseRecords') > 1000
         or jsonb_typeof(lesson_package_item -> 'consumedHours') <> 'number'
         or (lesson_package_item ->> 'id' like 'PKG-JWB-%'
           and not internal.student_import_has_microhour_precision(lesson_package_item -> 'consumedHours'))
         or (lesson_package_item ->> 'consumedHours')::numeric < 0 then
        raise exception using errcode = '22023', message = 'invalid_student_import_package';
      end if;
      if (select count(*) from jsonb_array_elements(lesson_package_item -> 'purchaseRecords')) <>
         (select count(distinct purchase ->> 'id')
          from jsonb_array_elements(lesson_package_item -> 'purchaseRecords') purchase) then
        raise exception using errcode = '22023', message = 'invalid_student_import_purchase_ids';
      end if;
      package_total := 0;
      for purchase_item in select value from jsonb_array_elements(lesson_package_item -> 'purchaseRecords')
      loop
        if jsonb_typeof(purchase_item) <> 'object'
           or purchase_item - 'id' - 'purchasedAt' - 'hours' - 'note' <> '{}'::jsonb
           or jsonb_typeof(purchase_item -> 'id') <> 'string'
           or nullif(trim(purchase_item ->> 'id'), '') is null
           or length(trim(purchase_item ->> 'id')) > 240
           or jsonb_typeof(purchase_item -> 'purchasedAt') <> 'string'
           or nullif(trim(purchase_item ->> 'purchasedAt'), '') is null
           or trim(purchase_item ->> 'purchasedAt') !~
             '^(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T[0-2]\d:[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-][0-2]\d:[0-5]\d))$'
           or trim(purchase_item ->> 'purchasedAt')::timestamptz is null
           or jsonb_typeof(purchase_item -> 'hours') <> 'number'
           or (lesson_package_item ->> 'id' like 'PKG-JWB-%'
             and not internal.student_import_has_microhour_precision(purchase_item -> 'hours'))
           or (purchase_item ->> 'hours')::numeric <= 0
           or (purchase_item ? 'note' and jsonb_typeof(purchase_item -> 'note') <> 'string')
           or (purchase_item ? 'note' and length(purchase_item ->> 'note') > 1000) then
          raise exception using errcode = '22023', message = 'invalid_student_import_purchase';
        end if;
        package_total := package_total + (purchase_item ->> 'hours')::numeric;
      end loop;
      package_consumed := (lesson_package_item ->> 'consumedHours')::numeric;
    end loop;
    if student_item ->> 'packageCoverage' = 'complete'
       and coalesce((student_item ->> 'importArchived')::boolean, false) is false then
      select
        coalesce(sum((purchase ->> 'hours')::numeric), 0)
      into package_total
      from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb)) lesson_package
      cross join lateral jsonb_array_elements(lesson_package -> 'purchaseRecords') purchase
      where lesson_package ->> 'id' like 'PKG-JWB-%';
      select coalesce(sum((lesson_package ->> 'consumedHours')::numeric), 0)
      into package_consumed
      from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb)) lesson_package
      where lesson_package ->> 'id' like 'PKG-JWB-%';
      if not (student_item ? 'contractHours')
         or not (student_item ? 'remainingHours')
         or package_total <> (student_item ->> 'contractHours')::numeric
         or package_total - package_consumed <> (student_item ->> 'remainingHours')::numeric then
        raise exception using errcode = '22023', message = 'invalid_student_import_complete_package_balance';
      end if;
    end if;
  end loop;

  -- The attachment table is locked before the idempotency shortcut so even a
  -- replay must prove it was planned against the current distinct student IDs.
  lock table internal.student_fu_attachments in share mode;
  fu_attachment_snapshot := internal.student_fu_attachment_reference_snapshot();
  if fu_attachment_snapshot ->> 'fingerprint' <> p_source_revisions ->> 'fuAttachments' then
    raise exception using errcode = '40001', message = 'student_import_fu_attachments_changed';
  end if;

  select * into prior
  from internal.student_import_commits c
  where c.plan_fingerprint = p_plan_fingerprint
  for update;
  if found then
    if prior.master_revision <> p_source_revisions ->> 'master'
       or prior.jwb_revision <> p_source_revisions ->> 'jwb'
       or prior.identity_link_fingerprint <> p_source_revisions ->> 'identityLinks'
       or prior.master_duplicate_resolution_fingerprint <>
          p_source_revisions ->> 'masterDuplicateResolutions'
       or prior.fu_attachment_fingerprint <> p_source_revisions ->> 'fuAttachments'
       or prior.bookings_version_before <> expected_bookings_version then
      raise exception using errcode = '23505', message = 'student_import_fingerprint_conflict';
    end if;
    -- A matching request is only idempotent after the locked source and
    -- identity evidence below is revalidated.  In particular, an empty
    -- reviewed-link set remains bound to the pre-commit student version; a
    -- same-fingerprint row from another student snapshot is never reusable.
    replaying_prior := true;
  end if;

  -- Stable lock order: attachment table, idempotency row, both source rows,
  -- then every canonical state that can
  -- retain a studentId.  Locking the reference rows makes the orphan check
  -- below part of the same transaction as the students replacement.
  select * into jwb
  from internal.student_import_source_rows s
  where s.source_kind = 'jwb'
  for update;
  select * into master
  from internal.student_import_source_rows s
  where s.source_kind = 'master'
  for update;
  select * into link_set
  from internal.student_import_identity_link_sets l
  where l.singleton
  for update;
  for locked_state in
    select s.*
    from public.ops_state s
    where s.entity = any(reference_entities)
    order by array_position(reference_entities, s.entity)
    for update
  loop
    if jsonb_typeof(locked_state.payload) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'student_reference_state_unavailable';
    end if;
    if locked_state.entity = 'students' then
      current_state := locked_state;
    elsif locked_state.entity = 'bookings' then
      booking_state := locked_state;
    end if;
  end loop;

  if jwb.source_kind is null or master.source_kind is null then
    raise exception using errcode = 'P0002', message = 'student_import_source_rows_unavailable';
  end if;
  if master.revision <> p_source_revisions ->> 'master'
     or jwb.revision <> p_source_revisions ->> 'jwb' then
    raise exception using errcode = '40001', message = 'student_import_source_changed';
  end if;
  if current_state.entity is null or jsonb_typeof(current_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'students_state_unavailable';
  end if;
  if booking_state.entity is null or jsonb_typeof(booking_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'bookings_state_unavailable';
  end if;
  if (case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and link_set.students_version = case
         when replaying_prior then p_expected_student_version
         else current_state.version
       end
       and link_set.link_count = 0
        then link_set.link_fingerprint
        else 'sha256:' || repeat('0', 64)
      end) <> p_source_revisions ->> 'identityLinks' then
    raise exception using errcode = '40001', message = 'student_import_identity_links_changed';
  end if;
  if replaying_prior then
    if current_state.version <> prior.students_version
       or p_expected_student_version + 1 <> prior.students_version
       or encode(extensions.digest(current_state.payload::text, 'sha256'), 'hex') <>
          prior.students_sha256
       or p_students is distinct from current_state.payload
       or booking_state.version <> prior.bookings_version
       or encode(extensions.digest(booking_state.payload::text, 'sha256'), 'hex') <>
          prior.bookings_sha256 then
      raise exception using errcode = '40001', message = 'student_import_idempotent_state_changed';
    end if;
  elsif current_state.version <> p_expected_student_version
     or booking_state.version <> expected_bookings_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  -- Duplicate decisions are intentionally bound to the pre-commit students
  -- version. On a replay, reconstruct that exact decision-evidence version
  -- while retaining the locked post-commit payload for the canonical result
  -- proof below.
  duplicate_decision_state := current_state;
  if replaying_prior then
    duplicate_decision_state.version := p_expected_student_version;
  end if;
  duplicate_snapshot := internal.student_import_master_duplicate_snapshot(master, duplicate_decision_state);
  if duplicate_snapshot ->> 'fingerprint' <>
     p_source_revisions ->> 'masterDuplicateResolutions' then
    raise exception using errcode = '40001', message = 'student_import_master_duplicate_resolutions_changed';
  end if;
  if exists (
    select 1 from jsonb_array_elements(duplicate_snapshot -> 'candidates') candidate
    where not exists (
      select 1 from jsonb_array_elements(duplicate_snapshot -> 'decisions') decision
      where decision -> 'sourceRows' = candidate -> 'sourceRows'
    )
  ) then
    raise exception using errcode = '23503', message = 'student_import_master_duplicate_resolution_required';
  end if;
  select coalesce(jsonb_agg(resolved_row order by resolved_row ->> 'sourceRow'), '[]'::jsonb)
  into resolved_master_rows
  from (
    select case
      when decision ->> 'decision' = 'select'
       and row_value ->> 'sourceRow' = decision ->> 'selectedSourceRow'
       and nullif(decision ->> 'selectedStatus', '') is not null
      then jsonb_set(row_value, '{status}', to_jsonb(decision ->> 'selectedStatus'), true)
      else row_value end as resolved_row
    from jsonb_array_elements(master.rows) row_value
    left join lateral (
      select d.value as decision
      from jsonb_array_elements(duplicate_snapshot -> 'decisions') d(value)
      where exists (
        select 1 from jsonb_array_elements_text(d.value -> 'sourceRows') source_row
        where source_row = row_value ->> 'sourceRow'
      )
      limit 1
    ) matched on true
    where matched.decision is null
       or (matched.decision ->> 'decision' = 'select'
           and row_value ->> 'sourceRow' = matched.decision ->> 'selectedSourceRow')
  ) resolved;

  -- Build the archive preservation input exclusively from rows locked above.
  -- Booking occurrence overrides may carry a different student from the
  -- parent series, so both identities are independently retained.
  -- Canonical shape: jsonb_array_elements(bookings.occurrenceOverrides)
  -- exposes each override.studentId (implemented below with a guarded CASE).
  select coalesce(jsonb_agg(to_jsonb(reference.student_id)
    order by reference.student_id collate "C"), '[]'::jsonb)
  into referenced_student_ids
  from (
    select distinct referenced.student_id
    from (
      select trim(reference_item ->> 'studentId') as student_id
      from public.ops_state reference_state
      cross join lateral jsonb_array_elements(reference_state.payload) reference_item
      where reference_state.entity = any(reference_entities)
        and reference_state.entity <> 'students'

      union

      select trim(occurrence_override ->> 'studentId') as student_id
      from jsonb_array_elements(booking_state.payload) booking
      cross join lateral jsonb_array_elements(case
        when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
          then booking -> 'occurrenceOverrides'
        else '[]'::jsonb
      end) occurrence_override

      union

      select trim(attachment.student_id) as student_id
      from internal.student_fu_attachments attachment
    ) referenced
    where nullif(referenced.student_id, '') is not null
  ) reference;

  expected_students := internal.student_import_canonical_projection(
    master.source_id,
    resolved_master_rows,
    jwb.rows,
    current_state.payload,
    case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and link_set.students_version = current_state.version
      then link_set.links else '[]'::jsonb end,
    referenced_student_ids
  );
  if p_students is distinct from expected_students then
    raise exception using errcode = '23503', message = 'student_import_canonical_projection_mismatch';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(expected_students) projected_student
    where projected_student ->> 'jwbMatchStatus' = 'ambiguous'
  ) then
    raise exception using errcode = '23503', message = 'student_import_ambiguous_projection';
  end if;
  students_hash := encode(extensions.digest(expected_students::text, 'sha256'), 'hex');
  if replaying_prior then
    return query select
      'students'::text,
      prior.students_version,
      prior.committed_at,
      prior.committed_by;
    return;
  end if;

  -- The commit boundary independently proves the authoritative formal roster.
  -- Every resolved eligible master row must map to exactly one active formal
  -- student and every active formal student must map back to exactly one row.
  -- Current reviewed links are the only exception to the namespaced derived ID;
  -- the present clear-only contract therefore always uses the derived branch.
  if exists (
    select 1
    from jsonb_array_elements(resolved_master_rows) eligible_master_row
    where eligible_master_row ->> 'status' <> '不活跃 + 无课时'
      and (
        select count(*)
        from jsonb_array_elements(expected_students) imported_student
        where coalesce(imported_student ->> 'importArchived', 'false') <> 'true'
          and imported_student ->> 'importSource' = 'master'
          and imported_student ->> 'sourceRow' = eligible_master_row ->> 'sourceRow'
          and imported_student ->> 'name' =
            internal.student_import_display_name(eligible_master_row ->> 'name')
          and imported_student ->> 'status' = eligible_master_row ->> 'status'
          and imported_student ->> 'masterSourceKey' =
            internal.student_import_master_source_key(master.source_id, eligible_master_row -> 'sourceRow')
          and (
            imported_student ->> 'id' =
              internal.student_import_student_id(master.source_id, eligible_master_row -> 'sourceRow')
            or exists (
              select 1
              from jsonb_array_elements(case
                when link_set.singleton
                 and link_set.master_source_id = master.source_id
                 and link_set.master_revision = master.revision
                 and link_set.jwb_source_id = jwb.source_id
                 and link_set.jwb_revision = jwb.revision
                 and link_set.students_version = current_state.version
                 and link_set.link_count = 0
                then link_set.links else '[]'::jsonb end
              ) link
              where link ->> 'masterSourceRow' = eligible_master_row ->> 'sourceRow'
                and link ->> 'studentId' = imported_student ->> 'id'
            )
          )
      ) <> 1
  ) or exists (
    select 1
    from jsonb_array_elements(expected_students) imported_student
    where coalesce(imported_student ->> 'importArchived', 'false') <> 'true'
      and imported_student ->> 'importSource' = 'master'
      and (
        select count(*)
        from jsonb_array_elements(resolved_master_rows) eligible_master_row
        where eligible_master_row ->> 'status' <> '不活跃 + 无课时'
          and imported_student ->> 'sourceRow' = eligible_master_row ->> 'sourceRow'
          and imported_student ->> 'name' =
            internal.student_import_display_name(eligible_master_row ->> 'name')
          and imported_student ->> 'status' = eligible_master_row ->> 'status'
          and imported_student ->> 'masterSourceKey' =
            internal.student_import_master_source_key(master.source_id, eligible_master_row -> 'sourceRow')
          and (
            imported_student ->> 'id' =
              internal.student_import_student_id(master.source_id, eligible_master_row -> 'sourceRow')
            or exists (
              select 1
              from jsonb_array_elements(case
                when link_set.singleton
                 and link_set.master_source_id = master.source_id
                 and link_set.master_revision = master.revision
                 and link_set.jwb_source_id = jwb.source_id
                 and link_set.jwb_revision = jwb.revision
                 and link_set.students_version = current_state.version
                 and link_set.link_count = 0
                then link_set.links else '[]'::jsonb end
              ) link
              where link ->> 'masterSourceRow' = eligible_master_row ->> 'sourceRow'
                and link ->> 'studentId' = imported_student ->> 'id'
            )
          )
      ) <> 1
  ) then
    raise exception using errcode = '23503', message = 'student_import_formal_identity_mismatch';
  end if;

  -- Manual trials are server-owned current-state records, not an import input.
  -- The formal plan may only preserve their exact canonical projection.  The
  -- sole omission case mirrors the domain: an exact current namespaced master
  -- identity consumes that same ID and turns it into the formal master row.
  if exists (
    select 1
    from jsonb_array_elements(expected_students) imported_student
    where coalesce(imported_student ->> 'importArchived', 'false') <> 'true'
      and coalesce(imported_student ->> 'importSource', '') <> 'master'
      and (
        coalesce(imported_student ->> 'importSource', '') <> 'manual_trial'
        or (
          select count(*)
          from jsonb_array_elements(current_state.payload) old_student
          where old_student ->> 'id' = imported_student ->> 'id'
            and internal.student_import_is_manual_trial(old_student)
            and imported_student = internal.student_import_canonical_manual_trial(old_student)
        ) <> 1
      )
  ) or exists (
    select 1
    from jsonb_array_elements(current_state.payload) old_student
    where internal.student_import_is_manual_trial(old_student)
      and (
        select count(*)
        from jsonb_array_elements(expected_students) imported_student
        where imported_student ->> 'id' = old_student ->> 'id'
          and coalesce(imported_student ->> 'importArchived', 'false') <> 'true'
          and (
            (
              imported_student ->> 'importSource' = 'manual_trial'
              and imported_student = internal.student_import_canonical_manual_trial(old_student)
            )
            or (
              imported_student ->> 'importSource' = 'master'
              and nullif(old_student ->> 'masterSourceKey', '') =
                imported_student ->> 'masterSourceKey'
            )
          )
      ) <> 1
  ) then
    raise exception using errcode = '23503', message = 'student_import_manual_trial_mismatch';
  end if;

  -- Archive markers are a narrow preservation mechanism for an excluded
  -- student whose stable ID is still retained by operational history.  They
  -- cannot be used to hide a new row, an active row, an unreferenced row, or
  -- an import-eligible master identity that the current plan must retain.
  if exists (
    select 1
    from jsonb_array_elements(expected_students) archived_student
    where archived_student ->> 'importArchived' = 'true'
      and (
        not exists (
          select 1 from jsonb_array_elements(current_state.payload) old_student
          where old_student ->> 'id' = archived_student ->> 'id'
        )
        or exists (
          select 1 from jsonb_array_elements(current_state.payload) old_student
          where old_student ->> 'id' = archived_student ->> 'id'
            and (
              internal.student_import_is_manual_trial(old_student)
              or archived_student <>
                internal.student_import_canonical_archive(old_student)
            )
        )
        or not exists (
          select 1
          from jsonb_array_elements_text(referenced_student_ids) referenced_student_id
          where referenced_student_id = archived_student ->> 'id'
        )
        or exists (
          select 1
          from jsonb_array_elements(resolved_master_rows) eligible_master_row
          where eligible_master_row ->> 'status' <> '不活跃 + 无课时'
            and (
              -- A reviewed current identity link is the authoritative mapping
              -- for an existing canonical ID, including legacy/non-derived IDs.
              exists (
                select 1
                from jsonb_array_elements(case
      when link_set.singleton
       and link_set.master_source_id = master.source_id
       and link_set.master_revision = master.revision
       and link_set.jwb_source_id = jwb.source_id
       and link_set.jwb_revision = jwb.revision
       and link_set.students_version = current_state.version
       and link_set.link_count = 0
                  then link_set.links else '[]'::jsonb end
                ) link
                where link ->> 'studentId' = archived_student ->> 'id'
                  and link ->> 'masterSourceRow' = eligible_master_row ->> 'sourceRow'
              )
            )
        )
      )
  ) then
    raise exception using errcode = '23503', message = 'student_import_invalid_archive';
  end if;
  if link_set.singleton
     and link_set.master_source_id = master.source_id
     and link_set.master_revision = master.revision
     and link_set.jwb_source_id = jwb.source_id
     and link_set.jwb_revision = jwb.revision
     and link_set.students_version = current_state.version
     and link_set.link_count = 0
     and exists (
       select 1
       from jsonb_array_elements(link_set.links) link
       where not exists (
         select 1 from jsonb_array_elements(master.rows) source_row
         where source_row ->> 'sourceRow' = link ->> 'masterSourceRow'
           and source_row ->> 'status' <> '不活跃 + 无课时'
       )
       or (link ? 'jwbSourceRow' and not exists (
         select 1 from jsonb_array_elements(jwb.rows) source_row
         where source_row ->> 'sourceRow' = link ->> 'jwbSourceRow'
       ))
       or not exists (
         select 1 from jsonb_array_elements(current_state.payload) student
         where student ->> 'id' = link ->> 'studentId'
       )
     ) then
    raise exception using errcode = '40001', message = 'student_import_identity_links_changed';
  end if;

  -- An import may update a student's attributes, but it must not make a
  -- currently referenced canonical student ID disappear.  Existing unrelated
  -- legacy orphans do not block the import because only IDs present in the
  -- locked pre-import students payload are considered here.
  select old_student ->> 'id'
  into referenced_removed_student_id
  from jsonb_array_elements(current_state.payload) old_student
  where nullif(trim(old_student ->> 'id'), '') is not null
    and not exists (
      select 1
      from jsonb_array_elements(expected_students) new_student
      where new_student ->> 'id' = old_student ->> 'id'
    )
    and exists (
      select 1
      from jsonb_array_elements_text(referenced_student_ids) referenced_student_id
      where referenced_student_id = old_student ->> 'id'
    )
  limit 1;
  if referenced_removed_student_id is not null then
    raise exception using errcode = '23503', message = 'student_import_referenced_student_removed';
  end if;

  -- Do not replace an existing package ledger while any series or occurrence
  -- still points at a package that the imported student currently owns. This
  -- guard only considers valid pre-import references, so unrelated legacy
  -- package orphans do not suddenly block an otherwise safe import.
  select referenced_id
  into referenced_removed_package_reference_id
  from (
    select 'booking:' || coalesce(booking ->> 'id', '') as referenced_id,
      booking ->> 'studentId' as referenced_student_id,
      booking ->> 'packageId' as referenced_package_id
    from jsonb_array_elements(booking_state.payload) booking
    where nullif(trim(booking ->> 'packageId'), '') is not null

    union all

    select 'booking_override:' || coalesce(occurrence_override ->> 'occurrenceId', booking ->> 'id', '') as referenced_id,
      coalesce(
        nullif(trim(occurrence_override ->> 'studentId'), ''),
        booking ->> 'studentId'
      ) as referenced_student_id,
      occurrence_override ->> 'packageId' as referenced_package_id
    from jsonb_array_elements(booking_state.payload) booking
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(booking -> 'occurrenceOverrides') = 'array'
          then booking -> 'occurrenceOverrides'
        else '[]'::jsonb
      end
    ) occurrence_override
    where nullif(trim(occurrence_override ->> 'packageId'), '') is not null

    union all

    select 'renewal:' || coalesce(reference_item ->> 'id', '') as referenced_id,
      reference_item ->> 'studentId' as referenced_student_id,
      reference_item ->> 'packageId' as referenced_package_id
    from public.ops_state reference_state
    cross join lateral jsonb_array_elements(reference_state.payload) reference_item
    where reference_state.entity = 'renewals'
      and nullif(trim(reference_item ->> 'packageId'), '') is not null

    union all

    select 'payroll:' || coalesce(reference_item ->> 'id', '') as referenced_id,
      reference_item ->> 'studentId' as referenced_student_id,
      reference_item ->> 'packageId' as referenced_package_id
    from public.ops_state reference_state
    cross join lateral jsonb_array_elements(reference_state.payload) reference_item
    where reference_state.entity = 'payroll'
      and nullif(trim(reference_item ->> 'packageId'), '') is not null

    union all

    select 'student_ledger:' || coalesce(ledger_item ->> 'id', '') as referenced_id,
      old_student ->> 'id' as referenced_student_id,
      ledger_item ->> 'packageId' as referenced_package_id
    from jsonb_array_elements(current_state.payload) old_student
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(old_student -> 'lessonLedger') = 'array'
        then old_student -> 'lessonLedger' else '[]'::jsonb end
    ) ledger_item
    where nullif(trim(ledger_item ->> 'packageId'), '') is not null

    union all

    -- Renewal task anchors encode both identities. Decode the exact anchor
    -- components; other task rules are deliberately not treated as package refs.
    select 'task:' || coalesce(reference_item ->> 'id', '') as referenced_id,
      reference_item ->> 'studentId' as referenced_student_id,
      split_part(reference_item ->> 'anchorBookingId', ':', 3) as referenced_package_id
    from public.ops_state reference_state
    cross join lateral jsonb_array_elements(reference_state.payload) reference_item
    where reference_state.entity = 'tasks'
      and reference_item ->> 'ruleKey' = 'renewal.package-depletion'
      and reference_item ->> 'anchorBookingId' ~ '^renewal:[^:]+:[^:]+$'
      and split_part(reference_item ->> 'anchorBookingId', ':', 3) not like '%\%%'
  ) package_reference
  where exists (
    select 1
    from jsonb_array_elements(current_state.payload) old_student
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(old_student -> 'lessonPackages') = 'array'
          then old_student -> 'lessonPackages'
        else '[]'::jsonb
      end
    ) old_package
    where old_student ->> 'id' = package_reference.referenced_student_id
      and old_package ->> 'id' = package_reference.referenced_package_id
  )
  and not exists (
    select 1
    from jsonb_array_elements(expected_students) new_student
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(new_student -> 'lessonPackages') = 'array'
          then new_student -> 'lessonPackages'
        else '[]'::jsonb
      end
    ) new_package
    where new_student ->> 'id' = package_reference.referenced_student_id
      and new_package ->> 'id' = package_reference.referenced_package_id
  )
  limit 1;
  if referenced_removed_package_reference_id is not null then
    raise exception using errcode = '23503', message = 'student_import_referenced_package_removed';
  end if;

  -- Package activation is deliberately fail-closed. Parent series and future
  -- occurrence overrides are resolved independently: an override can change
  -- both student and subject, so copying the parent's package would cross the
  -- student ledger boundary. Existing explicit override package choices,
  -- including an explicit null, are never overwritten.
  for booking_item in
    select item
    from jsonb_array_elements(booking_state.payload) with ordinality as booking(item, position)
    order by position
  loop
    next_booking := booking_item;
    booking_changed := false;
    booking_backfilled := false;
    parent_package_backfilled := false;
    booking_subject := case
      when booking_item ? 'subjectId'
       and jsonb_typeof(booking_item -> 'subjectId') = 'string'
        then nullif(trim(booking_item ->> 'subjectId'), '')
      else nullif(trim(booking_item ->> 'course'), '')
    end;
    if jsonb_typeof(booking_item) = 'object'
       and nullif(trim(booking_item ->> 'id'), '') is not null
       and nullif(trim(booking_item ->> 'studentId'), '') is not null
       and coalesce(booking_item ->> 'kind', '') <> '试听'
       and (
         coalesce(booking_item ->> 'recurring', 'false') <> 'true'
         or not (booking_item ? 'repeatCount')
         or (
           jsonb_typeof(booking_item -> 'repeatCount') = 'number'
           and (booking_item ->> 'repeatCount')::numeric = trunc((booking_item ->> 'repeatCount')::numeric)
           and (booking_item ->> 'repeatCount')::numeric between 1 and 1000
         )
       ) then
      if nullif(trim(booking_item ->> 'packageId'), '') is null
         and booking_subject is not null
         and (
           coalesce(booking_item ->> 'recurring', 'false') = 'true'
           or (
             coalesce(booking_item ->> 'status', '') not in (
               '已完成', 'completed', 'cancelled', '已取消', 'leave', '请假'
             )
             and coalesce(booking_item ->> 'sourceTiming', '') <> '已结束'
           )
         )
         and coalesce(booking_item ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
         and (booking_item ->> 'date')::date >=
           (current_timestamp at time zone 'Australia/Melbourne')::date then
        select coalesce(array_agg(candidate.package_id order by candidate.package_id), array[]::text[])
        into matching_package_ids
        from (
          select lesson_package ->> 'id' as package_id
          from jsonb_array_elements(expected_students) imported_student
          cross join lateral jsonb_array_elements(
            case
              when jsonb_typeof(imported_student -> 'lessonPackages') = 'array'
                then imported_student -> 'lessonPackages'
              else '[]'::jsonb
            end
          ) lesson_package
          cross join lateral jsonb_array_elements_text(
            case
              when jsonb_typeof(lesson_package -> 'subjectIds') = 'array'
                then lesson_package -> 'subjectIds'
              else '[]'::jsonb
            end
          ) subject(subject_id)
          where imported_student ->> 'id' = booking_item ->> 'studentId'
            and coalesce((imported_student ->> 'importArchived')::boolean, false) is false
            and nullif(trim(lesson_package ->> 'id'), '') is not null
            and subject.subject_id = booking_subject
            and (
              select coalesce(sum((purchase ->> 'hours')::numeric), 0)
              from jsonb_array_elements(lesson_package -> 'purchaseRecords') purchase
            ) - (lesson_package ->> 'consumedHours')::numeric > 0
          group by lesson_package ->> 'id'
        ) candidate;

        if cardinality(matching_package_ids) = 1 then
          next_booking := jsonb_set(
            next_booking,
            '{packageId}',
            to_jsonb(matching_package_ids[1]),
            true
          );
          booking_changed := true;
          booking_backfilled := true;
          parent_package_backfilled := true;
        elsif not unresolved_booking_ids @> jsonb_build_array(booking_item ->> 'id') then
          unresolved_booking_ids := unresolved_booking_ids ||
            jsonb_build_array(booking_item ->> 'id');
        end if;
      elsif nullif(trim(booking_item ->> 'packageId'), '') is null
         and booking_subject is not null
         and coalesce(booking_item ->> 'recurring', 'false') = 'true'
         and coalesce(booking_item ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
         and (booking_item ->> 'date')::date <
           (current_timestamp at time zone 'Australia/Melbourne')::date
         and (
           not (booking_item ? 'repeatCount')
           or (booking_item ->> 'date')::date +
             (((booking_item ->> 'repeatCount')::integer - 1) * 7) >=
               (current_timestamp at time zone 'Australia/Melbourne')::date
         )
         and not unresolved_booking_ids @> jsonb_build_array(booking_item ->> 'id') then
        -- Adding a package to an already-started parent would retroactively
        -- relabel historical occurrences that inherit the parent fields.
        unresolved_booking_ids := unresolved_booking_ids ||
          jsonb_build_array(booking_item ->> 'id');
      end if;

      if jsonb_typeof(booking_item -> 'occurrenceOverrides') = 'array' then
        next_overrides := '[]'::jsonb;
        for override_item in
          select item
          from jsonb_array_elements(booking_item -> 'occurrenceOverrides')
            with ordinality as occurrence_override(item, position)
          order by position
        loop
          override_effective_date := case
            when override_item ? 'date'
             and jsonb_typeof(override_item -> 'date') = 'string'
              then nullif(trim(override_item ->> 'date'), '')
            else right(coalesce(override_item ->> 'occurrenceId', ''), 10)
          end;
          override_student_id := case
            when override_item ? 'studentId'
              then nullif(trim(override_item ->> 'studentId'), '')
            else nullif(trim(booking_item ->> 'studentId'), '')
          end;
          override_subject := case
            when override_item ? 'subjectId'
              then nullif(trim(override_item ->> 'subjectId'), '')
            else booking_subject
          end;
          override_changes_assignment :=
            (override_item ? 'studentId' and coalesce(override_student_id, '') <>
              coalesce(nullif(trim(booking_item ->> 'studentId'), ''), ''))
            or (override_item ? 'subjectId' and coalesce(override_subject, '') <>
              coalesce(booking_subject, ''));
          override_is_eligible := jsonb_typeof(override_item) = 'object'
            and not (override_item ? 'packageId')
            and nullif(trim(override_item ->> 'settledAt'), '') is null
            and coalesce(override_item ->> 'status', '') not in (
              'completed', 'cancelled', 'abnormal', 'leave'
            )
            and case
              when override_effective_date ~ '^\d{4}-\d{2}-\d{2}$'
                then override_effective_date::date >=
                  (current_timestamp at time zone 'Australia/Melbourne')::date
              else false
            end;
          if parent_package_backfilled
             and jsonb_typeof(override_item) = 'object'
             and not (override_item ? 'packageId')
             and not override_is_eligible then
            -- Before this import the override inherited a missing parent
            -- package. Preserve that historical/terminal/settled meaning.
            override_item := jsonb_set(override_item, '{packageId}', 'null'::jsonb, true);
            booking_changed := true;
          elsif override_is_eligible
             and (
               nullif(trim(next_booking ->> 'packageId'), '') is null
               or override_changes_assignment
             ) then
            select coalesce(array_agg(candidate.package_id order by candidate.package_id), array[]::text[])
            into override_matching_package_ids
            from (
              select lesson_package ->> 'id' as package_id
              from jsonb_array_elements(expected_students) imported_student
              cross join lateral jsonb_array_elements(
                case
                  when jsonb_typeof(imported_student -> 'lessonPackages') = 'array'
                    then imported_student -> 'lessonPackages'
                  else '[]'::jsonb
                end
              ) lesson_package
              cross join lateral jsonb_array_elements_text(
                case
                  when jsonb_typeof(lesson_package -> 'subjectIds') = 'array'
                    then lesson_package -> 'subjectIds'
                  else '[]'::jsonb
                end
              ) subject(subject_id)
              where imported_student ->> 'id' = override_student_id
                and coalesce((imported_student ->> 'importArchived')::boolean, false) is false
                and override_subject is not null
                and nullif(trim(lesson_package ->> 'id'), '') is not null
                and subject.subject_id = override_subject
                and (
                  select coalesce(sum((purchase ->> 'hours')::numeric), 0)
                  from jsonb_array_elements(lesson_package -> 'purchaseRecords') purchase
                ) - (lesson_package ->> 'consumedHours')::numeric > 0
              group by lesson_package ->> 'id'
            ) candidate;

            if cardinality(override_matching_package_ids) = 1 then
              override_item := jsonb_set(
                override_item,
                '{packageId}',
                to_jsonb(override_matching_package_ids[1]),
                true
              );
              booking_changed := true;
              booking_backfilled := true;
            else
              -- If the override changes ownership/subject and the parent now
              -- has a package, make the missing override explicit so runtime
              -- expansion cannot inherit the wrong student's package.
              if nullif(trim(next_booking ->> 'packageId'), '') is not null
                 and override_changes_assignment then
                override_item := jsonb_set(override_item, '{packageId}', 'null'::jsonb, true);
                booking_changed := true;
              end if;
              if not unresolved_booking_ids @> jsonb_build_array(override_item ->> 'occurrenceId') then
                unresolved_booking_ids := unresolved_booking_ids ||
                  jsonb_build_array(override_item ->> 'occurrenceId');
              end if;
            end if;
          end if;
          next_overrides := next_overrides || jsonb_build_array(override_item);
        end loop;
        if next_overrides is distinct from booking_item -> 'occurrenceOverrides' then
          next_booking := jsonb_set(next_booking, '{occurrenceOverrides}', next_overrides, true);
          booking_changed := true;
        end if;
      end if;
    end if;
    next_bookings := next_bookings || jsonb_build_array(next_booking);
    if booking_changed and booking_backfilled then
      backfilled_booking_ids := backfilled_booking_ids ||
        jsonb_build_array(booking_item ->> 'id');
    end if;
  end loop;

  update public.ops_state s set
    payload = expected_students,
    version = s.version + 1,
    updated_at = now(),
    updated_by = left(trim(p_actor), 80)
  where s.entity = 'students'
  returning s.* into current_state;

  insert into public.ops_mutation_log(entity, version, actor)
  values ('students', current_state.version, current_state.updated_by);

  if next_bookings is distinct from booking_state.payload then
    update public.ops_state s set
      payload = next_bookings,
      version = s.version + 1,
      updated_at = current_state.updated_at,
      updated_by = current_state.updated_by
    where s.entity = 'bookings'
    returning s.* into booking_state;

    insert into public.ops_mutation_log(entity, version, actor)
    values ('bookings', booking_state.version, booking_state.updated_by);
  end if;
  bookings_hash := encode(extensions.digest(booking_state.payload::text, 'sha256'), 'hex');

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.committed',
    p_actor,
    'ops_state',
    'students',
    jsonb_build_object(
      'planFingerprint', p_plan_fingerprint,
      'masterRevision', master.revision,
      'jwbRevision', jwb.revision,
      'identityLinkFingerprint', p_source_revisions ->> 'identityLinks',
      'masterDuplicateResolutionFingerprint', p_source_revisions ->> 'masterDuplicateResolutions',
      'fuAttachmentFingerprint', p_source_revisions ->> 'fuAttachments',
      'beforeVersion', p_expected_student_version,
      'afterVersion', current_state.version,
      'bookingsVersionBefore', expected_bookings_version,
      'studentCount', jsonb_array_length(expected_students),
      'studentsSha256', students_hash,
      'bookingsVersion', booking_state.version,
      'bookingsSha256', bookings_hash,
      'bookingPackageBackfilledCount', jsonb_array_length(backfilled_booking_ids),
      'bookingPackageBackfilledIds', backfilled_booking_ids,
      'bookingPackageUnresolvedCount', jsonb_array_length(unresolved_booking_ids),
      'bookingPackageUnresolvedIds', unresolved_booking_ids
    )
  );

  insert into internal.student_import_commits (
    plan_fingerprint, master_revision, jwb_revision, identity_link_fingerprint,
    master_duplicate_resolution_fingerprint, fu_attachment_fingerprint, students_version,
    students_sha256, bookings_version_before, bookings_version, bookings_sha256,
    committed_by, committed_at, audit_id
  ) values (
    p_plan_fingerprint, master.revision, jwb.revision,
    p_source_revisions ->> 'identityLinks', p_source_revisions ->> 'masterDuplicateResolutions',
    p_source_revisions ->> 'fuAttachments',
    current_state.version,
    students_hash, expected_bookings_version, booking_state.version, bookings_hash,
    left(trim(p_actor), 120), current_state.updated_at, audit_entry_id
  );

  return query select
    current_state.entity,
    current_state.version,
    current_state.updated_at,
    current_state.updated_by;
end;
$$;

revoke all on function public.commit_student_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.commit_student_import_plan_atomic(text, text, bigint, jsonb, jsonb, text)
  to anon, authenticated;

create table if not exists internal.teacher_import_sources (
  workbook text primary key check (workbook in ('k12', 'university')),
  source_id text not null check (length(source_id) between 1 and 160),
  revision text not null check (length(revision) between 1 and 240),
  sheet_names jsonb not null check (jsonb_typeof(sheet_names) = 'array'),
  roster_rows jsonb not null check (jsonb_typeof(roster_rows) = 'array'),
  subject_rows jsonb not null check (jsonb_typeof(subject_rows) = 'array'),
  roster_row_count integer not null check (roster_row_count > 0),
  subject_row_count integer not null check (subject_row_count >= 0),
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  ingested_by text not null check (length(ingested_by) between 1 and 120),
  ingested_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  check (jsonb_array_length(roster_rows) = roster_row_count),
  check (jsonb_array_length(subject_rows) = subject_row_count)
);

alter table internal.teacher_import_sources enable row level security;
revoke all on table internal.teacher_import_sources from public, anon, authenticated;

create table if not exists internal.teacher_import_identity_links (
  resolution_key text primary key check (resolution_key ~ '^sha256:[a-f0-9]{64}$'),
  decision text not null check (decision in ('merge', 'separate')),
  k12_source_id text not null,
  k12_revision text not null,
  k12_source_row text not null,
  university_source_id text not null,
  university_revision text not null,
  university_source_row text not null,
  source_refs jsonb not null check (jsonb_typeof(source_refs) = 'array' and jsonb_array_length(source_refs) = 2),
  confirmed_by text not null check (length(confirmed_by) between 1 and 120),
  confirmed_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  unique (k12_source_id, k12_revision, k12_source_row),
  unique (university_source_id, university_revision, university_source_row)
);

alter table internal.teacher_import_identity_links enable row level security;
revoke all on table internal.teacher_import_identity_links from public, anon, authenticated;

-- V2 stores only server-resolved, revision-bound hard choices.  The public RPC
-- accepts an opaque option key and an enum; source rows and assignment targets
-- are reconstructed from the two locked snapshots below.
create table if not exists internal.teacher_import_hard_resolutions (
  resolution_key text primary key check (resolution_key ~ '^sha256:[a-f0-9]{64}$'),
  resolution_group_key text not null unique check (resolution_group_key ~ '^sha256:[a-f0-9]{64}$'),
  kind text not null check (kind in ('same_workbook_identity', 'cross_workbook_identity', 'subject_assignment')),
  decision text not null check (decision in ('merge', 'separate', 'assign', 'ignore')),
  k12_source_id text not null,
  k12_revision text not null,
  university_source_id text not null,
  university_revision text not null,
  source_refs jsonb check (source_refs is null or jsonb_typeof(source_refs) = 'array'),
  subject_ref jsonb check (subject_ref is null or jsonb_typeof(subject_ref) = 'object'),
  roster_ref jsonb check (roster_ref is null or jsonb_typeof(roster_ref) = 'object'),
  confirmed_by text not null check (length(confirmed_by) between 1 and 120),
  confirmed_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  check (
    (kind in ('same_workbook_identity', 'cross_workbook_identity')
      and decision in ('merge', 'separate')
      and source_refs is not null and jsonb_array_length(source_refs) >= 2
      and subject_ref is null and roster_ref is null)
    or
    (kind = 'subject_assignment'
      and decision in ('assign', 'ignore')
      and source_refs is null and subject_ref is not null
      and ((decision = 'assign' and roster_ref is not null)
        or (decision = 'ignore' and roster_ref is null)))
  )
);

alter table internal.teacher_import_hard_resolutions enable row level security;
revoke all on table internal.teacher_import_hard_resolutions from public, anon, authenticated;

-- Mirrors the pure planner's conservative width/whitespace/case identity
-- boundary as closely as PostgreSQL permits without accepting arbitrary
-- aliases.  Known operational suffixes are removed only by the second helper.
create or replace function internal.teacher_import_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(trim(regexp_replace(
    translate(
      replace(replace(replace(replace(coalesce(p_name, ''), chr(8203), ''), chr(8204), ''), chr(8205), ''), chr(65279), ''),
      'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９（）－＿',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789()-_'
    ),
    '[[:space:]　]+', ' ', 'g'
  )))
$$;

-- V1 intentionally predates width/zero-width normalisation.  Keep its much
-- narrower database comparison as a separate helper so a pair that is equal
-- only after NFKC/zero-width cleanup is offered through the closed V2 choice
-- rather than being silently accepted by the legacy two-row contract.
create or replace function internal.teacher_import_database_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(trim(regexp_replace(
    coalesce(p_name, ''), '[[:space:]　]+', ' ', 'g'
  )))
$$;

do $$
begin
  if internal.teacher_import_name_key('Ｗｉｄｔｈ Teacher') <> internal.teacher_import_name_key('Width Teacher')
     or internal.teacher_import_database_name_key('Ｗｉｄｔｈ Teacher') = internal.teacher_import_database_name_key('Width Teacher')
     or internal.teacher_import_name_key('Zero' || chr(8203) || 'Width Teacher') <> internal.teacher_import_name_key('ZeroWidth Teacher')
     or internal.teacher_import_database_name_key('Zero' || chr(8203) || 'Width Teacher') = internal.teacher_import_database_name_key('ZeroWidth Teacher') then
    raise exception using errcode = '22023', message = 'teacher_name_contract_fixture_mismatch_nfkc_v2_pair';
  end if;
end;
$$;

create or replace function internal.teacher_import_operational_name_key(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  result text := internal.teacher_import_name_key(p_name);
  next_result text;
begin
  loop
    next_result := trim(regexp_replace(
      result,
      '\s*\([^()]*?(弱化|离职|先不安排)[^()]*?\)\s*$',
      '',
      'i'
    ));
    exit when next_result = result;
    result := next_result;
  end loop;
  return trim(regexp_replace(result, '\s*(已弱化|弱化)\s*$', '', 'i'));
end;
$$;

create or replace function internal.teacher_import_hard_key(
  p_kind text,
  p_k12_revision text,
  p_university_revision text,
  p_reference_keys jsonb,
  p_decision text default null
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  material bytea;
  reference_key jsonb;
begin
  material := convert_to('teacher-import-hard-resolution-v2', 'UTF8') || decode('00', 'hex')
    || convert_to(p_kind, 'UTF8') || decode('00', 'hex')
    || convert_to(p_k12_revision, 'UTF8') || decode('00', 'hex')
    || convert_to(p_university_revision, 'UTF8');
  for reference_key in
    select value from jsonb_array_elements(p_reference_keys)
    order by (value ->> 'type') collate "C", (value ->> 'workbook') collate "C",
      (value ->> 'sourceId') collate "C", coalesce(value ->> 'sheetName', '') collate "C",
      trim(value ->> 'sourceRow') collate "C"
  loop
    material := material || decode('00', 'hex')
      || convert_to(reference_key ->> 'type', 'UTF8') || decode('00', 'hex')
      || convert_to(reference_key ->> 'workbook', 'UTF8') || decode('00', 'hex')
      || convert_to(reference_key ->> 'sourceId', 'UTF8');
    if reference_key ->> 'type' = 'subject' then
      material := material || decode('00', 'hex')
        || convert_to(reference_key ->> 'sheetName', 'UTF8');
    end if;
    material := material || decode('00', 'hex')
      || convert_to(trim(reference_key ->> 'sourceRow'), 'UTF8');
  end loop;
  if p_decision is not null then
    material := material || decode('00', 'hex') || convert_to(p_decision, 'UTF8');
  end if;
  return 'sha256:' || encode(extensions.digest(material, 'sha256'), 'hex');
end;
$$;

-- Cross-runtime contract fixtures.  The same constants are asserted through
-- the TypeScript key builders in tests/teacher-import.test.ts; applying this
-- migration proves PostgreSQL serialises every NUL-delimited field identically.
do $$
begin
  if internal.teacher_import_hard_key(
    'same_workbook_identity', 'k12-r1', 'university-r1',
    jsonb_build_array(
      jsonb_build_object('type','roster','workbook','k12','sourceId','fixture-k12','sourceRow',2),
      jsonb_build_object('type','roster','workbook','k12','sourceId','fixture-k12','sourceRow',3)
    ), 'merge'
  ) <> 'sha256:1d3a46fd4b218aa83738a732628cfd57fdba8dc5045c8537cf2b92d7103b1c67' then
    raise exception using errcode = '22023', message = 'teacher_hard_key_fixture_mismatch_same_workbook';
  end if;
  if internal.teacher_import_hard_key(
    'cross_workbook_identity', 'k12-r1', 'university-r1',
    jsonb_build_array(
      jsonb_build_object('type','roster','workbook','k12','sourceId','fixture-k12','sourceRow',2),
      jsonb_build_object('type','roster','workbook','university','sourceId','fixture-university','sourceRow',30),
      jsonb_build_object('type','roster','workbook','university','sourceId','fixture-university','sourceRow',71)
    ), 'separate'
  ) <> 'sha256:cbe8d81ca7a47e98f14a30cb5e799f042371d72d6db5e0462f46c92364a8e328' then
    raise exception using errcode = '22023', message = 'teacher_hard_key_fixture_mismatch_cross_workbook';
  end if;
  if internal.teacher_import_hard_key(
    'subject_assignment', 'k12-r1', 'university-r1',
    jsonb_build_array(
      jsonb_build_object('type','subject','workbook','k12','sourceId','fixture-k12','sheetName','IB','sourceRow',20)
    ), 'ignore'
  ) <> 'sha256:cd624be68238fec52227362399eed001d2d0b6e463bdff0f966de6ca177d2eac' then
    raise exception using errcode = '22023', message = 'teacher_hard_key_fixture_mismatch_subject_ignore';
  end if;
  if internal.teacher_import_hard_key(
    'subject_assignment', 'k12-r1', 'university-r1',
    jsonb_build_array(
      jsonb_build_object('type','subject','workbook','k12','sourceId','fixture-k12','sheetName','IB','sourceRow',20),
      jsonb_build_object('type','roster','workbook','k12','sourceId','fixture-k12','sourceRow',3)
    ), 'assign'
  ) <> 'sha256:3b62fca49e69afceb26cef4779c94679433c0a4c91760f9bf03cc282f30be214' then
    raise exception using errcode = '22023', message = 'teacher_hard_key_fixture_mismatch_subject_assign';
  end if;
end;
$$;

create or replace function internal.teacher_import_hard_candidates(
  p_k12 internal.teacher_import_sources,
  p_university internal.teacher_import_sources
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  candidates jsonb := '[]'::jsonb;
  identity_group record;
  identity_kind text;
  identity_refs jsonb;
  identity_ref_keys jsonb;
  identity_group_key text;
  identity_decision text;
  subject_record record;
  roster_rows jsonb;
  candidate_rows jsonb;
  subject_ref jsonb;
  roster_ref jsonb;
  subject_group_key text;
  nickname_base text;
  nickname_annotation text;
  roster_row jsonb;
begin
  -- Every conservative-name duplicate is one non-overlapping closed group.
  -- Mixed groups use a single cross-workbook decision, including 1+N cases.
  for identity_group in
    select
      internal.teacher_import_name_key(source_row ->> 'name') as name_key,
      count(distinct workbook) as workbook_count,
      count(*) filter (where workbook = 'k12') as k12_count,
      count(*) filter (where workbook = 'university') as university_count,
      jsonb_agg(
        jsonb_build_object(
          'workbook', workbook,
          'sourceId', source_id,
          'sourceRow', source_row -> 'sourceRow'
        ) order by workbook collate "C", source_id collate "C", trim(source_row ->> 'sourceRow') collate "C"
      ) as refs,
      jsonb_agg(jsonb_build_object(
        'type', 'roster', 'workbook', workbook, 'sourceId', source_id,
        'sourceRow', source_row -> 'sourceRow'
      ) order by workbook collate "C", source_id collate "C", trim(source_row ->> 'sourceRow') collate "C") as ref_keys
    from (
      select 'k12'::text as workbook, p_k12.source_id as source_id, source_row
      from jsonb_array_elements(p_k12.roster_rows) source_row
      union all
      select 'university', p_university.source_id, source_row
      from jsonb_array_elements(p_university.roster_rows) source_row
    ) roster
    group by internal.teacher_import_name_key(source_row ->> 'name')
    having count(*) > 1
      and not (
        count(*) = 2
        and count(*) filter (where workbook = 'k12') = 1
        and count(*) filter (where workbook = 'university') = 1
        and count(distinct internal.teacher_import_database_name_key(source_row ->> 'name')) = 1
      )
  loop
    identity_kind := case when identity_group.workbook_count = 2
      then 'cross_workbook_identity' else 'same_workbook_identity' end;
    identity_refs := identity_group.refs;
    identity_ref_keys := identity_group.ref_keys;
    identity_group_key := internal.teacher_import_hard_key(
      identity_kind, p_k12.revision, p_university.revision, identity_ref_keys
    );
    foreach identity_decision in array array['separate', 'merge']
    loop
      candidates := candidates || jsonb_build_array(jsonb_build_object(
        'resolutionKey', internal.teacher_import_hard_key(
          identity_kind, p_k12.revision, p_university.revision,
          identity_ref_keys, identity_decision
        ),
        'resolutionGroupKey', identity_group_key,
        'kind', identity_kind,
        'decision', identity_decision,
        'sourceRefs', identity_refs
      ));
    end loop;
  end loop;

  -- Subject aliases expose only current roster rows from the same workbook.
  -- Exact/known-operational unique matches remain automatic and therefore do
  -- not become administrator choices.
  for subject_record in
    select 'k12'::text as workbook, p_k12.source_id as source_id,
      p_k12.subject_rows as all_subject_rows, subject_row
    from jsonb_array_elements(p_k12.subject_rows) subject_row
    where subject_row ->> 'sheetName' = any(array[
      'Local English','ABC华裔English','Maths&Science','VCE数学科学','VCE其他',
      '奖学金','AEAS','青少英语','QCE','HSC','WACE','SACE','AMC数学竞赛',
      '科学竞赛','雅思PTE','IB'
    ])
    union all
    select 'university', p_university.source_id,
      p_university.subject_rows, subject_row
    from jsonb_array_elements(p_university.subject_rows) subject_row
    where subject_row ->> 'sheetName' = any(array[
      'Engineering','商科','IT','理科','文科（含论文辅导）','教育学','其他科目'
    ])
  loop
    roster_rows := case when subject_record.workbook = 'k12'
      then p_k12.roster_rows else p_university.roster_rows end;
    select coalesce(jsonb_agg(row_value order by trim(row_value ->> 'sourceRow') collate "C"), '[]'::jsonb)
    into candidate_rows
    from jsonb_array_elements(roster_rows) row_value
    where internal.teacher_import_name_key(row_value ->> 'name') =
      internal.teacher_import_name_key(subject_record.subject_row ->> 'name');
    if jsonb_array_length(candidate_rows) = 1 then
      continue;
    end if;
    if jsonb_array_length(candidate_rows) = 0 then
      select coalesce(jsonb_agg(row_value order by trim(row_value ->> 'sourceRow') collate "C"), '[]'::jsonb)
      into candidate_rows
      from jsonb_array_elements(roster_rows) row_value
      where internal.teacher_import_operational_name_key(row_value ->> 'name') =
        internal.teacher_import_operational_name_key(subject_record.subject_row ->> 'name');
      if jsonb_array_length(candidate_rows) = 1 then
        continue;
      end if;
    end if;
    if jsonb_array_length(candidate_rows) = 0 then
      nickname_base := internal.teacher_import_name_key(regexp_replace(
        subject_record.subject_row ->> 'name', '\s*\([^()]*\)\s*$', ''
      ));
      nickname_annotation := internal.teacher_import_name_key(substring(
        subject_record.subject_row ->> 'name' from '\(([^()]*)\)\s*$'
      ));
      if nickname_annotation <> '' then
        select coalesce(jsonb_agg(row_value), '[]'::jsonb)
        into candidate_rows
        from jsonb_array_elements(roster_rows) row_value
        where internal.teacher_import_name_key(row_value ->> 'name') = nickname_base
          and internal.teacher_import_name_key(
            coalesce(row_value ->> 'availabilityText', '') || ' ' || coalesce(row_value ->> 'capacityText', '')
          ) like '%' || nickname_annotation || '老师%';
        if jsonb_array_length(candidate_rows) = 1 then
          continue;
        end if;
        if jsonb_array_length(candidate_rows) > 1 then
          candidate_rows := '[]'::jsonb;
        end if;
      end if;
    end if;
    if jsonb_array_length(candidate_rows) = 0 then
      candidate_rows := roster_rows;
    end if;

    subject_ref := jsonb_build_object(
      'workbook', subject_record.workbook,
      'sourceId', subject_record.source_id,
      'sheetName', subject_record.subject_row ->> 'sheetName',
      'sourceRow', subject_record.subject_row -> 'sourceRow'
    );
    subject_group_key := internal.teacher_import_hard_key(
      'subject_assignment', p_k12.revision, p_university.revision,
      jsonb_build_array(jsonb_build_object(
        'type', 'subject', 'workbook', subject_record.workbook,
        'sourceId', subject_record.source_id,
        'sheetName', subject_record.subject_row ->> 'sheetName',
        'sourceRow', subject_record.subject_row -> 'sourceRow'
      ))
    );
    candidates := candidates || jsonb_build_array(jsonb_build_object(
      'resolutionKey', internal.teacher_import_hard_key(
        'subject_assignment', p_k12.revision, p_university.revision,
        jsonb_build_array(jsonb_build_object(
          'type', 'subject', 'workbook', subject_record.workbook,
          'sourceId', subject_record.source_id,
          'sheetName', subject_record.subject_row ->> 'sheetName',
          'sourceRow', subject_record.subject_row -> 'sourceRow'
        )), 'ignore'
      ),
      'resolutionGroupKey', subject_group_key,
      'kind', 'subject_assignment',
      'decision', 'ignore',
      'subjectRef', subject_ref
    ));
    for roster_row in select value from jsonb_array_elements(candidate_rows)
    loop
      roster_ref := jsonb_build_object(
        'workbook', subject_record.workbook,
        'sourceId', subject_record.source_id,
        'sourceRow', roster_row -> 'sourceRow'
      );
      candidates := candidates || jsonb_build_array(jsonb_build_object(
        'resolutionKey', internal.teacher_import_hard_key(
          'subject_assignment', p_k12.revision, p_university.revision,
          jsonb_build_array(
            jsonb_build_object(
              'type', 'subject', 'workbook', subject_record.workbook,
              'sourceId', subject_record.source_id,
              'sheetName', subject_record.subject_row ->> 'sheetName',
              'sourceRow', subject_record.subject_row -> 'sourceRow'
            ),
            jsonb_build_object(
              'type', 'roster', 'workbook', subject_record.workbook,
              'sourceId', subject_record.source_id,
              'sourceRow', roster_row -> 'sourceRow'
            )
          ), 'assign'
        ),
        'resolutionGroupKey', subject_group_key,
        'kind', 'subject_assignment',
        'decision', 'assign',
        'subjectRef', subject_ref,
        'rosterRef', roster_ref
      ));
    end loop;
  end loop;
  return candidates;
end;
$$;

-- Candidate-level cross-runtime fixtures.  These two simple 1+1 pairs are
-- equal only under the V2 conservative key, so PostgreSQL must expose the
-- same four opaque options asserted by the TypeScript planner tests.
do $$
declare
  k12_fixture internal.teacher_import_sources%rowtype;
  university_fixture internal.teacher_import_sources%rowtype;
  fixture_candidates jsonb;
begin
  k12_fixture.source_id := 'fixture-k12';
  k12_fixture.revision := 'k12-r1';
  k12_fixture.roster_rows := jsonb_build_array(
    jsonb_build_object('sourceRow', 101, 'name', 'Ｗｉｄｔｈ Teacher'),
    jsonb_build_object('sourceRow', 102, 'name', 'Zero' || chr(8203) || 'Width Teacher')
  );
  k12_fixture.subject_rows := '[]'::jsonb;
  university_fixture.source_id := 'fixture-university';
  university_fixture.revision := 'university-r1';
  university_fixture.roster_rows := jsonb_build_array(
    jsonb_build_object('sourceRow', 201, 'name', 'Width Teacher'),
    jsonb_build_object('sourceRow', 202, 'name', 'ZeroWidth Teacher')
  );
  university_fixture.subject_rows := '[]'::jsonb;

  fixture_candidates := internal.teacher_import_hard_candidates(k12_fixture, university_fixture);
  if jsonb_array_length(fixture_candidates) <> 4
     or not exists (select 1 from jsonb_array_elements(fixture_candidates) option
       where option ->> 'resolutionKey' = 'sha256:bfbc3e5b70c4e35ee6a87cab1a5530722d36bc519c0df1497ddca92badcb303d'
         and option ->> 'decision' = 'separate')
     or not exists (select 1 from jsonb_array_elements(fixture_candidates) option
       where option ->> 'resolutionKey' = 'sha256:c2b46c06370631eaa84f87085cc1407e6a7384cadbdb2bdf4bdf6faf95245ec6'
         and option ->> 'decision' = 'merge')
     or not exists (select 1 from jsonb_array_elements(fixture_candidates) option
       where option ->> 'resolutionKey' = 'sha256:1390b9b37ec5e3c3bba8ec4b59915c92ecb2ae5c104c2f1f77bd47a1b381ad4a'
         and option ->> 'decision' = 'separate')
     or not exists (select 1 from jsonb_array_elements(fixture_candidates) option
       where option ->> 'resolutionKey' = 'sha256:5a8bdd161a397c3f996bb2c57749a230fb4671e3e374dd607e03269ea10a1912'
         and option ->> 'decision' = 'merge') then
    raise exception using errcode = '22023', message = 'teacher_hard_candidate_fixture_mismatch_nfkc_v2_pair';
  end if;
end;
$$;

revoke all on function internal.teacher_import_name_key(text)
  from public, anon, authenticated;
revoke all on function internal.teacher_import_database_name_key(text)
  from public, anon, authenticated;
revoke all on function internal.teacher_import_operational_name_key(text)
  from public, anon, authenticated;
revoke all on function internal.teacher_import_hard_key(text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function internal.teacher_import_hard_candidates(
  internal.teacher_import_sources, internal.teacher_import_sources
) from public, anon, authenticated;

create table if not exists internal.teacher_import_commits (
  plan_fingerprint text primary key check (plan_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  k12_revision text not null,
  university_revision text not null,
  teachers_version bigint not null check (teachers_version > 0),
  teachers_sha256 text not null check (teachers_sha256 ~ '^[a-f0-9]{64}$'),
  committed_by text not null check (length(committed_by) between 1 and 120),
  committed_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.teacher_import_commits enable row level security;
revoke all on table internal.teacher_import_commits from public, anon, authenticated;

create or replace function public.put_teacher_import_source(
  p_secret text,
  p_workbook text,
  p_source_id text,
  p_revision text,
  p_sheet_names jsonb,
  p_roster_rows jsonb,
  p_subject_rows jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.teacher_import_sources%rowtype;
  snapshot_hash text;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_workbook not in ('k12', 'university')
     or p_actor not in ('Nixon', 'Ops Admin')
     or nullif(trim(p_source_id), '') is null
     or length(trim(p_source_id)) > 160
     or nullif(trim(p_revision), '') is null
     or length(trim(p_revision)) > 240
     or jsonb_typeof(p_sheet_names) <> 'array'
     or jsonb_array_length(p_sheet_names) < 1
     or jsonb_array_length(p_sheet_names) > 100
     or exists (
       select 1 from jsonb_array_elements(p_sheet_names) s
       where jsonb_typeof(s) <> 'string' or nullif(trim(s #>> '{}'), '') is null
     )
     or jsonb_typeof(p_roster_rows) <> 'array'
     or jsonb_array_length(p_roster_rows) < 1
     or jsonb_array_length(p_roster_rows) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_roster_rows) r
       where jsonb_typeof(r) <> 'object'
          or r ->> 'workbook' <> p_workbook
          or jsonb_typeof(r -> 'sourceRow') not in ('string', 'number')
          or nullif(trim(r ->> 'sourceRow'), '') is null
          or jsonb_typeof(r -> 'name') <> 'string'
          or nullif(trim(r ->> 'name'), '') is null
          or (r ? 'attributes' and jsonb_typeof(r -> 'attributes') <> 'object')
          or (r ? 'attributes' and r -> 'attributes' - 'location' <> '{}'::jsonb)
          or (r -> 'attributes' ? 'location' and jsonb_typeof(r -> 'attributes' -> 'location') <> 'string')
          or (r ? 'availabilityText' and jsonb_typeof(r -> 'availabilityText') not in ('string', 'null'))
          or (r ? 'capacityText' and jsonb_typeof(r -> 'capacityText') not in ('string', 'null'))
          or r - 'workbook' - 'sourceRow' - 'name' - 'availabilityText' - 'capacityText' - 'attributes' <> '{}'::jsonb
     )
     or jsonb_typeof(p_subject_rows) <> 'array'
     or jsonb_array_length(p_subject_rows) > 100000
     or exists (
       select 1 from jsonb_array_elements(p_subject_rows) r
       where jsonb_typeof(r) <> 'object'
          or r ->> 'workbook' <> p_workbook
          or jsonb_typeof(r -> 'sourceRow') not in ('string', 'number')
          or nullif(trim(r ->> 'sourceRow'), '') is null
          or jsonb_typeof(r -> 'name') <> 'string'
          or nullif(trim(r ->> 'name'), '') is null
          or jsonb_typeof(r -> 'sheetName') <> 'string'
          or nullif(trim(r ->> 'sheetName'), '') is null
          or (r ? 'subjectDetail' and jsonb_typeof(r -> 'subjectDetail') not in ('string', 'null'))
          or r - 'workbook' - 'sheetName' - 'sourceRow' - 'name' - 'subjectDetail' <> '{}'::jsonb
     ) then
    raise exception using errcode = '22023', message = 'invalid_teacher_import_source';
  end if;

  snapshot_hash := encode(extensions.digest(
    jsonb_build_object(
      'sheetNames', p_sheet_names,
      'rosterRows', p_roster_rows,
      'subjectRows', p_subject_rows
    )::text,
    'sha256'
  ), 'hex');

  -- Serialises the first insert as well as later updates for each workbook.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('teacher_import_source:' || p_workbook, 0)
  );
  select * into saved
  from internal.teacher_import_sources s
  where s.workbook = p_workbook
  for update;

  if found
     and saved.source_id = trim(p_source_id)
     and saved.revision = trim(p_revision)
     and saved.snapshot_sha256 = snapshot_hash then
    return jsonb_build_object(
      'workbook', saved.workbook,
      'sourceId', saved.source_id,
      'revision', saved.revision,
      'rosterRowCount', saved.roster_row_count,
      'subjectRowCount', saved.subject_row_count,
      'unchanged', true
    );
  end if;
  if found and saved.revision = trim(p_revision) then
    raise exception using errcode = '23505', message = 'teacher_import_revision_conflict';
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'teacher_import.source_ingested',
    p_actor,
    'teacher_import_source',
    p_workbook,
    jsonb_build_object(
      'sourceId', trim(p_source_id),
      'revision', trim(p_revision),
      'rosterRowCount', jsonb_array_length(p_roster_rows),
      'subjectRowCount', jsonb_array_length(p_subject_rows),
      'snapshotSha256', snapshot_hash
    )
  );

  insert into internal.teacher_import_sources (
    workbook, source_id, revision, sheet_names, roster_rows, subject_rows,
    roster_row_count, subject_row_count, snapshot_sha256,
    ingested_by, ingested_at, audit_id
  ) values (
    p_workbook, trim(p_source_id), trim(p_revision), p_sheet_names,
    p_roster_rows, p_subject_rows, jsonb_array_length(p_roster_rows),
    jsonb_array_length(p_subject_rows), snapshot_hash,
    left(trim(p_actor), 120), now(), audit_entry_id
  )
  on conflict (workbook) do update set
    source_id = excluded.source_id,
    revision = excluded.revision,
    sheet_names = excluded.sheet_names,
    roster_rows = excluded.roster_rows,
    subject_rows = excluded.subject_rows,
    roster_row_count = excluded.roster_row_count,
    subject_row_count = excluded.subject_row_count,
    snapshot_sha256 = excluded.snapshot_sha256,
    ingested_by = excluded.ingested_by,
    ingested_at = excluded.ingested_at,
    audit_id = excluded.audit_id
  returning * into saved;

  return jsonb_build_object(
    'workbook', saved.workbook,
    'sourceId', saved.source_id,
    'revision', saved.revision,
    'rosterRowCount', saved.roster_row_count,
    'subjectRowCount', saved.subject_row_count,
    'unchanged', false
  );
end;
$$;

create or replace function public.get_latest_teacher_import_sources(p_secret text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  k12 internal.teacher_import_sources%rowtype;
  university internal.teacher_import_sources%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into k12 from internal.teacher_import_sources s where s.workbook = 'k12';
  select * into university from internal.teacher_import_sources s where s.workbook = 'university';
  if k12.workbook is null or university.workbook is null then
    raise exception using errcode = 'P0002', message = 'teacher_import_sources_unavailable';
  end if;

  return jsonb_build_object(
    'k12', jsonb_build_object(
      'workbook', 'k12',
      'sourceId', k12.source_id,
      'revision', k12.revision,
      'sheetNames', k12.sheet_names,
      'rosterRows', k12.roster_rows,
      'subjectRows', k12.subject_rows
    ),
    'university', jsonb_build_object(
      'workbook', 'university',
      'sourceId', university.source_id,
      'revision', university.revision,
      'sheetNames', university.sheet_names,
      'rosterRows', university.roster_rows,
      'subjectRows', university.subject_rows
    ),
    'identityLinks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'resolutionKey', l.resolution_key,
        'decision', l.decision,
        'sourceRevisions', jsonb_build_object(
          'k12', l.k12_revision,
          'university', l.university_revision
        ),
        'sourceRefs', l.source_refs
      ) order by l.resolution_key)
      from internal.teacher_import_identity_links l
      where l.k12_source_id = k12.source_id
        and l.k12_revision = k12.revision
        and l.university_source_id = university.source_id
        and l.university_revision = university.revision
    ), '[]'::jsonb),
    'hardResolutions', coalesce((
      select jsonb_agg(
        case when r.kind in ('same_workbook_identity', 'cross_workbook_identity') then
          jsonb_build_object(
            'kind', r.kind,
            'resolutionKey', r.resolution_key,
            'decision', r.decision,
            'sourceRevisions', jsonb_build_object(
              'k12', r.k12_revision, 'university', r.university_revision
            ),
            'sourceRefs', r.source_refs
          )
        else jsonb_strip_nulls(jsonb_build_object(
          'kind', r.kind,
          'resolutionKey', r.resolution_key,
          'decision', r.decision,
          'sourceRevisions', jsonb_build_object(
            'k12', r.k12_revision, 'university', r.university_revision
          ),
          'subjectRef', r.subject_ref,
          'rosterRef', r.roster_ref
        )) end
        order by r.resolution_group_key
      )
      from internal.teacher_import_hard_resolutions r
      where r.k12_source_id = k12.source_id
        and r.k12_revision = k12.revision
        and r.university_source_id = university.source_id
        and r.university_revision = university.revision
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.put_teacher_import_identity_link(
  p_secret text,
  p_resolution_key text,
  p_decision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k12 internal.teacher_import_sources%rowtype;
  university internal.teacher_import_sources%rowtype;
  k12_row jsonb;
  university_row jsonb;
  k12_row_key text;
  university_row_key text;
  canonical_material bytea;
  expected_key text;
  refs jsonb;
  existing internal.teacher_import_identity_links%rowtype;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_resolution_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_decision not in ('merge', 'separate')
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023', message = 'invalid_teacher_identity_link_request';
  end if;

  select * into k12 from internal.teacher_import_sources s where s.workbook = 'k12' for update;
  select * into university from internal.teacher_import_sources s where s.workbook = 'university' for update;
  if k12.workbook is null or university.workbook is null then
    raise exception using errcode = 'P0002', message = 'teacher_import_sources_unavailable';
  end if;

  -- Resolve the opaque key only against current server-owned rows. The caller
  -- cannot nominate names, source rows or a teacher id.
  select kr.row, ur.row, trim(kr.row ->> 'sourceRow'), trim(ur.row ->> 'sourceRow')
  into k12_row, university_row, k12_row_key, university_row_key
  from jsonb_array_elements(k12.roster_rows) kr(row)
  cross join jsonb_array_elements(university.roster_rows) ur(row)
  where internal.teacher_import_database_name_key(kr.row ->> 'name')
      = internal.teacher_import_database_name_key(ur.row ->> 'name')
    and (
      select count(*) from jsonb_array_elements(k12.roster_rows) r
      where internal.teacher_import_database_name_key(r ->> 'name')
          = internal.teacher_import_database_name_key(kr.row ->> 'name')
    ) = 1
    and (
      select count(*) from jsonb_array_elements(university.roster_rows) r
      where internal.teacher_import_database_name_key(r ->> 'name')
          = internal.teacher_import_database_name_key(ur.row ->> 'name')
    ) = 1
    and encode(extensions.digest(
      convert_to('teacher-import-identity-link-v1', 'UTF8') || decode('00', 'hex')
      || convert_to(k12.revision, 'UTF8') || decode('00', 'hex')
      || convert_to(k12.source_id, 'UTF8') || decode('00', 'hex')
      || convert_to(trim(kr.row ->> 'sourceRow'), 'UTF8') || decode('00', 'hex')
      || convert_to(university.revision, 'UTF8') || decode('00', 'hex')
      || convert_to(university.source_id, 'UTF8') || decode('00', 'hex')
      || convert_to(trim(ur.row ->> 'sourceRow'), 'UTF8'),
      'sha256'
    ), 'hex') = substring(p_resolution_key from 8)
  limit 1;

  if k12_row is null or university_row is null then
    raise exception using errcode = '23503', message = 'teacher_identity_resolution_unavailable';
  end if;

  canonical_material := convert_to('teacher-import-identity-link-v1', 'UTF8') || decode('00', 'hex')
    || convert_to(k12.revision, 'UTF8') || decode('00', 'hex')
    || convert_to(k12.source_id, 'UTF8') || decode('00', 'hex')
    || convert_to(k12_row_key, 'UTF8') || decode('00', 'hex')
    || convert_to(university.revision, 'UTF8') || decode('00', 'hex')
    || convert_to(university.source_id, 'UTF8') || decode('00', 'hex')
    || convert_to(university_row_key, 'UTF8');
  expected_key := 'sha256:' || encode(extensions.digest(canonical_material, 'sha256'), 'hex');
  if expected_key <> p_resolution_key then
    raise exception using errcode = '23503', message = 'teacher_identity_resolution_unavailable';
  end if;

  refs := jsonb_build_array(
    jsonb_build_object('workbook', 'k12', 'sourceId', k12.source_id, 'sourceRow', k12_row -> 'sourceRow'),
    jsonb_build_object('workbook', 'university', 'sourceId', university.source_id, 'sourceRow', university_row -> 'sourceRow')
  );

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teacher_import_identity_link:' || p_resolution_key, 0));
  select * into existing from internal.teacher_import_identity_links l
  where l.resolution_key = p_resolution_key for update;
  if found then
    if existing.source_refs <> refs or existing.decision <> p_decision then
      raise exception using errcode = '23505', message = 'teacher_identity_link_conflict';
    end if;
    return jsonb_build_object('resolutionKey', existing.resolution_key, 'decision', existing.decision, 'unchanged', true);
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'teacher_import.identity_link_confirmed',
    p_actor,
    'teacher_import_identity_link',
    p_resolution_key,
    jsonb_build_object(
      'resolutionKey', p_resolution_key,
      'decision', p_decision,
      'k12Revision', k12.revision,
      'universityRevision', university.revision,
      'sourceRefs', refs
    )
  );

  insert into internal.teacher_import_identity_links (
    resolution_key, decision,
    k12_source_id, k12_revision, k12_source_row,
    university_source_id, university_revision, university_source_row,
    source_refs, confirmed_by, confirmed_at, audit_id
  ) values (
    p_resolution_key, p_decision,
    k12.source_id, k12.revision, k12_row_key,
    university.source_id, university.revision, university_row_key,
    refs, left(trim(p_actor), 120), now(), audit_entry_id
  );

  return jsonb_build_object('resolutionKey', p_resolution_key, 'decision', p_decision, 'unchanged', false);
end;
$$;

create or replace function public.put_teacher_import_hard_resolution(
  p_secret text,
  p_resolution_key text,
  p_decision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k12 internal.teacher_import_sources%rowtype;
  university internal.teacher_import_sources%rowtype;
  candidate jsonb;
  existing internal.teacher_import_hard_resolutions%rowtype;
  group_existing internal.teacher_import_hard_resolutions%rowtype;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_resolution_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_decision not in ('merge', 'separate', 'assign', 'ignore')
     or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023', message = 'invalid_teacher_hard_resolution_request';
  end if;

  -- Lock both complete sources before resolving the opaque key.  The caller
  -- cannot nominate a name, row, workbook, sheet, or teacher target.
  select * into k12 from internal.teacher_import_sources s
  where s.workbook = 'k12' for update;
  select * into university from internal.teacher_import_sources s
  where s.workbook = 'university' for update;
  if k12.workbook is null or university.workbook is null then
    raise exception using errcode = 'P0002', message = 'teacher_import_sources_unavailable';
  end if;

  select value into candidate
  from jsonb_array_elements(internal.teacher_import_hard_candidates(k12, university)) option
  where option ->> 'resolutionKey' = p_resolution_key
    and option ->> 'decision' = p_decision
  limit 1;
  if candidate is null then
    raise exception using errcode = '23503', message = 'teacher_hard_resolution_unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('teacher_import_hard_resolution:' || (candidate ->> 'resolutionGroupKey'), 0)
  );
  select * into existing
  from internal.teacher_import_hard_resolutions r
  where r.resolution_key = p_resolution_key for update;
  if found then
    if existing.decision <> p_decision
       or existing.k12_revision <> k12.revision
       or existing.university_revision <> university.revision then
      raise exception using errcode = '23505', message = 'teacher_hard_resolution_conflict';
    end if;
    return jsonb_build_object(
      'resolutionKey', existing.resolution_key,
      'decision', existing.decision,
      'unchanged', true
    );
  end if;
  select * into group_existing
  from internal.teacher_import_hard_resolutions r
  where r.resolution_group_key = candidate ->> 'resolutionGroupKey' for update;
  if found then
    raise exception using errcode = '23505', message = 'teacher_hard_resolution_conflict';
  end if;

  audit_entry_id := internal.append_operational_contract_audit(
    'teacher_import.hard_resolution_confirmed',
    p_actor,
    'teacher_import_hard_resolution',
    p_resolution_key,
    jsonb_build_object(
      'resolutionKey', p_resolution_key,
      'resolutionGroupKey', candidate ->> 'resolutionGroupKey',
      'kind', candidate ->> 'kind',
      'decision', p_decision,
      'k12Revision', k12.revision,
      'universityRevision', university.revision,
      'sourceRefs', candidate -> 'sourceRefs',
      'subjectRef', candidate -> 'subjectRef',
      'rosterRef', candidate -> 'rosterRef'
    )
  );
  insert into internal.teacher_import_hard_resolutions (
    resolution_key, resolution_group_key, kind, decision,
    k12_source_id, k12_revision, university_source_id, university_revision,
    source_refs, subject_ref, roster_ref,
    confirmed_by, confirmed_at, audit_id
  ) values (
    p_resolution_key, candidate ->> 'resolutionGroupKey', candidate ->> 'kind', p_decision,
    k12.source_id, k12.revision, university.source_id, university.revision,
    candidate -> 'sourceRefs', candidate -> 'subjectRef', candidate -> 'rosterRef',
    left(trim(p_actor), 120), now(), audit_entry_id
  );
  return jsonb_build_object(
    'resolutionKey', p_resolution_key,
    'decision', p_decision,
    'unchanged', false
  );
end;
$$;

revoke all on function public.put_teacher_import_source(text, text, text, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.get_latest_teacher_import_sources(text)
  from public, anon, authenticated;
revoke all on function public.put_teacher_import_identity_link(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.put_teacher_import_hard_resolution(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.put_teacher_import_source(text, text, text, text, jsonb, jsonb, jsonb, text)
  to anon, authenticated;
grant execute on function public.get_latest_teacher_import_sources(text)
  to anon, authenticated;
grant execute on function public.put_teacher_import_identity_link(text, text, text, text)
  to anon, authenticated;
grant execute on function public.put_teacher_import_hard_resolution(text, text, text, text)
  to anon, authenticated;

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
  removed_teacher_id text;
  hard_candidates jsonb;
  replaying_prior boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_plan_fingerprint, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_expected_teacher_version is null or p_expected_teacher_version < 0
     or p_actor not in ('Nixon', 'Ops Admin')
     or jsonb_typeof(p_source_revisions) <> 'object'
     or nullif(p_source_revisions ->> 'k12', '') is null
     or nullif(p_source_revisions ->> 'university', '') is null
     or jsonb_typeof(p_teachers) <> 'array'
     or jsonb_array_length(p_teachers) < 1
     or jsonb_array_length(p_teachers) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_teachers) t
       where jsonb_typeof(t) <> 'object'
          or jsonb_typeof(t -> 'id') <> 'string'
          or nullif(trim(t ->> 'id'), '') is null
          or jsonb_typeof(t -> 'name') <> 'string'
          or nullif(trim(t ->> 'name'), '') is null
          or jsonb_typeof(t -> 'initials') <> 'string'
          or nullif(trim(t ->> 'initials'), '') is null
          or jsonb_typeof(t -> 'subjects') <> 'array'
          or jsonb_typeof(t -> 'timezone') <> 'string'
          or nullif(trim(t ->> 'timezone'), '') is null
          or jsonb_typeof(t -> 'availability') <> 'string'
          or jsonb_typeof(t -> 'load') <> 'number'
          or (t ->> 'load')::numeric < 0
          or jsonb_typeof(t -> 'capacity') <> 'number'
          or (t ->> 'capacity')::numeric < 0
          or jsonb_typeof(t -> 'acceptsStudents') <> 'boolean'
          or jsonb_typeof(t -> 'note') <> 'string'
          or (t ? 'teacherSourceRefs' and jsonb_typeof(t -> 'teacherSourceRefs') <> 'array')
          or exists (
            select 1
            from jsonb_array_elements(
              case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
                then t -> 'teacherSourceRefs' else '[]'::jsonb end
            ) ref
            where jsonb_typeof(ref) <> 'object'
               or ref ->> 'workbook' not in ('k12', 'university')
               or jsonb_typeof(ref -> 'sourceId') <> 'string'
               or nullif(trim(ref ->> 'sourceId'), '') is null
               or jsonb_typeof(ref -> 'sourceRow') not in ('string', 'number')
               or nullif(trim(ref ->> 'sourceRow'), '') is null
               or ref - 'workbook' - 'sourceId' - 'sourceRow' <> '{}'::jsonb
          )
     )
     or (select count(*) from jsonb_array_elements(p_teachers)) <>
        (select count(distinct t ->> 'id') from jsonb_array_elements(p_teachers) t)
     or (
       select count(*)
       from jsonb_array_elements(p_teachers) t
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
           then t -> 'teacherSourceRefs' else '[]'::jsonb end
       ) ref
     ) <> (
       select count(distinct jsonb_build_array(
         ref ->> 'workbook', ref ->> 'sourceId', ref ->> 'sourceRow'
       ))
       from jsonb_array_elements(p_teachers) t
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
           then t -> 'teacherSourceRefs' else '[]'::jsonb end
       ) ref
     ) then
    raise exception using errcode = '22023', message = 'invalid_teacher_import_commit';
  end if;

  teachers_hash := encode(extensions.digest(p_teachers::text, 'sha256'), 'hex');
  select * into prior
  from internal.teacher_import_commits c
  where c.plan_fingerprint = p_plan_fingerprint
  for update;
  if found then
    if prior.k12_revision <> p_source_revisions ->> 'k12'
       or prior.university_revision <> p_source_revisions ->> 'university'
       or prior.teachers_sha256 <> teachers_hash then
      raise exception using errcode = '23505', message = 'teacher_import_fingerprint_conflict';
    end if;
    -- Do not return yet.  A replay is successful only after the current
    -- sources, decisions and canonical teachers row are locked and proven to
    -- still be the exact state produced by this command.
    replaying_prior := true;
  end if;

  select * into k12 from internal.teacher_import_sources s
  where s.workbook = 'k12' for update;
  select * into university from internal.teacher_import_sources s
  where s.workbook = 'university' for update;
  select * into current_state from public.ops_state s
  where s.entity = 'teachers' for update;

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

  hard_candidates := internal.teacher_import_hard_candidates(k12, university);

  -- Recompute every V2 option under the same locks used for the commit.  A
  -- saved row must still be one exact closed option from the two current
  -- snapshots, and every blocking group must have exactly one choice.
  if exists (
    select 1
    from internal.teacher_import_hard_resolutions r
    where r.k12_source_id = k12.source_id
      and r.k12_revision = k12.revision
      and r.university_source_id = university.source_id
      and r.university_revision = university.revision
      and not exists (
        select 1 from jsonb_array_elements(hard_candidates) option
        where option ->> 'resolutionKey' = r.resolution_key
          and option ->> 'resolutionGroupKey' = r.resolution_group_key
          and option ->> 'kind' = r.kind
          and option ->> 'decision' = r.decision
          and option -> 'sourceRefs' is not distinct from r.source_refs
          and option -> 'subjectRef' is not distinct from r.subject_ref
          and option -> 'rosterRef' is not distinct from r.roster_ref
      )
  ) then
    raise exception using errcode = '40001', message = 'teacher_import_hard_resolutions_changed';
  end if;
  if exists (
    select 1
    from (
      select distinct option ->> 'resolutionGroupKey' as resolution_group_key
      from jsonb_array_elements(hard_candidates) option
    ) candidate_group
    where not exists (
      select 1
      from internal.teacher_import_hard_resolutions r
      where r.resolution_group_key = candidate_group.resolution_group_key
        and r.k12_source_id = k12.source_id
        and r.k12_revision = k12.revision
        and r.university_source_id = university.source_id
        and r.university_revision = university.revision
    )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_hard_resolution_required';
  end if;

  -- The V1 two-row cross-workbook contract remains authoritative for simple
  -- pairs.  A separate plan cannot bypass the required confirmation merely
  -- because its output keeps the rows apart.
  if exists (
    select 1
    from (
      select internal.teacher_import_name_key(row ->> 'name') as name_key,
        (jsonb_agg(row) filter (where workbook = 'k12')) -> 0 as k12_row,
        (jsonb_agg(row) filter (where workbook = 'university')) -> 0 as university_row
      from (
        select 'k12'::text as workbook, row from jsonb_array_elements(k12.roster_rows) row
        union all
        select 'university', row from jsonb_array_elements(university.roster_rows) row
      ) roster
      group by internal.teacher_import_name_key(row ->> 'name')
      having count(*) = 2
        and count(*) filter (where workbook = 'k12') = 1
        and count(*) filter (where workbook = 'university') = 1
        and count(distinct internal.teacher_import_database_name_key(row ->> 'name')) = 1
    ) pair
    where not exists (
      select 1 from internal.teacher_import_identity_links l
      where l.k12_source_id = k12.source_id
        and l.k12_revision = k12.revision
        and l.k12_source_row = trim(pair.k12_row ->> 'sourceRow')
        and l.university_source_id = university.source_id
        and l.university_revision = university.revision
        and l.university_source_row = trim(pair.university_row ->> 'sourceRow')
    )
    and not exists (
      select 1 from jsonb_array_elements(current_state.payload) existing_teacher
      where exists (
        select 1 from jsonb_array_elements(coalesce(existing_teacher -> 'teacherSourceRefs', '[]'::jsonb)) ref
        where ref ->> 'workbook' = 'k12'
          and ref ->> 'sourceId' = k12.source_id
          and trim(ref ->> 'sourceRow') = trim(pair.k12_row ->> 'sourceRow')
      )
      and exists (
        select 1 from jsonb_array_elements(coalesce(existing_teacher -> 'teacherSourceRefs', '[]'::jsonb)) ref
        where ref ->> 'workbook' = 'university'
          and ref ->> 'sourceId' = university.source_id
          and trim(ref ->> 'sourceRow') = trim(pair.university_row ->> 'sourceRow')
      )
    )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_identity_link_required';
  end if;

  -- Validate that the replacement actually implements every current V2
  -- identity partition and subject assignment.  The saved decision is not a
  -- waiver; it is an invariant the payload must satisfy.
  if exists (
    select 1
    from internal.teacher_import_hard_resolutions r
    where r.k12_source_id = k12.source_id
      and r.k12_revision = k12.revision
      and r.university_source_id = university.source_id
      and r.university_revision = university.revision
      and r.kind in ('same_workbook_identity', 'cross_workbook_identity')
      and case r.decision
        when 'merge' then (
          select count(*)
          from jsonb_array_elements(p_teachers) teacher
          where (
            select count(*)
            from jsonb_array_elements(coalesce(teacher -> 'teacherSourceRefs', '[]'::jsonb)) teacher_ref
            join jsonb_array_elements(r.source_refs) decision_ref
              on teacher_ref ->> 'workbook' = decision_ref ->> 'workbook'
             and teacher_ref ->> 'sourceId' = decision_ref ->> 'sourceId'
             and trim(teacher_ref ->> 'sourceRow') = trim(decision_ref ->> 'sourceRow')
          ) = jsonb_array_length(r.source_refs)
        ) <> 1
        when 'separate' then exists (
          select 1
          from jsonb_array_elements(p_teachers) teacher
          where (
            select count(*)
            from jsonb_array_elements(coalesce(teacher -> 'teacherSourceRefs', '[]'::jsonb)) teacher_ref
            join jsonb_array_elements(r.source_refs) decision_ref
              on teacher_ref ->> 'workbook' = decision_ref ->> 'workbook'
             and teacher_ref ->> 'sourceId' = decision_ref ->> 'sourceId'
             and trim(teacher_ref ->> 'sourceRow') = trim(decision_ref ->> 'sourceRow')
          ) > 1
        )
        else true
      end
  ) then
    raise exception using errcode = '40001', message = 'teacher_import_hard_resolutions_changed';
  end if;
  if exists (
    select 1
    from internal.teacher_import_hard_resolutions r
    where r.k12_source_id = k12.source_id
      and r.k12_revision = k12.revision
      and r.university_source_id = university.source_id
      and r.university_revision = university.revision
      and r.kind = 'subject_assignment'
      and r.decision = 'assign'
      and not exists (
        select 1
        from jsonb_array_elements(p_teachers) teacher
        where exists (
          select 1 from jsonb_array_elements(coalesce(teacher -> 'teacherSourceRefs', '[]'::jsonb)) ref
          where ref ->> 'workbook' = r.roster_ref ->> 'workbook'
            and ref ->> 'sourceId' = r.roster_ref ->> 'sourceId'
            and trim(ref ->> 'sourceRow') = trim(r.roster_ref ->> 'sourceRow')
        )
        and exists (
          select 1 from jsonb_array_elements_text(coalesce(teacher -> 'subjects', '[]'::jsonb)) subject
          where subject = r.subject_ref ->> 'sheetName'
        )
      )
  ) then
    raise exception using errcode = '40001', message = 'teacher_import_hard_resolutions_changed';
  end if;

  -- A workbook refresh cannot silently remove a canonical teacher. It may
  -- only update linked teachers or add new ones; deactivation remains an
  -- explicit operational workflow so bookings/payroll/history keep identity.
  select old_teacher ->> 'id' into removed_teacher_id
  from jsonb_array_elements(current_state.payload) old_teacher
  where nullif(trim(old_teacher ->> 'id'), '') is not null
    and not exists (
      select 1 from jsonb_array_elements(p_teachers) new_teacher
      where new_teacher ->> 'id' = old_teacher ->> 'id'
    )
  limit 1;
  if removed_teacher_id is not null then
    raise exception using errcode = '23503', message = 'teacher_import_existing_teacher_removed';
  end if;

  -- Every current roster row must be represented exactly once by its stable
  -- source reference in the server-computed replacement.
  if exists (
    select 1
    from (
      select 'k12'::text as workbook, k12.source_id as source_id, row
      from jsonb_array_elements(k12.roster_rows) row
      union all
      select 'university'::text, university.source_id, row
      from jsonb_array_elements(university.roster_rows) row
    ) roster
    where (
      select count(*)
      from jsonb_array_elements(p_teachers) t
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
          then t -> 'teacherSourceRefs' else '[]'::jsonb end
      ) ref
      where ref ->> 'workbook' = roster.workbook
        and ref ->> 'sourceId' = roster.source_id
        and trim(ref ->> 'sourceRow') = trim(roster.row ->> 'sourceRow')
    ) <> 1
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_roster_reference_mismatch';
  end if;

  -- A canonical teacher may own current rows from both workbooks only when an
  -- administrator confirmed either the exact V1 pair or one complete current
  -- V2 cross-workbook merge group. This prevents a client-crafted payload from
  -- using same-name merging as a shortcut while allowing closed 1+N merges.
  if exists (
    select 1
    from jsonb_array_elements(p_teachers) t
    where exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
          then t -> 'teacherSourceRefs' else '[]'::jsonb end
      ) ref
      where ref ->> 'workbook' = 'k12'
        and ref ->> 'sourceId' = k12.source_id
        and exists (
          select 1 from jsonb_array_elements(k12.roster_rows) r
          where trim(r ->> 'sourceRow') = trim(ref ->> 'sourceRow')
        )
    )
    and exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
          then t -> 'teacherSourceRefs' else '[]'::jsonb end
      ) ref
      where ref ->> 'workbook' = 'university'
        and ref ->> 'sourceId' = university.source_id
        and exists (
          select 1 from jsonb_array_elements(university.roster_rows) r
          where trim(r ->> 'sourceRow') = trim(ref ->> 'sourceRow')
        )
    )
    and not exists (
      select 1
      from internal.teacher_import_identity_links l
      where l.k12_source_id = k12.source_id
        and l.k12_revision = k12.revision
        and l.university_source_id = university.source_id
        and l.university_revision = university.revision
        and l.decision = 'merge'
        and exists (
          select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
          where ref ->> 'workbook' = 'k12'
            and ref ->> 'sourceId' = l.k12_source_id
            and trim(ref ->> 'sourceRow') = l.k12_source_row
        )
        and exists (
          select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
          where ref ->> 'workbook' = 'university'
            and ref ->> 'sourceId' = l.university_source_id
            and trim(ref ->> 'sourceRow') = l.university_source_row
        )
    )
    and not exists (
      select 1
      from internal.teacher_import_hard_resolutions r
      where r.k12_source_id = k12.source_id
        and r.k12_revision = k12.revision
        and r.university_source_id = university.source_id
        and r.university_revision = university.revision
        and r.kind = 'cross_workbook_identity'
        and r.decision = 'merge'
        and (
          select count(*)
          from jsonb_array_elements(
            case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
              then t -> 'teacherSourceRefs' else '[]'::jsonb end
          ) teacher_ref
          join jsonb_array_elements(r.source_refs) decision_ref
            on teacher_ref ->> 'workbook' = decision_ref ->> 'workbook'
           and teacher_ref ->> 'sourceId' = decision_ref ->> 'sourceId'
           and trim(teacher_ref ->> 'sourceRow') = trim(decision_ref ->> 'sourceRow')
        ) = jsonb_array_length(r.source_refs)
        and not exists (
          select 1
          from jsonb_array_elements(
            case when jsonb_typeof(t -> 'teacherSourceRefs') = 'array'
              then t -> 'teacherSourceRefs' else '[]'::jsonb end
          ) teacher_ref
          where teacher_ref ->> 'sourceId' in (k12.source_id, university.source_id)
            and exists (
              select 1
              from jsonb_array_elements(k12.roster_rows) source_row
              where teacher_ref ->> 'workbook' = 'k12'
                and teacher_ref ->> 'sourceId' = k12.source_id
                and trim(teacher_ref ->> 'sourceRow') = trim(source_row ->> 'sourceRow')
              union all
              select 1
              from jsonb_array_elements(university.roster_rows) source_row
              where teacher_ref ->> 'workbook' = 'university'
                and teacher_ref ->> 'sourceId' = university.source_id
                and trim(teacher_ref ->> 'sourceRow') = trim(source_row ->> 'sourceRow')
            )
            and not exists (
              select 1 from jsonb_array_elements(r.source_refs) decision_ref
              where teacher_ref ->> 'workbook' = decision_ref ->> 'workbook'
                and teacher_ref ->> 'sourceId' = decision_ref ->> 'sourceId'
                and trim(teacher_ref ->> 'sourceRow') = trim(decision_ref ->> 'sourceRow')
            )
        )
    )
    and not exists (
      select 1
      from jsonb_array_elements(current_state.payload) existing_teacher
      where existing_teacher ->> 'id' = t ->> 'id'
        and exists (
          select 1 from jsonb_array_elements(
            case when jsonb_typeof(existing_teacher -> 'teacherSourceRefs') = 'array'
              then existing_teacher -> 'teacherSourceRefs' else '[]'::jsonb end
          ) ref
          where ref ->> 'workbook' = 'k12'
            and ref ->> 'sourceId' = k12.source_id
            and exists (
              select 1 from jsonb_array_elements(k12.roster_rows) r
              where trim(r ->> 'sourceRow') = trim(ref ->> 'sourceRow')
            )
        )
        and exists (
          select 1 from jsonb_array_elements(
            case when jsonb_typeof(existing_teacher -> 'teacherSourceRefs') = 'array'
              then existing_teacher -> 'teacherSourceRefs' else '[]'::jsonb end
          ) ref
          where ref ->> 'workbook' = 'university'
            and ref ->> 'sourceId' = university.source_id
            and exists (
              select 1 from jsonb_array_elements(university.roster_rows) r
              where trim(r ->> 'sourceRow') = trim(ref ->> 'sourceRow')
            )
        )
    )
  ) then
    raise exception using errcode = '23503', message = 'teacher_import_identity_link_required';
  end if;

  -- Conversely, every current decision must match the submitted grouping: a
  -- merge pair appears on exactly one canonical teacher, while a separate
  -- pair must never appear together. This also rejects stale pre-decision
  -- plans racing a newly-saved administrator choice.
  if exists (
    select 1
    from internal.teacher_import_identity_links l
    where l.k12_source_id = k12.source_id
      and l.k12_revision = k12.revision
      and l.university_source_id = university.source_id
      and l.university_revision = university.revision
      and case l.decision
        when 'merge' then (
        select count(*)
        from jsonb_array_elements(p_teachers) t
        where exists (
          select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
          where ref ->> 'workbook' = 'k12'
            and ref ->> 'sourceId' = l.k12_source_id
            and trim(ref ->> 'sourceRow') = l.k12_source_row
        )
        and exists (
          select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
          where ref ->> 'workbook' = 'university'
            and ref ->> 'sourceId' = l.university_source_id
            and trim(ref ->> 'sourceRow') = l.university_source_row
        )
        ) <> 1
        when 'separate' then exists (
          select 1
          from jsonb_array_elements(p_teachers) t
          where exists (
            select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
            where ref ->> 'workbook' = 'k12'
              and ref ->> 'sourceId' = l.k12_source_id
              and trim(ref ->> 'sourceRow') = l.k12_source_row
          )
          and exists (
            select 1 from jsonb_array_elements(t -> 'teacherSourceRefs') ref
            where ref ->> 'workbook' = 'university'
              and ref ->> 'sourceId' = l.university_source_id
              and trim(ref ->> 'sourceRow') = l.university_source_row
          )
        )
        else true
      end
  ) then
    raise exception using errcode = '40001', message = 'teacher_import_identity_links_changed';
  end if;

  if replaying_prior then
    return query select
      'teachers'::text,
      prior.teachers_version,
      prior.committed_at,
      prior.committed_by,
      false;
    return;
  end if;

  update public.ops_state s set
    payload = p_teachers,
    version = s.version + 1,
    updated_at = now(),
    updated_by = left(trim(p_actor), 80)
  where s.entity = 'teachers'
  returning s.* into current_state;

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

-- Availability submissions existed in the first deployed form database but
-- were never declared by the checked-in migration chain.  Declare the full
-- server-owned contract here so a clean database can replay this migration,
-- while every IF NOT EXISTS / ADD COLUMN IF NOT EXISTS remains compatible
-- with that production table.
create table if not exists public.teacher_availability_submissions (
  id bigint generated by default as identity primary key,
  teacher_id text not null,
  teacher_name text not null,
  submission_month text not null,
  availability_timezone text not null,
  current_city text,
  additional_students integer not null default 0,
  availability_slots jsonb not null default '[]'::jsonb,
  notes text,
  status text not null default 'pending',
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  review_note text
);

alter table public.teacher_availability_submissions
  add column if not exists id bigint generated by default as identity,
  add column if not exists teacher_id text,
  add column if not exists teacher_name text,
  add column if not exists submission_month text,
  add column if not exists availability_timezone text,
  add column if not exists current_city text,
  add column if not exists additional_students integer default 0,
  add column if not exists availability_slots jsonb default '[]'::jsonb,
  add column if not exists notes text,
  add column if not exists status text default 'pending',
  add column if not exists submitted_at timestamptz default now(),
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text,
  add column if not exists review_note text;

-- Do not silently coerce or delete legacy production rows.  New/updated rows
-- are constrained through NOT VALID checks, which are replay-safe and can be
-- validated after the existing data has been audited separately.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.teacher_availability_submissions'::regclass
      and conname in (
        'teacher_availability_submissions_month_check',
        'teacher_availability_submissions_submission_month_check'
      )
  ) then
    alter table public.teacher_availability_submissions
      add constraint teacher_availability_submissions_month_check
      check (submission_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.teacher_availability_submissions'::regclass
      and conname = 'teacher_availability_submissions_capacity_check'
  ) then
    alter table public.teacher_availability_submissions
      add constraint teacher_availability_submissions_capacity_check
      check (additional_students between 0 and 100) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.teacher_availability_submissions'::regclass
      and conname = 'teacher_availability_submissions_slots_check'
  ) then
    alter table public.teacher_availability_submissions
      add constraint teacher_availability_submissions_slots_check
      check (jsonb_typeof(availability_slots) = 'array') not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.teacher_availability_submissions'::regclass
      and conname = 'teacher_availability_submissions_status_check'
  ) then
    alter table public.teacher_availability_submissions
      add constraint teacher_availability_submissions_status_check
      check (status in ('pending', 'approved', 'rejected')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.teacher_availability_submissions'::regclass
      and conname = 'teacher_availability_submissions_review_check'
  ) then
    alter table public.teacher_availability_submissions
      add constraint teacher_availability_submissions_review_check
      check (
        (status = 'pending' and reviewed_at is null and reviewed_by is null)
        or (status in ('approved', 'rejected') and reviewed_at is not null and nullif(trim(reviewed_by), '') is not null)
      ) not valid;
  end if;
end;
$$;

create index if not exists teacher_availability_submissions_review_inbox_idx
  on public.teacher_availability_submissions (status, submitted_at desc, id desc);
create unique index if not exists teacher_availability_submissions_id_uidx
  on public.teacher_availability_submissions (id);
create index if not exists teacher_availability_submissions_teacher_month_idx
  on public.teacher_availability_submissions (teacher_id, submission_month, submitted_at desc);

alter table public.teacher_availability_submissions enable row level security;
revoke all on table public.teacher_availability_submissions from public, anon, authenticated;

create table if not exists internal.teacher_availability_reviews (
  submission_id bigint primary key references public.teacher_availability_submissions(id),
  decision text not null check (decision in ('approved', 'rejected')),
  teacher_version bigint not null check (teacher_version > 0),
  availability_sha256 text,
  reviewed_by text not null check (length(reviewed_by) between 1 and 120),
  reviewed_at timestamptz not null default now(),
  review_note text,
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.teacher_availability_reviews enable row level security;
revoke all on table internal.teacher_availability_reviews from public, anon, authenticated;

create or replace function public.review_teacher_availability_submission_atomic(
  p_secret text,
  p_submission_id bigint,
  p_decision text,
  p_expected_submission_status text,
  p_expected_teacher_version bigint,
  p_availability_windows jsonb,
  p_actor text,
  p_review_note text default null
)
returns table (
  submission_id bigint,
  status text,
  teacher_version bigint,
  reviewed_at timestamptz,
  reviewed_by text,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  submission public.teacher_availability_submissions%rowtype;
  teacher_state public.ops_state%rowtype;
  prior internal.teacher_availability_reviews%rowtype;
  current_teacher jsonb;
  next_teachers jsonb;
  expected_retained_windows jsonb := '[]'::jsonb;
  old_window jsonb;
  retained_piece jsonb;
  retained_excluded jsonb;
  retained_overrides jsonb;
  windows_hash text;
  audit_id uuid;
  reviewed_time timestamptz;
  month_start date;
  month_end date;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_submission_id is null or p_submission_id < 1
     or p_decision not in ('approved', 'rejected')
     or p_expected_submission_status <> 'pending'
     or p_expected_teacher_version is null or p_expected_teacher_version < 1
     or p_actor not in ('Nixon', 'Ops Admin')
     or length(coalesce(p_review_note, '')) > 1000
     or (p_decision = 'approved' and jsonb_typeof(p_availability_windows) <> 'array')
     or (p_decision = 'rejected' and p_availability_windows is not null) then
    raise exception using errcode = '22023', message = 'invalid_availability_review';
  end if;

  select * into submission
  from public.teacher_availability_submissions s
  where s.id = p_submission_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'availability_submission_not_found';
  end if;

  select * into prior
  from internal.teacher_availability_reviews r
  where r.submission_id = p_submission_id
  for update;
  if found then
    if prior.decision <> p_decision
       or (p_decision = 'approved' and prior.availability_sha256 <>
           encode(extensions.digest(p_availability_windows::text, 'sha256'), 'hex')) then
      raise exception using errcode = '23505', message = 'availability_submission_already_reviewed';
    end if;
    return query select
      prior.submission_id,
      prior.decision,
      prior.teacher_version,
      prior.reviewed_at,
      prior.reviewed_by,
      prior.audit_id;
    return;
  end if;

  if submission.status <> p_expected_submission_status then
    raise exception using errcode = '40001', message = 'availability_submission_status_changed';
  end if;

  -- Always lock the teachers row, including reject, so the reviewed result
  -- carries a precise directory version for the audit trail.
  select * into teacher_state
  from public.ops_state s
  where s.entity = 'teachers'
  for update;
  if teacher_state.entity is null or jsonb_typeof(teacher_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'teachers_state_unavailable';
  end if;
  if teacher_state.version <> p_expected_teacher_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if (select count(*) from jsonb_array_elements(teacher_state.payload) t
      where t ->> 'id' = submission.teacher_id) <> 1 then
    raise exception using errcode = 'P0002', message = 'availability_teacher_not_found';
  end if;
  select t into current_teacher
  from jsonb_array_elements(teacher_state.payload) t
  where t ->> 'id' = submission.teacher_id;

  if p_decision = 'approved' then
    begin
      month_start := (submission.submission_month || '-01')::date;
      month_end := (month_start + interval '1 month - 1 day')::date;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_availability_submission_month';
    end;

    if jsonb_typeof(coalesce(current_teacher -> 'availabilityWindows', '[]'::jsonb))
       is distinct from 'array'
       or exists (
         select 1
         from jsonb_array_elements(coalesce(current_teacher -> 'availabilityWindows', '[]'::jsonb)) old
         where jsonb_typeof(old) is distinct from 'object'
            or jsonb_typeof(old -> 'id') is distinct from 'string'
            or nullif(trim(old ->> 'id'), '') is null
            or old ->> 'teacherId' is distinct from submission.teacher_id
            or coalesce(old ->> 'validFrom', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            or coalesce(old ->> 'validTo', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            or (old ->> 'validFrom')::date > (old ->> 'validTo')::date
            or jsonb_typeof(old -> 'excludedDates') is distinct from 'array'
            or jsonb_typeof(old -> 'overrides') is distinct from 'array'
       ) then
      raise exception using errcode = '55000', message = 'availability_teacher_state_invalid';
    end if;

    -- Recreate the pure-domain retainOutsideMonth contract in the database.
    -- The caller may supply the resulting complete teacher list, but cannot
    -- silently drop or rewrite availability outside the reviewed month.
    for old_window in
      select old
      from jsonb_array_elements(coalesce(current_teacher -> 'availabilityWindows', '[]'::jsonb)) old
      order by old ->> 'id'
    loop
      if (old_window ->> 'validTo')::date < month_start
         or (old_window ->> 'validFrom')::date > month_end then
        expected_retained_windows := expected_retained_windows || jsonb_build_array(old_window);
        continue;
      end if;

      if (old_window ->> 'validFrom')::date < month_start then
        select coalesce(jsonb_agg(value order by value #>> '{}'), '[]'::jsonb)
        into retained_excluded
        from jsonb_array_elements(old_window -> 'excludedDates') value
        where (value #>> '{}')::date between (old_window ->> 'validFrom')::date and month_start - 1;
        select coalesce(jsonb_agg(value order by value ->> 'date'), '[]'::jsonb)
        into retained_overrides
        from jsonb_array_elements(old_window -> 'overrides') value
        where (value ->> 'date')::date between (old_window ->> 'validFrom')::date and month_start - 1;
        retained_piece := jsonb_set(
          jsonb_set(
            jsonb_set(old_window, '{validTo}', to_jsonb((month_start - 1)::text), true),
            '{excludedDates}', retained_excluded, true
          ),
          '{overrides}', retained_overrides, true
        );
        expected_retained_windows := expected_retained_windows || jsonb_build_array(retained_piece);
      end if;

      if (old_window ->> 'validTo')::date > month_end then
        select coalesce(jsonb_agg(value order by value #>> '{}'), '[]'::jsonb)
        into retained_excluded
        from jsonb_array_elements(old_window -> 'excludedDates') value
        where (value #>> '{}')::date between month_end + 1 and (old_window ->> 'validTo')::date;
        select coalesce(jsonb_agg(value order by value ->> 'date'), '[]'::jsonb)
        into retained_overrides
        from jsonb_array_elements(old_window -> 'overrides') value
        where (value ->> 'date')::date between month_end + 1 and (old_window ->> 'validTo')::date;
        retained_piece := jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(old_window, '{validFrom}', to_jsonb((month_end + 1)::text), true),
              '{id}',
              to_jsonb(case when (old_window ->> 'validFrom')::date < month_start
                then (old_window ->> 'id') || ':after:' || submission.submission_month
                else old_window ->> 'id' end),
              true
            ),
            '{excludedDates}', retained_excluded, true
          ),
          '{overrides}', retained_overrides, true
        );
        expected_retained_windows := expected_retained_windows || jsonb_build_array(retained_piece);
      end if;
    end loop;

    if exists (
      select 1 from jsonb_array_elements(p_availability_windows) w
      where jsonb_typeof(w) is distinct from 'object'
         or jsonb_typeof(w -> 'id') is distinct from 'string'
         or nullif(trim(w ->> 'id'), '') is null
         or w ->> 'teacherId' <> submission.teacher_id
         or jsonb_typeof(w -> 'day') is distinct from 'number'
         or (w ->> 'day')::integer not between 0 and 6
         or coalesce(w ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or coalesce(w ->> 'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or coalesce(w ->> 'validFrom', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or coalesce(w ->> 'validTo', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or (w ->> 'validFrom')::date > (w ->> 'validTo')::date
         or coalesce(w ->> 'start', '') = coalesce(w ->> 'end', '')
         or nullif(trim(w ->> 'timezone'), '') is null
         or coalesce(w ->> 'source', '') not in ('submission', 'manual', 'legacy-promoted')
         or jsonb_typeof(w -> 'excludedDates') is distinct from 'array'
         or jsonb_typeof(w -> 'overrides') is distinct from 'array'
    )
    or (select count(*) from jsonb_array_elements(p_availability_windows)) <>
       (select count(distinct w ->> 'id') from jsonb_array_elements(p_availability_windows) w) then
      raise exception using errcode = '22023', message = 'invalid_availability_windows';
    end if;

    -- The writeback is validated against the raw submitted slot set rather
    -- than trusting window values supplied by the browser.
    if (select count(*) from jsonb_array_elements(p_availability_windows) w
        where w ->> 'sourceSubmissionId' = submission.id::text) <>
       jsonb_array_length(submission.availability_slots)
    or exists (
      select 1 from jsonb_array_elements(p_availability_windows) w
      where w ->> 'sourceSubmissionId' = submission.id::text
        and (
          w ->> 'source' <> 'submission'
          or w ->> 'timezone' <> submission.availability_timezone
          or w ->> 'validFrom' <> month_start::text
          or w ->> 'validTo' <> month_end::text
        )
    )
    or exists (
      select 1 from jsonb_array_elements(p_availability_windows) w
      where w ->> 'sourceSubmissionId' is distinct from submission.id::text
        and (w ->> 'validFrom')::date <= month_end
        and (w ->> 'validTo')::date >= month_start
    )
    or jsonb_array_length(p_availability_windows)
       - jsonb_array_length(submission.availability_slots)
       <> jsonb_array_length(expected_retained_windows)
    or exists (
      select 1 from jsonb_array_elements(expected_retained_windows) expected
      where not exists (
        select 1 from jsonb_array_elements(p_availability_windows) supplied
        where supplied = expected
      )
    )
    or exists (
      select 1 from jsonb_array_elements(p_availability_windows) supplied
      where supplied ->> 'sourceSubmissionId' is distinct from submission.id::text
        and not exists (
          select 1 from jsonb_array_elements(expected_retained_windows) expected
          where expected = supplied
        )
    )
    then
      raise exception using errcode = '22023', message = 'invalid_availability_month_replacement';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(submission.availability_slots) submitted
      where not exists (
        select 1 from jsonb_array_elements(p_availability_windows) w
        where w ->> 'sourceSubmissionId' = submission.id::text
          and (w ->> 'day')::integer = (submitted ->> 'day')::integer
          and w ->> 'start' = submitted ->> 'start'
          and w ->> 'end' = submitted ->> 'end'
      )
    ) or exists (
      select 1
      from jsonb_array_elements(p_availability_windows) w
      where w ->> 'sourceSubmissionId' = submission.id::text
        and not exists (
        select 1 from jsonb_array_elements(submission.availability_slots) submitted
        where (w ->> 'day')::integer = (submitted ->> 'day')::integer
          and w ->> 'start' = submitted ->> 'start'
          and w ->> 'end' = submitted ->> 'end'
      )
    ) then
      raise exception using errcode = '22023', message = 'availability_windows_do_not_match_submission';
    end if;

    windows_hash := encode(extensions.digest(p_availability_windows::text, 'sha256'), 'hex');
    select jsonb_agg(
      case when t ->> 'id' = submission.teacher_id then
        jsonb_set(
          jsonb_set(
            jsonb_set(t, '{availabilityWindows}', p_availability_windows, true),
            '{newStudentCapacity}', to_jsonb(submission.additional_students), true
          ),
          '{availabilityUpdated}', to_jsonb('submission:' || submission.id::text), true
        )
      else t end order by ordinal
    ) into next_teachers
    from jsonb_array_elements(teacher_state.payload) with ordinality as item(t, ordinal);

    update public.ops_state s set
      payload = next_teachers,
      version = s.version + 1,
      updated_at = now(),
      updated_by = left(trim(p_actor), 80)
    where s.entity = 'teachers'
    returning s.* into teacher_state;

    insert into public.ops_mutation_log(entity, version, actor)
    values ('teachers', teacher_state.version, teacher_state.updated_by);
  else
    windows_hash := null;
  end if;

  reviewed_time := now();
  update public.teacher_availability_submissions s set
    status = p_decision,
    reviewed_at = reviewed_time,
    reviewed_by = left(trim(p_actor), 120),
    review_note = nullif(left(trim(coalesce(p_review_note, '')), 1000), '')
  where s.id = p_submission_id;

  audit_id := internal.append_operational_contract_audit(
    'teacher_availability.' || p_decision,
    p_actor,
    'teacher_availability_submission',
    p_submission_id::text,
    jsonb_build_object(
      'teacherId', submission.teacher_id,
      'month', submission.submission_month,
      'teacherVersionBefore', p_expected_teacher_version,
      'teacherVersionAfter', teacher_state.version,
      'availabilitySha256', windows_hash,
      'reviewNote', nullif(trim(coalesce(p_review_note, '')), '')
    )
  );

  insert into internal.teacher_availability_reviews (
    submission_id, decision, teacher_version, availability_sha256,
    reviewed_by, reviewed_at, review_note, audit_id
  ) values (
    p_submission_id, p_decision, teacher_state.version, windows_hash,
    left(trim(p_actor), 120), reviewed_time,
    nullif(left(trim(coalesce(p_review_note, '')), 1000), ''), audit_id
  );

  return query select
    p_submission_id,
    p_decision,
    teacher_state.version,
    reviewed_time,
    left(trim(p_actor), 120),
    audit_id;
end;
$$;

revoke all on function public.review_teacher_availability_submission_atomic(text, bigint, text, text, bigint, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.review_teacher_availability_submission_atomic(text, bigint, text, text, bigint, jsonb, text, text)
  to anon, authenticated;

-- Return the review columns as part of the inbox so the UI can distinguish a
-- pending item from an already-reviewed one without a second table endpoint.
-- PostgreSQL cannot change an existing function's table return shape through
-- CREATE OR REPLACE, so remove the deployed 11-column version first.
drop function if exists public.get_teacher_availability_submissions(text);

create or replace function public.get_teacher_availability_submissions(p_secret text)
returns table (
  id bigint,
  teacher_id text,
  teacher_name text,
  submission_month text,
  availability_timezone text,
  current_city text,
  additional_students integer,
  availability_slots jsonb,
  notes text,
  status text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,
  review_note text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  return query
  select
    s.id, s.teacher_id, s.teacher_name, s.submission_month, s.availability_timezone,
    s.current_city, s.additional_students, s.availability_slots, s.notes, s.status,
    s.submitted_at, s.reviewed_at, s.reviewed_by, s.review_note
  from public.teacher_availability_submissions s
  order by s.submitted_at desc;
end;
$$;

revoke all on function public.get_teacher_availability_submissions(text)
  from public, anon, authenticated;
grant execute on function public.get_teacher_availability_submissions(text)
  to anon, authenticated;

-- Booking series and teacher new-student capacity are one invariant.  The
-- Next.js service accepts only a narrow command, derives these payloads from a
-- locked snapshot and sends the reviewed transition here.  This RPC locks all
-- three state rows again, compares the exact versions and writes bookings plus
-- teachers in one transaction; it never accepts a students replacement.
create table if not exists internal.booking_capacity_commands (
  command_key text primary key check (command_key ~ '^booking-capacity:[a-f0-9]{64}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('create', 'update', 'delete')),
  booking_id text not null check (length(booking_id) between 1 and 120),
  booking_version bigint not null check (booking_version > 0),
  teacher_version bigint not null check (teacher_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.booking_capacity_commands enable row level security;
revoke all on table internal.booking_capacity_commands from public, anon, authenticated;

create or replace function public.get_booking_capacity_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_actor text
)
returns table (
  command_key text,
  action text,
  booking_id text,
  audit_entry_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  prior internal.booking_capacity_commands%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^booking-capacity:[a-f0-9]{64}$'
     or jsonb_typeof(p_command_intent) <> 'object'
     or nullif(trim(p_actor), '') is null then
    raise exception using errcode = '22023', message = 'invalid_booking_capacity_replay_lookup';
  end if;
  select * into prior from internal.booking_capacity_commands c
  where c.command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent
     or prior.actor <> left(trim(p_actor), 120) then
    raise exception using errcode = '23505', message = 'booking_capacity_idempotency_conflict';
  end if;
  return query select prior.command_key, prior.action, prior.booking_id, prior.audit_id;
end;
$$;

revoke all on function public.get_booking_capacity_command_result(text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.get_booking_capacity_command_result(text, text, jsonb, text)
  to anon, authenticated;

create or replace function public.mutate_booking_capacity_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_action text,
  p_booking_id text,
  p_expected_versions jsonb,
  p_bookings jsonb,
  p_teachers jsonb,
  p_changed_teacher_ids jsonb,
  p_student_id text,
  p_teacher_id text,
  p_actor text
)
returns table (
  command_key text,
  action text,
  applied boolean,
  booking_id text,
  bookings_row public.ops_state,
  teachers_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  booking_state public.ops_state%rowtype;
  student_state public.ops_state%rowtype;
  teacher_state public.ops_state%rowtype;
  prior internal.booking_capacity_commands%rowtype;
  saved_booking_state public.ops_state%rowtype;
  saved_teacher_state public.ops_state%rowtype;
  audit_id uuid;
  expected_booking_version bigint;
  expected_student_version bigint;
  expected_teacher_version bigint;
  changed_teacher_id jsonb;
  current_booking jsonb;
  next_booking jsonb;
  current_student jsonb;
  target_student jsonb;
  payload_hash text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^booking-capacity:[a-f0-9]{64}$'
     or jsonb_typeof(p_command_intent) <> 'object'
     or not (
       (p_command_intent ->> 'action' = 'upsert' and p_action in ('create', 'update'))
       or (p_command_intent ->> 'action' = 'delete' and p_action = 'delete')
     )
     or p_command_intent ->> 'bookingId' is distinct from p_booking_id
     or p_action not in ('create', 'update', 'delete')
     or nullif(trim(p_booking_id), '') is null
     or nullif(trim(p_student_id), '') is null
     or nullif(trim(p_teacher_id), '') is null
     or nullif(trim(p_actor), '') is null
     or jsonb_typeof(p_expected_versions) <> 'object'
     or p_expected_versions - 'bookings' - 'students' - 'teachers' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'bookings') <> 'number'
     or jsonb_typeof(p_expected_versions -> 'students') <> 'number'
     or jsonb_typeof(p_expected_versions -> 'teachers') <> 'number'
     or jsonb_typeof(p_bookings) <> 'array'
     or jsonb_typeof(p_teachers) <> 'array'
     or jsonb_typeof(p_changed_teacher_ids) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_booking_capacity_command';
  end if;
  -- Hash inside PostgreSQL so idempotency never depends on JavaScript versus
  -- jsonb object-key ordering or serialization details.
  payload_hash := encode(extensions.digest(
    jsonb_build_object(
      'action', p_action,
      'bookingId', p_booking_id,
      'expectedVersions', p_expected_versions,
      'bookings', p_bookings,
      'teachers', p_teachers,
      'changedTeacherIds', p_changed_teacher_ids
    )::text,
    'sha256'
  ), 'hex');

  begin
    expected_booking_version := (p_expected_versions ->> 'bookings')::bigint;
    expected_student_version := (p_expected_versions ->> 'students')::bigint;
    expected_teacher_version := (p_expected_versions ->> 'teachers')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_booking_capacity_versions';
  end;
  if expected_booking_version is null or expected_booking_version < 1
     or expected_student_version is null or expected_student_version < 1
     or expected_teacher_version is null or expected_teacher_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_booking_capacity_versions';
  end if;

  -- Idempotent replay returns the original committed rows when their current
  -- versions still identify that exact result.  A mismatched hash is rejected.
  select * into prior
  from internal.booking_capacity_commands c
  where c.command_key = p_command_key;

  -- Stable lock order prevents booking/capacity writes from racing each other.
  select * into booking_state from public.ops_state s where s.entity = 'bookings' for update;
  select * into student_state from public.ops_state s where s.entity = 'students' for update;
  select * into teacher_state from public.ops_state s where s.entity = 'teachers' for update;
  if booking_state.entity is null or student_state.entity is null or teacher_state.entity is null then
    raise exception using errcode = '55000', message = 'booking_capacity_state_missing';
  end if;

  -- Archive status is authoritative from the locked canonical student row.
  -- Check it even before an idempotent replay can return, so a command that
  -- committed while active cannot be replayed after the student is archived.
  current_booking := (
    select value from jsonb_array_elements(booking_state.payload) value
    where value ->> 'id' = p_booking_id limit 1
  );
  target_student := (
    select value from jsonb_array_elements(student_state.payload) value
    where value ->> 'id' = p_student_id limit 1
  );
  if target_student is null then
    raise exception using errcode = '22023', message = 'booking_student_not_found';
  end if;
  if target_student ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'archived_student_booking_read_only';
  end if;
  if current_booking is not null then
    current_student := (
      select value from jsonb_array_elements(student_state.payload) value
      where value ->> 'id' = current_booking ->> 'studentId' limit 1
    );
    if current_student is null then
      raise exception using errcode = '22023', message = 'booking_student_not_found';
    end if;
    if current_student ->> 'importArchived' = 'true' then
      raise exception using errcode = '42501', message = 'archived_student_booking_read_only';
    end if;
  end if;

  -- Re-read after acquiring the canonical locks. A concurrent identical
  -- command may have committed while this transaction was waiting.
  select * into prior
  from internal.booking_capacity_commands c
  where c.command_key = p_command_key;

  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent
       or prior.actor <> left(trim(p_actor), 120)
       or prior.action <> p_action
       or prior.booking_id <> p_booking_id then
      raise exception using errcode = '23505', message = 'booking_capacity_idempotency_conflict';
    end if;
    return query select
      prior.command_key, prior.action, false, prior.booking_id,
      booking_state, teacher_state, prior.audit_id;
    return;
  end if;

  if booking_state.version is distinct from expected_booking_version
     or student_state.version is distinct from expected_student_version
     or teacher_state.version is distinct from expected_teacher_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  -- Recheck identities and restrict the payload change surface.  The service
  -- may change only the named booking and the named capacity teachers.
  next_booking := (
    select value from jsonb_array_elements(p_bookings) value
    where value ->> 'id' = p_booking_id limit 1
  );
  if (p_action = 'create' and (current_booking is not null or next_booking is null))
     or (p_action = 'update' and (current_booking is null or next_booking is null))
     or (p_action = 'delete' and (current_booking is null or next_booking is not null)) then
    raise exception using errcode = '22023', message = 'booking_action_does_not_match_state';
  end if;
  if p_action <> 'delete' and (
       next_booking ->> 'studentId' is distinct from p_student_id
       or next_booking ->> 'teacherId' is distinct from p_teacher_id
     ) then
    raise exception using errcode = '22023', message = 'booking_identity_mismatch';
  end if;
  if exists (
    select 1 from jsonb_array_elements(booking_state.payload) value
    group by value ->> 'id'
    having value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(p_bookings) value
    group by value ->> 'id'
    having value ->> 'id' is null or count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'duplicate_booking_id';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(booking_state.payload) old_value
    full join jsonb_array_elements(p_bookings) new_value
      on old_value ->> 'id' = new_value ->> 'id'
    where coalesce(old_value ->> 'id', new_value ->> 'id') <> p_booking_id
      and old_value is distinct from new_value
  ) then
    raise exception using errcode = '22023', message = 'unrelated_booking_changed';
  end if;

  for changed_teacher_id in select value from jsonb_array_elements(p_changed_teacher_ids)
  loop
    if jsonb_typeof(changed_teacher_id) <> 'string' then
      raise exception using errcode = '22023', message = 'invalid_changed_teacher_id';
    end if;
  end loop;
  if exists (
    select 1
    from jsonb_array_elements(teacher_state.payload) old_value
    full join jsonb_array_elements(p_teachers) new_value
      on old_value ->> 'id' = new_value ->> 'id'
    where old_value is null or new_value is null
       or (
         old_value is distinct from new_value
         and not exists (
           select 1 from jsonb_array_elements_text(p_changed_teacher_ids) changed(id)
           where changed.id = coalesce(old_value ->> 'id', new_value ->> 'id')
         )
       )
       or (
         old_value is distinct from new_value
         and (old_value - 'newStudentCapacity' - 'capacityAssignments')
             is distinct from (new_value - 'newStudentCapacity' - 'capacityAssignments')
       )
  ) then
    raise exception using errcode = '22023', message = 'unrelated_teacher_changed';
  end if;

  update public.ops_state s set
    payload = p_bookings,
    version = s.version + 1,
    updated_at = now(),
    updated_by = left(trim(p_actor), 120)
  where s.entity = 'bookings'
  returning s.* into saved_booking_state;

  if teacher_state.payload is distinct from p_teachers then
    update public.ops_state s set
      payload = p_teachers,
      version = s.version + 1,
      updated_at = now(),
      updated_by = left(trim(p_actor), 120)
    where s.entity = 'teachers'
    returning s.* into saved_teacher_state;
  else
    saved_teacher_state := teacher_state;
  end if;

  audit_id := internal.append_operational_contract_audit(
    'booking_capacity_' || p_action,
    left(trim(p_actor), 120),
    'booking',
    p_booking_id,
    jsonb_build_object(
      'studentId', p_student_id,
      'teacherId', p_teacher_id,
      'changedTeacherIds', p_changed_teacher_ids,
      'bookingVersion', saved_booking_state.version,
      'teacherVersion', saved_teacher_state.version
    )
  );

  insert into internal.booking_capacity_commands (
    command_key, command_intent, command_hash, action, booking_id, booking_version,
    teacher_version, actor, audit_id
  ) values (
    p_command_key, p_command_intent, payload_hash, p_action, p_booking_id,
    saved_booking_state.version, saved_teacher_state.version,
    left(trim(p_actor), 120), audit_id
  );

  return query select
    p_command_key, p_action, true, p_booking_id,
    saved_booking_state, saved_teacher_state, audit_id;
end;
$$;

revoke all on function public.mutate_booking_capacity_atomic(text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mutate_booking_capacity_atomic(text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)
  to anon, authenticated;

-- Final confirmation of a leave/substitution is a single command over the
-- canonical booking occurrenceOverrides and its operation record. The Next.js
-- service derives exact occurrence IDs from the locked state; this RPC locks
-- bookings, operations and teachers again and rejects any broadened payload.
create table if not exists internal.operation_confirmation_commands (
  command_key text primary key check (command_key ~ '^operation-confirm:[a-f0-9]{64}$'),
  command_intent jsonb not null check (jsonb_typeof(command_intent) = 'object'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  operation_id text not null check (length(operation_id) between 1 and 120),
  action text not null check (action in ('leave', 'substitute', 'confirm_only')),
  affected_occurrence_ids jsonb not null check (jsonb_typeof(affected_occurrence_ids) = 'array'),
  booking_version bigint not null check (booking_version > 0),
  operation_version bigint not null check (operation_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  applied_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.operation_confirmation_commands enable row level security;
revoke all on table internal.operation_confirmation_commands from public, anon, authenticated;

create or replace function public.get_operation_confirmation_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_actor text
)
returns table (
  command_key text,
  operation_id text,
  action text,
  affected_occurrence_ids jsonb,
  audit_entry_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  prior internal.operation_confirmation_commands%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^operation-confirm:[a-f0-9]{64}$'
     or jsonb_typeof(p_command_intent) <> 'object'
     or nullif(trim(p_actor), '') is null then
    raise exception using errcode = '22023', message = 'invalid_operation_confirmation_replay_lookup';
  end if;
  select * into prior from internal.operation_confirmation_commands c
  where c.command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_intent is distinct from p_command_intent
     or prior.actor <> left(trim(p_actor), 120) then
    raise exception using errcode = '23505', message = 'operation_confirmation_idempotency_conflict';
  end if;
  return query select prior.command_key, prior.operation_id, prior.action,
    prior.affected_occurrence_ids, prior.audit_id;
end;
$$;

revoke all on function public.get_operation_confirmation_command_result(text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.get_operation_confirmation_command_result(text, text, jsonb, text)
  to anon, authenticated;

create or replace function public.confirm_operation_occurrences_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_operation_id text,
  p_action text,
  p_chosen_teacher_id text,
  p_expected_versions jsonb,
  p_bookings jsonb,
  p_operations jsonb,
  p_affected_occurrence_ids jsonb,
  p_actor text
)
returns table (
  command_key text,
  operation_id text,
  action text,
  applied boolean,
  affected_occurrence_ids jsonb,
  bookings_row public.ops_state,
  operations_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  booking_state public.ops_state%rowtype;
  operation_state public.ops_state%rowtype;
  student_state public.ops_state%rowtype;
  teacher_state public.ops_state%rowtype;
  saved_booking_state public.ops_state%rowtype;
  saved_operation_state public.ops_state%rowtype;
  prior internal.operation_confirmation_commands%rowtype;
  expected_booking_version bigint;
  expected_operation_version bigint;
  expected_teacher_version bigint;
  current_operation jsonb;
  current_student jsonb;
  next_operation jsonb;
  occurrence_id text;
  series_id text;
  old_booking jsonb;
  new_booking jsonb;
  old_override jsonb;
  new_override jsonb;
  expected_status text;
  audit_id uuid;
  payload_hash text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^operation-confirm:[a-f0-9]{64}$'
     or jsonb_typeof(p_command_intent) <> 'object'
     or p_command_intent ->> 'operationId' is distinct from p_operation_id
     or coalesce(p_command_intent ->> 'chosenTeacherId', '') is distinct from coalesce(p_chosen_teacher_id, '')
     or nullif(trim(p_operation_id), '') is null
     or p_action not in ('leave', 'substitute', 'confirm_only')
     or (p_action = 'substitute' and nullif(trim(p_chosen_teacher_id), '') is null)
     or (p_action <> 'substitute' and p_chosen_teacher_id is not null)
     or jsonb_typeof(p_expected_versions) <> 'object'
     or p_expected_versions - 'bookings' - 'operations' - 'teachers' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'bookings') <> 'number'
     or jsonb_typeof(p_expected_versions -> 'operations') <> 'number'
     or jsonb_typeof(p_expected_versions -> 'teachers') <> 'number'
     or jsonb_typeof(p_bookings) <> 'array'
     or jsonb_typeof(p_operations) <> 'array'
     or jsonb_typeof(p_affected_occurrence_ids) <> 'array'
     or nullif(trim(p_actor), '') is null then
    raise exception using errcode = '22023', message = 'invalid_operation_confirmation_command';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_affected_occurrence_ids) value
    where jsonb_typeof(value) <> 'string' or nullif(trim(value #>> '{}'), '') is null
  ) or (
    select count(*) from jsonb_array_elements_text(p_affected_occurrence_ids)
  ) <> (
    select count(distinct value) from jsonb_array_elements_text(p_affected_occurrence_ids) value
  ) or (p_action <> 'confirm_only' and jsonb_array_length(p_affected_occurrence_ids) = 0)
     or (p_action = 'confirm_only' and jsonb_array_length(p_affected_occurrence_ids) <> 0) then
    raise exception using errcode = '22023', message = 'invalid_affected_occurrence_ids';
  end if;

  begin
    expected_booking_version := (p_expected_versions ->> 'bookings')::bigint;
    expected_operation_version := (p_expected_versions ->> 'operations')::bigint;
    expected_teacher_version := (p_expected_versions ->> 'teachers')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_operation_confirmation_versions';
  end;
  if expected_booking_version is null or expected_booking_version < 1
     or expected_operation_version is null or expected_operation_version < 1
     or expected_teacher_version is null or expected_teacher_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_operation_confirmation_versions';
  end if;
  payload_hash := encode(extensions.digest(jsonb_build_object(
    'operationId', p_operation_id, 'action', p_action,
    'chosenTeacherId', p_chosen_teacher_id, 'expectedVersions', p_expected_versions,
    'bookings', p_bookings, 'operations', p_operations,
    'affectedOccurrenceIds', p_affected_occurrence_ids
  )::text, 'sha256'), 'hex');

  select * into prior from internal.operation_confirmation_commands c
  where c.command_key = p_command_key;

  -- Same global lock order is used by all state transactions touching bookings.
  select * into booking_state from public.ops_state s where s.entity = 'bookings' for update;
  select * into operation_state from public.ops_state s where s.entity = 'operations' for update;
  select * into student_state from public.ops_state s where s.entity = 'students' for update;
  select * into teacher_state from public.ops_state s where s.entity = 'teachers' for update;
  if booking_state.entity is null or operation_state.entity is null
     or student_state.entity is null or teacher_state.entity is null
     or jsonb_typeof(student_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'operation_confirmation_state_missing';
  end if;
  current_operation := (
    select value from jsonb_array_elements(operation_state.payload) value
    where value ->> 'id' = p_operation_id limit 1
  );
  if current_operation is null or nullif(trim(current_operation ->> 'studentId'), '') is null then
    raise exception using errcode = '22023', message = 'operation_confirmation_student_mismatch';
  end if;
  current_student := (
    select value from jsonb_array_elements(student_state.payload) value
    where value ->> 'id' = current_operation ->> 'studentId'
    limit 1
  );
  if current_student is null then
    raise exception using errcode = '22023', message = 'operation_confirmation_student_not_found';
  end if;
  if current_student ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'archived_student_operation_read_only';
  end if;

  -- Re-read after acquiring locks to observe a concurrent identical commit.
  select * into prior from internal.operation_confirmation_commands c
  where c.command_key = p_command_key;

  if prior.command_key is not null then
    if prior.command_intent is distinct from p_command_intent
       or prior.actor <> left(trim(p_actor), 120)
       or prior.operation_id <> p_operation_id or prior.action <> p_action then
      raise exception using errcode = '23505', message = 'operation_confirmation_idempotency_conflict';
    end if;
    return query select prior.command_key, prior.operation_id, prior.action, false,
      prior.affected_occurrence_ids, booking_state, operation_state, prior.audit_id;
    return;
  end if;
  if booking_state.version is distinct from expected_booking_version
     or operation_state.version is distinct from expected_operation_version
     or teacher_state.version is distinct from expected_teacher_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  next_operation := (select value from jsonb_array_elements(p_operations) value where value ->> 'id' = p_operation_id limit 1);
  if current_operation is null or next_operation is null
     or current_operation ->> 'status' <> '待处理'
     or next_operation ->> 'status' <> '已确认'
     or next_operation ->> 'confirmationAction' is distinct from p_action
     or next_operation ->> 'confirmationCommandKey' is distinct from p_command_key
     or coalesce(next_operation ->> 'chosenTeacherId', '') is distinct from coalesce(p_chosen_teacher_id, '')
     or next_operation -> 'affectedOccurrenceIds' is distinct from p_affected_occurrence_ids then
    raise exception using errcode = '22023', message = 'operation_confirmation_transition_mismatch';
  end if;
  if next_operation ->> 'studentId' is distinct from current_operation ->> 'studentId' then
    raise exception using errcode = '22023', message = 'operation_confirmation_student_mismatch';
  end if;
  if (current_operation - 'status' - 'chosenTeacherId' - 'affectedOccurrenceIds' - 'confirmationAction' - 'confirmationCommandKey' - 'confirmedAt' - 'confirmedBy')
       is distinct from
     (next_operation - 'status' - 'chosenTeacherId' - 'affectedOccurrenceIds' - 'confirmationAction' - 'confirmationCommandKey' - 'confirmedAt' - 'confirmedBy') then
    raise exception using errcode = '22023', message = 'unreviewed_operation_fields_changed';
  end if;
  if exists (
    select 1 from jsonb_array_elements(operation_state.payload) old_value
    full join jsonb_array_elements(p_operations) new_value on old_value ->> 'id' = new_value ->> 'id'
    where coalesce(old_value ->> 'id', new_value ->> 'id') <> p_operation_id
      and old_value is distinct from new_value
  ) then
    raise exception using errcode = '22023', message = 'unrelated_operation_changed';
  end if;

  if exists (
    select 1 from jsonb_array_elements(booking_state.payload) value
    group by value ->> 'id'
    having value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(p_bookings) value
    group by value ->> 'id'
    having value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(operation_state.payload) value
    group by value ->> 'id'
    having value ->> 'id' is null or count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(p_operations) value
    group by value ->> 'id'
    having value ->> 'id' is null or count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'duplicate_operation_confirmation_identity';
  end if;

  if p_action = 'confirm_only' and booking_state.payload is distinct from p_bookings then
    raise exception using errcode = '22023', message = 'confirm_only_cannot_change_bookings';
  end if;

  expected_status := case when p_action = 'leave' then 'leave' else 'confirmed' end;
  for occurrence_id in select value from jsonb_array_elements_text(p_affected_occurrence_ids)
  loop
    if occurrence_id !~ '^.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception using errcode = '22023', message = 'invalid_occurrence_id';
    end if;
    series_id := left(occurrence_id, length(occurrence_id) - 11);
    old_booking := (select value from jsonb_array_elements(booking_state.payload) value where value ->> 'id' = series_id limit 1);
    new_booking := (select value from jsonb_array_elements(p_bookings) value where value ->> 'id' = series_id limit 1);
    if old_booking is null or new_booking is null then
      raise exception using errcode = '22023', message = 'affected_booking_missing';
    end if;
    if old_booking ->> 'studentId' is distinct from current_operation ->> 'studentId'
       or new_booking ->> 'studentId' is distinct from current_operation ->> 'studentId' then
      raise exception using errcode = '22023', message = 'operation_confirmation_student_mismatch';
    end if;
    old_override := (select value from jsonb_array_elements(coalesce(old_booking -> 'occurrenceOverrides', '[]'::jsonb)) value where value ->> 'occurrenceId' = occurrence_id limit 1);
    new_override := (select value from jsonb_array_elements(coalesce(new_booking -> 'occurrenceOverrides', '[]'::jsonb)) value where value ->> 'occurrenceId' = occurrence_id limit 1);
    if new_override is null or new_override ->> 'status' is distinct from expected_status
       or (p_action = 'substitute' and new_override ->> 'teacherId' is distinct from p_chosen_teacher_id)
       or (p_action = 'leave' and (new_override - 'occurrenceId' - 'status') is distinct from coalesce(old_override - 'occurrenceId' - 'status', '{}'::jsonb))
       or (p_action = 'substitute' and (new_override - 'occurrenceId' - 'status' - 'teacherId') is distinct from coalesce(old_override - 'occurrenceId' - 'status' - 'teacherId', '{}'::jsonb)) then
      raise exception using errcode = '22023', message = 'occurrence_override_transition_mismatch';
    end if;
  end loop;
  if exists (
    select 1
    from jsonb_array_elements(booking_state.payload) old_booking
    full join jsonb_array_elements(p_bookings) new_booking on old_booking ->> 'id' = new_booking ->> 'id'
    where old_booking is null or new_booking is null
       or (old_booking - 'occurrenceOverrides') is distinct from (new_booking - 'occurrenceOverrides')
       or exists (
         select 1
         from jsonb_array_elements(coalesce(old_booking -> 'occurrenceOverrides', '[]'::jsonb)) old_override
         full join jsonb_array_elements(coalesce(new_booking -> 'occurrenceOverrides', '[]'::jsonb)) new_override
           on old_override ->> 'occurrenceId' = new_override ->> 'occurrenceId'
         where old_override is distinct from new_override
           and not exists (
             select 1 from jsonb_array_elements_text(p_affected_occurrence_ids) allowed(id)
             where allowed.id = coalesce(old_override ->> 'occurrenceId', new_override ->> 'occurrenceId')
           )
       )
  ) then
    raise exception using errcode = '22023', message = 'unrelated_booking_override_changed';
  end if;

  update public.ops_state s set payload = p_bookings, version = s.version + 1,
    updated_at = now(), updated_by = left(trim(p_actor), 120)
  where s.entity = 'bookings' returning s.* into saved_booking_state;
  update public.ops_state s set payload = p_operations, version = s.version + 1,
    updated_at = now(), updated_by = left(trim(p_actor), 120)
  where s.entity = 'operations' returning s.* into saved_operation_state;

  audit_id := internal.append_operational_contract_audit(
    'operation.confirmed', left(trim(p_actor), 120), 'operation', p_operation_id,
    jsonb_build_object('action', p_action, 'chosenTeacherId', p_chosen_teacher_id,
      'affectedOccurrenceIds', p_affected_occurrence_ids,
      'bookingVersion', saved_booking_state.version, 'operationVersion', saved_operation_state.version)
  );
  insert into internal.operation_confirmation_commands (
    command_key, command_intent, command_hash, operation_id, action, affected_occurrence_ids,
    booking_version, operation_version, actor, audit_id
  ) values (
    p_command_key, p_command_intent, payload_hash, p_operation_id, p_action, p_affected_occurrence_ids,
    saved_booking_state.version, saved_operation_state.version, left(trim(p_actor), 120), audit_id
  );
  return query select p_command_key, p_operation_id, p_action, true,
    p_affected_occurrence_ids, saved_booking_state, saved_operation_state, audit_id;
end;
$$;

revoke all on function public.confirm_operation_occurrences_atomic(text, text, jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.confirm_operation_occurrences_atomic(text, text, jsonb, text, text, text, jsonb, jsonb, jsonb, jsonb, text)
  to anon, authenticated;

-- An uploaded attachment and its shared file/student indexes are one command.
-- The former put_student_fu_attachment RPC is deliberately no longer
-- executable by Data API roles so callers cannot create unindexed orphans.
create table if not exists internal.student_fu_attachment_commands (
  command_key text primary key check (command_key ~ '^fu-attachment:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  attachment_id uuid not null unique references internal.student_fu_attachments(id),
  student_id text not null check (length(student_id) between 1 and 120),
  file_id text not null unique check (length(file_id) between 1 and 160),
  files_version bigint not null check (files_version > 0),
  students_version bigint not null check (students_version > 0),
  actor text not null check (length(actor) between 1 and 120),
  audit_id uuid not null references internal.operational_contract_audit(id),
  created_at timestamptz not null default now()
);

alter table internal.student_fu_attachment_commands enable row level security;
revoke all on table internal.student_fu_attachment_commands from public, anon, authenticated;

create or replace function public.put_student_fu_attachment_atomic(
  p_secret text,
  p_command_key text,
  p_student_id text,
  p_file_name text,
  p_content_type text,
  p_content_base64 text,
  p_file_title text,
  p_file_type text,
  p_fu_category text,
  p_expected_versions jsonb,
  p_actor text
)
returns table (
  command_key text,
  applied boolean,
  attachment jsonb,
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
  prior internal.student_fu_attachment_commands%rowtype;
  saved_attachment internal.student_fu_attachments%rowtype;
  current_student jsonb;
  next_student jsonb;
  next_students jsonb;
  next_files jsonb;
  file_record jsonb;
  decoded bytea;
  expected_files_version bigint;
  expected_students_version bigint;
  canonical_file_name text;
  canonical_title text;
  canonical_actor text;
  file_id text;
  command_digest text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^fu-attachment:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or nullif(trim(p_student_id), '') is null or length(trim(p_student_id)) > 120
     or nullif(trim(p_file_name), '') is null
     or nullif(trim(p_file_title), '') is null
     or nullif(trim(p_actor), '') is null
     or jsonb_typeof(p_expected_versions) <> 'object'
     or p_expected_versions - 'files' - 'students' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'files') <> 'number'
     or jsonb_typeof(p_expected_versions -> 'students') <> 'number'
     or p_content_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
     or p_file_type not in ('Report 资料', 'FU', '续课 FU')
     or (p_content_type = 'application/pdf' and (p_file_type <> 'Report 资料' or p_fu_category is not null))
     or (p_content_type <> 'application/pdf' and p_file_type = 'Report 资料')
     or (p_file_type in ('FU', '续课 FU') and p_fu_category is null)
     or (p_file_type = '续课 FU' and p_fu_category <> 'renewal_update')
     or (p_file_type = 'FU' and p_fu_category not in ('parent_communication', 'teacher_feedback', 'complaint', 'other')) then
    raise exception using errcode = '22023', message = 'invalid_fu_attachment_command';
  end if;
  begin
    decoded := decode(p_content_base64, 'base64');
    expected_files_version := (p_expected_versions ->> 'files')::bigint;
    expected_students_version := (p_expected_versions ->> 'students')::bigint;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_fu_attachment_payload';
  end;
  if expected_files_version is null or expected_files_version < 1
     or expected_students_version is null or expected_students_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_fu_attachment_payload';
  end if;
  if octet_length(decoded) < 1 or octet_length(decoded) > 4194304 then
    raise exception using errcode = '22023', message = 'attachment_size_out_of_range';
  end if;
  if (p_content_type = 'image/jpeg' and substring(decoded from 1 for 3) <> decode('ffd8ff', 'hex'))
     or (p_content_type = 'image/png' and substring(decoded from 1 for 8) <> decode('89504e470d0a1a0a', 'hex'))
     or (p_content_type = 'image/webp' and (
       substring(decoded from 1 for 4) <> convert_to('RIFF', 'UTF8')
       or substring(decoded from 9 for 4) <> convert_to('WEBP', 'UTF8')
     ))
     or (p_content_type = 'application/pdf' and substring(decoded from 1 for 5) <> convert_to('%PDF-', 'UTF8')) then
    raise exception using errcode = '22023', message = 'attachment_content_type_mismatch';
  end if;
  canonical_file_name := left(trim(p_file_name), 180);
  canonical_title := left(trim(p_file_title), 180);
  canonical_actor := left(trim(p_actor), 120);
  command_digest := encode(extensions.digest(
    jsonb_build_object(
      'studentId', trim(p_student_id), 'fileName', canonical_file_name,
      'contentType', p_content_type,
      'contentSha256', encode(extensions.digest(decoded, 'sha256'), 'hex'),
      'fileTitle', canonical_title, 'fileType', p_file_type,
      'fuCategory', p_fu_category, 'actor', canonical_actor
    )::text,
    'sha256'
  ), 'hex');

  -- Same lock prefix as the student import commit: attachment table first,
  -- then shared state rows in lexical entity order (files, students).
  lock table internal.student_fu_attachments in share row exclusive mode;
  select * into files_state from public.ops_state s where s.entity = 'files' for update;
  select * into students_state from public.ops_state s where s.entity = 'students' for update;
  if files_state.entity is null or students_state.entity is null
     or jsonb_typeof(files_state.payload) <> 'array'
     or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'fu_attachment_state_unavailable';
  end if;
  if (select count(*) from jsonb_array_elements(students_state.payload) student
      where student ->> 'id' = trim(p_student_id)) <> 1 then
    raise exception using errcode = '22023', message = 'fu_attachment_student_not_found';
  end if;
  current_student := (
    select student from jsonb_array_elements(students_state.payload) student
    where student ->> 'id' = trim(p_student_id) limit 1
  );
  if current_student ->> 'importArchived' = 'true' then
    raise exception using errcode = '42501', message = 'archived_student_attachment_read_only';
  end if;

  select * into prior from internal.student_fu_attachment_commands c
  where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    if prior.command_hash <> command_digest
       or prior.student_id <> trim(p_student_id)
       or prior.actor <> canonical_actor then
      raise exception using errcode = '23505', message = 'fu_attachment_idempotency_conflict';
    end if;
    select * into saved_attachment from internal.student_fu_attachments a where a.id = prior.attachment_id;
    if saved_attachment.id is null
       or saved_attachment.student_id is distinct from prior.student_id
       or saved_attachment.file_name is distinct from canonical_file_name
       or saved_attachment.content_type is distinct from p_content_type
       or saved_attachment.byte_size is distinct from octet_length(decoded)
       or saved_attachment.uploaded_by is distinct from canonical_actor then
      raise exception using errcode = '55000', message = 'fu_attachment_replay_missing';
    end if;
    if (select count(*) from jsonb_array_elements(files_state.payload) item
        where item ->> 'id' = prior.file_id
          and item ->> 'source' = '/api/fu-attachments/' || prior.attachment_id::text
          and item ->> 'studentId' = prior.student_id
          and item ->> 'type' = p_file_type) <> 1 then
      raise exception using errcode = '55000', message = 'fu_attachment_replay_index_mismatch';
    end if;
    return query select prior.command_key, false, jsonb_build_object(
      'id', saved_attachment.id, 'student_id', saved_attachment.student_id,
      'file_name', saved_attachment.file_name, 'content_type', saved_attachment.content_type,
      'byte_size', saved_attachment.byte_size, 'uploaded_by', saved_attachment.uploaded_by,
      'uploaded_at', saved_attachment.uploaded_at
    ), files_state, students_state, prior.audit_id;
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

  insert into internal.student_fu_attachments (
    student_id, file_name, content_type, byte_size, content, uploaded_by
  ) values (
    trim(p_student_id), canonical_file_name, p_content_type,
    octet_length(decoded), decoded, canonical_actor
  ) returning * into saved_attachment;
  file_id := case when p_file_type = 'Report 资料' then 'REPORT-' else 'FU-' end || saved_attachment.id::text;
  if exists (select 1 from jsonb_array_elements(files_state.payload) item where item ->> 'id' = file_id) then
    raise exception using errcode = '23505', message = 'fu_attachment_file_id_conflict';
  end if;
  file_record := jsonb_strip_nulls(jsonb_build_object(
    'id', file_id, 'studentId', trim(p_student_id),
    'title', canonical_title || ' · ' || canonical_file_name,
    'type', p_file_type, 'source', '/api/fu-attachments/' || saved_attachment.id::text,
    'addedAt', saved_attachment.uploaded_at,
    'fuCategory', p_fu_category
  ));
  next_files := jsonb_build_array(file_record) || files_state.payload;
  next_student := jsonb_set(current_student, '{files}', to_jsonb((current_student ->> 'files')::bigint + 1), false);
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
    'student_fu_attachment.created', canonical_actor, 'student', trim(p_student_id),
    jsonb_build_object('attachmentId', saved_attachment.id, 'fileId', file_id,
      'fileType', p_file_type, 'byteSize', saved_attachment.byte_size,
      'filesVersion', saved_files_state.version, 'studentsVersion', saved_students_state.version)
  );
  insert into internal.student_fu_attachment_commands (
    command_key, command_hash, attachment_id, student_id, file_id,
    files_version, students_version, actor, audit_id
  ) values (
    lower(p_command_key), command_digest, saved_attachment.id, trim(p_student_id), file_id,
    saved_files_state.version, saved_students_state.version, canonical_actor, audit_id
  );
  return query select lower(p_command_key), true, jsonb_build_object(
    'id', saved_attachment.id, 'student_id', saved_attachment.student_id,
    'file_name', saved_attachment.file_name, 'content_type', saved_attachment.content_type,
    'byte_size', saved_attachment.byte_size, 'uploaded_by', saved_attachment.uploaded_by,
    'uploaded_at', saved_attachment.uploaded_at
  ), saved_files_state, saved_students_state, audit_id;
end;
$$;

revoke all on function public.put_student_fu_attachment(text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.put_student_fu_attachment_atomic(text, text, text, text, text, text, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.put_student_fu_attachment_atomic(text, text, text, text, text, text, text, text, text, jsonb, text)
  to anon, authenticated;
