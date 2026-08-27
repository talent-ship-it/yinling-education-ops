import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../scripts/jiaowubao-direct-import-apply.ts", import.meta.url),
  "utf8",
);

test("the one-off writer is profile-bound, resumable, and deletes source-bearing temporary SQL", () => {
  assert.match(source, /EXPECTED_PROJECT_REF = "orvsgisjjrzgtxuwwsms"/u);
  assert.match(source, /SUPABASE_PROFILE = "insider-leads"/u);
  assert.match(source, /EXPECTED_ORGANIZATION_ID = "fgnmdykxtthalhwspelu"/u);
  assert.match(source, /--execute is required/u);
  assert.match(source, /buildJiaowubaoDirectImportResumableSql/u);
  assert.match(source, /compileJiaowubaoDirectImportProjection/u);
  assert.match(source, /assertJiaowubao20260818CompiledBatch\(compiled\)/u);
  assert.ok(
    source.indexOf("assertJiaowubao20260818CompiledBatch(compiled)")
      < source.indexOf("buildJiaowubaoDirectImportResumableSql(plan)"),
    "the locked batch gate must run before resumable SQL is created",
  );
  assert.match(source, /finally \{\s*\n\s*await rm\(secureDir, \{ recursive: true, force: true \}\)/u);
  assert.match(source, /JiaowubaoDirectImportDbFailureClassifier/u);
  assert.match(source, /failureClassifier\.feed\(chunk\)/u);
  assert.match(source, /failureClassifier\.category\(\)/u);
  assert.match(source, /\/v1\/projects\/\$\{EXPECTED_PROJECT_REF\}\/cli\/login-role/u);
  assert.match(source, /body: JSON\.stringify\(\{ read_only: false \}\)/u);
  assert.match(source, /--access-token-file/u);
  assert.match(source, /readSupabaseAccessToken\(args\.accessTokenFile\)/u);
  assert.match(source, /join\(tokenDir, "profile"\)/u);
  assert.match(source, /!== SUPABASE_PROFILE/u);
  assert.doesNotMatch(source, /process\.env\.SUPABASE_ACCESS_TOKEN|find-generic-password|homedir\(/u);
  assert.match(source, /PSQL_LINK = "\/opt\/homebrew\/bin\/psql"/u);
  assert.match(source, /"-X",\s*\n\s*"--no-password",\s*\n\s*"-qAt"/u);
  assert.match(source, /PGPASSFILE: pgpassPath/u);
  assert.match(source, /delete childEnvironment\[key\]/u);
  assert.match(source, /pgpassEscape\(target\.password\)/u);
  assert.match(source, /mode: 0o600/u);
  assert.match(source, /waitForTemporaryLogin/u);
  assert.match(source, /PROBE_ATTEMPTS = 9/u);
  assert.match(source, /importStatusSql\(compiled\.envelope\.revision\)/u);
  assert.match(source, /status\.state === "staging"/u);
  assert.match(source, /run_state\.state in \('staging', 'complete'\)/u);
  assert.match(source, /runPsqlResumableImport/u);
  assert.match(source, /parsePsqlProgressEvent/u);
  assert.match(source, /phase: "chunk"/u);
  assert.match(source, /Rerun the exact same command/u);
  assert.match(source, /abortStagingIfCurrentMasterDiffers/u);
  assert.match(source, /abortIfCurrentMasterDiffersSql/u);
  assert.match(source, /abort_jiaowubao_direct_import_if_current_master_differs/u);
  assert.match(source, /typeof result\.aborted !== "boolean"/u);
  assert.match(source, /masterSourceChanged/u);
  assert.ok(
    source.indexOf('"existing staging read"') < source.indexOf("assertJiaowubao20260818CompiledBatch(compiled)"),
    "a stale staging run must be handled before the locked batch gate can reject a refreshed authority",
  );
  assert.match(source, /\/database\/query/u);
  for (const version of [
    "20260819000100",
    "20260819000200",
    "20260819000300",
    "20260819000400",
    "20260819000500",
    "20260819000600",
    "20260819000700",
    "20260819000800",
    "20260819000900",
    "20260819001000",
    "20260819001100",
    "20260819001200",
  ]) assert.match(source, new RegExp(`"${version}"`, "u"));
  assert.match(source, /REQUIRED_REMOTE_MIGRATION_VERSION = "20260819001200"/u);
  assert.match(source, /QUERY_TIMEOUT_MS = 45 \* 60 \* 1000/u);
  assert.match(source, /for \(const version of REQUIRED_RELEASE_MIGRATION_VERSIONS\)/u);
  assert.match(source, /matches\.length !== 1/u);
  assert.match(source, /from supabase_migrations\.schema_migrations/u);
  assert.match(source, /where version = '\$\{REQUIRED_REMOTE_MIGRATION_VERSION\}'/u);
  assert.match(source, /safeSqlTextLiteral\(canonicalJson\(envelope\)\)/u);
  assert.match(source, /internal\.jiaowubao_direct_import_assert_envelope/u);
  assert.match(source, /envelopeAssertionSql\(compiled\.envelope\)/u);
  const authorityRead = source.indexOf('await runManagementQuery(accessToken, authoritySql(), "authority read")');
  const migrationGate = source.indexOf("assertRequiredRemoteMigration(await runManagementQuery(");
  const envelopeGate = source.indexOf("assertEnvelopeAccepted(await runManagementQuery(");
  const transactionWrite = source.indexOf("await writeOwnerOnly(resumablePath");
  assert.ok(authorityRead >= 0 && authorityRead < migrationGate, "migration gate must follow the authority read");
  assert.ok(migrationGate < envelopeGate, "the applied migration must be checked before the live envelope");
  assert.ok(envelopeGate < transactionWrite, "the live envelope must be accepted before resumable SQL is written");
  assert.match(source, /url\.port !== "5432"/u);
  assert.match(source, /url\.username !== `postgres\.\$\{EXPECTED_PROJECT_REF\}`/u);
  assert.match(source, /payload\.ttl_seconds < MINIMUM_LOGIN_ROLE_TTL_SECONDS/u);
  assert.doesNotMatch(source, /--db-url|PGPASSWORD:|deleteLoginRoles|\/cli\/login-role.*DELETE|GRANT postgres|BYPASSRLS/u);
  assert.doesNotMatch(source, /console\.log|process\.stderr\.write\([^)]*stdout|process\.stderr\.write\([^)]*stderr/u);
  assert.doesNotMatch(source, /stderr\.push|Buffer\.concat\(stderr/u);
});

test("the writer uses all seven exact source filenames and never exposes a browser route", () => {
  for (const fileName of [
    "吟领教育 2026-08-18 学员快速列表.xlsx",
    "吟领教育  学员列表.xlsx",
    "吟领教育 学员合约.xlsx",
    "吟领教育  学员课时列表.xlsx",
    "吟领教育 班级学员名单.xlsx",
    "吟领教育 2021-08-03至 2029-08-02 课表.xlsx",
    "吟领教育 2026-08-11至2026-08-25 请假补课记录.xlsx",
  ]) assert.match(source, new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(source, /app\/api|NextResponse|multipart\/form-data/u);
});
