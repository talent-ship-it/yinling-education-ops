import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL(
  "../supabase/migrations/20260821220005_student_import_management_commit_bridge.sql",
  import.meta.url,
), "utf8");
const cli = await readFile(new URL(
  "../scripts/student-import-management.ts",
  import.meta.url,
), "utf8");
const { parseManagementArguments } = await import("../scripts/student-import-management.ts");

test("formal student management bridge is postgres-only and private", () => {
  for (const fragment of [
    "internal.student_import_management_source_snapshot",
    "internal.student_import_management_snapshot",
    "internal.student_import_management_commit",
    "session_user <>",
    "current_user <>",
    "security invoker",
    "revoke all on function internal.student_import_management_source_snapshot",
    "revoke all on function internal.student_import_management_snapshot",
    "revoke all on function internal.student_import_management_commit",
    "student_import_management_canonical_contract_missing",
  ]) assert.match(migration, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "i"));
  assert.doesNotMatch(migration, /grant execute/iu);
  assert.doesNotMatch(migration, /security definer/iu);
});

test("bridge clones current canonical source and commit definitions", () => {
  for (const fragment of [
    "pg_get_functiondef(",
    "public.get_latest_student_import_source_rows(text)",
    "public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)",
    "student_import_assign_student_numbers",
    "student_import_identity_link_sets",
    "student_import_canonical_projection",
    "student_import_commits",
    "pg_advisory_xact_lock",
    "formalImportDate",
    "internal.student_import_management_replay",
  ]) assert.match(migration, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "i"));
  assert.doesNotMatch(migration, /verify_ops_secret/iu);
});

test("commit clone uses a real multiline replacement on its primary regex path", () => {
  assert.match(
    migration,
    /updated_definition := pg_catalog\.regexp_replace\(\s*definition,\s*\$student_import_management_commit_signature_pattern\$[\s\S]*?\$student_import_management_commit_signature\$CREATE OR REPLACE FUNCTION internal\.student_import_management_commit\(\n/u,
  );
  assert.doesNotMatch(
    migration,
    /'CREATE OR REPLACE FUNCTION internal\.student_import_management_commit\(\\n/u,
  );
});

test("management snapshot minimizes references and never exposes secrets", () => {
  assert.match(migration, /occurrenceOverrides/iu);
  assert.match(migration, /studentId/iu);
  assert.match(migration, /student_import_management_session\(\)\nreturns boolean/iu);
  assert.match(migration, /where internal\.student_import_management_session\(\)/iu);
  assert.match(cli, /student_import_management_snapshot/iu);
  assert.match(cli, /student_import_management_commit/iu);
  assert.match(cli, /OPS_API_SECRET/iu);
  assert.match(cli, /JIAOWUBAO_OPEN_API_SK/iu);
  assert.match(cli, /delete childEnv\[key\]/u);
  assert.doesNotMatch(cli, /process\.env\.OPS_API_SECRET/u);
  assert.doesNotMatch(cli, /process\.env\.JIAOWUBAO_OPEN_API_SK/u);
});

test("management CLI defaults to preview and accepts explicit commit", () => {
  const common = ["--profile", "/private/tmp/insider-leads-supabase-profile.yaml", "--actor", "Nixon"];
  assert.equal(parseManagementArguments(common).commit, false);
  assert.equal(parseManagementArguments([...common, "--commit"]).commit, true);
  assert.equal(parseManagementArguments(common).actor, "Nixon");
  const key = `sha256:${"a".repeat(64)}`;
  assert.equal(parseManagementArguments([...common, "--confirmation-key", key, "--expected-student-version", "18"]).confirmationKey, key);
  assert.equal(parseManagementArguments([...common, "--confirmation-key", key, "--expected-student-version", "18"]).expectedStudentVersion, 18);
  assert.throws(() => parseManagementArguments(["--profile", "/tmp/p", "--actor", "anonymous"]), /参数必须合法/u);
  assert.throws(() => parseManagementArguments([...common, "--commit", "--commit"]), /参数无效/u);
  assert.throws(() => parseManagementArguments([...common, "--confirmation-key", key]), /参数必须合法/u);
  assert.throws(() => parseManagementArguments([...common, "--confirmation-key", key, "--expected-student-version", "18", "--commit"]), /参数必须合法/u);
  assert.throws(() => parseManagementArguments([...common, "--unknown"]), /参数无效/u);
});
