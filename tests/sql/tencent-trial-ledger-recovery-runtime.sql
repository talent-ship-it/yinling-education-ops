\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Run only in a disposable, empty local database. All fixtures roll back.
begin;
create schema internal;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
exception when duplicate_object then null;
end $$;
create table public.ops_state (
  entity text primary key, payload jsonb not null, version bigint not null,
  updated_at timestamptz not null default now(), updated_by text not null default 'fixture'
);
create function internal.verify_ops_secret(p_secret text)
returns boolean language sql immutable set search_path = ''
as $$ select p_secret = 'synthetic-tencent-recovery-secret' $$;
create function internal.append_operational_contract_audit(text, text, text, text, jsonb)
returns uuid language sql set search_path = '' as $$ select gen_random_uuid() $$;

\ir ../../supabase/migrations/20260828000800_tencent_trial_ledger_outbox.sql
\ir ../../supabase/migrations/20260828001000_tencent_trial_ledger_sync_hardening.sql
\ir ../../supabase/migrations/20260908050013_tencent_trial_ledger_durable_recovery.sql

insert into public.ops_state(entity, payload, version) values
  ('students', '[{"id":"STU-1","name":"Synthetic student"}]', 1),
  ('lpItems', '[{"id":"LP-1","studentId":"STU-1","trialPaid":false}]', 1);

do $$
declare
  first_claim record;
  retried record;
  next_claim record;
  completed record;
  expired_retry record;
  count_value integer;
  hash text := repeat('a', 64);
begin
  select * into first_claim from public.claim_tencent_trial_ledger_sync_batch_v2(
    'synthetic-tencent-recovery-secret', 'fixture', 100, 300);
  assert first_claim.lease_token is not null;
  assert first_claim.source_versions = '{"students":1,"lpItems":1}'::jsonb;
  select count(*) into count_value from public.claim_tencent_trial_ledger_sync_batch_v2(
    'synthetic-tencent-recovery-secret', 'other-worker', 100, 300);
  assert count_value = 0, 'active lease must exclude another worker';

  -- Tencent has accepted the old unpaid row but its response was lost.
  -- A user edits both sources before the worker reports failure.
  update public.ops_state set payload = '[{"id":"STU-1","name":"Edited student"}]', version = 2
  where entity = 'students';
  update public.ops_state set payload = '[{"id":"LP-1","studentId":"STU-1","trialPaid":true}]', version = 2
  where entity = 'lpItems';
  perform public.fail_tencent_trial_ledger_sync_batch(
    'synthetic-tencent-recovery-secret', first_claim.lease_token, 'lost_add_response', 'fixture');

  select count(*) into count_value from public.claim_tencent_trial_ledger_sync_batch_v2(
    'synthetic-tencent-recovery-secret', 'fixture', 100, 300);
  assert count_value = 0, 'newer source events cannot bypass the retry delay';
  update internal.tencent_trial_ledger_outbox set available_at = clock_timestamp() - interval '1 second'
  where status = 'failed';
  select * into retried from public.claim_tencent_trial_ledger_sync_batch_v2(
    'synthetic-tencent-recovery-secret', 'fixture', 100, 300);
  assert retried.lease_token <> first_claim.lease_token;
  assert retried.state_rows = first_claim.state_rows, 'retry must project the original source snapshot';
  assert retried.source_versions = first_claim.source_versions;
  assert retried.attempt_count = 2;
  assert not exists (select 1 from jsonb_array_elements(retried.events) event
    where (event ->> 'entityVersion')::integer > 1);

  -- Read-back recovered the old row, making its immutable record ID durable.
  select * into completed from public.complete_tencent_trial_ledger_sync_batch(
    'synthetic-tencent-recovery-secret', retried.lease_token, hash, 1,
    jsonb_build_array(jsonb_build_object('lpItemId','LP-1','recordId','rec_original','payloadSha256',hash)), 'fixture');
  assert completed.completed;
  assert not exists (select 1 from internal.tencent_trial_ledger_pending_snapshot);
  assert (select count(*) from internal.tencent_trial_ledger_outbox where entity_version = 2 and status = 'pending') = 2,
    'completing old source must not acknowledge new edits';

  select * into next_claim from public.claim_tencent_trial_ledger_sync_batch_v2(
    'synthetic-tencent-recovery-secret', 'fixture', 100, 300);
  assert next_claim.source_versions = '{"students":2,"lpItems":2}'::jsonb;
  assert next_claim.state_rows <> retried.state_rows;
  assert next_claim.mappings -> 0 ->> 'recordId' = 'rec_original';

  -- Expiration follows the same recovery contract without a /fail receipt.
  update public.ops_state set payload = '[]', version = 3 where entity = 'lpItems';
  update internal.tencent_trial_ledger_sync_runs set lease_expires_at = clock_timestamp() - interval '1 second'
  where lease_token = next_claim.lease_token::uuid;
  select * into expired_retry from public.claim_tencent_trial_ledger_sync_batch_v2(
    'synthetic-tencent-recovery-secret', 'fixture', 100, 300);
  assert expired_retry.state_rows = next_claim.state_rows, 'expiry must not consume a newer source';

  -- Retry exhaustion cannot release a new source over an uncertain old add.
  update internal.tencent_trial_ledger_outbox set attempt_count = 8
  where lease_token = expired_retry.lease_token::uuid;
  perform public.fail_tencent_trial_ledger_sync_batch(
    'synthetic-tencent-recovery-secret', expired_retry.lease_token, 'lost_add_response', 'fixture');
  begin
    perform public.claim_tencent_trial_ledger_sync_batch_v2('synthetic-tencent-recovery-secret','fixture',100,300);
    raise exception 'expected recovery-required failure';
  exception when sqlstate '55000' then
    assert sqlerrm = 'tencent_trial_ledger_recovery_required';
  end;
  assert exists (select 1 from internal.tencent_trial_ledger_pending_snapshot);
  assert exists (select 1 from internal.tencent_trial_ledger_outbox where entity_version = 3 and status = 'pending');

  begin
    perform public.claim_tencent_trial_ledger_sync_batch_v2('wrong-secret','fixture',100,300);
    raise exception 'invalid secret accepted';
  exception when insufficient_privilege then null;
  end;
  assert not has_table_privilege('anon','internal.tencent_trial_ledger_pending_snapshot','SELECT');
  assert not has_table_privilege('authenticated','internal.tencent_trial_ledger_pending_snapshot','SELECT');
  raise notice 'PASS: pinned retries, source edits, mapping recovery, lease expiry, exhaustion and access control';
end $$;
rollback;
