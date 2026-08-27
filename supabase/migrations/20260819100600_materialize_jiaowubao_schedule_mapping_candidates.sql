-- Bound Jiaowubao schedule-label mapping review to a completed-run snapshot.
--
-- 005 correctly derived an opaque pair candidate from immutable source rows,
-- but it performed that full normalization/group/hash derivation every time a
-- high-tier admin opened a page (and again in confirmation + its append-only
-- decision guard).  A completed direct-import run cannot change, so preserve
-- the exact v1 source proof once in a separate immutable review read model.
-- This remains strictly a readiness overlay: no imported event, AVA/current
-- schedule block, booking, task, settlement, or classroom record is changed.

set local lock_timeout = '1s';

-- This is the original v1 provenance calculation, retained privately for the
-- one-time per-completed-run snapshot builder.  Calculate the two normalized
-- labels once per source row before filtering/grouping; the prior reader
-- evaluated each normalizer in both SELECT and WHERE expressions on every
-- request.  The resulting evidence/mapping hashes deliberately remain byte
-- compatible with 005.
create or replace function internal.jiaowubao_direct_schedule_mapping_snapshot_source(
  p_run_id uuid
)
returns table (
  mapping_key text,
  source_revision text,
  source_evidence_sha256 text,
  teacher_label_key text,
  course_label_key text,
  teacher_label text,
  course_label text,
  event_count integer
)
language sql
stable
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_snapshot_source$
  with completed_run as materialized (
    select run_state.id, run_state.revision
    from internal.jiaowubao_direct_import_runs run_state
    where run_state.id = p_run_id
      and run_state.state = 'complete'
  ), base_rows as materialized (
    select
      completed_run.id as run_id,
      completed_run.revision as source_revision,
      internal.jiaowubao_direct_schedule_mapping_label_key(schedule_event.teacher_display_name) as teacher_label_key,
      internal.jiaowubao_direct_schedule_mapping_label_key(schedule_event.course_name) as course_label_key,
      schedule_event.teacher_display_name as teacher_label,
      schedule_event.course_name as course_label,
      schedule_event.record_sha256
    from completed_run
    join internal.jiaowubao_direct_schedule_events schedule_event
      on schedule_event.run_id = completed_run.id
  ), source_rows as materialized (
    select *
    from base_rows
    where teacher_label_key <> ''
      and course_label_key <> ''
  ), grouped as materialized (
    select
      source_rows.run_id,
      source_rows.source_revision,
      source_rows.teacher_label_key,
      source_rows.course_label_key,
      min(source_rows.teacher_label) as teacher_label,
      min(source_rows.course_label) as course_label,
      count(*)::integer as event_count,
      string_agg(source_rows.record_sha256, ',' order by source_rows.record_sha256) as source_hash_material
    from source_rows
    group by
      source_rows.run_id,
      source_rows.source_revision,
      source_rows.teacher_label_key,
      source_rows.course_label_key
  ), evidenced as materialized (
    select
      grouped.*,
      encode(extensions.digest(convert_to(
        'jiaowubao-direct-schedule-label-pair-v1' || chr(31)
          || grouped.run_id::text || chr(31)
          || grouped.source_revision || chr(31)
          || grouped.teacher_label_key || chr(31)
          || grouped.course_label_key || chr(31)
          || grouped.event_count::text || chr(31)
          || grouped.source_hash_material,
        'UTF8'
      ), 'sha256'), 'hex') as source_evidence_sha256
    from grouped
  )
  select
    'sha256:' || encode(extensions.digest(convert_to(
      'jiaowubao-direct-schedule-label-mapping-candidate-v1' || chr(31)
        || evidenced.run_id::text || chr(31)
        || evidenced.source_revision || chr(31)
        || evidenced.teacher_label_key || chr(31)
        || evidenced.course_label_key || chr(31)
        || evidenced.source_evidence_sha256,
      'UTF8'
    ), 'sha256'), 'hex') as mapping_key,
    evidenced.source_revision,
    evidenced.source_evidence_sha256,
    evidenced.teacher_label_key,
    evidenced.course_label_key,
    evidenced.teacher_label,
    evidenced.course_label,
    evidenced.event_count
  from evidenced
$jiaowubao_direct_schedule_mapping_snapshot_source$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_snapshot_source(uuid)
  from public, anon, authenticated;

-- The manifest is the visible-complete marker for a run-scoped candidate
-- snapshot.  It is inserted last in the same transaction as its rows, so a
-- reader never accepts a partial snapshot (including an intentionally empty
-- source-label pair set).
create table if not exists internal.jiaowubao_direct_schedule_mapping_snapshot_manifests (
  run_id uuid primary key references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  source_revision text not null check (
    source_revision = btrim(source_revision) and char_length(source_revision) between 1 and 240
  ),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  completion_audit_id uuid not null
    references internal.operational_contract_audit(id) on delete restrict,
  candidate_count integer not null check (candidate_count between 0 and 200000),
  eligible_event_count integer not null check (eligible_event_count between 0 and 200000),
  candidate_set_sha256 text not null check (candidate_set_sha256 ~ '^[a-f0-9]{64}$'),
  materialized_at timestamptz not null default clock_timestamp(),
  check (
    (candidate_count = 0 and eligible_event_count = 0)
    or (candidate_count > 0 and eligible_event_count >= candidate_count)
  )
);

create table if not exists internal.jiaowubao_direct_schedule_mapping_candidate_snapshots (
  run_id uuid not null references internal.jiaowubao_direct_import_runs(id) on delete restrict,
  mapping_key text not null check (mapping_key ~ '^sha256:[a-f0-9]{64}$'),
  source_revision text not null check (
    source_revision = btrim(source_revision) and char_length(source_revision) between 1 and 240
  ),
  source_evidence_sha256 text not null check (source_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  teacher_label_key text not null check (
    teacher_label_key = btrim(teacher_label_key) and char_length(teacher_label_key) between 1 and 500
  ),
  course_label_key text not null check (
    course_label_key = btrim(course_label_key) and char_length(course_label_key) between 1 and 500
  ),
  teacher_label text not null check (char_length(teacher_label) between 1 and 240),
  course_label text not null check (char_length(course_label) between 1 and 500),
  source_event_count integer not null check (source_event_count between 1 and 200000),
  primary key (run_id, mapping_key),
  unique (run_id, teacher_label_key, course_label_key),
  unique (run_id, source_evidence_sha256)
);

alter table internal.jiaowubao_direct_schedule_mapping_snapshot_manifests enable row level security;
alter table internal.jiaowubao_direct_schedule_mapping_candidate_snapshots enable row level security;
revoke all on table internal.jiaowubao_direct_schedule_mapping_snapshot_manifests
  from public, anon, authenticated;
revoke all on table internal.jiaowubao_direct_schedule_mapping_candidate_snapshots
  from public, anon, authenticated;

-- The read model is append-only.  The materializer is the only ordinary
-- writer; its transaction-local capability prevents an accidental direct SQL
-- INSERT from creating a reviewable row without the complete source proof.
create or replace function internal.jiaowubao_direct_schedule_mapping_snapshot_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_snapshot_guard$
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_snapshot_append_only';
  end if;
  if current_setting('internal.jiaowubao_direct_schedule_mapping_snapshot_run_id', true)
       is distinct from new.run_id::text then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_snapshot_write_forbidden';
  end if;
  return new;
end;
$jiaowubao_direct_schedule_mapping_snapshot_guard$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_snapshot_guard()
  from public, anon, authenticated;

create trigger jiaowubao_direct_schedule_mapping_snapshot_manifest_guard
before insert or update or delete on internal.jiaowubao_direct_schedule_mapping_snapshot_manifests
for each row execute function internal.jiaowubao_direct_schedule_mapping_snapshot_guard();

create trigger jiaowubao_direct_schedule_mapping_candidate_snapshot_guard
before insert or update or delete on internal.jiaowubao_direct_schedule_mapping_candidate_snapshots
for each row execute function internal.jiaowubao_direct_schedule_mapping_snapshot_guard();

-- Re-hash the compact snapshot, never the imported schedule relation.  It
-- covers every stored candidate field so a damaged/internal row cannot become
-- silently reviewable.  At production shape this is roughly 359 rows, not
-- 39,743 source events.
create or replace function internal.jiaowubao_direct_schedule_mapping_snapshot_digest(
  p_run_id uuid,
  p_source_revision text
)
returns table (
  candidate_count integer,
  eligible_event_count integer,
  candidate_set_sha256 text
)
language sql
stable
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_snapshot_digest$
  select
    count(*)::integer as candidate_count,
    coalesce(sum(snapshot.source_event_count), 0)::integer as eligible_event_count,
    encode(extensions.digest(convert_to(
      'jiaowubao-direct-schedule-label-mapping-snapshot-v1' || chr(31)
        || p_run_id::text || chr(31)
        || p_source_revision || chr(31)
        || count(*)::text || chr(31)
        || coalesce(sum(snapshot.source_event_count), 0)::text || chr(31)
        || coalesce(jsonb_agg(jsonb_build_array(
          snapshot.mapping_key,
          snapshot.source_revision,
          snapshot.source_evidence_sha256,
          snapshot.teacher_label_key,
          snapshot.course_label_key,
          snapshot.teacher_label,
          snapshot.course_label,
          snapshot.source_event_count
        ) order by snapshot.mapping_key)::text, '[]'),
      'UTF8'
    ), 'sha256'), 'hex') as candidate_set_sha256
  from internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
  where snapshot.run_id = p_run_id
    and snapshot.source_revision = p_source_revision
$jiaowubao_direct_schedule_mapping_snapshot_digest$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_snapshot_digest(uuid, text)
  from public, anon, authenticated;

-- Validate the immutable completed-run header before a reader/confirmation
-- trusts a snapshot.  This deliberately stays header-only: it keeps a cursor
-- request indexed/page-bounded even if a historical run has a very large
-- number of distinct label pairs. The full compact-set hash is checked during
-- materialization and the all-run migration reconciliation below; ordinary
-- roles have no direct write path to either internal snapshot table.
create or replace function internal.jiaowubao_direct_schedule_mapping_snapshot_manifest(
  p_run_id uuid
)
returns table (
  run_id uuid,
  source_revision text,
  payload_sha256 text,
  completion_audit_id uuid,
  candidate_count integer,
  eligible_event_count integer,
  candidate_set_sha256 text
)
language plpgsql
stable
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_snapshot_manifest$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  saved_manifest internal.jiaowubao_direct_schedule_mapping_snapshot_manifests%rowtype;
begin
  select * into saved_run
  from internal.jiaowubao_direct_import_runs run_state
  where run_state.id = p_run_id
    and run_state.state = 'complete';
  if not found then
    return;
  end if;

  select * into saved_manifest
  from internal.jiaowubao_direct_schedule_mapping_snapshot_manifests manifest_row
  where manifest_row.run_id = saved_run.id;
  if not found then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_snapshot_unavailable';
  end if;
  if saved_manifest.source_revision <> saved_run.revision
     or saved_manifest.payload_sha256 is distinct from saved_run.payload_sha256
     or saved_manifest.completion_audit_id is distinct from saved_run.completion_audit_id then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_snapshot_invalid';
  end if;

  run_id := saved_run.id;
  source_revision := saved_manifest.source_revision;
  payload_sha256 := saved_manifest.payload_sha256;
  completion_audit_id := saved_manifest.completion_audit_id;
  candidate_count := saved_manifest.candidate_count;
  eligible_event_count := saved_manifest.eligible_event_count;
  candidate_set_sha256 := saved_manifest.candidate_set_sha256;
  return next;
end;
$jiaowubao_direct_schedule_mapping_snapshot_manifest$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_snapshot_manifest(uuid)
  from public, anon, authenticated;

-- Full compact-row reconciliation is private and used at the only write
-- boundary (and during this migration's historical backfill).  It hashes no
-- imported events, but it prevents a malformed/partial internal snapshot from
-- acquiring or retaining a manifest header.
create or replace function internal.assert_jiaowubao_direct_schedule_mapping_snapshot_integrity(
  p_run_id uuid
)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $assert_jiaowubao_direct_schedule_mapping_snapshot_integrity$
declare
  saved_manifest record;
  actual_digest record;
begin
  select * into saved_manifest
  from internal.jiaowubao_direct_schedule_mapping_snapshot_manifest(p_run_id);
  if not found then
    return;
  end if;

  select * into actual_digest
  from internal.jiaowubao_direct_schedule_mapping_snapshot_digest(
    saved_manifest.run_id, saved_manifest.source_revision
  );
  if actual_digest.candidate_count <> saved_manifest.candidate_count
     or actual_digest.eligible_event_count <> saved_manifest.eligible_event_count
     or actual_digest.candidate_set_sha256 <> saved_manifest.candidate_set_sha256 then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_snapshot_invalid';
  end if;
end;
$assert_jiaowubao_direct_schedule_mapping_snapshot_integrity$;

revoke all on function internal.assert_jiaowubao_direct_schedule_mapping_snapshot_integrity(uuid)
  from public, anon, authenticated;

-- Build exactly once per immutable completed run.  It never UPSERTs or
-- overwrites a snapshot: a retry validates the already-complete manifest; a
-- partial/corrupt pre-existing row set is rejected.  SECURITY DEFINER is
-- intentional here because an importer may have only EXECUTE rights while the
-- AFTER completion trigger still has to write these internal RLS tables.
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
    -- Calling the private full reconciliation here makes retries idempotent
    -- but rejects header/row drift without ever recomputing source events.
    perform internal.assert_jiaowubao_direct_schedule_mapping_snapshot_integrity(saved_run.id);
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

  -- Keep the post-write proof explicit: it also verifies the manifest was
  -- inserted last and remains tied to this exact completed import authority.
  perform internal.assert_jiaowubao_direct_schedule_mapping_snapshot_integrity(saved_run.id);
end;
$materialize_jiaowubao_direct_schedule_mapping_snapshot$;

revoke all on function internal.materialize_jiaowubao_direct_schedule_mapping_snapshot(uuid)
  from public, anon, authenticated;

create or replace function internal.jiaowubao_direct_schedule_mapping_snapshot_on_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $jiaowubao_direct_schedule_mapping_snapshot_on_complete$
begin
  perform internal.materialize_jiaowubao_direct_schedule_mapping_snapshot(new.id);
  return new;
end;
$jiaowubao_direct_schedule_mapping_snapshot_on_complete$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_snapshot_on_complete()
  from public, anon, authenticated;

-- A brief EXCLUSIVE lock closes the deployment race: it conflicts with both a
-- pre-existing completion's `SELECT ... FOR UPDATE` ROW SHARE lock and its
-- later ROW EXCLUSIVE transition, while still allowing ordinary readers. No
-- staging-to-complete UPDATE can commit between trigger installation, all-run
-- backfill/reconciliation, and this migration's commit. With the 1s lock
-- timeout, retry deployment while an import is idle rather than racing it.
lock table internal.jiaowubao_direct_import_runs in exclusive mode;

create trigger jiaowubao_direct_schedule_mapping_snapshot_on_complete
after update of state on internal.jiaowubao_direct_import_runs
for each row
when (old.state = 'staging' and new.state = 'complete')
execute function internal.jiaowubao_direct_schedule_mapping_snapshot_on_complete();

-- Backfill every historical completed run while completion is blocked by the
-- lock above.  Existing valid manifests are only reconciled; missing headers
-- are materialized once; partial/mismatched evidence fails closed.
do $jiaowubao_direct_schedule_mapping_snapshot_backfill$
declare
  completed_run record;
begin
  for completed_run in
    select run_state.id
    from internal.jiaowubao_direct_import_runs run_state
    where run_state.state = 'complete'
    order by run_state.completed_at, run_state.id
  loop
    perform internal.materialize_jiaowubao_direct_schedule_mapping_snapshot(completed_run.id);
  end loop;

  -- A second bounded reconciliation makes the migration's all-run invariant
  -- explicit and rejects a header that does not still match revision/payload,
  -- completion audit, count, eligible source count, and full snapshot digest.
  for completed_run in
    select run_state.id
    from internal.jiaowubao_direct_import_runs run_state
    where run_state.state = 'complete'
    order by run_state.completed_at, run_state.id
  loop
    perform internal.assert_jiaowubao_direct_schedule_mapping_snapshot_integrity(completed_run.id);
  end loop;
end;
$jiaowubao_direct_schedule_mapping_snapshot_backfill$;

-- Keep the 005 function signature/OID so its existing decision guard and
-- confirmation contract automatically receive bounded candidates.  It now
-- trusts only a manifest-validated snapshot derived from immutable source.
create or replace function internal.jiaowubao_direct_schedule_mapping_candidates(
  p_run_id uuid
)
returns table (
  mapping_key text,
  source_revision text,
  source_evidence_sha256 text,
  teacher_label_key text,
  course_label_key text,
  teacher_label text,
  course_label text,
  event_count integer
)
language sql
stable
security invoker
set search_path = ''
as $jiaowubao_direct_schedule_mapping_candidates$
  select
    snapshot.mapping_key,
    snapshot.source_revision,
    snapshot.source_evidence_sha256,
    snapshot.teacher_label_key,
    snapshot.course_label_key,
    snapshot.teacher_label,
    snapshot.course_label,
    snapshot.source_event_count as event_count
  from internal.jiaowubao_direct_schedule_mapping_snapshot_manifest(p_run_id) manifest
  join internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
    on snapshot.run_id = manifest.run_id
   and snapshot.source_revision = manifest.source_revision
$jiaowubao_direct_schedule_mapping_candidates$;

revoke all on function internal.jiaowubao_direct_schedule_mapping_candidates(uuid)
  from public, anon, authenticated;

-- The existing public reader keeps the same narrow DTO/ACL but takes its page
-- keys from the `(run_id, mapping_key)` snapshot primary key before joining the
-- materialized classification.  Summary/status work is therefore pair-scale;
-- neither cursor validation nor a page render can touch schedule source rows.
create or replace function public.get_jiaowubao_direct_schedule_mapping_review(
  p_secret text,
  p_limit integer default 80,
  p_after_mapping_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $get_jiaowubao_direct_schedule_mapping_review$
declare
  saved_run internal.jiaowubao_direct_import_runs%rowtype;
  saved_snapshot_manifest record;
  teachers_state public.ops_state%rowtype;
  teacher_count integer;
  distinct_teacher_count integer;
  total_count integer := 0;
  unmapped_count integer := 0;
  confirmed_count integer := 0;
  revoked_count integer := 0;
  authority_changed_count integer := 0;
  latest_decision_count integer := 0;
  classified_decision_count integer := 0;
  candidates jsonb := '[]'::jsonb;
  teacher_catalog jsonb := '[]'::jsonb;
  has_more boolean := false;
  next_cursor text := null;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_limit is null or p_limit not between 1 and 120
     or (p_after_mapping_key is not null and p_after_mapping_key !~ '^sha256:[a-f0-9]{64}$') then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_schedule_mapping_review';
  end if;

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
      'summary', jsonb_build_object(
        'total', 0, 'unmapped', 0, 'confirmed', 0, 'revoked', 0, 'authorityChanged', 0
      ),
      'candidates', '[]'::jsonb,
      'nextCursor', null
    );
  end if;

  select * into saved_snapshot_manifest
  from internal.jiaowubao_direct_schedule_mapping_snapshot_manifest(saved_run.id);

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

  if p_after_mapping_key is not null and not exists (
    select 1
    from internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
    where snapshot.run_id = saved_run.id
      and snapshot.source_revision = saved_snapshot_manifest.source_revision
      and snapshot.mapping_key = p_after_mapping_key
  ) then
    raise exception using errcode = '22023', message = 'jiaowubao_schedule_mapping_cursor_invalid';
  end if;

  with page_keys as materialized (
    -- This is the first candidate relation the reader touches. The snapshot
    -- primary key is `(run_id, mapping_key)`, so a cursor seeks only the next
    -- page before either page classification or the all-pair summary runs.
    select snapshot.mapping_key
    from internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
    where snapshot.run_id = saved_run.id
      and snapshot.source_revision = saved_snapshot_manifest.source_revision
      and (p_after_mapping_key is null or snapshot.mapping_key > p_after_mapping_key)
    order by snapshot.mapping_key
    limit p_limit + 1
  ), teacher_catalog_current as materialized (
    select *
    from internal.jiaowubao_direct_schedule_mapping_teacher_catalog(teachers_state.payload)
  ), latest_decisions as materialized (
    select distinct on (decision_row.mapping_key)
      decision_row.*
    from internal.jiaowubao_direct_schedule_label_mapping_decisions decision_row
    where decision_row.run_id = saved_run.id
    order by decision_row.mapping_key, decision_row.decision_sequence desc
  ), decision_classified as materialized (
    select
      decision_row.id as decision_id,
      decision_row.mapping_key,
      decision_row.source_revision,
      decision_row.source_evidence_sha256,
      decision_row.decision,
      decision_row.target_teacher_id,
      decision_row.target_subject_id,
      decision_row.decided_at,
      target_catalog.teacher_name as target_teacher_name,
      case
        when decision_row.id is null then 'unmapped'
        when decision_row.decision = 'revoked' then 'revoked'
        when target_catalog.teacher_id is not null
          and decision_row.target_subject_id = any(target_catalog.subject_ids)
          and decision_row.target_basis_sha256 = target_catalog.target_basis_sha256
          then 'confirmed'
        else 'authority_changed'
      end as mapping_status
    from latest_decisions decision_row
    join internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
      on snapshot.run_id = saved_run.id
     and snapshot.source_revision = saved_snapshot_manifest.source_revision
     and snapshot.mapping_key = decision_row.mapping_key
     and snapshot.source_evidence_sha256 = decision_row.source_evidence_sha256
     and snapshot.source_revision = decision_row.source_revision
    left join teacher_catalog_current target_catalog
      on target_catalog.teacher_id = decision_row.target_teacher_id
  ), page_candidates as materialized (
    select
      snapshot.mapping_key,
      snapshot.source_revision,
      snapshot.source_evidence_sha256,
      snapshot.teacher_label_key,
      snapshot.course_label_key,
      snapshot.teacher_label,
      snapshot.course_label,
      snapshot.source_event_count as event_count
    from page_keys page_key
    join internal.jiaowubao_direct_schedule_mapping_candidate_snapshots snapshot
      on snapshot.run_id = saved_run.id
     and snapshot.source_revision = saved_snapshot_manifest.source_revision
     and snapshot.mapping_key = page_key.mapping_key
  ), page_classified as materialized (
    select
      candidate.*,
      decision_row.decision_id,
      decision_row.decision,
      decision_row.target_teacher_id,
      decision_row.target_subject_id,
      decision_row.decided_at,
      decision_row.target_teacher_name,
      coalesce(decision_row.mapping_status, 'unmapped') as mapping_status
    from page_candidates candidate
    left join decision_classified decision_row
      on decision_row.mapping_key = candidate.mapping_key
      and decision_row.source_evidence_sha256 = candidate.source_evidence_sha256
      and decision_row.source_revision = candidate.source_revision
  ), page_plus_one as materialized (
    select *
    from page_classified
    order by mapping_key
  ), page as materialized (
    select * from page_plus_one order by mapping_key limit p_limit
  )
  select
    saved_snapshot_manifest.candidate_count,
    saved_snapshot_manifest.candidate_count - (select count(*)::integer from latest_decisions),
    (select count(*) filter (where mapping_status = 'confirmed')::integer from decision_classified),
    (select count(*) filter (where mapping_status = 'revoked')::integer from decision_classified),
    (select count(*) filter (where mapping_status = 'authority_changed')::integer from decision_classified),
    (select count(*)::integer from latest_decisions),
    (select count(*)::integer from decision_classified),
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
        else to_char(page.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
    ) order by page.mapping_key), '[]'::jsonb),
    (select count(*) > p_limit from page_plus_one),
    (select case when count(*) > p_limit then max(mapping_key) filter (where row_number <= p_limit) end
      from (
        select mapping_key, row_number() over (order by mapping_key) as row_number
        from page_plus_one
      ) cursor_rows)
  into
    total_count,
    unmapped_count,
    confirmed_count,
    revoked_count,
    authority_changed_count,
    latest_decision_count,
    classified_decision_count,
    candidates,
    has_more,
    next_cursor
  from page;

  if latest_decision_count <> classified_decision_count
     or unmapped_count < 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_mapping_snapshot_invalid';
  end if;

  return jsonb_build_object(
    'state', 'complete',
    'runToken', saved_run.id::text,
    'teachersVersion', teachers_state.version,
    'teachers', teacher_catalog,
    'summary', jsonb_build_object(
      'total', total_count,
      'unmapped', unmapped_count,
      'confirmed', confirmed_count,
      'revoked', revoked_count,
      'authorityChanged', authority_changed_count
    ),
    'candidates', candidates,
    'nextCursor', case when has_more then next_cursor else null end
  );
end;
$get_jiaowubao_direct_schedule_mapping_review$;

revoke all on function public.get_jiaowubao_direct_schedule_mapping_review(text, integer, text)
  from public, anon, authenticated;
grant execute on function public.get_jiaowubao_direct_schedule_mapping_review(text, integer, text)
  to anon, authenticated;
