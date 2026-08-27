import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixture = await readFile(
  new URL("./sql/task-deadline-invariant-contract.sql", import.meta.url),
  "utf8",
);

test("deadline SQL runtime contract is local-only, evidence-complete, and disposable", () => {
  assert.match(fixture, /^\\set ON_ERROR_STOP on/m);
  assert.match(fixture, /^begin;$/im);
  assert.match(fixture, /20260819100800_manual_legacy_task_deadline_atomic\.sql/i);
  assert.match(fixture, /20260819101800_enforce_task_canonical_deadlines\.sql/i);
  assert.match(fixture, /task_deadline_runtime_complete_evidence_failed/i);
  assert.match(fixture, /task_deadline_runtime_malformed_managed_evidence_failed/i);
  assert.match(fixture, /task_deadline_runtime_empty_managed_evidence_failed/i);
  assert.match(fixture, /task_deadline_runtime_delete_not_rejected/i);
  assert.match(fixture, /task_deadline_runtime_generic_manual_thaw_not_rejected/i);
  assert.match(fixture, /task_deadline_runtime_forged_marker_not_rejected/i);
  assert.match(fixture, /task_deadline_runtime_manual_thaw_ledger_failed/i);
  assert.match(fixture, /task_deadline_runtime_readded_marker_not_rejected/i);
  assert.match(fixture, /task_deadline_runtime_clear_not_rejected/i);
  assert.match(fixture, /task_deadline_runtime_managed_manual_not_rejected/i);
  assert.match(fixture, /task_deadline_runtime_generic_managed_thaw_not_rejected/i);
  assert.match(fixture, /task_deadline_runtime_managed_projection_change_not_rejected/i);
  assert.match(fixture, /task_deadline_runtime_managed_thaw_ledger_failed/i);
  assert.match(fixture, /task_deadline_runtime_thawed_delete_not_rejected/i);
  assert.match(fixture, /task_deadline_runtime_new_bad_not_rejected/i);
  assert.match(fixture, /^rollback;$/im);
  assert.doesNotMatch(fixture, /^commit;$/im);
});
