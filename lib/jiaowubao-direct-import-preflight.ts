import { createHash } from "node:crypto";

import {
  JiaowubaoStaticImportError,
  staticWallClockToInstant,
} from "./jiaowubao-static-import";
import {
  JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE,
  JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE_BASIS,
  type JiaowubaoStaticParsedRecord,
  type JiaowubaoStaticParsedXlsxExports,
  type JiaowubaoStaticSchedulePayload,
  type JiaowubaoStaticSourceRef,
  type JiaowubaoStaticWorkbookKey,
} from "./jiaowubao-static-xlsx-parser";

/**
 * A local, server-only hand-off contract for the seven Jiaowubao exports.
 *
 * It is deliberately separate from the retired browser uploader.  The output
 * is evidence for a future relational staging writer: it never creates a
 * student, never makes an attachment decision, and never expands one class
 * timetable cell into individual student bookings.
 */
export const JIAOWUBAO_DIRECT_STAGING_FORMAT = "jiaowubao-direct-staging-v1" as const;
export const JIAOWUBAO_DIRECT_STAGING_TIMEZONE = JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE;
export const JIAOWUBAO_DIRECT_STAGING_TIMEZONE_BASIS = JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE_BASIS;

/** Chunks are intentionally below the former two-MiB database request ceiling. */
export const MAX_JIAOWUBAO_DIRECT_CHUNK_BYTES = 1_250_000;
export const MAX_JIAOWUBAO_DIRECT_CHUNK_RECORDS = 1_500;
export const MAX_JIAOWUBAO_DIRECT_CHUNKS = 512;
export const MAX_JIAOWUBAO_DIRECT_RECORD_BYTES = 96 * 1024;

export type JiaowubaoDirectStagingRecordKind =
  | "student_snapshot"
  | "quick_list"
  | "contract_history"
  | "hour_balance"
  | "class_membership"
  | "schedule_event"
  | "leave_makeup";

export type JiaowubaoDirectStudentRelationship = Readonly<{
  /** The later server-side writer must obtain a current Tencent-master match. */
  state: "pending_authoritative_tencent_match" | "not_applicable";
  /** No client or local preflight result can attach a JWB row to a student. */
  automaticAttachment: "forbidden";
  /** Schedule attendee names are evidence only, never one-student bookings. */
  sourceIdentity: "tabular_identity_hint" | "class_member_identity_hint" | "leave_name_hint" | "schedule_display_names" | "none";
}>;

export type JiaowubaoDirectScheduleTemporal =
  | Readonly<{
    state: "resolved";
    sourceDate: string;
    start: string;
    end: string;
    sourceTimezone: typeof JIAOWUBAO_DIRECT_STAGING_TIMEZONE;
    sourceStartInstant: string;
    sourceEndInstant: string;
  }>
  | Readonly<{
    state: "invalid";
    reason: "invalid_time_interval" | "invalid_wall_clock" | "ambiguous_wall_clock" | "non_positive_interval";
    sourceDate: string;
    sourceTimezone: typeof JIAOWUBAO_DIRECT_STAGING_TIMEZONE;
  }>;

export type JiaowubaoDirectStagingRecord = Readonly<{
  kind: JiaowubaoDirectStagingRecordKind;
  sourceKey: string;
  sourceRefs: readonly JiaowubaoStaticSourceRef[];
  /** Digest of this exact source record, including its cell/row provenance. */
  sourceDigest: string;
  studentRelationship: JiaowubaoDirectStudentRelationship;
  payload: Readonly<Record<string, unknown>>;
}>;

export type JiaowubaoDirectWorkbookManifest = Readonly<{
  kind: JiaowubaoStaticWorkbookKey;
  workbookName: string;
  workbookSha256: string;
  sheetName: string;
  sourceRecordCount: number;
}>;

export type JiaowubaoDirectRecordCounts = Readonly<Record<JiaowubaoDirectStagingRecordKind, number>>;

export type JiaowubaoDirectStagingContract = Readonly<{
  storage: "server_only_relational_staging";
  studentAuthority: "tencent_master";
  studentCreation: "forbidden";
  studentMatching: "server_side_current_tencent_only";
  scheduleProjection: "read_only_imported_schedule_event";
  scheduleBookingExpansion: "forbidden";
  sourceMutation: "forbidden";
}>;

export type JiaowubaoDirectStagingChunk = Readonly<{
  format: typeof JIAOWUBAO_DIRECT_STAGING_FORMAT;
  revision: string;
  contract: JiaowubaoDirectStagingContract;
  sourceTimezone: typeof JIAOWUBAO_DIRECT_STAGING_TIMEZONE;
  sourceTimezoneBasis: typeof JIAOWUBAO_DIRECT_STAGING_TIMEZONE_BASIS;
  workbooks: readonly JiaowubaoDirectWorkbookManifest[];
  recordCounts: JiaowubaoDirectRecordCounts;
  chunk: Readonly<{ index: number; count: number }>;
  records: readonly JiaowubaoDirectStagingRecord[];
}>;

export type JiaowubaoDirectChunkManifest = Readonly<{
  index: number;
  fileName: string;
  recordCount: number;
  bytes: number;
  sha256: string;
}>;

export type JiaowubaoDirectStagingManifest = Readonly<{
  format: typeof JIAOWUBAO_DIRECT_STAGING_FORMAT;
  revision: string;
  contract: JiaowubaoDirectStagingContract;
  sourceTimezone: typeof JIAOWUBAO_DIRECT_STAGING_TIMEZONE;
  sourceTimezoneBasis: typeof JIAOWUBAO_DIRECT_STAGING_TIMEZONE_BASIS;
  workbooks: readonly JiaowubaoDirectWorkbookManifest[];
  recordCounts: JiaowubaoDirectRecordCounts;
  chunks: readonly JiaowubaoDirectChunkManifest[];
}>;

/**
 * This report intentionally contains aggregate counts and integrity hashes
 * only.  It must remain safe to print to a terminal or attach to a ticket.
 */
export type JiaowubaoDirectReconciliationReport = Readonly<{
  format: typeof JIAOWUBAO_DIRECT_STAGING_FORMAT;
  revision: string;
  sourceTimezone: typeof JIAOWUBAO_DIRECT_STAGING_TIMEZONE;
  sourceTimezoneBasis: typeof JIAOWUBAO_DIRECT_STAGING_TIMEZONE_BASIS;
  workbooks: readonly Readonly<{
    kind: JiaowubaoStaticWorkbookKey;
    workbookSha256: string;
    sourceRecordCount: number;
  }>[];
  records: JiaowubaoDirectRecordCounts;
  studentRelationships: Readonly<{
    pendingAuthoritativeTencentMatch: number;
    notApplicable: number;
    scheduleDisplayNameEvidenceOnly: number;
  }>;
  hourBalances: Readonly<{
    rows: number;
    arithmeticallyConsistent: number;
    arithmeticMismatch: number;
    incompleteNumericFields: number;
    invalidNumericFields: number;
    /** A negative balance is preserved as source evidence, never silently discarded. */
    negativeTotalHours: number;
    negativeUsedHours: number;
    negativeRemainingHours: number;
  }>;
  schedule: Readonly<{
    sourceCells: number;
    parsedTimeIntervals: number;
    invalidTimeIntervals: number;
    resolvedWallClocks: number;
    invalidWallClocks: number;
    ambiguousWallClocks: number;
    nonPositiveIntervals: number;
    missingClass: number;
    missingCourse: number;
    missingTeacher: number;
  }>;
  chunks: Readonly<{
    count: number;
    totalRecords: number;
    totalBytes: number;
    largestBytes: number;
  }>;
}>;

export type JiaowubaoDirectPreparedStaging = Readonly<{
  revision: string;
  contract: JiaowubaoDirectStagingContract;
  workbooks: readonly JiaowubaoDirectWorkbookManifest[];
  recordCounts: JiaowubaoDirectRecordCounts;
  chunks: readonly JiaowubaoDirectStagingChunk[];
  manifest: JiaowubaoDirectStagingManifest;
  reconciliation: JiaowubaoDirectReconciliationReport;
}>;

export class JiaowubaoDirectPreflightError extends Error {
  constructor(
    readonly code:
      | "invalid_source"
      | "duplicate_source_key"
      | "record_too_large"
      | "chunk_too_large"
      | "chunk_limit_exceeded"
      | "unsupported_value",
    message: string,
  ) {
    super(message);
    this.name = "JiaowubaoDirectPreflightError";
  }
}

interface JsonObject {
  readonly [key: string]: JsonValue;
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

type MutableScheduleSummary = {
  sourceCells: number;
  parsedTimeIntervals: number;
  invalidTimeIntervals: number;
  resolvedWallClocks: number;
  invalidWallClocks: number;
  ambiguousWallClocks: number;
  nonPositiveIntervals: number;
  missingClass: number;
  missingCourse: number;
  missingTeacher: number;
};

type MutableHourSummary = {
  rows: number;
  arithmeticallyConsistent: number;
  arithmeticMismatch: number;
  incompleteNumericFields: number;
  invalidNumericFields: number;
  negativeTotalHours: number;
  negativeUsedHours: number;
  negativeRemainingHours: number;
};

const RECORD_KIND_ORDER: readonly JiaowubaoDirectStagingRecordKind[] = [
  "student_snapshot",
  "quick_list",
  "contract_history",
  "hour_balance",
  "class_membership",
  "schedule_event",
  "leave_makeup",
] as const;

const SOURCE_CONTRACT: JiaowubaoDirectStagingContract = Object.freeze({
  storage: "server_only_relational_staging",
  studentAuthority: "tencent_master",
  studentCreation: "forbidden",
  studentMatching: "server_side_current_tencent_only",
  scheduleProjection: "read_only_imported_schedule_event",
  scheduleBookingExpansion: "forbidden",
  sourceMutation: "forbidden",
});

function freeze<T>(value: T) {
  return Object.freeze(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** A stable JSON encoding used for both artifact files and all integrity hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JiaowubaoDirectPreflightError("unsupported_value", "Preflight data contains a non-finite number.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return freeze(value.map((item) => canonicalize(item)));
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
      // This is JSON's normal object behaviour. Parser records use undefined
      // only for optional source fields, never for a source-cell value.
      if (item === undefined) continue;
      result[key] = canonicalize(item);
    }
    return freeze(result);
  }
  throw new JiaowubaoDirectPreflightError("unsupported_value", "Preflight data contains an unsupported value.");
}

function sourceIdentity(
  sourceIdentity: JiaowubaoDirectStudentRelationship["sourceIdentity"],
): JiaowubaoDirectStudentRelationship {
  return freeze({
    state: sourceIdentity === "none" ? "not_applicable" : "pending_authoritative_tencent_match",
    automaticAttachment: "forbidden",
    sourceIdentity,
  });
}

function sourceRecordPayload(
  entity: string,
  source: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return freeze({
    source,
    staging: freeze({
      entity,
      writeMode: "server_only_relational_staging",
      studentCreation: "forbidden",
      ...extra,
    }),
  }) as Readonly<Record<string, unknown>>;
}

function createRecord(
  kind: JiaowubaoDirectStagingRecordKind,
  record: JiaowubaoStaticParsedRecord<unknown>,
  studentRelationship: JiaowubaoDirectStudentRelationship,
  payload: Readonly<Record<string, unknown>>,
): JiaowubaoDirectStagingRecord {
  if (!record.sourceKey || !Array.isArray(record.sourceRefs) || !payload) {
    throw new JiaowubaoDirectPreflightError("invalid_source", "A parsed Jiaowubao source record is malformed.");
  }
  const base = freeze({
    kind,
    sourceKey: record.sourceKey,
    sourceRefs: freeze([...record.sourceRefs]),
    studentRelationship,
    payload,
  });
  const sourceDigest = sha256(canonicalJson(base));
  return freeze({ ...base, sourceDigest });
}

function zeroRecordCounts(): Record<JiaowubaoDirectStagingRecordKind, number> {
  return {
    student_snapshot: 0,
    quick_list: 0,
    contract_history: 0,
    hour_balance: 0,
    class_membership: 0,
    schedule_event: 0,
    leave_makeup: 0,
  };
}

function zeroScheduleSummary(): MutableScheduleSummary {
  return {
    sourceCells: 0,
    parsedTimeIntervals: 0,
    invalidTimeIntervals: 0,
    resolvedWallClocks: 0,
    invalidWallClocks: 0,
    ambiguousWallClocks: 0,
    nonPositiveIntervals: 0,
    missingClass: 0,
    missingCourse: 0,
    missingTeacher: 0,
  };
}

function zeroHourSummary(): MutableHourSummary {
  return {
    rows: 0,
    arithmeticallyConsistent: 0,
    arithmeticMismatch: 0,
    incompleteNumericFields: 0,
    invalidNumericFields: 0,
    negativeTotalHours: 0,
    negativeUsedHours: 0,
    negativeRemainingHours: 0,
  };
}

function directManifests(parsed: JiaowubaoStaticParsedXlsxExports): readonly JiaowubaoDirectWorkbookManifest[] {
  const entries: JiaowubaoDirectWorkbookManifest[] = [
    { kind: "quick_list", workbookName: parsed.quickList.source.workbookName, workbookSha256: parsed.quickList.source.sha256, sheetName: parsed.quickList.source.sheetName, sourceRecordCount: parsed.quickList.records.length },
    { kind: "students", workbookName: parsed.students.source.workbookName, workbookSha256: parsed.students.source.sha256, sheetName: parsed.students.source.sheetName, sourceRecordCount: parsed.students.records.length },
    { kind: "contracts", workbookName: parsed.contracts.source.workbookName, workbookSha256: parsed.contracts.source.sha256, sheetName: parsed.contracts.source.sheetName, sourceRecordCount: parsed.contracts.records.length },
    { kind: "hours", workbookName: parsed.hours.source.workbookName, workbookSha256: parsed.hours.source.sha256, sheetName: parsed.hours.source.sheetName, sourceRecordCount: parsed.hours.records.length },
    { kind: "class_members", workbookName: parsed.classMemberships.source.workbookName, workbookSha256: parsed.classMemberships.source.sha256, sheetName: parsed.classMemberships.source.sheetName, sourceRecordCount: parsed.classMemberships.records.length },
    { kind: "schedule", workbookName: parsed.schedule.source.workbookName, workbookSha256: parsed.schedule.source.sha256, sheetName: parsed.schedule.source.sheetName, sourceRecordCount: parsed.schedule.records.length },
    { kind: "leave_makeups", workbookName: parsed.leaveMakeups.source.workbookName, workbookSha256: parsed.leaveMakeups.source.sha256, sheetName: parsed.leaveMakeups.source.sheetName, sourceRecordCount: parsed.leaveMakeups.records.length },
  ];
  return freeze(entries.map((entry) => freeze(entry)));
}

function sourceScalarRecord(record: JiaowubaoStaticParsedRecord<unknown>) {
  return record.payload as Readonly<Record<string, unknown>>;
}

function recordHasText(value: unknown) {
  return typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
}

function scheduleTemporal(
  payload: JiaowubaoStaticSchedulePayload,
  summary: MutableScheduleSummary,
): JiaowubaoDirectScheduleTemporal {
  summary.sourceCells += 1;
  if (!payload.className) summary.missingClass += 1;
  if (!payload.course) summary.missingCourse += 1;
  if (!payload.teacher) summary.missingTeacher += 1;
  if (payload.parseStatus.kind !== "parsed") {
    summary.invalidTimeIntervals += 1;
    const result: JiaowubaoDirectScheduleTemporal = freeze({
      state: "invalid",
      reason: "invalid_time_interval" as const,
      sourceDate: payload.sourceDate,
      sourceTimezone: JIAOWUBAO_DIRECT_STAGING_TIMEZONE,
    });
    return result;
  }

  summary.parsedTimeIntervals += 1;
  try {
    const sourceStartInstant = staticWallClockToInstant(
      payload.sourceDate,
      payload.parseStatus.start,
      JIAOWUBAO_DIRECT_STAGING_TIMEZONE,
    );
    const sourceEndInstant = staticWallClockToInstant(
      payload.sourceDate,
      payload.parseStatus.end,
      JIAOWUBAO_DIRECT_STAGING_TIMEZONE,
    );
    if (sourceEndInstant <= sourceStartInstant) {
      summary.nonPositiveIntervals += 1;
      const result: JiaowubaoDirectScheduleTemporal = freeze({
        state: "invalid",
        reason: "non_positive_interval" as const,
        sourceDate: payload.sourceDate,
        sourceTimezone: JIAOWUBAO_DIRECT_STAGING_TIMEZONE,
      });
      return result;
    }
    summary.resolvedWallClocks += 1;
    return freeze({
      state: "resolved",
      sourceDate: payload.sourceDate,
      start: payload.parseStatus.start,
      end: payload.parseStatus.end,
      sourceTimezone: JIAOWUBAO_DIRECT_STAGING_TIMEZONE,
      sourceStartInstant,
      sourceEndInstant,
    });
  } catch (error) {
    const reason: "invalid_wall_clock" | "ambiguous_wall_clock" = error instanceof JiaowubaoStaticImportError && error.code === "ambiguous_wall_clock"
      ? "ambiguous_wall_clock"
      : "invalid_wall_clock";
    if (reason === "ambiguous_wall_clock") summary.ambiguousWallClocks += 1;
    else summary.invalidWallClocks += 1;
    const result: JiaowubaoDirectScheduleTemporal = freeze({
      state: "invalid",
      reason,
      sourceDate: payload.sourceDate,
      sourceTimezone: JIAOWUBAO_DIRECT_STAGING_TIMEZONE,
    });
    return result;
  }
}

function numericMicrohours(value: unknown): "missing" | "invalid" | number {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return "missing";
  const raw = typeof value === "string" ? value.replace(/,/gu, "").trim() : String(value);
  const parsed = Number(raw);
  const microhours = Math.round(parsed * 1_000_000);
  if (!Number.isFinite(parsed)
    || !Number.isSafeInteger(microhours)
    || Math.abs(parsed - microhours / 1_000_000) > 1e-9) {
    return "invalid";
  }
  return microhours;
}

function reconcileHourRecord(record: JiaowubaoStaticParsedRecord<unknown>, summary: MutableHourSummary) {
  summary.rows += 1;
  const payload = record.payload as Readonly<{ raw?: Readonly<{ fields?: Readonly<Record<string, unknown>> }> }>;
  const fields = payload.raw?.fields ?? {};
  const total = numericMicrohours(fields.课时数);
  const used = numericMicrohours(fields.已消课时);
  const remaining = numericMicrohours(fields.剩余课时);
  if (total === "invalid" || used === "invalid" || remaining === "invalid") {
    summary.invalidNumericFields += 1;
    return;
  }
  if (total === "missing" || used === "missing" || remaining === "missing") {
    summary.incompleteNumericFields += 1;
    return;
  }
  if (total < 0) summary.negativeTotalHours += 1;
  if (used < 0) summary.negativeUsedHours += 1;
  if (remaining < 0) summary.negativeRemainingHours += 1;
  if (total === used + remaining) summary.arithmeticallyConsistent += 1;
  else summary.arithmeticMismatch += 1;
}

function collectRecords(parsed: JiaowubaoStaticParsedXlsxExports) {
  const scheduleSummary = zeroScheduleSummary();
  const hourSummary = zeroHourSummary();
  const records: JiaowubaoDirectStagingRecord[] = [];

  for (const record of parsed.students.records) {
    records.push(createRecord(
      "student_snapshot",
      record,
      sourceIdentity("tabular_identity_hint"),
      sourceRecordPayload("imported_student_snapshot", sourceScalarRecord(record)),
    ));
  }
  for (const record of parsed.quickList.records) {
    records.push(createRecord(
      "quick_list",
      record,
      sourceIdentity("tabular_identity_hint"),
      sourceRecordPayload("imported_quick_list_fact", sourceScalarRecord(record)),
    ));
  }
  for (const record of parsed.contracts.records) {
    records.push(createRecord(
      "contract_history",
      record,
      sourceIdentity("tabular_identity_hint"),
      sourceRecordPayload("imported_contract_history", sourceScalarRecord(record)),
    ));
  }
  for (const record of parsed.hours.records) {
    reconcileHourRecord(record, hourSummary);
    records.push(createRecord(
      "hour_balance",
      record,
      sourceIdentity("tabular_identity_hint"),
      sourceRecordPayload("imported_hour_balance", sourceScalarRecord(record)),
    ));
  }
  for (const record of parsed.classMemberships.records) {
    records.push(createRecord(
      "class_membership",
      record,
      sourceIdentity("class_member_identity_hint"),
      sourceRecordPayload("imported_class_membership", sourceScalarRecord(record)),
    ));
  }
  for (const record of parsed.schedule.records) {
    const payload = record.payload;
    const temporal = scheduleTemporal(payload, scheduleSummary);
    records.push(createRecord(
      "schedule_event",
      record,
      sourceIdentity("schedule_display_names"),
      sourceRecordPayload("imported_schedule_event", payload as unknown as Readonly<Record<string, unknown>>, freeze({
        temporal,
        eventState: "read_only_source_evidence",
        teacherAvailabilityProjection: "server_resolution_required",
        studentBookingExpansion: "forbidden",
      })),
    ));
  }
  for (const record of parsed.leaveMakeups.records) {
    const source = sourceScalarRecord(record);
    const identity = (source.identity ?? {}) as Readonly<Record<string, unknown>>;
    records.push(createRecord(
      "leave_makeup",
      record,
      sourceIdentity(recordHasText(identity.name) ? "leave_name_hint" : "none"),
      sourceRecordPayload("imported_leave_makeup", source),
    ));
  }

  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.sourceKey)) {
      throw new JiaowubaoDirectPreflightError(
        "duplicate_source_key",
        `The parsed Jiaowubao source emitted a duplicate source key (${record.sourceKey}).`,
      );
    }
    seen.add(record.sourceKey);
  }
  const ordering = new Map(RECORD_KIND_ORDER.map((kind, index) => [kind, index]));
  records.sort((left, right) => {
    const kindDelta = (ordering.get(left.kind) ?? 0) - (ordering.get(right.kind) ?? 0);
    return kindDelta || left.sourceKey.localeCompare(right.sourceKey);
  });
  return freeze({ records: freeze(records), scheduleSummary: freeze(scheduleSummary), hourSummary: freeze(hourSummary) });
}

function recordCounts(records: readonly JiaowubaoDirectStagingRecord[]): JiaowubaoDirectRecordCounts {
  const counts = zeroRecordCounts();
  for (const record of records) counts[record.kind] += 1;
  return freeze(counts);
}

function revisionFor(
  workbooks: readonly JiaowubaoDirectWorkbookManifest[],
  records: readonly JiaowubaoDirectStagingRecord[],
) {
  return `sha256:${sha256(canonicalJson({
    format: JIAOWUBAO_DIRECT_STAGING_FORMAT,
    sourceTimezone: JIAOWUBAO_DIRECT_STAGING_TIMEZONE,
    workbooks,
    records: records.map((record) => freeze({
      kind: record.kind,
      sourceKey: record.sourceKey,
      sourceDigest: record.sourceDigest,
    })),
  }))}`;
}

function chunkEnvelope(
  revision: string,
  workbooks: readonly JiaowubaoDirectWorkbookManifest[],
  counts: JiaowubaoDirectRecordCounts,
  records: readonly JiaowubaoDirectStagingRecord[],
  index: number,
  count: number,
): JiaowubaoDirectStagingChunk {
  return freeze({
    format: JIAOWUBAO_DIRECT_STAGING_FORMAT,
    revision,
    contract: SOURCE_CONTRACT,
    sourceTimezone: JIAOWUBAO_DIRECT_STAGING_TIMEZONE,
    sourceTimezoneBasis: JIAOWUBAO_DIRECT_STAGING_TIMEZONE_BASIS,
    workbooks,
    recordCounts: counts,
    chunk: freeze({ index, count }),
    records,
  });
}

function chunkRecords(
  revision: string,
  workbooks: readonly JiaowubaoDirectWorkbookManifest[],
  counts: JiaowubaoDirectRecordCounts,
  records: readonly JiaowubaoDirectStagingRecord[],
): readonly JiaowubaoDirectStagingChunk[] {
  const emptyEnvelopeBytes = Buffer.byteLength(canonicalJson(chunkEnvelope(
    revision,
    workbooks,
    counts,
    [],
    MAX_JIAOWUBAO_DIRECT_CHUNKS - 1,
    MAX_JIAOWUBAO_DIRECT_CHUNKS,
  )), "utf8");
  const buckets: JiaowubaoDirectStagingRecord[][] = [];
  let current: JiaowubaoDirectStagingRecord[] = [];
  let currentBytes = emptyEnvelopeBytes;

  const finalize = () => {
    if (!current.length) return;
    buckets.push(current);
    current = [];
    currentBytes = emptyEnvelopeBytes;
  };

  for (const record of records) {
    const recordBytes = Buffer.byteLength(canonicalJson(record), "utf8");
    if (recordBytes > MAX_JIAOWUBAO_DIRECT_RECORD_BYTES) {
      throw new JiaowubaoDirectPreflightError(
        "record_too_large",
        `Jiaowubao source record ${record.sourceKey} is too large for the direct staging contract.`,
      );
    }
    const candidateBytes = currentBytes + recordBytes + (current.length ? 1 : 0);
    if (current.length && (current.length >= MAX_JIAOWUBAO_DIRECT_CHUNK_RECORDS || candidateBytes > MAX_JIAOWUBAO_DIRECT_CHUNK_BYTES)) {
      finalize();
    }
    const firstRecordBytes = currentBytes + recordBytes;
    if (firstRecordBytes > MAX_JIAOWUBAO_DIRECT_CHUNK_BYTES) {
      throw new JiaowubaoDirectPreflightError(
        "chunk_too_large",
        `Jiaowubao source record ${record.sourceKey} cannot fit inside a direct staging chunk.`,
      );
    }
    current.push(record);
    currentBytes += recordBytes + (current.length > 1 ? 1 : 0);
  }
  finalize();
  if (!buckets.length || buckets.length > MAX_JIAOWUBAO_DIRECT_CHUNKS) {
    throw new JiaowubaoDirectPreflightError("chunk_limit_exceeded", "The Jiaowubao source needs an unsupported number of staging chunks.");
  }
  const chunks = buckets.map((recordsForChunk, index) => chunkEnvelope(
    revision,
    workbooks,
    counts,
    freeze(recordsForChunk),
    index,
    buckets.length,
  ));
  for (const chunk of chunks) {
    if (Buffer.byteLength(canonicalJson(chunk), "utf8") > MAX_JIAOWUBAO_DIRECT_CHUNK_BYTES) {
      throw new JiaowubaoDirectPreflightError("chunk_too_large", "A direct staging chunk exceeds its maximum byte size.");
    }
  }
  return freeze(chunks);
}

function relationshipSummary(records: readonly JiaowubaoDirectStagingRecord[]) {
  let pendingAuthoritativeTencentMatch = 0;
  let notApplicable = 0;
  let scheduleDisplayNameEvidenceOnly = 0;
  for (const record of records) {
    if (record.studentRelationship.state === "pending_authoritative_tencent_match") pendingAuthoritativeTencentMatch += 1;
    else notApplicable += 1;
    if (record.studentRelationship.sourceIdentity === "schedule_display_names") scheduleDisplayNameEvidenceOnly += 1;
  }
  return freeze({ pendingAuthoritativeTencentMatch, notApplicable, scheduleDisplayNameEvidenceOnly });
}

/**
 * Prepare local, deterministic records for a future server-only relational
 * staging writer.  It does not inspect Tencent rows and therefore cannot
 * attach to, create, update, or delete a student.
 */
export function prepareJiaowubaoDirectStaging(
  parsed: JiaowubaoStaticParsedXlsxExports,
): JiaowubaoDirectPreparedStaging {
  if (parsed.format !== "jiaowubao-static-excel-v1") {
    throw new JiaowubaoDirectPreflightError("invalid_source", "Unsupported Jiaowubao XLSX parser format.");
  }
  const workbooks = directManifests(parsed);
  const collected = collectRecords(parsed);
  const counts = recordCounts(collected.records);
  const revision = revisionFor(workbooks, collected.records);
  const chunks = chunkRecords(revision, workbooks, counts, collected.records);
  const chunkManifests = chunks.map((chunk) => {
    const bytes = Buffer.byteLength(canonicalJson(chunk), "utf8");
    return freeze({
      index: chunk.chunk.index,
      fileName: `chunks/${String(chunk.chunk.index + 1).padStart(4, "0")}.json`,
      recordCount: chunk.records.length,
      bytes,
      sha256: sha256(canonicalJson(chunk)),
    });
  });
  const manifest = freeze({
    format: JIAOWUBAO_DIRECT_STAGING_FORMAT,
    revision,
    contract: SOURCE_CONTRACT,
    sourceTimezone: JIAOWUBAO_DIRECT_STAGING_TIMEZONE,
    sourceTimezoneBasis: JIAOWUBAO_DIRECT_STAGING_TIMEZONE_BASIS,
    workbooks,
    recordCounts: counts,
    chunks: freeze(chunkManifests),
  });
  const chunkBytes = chunkManifests.map((chunk) => chunk.bytes);
  const reconciliation = freeze({
    format: JIAOWUBAO_DIRECT_STAGING_FORMAT,
    revision,
    sourceTimezone: JIAOWUBAO_DIRECT_STAGING_TIMEZONE,
    sourceTimezoneBasis: JIAOWUBAO_DIRECT_STAGING_TIMEZONE_BASIS,
    // File names are intentionally omitted: this remains an aggregate,
    // non-PII report suitable for logs and hand-off notes.
    workbooks: freeze(workbooks.map((workbook) => freeze({
      kind: workbook.kind,
      workbookSha256: workbook.workbookSha256,
      sourceRecordCount: workbook.sourceRecordCount,
    }))),
    records: counts,
    studentRelationships: relationshipSummary(collected.records),
    hourBalances: collected.hourSummary,
    schedule: collected.scheduleSummary,
    chunks: freeze({
      count: chunks.length,
      totalRecords: collected.records.length,
      totalBytes: chunkBytes.reduce((total, bytes) => total + bytes, 0),
      largestBytes: Math.max(...chunkBytes),
    }),
  });
  return freeze({
    revision,
    contract: SOURCE_CONTRACT,
    workbooks,
    recordCounts: counts,
    chunks,
    manifest,
    reconciliation,
  });
}
