import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260831001200_preserve_trial_handover_retirement.sql",
    import.meta.url,
  ),
  "utf8",
);
const runtimeFixture = await readFile(
  new URL("./sql/trial-manual-lp-atomic-runtime.sql", import.meta.url),
  "utf8",
);

test("the final scheduling projector preserves handover retirement and the 24h/48h/72h chain", () => {
  assert.match(migration, /create or replace function internal\.trial_scheduling_policy_tasks\(/i);
  assert.match(migration, /task\.value ->> 'ruleKey' in \([\s\S]*scheduling-alert-36h[\s\S]*lp\.handover/i);
  assert.match(migration, /trial\.manual-request\.parent-progress-24h/);
  assert.match(migration, /trial\.manual-request\.parent-progress-48h/);
  assert.match(migration, /trial\.manual-request\.scheduling-anomaly-72h/);
  assert.match(migration, /internal\.trial_manual_task_id\(p_lp_item_id, rule\)/i);
});

test("completed or frozen rows are preserved and completed rows cannot seed a new chain", () => {
  const templateSelection = migration.slice(
    migration.indexOf("select task.value into template"),
    migration.indexOf("if template is null"),
  );
  assert.match(templateSelection, /coalesce\(task\.value ->> 'status', ''\) <> 'done'/i);
  assert.match(templateSelection, /not \(task\.value \? 'legacyEvidence'\)/i);
  assert.match(templateSelection, /internal\.legacy_task_deadline_freezes evidence/i);

  assert.match(migration, /coalesce\(task\.value ->> 'status', ''\) <> 'done'/i);
  assert.match(migration, /not \(task\.value \? 'legacyEvidence'\)/i);
  assert.match(migration, /evidence\.task_id = task\.value ->> 'id'/i);
  assert.match(runtimeFixture, /trial_completed_template_reopened_chain/);
  assert.match(runtimeFixture, /trial_historical_handover_changed/);
});

test("the forward backfill repairs only open generic handovers belonging to trial LPs", () => {
  assert.match(migration, /trial_lp\.value ->> 'workflowType' = '试听 LP'/i);
  assert.match(migration, /task\.value ->> 'ruleKey' = 'lp\.handover'/i);
  assert.match(migration, /试听 LP：核对交接信息%/);
  assert.match(migration, /insert into public\.ops_mutation_log/i);
  assert.match(migration, /updated_by = 'migration:preserve-trial-handover-retirement'/i);
});

test("the disposable runtime fixture exercises the full migration order and expects no generic handover", () => {
  const handover = runtimeFixture.indexOf("20260831000300_trial_handover_task_retirement.sql");
  const feedback = runtimeFixture.indexOf("20260831001100_restore_trial_scheduling_feedback_chain.sql");
  const preservation = runtimeFixture.indexOf("20260831001200_preserve_trial_handover_retirement.sql");
  assert.ok(handover > 0 && feedback > handover && preservation > feedback);

  const expectedRules = runtimeFixture.slice(
    runtimeFixture.indexOf("if rules is distinct from array["),
    runtimeFixture.indexOf("trial_manual_rule_projection_failed"),
  );
  assert.doesNotMatch(expectedRules, /'lp\.handover'/);
});
