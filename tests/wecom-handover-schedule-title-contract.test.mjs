import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqlRuntimeFixtures } from "./sql/runtime-fixtures.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261021094454_version_wecom_handover_schedule_evidence.sql", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./sql/wecom-handover-schedule-title-runtime.sql", import.meta.url), "utf8");

test("title-only candidate contract preserves native validation and uses exact shared-event names", () => {
  assert.match(migration, /jsonb_typeof\(candidate -> 'studentId'\) not in \('string','null'\)/u);
  assert.match(migration, /title_only := candidate -> 'studentId' = 'null'::jsonb/u);
  assert.match(migration, /if entry ->> 'status' not in \('candidate','ambiguous'\) then/u);
  assert.match(migration, /title_name := internal\.wecom_schedule_title_student_name\(event ->> 'courseName'\)/u);
  assert.match(migration, /candidate ->> 'studentName' is distinct from title_name/u);
  assert.match(migration, /jsonb_array_length\(event -> 'sourceParticipants'\) = 0/u);
  assert.match(migration, /internal\.wecom_schedule_account_letter\(participant ->> 'label'\)\s+is distinct from account_metadata ->> 'sharedAccountLetter'/u);
  assert.match(migration, /student ->> 'name' is distinct from candidate ->> 'studentName'/u);
  assert.match(migration, /coalesce\(s ->> 'importArchived','false'\) <> 'true'/u);
  assert.match(migration, /schedule ->> 'studentName' is distinct from candidate ->> 'studentName'/u);
  assert.match(migration, /source -> 'confirmed' <> 'null'::jsonb/u);
  assert.match(migration, /source ->> 'status' in \('identity_conflict','identity_ambiguous'\)/u);
  assert.match(migration, /where case when candidate -> 'studentId' = 'null'::jsonb then not p_full_admin else not exists/u);
  assert.doesNotMatch(migration, /(?:insert into|update|delete from) public\.ops_state|insert into internal\.wecom_lp_confirmations|update internal\.wecom_archive_messages/u);
});

test("title and keycap helpers stay private with bounded parser and suffix support", () => {
  assert.match(migration, /revoke all on function internal\.wecom_schedule_title_student_name\(text\) from public, anon, authenticated, service_role/u);
  assert.match(migration, /revoke all on function internal\.wecom_schedule_account_letter\(text\) from public, anon, authenticated, service_role/u);
  assert.ok(migration.includes("U&'^(?:[试视]听"));
  assert.ok(migration.includes("[[:digit:]\\FE0F\\20E3]*"));
  assert.ok(migration.includes("from '^.*[-–—][[:space:]]+(.{1,80}?)[[:space:]]*试听"));
  assert.ok(migration.includes("^[A-Za-z ''’.一-鿿-]+$"));
  assert.ok(migration.includes("unknown|tbd|na|none|null|student|unknownstudent|newstudent|trialstudent|placeholder|pending|notprovided|notknown"));
  assert.match(migration, /english\|mathematics\|maths\?\|verbalreasoning\|reading\|writing\|science\|physics\|chemistry\|biology\|aes\|trial/u);
  assert.match(migration, /statement_timeout = '12s' set work_mem = '32MB' set enable_indexscan = off/u);
  assert.match(migration, /statement_timeout = '13s' set work_mem = '32MB'/u);
});

test("title fixture exercises persisted null candidates, all-or-none privacy, and forged metadata rollback", () => {
  assert.equal(sqlRuntimeFixtures.find(({ id }) => id === "wecom-handover-schedule-title")?.source, "tests/sql/wecom-handover-schedule-title-runtime.sql");
  assert.ok(runtime.includes("\\ir wecom-handover-schedule-algorithm-runtime.sql"));
  for (const condition of [
    "title_supported_subset_differed", "title_generic_or_unsupported_name_accepted", "title_keycap_account_not_recognized",
    "title_account_invalid_suffix_accepted", "title_private_helper_exposed", "title_candidate_fixture_missing_historical_shared_metadata",
    "title_candidate_save_or_fulladmin_visibility_failed", "title_idempotence_created_records",
    "title_invalid_candidate_accepted", "title_invalid_candidate_partially_saved",
    "title_native_candidate_branch_changed", "title_mixed_candidates_leaked_partial_evidence", "title_candidate_modified_business_identity",
  ]) assert.ok(runtime.includes(condition), condition);
  for (const scenario of ["title-generic", "title-placeholder", "title-no-delimiter", "title-nonshared", "title-mixed",
    "title-multiple", "title-empty", "title-truncated", "forged-name", "forged-schedule-name", "forged-letter",
    "forged-planner", "matched", "no_match", "empty-id", "unknown-id", "forged-run", "forged-time"]) assert.ok(runtime.includes(scenario), scenario);
});
