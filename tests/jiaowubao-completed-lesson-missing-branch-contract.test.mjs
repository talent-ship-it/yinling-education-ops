import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const branch = read("lib/jiaowubao-completed-lesson-branch.ts");
const lesson = read("lib/jiaowubao-completed-lessons.ts");
const reconciliation = read("lib/jiaowubao-completed-lesson-reconciliation.ts");
const browser = read("app/jiaowubao-completed-month-evidence.ts");
const migration = read("supabase/migrations/20260904000400_allow_missing_completed_lesson_branch_review_only.sql");

test("unknown branch uses an old-client-incompatible marker and never participates in reconciliation", () => {
  assert.match(branch, /UNKNOWN_BRANCH_ID = "~"/);
  assert.match(lesson, /missingCompletedLessonSourceBranch/);
  assert.match(lesson, /value === JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID[\s\S]*string-reserved/);
  assert.match(reconciliation, /isJiaowubaoCompletedLessonUnknownBranchId\(sample\.branchId\)[\s\S]*lessonOnlyPlan\("branch_ambiguous"/);
  assert.match(reconciliation, /!isJiaowubaoCompletedLessonUnknownBranchId\(groups\[0\]!\[0\]!\.branchId\)/);
  assert.match(browser, /LESSON_KEY = \/\^jwb-open-api:lesson:\(\?:~\|/);
  assert.match(browser, /sourceBranchComponent\(item\.branchId\)/);
});

test("forward migration allows only exact unknown branch while keeping calendar and member IDs strict", () => {
  assert.match(migration, /alter table internal\.jiaowubao_completed_lesson_snapshot_items[\s\S]*source_key_check/);
  assert.match(migration, /alter table internal\.jiaowubao_completed_lesson_member_items[\s\S]*source_key_check/);
  assert.match(migration, /create or replace function internal\.assert_jiaowubao_completed_lesson_snapshot_page/);
  assert.match(migration, /jsonb_typeof\(wrapper -> 'record' -> 'branchId'\) is distinct from 'string'/);
  assert.match(migration, /jsonb_typeof\(wrapper -> 'record' -> 'calendarId'\) is distinct from 'string'/);
  assert.match(migration, /jsonb_typeof\(wrapper -> 'record' -> 'memberId'\) is distinct from 'string'/);
  assert.match(migration, /branchId',''\) !~ '\^\(~\|\[A-Za-z0-9\]/);
  assert.match(migration, /calendarId',''\) ~ '\^0\+\$'/);
  assert.match(migration, /memberId',''\) ~ '\^0\+\$'/);
  assert.match(migration, /unique/iu, "migration comments must preserve the existing source-key uniqueness contract");
  assert.doesNotMatch(migration, /drop (?:index|constraint)[^;]*(?:unique|source_key_key)/iu);
});
