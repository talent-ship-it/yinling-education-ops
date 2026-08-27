import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("manual package writes persist a structured purchased/bonus breakdown", () => {
  const client = read("app/operations-client.tsx");
  assert.match(client, /purchasedHours: parsed\.purchasedHours/);
  assert.match(client, /bonusHours: parsed\.bonusHours/);
  assert.match(client, /purchasedHours,\s*\n\s*bonusHours,/);
  assert.match(read("app/student-records-panel.tsx"), /购买 \$\{purchase\.purchasedHours\} \+ 赠送 \$\{purchase\.bonusHours\}/);
});

test("all current-state validators accept optional legacy-compatible breakdown fields", () => {
  assert.match(read("lib/ops-state-transition.ts"), /purchasedHours/);
  assert.match(read("lib/student-import-service.ts"), /\["id", "purchasedAt", "hours", "purchasedHours", "bonusHours", "note"\]/);
  assert.match(read("lib/lesson-occurrence-service.ts"), /purchase breakdown is invalid/);
});

test("forward migration updates the deployed exact-key writer and validates only new breakdowns", () => {
  const migration = read("supabase/migrations/20260819101000_allow_manual_purchase_hours_breakdown.sql");
  const canonicalCommit = read("supabase/migrations/20260815030000_student_import_identity_review.sql");
  const inactiveRosterPatch = read("supabase/migrations/20260818001200_restore_inactive_no_hours_roster_exclusion.sql");
  const timeoutPatch = read("supabase/migrations/20260819000500_bound_student_import_commit_timeout.sql");
  const count = (source, needle) => source.split(needle).length - 1;
  assert.match(migration, /create trigger ops_state_validate_manual_package_breakdown/);
  assert.match(migration, /put_ops_state/);
  assert.match(migration, /purchasedHours/);
  assert.match(migration, /bonusHours/);
  assert.match(migration, /pg_get_functiondef/);
  assert.match(migration, /if position\(exact_key_suffix in original_definition\) > 0/);
  assert.match(migration, /jsonb_typeof\(purchase_item -> 'purchasedHours'\) is distinct from 'number'/i);
  assert.match(migration, /jsonb_typeof\(purchase_item -> 'bonusHours'\) is distinct from 'number'/i);
  assert.match(migration, /jsonb_typeof\(purchase_item -> 'hours'\) is distinct from 'number'/i);
  assert.match(migration, /commit_student_import_plan_atomic/);
  assert.match(migration, /student_import_commit_purchase_key_anchor_mismatch/);
  assert.match(migration, /student_import_commit_security_or_acl_changed/);
  assert.match(migration, /original_config/);
  assert.match(migration, /original_acl/);
  assert.match(migration, /p\.pronargs = 6/);
  assert.equal(count(canonicalCommit, "purchase_item - 'id' - 'purchasedAt' - 'hours' - 'note'"), 1);
  assert.equal(count(canonicalCommit, "eligible_master_row ->> 'status' <> '不活跃 + 无课时'"), 3);
  assert.match(inactiveRosterPatch, /commit_student_import_plan_atomic\(text,text,bigint,jsonb,jsonb,text\)/);
  assert.match(timeoutPatch, /set statement_timeout = '30s'/i);
  assert.doesNotMatch(migration, /sourcePurchaseId|sourcePackageId|student_import_jwb/);
  const sqlContract = read("tests/sql/manual-purchase-breakdown-contract.sql");
  assert.match(sqlContract, /ops_state_validate_manual_package_breakdown/);
  assert.match(sqlContract, /manual_purchase_breakdown_writer_missing/);
  assert.match(sqlContract, /manual_purchase_breakdown_missing_hours_not_fail_closed/);
  assert.match(sqlContract, /manual_purchase_breakdown_commit_writer_missing/);
  assert.match(sqlContract, /student_import_commit_purchase_breakdown_not_patched/);
  assert.match(sqlContract, /student_import_commit_security_or_acl_contract_failed/);
  assert.match(sqlContract, /IS DISTINCT FROM/);
});
