-- Reviewed server-side contracts for three operations that must never be
-- implemented as a sequence of independent ops_state writes:
--   1. attendance-backed lesson settlement;
--   2. teacher availability submission review/writeback; and
--   3. versioned student source import.
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
      return query select
        prior.occurrence_id,
        prior.idempotency_key,
        false,
        prior.disposition,
        prior.occurrence_version,
        prior.audit_id;
      return;
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

create table if not exists internal.student_import_commits (
  plan_fingerprint text primary key check (plan_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  master_revision text not null,
  jwb_revision text not null,
  students_version bigint not null check (students_version > 0),
  students_sha256 text not null check (students_sha256 ~ '^[a-f0-9]{64}$'),
  committed_by text not null check (length(committed_by) between 1 and 120),
  committed_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id)
);

alter table internal.student_import_commits enable row level security;
revoke all on table internal.student_import_commits from public, anon, authenticated;

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
     or nullif(trim(p_revision), '') is null
     or nullif(trim(p_actor), '') is null
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_rows) r
       where jsonb_typeof(r) <> 'object'
          or not (r ? 'sourceRow')
          or jsonb_typeof(r -> 'name') <> 'string'
          or nullif(trim(r ->> 'name'), '') is null
          or (p_source_kind = 'master' and jsonb_typeof(r -> 'status') <> 'string')
     ) then
    raise exception using errcode = '22023', message = 'invalid_student_import_source_rows';
  end if;

  rows_hash := encode(extensions.digest(p_rows::text, 'sha256'), 'hex');

  select * into saved
  from internal.student_import_source_rows s
  where s.source_kind = p_source_kind
  for update;

  if found and saved.revision = trim(p_revision) and saved.rows_sha256 = rows_hash then
    return jsonb_build_object(
      'sourceKind', saved.source_kind,
      'sourceId', saved.source_id,
      'revision', saved.revision,
      'rowCount', saved.row_count,
      'unchanged', true
    );
  end if;
  if found and saved.revision = trim(p_revision) and saved.rows_sha256 <> rows_hash then
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
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  select * into master from internal.student_import_source_rows s where s.source_kind = 'master';
  select * into jwb from internal.student_import_source_rows s where s.source_kind = 'jwb';
  if master.source_kind is null or jwb.source_kind is null then
    raise exception using errcode = 'P0002', message = 'student_import_source_rows_unavailable';
  end if;

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
    )
  );
end;
$$;

revoke all on function public.put_student_import_source_rows(text, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.get_latest_student_import_source_rows(text)
  from public, anon, authenticated;
grant execute on function public.put_student_import_source_rows(text, text, text, text, jsonb, text)
  to anon, authenticated;
grant execute on function public.get_latest_student_import_source_rows(text)
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
  booking_state public.ops_state%rowtype;
  locked_state public.ops_state%rowtype;
  prior internal.student_import_commits%rowtype;
  master internal.student_import_source_rows%rowtype;
  jwb internal.student_import_source_rows%rowtype;
  reference_entities constant text[] := array[
    'bookings', 'files', 'lpItems', 'messages', 'operations',
    'payroll', 'renewals', 'students', 'tasks'
  ];
  referenced_removed_student_id text;
  referenced_removed_package_booking_id text;
  booking_item jsonb;
  next_booking jsonb;
  override_item jsonb;
  next_overrides jsonb;
  next_bookings jsonb := '[]'::jsonb;
  matching_package_ids text[];
  booking_subject text;
  backfilled_booking_ids jsonb := '[]'::jsonb;
  unresolved_booking_ids jsonb := '[]'::jsonb;
  students_hash text;
  audit_entry_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_plan_fingerprint, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_expected_student_version is null or p_expected_student_version < 1
     or p_actor not in ('Nixon', 'Ops Admin')
     or jsonb_typeof(p_source_revisions) <> 'object'
     or nullif(p_source_revisions ->> 'master', '') is null
     or nullif(p_source_revisions ->> 'jwb', '') is null
     or jsonb_typeof(p_students) <> 'array'
     or jsonb_array_length(p_students) > 10000
     or exists (
       select 1 from jsonb_array_elements(p_students) s
       where jsonb_typeof(s) <> 'object'
          or jsonb_typeof(s -> 'id') <> 'string'
          or nullif(trim(s ->> 'id'), '') is null
          or jsonb_typeof(s -> 'name') <> 'string'
          or nullif(trim(s ->> 'name'), '') is null
          or (
            coalesce(s ->> 'importSource', '') <> 'manual_trial'
            and coalesce(s ->> 'status', '') not in (
              '在读', '不活跃 + 无课时', '活跃 + 无课时', '活跃 + 有课时',
              '不活跃 + 有课时', '在读 + 加课待排'
            )
          )
     )
     or (select count(*) from jsonb_array_elements(p_students)) <>
        (select count(distinct s ->> 'id') from jsonb_array_elements(p_students) s) then
    raise exception using errcode = '22023', message = 'invalid_student_import_commit';
  end if;

  students_hash := encode(extensions.digest(p_students::text, 'sha256'), 'hex');
  select * into prior
  from internal.student_import_commits c
  where c.plan_fingerprint = p_plan_fingerprint
  for update;
  if found then
    if prior.master_revision <> p_source_revisions ->> 'master'
       or prior.jwb_revision <> p_source_revisions ->> 'jwb'
       or prior.students_sha256 <> students_hash then
      raise exception using errcode = '23505', message = 'student_import_fingerprint_conflict';
    end if;
    return query select
      'students'::text,
      prior.students_version,
      prior.committed_at,
      prior.committed_by;
    return;
  end if;

  -- Stable lock order: both source rows, then every canonical state that can
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
  if current_state.version <> p_expected_student_version then
    raise exception using errcode = '40001', message = 'version_conflict';
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
      from jsonb_array_elements(p_students) new_student
      where new_student ->> 'id' = old_student ->> 'id'
    )
    and exists (
      select 1
      from public.ops_state reference_state
      cross join lateral jsonb_array_elements(reference_state.payload) reference_item
      where reference_state.entity = any(reference_entities)
        and reference_state.entity <> 'students'
        and reference_item ->> 'studentId' = old_student ->> 'id'
    )
  limit 1;
  if referenced_removed_student_id is not null then
    raise exception using errcode = '23503', message = 'student_import_referenced_student_removed';
  end if;

  -- Do not replace an existing package ledger while any series or occurrence
  -- still points at a package that the imported student currently owns. This
  -- guard only considers valid pre-import references, so unrelated legacy
  -- package orphans do not suddenly block an otherwise safe import.
  select referenced_booking_id
  into referenced_removed_package_booking_id
  from (
    select booking ->> 'id' as referenced_booking_id,
      booking ->> 'studentId' as referenced_student_id,
      booking ->> 'packageId' as referenced_package_id
    from jsonb_array_elements(booking_state.payload) booking
    where nullif(trim(booking ->> 'packageId'), '') is not null

    union all

    select booking ->> 'id' as referenced_booking_id,
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
    from jsonb_array_elements(p_students) new_student
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
  if referenced_removed_package_booking_id is not null then
    raise exception using errcode = '23503', message = 'student_import_referenced_package_removed';
  end if;

  -- Package activation is deliberately fail-closed. Only future, unfinished
  -- non-trial series without an existing packageId are candidates. An exact
  -- course/subject match must resolve to exactly one package on the imported
  -- student; zero or multiple matches remain untouched and are audited.
  -- Recurring series that began in the past are not rewritten because setting
  -- their parent packageId would also relabel historical occurrences.
  for booking_item in
    select item
    from jsonb_array_elements(booking_state.payload) with ordinality as booking(item, position)
    order by position
  loop
    booking_subject := coalesce(
      nullif(trim(booking_item ->> 'subjectId'), ''),
      nullif(trim(booking_item ->> 'course'), '')
    );
    if jsonb_typeof(booking_item) = 'object'
       and nullif(trim(booking_item ->> 'id'), '') is not null
       and nullif(trim(booking_item ->> 'studentId'), '') is not null
       and nullif(trim(booking_item ->> 'packageId'), '') is null
       and coalesce(booking_item ->> 'kind', '') <> '试听'
       and coalesce(booking_item ->> 'status', '') not in (
         '已完成', 'completed', 'cancelled', '已取消'
       )
       and coalesce(booking_item ->> 'sourceTiming', '') <> '已结束'
       and booking_subject is not null
       and case
         when coalesce(booking_item ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
           then (booking_item ->> 'date')::date >=
             (current_timestamp at time zone 'Australia/Melbourne')::date
         else false
       end then
      select coalesce(array_agg(candidate.package_id order by candidate.package_id), array[]::text[])
      into matching_package_ids
      from (
        select lesson_package ->> 'id' as package_id
        from jsonb_array_elements(p_students) imported_student
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
          and nullif(trim(lesson_package ->> 'id'), '') is not null
          and subject.subject_id = booking_subject
        group by lesson_package ->> 'id'
      ) candidate;

      if cardinality(matching_package_ids) = 1 then
        next_booking := jsonb_set(
          booking_item,
          '{packageId}',
          to_jsonb(matching_package_ids[1]),
          true
        );
        if jsonb_typeof(booking_item -> 'occurrenceOverrides') = 'array' then
          next_overrides := '[]'::jsonb;
          for override_item in
            select item
            from jsonb_array_elements(booking_item -> 'occurrenceOverrides')
              with ordinality as occurrence_override(item, position)
            order by position
          loop
            -- Occurrence IDs are `${seriesId}:${sourceDate}`. Only future,
            -- unsettled overrides with no package are filled. Explicit
            -- non-empty package choices, historical lessons and settled
            -- evidence remain immutable.
            if jsonb_typeof(override_item) = 'object'
               and nullif(trim(override_item ->> 'packageId'), '') is null
               and nullif(trim(override_item ->> 'settledAt'), '') is null
               and coalesce(override_item ->> 'status', '') not in (
                 'completed', 'cancelled', 'abnormal'
               )
               and case
                 when right(coalesce(override_item ->> 'occurrenceId', ''), 10) ~ '^\d{4}-\d{2}-\d{2}$'
                   then right(override_item ->> 'occurrenceId', 10)::date >=
                     (current_timestamp at time zone 'Australia/Melbourne')::date
                 else false
               end then
              next_overrides := next_overrides || jsonb_build_array(
                jsonb_set(override_item, '{packageId}', to_jsonb(matching_package_ids[1]), true)
              );
            else
              next_overrides := next_overrides || jsonb_build_array(override_item);
            end if;
          end loop;
          next_booking := jsonb_set(next_booking, '{occurrenceOverrides}', next_overrides, true);
        end if;
        next_bookings := next_bookings || jsonb_build_array(next_booking);
        backfilled_booking_ids := backfilled_booking_ids ||
          jsonb_build_array(booking_item ->> 'id');
      else
        next_bookings := next_bookings || jsonb_build_array(booking_item);
        unresolved_booking_ids := unresolved_booking_ids ||
          jsonb_build_array(booking_item ->> 'id');
      end if;
    else
      next_bookings := next_bookings || jsonb_build_array(booking_item);
    end if;
  end loop;

  update public.ops_state s set
    payload = p_students,
    version = s.version + 1,
    updated_at = now(),
    updated_by = left(trim(p_actor), 80)
  where s.entity = 'students'
  returning s.* into current_state;

  insert into public.ops_mutation_log(entity, version, actor)
  values ('students', current_state.version, current_state.updated_by);

  if jsonb_array_length(backfilled_booking_ids) > 0 then
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

  audit_entry_id := internal.append_operational_contract_audit(
    'student_import.committed',
    p_actor,
    'ops_state',
    'students',
    jsonb_build_object(
      'planFingerprint', p_plan_fingerprint,
      'masterRevision', master.revision,
      'jwbRevision', jwb.revision,
      'beforeVersion', p_expected_student_version,
      'afterVersion', current_state.version,
      'studentCount', jsonb_array_length(p_students),
      'studentsSha256', students_hash,
      'bookingPackageBackfilledCount', jsonb_array_length(backfilled_booking_ids),
      'bookingPackageBackfilledIds', backfilled_booking_ids,
      'bookingPackageUnresolvedCount', jsonb_array_length(unresolved_booking_ids),
      'bookingPackageUnresolvedIds', unresolved_booking_ids
    )
  );

  insert into internal.student_import_commits (
    plan_fingerprint, master_revision, jwb_revision, students_version,
    students_sha256, committed_by, committed_at, audit_id
  ) values (
    p_plan_fingerprint, master.revision, jwb.revision, current_state.version,
    students_hash, left(trim(p_actor), 120), current_state.updated_at, audit_entry_id
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

  if booking_state.version <> expected_booking_version
     or student_state.version <> expected_student_version
     or teacher_state.version <> expected_teacher_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  -- Recheck identities and restrict the payload change surface.  The service
  -- may change only the named booking and the named capacity teachers.
  current_booking := (
    select value from jsonb_array_elements(booking_state.payload) value
    where value ->> 'id' = p_booking_id limit 1
  );
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
  teacher_state public.ops_state%rowtype;
  saved_booking_state public.ops_state%rowtype;
  saved_operation_state public.ops_state%rowtype;
  prior internal.operation_confirmation_commands%rowtype;
  expected_booking_version bigint;
  expected_operation_version bigint;
  expected_teacher_version bigint;
  current_operation jsonb;
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
  payload_hash := encode(extensions.digest(jsonb_build_object(
    'operationId', p_operation_id, 'action', p_action,
    'chosenTeacherId', p_chosen_teacher_id, 'expectedVersions', p_expected_versions,
    'bookings', p_bookings, 'operations', p_operations,
    'affectedOccurrenceIds', p_affected_occurrence_ids
  )::text, 'sha256'), 'hex');

  select * into prior from internal.operation_confirmation_commands c
  where c.command_key = p_command_key;

  -- Same lock order is used by all state transactions touching bookings.
  select * into booking_state from public.ops_state s where s.entity = 'bookings' for update;
  select * into operation_state from public.ops_state s where s.entity = 'operations' for update;
  select * into teacher_state from public.ops_state s where s.entity = 'teachers' for update;
  if booking_state.entity is null or operation_state.entity is null or teacher_state.entity is null then
    raise exception using errcode = '55000', message = 'operation_confirmation_state_missing';
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
  if booking_state.version <> expected_booking_version
     or operation_state.version <> expected_operation_version
     or teacher_state.version <> expected_teacher_version then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;

  current_operation := (select value from jsonb_array_elements(operation_state.payload) value where value ->> 'id' = p_operation_id limit 1);
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
