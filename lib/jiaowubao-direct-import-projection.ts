import { createHash } from "node:crypto";

import {
  canonicalJson,
  type JiaowubaoDirectPreparedStaging,
  type JiaowubaoDirectRecordCounts,
  type JiaowubaoDirectStagingChunk,
  type JiaowubaoDirectStagingRecord,
  type JiaowubaoDirectStagingRecordKind,
  type JiaowubaoDirectWorkbookManifest,
} from "./jiaowubao-direct-import-preflight";
import { staticWallClockToInstant } from "./jiaowubao-static-import";
import {
  EXCLUDED_MASTER_STUDENT_STATUS,
  normalizeStudentImportName,
  type MasterStudentImportRow,
  type StudentImportSourceKey,
} from "./student-import";

/** Matches the envelope accepted by `internal.begin_jiaowubao_direct_import`. */
export const JIAOWUBAO_DIRECT_IMPORT_FORMAT = "jiaowubao-direct-import-v1" as const;
export const JIAOWUBAO_DIRECT_IMPORT_SOURCE_ID = "jiaowubao-static-excel" as const;

export type JiaowubaoDirectAuthorityMasterSource = Readonly<{
  sourceId: string;
  revision: string;
  rowsSha256: string;
  rows: readonly MasterStudentImportRow[];
}>;

/** The current Tencent-derived formal student projection from `ops_state`. */
export type JiaowubaoDirectAuthorityStudent = Readonly<{
  id: string;
  name: string;
  /** Legacy Tencent rows can carry a stale source row; it is not identity evidence. */
  sourceRow?: StudentImportSourceKey | null;
  /** Missing/blank is the audited legacy Tencent shape; other explicit sources are excluded. */
  importSource?: string | null;
  importArchived?: boolean | string;
  status?: string;
}>;

/** The current teacher projection from `ops_state`; subjects are optional evidence only. */
export type JiaowubaoDirectAuthorityTeacher = Readonly<{
  id: string;
  name: string;
  subjects?: readonly string[];
}>;

/**
 * A trusted writer must read these three current values from one authority
 * snapshot and later let the database recheck the master revision/hash at
 * completion. This pure local compiler never fetches or persists them.
 */
export type JiaowubaoDirectProjectionAuthority = Readonly<{
  masterSource: JiaowubaoDirectAuthorityMasterSource;
  students: readonly JiaowubaoDirectAuthorityStudent[];
  teachers: readonly JiaowubaoDirectAuthorityTeacher[];
}>;

export type JiaowubaoDirectQuarantineReason =
  | "unmatched_tencent_student"
  | "ambiguous_tencent_student"
  | "excluded_tencent_student"
  | "empty_name"
  | "missing_phone"
  | "duplicate_identity"
  | "review_required"
  | "class_not_resolved"
  | "invalid_source_value";

export type JiaowubaoDirectAttachmentResolution = Readonly<{
  state: "attached" | "quarantined";
  studentId: string | null;
  masterSourceRow: string | null;
  reason: JiaowubaoDirectQuarantineReason | null;
}>;

export type JiaowubaoDirectParticipantResolution = Readonly<{
  state: "attached" | "quarantined";
  reason: JiaowubaoDirectQuarantineReason | null;
}>;

export type JiaowubaoDirectSupplementalProjection = Readonly<{
  sourceKey: string;
  resolution: JiaowubaoDirectAttachmentResolution;
  identityProof: boolean;
}>;

export type JiaowubaoDirectScheduleParticipantProjection = Readonly<{
  participantKey: string;
  sourceDisplayName: string;
  identitySupplementalSourceKey: string | null;
  resolution: JiaowubaoDirectParticipantResolution;
}>;

export type JiaowubaoDirectScheduleProjection = Readonly<{
  sourceKey: string;
  teacherResolution: "exact_name" | "unresolved" | "ambiguous" | "not_found";
  teacherId: string | null;
  availabilityEffect: "display_only" | "blocks_teacher_ava";
  participants: readonly JiaowubaoDirectScheduleParticipantProjection[];
}>;

export type JiaowubaoDirectLeaveMakeupProjection = Readonly<{
  sourceKey: string;
  incidentKind: "leave" | "makeup" | "unknown";
  resolution: JiaowubaoDirectAttachmentResolution;
}>;

/** Exact `p_projection` shape accepted by `stage_jiaowubao_direct_import_chunk`. */
export type JiaowubaoDirectChunkProjection = Readonly<{
  supplemental: readonly JiaowubaoDirectSupplementalProjection[];
  scheduleEvents: readonly JiaowubaoDirectScheduleProjection[];
  leaveMakeups: readonly JiaowubaoDirectLeaveMakeupProjection[];
}>;

export type JiaowubaoDirectImportEnvelope = Readonly<{
  format: typeof JIAOWUBAO_DIRECT_IMPORT_FORMAT;
  sourceId: typeof JIAOWUBAO_DIRECT_IMPORT_SOURCE_ID;
  revision: string;
  sourceTimezone: "Australia/Melbourne";
  sourceTimezoneBasis: string;
  masterSource: Readonly<{
    sourceId: string;
    revision: string;
    rowsSha256: string;
  }>;
  workbooks: readonly JiaowubaoDirectWorkbookManifest[];
  recordCounts: JiaowubaoDirectRecordCounts;
  expectedCounts: Readonly<{
    supplementalRecords: number;
    scheduleEvents: number;
    scheduleParticipants: number;
    leaveMakeups: number;
  }>;
  chunkCount: number;
}>;

export type JiaowubaoDirectCompiledChunk = Readonly<{
  chunk: JiaowubaoDirectStagingChunk;
  projection: JiaowubaoDirectChunkProjection;
  /** Local canonical digest for pre-write review; PostgreSQL computes its own JSONB digest. */
  projectionSha256: string;
}>;

export type JiaowubaoDirectNonOperationalScheduleReason = "refund" | "transfer" | "consumption" | "test";

/** Aggregate-only: safe to log, unlike the source chunks and projection payloads. */
export type JiaowubaoDirectProjectionReport = Readonly<{
  format: typeof JIAOWUBAO_DIRECT_IMPORT_FORMAT;
  revision: string;
  authority: Readonly<{
    masterRows: number;
    activeMasterRows: number;
    currentStudentCandidates: number;
    currentMasterStudents: number;
    currentExplicitMasterStudents: number;
    currentLegacyMasterStudents: number;
    currentTeachers: number;
  }>;
  expectedCounts: JiaowubaoDirectImportEnvelope["expectedCounts"];
  supplemental: Readonly<{
    attached: number;
    quarantined: number;
    identityProofs: number;
    quarantinedByReason: Readonly<Record<JiaowubaoDirectQuarantineReason, number>>;
  }>;
  schedule: Readonly<{
    events: number;
    blocksTeacherAva: number;
    displayOnly: number;
    exactTeachers: number;
    unresolvedTeachers: number;
    ambiguousTeachers: number;
    missingTeachers: number;
    /**
     * Course labels remain raw JWB source data. The current staging contract
     * deliberately writes no subject attachment, so every imported event is
     * represented here as unresolved regardless of whether it blocks AVA.
     */
    subjectResolution: Readonly<{
      unresolved: number;
      sourceCourseMissing: number;
    }>;
    nonOperationalByReason: Readonly<Record<JiaowubaoDirectNonOperationalScheduleReason, number>>;
    participants: number;
    attachedParticipants: number;
    quarantinedParticipants: number;
    quarantinedByReason: Readonly<Record<JiaowubaoDirectQuarantineReason, number>>;
  }>;
  leaveMakeups: Readonly<{
    leave: number;
    makeup: number;
    unknown: number;
    attached: number;
    quarantined: number;
    quarantinedByReason: Readonly<Record<JiaowubaoDirectQuarantineReason, number>>;
  }>;
}>;

export type JiaowubaoDirectCompiledImport = Readonly<{
  envelope: JiaowubaoDirectImportEnvelope;
  chunks: readonly JiaowubaoDirectCompiledChunk[];
  report: JiaowubaoDirectProjectionReport;
}>;

export type JiaowubaoDirectStageInstruction = Readonly<{
  chunk: JiaowubaoDirectStagingChunk;
  projection: JiaowubaoDirectChunkProjection;
}>;

/**
 * Local execution plan for the trusted writer. It intentionally mirrors the
 * only safe production transaction order: begin, stage every bounded chunk,
 * then complete. This module does not perform those RPC calls itself.
 */
export type JiaowubaoDirectSequentialImportPlan = Readonly<{
  begin: Readonly<{
    envelope: JiaowubaoDirectImportEnvelope;
    actor: string;
  }>;
  stages: readonly JiaowubaoDirectStageInstruction[];
  complete: Readonly<{ actor: string }>;
}>;

/**
 * Exact wrapper accepted by `internal.apply_jiaowubao_direct_import_atomic`.
 * It is deliberately fixture-only: full JWB input must use the sequential
 * trusted-CLI transaction plan above, never one giant JSONB RPC request.
 */
export type JiaowubaoDirectAtomicImportRequest = JiaowubaoDirectImportEnvelope & Readonly<{
  actor: string;
  chunks: readonly JiaowubaoDirectStageInstruction[];
}>;

export const MAX_JIAOWUBAO_DIRECT_ATOMIC_FIXTURE_CHUNKS = 4;
export const MAX_JIAOWUBAO_DIRECT_ATOMIC_FIXTURE_BYTES = 1_000_000;

export class JiaowubaoDirectProjectionError extends Error {
  constructor(
    readonly code: "invalid_preflight" | "invalid_authority_snapshot" | "invalid_actor" | "atomic_fixture_too_large",
    message: string,
  ) {
    super(message);
    this.name = "JiaowubaoDirectProjectionError";
  }
}

type NormalizedMaster = Readonly<{
  sourceRow: string;
  name: string;
  nameKey: string;
  excluded: boolean;
}>;

type NormalizedStudent = Readonly<{
  id: string;
  sourceRow: string;
  nameKey: string;
}>;

type NormalizedStudentCandidate = Readonly<{
  id: string;
  sourceRow: string | null;
  nameKey: string;
  authorityMode: "explicit_master" | "legacy_tencent";
}>;

type NormalizedTeacher = Readonly<{
  id: string;
  name: string;
  nameKey: string;
}>;

type ParsedAuthority = Readonly<{
  masterByName: ReadonlyMap<string, readonly NormalizedMaster[]>;
  activeMasterByName: ReadonlyMap<string, readonly NormalizedMaster[]>;
  currentStudentsBySourceAndName: ReadonlyMap<string, readonly NormalizedStudent[]>;
  teachersByName: ReadonlyMap<string, readonly NormalizedTeacher[]>;
  report: JiaowubaoDirectProjectionReport["authority"];
}>;

type SupplementalCandidate = Readonly<{
  record: JiaowubaoDirectStagingRecord;
  /**
   * Atomic staging runs chunks in index order. A schedule participant may
   * reference a proof in its own chunk (supplemental records are inserted
   * first) or an earlier chunk, but never a later one.
   */
  chunkIndex: number;
  resolution: JiaowubaoDirectAttachmentResolution;
  nameKey?: string;
  identityProof: boolean;
}>;

type MutableReasonCounts = Record<JiaowubaoDirectQuarantineReason, number>;

const SUPPLEMENTAL_KINDS = new Set<JiaowubaoDirectStagingRecordKind>([
  "student_snapshot",
  "quick_list",
  "contract_history",
  "hour_balance",
  "class_membership",
]);

const RECORD_KIND_ORDER: readonly JiaowubaoDirectStagingRecordKind[] = [
  "student_snapshot",
  "quick_list",
  "contract_history",
  "hour_balance",
  "class_membership",
  "schedule_event",
  "leave_makeup",
];

const REQUIRED_WORKBOOK_KINDS = [
  "quick_list",
  "students",
  "contracts",
  "hours",
  "class_members",
  "schedule",
  "leave_makeups",
] as const;

const RECORD_WORKBOOK: Readonly<Record<JiaowubaoDirectStagingRecordKind, (typeof REQUIRED_WORKBOOK_KINDS)[number]>> = Object.freeze({
  student_snapshot: "students",
  quick_list: "quick_list",
  contract_history: "contracts",
  hour_balance: "hours",
  class_membership: "class_members",
  schedule_event: "schedule",
  leave_makeup: "leave_makeups",
});

const REQUIRED_STAGING_CONTRACT = Object.freeze({
  storage: "server_only_relational_staging",
  studentAuthority: "tencent_master",
  studentCreation: "forbidden",
  studentMatching: "server_side_current_tencent_only",
  scheduleProjection: "read_only_imported_schedule_event",
  scheduleBookingExpansion: "forbidden",
  sourceMutation: "forbidden",
});

const SOURCE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const WALL_CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

const SUPPLEMENTAL_PROOF_PRIORITY: Readonly<Record<Extract<JiaowubaoDirectStagingRecordKind, "student_snapshot" | "quick_list" | "contract_history" | "hour_balance" | "class_membership">, number>> = Object.freeze({
  student_snapshot: 0,
  quick_list: 1,
  hour_balance: 2,
  contract_history: 3,
  class_membership: 4,
});

const QUARANTINE_REASONS: readonly JiaowubaoDirectQuarantineReason[] = [
  "unmatched_tencent_student",
  "ambiguous_tencent_student",
  "excluded_tencent_student",
  "empty_name",
  "missing_phone",
  "duplicate_identity",
  "review_required",
  "class_not_resolved",
  "invalid_source_value",
] as const;

const NON_OPERATIONAL_RULES: readonly Readonly<{
  reason: JiaowubaoDirectNonOperationalScheduleReason;
  matches: (value: string) => boolean;
}>[] = [
  { reason: "refund", matches: (value) => /退款|退费|\brefund\b/iu.test(value) },
  { reason: "transfer", matches: (value) => /转出|转入|转课|转班|\btransfer\b/iu.test(value) },
  { reason: "consumption", matches: (value) => /消课|耗课|扣课|\bconsum(?:e|ed|ption)\b/iu.test(value) },
  { reason: "test", matches: (value) => /测试|\b(?:test(?:ing)?|demo|mock)\b/iu.test(value) },
] as const;

function frozen<T>(value: T) {
  return Object.freeze(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanText(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  return String(value)
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/[\s\u3000]+/gu, " ")
    .trim();
}

/** Mirrors the SQL snapshot's trim-only status comparison; do not NFKC it. */
function authorityStatus(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** Keeps meaningful internal whitespace intact for exact source metadata. */
function trimText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function sourceKey(value: unknown) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return "";
    return String(value);
  }
  if (typeof value !== "string") return "";
  const clean = value.trim();
  return clean.length > 0 && clean.length <= 240 ? clean : "";
}

function recordObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function sourcePayload(record: JiaowubaoDirectStagingRecord) {
  const source = recordObject(record.payload.source);
  if (!source) throw new JiaowubaoDirectProjectionError("invalid_preflight", "A direct preflight source payload is malformed.");
  return source;
}

function identityFromSource(source: Readonly<Record<string, unknown>>) {
  const identity = recordObject(source.identity);
  return frozen({
    name: cleanText(identity?.name),
    phone: cleanText(identity?.phone),
  });
}

function zeroReasonCounts(): MutableReasonCounts {
  return Object.fromEntries(QUARANTINE_REASONS.map((reason) => [reason, 0])) as MutableReasonCounts;
}

function addMapValue<T>(map: Map<string, T[]>, key: string, value: T) {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function freezeMapValues<T>(map: Map<string, T[]>) {
  return new Map([...map.entries()].map(([key, values]) => [key, frozen([...values])])) as ReadonlyMap<string, readonly T[]>;
}

function assertAuthoritySnapshot(authority: JiaowubaoDirectProjectionAuthority): ParsedAuthority {
  if (!authority || !Array.isArray(authority.masterSource?.rows)
    || !Array.isArray(authority.students) || !Array.isArray(authority.teachers)
    || !trimText(authority.masterSource?.sourceId)
    || trimText(authority.masterSource?.sourceId) !== authority.masterSource?.sourceId
    || !trimText(authority.masterSource?.revision)
    || trimText(authority.masterSource?.revision) !== authority.masterSource?.revision
    || !SHA256_PATTERN.test(trimText(authority.masterSource?.rowsSha256))
    || trimText(authority.masterSource?.rowsSha256) !== authority.masterSource?.rowsSha256) {
    throw new JiaowubaoDirectProjectionError("invalid_authority_snapshot", "The current Tencent/ops authority snapshot is invalid.");
  }

  const masterByName = new Map<string, NormalizedMaster[]>();
  const activeMasterByName = new Map<string, NormalizedMaster[]>();
  const masterSourceRows = new Set<string>();
  for (const row of authority.masterSource.rows) {
    const rowKey = sourceKey(row?.sourceRow);
    const name = cleanText(row?.name);
    const nameKey = name ? normalizeStudentImportName(name) : "";
    if (!rowKey || !nameKey || masterSourceRows.has(rowKey)) {
      throw new JiaowubaoDirectProjectionError("invalid_authority_snapshot", "The current Tencent master snapshot has an invalid identity row.");
    }
    masterSourceRows.add(rowKey);
    const excluded = authorityStatus(row.status) === EXCLUDED_MASTER_STUDENT_STATUS;
    const normalized = frozen({ sourceRow: rowKey, name, nameKey, excluded });
    addMapValue(masterByName, nameKey, normalized);
    if (!excluded) addMapValue(activeMasterByName, nameKey, normalized);
  }

  const currentCandidatesByName = new Map<string, NormalizedStudentCandidate[]>();
  let currentStudentCandidates = 0;
  let currentMasterStudents = 0;
  let currentExplicitMasterStudents = 0;
  let currentLegacyMasterStudents = 0;
  for (const student of authority.students) {
    const importSource = trimText(student?.importSource);
    if ((importSource !== "" && importSource !== "master")
      || student.importArchived === true
      || (typeof student.importArchived === "string" && student.importArchived.trim().toLowerCase() === "true")) continue;
    const id = trimText(student.id);
    const nameKey = normalizeStudentImportName(cleanText(student.name));
    if (!id || !nameKey) continue;
    currentStudentCandidates += 1;
    addMapValue(currentCandidatesByName, nameKey, frozen({
      id,
      sourceRow: sourceKey(student.sourceRow) || null,
      nameKey,
      authorityMode: importSource === "master" ? "explicit_master" : "legacy_tencent",
    }));
  }

  const currentStudentsBySourceAndName = new Map<string, NormalizedStudent[]>();
  for (const [nameKey, candidates] of currentCandidatesByName) {
    const activeMasters = activeMasterByName.get(nameKey) ?? [];
    if (activeMasters.length !== 1) continue;
    const master = activeMasters[0];

    // The current normalized name must be globally unique before either
    // current shape can become authority. Keep duplicate candidates in the
    // map only so callers quarantine them as ambiguous rather than unmatched.
    if (candidates.length !== 1) {
      for (const candidate of candidates) {
        addMapValue(currentStudentsBySourceAndName, `${master.sourceRow}\u0000${nameKey}`, frozen({
          id: candidate.id,
          sourceRow: master.sourceRow,
          nameKey,
        }));
      }
      continue;
    }

    const candidate = candidates[0];
    if (candidate.authorityMode === "explicit_master" && candidate.sourceRow !== master.sourceRow) continue;
    addMapValue(currentStudentsBySourceAndName, `${master.sourceRow}\u0000${nameKey}`, frozen({
      id: candidate.id,
      sourceRow: master.sourceRow,
      nameKey,
    }));
    currentMasterStudents += 1;
    if (candidate.authorityMode === "explicit_master") currentExplicitMasterStudents += 1;
    else currentLegacyMasterStudents += 1;
  }

  const teachersByName = new Map<string, NormalizedTeacher[]>();
  for (const teacher of authority.teachers) {
    const id = trimText(teacher?.id);
    const name = cleanText(teacher?.name);
    const nameKey = name ? normalizeStudentImportName(name) : "";
    if (!id || !nameKey) {
      throw new JiaowubaoDirectProjectionError("invalid_authority_snapshot", "The current teacher projection is malformed.");
    }
    addMapValue(teachersByName, nameKey, frozen({ id, name, nameKey }));
  }

  return frozen({
    masterByName: freezeMapValues(masterByName),
    activeMasterByName: freezeMapValues(activeMasterByName),
    currentStudentsBySourceAndName: freezeMapValues(currentStudentsBySourceAndName),
    teachersByName: freezeMapValues(teachersByName),
    report: frozen({
      masterRows: authority.masterSource.rows.length,
      activeMasterRows: [...activeMasterByName.values()].reduce((total, rows) => total + rows.length, 0),
      currentStudentCandidates,
      currentMasterStudents,
      currentExplicitMasterStudents,
      currentLegacyMasterStudents,
      currentTeachers: authority.teachers.length,
    }),
  });
}

function quarantined(reason: JiaowubaoDirectQuarantineReason): JiaowubaoDirectAttachmentResolution {
  return frozen({ state: "quarantined", studentId: null, masterSourceRow: null, reason });
}

function attached(student: NormalizedStudent, master: NormalizedMaster): JiaowubaoDirectAttachmentResolution {
  return frozen({ state: "attached", studentId: student.id, masterSourceRow: master.sourceRow, reason: null });
}

function resolveCurrentTencentStudent(
  name: string,
  phone: string | undefined,
  requirePhone: boolean,
  authority: ParsedAuthority,
): Readonly<{ resolution: JiaowubaoDirectAttachmentResolution; nameKey?: string }> {
  const nameKey = name ? normalizeStudentImportName(name) : "";
  if (!nameKey) return frozen({ resolution: quarantined("empty_name") });
  if (requirePhone && !phone) return frozen({ resolution: quarantined("missing_phone"), nameKey });

  const active = authority.activeMasterByName.get(nameKey) ?? [];
  if (active.length > 1) return frozen({ resolution: quarantined("ambiguous_tencent_student"), nameKey });
  if (!active.length) {
    const all = authority.masterByName.get(nameKey) ?? [];
    const reason: JiaowubaoDirectQuarantineReason = all.length && all.every((row) => row.excluded)
      ? "excluded_tencent_student"
      : "unmatched_tencent_student";
    return frozen({ resolution: quarantined(reason), nameKey });
  }
  const master = active[0];
  const students = authority.currentStudentsBySourceAndName.get(`${master.sourceRow}\u0000${master.nameKey}`) ?? [];
  if (students.length !== 1) {
    return frozen({ resolution: quarantined(students.length > 1 ? "ambiguous_tencent_student" : "unmatched_tencent_student"), nameKey });
  }
  return frozen({ resolution: attached(students[0], master), nameKey });
}

function invalidPreflight(message = "The direct preflight batch is invalid."): never {
  throw new JiaowubaoDirectProjectionError("invalid_preflight", message);
}

function sameCanonicalJson(left: unknown, right: unknown) {
  return canonicalJson(left) === canonicalJson(right);
}

function isDirectRecordKind(value: unknown): value is JiaowubaoDirectStagingRecordKind {
  return typeof value === "string" && RECORD_KIND_ORDER.includes(value as JiaowubaoDirectStagingRecordKind);
}

function isCanonicalIsoDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function directRecordDigest(record: JiaowubaoDirectStagingRecord) {
  return sha256(canonicalJson({
    kind: record.kind,
    sourceKey: record.sourceKey,
    sourceRefs: record.sourceRefs,
    studentRelationship: record.studentRelationship,
    payload: record.payload,
  }));
}

function directPreflightRevision(
  workbooks: readonly JiaowubaoDirectWorkbookManifest[],
  records: readonly JiaowubaoDirectStagingRecord[],
) {
  const order = new Map(RECORD_KIND_ORDER.map((kind, index) => [kind, index]));
  const revisionRecords = [...records]
    .sort((left, right) => (order.get(left.kind) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.kind) ?? Number.MAX_SAFE_INTEGER)
      || left.sourceKey.localeCompare(right.sourceKey))
    .map((record) => frozen({
      kind: record.kind,
      sourceKey: record.sourceKey,
      sourceDigest: record.sourceDigest,
    }));
  return `sha256:${sha256(canonicalJson({
    format: "jiaowubao-direct-staging-v1",
    sourceTimezone: "Australia/Melbourne",
    workbooks,
    records: revisionRecords,
  }))}`;
}

function assertScheduleTemporal(record: JiaowubaoDirectStagingRecord) {
  const staging = recordObject(record.payload.staging);
  const temporal = recordObject(staging?.temporal);
  if (!temporal
    || !isCanonicalIsoDate(cleanText(temporal.sourceDate))
    || temporal.sourceTimezone !== "Australia/Melbourne") {
    invalidPreflight("A schedule source row has invalid Melbourne temporal metadata.");
  }
  if (temporal.state === "invalid") {
    if (![
      "invalid_time_interval",
      "invalid_wall_clock",
      "ambiguous_wall_clock",
      "non_positive_interval",
    ].includes(cleanText(temporal.reason))) {
      invalidPreflight("A schedule source row has an invalid time-state reason.");
    }
    return false;
  }
  if (temporal.state !== "resolved"
    || !WALL_CLOCK_PATTERN.test(cleanText(temporal.start))
    || !WALL_CLOCK_PATTERN.test(cleanText(temporal.end))
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(cleanText(temporal.sourceStartInstant))
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(cleanText(temporal.sourceEndInstant))) {
    invalidPreflight("A schedule source row has an invalid resolved time interval.");
  }
  try {
    const expectedStart = staticWallClockToInstant(
      cleanText(temporal.sourceDate),
      cleanText(temporal.start),
      "Australia/Melbourne",
    );
    const expectedEnd = staticWallClockToInstant(
      cleanText(temporal.sourceDate),
      cleanText(temporal.end),
      "Australia/Melbourne",
    );
    if (expectedStart !== temporal.sourceStartInstant
      || expectedEnd !== temporal.sourceEndInstant
      || expectedStart >= expectedEnd) {
      invalidPreflight("A schedule source row has a non-canonical Melbourne time interval.");
    }
  } catch {
    invalidPreflight("A schedule source row has an unresolvable Melbourne time interval.");
  }
  return true;
}

function assertWorkbookManifest(
  workbooks: readonly JiaowubaoDirectWorkbookManifest[],
  workbookCounts: Readonly<Record<string, number>>,
) {
  if (workbooks.length !== REQUIRED_WORKBOOK_KINDS.length) {
    invalidPreflight("The direct preflight workbook manifest is incomplete.");
  }
  for (let index = 0; index < REQUIRED_WORKBOOK_KINDS.length; index += 1) {
    const expectedKind = REQUIRED_WORKBOOK_KINDS[index];
    const workbook = workbooks[index];
    if (!workbook
      || workbook.kind !== expectedKind
      || !trimText(workbook.workbookName)
      || trimText(workbook.workbookName) !== workbook.workbookName
      || !SHA256_PATTERN.test(trimText(workbook.workbookSha256))
      || trimText(workbook.workbookSha256) !== workbook.workbookSha256
      || !trimText(workbook.sheetName)
      || trimText(workbook.sheetName) !== workbook.sheetName
      || !Number.isSafeInteger(workbook.sourceRecordCount)
      || workbook.sourceRecordCount < 0
      || workbook.sourceRecordCount !== (workbookCounts[expectedKind] ?? 0)) {
      invalidPreflight("The direct preflight workbook manifest does not reconcile.");
    }
  }
}

function assertPreflight(prepared: JiaowubaoDirectPreparedStaging) {
  if (!prepared || !Array.isArray(prepared.chunks) || !prepared.chunks.length
    || typeof prepared.revision !== "string" || !prepared.revision
    || !Array.isArray(prepared.workbooks) || !prepared.recordCounts
    || prepared.chunks.length > 512
    || !sameCanonicalJson(prepared.contract, REQUIRED_STAGING_CONTRACT)) {
    invalidPreflight();
  }
  const expectedKinds = new Set(RECORD_KIND_ORDER);
  const sourceKeys = new Set<string>();
  const counts = Object.fromEntries(RECORD_KIND_ORDER.map((kind) => [kind, 0])) as Record<JiaowubaoDirectStagingRecordKind, number>;
  const workbookCounts: Record<string, number> = Object.fromEntries(REQUIRED_WORKBOOK_KINDS.map((kind) => [kind, 0]));
  const allRecords: JiaowubaoDirectStagingRecord[] = [];
  const sourceTimezoneBasis = prepared.chunks[0]?.sourceTimezoneBasis;
  if (!trimText(sourceTimezoneBasis) || trimText(sourceTimezoneBasis) !== sourceTimezoneBasis) invalidPreflight();

  for (let index = 0; index < prepared.chunks.length; index += 1) {
    const chunk: JiaowubaoDirectStagingChunk = prepared.chunks[index]!;
    if (chunk.format !== "jiaowubao-direct-staging-v1"
      || chunk.revision !== prepared.revision
      || !sameCanonicalJson(chunk.contract, REQUIRED_STAGING_CONTRACT)
      || chunk.sourceTimezone !== "Australia/Melbourne"
      || chunk.sourceTimezoneBasis !== sourceTimezoneBasis
      || !sameCanonicalJson(chunk.workbooks, prepared.workbooks)
      || !sameCanonicalJson(chunk.recordCounts, prepared.recordCounts)
      || chunk.chunk.index !== index
      || chunk.chunk.count !== prepared.chunks.length
      || !Array.isArray(chunk.records)
      || chunk.records.length < 1 || chunk.records.length > 1500) {
      invalidPreflight("The direct preflight chunks are not a contiguous immutable sequence.");
    }
    for (const record of chunk.records as readonly JiaowubaoDirectStagingRecord[]) {
      const recordKind = isDirectRecordKind(record.kind) ? record.kind : undefined;
      const sourceRef = Array.isArray(record.sourceRefs) && record.sourceRefs.length === 1
        ? recordObject(record.sourceRefs[0])
        : undefined;
      if (!recordKind
        || !expectedKinds.has(recordKind)
        || !SOURCE_KEY_PATTERN.test(cleanText(record.sourceKey))
        || cleanText(record.sourceKey) !== record.sourceKey
        || sourceKeys.has(record.sourceKey)
        || !SHA256_PATTERN.test(cleanText(record.sourceDigest))
        || cleanText(record.sourceDigest) !== record.sourceDigest
        || record.sourceDigest !== directRecordDigest(record)
        || !sourceRef
        || sourceRef.workbook !== RECORD_WORKBOOK[recordKind]
        || typeof sourceRef.row !== "number"
        || !Number.isSafeInteger(sourceRef.row)
        || sourceRef.row < 1
        || (recordKind === "schedule_event" && !/^[A-Z]{1,3}[1-9][0-9]{0,5}$/u.test(cleanText(sourceRef.cell)))
        || !recordObject(record.payload)
        || !recordObject(record.payload.source)
        || !recordObject(record.payload.staging)
        || !recordObject(record.studentRelationship)
        || record.studentRelationship.automaticAttachment !== "forbidden") {
        invalidPreflight("The direct preflight records are not valid immutable source evidence.");
      }
      if (recordKind === "schedule_event") assertScheduleTemporal(record);
      sourceKeys.add(record.sourceKey);
      counts[recordKind] += 1;
      workbookCounts[sourceRef.workbook as string] += 1;
      allRecords.push(record);
    }
  }
  if (!sameCanonicalJson(prepared.recordCounts, counts)) {
    invalidPreflight("The direct preflight record totals do not reconcile.");
  }
  assertWorkbookManifest(prepared.workbooks, workbookCounts);

  const expectedRevision = directPreflightRevision(prepared.workbooks, allRecords);
  if (prepared.revision !== expectedRevision) {
    invalidPreflight("The direct preflight revision does not bind its immutable source records.");
  }
  const chunkManifests = prepared.chunks.map((chunk) => frozen({
    index: chunk.chunk.index,
    fileName: `chunks/${String(chunk.chunk.index + 1).padStart(4, "0")}.json`,
    recordCount: chunk.records.length,
    bytes: Buffer.byteLength(canonicalJson(chunk), "utf8"),
    sha256: sha256(canonicalJson(chunk)),
  }));
  const expectedManifest = frozen({
    format: "jiaowubao-direct-staging-v1",
    revision: expectedRevision,
    contract: REQUIRED_STAGING_CONTRACT,
    sourceTimezone: "Australia/Melbourne",
    sourceTimezoneBasis,
    workbooks: prepared.workbooks,
    recordCounts: counts,
    chunks: frozen(chunkManifests),
  });
  if (!sameCanonicalJson(prepared.manifest, expectedManifest)) {
    invalidPreflight("The direct preflight manifest does not bind the supplied chunks.");
  }
}

function supplementalIdentityKey(candidate: SupplementalCandidate) {
  if (candidate.resolution.state !== "attached" || !candidate.nameKey) return "";
  return `${candidate.resolution.studentId}\u0000${candidate.resolution.masterSourceRow}\u0000${candidate.nameKey}`;
}

function sortCandidateForProof(left: SupplementalCandidate, right: SupplementalCandidate) {
  // The source chunks are immutable and the private RPC stages them in
  // numeric order. Prefer a proof which is available as early as possible;
  // this prevents a schedule cell from citing a supplemental row that has
  // not yet been inserted. Within a chunk, source strength and source key
  // make the choice deterministic.
  if (left.chunkIndex !== right.chunkIndex) return left.chunkIndex - right.chunkIndex;
  const leftPriority = SUPPLEMENTAL_PROOF_PRIORITY[left.record.kind as keyof typeof SUPPLEMENTAL_PROOF_PRIORITY] ?? Number.MAX_SAFE_INTEGER;
  const rightPriority = SUPPLEMENTAL_PROOF_PRIORITY[right.record.kind as keyof typeof SUPPLEMENTAL_PROOF_PRIORITY] ?? Number.MAX_SAFE_INTEGER;
  return leftPriority - rightPriority || left.record.sourceKey.localeCompare(right.record.sourceKey);
}

function compileSupplementalCandidates(
  prepared: JiaowubaoDirectPreparedStaging,
  authority: ParsedAuthority,
) {
  const candidates: SupplementalCandidate[] = [];
  for (const chunk of prepared.chunks) {
    for (const record of chunk.records) {
      if (!SUPPLEMENTAL_KINDS.has(record.kind)) continue;
      const identity = identityFromSource(sourcePayload(record));
      const resolved = resolveCurrentTencentStudent(identity.name, identity.phone, true, authority);
      candidates.push(frozen({
        record,
        chunkIndex: chunk.chunk.index,
        resolution: resolved.resolution,
        ...(resolved.nameKey ? { nameKey: resolved.nameKey } : {}),
        identityProof: false,
      }));
    }
  }
  const byIdentity = new Map<string, SupplementalCandidate[]>();
  for (const candidate of candidates) {
    const key = supplementalIdentityKey(candidate);
    if (key) addMapValue(byIdentity, key, candidate);
  }
  const identityProofKeys = new Set<string>();
  for (const values of byIdentity.values()) {
    const selected = [...values].sort(sortCandidateForProof)[0];
    identityProofKeys.add(selected.record.sourceKey);
  }
  const resolvedCandidates = candidates.map((candidate) => frozen({
    ...candidate,
    identityProof: identityProofKeys.has(candidate.record.sourceKey),
  }));
  const bySourceKey = new Map(resolvedCandidates.map((candidate) => [candidate.record.sourceKey, candidate]));
  const proofByName = new Map<string, SupplementalCandidate[]>();
  for (const candidate of resolvedCandidates) {
    if (!candidate.identityProof || !candidate.nameKey) continue;
    addMapValue(proofByName, candidate.nameKey, candidate);
  }
  return frozen({
    bySourceKey: bySourceKey as ReadonlyMap<string, SupplementalCandidate>,
    proofByName: freezeMapValues(proofByName),
    candidates: frozen(resolvedCandidates),
  });
}

function scheduleNames(source: Readonly<Record<string, unknown>>) {
  const values = source.studentDisplayNames;
  if (!Array.isArray(values)) {
    throw new JiaowubaoDirectProjectionError("invalid_preflight", "A schedule source row has no display-name array.");
  }
  const names = values.map((value) => cleanText(value));
  if (names.some((value) => !value)) {
    throw new JiaowubaoDirectProjectionError("invalid_preflight", "A schedule source row has an invalid display name.");
  }
  return frozen(names);
}

function scheduleTemporalResolved(record: JiaowubaoDirectStagingRecord) {
  const staging = recordObject(record.payload.staging);
  const temporal = recordObject(staging?.temporal);
  return temporal?.state === "resolved";
}

function nonOperationalScheduleReason(source: Readonly<Record<string, unknown>>) {
  const raw = recordObject(source.raw);
  const sourceText = [
    cleanText(raw?.rawText),
    cleanText(source.className),
    cleanText(source.course),
    cleanText(source.teacher),
  ].join("\n");
  return NON_OPERATIONAL_RULES.find((rule) => rule.matches(sourceText))?.reason;
}

function teacherForSchedule(
  source: Readonly<Record<string, unknown>>,
  authority: ParsedAuthority,
) {
  const displayName = cleanText(source.teacher);
  if (!displayName) return frozen({ resolution: "unresolved" as const, teacherId: null });
  const candidates = authority.teachersByName.get(normalizeStudentImportName(displayName)) ?? [];
  if (!candidates.length) return frozen({ resolution: "not_found" as const, teacherId: null });
  if (candidates.length !== 1) return frozen({ resolution: "ambiguous" as const, teacherId: null });
  return frozen({ resolution: "exact_name" as const, teacherId: candidates[0].id });
}

function participantProjection(
  sourceDisplayName: string,
  index: number,
  scheduleChunkIndex: number,
  proofByName: ReadonlyMap<string, readonly SupplementalCandidate[]>,
  authority: ParsedAuthority,
): JiaowubaoDirectScheduleParticipantProjection {
  const nameKey = normalizeStudentImportName(sourceDisplayName);
  const proofs = (proofByName.get(nameKey) ?? []).filter((proof) => proof.chunkIndex <= scheduleChunkIndex);
  if (proofs.length === 1) {
    return frozen({
      participantKey: `p-${String(index + 1).padStart(4, "0")}`,
      sourceDisplayName,
      identitySupplementalSourceKey: proofs[0].record.sourceKey,
      resolution: frozen({ state: "attached", reason: null }),
    });
  }
  const match = resolveCurrentTencentStudent(sourceDisplayName, undefined, false, authority);
  const reason: JiaowubaoDirectQuarantineReason = match.resolution.state === "attached"
    ? "class_not_resolved"
    : match.resolution.reason!;
  return frozen({
    participantKey: `p-${String(index + 1).padStart(4, "0")}`,
    sourceDisplayName,
    identitySupplementalSourceKey: null,
    resolution: frozen({ state: "quarantined", reason }),
  });
}

function incidentKind(source: Readonly<Record<string, unknown>>) {
  const raw = recordObject(source.raw);
  const fields = recordObject(raw?.fields) ?? {};
  const hasValue = (field: string) => Boolean(cleanText(fields[field]));
  const hasLeave = ["请假类型", "请假时间", "请假原因", "请假实扣/应扣"].some(hasValue);
  const hasMakeup = ["补课班级", "补课详情", "补课实扣/应扣"].some(hasValue);
  // The supplied export is a leave-record export. When it carries both a
  // leave and later make-up detail, retain one read-only leave incident rather
  // than inventing a second operational activity.
  if (hasLeave) return "leave" as const;
  if (hasMakeup) return "makeup" as const;
  return "unknown" as const;
}

function addReason(target: MutableReasonCounts, resolution: JiaowubaoDirectAttachmentResolution | JiaowubaoDirectParticipantResolution) {
  if (resolution.state === "quarantined" && resolution.reason) target[resolution.reason] += 1;
}

function emptyNonOperationalCounts(): Record<JiaowubaoDirectNonOperationalScheduleReason, number> {
  return { refund: 0, transfer: 0, consumption: 0, test: 0 };
}

/**
 * Compiles the only reviewed identifiers needed by the private staging RPC.
 * It never writes anything, never calls a remote service, and never logs raw
 * identities.  Raw names/phones/times remain exclusively in the unchanged
 * preflight chunks; the stage function derives them from there.
 */
export function compileJiaowubaoDirectImportProjection(
  prepared: JiaowubaoDirectPreparedStaging,
  authorityInput: JiaowubaoDirectProjectionAuthority,
): JiaowubaoDirectCompiledImport {
  assertPreflight(prepared);
  const authority = assertAuthoritySnapshot(authorityInput);
  const supplemental = compileSupplementalCandidates(prepared, authority);
  const supplementalReasons = zeroReasonCounts();
  const participantReasons = zeroReasonCounts();
  const leaveReasons = zeroReasonCounts();
  const nonOperational = emptyNonOperationalCounts();
  let supplementalAttached = 0;
  let supplementalQuarantined = 0;
  let exactTeachers = 0;
  let unresolvedTeachers = 0;
  let ambiguousTeachers = 0;
  let missingTeachers = 0;
  let availabilityBlocks = 0;
  let displayOnly = 0;
  let participants = 0;
  let attachedParticipants = 0;
  let quarantinedParticipants = 0;
  let sourceCourseMissing = 0;
  let leaveCount = 0;
  let makeupCount = 0;
  let unknownLeaveCount = 0;
  let attachedLeaves = 0;
  let quarantinedLeaves = 0;

  const compiledChunks: JiaowubaoDirectCompiledChunk[] = [];
  for (const chunk of prepared.chunks) {
    const chunkSupplemental: JiaowubaoDirectSupplementalProjection[] = [];
    const scheduleEvents: JiaowubaoDirectScheduleProjection[] = [];
    const leaveMakeups: JiaowubaoDirectLeaveMakeupProjection[] = [];
    for (const record of chunk.records) {
      if (SUPPLEMENTAL_KINDS.has(record.kind)) {
        const candidate = supplemental.bySourceKey.get(record.sourceKey);
        if (!candidate) throw new JiaowubaoDirectProjectionError("invalid_preflight", "A supplemental preflight record has no compiler decision.");
        const projection = frozen({
          sourceKey: record.sourceKey,
          resolution: candidate.resolution,
          identityProof: candidate.identityProof,
        });
        chunkSupplemental.push(projection);
        if (candidate.resolution.state === "attached") supplementalAttached += 1;
        else {
          supplementalQuarantined += 1;
          addReason(supplementalReasons, candidate.resolution);
        }
        continue;
      }
      if (record.kind === "schedule_event") {
        const source = sourcePayload(record);
        const names = scheduleNames(source);
        const teacher = teacherForSchedule(source, authority);
        const sourceClassification = nonOperationalScheduleReason(source);
        if (sourceClassification) nonOperational[sourceClassification] += 1;
        if (!cleanText(source.course)) sourceCourseMissing += 1;
        if (teacher.resolution === "exact_name") exactTeachers += 1;
        else if (teacher.resolution === "unresolved") unresolvedTeachers += 1;
        else if (teacher.resolution === "ambiguous") ambiguousTeachers += 1;
        else missingTeachers += 1;
        const scheduleParticipants = names.map((name, index) => participantProjection(
          name,
          index,
          chunk.chunk.index,
          supplemental.proofByName,
          authority,
        ));
        for (const participant of scheduleParticipants) {
          participants += 1;
          if (participant.resolution.state === "attached") attachedParticipants += 1;
          else {
            quarantinedParticipants += 1;
            addReason(participantReasons, participant.resolution);
          }
        }
        const blocksTeacherAva = scheduleTemporalResolved(record)
          && !sourceClassification
          && teacher.resolution === "exact_name"
          // Existing JWB schedule cells remove a teacher's occupied time.
          // Subject labels are intentionally unresolved in this import and
          // must not make an otherwise valid current class disappear from AVA.
          && scheduleParticipants.some((participant) => participant.resolution.state === "attached");
        if (blocksTeacherAva) availabilityBlocks += 1;
        else displayOnly += 1;
        scheduleEvents.push(frozen({
          sourceKey: record.sourceKey,
          teacherResolution: teacher.resolution,
          teacherId: teacher.teacherId,
          availabilityEffect: blocksTeacherAva ? "blocks_teacher_ava" : "display_only",
          participants: frozen(scheduleParticipants),
        }));
        continue;
      }
      if (record.kind === "leave_makeup") {
        const source = sourcePayload(record);
        const identity = identityFromSource(source);
        const resolution = resolveCurrentTencentStudent(identity.name, undefined, false, authority).resolution;
        const kind = incidentKind(source);
        if (kind === "leave") leaveCount += 1;
        else if (kind === "makeup") makeupCount += 1;
        else unknownLeaveCount += 1;
        if (resolution.state === "attached") attachedLeaves += 1;
        else {
          quarantinedLeaves += 1;
          addReason(leaveReasons, resolution);
        }
        leaveMakeups.push(frozen({ sourceKey: record.sourceKey, incidentKind: kind, resolution }));
        continue;
      }
      throw new JiaowubaoDirectProjectionError("invalid_preflight", "A direct preflight record has an unsupported kind.");
    }
    const projection = frozen({
      supplemental: frozen(chunkSupplemental),
      scheduleEvents: frozen(scheduleEvents),
      leaveMakeups: frozen(leaveMakeups),
    });
    compiledChunks.push(frozen({
      chunk,
      projection,
      projectionSha256: sha256(canonicalJson(projection)),
    }));
  }

  const expectedCounts = frozen({
    supplementalRecords: supplemental.candidates.length,
    scheduleEvents: prepared.recordCounts.schedule_event,
    scheduleParticipants: participants,
    leaveMakeups: prepared.recordCounts.leave_makeup,
  });
  const envelope = frozen({
    format: JIAOWUBAO_DIRECT_IMPORT_FORMAT,
    sourceId: JIAOWUBAO_DIRECT_IMPORT_SOURCE_ID,
    revision: prepared.revision,
    sourceTimezone: "Australia/Melbourne" as const,
    sourceTimezoneBasis: prepared.chunks[0].sourceTimezoneBasis,
    masterSource: frozen({
      sourceId: authorityInput.masterSource.sourceId,
      revision: authorityInput.masterSource.revision,
      rowsSha256: authorityInput.masterSource.rowsSha256,
    }),
    workbooks: prepared.workbooks,
    recordCounts: prepared.recordCounts,
    expectedCounts,
    chunkCount: prepared.chunks.length,
  });
  const report = frozen({
    format: JIAOWUBAO_DIRECT_IMPORT_FORMAT,
    revision: prepared.revision,
    authority: authority.report,
    expectedCounts,
    supplemental: frozen({
      attached: supplementalAttached,
      quarantined: supplementalQuarantined,
      identityProofs: supplemental.candidates.filter((candidate) => candidate.identityProof).length,
      quarantinedByReason: frozen(supplementalReasons),
    }),
    schedule: frozen({
      events: prepared.recordCounts.schedule_event,
      blocksTeacherAva: availabilityBlocks,
      displayOnly,
      exactTeachers,
      unresolvedTeachers,
      ambiguousTeachers,
      missingTeachers,
      subjectResolution: frozen({
        unresolved: prepared.recordCounts.schedule_event,
        sourceCourseMissing,
      }),
      nonOperationalByReason: frozen(nonOperational),
      participants,
      attachedParticipants,
      quarantinedParticipants,
      quarantinedByReason: frozen(participantReasons),
    }),
    leaveMakeups: frozen({
      leave: leaveCount,
      makeup: makeupCount,
      unknown: unknownLeaveCount,
      attached: attachedLeaves,
      quarantined: quarantinedLeaves,
      quarantinedByReason: frozen(leaveReasons),
    }),
  });
  return frozen({ envelope, chunks: frozen(compiledChunks), report });
}

function validActor(actor: string) {
  const cleanActor = trimText(actor);
  if (!cleanActor || cleanActor !== actor || cleanActor.length > 120) {
    throw new JiaowubaoDirectProjectionError("invalid_actor", "The direct import actor is invalid.");
  }
  return cleanActor;
}

/**
 * Build a local-only trusted-writer plan. The caller is responsible for one
 * server-side transaction in the exact begin → stage* → complete order.
 */
export function buildJiaowubaoDirectSequentialImportPlan(
  compiled: JiaowubaoDirectCompiledImport,
  actor: string,
): JiaowubaoDirectSequentialImportPlan {
  const cleanActor = validActor(actor);
  const stages = frozen(compiled.chunks.map((entry) => frozen({ chunk: entry.chunk, projection: entry.projection })));
  return frozen({
    begin: frozen({ envelope: compiled.envelope, actor: cleanActor }),
    stages,
    complete: frozen({ actor: cleanActor }),
  });
}

/**
 * Build a small-fixture/replay-only wrapper for the database's atomic test
 * RPC. It refuses the real Excel batch by construction; production callers
 * must use `buildJiaowubaoDirectSequentialImportPlan` with a trusted local
 * transaction writer.
 */
export function buildJiaowubaoDirectAtomicImportRequest(
  compiled: JiaowubaoDirectCompiledImport,
  actor: string,
): JiaowubaoDirectAtomicImportRequest {
  const plan = buildJiaowubaoDirectSequentialImportPlan(compiled, actor);
  if (plan.stages.length > MAX_JIAOWUBAO_DIRECT_ATOMIC_FIXTURE_CHUNKS) {
    throw new JiaowubaoDirectProjectionError(
      "atomic_fixture_too_large",
      "The atomic direct-import wrapper is limited to small fixtures; use the sequential trusted-writer plan.",
    );
  }
  const request = frozen({
    ...plan.begin.envelope,
    actor: plan.begin.actor,
    chunks: plan.stages,
  });
  if (Buffer.byteLength(canonicalJson(request), "utf8") > MAX_JIAOWUBAO_DIRECT_ATOMIC_FIXTURE_BYTES) {
    throw new JiaowubaoDirectProjectionError(
      "atomic_fixture_too_large",
      "The atomic direct-import wrapper is limited to small fixtures; use the sequential trusted-writer plan.",
    );
  }
  return request;
}
