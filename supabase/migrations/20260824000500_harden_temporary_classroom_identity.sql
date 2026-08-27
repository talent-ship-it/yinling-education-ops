-- Temporary classroom hardening.
--
-- A browser requestKey is an idempotency handle, not a booking identity.  The
-- claim below binds it to the signed actor and the server-normalized intent
-- before BBB is called.  Reusing the same handle for another intent is an
-- explicit conflict; it can never silently update the first booking.

create table if not exists internal.temporary_classroom_requests (
  request_identity text primary key
    check (request_identity ~ '^temporary-classroom:[a-f0-9]{64}$'),
  request_key text not null
    check (request_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  actor text not null check (length(actor) between 1 and 120),
  mode text not null check (mode in ('test', 'recorded')),
  intent jsonb not null check (jsonb_typeof(intent) = 'object'),
  intent_hash text not null check (intent_hash ~ '^[a-f0-9]{64}$'),
  booking_id text,
  occurrence_id text,
  meeting_id text not null check (length(meeting_id) between 2 and 240),
  claimed_at timestamptz not null default now()
);

alter table internal.temporary_classroom_requests enable row level security;
revoke all on table internal.temporary_classroom_requests from public, anon, authenticated, service_role;

create or replace function internal.booking_projection_occurrence_exists(
  p_booking jsonb,
  p_occurrence_id text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  source_date date;
  target_date date;
  source_end date;
  interval_days integer;
  recurrence_offset integer;
begin
  if jsonb_typeof(p_booking) is distinct from 'object'
     or jsonb_typeof(p_booking -> 'id') is distinct from 'string'
     or jsonb_typeof(p_booking -> 'date') is distinct from 'string'
     or nullif(trim(p_booking ->> 'id'), '') is null
     or nullif(trim(p_booking ->> 'date'), '') is null
     or nullif(trim(p_occurrence_id), '') is null
     or p_occurrence_id <> p_booking ->> 'id' || ':' || pg_catalog.right(p_occurrence_id, 10)
     or pg_catalog.right(p_occurrence_id, 10) !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;

  begin
    source_date := (p_booking ->> 'date')::date;
    target_date := pg_catalog.right(p_occurrence_id, 10)::date;
  exception when others then
    return false;
  end;
  if pg_catalog.to_char(source_date, 'YYYY-MM-DD') <> p_booking ->> 'date'
     or pg_catalog.to_char(target_date, 'YYYY-MM-DD') <> pg_catalog.right(p_occurrence_id, 10) then
    return false;
  end if;

  -- A non-recurring booking has exactly one source occurrence.  This explicit
  -- equality is intentionally stricter than merely checking the ID prefix.
  if coalesce(p_booking ->> 'recurring', 'false') <> 'true' then
    return target_date = source_date;
  end if;

  begin
    interval_days := internal.booking_recurrence_interval_days(p_booking);
    source_end := internal.booking_recurrence_source_end_date(p_booking);
  exception when others then
    return false;
  end;
  if interval_days is null or interval_days < 1 or target_date < source_date then
    return false;
  end if;
  if source_end is not null and target_date > source_end then
    return false;
  end if;
  recurrence_offset := target_date - source_date;
  if recurrence_offset % interval_days <> 0 then
    return false;
  end if;
  if p_booking ? 'repeatCount'
     and recurrence_offset / interval_days >= (p_booking ->> 'repeatCount')::integer then
    return false;
  end if;
  return true;
exception when others then
  -- This helper is a boundary validator.  Malformed state is rejected by the
  -- caller rather than being converted into a guessed occurrence.
  return false;
end;
$function$;

revoke all on function internal.booking_projection_occurrence_exists(jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function public.get_temporary_classroom_capability(
  p_secret text
)
returns table(available boolean, contract text)
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2s'
as $function$
declare
  target_oid oid;
  source_definition text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  target_oid := to_regprocedure(
    'public.mutate_booking_projection_atomic(text,text,jsonb,text,text,jsonb,jsonb,jsonb,jsonb,text,text,text,text)'
  );
  if target_oid is null then
    raise exception using errcode = '55000', message = 'temporary_classroom_contract_unavailable';
  end if;
  select pg_get_functiondef(target_oid) into source_definition;
  if position('upsert_bind_classroom' in source_definition) = 0
     or position('temporary_classroom_projection_missing' in source_definition) = 0
     or position('internal.booking_projection_occurrence_exists' in source_definition) = 0 then
    raise exception using errcode = '55000', message = 'temporary_classroom_contract_unavailable';
  end if;
  return query select true, 'temporary-classroom:v2';
end;
$function$;

revoke all on function public.get_temporary_classroom_capability(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_temporary_classroom_capability(text)
  to anon, authenticated;

create or replace function public.claim_temporary_classroom_request(
  p_secret text,
  p_request_key text,
  p_intent jsonb,
  p_mode text,
  p_booking_id text,
  p_occurrence_id text,
  p_meeting_id text,
  p_actor text
)
returns table(
  request_identity text,
  request_key text,
  actor text,
  intent jsonb,
  mode text,
  booking_id text,
  occurrence_id text,
  meeting_id text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  actor_value text;
  request_value text;
  identity_value text;
  expected_booking_id text;
  expected_occurrence_id text;
  expected_meeting_id text;
  prior internal.temporary_classroom_requests%rowtype;
  intent_hash_value text;
  intent_date date;
  inserted boolean := false;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  actor_value := left(btrim(p_actor), 120);
  request_value := btrim(p_request_key);
  if nullif(actor_value, '') is null
     or request_value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     or p_mode not in ('test', 'recorded')
     or jsonb_typeof(p_intent) is distinct from 'object'
     or nullif(btrim(p_meeting_id), '') is null then
    raise exception using errcode = '22023', message = 'invalid_temporary_classroom_request';
  end if;

  if p_mode = 'test' then
    if p_intent is distinct from jsonb_build_object('mode', 'test')
       or p_booking_id is not null
       or p_occurrence_id is not null then
      raise exception using errcode = '22023', message = 'invalid_temporary_classroom_request';
    end if;
    expected_meeting_id := 'yinling-test-' || pg_catalog.left(encode(
      extensions.digest('temporary-test:' || actor_value || ':' || request_value, 'sha256'), 'hex'
    ), 64);
  else
    if p_intent - 'mode' - 'studentId' - 'teacherId' - 'subjectId'
         - 'teacherSubjectId' - 'packageId' - 'duration' - 'date'
         - 'start' - 'timezone' <> '{}'::jsonb
       or jsonb_typeof(p_intent -> 'mode') is distinct from 'string'
       or p_intent ->> 'mode' <> 'recorded'
       or jsonb_typeof(p_intent -> 'studentId') is distinct from 'string'
       or jsonb_typeof(p_intent -> 'teacherId') is distinct from 'string'
       or jsonb_typeof(p_intent -> 'subjectId') is distinct from 'string'
       or jsonb_typeof(p_intent -> 'teacherSubjectId') is distinct from 'string'
       or jsonb_typeof(p_intent -> 'packageId') is distinct from 'string'
       or jsonb_typeof(p_intent -> 'duration') is distinct from 'number'
       or jsonb_typeof(p_intent -> 'date') is distinct from 'string'
       or jsonb_typeof(p_intent -> 'start') is distinct from 'string'
       or jsonb_typeof(p_intent -> 'timezone') is distinct from 'string'
       or nullif(btrim(p_intent ->> 'studentId'), '') is null
       or nullif(btrim(p_intent ->> 'teacherId'), '') is null
       or nullif(btrim(p_intent ->> 'subjectId'), '') is null
       or nullif(btrim(p_intent ->> 'teacherSubjectId'), '') is null
       or nullif(btrim(p_intent ->> 'packageId'), '') is null
       or (p_intent ->> 'duration') not in ('60', '90', '120')
       or p_intent ->> 'date' !~ '^\d{4}-\d{2}-\d{2}$'
       or p_intent ->> 'start' !~ '^([01]\d|2[0-3]):[0-5]\d$'
       or p_intent ->> 'timezone' not in (
         'Australia/Melbourne',
         'Australia/Adelaide',
         'Australia/Sydney',
         'Australia/Canberra',
         'Australia/Hobart',
         'Australia/Brisbane',
         'Australia/Perth',
         'Pacific/Auckland',
         'Asia/Shanghai',
         'America/Argentina/Buenos_Aires',
         'Europe/Sarajevo'
       )
       or nullif(btrim(p_booking_id), '') is null
       or nullif(btrim(p_occurrence_id), '') is null then
      raise exception using errcode = '22023', message = 'invalid_temporary_classroom_request';
    end if;
    begin
      intent_date := (p_intent ->> 'date')::date;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_temporary_classroom_request';
    end;
    if pg_catalog.to_char(intent_date, 'YYYY-MM-DD') <> p_intent ->> 'date' then
      raise exception using errcode = '22023', message = 'invalid_temporary_classroom_request';
    end if;
    expected_booking_id := 'TMP-' || pg_catalog.left(encode(
      extensions.digest('temporary-booking:' || actor_value || ':' || request_value, 'sha256'), 'hex'
    ), 48);
    expected_occurrence_id := expected_booking_id || ':' || (p_intent ->> 'date');
    expected_meeting_id := 'yinling-occ-' || pg_catalog.left(encode(
      extensions.digest(expected_occurrence_id, 'sha256'), 'hex'
    ), 48);
    if p_booking_id <> expected_booking_id
       or p_occurrence_id <> expected_occurrence_id then
      raise exception using errcode = '22023', message = 'invalid_temporary_classroom_request';
    end if;
  end if;
  if p_meeting_id <> expected_meeting_id then
    raise exception using errcode = '22023', message = 'invalid_temporary_classroom_request';
  end if;

  identity_value := 'temporary-classroom:' || pg_catalog.left(encode(
    extensions.digest(actor_value || chr(31) || request_value, 'sha256'), 'hex'
  ), 64);
  intent_hash_value := encode(extensions.digest(p_intent::text, 'sha256'), 'hex');
  insert into internal.temporary_classroom_requests(
    request_identity, request_key, actor, mode, intent, intent_hash,
    booking_id, occurrence_id, meeting_id
  ) values (
    identity_value, request_value, actor_value, p_mode, p_intent, intent_hash_value,
    p_booking_id, p_occurrence_id, p_meeting_id
  ) on conflict (request_identity) do nothing
    returning true into inserted;

  select * into prior from internal.temporary_classroom_requests
  where internal.temporary_classroom_requests.request_identity = identity_value;
  if prior.request_identity is null
     or prior.actor <> actor_value
     or prior.request_key <> request_value
     or prior.mode <> p_mode
     or prior.intent is distinct from p_intent
     or prior.booking_id is distinct from p_booking_id
     or prior.occurrence_id is distinct from p_occurrence_id
     or prior.meeting_id <> p_meeting_id then
    raise exception using errcode = '23505', message = 'temporary_classroom_request_conflict';
  end if;
  return query select
    prior.request_identity, prior.request_key, prior.actor, prior.intent,
    prior.mode, prior.booking_id, prior.occurrence_id, prior.meeting_id,
    not coalesce(inserted, false);
end;
$function$;

revoke all on function public.claim_temporary_classroom_request(text, text, jsonb, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_temporary_classroom_request(text, text, jsonb, text, text, text, text, text)
  to anon, authenticated;

-- Add the same occurrence boundary check inside the atomic projection wrapper.
-- The service check is a fast fail; this check protects direct RPC callers and
-- the final locked projection state.
do $temporary_classroom_occurrence_wrapper$
declare
  target_oid oid;
  source_definition text;
  patched_definition text;
begin
  target_oid := to_regprocedure(
    'public.mutate_booking_projection_atomic(text,text,jsonb,text,text,jsonb,jsonb,jsonb,jsonb,text,text,text,text)'
  );
  if target_oid is null then
    raise exception using errcode = '55000', message = 'temporary_classroom_projection_wrapper_missing';
  end if;
  select pg_get_functiondef(target_oid) into source_definition;
  if position('create or replace function public.mutate_booking_projection_atomic' in lower(source_definition)) = 0
     or position('upsert_bind_classroom' in source_definition) = 0
     or position('core_student_id text' in source_definition) = 0
     or position('core_intent := case when p_command_intent ->> ''action'' in (''cancel_occurrence'', ''update_occurrence'', ''bind_classroom'', ''upsert_bind_classroom'')' in source_definition) = 0 then
    raise exception using errcode = '55000', message = 'temporary_classroom_projection_wrapper_drift';
  end if;

  patched_definition := replace(
    source_definition,
    $anchor$  core_student_id text;
  core_teacher_id text;
  core_intent jsonb;$anchor$,
    $replacement$  core_student_id text;
  core_teacher_id text;
  occurrence_booking jsonb;
  core_intent jsonb;$replacement$
  );
  patched_definition := replace(
    patched_definition,
    $anchor$  core_student_id := coalesce(current_booking ->> 'studentId', p_student_id);
  core_teacher_id := coalesce(current_booking ->> 'teacherId', p_teacher_id);$anchor$,
    $replacement$  if p_command_intent ->> 'action' in ('bind_classroom', 'upsert_bind_classroom') then
    occurrence_booking := case when p_command_intent ->> 'action' = 'bind_classroom'
      then current_booking
      else (select value from jsonb_array_elements(p_bookings) value
        where value ->> 'id' = p_booking_id limit 1)
    end;
    if not internal.booking_projection_occurrence_exists(
      occurrence_booking, p_command_intent ->> 'occurrenceId'
    ) then
      raise exception using errcode = '22023', message = 'booking_occurrence_not_found';
    end if;
  end if;
  core_student_id := coalesce(current_booking ->> 'studentId', p_student_id);
  core_teacher_id := coalesce(current_booking ->> 'teacherId', p_teacher_id);$replacement$
  );
  if patched_definition = source_definition
     or position('occurrence_booking jsonb' in patched_definition) = 0
     or position('internal.booking_projection_occurrence_exists' in patched_definition) = 0
     or position('message = ''booking_occurrence_not_found''' in patched_definition) = 0 then
    raise exception using errcode = '55000', message = 'temporary_classroom_projection_wrapper_patch_failed';
  end if;
  execute patched_definition;
end;
$temporary_classroom_occurrence_wrapper$;

alter function public.get_booking_projection_command_result(text, text, jsonb, text)
  set statement_timeout = '8s';
alter function public.mutate_booking_projection_atomic(
  text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, text
) set statement_timeout = '15s';

revoke all on function public.mutate_booking_projection_atomic(
  text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.mutate_booking_projection_atomic(
  text, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text, text
) to anon, authenticated;
