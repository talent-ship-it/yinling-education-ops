import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, canonicalPatch, transition, client, importDomain] = await Promise.all([
  readFile(new URL("../supabase/migrations/20260817000100_assign_student_numbers_from_jwb.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20260817000200_student_import_number_canonical_projection.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/ops-state-transition.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/student-import.ts", import.meta.url), "utf8"),
]);

test("student numbers are allocated by internal database functions, not the browser", () => {
  assert.match(migration, /before insert or update of payload on public\.ops_state/i);
  assert.match(migration, /current_timestamp at time zone 'Australia\/Melbourne'/);
  assert.match(migration, /create or replace function internal\.student_import_assign_student_numbers\(p_students jsonb\)/i);
  assert.match(migration, /create or replace function internal\.assign_new_student_numbers\(\)/i);
  assert.match(migration, /create table internal\.student_number_reservations/i);
  assert.match(migration, /student_number_reservation_snapshot/);
  assert.match(migration, /alter table internal\.student_number_reservations enable row level security/i);
  assert.match(migration, /revoke all on table internal\.student_number_reservations from public, anon, authenticated/i);
  assert.match(migration, /student_number_immutable/);
  assert.match(migration, /student_number_server_assigned/);
  assert.match(migration, /student_number_reservation_conflict/);
  assert.match(migration, /student_number_reserved_identity/);
  assert.match(migration, /student_number_daily_sequence_exhausted/);
  assert.match(migration, /student_number_jwb_date_fixture_failed/);
  assert.match(migration, /student_number_reservation_restore_fixture_failed/);
  assert.match(migration, /student_number_utf16_sort_fixture_failed/);
  assert.match(migration, /student_number_trigger_restore_fixture_failed/);
  assert.match(migration, /student_number_manual_fixture_failed/);
  assert.match(migration, /student_number_formal_fixture_failed/);
  assert.match(migration, /student_number_forged_fixture_missing/);
  assert.match(migration, /firstJwbHourEntryDate/);
  assert.match(migration, /YYYYMMDD \+ a same-day three-digit serial/);
  assert.match(migration, /internal\.student_import_utf16_sort_key\(student\.value ->> 'id'\)/);
  assert.match(migration, /revoke all on function internal\.student_import_assign_student_numbers\(jsonb\)[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /revoke all on function internal\.assign_new_student_numbers\(\)[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /lock table public\.ops_state in access exclusive mode nowait/i);
  assert.match(migration, /student_number_migration_ops_state_busy/);
  assert.match(migration, /student_number_trigger_already_exists/);
  assert.match(migration, /ops_state_assign_student_numbers_from_jwb/);
  assert.doesNotMatch(migration, /drop\s+trigger/i);
  const lockGate = migration.indexOf("do $student_number_ops_state_lock$");
  const triggerPreflight = migration.indexOf("do $student_number_trigger_preflight$");
  const triggerCreate = migration.indexOf("create trigger ops_state_assign_new_student_numbers");
  const backfill = migration.indexOf("do $student_number_reservation_backfill$");
  assert.ok(
    lockGate >= 0 && triggerPreflight > lockGate && triggerCreate > triggerPreflight && backfill > triggerCreate,
    "the no-wait table lock and trigger must be installed before the initial students row lock",
  );
  assert.doesNotMatch(client, /function nextStudentNumber\b/);
  assert.doesNotMatch(client, /studentNumber:\s*nextStudentNumber/);
});

test("the formal import's canonical commit and replay apply the same number projection", () => {
  assert.match(canonicalPatch, /student_import_managed_fields[\s\S]*firstJwbHourEntryDate/i);
  assert.match(canonicalPatch, /put_student_import_source_rows\(text,text,text,text,jsonb,text\)/i);
  assert.match(canonicalPatch, /student_import_canonical_projection\(text,jsonb,jsonb,jsonb,jsonb,jsonb\)/i);
  assert.match(canonicalPatch, /student_number_source_allowed_fields_anchor_mismatch/);
  assert.match(canonicalPatch, /student_number_source_date_anchor_mismatch/);
  assert.match(canonicalPatch, /studentNumberReservations/);
  assert.match(canonicalPatch, /student_number_snapshot_patch_anchor_mismatch/);
  assert.match(canonicalPatch, /student_number_snapshot_patch_verification_failed/);
  assert.match(canonicalPatch, /student_number_projection_patch_anchor_mismatch/);
  assert.match(canonicalPatch, /commit_student_import_plan_atomic\(text,text,bigint,jsonb,jsonb,text\)/i);
  assert.match(canonicalPatch, /get_student_import_commit_replay_result\(text,text,bigint,text\)/i);
  assert.match(canonicalPatch, /expected_students := internal\.student_import_assign_student_numbers\(expected_students\);/i);
  assert.match(canonicalPatch, /student_number_commit_patch_anchor_mismatch/);
  assert.match(canonicalPatch, /student_number_replay_patch_anchor_mismatch/);
  assert.match(canonicalPatch, /student_number_commit_patch_verification_failed/);
  assert.match(canonicalPatch, /student_number_replay_patch_verification_failed/);
  assert.match(canonicalPatch, /lock table internal\.student_number_reservations in share mode/i);
  assert.match(canonicalPatch, /student_number_commit_reservation_lock_missing/);
  assert.match(canonicalPatch, /student_number_replay_reservation_lock_missing/);
});

test("generic client writes cannot choose, alter, or forge a historical number", () => {
  const allocation = transition.slice(transition.indexOf("function assertStudentsTransition"));
  assert.match(allocation, /!existing && studentNumber !== undefined[\s\S]*新建学生的学生编号由服务器自动分配/);
  assert.match(allocation, /existing\.studentNumber === undefined && studentNumber !== undefined[\s\S]*学生编号只能由服务器补发/);
  assert.match(allocation, /existing\.studentNumber !== undefined && !same\(existing\.studentNumber, studentNumber\)/);
  assert.match(allocation, /!existing && Object\.hasOwn\(student, "importSource"\)[\s\S]*正式导入标记只能由正式导入流程写入/);
  assert.match(allocation, /existing && !same\(existing\.importSource, student\.importSource\)[\s\S]*学生导入来源只能由正式导入流程修改/);
});

test("the generic client applies server-assigned student fields after a successful write", () => {
  const hook = client.slice(client.indexOf("function useSharedState"), client.indexOf("function nowLabel"));
  assert.match(hook, /const localAfterSubmit = valueRef\.current/);
  assert.match(hook, /const hasNewerLocalChanges = JSON\.stringify\(localAfterSubmit\) !== payloadSerialized/);
  assert.match(hook, /\? mergeConcurrentPayload\(payload, localAfterSubmit, row\.payload\)/);
  assert.match(hook, /: \{ value: row\.payload, conflicts: 0 \}/);
  assert.match(hook, /committedRef\.current = JSON\.stringify\(row\.payload\)/);
  assert.match(hook, /valueRef\.current = merged\.value/);
  assert.match(hook, /setValue\(merged\.value\)/);
  assert.doesNotMatch(hook, /committedRef\.current = payloadSerialized/);
});

test("the import domain derives a historical number date from the first positive JWB contract", () => {
  assert.match(importDomain, /earliest positive JWB contract date/);
  assert.match(importDomain, /assignStudentNumbers/);
  assert.match(importDomain, /firstJwbHourEntryDate/);
  assert.match(importDomain, /dateKeyForStudentNumber/);
  assert.match(importDomain, /studentNumberReservations/);
  assert.match(importDomain, /formalImportDate is required to number a master student/);
  assert.match(importDomain, /studentNumberDateSource/);
});
