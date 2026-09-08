-- Keep an uncertain Tencent write bound to the source that produced it.
-- Business columns remain the existing 13-column contract; no external sheet
-- schema change or new provider permission is needed.
set local lock_timeout = '1s';
select pg_advisory_xact_lock(hashtextextended('tencent-trial-ledger-sync', 0));

-- Old runs have no recoverable source snapshot. Drain the worker and resolve
-- pre-existing uncertain receipts before installing this contract; guessing
-- their original mutable values would reproduce the duplicate-row bug.
do $$
begin
  if exists (select 1 from internal.tencent_trial_ledger_sync_runs where status = 'processing')
    or exists (select 1 from internal.tencent_trial_ledger_outbox
      where status <> 'completed' and attempt_count > 0) then
    raise exception using errcode = '55000', message = 'tencent_trial_ledger_legacy_recovery_required';
  end if;
end;
$$;

create table internal.tencent_trial_ledger_pending_snapshot (
  singleton boolean primary key default true check (singleton),
  source_versions jsonb not null check (jsonb_typeof(source_versions) = 'object'),
  state_rows jsonb not null check (jsonb_typeof(state_rows) = 'array' and jsonb_array_length(state_rows) = 2),
  created_at timestamptz not null default clock_timestamp()
);
alter table internal.tencent_trial_ledger_pending_snapshot enable row level security;
revoke all on table internal.tencent_trial_ledger_pending_snapshot from public, anon, authenticated, service_role;

create or replace function public.claim_tencent_trial_ledger_sync_batch(
  p_secret text,
  p_worker_id text,
  p_limit integer default 100,
  p_lease_seconds integer default 300
)
returns table(
  lease_token text,
  events jsonb,
  source_versions jsonb,
  state_rows jsonb,
  mappings jsonb,
  attempt_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  selected_ids uuid[];
  lease uuid;
  now_at timestamptz;
  pending internal.tencent_trial_ledger_pending_snapshot%rowtype;
  versions jsonb;
  students_state public.ops_state%rowtype;
  lp_items_state public.ops_state%rowtype;
  attempts integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(btrim(p_worker_id), '') !~ '^[A-Za-z0-9._:-]{1,80}$'
     or p_limit is null or p_limit not between 1 and 500
     or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'invalid_tencent_trial_ledger_claim';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tencent-trial-ledger-sync', 0));
  now_at := clock_timestamp();

  update internal.tencent_trial_ledger_outbox outbox
  set status = case when outbox.attempt_count >= 8 then 'dead' else 'failed' end,
      available_at = now_at,
      lease_token = null,
      lease_expires_at = null,
      error_code = 'lease_expired'
  from internal.tencent_trial_ledger_sync_runs run
  where run.status = 'processing'
    and run.lease_expires_at <= now_at
    and outbox.lease_token = run.lease_token
    and outbox.status = 'processing';
  update internal.tencent_trial_ledger_sync_runs run
  set status = 'failed', completed_at = now_at, error_code = 'lease_expired'
  where run.status = 'processing' and run.lease_expires_at <= now_at;

  if exists (
    select 1 from internal.tencent_trial_ledger_sync_runs run
    where run.status = 'processing' and run.lease_expires_at > now_at
  ) then
    return;
  end if;

  select * into pending from internal.tencent_trial_ledger_pending_snapshot
  where singleton = true for update;

  select array_agg(candidate.event_id order by candidate.created_at, candidate.event_id)
  into selected_ids
  from (
    select outbox.event_id, outbox.created_at
    from internal.tencent_trial_ledger_outbox outbox
    where outbox.status in ('pending', 'failed')
      and outbox.attempt_count < 8
      and outbox.available_at <= now_at
      and (pending.singleton is null
        or outbox.entity_version <= (pending.source_versions ->> outbox.entity)::bigint)
    order by outbox.created_at, outbox.event_id
    for update skip locked
    limit p_limit
  ) candidate;
  if selected_ids is null or cardinality(selected_ids) = 0 then
    -- A dead or delayed old write must never be bypassed by a newer source
    -- version. Its Tencent add may already have committed without a receipt.
    if pending.singleton is not null and exists (
      select 1 from internal.tencent_trial_ledger_outbox outbox
      where outbox.status = 'dead'
        and outbox.entity_version <= (pending.source_versions ->> outbox.entity)::bigint
    ) then
      raise exception using errcode = '55000', message = 'tencent_trial_ledger_recovery_required';
    end if;
    return;
  end if;

  if pending.singleton is null then
    select * into students_state from public.ops_state where entity = 'students' for share;
    select * into lp_items_state from public.ops_state where entity = 'lpItems' for share;
    if students_state.entity is null or lp_items_state.entity is null
       or jsonb_typeof(students_state.payload) is distinct from 'array'
       or jsonb_typeof(lp_items_state.payload) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'tencent_trial_ledger_source_state_missing';
    end if;
    insert into internal.tencent_trial_ledger_pending_snapshot(singleton, source_versions, state_rows)
    values (true,
      jsonb_build_object('students', students_state.version, 'lpItems', lp_items_state.version),
      jsonb_build_array(to_jsonb(students_state), to_jsonb(lp_items_state)))
    returning * into pending;
  end if;
  -- Retry the exact original projection until its mapping is durable. A new
  -- LP edit remains queued and is projected only after this snapshot completes.
  lease := gen_random_uuid();
  versions := pending.source_versions;
  update internal.tencent_trial_ledger_outbox outbox
  set status = 'processing',
      attempt_count = outbox.attempt_count + 1,
      lease_token = lease,
      lease_expires_at = now_at + make_interval(secs => p_lease_seconds),
      error_code = null
  where outbox.event_id = any(selected_ids);
  select max(outbox.attempt_count) into attempts
  from internal.tencent_trial_ledger_outbox outbox where outbox.event_id = any(selected_ids);

  insert into internal.tencent_trial_ledger_sync_runs(
    lease_token, worker_id, source_versions, event_ids, status, leased_at, lease_expires_at
  ) values (
    lease, btrim(p_worker_id), versions, selected_ids, 'processing', now_at,
    now_at + make_interval(secs => p_lease_seconds)
  );

  return query
  select lease::text,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventId', outbox.event_id::text,
        'entity', outbox.entity,
        'entityVersion', outbox.entity_version,
        'attempt', outbox.attempt_count
      ) order by outbox.created_at, outbox.event_id)
      from internal.tencent_trial_ledger_outbox outbox where outbox.event_id = any(selected_ids)
    ), '[]'::jsonb),
    versions,
    pending.state_rows,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'lpItemId', mapping.lp_item_id,
        'recordId', mapping.tencent_record_id,
        'payloadSha256', mapping.payload_sha256
      ) order by mapping.lp_item_id)
      from internal.tencent_trial_ledger_record_map mapping
    ), '[]'::jsonb),
    attempts;
end;
$$;
revoke all on function public.claim_tencent_trial_ledger_sync_batch(text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_tencent_trial_ledger_sync_batch(text, text, integer, integer)
  to anon, authenticated;

-- The new application requires v2 so a code-only rollout cannot silently
-- fall back to the old non-durable claim implementation.
create function public.claim_tencent_trial_ledger_sync_batch_v2(
  p_secret text, p_worker_id text, p_limit integer default 100, p_lease_seconds integer default 300
)
returns table(lease_token text, events jsonb, source_versions jsonb, state_rows jsonb, mappings jsonb, attempt_count integer)
language sql volatile security definer set search_path = ''
as $$
  select * from public.claim_tencent_trial_ledger_sync_batch(p_secret, p_worker_id, p_limit, p_lease_seconds)
$$;
revoke all on function public.claim_tencent_trial_ledger_sync_batch_v2(text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_tencent_trial_ledger_sync_batch_v2(text, text, integer, integer)
  to anon, authenticated;

create or replace function public.complete_tencent_trial_ledger_sync_batch(
  p_secret text,
  p_lease_token text,
  p_payload_sha256 text,
  p_record_count integer,
  p_record_mappings jsonb,
  p_actor text
)
returns table(completed boolean, completed_event_count integer, synced_record_count integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  lease uuid;
  run internal.tencent_trial_ledger_sync_runs%rowtype;
  completed_at_value timestamptz;
  completed_events integer;
  mapping_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(lower(btrim(p_lease_token)), '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(lower(btrim(p_payload_sha256)), '') !~ '^[a-f0-9]{64}$'
     or p_record_count is null or p_record_count not between 0 and 100000
     or jsonb_typeof(p_record_mappings) is distinct from 'array'
     or nullif(btrim(p_actor), '') is null or length(btrim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_tencent_trial_ledger_completion';
  end if;
  if jsonb_array_length(p_record_mappings) <> p_record_count then
    raise exception using errcode = '22023', message = 'invalid_tencent_trial_ledger_completion';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_record_mappings) mapping(value)
    where case
      when jsonb_typeof(mapping.value) is distinct from 'object' then true
      else (select count(*) from jsonb_object_keys(mapping.value)) <> 3
        or coalesce(mapping.value ->> 'lpItemId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
        or coalesce(mapping.value ->> 'recordId', '') !~ '^[A-Za-z0-9_-]{1,160}$'
        or coalesce(mapping.value ->> 'payloadSha256', '') !~ '^[a-f0-9]{64}$'
    end
  ) then
    raise exception using errcode = '22023', message = 'invalid_tencent_trial_ledger_mapping';
  end if;
  select count(distinct mapping.value ->> 'lpItemId'), count(*)
  into mapping_count, completed_events
  from jsonb_array_elements(p_record_mappings) mapping(value);
  if mapping_count <> completed_events or (
    select count(distinct mapping.value ->> 'recordId')
    from jsonb_array_elements(p_record_mappings) mapping(value)
  ) <> completed_events then
    raise exception using errcode = '22023', message = 'duplicate_tencent_trial_ledger_mapping';
  end if;

  lease := lower(btrim(p_lease_token))::uuid;
  perform pg_advisory_xact_lock(hashtextextended('tencent-trial-ledger-sync', 0));
  select * into run from internal.tencent_trial_ledger_sync_runs candidate
  where candidate.lease_token = lease for update;
  completed_at_value := clock_timestamp();
  if run.lease_token is null or run.status <> 'processing' then
    raise exception using errcode = '40001', message = 'tencent_trial_ledger_lease_not_active';
  end if;
  if run.lease_expires_at <= completed_at_value then
    raise exception using errcode = '40001', message = 'tencent_trial_ledger_lease_expired';
  end if;
  if not exists (
    select 1 from internal.tencent_trial_ledger_pending_snapshot pending
    where pending.singleton and pending.source_versions = run.source_versions
  ) then
    raise exception using errcode = '40001', message = 'tencent_trial_ledger_snapshot_mismatch';
  end if;
  if exists (
    select 1
    from internal.tencent_trial_ledger_record_map existing
    join jsonb_array_elements(p_record_mappings) mapping(value)
      on mapping.value ->> 'lpItemId' = existing.lp_item_id
    where mapping.value ->> 'recordId' <> existing.tencent_record_id
  ) then
    raise exception using errcode = '40001', message = 'tencent_trial_ledger_mapping_reassignment';
  end if;

  -- Never remove a historical mapping. Tencent records are never deleted, and
  -- retaining the record ID prevents a temporarily absent LP from duplicating.
  insert into internal.tencent_trial_ledger_record_map(
    lp_item_id, tencent_record_id, payload_sha256, synced_at, synced_by
  )
  select mapping.value ->> 'lpItemId', mapping.value ->> 'recordId',
    mapping.value ->> 'payloadSha256', completed_at_value, btrim(p_actor)
  from jsonb_array_elements(p_record_mappings) mapping(value)
  on conflict (lp_item_id) do update
  set payload_sha256 = excluded.payload_sha256,
      synced_at = excluded.synced_at,
      synced_by = excluded.synced_by;

  update internal.tencent_trial_ledger_outbox outbox
  set status = 'completed', lease_token = null, lease_expires_at = null,
      completed_at = completed_at_value, error_code = null
  where outbox.status <> 'completed'
    and ((outbox.entity = 'students' and outbox.entity_version <= (run.source_versions ->> 'students')::bigint)
      or (outbox.entity = 'lpItems' and outbox.entity_version <= (run.source_versions ->> 'lpItems')::bigint));
  get diagnostics completed_events = row_count;

  update internal.tencent_trial_ledger_sync_runs candidate
  set status = 'completed', completed_at = completed_at_value,
      payload_sha256 = lower(btrim(p_payload_sha256)), record_count = p_record_count,
      error_code = null
  where candidate.lease_token = lease;

  delete from internal.tencent_trial_ledger_pending_snapshot
  where singleton and source_versions = run.source_versions;

  perform internal.append_operational_contract_audit(
    'trial.tencent_ledger.synced', btrim(p_actor), 'integration', 'tencent-trial-ledger',
    jsonb_build_object(
      'leaseToken', lease::text,
      'payloadSha256', lower(btrim(p_payload_sha256)),
      'recordCount', p_record_count,
      'completedEventCount', completed_events,
      'sourceVersions', run.source_versions
    )
  );
  return query select true, completed_events, p_record_count;
end;
$$;
revoke all on function public.complete_tencent_trial_ledger_sync_batch(text, text, text, integer, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_tencent_trial_ledger_sync_batch(text, text, text, integer, jsonb, text)
  to anon, authenticated;
