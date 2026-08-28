import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260828000700_teacher_change_trial_jiaowubao.sql",
  import.meta.url,
);
const baseMigrationUrl = new URL(
  "../supabase/migrations/20260828000500_jiaowubao_trial_sync_atomic.sql",
  import.meta.url,
);

test("teacher-change trials extend only the proven Jiaowubao schedule projection", async () => {
  const [migration, base] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(baseMigrationUrl, "utf8"),
  ]);

  assert.match(migration, /trial_teacher_evidence_key/);
  assert.match(migration, /'待核对老师映射'/);
  assert.match(migration, /workflowType' in \('试听 LP', '换老师试听'\)/);
  assert.match(migration, /before_lp ->> 'workflowType' = '换老师试听'/);
  assert.match(migration, /\{fields,newTeacher\}/);
  assert.match(migration, /\{trialSchedule,teacherName\}/);
  assert.match(migration, /ruleKey' <> 'trial\.jiaowubao\.payment-n2'[\s\S]+lp ->> 'workflowType' = '试听 LP'/);
  assert.match(migration, /'trial\.scheduling'/);
  assert.doesNotMatch(migration, /create or replace function public\.complete_jiaowubao_trial_payment_task/);

  assert.match(base, /where lp ->> 'workflowType' = '试听 LP'/);
  assert.match(base, /or not \(after_lp -> 'trialSchedule' \? 'plannerHint'\)/);
});
