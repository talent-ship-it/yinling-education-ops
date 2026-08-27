import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20260819101800_enforce_task_canonical_deadlines.sql", import.meta.url), "utf8");
const store = await readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8");

test("deadline invariant migration freezes legacy evidence before installing the hard guard", () => {
  assert.match(migration, /Migration 20260819101800/i);
  assert.match(migration, /create or replace function internal\.task_due_at_is_canonical/i);
  assert.match(migration, /create table if not exists internal\.legacy_task_deadline_freezes/i);
  assert.match(migration, /original_task jsonb not null/i);
  assert.match(migration, /frozen_task jsonb not null/i);
  assert.match(migration, /sourceDue/);
  assert.match(migration, /sourceDueAt/);
  assert.match(migration, /missing_canonical_due_at/);
  assert.match(migration, /create trigger ops_state_enforce_task_canonical_deadlines/i);
  assert.match(migration, /open_task_requires_canonical_due_at/i);
  assert.match(migration, /managed_task_anchor_required/i);
  assert.match(migration, /legacy_task_evidence_immutable/i);
  assert.match(migration, /ownership in \('legacy_manual', 'managed_rule'\)/i);
  assert.match(migration, /or ownership = 'managed_rule'/i);
  assert.doesNotMatch(migration, /ownership = 'managed_rule' and \(\s*nullif\(btrim\(rule_key\)/i);
  assert.match(migration, /case when item\.value \? 'ruleKey' or item\.value \? 'anchorBookingId'/i);
  assert.doesNotMatch(migration, /and not item\.value \? 'ruleKey'/i);
  assert.match(migration, /or item\.value \? 'legacyEvidence'/i);
  assert.match(migration, /where exists \(\s*select 1 from internal\.legacy_task_deadline_freezes ledger/i);
  assert.match(migration, /legacy_task_evidence_delete_forbidden/i);
  assert.match(migration, /legacy_task_evidence_not_active/i);
  assert.match(migration, /freeze_record\.frozen_task is distinct from task/i);
  assert.match(migration, /task_state\.payload/);
  assert.match(migration, /updated_by = 'deadline-invariant-migration'/i);
});

test("Postgres canonical regex contains one backslash and catches the double-slash regression", () => {
  const correctPattern = "'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'";
  const brokenPattern = "'^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}\\\\.\\\\d{3}Z$'";
  assert.ok(migration.includes(correctPattern), "migration must use PostgreSQL's single-backslash regex");
  assert.ok(!migration.includes(brokenPattern), "double-backslash regex matches a literal slash sequence");
});

test("the migration never treats legacy display text as a deadline", () => {
  assert.match(migration, /`due` is historical display\/evidence only/i);
  assert.match(migration, /It is never parsed here/i);
  assert.match(migration, /发布后立即/);
  assert.doesNotMatch(migration, /due\s*::\s*timestamptz/i);
  assert.doesNotMatch(migration, /dueAt.*发布后立即/i);
});

test("migration leaves the explicit 191008 manual repair contract available", () => {
  assert.match(migration, /191008 manual route/i);
  assert.match(migration, /internal\.task_due_at_is_canonical\(task ->> 'dueAt'\)/i);
  assert.match(migration, /create or replace function public\.mutate_legacy_task_deadline_atomic/i);
  assert.match(migration, /internal\.legacy_task_deadline_identity/i);
  assert.match(migration, /set_config\('app\.legacy_task_deadline_command_key', p_command_key, true\)/i);
  assert.match(migration, /set_config\('app\.legacy_task_deadline_task_id', identity_value ->> 'taskId', true\)/i);
  assert.match(migration, /set thawed_at = clock_timestamp\(\),\s*thaw_source = 'legacy_manual'/i);
  assert.match(migration, /thaw_command_key = command_key_value/i);
  assert.match(migration, /freeze_record\.thaw_command_key <> p_command_key/i);
  assert.match(migration, /legacy_task_deadline_freeze_commit_missing/i);
  assert.match(migration, /legacy_task_deadline_clear_disabled/i);
});

test("managed frozen tasks thaw only inside the authoritative LP scheduler transaction", () => {
  assert.match(migration, /freeze_record\.ownership = 'legacy_manual'/i);
  assert.match(migration, /thaw_source = 'managed_workflow'/i);
  assert.match(migration, /managed_task_authoritative_identity_changed/i);
  assert.match(migration, /managed_task_thaw_requires_authoritative_workflow/i);
  assert.match(migration, /freeze_record\.rule_key is not null/i);
  assert.match(migration, /freeze_record\.anchor_booking_id is not null/i);
  assert.match(migration, /\(old_task - 'dueAt' - 'legacyEvidence'\)\s*is distinct from \(task - 'dueAt' - 'legacyEvidence'\)/i);
  assert.match(migration, /create or replace function public\.put_lp_parent_progress_scheduler_tasks_authoritative/i);
  assert.match(migration, /set_config\('app\.managed_task_deadline_workflow', 'lp-parent-progress', true\)/i);
  assert.match(migration, /set_config\('app\.managed_task_deadline_command_key', p_run_key, true\)/i);
  assert.match(migration, /set_config\(\s*'app\.managed_task_deadline_source_sha256'/i);
  assert.match(migration, /set_config\('app\.managed_task_deadline_target_sha256', run_row\.target_tasks_digest, true\)/i);
  assert.match(migration, /extensions\.digest\(old\.payload::text, 'sha256'\)/i);
  assert.match(migration, /scheduler_run\.target_tasks_digest = managed_target_sha256_value/i);
  assert.match(migration, /scheduler_run\.task_version_before = old\.version/i);
  assert.match(migration, /task ->> 'ruleKey' !~ '\^trial\\\.parent-progress-sync/i);
  assert.match(store, /LP_PARENT_PROGRESS_SCHEDULER_COMMIT_RPC = "put_lp_parent_progress_scheduler_tasks_authoritative"/i);
});
