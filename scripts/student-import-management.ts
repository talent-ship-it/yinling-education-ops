#!/usr/bin/env node

/**
 * Owner-only Management API bridge for the formal student import.
 *
 * The database computes the source snapshot and performs the final canonical
 * import validation.  This CLI only holds the server-owned plan in memory long
 * enough to run the existing TypeScript planner; it prints aggregate receipts
 * and never prints source rows, student records, or credentials.
 */

import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertStudentImportCommit,
  prepareStudentImport,
  type PreparedStudentImport,
} from "../lib/student-import-service.ts";

const PROJECT_REF = "orvsgisjjrzgtxuwwsms";
const QUERY_TIMEOUT_MS = 120_000;
const MAX_QUERY_OUTPUT_BYTES = 16 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ACTORS = new Set(["Nixon", "Ops Admin"]);

type JsonRecord = Record<string, unknown>;
type ManagementOptions = Readonly<{
  profile: string;
  actor: "Nixon" | "Ops Admin";
  commit: boolean;
  confirmationKey: string | null;
  expectedStudentVersion: number | null;
}>;

function fail(message: string): never { throw new Error(message); }

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 无效。`);
  return value as JsonRecord;
}

function dollarQuote(value: string) {
  const base = `student_mgmt_${value.replace(/[^A-Za-z0-9_]/gu, "").slice(0, 24) || "sql"}`;
  let tag = base;
  while (value.includes(`$${tag}$`)) tag += "_x";
  return `$${tag}$${value}$${tag}$`;
}

function jsonSql(value: unknown) { return dollarQuote(JSON.stringify(value)); }

async function ownerOnlyFile(path: string, label: string) {
  const stat = await lstat(path).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    fail(`${label} 必须是 owner-only 普通文件。`);
  }
}

function parseManagementResult(stdout: string): unknown {
  const start = stdout.indexOf("{");
  if (start < 0) fail("Supabase Management API 没有返回 JSON。");
  let payload: unknown;
  try { payload = JSON.parse(stdout.slice(start)); } catch { fail("Supabase Management API 返回不是合法 JSON。"); }
  const envelope = record(payload, "Supabase Management API 回执");
  const rows = envelope.rows;
  if (!Array.isArray(rows) || rows.length !== 1) fail("Supabase Management API 回执行数不符合预期。");
  const row = record(rows[0], "Supabase Management API 回执行");
  const value = row.result;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { fail("Supabase Management API RPC 回执不是合法 JSON。"); }
  }
  if (value && typeof value === "object") return value;
  fail("Supabase Management API 回执字段无效。");
}

async function runManagementQuery(profile: string, sql: string) {
  const scratch = await mkdtemp(join(tmpdir(), "student-management-query-"));
  try {
    await chmod(scratch, 0o700);
    const sqlPath = join(scratch, "query.sql");
    await writeFile(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const childEnv = { ...process.env };
      for (const key of [
        "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_URL", "OPS_API_SECRET", "JIAOWUBAO_OPS_SECRET",
        "JIAOWUBAO_OPEN_API_SK",
      ]) delete childEnv[key];
      const child = spawn("npx", [
        "--yes", "supabase@2.115.0", "db", "query",
        "--profile", profile, "--linked", "--project-ref", PROJECT_REF,
        "--output-format", "json", "--file", sqlPath, "--yes",
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
  return `begin;\nset local statement_timeout = '60s';\n${selectSql}\ncommit;\n`;
}

async function rpc(profile: string, sql: string) {
  try { return await runManagementQuery(profile, transaction(sql)); }
  catch { fail("Supabase Management API 请求失败；未自动重试。\n"); }
}

function objectResult(value: unknown, label: string) { return record(value, label); }

function integerField(value: JsonRecord, key: string, minimum = 0) {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < minimum) fail(`服务器回执 ${key} 无效。`);
  return field as number;
}

function stringField(value: JsonRecord, key: string, pattern: RegExp) {
  const field = value[key];
  if (typeof field !== "string" || !pattern.test(field)) fail(`服务器回执 ${key} 无效。`);
  return field;
}

function validateManagementSnapshot(value: unknown) {
  const snapshot = objectResult(value, "学生导入管理快照");
  const sourceSnapshot = objectResult(snapshot.sourceSnapshot, "学生导入来源快照");
  const studentsRow = snapshot.studentsRow;
  if (!studentsRow || typeof studentsRow !== "object" || Array.isArray(studentsRow)) {
    fail("学生导入管理快照缺少 students 状态。");
  }
  if (!Array.isArray(snapshot.referenceRows)) fail("学生导入管理快照缺少引用状态。");
  return { sourceSnapshot, studentsRow, referenceRows: snapshot.referenceRows } as const;
}

function aggregatePrepared(prepared: PreparedStudentImport) {
  const students = prepared.plan.students;
  const packageStudents = students.filter((student) => Array.isArray(student.lessonPackages)
    && student.lessonPackages.length > 0).length;
  const packageCount = students.reduce((total, student) => total
    + (Array.isArray(student.lessonPackages) ? student.lessonPackages.length : 0), 0);
  const purchaseRecordCount = students.reduce((total, student) => total
    + (Array.isArray(student.lessonPackages)
      ? student.lessonPackages.reduce((packageTotal, lessonPackage) => packageTotal
        + (Array.isArray(lessonPackage.purchaseRecords) ? lessonPackage.purchaseRecords.length : 0), 0)
      : 0), 0);
  return {
    planFingerprint: stringField(prepared.response as unknown as JsonRecord, "planFingerprint", SHA256),
    formalImportDate: prepared.response.formalImportDate,
    expectedStudentVersion: prepared.response.expectedStudentVersion,
    sourceMasterRows: prepared.response.sources.master.rowCount,
    sourceJwbRows: prepared.response.sources.jwb.rowCount,
    studentCount: students.length,
    jwbMatchedCount: students.filter((student) => student.jwbMatchStatus === "matched").length,
    jwbAmbiguousCount: students.filter((student) => student.jwbMatchStatus === "ambiguous").length,
    jwbUnmatchedCount: students.filter((student) => student.jwbMatchStatus === "unmatched").length,
    packageStudentCount: packageStudents,
    packageCount,
    purchaseRecordCount,
    ambiguousCount: prepared.plan.ambiguous.length,
    pendingDuplicateResolutionCount: prepared.response.masterDuplicateResolutions.length,
    identityLinkCount: prepared.response.identityLinkCount,
    canCommit: prepared.response.canCommit,
  };
}

function assertCommitReceipt(value: unknown, prepared: PreparedStudentImport) {
  if (!Array.isArray(value) || value.length !== 1) fail("学生正式导入回执数量不符合预期。");
  const row = record(value[0], "学生正式导入回执");
  if (row.entity !== "students") fail("学生正式导入回执实体无效。");
  const version = integerField(row, "version", 1);
  if (version < prepared.response.expectedStudentVersion) fail("学生正式导入版本回退。");
  if (typeof row.updated_at !== "string" || typeof row.updated_by !== "string") fail("学生正式导入回执字段无效。");
  return {
    entity: "students",
    version,
    replayed: version === prepared.response.expectedStudentVersion,
  } as const;
}

function assertReplayReceipt(value: unknown, expectedStudentVersion: number) {
  if (!Array.isArray(value) || value.length !== 1) fail("学生正式导入重放回执数量不符合预期。");
  const row = record(value[0], "学生正式导入重放回执");
  if (row.entity !== "students") fail("学生正式导入重放回执实体无效。");
  const version = integerField(row, "version", 1);
  if (version !== expectedStudentVersion + 1) fail("学生正式导入重放版本与原提交不一致。");
  if (typeof row.updated_at !== "string" || typeof row.updated_by !== "string") fail("学生正式导入重放回执字段无效。");
  return { entity: "students", version, replayed: true } as const;
}

export function parseManagementArguments(args: readonly string[]): ManagementOptions {
  const allowed = new Set(["--profile", "--actor", "--commit", "--confirmation-key", "--expected-student-version"]);
  const values = new Set(["--profile", "--actor", "--confirmation-key", "--expected-student-version"]);
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
  const profile = value("--profile") ?? process.env.INSIDER_LEADS_SUPABASE_PROFILE;
  const actor = value("--actor");
  const confirmationKey = value("--confirmation-key");
  const rawExpectedVersion = value("--expected-student-version");
  const expectedStudentVersion = rawExpectedVersion === undefined ? null : Number(rawExpectedVersion);
  if (!profile || !actor || !ACTORS.has(actor)
    || (confirmationKey !== undefined && !SHA256.test(confirmationKey))
    || (rawExpectedVersion !== undefined
      && (!/^(?:0|[1-9][0-9]*)$/u.test(rawExpectedVersion)
        || !Number.isSafeInteger(expectedStudentVersion)
        || (expectedStudentVersion as number) < 1
        || (expectedStudentVersion as number) >= 9007199254740991))
    || (confirmationKey === undefined) !== (rawExpectedVersion === undefined)
    || (confirmationKey !== undefined && args.includes("--commit"))) {
    fail("需要 --profile、--actor；参数必须合法。");
  }
  return Object.freeze({
    profile: resolve(profile),
    actor: actor as ManagementOptions["actor"],
    commit: args.includes("--commit"),
    confirmationKey: confirmationKey ?? null,
    expectedStudentVersion: expectedStudentVersion as number | null,
  });
}

export async function runManagement(options: ManagementOptions) {
  await ownerOnlyFile(options.profile, "--profile");
  if (options.confirmationKey !== null && options.expectedStudentVersion !== null) {
    const replayed = await rpc(options.profile, `
select coalesce(jsonb_agg(to_jsonb(saved) order by saved.entity), '[]'::jsonb)::text as result
from internal.student_import_management_replay(
  ${dollarQuote(options.confirmationKey)},
  ${options.expectedStudentVersion},
  ${dollarQuote(options.actor)}
) saved;
`);
    const receipt = assertReplayReceipt(replayed, options.expectedStudentVersion);
    const result = {
      phase: "replay",
      confirmationKey: options.confirmationKey,
      expectedStudentVersion: options.expectedStudentVersion,
      ...receipt,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const rawSnapshot = await rpc(options.profile, `select internal.student_import_management_snapshot()::text as result;`);
  const snapshot = validateManagementSnapshot(rawSnapshot);
  const prepared = prepareStudentImport({
    sourceSnapshot: snapshot.sourceSnapshot,
    studentsRow: snapshot.studentsRow as never,
    referenceRows: snapshot.referenceRows as never,
  });
  const preview = aggregatePrepared(prepared);
  process.stdout.write(`${JSON.stringify({ phase: "preview", ...preview })}\n`);
  if (!options.commit) return preview;
  if (!prepared.response.canCommit) fail("学生正式导入预检未通过；未写入任何数据。");
  assertStudentImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedStudentVersion: prepared.response.expectedStudentVersion,
  }, prepared);
  const committed = await rpc(options.profile, `
select coalesce(jsonb_agg(to_jsonb(saved) order by saved.entity), '[]'::jsonb)::text as result
from internal.student_import_management_commit(
  ${dollarQuote(prepared.response.planFingerprint)},
  ${prepared.response.expectedStudentVersion},
  ${jsonSql(prepared.sourceRevisions)},
  ${jsonSql(prepared.plan.students)},
  ${dollarQuote(options.actor)}
) saved;
`);
  const receipt = assertCommitReceipt(committed, prepared);
  const result = { phase: "commit", ...preview, ...receipt };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--help")) {
    process.stdout.write("node --import tsx scripts/student-import-management.ts --profile /private/tmp/insider-leads-supabase-profile.yaml --actor Nixon [--commit] | [--confirmation-key sha256:... --expected-student-version N]\n");
  } else {
    runManagement(parseManagementArguments(process.argv.slice(2)))
      .catch((error: unknown) => {
        process.stderr.write(`Jiaowubao student Management API bridge failed: ${error instanceof Error ? error.message : "Unexpected failure."}\n`);
        process.exitCode = 1;
      });
  }
}
