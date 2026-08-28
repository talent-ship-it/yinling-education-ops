-- Transactional outbox and durable Tencent record mapping for the 13-column
-- trial review ledger. PostgreSQL owns change detection and leasing; the
-- external MCP bridge receives only the two authoritative state rows required
-- to build the projection and acknowledges only after Tencent read-back.

create table if not exists internal.tencent_trial_ledger_outbox (
  event_id uuid primary key default gen_random_uuid(),
  entity text not null check (entity in ('students', 'lpItems')),
  entity_version bigint not null check (entity_version > 0),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'failed', 'completed', 'dead')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_.:-]{1,80}$'),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (entity, entity_version),
  check (
    (status = 'processing' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'processing' and lease_token is null and lease_expires_at is null)
  )
);
create index if not exists tencent_trial_ledger_outbox_ready_idx
  on internal.tencent_trial_ledger_outbox(status, available_at, created_at)
  where status in ('pending', 'failed');
alter table internal.tencent_trial_ledger_outbox enable row level security;
revoke all on table internal.tencent_trial_ledger_outbox from public, anon, authenticated, service_role;

create table if not exists internal.tencent_trial_ledger_sync_runs (
  lease_token uuid primary key,
  worker_id text not null check (worker_id ~ '^[A-Za-z0-9._:-]{1,80}$'),
  source_versions jsonb not null check (jsonb_typeof(source_versions) = 'object'),
  event_ids uuid[] not null check (cardinality(event_ids) > 0),
  status text not null check (status in ('processing', 'completed', 'failed')),
  leased_at timestamptz not null,
  lease_expires_at timestamptz not null,
  completed_at timestamptz,
  payload_sha256 text check (payload_sha256 is null or payload_sha256 ~ '^[a-f0-9]{64}$'),
  record_count integer check (record_count is null or record_count between 0 and 100000),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_.:-]{1,80}$')
);
create unique index if not exists tencent_trial_ledger_one_active_run_idx
  on internal.tencent_trial_ledger_sync_runs ((status)) where status = 'processing';
alter table internal.tencent_trial_ledger_sync_runs enable row level security;
revoke all on table internal.tencent_trial_ledger_sync_runs from public, anon, authenticated, service_role;

create table if not exists internal.tencent_trial_ledger_record_map (
  lp_item_id text primary key check (lp_item_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  tencent_record_id text not null unique check (tencent_record_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  synced_at timestamptz not null,
  synced_by text not null check (length(synced_by) between 1 and 120)
);
alter table internal.tencent_trial_ledger_record_map enable row level security;
revoke all on table internal.tencent_trial_ledger_record_map from public, anon, authenticated, service_role;

create or replace function internal.enqueue_tencent_trial_ledger_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.entity in ('students', 'lpItems')
     and jsonb_typeof(new.payload) = 'array'
     and (tg_op = 'INSERT' or old.version is distinct from new.version or old.payload is distinct from new.payload) then
    insert into internal.tencent_trial_ledger_outbox(entity, entity_version)
    values (new.entity, new.version)
    on conflict (entity, entity_version) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function internal.enqueue_tencent_trial_ledger_sync()
  from public, anon, authenticated, service_role;

drop trigger if exists enqueue_tencent_trial_ledger_sync on public.ops_state;
create trigger enqueue_tencent_trial_ledger_sync
after insert or update of payload, version on public.ops_state
for each row execute function internal.enqueue_tencent_trial_ledger_sync();

-- Queue one bootstrap projection without changing any operational state.
insert into internal.tencent_trial_ledger_outbox(entity, entity_version)
select entity, version
from public.ops_state
where entity in ('students', 'lpItems')
  and jsonb_typeof(payload) = 'array'
on conflict (entity, entity_version) do nothing;

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
  now_at timestamptz := clock_timestamp();
  versions jsonb;
  students_state public.ops_state%rowtype;
  lp_items_state public.ops_state%rowtype;
  attempts integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(btrim(p_worker_id), '') !~ '^[A-Za-z0-9._:-]{1,80}$'
     or p_limit not between 1 and 500
     or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'invalid_tencent_trial_ledger_claim';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tencent-trial-ledger-sync', 0));

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

  select array_agg(candidate.event_id order by candidate.created_at, candidate.event_id)
  into selected_ids
  from (
    select outbox.event_id, outbox.created_at
    from internal.tencent_trial_ledger_outbox outbox
    where outbox.status in ('pending', 'failed')
      and outbox.attempt_count < 8
      and outbox.available_at <= now_at
    order by outbox.created_at, outbox.event_id
    for update skip locked
    limit p_limit
  ) candidate;
  if selected_ids is null or cardinality(selected_ids) = 0 then return; end if;

  select * into students_state from public.ops_state where entity = 'students' for share;
  select * into lp_items_state from public.ops_state where entity = 'lpItems' for share;
  if students_state.entity is null or lp_items_state.entity is null
     or jsonb_typeof(students_state.payload) is distinct from 'array'
     or jsonb_typeof(lp_items_state.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'tencent_trial_ledger_source_state_missing';
  end if;

  lease := gen_random_uuid();
  versions := jsonb_build_object('students', students_state.version, 'lpItems', lp_items_state.version);
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
    jsonb_build_array(to_jsonb(students_state), to_jsonb(lp_items_state)),
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
  completed_at_value timestamptz := clock_timestamp();
  completed_events integer;
  mapping_count integer;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(lower(btrim(p_lease_token)), '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(lower(btrim(p_payload_sha256)), '') !~ '^[a-f0-9]{64}$'
     or p_record_count not between 0 and 100000
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
  select count(distinct mapping.value ->> 'lpItemId'), count(*) into mapping_count, completed_events
  from jsonb_array_elements(p_record_mappings) mapping(value);
  if mapping_count <> completed_events or (
    select count(distinct mapping.value ->> 'recordId')
    from jsonb_array_elements(p_record_mappings) mapping(value)
  ) <> completed_events then
    raise exception using errcode = '22023', message = 'duplicate_tencent_trial_ledger_mapping';
  end if;

  lease := lower(btrim(p_lease_token))::uuid;
  select * into run from internal.tencent_trial_ledger_sync_runs candidate
  where candidate.lease_token = lease for update;
  if run.lease_token is null or run.status <> 'processing' then
    raise exception using errcode = '40001', message = 'tencent_trial_ledger_lease_not_active';
  end if;
  if run.lease_expires_at <= completed_at_value then
    raise exception using errcode = '40001', message = 'tencent_trial_ledger_lease_expired';
  end if;

  delete from internal.tencent_trial_ledger_record_map existing
  where not exists (
    select 1 from jsonb_array_elements(p_record_mappings) mapping(value)
    where mapping.value ->> 'lpItemId' = existing.lp_item_id
  );

  insert into internal.tencent_trial_ledger_record_map(
    lp_item_id, tencent_record_id, payload_sha256, synced_at, synced_by
  )
  select mapping.value ->> 'lpItemId', mapping.value ->> 'recordId',
    mapping.value ->> 'payloadSha256', completed_at_value, btrim(p_actor)
  from jsonb_array_elements(p_record_mappings) mapping(value)
  on conflict (lp_item_id) do update
  set tencent_record_id = excluded.tencent_record_id,
      payload_sha256 = excluded.payload_sha256,
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
  now_at timestamptz := clock_timestamp();
  max_attempt integer;
  retry_value timestamptz;
  dead_value boolean;
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
  select * into run from internal.tencent_trial_ledger_sync_runs candidate
  where candidate.lease_token = lease for update;
  if run.lease_token is null or run.status <> 'processing' then
    raise exception using errcode = '40001', message = 'tencent_trial_ledger_lease_not_active';
  end if;
  select max(outbox.attempt_count) into max_attempt
  from internal.tencent_trial_ledger_outbox outbox where outbox.lease_token = lease;
  dead_value := coalesce(max_attempt, 0) >= 8;
  retry_value := now_at + make_interval(mins => least(60, (power(2, greatest(coalesce(max_attempt, 1) - 1, 0)))::integer));

  update internal.tencent_trial_ledger_outbox outbox
  set status = case when dead_value then 'dead' else 'failed' end,
      available_at = retry_value,
      lease_token = null,
      lease_expires_at = null,
      error_code = lower(btrim(p_error_code))
  where outbox.lease_token = lease and outbox.status = 'processing';
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

create or replace function public.get_tencent_trial_ledger_sync_status(p_secret text)
returns table(
  pending_count bigint,
  failed_count bigint,
  dead_count bigint,
  active_lease_expires_at timestamptz,
  last_synced_at timestamptz,
  last_payload_sha256 text,
  last_record_count integer
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
    count(*) filter (where outbox.status = 'pending'),
    count(*) filter (where outbox.status = 'failed'),
    count(*) filter (where outbox.status = 'dead'),
    (select max(run.lease_expires_at) from internal.tencent_trial_ledger_sync_runs run where run.status = 'processing'),
    (select max(run.completed_at) from internal.tencent_trial_ledger_sync_runs run where run.status = 'completed'),
    (select run.payload_sha256 from internal.tencent_trial_ledger_sync_runs run
      where run.status = 'completed' order by run.completed_at desc nulls last limit 1),
    (select run.record_count from internal.tencent_trial_ledger_sync_runs run
      where run.status = 'completed' order by run.completed_at desc nulls last limit 1)
  from internal.tencent_trial_ledger_outbox outbox;
end;
$$;
revoke all on function public.get_tencent_trial_ledger_sync_status(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_tencent_trial_ledger_sync_status(text)
  to anon, authenticated;
