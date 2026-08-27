import { createHash } from "node:crypto";

import {
  adaptJiaowubaoImportRows,
  type JiaowubaoImportInput,
  type RawJiaowubaoContract,
  type RawJiaowubaoCourse,
  type RawJiaowubaoCourseBalance,
  type RawJiaowubaoStudent,
} from "./jiaowubao-import";
import type { JwbStudentImportRow, StudentImportSourceKey } from "./student-import";

/**
 * Local-only format for the normalized JWB student source hand-off.
 *
 * The planner deliberately stops at immutable row closures.  It does not
 * create students, write staging rows, or call an API.  A later writer can
 * persist these chunks after it has independently checked the source and
 * authority versions.
 */
export const JIAOWUBAO_STUDENT_SOURCE_STAGING_FORMAT = "jiaowubao-student-source-staging-v1" as const;
export const MAX_JIAOWUBAO_STUDENT_SOURCE_ROWS = 10_000;
export const MAX_JIAOWUBAO_STUDENT_SOURCE_REVISIONS = 32;
export const MAX_JIAOWUBAO_STUDENT_SOURCE_CHUNKS = 512;
export const MAX_JIAOWUBAO_STUDENT_SOURCE_CHUNK_BYTES = 2 * 1024 * 1024;
/**
 * PostgreSQL's jsonb text representation adds structural whitespace to the
 * compact local closure encoding. Plan conservatively so a valid local chunk
 * remains safely under the server's hard 2 MiB byte limit.
 */
export const DEFAULT_JIAOWUBAO_STUDENT_SOURCE_CHUNK_BYTES = Math.floor(
  MAX_JIAOWUBAO_STUDENT_SOURCE_CHUNK_BYTES * 0.8,
);
export const MAX_JIAOWUBAO_STUDENT_SOURCE_ROW_BYTES = MAX_JIAOWUBAO_STUDENT_SOURCE_CHUNK_BYTES;

type SourceRevisions = Readonly<Record<string, string>>;

/** Raw API arrays plus the immutable source identity captured by the exporter. */
export type RawJiaowubaoImportInput = Readonly<{
  sourceId: string;
  revision: string;
  /** If omitted, it is derived from the exact raw arrays below. */
  rawCandidateSha256?: string;
  /** Revisions of the individual source snapshots used to build this candidate. */
  sourceRevisions?: SourceRevisions;
} & JiaowubaoImportInput>;

export type JiaowubaoStudentSourceRowClosure = Readonly<{
  sourceRow: string;
  row: JwbStudentImportRow;
  /**
   * Canonical bytes for `row`.  The database validates that this parses back
   * to `row` and verifies `rowSha256` over these exact bytes.
   *
   * This stays in the private staging table only; it is never included in a
   * progress receipt or returned by a public status RPC.
   */
  rowCanonicalJson: string;
  rowSha256: string;
  /**
   * Canonical metadata binding this row digest to the source/revision.  The
   * staging RPC independently parses and hashes it before accepting a chunk.
   */
  closureCanonicalJson: string;
  closureSha256: string;
}>;

export type JiaowubaoStudentSourceStagingChunk = Readonly<{
  format: typeof JIAOWUBAO_STUDENT_SOURCE_STAGING_FORMAT;
  sourceId: string;
  revision: string;
  rawCandidateSha256: string;
  sourceRevisions: SourceRevisions;
  chunk: Readonly<{ index: number; count: number }>;
  rows: readonly JiaowubaoStudentSourceRowClosure[];
  /** Serialized UTF-8 bytes of this complete chunk. */
  bytes: number;
  /** Digest of the chunk payload before the bookkeeping fields are added. */
  sha256: string;
}>;

export type JiaowubaoStudentSourceStagingEnvelope = Readonly<{
  format: typeof JIAOWUBAO_STUDENT_SOURCE_STAGING_FORMAT;
  sourceId: string;
  revision: string;
  rawCandidateSha256: string;
  sourceRevisions: SourceRevisions;
  expectedRows: number;
  expectedChunks: number;
  normalizedRowsSha256: string;
}>;

export type JiaowubaoStudentSourceStagingPlan = Readonly<{
  envelope: JiaowubaoStudentSourceStagingEnvelope;
  chunks: readonly JiaowubaoStudentSourceStagingChunk[];
  /** The normalized rows are retained only for the local planner caller. */
  rows: readonly JwbStudentImportRow[];
}>;

export type JiaowubaoStudentSourceStagingProgress = Readonly<{
  state?: "planned" | "staging" | "complete" | "aborted";
  chunksCommitted?: number;
  rowsCommitted?: number;
}>;

export type JiaowubaoStudentSourceStagingReceipt = Readonly<{
  format: typeof JIAOWUBAO_STUDENT_SOURCE_STAGING_FORMAT;
  sourceId: string;
  revision: string;
  state: "planned" | "staging" | "complete" | "aborted";
  expectedRows: number;
  expectedChunks: number;
  chunksCommitted: number;
  rowsCommitted: number;
  remainingChunks: number;
  remainingRows: number;
  /** Safe integrity values; no names, phones, packages, or source rows. */
  rawCandidateSha256: string;
  normalizedRowsSha256: string;
}>;

export type JiaowubaoStudentSourceStagingErrorCode =
  | "invalid_input"
  | "invalid_metadata"
  | "max_count_exceeded"
  | "normalization_failed"
  | "duplicate_source_row"
  | "source_row_oversize"
  | "chunk_limit_exceeded"
  | "invalid_progress";

/** Errors intentionally contain no source values: source IDs may be customer data. */
export class JiaowubaoStudentSourceStagingError extends Error {
  constructor(readonly code: JiaowubaoStudentSourceStagingErrorCode, message: string) {
    super(message);
    this.name = "JiaowubaoStudentSourceStagingError";
  }
}

export type JiaowubaoStudentSourceStagingOptions = Readonly<{
  /** Lower values are useful for deterministic unit tests; never above 2 MiB. */
  maxChunkBytes?: number;
  maxRows?: number;
  maxChunks?: number;
}>;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function freeze<T>(value: T) {
  return Object.freeze(value);
}

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JiaowubaoStudentSourceStagingError("invalid_input", "JWB source contains an unsupported value.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      if (item !== undefined) result[key] = canonicalize(item);
    }
    return result;
  }
  throw new JiaowubaoStudentSourceStagingError("invalid_input", "JWB source contains an unsupported value.");
}

/** Stable JSON encoding shared by row, chunk, and candidate digests. */
export function canonicalJiaowubaoStudentSourceJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digestCanonicalJson(canonicalJson: string) {
  return `sha256:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`;
}

function digest(value: unknown) {
  return digestCanonicalJson(canonicalJiaowubaoStudentSourceJson(value));
}

function requiredText(value: unknown, limit: number, code: JiaowubaoStudentSourceStagingErrorCode = "invalid_metadata") {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new JiaowubaoStudentSourceStagingError(code, "JWB source metadata is invalid.");
  }
  return value.trim();
}

function digestText(value: unknown) {
  const clean = requiredText(value, 80);
  if (!/^sha256:[a-f0-9]{64}$/u.test(clean)) {
    throw new JiaowubaoStudentSourceStagingError("invalid_metadata", "JWB source digest metadata is invalid.");
  }
  return clean;
}

function sourceRowKey(value: StudentImportSourceKey) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new JiaowubaoStudentSourceStagingError("normalization_failed", "JWB source row identity is invalid.");
  }
  const key = String(value).trim();
  if (!key || key.length > 240) {
    throw new JiaowubaoStudentSourceStagingError("normalization_failed", "JWB source row identity is invalid.");
  }
  return key;
}

function compareSourceRows(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceRevisions(input: RawJiaowubaoImportInput) {
  const supplied = input.sourceRevisions;
  if (supplied !== undefined && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) {
    throw new JiaowubaoStudentSourceStagingError("invalid_metadata", "JWB source revisions are invalid.");
  }
  const entries = Object.entries(supplied ?? {
    students: input.revision,
    contracts: input.revision,
    courseBalances: input.revision,
    ...(input.courses !== undefined ? { courses: input.revision } : {}),
  });
  if (entries.length < 1 || entries.length > MAX_JIAOWUBAO_STUDENT_SOURCE_REVISIONS) {
    throw new JiaowubaoStudentSourceStagingError("max_count_exceeded", "JWB source revision count exceeds the allowed maximum.");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of entries.sort(([left], [right]) => compareSourceRows(left, right))) {
    const cleanKey = requiredText(key, 80);
    result[cleanKey] = requiredText(value, 240);
  }
  return freeze(result);
}

function rawCandidatePayload(input: RawJiaowubaoImportInput) {
  return {
    students: input.students,
    contracts: input.contracts,
    courseBalances: input.courseBalances,
    ...(input.courses !== undefined ? { courses: input.courses } : {}),
    negativeAdjustmentPolicy: input.negativeAdjustmentPolicy ?? "reject",
  };
}

/**
 * Digest the semantic candidate payload used by the staging envelope.
 *
 * This is deliberately independent of the JSON file's whitespace or key
 * ordering.  Aggregate manifests bind this digest to the parsed candidate;
 * the file itself may additionally be protected by an artifact hash when it
 * is transported or archived.
 */
export function digestJiaowubaoStudentSourceCandidate(input: RawJiaowubaoImportInput) {
  return digest(rawCandidatePayload(input));
}

function rawArrays(input: RawJiaowubaoImportInput) {
  const lengths: readonly [string, unknown][] = [
    ["students", input.students],
    ["contracts", input.contracts],
    ["courseBalances", input.courseBalances],
    ["courses", input.courses],
  ];
  for (const [, value] of lengths) {
    if (value !== undefined && !Array.isArray(value)) {
      throw new JiaowubaoStudentSourceStagingError("invalid_input", "JWB source arrays are invalid.");
    }
    if (Array.isArray(value) && value.length > MAX_JIAOWUBAO_STUDENT_SOURCE_ROWS) {
      throw new JiaowubaoStudentSourceStagingError("max_count_exceeded", "JWB source row count exceeds the allowed maximum.");
    }
  }
}

function closure(
  sourceId: string,
  revision: string,
  revisions: SourceRevisions,
  row: JwbStudentImportRow,
): JiaowubaoStudentSourceRowClosure {
  const sourceRow = sourceRowKey(row.sourceRow);
  const rowCanonicalJson = canonicalJiaowubaoStudentSourceJson(row);
  const rowSha256 = digestCanonicalJson(rowCanonicalJson);
  const closureCanonicalJson = canonicalJiaowubaoStudentSourceJson({
    format: JIAOWUBAO_STUDENT_SOURCE_STAGING_FORMAT,
    sourceId,
    revision,
    sourceRevisions: revisions,
    sourceRow,
    rowSha256,
  });
  const closureSha256 = digestCanonicalJson(closureCanonicalJson);
  return freeze({
    sourceRow,
    row,
    rowCanonicalJson,
    rowSha256,
    closureCanonicalJson,
    closureSha256,
  });
}

function chunkPayload(
  input: Pick<RawJiaowubaoImportInput, "sourceId" | "revision">,
  rawCandidateSha256: string,
  revisions: SourceRevisions,
  index: number,
  count: number,
  rows: readonly JiaowubaoStudentSourceRowClosure[],
) {
  return {
    format: JIAOWUBAO_STUDENT_SOURCE_STAGING_FORMAT,
    sourceId: input.sourceId,
    revision: input.revision,
    rawCandidateSha256,
    sourceRevisions: revisions,
    chunk: { index, count },
    rows,
  };
}

function materializeChunk(
  payload: ReturnType<typeof chunkPayload>,
): JiaowubaoStudentSourceStagingChunk {
  const sha256 = digest(payload);
  let bytes = 0;
  let chunk: JiaowubaoStudentSourceStagingChunk;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    chunk = freeze({ ...payload, bytes, sha256 });
    const nextBytes = Buffer.byteLength(canonicalJiaowubaoStudentSourceJson(chunk), "utf8");
    if (nextBytes === bytes) return chunk;
    bytes = nextBytes;
  }
  return freeze({ ...payload, bytes, sha256 });
}

function planChunkRows(
  input: Pick<RawJiaowubaoImportInput, "sourceId" | "revision">,
  rawCandidateSha256: string,
  revisions: SourceRevisions,
  rows: readonly JiaowubaoStudentSourceRowClosure[],
  maxChunkBytes: number,
  maxChunks: number,
) {
  const provisional: JiaowubaoStudentSourceStagingChunk[] = [];
  let current: JiaowubaoStudentSourceRowClosure[] = [];
  for (const row of rows) {
    const candidateRows = [...current, row];
    const candidate = materializeChunk(chunkPayload(
      input,
      rawCandidateSha256,
      revisions,
      provisional.length,
      0,
      candidateRows,
    ));
    if (candidate.bytes > maxChunkBytes) {
      if (current.length === 0) {
        throw new JiaowubaoStudentSourceStagingError("source_row_oversize", "A single normalized JWB source row exceeds the chunk limit.");
      }
      provisional.push(materializeChunk(chunkPayload(
        input,
        rawCandidateSha256,
        revisions,
        provisional.length,
        0,
        current,
      )));
      if (provisional.length >= maxChunks) {
        throw new JiaowubaoStudentSourceStagingError("chunk_limit_exceeded", "JWB source chunk count exceeds the allowed maximum.");
      }
      current = [row];
      const single = materializeChunk(chunkPayload(input, rawCandidateSha256, revisions, provisional.length, 0, current));
      if (single.bytes > maxChunkBytes) {
        throw new JiaowubaoStudentSourceStagingError("source_row_oversize", "A single normalized JWB source row exceeds the chunk limit.");
      }
    } else {
      current = candidateRows;
    }
  }
  if (current.length) provisional.push(materializeChunk(chunkPayload(
    input,
    rawCandidateSha256,
    revisions,
    provisional.length,
    0,
    current,
  )));
  if (provisional.length > maxChunks) {
    throw new JiaowubaoStudentSourceStagingError("chunk_limit_exceeded", "JWB source chunk count exceeds the allowed maximum.");
  }
  const count = provisional.length;
  return provisional.map((chunk, index) => materializeChunk(chunkPayload(
    input,
    rawCandidateSha256,
    revisions,
    index,
    count,
    chunk.rows,
  )));
}

function assertOptions(options: JiaowubaoStudentSourceStagingOptions) {
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_JIAOWUBAO_STUDENT_SOURCE_CHUNK_BYTES;
  const maxRows = options.maxRows ?? MAX_JIAOWUBAO_STUDENT_SOURCE_ROWS;
  const maxChunks = options.maxChunks ?? MAX_JIAOWUBAO_STUDENT_SOURCE_CHUNKS;
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > MAX_JIAOWUBAO_STUDENT_SOURCE_CHUNK_BYTES
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_JIAOWUBAO_STUDENT_SOURCE_ROWS
    || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_JIAOWUBAO_STUDENT_SOURCE_CHUNKS) {
    throw new JiaowubaoStudentSourceStagingError("invalid_input", "JWB staging planner limits are invalid.");
  }
  return { maxChunkBytes, maxRows, maxChunks };
}

/**
 * Normalize one already validated raw snapshot and deterministically split it
 * into resumable, independently addressable chunks.
 */
export function planJiaowubaoStudentSourceStaging(
  input: RawJiaowubaoImportInput,
  options: JiaowubaoStudentSourceStagingOptions = {},
): JiaowubaoStudentSourceStagingPlan {
  if (!input || typeof input !== "object") {
    throw new JiaowubaoStudentSourceStagingError("invalid_input", "JWB source input is invalid.");
  }
  const limits = assertOptions(options);
  const sourceId = requiredText(input.sourceId, 160);
  const revision = requiredText(input.revision, 240);
  rawArrays(input);
  const revisions = sourceRevisions(input);
  const derivedRawCandidateSha256 = digestJiaowubaoStudentSourceCandidate(input);
  const rawCandidateSha256 = input.rawCandidateSha256 === undefined
    ? derivedRawCandidateSha256
    : digestText(input.rawCandidateSha256);

  let rows: readonly JwbStudentImportRow[];
  try {
    rows = adaptJiaowubaoImportRows({
      students: input.students,
      contracts: input.contracts,
      courseBalances: input.courseBalances,
      ...(input.courses !== undefined ? { courses: input.courses } : {}),
      negativeAdjustmentPolicy: input.negativeAdjustmentPolicy,
    });
  } catch {
    // The adapter's detailed error can contain a source key. Do not re-expose
    // it in a receipt, API response, or terminal log.
    throw new JiaowubaoStudentSourceStagingError("normalization_failed", "JWB source normalization failed validation.");
  }
  if (rows.length < 1 || rows.length > limits.maxRows) {
    throw new JiaowubaoStudentSourceStagingError("max_count_exceeded", "Normalized JWB source row count exceeds the allowed maximum.");
  }

  const sourceRows = new Set<string>();
  const revisionsForClosure = revisions;
  const closures = rows
    .map((row) => closure(sourceId, revision, revisionsForClosure, row))
    .sort((left, right) => compareSourceRows(left.sourceRow, right.sourceRow));
  for (const item of closures) {
    if (sourceRows.has(item.sourceRow)) {
      throw new JiaowubaoStudentSourceStagingError("duplicate_source_row", "JWB source contains duplicate normalized row identities.");
    }
    sourceRows.add(item.sourceRow);
  }

  // This exact byte sequence is independently rebuilt by PostgreSQL from
  // verified closureCanonicalJson values at completion.  It binds the local
  // deterministic planner output to the completed server payload without
  // relying on PostgreSQL's different jsonb text serialization.
  const normalizedRowsSha256 = digestCanonicalJson(
    `[${closures.map((item) => item.closureCanonicalJson).join(",")}]`,
  );
  const chunks = planChunkRows(
    { sourceId, revision },
    rawCandidateSha256,
    revisions,
    closures,
    limits.maxChunkBytes,
    limits.maxChunks,
  );
  const envelope = freeze({
    format: JIAOWUBAO_STUDENT_SOURCE_STAGING_FORMAT,
    sourceId,
    revision,
    rawCandidateSha256,
    sourceRevisions: revisions,
    expectedRows: rows.length,
    expectedChunks: chunks.length,
    normalizedRowsSha256,
  });
  return freeze({ envelope, chunks: freeze(chunks), rows: freeze([...rows]) });
}

/**
 * Return an aggregate-only receipt suitable for logs or progress polling.
 * Neither the normalized rows nor a source row key is included.
 */
export function formatJiaowubaoStudentSourceStagingReceipt(
  plan: JiaowubaoStudentSourceStagingPlan,
  progress: JiaowubaoStudentSourceStagingProgress = {},
): JiaowubaoStudentSourceStagingReceipt {
  const state = progress.state ?? "planned";
  const chunksCommitted = progress.chunksCommitted ?? 0;
  const rowsCommitted = progress.rowsCommitted ?? 0;
  if (!["planned", "staging", "complete", "aborted"].includes(state)
    || !Number.isSafeInteger(chunksCommitted) || chunksCommitted < 0 || chunksCommitted > plan.envelope.expectedChunks
    || !Number.isSafeInteger(rowsCommitted) || rowsCommitted < 0 || rowsCommitted > plan.envelope.expectedRows) {
    throw new JiaowubaoStudentSourceStagingError("invalid_progress", "JWB staging progress is invalid.");
  }
  return freeze({
    format: JIAOWUBAO_STUDENT_SOURCE_STAGING_FORMAT,
    sourceId: plan.envelope.sourceId,
    revision: plan.envelope.revision,
    state,
    expectedRows: plan.envelope.expectedRows,
    expectedChunks: plan.envelope.expectedChunks,
    chunksCommitted,
    rowsCommitted,
    remainingChunks: plan.envelope.expectedChunks - chunksCommitted,
    remainingRows: plan.envelope.expectedRows - rowsCommitted,
    rawCandidateSha256: plan.envelope.rawCandidateSha256,
    normalizedRowsSha256: plan.envelope.normalizedRowsSha256,
  });
}

/** Aggregate-only progress helper for callers that do not need the full receipt. */
export function formatJiaowubaoStudentSourceStagingProgress(
  plan: JiaowubaoStudentSourceStagingPlan,
  chunksCommitted: number,
  rowsCommitted: number,
) {
  return formatJiaowubaoStudentSourceStagingReceipt(plan, { state: "staging", chunksCommitted, rowsCommitted });
}

export type JiaowubaoStudentSourceStagingRawTypes = Readonly<{
  students: readonly RawJiaowubaoStudent[];
  contracts: readonly RawJiaowubaoContract[];
  courseBalances: readonly RawJiaowubaoCourseBalance[];
  courses?: readonly RawJiaowubaoCourse[];
}>;
