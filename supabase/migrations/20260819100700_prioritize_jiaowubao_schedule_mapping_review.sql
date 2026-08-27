-- Materialize a bounded, current/future-priority projection for the existing
-- admin-confirmed Jiaowubao schedule-label mapping ledger.
--
-- 006 intentionally snapshots every source label pair for immutable review,
-- but its opaque hash order is not an operations queue.  This migration keeps
-- that all-history reader unchanged and derives a second immutable per-UTC-day
-- relevance projection only when a completed import is materialized.  Runtime
-- priority reads touch the candidate snapshot, relevance snapshot, decisions,
-- and current teacher authority only; they never re-scan imported schedule
-- events.  No source event, AVA block, booking, task, package, settlement, or
-- classroom row is changed.

set local lock_timeout = '1s';

-- A row represents one opaque label-pair candidate's parsed source events on
-- one UTC day.  UTC is deliberate: the reviewed browser window is frozen to
-- canonical UTC midnights, so every row is wholly inside or outside the
-- requested 63-day window.  `first_starts_at` consequently remains the exact
-- next source instant without consulting the raw event relation.
create table if not exists internal.jiaowubao_direct_schedule_mapping_candidate_relevance_days (
  run_id uuid not null references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  mapping_key text not null check (mapping_key ~ '^sha256:[a-f0-9]{64}$'),
  source_revision text not null check (
    source_revision = btrim(source_revision) and char_length(source_revision) between 1 and 240
  ),
  occurrence_day date not null,
  first_starts_at timestamptz not null,
  event_count integer not null check (event_count between 1 and 200000),
  primary key (run_id, mapping_key, occurrence_day),
  foreign key (run_id, mapping_key)
    references internal.jiaowubao_direct_schedule_mapping_candidate_snapshots(run_id, mapping_key)
    on delete restrict,
  check ((first_starts_at at time zone 'UTC')::date = occurrence_day)
);

create index if not exists jiaowubao_direct_schedule_mapping_relevance_window_idx
  on internal.jiaowubao_direct_schedule_mapping_candidate_relevance_days (
    run_id, occurrence_day, first_starts_at, mapping_key
  );

-- Inserted last with its immutable rows.  The manifest binds the relevance
-- snapshot to the completed import authority and to the exact 006 candidate
-- snapshot digest, so a reader fails closed on a missing or mismatched build.
create table if not exists internal.jiaowubao_direct_schedule_mapping_relevance_manifests (
  run_id uuid primary key references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  source_revision text not null check (
    source_revision = btrim(source_revision) and char_length(source_revision) between 1 and 240
  ),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  completion_audit_id uuid not null
    references internal.operational_contract_audit(id) on delete restrict,
  candidate_set_sha256 text not null check (candidate_set_sha256 ~ '^[a-f0-9]{64}$'),
  relevance_day_count integer not null check (relevance_day_count between 0 and 2000000),
  parsed_event_count integer not null check (parsed_event_count between 0 and 200000),
  relevance_set_sha256 text not null check (relevance_set_sha256 ~ '^[a-f0-9]{64}$'),
  materialized_at timestamptz not null default clock_timestamp(),
  check (
    (relevance_day_count = 0 and parsed_event_count = 0)
    or (relevance_day_count > 0 and parsed_event_count >= relevance_day_count)
  )
);

alter table internal.jiaowubao_direct_schedule_mapping_candidate_relevance_days enable row level security;
alter table internal.jiaowubao_direct_schedule_mapping_relevance_manifests enable row level security;
revoke all on table internal.jiaowubao_direct_schedule_mapping_candidate_relevance_days
  from public, anon, authenticated;
revoke all on table internal.jiaowubao_direct_schedule_mapping_relevance_manifests
  from public, anon, authenticated;

-- A distinct transaction-local capability prevents even a privileged internal
-- statement from accidentally creating a reader-visible partial relevance
-- snapshot.  Both the day rows and their manifest are append-only.
create or replace function internal.jiaowubao_direct_schedule_mapping_relevance_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_relevance_guard$
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_append_only';
  end if;
  if current_setting('internal.jiaowubao_direct_schedule_mapping_relevance_run_id', true)
       is distinct from new.run_id::text then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_write_forbidden';
  end if;
  return new;
end;
$jiaowubao_direct_schedule_mapping_relevance_guard$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_relevance_guard()
  from public, anon, authenticated;

create trigger jiaowubao_direct_schedule_mapping_relevance_day_guard
before insert or update or delete on internal.jiaowubao_direct_schedule_mapping_candidate_relevance_days
for each row execute function internal.jiaowubao_direct_schedule_mapping_relevance_guard();

create trigger jiaowubao_direct_schedule_mapping_relevance_manifest_guard
before insert or update or delete on internal.jiaowubao_direct_schedule_mapping_relevance_manifests
for each row execute function internal.jiaowubao_direct_schedule_mapping_relevance_guard();

-- This is the only relevance function allowed to touch raw imported schedule
-- evidence.  It joins a parsed event back to the already-manifested candidate
-- key, groups it by UTC day, and deliberately exposes no source identifiers,
-- workbook coordinates, student data, raw payload, or labels.
create or replace function internal.jiaowubao_direct_schedule_mapping_relevance_source(
  p_run_id uuid
)
returns table (
  mapping_key text,
  source_revision text,
  occurrence_day date,
  first_starts_at timestamptz,
  event_count integer
)
language sql
stable
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_relevance_source$
  with snapshot_manifest as materialized (
    select *
    from internal.jiaowubao_direct_schedule_mapping_snapshot_manifest(p_run_id)
  ), source_rows as materialized (
    select
      schedule_event.run_id,
      schedule_event.starts_at,
      internal.jiaowubao_direct_schedule_mapping_label_key(schedule_event.teacher_display_name) as teacher_label_key,
      internal.jiaowubao_direct_schedule_mapping_label_key(schedule_event.course_name) as course_label_key
    from snapshot_manifest manifest
    join internal.jiaowubao_direct_schedule_events schedule_event
      on schedule_event.run_id = manifest.run_id
    where schedule_event.time_parse_status = 'parsed'
      and schedule_event.starts_at is not null
  ), matched as materialized (
    select
      snapshot.mapping_key,
      snapshot.source_revision,
      (source_row.starts_at at time zone 'UTC')::date as occurrence_day,
      source_row.starts_at
    from snapshot_manifest manifest
    join internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
      on snapshot.run_id = manifest.run_id
     and snapshot.source_revision = manifest.source_revision
    join source_rows source_row
      on source_row.run_id = snapshot.run_id
     and source_row.teacher_label_key = snapshot.teacher_label_key
     and source_row.course_label_key = snapshot.course_label_key
  )
  select
    matched.mapping_key,
    matched.source_revision,
    matched.occurrence_day,
    min(matched.starts_at) as first_starts_at,
    count(*)::integer as event_count
  from matched
  group by matched.mapping_key, matched.source_revision, matched.occurrence_day
$jiaowubao_direct_schedule_mapping_relevance_source$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_relevance_source(uuid)
  from public, anon, authenticated;

-- Full compact-set digest used at materialization/reconciliation time only.
-- Ordinary priority reads validate only the manifest header so pagination stays
-- bounded even for a historical source run with many relevance days.
create or replace function internal.jiaowubao_direct_schedule_mapping_relevance_digest(
  p_run_id uuid,
  p_source_revision text
)
returns table (
  relevance_day_count integer,
  parsed_event_count integer,
  relevance_set_sha256 text
)
language sql
stable
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_relevance_digest$
  select
    count(*)::integer as relevance_day_count,
    coalesce(sum(relevance.event_count), 0)::integer as parsed_event_count,
    encode(extensions.digest(convert_to(
      'jiaowubao-direct-schedule-mapping-relevance-v1' || chr(31)
        || p_run_id::text || chr(31)
        || p_source_revision || chr(31)
        || count(*)::text || chr(31)
        || coalesce(sum(relevance.event_count), 0)::text || chr(31)
        || coalesce(jsonb_agg(jsonb_build_array(
          relevance.mapping_key,
          relevance.source_revision,
          relevance.occurrence_day::text,
          to_char(relevance.first_starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          relevance.event_count
        ) order by relevance.mapping_key, relevance.occurrence_day)::text, '[]'),
      'UTF8'
    ), 'sha256'), 'hex') as relevance_set_sha256
  from internal.jiaowubao_direct_schedule_mapping_candidate_relevance_days relevance
  where relevance.run_id = p_run_id
    and relevance.source_revision = p_source_revision
$jiaowubao_direct_schedule_mapping_relevance_digest$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_relevance_digest(uuid, text)
  from public, anon, authenticated;

-- Header-only validation for the server reader.  It explicitly binds this
-- snapshot to the existing candidate manifest instead of trusting a run ID
-- alone; a partial day-row insert has no manifest and is never reviewable.
create or replace function internal.jiaowubao_direct_schedule_mapping_relevance_manifest(
  p_run_id uuid
)
returns table (
  run_id uuid,
  source_revision text,
  payload_sha256 text,
  completion_audit_id uuid,
  candidate_set_sha256 text,
  relevance_day_count integer,
  parsed_event_count integer,
  relevance_set_sha256 text
)
language plpgsql
stable
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_relevance_manifest$
declare
  saved_snapshot_manifest record;
  saved_manifest internal.jiaowubao_direct_schedule_mapping_relevance_manifests%rowtype;
begin
  select * into saved_snapshot_manifest
  from internal.jiaowubao_direct_schedule_mapping_snapshot_manifest(p_run_id);
  if not found then
    return;
  end if;

  select * into saved_manifest
  from internal.jiaowubao_direct_schedule_mapping_relevance_manifests manifest_row
  where manifest_row.run_id = saved_snapshot_manifest.run_id;
  if not found then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_unavailable';
  end if;
  if saved_manifest.source_revision <> saved_snapshot_manifest.source_revision
     or saved_manifest.payload_sha256 is distinct from saved_snapshot_manifest.payload_sha256
     or saved_manifest.completion_audit_id is distinct from saved_snapshot_manifest.completion_audit_id
     or saved_manifest.candidate_set_sha256 <> saved_snapshot_manifest.candidate_set_sha256 then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_invalid';
  end if;

  run_id := saved_snapshot_manifest.run_id;
  source_revision := saved_manifest.source_revision;
  payload_sha256 := saved_manifest.payload_sha256;
  completion_audit_id := saved_manifest.completion_audit_id;
  candidate_set_sha256 := saved_manifest.candidate_set_sha256;
  relevance_day_count := saved_manifest.relevance_day_count;
  parsed_event_count := saved_manifest.parsed_event_count;
  relevance_set_sha256 := saved_manifest.relevance_set_sha256;
  return next;
end;
$jiaowubao_direct_schedule_mapping_relevance_manifest$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_relevance_manifest(uuid)
  from public, anon, authenticated;

create or replace function internal.assert_jiaowubao_direct_schedule_mapping_relevance_integrity(
  p_run_id uuid
)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $assert_jiaowubao_direct_schedule_mapping_relevance_integrity$
declare
  saved_manifest record;
  saved_snapshot_manifest record;
  actual_digest record;
begin
  select * into saved_manifest
  from internal.jiaowubao_direct_schedule_mapping_relevance_manifest(p_run_id);
  if not found then
    return;
  end if;

  select * into saved_snapshot_manifest
  from internal.jiaowubao_direct_schedule_mapping_snapshot_manifest(saved_manifest.run_id);
  select * into actual_digest
  from internal.jiaowubao_direct_schedule_mapping_relevance_digest(
    saved_manifest.run_id, saved_manifest.source_revision
  );
  if actual_digest.relevance_day_count <> saved_manifest.relevance_day_count
     or actual_digest.parsed_event_count <> saved_manifest.parsed_event_count
     or actual_digest.relevance_set_sha256 <> saved_manifest.relevance_set_sha256
     or actual_digest.parsed_event_count > saved_snapshot_manifest.eligible_event_count then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_invalid';
  end if;
end;
$assert_jiaowubao_direct_schedule_mapping_relevance_integrity$;

revoke all on function internal.assert_jiaowubao_direct_schedule_mapping_relevance_integrity(uuid)
  from public, anon, authenticated;

-- Idempotent per-run materialization.  A retry verifies an existing complete
-- snapshot; it never overwrites it.  An orphaned set of day rows fails closed
-- rather than being silently completed from a potentially different source.
create or replace function internal.materialize_jiaowubao_direct_schedule_mapping_relevance(
  p_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $materialize_jiaowubao_direct_schedule_mapping_relevance$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  saved_snapshot_manifest record;
  saved_manifest internal.jiaowubao_direct_schedule_mapping_relevance_manifests%rowtype;
  actual_digest record;
begin
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for key share;
  if not found or saved_run.state <> 'complete'
     or saved_run.payload_sha256 is null
     or saved_run.completion_audit_id is null then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_run_unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao_direct_schedule_mapping_relevance:' || saved_run.id::text, 0)
  );

  select * into saved_snapshot_manifest
  from internal.jiaowubao_direct_schedule_mapping_snapshot_manifest(saved_run.id);
  if not found then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_snapshot_unavailable';
  end if;

  select * into saved_manifest
  from internal.jiaowubao_direct_schedule_mapping_relevance_manifests manifest_row
  where manifest_row.run_id = saved_run.id
  for key share;
  if found then
    perform internal.assert_jiaowubao_direct_schedule_mapping_relevance_integrity(saved_run.id);
    return;
  end if;

  if exists (
    select 1
    from internal.jiaowubao_direct_schedule_mapping_candidate_relevance_days relevance
    where relevance.run_id = saved_run.id
  ) then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_incomplete';
  end if;

  perform set_config(
    'internal.jiaowubao_direct_schedule_mapping_relevance_run_id', saved_run.id::text, true
  );
  insert into internal.jiaowubao_direct_schedule_mapping_candidate_relevance_days (
    run_id, mapping_key, source_revision, occurrence_day, first_starts_at, event_count
  )
  select
    saved_run.id,
    source_relevance.mapping_key,
    source_relevance.source_revision,
    source_relevance.occurrence_day,
    source_relevance.first_starts_at,
    source_relevance.event_count
  from internal.jiaowubao_direct_schedule_mapping_relevance_source(saved_run.id) source_relevance;

  select * into actual_digest
  from internal.jiaowubao_direct_schedule_mapping_relevance_digest(saved_run.id, saved_run.revision);
  if actual_digest.parsed_event_count > saved_snapshot_manifest.eligible_event_count then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_count_invalid';
  end if;

  insert into internal.jiaowubao_direct_schedule_mapping_relevance_manifests (
    run_id, source_revision, payload_sha256, completion_audit_id, candidate_set_sha256,
    relevance_day_count, parsed_event_count, relevance_set_sha256
  ) values (
    saved_run.id, saved_run.revision, saved_run.payload_sha256, saved_run.completion_audit_id,
    saved_snapshot_manifest.candidate_set_sha256,
    actual_digest.relevance_day_count, actual_digest.parsed_event_count, actual_digest.relevance_set_sha256
  );

  perform internal.assert_jiaowubao_direct_schedule_mapping_relevance_integrity(saved_run.id);
end;
$materialize_jiaowubao_direct_schedule_mapping_relevance$;

revoke all on function internal.materialize_jiaowubao_direct_schedule_mapping_relevance(uuid)
  from public, anon, authenticated;

-- 006's trigger resolves this function by name at execution time.  Replacing
-- the materializer here makes every future staging -> complete transition
-- publish candidates and relevance in one transaction, without changing the
-- existing trigger or any raw-source lifecycle.
create or replace function internal.materialize_jiaowubao_direct_schedule_mapping_snapshot(
  p_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $materialize_jiaowubao_direct_schedule_mapping_snapshot$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  saved_manifest internal.jiaowubao_direct_schedule_mapping_snapshot_manifests%rowtype;
  actual_digest record;
begin
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
  for key share;
  if not found or saved_run.state <> 'complete'
     or saved_run.payload_sha256 is null
     or saved_run.completion_audit_id is null then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_snapshot_run_unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao_direct_schedule_mapping_snapshot:' || saved_run.id::text, 0)
  );

  select * into saved_manifest
  from internal.jiaowubao_direct_schedule_mapping_snapshot_manifests manifest_row
  where manifest_row.run_id = saved_run.id
  for key share;
  if found then
    perform internal.assert_jiaowubao_direct_schedule_mapping_snapshot_integrity(saved_run.id);
    perform internal.materialize_jiaowubao_direct_schedule_mapping_relevance(saved_run.id);
    return;
  end if;

  if exists (
    select 1
    from internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
    where snapshot.run_id = saved_run.id
  ) then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_snapshot_incomplete';
  end if;

  perform set_config(
    'internal.jiaowubao_direct_schedule_mapping_snapshot_run_id', saved_run.id::text, true
  );
  insert into internal.jiaowubao_direct_schedule_mapping_candidate_snapshots (
    run_id, mapping_key, source_revision, source_evidence_sha256,
    teacher_label_key, course_label_key, teacher_label, course_label, source_event_count
  )
  select
    saved_run.id,
    source_candidate.mapping_key,
    source_candidate.source_revision,
    source_candidate.source_evidence_sha256,
    source_candidate.teacher_label_key,
    source_candidate.course_label_key,
    source_candidate.teacher_label,
    source_candidate.course_label,
    source_candidate.event_count
  from internal.jiaowubao_direct_schedule_mapping_snapshot_source(saved_run.id) source_candidate;

  select * into actual_digest
  from internal.jiaowubao_direct_schedule_mapping_snapshot_digest(saved_run.id, saved_run.revision);
  if actual_digest.eligible_event_count > (saved_run.expected_counts ->> 'scheduleEvents')::integer then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_snapshot_count_invalid';
  end if;

  insert into internal.jiaowubao_direct_schedule_mapping_snapshot_manifests (
    run_id, source_revision, payload_sha256, completion_audit_id,
    candidate_count, eligible_event_count, candidate_set_sha256
  ) values (
    saved_run.id, saved_run.revision, saved_run.payload_sha256, saved_run.completion_audit_id,
    actual_digest.candidate_count, actual_digest.eligible_event_count, actual_digest.candidate_set_sha256
  );

  perform internal.assert_jiaowubao_direct_schedule_mapping_snapshot_integrity(saved_run.id);
  perform internal.materialize_jiaowubao_direct_schedule_mapping_relevance(saved_run.id);
end;
$materialize_jiaowubao_direct_schedule_mapping_snapshot$;

revoke all on function internal.materialize_jiaowubao_direct_schedule_mapping_snapshot(uuid)
  from public, anon, authenticated;

-- Close the deployment race before backfilling.  A brief EXCLUSIVE lock blocks
-- a concurrent completion while this new materializer and its latest-run
-- relevance snapshot become visible together.  We backfill the only run the
-- priority reader can select; older runs remain safely available to the 006
-- all-history reader and can be materialized later by the same idempotent
-- function without rewriting their source evidence.
lock table internal.jiaowubao_direct_import_runs in exclusive mode;

do $jiaowubao_direct_schedule_mapping_relevance_backfill$
declare
  latest_completed_run_id uuid;
begin
  select run_state.id into latest_completed_run_id
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.state = 'complete'
  order by run_state.completed_at desc, run_state.id desc
  limit 1;

  if latest_completed_run_id is not null then
    perform internal.materialize_jiaowubao_direct_schedule_mapping_snapshot(latest_completed_run_id);
    perform internal.assert_jiaowubao_direct_schedule_mapping_relevance_integrity(latest_completed_run_id);
  end if;
end;
$jiaowubao_direct_schedule_mapping_relevance_backfill$;

-- Secret-gated priority reader.  Its default set is intentionally limited to
-- mapping states requiring a person: unmapped and authority_changed.  Revoked
-- mappings are counted for transparency but excluded, so an explicit revoke
-- cannot re-enter the action queue as an accidental automatic suggestion.
create or replace function public.get_jiaowubao_direct_schedule_mapping_priority_review(
  p_secret text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_limit integer default 80,
  p_after_mapping_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $get_jiaowubao_direct_schedule_mapping_priority_review$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  saved_relevance_manifest record;
  teachers_state public.ops_state%rowtype;
  teacher_count integer;
  distinct_teacher_count integer;
  latest_decision_count integer := 0;
  classified_decision_count integer := 0;
  total_count integer := 0;
  unmapped_count integer := 0;
  authority_changed_count integer := 0;
  revoked_in_window_count integer := 0;
  cursor_count integer := 0;
  candidates jsonb := '[]'::jsonb;
  teacher_catalog jsonb := '[]'::jsonb;
  has_more boolean := false;
  next_cursor text := null;
  window_start_text text;
  window_end_text text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_window_start is null or p_window_end is null
     or not isfinite(p_window_start) or not isfinite(p_window_end)
     or date_trunc('day', p_window_start at time zone 'UTC') <> p_window_start at time zone 'UTC'
     or date_trunc('day', p_window_end at time zone 'UTC') <> p_window_end at time zone 'UTC'
     or p_window_end - p_window_start <> interval '63 days'
     or p_limit is null or p_limit not between 1 and 120
     or (p_after_mapping_key is not null and p_after_mapping_key !~ '^sha256:[a-f0-9]{64}$') then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_schedule_mapping_priority_review';
  end if;

  window_start_text := to_char(p_window_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  window_end_text := to_char(p_window_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.state = 'complete'
  order by run_state.completed_at desc, run_state.id desc
  limit 1;

  if saved_run.id is null then
    return jsonb_build_object(
      'state', 'absent',
      'runToken', null,
      'teachersVersion', null,
      'teachers', '[]'::jsonb,
      'window', jsonb_build_object('startsAt', window_start_text, 'endsAt', window_end_text),
      'summary', jsonb_build_object(
        'total', 0, 'unmapped', 0, 'authorityChanged', 0, 'revokedInWindow', 0
      ),
      'candidates', '[]'::jsonb,
      'nextCursor', null
    );
  end if;

  select * into saved_relevance_manifest
  from internal.jiaowubao_direct_schedule_mapping_relevance_manifest(saved_run.id);
  if not found then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_unavailable';
  end if;

  select * into teachers_state
  from public.ops_state state_row
  where state_row.entity = 'teachers';
  if teachers_state.entity is null
     or teachers_state.version < 0
     or jsonb_typeof(teachers_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_unavailable';
  end if;

  select count(*), count(distinct catalog.teacher_id)
  into teacher_count, distinct_teacher_count
  from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(teachers_state.payload) catalog;
  if teacher_count <> distinct_teacher_count then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_teachers_state_invalid';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', catalog.teacher_id,
    'name', catalog.teacher_name,
    'subjectIds', to_jsonb(catalog.subject_ids)
  ) order by catalog.teacher_name collate "C", catalog.teacher_id), '[]'::jsonb)
  into teacher_catalog
  from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(teachers_state.payload) catalog;

  -- Preserve 005/006's fail-closed decision provenance check without touching
  -- raw events.  Every latest append-only decision must still point to the
  -- immutable candidate snapshot for this exact run/revision/evidence digest.
  with latest_decisions as materialized (
    select distinct on (decision_row.mapping_key)
      decision_row.mapping_key,
      decision_row.source_revision,
      decision_row.source_evidence_sha256
    from internal.jiaowubao_direct_schedule_label_mapping_decisions decision_row
    where decision_row.run_id = saved_run.id
    order by decision_row.mapping_key, decision_row.decision_sequence desc
  )
  select count(*)::integer, count(snapshot.mapping_key)::integer
  into latest_decision_count, classified_decision_count
  from latest_decisions decision_row
  left join internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
    on snapshot.run_id = saved_run.id
   and snapshot.source_revision = saved_relevance_manifest.source_revision
   and snapshot.mapping_key = decision_row.mapping_key
   and snapshot.source_revision = decision_row.source_revision
   and snapshot.source_evidence_sha256 = decision_row.source_evidence_sha256;
  if latest_decision_count <> classified_decision_count then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_invalid';
  end if;

  with teacher_catalog_current as materialized (
    select *
    from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(teachers_state.payload)
  ), window_relevance as materialized (
    select
      relevance.mapping_key,
      min(relevance.first_starts_at) as next_starts_at,
      sum(relevance.event_count)::integer as window_event_count
    from internal.jiaowubao_direct_schedule_mapping_candidate_relevance_days relevance
    where relevance.run_id = saved_run.id
      and relevance.source_revision = saved_relevance_manifest.source_revision
      and relevance.occurrence_day >= (p_window_start at time zone 'UTC')::date
      and relevance.occurrence_day < (p_window_end at time zone 'UTC')::date
    group by relevance.mapping_key
  ), relevance_candidates as materialized (
    select
      relevance.mapping_key,
      relevance.next_starts_at,
      relevance.window_event_count,
      snapshot.source_revision,
      snapshot.source_evidence_sha256,
      snapshot.teacher_label,
      snapshot.course_label,
      snapshot.source_event_count as event_count
    from window_relevance relevance
    join internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
      on snapshot.run_id = saved_run.id
     and snapshot.source_revision = saved_relevance_manifest.source_revision
     and snapshot.mapping_key = relevance.mapping_key
  ), latest_decisions as materialized (
    select distinct on (decision_row.mapping_key)
      decision_row.id as decision_id,
      decision_row.mapping_key,
      decision_row.source_revision,
      decision_row.source_evidence_sha256,
      decision_row.decision,
      decision_row.target_teacher_id,
      decision_row.target_subject_id,
      decision_row.decided_at,
      decision_row.target_basis_sha256
    from internal.jiaowubao_direct_schedule_label_mapping_decisions decision_row
    where decision_row.run_id = saved_run.id
    order by decision_row.mapping_key, decision_row.decision_sequence desc
  ), classified as materialized (
    select
      candidate.*,
      decision_row.decision_id,
      decision_row.decision,
      decision_row.target_teacher_id,
      decision_row.target_subject_id,
      decision_row.decided_at,
      target_catalog.teacher_name as target_teacher_name,
      case
        when decision_row.decision_id is null then 'unmapped'
        when decision_row.decision = 'revoked' then 'revoked'
        when target_catalog.teacher_id is not null
          and decision_row.target_subject_id = any(target_catalog.subject_ids)
          and decision_row.target_basis_sha256 = target_catalog.target_basis_sha256
          then 'confirmed'
        else 'authority_changed'
      end as mapping_status
    from relevance_candidates candidate
    left join latest_decisions decision_row
      on decision_row.mapping_key = candidate.mapping_key
     and decision_row.source_revision = candidate.source_revision
     and decision_row.source_evidence_sha256 = candidate.source_evidence_sha256
    left join teacher_catalog_current target_catalog
      on target_catalog.teacher_id = decision_row.target_teacher_id
  ), actionable as materialized (
    select
      classified.*,
      case when classified.mapping_status = 'authority_changed' then 0 else 1 end as priority_rank
    from classified
    where classified.mapping_status in ('unmapped', 'authority_changed')
  ), cursor_boundary as materialized (
    select *
    from actionable
    where mapping_key = p_after_mapping_key
  ), page_plus_one as materialized (
    select actionable.*
    from actionable
    left join cursor_boundary cursor_row on true
    where p_after_mapping_key is null
       or (
         actionable.priority_rank > cursor_row.priority_rank
         or (actionable.priority_rank = cursor_row.priority_rank
           and actionable.next_starts_at > cursor_row.next_starts_at)
         or (actionable.priority_rank = cursor_row.priority_rank
           and actionable.next_starts_at = cursor_row.next_starts_at
           and actionable.window_event_count < cursor_row.window_event_count)
         or (actionable.priority_rank = cursor_row.priority_rank
           and actionable.next_starts_at = cursor_row.next_starts_at
           and actionable.window_event_count = cursor_row.window_event_count
           and actionable.mapping_key > cursor_row.mapping_key)
       )
    order by actionable.priority_rank, actionable.next_starts_at, actionable.window_event_count desc, actionable.mapping_key
    limit p_limit + 1
  ), page as materialized (
    select *
    from page_plus_one
    order by priority_rank, next_starts_at, window_event_count desc, mapping_key
    limit p_limit
  )
  select
    (select count(*)::integer from actionable),
    (select count(*) filter (where mapping_status = 'unmapped')::integer from classified),
    (select count(*) filter (where mapping_status = 'authority_changed')::integer from classified),
    (select count(*) filter (where mapping_status = 'revoked')::integer from classified),
    (select count(*)::integer from cursor_boundary),
    coalesce(jsonb_agg(jsonb_build_object(
      'mappingKey', page.mapping_key,
      'teacherLabel', page.teacher_label,
      'courseLabel', page.course_label,
      'eventCount', page.event_count,
      'status', page.mapping_status,
      'targetTeacherId', page.target_teacher_id,
      'targetTeacherName', page.target_teacher_name,
      'targetSubjectId', page.target_subject_id,
      'decidedAt', case when page.decision_id is null then null
        else to_char(page.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'nextStartsAt', to_char(page.next_starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'windowEventCount', page.window_event_count
    ) order by page.priority_rank, page.next_starts_at, page.window_event_count desc, page.mapping_key), '[]'::jsonb),
    (select count(*) > p_limit from page_plus_one),
    (select mapping_key from page
      order by priority_rank desc, next_starts_at desc, window_event_count, mapping_key desc
      limit 1)
  into
    total_count,
    unmapped_count,
    authority_changed_count,
    revoked_in_window_count,
    cursor_count,
    candidates,
    has_more,
    next_cursor
  from page;

  if p_after_mapping_key is not null and cursor_count <> 1 then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_mapping_priority_cursor_invalid';
  end if;
  if total_count <> unmapped_count + authority_changed_count then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_relevance_invalid';
  end if;

  return jsonb_build_object(
    'state', 'complete',
    'runToken', saved_run.id::text,
    'teachersVersion', teachers_state.version,
    'teachers', teacher_catalog,
    'window', jsonb_build_object('startsAt', window_start_text, 'endsAt', window_end_text),
    'summary', jsonb_build_object(
      'total', total_count,
      'unmapped', unmapped_count,
      'authorityChanged', authority_changed_count,
      'revokedInWindow', revoked_in_window_count
    ),
    'candidates', candidates,
    'nextCursor', case when has_more then next_cursor else null end
  );
end;
$get_jiaowubao_direct_schedule_mapping_priority_review$;

revoke all on function public.get_jiaowubao_direct_schedule_mapping_priority_review(
  text, timestamptz, timestamptz, integer, text
) from public, anon, authenticated;
grant execute on function public.get_jiaowubao_direct_schedule_mapping_priority_review(
  text, timestamptz, timestamptz, integer, text
) to anon, authenticated;
