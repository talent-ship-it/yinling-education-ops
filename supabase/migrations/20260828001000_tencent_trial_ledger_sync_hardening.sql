-- Harden the external Tencent MCP bridge without changing its one-way scope.
-- Existing record IDs are immutable, historical mappings are retained, and
-- completion/failure decisions are made under the live lease lock time.

set local lock_timeout = '1s';

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

create or replace function public.fail_tencent_trial_ledger_sync_batch(
  p_secret text,
  p_lease_token text,
  p_error_code text,
  p_actor text
)
returns table(failed boolean, dead boolean, retry_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  lease uuid;
  run internal.tencent_trial_ledger_sync_runs%rowtype;
  now_at timestamptz;
  retry_value timestamptz;
  dead_value boolean;
  released_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(lower(btrim(p_lease_token)), '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(lower(btrim(p_error_code)), '') !~ '^[a-z0-9_.:-]{1,80}$'
     or nullif(btrim(p_actor), '') is null or length(btrim(p_actor)) > 120 then
    raise exception using errcode = '22023', message = 'invalid_tencent_trial_ledger_failure';
  end if;

  lease := lower(btrim(p_lease_token))::uuid;
  perform pg_advisory_xact_lock(hashtextextended('tencent-trial-ledger-sync', 0));
  select * into run from internal.tencent_trial_ledger_sync_runs candidate
  where candidate.lease_token = lease for update;
  now_at := clock_timestamp();
  if run.lease_token is null or run.status <> 'processing' then
    raise exception using errcode = '40001', message = 'tencent_trial_ledger_lease_not_active';
  end if;
  if run.lease_expires_at <= now_at then
    raise exception using errcode = '40001', message = 'tencent_trial_ledger_lease_expired';
  end if;

  with released as (
    update internal.tencent_trial_ledger_outbox outbox
    set status = case when outbox.attempt_count >= 8 then 'dead' else 'failed' end,
        available_at = case when outbox.attempt_count >= 8 then now_at else now_at + make_interval(
          mins => least(60, power(2, greatest(outbox.attempt_count - 1, 0))::integer)
        ) end,
        lease_token = null,
        lease_expires_at = null,
        error_code = lower(btrim(p_error_code))
    where outbox.lease_token = lease and outbox.status = 'processing'
    returning status, available_at
  )
  select count(*), coalesce(bool_and(status = 'dead'), false),
    min(available_at) filter (where status = 'failed')
  into released_count, dead_value, retry_value
  from released;
  if released_count = 0 then
    raise exception using errcode = '40001', message = 'tencent_trial_ledger_lease_events_missing';
  end if;

  update internal.tencent_trial_ledger_sync_runs candidate
  set status = 'failed', completed_at = now_at, error_code = lower(btrim(p_error_code))
  where candidate.lease_token = lease;

  perform internal.append_operational_contract_audit(
    'trial.tencent_ledger.failed', btrim(p_actor), 'integration', 'tencent-trial-ledger',
    jsonb_build_object('leaseToken', lease::text, 'errorCode', lower(btrim(p_error_code)),
      'dead', dead_value, 'retryAt', retry_value)
  );
  return query select true, dead_value, retry_value;
end;
$$;
revoke all on function public.fail_tencent_trial_ledger_sync_batch(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_tencent_trial_ledger_sync_batch(text, text, text, text)
  to anon, authenticated;
