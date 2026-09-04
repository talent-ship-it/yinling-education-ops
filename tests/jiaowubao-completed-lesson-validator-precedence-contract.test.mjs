import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dualSourceMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260903000300_upgrade_jiaowubao_completed_month_evidence.sql"),
  "utf8",
);
const missingBranchMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260904000400_allow_missing_completed_lesson_branch_review_only.sql"),
  "utf8",
);
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260904000500_fix_completed_lesson_validator_json_projection.sql"),
  "utf8",
);

const LESSON_VALIDATOR = "internal.assert_jiaowubao_completed_lesson_snapshot_page";
const SCHEDULE_VALIDATOR = "internal.assert_jiaowubao_completed_lesson_snapshot_schedule_page";

function functionDefinition(source, name) {
  const start = source.indexOf(`create or replace function ${name}(`);
  const end = source.indexOf("\n$$;", start);
  assert.ok(start >= 0 && end > start, `missing ${name}`);
  return source.slice(start, end + 4);
}

function normalizeSql(source) {
  return source.replace(/\s+/gu, " ").trim();
}

function expectedPrecedenceFix(source) {
  return source
    .replaceAll("wrapper -> 'record' - ARRAY", "(wrapper -> 'record') - ARRAY")
    .replace(
      /not \(wrapper -> 'record' \?& (ARRAY\[[^\n]+\]::text\[\])\)/gu,
      "not ((wrapper -> 'record') ?& $1)",
    )
    .replace(
      "wrapper -> 'record' ->> 'sourceKey' is distinct from 'jwb-open-api:lesson:' || wrapper -> 'record' ->> 'branchId' || ':' || wrapper -> 'record' ->> 'calendarId' || ':' || wrapper -> 'record' ->> 'memberId'",
      "(wrapper -> 'record' ->> 'sourceKey') is distinct from ( 'jwb-open-api:lesson:' || (wrapper -> 'record' ->> 'branchId') || ':' || (wrapper -> 'record' ->> 'calendarId') || ':' || (wrapper -> 'record' ->> 'memberId') )",
    )
    .replace(
      "wrapper -> 'record' ->> 'sourceKey' is distinct from 'jwb-open-api:schedule:' || wrapper -> 'record' ->> 'calendarId'",
      "(wrapper -> 'record' ->> 'sourceKey') is distinct from ( 'jwb-open-api:schedule:' || (wrapper -> 'record' ->> 'calendarId') )",
    );
}

test("completed lesson validators parenthesize JSON extraction across mixed operators", () => {
  assert.match(migration, /^begin;/u);
  assert.match(migration, /create or replace function internal\.assert_jiaowubao_completed_lesson_snapshot_page/);
  assert.match(migration, /create or replace function internal\.assert_jiaowubao_completed_lesson_snapshot_schedule_page/);
  assert.equal([...migration.matchAll(/\(wrapper -> 'record'\) - ARRAY/gu)].length, 2);
  assert.equal([...migration.matchAll(/\(wrapper -> 'record'\) \?& ARRAY/gu)].length, 2);
  assert.doesNotMatch(migration, /\bor wrapper -> 'record' - ARRAY/u);
  assert.doesNotMatch(migration, /\bor not \(wrapper -> 'record' \?& ARRAY/u);
  assert.doesNotMatch(migration, /\|\| wrapper -> 'record'/u);
  assert.equal([...migration.matchAll(/\(wrapper -> 'record' ->> 'sourceKey'\) is distinct from \(/gu)].length, 2);
  assert.doesNotMatch(migration, /\b(?:insert into|update|delete from|alter table|drop table)\b/iu);
  assert.match(migration, /commit;\s*$/u);
});

test("precedence migration preserves every prior lesson and schedule invariant", () => {
  const previousLesson = functionDefinition(missingBranchMigration, LESSON_VALIDATOR);
  const previousSchedule = functionDefinition(dualSourceMigration, SCHEDULE_VALIDATOR);
  const currentLesson = functionDefinition(migration, LESSON_VALIDATOR);
  const currentSchedule = functionDefinition(migration, SCHEDULE_VALIDATOR);

  assert.equal(
    normalizeSql(currentLesson),
    normalizeSql(expectedPrecedenceFix(previousLesson)),
  );
  assert.equal(
    normalizeSql(currentSchedule),
    normalizeSql(expectedPrecedenceFix(previousSchedule)),
  );
});
