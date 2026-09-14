\ir assert-disposable-database.sql
\set ON_ERROR_STOP on

-- Local-only 005 -> 007 compatibility and scale regression. It creates one
-- completed-looking immutable source run with the production-shaped 39,743
-- schedule events / 359 teacher-course pairs, captures the exact 005 v1
-- candidates, then applies 006/007 and proves its snapshot is byte-for-byte
-- identical before exercising all-history GET, current/future priority GET
-- (including cursors), and PUT + decision guard.
-- The controlled transition below uses session_replication_role only inside
-- this disposable superuser transaction; production completion always uses
-- the reviewed completion function and 006's AFTER transition trigger.

begin;

\ir ../../supabase/migrations/20260819000100_create_jiaowubao_direct_import_projection.sql
\ir ../../supabase/migrations/20260819000200_read_jiaowubao_direct_import_projection.sql
\if :{?skip_jiaowubao_booking_capacity_guard}
\else
\ir ../../supabase/migrations/20260819000300_guard_booking_capacity_against_jiaowubao_schedule.sql
\endif
\ir ../../supabase/migrations/20260819000600_fix_jiaowubao_direct_import_envelope_precedence.sql
\ir ../../supabase/migrations/20260819000700_fix_jiaowubao_direct_import_stage_alias_ambiguity.sql
\ir ../../supabase/migrations/20260819000800_fix_jiaowubao_direct_import_completion_proof.sql
\ir ../../supabase/migrations/20260819000900_optimize_jiaowubao_direct_import_completion_proof.sql
\ir ../../supabase/migrations/20260819001000_batch_jiaowubao_direct_import_schedule_stage.sql
\ir ../../supabase/migrations/20260819001100_resume_jiaowubao_direct_import_chunks.sql
\ir ../../supabase/migrations/20260819001200_guard_jiaowubao_direct_import_auto_abort.sql
\ir ../../supabase/migrations/20260819100400_read_jiaowubao_operations_readiness.sql
\ir ../../supabase/migrations/20260819100500_review_jiaowubao_schedule_label_mappings.sql

create or replace function internal.verify_ops_secret(p_secret text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_secret = 'jiaowubao-snapshot-performance-secret';
$$;

-- `ileaudit` intentionally has a minimal audit baseline. This local-only
-- writer merely satisfies the real foreign keys while retaining an explicit
-- audit row for the later append-only mapping confirmation.
create or replace function internal.append_operational_contract_audit(
  p_action text,
  p_actor text,
  p_target_type text,
  p_target_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $fixture_append_operational_contract_audit$
declare
  saved_id uuid;
begin
  insert into internal.operational_contract_audit (
    action, actor, target_type, target_id, metadata
  ) values (
    left(trim(p_action), 120),
    left(trim(p_actor), 120),
    left(trim(p_target_type), 80),
    left(trim(p_target_id), 240),
    coalesce(p_metadata, '{}'::jsonb)
  ) returning id into saved_id;
  return saved_id;
end;
$fixture_append_operational_contract_audit$;

do $jiaowubao_schedule_mapping_snapshot_scale_setup$
declare
  test_run_id uuid;
  test_audit_id uuid;
  test_completion_audit_id uuid;
  test_record_counts jsonb := jsonb_build_object(
    'student_snapshot', 0,
    'quick_list', 0,
    'contract_history', 0,
    'hour_balance', 0,
    'class_membership', 0,
    'schedule_event', 39743,
    'leave_makeup', 0
  );
begin
  insert into public.ops_state (entity, payload, version, updated_by) values
    ('teachers', jsonb_build_array(jsonb_build_object(
      'id', 'snapshot-performance-teacher',
      'name', 'Snapshot Performance Teacher',
      'subjects', jsonb_build_array('Snapshot Performance Subject')
    )), 1, 'Snapshot performance fixture');

  test_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.performance_fixture',
    'Snapshot performance fixture',
    'jiaowubao_direct_import_run',
    'local-only',
    '{}'::jsonb
  );
  test_completion_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_direct_import.completed',
    'Snapshot performance fixture',
    'jiaowubao_direct_import_run',
    'local-only-complete',
    '{}'::jsonb
  );

  insert into internal.jiaowubao_direct_import_runs (
    source_id, revision, format, source_timezone, source_timezone_basis,
    master_source_id, master_revision, master_rows_sha256,
    expected_chunk_count, source_record_counts, expected_counts,
    state, staged_by, staging_audit_id
  ) values (
    'jiaowubao-static-excel', 'sha256:' || repeat('9', 64),
    'jiaowubao-direct-import-v1', 'Australia/Melbourne', 'local snapshot scale fixture',
    'master', 'fixture', repeat('8', 64), 1, test_record_counts,
    jsonb_build_object(
      'supplementalRecords', 0,
      'scheduleEvents', 39743,
      'scheduleParticipants', 0,
      'leaveMakeups', 0
    ),
    'staging', 'Snapshot performance fixture', test_audit_id
  ) returning id into test_run_id;

  insert into internal.jiaowubao_direct_import_chunks (
    run_id, chunk_index, chunk_sha256, source_record_counts,
    source_record_count, content_bytes, projection_sha256, projected_record_counts, audit_id
  ) values (
    test_run_id, 0, repeat('5', 64), test_record_counts,
    39743, 1, repeat('4', 64),
    jsonb_build_object(
      'supplementalRecords', 0,
      'scheduleEvents', 39743,
      'scheduleParticipants', 0,
      'leaveMakeups', 0
    ), test_audit_id
  );

  insert into internal.jiaowubao_direct_schedule_events (
    run_id, chunk_index, source_key, source_row, source_cell,
    source_date, source_timezone, source_timezone_basis,
    time_parse_status, time_parse_reason, dst_resolution,
    source_local_start, source_local_end, starts_at, ends_at,
    teacher_resolution, subject_resolution, availability_effect,
    course_name, teacher_display_name, source_payload, record_sha256
  )
  select
    test_run_id,
    0,
    'snapshot-performance:schedule:' || event_number::text,
    event_number,
    'A' || event_number::text,
    case when ((event_number - 1) % 359) = 0 then date '2026-08-21' else date '2026-08-20' end,
    'Australia/Melbourne',
    'local snapshot scale fixture',
    case when event_number = 1 then 'invalid_time' else 'parsed' end,
    case when event_number = 1 then 'missing_time_interval' else null end,
    case when event_number = 1 then null else 'unambiguous' end,
    case when event_number = 1 then null else time '10:00' end,
    case when event_number = 1 then null else time '11:00' end,
    case when event_number = 1 then null
      when ((event_number - 1) % 359) = 0 then timestamptz '2026-08-21 00:00:00+00'
      else timestamptz '2026-08-20 00:00:00+00' end,
    case when event_number = 1 then null
      when ((event_number - 1) % 359) = 0 then timestamptz '2026-08-21 01:00:00+00'
      else timestamptz '2026-08-20 01:00:00+00' end,
    'unresolved',
    'unresolved',
    'display_only',
    'Source Course ' || (((event_number - 1) % 359) + 1)::text,
    'Source Teacher ' || (((event_number - 1) % 359) + 1)::text,
    jsonb_build_object('source', jsonb_build_object('fixture', true)),
    encode(extensions.digest(convert_to('snapshot-performance:' || event_number::text, 'UTF8'), 'sha256'), 'hex')
  from generate_series(1, 39743) event_number;

  create temporary table jiaowubao_schedule_mapping_snapshot_scale_context (
    run_id uuid primary key
  ) on commit drop;
  insert into jiaowubao_schedule_mapping_snapshot_scale_context values (test_run_id);

  -- This run shape is intentionally complete before 006 exists, so the next
  -- statement reproduces the deployed 005 reader's live source derivation.
  perform set_config('session_replication_role', 'replica', true);
  update internal.jiaowubao_direct_import_runs run_state
  set state = 'complete',
      payload_sha256 = repeat('6', 64),
      completed_at = clock_timestamp(),
      completion_audit_id = test_completion_audit_id
  where run_state.id = test_run_id;
  perform set_config('session_replication_role', 'origin', true);
end;
$jiaowubao_schedule_mapping_snapshot_scale_setup$;

create temporary table jiaowubao_schedule_mapping_005_expected on commit drop as
select candidate.*
from internal.jiaowubao_direct_schedule_mapping_candidates(
  (select context.run_id from jiaowubao_schedule_mapping_snapshot_scale_context context)
) candidate;

do $jiaowubao_schedule_mapping_005_shape$
begin
  if (select count(*) from jiaowubao_schedule_mapping_005_expected) <> 359
     or (select sum(event_count) from jiaowubao_schedule_mapping_005_expected) <> 39743 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_005_scale_shape_failed';
  end if;
end;
$jiaowubao_schedule_mapping_005_shape$;

\echo JWB_SNAPSHOT_006_BACKFILL_BEGIN
\timing on
\ir ../../supabase/migrations/20260819100600_materialize_jiaowubao_schedule_mapping_candidates.sql
\timing off
\echo JWB_SNAPSHOT_006_BACKFILL_END

\echo JWB_PRIORITY_007_BACKFILL_BEGIN
\timing on
\ir ../../supabase/migrations/20260819100700_prioritize_jiaowubao_schedule_mapping_review.sql
\timing off
\echo JWB_PRIORITY_007_BACKFILL_END

do $jiaowubao_schedule_mapping_snapshot_scale_assertions$
declare
  test_run_id uuid := (select context.run_id from jiaowubao_schedule_mapping_snapshot_scale_context context);
  first_page jsonb;
  cursor_page jsonb;
  receipt jsonb;
  priority_first_page jsonb;
  priority_cursor_page jsonb;
  priority_authority_page jsonb;
  priority_after_authority_page jsonb;
  priority_authority_receipt jsonb;
  first_mapping_key text;
  priority_authority_mapping_key text;
  page_cursor text := null;
  page_payload jsonb;
  fetched_mapping_keys text[];
  seen_mapping_keys text[] := ARRAY[]::text[];
  page_number integer := 0;
  started_at timestamptz;
  elapsed_ms numeric;
  get_elapsed_ms numeric;
  cursor_elapsed_ms numeric;
  put_elapsed_ms numeric;
  priority_get_elapsed_ms numeric;
  priority_cursor_elapsed_ms numeric;
begin
  -- Inspect the functions actually installed after CREATE OR REPLACE, not
  -- merely migration text: neither GET, PUT nor the decision trigger can fall
  -- back to a raw schedule-event relation after 006.
  if position(
       'internal.jiaowubao_direct_schedule_events'
       in pg_get_functiondef('internal.jiaowubao_direct_schedule_mapping_candidates(uuid)'::regprocedure)
     ) > 0
     or position(
       'internal.jiaowubao_direct_schedule_events'
       in pg_get_functiondef('public.get_jiaowubao_direct_schedule_mapping_review(text,integer,text)'::regprocedure)
     ) > 0
     or position(
       'internal.jiaowubao_direct_schedule_events'
       in pg_get_functiondef('public.put_jiaowubao_direct_schedule_label_mapping(text,text,uuid,text,text,text,bigint,text)'::regprocedure)
     ) > 0
     or position(
       'internal.jiaowubao_direct_schedule_events'
       in pg_get_functiondef('internal.jiaowubao_direct_schedule_mapping_decision_guard()'::regprocedure)
     ) > 0
     or position(
       'internal.jiaowubao_direct_schedule_events'
       in pg_get_functiondef('public.get_jiaowubao_direct_schedule_mapping_priority_review(text,timestamp with time zone,timestamp with time zone,integer,text)'::regprocedure)
     ) > 0 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_snapshot_runtime_raw_source_access_failed';
  end if;

  -- Exact v1 provenance compatibility: no source group is added, omitted, or
  -- changed when the completed 005 run is backfilled into the 006 snapshot.
  if exists (
    (select * from jiaowubao_schedule_mapping_005_expected
      except all
     select * from internal.jiaowubao_direct_schedule_mapping_candidates(test_run_id))
    union all
    (select * from internal.jiaowubao_direct_schedule_mapping_candidates(test_run_id)
      except all
     select * from jiaowubao_schedule_mapping_005_expected)
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_snapshot_v1_parity_failed';
  end if;
  if not exists (
    select 1
    from internal.jiaowubao_direct_schedule_mapping_snapshot_manifests manifest
    where manifest.run_id = test_run_id
      and manifest.candidate_count = 359
      and manifest.eligible_event_count = 39743
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_snapshot_manifest_missing';
  end if;

  -- Create one later source pair whose already-confirmed target becomes stale
  -- only because its teacher authority basis changes. This proves the priority
  -- queue puts an authority_changed pair ahead of earlier unmapped source
  -- starts, and that its keyset cursor crosses that status boundary correctly.
  select candidate.mapping_key into priority_authority_mapping_key
  from internal.jiaowubao_direct_schedule_mapping_candidates(test_run_id) candidate
  where candidate.teacher_label = 'Source Teacher 1'
    and candidate.course_label = 'Source Course 1';
  if priority_authority_mapping_key is null then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_priority_authority_candidate_missing';
  end if;
  priority_authority_receipt := public.put_jiaowubao_direct_schedule_label_mapping(
    'jiaowubao-snapshot-performance-secret',
    priority_authority_mapping_key,
    '10000000-0000-4000-8000-000000000010'::uuid,
    'confirm',
    'snapshot-performance-teacher',
    'Snapshot Performance Subject',
    1,
    'Nixon'
  );
  if priority_authority_receipt ->> 'unchanged' <> 'false' then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_priority_authority_seed_failed';
  end if;
  update public.ops_state set
    payload = jsonb_build_array(jsonb_build_object(
      'id', 'snapshot-performance-teacher',
      'name', 'Snapshot Performance Teacher Updated',
      'subjects', jsonb_build_array('Snapshot Performance Subject')
    )),
    version = 2,
    updated_at = clock_timestamp(),
    updated_by = 'Snapshot performance fixture'
  where entity = 'teachers';

  if not exists (
    select 1
    from internal.jiaowubao_direct_schedule_mapping_relevance_manifests manifest
    where manifest.run_id = test_run_id
      and manifest.parsed_event_count = 39742
      and manifest.relevance_day_count = 359
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_priority_manifest_missing';
  end if;

  -- A snapshot GET, cursor GET, and PUT+append-only decision guard must all
  -- finish under the narrow runtime budget. The 39,743 source rows remain in
  -- the database solely to catch an accidental fallback to live derivation.
  perform set_config('statement_timeout', '500ms', true);
  started_at := clock_timestamp();
  first_page := public.get_jiaowubao_direct_schedule_mapping_review(
    'jiaowubao-snapshot-performance-secret', 80, null
  );
  elapsed_ms := extract(epoch from (clock_timestamp() - started_at)) * 1000;
  get_elapsed_ms := elapsed_ms;
  if elapsed_ms > 500
     or first_page ->> 'state' <> 'complete'
     or coalesce((first_page #>> '{summary,total}')::integer, -1) <> 359
     or jsonb_array_length(first_page -> 'candidates') <> 80
     or first_page ->> 'nextCursor' is null then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_snapshot_get_performance_failed';
  end if;

  started_at := clock_timestamp();
  cursor_page := public.get_jiaowubao_direct_schedule_mapping_review(
    'jiaowubao-snapshot-performance-secret', 80, first_page ->> 'nextCursor'
  );
  elapsed_ms := extract(epoch from (clock_timestamp() - started_at)) * 1000;
  cursor_elapsed_ms := elapsed_ms;
  if elapsed_ms > 500
     or jsonb_array_length(cursor_page -> 'candidates') <> 80
     or cursor_page #>> '{candidates,0,mappingKey}' = first_page #>> '{candidates,0,mappingKey}' then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_snapshot_cursor_performance_failed';
  end if;

  -- The priority reader derives its next source start and current-window count
  -- entirely from 007's immutable relevance days.  The one invalid source
  -- time is deliberately excluded from the parsed relevance count.
  started_at := clock_timestamp();
  priority_first_page := public.get_jiaowubao_direct_schedule_mapping_priority_review(
    'jiaowubao-snapshot-performance-secret',
    timestamptz '2026-08-20 00:00:00+00',
    timestamptz '2026-10-22 00:00:00+00',
    80,
    null
  );
  elapsed_ms := extract(epoch from (clock_timestamp() - started_at)) * 1000;
  priority_get_elapsed_ms := elapsed_ms;
  if elapsed_ms > 500
     or priority_first_page ->> 'state' <> 'complete'
     or coalesce((priority_first_page #>> '{summary,total}')::integer, -1) <> 359
     or coalesce((priority_first_page #>> '{summary,unmapped}')::integer, -1) <> 358
     or coalesce((priority_first_page #>> '{summary,authorityChanged}')::integer, -1) <> 1
     or jsonb_array_length(priority_first_page -> 'candidates') <> 80
     or priority_first_page #>> '{candidates,0,mappingKey}' <> priority_authority_mapping_key
     or priority_first_page #>> '{candidates,0,status}' <> 'authority_changed'
     or priority_first_page #>> '{candidates,0,nextStartsAt}' <> '2026-08-21T00:00:00.000Z'
     or priority_first_page ->> 'nextCursor' is null then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_priority_get_performance_failed';
  end if;

  priority_authority_page := public.get_jiaowubao_direct_schedule_mapping_priority_review(
    'jiaowubao-snapshot-performance-secret',
    timestamptz '2026-08-20 00:00:00+00',
    timestamptz '2026-10-22 00:00:00+00',
    1,
    null
  );
  priority_after_authority_page := public.get_jiaowubao_direct_schedule_mapping_priority_review(
    'jiaowubao-snapshot-performance-secret',
    timestamptz '2026-08-20 00:00:00+00',
    timestamptz '2026-10-22 00:00:00+00',
    1,
    priority_authority_page ->> 'nextCursor'
  );
  if priority_authority_page #>> '{candidates,0,mappingKey}' <> priority_authority_mapping_key
     or priority_authority_page #>> '{candidates,0,status}' <> 'authority_changed'
     or priority_authority_page #>> '{candidates,0,nextStartsAt}' <> '2026-08-21T00:00:00.000Z'
     or priority_authority_page ->> 'nextCursor' is null
     or priority_after_authority_page #>> '{candidates,0,status}' <> 'unmapped'
     or priority_after_authority_page #>> '{candidates,0,nextStartsAt}' <> '2026-08-20T00:00:00.000Z'
     or priority_after_authority_page #>> '{candidates,0,mappingKey}' = priority_authority_mapping_key then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_priority_status_cursor_order_failed';
  end if;

  started_at := clock_timestamp();
  priority_cursor_page := public.get_jiaowubao_direct_schedule_mapping_priority_review(
    'jiaowubao-snapshot-performance-secret',
    timestamptz '2026-08-20 00:00:00+00',
    timestamptz '2026-10-22 00:00:00+00',
    80,
    priority_first_page ->> 'nextCursor'
  );
  elapsed_ms := extract(epoch from (clock_timestamp() - started_at)) * 1000;
  priority_cursor_elapsed_ms := elapsed_ms;
  if elapsed_ms > 500
     or jsonb_array_length(priority_cursor_page -> 'candidates') <> 80
     or priority_cursor_page #>> '{candidates,0,mappingKey}' = priority_first_page #>> '{candidates,0,mappingKey}' then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_priority_cursor_performance_failed';
  end if;

  -- Walk every keyset page to prove deterministic ordering, no duplicate
  -- candidate key across pages, and full 359-pair coverage rather than merely
  -- validating the first cursor hop.
  loop
    page_number := page_number + 1;
    if page_number > 6 then
      raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_snapshot_pagination_loop_failed';
    end if;
    page_payload := public.get_jiaowubao_direct_schedule_mapping_review(
      'jiaowubao-snapshot-performance-secret', 80, page_cursor
    );
    select coalesce(array_agg(candidate.value ->> 'mappingKey'), ARRAY[]::text[])
    into fetched_mapping_keys
    from jsonb_array_elements(page_payload -> 'candidates') candidate(value);
    if cardinality(fetched_mapping_keys) = 0
       or exists (
         select 1
         from unnest(fetched_mapping_keys) fetched(mapping_key)
         where fetched.mapping_key = any(seen_mapping_keys)
       ) then
      raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_snapshot_pagination_duplicate_failed';
    end if;
    seen_mapping_keys := seen_mapping_keys || fetched_mapping_keys;
    page_cursor := page_payload ->> 'nextCursor';
    exit when page_cursor is null;
  end loop;
  if cardinality(seen_mapping_keys) <> 359
     or (select count(*) from (select distinct unnest(seen_mapping_keys)) mapping_key) <> 359 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_snapshot_pagination_coverage_failed';
  end if;

  select candidate.mapping_key into first_mapping_key
  from internal.jiaowubao_direct_schedule_mapping_candidates(test_run_id) candidate
  where candidate.mapping_key <> priority_authority_mapping_key
  order by candidate.mapping_key
  limit 1;
  started_at := clock_timestamp();
  receipt := public.put_jiaowubao_direct_schedule_label_mapping(
    'jiaowubao-snapshot-performance-secret',
    first_mapping_key,
    '10000000-0000-4000-8000-000000000001'::uuid,
    'confirm',
    'snapshot-performance-teacher',
    'Snapshot Performance Subject',
    2,
    'Nixon'
  );
  elapsed_ms := extract(epoch from (clock_timestamp() - started_at)) * 1000;
  put_elapsed_ms := elapsed_ms;
  if elapsed_ms > 500
     or receipt ->> 'unchanged' <> 'false'
     or (select count(*) from internal.jiaowubao_direct_schedule_label_mapping_decisions) <> 2 then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_snapshot_put_performance_failed';
  end if;

  if exists (
    select 1
    from internal.jiaowubao_direct_schedule_events schedule_event
    where schedule_event.run_id = test_run_id
      and (schedule_event.teacher_resolution <> 'unresolved'
        or schedule_event.subject_resolution <> 'unresolved'
        or schedule_event.availability_effect <> 'display_only')
  ) then
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_snapshot_source_mutated';
  end if;
  -- A relevance manifest is the visible-complete marker.  Prove a missing
  -- manifest fails closed rather than returning an empty successful queue.
  perform set_config('session_replication_role', 'replica', true);
  delete from internal.jiaowubao_direct_schedule_mapping_relevance_manifests
  where run_id = test_run_id;
  perform set_config('session_replication_role', 'origin', true);
  begin
    perform public.get_jiaowubao_direct_schedule_mapping_priority_review(
      'jiaowubao-snapshot-performance-secret',
      timestamptz '2026-08-20 00:00:00+00',
      timestamptz '2026-10-22 00:00:00+00',
      80,
      null
    );
    raise exception using errcode = 'P0001', message = 'jiaowubao_schedule_mapping_priority_missing_manifest_not_rejected';
  exception when sqlstate '55000' then
    if sqlerrm <> 'jiaowubao_schedule_mapping_relevance_unavailable' then
      raise;
    end if;
  end;
  raise notice 'jiaowubao mapping snapshot: 39,743 events / 359 pairs; all-history GET=% ms, cursor=% ms, priority GET=% ms, priority cursor=% ms, PUT+guard=% ms',
    round(get_elapsed_ms, 3), round(cursor_elapsed_ms, 3), round(priority_get_elapsed_ms, 3), round(priority_cursor_elapsed_ms, 3), round(put_elapsed_ms, 3);
end;
$jiaowubao_schedule_mapping_snapshot_scale_assertions$;

rollback;
