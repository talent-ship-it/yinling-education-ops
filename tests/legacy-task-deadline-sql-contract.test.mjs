import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixture = await readFile(
  new URL("./sql/legacy-task-deadline-contract.sql", import.meta.url),
  "utf8",
);

test("the manual legacy-deadline SQL contract is local-only, exact, replay-safe, and disposable", () => {
  assert.match(fixture, /^\\set ON_ERROR_STOP on/m);
  assert.match(fixture, /^begin;/im);
  assert.match(fixture, /20260819100800_manual_legacy_task_deadline_atomic\.sql/i);
  assert.match(fixture, /create table if not exists public\.ops_mutation_log/i);
  assert.match(fixture, /legacy-task-deadline-fixture-secret/i);
  assert.match(fixture, /fixture_append_operational_contract_audit/i);
  assert.match(fixture, /insert into internal\.operational_contract_audit/i);
  assert.match(fixture, /public\.mutate_legacy_task_deadline_atomic\(/i);
  assert.match(fixture, /'2026-08-19T08:00:00\.000Z'/i);
  assert.match(fixture, /legacy_task_deadline_projection_changed_more_than_due_at/i);
  assert.match(fixture, /legacy_task_deadline_replay_failed/i);
  assert.match(fixture, /legacy_task_deadline_set_identical_receipt_failed/i);
  assert.match(fixture, /legacy_task_deadline_set_identical_lookup_failed/i);
  assert.match(fixture, /legacy_task_deadline_set_identical_replay_failed/i);
  assert.match(fixture, /legacy_task_deadline_clear_missing_receipt_failed/i);
  assert.match(fixture, /legacy_task_deadline_clear_missing_lookup_failed/i);
  assert.match(fixture, /legacy_task_deadline_clear_missing_replay_failed/i);
  assert.match(fixture, /legacy_task_deadline_audit_count_failed/i);
  assert.match(fixture, /legacy_task_deadline_bad_secret_not_rejected/i);
  assert.match(fixture, /legacy_task_deadline_idempotency_conflict_not_rejected/i);
  assert.match(fixture, /legacy_task_deadline_managed_not_rejected/i);
  assert.match(fixture, /legacy_task_deadline_done_not_rejected/i);
  assert.match(fixture, /legacy_task_deadline_archived_not_rejected/i);
  assert.match(fixture, /legacy_task_deadline_rejected_commands_created_receipt/i);
  assert.match(fixture, /legacy_task_deadline_melbourne_time_nonexistent/i);
  assert.match(fixture, /legacy_task_deadline_melbourne_time_ambiguous/i);
  assert.match(fixture, /^rollback;$/im);
  assert.doesNotMatch(fixture, /^commit;$/im);
});
