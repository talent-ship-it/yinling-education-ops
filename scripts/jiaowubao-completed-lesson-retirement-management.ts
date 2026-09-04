#!/usr/bin/env node

/**
 * One-time, owner-only Management API bridge that retires an exact blocked
 * query_lesson_list collection so the ordinary cron can rebuild it from
 * scratch. The project credential wrapper supplies only the approved
 * Supabase Management API token; this command never persists or prints it and
 * never reads JWB, OPS, database-password, cron, or service-role secrets. The
 * database preview returns only an opaque confirmation key and aggregate
 * counters; a separate --commit invocation reuses the same locally persisted
 * command UUID for safe lost-response retry.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT_REF = "orvsgisjjrzgtxuwwsms";
const COMPANY_PROFILE = "insiderlead";
const CREDENTIAL_HELPER = "/Users/nixon/Documents/Codex/bin/codex-project-credential";
const SUPABASE_WORKDIR = "/Users/nixon/Projects/Insiderleadsedu/supabase";
const STATE_SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 16 * 1024;
const MAX_QUERY_OUTPUT_BYTES = 128 * 1024;
const QUERY_TIMEOUT_MS = 60_000;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type JsonRecord = Record<string, unknown>;
type Actor = "Nixon" | "Ops Admin";

export type CompletedLessonRetirementManagementOptions = Readonly<{
  state: string;
  month: string;
  actor: Actor;
  commit: boolean;
}>;

type RetirementState = Readonly<{
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  month: string;
  confirmationKey: string;
  commandId: string;
}>;

type SafeReceipt = Readonly<{
  phase: "preview" | "commit";
  month: string;
  confirmationKey?: string;
  state?: "aborted";
  reason?: "schedule_changed";
  memberCount: number;
  completedMemberCount: number;
  rowCount: number;
  canCommit?: true;
  replayed?: boolean;
}>;

function fail(message: string): never { throw new Error(message); }

function usage() {
  return [
    "Usage:",
    `  CODEX_COMPANY_PROFILE=${COMPANY_PROFILE} ${CREDENTIAL_HELPER} exec supabase -- \\`,
    "    node --import tsx scripts/jiaowubao-completed-lesson-retirement-management.ts \\",
    "    --state /absolute/path/to/owner-only/retirement-state.json \\",
    "    --month YYYY-MM --actor Nixon",
    "",
    "After reviewing the aggregate preview, run the same command with --commit.",
    "Keep the state file for any retry; it contains the stable command UUID and opaque confirmation key.",
  ].join("\n");
}

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 无效。`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} 字段无效。`);
  }
}

function dollarQuote(value: string) {
  const base = `jwb_retire_${value.replace(/[^A-Za-z0-9_]/gu, "").slice(0, 24) || "value"}`;
  let tag = base;
  while (value.includes(`$${tag}$`)) tag += "_x";
  return `$${tag}$${value}$${tag}$`;
}

async function ownerOnlyFile(path: string, label: string, maximum: number) {
  const stat = await lstat(path).catch(() => null);
  const owner = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > maximum
      || (stat.mode & 0o077) !== 0 || (owner !== null && stat.uid !== owner)) {
    fail(`${label} 必须是当前用户拥有的 owner-only 普通文件。`);
  }
  return stat;
}

async function ownerOnlyStateDirectory(path: string) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory).catch(() => null);
  const owner = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()
      || (stat.mode & 0o077) !== 0 || (owner !== null && stat.uid !== owner)) {
    fail("--state 的父目录必须是当前用户拥有的 owner-only 目录。");
  }
}

export function assertCompletedLessonRetirementCredentialEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const token = environment.SUPABASE_ACCESS_TOKEN;
  if (environment.CODEX_COMPANY_PROFILE !== COMPANY_PROFILE
      || typeof token !== "string" || token.length < 20 || token.length > 4096
      || token !== token.trim() || /[\u0000-\u0020\u007f]/u.test(token)) {
    fail("必须通过 Insider Leads codex-project-credential Supabase 包装器运行。");
  }
}

export function parseCompletedLessonRetirementState(value: unknown, expectedMonth: string): RetirementState {
  const parsed = object(value, "退役状态文件");
  exactKeys(parsed, ["schemaVersion", "month", "confirmationKey", "commandId"], "退役状态文件");
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION || parsed.month !== expectedMonth
      || typeof parsed.confirmationKey !== "string" || !SHA256.test(parsed.confirmationKey)
      || typeof parsed.commandId !== "string" || !UUID.test(parsed.commandId)) {
    fail("退役状态文件与本次月份或命令不匹配。");
  }
  return Object.freeze({
    schemaVersion: STATE_SCHEMA_VERSION,
    month: expectedMonth,
    confirmationKey: parsed.confirmationKey,
    commandId: parsed.commandId,
  });
}

export async function readCompletedLessonRetirementState(path: string, month: string) {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return null;
  await ownerOnlyFile(path, "--state", MAX_STATE_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch { fail("退役状态文件不是合法 JSON。"); }
  return parseCompletedLessonRetirementState(parsed, month);
}

export async function createCompletedLessonRetirementState(path: string, state: RetirementState) {
  await ownerOnlyStateDirectory(path);
  if (await lstat(path).catch(() => null)) fail("退役状态文件已存在；请复用它，不要生成新命令。");
  const temporary = join(dirname(path), `.retirement-state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // link() is an atomic no-overwrite publication on the same filesystem.
    // It preserves a competing valid state instead of replacing its command.
    await link(temporary, path).catch(() => fail("退役状态文件创建冲突；请检查并复用已存在的文件。"));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  await ownerOnlyFile(path, "--state", MAX_STATE_BYTES);
}

function parseManagementResult(stdout: string): JsonRecord {
  const start = stdout.indexOf("{");
  if (start < 0) fail("Supabase Management API 没有返回 JSON。");
  let payload: unknown;
  try { payload = JSON.parse(stdout.slice(start)); }
  catch { fail("Supabase Management API 返回不是合法 JSON。"); }
  const envelope = object(payload, "Supabase Management API 回执");
  if (!Array.isArray(envelope.rows) || envelope.rows.length !== 1) {
    fail("Supabase Management API 回执行数不符合预期。");
  }
  const row = object(envelope.rows[0], "Supabase Management API 回执行");
  if (typeof row.result === "object" && row.result !== null && !Array.isArray(row.result)) {
    return row.result as JsonRecord;
  }
  if (typeof row.result !== "string") fail("Supabase Management API 回执字段无效。");
  try { return object(JSON.parse(row.result), "Supabase Management API RPC 回执"); }
  catch { fail("Supabase Management API RPC 回执不是合法 JSON。"); }
}

async function runManagementQuery(sql: string) {
  const scratch = await mkdtemp(join(tmpdir(), "jwb-completed-lesson-retirement-query-"));
  try {
    const sqlPath = join(scratch, "query.sql");
    await writeFile(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    return await new Promise<JsonRecord>((resolvePromise, rejectPromise) => {
      const childEnvironment = { ...process.env };
      // Do not let an ambient application/database credential silently change
      // the management path. SUPABASE_ACCESS_TOKEN is the one exception: the
      // required project credential wrapper injects it into this process and
      // it must reach the pinned CLI child without entering arguments, files,
      // or output.
      for (const key of Object.keys(childEnvironment)) {
        if (key === "SUPABASE_ACCESS_TOKEN" || key === "CODEX_COMPANY_PROFILE") continue;
        if (/^(?:SUPABASE_|JIAOWUBAO_|OPS_|CRON_)/u.test(key)
            || /(?:^|_)(?:DATABASE_URL|DB_URL|POSTGRES_URL|PASSWORD|SECRET|TOKEN|SERVICE_ROLE_KEY)$/u.test(key)
            || key === "PGPASSFILE" || key === "PGPASSWORD") {
          delete childEnvironment[key];
        }
      }
      const child = spawn("npx", [
        "--yes", "supabase@2.115.0", "db", "query",
        "--workdir", SUPABASE_WORKDIR,
        "--linked", "--project-ref", PROJECT_REF, "--agent", "yes",
        "--output-format", "json", "--file", sqlPath,
      ], { env: childEnvironment, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const failChild = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        rejectPromise(new Error(message));
      };
      const timer = setTimeout(() => failChild("Supabase Management API 请求超时。"), QUERY_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_QUERY_OUTPUT_BYTES) return failChild("Supabase Management API 回执超过安全上限。");
        chunks.push(chunk);
      });
      child.on("error", () => failChild("Supabase CLI 无法启动。"));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) return rejectPromise(new Error("Supabase Management API 请求失败。"));
        try { resolvePromise(parseManagementResult(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { rejectPromise(error instanceof Error ? error : new Error("Supabase Management API 回执无效。")); }
      });
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function rpc(name: string, argumentsSql: readonly string[]) {
  const sql = [
    "begin;",
    "set local statement_timeout = '30s';",
    `select internal.${name}(${argumentsSql.join(", ")})::text as result;`,
    "commit;",
    "",
  ].join("\n");
  try { return await runManagementQuery(sql); }
  catch { fail(`Supabase Management API ${name} 请求失败。`); }
}

function integer(value: JsonRecord, key: string, maximum = 6000) {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < 0 || (field as number) > maximum) {
    fail(`服务器回执 ${key} 无效。`);
  }
  return field as number;
}

function validateCounters(value: JsonRecord) {
  const memberCount = integer(value, "memberCount");
  const completedMemberCount = integer(value, "completedMemberCount");
  const rowCount = integer(value, "rowCount");
  if (memberCount < 1 || completedMemberCount > memberCount) fail("服务器回执计数无效。");
  return { memberCount, completedMemberCount, rowCount };
}

export function validateCompletedLessonRetirementPreviewReceipt(value: JsonRecord, month: string): SafeReceipt {
  exactKeys(value, [
    "phase", "month", "confirmationKey", "memberCount",
    "completedMemberCount", "rowCount", "canCommit",
  ], "服务器预检回执");
  if (value.phase !== "preview" || value.month !== month || value.canCommit !== true
      || typeof value.confirmationKey !== "string" || !SHA256.test(value.confirmationKey)) {
    fail("服务器预检回执无效。");
  }
  return Object.freeze({
    phase: "preview",
    month,
    confirmationKey: value.confirmationKey,
    ...validateCounters(value),
    canCommit: true,
  });
}

export function validateCompletedLessonRetirementCommitReceipt(value: JsonRecord, month: string): SafeReceipt {
  exactKeys(value, [
    "phase", "month", "state", "reason", "memberCount",
    "completedMemberCount", "rowCount", "replayed",
  ], "服务器提交回执");
  if (value.phase !== "commit" || value.month !== month || value.state !== "aborted"
      || value.reason !== "schedule_changed"
      || typeof value.replayed !== "boolean") fail("服务器提交回执无效。");
  return Object.freeze({
    phase: "commit",
    month,
    state: "aborted",
    reason: "schedule_changed",
    ...validateCounters(value),
    replayed: value.replayed,
  });
}

export function parseCompletedLessonRetirementManagementArguments(
  args: readonly string[],
): CompletedLessonRetirementManagementOptions {
  const allowed = new Set(["--state", "--month", "--actor", "--commit"]);
  const valued = new Set(["--state", "--month", "--actor"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument) || seen.has(argument)) fail("参数无效。请使用 --help 查看用法。");
    seen.add(argument);
    if (valued.has(argument)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) fail("参数缺少值。请使用 --help 查看用法。");
      index += 1;
    }
  }
  const after = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const state = after("--state");
  const month = after("--month");
  const actor = after("--actor");
  if (!state || !month || !MONTH.test(month)
      || (actor !== "Nixon" && actor !== "Ops Admin")) {
    fail("需要合法的 --state、--month 和 --actor。");
  }
  return Object.freeze({
    state: resolve(state), month, actor,
    commit: args.includes("--commit"),
  });
}

export async function runCompletedLessonRetirementManagement(
  options: CompletedLessonRetirementManagementOptions,
) {
  assertCompletedLessonRetirementCredentialEnvironment();
  await ownerOnlyStateDirectory(options.state);
  const savedState = await readCompletedLessonRetirementState(options.state, options.month);

  if (options.commit) {
    if (!savedState) fail("提交前必须先运行预检并保留同一个 --state 文件。");
    const committed = validateCompletedLessonRetirementCommitReceipt(await rpc(
      "jiaowubao_completed_lesson_retirement_management_commit",
      [
        dollarQuote(options.month),
        dollarQuote(savedState.confirmationKey),
        `${dollarQuote(savedState.commandId)}::uuid`,
        dollarQuote(options.actor),
      ],
    ), options.month);
    process.stdout.write(`${JSON.stringify(committed)}\n`);
    return committed;
  }

  const preview = validateCompletedLessonRetirementPreviewReceipt(await rpc(
    "jiaowubao_completed_lesson_retirement_management_preview",
    [dollarQuote(options.month), dollarQuote(options.actor)],
  ), options.month);
  if (savedState) {
    if (savedState.confirmationKey !== preview.confirmationKey) {
      fail("阻断代次或冻结证据已变化；旧退役状态文件不会重新绑定。");
    }
  } else {
    await createCompletedLessonRetirementState(options.state, Object.freeze({
      schemaVersion: STATE_SCHEMA_VERSION,
      month: options.month,
      confirmationKey: preview.confirmationKey!,
      commandId: randomUUID(),
    }));
  }
  process.stdout.write(`${JSON.stringify(preview)}\n`);
  return preview;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
  } else {
    runCompletedLessonRetirementManagement(
      parseCompletedLessonRetirementManagementArguments(process.argv.slice(2)),
    ).catch((error: unknown) => {
      process.stderr.write(`Jiaowubao completed-lesson retirement failed: ${error instanceof Error ? error.message : "Unexpected failure."}\n`);
      process.exitCode = 1;
    });
  }
}
