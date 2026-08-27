#!/usr/bin/env node

/**
 * One-time owner bridge for the exact eight-row JWB identity merge release.
 *
 * The default action is a server-side aggregate preview.  `--commit` performs
 * a second, separate Management API postgres-session call using only the
 * opaque key returned by that preview.  No source rows, names, student IDs,
 * OPS_API_SECRET, or database URL are read or printed by this CLI.
 */

import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT_REF = "orvsgisjjrzgtxuwwsms";
const QUERY_TIMEOUT_MS = 60_000;
const MAX_QUERY_OUTPUT_BYTES = 128 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const REVISION = /^sha256:[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;
export type IdentityManagementOptions = Readonly<{
  profile: string;
  actor: "Nixon" | "Ops Admin";
  commit: boolean;
  confirmationKey: string | null;
}>;

function fail(message: string): never { throw new Error(message); }

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 无效。`);
  return value as JsonRecord;
}

function dollarQuote(value: string) {
  const tagBase = `identity_mgmt_${value.replace(/[^A-Za-z0-9_]/gu, "").slice(0, 24) || "sql"}`;
  let tag = tagBase;
  while (value.includes(`$${tag}$`)) tag += "_x";
  return `$${tag}$${value}$${tag}$`;
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
  const scratch = await mkdtemp(join(tmpdir(), "identity-management-query-"));
  try {
    const sqlPath = join(scratch, "query.sql");
    await writeFile(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    return await new Promise<JsonRecord>((resolvePromise, rejectPromise) => {
      const childEnv = { ...process.env };
      for (const key of [
        "SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_URL", "OPS_API_SECRET", "JIAOWUBAO_OPS_SECRET",
        "JIAOWUBAO_OPEN_API_SK",
      ]) delete childEnv[key];
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
    // Never echo Management API errors: they can include raw SQL/source data.
    fail(`Supabase Management API ${name} 请求失败。`);
  }
}

function stringField(value: JsonRecord, key: string, pattern: RegExp) {
  const field = value[key];
  if (typeof field !== "string" || !pattern.test(field)) fail(`服务器回执 ${key} 无效。`);
  return field;
}

function integerField(value: JsonRecord, key: string) {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < 0) fail(`服务器回执 ${key} 无效。`);
  return field as number;
}

function booleanField(value: JsonRecord, key: string) {
  if (typeof value[key] !== "boolean") fail(`服务器回执 ${key} 无效。`);
  return value[key] as boolean;
}

export function parseIdentityManagementArguments(args: readonly string[]): IdentityManagementOptions {
  const allowed = new Set(["--profile", "--actor", "--commit", "--confirmation-key"]);
  const values = new Set(["--profile", "--actor", "--confirmation-key"]);
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
  const commit = args.includes("--commit");
  if (!profile || !actor || !["Nixon", "Ops Admin"].includes(actor)
      || (confirmationKey !== undefined && (!commit || !SHA256.test(confirmationKey)))) {
    fail("需要 --profile、--actor；参数必须合法。");
  }
  return Object.freeze({
    profile: resolve(profile),
    actor: actor as IdentityManagementOptions["actor"],
    commit,
    confirmationKey: confirmationKey ?? null,
  });
}

export async function runIdentityManagement(options: IdentityManagementOptions) {
  await ownerOnlyFile(options.profile, "--profile");
  if (options.confirmationKey) {
    const committed = await rpc(options.profile, "student_import_identity_bulk_management_commit", [
      dollarQuote(options.confirmationKey), dollarQuote(options.actor),
    ]);
    const recoveryReceipt = validateCommitReceipt(committed, options.confirmationKey, "commit-recovery");
    process.stdout.write(`${JSON.stringify(recoveryReceipt)}\n`);
    return recoveryReceipt;
  }
  const preview = await rpc(options.profile, "student_import_identity_bulk_management_preview", [dollarQuote(options.actor)]);
  const previewKey = stringField(preview, "confirmationKey", SHA256);
  const previewRevision = stringField(preview, "masterRevision", REVISION);
  const previewJwbRevision = stringField(preview, "jwbRevision", REVISION);
  const candidateCount = integerField(preview, "mergeCandidateCount");
  const pendingCount = integerField(preview, "pendingMergeCount");
  const duplicateCount = integerField(preview, "unresolvedDuplicateGroupCount");
  const reviewedBatchCount = integerField(preview, "reviewedBatchCount");
  const canSubmit = booleanField(preview, "canSubmit");
  const previewReceipt = {
    phase: "preview",
    confirmationKey: previewKey,
    masterRevision: previewRevision,
    jwbRevision: previewJwbRevision,
    studentsVersion: integerField(preview, "studentsVersion"),
    reviewEpoch: integerField(preview, "reviewEpoch"),
    mergeCandidateCount: candidateCount,
    pendingMergeCount: pendingCount,
    alreadyLinkedMergeCount: integerField(preview, "alreadyLinkedMergeCount"),
    unresolvedDuplicateGroupCount: duplicateCount,
    reviewedBatchCount,
    canSubmit,
  };
  process.stdout.write(`${JSON.stringify(previewReceipt)}\n`);
  if (!options.commit) return previewReceipt;
  if (!canSubmit || candidateCount !== 8 || pendingCount !== 8 || duplicateCount !== 0 || reviewedBatchCount !== 8) {
    fail("服务器预检不是已审核的精确八条合并批次；未写入任何数据。");
  }

  // The only commit input is the exact opaque key returned by this server
  // preview.  No client identities, names, rows, or decisions are accepted.
  const committed = await rpc(options.profile, "student_import_identity_bulk_management_commit", [
    dollarQuote(previewKey), dollarQuote(options.actor),
  ]);
  const commitReceipt = validateCommitReceipt(committed, previewKey, "commit");
  if (commitReceipt.masterRevision !== previewRevision
      || commitReceipt.jwbRevision !== previewJwbRevision) {
    fail("服务器提交回执与预检不一致；请以数据库状态为准，未自动重试。");
  }
  process.stdout.write(`${JSON.stringify(commitReceipt)}\n`);
  return commitReceipt;
}

function validateCommitReceipt(value: JsonRecord, expectedKey: string, phase: "commit" | "commit-recovery") {
  const receipt = {
    phase,
    confirmationKey: stringField(value, "confirmationKey", SHA256),
    fingerprint: stringField(value, "fingerprint", SHA256),
    masterRevision: stringField(value, "masterRevision", REVISION),
    jwbRevision: stringField(value, "jwbRevision", REVISION),
    studentsVersion: integerField(value, "studentsVersion"),
    reviewEpoch: integerField(value, "reviewEpoch"),
    count: integerField(value, "count"),
    requestedCount: integerField(value, "requestedCount"),
    newlyAppliedCount: integerField(value, "newlyAppliedCount"),
    alreadyAppliedCount: integerField(value, "alreadyAppliedCount"),
    finalCount: integerField(value, "finalCount"),
    reviewedBatchCount: integerField(value, "reviewedBatchCount"),
    unchanged: booleanField(value, "unchanged"),
  };
  if (receipt.confirmationKey !== expectedKey
      || receipt.count !== receipt.finalCount
      || receipt.requestedCount !== 8
      || receipt.newlyAppliedCount !== 8
      || receipt.reviewedBatchCount !== 8
      || receipt.alreadyAppliedCount > receipt.finalCount
      || receipt.finalCount < 8) {
    fail("服务器提交回执不是精确八条批次；请以数据库状态为准，未自动重试。");
  }
  return receipt;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--help")) {
    process.stdout.write("node --import tsx scripts/student-import-identity-management.ts --profile /private/tmp/insider-leads-supabase-profile.yaml --actor 'Nixon' [--commit [--confirmation-key sha256:...]]\n");
  } else {
    runIdentityManagement(parseIdentityManagementArguments(process.argv.slice(2)))
      .catch((error: unknown) => {
        process.stderr.write(`Jiaowubao identity Management API bridge failed: ${error instanceof Error ? error.message : "Unexpected failure."}\n`);
        process.exitCode = 1;
      });
  }
}
