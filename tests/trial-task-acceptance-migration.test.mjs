import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../supabase/migrations/20260831000200_trial_task_acceptance_cleanup.sql", import.meta.url),
  "utf8",
);

test("acceptance cleanup retires every superseded open trial task", () => {
  for (const rule of [
    "trial.parent-follow-up",
    "trial.parent-no-reply-follow-up",
    "trial.teaching-control-escalation",
    "trial.lp-review",
    "trial.prep",
    "trial.minimum",
    "trial.short-notice-prep",
    "trial.manual-request.scheduling-alert-36h",
    "trial.manual-request.parent-progress-48h",
    "trial.jiaowubao.teacher-reply-4h",
    "trial.jiaowubao.teacher-reply-8h",
  ]) assert.match(migration, new RegExp(rule.replaceAll(".", "[.]")));
  assert.match(migration, /parent-progress-sync/);
  for (const title of [
    "QA 系统验收",
    "试听 LP：核对交接信息",
    "发送家长试听跟进请求",
    "家长未回复：向负责人汇报",
  ]) assert.match(migration, new RegExp(title));
});

test("acceptance cleanup preserves completed and frozen evidence", () => {
  assert.match(migration, /coalesce\(task\.value ->> 'status', ''\) <> 'done'/);
  assert.match(migration, /not \(task\.value \? 'legacyEvidence'\)/);
  assert.match(migration, /internal\.legacy_task_deadline_freezes/);
  assert.match(migration, /insert into public\.ops_mutation_log/);
});
