import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const {
  buildScheduleSnapshotEnvelope,
  parseArguments,
  readScheduleSnapshotExport,
} = await import("../scripts/jiaowubao-open-api-schedule-staging.ts");

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function syntheticExport(rowsByPage) {
  const directory = await mkdtemp(join(tmpdir(), "jwb-open-api-stage-"));
  await chmod(directory, 0o700);
  const pages = [];
  let recordCount = 0;
  for (let index = 0; index < rowsByPage.length; index += 1) {
    const serialized = JSON.stringify(rowsByPage[index]);
    const pageFile = `page-${String(index + 1).padStart(4, "0")}.json`;
    await writeFile(join(directory, pageFile), `${serialized}\n`, { mode: 0o600 });
    pages.push({ page: index + 1, recordCount: rowsByPage[index].length, sha256: `sha256:${sha256(serialized)}`, file: pageFile });
    recordCount += rowsByPage[index].length;
  }
  const manifestPayload = {
    format: "jiaowubao-schedule-export/v1",
    source: "jiaowubao-open-api",
    tool: "query_schedule_list",
    query: { start: "2026-08-21", end: "2026-08-21", limit: 100, order: "asc" },
    pageCount: pages.length,
    recordCount,
    recordsSha256: `sha256:${sha256(JSON.stringify(pages.map(({ page, recordCount: count, sha256: pageSha256 }) => ({
      page,
      recordCount: count,
      sha256: pageSha256,
    }))))}`,
    pages,
  };
  const manifestSha256 = `sha256:${sha256(JSON.stringify(manifestPayload))}`;
  const manifest = { ...manifestPayload, manifestSha256, revision: manifestSha256 };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return directory;
}

test("zero-row export becomes a zero-page envelope", async () => {
  const directory = await syntheticExport([]);
  try {
    const exported = await readScheduleSnapshotExport(directory);
    const envelope = buildScheduleSnapshotEnvelope(exported);
    assert.equal(envelope.expectedPageCount, 0);
    assert.equal(envelope.expectedRowCount, 0);
    assert.match(envelope.externalManifestSha256, /^sha256:[a-f0-9]{64}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("exactly one page and two pages produce explicit DB page indexes", async () => {
  const onePage = await syntheticExport([Array.from({ length: 100 }, (_, index) => ({ cal_id: String(index) }))]);
  const twoPages = await syntheticExport([
    Array.from({ length: 100 }, (_, index) => ({ cal_id: String(index) })),
    [{ cal_id: "100" }],
  ]);
  try {
    assert.equal((await readScheduleSnapshotExport(onePage)).rows.length, 100);
    const exported = await readScheduleSnapshotExport(twoPages);
    assert.equal(exported.rows.length, 101);
    assert.deepEqual(exported.rows.slice(0, 2).map((row) => row.sourceKey), ["jwb-open-api:schedule:0", "jwb-open-api:schedule:1"]);
  } finally {
    await rm(onePage, { recursive: true, force: true });
    await rm(twoPages, { recursive: true, force: true });
  }
});

test("duplicate cal_id across pages fails before any RPC can be called", async () => {
  const directory = await syntheticExport([
    Array.from({ length: 100 }, (_, index) => ({ cal_id: index })),
    [{ cal_id: "7" }],
  ]);
  try { await assert.rejects(readScheduleSnapshotExport(directory), /跨页重复 cal_id/); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI requires an environment-backed DB URL and safe actor", () => {
  assert.deepEqual(parseArguments([
    "--input", "/tmp/export", "--database-url-env", "SUPABASE_DB_URL", "--actor", "Nixon",
  ]), {
    input: "/tmp/export",
    databaseUrlEnv: "SUPABASE_DB_URL",
    secretEnv: "JIAOWUBAO_OPS_SECRET",
    sourceKey: "jwb-open-api-schedule",
    actor: "Nixon",
    abort: false,
    abortRunId: null,
    replaceCurrent: false,
  });
  assert.throws(() => parseArguments([
    "--input", "/tmp/export", "--database-url-env", "SUPABASE_DB_URL", "--actor", "anonymous",
  ]), /actor/);
  assert.throws(() => parseArguments([
    "--input", "/tmp/export", "--database-url-env", "SUPABASE_DB_URL", "--actor", "Nixon", "--unexpected",
  ]), /参数无效/);
  assert.deepEqual(parseArguments([
    "--abort", "--abort-run-id", "f13e2fd8-f75a-4d64-a9d6-00dcbd4e6677", "--database-url-env", "SUPABASE_DB_URL", "--actor", "Nixon",
  ]), {
    input: null,
    databaseUrlEnv: "SUPABASE_DB_URL",
    secretEnv: "JIAOWUBAO_OPS_SECRET",
    sourceKey: "jwb-open-api-schedule",
    actor: "Nixon",
    abort: true,
    abortRunId: "f13e2fd8-f75a-4d64-a9d6-00dcbd4e6677",
    replaceCurrent: false,
  });
});

test("DB replay and completion are aggregate-only and require server hashes", async () => {
  const source = await import("node:fs/promises");
  const body = await source.readFile(new URL("../scripts/jiaowubao-open-api-schedule-staging.ts", import.meta.url), "utf8");
  assert.match(body, /begin_jiaowubao_open_api_schedule_snapshot_ingest/);
  assert.match(body, /state === "complete"/);
  assert.match(body, /complete_jiaowubao_open_api_schedule_snapshot_ingest/);
  assert.match(body, /rowsSha256/);
  assert.match(body, /payloadSha256/);
  assert.match(body, /statusAfterUncertain/);
  assert.match(body, /get_jiaowubao_open_api_schedule_snapshot_ingest_status/);
  assert.match(body, /未自动重试/);
  assert.match(body, /get_jiaowubao_open_api_schedule_snapshot_preflight/);
  assert.match(body, /--replace-current/);
  assert.match(body, /当前快照已是不同 revision/);
  assert.match(body, /recordsSha256 与分页摘要不匹配/);
  assert.match(body, /PGCONNECT_TIMEOUT/);
  assert.match(body, /statement_timeout/);
  assert.match(body, /spawn\("psql"/);
  assert.match(body, /begin;\\nset local statement_timeout = '30s';\\nselect public\./);
  assert.match(body, /commit;\\n/);
  assert.match(body, /pageIndex/);
  assert.match(body, /start \+= 100, pageIndex \+= 1/);
  assert.doesNotMatch(body, /JSON\.stringify\(.*rowsSha256/);
});

test("SQL fixture covers stage replay, completion replay, empty completion, and abort cleanup", async () => {
  const source = await import("node:fs/promises");
  const fixture = await source.readFile(new URL("./sql/jiaowubao-open-api-schedule-snapshot-ingest-rollback.sql", import.meta.url), "utf8");
  assert.match(fixture, /stage_jiaowubao_open_api_schedule_snapshot_page/);
  assert.match(fixture, /snapshot_stage_replay_not_idempotent/);
  assert.match(fixture, /snapshot_completion_replay_not_idempotent/);
  assert.match(fixture, /get_jiaowubao_open_api_schedule_snapshot_identity_page/);
  assert.match(fixture, /snapshot_identity_page_invalid/);
  assert.match(fixture, /snapshot_identity_revision_reset_missing/);
  assert.match(fixture, /snapshot_empty_completion_failed/);
  assert.match(fixture, /snapshot_missing_required_envelope_key_was_accepted/);
  assert.match(fixture, /snapshot_missing_required_record_key_was_accepted/);
  assert.match(fixture, /snapshot_stale_pointer_replacement_was_accepted/);
  assert.match(fixture, /snapshot_current_pointer_changed_after_stale_completion/);
  assert.match(fixture, /snapshot_abort_did_not_cleanup_pages/);
  assert.match(fixture, /rollback;/);
  assert.doesNotMatch(fixture, /expectedRowsSha256/);
});
