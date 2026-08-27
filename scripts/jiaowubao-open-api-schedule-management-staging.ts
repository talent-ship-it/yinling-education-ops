#!/usr/bin/env node

/**
 * One-time owner bridge for the private JWB Open API schedule snapshot.
 *
 * Each call is a separate Supabase Management API `db query` invocation.  The
 * database session is required to be postgres by the 20260821220001 bridge;
 * no database URL or OPS_API_SECRET is read, copied, or written.  Input JSON
 * is written to a 0600 temporary SQL file and passed with --file, never argv.
 * Every page is committed independently; completion is its own short query.
 */

import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildScheduleSnapshotEnvelope,
  readScheduleSnapshotExport,
  type ScheduleSnapshotExport,
} from "./jiaowubao-open-api-schedule-staging.ts";

const PROJECT_REF = "orvsgisjjrzgtxuwwsms";
const PROFILE_ENV = "INSIDER_LEADS_SUPABASE_PROFILE";
const MAX_QUERY_OUTPUT_BYTES = 128 * 1024;
const QUERY_TIMEOUT_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;

type JsonRecord = Record<string, unknown>;
type ManagementOptions = Readonly<{
  input: string | null;
  profile: string;
  actor: "Nixon" | "Ops Admin";
  sourceKey: string;
  pageStart: number | null;
  pageCount: number | null;
  abort: boolean;
  abortRunId: string | null;
  replaceCurrent: boolean;
}>;

function fail(message: string): never { throw new Error(message); }
function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 无效。`);
  return value as JsonRecord;
}
function dollarQuote(value: string) {
  const safe = value.replace(/[^A-Za-z0-9_]/gu, "");
  const tag = `jwb_mgmt_${safe.slice(0, 24) || "sql"}`;
  let candidate = tag;
  while (value.includes(`$${candidate}$`)) candidate += "_x";
  return `$${candidate}$${value}$${candidate}$`;
}
function jsonSql(value: unknown) { return dollarQuote(JSON.stringify(value)); }

function nonNegativeInteger(value: string | undefined, label: string, maximum: number) {
  if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) fail(`${label} 必须是非负整数。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) fail(`${label} 超出安全上限。`);
  return parsed;
}

async function ownerOnlyFile(path: string, label: string) {
  const stat = await lstat(path).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    fail(`${label} 必须是 owner-only 普通文件。`);
  }
}

function parseManagementResult(stdout: string): JsonRecord {
  const start = stdout.indexOf("{");
  if (start < 0) fail("Supabase Management API 没有返回 JSON。");
  let payload: unknown;
  try { payload = JSON.parse(stdout.slice(start)); } catch { fail("Supabase Management API 返回不是合法 JSON。"); }
  const envelope = record(payload, "Supabase Management API 回执");
  const rows = envelope.rows;
  if (!Array.isArray(rows) || rows.length !== 1) fail("Supabase Management API 回执行数不符合预期。");
  const row = record(rows[0], "Supabase Management API 回执行");
  const value = row.result;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as JsonRecord;
  if (typeof value !== "string") fail("Supabase Management API 回执字段无效。");
  try { return record(JSON.parse(value), "Supabase Management API RPC 回执"); }
  catch { fail("Supabase Management API RPC 回执不是合法 JSON。"); }
}

async function runManagementQuery(profile: string, sql: string) {
  const scratch = await mkdtemp(join(tmpdir(), "jwb-management-query-"));
  try {
    const sqlPath = join(scratch, "query.sql");
    await writeFile(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    return await new Promise<JsonRecord>((resolvePromise, rejectPromise) => {
      const childEnv = { ...process.env };
      for (const key of ["SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_URL", "OPS_API_SECRET", "JIAOWUBAO_OPS_SECRET"]) delete childEnv[key];
      const child = spawn("npx", [
        "--yes", "supabase@2.115.0", "db", "query",
        "--profile", profile, "--linked", "--project-ref", PROJECT_REF,
        "--output-format", "json", "--file", sqlPath,
      ], { env: childEnv, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finishError = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        rejectPromise(new Error(message));
      };
      const timer = setTimeout(() => finishError("Supabase Management API 请求超时。"), QUERY_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_QUERY_OUTPUT_BYTES) {
          finishError("Supabase Management API 回执超过安全上限。");
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", () => finishError("Supabase CLI 无法启动。"));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          rejectPromise(new Error("Supabase Management API 请求失败。"));
          return;
        }
        try { resolvePromise(parseManagementResult(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { rejectPromise(error instanceof Error ? error : new Error("Supabase Management API 回执无效。")); }
      });
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function transaction(selectSql: string) {
  return `begin;\nset local statement_timeout = '30s';\n${selectSql}\ncommit;\n`;
}
async function rpc(profile: string, name: string, args: readonly string[]) {
  try {
    return await runManagementQuery(profile, transaction(`select internal.${name}(${args.join(", ")})::text as result;`));
  } catch {
    // Keep raw Management API errors out of terminal output: a failed stage
    // can include the page SQL, which is source evidence rather than a safe
    // aggregate receipt. The RPC name is enough to diagnose the protocol
    // phase without exposing a secret or schedule record.
    fail(`Supabase Management API ${name} 请求失败。`);
  }
}

function currentRevision(value: JsonRecord) {
  if (value.current === null || value.current === undefined) return null;
  const current = record(value.current, "当前快照");
  if (typeof current.revision !== "string" || !SHA256.test(current.revision)) fail("当前快照 revision 无效。");
  return current.revision;
}

export function parseManagementArguments(args: readonly string[]): ManagementOptions {
  const allowed = new Set(["--input", "--profile", "--actor", "--source-key", "--page-start", "--page-count", "--abort", "--abort-run-id", "--replace-current"]);
  const values = new Set(["--input", "--profile", "--actor", "--source-key", "--page-start", "--page-count", "--abort-run-id"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument) || seen.has(argument)) fail("参数无效。请使用 --help 查看用法。");
    seen.add(argument);
    if (values.has(argument)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) fail("参数缺少值。请使用 --help 查看用法。");
      index += 1;
    }
  }
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const input = value("--input");
  const profile = value("--profile") ?? process.env[PROFILE_ENV];
  const actor = value("--actor");
  const sourceKey = value("--source-key") ?? "jwb-open-api-schedule";
  const rawPageStart = value("--page-start");
  const rawPageCount = value("--page-count");
  const abort = args.includes("--abort");
  const abortRunId = value("--abort-run-id") ?? null;
  const pageStart = rawPageStart === undefined ? null : nonNegativeInteger(rawPageStart, "--page-start", 499);
  const pageCount = rawPageCount === undefined ? null : nonNegativeInteger(rawPageCount, "--page-count", 500);
  if (!profile || !actor || !["Nixon", "Ops Admin"].includes(actor)
    || (!input && !abortRunId) || (input && abortRunId)
    || !SOURCE_KEY.test(sourceKey)
    || (pageStart === null) !== (pageCount === null)
    || pageCount === 0
    || (abortRunId !== null && (!abort || !UUID.test(abortRunId)))) {
    fail("需要 --input 或 --abort-run-id、--profile、--actor；参数必须合法。");
  }
  return Object.freeze({
    input: input ? resolve(input) : null,
    profile: resolve(profile),
    actor: actor as ManagementOptions["actor"],
    sourceKey,
    pageStart,
    pageCount,
    abort,
    abortRunId,
    replaceCurrent: args.includes("--replace-current"),
  });
}

export async function runManagementStaging(options: ManagementOptions) {
  await ownerOnlyFile(options.profile, "--profile");
  if (options.abortRunId) {
    const aborted = await rpc(options.profile, "jiaowubao_open_api_schedule_management_abort", [dollarQuote(options.abortRunId), dollarQuote(options.actor)]);
    if (aborted.state !== "aborted") fail("abort 回执无效。");
    return { state: "aborted", runId: options.abortRunId };
  }
  if (!options.input) fail("缺少 --input。");
  const exported: ScheduleSnapshotExport = await readScheduleSnapshotExport(options.input);
  const preflight = await rpc(options.profile, "jiaowubao_open_api_schedule_management_preflight", [dollarQuote(options.sourceKey), dollarQuote(options.actor)]);
  const expectedCurrentRevision = currentRevision(preflight);
  if (expectedCurrentRevision !== null && expectedCurrentRevision !== exported.manifest.revision && !options.replaceCurrent) {
    fail("当前快照已有不同 revision；请确认后显式传入 --replace-current。");
  }
  const envelope = buildScheduleSnapshotEnvelope(exported, options.sourceKey, expectedCurrentRevision);
  const begin = await rpc(options.profile, "jiaowubao_open_api_schedule_management_begin", [jsonSql(envelope), dollarQuote(options.actor)]);
  const runId = String(begin.runId ?? "");
  if (!UUID.test(runId)) fail("begin runId 无效。");
  if (options.abort) {
    if (begin.state === "complete") fail("已完成的 run 不允许 abort。");
    const aborted = await rpc(options.profile, "jiaowubao_open_api_schedule_management_abort", [dollarQuote(runId), dollarQuote(options.actor)]);
    return { state: aborted.state, runId };
  }
  if (begin.state === "complete") return { state: "complete", runId, replayed: true };
  if (begin.state !== "staging") fail("begin 未返回 staging。");
  const expectedPageCount = exported.manifest.pageCount;
  const pageStart = options.pageStart ?? 0;
  const pageEndExclusive = options.pageCount === null
    ? expectedPageCount
    : pageStart + options.pageCount;
  if (pageStart >= expectedPageCount || pageEndExclusive > expectedPageCount) {
    fail("指定的分页范围超出导出清单。");
  }
  for (let pageIndex = pageStart; pageIndex < pageEndExclusive; pageIndex += 1) {
    const start = pageIndex * 100;
    const pageRows = exported.rows.slice(start, start + 100);
    let staged: JsonRecord;
    try {
      staged = await rpc(options.profile, "jiaowubao_open_api_schedule_management_stage", [dollarQuote(runId), String(pageIndex), jsonSql(pageRows), dollarQuote(options.actor)]);
    } catch {
      let status: JsonRecord;
      try { status = await rpc(options.profile, "jiaowubao_open_api_schedule_management_status", [dollarQuote(runId), dollarQuote(options.actor)]); }
      catch { fail("RPC 结果不确定，状态查询也失败；未自动重试，请先确认 run 状态。"); }
      process.stdout.write(`${JSON.stringify({ state: status.state, runId, pagesCommitted: status.pagesCommitted, rowsCommitted: status.rowsCommitted, statusChecked: true })}\n`);
      fail("RPC 结果不确定；已读取数据库状态，未自动重试。");
    }
    if (staged.pageIndex !== pageIndex || staged.rowCount !== pageRows.length) fail("stage 回执与本地页不一致。");
    process.stdout.write(`${JSON.stringify({ state: "staging", runId, pageIndex, pagesCommitted: pageIndex + 1, rowsCommitted: start + pageRows.length })}\n`);
  }
  const status = await rpc(options.profile, "jiaowubao_open_api_schedule_management_status", [dollarQuote(runId), dollarQuote(options.actor)]);
  if (status.state !== "staging" || status.pagesCommitted !== expectedPageCount || status.rowsCommitted !== exported.rows.length) {
    return {
      state: "staging",
      runId,
      pagesCommitted: status.pagesCommitted,
      rowsCommitted: status.rowsCommitted,
      expectedPageCount,
      expectedRowCount: exported.rows.length,
    };
  }
  let completed: JsonRecord;
  try {
    completed = await rpc(options.profile, "jiaowubao_open_api_schedule_management_complete", [dollarQuote(runId), dollarQuote(options.actor)]);
  } catch {
    let status: JsonRecord;
    try { status = await rpc(options.profile, "jiaowubao_open_api_schedule_management_status", [dollarQuote(runId), dollarQuote(options.actor)]); }
    catch { fail("complete 结果不确定，状态查询也失败；未自动重试。"); }
    process.stdout.write(`${JSON.stringify({ state: status.state, runId, pagesCommitted: status.pagesCommitted, rowsCommitted: status.rowsCommitted, statusChecked: true })}\n`);
    fail("complete 结果不确定；已读取数据库状态，未自动重试。");
  }
  if (completed.state !== "complete" || !SHA256.test(String(completed.rowsSha256 ?? "")) || !SHA256.test(String(completed.payloadSha256 ?? ""))) fail("complete 回执未返回服务端 canonical hash。");
  return { state: "complete", runId, rowCount: completed.rowCount, rowsSha256: completed.rowsSha256, payloadSha256: completed.payloadSha256 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--help")) {
    process.stdout.write("node --import tsx scripts/jiaowubao-open-api-schedule-management-staging.ts --input DIR --profile /private/tmp/insider-leads-supabase-profile.yaml --actor 'Nixon' [--page-start N --page-count N] [--replace-current] [--abort]\n");
  } else {
    runManagementStaging(parseManagementArguments(process.argv.slice(2)))
      .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
      .catch((error: unknown) => {
        process.stderr.write(`Jiaowubao Management API staging failed: ${error instanceof Error ? error.message : "Unexpected failure."}\n`);
        process.exitCode = 1;
      });
  }
}
