import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260828000900_trial_payment_task_lifecycle.sql",
  import.meta.url,
);

test("booking payment reconciliation preserves notes and Can't Do without opening payment confirmation", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /reconcile_trial_payment_tasks_for_booking_base_20260828000900/);
  assert.match(sql, /completionNote/);
  assert.match(sql, /completionOutcome', 'cannot_do'/);
  assert.match(sql, /generated\.value ->> 'status' in \('overdue', 'today', 'upcoming', 'waiting'\)/);
  assert.match(sql, /char_length\(candidate\.value ->> 'completionNote'\) between 1 and 1000/);
  assert.match(sql, /revoke all on function internal\.reconcile_trial_payment_tasks_for_booking\(/);
  assert.doesNotMatch(sql, /grant execute/);
  assert.doesNotMatch(sql, /已由规划老师确认试听付款|已由管理员确认试听付款/);
});
