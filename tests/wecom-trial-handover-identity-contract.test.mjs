import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../supabase/migrations/20260915000300_wecom_trial_handover_identity.sql",
  import.meta.url,
), "utf8");
const tolerantMigration = readFileSync(new URL(
  "../supabase/migrations/20260915000400_wecom_trial_handover_tolerant_identity.sql",
  import.meta.url,
), "utf8");
const archiveParser = readFileSync(new URL("../lib/wecom-archive.ts", import.meta.url), "utf8");
const botRouter = readFileSync(new URL("../lib/wecom-bot-routing.ts", import.meta.url), "utf8");
const reviewPage = readFileSync(new URL("../app/handover-review/page.tsx", import.meta.url), "utf8");

test("trial handovers have a private, group-scoped WeChat identity record", () => {
  assert.match(migration, /create table if not exists internal\.wecom_trial_handover_cases/i);
  assert.match(migration, /unique \(chat_id, wechat_name_key\)/i);
  assert.match(migration, /alter table internal\.wecom_trial_handover_cases enable row level security/i);
  assert.match(migration, /revoke all on table internal\.wecom_trial_handover_cases from public, anon, authenticated/i);
  assert.match(migration, /awaiting_student_name/i);
  assert.match(migration, /identity_conflict/i);
  assert.match(migration, /create or replace function internal\.wecom_identity_key/i);
  assert.match(migration, /hashtextextended\(archive\.chat_id \|\| chr\(31\) \|\| canonical_wechat_key/i);
});

test("the bot contract persists the explicit ownership hints and drives the identity case", () => {
  assert.match(migration, /operations_owner_hint/i);
  assert.match(migration, /course_planner_hint/i);
  assert.match(migration, /operationsOwnerHint/i);
  assert.match(migration, /coursePlannerHint/i);
  assert.match(migration, /wecom_trial_handover_bot_definition_drift/i);
  assert.match(migration, /wecom_trial_handover_archive_definition_drift/i);
  assert.match(migration, /create trigger sync_wecom_trial_handover_case/i);
  assert.match(migration, /internal\.upsert_wecom_trial_handover_case\(/i);
  assert.match(migration, /trial_identity_status/i);
  assert.match(migration, /trialAwaitingStudentName/i);
});

test("a later trial identity update tolerates only one obvious same-group WeChat candidate", () => {
  assert.match(tolerantMigration, /create or replace function internal\.wecom_trial_identity_core_key/i);
  assert.match(tolerantMigration, /pg_catalog\.char_length\(canonical_wechat_core_key\) >= 3/i);
  assert.match(tolerantMigration, /identity_match_mode := 'tolerant_unique'/i);
  assert.match(tolerantMigration, /identity_ambiguous/i);
  assert.match(tolerantMigration, /tolerantCandidateCount/i);
  assert.match(tolerantMigration, /hashtextextended\(archive\.chat_id, 0\)/i);
  assert.doesNotMatch(tolerantMigration, /insert\s+into\s+public\.ops_state/i);
});

test("the parser and bot route use explicit labels only", () => {
  assert.match(archiveParser, /GUARDIAN_WECHAT_LABELS = \["家长微信名", "家长微信", "微信名"\]/u);
  assert.match(archiveParser, /OPERATIONS_OWNER_LABELS/u);
  assert.match(archiveParser, /COURSE_PLANNER_LABELS/u);
  assert.match(botRouter, /metadata\.operationsOwnerHint/i);
  assert.match(botRouter, /metadata\.coursePlannerHint/i);
});

test("identity intake cannot create operational business state", () => {
  assert.doesNotMatch(migration, /insert\s+into\s+public\.ops_state/i);
  assert.doesNotMatch(migration, /create_student_with_tasks_atomic/i);
  assert.doesNotMatch(migration, /create_lp/i);
});

test("the existing full-admin handover review page surfaces trial identity state", () => {
  assert.match(reviewPage, /readWecomHandoverCases\(\{ filter: caseFilter, cursor: caseCursor \}\)/);
  assert.match(reviewPage, /试听身份交接/u);
  assert.match(reviewPage, /trialIdentityStatus\(row\.status\)/);
  assert.match(reviewPage, /casePage\.nextCursor/);
  assert.match(reviewPage, /试听身份记录暂时无法读取/u);
  assert.match(reviewPage, /微信名候选不唯一/u);
  assert.match(reviewPage, /轻微差异/u);
  assert.match(reviewPage, /hasFullAdminAccess/i);
});
