import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260819101500_add_exam_month_planning_task.sql", import.meta.url);

test("planning migration is a forward-only Melbourne calendar-month contract", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /exam_submission_incoming_tasks_legacy_20260815/);
  assert.match(sql, /exam_submission_reconcile_tasks_legacy_20260815/);
  assert.match(sql, /exam_follow_up_identity_legacy_20260815/);
  assert.match(sql, /exam:[^']*:planning/);
  assert.match(sql, /exam_month_planning/);
  assert.match(sql, /target_month_start := \(pg_catalog\.date_trunc\('month', exam_date\) - interval '1 month'\)\:\:date/);
  assert.match(sql, /target_month_last_day := \(pg_catalog\.date_trunc\('month', exam_date\) - interval '1 day'\)\:\:date/);
  assert.match(sql, /least\(extract\(day from exam_date\)\:\:integer/);
  assert.match(sql, /Australia\/Melbourne/);
  assert.match(sql, /考试前一个月规划/);
  assert.match(sql, /follow_up_kind in \('exam_care', 'exam_recall', 'exam_month_planning', 'exam_results_follow_up'\)/);
  assert.match(sql, /2026-02-28 18:00/);
  assert.match(sql, /2028-02-29 18:00/);
  assert.match(sql, /2026-09-30T08:00:00\.000Z/);
});
