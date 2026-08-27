import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260819001100_resume_jiaowubao_direct_import_chunks.sql",
    import.meta.url,
  ),
  "utf8",
);
const fixture = await readFile(
  new URL("./sql/jiaowubao-direct-import-resume-contract.sql", import.meta.url),
  "utf8",
);
const stageFixture = await readFile(
  new URL("./sql/jiaowubao-direct-import-stage-performance.sql", import.meta.url),
  "utf8",
);

test("011 makes staging resumable without exposing incomplete runs", () => {
  assert.match(migration, /add column if not exists aborted_at timestamptz/i);
  assert.match(migration, /state in \('staging', 'complete', 'aborted'\)/i);
  assert.match(
    migration,
    /create unique index if not exists jiaowubao_direct_import_runs_active_revision_key[\s\S]*?where state in \('staging', 'complete'\)/i,
  );
  const beginFunction = migration.match(
    /create or replace function internal\.begin_jiaowubao_direct_import[\s\S]*?\$begin_jiaowubao_direct_import\$;/i,
  )?.[0] ?? "";
  assert.match(beginFunction, /run_state\.state in \('staging', 'complete'\)/i);
  assert.match(beginFunction, /pg_catalog\.pg_advisory_xact_lock/i);
  assert.match(migration, /committed staging evidence remains invisible to application reads/i);
  assert.match(migration, /create or replace function internal\.abort_jiaowubao_direct_import\(/i);
  assert.match(migration, /jiaowubao_direct_import\.aborted/i);
  assert.match(migration, /set_config\('internal\.jiaowubao_direct_import_abort_run_id'/i);
  assert.match(migration, /revoke all on function internal\.abort_jiaowubao_direct_import\(uuid, text\)\s+from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /security definer|grant\s+execute|create\s+(?:or\s+replace\s+)?function\s+public\./i);
});

test("011 replaces hot schedule INSERT row guards with transition-table proofs and keeps immutable mutation guards", () => {
  assert.match(
    migration,
    /after insert on internal\.jiaowubao_direct_schedule_events\s+referencing new table as inserted_schedule_events\s+for each statement/i,
  );
  assert.match(
    migration,
    /after insert on internal\.jiaowubao_direct_schedule_event_participants\s+referencing new table as inserted_schedule_participant\s+for each statement/i,
  );
  const scheduleInsertGuard = migration.match(
    /create or replace function internal\.jiaowubao_direct_import_schedule_insert_guard\(\)[\s\S]*?\$jiaowubao_direct_import_schedule_insert_guard\$;/i,
  )?.[0] ?? "";
  const participantInsertGuard = migration.match(
    /create or replace function internal\.jiaowubao_direct_import_participant_insert_guard\(\)[\s\S]*?\$jiaowubao_direct_import_participant_insert_guard\$;/i,
  )?.[0] ?? "";
  assert.match(scheduleInsertGuard, /select distinct inserted_schedule_event\.run_id/i);
  assert.match(scheduleInsertGuard, /jiaowubao_direct_import_assert_staging\(parent_run_id\)/i);
  assert.match(participantInsertGuard, /select distinct schedule_event\.run_id/i);
  assert.match(participantInsertGuard, /jiaowubao_direct_import_assert_staging\(parent_run_id\)/i);
  assert.match(participantInsertGuard, /jiaowubao_direct_import_schedule_participant_name_evidence_invalid/i);
  assert.match(participantInsertGuard, /jiaowubao_direct_import_schedule_participant_identity_invalid/i);
  assert.match(migration, /before update or delete on internal\.jiaowubao_direct_schedule_events/i);
  assert.match(migration, /before update or delete on internal\.jiaowubao_direct_schedule_event_participants/i);
  assert.match(migration, /jiaowubao_direct_import_assert_aborted\(old\.run_id\)/i);
  assert.match(migration, /jiaowubao_direct_import_assert_aborted\(parent_run_id\)/i);
});

test("local rollback fixtures cover performance, exact replay, abort cleanup, and same-revision reopen", () => {
  assert.match(fixture, /^\\set ON_ERROR_STOP on/m);
  assert.match(fixture, /^begin;$/im);
  assert.match(fixture, /20260819001100_resume_jiaowubao_direct_import_chunks\.sql/i);
  assert.match(fixture, /jiaowubao_direct_import_chunk_sequence_gap/i);
  assert.match(fixture, /jiaowubao_direct_import_resume_replay_failed/i);
  assert.match(fixture, /internal\.abort_jiaowubao_direct_import\(/i);
  assert.match(fixture, /abort:schedule:0/i);
  assert.match(fixture, /abort:participant:0/i);
  assert.match(fixture, /jiaowubao_direct_import_abort_cleanup_failed/i);
  assert.match(fixture, /jiaowubao_direct_import_abort_resume_failed/i);
  assert.match(fixture, /^rollback;$/im);
  assert.doesNotMatch(fixture, /^commit;$/im);

  assert.match(stageFixture, /20260819001100_resume_jiaowubao_direct_import_chunks\.sql/i);
  assert.match(stageFixture, /1499 events \+ 1499 participants \+ 1 identity/i);
});
