\set ON_ERROR_STOP on
\i tests/sql/assert-disposable-database.sql

create schema internal;
create schema extensions;
create extension pgcrypto with schema extensions;
do $roles$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
end;
$roles$;
create function internal.verify_ops_secret(p_secret text)
returns boolean language sql immutable set search_path = ''
as $$ select p_secret = 'temporary-claim-fixture-only' $$;

do $original_claim$
declare
  request_key text := 'temporary-runtime-direct';
  actor text := 'Synthetic Admin A';
  meeting_id text;
  error_message text;
begin
  perform set_config('plpgsql.variable_conflict', 'error', true);
  meeting_id := 'yinling-test-' || encode(extensions.digest('temporary-test:' || actor || ':' || request_key, 'sha256'), 'hex');
  begin
    perform public.claim_temporary_classroom_request('temporary-claim-fixture-only', request_key, '{"mode":"test"}', 'test', null, null, meeting_id, actor);
    raise exception 'original claim unexpectedly succeeded';
  exception when ambiguous_column then
    get stacked diagnostics error_message = message_text;
    if position('request_identity' in error_message) = 0 then raise exception 'unexpected ambiguity: %', error_message; end if;
  end;
  if exists (select from internal.temporary_classroom_requests) then raise exception 'failed original claim wrote a ledger row'; end if;
  create table public.temporary_claim_fixture_metadata as
    select proowner, prosecdef, proconfig, proacl, proargnames, proargmodes, pg_get_function_result(oid) as result_type
    from pg_catalog.pg_proc
    where oid = 'public.claim_temporary_classroom_request(text,text,jsonb,text,text,text,text,text)'::regprocedure;
end;
$original_claim$;

do $fixed_claim$
declare
  request_key text := 'temporary-runtime-direct';
  actor text := 'Synthetic Admin A';
  second_actor text := 'Synthetic Admin B';
  meeting_id text;
  identity text;
  claimed_at timestamptz;
  first_claim record;
  replay_claim record;
  isolated_claim record;
  intent jsonb;
  booking_id text;
  occurrence_id text;
  recorded_request_key text := 'temporary-runtime-recorded';
  recorded_meeting_id text;
  error_message text;
begin
  perform set_config('plpgsql.variable_conflict', 'error', true);
  if exists (
    select * from public.temporary_claim_fixture_metadata
    except
    select proowner, prosecdef, proconfig, proacl, proargnames, proargmodes, pg_get_function_result(oid)
    from pg_catalog.pg_proc
    where oid = 'public.claim_temporary_classroom_request(text,text,jsonb,text,text,text,text,text)'::regprocedure
  ) then raise exception 'migration changed claim owner, security, settings, ACL or signature'; end if;
  meeting_id := 'yinling-test-' || encode(extensions.digest('temporary-test:' || actor || ':' || request_key, 'sha256'), 'hex');
  identity := 'temporary-classroom:' || encode(extensions.digest(actor || chr(31) || request_key, 'sha256'), 'hex');
  select * into strict first_claim from public.claim_temporary_classroom_request('temporary-claim-fixture-only', request_key, '{"mode":"test"}', 'test', null, null, meeting_id, actor);
  if first_claim.request_identity is distinct from identity
     or first_claim.request_key is distinct from request_key
     or first_claim.actor is distinct from actor
     or first_claim.intent is distinct from '{"mode":"test"}'::jsonb
     or first_claim.mode is distinct from 'test'
     or first_claim.booking_id is not null or first_claim.occurrence_id is not null
     or first_claim.meeting_id is distinct from meeting_id
     or first_claim.replayed is distinct from false then raise exception 'first direct claim returned incorrect metadata'; end if;
  select r.claimed_at into claimed_at from internal.temporary_classroom_requests r where r.request_identity = identity;
  select * into strict replay_claim from public.claim_temporary_classroom_request('temporary-claim-fixture-only', request_key, '{"mode":"test"}', 'test', null, null, meeting_id, actor);
  if replay_claim.request_identity is distinct from first_claim.request_identity
     or replay_claim.replayed is distinct from true
     or (select r.claimed_at from internal.temporary_classroom_requests r where r.request_identity = identity) is distinct from claimed_at
     or (select count(*) from internal.temporary_classroom_requests) <> 1 then raise exception 'direct replay changed the ledger'; end if;
  select * into strict isolated_claim from public.claim_temporary_classroom_request(
    'temporary-claim-fixture-only', request_key, '{"mode":"test"}', 'test', null, null,
    'yinling-test-' || encode(extensions.digest('temporary-test:' || second_actor || ':' || request_key, 'sha256'), 'hex'), second_actor);
  if isolated_claim.request_identity = first_claim.request_identity
     or isolated_claim.meeting_id = first_claim.meeting_id
     or isolated_claim.actor is distinct from second_actor
     or isolated_claim.replayed is distinct from false then raise exception 'request key was not isolated by actor'; end if;
  begin
    perform public.claim_temporary_classroom_request('temporary-claim-fixture-only', request_key, '{"mode":"test"}', 'test', null, null, 'wrong-meeting-id', actor);
    raise exception 'mismatched meeting identity was accepted';
  exception when invalid_parameter_value then null;
  end;
  booking_id := 'TMP-' || left(encode(extensions.digest('temporary-booking:' || actor || ':' || recorded_request_key, 'sha256'), 'hex'), 48);
  occurrence_id := booking_id || ':2026-10-15';
  recorded_meeting_id := 'yinling-occ-' || left(encode(extensions.digest(occurrence_id, 'sha256'), 'hex'), 48);
  intent := jsonb_build_object('mode', 'recorded', 'studentId', 'SYNTHETIC-STUDENT', 'teacherId', 'SYNTHETIC-TEACHER',
    'subjectId', 'Year7 English', 'teacherSubjectId', 'Year7 English', 'packageId', 'SYNTHETIC-PACKAGE',
    'duration', 60, 'date', '2026-10-15', 'start', '15:00', 'timezone', 'Australia/Melbourne');
  select * into strict first_claim from public.claim_temporary_classroom_request('temporary-claim-fixture-only', recorded_request_key, intent, 'recorded', booking_id, occurrence_id, recorded_meeting_id, actor);
  if first_claim.booking_id is distinct from booking_id or first_claim.occurrence_id is distinct from occurrence_id
     or first_claim.meeting_id is distinct from recorded_meeting_id or first_claim.intent is distinct from intent
     or first_claim.mode is distinct from 'recorded' or first_claim.replayed is distinct from false then raise exception 'first recorded claim returned incorrect metadata'; end if;
  select * into strict replay_claim from public.claim_temporary_classroom_request('temporary-claim-fixture-only', recorded_request_key, intent, 'recorded', booking_id, occurrence_id, recorded_meeting_id, actor);
  if replay_claim.request_identity is distinct from first_claim.request_identity or replay_claim.replayed is distinct from true then raise exception 'recorded claim did not replay'; end if;
  begin
    perform public.claim_temporary_classroom_request('temporary-claim-fixture-only', recorded_request_key, intent || '{"subjectId":"Year7 Science"}', 'recorded', booking_id, occurrence_id, recorded_meeting_id, actor);
    raise exception 'changed recorded intent was accepted';
  exception when unique_violation then
    get stacked diagnostics error_message = message_text;
    if error_message <> 'temporary_classroom_request_conflict' then raise; end if;
  end;
  booking_id := 'TMP-' || left(encode(extensions.digest('temporary-booking:' || actor || ':' || request_key, 'sha256'), 'hex'), 48);
  occurrence_id := booking_id || ':2026-10-15';
  begin
    perform public.claim_temporary_classroom_request('temporary-claim-fixture-only', request_key, intent, 'recorded', booking_id, occurrence_id,
      'yinling-occ-' || left(encode(extensions.digest(occurrence_id, 'sha256'), 'hex'), 48), actor);
    raise exception 'changed direct mode was accepted';
  exception when unique_violation then
    get stacked diagnostics error_message = message_text;
    if error_message <> 'temporary_classroom_request_conflict' then raise; end if;
  end;
  if (select count(*) from internal.temporary_classroom_requests) <> 3
     or (select r.intent from internal.temporary_classroom_requests r where r.request_identity = first_claim.request_identity) is distinct from intent then
    raise exception 'rejected request modified the claim ledger';
  end if;
  if not has_function_privilege('anon', 'public.claim_temporary_classroom_request(text,text,jsonb,text,text,text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.claim_temporary_classroom_request(text,text,jsonb,text,text,text,text,text)', 'execute')
     or has_function_privilege('service_role', 'public.claim_temporary_classroom_request(text,text,jsonb,text,text,text,text,text)', 'execute')
     or has_table_privilege('anon', 'internal.temporary_classroom_requests', 'select,insert,update,delete')
     or has_table_privilege('authenticated', 'internal.temporary_classroom_requests', 'select,insert,update,delete') then
    raise exception 'claim privilege boundary changed';
  end if;
end;
$fixed_claim$;

set role anon;
do $secret_guard$
begin
  begin
    perform public.claim_temporary_classroom_request('wrong-secret', 'temporary-secret-guard', '{"mode":"test"}', 'test', null, null, 'unused-meeting', 'Synthetic Admin A');
    raise exception 'invalid secret was accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'invalid_ops_secret' then raise; end if;
  end;
end;
$secret_guard$;
reset role;
select 'PASS: original 42702, direct and recorded claims, replay, actor isolation, immutable intent, secret and migration metadata';
