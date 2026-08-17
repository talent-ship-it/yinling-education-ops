import { createHash, createHmac } from "node:crypto";

import { DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER } from "@/lib/demo-users";
import {
  adaptJiaowubaoImportRows,
  JiaowubaoImportError,
  type JiaowubaoImportErrorCode,
  type JiaowubaoNegativeAdjustmentPolicy,
  type RawJiaowubaoContract,
  type RawJiaowubaoCourse,
  type RawJiaowubaoCourseBalance,
  type RawJiaowubaoStudent,
} from "@/lib/jiaowubao-import";
import {
  applyMasterStudentDuplicateResolutions,
  buildStudentImportPlan,
  findMasterStudentDuplicateGroups,
  importLessonPackagesForStudent,
  isMasterStudentStatus,
  MASTER_STUDENT_STATUSES,
  normalizeStudentImportName,
  STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1,
  StudentImportError,
  studentIdForMasterSource,
  type ExistingStudentImportRecord,
  type JwbStudentImportRow,
  type MasterStudentImportRow,
  type MasterStudentDuplicateResolution,
  type MasterStudentStatus,
  type StudentImportPlan,
  type StudentImportIdentityLink,
  type StudentImportSourceKey,
} from "@/lib/student-import";
import type { OpsStateRow, StudentImportSourceRowsSnapshot } from "@/lib/ops-store";

const FINGERPRINT_CONTRACT = "student-import-plan-v8-strict-or-reviewed-jwb-annotation-match";
const FORMAL_IDENTITY_STRATEGY = "current-revision-reviewed-link-or-namespaced-id-v1";
const MASTER_DUPLICATE_RESOLUTION_CONTRACT = "student-import-master-duplicate-resolution-v1";
const IDENTITY_REVIEW_CANDIDATE_CONTRACT = "student-import-identity-review-candidate-v1";
const IDENTITY_REVIEW_RESOLUTION_CONTRACT = "student-import-identity-review-v1";
const IDENTITY_REVIEW_CLEAR_CONTRACT = "student-import-identity-review-clear-v1";
const IDENTITY_REVIEW_MANUAL_TOKEN_CONTRACT = "student-import-identity-review-manual-token-v2-hmac";
const SELECTABLE_MASTER_DUPLICATE_STATUSES = MASTER_STUDENT_STATUSES.filter((status) =>
  status !== "不活跃 + 无课时");
const JWB_REQUIRED_MASTER_STATUSES = new Set<MasterStudentStatus>([
  "在读",
  "活跃 + 有课时",
  "不活跃 + 有课时",
  "在读 + 加课待排",
]);
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_CLIENT_PLAN_FIELDS = ["students", "masterRows", "jwbRows", "actions", "plan"] as const;
const COMMIT_REQUEST_FIELDS = new Set(["planFingerprint", "expectedStudentVersion"]);
const MAX_SOURCE_RECORDS = 10_000;
const JIAOWUBAO_RAW_SOURCE_FORMAT = "jiaowubao-api-v2" as const;
const NORMALIZED_SOURCE_INGEST_REQUEST_FIELDS = new Set(["sourceKind", "sourceId", "revision", "rows"]);
const RAW_JWB_SOURCE_INGEST_REQUEST_FIELDS = new Set([
  "sourceKind",
  "sourceFormat",
  "sourceId",
  "revision",
  "negativeAdjustmentPolicy",
  "students",
  "contracts",
  "courseBalances",
  "courses",
]);
// `教务宝学员编号` is the exact header in the authoritative Tencent master
// sheet. The normalized import contract persists it as `jwbMemId` so the
// database and plan can share a stable, language-neutral field name.
const MASTER_JWB_MEMBER_ID_HEADER = "教务宝学员编号";
const MASTER_SOURCE_ROW_FIELDS = new Set([
  "sourceRow",
  "name",
  "status",
  "jwbMemId",
  MASTER_JWB_MEMBER_ID_HEADER,
  "attributes",
]);
const MASTER_ATTRIBUTE_FIELDS = new Set(["location", "year", "owner", "planner"]);
const MASTER_ATTRIBUTE_TEXT_LIMIT = 120;
const JWB_SOURCE_ROW_FIELDS = new Set([
  "sourceRow",
  "name",
  "remainingHours",
  "contractHours",
  "contractEffectiveDate",
  "firstJwbHourEntryDate",
  "lessonPackages",
  "packageCoverage",
  "attributes",
]);
const RAW_JWB_STUDENT_FIELDS = new Set([
  "mem_id",
  "name",
  "mem_name",
  "ks_total",
  "ks_used",
  "ks_rest",
]);
const RAW_JWB_CONTRACT_FIELDS = new Set([
  "contract_id",
  "contract_code",
  "mem_id",
  "course_id",
  "course_title",
  "nature",
  "nature_title",
  "ks",
  "ks_use",
  "ks_left",
  "dated",
  "contract_dated",
  "start",
  "end",
  "detail_lists",
]);
const RAW_JWB_CONTRACT_DETAIL_FIELDS = new Set([
  "detail_id",
  "course_id",
  "course_title",
  "ks",
  "ks_left",
  "end",
]);
const RAW_JWB_COURSE_FIELDS = new Set(["course_id", "title"]);
const RAW_JWB_COURSE_BALANCE_FIELDS = new Set([
  "mem_id",
  "ks_total",
  "ks_used",
  "ks_rest",
  "courses",
]);
const RAW_JWB_COURSE_BALANCE_COURSE_FIELDS = new Set([
  "course_id",
  "title",
  "ks",
  "ks_use",
  "ks_left",
]);

type RecordValue = Record<string, unknown>;

const JWB_PACKAGE_IMPORT_STATUSES = new Set([
  "aggregate_only_missing_purchase_history",
  "aggregate_only_negative_adjustment",
  "aggregate_only_negative_balance",
  "aggregate_only_negative_balance_and_adjustment",
  "aggregate_only_no_current_courses",
  "packages_from_current_balances_with_negative_adjustment_audit",
  "packages_from_current_course_balances",
  "partial_packages_unresolved_course_balances",
]);
const JWB_PACKAGE_IMPORT_FIELDS = new Set([
  "status",
  "currentTotalHours",
  "currentUsedHours",
  "currentRemainingHours",
  "unresolvedCourseBalances",
  "adjustmentContracts",
]);
const JWB_UNRESOLVED_COURSE_FIELDS = new Set([
  "courseId",
  "title",
  "totalHours",
  "usedHours",
  "remainingHours",
]);
const JWB_ADJUSTMENT_CONTRACT_FIELDS = new Set([
  "contractId",
  "nature",
  "courseId",
  "hoursDelta",
]);

export type StudentImportDryRunResponse = Readonly<{
  planFingerprint: string;
  expectedStudentVersion: number;
  canCommit: boolean;
  sources: Readonly<{
    master: Readonly<{ sourceId: string; revision: string; rowCount: number }>;
    jwb: Readonly<{ sourceId: string; revision: string; rowCount: number }>;
  }>;
  identityLinkCount: number;
  identityCoverage: Readonly<{
    requiredMasterRows: number;
    matchedRequiredMasterRows: number;
    missingRequiredMasterRows: number;
    ready: boolean;
  }>;
  masterDuplicateResolutions: readonly MasterDuplicateResolutionCandidate[];
  summary: StudentImportPlan["summary"];
  excluded: StudentImportPlan["excluded"];
  unmatched: StudentImportPlan["unmatched"];
  ambiguous: readonly Readonly<{
    kind: StudentImportPlan["ambiguous"][number]["kind"];
    masterSourceRows: readonly StudentImportSourceKey[];
    jwbSourceRows: readonly StudentImportSourceKey[];
    existingStudentCount: number;
  }>[];
}>;

export type MasterDuplicateResolutionDecision = "select" | "ignore";

export type StudentIdentityReviewDecision = "merge" | "create";

export type StudentIdentityReviewOption = Readonly<{
  resolutionKey: string;
  decision: StudentIdentityReviewDecision;
  label: string;
}>;

export type StudentIdentityReviewCandidate = Readonly<{
  candidateKey: string;
  master: Readonly<{ name: string; sourceRow: StudentImportSourceKey }>;
  jwb: Readonly<{ name: string; sourceRow: StudentImportSourceKey }>;
  existing?: Readonly<{ name: string; sourceRow?: StudentImportSourceKey }>;
  existingMatchCount: number;
  options: readonly StudentIdentityReviewOption[];
  blockedReason?: "existing_identity_ambiguous" | "identity_already_used" | "derived_identity_conflict";
  persistenceContract: "student_identity_review_v1";
}>;

export type StudentIdentityReviewRequest = Readonly<{
  resolutionKey: string;
  decision: StudentIdentityReviewDecision;
}>;

export type StudentIdentityReviewClearRequest = Readonly<{
  resolutionKey: string;
  decision: "clear";
}>;

export type StudentIdentityManualReview = Readonly<{
  masters: readonly Readonly<{
    token: string;
    name: string;
    sourceRow: StudentImportSourceKey;
    status: MasterStudentStatus;
  }>[];
  jwb: readonly Readonly<{
    token: string;
    name: string;
    sourceRow: StudentImportSourceKey;
  }>[];
  existing: readonly Readonly<{
    token: string;
    name: string;
    sourceRow?: StudentImportSourceKey;
    status?: string;
    segment?: string;
  }>[];
}>;

export type StudentIdentityManualReviewRequest = Readonly<{
  masterToken: string;
  jwbToken: string;
  decision: StudentIdentityReviewDecision;
  existingToken?: string;
}>;

export type MasterDuplicateResolutionOption = Readonly<{
  resolutionKey: string;
  decision: MasterDuplicateResolutionDecision;
  label: string;
  selectedSourceRow?: StudentImportSourceKey;
  selectedStatus?: MasterStudentStatus;
}>;

export type MasterDuplicateResolutionCandidate = Readonly<{
  candidateKey: string;
  sourceRows: readonly Readonly<{
    sourceRow: StudentImportSourceKey;
    status: string;
    attributes?: Readonly<Partial<Record<"location" | "year" | "owner" | "planner", string>>>;
  }>[];
  options: readonly MasterDuplicateResolutionOption[];
  persistenceContract: "student_master_duplicate_resolution_v1";
}>;

export type MasterDuplicateResolutionRequest = Readonly<{
  resolutionKey: string;
  decision: MasterDuplicateResolutionDecision;
}>;

export type PreparedStudentImport = Readonly<{
  plan: StudentImportPlan;
  response: StudentImportDryRunResponse;
  sourceRevisions: Readonly<{
    master: string;
    jwb: string;
    identityLinks: string;
    masterDuplicateResolutions: string;
    fuAttachments: string;
    bookingsVersion: number;
  }>;
}>;

export type StudentImportCommitRequest = Readonly<{
  planFingerprint: string;
  expectedStudentVersion: number;
}>;

export type StudentImportSourceKind = "master" | "jwb";

/**
 * Decodes the deliberately narrow database DETAIL emitted when a formal
 * import source is absent. Unknown detail stays unknown instead of guessing
 * that both sources are missing.
 */
export function parseStudentImportSourceUnavailableDetail(
  value: unknown,
): readonly StudentImportSourceKind[] | null {
  if (typeof value !== "string") return null;
  const match = /^missing_sources=(master|jwb)(?:,(master|jwb))?$/.exec(value.trim());
  if (!match) return null;
  const sources = new Set<StudentImportSourceKind>(
    match.slice(1).filter((source): source is StudentImportSourceKind =>
      source === "master" || source === "jwb"),
  );
  if (sources.size !== match.slice(1).filter(Boolean).length) return null;
  return (["master", "jwb"] as const).filter((source) => sources.has(source));
}

export type StudentImportSourceIngestRequest = Readonly<{
  sourceKind: StudentImportSourceKind;
  sourceId: string;
  revision: string;
  rows: readonly MasterStudentImportRow[] | readonly JwbStudentImportRow[];
}>;

export type StudentImportServiceErrorCode =
  | "invalid_source_snapshot"
  | "invalid_students_state"
  | "invalid_commit_request"
  | "invalid_source_ingest_request"
  | "invalid_jiaowubao_source"
  | "invalid_master_duplicate_resolution_request"
  | "master_duplicate_resolution_unavailable"
  | "invalid_identity_review_request"
  | "identity_review_unavailable"
  | "client_plan_forbidden"
  | "ambiguous_plan"
  | "insufficient_identity_coverage"
  | "empty_plan"
  | "stale_plan"
  | "stale_students_version";

export class StudentImportServiceError extends Error {
  constructor(
    readonly code: StudentImportServiceErrorCode,
    message: string,
    readonly sourceErrorCode?: JiaowubaoImportErrorCode,
  ) {
    super(message);
    this.name = "StudentImportServiceError";
  }
}

function unsupportedFields(value: RecordValue, fields: ReadonlySet<string>) {
  return Object.keys(value).filter((field) => !fields.has(field));
}

function strictRawRecord(value: unknown, fields: ReadonlySet<string>, label: string) {
  if (!isRecord(value)) {
    throw new StudentImportServiceError(
      "invalid_source_ingest_request",
      `${label} must be an object.`,
    );
  }
  const unsupported = unsupportedFields(value, fields);
  if (unsupported.length) {
    throw new StudentImportServiceError(
      "invalid_source_ingest_request",
      `${label} contains unsupported fields: ${unsupported.join(", ")}.`,
    );
  }
  return value;
}

function optionalRawText(value: unknown) {
  return value === undefined || value === null || typeof value === "string";
}

function rawJiaowubaoStudents(value: readonly unknown[]) {
  return value.map((item, index) => {
    const student = strictRawRecord(item, RAW_JWB_STUDENT_FIELDS, `JWB student ${index + 1}`);
    if (!optionalRawText(student.name) || !optionalRawText(student.mem_name)) {
      throw new StudentImportServiceError(
        "invalid_source_ingest_request",
        `JWB student ${index + 1} name fields must be text or null.`,
      );
    }
    return student as unknown as RawJiaowubaoStudent;
  });
}

function rawJiaowubaoContracts(value: readonly unknown[]) {
  return value.map((item, index) => {
    const contract = strictRawRecord(item, RAW_JWB_CONTRACT_FIELDS, `JWB contract ${index + 1}`);
    for (const field of ["contract_code", "dated", "contract_dated", "start", "end"] as const) {
      if (!optionalRawText(contract[field])) {
        throw new StudentImportServiceError(
          "invalid_source_ingest_request",
          `JWB contract ${index + 1} ${field} must be text or null.`,
        );
      }
    }
    if (!Array.isArray(contract.detail_lists)) {
      throw new StudentImportServiceError(
        "invalid_source_ingest_request",
        `JWB contract ${index + 1} detail_lists must be an array.`,
      );
    }
    const detailLists = contract.detail_lists.map((detail, detailIndex) => {
      const parsed = strictRawRecord(
        detail,
        RAW_JWB_CONTRACT_DETAIL_FIELDS,
        `JWB contract ${index + 1} detail ${detailIndex + 1}`,
      );
      if (!optionalRawText(parsed.course_title) || !optionalRawText(parsed.end)) {
        throw new StudentImportServiceError(
          "invalid_source_ingest_request",
          `JWB contract ${index + 1} detail text fields must be text or null.`,
        );
      }
      return parsed;
    });
    return { ...contract, detail_lists: detailLists } as unknown as RawJiaowubaoContract;
  });
}

function rawJiaowubaoCourses(value: readonly unknown[]) {
  return value.map((item, index) =>
    strictRawRecord(item, RAW_JWB_COURSE_FIELDS, `JWB course ${index + 1}`) as unknown as RawJiaowubaoCourse);
}

function rawJiaowubaoCourseBalances(value: readonly unknown[]) {
  return value.map((item, index) => {
    const balance = strictRawRecord(
      item,
      RAW_JWB_COURSE_BALANCE_FIELDS,
      `JWB course balance ${index + 1}`,
    );
    if (!Array.isArray(balance.courses) || balance.courses.length > 1_000) {
      throw new StudentImportServiceError(
        "invalid_source_ingest_request",
        `JWB course balance ${index + 1} courses must contain at most 1,000 rows.`,
      );
    }
    const courses = balance.courses.map((course, courseIndex) =>
      strictRawRecord(
        course,
        RAW_JWB_COURSE_BALANCE_COURSE_FIELDS,
        `JWB course balance ${index + 1} course ${courseIndex + 1}`,
      ));
    return { ...balance, courses } as unknown as RawJiaowubaoCourseBalance;
  });
}

export function hasStudentImportAdminAccess(actor: string | null, fullAdmin: boolean) {
  return actor === DEMO_LIMITED_ADMIN_USER || (actor === DEMO_ADMIN_USER && fullAdmin);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.entries(value as RecordValue)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(",")}}`;
}

function canonicalSourceKey(value: unknown): StudentImportSourceKey | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean && clean.length <= 240 ? clean : undefined;
}

function sourceKey(value: unknown): value is StudentImportSourceKey {
  return canonicalSourceKey(value) !== undefined;
}

function sourceIdentity(value: unknown, label: string) {
  if (!isRecord(value) || typeof value.sourceId !== "string" || !value.sourceId.trim()) {
    throw new StudentImportServiceError("invalid_source_snapshot", `${label} sourceId is missing.`);
  }
  if (typeof value.revision !== "string" || !value.revision.trim() || !Array.isArray(value.rows)) {
    throw new StudentImportServiceError("invalid_source_snapshot", `${label} revision or rows are missing.`);
  }
  return { sourceId: value.sourceId.trim(), revision: value.revision.trim(), rows: value.rows };
}

function studentIdentityLinks(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_RECORDS) {
    throw new StudentImportServiceError("invalid_source_snapshot", "Student identity links are invalid.");
  }
  const masterRowsSeen = new Set<string>();
  const jwbRowsSeen = new Set<string>();
  const studentIdsSeen = new Set<string>();
  return value.map((link): StudentImportSourceRowsSnapshot["identityLinks"][number] => {
    if (!isRecord(link)
      || Object.keys(link).some((field) => ![
        "masterSourceRow", "jwbSourceRow", "studentId", "matchStrategy",
      ].includes(field))
      || !sourceKey(link.masterSourceRow)
      || (link.jwbSourceRow !== undefined && link.jwbSourceRow !== null && !sourceKey(link.jwbSourceRow))
      || (link.matchStrategy !== undefined
        && link.matchStrategy !== STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1)
      || typeof link.studentId !== "string"
      || !link.studentId.trim()
      || link.studentId.length > 240) {
      throw new StudentImportServiceError("invalid_source_snapshot", "Student identity links are invalid.");
    }
    const masterSourceRow = canonicalSourceKey(link.masterSourceRow)!;
    const jwbSourceRow = link.jwbSourceRow === undefined || link.jwbSourceRow === null
      ? undefined
      : canonicalSourceKey(link.jwbSourceRow)!;
    const masterKey = String(masterSourceRow);
    const jwbKey = jwbSourceRow === undefined ? undefined : String(jwbSourceRow);
    const studentId = link.studentId.trim();
    const matchStrategy = link.matchStrategy === undefined
      ? undefined
      : STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1;
    if (matchStrategy !== undefined && jwbSourceRow === undefined) {
      throw new StudentImportServiceError("invalid_source_snapshot", "Student identity link strategy requires a JWB source row.");
    }
    if (masterRowsSeen.has(masterKey)
      || (jwbKey !== undefined && jwbRowsSeen.has(jwbKey))
      || studentIdsSeen.has(studentId)) {
      throw new StudentImportServiceError("invalid_source_snapshot", "Student identity links must be one-to-one.");
    }
    masterRowsSeen.add(masterKey);
    if (jwbKey !== undefined) jwbRowsSeen.add(jwbKey);
    studentIdsSeen.add(studentId);
    return {
      masterSourceRow,
      ...(jwbKey !== undefined ? {
        jwbSourceRow,
      } : {}),
      studentId,
      ...(matchStrategy !== undefined ? { matchStrategy } : {}),
    };
  });
}

function studentNumberReservations(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_RECORDS) {
    throw new StudentImportServiceError("invalid_source_snapshot", "Student number reservations are invalid.");
  }
  const studentIds = new Set<string>();
  const studentNumbers = new Set<string>();
  return value.map((reservation): StudentImportSourceRowsSnapshot["studentNumberReservations"][number] => {
    if (!isRecord(reservation)
      || Object.keys(reservation).some((field) => field !== "studentId" && field !== "studentNumber")
      || Object.keys(reservation).length !== 2
      || typeof reservation.studentId !== "string"
      || !reservation.studentId.trim()
      || reservation.studentId !== reservation.studentId.trim()
      || reservation.studentId.length > 240
      || typeof reservation.studentNumber !== "string"
      || !/^\d{11}$/.test(reservation.studentNumber)
      || studentIds.has(reservation.studentId)
      || studentNumbers.has(reservation.studentNumber)) {
      throw new StudentImportServiceError("invalid_source_snapshot", "Student number reservations are invalid.");
    }
    studentIds.add(reservation.studentId);
    studentNumbers.add(reservation.studentNumber);
    return {
      studentId: reservation.studentId,
      studentNumber: reservation.studentNumber,
    };
  });
}

function masterDuplicateResolutionSnapshot(value: unknown): readonly MasterStudentDuplicateResolution[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_RECORDS) {
    throw new StudentImportServiceError("invalid_source_snapshot", "Student master duplicate resolutions are invalid.");
  }
  const groupKeys = new Set<string>();
  return value.map((resolution): MasterStudentDuplicateResolution => {
    if (!isRecord(resolution)
      || Object.keys(resolution).some((field) => ![
        "decision", "sourceRows", "selectedSourceRow", "selectedStatus", "selectedStudentId",
      ].includes(field))
      || (resolution.decision !== "select" && resolution.decision !== "ignore")
      || !Array.isArray(resolution.sourceRows)
      || resolution.sourceRows.length < 2
      || resolution.sourceRows.length > 100
      || !resolution.sourceRows.every(sourceKey)
      || new Set(resolution.sourceRows.map((row) => String(row).trim())).size !== resolution.sourceRows.length) {
      throw new StudentImportServiceError("invalid_source_snapshot", "Student master duplicate resolutions are invalid.");
    }
    const sourceRows = resolution.sourceRows.map((row) => canonicalSourceKey(row)!);
    const groupKey = resolutionGroupKey(sourceRows);
    if (groupKeys.has(groupKey)) {
      throw new StudentImportServiceError("invalid_source_snapshot", "Student master duplicate resolution groups must be unique.");
    }
    groupKeys.add(groupKey);
    if (resolution.decision === "ignore") {
      if (resolution.selectedSourceRow !== undefined
        || resolution.selectedStatus !== undefined
        || resolution.selectedStudentId !== undefined) {
        throw new StudentImportServiceError("invalid_source_snapshot", "Ignored duplicate groups cannot select a row.");
      }
      return { decision: "ignore", sourceRows };
    }
    if (!sourceKey(resolution.selectedSourceRow)
      || !sourceRows.map((row) => String(row).trim()).includes(String(resolution.selectedSourceRow).trim())
      || (resolution.selectedStatus !== undefined && !isMasterStudentStatus(resolution.selectedStatus))
      || (resolution.selectedStudentId !== undefined
        && (typeof resolution.selectedStudentId !== "string"
          || !resolution.selectedStudentId.trim()
          || resolution.selectedStudentId.length > 240))) {
      throw new StudentImportServiceError("invalid_source_snapshot", "Selected duplicate resolution is invalid.");
    }
    return {
      decision: "select",
      sourceRows,
      selectedSourceRow: canonicalSourceKey(resolution.selectedSourceRow)!,
      ...(resolution.selectedStatus !== undefined
        ? { selectedStatus: resolution.selectedStatus as MasterStudentStatus }
        : {}),
      ...(typeof resolution.selectedStudentId === "string"
        ? { selectedStudentId: resolution.selectedStudentId.trim() }
        : {}),
    };
  });
}

function strictTrimmedText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new StudentImportServiceError("invalid_source_snapshot", `${label} must be text.`);
  }
  const clean = value.trim();
  if (!clean || clean.length > maxLength) {
    throw new StudentImportServiceError(
      "invalid_source_snapshot",
      `${label} must contain 1 to ${maxLength} characters.`,
    );
  }
  return clean;
}

function masterAttributes(value: unknown) {
  if (value === undefined) return undefined;
  if (!isRecord(value) || unsupportedFields(value, MASTER_ATTRIBUTE_FIELDS).length) {
    throw new StudentImportServiceError(
      "invalid_source_snapshot",
      "Master attributes may contain only location, year, owner and planner.",
    );
  }
  const result: Record<string, string> = {};
  for (const field of MASTER_ATTRIBUTE_FIELDS) {
    if (value[field] !== undefined) {
      result[field] = strictTrimmedText(
        value[field],
        `Master attribute ${field}`,
        MASTER_ATTRIBUTE_TEXT_LIMIT,
      );
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function optionalMasterJwbMemberId(value: unknown, field: string) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return undefined;
  }
  const memberId = canonicalSourceKey(value);
  if (memberId === undefined) {
    throw new StudentImportServiceError(
      "invalid_source_snapshot",
      `${field} must be a stable string or integer when supplied.`,
    );
  }
  return memberId;
}

function masterJwbMemberId(row: RecordValue) {
  const canonical = optionalMasterJwbMemberId(row.jwbMemId, "Master jwbMemId");
  const tencentHeader = optionalMasterJwbMemberId(
    row[MASTER_JWB_MEMBER_ID_HEADER],
    `Master ${MASTER_JWB_MEMBER_ID_HEADER}`,
  );
  if (canonical !== undefined && tencentHeader !== undefined) {
    throw new StudentImportServiceError(
      "invalid_source_snapshot",
      "Master rows may supply either jwbMemId or 教务宝学员编号, not both.",
    );
  }
  return canonical ?? tencentHeader;
}

function masterRows(value: unknown, options?: { allowBlankDuplicateStatus?: boolean }): readonly MasterStudentImportRow[] {
  const source = sourceIdentity(value, "Master");
  return source.rows.map((row) => {
    if (!isRecord(row)
      || !sourceKey(row.sourceRow)
      || typeof row.name !== "string"
      || typeof row.status !== "string"
      || Object.keys(row).some((field) => !MASTER_SOURCE_ROW_FIELDS.has(field))) {
      throw new StudentImportServiceError("invalid_source_snapshot", "Master source rows do not match the import contract.");
    }
    const name = strictTrimmedText(row.name, "Master student name", 240);
    const status = row.status.trim();
    if (!isMasterStudentStatus(status) && !(options?.allowBlankDuplicateStatus && status === "")) {
      throw new StudentImportServiceError("invalid_source_snapshot", "Master source rows do not match the import contract.");
    }
    const attributes = masterAttributes(row.attributes);
    const jwbMemId = masterJwbMemberId(row);
    return {
      sourceRow: canonicalSourceKey(row.sourceRow)!,
      name,
      status,
      ...(jwbMemId !== undefined ? { jwbMemId } : {}),
      ...(attributes ? { attributes } : {}),
    };
  });
}

function hasMicrohourPrecision(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000 === value
    && Math.abs(value * 1_000_000) <= Number.MAX_SAFE_INTEGER;
}

function strictInternalNumber(value: unknown, label: string, options?: { nonNegative?: boolean }) {
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || !hasMicrohourPrecision(value)
    || (options?.nonNegative && value < 0)) {
    throw new StudentImportServiceError(
      "invalid_source_snapshot",
      `${label} must be a ${options?.nonNegative ? "non-negative " : ""}finite number with at most six decimal places.`,
    );
  }
  return value;
}

function internalJwbAttributes(value: unknown) {
  if (value === undefined) return undefined;
  if (!isRecord(value)
    || Object.keys(value).length !== 1
    || !isRecord(value.jiaowubaoPackageImport)) {
    throw new StudentImportServiceError(
      "invalid_source_snapshot",
      "JWB attributes may contain only the internal package import audit.",
    );
  }
  const audit = value.jiaowubaoPackageImport;
  if (unsupportedFields(audit, JWB_PACKAGE_IMPORT_FIELDS).length
    || typeof audit.status !== "string"
    || !JWB_PACKAGE_IMPORT_STATUSES.has(audit.status)) {
    throw new StudentImportServiceError("invalid_source_snapshot", "JWB package import audit is invalid.");
  }
  const currentTotalHours = strictInternalNumber(
    audit.currentTotalHours,
    "JWB currentTotalHours",
    { nonNegative: true },
  );
  const currentUsedHours = strictInternalNumber(
    audit.currentUsedHours,
    "JWB currentUsedHours",
    { nonNegative: true },
  );
  const currentRemainingHours = strictInternalNumber(
    audit.currentRemainingHours,
    "JWB currentRemainingHours",
  );
  if (Math.abs(currentTotalHours - currentUsedHours - currentRemainingHours) > 0.000001) {
    throw new StudentImportServiceError("invalid_source_snapshot", "JWB package import totals do not balance.");
  }

  if (audit.unresolvedCourseBalances !== undefined
    && (!Array.isArray(audit.unresolvedCourseBalances)
      || audit.unresolvedCourseBalances.length > 1_000)) {
    throw new StudentImportServiceError("invalid_source_snapshot", "JWB unresolved courses are invalid.");
  }
  const courseIds = new Set<string>();
  const unresolvedCourseBalances = (audit.unresolvedCourseBalances ?? []).map((item) => {
    if (!isRecord(item) || unsupportedFields(item, JWB_UNRESOLVED_COURSE_FIELDS).length) {
      throw new StudentImportServiceError("invalid_source_snapshot", "JWB unresolved course is invalid.");
    }
    const courseId = strictTrimmedText(item.courseId, "JWB unresolved courseId", 240);
    const title = strictTrimmedText(item.title, "JWB unresolved title", 240);
    if (courseIds.has(courseId)) {
      throw new StudentImportServiceError("invalid_source_snapshot", "JWB unresolved course IDs must be unique.");
    }
    courseIds.add(courseId);
    const totalHours = strictInternalNumber(item.totalHours, "JWB unresolved totalHours", { nonNegative: true });
    const usedHours = strictInternalNumber(item.usedHours, "JWB unresolved usedHours", { nonNegative: true });
    const remainingHours = strictInternalNumber(item.remainingHours, "JWB unresolved remainingHours");
    if (Math.abs(totalHours - usedHours - remainingHours) > 0.000001) {
      throw new StudentImportServiceError("invalid_source_snapshot", "JWB unresolved course totals do not balance.");
    }
    return { courseId, title, totalHours, usedHours, remainingHours };
  });

  if (!Array.isArray(audit.adjustmentContracts) || audit.adjustmentContracts.length > 1_000) {
    throw new StudentImportServiceError("invalid_source_snapshot", "JWB adjustment contracts are invalid.");
  }
  const contractIds = new Set<string>();
  const adjustmentContracts = audit.adjustmentContracts.map((item) => {
    if (!isRecord(item) || unsupportedFields(item, JWB_ADJUSTMENT_CONTRACT_FIELDS).length) {
      throw new StudentImportServiceError("invalid_source_snapshot", "JWB adjustment contract is invalid.");
    }
    const contractId = strictTrimmedText(item.contractId, "JWB adjustment contractId", 240);
    const nature = strictTrimmedText(item.nature, "JWB adjustment nature", 40);
    const courseId = strictTrimmedText(item.courseId, "JWB adjustment courseId", 240);
    const hoursDelta = strictInternalNumber(item.hoursDelta, "JWB adjustment hoursDelta");
    if ((nature !== "退费" && nature !== "转出") || hoursDelta > 0 || contractIds.has(contractId)) {
      throw new StudentImportServiceError("invalid_source_snapshot", "JWB adjustment contract is invalid.");
    }
    contractIds.add(contractId);
    return { contractId, nature, courseId, hoursDelta };
  });

  return {
    jiaowubaoPackageImport: {
      status: audit.status,
      currentTotalHours,
      currentUsedHours,
      currentRemainingHours,
      ...(audit.unresolvedCourseBalances !== undefined ? { unresolvedCourseBalances } : {}),
      adjustmentContracts,
    },
  };
}

function jwbRows(value: unknown): readonly JwbStudentImportRow[] {
  const source = sourceIdentity(value, "JWB");
  return source.rows.map((row) => {
    if (!isRecord(row) || !sourceKey(row.sourceRow) || typeof row.name !== "string") {
      throw new StudentImportServiceError("invalid_source_snapshot", "JWB source rows do not match the import contract.");
    }
    const parsed = row as JwbStudentImportRow;
    if (!parsed.name.trim()
      || parsed.name.trim().length > 240
      || (parsed.remainingHours !== undefined && parsed.remainingHours !== null
        && typeof parsed.remainingHours !== "number")
      || (parsed.contractHours !== undefined && parsed.contractHours !== null
        && typeof parsed.contractHours !== "number")
      || (parsed.contractEffectiveDate !== undefined && parsed.contractEffectiveDate !== null
        && typeof parsed.contractEffectiveDate !== "string")
      || (parsed.firstJwbHourEntryDate !== undefined && parsed.firstJwbHourEntryDate !== null
        && typeof parsed.firstJwbHourEntryDate !== "string")
      || !isOptionalFiniteNumber(parsed.remainingHours)
      || !isOptionalNonNegativeNumber(parsed.contractHours)
      || !isOptionalIsoDate(parsed.contractEffectiveDate)
      || !isOptionalIsoDate(parsed.firstJwbHourEntryDate)
      || (parsed.packageCoverage !== undefined
        && parsed.packageCoverage !== "complete"
        && parsed.packageCoverage !== "partial"
        && parsed.packageCoverage !== "none")
      || Object.keys(parsed).some((field) => !JWB_SOURCE_ROW_FIELDS.has(field))) {
      throw new StudentImportServiceError("invalid_source_snapshot", "JWB source rows do not match the import contract.");
    }
    const attributes = internalJwbAttributes(parsed.attributes);
    if (parsed.lessonPackages !== undefined) {
      try {
        importLessonPackagesForStudent(
          `SOURCE-${String(parsed.sourceRow).trim()}`,
          parsed.lessonPackages,
          parsed.sourceRow,
        );
      } catch (error) {
        if (error instanceof StudentImportError) {
          throw new StudentImportServiceError("invalid_source_snapshot", error.message);
        }
        throw error;
      }
    }
    const packageCount = parsed.lessonPackages?.length ?? 0;
    if ((parsed.packageCoverage === "complete" || parsed.packageCoverage === "partial") && packageCount === 0) {
      throw new StudentImportServiceError(
        "invalid_source_snapshot",
        `${parsed.packageCoverage} packageCoverage requires at least one lesson package.`,
      );
    }
    if (parsed.packageCoverage === "none" && packageCount > 0) {
      throw new StudentImportServiceError(
        "invalid_source_snapshot",
        "none packageCoverage cannot include lesson packages.",
      );
    }
    return {
      ...parsed,
      sourceRow: canonicalSourceKey(parsed.sourceRow)!,
      name: parsed.name.trim(),
      ...(attributes ? { attributes } : {}),
    };
  });
}

function isOptionalNonNegativeNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  return typeof value === "number"
    && Number.isFinite(value)
    && hasMicrohourPrecision(value)
    && value >= 0;
}

function isOptionalFiniteNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  return typeof value === "number"
    && Number.isFinite(value)
    && hasMicrohourPrecision(value);
}

function isOptionalIsoDate(value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseStudentImportSourceSnapshot(value: unknown): StudentImportSourceRowsSnapshot {
  if (!isRecord(value)) {
    throw new StudentImportServiceError("invalid_source_snapshot", "Student import source snapshot is missing.");
  }
  const master = sourceIdentity(value.master, "Master");
  const jwb = sourceIdentity(value.jwb, "JWB");
  const identityLinks = studentIdentityLinks(value.identityLinks ?? []);
  const reservations = studentNumberReservations(value.studentNumberReservations);
  if (typeof value.identityLinkFingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(value.identityLinkFingerprint)) {
    throw new StudentImportServiceError("invalid_source_snapshot", "Student identity links are invalid.");
  }
  if (!Number.isSafeInteger(value.identityReviewEpoch) || (value.identityReviewEpoch as number) < 0) {
    throw new StudentImportServiceError("invalid_source_snapshot", "Student identity review epoch is invalid.");
  }
  const masterDuplicateResolutions = masterDuplicateResolutionSnapshot(value.masterDuplicateResolutions ?? []);
  if (typeof value.masterDuplicateResolutionFingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(value.masterDuplicateResolutionFingerprint)) {
    throw new StudentImportServiceError("invalid_source_snapshot", "Student master duplicate resolutions are invalid.");
  }
  const fuAttachmentReferences = value.fuAttachmentReferences;
  if (!isRecord(fuAttachmentReferences)
    || Object.keys(fuAttachmentReferences).some((field) => field !== "studentIds" && field !== "fingerprint")
    || Object.keys(fuAttachmentReferences).length !== 2
    || !Array.isArray(fuAttachmentReferences.studentIds)
    || fuAttachmentReferences.studentIds.length > MAX_SOURCE_RECORDS
    || typeof fuAttachmentReferences.fingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(fuAttachmentReferences.fingerprint)
    || fuAttachmentReferences.studentIds.some((studentId) =>
      typeof studentId !== "string"
      || !studentId.trim()
      || studentId !== studentId.trim()
      || studentId.length > 120)
    || new Set(fuAttachmentReferences.studentIds).size !== fuAttachmentReferences.studentIds.length) {
    throw new StudentImportServiceError("invalid_source_snapshot", "Student attachment references are invalid.");
  }
  return {
    master: {
      sourceId: master.sourceId,
      revision: master.revision,
      rows: masterRows(value.master, { allowBlankDuplicateStatus: true }),
    },
    jwb: { sourceId: jwb.sourceId, revision: jwb.revision, rows: jwbRows(value.jwb) },
    identityLinks,
    identityLinkFingerprint: value.identityLinkFingerprint,
    identityReviewEpoch: value.identityReviewEpoch as number,
    masterDuplicateResolutions,
    masterDuplicateResolutionFingerprint: value.masterDuplicateResolutionFingerprint,
    fuAttachmentReferences: {
      studentIds: fuAttachmentReferences.studentIds as string[],
      fingerprint: fuAttachmentReferences.fingerprint,
    },
    studentNumberReservations: reservations,
  };
}

/**
 * Parses one explicitly uploaded source file. This never infers the source,
 * revision or freshness and never accepts a mixed master/JWB payload.
 */
export function parseStudentImportSourceIngestRequest(
  value: unknown,
): StudentImportSourceIngestRequest {
  if (!isRecord(value)) {
    throw new StudentImportServiceError(
      "invalid_source_ingest_request",
      "Source import must be an object.",
    );
  }

  if ("sourceFormat" in value) {
    return parseRawJiaowubaoSourceIngestRequest(value);
  }

  if (Object.keys(value).some((field) => !NORMALIZED_SOURCE_INGEST_REQUEST_FIELDS.has(field))
    || (value.sourceKind !== "master" && value.sourceKind !== "jwb")
    || typeof value.sourceId !== "string"
    || !value.sourceId.trim()
    || value.sourceId.length > 160
    || typeof value.revision !== "string"
    || !value.revision.trim()
    || value.revision.length > 240
    || !Array.isArray(value.rows)
    || value.rows.length < 1
    || value.rows.length > MAX_SOURCE_RECORDS) {
    throw new StudentImportServiceError(
      "invalid_source_ingest_request",
      "Source import requires sourceKind, sourceId, revision and 1 to 10,000 rows.",
    );
  }

  const source = {
    sourceId: value.sourceId.trim(),
    revision: value.revision.trim(),
    rows: value.rows,
  };
  try {
    if (value.sourceKind === "jwb") {
      throw new StudentImportServiceError(
        "invalid_source_snapshot",
        "Normalized JWB rows are not accepted; upload the strict jiaowubao-api-v2 snapshot.",
      );
    }
    const rows = masterRows(source, { allowBlankDuplicateStatus: true });
    // Full source ingestion permits a blank status only when the pure domain
    // closes it inside a current duplicate group that requires a hard option.
    findMasterStudentDuplicateGroups(rows);
    return {
      sourceKind: "master",
      sourceId: source.sourceId,
      revision: source.revision,
      rows,
    };
  } catch (error) {
    if (error instanceof StudentImportServiceError) {
      throw new StudentImportServiceError("invalid_source_ingest_request", error.message);
    }
    if (error instanceof StudentImportError) {
      throw new StudentImportServiceError("invalid_source_ingest_request", error.message);
    }
    throw error;
  }
}

function parseRawJiaowubaoSourceIngestRequest(
  value: RecordValue,
): StudentImportSourceIngestRequest {
  if (Object.keys(value).some((field) => !RAW_JWB_SOURCE_INGEST_REQUEST_FIELDS.has(field))
    || value.sourceKind !== "jwb"
    || value.sourceFormat !== JIAOWUBAO_RAW_SOURCE_FORMAT
    || typeof value.sourceId !== "string"
    || !value.sourceId.trim()
    || value.sourceId.length > 160
    || typeof value.revision !== "string"
    || !value.revision.trim()
    || value.revision.length > 240
    || (value.negativeAdjustmentPolicy !== "reject"
      && value.negativeAdjustmentPolicy !== "aggregate-only")
    || !Array.isArray(value.students)
    || value.students.length < 1
    || value.students.length > MAX_SOURCE_RECORDS
    || !Array.isArray(value.contracts)
    || value.contracts.length > MAX_SOURCE_RECORDS
    || !Array.isArray(value.courseBalances)
    || value.courseBalances.length < 1
    || value.courseBalances.length > MAX_SOURCE_RECORDS
    || (value.courses !== undefined
      && (!Array.isArray(value.courses) || value.courses.length > MAX_SOURCE_RECORDS))) {
    throw new StudentImportServiceError(
      "invalid_source_ingest_request",
      "Raw JWB import requires jiaowubao-api-v2, an explicit negative adjustment policy, 1 to 10,000 students and course balances, and at most 10,000 contracts and catalogue courses.",
    );
  }

  try {
    const students = rawJiaowubaoStudents(value.students);
    const contracts = rawJiaowubaoContracts(value.contracts);
    const courseBalances = rawJiaowubaoCourseBalances(value.courseBalances);
    const courses = value.courses === undefined
      ? undefined
      : rawJiaowubaoCourses(value.courses as readonly unknown[]);
    const rows = adaptJiaowubaoImportRows({
      students,
      contracts,
      courseBalances,
      ...(courses ? { courses } : {}),
      negativeAdjustmentPolicy: value.negativeAdjustmentPolicy as JiaowubaoNegativeAdjustmentPolicy,
    });
    if (rows.length < 1 || rows.length > MAX_SOURCE_RECORDS) {
      throw new StudentImportServiceError(
        "invalid_source_ingest_request",
        "Raw JWB adaptation must produce 1 to 10,000 student rows.",
      );
    }
    const source = {
      sourceId: value.sourceId.trim(),
      revision: value.revision.trim(),
      rows,
    };
    return {
      sourceKind: "jwb",
      sourceId: source.sourceId,
      revision: source.revision,
      rows: jwbRows(source),
    };
  } catch (error) {
    if (error instanceof JiaowubaoImportError) {
      throw new StudentImportServiceError(
        "invalid_jiaowubao_source",
        error.message,
        error.code,
      );
    }
    throw error;
  }
}

const IMPORT_PURCHASE_DATE_PATTERN = /^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))$/;

function assertCurrentLessonPackages(student: RecordValue) {
  if (student.lessonPackages === undefined) return;
  if (!Array.isArray(student.lessonPackages) || student.lessonPackages.length > 100) {
    throw new StudentImportServiceError("invalid_students_state", "Student lesson packages are invalid.");
  }
  const packageIds = new Set<string>();
  for (const packageValue of student.lessonPackages) {
    if (!isRecord(packageValue)
      || Object.keys(packageValue).some((field) =>
        !["id", "name", "subjectIds", "purchaseRecords", "consumedHours"].includes(field))
      || typeof packageValue.id !== "string"
      || !packageValue.id.trim()
      || packageValue.id.trim().length > 240
      || typeof packageValue.name !== "string"
      || !packageValue.name.trim()
      || packageValue.name.trim().length > 240
      || !Array.isArray(packageValue.subjectIds)
      || packageValue.subjectIds.length < 1
      || packageValue.subjectIds.length > 100
      || packageValue.subjectIds.some((subject) =>
        typeof subject !== "string" || !subject.trim() || subject.trim().length > 240)
      || new Set(packageValue.subjectIds.map((subject) => String(subject).trim())).size
        !== packageValue.subjectIds.length
      || !Array.isArray(packageValue.purchaseRecords)
      || packageValue.purchaseRecords.length < 1
      || packageValue.purchaseRecords.length > 1_000
      || typeof packageValue.consumedHours !== "number"
      || !Number.isFinite(packageValue.consumedHours)
      || packageValue.consumedHours < 0
      || (packageValue.id.startsWith("PKG-JWB-") && !hasMicrohourPrecision(packageValue.consumedHours))) {
      throw new StudentImportServiceError("invalid_students_state", "Student lesson packages are invalid.");
    }
    const packageId = packageValue.id.trim();
    if (packageIds.has(packageId)) {
      throw new StudentImportServiceError("invalid_students_state", "Student lesson package IDs must be unique.");
    }
    packageIds.add(packageId);
    const purchaseIds = new Set<string>();
    for (const purchaseValue of packageValue.purchaseRecords) {
      if (!isRecord(purchaseValue)
        || Object.keys(purchaseValue).some((field) => !["id", "purchasedAt", "hours", "note"].includes(field))
        || typeof purchaseValue.id !== "string"
        || !purchaseValue.id.trim()
        || purchaseValue.id.trim().length > 240
        || typeof purchaseValue.purchasedAt !== "string"
        || !IMPORT_PURCHASE_DATE_PATTERN.test(purchaseValue.purchasedAt.trim())
        || !Number.isFinite(Date.parse(purchaseValue.purchasedAt))
        || typeof purchaseValue.hours !== "number"
        || !Number.isFinite(purchaseValue.hours)
        || purchaseValue.hours <= 0
        || (packageId.startsWith("PKG-JWB-") && !hasMicrohourPrecision(purchaseValue.hours))
        || (purchaseValue.note !== undefined
          && (typeof purchaseValue.note !== "string" || purchaseValue.note.length > 1_000))) {
        throw new StudentImportServiceError("invalid_students_state", "Student lesson package purchases are invalid.");
      }
      const purchaseId = purchaseValue.id.trim();
      if (purchaseIds.has(purchaseId)) {
        throw new StudentImportServiceError("invalid_students_state", "Student lesson package purchase IDs must be unique.");
      }
      purchaseIds.add(purchaseId);
    }
  }
}

function assertCurrentJwbAggregate(student: RecordValue) {
  const coverage = student.packageCoverage;
  if (coverage === undefined) return;
  if (coverage !== "complete" && coverage !== "partial" && coverage !== "none") {
    throw new StudentImportServiceError("invalid_students_state", "Student package coverage is invalid.");
  }
  for (const [field, nonNegative] of [["remainingHours", false], ["contractHours", true]] as const) {
    const value = student[field];
    if (value !== undefined
      && (typeof value !== "number"
        || !Number.isFinite(value)
        || !hasMicrohourPrecision(value)
        || (nonNegative && value < 0))) {
      throw new StudentImportServiceError("invalid_students_state", `Student ${field} is invalid.`);
    }
  }
  const managedPackageCount = Array.isArray(student.lessonPackages)
    ? student.lessonPackages.filter((lessonPackage) =>
      isRecord(lessonPackage)
      && typeof lessonPackage.id === "string"
      && lessonPackage.id.startsWith("PKG-JWB-")).length
    : 0;
  if ((coverage === "complete" || coverage === "partial") && managedPackageCount === 0) {
    throw new StudentImportServiceError("invalid_students_state", `${coverage} package coverage needs a JWB package.`);
  }
  if (coverage === "none" && managedPackageCount > 0) {
    throw new StudentImportServiceError("invalid_students_state", "None package coverage cannot keep JWB packages.");
  }
  if (typeof student.remainingHours === "number" && student.remainingHours < 0 && coverage !== "none") {
    throw new StudentImportServiceError("invalid_students_state", "Negative balances require none package coverage.");
  }
}

function studentsState(row: OpsStateRow | undefined) {
  if (!row || row.entity !== "students" || !Number.isSafeInteger(row.version) || row.version < 0 || !Array.isArray(row.payload)) {
    throw new StudentImportServiceError("invalid_students_state", "Students state is not available for import.");
  }
  const students = row.payload.map((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || typeof value.name !== "string") {
      throw new StudentImportServiceError("invalid_students_state", "Students state contains an invalid record.");
    }
    return value as ExistingStudentImportRecord;
  });
  return { students, version: row.version };
}

const STUDENT_REFERENCE_ENTITIES = [
  "bookings", "files", "lpItems", "messages", "operations", "payroll", "renewals", "tasks",
] as const;

function referencedStudentIds(rows: readonly OpsStateRow[] | undefined) {
  if (!rows) return new Set<string>();
  const rowsByEntity = new Map(rows.map((row) => [row.entity, row]));
  const result = new Set<string>();
  for (const entity of STUDENT_REFERENCE_ENTITIES) {
    const row = rowsByEntity.get(entity);
    if (!row || !Array.isArray(row.payload) || !row.payload.every(isRecord)) {
      throw new StudentImportServiceError(
        "invalid_students_state",
        `${entity} state is not available for student import reference checks.`,
      );
    }
    for (const item of row.payload) {
      if (typeof item.studentId === "string" && item.studentId.trim()) result.add(item.studentId.trim());
      if (entity !== "bookings" || item.occurrenceOverrides === undefined) continue;
      if (!Array.isArray(item.occurrenceOverrides) || !item.occurrenceOverrides.every(isRecord)) {
        throw new StudentImportServiceError(
          "invalid_students_state",
          "bookings state contains invalid occurrence overrides for student import reference checks.",
        );
      }
      for (const override of item.occurrenceOverrides) {
        if (typeof override.studentId === "string" && override.studentId.trim()) {
          result.add(override.studentId.trim());
        }
      }
    }
  }
  return result;
}

function allReferencedStudentIds(
  rows: readonly OpsStateRow[] | undefined,
  attachmentStudentIds: readonly string[],
) {
  const result = referencedStudentIds(rows);
  for (const studentId of attachmentStudentIds) result.add(studentId);
  return result;
}

function requiredBookingsVersion(rows: readonly OpsStateRow[]) {
  const bookingRows = rows.filter((row) => row.entity === "bookings");
  const [bookingsRow] = bookingRows;
  if (bookingRows.length !== 1
    || !bookingsRow
    || !Number.isSafeInteger(bookingsRow.version)
    || bookingsRow.version < 0
    || !Array.isArray(bookingsRow.payload)
    || !bookingsRow.payload.every(isRecord)) {
    throw new StudentImportServiceError(
      "invalid_students_state",
      "Bookings state is not available for student import concurrency checks.",
    );
  }
  return bookingsRow.version;
}

function masterDuplicateResolutionKey(input: {
  sourceId: string;
  revision: string;
  studentVersion: number;
  sourceRows: readonly StudentImportSourceKey[];
  decision?: MasterDuplicateResolutionDecision;
  selectedSourceRow?: StudentImportSourceKey;
  selectedStatus?: MasterStudentStatus;
}) {
  const material = [
    MASTER_DUPLICATE_RESOLUTION_CONTRACT,
    input.sourceId,
    input.revision,
    String(input.studentVersion),
    ...input.sourceRows.map(String).sort(),
    ...(input.decision ? [input.decision] : []),
    ...(input.selectedSourceRow !== undefined ? [String(input.selectedSourceRow)] : []),
    ...(input.selectedStatus ? [input.selectedStatus] : []),
  ].join("\u0000");
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

function identityReviewOpaqueKey(input: {
  contract: typeof IDENTITY_REVIEW_CANDIDATE_CONTRACT | typeof IDENTITY_REVIEW_RESOLUTION_CONTRACT;
  master: Readonly<{ sourceId: string; revision: string; sourceRow: StudentImportSourceKey }>;
  jwb: Readonly<{ sourceId: string; revision: string; sourceRow: StudentImportSourceKey }>;
  studentsVersion: number;
  reviewEpoch: number;
  decision?: StudentIdentityReviewDecision;
  studentId?: string;
}) {
  return `sha256:${createHash("sha256").update(stableValue(input)).digest("hex")}`;
}

function identityEvidenceName(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function identityReviewClearKey(input: {
  master: Readonly<{ sourceId: string; revision: string }>;
  jwb: Readonly<{ sourceId: string; revision: string }>;
  studentsVersion: number;
  reviewEpoch: number;
  identityLinkFingerprint: string;
}) {
  return `sha256:${createHash("sha256").update(stableValue({
    contract: IDENTITY_REVIEW_CLEAR_CONTRACT,
    ...input,
  })).digest("hex")}`;
}

function identityReviewManualToken(input: {
  tokenSecret: string;
  kind: "master" | "jwb" | "existing";
  master: Readonly<{ sourceId: string; revision: string }>;
  jwb: Readonly<{ sourceId: string; revision: string }>;
  studentsVersion: number;
  reviewEpoch: number;
  sourceRow?: StudentImportSourceKey;
  studentId?: string;
}) {
  const { tokenSecret, ...evidence } = input;
  if (!tokenSecret) {
    throw new StudentImportServiceError(
      "invalid_source_snapshot",
      "Student identity review token secret is unavailable.",
    );
  }
  return `sha256:${createHmac("sha256", tokenSecret).update(stableValue({
    contract: IDENTITY_REVIEW_MANUAL_TOKEN_CONTRACT,
    ...evidence,
  })).digest("hex")}`;
}

function eligibleDerivedIdentityOwners(
  masterRows: readonly MasterStudentImportRow[],
  masterSourceId: string,
) {
  const owners = new Map<string, string[]>();
  for (const row of masterRows) {
    const status = String(row.status ?? "").trim();
    if (!isMasterStudentStatus(status) || status === "不活跃 + 无课时") continue;
    const studentId = studentIdForMasterSource(row.sourceRow, masterSourceId);
    owners.set(studentId, [...(owners.get(studentId) ?? []), String(row.sourceRow).trim()]);
  }
  return owners;
}

/**
 * Builds review evidence only. A candidate is never selected or persisted by
 * this function: the administrator must choose one opaque closed option and
 * the database independently recomputes it from locked current state.
 */
export function buildStudentIdentityReviewCandidates(input: {
  master: Readonly<{
    sourceId: string;
    revision: string;
    rows: readonly MasterStudentImportRow[];
  }>;
  jwb: Readonly<{
    sourceId: string;
    revision: string;
    rows: readonly JwbStudentImportRow[];
  }>;
  studentsVersion: number;
  existingStudents: readonly ExistingStudentImportRecord[];
  identityLinks?: readonly StudentImportIdentityLink[];
  reviewEpoch?: number;
}): readonly StudentIdentityReviewCandidate[] {
  if (!Number.isSafeInteger(input.studentsVersion) || input.studentsVersion < 0) {
    throw new StudentImportServiceError("invalid_students_state", "Student version is unavailable for identity review.");
  }
  const reviewEpoch = input.reviewEpoch ?? 0;
  if (!Number.isSafeInteger(reviewEpoch) || reviewEpoch < 0) {
    throw new StudentImportServiceError("invalid_source_snapshot", "Student identity review epoch is invalid.");
  }

  const masterGroups = new Map<string, MasterStudentImportRow[]>();
  for (const row of input.master.rows) {
    const key = normalizeStudentImportName(row.name);
    if (key) masterGroups.set(key, [...(masterGroups.get(key) ?? []), row]);
  }
  const jwbGroups = new Map<string, JwbStudentImportRow[]>();
  for (const row of input.jwb.rows) {
    // The reviewer may choose an existing system identity, but the master and
    // JWB source records themselves must still have the same full name under
    // the exact source contract. A human review cannot waive a source-name
    // discrepancy; teaching administration must correct the master sheet.
    const key = normalizeStudentImportName(row.name);
    if (key) jwbGroups.set(key, [...(jwbGroups.get(key) ?? []), row]);
  }
  const existingGroups = new Map<string, ExistingStudentImportRecord[]>();
  const existingById = new Map<string, ExistingStudentImportRecord[]>();
  for (const student of input.existingStudents) {
    existingById.set(student.id, [...(existingById.get(student.id) ?? []), student]);
    const key = normalizeStudentImportName(student.name);
    if (key) existingGroups.set(key, [...(existingGroups.get(key) ?? []), student]);
  }

  const linkedMasterRows = new Set((input.identityLinks ?? []).map((link) => String(link.masterSourceRow).trim()));
  const linkedJwbRows = new Set((input.identityLinks ?? [])
    .flatMap((link) => link.jwbSourceRow === undefined ? [] : [String(link.jwbSourceRow).trim()]));
  const linkedStudentIds = new Set((input.identityLinks ?? []).map((link) => link.studentId));
  const derivedIdentityOwners = eligibleDerivedIdentityOwners(input.master.rows, input.master.sourceId);
  const candidates: StudentIdentityReviewCandidate[] = [];

  for (const [reviewKey, masters] of masterGroups) {
    const jwbRowsForKey = jwbGroups.get(reviewKey) ?? [];
    if (masters.length !== 1 || jwbRowsForKey.length !== 1) continue;
    const master = masters[0];
    const status = String(master.status ?? "").trim();
    if (!isMasterStudentStatus(status) || status === "不活跃 + 无课时") continue;
    const jwb = jwbRowsForKey[0];
    if (linkedMasterRows.has(String(master.sourceRow).trim())
      || linkedJwbRows.has(String(jwb.sourceRow).trim())) continue;

    const keyBasis = {
      master: {
        sourceId: input.master.sourceId,
        revision: input.master.revision,
        sourceRow: master.sourceRow,
      },
      jwb: {
        sourceId: input.jwb.sourceId,
        revision: input.jwb.revision,
        sourceRow: jwb.sourceRow,
      },
      studentsVersion: input.studentsVersion,
      reviewEpoch,
    } as const;
    const existing = existingGroups.get(reviewKey) ?? [];
    const options: StudentIdentityReviewOption[] = [];
    let blockedReason: StudentIdentityReviewCandidate["blockedReason"];
    const derivedId = studentIdForMasterSource(master.sourceRow, input.master.sourceId);
    const masterSourceKey = String(master.sourceRow).trim();
    const derivedOwners = derivedIdentityOwners.get(derivedId) ?? [];
    const derivedIdentityAvailable = (existingById.get(derivedId) ?? []).length === 0
      && !linkedStudentIds.has(derivedId)
      && derivedOwners.length === 1
      && derivedOwners[0] === masterSourceKey;

    const mergeTargetOwners = existing[0]
      ? derivedIdentityOwners.get(existing[0].id) ?? []
      : [];
    const mergeTargetAvailable = existing.length === 1
      && !linkedStudentIds.has(existing[0].id)
      && mergeTargetOwners.every((owner) => owner === masterSourceKey);

    if (existing[0] && mergeTargetAvailable) {
      options.push({
        resolutionKey: identityReviewOpaqueKey({
          contract: IDENTITY_REVIEW_RESOLUTION_CONTRACT,
          ...keyBasis,
          decision: "merge",
          studentId: existing[0].id,
        }),
        decision: "merge",
        label: "确认合并到现有学生",
      });
    }
    // A same-name current record is evidence, not proof. When the deterministic
    // formal ID is free, the reviewer must also be able to say these are two
    // different people instead of being forced into a merge.
    if (derivedIdentityAvailable) {
      options.push({
        resolutionKey: identityReviewOpaqueKey({
          contract: IDENTITY_REVIEW_RESOLUTION_CONTRACT,
          ...keyBasis,
          decision: "create",
          studentId: derivedId,
        }),
        decision: "create",
        label: existing.length
          ? "确认为不同学生并创建新身份"
          : "确认创建正式学生身份",
      });
    }
    if (!options.length) {
      blockedReason = existing.length > 1
        ? "existing_identity_ambiguous"
        : existing.length === 1 && linkedStudentIds.has(existing[0].id)
          ? "identity_already_used"
          : "derived_identity_conflict";
    }

    candidates.push({
      candidateKey: identityReviewOpaqueKey({
        contract: IDENTITY_REVIEW_CANDIDATE_CONTRACT,
        ...keyBasis,
      }),
      master: { name: identityEvidenceName(master.name), sourceRow: master.sourceRow },
      jwb: { name: identityEvidenceName(jwb.name), sourceRow: jwb.sourceRow },
      ...(existing[0] ? {
        existing: {
          name: identityEvidenceName(existing[0].name),
          ...(canonicalSourceKey(existing[0].sourceRow) !== undefined
            ? { sourceRow: canonicalSourceKey(existing[0].sourceRow)! }
            : {}),
        },
      } : {}),
      existingMatchCount: existing.length,
      options,
      ...(blockedReason ? { blockedReason } : {}),
      persistenceContract: "student_identity_review_v1",
    });
  }

  return candidates.sort((left, right) =>
    String(left.master.sourceRow).localeCompare(String(right.master.sourceRow), "en"));
}

export function parseStudentIdentityReviewRequest(value: unknown): StudentIdentityReviewRequest {
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || typeof value.resolutionKey !== "string"
    || !FINGERPRINT_PATTERN.test(value.resolutionKey)
    || (value.decision !== "merge" && value.decision !== "create")) {
    throw new StudentImportServiceError(
      "invalid_identity_review_request",
      "请选择当前身份审核列表提供的处理方式。",
    );
  }
  return { resolutionKey: value.resolutionKey, decision: value.decision };
}

export function parseStudentIdentityReviewClearRequest(value: unknown): StudentIdentityReviewClearRequest {
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || typeof value.resolutionKey !== "string"
    || !FINGERPRINT_PATTERN.test(value.resolutionKey)
    || value.decision !== "clear") {
    throw new StudentImportServiceError(
      "invalid_identity_review_request",
      "请使用当前身份审核列表提供的清空确认。",
    );
  }
  return { resolutionKey: value.resolutionKey, decision: "clear" };
}

export function parseStudentIdentityManualReviewRequest(
  value: unknown,
): StudentIdentityManualReviewRequest {
  if (!isRecord(value)
    || typeof value.masterToken !== "string"
    || !FINGERPRINT_PATTERN.test(value.masterToken)
    || typeof value.jwbToken !== "string"
    || !FINGERPRINT_PATTERN.test(value.jwbToken)
    || (value.decision !== "merge" && value.decision !== "create")) {
    throw new StudentImportServiceError(
      "invalid_identity_review_request",
      "请从当前人工配对列表选择学生总表与教务宝记录。",
    );
  }
  if (value.decision === "create") {
    if (Object.keys(value).length !== 3 || "existingToken" in value) {
      throw new StudentImportServiceError(
        "invalid_identity_review_request",
        "创建新身份不能携带现有学生标识。",
      );
    }
    return {
      masterToken: value.masterToken,
      jwbToken: value.jwbToken,
      decision: "create",
    };
  }
  if (Object.keys(value).length !== 4
    || typeof value.existingToken !== "string"
    || !FINGERPRINT_PATTERN.test(value.existingToken)) {
    throw new StudentImportServiceError(
      "invalid_identity_review_request",
      "合并身份必须选择当前列表中的现有学生。",
    );
  }
  return {
    masterToken: value.masterToken,
    jwbToken: value.jwbToken,
    existingToken: value.existingToken,
    decision: "merge",
  };
}

function buildStudentIdentityManualReview(input: {
  tokenSecret: string;
  sources: StudentImportSourceRowsSnapshot;
  resolvedMasterRows: readonly MasterStudentImportRow[];
  studentsVersion: number;
  existingStudents: readonly ExistingStudentImportRecord[];
}): StudentIdentityManualReview {
  const { sources } = input;
  const linkedMasterRows = new Set(sources.identityLinks.map((link) =>
    String(link.masterSourceRow).trim()));
  const linkedJwbRows = new Set(sources.identityLinks.flatMap((link) =>
    link.jwbSourceRow === undefined ? [] : [String(link.jwbSourceRow).trim()]));
  const linkedStudentIds = new Set(sources.identityLinks.map((link) => link.studentId));
  const tokenBasis = {
    master: { sourceId: sources.master.sourceId, revision: sources.master.revision },
    jwb: { sourceId: sources.jwb.sourceId, revision: sources.jwb.revision },
    studentsVersion: input.studentsVersion,
    reviewEpoch: sources.identityReviewEpoch,
  } as const;
  const bySourceRow = <T extends { sourceRow: StudentImportSourceKey }>(left: T, right: T) =>
    String(left.sourceRow).localeCompare(String(right.sourceRow), "en");
  const existingEvidence = input.existingStudents.map((student) => {
    const sourceRow = canonicalSourceKey(student.masterSourceKey)
      ?? canonicalSourceKey(student.sourceRow);
    const status = typeof student.status === "string" && student.status.trim().length <= 80
      ? student.status.trim()
      : undefined;
    const segment = typeof student.segment === "string" && student.segment.trim().length <= 80
      ? student.segment.trim()
      : undefined;
    const evidence = {
      name: identityEvidenceName(student.name),
      ...(sourceRow !== undefined ? { sourceRow } : {}),
      ...(status ? { status } : {}),
      ...(segment ? { segment } : {}),
    };
    return { student, evidence, signature: stableValue(evidence) };
  });
  const evidenceCounts = new Map<string, number>();
  for (const item of existingEvidence) {
    evidenceCounts.set(item.signature, (evidenceCounts.get(item.signature) ?? 0) + 1);
  }

  return {
    masters: input.resolvedMasterRows.flatMap((row) => {
      const status = String(row.status ?? "").trim();
      if (!isMasterStudentStatus(status)
        || !JWB_REQUIRED_MASTER_STATUSES.has(status)
        || linkedMasterRows.has(String(row.sourceRow).trim())) return [];
      return [{
        token: identityReviewManualToken({
          kind: "master",
          tokenSecret: input.tokenSecret,
          ...tokenBasis,
          sourceRow: row.sourceRow,
        }),
        name: identityEvidenceName(row.name),
        sourceRow: row.sourceRow,
        status,
      }];
    }).sort(bySourceRow),
    jwb: sources.jwb.rows.flatMap((row) => {
      if (linkedJwbRows.has(String(row.sourceRow).trim())) return [];
      return [{
        token: identityReviewManualToken({
          tokenSecret: input.tokenSecret,
          kind: "jwb",
          ...tokenBasis,
          sourceRow: row.sourceRow,
        }),
        name: identityEvidenceName(row.name),
        sourceRow: row.sourceRow,
      }];
    }).sort(bySourceRow),
    existing: existingEvidence.flatMap(({ student, evidence, signature }) => {
      if (linkedStudentIds.has(student.id)) return [];
      // Two records with identical visible evidence cannot be chosen safely by
      // a human. Do not issue either token; create remains available.
      if (evidenceCounts.get(signature) !== 1) return [];
      return [{
        token: identityReviewManualToken({
          kind: "existing",
          tokenSecret: input.tokenSecret,
          ...tokenBasis,
          studentId: student.id,
        }),
        ...evidence,
      }];
    }).sort((left, right) =>
      left.name.localeCompare(right.name, "zh-Hans-CN")
      || String(left.sourceRow ?? "").localeCompare(String(right.sourceRow ?? ""), "en")),
  };
}

export function resolveStudentIdentityReviewCandidate(
  request: StudentIdentityReviewRequest,
  candidates: readonly StudentIdentityReviewCandidate[],
) {
  for (const candidate of candidates) {
    const option = candidate.options.find((item) =>
      item.resolutionKey === request.resolutionKey && item.decision === request.decision);
    if (option) return { candidate, option } as const;
  }
  throw new StudentImportServiceError(
    "identity_review_unavailable",
    "该学生身份审核选项已失效，请重新读取最新候选。",
  );
}

export function prepareStudentIdentityReview(input: {
  sourceSnapshot: unknown;
  studentsRow: OpsStateRow | undefined;
  manualTokenSecret: string;
}) {
  const sources = parseStudentImportSourceSnapshot(input.sourceSnapshot);
  const current = studentsState(input.studentsRow);
  // Use the same authoritative duplicate-row decisions as the locked SQL RPC.
  // No token is issued for a pending group: otherwise a link could be created
  // for a row that a later select/ignore decision removes from the projection.
  const duplicateCandidates = buildMasterDuplicateResolutionCandidates({
    sourceId: sources.master.sourceId,
    revision: sources.master.revision,
    studentVersion: current.version,
    rows: sources.master.rows,
  });
  const resolvedGroupKeys = new Set(sources.masterDuplicateResolutions.map((resolution) =>
    resolutionGroupKey(resolution.sourceRows)));
  const pendingDuplicateRows = new Set(duplicateCandidates.flatMap((candidate) =>
    resolvedGroupKeys.has(resolutionGroupKey(candidate.sourceRows.map((row) => row.sourceRow)))
      ? []
      : candidate.sourceRows.map((row) => String(row.sourceRow).trim())));
  const resolvedMasterRows = applyMasterStudentDuplicateResolutions(
    sources.master.rows,
    sources.masterDuplicateResolutions,
  ).filter((row) => !pendingDuplicateRows.has(String(row.sourceRow).trim()));
  const candidateInput = {
    master: { ...sources.master, rows: resolvedMasterRows },
    jwb: sources.jwb,
    studentsVersion: current.version,
    existingStudents: current.students,
    reviewEpoch: sources.identityReviewEpoch,
  } as const;
  const candidates = buildStudentIdentityReviewCandidates({
    ...candidateInput,
    identityLinks: sources.identityLinks,
  });
  const visibleCandidateKeys = new Set(candidates.map((candidate) => candidate.candidateKey));
  const decisionCandidates = buildStudentIdentityReviewCandidates(candidateInput).flatMap((candidate) => {
    if (visibleCandidateKeys.has(candidate.candidateKey)) return [candidate];
    const masterSourceKey = String(candidate.master.sourceRow).trim();
    const jwbSourceKey = String(candidate.jwb.sourceRow).trim();
    const link = sources.identityLinks.find((item) =>
      String(item.masterSourceRow).trim() === masterSourceKey
      && item.jwbSourceRow !== undefined
      && String(item.jwbSourceRow).trim() === jwbSourceKey);
    if (!link) return [];
    const matchingOptions = candidate.options.filter((option) => {
      if (option.decision === "create") {
        return link.studentId === studentIdForMasterSource(
        candidate.master.sourceRow,
        sources.master.sourceId,
      );
      }
      const master = resolvedMasterRows.find((row) =>
        String(row.sourceRow).trim() === masterSourceKey);
      if (!master) return false;
      const exactNameKey = normalizeStudentImportName(master.name);
      return Boolean(exactNameKey) && current.students.some((student) =>
        student.id === link.studentId
        && normalizeStudentImportName(student.name) === exactNameKey);
    });
    return matchingOptions.length === 1 ? [{ ...candidate, options: matchingOptions }] : [];
  });
  return {
    candidates,
    // Kept server-side and used only to validate a submitted opaque option.
    // It includes the visible options plus only an exact active-link replay;
    // the locked database RPC performs the same check again before mutation.
    decisionCandidates,
    identityLinkCount: sources.identityLinks.length,
    manualReview: buildStudentIdentityManualReview({
      tokenSecret: input.manualTokenSecret,
      sources,
      resolvedMasterRows,
      studentsVersion: current.version,
      existingStudents: current.students,
    }),
    clearKey: identityReviewClearKey({
      master: { sourceId: sources.master.sourceId, revision: sources.master.revision },
      jwb: { sourceId: sources.jwb.sourceId, revision: sources.jwb.revision },
      studentsVersion: current.version,
      reviewEpoch: sources.identityReviewEpoch,
      identityLinkFingerprint: sources.identityLinkFingerprint,
    }),
  } as const;
}

export function buildMasterDuplicateResolutionCandidates(input: {
  sourceId: string;
  revision: string;
  studentVersion: number;
  rows: readonly MasterStudentImportRow[];
}): readonly MasterDuplicateResolutionCandidate[] {
  return findMasterStudentDuplicateGroups(input.rows).map((group) => {
    const sourceRows = group.rows.map((row) => row.sourceRow);
    return {
      candidateKey: masterDuplicateResolutionKey({ ...input, sourceRows }),
      sourceRows: group.rows.map((row) => ({
        sourceRow: row.sourceRow,
        status: row.status,
        ...(row.attributes ? { attributes: row.attributes } : {}),
      })),
      options: [
        ...group.rows.flatMap((row) => {
          const status = String(row.status ?? "").trim();
          const statuses = status ? [undefined] : [...SELECTABLE_MASTER_DUPLICATE_STATUSES];
          return statuses.map((selectedStatus) => ({
            resolutionKey: masterDuplicateResolutionKey({
              ...input,
              sourceRows,
              decision: "select" as const,
              selectedSourceRow: row.sourceRow,
              ...(selectedStatus ? { selectedStatus } : {}),
            }),
            decision: "select" as const,
            selectedSourceRow: row.sourceRow,
            ...(selectedStatus ? { selectedStatus } : {}),
            label: selectedStatus
              ? `保留来源行 ${String(row.sourceRow)}，状态设为${selectedStatus}`
              : `保留来源行 ${String(row.sourceRow)}`,
          }));
        }),
        {
          resolutionKey: masterDuplicateResolutionKey({ ...input, sourceRows, decision: "ignore" }),
          decision: "ignore" as const,
          label: "明确忽略整组",
        },
      ],
      persistenceContract: "student_master_duplicate_resolution_v1" as const,
    };
  });
}

export function parseMasterDuplicateResolutionRequest(value: unknown): MasterDuplicateResolutionRequest {
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || typeof value.resolutionKey !== "string"
    || !FINGERPRINT_PATTERN.test(value.resolutionKey)
    || (value.decision !== "select" && value.decision !== "ignore")) {
    throw new StudentImportServiceError(
      "invalid_master_duplicate_resolution_request",
      "请选择当前预检提供的学生总表重复项处理方式。",
    );
  }
  return { resolutionKey: value.resolutionKey, decision: value.decision };
}

export function resolveMasterDuplicateCandidate(
  request: MasterDuplicateResolutionRequest,
  candidates: readonly MasterDuplicateResolutionCandidate[],
) {
  for (const candidate of candidates) {
    const option = candidate.options.find((item) =>
      item.resolutionKey === request.resolutionKey && item.decision === request.decision);
    if (option) return { candidate, option } as const;
  }
  throw new StudentImportServiceError(
    "master_duplicate_resolution_unavailable",
    "该学生总表重复项处理已失效，请重新预检。",
  );
}

export function masterDuplicateDecisionForCandidate(
  candidate: MasterDuplicateResolutionCandidate,
  option: MasterDuplicateResolutionOption,
  identityLinks: readonly StudentImportIdentityLink[] = [],
): MasterStudentDuplicateResolution {
  const selectedKey = option.selectedSourceRow === undefined ? undefined : String(option.selectedSourceRow).trim();
  const selectedLinks = selectedKey === undefined
    ? undefined
    : identityLinks.filter((link) => String(link.masterSourceRow).trim() === selectedKey);
  if (selectedLinks && selectedLinks.length > 1) {
    throw new StudentImportServiceError(
      "master_duplicate_resolution_unavailable",
      "所选来源行的当前审核身份链接不唯一，请重新核对来源。",
    );
  }
  return {
    decision: option.decision,
    sourceRows: candidate.sourceRows.map((row) => row.sourceRow),
    ...(option.selectedSourceRow !== undefined ? { selectedSourceRow: option.selectedSourceRow } : {}),
    ...(option.selectedStatus !== undefined ? { selectedStatus: option.selectedStatus } : {}),
    ...(selectedLinks?.[0] ? { selectedStudentId: selectedLinks[0].studentId } : {}),
  };
}

function resolutionGroupKey(sourceRows: readonly StudentImportSourceKey[]) {
  return sourceRows.map((row) => String(row).trim()).sort().join("\u0000");
}

function identityLinksWithMasterDuplicateSelections(input: {
  resolutions: readonly MasterStudentDuplicateResolution[];
  masterRows: readonly MasterStudentImportRow[];
  identityLinks: readonly StudentImportIdentityLink[];
}) {
  const links: StudentImportIdentityLink[] = [...input.identityLinks];
  const masterByKey = new Map(input.masterRows.map((row) => [String(row.sourceRow).trim(), row]));
  for (const resolution of input.resolutions) {
    if (resolution.decision !== "select" || resolution.selectedStudentId === undefined) continue;
    const selectedKey = String(resolution.selectedSourceRow).trim();
    const selectedMaster = masterByKey.get(selectedKey);
    const existingLink = links.filter((link) =>
      String(link.masterSourceRow).trim() === selectedKey
      && link.studentId === resolution.selectedStudentId);
    if (!selectedMaster || existingLink.length !== 1) {
      throw new StudentImportServiceError(
        "master_duplicate_resolution_unavailable",
        "所选来源行没有当前审核身份链接，请重新确认。",
      );
    }
  }
  return links;
}

export function studentImportPlanFingerprint(input: {
  plan: StudentImportPlan;
  studentVersion: number;
  bookingsVersion: number;
  sources: StudentImportSourceRowsSnapshot;
}) {
  const sourceIdentityOnly = {
    master: { sourceId: input.sources.master.sourceId, revision: input.sources.master.revision },
    jwb: { sourceId: input.sources.jwb.sourceId, revision: input.sources.jwb.revision },
    identityLinks: input.sources.identityLinkFingerprint,
    masterDuplicateResolutions: input.sources.masterDuplicateResolutionFingerprint,
    fuAttachments: input.sources.fuAttachmentReferences.fingerprint,
    bookingsVersion: input.bookingsVersion,
    identityStrategy: FORMAL_IDENTITY_STRATEGY,
  };
  return `sha256:${createHash("sha256").update(stableValue({
    contract: FINGERPRINT_CONTRACT,
    studentVersion: input.studentVersion,
    sources: sourceIdentityOnly,
    plan: input.plan,
  })).digest("hex")}`;
}

export function prepareStudentImport(input: {
  sourceSnapshot: unknown;
  studentsRow: OpsStateRow | undefined;
  referenceRows: readonly OpsStateRow[];
  masterDuplicateResolutions?: readonly MasterStudentDuplicateResolution[];
}): PreparedStudentImport {
  const sources = parseStudentImportSourceSnapshot(input.sourceSnapshot);
  const current = studentsState(input.studentsRow);
  const bookingsVersion = requiredBookingsVersion(input.referenceRows);
  const masterDuplicateResolutions = buildMasterDuplicateResolutionCandidates({
    sourceId: sources.master.sourceId,
    revision: sources.master.revision,
    studentVersion: current.version,
    rows: sources.master.rows,
  });
  const savedMasterDuplicateResolutions = input.masterDuplicateResolutions
    ?? sources.masterDuplicateResolutions;
  const resolvedGroupKeys = new Set(savedMasterDuplicateResolutions
    .map((resolution) => resolutionGroupKey(resolution.sourceRows)));
  const pendingMasterDuplicateResolutions = masterDuplicateResolutions.filter((candidate) =>
    !resolvedGroupKeys.has(resolutionGroupKey(candidate.sourceRows.map((row) => row.sourceRow))));
  const resolvedMasterRows = applyMasterStudentDuplicateResolutions(
    sources.master.rows,
    savedMasterDuplicateResolutions,
  ).filter((row) => {
    if (String(row.status ?? "").trim()) return true;
    return !pendingMasterDuplicateResolutions.some((candidate) =>
      candidate.sourceRows.some((candidateRow) =>
        String(candidateRow.sourceRow).trim() === String(row.sourceRow).trim()));
  });
  const resolvedIdentityLinks = identityLinksWithMasterDuplicateSelections({
    resolutions: savedMasterDuplicateResolutions,
    masterRows: sources.master.rows,
    identityLinks: sources.identityLinks,
  });
  const plan = buildStudentImportPlan({
    masterRows: resolvedMasterRows,
    jwbRows: sources.jwb.rows,
    existingStudents: current.students,
    identityLinks: resolvedIdentityLinks,
    masterSourceNamespace: sources.master.sourceId,
    allowLegacyIdentityFallback: false,
    preserveManualTrials: true,
    // The server-owned plan includes every historical number before it is
    // fingerprinted. SQL reconstructs the exact same deterministic result
    // from the locked JWB-backed positive-contract date at the commit boundary.
    assignStudentNumbers: true,
    studentNumberReservations: sources.studentNumberReservations,
    preserveReferencedStudentIds: allReferencedStudentIds(
      input.referenceRows,
      sources.fuAttachmentReferences.studentIds,
    ),
  });
  for (const student of plan.students) {
    assertCurrentLessonPackages(student as RecordValue);
    assertCurrentJwbAggregate(student as RecordValue);
  }
  // These statuses describe a student who is already studying, has hours, or
  // is waiting for an additional lesson allocation.  A formal replacement is
  // unsafe unless that master identity is tied to exactly one JWB account.
  // "活跃 + 无课时" is deliberately exempt: the authoritative source says
  // there is no balance to import, so a missing JWB account is not evidence of
  // an incomplete identity projection.
  const requiredMasterStudents = plan.students.filter((student) =>
    student.importSource === "master"
    && isMasterStudentStatus(student.status)
    && JWB_REQUIRED_MASTER_STATUSES.has(student.status));
  const matchedRequiredMasterRows = requiredMasterStudents.filter((student) =>
    student.jwbMatchStatus === "matched").length;
  const identityCoverage = {
    requiredMasterRows: requiredMasterStudents.length,
    matchedRequiredMasterRows,
    missingRequiredMasterRows: requiredMasterStudents.length - matchedRequiredMasterRows,
    ready: requiredMasterStudents.length === matchedRequiredMasterRows,
  } as const;
  const planFingerprint = studentImportPlanFingerprint({
    plan,
    studentVersion: current.version,
    bookingsVersion,
    sources,
  });
  return {
    plan,
    sourceRevisions: {
      master: sources.master.revision,
      jwb: sources.jwb.revision,
      identityLinks: sources.identityLinkFingerprint,
      masterDuplicateResolutions: sources.masterDuplicateResolutionFingerprint,
      fuAttachments: sources.fuAttachmentReferences.fingerprint,
      bookingsVersion,
    },
    response: {
      planFingerprint,
      expectedStudentVersion: current.version,
      canCommit: plan.students.length > 0
        && plan.ambiguous.length === 0
        && pendingMasterDuplicateResolutions.length === 0
        && identityCoverage.ready,
      sources: {
        master: { sourceId: sources.master.sourceId, revision: sources.master.revision, rowCount: sources.master.rows.length },
        jwb: { sourceId: sources.jwb.sourceId, revision: sources.jwb.revision, rowCount: sources.jwb.rows.length },
      },
      identityLinkCount: sources.identityLinks.length,
      identityCoverage,
      masterDuplicateResolutions: pendingMasterDuplicateResolutions,
      summary: plan.summary,
      excluded: plan.excluded,
      unmatched: plan.unmatched,
      // The browser needs only review counts and source-row evidence. Current
      // student IDs and normalized join keys stay inside the server plan.
      ambiguous: plan.ambiguous.map((ambiguity) => ({
        kind: ambiguity.kind,
        masterSourceRows: ambiguity.masterSourceRows,
        jwbSourceRows: ambiguity.jwbSourceRows,
        existingStudentCount: ambiguity.existingStudentIds.length,
      })),
    },
  };
}

export function parseStudentImportCommitRequest(value: unknown): StudentImportCommitRequest {
  if (!isRecord(value)) {
    throw new StudentImportServiceError("invalid_commit_request", "Import confirmation is incomplete.");
  }
  if (FORBIDDEN_CLIENT_PLAN_FIELDS.some((field) => field in value)) {
    throw new StudentImportServiceError("client_plan_forbidden", "Student and source rows must be computed by the server.");
  }
  if (Object.keys(value).some((field) => !COMMIT_REQUEST_FIELDS.has(field))) {
    throw new StudentImportServiceError("invalid_commit_request", "Import confirmation contains unsupported fields.");
  }
  if (typeof value.planFingerprint !== "string" || !FINGERPRINT_PATTERN.test(value.planFingerprint)) {
    throw new StudentImportServiceError("invalid_commit_request", "A valid plan fingerprint is required.");
  }
  if (!Number.isSafeInteger(value.expectedStudentVersion) || (value.expectedStudentVersion as number) < 0) {
    throw new StudentImportServiceError("invalid_commit_request", "A valid expected student version is required.");
  }
  return {
    planFingerprint: value.planFingerprint,
    expectedStudentVersion: value.expectedStudentVersion as number,
  };
}

export function assertStudentImportCommit(
  request: StudentImportCommitRequest,
  prepared: PreparedStudentImport,
) {
  if (prepared.plan.ambiguous.length || prepared.response.masterDuplicateResolutions.length) {
    throw new StudentImportServiceError("ambiguous_plan", "Ambiguous student matches must be resolved before import.");
  }
  if (prepared.plan.students.length === 0) {
    throw new StudentImportServiceError("empty_plan", "The reviewed import would produce an empty student list.");
  }
  if (!prepared.response.identityCoverage.ready) {
    throw new StudentImportServiceError(
      "insufficient_identity_coverage",
      "Students who are studying or have hours must be matched to reviewed JWB identities before import.",
    );
  }
  if (request.expectedStudentVersion !== prepared.response.expectedStudentVersion) {
    throw new StudentImportServiceError("stale_students_version", "The students list changed after this plan was reviewed.");
  }
  if (request.planFingerprint !== prepared.response.planFingerprint) {
    throw new StudentImportServiceError("stale_plan", "The import sources or plan changed after review.");
  }
}
