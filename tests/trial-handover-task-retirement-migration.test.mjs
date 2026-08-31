import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../supabase/migrations/20260831000300_trial_handover_task_retirement.sql", import.meta.url),
  "utf8",
);

test("trial creation retires the generic handover task after the accepted projector runs", () => {
  assert.match(migration, /rename to trial_scheduling_policy_tasks_before_handover_retirement/);
  assert.match(migration, /trial_scheduling_policy_tasks_before_handover_retirement\([\s\S]*p_tasks,[\s\S]*p_lp_item_id/);
  assert.match(migration, /task\.value ->> 'ruleKey' = 'lp\.handover'/);
  assert.match(migration, /task\.value ->> 'anchorBookingId' = p_lp_item_id/);
});

test("handover retirement backfills only open, unfrozen trial tasks", () => {
  assert.match(migration, /coalesce\(task\.value ->> 'status', ''\) <> 'done'/);
  assert.match(migration, /not \(task\.value \? 'legacyEvidence'\)/);
  assert.match(migration, /internal\.legacy_task_deadline_freezes/);
  assert.match(migration, /lp\.value ->> 'workflowType' = '试听 LP'/);
  assert.match(migration, /试听 LP：核对交接信息%/);
  assert.match(migration, /insert into public\.ops_mutation_log/);
});
