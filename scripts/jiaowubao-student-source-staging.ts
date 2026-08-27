#!/usr/bin/env node

/**
 * One-time, operator-only writer for the normalized Jiaowubao student source.
 *
 * This command is deliberately separate from the web application. It reads a
 * local candidate JSON plus its aggregate manifest, asks the deterministic
 * planner to normalize/split it, then makes one committed Supabase HTTPS RPC
 * invocation (one database transaction) per stage chunk. A staging run is source-only: it never resolves student
 * identities and it never reads or pins the current master revision. Identity
 * review remains a later, human-gated step.
 *
 * The planner returns closures ({ row, rowSha256, closureSha256 }). The SQL
 * staging contract accepts the closure rows as its immutable evidence payload;
 * the mapping is isolated in plannerChunkPayload so a contract change cannot
 * accidentally send the raw candidate or a different row order.
 */

import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import {
  digestJiaowubaoStudentSourceCandidate,
  planJiaowubaoStudentSourceStaging,
  type JiaowubaoStudentSourceStagingChunk,
  type JiaowubaoStudentSourceStagingPlan,
  type RawJiaowubaoImportInput,
} from "../lib/jiaowubao-student-source-staging.ts";

const EXPECTED_FORMAT = "jiaowubao-student-source-staging-v1";
const OPS_SECRET_ENV = "JIAOWUBAO_OPS_SECRET";
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_API_KEY_BYTES = 8 * 1024;
const MAX_RPC_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RPC_RESPONSE_BYTES = 512 * 1024;
const RPC_TIMEOUT_MS = 30_000;
const SUPABASE_HOST = "orvsgisjjrzgtxuwwsms.supabase.co";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVISION = /^sha256:[a-f0-9]{64}$/u;

type CliOptions = Readonly<{
  input: string;
  manifest: string;
  supabaseUrl: string;
  supabaseKeyFile?: string;
  supabaseKeyEnv?: string;
  resume: string;
  sourceId: string;
  revision: string;
  actor: string;
  abort: boolean;
}>;

type SafeManifest = Readonly<{
  schemaVersion: number;
  negativeAdjustmentPolicy: string;
  payloadSha256: string;
  payloadBytes: number;
  sourceRevisions: Readonly<Record<string, string>>;
  aggregates: Readonly<Record<string, number>>;
}>;

type SafeReceipt = Readonly<{
  format: typeof EXPECTED_FORMAT;
  sourceId: string;
  revision: string;
  candidateArtifactSha256: string;
  normalizedRowsSha256: string;
  expectedRows: number;
  expectedChunks: number;
  runId: string;
  state: "staging" | "complete" | "aborted";
  chunksCommitted: number;
  rowsCommitted: number;
}>;

type PublishedJwbPointer = Readonly<{
  sourceId: string;
  revision: string;
  rowsSha256: string;
  rowCount: number;
}>;

function usage() {
  return [
    "Usage:",
    "  JIAOWUBAO_OPS_SECRET='(operator secret)' node --import tsx scripts/jiaowubao-student-source-staging.ts \\",
    "    --input '/absolute/path/raw-jiaowubao-import-input.json' \\",
    "    --manifest '/absolute/path/aggregate-manifest.json' \\",
    "    --supabase-url 'https://orvsgisjjrzgtxuwwsms.supabase.co' \\",
    "    (--supabase-key-file '/absolute/path/owner-only-publishable-or-anon-key' | \\",
    "     --supabase-key-env 'SUPABASE_PUBLISHABLE_KEY') \\",
    "    --resume '/absolute/path/owner-only-resume.json' \\",
    "    --source-id 'jwb-api-student-course-balance-20260821' \\",
    "    --revision 'sha256:<64 lowercase hex>' \\",
    "    --actor 'Nixon'",
    "",
    "The command is source-only. It stages the candidate for later human identity review;",
    "it does not create students, packages, bookings, or identity links.",
    "Use exactly one key source. --supabase-key-file must be owner-only; --supabase-key-env reads an existing environment variable.",
    "Use --abort with the same --resume to delete an incomplete staging run.",
  ].join("\n");
}

function valueAfter(args: readonly string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseArguments(args: readonly string[]): CliOptions {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const accepted = new Set([
    "--input", "--manifest", "--supabase-url", "--supabase-key-file", "--supabase-key-env", "--resume", "--source-id", "--revision", "--actor", "--abort",
  ]);
  for (const argument of args) {
    if (argument.startsWith("--") && !accepted.has(argument)) throw new Error(`Unknown option: ${argument}`);
  }
  const input = valueAfter(args, "--input");
  const manifest = valueAfter(args, "--manifest");
  const supabaseUrl = valueAfter(args, "--supabase-url");
  const supabaseKeyFile = valueAfter(args, "--supabase-key-file");
  const supabaseKeyEnv = valueAfter(args, "--supabase-key-env");
  const resume = valueAfter(args, "--resume");
  const sourceId = valueAfter(args, "--source-id");
  const revision = valueAfter(args, "--revision");
  const actor = valueAfter(args, "--actor");
  if (!input || !manifest || !supabaseUrl || (!supabaseKeyFile && !supabaseKeyEnv) || (supabaseKeyFile && supabaseKeyEnv) || !resume || !sourceId || !revision || !actor) {
    throw new Error("--input, --manifest, --supabase-url, exactly one of --supabase-key-file or --supabase-key-env, --resume, --source-id, --revision, and --actor are required.");
  }
  if (supabaseKeyEnv && !/^[A-Z_][A-Z0-9_]*$/u.test(supabaseKeyEnv)) {
    throw new Error("--supabase-key-env must be an uppercase environment variable name.");
  }
  if (sourceId !== sourceId.trim() || sourceId.length < 1 || sourceId.length > 160) {
    throw new Error("--source-id must be a trimmed value of at most 160 characters.");
  }
  if (!REVISION.test(revision.trim()) || revision !== revision.trim()) {
    throw new Error("--revision must be sha256:<64 lowercase hex>.");
  }
  if (actor !== actor.trim() || !["Nixon", "Ops Admin"].includes(actor)) {
    throw new Error("--actor must be Nixon or Ops Admin.");
  }
  return Object.freeze({
    input: resolve(input), manifest: resolve(manifest), supabaseUrl,
    ...(supabaseKeyFile ? { supabaseKeyFile: resolve(supabaseKeyFile) } : { supabaseKeyEnv }),
    resume: resolve(resume), sourceId, revision, actor, abort: args.includes("--abort"),
  });
}

async function regularOwnerOnlyFile(path: string, label: string, maxBytes: number) {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
    throw new Error(`${label} must be an owner-only regular file within its size limit.`);
  }
  return stat;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 240) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseSourceInput(bytes: Uint8Array): RawJiaowubaoImportInput {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("The candidate JSON is invalid."); }
  const input = object(parsed, "The candidate JSON");
  if (!Array.isArray(input.students) || !Array.isArray(input.contracts) || !Array.isArray(input.courseBalances)) {
    throw new Error("The candidate must contain students, contracts, and courseBalances arrays.");
  }
  if (input.courses !== undefined && !Array.isArray(input.courses)) throw new Error("The candidate courses value is invalid.");
  if (input.negativeAdjustmentPolicy !== "aggregate-only") {
    throw new Error("The candidate must use negativeAdjustmentPolicy=aggregate-only.");
  }
  return input as unknown as RawJiaowubaoImportInput;
}

/** Hash the parsed candidate semantics, independent of JSON formatting. */
export function candidateManifestSha256(inputBytes: Uint8Array) {
  return digestJiaowubaoStudentSourceCandidate(parseSourceInput(inputBytes));
}

function parseManifest(bytes: Uint8Array): SafeManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("The aggregate manifest is invalid."); }
  const input = object(parsed, "The aggregate manifest");
  const payload = object(input.payload, "The aggregate manifest payload");
  const sources = object(input.sources, "The aggregate manifest sources");
  const sourceRevisions: Record<string, string> = {};
  for (const [key, value] of Object.entries(sources)) {
    const source = object(value, `The aggregate manifest ${key}`);
    const revision = source.sourceRevision;
    if (typeof revision !== "string" || !REVISION.test(revision)) throw new Error("The aggregate manifest source revision is invalid.");
    sourceRevisions[key === "courseBalances" ? "courseBalances" : key] = revision;
  }
  for (const required of ["students", "contracts", "courseBalances"]) {
    if (!sourceRevisions[required]) throw new Error(`The aggregate manifest is missing ${required}.`);
  }
  const payloadSha256 = text(payload.sha256, "The aggregate manifest payload hash", 80);
  if (!REVISION.test(payloadSha256)) throw new Error("The aggregate manifest payload hash is invalid.");
  const bytesCount = payload.bytes;
  if (!Number.isSafeInteger(bytesCount) || bytesCount < 1) throw new Error("The aggregate manifest payload byte count is invalid.");
  const policy = text(input.negativeAdjustmentPolicy, "The aggregate manifest policy", 32);
  if (policy !== "aggregate-only") throw new Error("The aggregate manifest policy is not aggregate-only.");
  const rawAggregates = object(input.aggregates, "The aggregate manifest aggregates");
  const aggregates: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawAggregates)) {
    if (!Number.isSafeInteger(value) || value < 0) continue;
    aggregates[key] = value;
  }
  if (input.schemaVersion !== 1) throw new Error("The aggregate manifest schema version is unsupported.");
  return Object.freeze({
    schemaVersion: 1,
    negativeAdjustmentPolicy: policy,
    payloadSha256,
    payloadBytes: bytesCount,
    sourceRevisions: Object.freeze(sourceRevisions),
    aggregates: Object.freeze(aggregates),
  });
}

function assertCandidateMatchesManifest(
  inputBytes: Uint8Array,
  sourceInput: RawJiaowubaoImportInput,
  manifest: SafeManifest,
  plan: JiaowubaoStudentSourceStagingPlan,
) {
  if (candidateManifestSha256(inputBytes) !== manifest.payloadSha256) {
    throw new Error("The parsed candidate does not match the aggregate manifest hash.");
  }
  const expected = {
    students: sourceInput.students.length,
    contracts: sourceInput.contracts.length,
    courseBalances: sourceInput.courseBalances.length,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest.aggregates[key] !== value) {
      throw new Error("The candidate aggregate counts do not match the aggregate manifest.");
    }
  }
  if (plan.envelope.expectedRows !== expected.students) {
    throw new Error("The normalized source row count does not match the candidate manifest.");
  }
}

/** Explicit contract boundary: stage immutable planner closures, in planner order. */
export function plannerChunkPayload(chunk: JiaowubaoStudentSourceStagingChunk) {
  if (!Array.isArray(chunk.rows) || chunk.rows.length < 1) throw new Error("The planner produced an empty chunk.");
  return chunk.rows.map((closure) => ({
    sourceRow: closure.sourceRow,
    row: closure.row,
    rowCanonicalJson: closure.rowCanonicalJson,
    rowSha256: closure.rowSha256,
    closureCanonicalJson: closure.closureCanonicalJson,
    closureSha256: closure.closureSha256,
  }));
}

function safeMetadata(manifest: SafeManifest) {
  return {
    sourceRevisions: manifest.sourceRevisions,
    candidateArtifactSha256: manifest.payloadSha256,
    aggregateCounts: manifest.aggregates,
    negativeAdjustmentPolicy: manifest.negativeAdjustmentPolicy,
    sourceScope: "source_only_identity_review_pending",
    masterRevisionPinned: false,
  };
}

function beginEnvelope(
  plan: JiaowubaoStudentSourceStagingPlan,
  manifest: SafeManifest,
  expectedPublishedJwb: PublishedJwbPointer,
) {
  return {
    sourceId: plan.envelope.sourceId,
    revision: plan.envelope.revision,
    candidateArtifactSha256: plan.envelope.rawCandidateSha256,
    expectedRowCount: plan.envelope.expectedRows,
    expectedChunkCount: plan.envelope.expectedChunks,
    sourceRevisions: plan.envelope.sourceRevisions,
    normalizedRowsSha256: plan.envelope.normalizedRowsSha256,
    expectedPublishedJwb,
    sourceMetadata: safeMetadata(manifest),
  };
}

export function parseSupabaseUrl(value: string) {
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("The Supabase URL is invalid."); }
  if (parsed.protocol !== "https:" || parsed.hostname !== SUPABASE_HOST
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw new Error(`The Supabase URL must be https://${SUPABASE_HOST}.`);
  }
  return `https://${SUPABASE_HOST}`;
}

export function parseSupabaseApiKey(value: string) {
  const key = value.trim();
  if (!key || key.length > MAX_API_KEY_BYTES || /[\r\n\u0000]/u.test(key)
    || key.startsWith("sb_secret_") || key.includes("service_role")) {
    throw new Error("The Supabase key must contain a publishable or anon key.");
  }
  const isPublishable = key.startsWith("sb_publishable_");
  const isLegacyAnon = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(key);
  if (!isPublishable && !isLegacyAnon) {
    throw new Error("The Supabase key must contain a publishable or anon key.");
  }
  return key;
}

export function readSupabaseApiKeyFromEnvironment(name: string, environment: NodeJS.ProcessEnv = process.env) {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
    throw new Error("The Supabase key environment variable name is invalid.");
  }
  const value = environment[name];
  if (!value) throw new Error(`The Supabase key environment variable ${name} is not set.`);
  return parseSupabaseApiKey(value);
}

type RpcName =
  | "get_jiaowubao_student_source_ingest_preflight"
  | "begin_jiaowubao_student_source_ingest"
  | "stage_jiaowubao_student_source_chunk"
  | "get_jiaowubao_student_source_ingest_status"
  | "complete_jiaowubao_student_source_ingest"
  | "abort_jiaowubao_student_source_ingest";

async function readBoundedResponse(response: Response) {
  if (!response.body) throw new Error("Supabase returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RPC_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Supabase response exceeded the bounded response size.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function callSupabaseRpc(
  supabaseUrl: string,
  apiKey: string,
  secret: string,
  rpc: RpcName,
  body: Record<string, unknown>,
  phase: string,
) {
  const requestBody = JSON.stringify({ ...body, p_secret: secret });
  if (Buffer.byteLength(requestBody, "utf8") > MAX_RPC_REQUEST_BYTES) {
    throw new Error(`Supabase ${phase} request exceeds the bounded request size.`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpc}`, {
        method: "POST",
        headers: {
          apikey: apiKey,
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch {
      throw new Error(`Supabase ${phase} request failed.`);
    }
    let responseBytes: Buffer;
    try { responseBytes = await readBoundedResponse(response); } catch (error) {
      if (error instanceof Error && error.message === "Supabase response exceeded the bounded response size.") {
        throw new Error(`Supabase ${phase} response exceeded the bounded response size.`);
      }
      throw new Error(`Supabase ${phase} response could not be read.`);
    }
    if (!response.ok) throw new Error(`Supabase ${phase} request failed.`);
    let parsed: unknown;
    try { parsed = JSON.parse(responseBytes.toString("utf8")); } catch { throw new Error(`Supabase ${phase} returned an invalid aggregate response.`); }
    return object(parsed, `Supabase ${phase} response`);
  } finally {
    clearTimeout(timeout);
  }
}

async function writeReceipt(path: string, receipt: SafeReceipt) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readResumeReceipt(path: string, plan: JiaowubaoStudentSourceStagingPlan) {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024) {
    throw new Error("The resume receipt must be an owner-only regular file.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("The resume receipt is invalid."); }
  const receipt = object(parsed, "The resume receipt") as Partial<SafeReceipt>;
  if (receipt.format !== EXPECTED_FORMAT
    || receipt.sourceId !== plan.envelope.sourceId
    || receipt.revision !== plan.envelope.revision
    || receipt.candidateArtifactSha256 !== plan.envelope.rawCandidateSha256
    || receipt.normalizedRowsSha256 !== plan.envelope.normalizedRowsSha256
    || !UUID.test(String(receipt.runId ?? ""))
    || !["staging", "complete", "aborted"].includes(String(receipt.state ?? ""))
    || !Number.isSafeInteger(receipt.chunksCommitted)
    || !Number.isSafeInteger(receipt.rowsCommitted)
    || (receipt.chunksCommitted ?? -1) < 0
    || (receipt.chunksCommitted ?? Infinity) > plan.envelope.expectedChunks
    || (receipt.rowsCommitted ?? -1) < 0
    || (receipt.rowsCommitted ?? Infinity) > plan.envelope.expectedRows) {
    throw new Error("The resume receipt does not match the candidate plan.");
  }
  return receipt as SafeReceipt;
}

function receiptFrom(plan: JiaowubaoStudentSourceStagingPlan, runId: string, state: SafeReceipt["state"], chunksCommitted: number, rowsCommitted: number): SafeReceipt {
  return Object.freeze({
    format: EXPECTED_FORMAT,
    sourceId: plan.envelope.sourceId,
    revision: plan.envelope.revision,
    candidateArtifactSha256: plan.envelope.rawCandidateSha256,
    normalizedRowsSha256: plan.envelope.normalizedRowsSha256,
    expectedRows: plan.envelope.expectedRows,
    expectedChunks: plan.envelope.expectedChunks,
    runId, state, chunksCommitted, rowsCommitted,
  });
}

function asString(value: unknown, label: string) { return text(value, label, 240); }
function asNumber(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid.`);
  return value as number;
}

function publishedJwbPointerFromPreflight(value: Record<string, unknown>) {
  const pointer = object(value.currentJwb, "preflight currentJwb");
  const sourceId = text(pointer.sourceId, "preflight sourceId", 160);
  const revision = text(pointer.revision, "preflight revision", 240);
  const rowsSha256 = text(pointer.rowsSha256, "preflight rowsSha256", 80);
  const rowCount = asNumber(pointer.rowCount, "preflight rowCount");
  if (!/^[a-f0-9]{64}$/u.test(rowsSha256) || rowCount < 1 || rowCount > 10_000) {
    throw new Error("The current JWB source pointer is invalid.");
  }
  return Object.freeze({ sourceId, revision, rowsSha256, rowCount });
}

function receiptFromServerStatus(
  plan: JiaowubaoStudentSourceStagingPlan,
  runId: string,
  status: Record<string, unknown>,
) {
  const state = asString(status.state, "status state");
  if (!(["staging", "complete", "aborted"] as const).includes(state as SafeReceipt["state"])) {
    throw new Error("The status response state is invalid.");
  }
  if (asString(status.runId, "status runId") !== runId
    || asString(status.sourceId, "status sourceId") !== plan.envelope.sourceId
    || asString(status.revision, "status revision") !== plan.envelope.revision
    || asString(status.candidateArtifactSha256, "status candidateArtifactSha256") !== plan.envelope.rawCandidateSha256
    || asString(status.normalizedRowsSha256, "status normalizedRowsSha256") !== plan.envelope.normalizedRowsSha256
    || asNumber(status.expectedRowCount, "status expectedRowCount") !== plan.envelope.expectedRows
    || asNumber(status.expectedChunkCount, "status expectedChunkCount") !== plan.envelope.expectedChunks) {
    throw new Error("The persisted status does not match the candidate plan.");
  }
  const chunksCommitted = asNumber(status.stagedChunkCount, "status stagedChunkCount");
  const rowsCommitted = asNumber(status.stagedRowCount, "status stagedRowCount");
  if (chunksCommitted > plan.envelope.expectedChunks || rowsCommitted > plan.envelope.expectedRows) {
    throw new Error("The persisted status exceeds the candidate plan.");
  }
  if (state === "complete"
    && (chunksCommitted !== plan.envelope.expectedChunks || rowsCommitted !== plan.envelope.expectedRows)) {
    throw new Error("The completed run status is incomplete.");
  }
  return receiptFrom(plan, runId, state as SafeReceipt["state"], chunksCommitted, rowsCommitted);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const secret = process.env[OPS_SECRET_ENV];
  if (!secret || secret.length > 512 || /[\r\n\u0000]/u.test(secret)) throw new Error(`${OPS_SECRET_ENV} is required.`);
  await regularOwnerOnlyFile(options.input, "--input", MAX_INPUT_BYTES);
  await regularOwnerOnlyFile(options.manifest, "--manifest", MAX_MANIFEST_BYTES);
  if (options.supabaseKeyFile) await regularOwnerOnlyFile(options.supabaseKeyFile, "--supabase-key-file", MAX_API_KEY_BYTES);
  const supabaseUrl = parseSupabaseUrl(options.supabaseUrl);
  const [inputBytes, manifestBytes] = await Promise.all([
    readFile(options.input), readFile(options.manifest),
  ]);
  const apiKey = options.supabaseKeyFile
    ? parseSupabaseApiKey((await readFile(options.supabaseKeyFile)).toString("utf8"))
    : readSupabaseApiKeyFromEnvironment(options.supabaseKeyEnv ?? "");
  const manifest = parseManifest(manifestBytes);
  const sourceInput = parseSourceInput(inputBytes);
  const plan = planJiaowubaoStudentSourceStaging({
    ...sourceInput,
    sourceId: options.sourceId,
    revision: options.revision,
    rawCandidateSha256: manifest.payloadSha256,
    sourceRevisions: manifest.sourceRevisions,
  });
  if (manifest.payloadBytes !== inputBytes.byteLength) throw new Error("The candidate byte count does not match the aggregate manifest.");
  assertCandidateMatchesManifest(inputBytes, sourceInput, manifest, plan);
  const savedReceipt = await readResumeReceipt(options.resume, plan);
  let priorReceipt: SafeReceipt | undefined;
  if (savedReceipt) {
    // A network timeout may happen after a database transaction commits.  Ask
    // the server for this exact run before deciding whether to resume, abort,
    // or create a fresh run. This prevents an uncertain abort from creating a
    // second active run and then failing on a mismatched local receipt.
    const status = await callSupabaseRpc(
      supabaseUrl, apiKey, secret, "get_jiaowubao_student_source_ingest_status",
      { p_run_id: savedReceipt.runId, p_actor: options.actor }, "status",
    );
    const persistedReceipt = receiptFromServerStatus(plan, savedReceipt.runId, status);
    await writeReceipt(options.resume, persistedReceipt);
    if (persistedReceipt.state === "complete") {
      if (options.abort) throw new Error("A completed staging run cannot be aborted.");
      process.stdout.write(`${JSON.stringify(persistedReceipt)}\n`);
      return;
    }
    if (persistedReceipt.state === "aborted") {
      if (options.abort) {
        process.stdout.write(`${JSON.stringify(persistedReceipt)}\n`);
        return;
      }
      // The active-revision unique index intentionally ignores an aborted
      // run. Only after confirming that state is it safe to begin a fresh run.
    } else {
      if (options.abort) {
        const aborted = await callSupabaseRpc(
          supabaseUrl, apiKey, secret, "abort_jiaowubao_student_source_ingest",
          { p_run_id: persistedReceipt.runId, p_actor: options.actor }, "abort",
        );
        if (asString(aborted.runId, "abort runId") !== persistedReceipt.runId
          || asString(aborted.state, "abort state") !== "aborted") {
          throw new Error("The abort response did not confirm the persisted staging run.");
        }
        const receipt = receiptFrom(plan, persistedReceipt.runId, "aborted", 0, 0);
        await writeReceipt(options.resume, receipt);
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
        return;
      }
      priorReceipt = persistedReceipt;
    }
  }
  if (options.abort) throw new Error("--abort requires a persisted staging run.");
  const preflight = await callSupabaseRpc(
    supabaseUrl, apiKey, secret, "get_jiaowubao_student_source_ingest_preflight",
    { p_actor: options.actor }, "preflight",
  );
  const expectedPublishedJwb = publishedJwbPointerFromPreflight(preflight);
  const envelope = beginEnvelope(plan, manifest, expectedPublishedJwb);
  const begin = await callSupabaseRpc(
    supabaseUrl, apiKey, secret, "begin_jiaowubao_student_source_ingest",
    { p_envelope: envelope, p_actor: options.actor }, "begin",
  );
  const runId = asString(begin.runId, "begin runId");
  if (!UUID.test(runId)) throw new Error("The begin response runId is invalid.");
  if (priorReceipt && priorReceipt.runId !== runId) throw new Error("The persisted run ID does not match the server run.");
  const beginState = asString(begin.state, "begin state");
  if (asString(begin.sourceId, "begin sourceId") !== plan.envelope.sourceId
    || asString(begin.revision, "begin revision") !== plan.envelope.revision
    || asNumber(begin.expectedRowCount, "begin expectedRowCount") !== plan.envelope.expectedRows
    || asNumber(begin.expectedChunkCount, "begin expectedChunkCount") !== plan.envelope.expectedChunks
    || asString(begin.candidateArtifactSha256, "begin candidateArtifactSha256") !== plan.envelope.rawCandidateSha256
    || asString(begin.normalizedRowsSha256, "begin normalizedRowsSha256") !== plan.envelope.normalizedRowsSha256) {
    throw new Error("The persisted run envelope does not match the candidate plan.");
  }
  const persistedPublishedJwb = publishedJwbPointerFromPreflight({
    currentJwb: begin.expectedPublishedJwb,
  });
  if (persistedPublishedJwb.sourceId !== expectedPublishedJwb.sourceId
    || persistedPublishedJwb.revision !== expectedPublishedJwb.revision
    || persistedPublishedJwb.rowsSha256 !== expectedPublishedJwb.rowsSha256
    || persistedPublishedJwb.rowCount !== expectedPublishedJwb.rowCount) {
    throw new Error("The persisted publication pointer does not match the preflight.");
  }
  if (beginState === "complete") {
    const receipt = receiptFrom(plan, runId, "complete", plan.envelope.expectedChunks, plan.envelope.expectedRows);
    await writeReceipt(options.resume, receipt);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  if (beginState !== "staging") throw new Error("The begin response is not staging.");
  await writeReceipt(options.resume, receiptFrom(plan, runId, "staging", 0, 0));
  // Always replay every chunk from index zero. The server decides whether a
  // chunk is a safe idempotent replay; local state is never trusted to skip it.
  for (let index = 0; index < plan.chunks.length; index += 1) {
    const chunk = plan.chunks[index];
    const payload = plannerChunkPayload(chunk);
    const staged = await callSupabaseRpc(
      supabaseUrl, apiKey, secret, "stage_jiaowubao_student_source_chunk",
      { p_run_id: runId, p_chunk_index: index, p_closures: payload, p_actor: options.actor }, `stage-${index}`,
    );
    if (asString(staged.state, "stage state") !== "staging"
      || asNumber(staged.chunkIndex, "stage chunkIndex") !== index
      || asNumber(staged.sourceRowCount, "stage sourceRowCount") !== payload.length) {
      throw new Error("The stage response does not match the planned chunk.");
    }
    const receipt = receiptFrom(plan, runId, "staging", index + 1, plan.chunks.slice(0, index + 1).reduce((sum, item) => sum + item.rows.length, 0));
    await writeReceipt(options.resume, receipt);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }
  const completed = await callSupabaseRpc(
    supabaseUrl, apiKey, secret, "complete_jiaowubao_student_source_ingest",
    { p_run_id: runId, p_actor: options.actor }, "complete",
  );
  if (asString(completed.state, "complete state") !== "complete"
    || asString(completed.normalizedRowsSha256, "complete normalizedRowsSha256") !== plan.envelope.normalizedRowsSha256) {
    throw new Error("The completion response did not confirm the candidate integrity contract.");
  }
  const receipt = receiptFrom(plan, runId, "complete", plan.envelope.expectedChunks, plan.envelope.expectedRows);
  await writeReceipt(options.resume, receipt);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unexpected staging failure.";
    process.stderr.write(`Jiaowubao student source staging failed: ${message}\n`);
    process.exitCode = 1;
  });
}
