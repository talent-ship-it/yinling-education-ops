\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;
create schema internal;
create schema extensions;
create extension pgcrypto with schema extensions;
create table public.ops_state(entity text primary key,payload jsonb,version bigint,updated_at timestamptz default now(),updated_by text);
create table public.ops_mutation_log(entity text,version bigint,actor text);
create table internal.operational_contract_audit(id uuid default gen_random_uuid(),action text,actor text,target_type text,target_id text,metadata jsonb);
create table internal.temporary_classroom_requests(request_identity text,mode text,booking_id text,occurrence_id text,meeting_id text);
create function internal.verify_ops_secret(secret text) returns boolean language sql as $$ select secret='classroom-fixture-only' $$;
create function internal.append_operational_contract_audit(p_action text,p_actor text,p_target_type text,p_target_id text,p_metadata jsonb) returns uuid language plpgsql as $$
declare result uuid;
begin insert into internal.operational_contract_audit(action,actor,target_type,target_id,metadata) values(p_action,p_actor,p_target_type,p_target_id,p_metadata) returning id into result; return result; end $$;
\ir ../../supabase/migrations/20260922083628_durable_classroom_end_recovery.sql

do $test$
declare occurrence text := 'B1:2026-09-22'; meeting text; response jsonb; before_version bigint;
  lease uuid := 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  temp_occurrence text := 'TMP-TEST:2026-09-22'; temp_meeting text;
begin
  meeting := 'yinling-occ-' || left(encode(extensions.digest(occurrence,'sha256'),'hex'),48);
  temp_meeting := 'yinling-occ-' || left(encode(extensions.digest(temp_occurrence,'sha256'),'hex'),48);
  insert into public.ops_state values('bookings',jsonb_build_array(jsonb_build_object('id','B1','notes','preserve me','occurrenceOverrides',jsonb_build_array(jsonb_build_object('occurrenceId',occurrence,'status','confirmed','classroom',jsonb_build_object('meetingId',meeting,'status','running'))))),1,now(),'fixture');
  if not public.claim_classroom_creation('classroom-fixture-only',occurrence,meeting,lease) then raise exception 'create lease missing'; end if;
  begin perform public.begin_classroom_end('classroom-fixture-only',occurrence,meeting,0,'Nixon'); raise exception 'stale version allowed'; exception when serialization_failure then null; end;
  if exists(select 1 from internal.classroom_end_requests) then raise exception 'stale request persisted'; end if;
  response := public.begin_classroom_end('classroom-fixture-only',occurrence,meeting,1,'Nixon');
  if response->>'status' <> 'closing' then raise exception 'intent missing'; end if;
  if public.claim_classroom_creation('classroom-fixture-only',occurrence,meeting,gen_random_uuid()) then raise exception 'late create allowed'; end if;
  response := public.finish_classroom_end('classroom-fixture-only',occurrence,true);
  if response->>'status' <> 'closing' then raise exception 'live create lease ignored'; end if;
  if public.release_classroom_creation('classroom-fixture-only',occurrence,lease) then raise exception 'inflight create was not told to compensate'; end if;
  response := public.finish_classroom_end('classroom-fixture-only',occurrence,false);
  if response->>'status' <> 'closing' then raise exception 'unconfirmed provider marked ended'; end if;
  if (select count(*) from public.read_classroom_end_requests('classroom-fixture-only')) <> 1 then raise exception 'cron cannot discover pending intent'; end if;
  update public.ops_state set payload=jsonb_set(payload,'{0,notes}','"new concurrent note"'),version=2 where entity='bookings';
  create function pg_temp.fail_projection() returns trigger language plpgsql as $$ begin raise exception 'fixture database failure'; end $$;
  create trigger fixture_failure before update on public.ops_state for each row execute function pg_temp.fail_projection();
  begin perform public.finish_classroom_end('classroom-fixture-only',occurrence,true); raise exception 'expected database failure'; exception when others then if sqlerrm <> 'fixture database failure' then raise; end if; end;
  if (select status from internal.classroom_end_requests where occurrence_id=occurrence) <> 'closing' then raise exception 'failed projection lost recovery intent'; end if;
  drop trigger fixture_failure on public.ops_state;
  response := public.finish_classroom_end('classroom-fixture-only',occurrence,true);
  if response->>'status' <> 'ended' then raise exception 'retry did not finalize'; end if;
  if (select payload->0->>'notes' from public.ops_state where entity='bookings') <> 'new concurrent note' then raise exception 'unrelated booking edit lost'; end if;
  if (select payload->0->'occurrenceOverrides'->0->'classroom'->>'status' from public.ops_state where entity='bookings') <> 'ended' then raise exception 'booking not closed'; end if;
  select version into before_version from public.ops_state where entity='bookings';
  perform public.finish_classroom_end('classroom-fixture-only',occurrence,true);
  if (select version from public.ops_state where entity='bookings') <> before_version then raise exception 'duplicate close changed booking'; end if;
  if (select count(*) from internal.operational_contract_audit where action='classroom.ended') <> 1 then raise exception 'duplicate close audit'; end if;
  if public.claim_classroom_creation('classroom-fixture-only',occurrence,meeting,gen_random_uuid()) then raise exception 'closed room recreated'; end if;
  if public.claim_classroom_creation('classroom-fixture-only',temp_occurrence,temp_meeting,gen_random_uuid()) then raise exception 'missing booking accepted by ordinary path'; end if;
  begin perform public.claim_temporary_classroom_creation('classroom-fixture-only',temp_occurrence,temp_meeting,gen_random_uuid(),'missing'); raise exception 'unclaimed temporary create accepted'; exception when insufficient_privilege then null; end;
  insert into internal.temporary_classroom_requests values('verified-fixture-claim','recorded','TMP-TEST',temp_occurrence,temp_meeting);
  if not public.claim_temporary_classroom_creation('classroom-fixture-only',temp_occurrence,temp_meeting,gen_random_uuid(),'verified-fixture-claim') then raise exception 'verified temporary saga rejected'; end if;
  -- A crashed or timed-out provisioner cannot block recovery forever. Once its
  -- bounded lease expires, a fresh provider-stopped check can finalize the end.
  insert into internal.classroom_end_requests(occurrence_id,meeting_id,requested_by) values(temp_occurrence,temp_meeting,'fixture');
  response := public.finish_classroom_end('classroom-fixture-only',temp_occurrence,true);
  if response->>'status' <> 'closing' then raise exception 'temporary live lease ignored'; end if;
  update internal.classroom_creation_leases set expires_at=now()-interval '1 second' where occurrence_id=temp_occurrence;
  response := public.finish_classroom_end('classroom-fixture-only',temp_occurrence,true);
  if response->>'status' <> 'ended' then raise exception 'expired lease blocked recovery'; end if;
  begin perform public.read_classroom_end_requests('wrong-secret'); raise exception 'invalid secret accepted'; exception when insufficient_privilege then null; end;
end $test$;
rollback;
select 'PASS: durable intent, inflight creation barrier, database failure recovery, idempotency and verified temporary path';
