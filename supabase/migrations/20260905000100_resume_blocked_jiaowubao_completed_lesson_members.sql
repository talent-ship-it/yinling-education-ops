-- One-time, postgres-owner management bridge for retiring an exact
-- query_lesson_list caller-failure generation.  Retirement never reuses the
-- partial collection: it preserves every target/page/item as immutable
-- evidence, marks only the latest blocked run aborted/schedule_changed, and
-- lets the existing non-force cron start a fresh full collection.

create or replace function internal.jiaowubao_completed_lesson_retirement_management_session()
returns void
language plpgsql
security invoker
set search_path = ''
as $management_session$
begin
  if session_user <> 'postgres' or current_user <> 'postgres' then
    raise exception using errcode = '42501',
      message = 'jiaowubao_completed_lesson_retirement_management_session_required';
  end if;
end;
$management_session$;

revoke all on function internal.jiaowubao_completed_lesson_retirement_management_session()
  from public, anon, authenticated, service_role;

-- This guard is deliberately about the deterministic latest run, not any
-- historical blocked run.  A retired generation may therefore be followed by
-- the ordinary cron, while an unreviewed caller_failure cannot be bypassed by
-- either force=true or a delayed request.
create or replace function internal.guard_jiaowubao_completed_lesson_blocked_successor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $blocked_successor$
declare
  latest_state text;
  latest_reason text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'jiaowubao-completed-lesson-members:' || new.period_month::text, 0
  ));
  select run_row.state, run_row.abort_reason
    into latest_state, latest_reason
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.period_month = new.period_month
  order by run_row.started_at desc, run_row.id desc
  limit 1
  for update;
  if found and latest_state = 'blocked' and latest_reason = 'caller_failure' then
    raise exception using errcode = '55000',
      message = 'jiaowubao_completed_lesson_member_blocked_requires_management_retirement';
  end if;
  return new;
end;
$blocked_successor$;

drop trigger if exists guard_jiaowubao_completed_lesson_blocked_successor
  on internal.jiaowubao_completed_lesson_member_runs;
create trigger guard_jiaowubao_completed_lesson_blocked_successor
before insert on internal.jiaowubao_completed_lesson_member_runs
for each row execute function internal.guard_jiaowubao_completed_lesson_blocked_successor();
revoke all on function internal.guard_jiaowubao_completed_lesson_blocked_successor()
  from public, anon, authenticated, service_role;

create table if not exists internal.jiaowubao_completed_lesson_retirement_previews (
  confirmation_key text primary key check (confirmation_key ~ '^sha256:[a-f0-9]{64}$'),
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  run_id uuid not null references internal.jiaowubao_completed_lesson_member_runs(id) on delete restrict,
  blocked_audit_id uuid not null references internal.operational_contract_audit(id) on delete restrict,
  blocked_at timestamptz not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  member_count integer not null check (member_count between 1 and 6000),
  completed_member_count integer not null check (completed_member_count between 0 and member_count),
  row_count integer not null check (row_count between 0 and 6000),
  prepared_by text not null check (prepared_by in ('Nixon', 'Ops Admin')),
  prepared_at timestamptz not null default clock_timestamp()
);
alter table internal.jiaowubao_completed_lesson_retirement_previews enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_retirement_previews
  from public, anon, authenticated, service_role;

create table if not exists internal.jiaowubao_completed_lesson_retirement_receipts (
  command_id uuid primary key,
  confirmation_key text not null unique
    references internal.jiaowubao_completed_lesson_retirement_previews(confirmation_key) on delete restrict,
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  run_id uuid not null references internal.jiaowubao_completed_lesson_member_runs(id) on delete restrict,
  blocked_audit_id uuid not null references internal.operational_contract_audit(id) on delete restrict,
  retirement_audit_id uuid not null references internal.operational_contract_audit(id) on delete restrict,
  committed_by text not null check (committed_by in ('Nixon', 'Ops Admin')),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  committed_at timestamptz not null default clock_timestamp()
);
alter table internal.jiaowubao_completed_lesson_retirement_receipts enable row level security;
revoke all on table internal.jiaowubao_completed_lesson_retirement_receipts
  from public, anon, authenticated, service_role;

drop trigger if exists guard_jiaowubao_completed_lesson_retirement_previews
  on internal.jiaowubao_completed_lesson_retirement_previews;
create trigger guard_jiaowubao_completed_lesson_retirement_previews
before update or delete on internal.jiaowubao_completed_lesson_retirement_previews
for each row execute function internal.guard_jiaowubao_completed_lesson_member_immutable();
drop trigger if exists guard_jiaowubao_completed_lesson_retirement_receipts
  on internal.jiaowubao_completed_lesson_retirement_receipts;
create trigger guard_jiaowubao_completed_lesson_retirement_receipts
before update or delete on internal.jiaowubao_completed_lesson_retirement_receipts
for each row execute function internal.guard_jiaowubao_completed_lesson_member_immutable();

-- Callers lock the run and current pointer before invoking this helper.  The
-- returned object contains only fixed identities, hashes, counters and audit
-- metadata; it contains no member IDs, lesson rows or source payloads.
create or replace function internal.jiaowubao_completed_lesson_retirement_evidence(p_run_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $retirement_evidence$
declare
  saved internal.jiaowubao_completed_lesson_member_runs%rowtype;
  begin_audit internal.operational_contract_audit%rowtype;
  blocked_audit internal.operational_contract_audit%rowtype;
  pointer internal.jiaowubao_completed_lesson_snapshot_current%rowtype;
  pointer_found boolean := false;
  target_count integer;
  complete_target_count integer;
begin
  perform internal.jiaowubao_completed_lesson_retirement_management_session();
  select * into saved
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.id = p_run_id;
  if not found or saved.state <> 'blocked' or saved.abort_reason <> 'caller_failure'
     or saved.abort_audit_id is null or saved.aborted_at is null
     or saved.ready_at is not null or saved.published_at is not null
     or saved.final_revision is not null then
    raise exception using errcode = '55000',
      message = 'jiaowubao_completed_lesson_retirement_target_invalid';
  end if;

  select * into begin_audit
  from internal.operational_contract_audit audit_row
  where audit_row.id = saved.begin_audit_id;
  if not found
     or begin_audit.action <> 'jiaowubao_completed_lesson_member_collection.started'
     or begin_audit.actor <> saved.started_by
     or begin_audit.target_type <> 'jiaowubao_completed_lesson_member_run'
     or begin_audit.target_id <> saved.id::text
     or begin_audit.metadata <> jsonb_build_object(
       'month', to_char(saved.period_month, 'YYYY-MM'),
       'memberCount', saved.member_count,
       'memberSetSha256', saved.member_set_sha256,
       'scheduleMemberCount', saved.schedule_member_count,
       'scheduleMemberSetSha256', saved.schedule_member_set_sha256,
       'scheduleRevision', saved.schedule_revision,
       'catalogMemberCount', saved.catalog_member_count,
       'catalogRevisionSha256', saved.catalog_revision_sha256
     ) then
    raise exception using errcode = '55000',
      message = 'jiaowubao_completed_lesson_retirement_begin_audit_invalid';
  end if;

  select * into blocked_audit
  from internal.operational_contract_audit audit_row
  where audit_row.id = saved.abort_audit_id;
  if not found
     or blocked_audit.action <> 'jiaowubao_completed_lesson_member_collection.blocked'
     or blocked_audit.actor <> 'Ops Admin'
     or blocked_audit.target_type <> 'jiaowubao_completed_lesson_member_run'
     or blocked_audit.target_id <> saved.id::text
     or blocked_audit.metadata <> jsonb_build_object(
       'month', to_char(saved.period_month, 'YYYY-MM'),
       'reason', 'caller_failure',
       'completedMemberCount', saved.completed_member_count,
       'memberCount', saved.member_count,
       'rowCount', saved.row_count
     ) then
    raise exception using errcode = '55000',
      message = 'jiaowubao_completed_lesson_retirement_block_audit_invalid';
  end if;

  select count(*)::integer,
         count(*) filter (where target.complete)::integer
    into target_count, complete_target_count
  from internal.jiaowubao_completed_lesson_member_targets target
  where target.run_id = saved.id;
  if target_count <> saved.member_count
     or complete_target_count <> saved.completed_member_count then
    raise exception using errcode = '55000',
      message = 'jiaowubao_completed_lesson_retirement_counters_invalid';
  end if;

  select * into pointer
  from internal.jiaowubao_completed_lesson_snapshot_current current_pointer
  where current_pointer.api_source_key = 'jwb-open-api-completed-lessons'
    and current_pointer.period_month = saved.period_month;
  pointer_found := found;
  if (saved.expected_current_revision is null and pointer_found)
     or (saved.expected_current_revision is not null and not pointer_found)
     or (pointer_found and pointer.revision is distinct from saved.expected_current_revision) then
    raise exception using errcode = '55000',
      message = 'jiaowubao_completed_lesson_retirement_pointer_changed';
  end if;

  return jsonb_build_object(
    'format', 'jiaowubao-completed-lesson-retirement/v1',
    'month', to_char(saved.period_month, 'YYYY-MM'),
    'runId', saved.id,
    'state', saved.state,
    'abortReason', saved.abort_reason,
    'scheduleRevision', saved.schedule_revision,
    'scheduleMemberSetSha256', saved.schedule_member_set_sha256,
    'scheduleMemberCount', saved.schedule_member_count,
    'catalogRevisionSha256', saved.catalog_revision_sha256,
    'catalogMemberCount', saved.catalog_member_count,
    'memberSetSha256', saved.member_set_sha256,
    'memberCount', saved.member_count,
    'completedMemberCount', saved.completed_member_count,
    'rowCount', saved.row_count,
    'expectedCurrentRevision', saved.expected_current_revision,
    'startedBy', saved.started_by,
    'startedAtEpochMicros', floor(extract(epoch from saved.started_at) * 1000000)::bigint,
    'beginAuditId', saved.begin_audit_id,
    'beginAuditCreatedAtEpochMicros', floor(extract(epoch from begin_audit.created_at) * 1000000)::bigint,
    'blockedAtEpochMicros', floor(extract(epoch from saved.aborted_at) * 1000000)::bigint,
    'blockedAuditId', saved.abort_audit_id,
    'blockedAuditCreatedAtEpochMicros', floor(extract(epoch from blocked_audit.created_at) * 1000000)::bigint,
    'currentPointer', case when pointer_found then jsonb_build_object(
      'apiSourceKey', pointer.api_source_key,
      'month', to_char(pointer.period_month, 'YYYY-MM'),
      'runId', pointer.run_id,
      'revision', pointer.revision,
      'rowCount', pointer.row_count,
      'scheduleRowCount', pointer.schedule_row_count,
      'rowsSha256', pointer.rows_sha256,
      'payloadSha256', pointer.payload_sha256,
      'publishedAtEpochMicros', floor(extract(epoch from pointer.published_at) * 1000000)::bigint,
      'auditId', pointer.audit_id
    ) else null end
  );
end;
$retirement_evidence$;

revoke all on function internal.jiaowubao_completed_lesson_retirement_evidence(uuid)
  from public, anon, authenticated, service_role;

create or replace function internal.jiaowubao_completed_lesson_retirement_management_preview(
  p_month text,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '15s'
as $retirement_preview$
declare
  month_value date;
  candidate_id uuid;
  saved internal.jiaowubao_completed_lesson_member_runs%rowtype;
  latest_id uuid;
  lease internal.jiaowubao_completed_lesson_sync_leases%rowtype;
  now_at timestamptz;
  evidence jsonb;
  evidence_sha text;
  confirmation_key_value text;
  prior internal.jiaowubao_completed_lesson_retirement_previews%rowtype;
begin
  perform internal.jiaowubao_completed_lesson_retirement_management_session();
  if coalesce(p_month, '') !~ '^\d{4}-\d{2}$'
     or p_actor is null or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023',
      message = 'jiaowubao_completed_lesson_retirement_request_invalid';
  end if;
  month_value := to_date(p_month || '-01', 'YYYY-MM-DD');
  if to_char(month_value, 'YYYY-MM') is distinct from p_month
     or month_value >= date_trunc('month', timezone('Australia/Melbourne', clock_timestamp()))::date then
    raise exception using errcode = '22023',
      message = 'jiaowubao_completed_lesson_retirement_month_invalid';
  end if;

  -- Unlocked identity discovery precedes the global lock order.
  select run_row.id into candidate_id
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.period_month = month_value
  order by run_row.started_at desc, run_row.id desc
  limit 1;
  if candidate_id is null then
    raise exception using errcode = 'P0002',
      message = 'jiaowubao_completed_lesson_retirement_target_missing';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'jiaowubao-completed-lesson-members:' || month_value::text, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'jiaowubao-completed-lessons:' || month_value::text, 0
  ));
  select * into saved
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.id = candidate_id
  for update;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'jiaowubao-completed-lessons-sync:' || month_value::text, 0
  ));
  select * into lease
  from internal.jiaowubao_completed_lesson_sync_leases lease_row
  where lease_row.period_month = month_value
  for update;
  now_at := clock_timestamp();
  if found and lease.lease_expires_at > now_at then
    raise exception using errcode = '55000',
      message = 'jiaowubao_completed_lesson_retirement_worker_active';
  end if;

  select run_row.id into latest_id
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.period_month = month_value
  order by run_row.started_at desc, run_row.id desc
  limit 1;
  if latest_id is distinct from candidate_id then
    raise exception using errcode = '40001',
      message = 'jiaowubao_completed_lesson_retirement_target_changed';
  end if;
  perform 1
  from internal.jiaowubao_completed_lesson_snapshot_current current_pointer
  where current_pointer.api_source_key = 'jwb-open-api-completed-lessons'
    and current_pointer.period_month = month_value
  for update;

  evidence := internal.jiaowubao_completed_lesson_retirement_evidence(candidate_id);
  evidence_sha := 'sha256:' || encode(extensions.digest(evidence::text, 'sha256'), 'hex');
  confirmation_key_value := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'actor', p_actor,
    'evidenceSha256', evidence_sha,
    'operation', 'retire-for-fresh-rebuild'
  )::text, 'sha256'), 'hex');

  insert into internal.jiaowubao_completed_lesson_retirement_previews(
    confirmation_key, period_month, run_id, blocked_audit_id, blocked_at,
    evidence_sha256, member_count, completed_member_count, row_count, prepared_by
  ) values (
    confirmation_key_value, month_value, saved.id, saved.abort_audit_id, saved.aborted_at,
    evidence_sha, saved.member_count, saved.completed_member_count, saved.row_count, p_actor
  ) on conflict on constraint jiaowubao_completed_lesson_retirement_previews_pkey
    do nothing;
  select * into prior
  from internal.jiaowubao_completed_lesson_retirement_previews preview
  where preview.confirmation_key = confirmation_key_value
  for update;
  if prior.period_month is distinct from month_value
     or prior.run_id is distinct from saved.id
     or prior.blocked_audit_id is distinct from saved.abort_audit_id
     or prior.blocked_at is distinct from saved.aborted_at
     or prior.evidence_sha256 is distinct from evidence_sha
     or prior.prepared_by is distinct from p_actor then
    raise exception using errcode = '23505',
      message = 'jiaowubao_completed_lesson_retirement_preview_conflict';
  end if;

  return jsonb_build_object(
    'phase', 'preview', 'month', p_month,
    'confirmationKey', confirmation_key_value,
    'memberCount', saved.member_count,
    'completedMemberCount', saved.completed_member_count,
    'rowCount', saved.row_count,
    'canCommit', true
  );
end;
$retirement_preview$;

revoke all on function internal.jiaowubao_completed_lesson_retirement_management_preview(text, text)
  from public, anon, authenticated, service_role;

create or replace function internal.jiaowubao_completed_lesson_retirement_management_commit(
  p_month text,
  p_confirmation_key text,
  p_command_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '15s'
as $retirement_commit$
declare
  month_value date;
  preview_probe internal.jiaowubao_completed_lesson_retirement_previews%rowtype;
  preview internal.jiaowubao_completed_lesson_retirement_previews%rowtype;
  receipt internal.jiaowubao_completed_lesson_retirement_receipts%rowtype;
  key_receipt internal.jiaowubao_completed_lesson_retirement_receipts%rowtype;
  saved internal.jiaowubao_completed_lesson_member_runs%rowtype;
  latest_id uuid;
  lease internal.jiaowubao_completed_lesson_sync_leases%rowtype;
  now_at timestamptz;
  evidence jsonb;
  evidence_sha text;
  expected_key text;
  retirement_audit_id uuid;
  changed_id uuid;
  result_value jsonb;
begin
  perform internal.jiaowubao_completed_lesson_retirement_management_session();
  if coalesce(p_month, '') !~ '^\d{4}-\d{2}$'
     or coalesce(p_confirmation_key, '') !~ '^sha256:[a-f0-9]{64}$'
     or p_command_id is null
     or p_actor is null or p_actor not in ('Nixon', 'Ops Admin') then
    raise exception using errcode = '22023',
      message = 'jiaowubao_completed_lesson_retirement_request_invalid';
  end if;
  month_value := to_date(p_month || '-01', 'YYYY-MM-DD');
  if to_char(month_value, 'YYYY-MM') is distinct from p_month
     or month_value >= date_trunc('month', timezone('Australia/Melbourne', clock_timestamp()))::date then
    raise exception using errcode = '22023',
      message = 'jiaowubao_completed_lesson_retirement_month_invalid';
  end if;

  -- Unlocked preview discovery obtains the immutable target identity only.
  select * into preview_probe
  from internal.jiaowubao_completed_lesson_retirement_previews preview_row
  where preview_row.confirmation_key = p_confirmation_key;
  if not found or preview_probe.period_month is distinct from month_value then
    raise exception using errcode = '23503',
      message = 'jiaowubao_completed_lesson_retirement_preview_unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'jiaowubao-completed-lesson-members:' || month_value::text, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'jiaowubao-completed-lessons:' || month_value::text, 0
  ));

  -- Command receipt locks precede the run lock.  A replay is valid only for
  -- the exact command/key/month/actor and the already-retired generation.
  select * into receipt
  from internal.jiaowubao_completed_lesson_retirement_receipts receipt_row
  where receipt_row.command_id = p_command_id
  for update;
  if found then
    if receipt.confirmation_key is distinct from p_confirmation_key
       or receipt.period_month is distinct from month_value
       or receipt.committed_by is distinct from p_actor then
      raise exception using errcode = '23505',
        message = 'jiaowubao_completed_lesson_retirement_command_conflict';
    end if;
    select * into saved
    from internal.jiaowubao_completed_lesson_member_runs run_row
    where run_row.id = receipt.run_id
    for update;
    if not found or saved.state <> 'aborted' or saved.abort_reason <> 'schedule_changed'
       or saved.abort_audit_id is distinct from receipt.retirement_audit_id
       or receipt.blocked_audit_id is null then
      raise exception using errcode = '40001',
        message = 'jiaowubao_completed_lesson_retirement_replay_conflict';
    end if;
    return receipt.result || jsonb_build_object('replayed', true);
  end if;

  select * into key_receipt
  from internal.jiaowubao_completed_lesson_retirement_receipts receipt_row
  where receipt_row.confirmation_key = p_confirmation_key
  for update;
  if found then
    raise exception using errcode = '23505',
      message = 'jiaowubao_completed_lesson_retirement_command_conflict';
  end if;
  select * into preview
  from internal.jiaowubao_completed_lesson_retirement_previews preview_row
  where preview_row.confirmation_key = p_confirmation_key
  for update;
  if not found or preview.period_month is distinct from month_value
     or preview.prepared_by is distinct from p_actor then
    raise exception using errcode = '23503',
      message = 'jiaowubao_completed_lesson_retirement_preview_unavailable';
  end if;
  select * into saved
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.id = preview.run_id
  for update;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'jiaowubao-completed-lessons-sync:' || month_value::text, 0
  ));
  select * into lease
  from internal.jiaowubao_completed_lesson_sync_leases lease_row
  where lease_row.period_month = month_value
  for update;
  now_at := clock_timestamp();
  if found and lease.lease_expires_at > now_at then
    raise exception using errcode = '55000',
      message = 'jiaowubao_completed_lesson_retirement_worker_active';
  end if;

  select run_row.id into latest_id
  from internal.jiaowubao_completed_lesson_member_runs run_row
  where run_row.period_month = month_value
  order by run_row.started_at desc, run_row.id desc
  limit 1;
  if latest_id is distinct from saved.id then
    raise exception using errcode = '40001',
      message = 'jiaowubao_completed_lesson_retirement_target_changed';
  end if;
  perform 1
  from internal.jiaowubao_completed_lesson_snapshot_current current_pointer
  where current_pointer.api_source_key = 'jwb-open-api-completed-lessons'
    and current_pointer.period_month = month_value
  for update;

  evidence := internal.jiaowubao_completed_lesson_retirement_evidence(saved.id);
  evidence_sha := 'sha256:' || encode(extensions.digest(evidence::text, 'sha256'), 'hex');
  expected_key := 'sha256:' || encode(extensions.digest(jsonb_build_object(
    'actor', p_actor,
    'evidenceSha256', evidence_sha,
    'operation', 'retire-for-fresh-rebuild'
  )::text, 'sha256'), 'hex');
  if expected_key is distinct from p_confirmation_key
     or preview.evidence_sha256 is distinct from evidence_sha
     or preview.blocked_audit_id is distinct from saved.abort_audit_id
     or preview.blocked_at is distinct from saved.aborted_at
     or preview.member_count is distinct from saved.member_count
     or preview.completed_member_count is distinct from saved.completed_member_count
     or preview.row_count is distinct from saved.row_count then
    raise exception using errcode = '40001',
      message = 'jiaowubao_completed_lesson_retirement_evidence_changed';
  end if;

  retirement_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_completed_lesson_member_collection.retired_for_rebuild', p_actor,
    'jiaowubao_completed_lesson_member_run', saved.id::text,
    jsonb_build_object(
      'month', p_month,
      'previousReason', 'caller_failure',
      'reason', 'schedule_changed',
      'confirmationKey', p_confirmation_key,
      'commandId', p_command_id,
      'blockedAuditId', saved.abort_audit_id,
      'completedMemberCount', saved.completed_member_count,
      'memberCount', saved.member_count,
      'rowCount', saved.row_count,
      'preservedEvidence', true,
      'freshRebuildRequired', true,
      'managementBridge', true
    )
  );
  update internal.jiaowubao_completed_lesson_member_runs run_row
  set state = 'aborted',
      aborted_at = clock_timestamp(),
      abort_reason = 'schedule_changed',
      abort_audit_id = retirement_audit_id
  where run_row.id = preview.run_id
    and run_row.period_month = month_value
    and run_row.state = 'blocked'
    and run_row.abort_reason = 'caller_failure'
    and run_row.abort_audit_id = preview.blocked_audit_id
    and run_row.aborted_at = preview.blocked_at
    and run_row.ready_at is null
    and run_row.published_at is null
    and run_row.final_revision is null
    and run_row.member_count = preview.member_count
    and run_row.completed_member_count = preview.completed_member_count
    and run_row.row_count = preview.row_count
  returning run_row.id into changed_id;
  if changed_id is null then
    raise exception using errcode = '40001',
      message = 'jiaowubao_completed_lesson_retirement_cas_failed';
  end if;

  result_value := jsonb_build_object(
    'phase', 'commit', 'month', p_month,
    'state', 'aborted', 'reason', 'schedule_changed',
    'memberCount', saved.member_count,
    'completedMemberCount', saved.completed_member_count,
    'rowCount', saved.row_count,
    'replayed', false
  );
  insert into internal.jiaowubao_completed_lesson_retirement_receipts(
    command_id, confirmation_key, period_month, run_id, blocked_audit_id,
    retirement_audit_id, committed_by, result
  ) values (
    p_command_id, p_confirmation_key, month_value, saved.id, saved.abort_audit_id,
    retirement_audit_id, p_actor, result_value
  );

  -- The expired lease row is only coordination state.  Removing it while the
  -- sync advisory lock is held prevents a waiter that captured an old `now`
  -- before its row lock from reporting a false active lease.
  delete from internal.jiaowubao_completed_lesson_sync_leases lease_row
  where lease_row.period_month = month_value
    and lease_row.lease_expires_at <= now_at;
  return result_value;
end;
$retirement_commit$;

revoke all on function internal.jiaowubao_completed_lesson_retirement_management_commit(text, text, uuid, text)
  from public, anon, authenticated, service_role;

alter table internal.jiaowubao_completed_lesson_retirement_previews owner to postgres;
alter table internal.jiaowubao_completed_lesson_retirement_receipts owner to postgres;
alter function internal.jiaowubao_completed_lesson_retirement_management_session() owner to postgres;
alter function internal.guard_jiaowubao_completed_lesson_blocked_successor() owner to postgres;
alter function internal.jiaowubao_completed_lesson_retirement_evidence(uuid) owner to postgres;
alter function internal.jiaowubao_completed_lesson_retirement_management_preview(text, text) owner to postgres;
alter function internal.jiaowubao_completed_lesson_retirement_management_commit(text, text, uuid, text) owner to postgres;

comment on table internal.jiaowubao_completed_lesson_member_runs is
  'Private resumable query_lesson_list(over=1) collection state. Browser, bearer and manual force cannot recover a blocked caller_failure or create its successor. Only an exact postgres-owner retirement to aborted/schedule_changed permits the ordinary non-force cron to start a fresh full rebuild; no blocked run changes ops_state or a published month pointer.';
comment on function internal.jiaowubao_completed_lesson_retirement_management_preview(text, text)
  is 'Postgres Management API-only aggregate preview for retiring the exact latest caller_failure generation before a full fresh cron rebuild.';
comment on function internal.jiaowubao_completed_lesson_retirement_management_commit(text, text, uuid, text)
  is 'Postgres Management API-only exact retirement. It preserves partial evidence and does not resume or publish the blocked collection.';
