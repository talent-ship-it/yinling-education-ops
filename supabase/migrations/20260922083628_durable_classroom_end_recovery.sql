set local lock_timeout = '2s';

create table internal.classroom_end_requests (
  occurrence_id text primary key check (occurrence_id ~ '^.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  meeting_id text not null unique,
  status text not null default 'closing' check (status in ('closing', 'ended')),
  requested_by text not null,
  requested_at timestamptz not null default now(),
  checked_at timestamptz,
  ended_at timestamptz
);
create table internal.classroom_creation_leases (
  lease_id uuid primary key,
  occurrence_id text not null,
  expires_at timestamptz not null default now() + interval '5 minutes'
);
create index classroom_creation_leases_occurrence on internal.classroom_creation_leases(occurrence_id, expires_at);
create index classroom_end_requests_pending on internal.classroom_end_requests(checked_at nulls first, requested_at) where status = 'closing';
alter table internal.classroom_end_requests enable row level security;
alter table internal.classroom_creation_leases enable row level security;
revoke all on internal.classroom_end_requests, internal.classroom_creation_leases from public, anon, authenticated;

create function public.claim_classroom_creation(p_secret text, p_occurrence_id text, p_meeting_id text, p_lease_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare booking jsonb; occurrence jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501', message='invalid_ops_secret'; end if;
  if p_lease_id is null or coalesce(p_occurrence_id,'') !~ '^.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or p_meeting_id is distinct from 'yinling-occ-' || left(encode(extensions.digest(p_occurrence_id,'sha256'),'hex'),48) then
    raise exception using errcode='22023', message='invalid_classroom_identity';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('classroom:' || p_occurrence_id,0));
  if exists(select 1 from internal.classroom_end_requests where occurrence_id=p_occurrence_id) then return false; end if;
  select b into booking from public.ops_state s cross join lateral jsonb_array_elements(s.payload) b
    where s.entity='bookings' and b->>'id'=left(p_occurrence_id,length(p_occurrence_id)-11);
  if booking is null then return false; end if;
  select o into occurrence from jsonb_array_elements(coalesce(booking->'occurrenceOverrides','[]')) o where o->>'occurrenceId'=p_occurrence_id;
  if occurrence->'classroom'->>'status'='ended' or coalesce(occurrence->>'status','confirmed') <> 'confirmed' then return false; end if;
  delete from internal.classroom_creation_leases where occurrence_id=p_occurrence_id and expires_at <= now();
  insert into internal.classroom_creation_leases(lease_id,occurrence_id) values(p_lease_id,p_occurrence_id);
  return true;
end $$;

create function public.release_classroom_creation(p_secret text, p_occurrence_id text, p_lease_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501', message='invalid_ops_secret'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('classroom:' || p_occurrence_id,0));
  delete from internal.classroom_creation_leases where lease_id=p_lease_id and occurrence_id=p_occurrence_id;
  if not found then return false; end if;
  return not exists(select 1 from internal.classroom_end_requests where occurrence_id=p_occurrence_id);
end $$;

-- The existing recorded-temporary-classroom saga claims an immutable request
-- before creating BBB and then persists its booking. Only that verified claim
-- may use this dedicated pre-booking path; the ordinary path still requires a
-- booking. A caller cannot turn a missing booking into an unrestricted create.
create function public.claim_temporary_classroom_creation(p_secret text,p_occurrence_id text,p_meeting_id text,p_lease_id uuid,p_request_identity text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501',message='invalid_ops_secret'; end if;
  if p_lease_id is null or not exists(select 1 from internal.temporary_classroom_requests r
    where r.request_identity=p_request_identity and r.mode='recorded'
      and r.occurrence_id=p_occurrence_id and r.meeting_id=p_meeting_id
      and r.booking_id=left(p_occurrence_id,length(p_occurrence_id)-11)) then
    raise exception using errcode='42501',message='temporary_classroom_claim_required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('classroom:' || p_occurrence_id,0));
  if exists(select 1 from internal.classroom_end_requests where occurrence_id=p_occurrence_id) then return false; end if;
  if exists(select 1 from public.ops_state s cross join lateral jsonb_array_elements(s.payload) b
    where s.entity='bookings' and b->>'id'=left(p_occurrence_id,length(p_occurrence_id)-11)) then
    return public.claim_classroom_creation(p_secret,p_occurrence_id,p_meeting_id,p_lease_id);
  end if;
  insert into internal.classroom_creation_leases(lease_id,occurrence_id) values(p_lease_id,p_occurrence_id);
  return true;
end $$;

create function public.read_classroom_end_requests(p_secret text, p_occurrence_id text default null)
returns table(occurrence_id text, meeting_id text, status text)
language plpgsql security definer set search_path = '' as $$
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501', message='invalid_ops_secret'; end if;
  return query select e.occurrence_id,e.meeting_id,e.status from internal.classroom_end_requests e
    where (p_occurrence_id is not null and e.occurrence_id=p_occurrence_id)
       or (p_occurrence_id is null and e.status='closing')
    order by e.checked_at nulls first,e.requested_at limit 10;
end $$;

create function public.begin_classroom_end(p_secret text,p_occurrence_id text,p_meeting_id text,p_expected_version bigint,p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.classroom_end_requests%rowtype; current_bookings public.ops_state%rowtype; booking jsonb; occurrence jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501', message='invalid_ops_secret'; end if;
  if coalesce(p_occurrence_id,'') !~ '^.+:[0-9]{4}-[0-9]{2}-[0-9]{2}$' or nullif(trim(p_actor),'') is null
     or p_meeting_id is distinct from 'yinling-occ-' || left(encode(extensions.digest(p_occurrence_id,'sha256'),'hex'),48) then
    raise exception using errcode='22023', message='invalid_classroom_identity';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('classroom:' || p_occurrence_id,0));
  select * into saved from internal.classroom_end_requests where occurrence_id=p_occurrence_id;
  if found then return jsonb_build_object('occurrence_id',saved.occurrence_id,'meeting_id',saved.meeting_id,'status',saved.status); end if;
  select * into current_bookings from public.ops_state where entity='bookings' for update;
  if current_bookings.version is distinct from p_expected_version then raise exception using errcode='40001',message='version_conflict'; end if;
  select b into booking from jsonb_array_elements(current_bookings.payload) b where b->>'id'=left(p_occurrence_id,length(p_occurrence_id)-11);
  select o into occurrence from jsonb_array_elements(coalesce(booking->'occurrenceOverrides','[]')) o where o->>'occurrenceId'=p_occurrence_id;
  if occurrence->'classroom'->>'meetingId' is distinct from p_meeting_id then raise exception using errcode='22023',message='classroom_binding_mismatch'; end if;
  insert into internal.classroom_end_requests(occurrence_id,meeting_id,requested_by) values(p_occurrence_id,p_meeting_id,left(trim(p_actor),120));
  perform internal.append_operational_contract_audit('classroom.end_requested',p_actor,'lesson_occurrence',p_occurrence_id,jsonb_build_object('meetingId',p_meeting_id));
  return jsonb_build_object('occurrence_id',p_occurrence_id,'meeting_id',p_meeting_id,'status','closing');
end $$;

create function public.finish_classroom_end(p_secret text,p_occurrence_id text,p_provider_stopped boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare saved internal.classroom_end_requests%rowtype; current_bookings public.ops_state%rowtype;
  booking jsonb; occurrence jsonb; overrides jsonb; updated_booking jsonb; updated_payload jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode='42501', message='invalid_ops_secret'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('classroom:' || p_occurrence_id,0));
  select * into saved from internal.classroom_end_requests where occurrence_id=p_occurrence_id for update;
  if not found then raise exception using errcode='P0002',message='classroom_end_request_missing'; end if;
  update internal.classroom_end_requests set checked_at=now() where occurrence_id=p_occurrence_id;
  if saved.status='ended' then return jsonb_build_object('occurrence_id',p_occurrence_id,'meeting_id',saved.meeting_id,'status','ended'); end if;
  if p_provider_stopped is not true or exists(select 1 from internal.classroom_creation_leases where occurrence_id=p_occurrence_id and expires_at>now()) then
    return jsonb_build_object('occurrence_id',p_occurrence_id,'meeting_id',saved.meeting_id,'status','closing');
  end if;
  select * into current_bookings from public.ops_state where entity='bookings' for update;
  select b into booking from jsonb_array_elements(current_bookings.payload) b where b->>'id'=left(p_occurrence_id,length(p_occurrence_id)-11);
  if booking is not null then
    select o into occurrence from jsonb_array_elements(coalesce(booking->'occurrenceOverrides','[]')) o where o->>'occurrenceId'=p_occurrence_id;
    occurrence := coalesce(occurrence,jsonb_build_object('occurrenceId',p_occurrence_id));
    occurrence := jsonb_set(occurrence,'{classroom}',coalesce(occurrence->'classroom','{}') || jsonb_build_object('occurrenceId',p_occurrence_id,'meetingId',saved.meeting_id,'status','ended','createdAt',coalesce(occurrence->'classroom'->>'createdAt',saved.requested_at::text)));
    select coalesce(jsonb_agg(o order by ord),'[]') into overrides from jsonb_array_elements(coalesce(booking->'occurrenceOverrides','[]')) with ordinality item(o,ord) where o->>'occurrenceId'<>p_occurrence_id;
    updated_booking := jsonb_set(booking,'{occurrenceOverrides}',overrides || jsonb_build_array(occurrence));
    select jsonb_agg(case when b->>'id'=booking->>'id' then updated_booking else b end order by ord) into updated_payload from jsonb_array_elements(current_bookings.payload) with ordinality item(b,ord);
    update public.ops_state set payload=updated_payload,version=version+1,updated_at=now(),updated_by=saved.requested_by where entity='bookings' returning * into current_bookings;
    insert into public.ops_mutation_log(entity,version,actor) values('bookings',current_bookings.version,saved.requested_by);
  end if;
  update internal.classroom_end_requests set status='ended',ended_at=now() where occurrence_id=p_occurrence_id;
  perform internal.append_operational_contract_audit('classroom.ended',saved.requested_by,'lesson_occurrence',p_occurrence_id,jsonb_build_object('meetingId',saved.meeting_id));
  return jsonb_build_object('occurrence_id',p_occurrence_id,'meeting_id',saved.meeting_id,'status','ended');
end $$;

revoke all on function public.claim_classroom_creation(text,text,text,uuid), public.release_classroom_creation(text,text,uuid), public.read_classroom_end_requests(text,text), public.begin_classroom_end(text,text,text,bigint,text), public.finish_classroom_end(text,text,boolean) from public, anon, authenticated;
grant execute on function public.claim_classroom_creation(text,text,text,uuid), public.release_classroom_creation(text,text,uuid), public.read_classroom_end_requests(text,text), public.begin_classroom_end(text,text,text,bigint,text), public.finish_classroom_end(text,text,boolean) to anon, authenticated;
revoke all on function public.claim_temporary_classroom_creation(text,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.claim_temporary_classroom_creation(text,text,text,uuid,text) to anon, authenticated;
