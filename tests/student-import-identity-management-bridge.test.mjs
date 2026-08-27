import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL(
  "../supabase/migrations/20260821220004_student_import_identity_management_bridge.sql",
  import.meta.url,
), "utf8");
const cli = await readFile(new URL(
  "../scripts/student-import-identity-management.ts",
  import.meta.url,
), "utf8");
const { parseIdentityManagementArguments } = await import(
  "../scripts/student-import-identity-management.ts",
);

test("identity management bridge is private postgres-only and leaves public RPCs unchanged", () => {
  assert.match(migration, /session_user <> 'postgres'/i);
  assert.match(migration, /current_user <> 'postgres'/i);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /student_import_identity_bulk_management_preview/i);
  assert.match(migration, /student_import_identity_bulk_management_commit/i);
  assert.match(migration, /revoke all on function internal\.student_import_identity_bulk_management_session/i);
  assert.match(migration, /revoke all on function internal\.student_import_identity_bulk_management_review/i);
  assert.match(migration, /revoke all on function internal\.student_import_identity_bulk_management_preview/i);
  assert.match(migration, /revoke all on function internal\.student_import_identity_bulk_management_commit/i);
  assert.doesNotMatch(migration, /grant execute/i);
  assert.doesNotMatch(migration, /create or replace function public\./i);
  assert.doesNotMatch(migration, /verify_ops_secret/i);
});

test("bridge reuses canonical merge/CAS/ledger protocol and exact eight-row gate", () => {
  for (const fragment of [
    "student_import_identity_resolved_master_rows",
    "student_import_identity_bulk_merge_candidates",
    "student_import_identity_bulk_merge_plan",
    "student_import_identity_bulk_review_key",
    "student_import_identity_bulk_review_commands",
    "append_operational_contract_audit",
    "student_import_identity_link_sets",
    "pg_advisory_xact_lock",
    "for update",
    "expected_review_count constant integer := 8",
    "requested_count <> expected_review_count",
    "newly_applied_count <> expected_review_count",
    "unresolved_duplicate_group_count <> 0",
  ]) assert.match(migration, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "i"));
  assert.match(migration, /confirmationKey', expected_key/i);
  assert.match(migration, /p_confirmation_key/);
  assert.match(migration, /managementBridge', true/i);
});

test("CLI uses Management API db query, scrubs secrets, and submits only preview key", () => {
  assert.match(cli, /supabase@2\.115\.0/);
  assert.match(cli, /db.*query/s);
  assert.match(cli, /--project-ref.*PROJECT_REF/s);
  assert.match(cli, /OPS_API_SECRET/);
  assert.match(cli, /JIAOWUBAO_OPS_SECRET/);
  assert.match(cli, /delete childEnv\[key\]/);
  assert.doesNotMatch(cli, /database-url-env|ops-secret-env/);
  assert.match(cli, /student_import_identity_bulk_management_preview/);
  assert.match(cli, /student_import_identity_bulk_management_commit/);
  assert.match(cli, /previewKey/);
  assert.match(cli, /--confirmation-key/);
  assert.match(cli, /if \(options\.confirmationKey\)/);
  assert.ok(
    cli.indexOf("if (options.confirmationKey)") < cli.indexOf("const preview ="),
    "recovery must call commit before any fresh preview",
  );
  assert.match(cli, /candidateCount !== 8/);
  assert.match(cli, /pendingCount !== 8/);
  assert.match(cli, /process\.stdout\.write\(\`\$\{JSON\.stringify\(previewReceipt\)/);
});

test("CLI arguments default to preview and expose only explicit commit", () => {
  const common = ["--profile", "/private/tmp/profile.yaml", "--actor", "Nixon"];
  const key = `sha256:${"a".repeat(64)}`;
  assert.equal(parseIdentityManagementArguments(common).commit, false);
  assert.equal(parseIdentityManagementArguments([...common, "--commit"]).commit, true);
  assert.equal(parseIdentityManagementArguments(common).actor, "Nixon");
  assert.equal(parseIdentityManagementArguments([...common, "--commit", "--confirmation-key", key]).confirmationKey, key);
  assert.equal(parseIdentityManagementArguments(common).confirmationKey, null);
  assert.throws(() => parseIdentityManagementArguments(["--profile", "/tmp/p", "--actor", "anonymous"]), /参数必须合法/u);
  assert.throws(() => parseIdentityManagementArguments([...common, "--confirmation-key", key]), /参数必须合法/u);
  assert.throws(() => parseIdentityManagementArguments([...common, "--commit", "--confirmation-key", "not-a-key"]), /参数必须合法/u);
  assert.throws(() => parseIdentityManagementArguments([...common, "--commit", "--commit"]), /参数无效/u);
  assert.throws(() => parseIdentityManagementArguments([...common, "--unexpected"]), /参数无效/u);
});
