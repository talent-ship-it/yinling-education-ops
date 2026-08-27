import { createHash } from "node:crypto";

import {
  buildJiaowubaoStaticExportPlan,
  jiaowubaoStaticIdentityKeyFor,
  JIAOWUBAO_STATIC_SOURCE_FORMAT,
  JIAOWUBAO_STATIC_SOURCE_TIMEZONE,
  matchJiaowubaoStaticFactsToMaster,
  staticWallClockToInstant,
  type JiaowubaoStaticCellRow,
  type JiaowubaoStaticStudentFact,
} from "@/lib/jiaowubao-static-import";
import {
  JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE_BASIS,
  type JiaowubaoStaticParsedHeaderWorkbook,
  type JiaowubaoStaticParsedRecord,
  type JiaowubaoStaticParsedXlsxExports,
  type JiaowubaoStaticSourceRef,
  type JiaowubaoStaticTabularPayload,
  type JiaowubaoStaticWorkbookKey,
} from "@/lib/jiaowubao-static-xlsx-parser";
import {
  normalizeStudentImportName,
  type MasterStudentImportRow,
  type StudentImportSourceKey,
} from "@/lib/student-import";

/**
 * Server-only preparation of the seven offline Jiaowubao workbooks.  It
 * deliberately produces an evidence batch, never a students replacement,
 * lesson package, normal booking, or Tencent source mutation.
 */

export const JIAOWUBAO_STATIC_EXCEL_SOURCE_ID = "jiaowubao-static-excel" as const;
/**
 * PostgreSQL measures the incoming JSONB text after canonicalising it, which
 * adds whitespace compared with JSON.stringify.  Leave a meaningful margin
 * below the database's hard 2 MiB request ceiling so a valid client chunk
 * cannot fail only because the JSONB representation is slightly larger.
 */
export const MAX_JIAOWUBAO_STATIC_CHUNK_BYTES = 1_500_000;
export const MAX_JIAOWUBAO_STATIC_CHUNK_RECORDS = 2_000;
export const MAX_JIAOWUBAO_STATIC_CHUNKS = 512;
export const MAX_JIAOWUBAO_STATIC_RECORD_PAYLOAD_BYTES = 32 * 1024;

const EXCLUDED_MASTER_STATUS = "不活跃 + 无课时";
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/gu;

export type JiaowubaoStaticQuarantineReason =
  | "unmatched_jwb_identity"
  | "ambiguous_jwb_identity"
  | "review_required_annotation"
  | "excluded_master_status"
  | "empty_name"
  | "missing_phone"
  | "duplicate_identity"
  | "class_not_resolved"
  | "unassigned_teacher"
  | "unmapped_course"
  | "invalid_source_value"
  | "non_operational_static_schedule";

export type JiaowubaoStaticAttachment =
  | Readonly<{
    state: "attached";
    masterSourceRow: string;
    /** Raw JWB display name proven to equal the Tencent master name. */
    evidenceName: string;
    matchMode: "exact_name";
  }>
  | Readonly<{
    state: "quarantined";
    reason: JiaowubaoStaticQuarantineReason;
  }>;

export type JiaowubaoStaticStoredRecord = Readonly<{
  sourceKey: string;
  sourceRefs: readonly JiaowubaoStaticSourceRef[];
  attachments: readonly JiaowubaoStaticAttachment[];
  payload: Readonly<Record<string, unknown>>;
}>;

export type JiaowubaoStaticRecordSets = Readonly<{
  facts: readonly JiaowubaoStaticStoredRecord[];
  contracts: readonly JiaowubaoStaticStoredRecord[];
  hours: readonly JiaowubaoStaticStoredRecord[];
  classMembers: readonly JiaowubaoStaticStoredRecord[];
  schedule: readonly JiaowubaoStaticStoredRecord[];
  leaveMakeups: readonly JiaowubaoStaticStoredRecord[];
}>;

export type JiaowubaoStaticWorkbookManifest = Readonly<{
  kind: JiaowubaoStaticWorkbookKey;
  workbookName: string;
  workbookSha256: string;
  rowCount: number;
}>;

export type JiaowubaoStaticRecordCounts = Readonly<{
  facts: number;
  contracts: number;
  hours: number;
  classMembers: number;
  schedule: number;
  leaveMakeups: number;
}>;

/**
 * The exact Tencent snapshot used to prepare an offline Excel batch.  It is
 * included in every chunk so the ledger can reject a stale source read before
 * storing even the first attachment.
 */
export type JiaowubaoStaticMasterSource = Readonly<{
  sourceId: string;
  revision: string;
  rowsSha256: string;
  rows: readonly MasterStudentImportRow[];
}>;

export type JiaowubaoStaticExcelChunk = Readonly<{
  format: typeof JIAOWUBAO_STATIC_SOURCE_FORMAT;
  sourceTimezone: typeof JIAOWUBAO_STATIC_SOURCE_TIMEZONE;
  sourceTimezoneBasis: string;
  masterSource: Readonly<{
    sourceId: string;
    revision: string;
    rowsSha256: string;
  }>;
  workbooks: readonly JiaowubaoStaticWorkbookManifest[];
  recordCounts: JiaowubaoStaticRecordCounts;
  chunk: Readonly<{ index: number; count: number }>;
  facts: readonly JiaowubaoStaticStoredRecord[];
  contracts: readonly JiaowubaoStaticStoredRecord[];
  hours: readonly JiaowubaoStaticStoredRecord[];
  classMembers: readonly JiaowubaoStaticStoredRecord[];
  schedule: readonly JiaowubaoStaticStoredRecord[];
  leaveMakeups: readonly JiaowubaoStaticStoredRecord[];
}>;

export type JiaowubaoStaticExcelPreparedImport = Readonly<{
  sourceId: typeof JIAOWUBAO_STATIC_EXCEL_SOURCE_ID;
  revision: string;
  masterSource: JiaowubaoStaticMasterSource;
  workbooks: readonly JiaowubaoStaticWorkbookManifest[];
  recordCounts: JiaowubaoStaticRecordCounts;
  chunks: readonly JiaowubaoStaticExcelChunk[];
  summary: Readonly<{
    exactAttachments: number;
    reviewRequired: number;
    quarantinedRecords: number;
    invalidScheduleTimes: number;
    sourceTimezone: typeof JIAOWUBAO_STATIC_SOURCE_TIMEZONE;
  }>;
}>;

export class JiaowubaoStaticImportServiceError extends Error {
  constructor(
    readonly code:
      | "invalid_static_export"
      | "static_record_payload_too_large"
      | "static_chunk_too_large"
      | "static_chunk_limit_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "JiaowubaoStaticImportServiceError";
  }
}

type RecordSetKey = keyof JiaowubaoStaticRecordSets;

type AttachmentByIdentity = Readonly<{
  attachment: readonly JiaowubaoStaticAttachment[];
}>;

const RECORD_SET_KEYS: readonly RecordSetKey[] = [
  "facts",
  "contracts",
  "hours",
  "classMembers",
  "schedule",
  "leaveMakeups",
] as const;

function cleanText(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value).normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim()
    : "";
}

function classKey(value: unknown) {
  return cleanText(value);
}

function sourceRowText(value: StudentImportSourceKey) {
  return String(value).trim();
}

function emptyRecordSets(): { [Key in RecordSetKey]: JiaowubaoStaticStoredRecord[] } {
  return {
    facts: [],
    contracts: [],
    hours: [],
    classMembers: [],
    schedule: [],
    leaveMakeups: [],
  };
}

function recordCounts(recordSets: JiaowubaoStaticRecordSets): JiaowubaoStaticRecordCounts {
  return {
    facts: recordSets.facts.length,
    contracts: recordSets.contracts.length,
    hours: recordSets.hours.length,
    classMembers: recordSets.classMembers.length,
    schedule: recordSets.schedule.length,
    leaveMakeups: recordSets.leaveMakeups.length,
  };
}

function attachmentKey(attachment: JiaowubaoStaticAttachment) {
  return attachment.state === "attached"
    ? `attached:${attachment.masterSourceRow}`
    : `quarantined:${attachment.reason}`;
}

function uniqueAttachments(attachments: readonly JiaowubaoStaticAttachment[]) {
  const result = new Map<string, JiaowubaoStaticAttachment>();
  for (const attachment of attachments) result.set(attachmentKey(attachment), attachment);
  const sorted = [...result.values()].sort((left, right) => {
    if (left.state !== right.state) return left.state === "attached" ? -1 : 1;
    return attachmentKey(left).localeCompare(attachmentKey(right));
  });
  return Object.freeze(sorted);
}

function quarantined(reason: JiaowubaoStaticQuarantineReason): JiaowubaoStaticAttachment {
  return Object.freeze({ state: "quarantined", reason });
}

function rawRows(workbook: JiaowubaoStaticParsedHeaderWorkbook) {
  return workbook.records.map((record) => record.payload.raw.fields as JiaowubaoStaticCellRow);
}

function workbookForFacts(
  workbook: JiaowubaoStaticParsedHeaderWorkbook,
) {
  return {
    workbookName: workbook.source.workbookName,
    workbookSha256: workbook.source.sha256,
    rows: rawRows(workbook),
  } as const;
}

function manifestFor(parsed: JiaowubaoStaticParsedXlsxExports): readonly JiaowubaoStaticWorkbookManifest[] {
  const entries: JiaowubaoStaticWorkbookManifest[] = [
    { kind: "quick_list", workbookName: parsed.quickList.source.workbookName, workbookSha256: parsed.quickList.source.sha256, rowCount: parsed.quickList.records.length },
    { kind: "students", workbookName: parsed.students.source.workbookName, workbookSha256: parsed.students.source.sha256, rowCount: parsed.students.records.length },
    { kind: "contracts", workbookName: parsed.contracts.source.workbookName, workbookSha256: parsed.contracts.source.sha256, rowCount: parsed.contracts.records.length },
    { kind: "hours", workbookName: parsed.hours.source.workbookName, workbookSha256: parsed.hours.source.sha256, rowCount: parsed.hours.records.length },
    { kind: "class_members", workbookName: parsed.classMemberships.source.workbookName, workbookSha256: parsed.classMemberships.source.sha256, rowCount: parsed.classMemberships.records.length },
    { kind: "schedule", workbookName: parsed.schedule.source.workbookName, workbookSha256: parsed.schedule.source.sha256, rowCount: parsed.schedule.records.length },
    { kind: "leave_makeups", workbookName: parsed.leaveMakeups.source.workbookName, workbookSha256: parsed.leaveMakeups.source.sha256, rowCount: parsed.leaveMakeups.records.length },
  ];
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function revisionFor(
  manifest: readonly JiaowubaoStaticWorkbookManifest[],
  masterSource: JiaowubaoStaticMasterSource,
) {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      workbooks: manifest.map((entry) => [entry.kind, entry.workbookName, entry.workbookSha256, entry.rowCount]),
      masterSource: [masterSource.sourceId, masterSource.revision, masterSource.rowsSha256],
    }))
    .digest("hex");
  return `sha256:${digest}`;
}

function issueReasonForRawIdentity(row: JiaowubaoStaticCellRow): JiaowubaoStaticQuarantineReason {
  if (!cleanText(row.姓名)) return "empty_name";
  if (!cleanText(row.手机号)) return "missing_phone";
  return "unmatched_jwb_identity";
}

function attachmentResolver(
  masterRows: readonly MasterStudentImportRow[],
  facts: readonly JiaowubaoStaticStudentFact[],
  issues: readonly Readonly<{ identityKey: string; reason: string }>[],
) {
  const matchPlan = matchJiaowubaoStaticFactsToMaster(masterRows, facts);
  const factsBySource = new Map(facts.map((fact) => [fact.identity.sourceRow, fact]));
  const result = new Map<string, AttachmentByIdentity>();
  const issueByIdentity = new Map<string, JiaowubaoStaticQuarantineReason>();
  for (const issue of issues) {
    const reason: JiaowubaoStaticQuarantineReason = issue.reason === "conflicting_external_student_number"
      ? "duplicate_identity"
      : issue.reason === "empty_name" ? "empty_name"
        : issue.reason === "missing_phone" ? "missing_phone"
          : "unmatched_jwb_identity";
    issueByIdentity.set(issue.identityKey, reason);
  }
  for (const match of matchPlan.matches) {
    const fact = factsBySource.get(match.jwbSourceRow);
    if (!fact) continue;
    result.set(fact.identity.identityKey, {
      attachment: Object.freeze([Object.freeze({
        state: "attached",
        masterSourceRow: sourceRowText(match.masterSourceRow),
        evidenceName: fact.identity.name,
        matchMode: "exact_name",
      })]),
    });
  }
  for (const match of matchPlan.reviewCandidates) {
    const fact = factsBySource.get(match.jwbSourceRow);
    if (!fact) continue;
    result.set(fact.identity.identityKey, { attachment: Object.freeze([quarantined("review_required_annotation")]) });
  }
  for (const sourceRow of matchPlan.ambiguousJwbSourceRows) {
    const fact = factsBySource.get(sourceRow);
    if (!fact) continue;
    result.set(fact.identity.identityKey, { attachment: Object.freeze([quarantined("ambiguous_jwb_identity")]) });
  }

  // A JWB row that has only one same-name Tencent row, but that row is in the
  // explicitly rejected source category, gets a clear quarantine reason.  It
  // is never attached to the excluded source row.
  const activeNames = new Set(masterRows
    .filter((row) => cleanText(row.status) !== EXCLUDED_MASTER_STATUS)
    .map((row) => normalizeStudentImportName(row.name))
    .filter(Boolean));
  const excludedNameCounts = new Map<string, number>();
  for (const row of masterRows) {
    if (cleanText(row.status) !== EXCLUDED_MASTER_STATUS) continue;
    const name = normalizeStudentImportName(row.name);
    if (name) excludedNameCounts.set(name, (excludedNameCounts.get(name) ?? 0) + 1);
  }

  for (const fact of facts) {
    if (result.has(fact.identity.identityKey)) continue;
    const issue = issueByIdentity.get(fact.identity.identityKey);
    if (issue) {
      result.set(fact.identity.identityKey, { attachment: Object.freeze([quarantined(issue)]) });
      continue;
    }
    const excludedCount = excludedNameCounts.get(fact.identity.normalizedName) ?? 0;
    if (excludedCount === 1 && !activeNames.has(fact.identity.normalizedName)) {
      result.set(fact.identity.identityKey, { attachment: Object.freeze([quarantined("excluded_master_status")]) });
    } else {
      result.set(fact.identity.identityKey, { attachment: Object.freeze([quarantined("unmatched_jwb_identity")]) });
    }
  }

  const factsByName = new Map<string, JiaowubaoStaticStudentFact[]>();
  for (const fact of facts) {
    factsByName.set(fact.identity.normalizedName, [...(factsByName.get(fact.identity.normalizedName) ?? []), fact]);
  }

  const fromRow = (row: JiaowubaoStaticCellRow): readonly JiaowubaoStaticAttachment[] => {
    const identityKey = jiaowubaoStaticIdentityKeyFor(row);
    if (!identityKey) return Object.freeze([quarantined(issueReasonForRawIdentity(row))]);
    const issue = issueByIdentity.get(identityKey);
    if (issue) return Object.freeze([quarantined(issue)]);
    return result.get(identityKey)?.attachment ?? Object.freeze([quarantined("unmatched_jwb_identity")]);
  };

  const fromName = (name: string | undefined): readonly JiaowubaoStaticAttachment[] => {
    const normalized = normalizeStudentImportName(cleanText(name));
    if (!normalized) return Object.freeze([quarantined("empty_name")]);
    const candidates = factsByName.get(normalized) ?? [];
    if (candidates.length !== 1) {
      return Object.freeze([quarantined(candidates.length > 1 ? "ambiguous_jwb_identity" : "unmatched_jwb_identity")]);
    }
    return result.get(candidates[0].identity.identityKey)?.attachment
      ?? Object.freeze([quarantined("unmatched_jwb_identity")]);
  };

  return { fromRow, fromName };
}

function rawPayload(record: JiaowubaoStaticParsedRecord<JiaowubaoStaticTabularPayload>) {
  return Object.freeze({
    raw: record.payload.raw,
    identity: record.payload.identity,
  }) as Readonly<Record<string, unknown>>;
}

function assertRecordPayloadSize(record: JiaowubaoStaticStoredRecord) {
  const bytes = Buffer.byteLength(JSON.stringify(record.payload), "utf8");
  if (bytes > MAX_JIAOWUBAO_STATIC_RECORD_PAYLOAD_BYTES) {
    throw new JiaowubaoStaticImportServiceError(
      "static_record_payload_too_large",
      `Static source record ${record.sourceKey} exceeds the 32 KiB storage bound.`,
    );
  }
}

function makeRecord(
  sourceKey: string,
  sourceRefs: readonly JiaowubaoStaticSourceRef[],
  attachments: readonly JiaowubaoStaticAttachment[],
  payload: Readonly<Record<string, unknown>>,
) {
  const record = Object.freeze({
    sourceKey,
    sourceRefs: Object.freeze([...sourceRefs]),
    attachments: uniqueAttachments(attachments),
    payload,
  });
  assertRecordPayloadSize(record);
  return record;
}

function buildRecordSets(
  parsed: JiaowubaoStaticParsedXlsxExports,
  masterRows: readonly MasterStudentImportRow[],
) {
  const plan = buildJiaowubaoStaticExportPlan({
    quickList: workbookForFacts(parsed.quickList),
    students: workbookForFacts(parsed.students),
    hours: workbookForFacts(parsed.hours),
    contracts: workbookForFacts(parsed.contracts),
  });
  const resolver = attachmentResolver(masterRows, plan.students, plan.unlinked);
  const sets = emptyRecordSets();

  for (const record of parsed.students.records) {
    const attachments = resolver.fromRow(record.payload.raw.fields);
    const identityKey = jiaowubaoStaticIdentityKeyFor(record.payload.raw.fields);
    const derivedFact = identityKey
      ? plan.students.find((fact) => fact.identity.identityKey === identityKey)
      : undefined;
    sets.facts.push(makeRecord(
      record.sourceKey,
      record.sourceRefs,
      attachments,
      Object.freeze({
        sourceKind: "student_snapshot",
        ...rawPayload(record),
        ...(derivedFact ? { aggregate: derivedFact.aggregate } : {}),
      }),
    ));
  }
  for (const record of parsed.quickList.records) {
    sets.facts.push(makeRecord(
      record.sourceKey,
      record.sourceRefs,
      resolver.fromRow(record.payload.raw.fields),
      Object.freeze({ sourceKind: "quick_list", ...rawPayload(record) }),
    ));
  }
  for (const record of parsed.contracts.records) {
    sets.contracts.push(makeRecord(
      record.sourceKey,
      record.sourceRefs,
      resolver.fromRow(record.payload.raw.fields),
      rawPayload(record),
    ));
  }
  for (const record of parsed.hours.records) {
    sets.hours.push(makeRecord(
      record.sourceKey,
      record.sourceRefs,
      resolver.fromRow(record.payload.raw.fields),
      rawPayload(record),
    ));
  }

  const classAttachments = new Map<string, readonly JiaowubaoStaticAttachment[]>();
  for (const record of parsed.classMemberships.records) {
    const attachments = resolver.fromRow({
      姓名: record.payload.identity.name,
      手机号: record.payload.identity.phone,
    });
    sets.classMembers.push(makeRecord(
      record.sourceKey,
      record.sourceRefs,
      attachments,
      Object.freeze({ raw: record.payload.raw, identity: record.payload.identity, className: record.payload.className, classType: record.payload.classType }),
    ));
    const key = classKey(record.payload.className);
    if (key) classAttachments.set(key, uniqueAttachments([...(classAttachments.get(key) ?? []), ...attachments]));
  }

  for (const record of parsed.schedule.records) {
    const attachments: JiaowubaoStaticAttachment[] = [quarantined("non_operational_static_schedule")];
    if (record.payload.parseStatus.kind !== "parsed") {
      attachments.push(quarantined("invalid_source_value"));
    } else {
      const { start, end } = record.payload.parseStatus;
      try {
        const startInstant = staticWallClockToInstant(record.payload.sourceDate, start, record.payload.sourceTimezone);
        const endInstant = staticWallClockToInstant(record.payload.sourceDate, end, record.payload.sourceTimezone);
        if (endInstant <= startInstant) throw new Error("non-positive interval");
      } catch {
        attachments.push(quarantined("invalid_source_value"));
      }
    }
    if (!record.payload.teacher) attachments.push(quarantined("unassigned_teacher"));
    if (!record.payload.course) attachments.push(quarantined("unmapped_course"));
    const classMatches = classAttachments.get(classKey(record.payload.className));
    if (classMatches?.length) attachments.push(...classMatches);
    else attachments.push(quarantined("class_not_resolved"));
    const payload = Object.freeze({
      ...record.payload,
      ...(record.payload.parseStatus.kind === "parsed" ? (() => {
        const { start, end } = record.payload.parseStatus;
        try {
          const sourceStartInstant = staticWallClockToInstant(record.payload.sourceDate, start, record.payload.sourceTimezone);
          const sourceEndInstant = staticWallClockToInstant(record.payload.sourceDate, end, record.payload.sourceTimezone);
          return sourceEndInstant > sourceStartInstant ? { sourceStartInstant, sourceEndInstant } : {};
        } catch {
          return {};
        }
      })() : {}),
    }) as Readonly<Record<string, unknown>>;
    sets.schedule.push(makeRecord(record.sourceKey, record.sourceRefs, attachments, payload));
  }

  for (const record of parsed.leaveMakeups.records) {
    const attachments = resolver.fromName(record.payload.identity.name);
    sets.leaveMakeups.push(makeRecord(
      record.sourceKey,
      record.sourceRefs,
      attachments,
      Object.freeze({ ...record.payload }) as Readonly<Record<string, unknown>>,
    ));
  }

  return { recordSets: Object.freeze({
    facts: Object.freeze(sets.facts),
    contracts: Object.freeze(sets.contracts),
    hours: Object.freeze(sets.hours),
    classMembers: Object.freeze(sets.classMembers),
    schedule: Object.freeze(sets.schedule),
    leaveMakeups: Object.freeze(sets.leaveMakeups),
  }), plan };
}

function chunkFromSets(
  masterSource: JiaowubaoStaticMasterSource,
  workbooks: readonly JiaowubaoStaticWorkbookManifest[],
  counts: JiaowubaoStaticRecordCounts,
  records: Readonly<Record<RecordSetKey, readonly JiaowubaoStaticStoredRecord[]>>,
  index: number,
  count: number,
): JiaowubaoStaticExcelChunk {
  return Object.freeze({
    format: JIAOWUBAO_STATIC_SOURCE_FORMAT,
    sourceTimezone: JIAOWUBAO_STATIC_SOURCE_TIMEZONE,
    sourceTimezoneBasis: JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE_BASIS,
    masterSource: Object.freeze({
      sourceId: masterSource.sourceId,
      revision: masterSource.revision,
      rowsSha256: masterSource.rowsSha256,
    }),
    workbooks,
    recordCounts: counts,
    chunk: Object.freeze({ index, count }),
    facts: records.facts,
    contracts: records.contracts,
    hours: records.hours,
    classMembers: records.classMembers,
    schedule: records.schedule,
    leaveMakeups: records.leaveMakeups,
  });
}

function emptyChunkRecords(): { [Key in RecordSetKey]: JiaowubaoStaticStoredRecord[] } {
  return { facts: [], contracts: [], hours: [], classMembers: [], schedule: [], leaveMakeups: [] };
}

function chunkRecordSets(
  masterSource: JiaowubaoStaticMasterSource,
  workbooks: readonly JiaowubaoStaticWorkbookManifest[],
  counts: JiaowubaoStaticRecordCounts,
  allRecords: JiaowubaoStaticRecordSets,
) {
  const chunks: { [Key in RecordSetKey]: JiaowubaoStaticStoredRecord[] }[] = [];
  let current = emptyChunkRecords();
  let currentRecordCount = 0;
  // The JSON envelope is fixed except for its record arrays.  Measuring the
  // empty, worst-digit envelope once and then adding each record's encoded
  // byte length avoids repeatedly serialising a near-2 MiB chunk for every
  // one of the 39k schedule cells.
  const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify(
    chunkFromSets(masterSource, workbooks, counts, emptyChunkRecords(), MAX_JIAOWUBAO_STATIC_CHUNKS - 1, MAX_JIAOWUBAO_STATIC_CHUNKS),
  ), "utf8");
  let currentBytes = emptyEnvelopeBytes;
  const finalize = () => {
    if (!currentRecordCount) return;
    chunks.push(current);
    current = emptyChunkRecords();
    currentRecordCount = 0;
    currentBytes = emptyEnvelopeBytes;
  };

  for (const key of RECORD_SET_KEYS) {
    for (const record of allRecords[key]) {
      const candidateCount = currentRecordCount + 1;
      const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
      const candidateBytes = currentBytes + recordBytes + (current[key].length ? 1 : 0);
      if (candidateCount > MAX_JIAOWUBAO_STATIC_CHUNK_RECORDS || candidateBytes > MAX_JIAOWUBAO_STATIC_CHUNK_BYTES) {
        if (!currentRecordCount) {
          throw new JiaowubaoStaticImportServiceError(
            "static_chunk_too_large",
            `Static source record ${record.sourceKey} cannot fit inside the static import transport budget.`,
          );
        }
        finalize();
        current[key].push(record);
        currentRecordCount = 1;
        currentBytes += recordBytes;
      } else {
        current[key].push(record);
        currentRecordCount = candidateCount;
        currentBytes = candidateBytes;
      }
    }
  }
  finalize();
  if (!chunks.length || chunks.length > MAX_JIAOWUBAO_STATIC_CHUNKS) {
    throw new JiaowubaoStaticImportServiceError(
      "static_chunk_limit_exceeded",
      "Static Jiaowubao data requires an unsupported number of chunks.",
    );
  }
  return Object.freeze(chunks.map((records, index) => {
    const chunk = chunkFromSets(masterSource, workbooks, counts, records, index, chunks.length);
    if (Buffer.byteLength(JSON.stringify(chunk), "utf8") > MAX_JIAOWUBAO_STATIC_CHUNK_BYTES) {
      throw new JiaowubaoStaticImportServiceError("static_chunk_too_large", "Static Jiaowubao chunk exceeds the transport budget.");
    }
    return chunk;
  }));
}

/**
 * Turns parsed workbooks into deterministic, bounded, non-operational source
 * evidence chunks.  The only automatic student relationship is a unique
 * exact-name match to a non-excluded Tencent master row; V1 annotations stay
 * in review quarantine and JWB-only rows remain unattached.
 */
export function prepareJiaowubaoStaticExcelImport(
  parsed: JiaowubaoStaticParsedXlsxExports,
  masterSource: JiaowubaoStaticMasterSource,
): JiaowubaoStaticExcelPreparedImport {
  if (parsed.format !== JIAOWUBAO_STATIC_SOURCE_FORMAT) {
    throw new JiaowubaoStaticImportServiceError("invalid_static_export", "Unsupported Jiaowubao static export format.");
  }
  if (!masterSource.sourceId.trim()
    || masterSource.sourceId !== masterSource.sourceId.trim()
    || masterSource.sourceId.length > 160
    || !masterSource.revision.trim()
    || masterSource.revision !== masterSource.revision.trim()
    || masterSource.revision.length > 240
    || !/^[a-f0-9]{64}$/iu.test(masterSource.rowsSha256)
    || !Array.isArray(masterSource.rows)) {
    throw new JiaowubaoStaticImportServiceError("invalid_static_export", "Tencent master source metadata is invalid.");
  }
  const workbooks = manifestFor(parsed);
  const immutableMasterSource = Object.freeze({
    sourceId: masterSource.sourceId,
    revision: masterSource.revision,
    rowsSha256: masterSource.rowsSha256.toLowerCase(),
    rows: Object.freeze([...masterSource.rows]),
  });
  const { recordSets } = buildRecordSets(parsed, immutableMasterSource.rows);
  const counts = recordCounts(recordSets);
  const chunks = chunkRecordSets(immutableMasterSource, workbooks, counts, recordSets);
  const records = RECORD_SET_KEYS.flatMap((key) => recordSets[key]);
  const attachments = records.flatMap((record) => record.attachments);
  return Object.freeze({
    sourceId: JIAOWUBAO_STATIC_EXCEL_SOURCE_ID,
    revision: revisionFor(workbooks, immutableMasterSource),
    masterSource: immutableMasterSource,
    workbooks,
    recordCounts: counts,
    chunks,
    summary: Object.freeze({
      exactAttachments: attachments.filter((attachment) => attachment.state === "attached").length,
      reviewRequired: attachments.filter((attachment) => attachment.state === "quarantined" && attachment.reason === "review_required_annotation").length,
      quarantinedRecords: records.filter((record) => record.attachments.some((attachment) => attachment.state === "quarantined")).length,
      invalidScheduleTimes: parsed.schedule.summary.invalidTime,
      sourceTimezone: JIAOWUBAO_STATIC_SOURCE_TIMEZONE,
    }),
  });
}
