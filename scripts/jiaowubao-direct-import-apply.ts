#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

import {
  canonicalJson,
  prepareJiaowubaoDirectStaging,
} from "../lib/jiaowubao-direct-import-preflight";
import {
  buildJiaowubaoDirectSequentialImportPlan,
  compileJiaowubaoDirectImportProjection,
  type JiaowubaoDirectProjectionAuthority,
} from "../lib/jiaowubao-direct-import-projection";
import { assertJiaowubao20260818CompiledBatch } from "../lib/jiaowubao-direct-import-batch-gate";
import { JiaowubaoDirectImportDbFailureClassifier } from "../lib/jiaowubao-direct-import-failure";
import { buildJiaowubaoDirectImportResumableSql } from "../lib/jiaowubao-direct-import-sql";
import {
  parseJiaowubaoStaticXlsxExports,
  type JiaowubaoStaticSourceInput,
  type JiaowubaoStaticXlsxExportInput,
} from "../lib/jiaowubao-static-xlsx-parser";

const EXPECTED_PROJECT_REF = "orvsgisjjrzgtxuwwsms";
const EXPECTED_ORGANIZATION_ID = "fgnmdykxtthalhwspelu";
const SUPABASE_MANAGEMENT_API = "https://api.supabase.com";
const SUPABASE_PROFILE = "insider-leads";
const PSQL_LINK = "/opt/homebrew/bin/psql";
const MAX_QUERY_OUTPUT_BYTES = 256 * 1024 * 1024;
// The reviewed 48,936-record batch performs one full relational/DST proof at
// final completion. Chunks commit independently, so this remains a finite
// session bound rather than an all-or-nothing deadline: a timeout preserves
// the committed, application-invisible staging prefix for exact replay.
const QUERY_TIMEOUT_MS = 45 * 60 * 1000;
const MINIMUM_LOGIN_ROLE_TTL_SECONDS = 60;
const PROBE_ATTEMPTS = 9;
const PROBE_TIMEOUT_MS = 30_000;
const ACCESS_TOKEN = /^sbp_(?:oauth_)?[a-f0-9]{40}$/u;
const LOGIN_ROLE = /^cli_login_[A-Za-z0-9_]+$/u;
const REQUIRED_RELEASE_MIGRATION_VERSIONS = Object.freeze([
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
] as const);
const REQUIRED_REMOTE_MIGRATION_VERSION = "20260819001200";

type SourceInputKey = keyof JiaowubaoStaticXlsxExportInput;

const REQUIRED_EXPORTS: Readonly<Record<SourceInputKey, string>> = Object.freeze({
  quickList: "吟领教育 2026-08-18 学员快速列表.xlsx",
  students: "吟领教育  学员列表.xlsx",
  contracts: "吟领教育 学员合约.xlsx",
  hours: "吟领教育  学员课时列表.xlsx",
  classMemberships: "吟领教育 班级学员名单.xlsx",
  schedule: "吟领教育 2021-08-03至 2029-08-02 课表.xlsx",
  leaveMakeups: "吟领教育 2026-08-11至2026-08-25 请假补课记录.xlsx",
});

type Arguments = Readonly<{
  inputDir: string;
  stageDir: string;
  poolerUrlFile: string;
  accessTokenFile: string;
  actor: string;
  execute: true;
}>;

type TemporaryLoginRole = Readonly<{
  role: string;
  password: string;
  ttlSeconds: number;
}>;

type DirectDatabaseTarget = Readonly<{
  host: string;
  port: "5432";
  database: "postgres";
  user: string;
  password: string;
}>;

type DbQueryResult = Readonly<{
  rows?: readonly Readonly<Record<string, unknown>>[];
}>;

type ImportReceipt = Readonly<Record<string, unknown>>;

type PsqlProgressEvent = Readonly<{
  status: "staging" | "complete";
  phase: "begin" | "chunk" | "complete";
  revision?: string;
  completedChunks?: number;
  chunkCount?: number;
  replayed?: boolean;
  receipt?: ImportReceipt;
}>;

type AuthoritySnapshotResult = Readonly<{
  authority: JiaowubaoDirectProjectionAuthority;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVISION = /^sha256:[a-f0-9]{64}$/u;

function usage() {
  return [
    "Usage:",
    "  node --import tsx scripts/jiaowubao-direct-import-apply.ts \\",
    "    --input-dir '/absolute/path/to/教务宝数据' \\",
    "    --stage '/absolute/path/to/isolated-supabase-release-stage' \\",
    "    --pooler-url-file '/absolute/path/to/supabase/.temp/pooler-url' \\",
    "    --access-token-file '/absolute/path/to/isolated-cli-home/access-token' \\",
    "    --actor 'Nixon' --execute",
    "",
    "This is a production writer. It uses only the isolated Insider Leads profile/project,",
    "commits reviewed chunks one at a time in a trusted session. A staging run is never visible",
    "to application readers; rerunning this exact command replay-checks its committed prefix and resumes.",
  ].join("\n");
}

function argumentValue(args: readonly string[], flag: string) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArguments(args: readonly string[]): Arguments {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const accepted = new Set([
    "--input-dir",
    "--stage",
    "--pooler-url-file",
    "--access-token-file",
    "--actor",
    "--execute",
  ]);
  for (const value of args) {
    if (value.startsWith("--") && !accepted.has(value)) throw new Error(`Unknown option: ${value}`);
  }
  if (!args.includes("--execute")) throw new Error("--execute is required for the production writer.");
  const inputDir = argumentValue(args, "--input-dir");
  const stageDir = argumentValue(args, "--stage");
  const poolerUrlFile = argumentValue(args, "--pooler-url-file");
  const accessTokenFile = argumentValue(args, "--access-token-file");
  const actor = argumentValue(args, "--actor");
  if (!inputDir || !stageDir || !poolerUrlFile || !accessTokenFile
    || !actor || actor !== actor.trim() || actor.length > 120) {
    throw new Error("--input-dir, --stage, --pooler-url-file, --access-token-file, and a trimmed --actor are required.");
  }
  return Object.freeze({
    inputDir: resolve(inputDir),
    stageDir: resolve(stageDir),
    poolerUrlFile: resolve(poolerUrlFile),
    accessTokenFile: resolve(accessTokenFile),
    actor,
    execute: true,
  });
}

async function requireRealDirectory(path: string, label: string) {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

async function verifyReleaseStage(stageDir: string) {
  await requireRealDirectory(stageDir, "--stage");
  const projectRefPath = join(stageDir, "supabase", ".temp", "project-ref");
  const projectRefStat = await lstat(projectRefPath).catch(() => null);
  if (!projectRefStat?.isFile() || projectRefStat.isSymbolicLink()) throw new Error("The release stage has no trusted project ref.");
  const projectRef = (await readFile(projectRefPath, "utf8")).trim();
  if (projectRef !== EXPECTED_PROJECT_REF) throw new Error("The release stage is linked to the wrong Supabase project.");
  const migrationDir = join(stageDir, "supabase", "migrations");
  await requireRealDirectory(migrationDir, "The release-stage migration directory");
  const migrationNames = await readdir(migrationDir);
  for (const version of REQUIRED_RELEASE_MIGRATION_VERSIONS) {
    const matches = migrationNames.filter((name) => name.startsWith(`${version}_`) && name.endsWith(".sql"));
    if (matches.length !== 1) {
      throw new Error(`The release stage must contain exactly one migration ${version}.`);
    }
    const migrationStat = await lstat(join(migrationDir, matches[0])).catch(() => null);
    if (!migrationStat?.isFile() || migrationStat.isSymbolicLink()) {
      throw new Error(`The release-stage migration ${version} is not a trusted regular file.`);
    }
  }
}

async function readWorkbook(inputDir: string, workbookName: string): Promise<JiaowubaoStaticSourceInput> {
  const path = join(inputDir, workbookName);
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Required workbook is missing: ${workbookName}`);
  const bytes = new Uint8Array(await readFile(path));
  if (!bytes.byteLength) throw new Error(`Required workbook is empty: ${workbookName}`);
  return Object.freeze({ workbookName, sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
}

async function readInputs(inputDir: string): Promise<JiaowubaoStaticXlsxExportInput> {
  await requireRealDirectory(inputDir, "--input-dir");
  const entries = await Promise.all(Object.entries(REQUIRED_EXPORTS).map(async ([key, fileName]) => [
    key,
    await readWorkbook(inputDir, fileName),
  ] as const));
  return Object.freeze(Object.fromEntries(entries)) as JiaowubaoStaticXlsxExportInput;
}

function normalizeAccessToken(value: string) {
  const token = value.trim();
  if (!ACCESS_TOKEN.test(token)) throw new Error("The isolated Supabase access token is invalid.");
  return token;
}

async function readSupabaseAccessToken(tokenPath: string) {
  const tokenDir = dirname(tokenPath);
  const [directoryStat, tokenStat, profileStat] = await Promise.all([
    lstat(tokenDir).catch(() => null),
    lstat(tokenPath).catch(() => null),
    lstat(join(tokenDir, "profile")).catch(() => null),
  ]);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()
    || (directoryStat.mode & 0o077) !== 0
    || !tokenStat?.isFile() || tokenStat.isSymbolicLink() || (tokenStat.mode & 0o077) !== 0
    || !profileStat?.isFile() || profileStat.isSymbolicLink() || (profileStat.mode & 0o077) !== 0) {
    throw new Error("The isolated Supabase CLI home is unavailable or not owner-only.");
  }
  if ((await readFile(join(tokenDir, "profile"), "utf8")).trim() !== SUPABASE_PROFILE) {
    throw new Error("The isolated Supabase CLI home has the wrong profile.");
  }
  return normalizeAccessToken(await readFile(tokenPath, "utf8"));
}

async function assertManagementProject(accessToken: string) {
  const response = await fetch(
    `${SUPABASE_MANAGEMENT_API}/v1/projects/${EXPECTED_PROJECT_REF}`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "user-agent": "yinling-jiaowubao-direct-import",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  ).catch(() => null);
  if (!response?.ok) {
    if (response) await response.arrayBuffer().catch(() => undefined);
    throw new Error("The isolated Supabase account could not verify the target project.");
  }
  const payload = await response.json().catch(() => null) as null | {
    id?: unknown;
    organization_id?: unknown;
  };
  if (!payload || payload.id !== EXPECTED_PROJECT_REF
    || payload.organization_id !== EXPECTED_ORGANIZATION_ID) {
    throw new Error("The isolated Supabase account resolved the wrong project or organization.");
  }
}

async function mintTemporaryLoginRole(accessToken: string): Promise<TemporaryLoginRole> {
  const response = await fetch(
    `${SUPABASE_MANAGEMENT_API}/v1/projects/${EXPECTED_PROJECT_REF}/cli/login-role`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": "yinling-jiaowubao-direct-import",
      },
      body: JSON.stringify({ read_only: false }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  ).catch(() => null);
  if (!response?.ok) {
    if (response) await response.arrayBuffer().catch(() => undefined);
    throw new Error("The temporary Supabase database login could not be created.");
  }
  const payload = await response.json().catch(() => null) as null | {
    role?: unknown;
    password?: unknown;
    ttl_seconds?: unknown;
  };
  if (!payload
    || typeof payload.role !== "string" || !LOGIN_ROLE.test(payload.role)
    || typeof payload.password !== "string" || payload.password.length < 16 || payload.password.length > 512
    || typeof payload.ttl_seconds !== "number" || !Number.isSafeInteger(payload.ttl_seconds)
    || payload.ttl_seconds < MINIMUM_LOGIN_ROLE_TTL_SECONDS) {
    throw new Error("The temporary Supabase database login contract is invalid.");
  }
  return Object.freeze({ role: payload.role, password: payload.password, ttlSeconds: payload.ttl_seconds });
}

async function directDatabaseTarget(
  poolerUrlFile: string,
  login: TemporaryLoginRole,
): Promise<DirectDatabaseTarget> {
  const stat = await lstat(poolerUrlFile).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error("--pooler-url-file must be a trusted regular file.");
  }
  const raw = (await readFile(poolerUrlFile, "utf8")).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The trusted Supabase pooler URL is invalid.");
  }
  if (url.protocol !== "postgresql:"
    || !/^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(url.hostname)
    || url.port !== "5432"
    || url.username !== `postgres.${EXPECTED_PROJECT_REF}`
    || url.password !== ""
    || url.pathname !== "/postgres"
    || [...url.searchParams.keys()].length !== 0) {
    throw new Error("The trusted Supabase pooler URL does not match the Insider Leads session pooler.");
  }
  return Object.freeze({
    host: url.hostname,
    port: "5432",
    database: "postgres",
    user: `${login.role}.${EXPECTED_PROJECT_REF}`,
    password: login.password,
  });
}

async function runManagementQuery(
  accessToken: string,
  sql: string,
  phase: string,
) {
  if (Buffer.byteLength(sql, "utf8") > 256 * 1024) {
    throw new Error(`Supabase ${phase} query is not a bounded aggregate query.`);
  }
  const response = await fetch(
    `${SUPABASE_MANAGEMENT_API}/v1/projects/${EXPECTED_PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": "yinling-jiaowubao-direct-import",
      },
      body: JSON.stringify({ query: sql }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    },
  ).catch(() => null);
  if (!response || response.status !== 201) {
    if (response) await response.arrayBuffer().catch(() => undefined);
    throw new Error(`Supabase ${phase} aggregate query failed.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 64 * 1024 * 1024) {
    throw new Error(`Supabase ${phase} aggregate response exceeded its safety bound.`);
  }
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!Array.isArray(parsed)
    || !parsed.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    throw new Error(`Supabase ${phase} returned an invalid aggregate response.`);
  }
  return Object.freeze({ rows: parsed as readonly Readonly<Record<string, unknown>>[] });
}

class PsqlExecutionError extends Error {
  constructor(
    message: string,
    readonly category: string,
  ) {
    super(message);
    this.name = "PsqlExecutionError";
  }
}

async function verifyPsqlBinary() {
  const binary = await realpath(PSQL_LINK).catch(() => null);
  if (!binary || !/^\/opt\/homebrew\/Cellar\/postgresql@16\/16\.[0-9.]+\/bin\/psql$/u.test(binary)) {
    throw new Error("The trusted PostgreSQL 16 psql binary is unavailable.");
  }
  const stat = await lstat(binary).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error("The trusted PostgreSQL 16 psql binary is not executable.");
  }
  return binary;
}

function pgpassEscape(value: string) {
  if (/[\r\n\u0000]/u.test(value)) throw new Error("The temporary database credential is invalid.");
  return value.replace(/[\\:]/gu, "\\$&");
}

async function runPsqlJson(
  psqlBinary: string,
  target: DirectDatabaseTarget,
  pgpassPath: string,
  sqlFile: string,
  phase: string,
  timeoutMs: number,
) {
  return new Promise<Readonly<Record<string, unknown>>>((resolvePromise, rejectPromise) => {
    const childEnvironment = { ...process.env };
    for (const key of [
      "PGPASSWORD",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGOPTIONS",
      "PGHOSTADDR",
      "SUPABASE_ACCESS_TOKEN",
    ]) delete childEnvironment[key];
    Object.assign(childEnvironment, {
      PGHOST: target.host,
      PGPORT: target.port,
      PGDATABASE: target.database,
      PGUSER: target.user,
      PGPASSFILE: pgpassPath,
      PGSSLMODE: "require",
      PGCONNECT_TIMEOUT: "15",
    });

    const child = spawn(psqlBinary, [
      "-X",
      "--no-password",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      sqlFile,
    ], {
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let settled = false;
    const failureClassifier = new JiaowubaoDirectImportDbFailureClassifier();
    const timer = setTimeout(() => {
      failureClassifier.markTimeout();
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      failureClassifier.feed(chunk);
      if (stdoutBytes > MAX_QUERY_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGTERM");
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      failureClassifier.feed(chunk);
      if (stderrBytes > MAX_QUERY_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGTERM");
      }
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new PsqlExecutionError(`PostgreSQL ${phase} process could not start.`, "database_failure"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const category = failureClassifier.category();
      if (code !== 0 || outputExceeded) {
        rejectPromise(new PsqlExecutionError(`PostgreSQL ${phase} failed (${category}).`, category));
        return;
      }
      const lastLine = Buffer.concat(stdout).toString("utf8")
        .split(/\r?\n/gu)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      try {
        const parsed = JSON.parse(lastLine || "") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
        resolvePromise(parsed as Readonly<Record<string, unknown>>);
      } catch {
        rejectPromise(new PsqlExecutionError(`PostgreSQL ${phase} returned an invalid aggregate response.`, "database_failure"));
      }
    });
  });
}

function asPlainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/**
 * Accept only the tiny JSON progress protocol generated by
 * `buildJiaowubaoDirectImportResumableSql`.  psql's raw stdout is never
 * forwarded: a malformed or unexpected line terminates the session instead.
 */
function parsePsqlProgressEvent(value: unknown): {
  progress: PsqlProgressEvent;
  completionReceipt?: ImportReceipt;
} | null {
  const event = asPlainRecord(value);
  if (!event || typeof event.event !== "string") return null;
  if (event.event === "beginCommitted") {
    if (typeof event.runId !== "string" || !UUID.test(event.runId)
      || typeof event.revision !== "string" || !REVISION.test(event.revision)) return null;
    return {
      progress: Object.freeze({ status: "staging", phase: "begin", revision: event.revision }),
    };
  }
  if (event.event === "chunkCommitted") {
    const stageReceipt = asPlainRecord(event.stageReceipt);
    const chunkIndex = event.chunkIndex;
    const chunkCount = event.chunkCount;
    if (typeof event.runId !== "string" || !UUID.test(event.runId)
      || typeof chunkIndex !== "number" || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 511
      || typeof chunkCount !== "number" || !Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 512
      || chunkIndex >= chunkCount
      || !stageReceipt || stageReceipt.state !== "staging"
      || stageReceipt.chunkIndex !== chunkIndex
      || typeof stageReceipt.replayed !== "boolean") return null;
    return {
      progress: Object.freeze({
        status: "staging",
        phase: "chunk",
        completedChunks: chunkIndex + 1,
        chunkCount,
        replayed: stageReceipt.replayed,
      }),
    };
  }
  if (event.event === "complete") {
    const receipt = asPlainRecord(event.receipt);
    if (!receipt || receipt.state !== "complete"
      || typeof receipt.revision !== "string" || !REVISION.test(receipt.revision)
      || typeof receipt.payloadSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.payloadSha256)
      || !Number.isSafeInteger(receipt.chunkCount)
      || !Number.isSafeInteger(receipt.supplementalRecords)
      || !Number.isSafeInteger(receipt.scheduleEvents)
      || !Number.isSafeInteger(receipt.scheduleParticipants)
      || !Number.isSafeInteger(receipt.leaveMakeups)) return null;
    return {
      progress: Object.freeze({ status: "complete", phase: "complete", receipt }),
      completionReceipt: receipt,
    };
  }
  return null;
}

/**
 * Execute the multi-transaction resumable protocol in one authenticated psql
 * session.  Each validated progress record comes after the corresponding
 * SQL COMMIT, so an interrupted process can safely replay-check and resume.
 */
async function runPsqlResumableImport(
  psqlBinary: string,
  target: DirectDatabaseTarget,
  pgpassPath: string,
  sqlFile: string,
  timeoutMs: number,
  onProgress: (progress: PsqlProgressEvent) => void,
) {
  return new Promise<ImportReceipt>((resolvePromise, rejectPromise) => {
    const childEnvironment = { ...process.env };
    for (const key of [
      "PGPASSWORD",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGOPTIONS",
      "PGHOSTADDR",
      "SUPABASE_ACCESS_TOKEN",
    ]) delete childEnvironment[key];
    Object.assign(childEnvironment, {
      PGHOST: target.host,
      PGPORT: target.port,
      PGDATABASE: target.database,
      PGUSER: target.user,
      PGPASSFILE: pgpassPath,
      PGSSLMODE: "require",
      PGCONNECT_TIMEOUT: "15",
    });

    const child = spawn(psqlBinary, [
      "-X",
      "--no-password",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      sqlFile,
    ], {
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutTail = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let invalidProgress = false;
    let settled = false;
    let completionReceipt: ImportReceipt | undefined;
    const failureClassifier = new JiaowubaoDirectImportDbFailureClassifier();
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(() => {
      failureClassifier.markTimeout();
      stop();
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    const consumeProgressLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || invalidProgress) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        invalidProgress = true;
        stop();
        return;
      }
      const progress = parsePsqlProgressEvent(parsed);
      if (!progress) {
        invalidProgress = true;
        stop();
        return;
      }
      if (progress.completionReceipt) completionReceipt = progress.completionReceipt;
      onProgress(progress.progress);
    };
    const consumeStdout = (text: string, final = false) => {
      stdoutTail += text;
      if (Buffer.byteLength(stdoutTail, "utf8") > 1024 * 1024) {
        invalidProgress = true;
        stop();
        return;
      }
      const lines = stdoutTail.split(/\r?\n/gu);
      stdoutTail = final ? "" : (lines.pop() ?? "");
      for (const line of lines) consumeProgressLine(line);
      if (final && stdoutTail) consumeProgressLine(stdoutTail);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      failureClassifier.feed(chunk);
      if (stdoutBytes > MAX_QUERY_OUTPUT_BYTES) {
        outputExceeded = true;
        stop();
        return;
      }
      consumeStdout(stdoutDecoder.write(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      failureClassifier.feed(chunk);
      if (stderrBytes > MAX_QUERY_OUTPUT_BYTES) {
        outputExceeded = true;
        stop();
      }
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new PsqlExecutionError("PostgreSQL resumable import process could not start.", "database_failure"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      consumeStdout(stdoutDecoder.end(), true);
      const category = failureClassifier.category();
      if (code !== 0 || outputExceeded || invalidProgress) {
        rejectPromise(new PsqlExecutionError(`PostgreSQL resumable import failed (${category}).`, category));
        return;
      }
      if (!completionReceipt) {
        rejectPromise(new PsqlExecutionError("PostgreSQL resumable import returned no completion receipt.", "database_failure"));
        return;
      }
      resolvePromise(completionReceipt);
    });
  });
}

function probeSql() {
  return [
    "set session role postgres;",
    "select jsonb_build_object(",
    "  'ready', session_user ~ '^cli_login_[a-zA-Z0-9_]+$'",
    "    and current_user = 'postgres'",
    "    and pg_catalog.pg_has_role(session_user, 'postgres', 'SET')",
    ");",
    "",
  ].join("\n");
}

async function waitForTemporaryLogin(
  psqlBinary: string,
  target: DirectDatabaseTarget,
  pgpassPath: string,
  probePath: string,
) {
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    try {
      const result = await runPsqlJson(
        psqlBinary,
        target,
        pgpassPath,
        probePath,
        "temporary-login probe",
        PROBE_TIMEOUT_MS,
      );
      if (result.ready === true) return;
    } catch {
      // Supavisor can take a short time to propagate a freshly minted role.
      // The probe is read-only, and no database diagnostics are retained.
    }
    if (attempt + 1 < PROBE_ATTEMPTS) {
      const delayMs = Math.min(15_000, Math.round(3_000 * (1.5 ** attempt)));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw new Error("The temporary Supabase database login did not become ready.");
}

function authoritySql() {
  return [
    "select jsonb_build_object(",
    "  'authority', jsonb_build_object(",
    "    'masterSource', jsonb_build_object(",
    "      'sourceId', master_source.source_id,",
    "      'revision', master_source.revision,",
    "      'rowsSha256', master_source.rows_sha256,",
    "      'rows', master_source.rows",
    "    ),",
    "    'students', students_state.payload,",
    "    'teachers', teachers_state.payload",
    "  )",
    ") as authority_snapshot",
    "from internal.student_import_source_rows master_source",
    "join public.ops_state students_state on students_state.entity = 'students'",
    "join public.ops_state teachers_state on teachers_state.entity = 'teachers'",
    "where master_source.source_kind = 'master';",
    "",
  ].join("\n");
}

function parseAuthority(result: DbQueryResult): AuthoritySnapshotResult {
  const row = result.rows?.[0];
  const snapshot = row?.authority_snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("The current Tencent/ops authority snapshot is unavailable.");
  }
  const authority = (snapshot as { authority?: unknown }).authority;
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new Error("The current Tencent/ops authority snapshot is malformed.");
  }
  return { authority: authority as JiaowubaoDirectProjectionAuthority };
}

function requiredRemoteMigrationSql() {
  return [
    "select jsonb_build_object(",
    "  'applied', exists (",
    "    select 1",
    "    from supabase_migrations.schema_migrations",
    `    where version = '${REQUIRED_REMOTE_MIGRATION_VERSION}'`,
    "  )",
    ") as required_release_migration;",
    "",
  ].join("\n");
}

function assertRequiredRemoteMigration(result: DbQueryResult) {
  const value = result.rows?.length === 1 ? result.rows[0]?.required_release_migration : null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as { applied?: unknown }).applied !== true) {
    throw new Error(`Supabase migration ${REQUIRED_REMOTE_MIGRATION_VERSION} is not applied.`);
  }
}

/** Build a PostgreSQL dollar-quoted literal whose delimiter cannot occur in the value. */
function safeSqlTextLiteral(value: string) {
  if (value.includes("\u0000")) throw new Error("The reviewed import envelope contains an unsupported value.");
  const delimiter = `$jiaowubao_${createHash("sha256").update(value).digest("hex")}$`;
  if (value.includes(delimiter)) throw new Error("The reviewed import envelope cannot be represented safely in SQL.");
  return `${delimiter}${value}${delimiter}`;
}

function envelopeAssertionSql(
  envelope: ReturnType<typeof compileJiaowubaoDirectImportProjection>["envelope"],
) {
  const envelopeLiteral = safeSqlTextLiteral(canonicalJson(envelope));
  return [
    "with asserted as materialized (",
    "  select internal.jiaowubao_direct_import_assert_envelope(",
    `    ${envelopeLiteral}::jsonb`,
    "  ) as checked",
    ")",
    "select jsonb_build_object('accepted', true) as direct_import_envelope_assertion",
    "from asserted;",
    "",
  ].join("\n");
}

function assertEnvelopeAccepted(result: DbQueryResult) {
  const value = result.rows?.length === 1 ? result.rows[0]?.direct_import_envelope_assertion : null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as { accepted?: unknown }).accepted !== true) {
    throw new Error("Supabase did not accept the reviewed direct-import envelope.");
  }
}

function importStatusSql(revision: string) {
  if (!REVISION.test(revision)) throw new Error("The reviewed import revision is invalid.");
  return [
    "select jsonb_build_object(",
    "  'importStatus', coalesce((",
    "    select jsonb_build_object(",
    "      'runId', run_state.id,",
    "      'state', run_state.state,",
    "      'revision', run_state.revision,",
    "      'stagedBy', run_state.staged_by,",
    "      'masterSourceId', run_state.master_source_id,",
    "      'masterRevision', run_state.master_revision,",
    "      'masterRowsSha256', run_state.master_rows_sha256,",
    "      'payloadSha256', run_state.payload_sha256,",
    "      'chunkCount', (select count(*) from internal.jiaowubao_direct_import_chunks chunk where chunk.run_id = run_state.id),",
    "      'supplementalRecords', (select count(*) from internal.jiaowubao_direct_supplemental_records record where record.run_id = run_state.id),",
    "      'scheduleEvents', (select count(*) from internal.jiaowubao_direct_schedule_events event where event.run_id = run_state.id),",
    "      'scheduleParticipants', (select count(*) from internal.jiaowubao_direct_schedule_event_participants participant join internal.jiaowubao_direct_schedule_events event on event.id = participant.event_id where event.run_id = run_state.id),",
    "      'leaveMakeups', (select count(*) from internal.jiaowubao_direct_leave_makeup_events incident where incident.run_id = run_state.id)",
    "    )",
    "    from internal.jiaowubao_direct_import_runs run_state",
    "    where run_state.source_id = 'jiaowubao-static-excel'",
    `      and run_state.revision = '${revision}'`,
    "      and run_state.state in ('staging', 'complete')",
    "    order by case run_state.state when 'complete' then 0 else 1 end, run_state.staged_at desc",
    "    limit 1",
    "  ), jsonb_build_object('state', 'absent'))",
    ") as direct_import_status;",
    "",
  ].join("\n");
}

function parseImportStatus(result: DbQueryResult) {
  const value = result.rows?.[0]?.direct_import_status;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The direct-import completion state is unavailable.");
  }
  const status = (value as { importStatus?: unknown }).importStatus;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("The direct-import completion state is malformed.");
  }
  return status as ImportReceipt;
}

function receiptMatches(
  receipt: ImportReceipt,
  compiled: ReturnType<typeof compileJiaowubaoDirectImportProjection>,
) {
  const expected = compiled.envelope.expectedCounts;
  return receipt.state === "complete"
    && receipt.revision === compiled.envelope.revision
    && typeof receipt.payloadSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(receipt.payloadSha256)
    && receipt.chunkCount === compiled.envelope.chunkCount
    && receipt.supplementalRecords === expected.supplementalRecords
    && receipt.scheduleEvents === expected.scheduleEvents
    && receipt.scheduleParticipants === expected.scheduleParticipants
    && receipt.leaveMakeups === expected.leaveMakeups;
}

function activeStagingRunId(status: ImportReceipt, actor: string) {
  if (status.state !== "staging"
    || typeof status.runId !== "string" || !UUID.test(status.runId)
    || status.stagedBy !== actor) return null;
  return status.runId;
}

function staleStagingRunId(
  status: ImportReceipt,
  authority: JiaowubaoDirectProjectionAuthority,
  actor: string,
) {
  const runId = activeStagingRunId(status, actor);
  if (!runId) return null;
  const master = authority.masterSource;
  const changed = status.masterSourceId !== master.sourceId
    || status.masterRevision !== master.revision
    || status.masterRowsSha256 !== master.rowsSha256;
  return changed ? runId : null;
}

function abortIfCurrentMasterDiffersSql(
  runId: string,
  actor: string,
  authority: JiaowubaoDirectProjectionAuthority,
) {
  if (!UUID.test(runId) || actor !== actor.trim() || !actor || actor.length > 120) {
    throw new Error("The staging run abort request is invalid.");
  }
  const runLiteral = safeSqlTextLiteral(runId);
  const actorLiteral = safeSqlTextLiteral(actor);
  const masterSourceIdLiteral = safeSqlTextLiteral(authority.masterSource.sourceId);
  const masterRevisionLiteral = safeSqlTextLiteral(authority.masterSource.revision);
  const masterRowsSha256Literal = safeSqlTextLiteral(authority.masterSource.rowsSha256);
  return [
    "\\set VERBOSITY verbose",
    "set session role postgres;",
    "begin;",
    "set local lock_timeout = '5s';",
    "set local statement_timeout = '0';",
    "do $jiaowubao_direct_transport_guard$",
    "begin",
    "  if session_user !~ '^cli_login_[a-zA-Z0-9_]+$'",
    "     or current_user <> 'postgres'",
    "     or not pg_catalog.pg_has_role(session_user, 'postgres', 'SET') then",
    "    raise exception using errcode = '42501', message = 'jiaowubao_direct_import_transport_role_invalid';",
    "  end if;",
    "end;",
    "$jiaowubao_direct_transport_guard$;",
    "with abort_attempt as materialized (",
    "  select internal.abort_jiaowubao_direct_import_if_current_master_differs(",
    `    ${runLiteral}::uuid, ${actorLiteral}, ${masterSourceIdLiteral},`,
    `    ${masterRevisionLiteral}, ${masterRowsSha256Literal}`,
    "  ) as value",
    ")",
    "select jsonb_build_object(",
    "  'state', value ->> 'state',",
    "  'runId', value ->> 'runId',",
    "  'aborted', coalesce((value ->> 'aborted')::boolean, false),",
    "  'reason', value ->> 'reason'",
    ") as direct_import_abort_receipt",
    "from abort_attempt;",
    "commit;",
    "",
  ].join("\n");
}

async function abortStagingIfCurrentMasterDiffers(
  psqlBinary: string,
  accessToken: string,
  poolerUrlFile: string,
  secureDir: string,
  runId: string,
  actor: string,
  authority: JiaowubaoDirectProjectionAuthority,
) {
  const login = await mintTemporaryLoginRole(accessToken);
  const target = await directDatabaseTarget(poolerUrlFile, login);
  const pgpassPath = join(secureDir, "abort.pgpass");
  await writeOwnerOnly(
    pgpassPath,
    `${pgpassEscape(target.host)}:${target.port}:${target.database}:${pgpassEscape(target.user)}:${pgpassEscape(target.password)}\n`,
  );
  const probePath = join(secureDir, "abort-probe.sql");
  await writeOwnerOnly(probePath, probeSql());
  await waitForTemporaryLogin(psqlBinary, target, pgpassPath, probePath);
  const abortPath = join(secureDir, "abort-staging.sql");
  await writeOwnerOnly(abortPath, abortIfCurrentMasterDiffersSql(runId, actor, authority));
  const result = await runPsqlJson(
    psqlBinary,
    target,
    pgpassPath,
    abortPath,
    "atomic master-drift staging abort",
    120_000,
  );
  if (result.runId !== runId || typeof result.aborted !== "boolean"
    || (result.state !== "aborted" && result.state !== "staging")) {
    throw new Error("The atomic staging-abort check returned an invalid receipt.");
  }
  return result as Readonly<{ state: "aborted" | "staging"; runId: string; aborted: boolean; reason?: string }>;
}

async function writeOwnerOnly(path: string, value: string) {
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  await verifyReleaseStage(args.stageDir);
  const psqlBinary = await verifyPsqlBinary();
  const accessToken = await readSupabaseAccessToken(args.accessTokenFile);
  await assertManagementProject(accessToken);
  const secureDir = await mkdtemp(join(tmpdir(), "jiaowubao-direct-apply-"));
  await chmod(secureDir, 0o700);
  try {
    const authority = parseAuthority(
      await runManagementQuery(accessToken, authoritySql(), "authority read"),
    ).authority;
    assertRequiredRemoteMigration(await runManagementQuery(
      accessToken,
      requiredRemoteMigrationSql(),
      "required release migration read",
    ));

	    const parsed = parseJiaowubaoStaticXlsxExports(await readInputs(args.inputDir));
	    const prepared = prepareJiaowubaoDirectStaging(parsed);
	    const existingStatus = parseImportStatus(await runManagementQuery(
	      accessToken,
	      importStatusSql(prepared.revision),
	      "existing staging read",
	    ));
	    if (existingStatus.state === "staging" && existingStatus.stagedBy !== args.actor) {
	      throw new Error("A staging batch for this reviewed Excel revision belongs to a different actor and will not be resumed or aborted.");
	    }
	    const staleRunId = staleStagingRunId(existingStatus, authority, args.actor);
	    if (staleRunId) {
	      const abortReceipt = await abortStagingIfCurrentMasterDiffers(
	        psqlBinary,
	        accessToken,
	        args.poolerUrlFile,
	        secureDir,
	        staleRunId,
	        args.actor,
	        authority,
	      );
	      if (!abortReceipt.aborted) {
	        throw new Error("The current Tencent master changed while checking a staging batch; no data was deleted. Rerun the exact command to read a fresh authority snapshot.");
	      }
	      process.stdout.write(`${canonicalJson({ status: "aborted", reason: "masterSourceChanged" })}\n`);
	    }
	    const compiled = compileJiaowubaoDirectImportProjection(prepared, authority);
    assertJiaowubao20260818CompiledBatch(compiled);
    assertEnvelopeAccepted(await runManagementQuery(
      accessToken,
      envelopeAssertionSql(compiled.envelope),
      "compiled envelope assertion",
    ));
    const plan = buildJiaowubaoDirectSequentialImportPlan(compiled, args.actor);
    process.stdout.write(`${canonicalJson({ status: "reviewed", report: compiled.report })}\n`);

    const resumablePath = join(secureDir, "resume.sql");
    await writeOwnerOnly(resumablePath, buildJiaowubaoDirectImportResumableSql(plan));
    const login = await mintTemporaryLoginRole(accessToken);
    const target = await directDatabaseTarget(args.poolerUrlFile, login);
    const pgpassPath = join(secureDir, "pgpass");
    await writeOwnerOnly(
      pgpassPath,
      `${pgpassEscape(target.host)}:${target.port}:${target.database}:${pgpassEscape(target.user)}:${pgpassEscape(target.password)}\n`,
    );
    const probePath = join(secureDir, "probe.sql");
    await writeOwnerOnly(probePath, probeSql());
    await waitForTemporaryLogin(psqlBinary, target, pgpassPath, probePath);

    let receipt: ImportReceipt;
    try {
      receipt = await runPsqlResumableImport(
        psqlBinary,
        target,
        pgpassPath,
        resumablePath,
        QUERY_TIMEOUT_MS,
        (progress) => process.stdout.write(`${canonicalJson(progress)}\n`),
      );
    } catch (error) {
      const category = error instanceof PsqlExecutionError ? error.category : "database_failure";
      let status: ImportReceipt;
      try {
        status = parseImportStatus(await runManagementQuery(
          accessToken,
          importStatusSql(compiled.envelope.revision),
          "completion recovery",
        ));
      } catch {
        throw new Error(`The direct import stopped (${category}); its commit outcome could not be verified.`);
      }
	      if (receiptMatches(status, compiled)) {
	        receipt = status;
	      } else if (status.state === "absent") {
	        throw new Error(`The direct import failed (${category}); no completed or staging batch was found.`);
	      } else if (status.state === "staging") {
	        const currentAuthority = parseAuthority(await runManagementQuery(
	          accessToken,
	          authoritySql(),
	          "staging recovery authority read",
	        )).authority;
	        const staleRunId = staleStagingRunId(status, currentAuthority, args.actor);
	        if (staleRunId) {
	          const abortReceipt = await abortStagingIfCurrentMasterDiffers(
	            psqlBinary,
	            accessToken,
	            args.poolerUrlFile,
	            secureDir,
	            staleRunId,
	            args.actor,
	            currentAuthority,
	          );
	          if (!abortReceipt.aborted) {
	            throw new Error("The current Tencent master changed while checking a staging batch; no data was deleted. Rerun the exact command to read a fresh authority snapshot.");
	          }
	          process.stdout.write(`${canonicalJson({ status: "aborted", reason: "masterSourceChanged" })}\n`);
	          throw new Error("The stale staging batch was safely aborted after a confirmed Tencent master change. Rerun the exact same command to compile against the new authority and continue.");
	        }
	        throw new Error(`The direct import paused (${category}) with a resumable staging batch. Rerun the exact same command to replay-check its committed prefix and continue.`);
      } else {
        throw new Error("The direct import completion state does not match the reviewed batch; no retry was attempted.");
      }
    }
    if (!receiptMatches(receipt, compiled)) {
      throw new Error("The completed direct import receipt does not match the reviewed plan.");
    }
    process.stdout.write(`${canonicalJson({ status: "complete", receipt })}\n`);
  } finally {
    await rm(secureDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected direct-import failure.";
  process.stderr.write(`Jiaowubao direct import failed: ${message}\n`);
  process.exitCode = 1;
});
