#!/usr/bin/env node

/**
 * Owner-only bridge for the local Jiaowubao Open API schedule export.
 *
 * Input is the export directory produced by
 * jiaowubao-open-api-schedule-export.ts.  The command deliberately uses
 * direct psql because the snapshot RPCs have no anon/authenticated grants.
 * Each page is one independent psql transaction; completion is a separate
 * transaction. JSON and the secret travel on stdin/environment, never argv.
 *
 * Stable sourceKey is `jwb-open-api:schedule:${cal_id}` from the trimmed,
 * non-empty JWB cal_id. Numeric and string representations of the same ID
 * intentionally collide. The CLI does
 * not calculate a PostgreSQL hash: completion returns the database's
 * canonical jsonb::text rowsSha256 and payloadSha256.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import {
  JIAOWUBAO_SCHEDULE_SNAPSHOT_FIELDS,
  JIAOWUBAO_SCHEDULE_SNAPSHOT_FORMAT,
  JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_STUDENTS_PER_RECORD,
  JIAOWUBAO_SCHEDULE_STUDENT_FIELDS,
} from "../lib/jiaowubao-open-api-schedule-snapshot";

const LEGACY_FORMAT = "jiaowubao-schedule-export/v1";
const FORMATS = new Set([LEGACY_FORMAT, JIAOWUBAO_SCHEDULE_SNAPSHOT_FORMAT]);
const DEFAULT_SOURCE_KEY = "jwb-open-api-schedule";
const DEFAULT_SECRET_ENV = "JIAOWUBAO_OPS_SECRET";
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 60;
const MAX_ROWS = 6_000;
const MAX_PSQL_STDOUT_BYTES = 64 * 1024;
const PSQL_TIMEOUT_MS = 45_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/u;
const CAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const LEGACY_EVIDENCE_FIELDS = new Set([
  "cal_id", "type", "appoint", "team_id", "team_title", "course_id", "course_title",
  "room_id", "room_title", "teacher_id", "teacher_title", "teacher_s", "teacher_t",
  "dated", "time_start", "time_end", "cal_length", "hours", "created", "live",
  "max_num", "mem_max", "mem_num", "mem_num_sign", "mem_num_not_sign", "mem_num_leave",
  "mem_leave", "mem_arrive", "arrive_percent", "mem_not_comment", "all_leave", "over",
  "over_state", "over_time",
]);
const SNAPSHOT_FIELDS = new Set(JIAOWUBAO_SCHEDULE_SNAPSHOT_FIELDS);
const STUDENT_FIELDS = new Set(JIAOWUBAO_SCHEDULE_STUDENT_FIELDS);

type JsonRecord = Record<string, unknown>;
type Manifest = Readonly<{
  format: string;
  source: "jiaowubao-open-api";
  tool: "query_schedule_list";
  query: Readonly<{ start: string; end: string; limit: number; order: "asc" }>;
  pageCount: number;
  recordCount: number;
  recordsSha256: string;
  manifestSha256: string;
  revision: string;
  pages: readonly Readonly<{ page: number; recordCount: number; sha256: string; file: string }>[];
}>;
type SnapshotRow = Readonly<{ sourceKey: string; record: JsonRecord }>;
export type ScheduleSnapshotExport = Readonly<{ manifest: Manifest; manifestSha256: string; rows: readonly SnapshotRow[] }>;
export type ScheduleSnapshotCliOptions = Readonly<{
  input: string | null;
  databaseUrlEnv: string;
  secretEnv: string;
  sourceKey: string;
  actor: string;
  abort: boolean;
  abortRunId: string | null;
  replaceCurrent: boolean;
}>;

function fail(message: string): never { throw new Error(message); }
function digest(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 无效。`);
  return value as JsonRecord;
}
function ownerOnlyFile(path: string, label: string, maxBytes: number) {
  return lstat(path).then((entry) => {
    if (entry.isSymbolicLink() || !entry.isFile() || (entry.mode & 0o077) !== 0 || entry.size > maxBytes) fail(`${label} 必须是 owner-only 普通文件。`);
  });
}
async function ownerOnlyDirectory(path: string) {
  const entry = await lstat(path).catch(() => null);
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory() || (entry.mode & 0o077) !== 0) fail("--input 必须是 owner-only 导出目录。");
}
function stableSourceKey(value: unknown) {
  const source = record(value, "排课记录");
  const raw = source.cal_id;
  const safeNumericId = typeof raw === "number" && Number.isSafeInteger(raw);
  if ((typeof raw !== "string" && !safeNumericId) || !String(raw).trim()) fail("排课记录缺少非空 cal_id。");
  const calId = String(raw).trim();
  if (!CAL_ID.test(calId)) fail("cal_id 含有不支持的字符。");
  const key = `jwb-open-api:schedule:${calId}`;
  if (!SOURCE_KEY.test(key)) fail("cal_id 含有不支持的 sourceKey 字符。");
  return key;
}
function safeStudentList(value: unknown) {
  if (!Array.isArray(value) || value.length > JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_STUDENTS_PER_RECORD || value.some((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return true;
    return Object.keys(candidate as JsonRecord).some((key) => !STUDENT_FIELDS.has(key));
  })) fail("排课记录学员明细包含未允许的字段。");
  return value;
}
function safeRecord(value: unknown, format: string) {
  const source = record(value, "排课记录");
  const fields = format === LEGACY_FORMAT ? LEGACY_EVIDENCE_FIELDS : SNAPSHOT_FIELDS;
  if (Object.keys(source).some((key) => !fields.has(key))) fail("排课记录包含未允许的字段。");
  if (format === JIAOWUBAO_SCHEDULE_SNAPSHOT_FORMAT && source.stu_list !== undefined) {
    safeStudentList(source.stu_list);
  }
  stableSourceKey(source);
  // SQL deliberately accepts only a string cal_id. Normalize numeric API
  // representations before constructing the {sourceKey,record} wrapper.
  return Object.freeze({ ...source, cal_id: String(source.cal_id).trim() });
}
function dollarQuote(value: string) {
  let tag = `jwb_${digest(value).slice(0, 24)}`;
  while (value.includes(`$${tag}$`)) tag += "_x";
  return `$${tag}$${value}$${tag}$`;
}
function jsonSql(value: unknown) { return dollarQuote(JSON.stringify(value)); }

export async function readScheduleSnapshotExport(input: string): Promise<ScheduleSnapshotExport> {
  await ownerOnlyDirectory(input);
  const manifestPath = join(input, "manifest.json");
  await ownerOnlyFile(manifestPath, "manifest.json", MAX_MANIFEST_BYTES);
  const manifestBytes = await readFile(manifestPath);
  let parsed: unknown;
  try { parsed = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("manifest.json 不是合法 JSON。"); }
  const manifest = record(parsed, "manifest.json") as Manifest;
  if (!FORMATS.has(manifest.format) || manifest.source !== "jiaowubao-open-api" || manifest.tool !== "query_schedule_list") fail("manifest 格式不受支持。");
  if (!manifest.query || manifest.query.limit !== 100 || manifest.query.order !== "asc") fail("manifest query 不是固定安全查询。");
  if (!Number.isSafeInteger(manifest.pageCount) || manifest.pageCount < 0 || manifest.pageCount > MAX_PAGES || !Number.isSafeInteger(manifest.recordCount) || manifest.recordCount < 0 || manifest.recordCount > MAX_ROWS) fail("manifest 页数或行数无效。");
  if (!/^sha256:[a-f0-9]{64}$/u.test(manifest.recordsSha256) || !/^sha256:[a-f0-9]{64}$/u.test(String((manifest as JsonRecord).manifestSha256 ?? "")) || String((manifest as JsonRecord).revision ?? "") !== String((manifest as JsonRecord).manifestSha256 ?? "") || !Array.isArray(manifest.pages) || manifest.pages.length !== manifest.pageCount) fail("manifest 摘要或页清单无效。");
  const manifestPayload = {
    format: manifest.format,
    source: manifest.source,
    tool: manifest.tool,
    query: manifest.query,
    pageCount: manifest.pageCount,
    recordCount: manifest.recordCount,
    recordsSha256: manifest.recordsSha256,
    pages: manifest.pages,
  };
  if (`sha256:${digest(JSON.stringify(manifestPayload))}` !== manifest.manifestSha256) fail("manifestSha256 与 manifest 内容不匹配。");
  const expectedRecordsSha256 = `sha256:${digest(JSON.stringify(manifest.pages.map(({ page, recordCount, sha256 }) => ({
    page,
    recordCount,
    sha256,
  }))))}`;
  if (manifest.recordsSha256 !== expectedRecordsSha256) fail("recordsSha256 与分页摘要不匹配。");
  const files = new Set(await readdir(input));
  const rows: SnapshotRow[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < manifest.pages.length; index += 1) {
    const page = record(manifest.pages[index], `manifest page ${index}`);
    if (page.page !== index + 1 || !Number.isSafeInteger(page.recordCount) || page.recordCount < 1 || page.recordCount > 100 || (index < manifest.pages.length - 1 && page.recordCount !== 100) || typeof page.file !== "string" || !/^page-\d{4}\.json$/u.test(page.file) || typeof page.sha256 !== "string" || !SHA256.test(page.sha256)) fail("manifest 页清单无效。");
    if (!files.delete(page.file)) fail("manifest 引用的页文件缺失或重复。");
    const pagePath = join(input, page.file);
    await ownerOnlyFile(pagePath, page.file, MAX_PAGE_BYTES);
    const bytes = await readFile(pagePath);
    if (!bytes.toString("utf8").endsWith("\n") || `sha256:${digest(bytes.subarray(0, bytes.length - 1))}` !== page.sha256) fail(`页 ${page.page} 摘要不匹配。`);
    let pageValue: unknown;
    try { pageValue = JSON.parse(bytes.toString("utf8")); } catch { fail(`页 ${page.page} 不是合法 JSON。`); }
    if (!Array.isArray(pageValue) || pageValue.length !== page.recordCount || pageValue.length < 1) fail(`页 ${page.page} 行数不匹配。`);
    for (const raw of pageValue) {
      const safe = safeRecord(raw, manifest.format);
      const sourceKey = stableSourceKey(safe);
      if (seen.has(sourceKey)) fail(`跨页重复 cal_id：${sourceKey}。`);
      seen.add(sourceKey);
      rows.push({ sourceKey, record: safe });
    }
  }
  if (files.size !== 1 || !files.has("manifest.json") || rows.length !== manifest.recordCount) fail("导出目录包含未声明文件或总行数不匹配。");
  return Object.freeze({ manifest, manifestSha256: manifest.manifestSha256, rows });
}

export function buildScheduleSnapshotEnvelope(
  exported: ScheduleSnapshotExport,
  sourceKey = DEFAULT_SOURCE_KEY,
  expectedCurrentRevision: string | null = null,
) {
  if (!SOURCE_KEY.test(sourceKey)) fail("sourceKey 无效。");
  if (expectedCurrentRevision !== null && !SHA256.test(expectedCurrentRevision)) fail("当前快照 revision 无效。");
  return Object.freeze({
    apiSourceKey: sourceKey,
    revision: exported.manifest.manifestSha256,
    query: exported.manifest.query,
    expectedPageCount: exported.manifest.pageCount,
    expectedRowCount: exported.manifest.recordCount,
    expectedCurrentRevision,
    externalManifestSha256: exported.manifest.manifestSha256,
    sourceMetadata: {
      exportFormat: exported.manifest.format,
      manifestSha256: exported.manifest.manifestSha256,
      recordsSha256: exported.manifest.recordsSha256,
    },
  });
}

function databaseEnvironment(raw: string) {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { fail("数据库连接 URL 无效。"); }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") fail("数据库连接 URL 必须是 PostgreSQL URL。");
  if (!parsed.hostname || !["db.orvsgisjjrzgtxuwwsms.supabase.co", "localhost", "127.0.0.1"].includes(parsed.hostname)) fail("数据库主机不是 Insider Leads 项目或本地测试实例。");
  return {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//u, "")),
    PGSSLMODE: parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" ? "disable" : "require",
    PGCONNECT_TIMEOUT: "15",
  };
}

async function runPsql(databaseUrl: string, sql: string) {
  const connectionEnv = databaseEnvironment(databaseUrl);
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { env: { ...process.env, ...connectionEnv }, stdio: ["pipe", "pipe", "ignore"] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => failPsql("psql 请求超时。"), PSQL_TIMEOUT_MS);
    const failPsql = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(new Error(message));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_PSQL_STDOUT_BYTES) {
        failPsql("psql 回执超过安全上限。");
        return;
      }
      stdout.push(chunk);
    });
    child.on("error", () => failPsql("psql 无法启动。"));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(`psql 请求失败（${code}）。`));
    });
    child.stdin.end(sql);
  });
}
async function rpc(databaseUrl: string, name: string, secret: string, args: readonly string[]) {
  // Explicit transaction boundaries make the independently committed page
  // protocol obvious and keep a begin/stage/complete payload in one psql
  // session without putting JSON or credentials in argv.
  const output = await runPsql(databaseUrl, `begin;\nset local statement_timeout = '30s';\nselect public.${name}(${[dollarQuote(secret), ...args].join(", ")})::text;\ncommit;\n`);
  if (!output) fail(`psql ${name} 返回为空。`);
  try {
    const value = JSON.parse(output);
    return record(value, `psql ${name} 返回`);
  } catch { fail(`psql ${name} 返回不是 JSON。`); }
}

async function statusAfterUncertain(databaseUrl: string, secret: string, runId: string, actor: string): Promise<never> {
  let status: JsonRecord;
  try {
    status = await rpc(databaseUrl, "get_jiaowubao_open_api_schedule_snapshot_ingest_status", secret, [dollarQuote(runId), dollarQuote(actor)]);
  } catch {
    fail("RPC 结果不确定，状态查询也失败；未自动重试，请先从数据库确认 run 状态。");
  }
  const receipt = {
    state: String(status.state ?? "unknown"),
    runId,
    pagesCommitted: status.pagesCommitted,
    rowsCommitted: status.rowsCommitted,
    canonicalRowsSha256: status.canonicalRowsSha256,
    payloadSha256: status.payloadSha256,
    statusChecked: true,
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  fail("RPC 结果不确定；已读取数据库状态，未自动重试。");
}

export function parseArguments(args: readonly string[]): ScheduleSnapshotCliOptions {
  const allowed = new Set(["--input", "--database-url-env", "--ops-secret-env", "--source-key", "--actor", "--abort", "--abort-run-id", "--replace-current"]);
  const valueFlags = new Set(["--input", "--database-url-env", "--ops-secret-env", "--source-key", "--actor", "--abort-run-id"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument) || seen.has(argument)) fail("参数无效。请使用 --help 查看用法。");
    seen.add(argument);
    if (valueFlags.has(argument)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) fail("参数缺少值。请使用 --help 查看用法。");
      index += 1;
    }
  }
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const input = value("--input");
  const databaseUrlEnv = value("--database-url-env");
  const secretEnv = value("--ops-secret-env") ?? DEFAULT_SECRET_ENV;
  const sourceKey = value("--source-key") ?? DEFAULT_SOURCE_KEY;
  const actor = value("--actor");
  const abort = args.includes("--abort");
  const abortRunId = value("--abort-run-id") ?? null;
  if ((!input && !abortRunId) || (input && abortRunId) || !databaseUrlEnv || !actor || !["Nixon", "Ops Admin"].includes(actor) || !SOURCE_KEY.test(sourceKey) || !/^[A-Z_][A-Z0-9_]*$/u.test(databaseUrlEnv) || !/^[A-Z_][A-Z0-9_]*$/u.test(secretEnv) || (abortRunId !== null && (!abort || !UUID.test(abortRunId)))) fail("需要 --input 或 --abort-run-id、--database-url-env、--actor；环境变量名/source key 必须合法。");
  return Object.freeze({ input: input ? resolve(input) : null, databaseUrlEnv, secretEnv, sourceKey, actor, abort, abortRunId, replaceCurrent: args.includes("--replace-current") });
}

function currentRevisionFromPreflight(value: JsonRecord) {
  const current = value.current;
  if (current === null || current === undefined) return null;
  const currentRecord = record(current, "当前快照 preflight");
  const revision = currentRecord.revision;
  if (typeof revision !== "string" || !SHA256.test(revision)) fail("当前快照 preflight 无效。");
  return revision;
}

function assertStagingPagesWithinLimit(rows: readonly SnapshotRow[]) {
  for (let start = 0; start < rows.length; start += 100) {
    if (Buffer.byteLength(JSON.stringify(rows.slice(start, start + 100)), "utf8") > MAX_PAGE_BYTES) {
      fail("导出页在来源键封装后超过数据库安全上限。");
    }
  }
}

export async function runScheduleSnapshotStaging(options: ScheduleSnapshotCliOptions) {
  const databaseUrl = process.env[options.databaseUrlEnv];
  const secret = process.env[options.secretEnv];
  if (!databaseUrl || !secret) fail("数据库 URL 或 ops secret 环境变量未设置。");
  if (options.abortRunId !== null) {
    const aborted = await rpc(databaseUrl, "abort_jiaowubao_open_api_schedule_snapshot_ingest", secret, [dollarQuote(options.abortRunId), dollarQuote(options.actor)]);
    if (aborted.state !== "aborted") fail("abort 回执无效。");
    return { state: "aborted", runId: options.abortRunId };
  }
  if (options.input === null) fail("缺少导出目录。");
  const exported = await readScheduleSnapshotExport(options.input);
  assertStagingPagesWithinLimit(exported.rows);
  const preflight = await rpc(databaseUrl, "get_jiaowubao_open_api_schedule_snapshot_preflight", secret, [dollarQuote(options.sourceKey), dollarQuote(options.actor)]);
  const expectedCurrentRevision = currentRevisionFromPreflight(preflight);
  if (expectedCurrentRevision !== null && expectedCurrentRevision !== exported.manifest.revision && !options.replaceCurrent) {
    fail("当前快照已是不同 revision；为避免旧导出覆盖，请确认后显式传入 --replace-current。");
  }
  const envelope = buildScheduleSnapshotEnvelope(exported, options.sourceKey, expectedCurrentRevision);
  const begin = await rpc(databaseUrl, "begin_jiaowubao_open_api_schedule_snapshot_ingest", secret, [jsonSql(envelope), dollarQuote(options.actor)]);
  const runId = String(begin.runId ?? "");
  if (!UUID.test(runId)) fail("begin runId 无效。");
  if (options.abort) {
    if (begin.state === "complete") fail("已完成的 run 不允许 abort。");
    const aborted = await rpc(databaseUrl, "abort_jiaowubao_open_api_schedule_snapshot_ingest", secret, [dollarQuote(runId), dollarQuote(options.actor)]);
    return { state: aborted.state, runId };
  }
  if (begin.state === "complete") return { state: "complete", runId, replayed: true };
  if (begin.state !== "staging") fail("begin 未返回 staging。");
  for (let start = 0, pageIndex = 0; start < exported.rows.length; start += 100, pageIndex += 1) {
    const pageRows = exported.rows.slice(start, start + 100);
    let staged: JsonRecord;
    try {
      staged = await rpc(databaseUrl, "stage_jiaowubao_open_api_schedule_snapshot_page", secret, [dollarQuote(runId), String(pageIndex), jsonSql(pageRows), dollarQuote(options.actor)]);
    } catch {
      return statusAfterUncertain(databaseUrl, secret, runId, options.actor);
    }
    if (staged.pageIndex !== pageIndex || staged.rowCount !== pageRows.length) fail("stage 回执与本地页不一致。");
    process.stdout.write(`${JSON.stringify({ state: "staging", runId, pageIndex, pagesCommitted: pageIndex + 1, rowsCommitted: start + pageRows.length })}\n`);
  }
  let completed: JsonRecord;
  try {
    completed = await rpc(databaseUrl, "complete_jiaowubao_open_api_schedule_snapshot_ingest", secret, [dollarQuote(runId), dollarQuote(options.actor)]);
  } catch {
    return statusAfterUncertain(databaseUrl, secret, runId, options.actor);
  }
  if (completed.state !== "complete" || !SHA256.test(String(completed.rowsSha256 ?? "")) || !SHA256.test(String(completed.payloadSha256 ?? ""))) fail("complete 回执未返回服务端 canonical hash。");
  return { state: "complete", runId, rowCount: completed.rowCount, rowsSha256: completed.rowsSha256, payloadSha256: completed.payloadSha256 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--help")) process.stdout.write("node --import tsx scripts/jiaowubao-open-api-schedule-staging.ts --input DIR --database-url-env SUPABASE_DB_URL --actor 'Nixon' [--replace-current] [--abort]\n# 或：--abort --abort-run-id RUN_UUID --database-url-env SUPABASE_DB_URL --actor 'Nixon'\n");
  else runScheduleSnapshotStaging(parseArguments(process.argv.slice(2))).then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`)).catch((error: unknown) => { process.stderr.write(`Jiaowubao schedule staging failed: ${error instanceof Error ? error.message : "Unexpected failure."}\n`); process.exitCode = 1; });
}
