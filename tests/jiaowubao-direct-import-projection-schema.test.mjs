import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260819000100_create_jiaowubao_direct_import_projection.sql",
    import.meta.url,
  ),
  "utf8",
);

test("direct Jiaowubao import is an internal, non-operational projection", () => {
  assert.match(migration, /create table if not exists internal\.jiaowubao_direct_import_runs/i);
  assert.match(migration, /create table if not exists internal\.jiaowubao_direct_import_workbooks/i);
  assert.match(migration, /create table if not exists internal\.jiaowubao_direct_import_chunks/i);
  assert.match(migration, /create table if not exists internal\.jiaowubao_direct_supplemental_records/i);
  assert.match(migration, /create table if not exists internal\.jiaowubao_direct_schedule_events/i);
  assert.match(migration, /create table if not exists internal\.jiaowubao_direct_schedule_event_participants/i);
  assert.match(migration, /create table if not exists internal\.jiaowubao_direct_leave_makeup_events/i);
  assert.doesNotMatch(migration, /\b(?:insert\s+into|update|delete\s+from)\s+public\.ops_state\b/i);
  assert.doesNotMatch(migration, /create(?:\s+or\s+replace)?\s+function\s+public\./i);
  assert.doesNotMatch(migration, /create(?:\s+or\s+replace)?\s+table\s+public\./i);
  assert.match(migration, /Trust boundary: PostgreSQL preserves and reconciles/i);
  assert.match(migration, /Only the reviewed local preflight\/CLI may construct this internal contract/i);
});

test("the direct-import contract is private, reconciled, and immutable after completion", () => {
  const rlsTables = [
    "jiaowubao_direct_import_runs",
    "jiaowubao_direct_import_workbooks",
    "jiaowubao_direct_import_chunks",
    "jiaowubao_direct_supplemental_records",
    "jiaowubao_direct_schedule_events",
    "jiaowubao_direct_schedule_event_participants",
    "jiaowubao_direct_leave_makeup_events",
  ];
  for (const table of rlsTables) {
    assert.match(migration, new RegExp(`alter table internal\\.${table} enable row level security`, "i"));
    assert.match(migration, new RegExp(`revoke all on table internal\\.${table} from public, anon, authenticated`, "i"));
  }
  assert.match(migration, /expected_counts \?& ARRAY\['supplementalRecords', 'scheduleEvents', 'scheduleParticipants', 'leaveMakeups'\]/i);
  assert.match(migration, /jiaowubao_direct_import_record_counts_mismatch/i);
  assert.match(migration, /jiaowubao_direct_import_workbook_manifest_incomplete/i);
  assert.match(migration, /jiaowubao_direct_import_block_participants_unresolved/i);
  assert.match(migration, /jiaowubao_direct_import_run_read_only/i);
  assert.match(migration, /jiaowubao_direct_import_supplemental_read_only/i);
  assert.match(migration, /jiaowubao_direct_import_schedule_read_only/i);
  assert.match(migration, /jiaowubao_direct_import_chunk_read_only/i);
});

test("Tencent and Melbourne time rules gate all attachable data and AVA blocks", () => {
  assert.match(migration, /source_timezone = 'Australia\/Melbourne'/i);
  assert.match(migration, /jiaowubao_direct_import_master_source_changed/i);
  assert.match(migration, /jiaowubao_direct_import_excluded_master_forbidden/i);
  assert.match(migration, /internal\.student_import_name_key\(matching_name\).*student_import_name_key\(p_evidence_name\)/is);
  assert.match(migration, /dst_resolution = 'unambiguous'/i);
  assert.match(migration, /time_parse_status = 'parsed'[\s\S]*?teacher_resolution = 'exact_name'/i);
  assert.match(migration, /availability_effect = 'blocks_teacher_ava'/i);
  assert.match(migration, /create or replace view internal\.jiaowubao_direct_current_schedule_blocks/i);
  assert.match(migration, /student_id text/i);
  assert.match(migration, /jiaowubao_direct_import_student_id_not_current_tencent_record/i);
  assert.match(migration, /jiaowubao_direct_import_teacher_id_not_exact_current_record/i);
  assert.match(migration, /tstzrange\(schedule_event\.starts_at, schedule_event\.ends_at, '\[\)'\) as occupied_range/i);
  assert.match(migration, /as student_ids/i);
});

test("duplicate names cannot attach, and schedule names inherit only a phone-proven canonical identity", () => {
  assert.match(migration, /matching_active_name_count/i);
  assert.match(migration, /jiaowubao_direct_import_attachment_name_ambiguous/i);
  assert.match(migration, /evidence_phone text/i);
  assert.match(migration, /identity_proof boolean not null default false/i);
  assert.match(migration, /jiaowubao_direct_supplemental_canonical_identity_idx/i);
  assert.match(migration, /jiaowubao_direct_import_supplemental_phone_evidence_invalid/i);
  assert.match(migration, /jiaowubao_direct_import_supplemental_name_evidence_invalid/i);
  assert.match(migration, /jiaowubao_direct_import_leave_makeup_name_evidence_invalid/i);
  assert.match(migration, /jiaowubao_direct_import_schedule_participant_name_evidence_invalid/i);
  assert.match(migration, /jiaowubao_direct_import_schedule_participant_identity_invalid/i);
  assert.match(migration, /identity_record\.identity_proof is not true/i);
  assert.match(migration, /identity_supplemental_record_id bigint/i);
  assert.match(migration, /source_payload #> '\{source,studentDisplayNames\}'/i);
  assert.match(migration, /jiaowubao_direct_import_schedule_participant_coverage_invalid/i);
  assert.match(
    migration,
    /jiaowubao_direct_import_participant_guard\$[\s\S]*?assert_schedule_participant_identity\(/i,
  );
  assert.match(migration, /jiaowubao_direct_supplemental_source_coordinate_idx/i);
  assert.match(migration, /jiaowubao_direct_schedule_source_coordinate_idx/i);
  assert.match(migration, /jiaowubao_direct_leave_makeup_source_coordinate_idx/i);
});

test("completion is the locked, set-based authority gate rather than a per-row Tencent scan", () => {
  assert.match(migration, /jiaowubao_direct_import_assert_staging\$[\s\S]*?for update;/i);
  assert.match(migration, /jiaowubao_direct_import_assert_complete\$[\s\S]*?for update;/i);
  assert.match(migration, /create or replace function internal\.jiaowubao_direct_import_validate_projection/i);
  assert.match(migration, /master_rows as materialized/i);
  assert.match(migration, /current_students as materialized/i);
  assert.match(migration, /current_teachers as materialized/i);
  assert.match(migration, /pg_catalog\.generate_series\(-720, 840, 15\)/i);
  assert.match(migration, /jiaowubao_direct_import_schedule_time_proof_invalid/i);
  assert.match(migration, /jiaowubao_direct_import_teacher_name_ambiguous/i);
  assert.match(migration, /jiaowubao_direct_import_subject_resolution_not_yet_authoritative/i);
  assert.match(migration, /persisted_source_counts as/i);
  assert.match(migration, /jiaowubao_direct_import_source_kind_counts_mismatch/i);
  assert.match(migration, /persisted_workbook_counts as/i);
  assert.match(migration, /jiaowubao_direct_import_workbook_row_counts_mismatch/i);
  assert.match(migration, /when 'contract' then 'contract_history'/i);
  const beginFunction = migration.match(
    /create or replace function internal\.begin_jiaowubao_direct_import[\s\S]*?\$begin_jiaowubao_direct_import\$;/i,
  )?.[0] ?? "";
  assert.match(beginFunction, /nonlocking snapshot check/i);
  assert.doesNotMatch(beginFunction, /for share;/i);
  const completionFunction = migration.match(
    /create or replace function internal\.jiaowubao_direct_import_assert_complete[\s\S]*?\$jiaowubao_direct_import_assert_complete\$;/i,
  )?.[0] ?? "";
  assert.match(completionFunction, /from internal\.student_import_source_rows[\s\S]*?for share;/i);
});

test("only internal CLI helpers can create, stage, audit, and atomically complete a run", () => {
  for (const helper of [
    "begin_jiaowubao_direct_import",
    "stage_jiaowubao_direct_import_chunk",
    "complete_jiaowubao_direct_import",
    "apply_jiaowubao_direct_import_atomic",
  ]) {
    assert.match(migration, new RegExp(`create or replace function internal\\.${helper}`, "i"));
    assert.match(migration, new RegExp(`revoke all on function internal\\.${helper}`, "i"));
  }
  assert.doesNotMatch(migration, /grant execute on function internal\./i);
  assert.match(migration, /jiaowubao-direct-staging-v1/i);
  assert.match(migration, /jiaowubao_direct_import\.started/i);
  assert.match(migration, /jiaowubao_direct_import\.chunk_staged/i);
  assert.match(migration, /jiaowubao_direct_import\.completed/i);
  assert.match(migration, /jiaowubao_direct_import_chunk_projection_proof_invalid/i);
  assert.match(migration, /jiaowubao_direct_import_raw_record_digest_proof_invalid/i);
  assert.match(migration, /jiaowubao_direct_import_expected_counts_source_mismatch/i);
  assert.match(migration, /jiaowubao_direct_import_completion_audit_invalid/i);
  assert.match(migration, /small-fixture and exact-replay convenience entrypoint/i);
  assert.match(migration, /Production import transaction contract/i);
  assert.match(migration, /BEGIN;[\s\S]*?begin_jiaowubao_direct_import[\s\S]*?stage_jiaowubao_direct_import_chunk[\s\S]*?complete_jiaowubao_direct_import[\s\S]*?COMMIT;/i);
  assert.match(migration, /must never commit a partial sequence or use a browser\/Data API/i);
});

test("a nonempty staged record retains the complete hashed preflight envelope", () => {
  // Completion recomputes the preflight record digest from this private copy of
  // the source record. Keeping studentRelationship is important: it is part of
  // every direct-staging-v1 record and omitting it would make every nonempty
  // run fail only at completion.
  const persistedEnvelopeFields = migration.match(
    /'studentRelationship', raw_record -> 'studentRelationship'/g,
  ) ?? [];
  assert.equal(persistedEnvelopeFields.length, 3);
  assert.match(
    migration,
    /record\.source_payload #> '\{_directImport,studentRelationship\}'/i,
  );
  assert.match(
    migration,
    /schedule_event\.source_payload #> '\{_directImport,studentRelationship\}'/i,
  );
  assert.match(
    migration,
    /leave_makeup_event\.source_payload #> '\{_directImport,studentRelationship\}'/i,
  );
  assert.match(migration, /jiaowubao_direct_import_raw_record_digest_proof_invalid/i);
});

test("an identical completed atomic request replays only against its immutable chunk ledger", () => {
  assert.match(
    migration,
    /if saved_run\.state = 'complete' then[\s\S]*?jiaowubao_direct_import_completed_replay_mismatch/is,
  );
  assert.match(migration, /persisted_chunks as materialized/i);
  assert.match(migration, /extensions\.digest\(\(item\.value -> 'chunk'\)::text, 'sha256'\)/i);
  assert.match(migration, /extensions\.digest\(\(item\.value -> 'projection'\)::text, 'sha256'\)/i);
  assert.match(migration, /persisted\.chunk_sha256 <> supplied\.chunk_sha256/i);
  assert.match(migration, /persisted\.projection_sha256 <> supplied\.projection_sha256/i);
  assert.match(migration, /'replayed', true/i);
});
