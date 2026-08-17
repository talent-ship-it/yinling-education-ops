import type { StudentLessonPackage } from "./student-records";

/**
 * Pure domain logic for replacing the system student list from the latest
 * master sheet and enriching it with JWB balances.
 *
 * Matching is intentionally conservative. A master-sheet name and a JWB name
 * match only when their complete display names are equal after the shared
 * safe cleanup: NFKC, invisible-character removal, whitespace collapsing and
 * ASCII-only case folding. Punctuation and Chinese characters are never
 * discarded. Every key must still be unique on both sides; duplicates are
 * ambiguous and never attach JWB data.
 */

export const MASTER_STUDENT_STATUSES = [
  "在读",
  "不活跃 + 无课时",
  "活跃 + 无课时",
  "活跃 + 有课时",
  "不活跃 + 有课时",
  "在读 + 加课待排",
] as const;

export type MasterStudentStatus = (typeof MASTER_STUDENT_STATUSES)[number];

export const EXCLUDED_MASTER_STUDENT_STATUS: MasterStudentStatus = "不活跃 + 无课时";

export type StudentImportSourceKey = string | number;
export type StudentImportAttributes = Readonly<Record<string, unknown>>;

/**
 * A deliberately narrow, reviewed exception to strict full-name matching.
 * It is not a fuzzy-name mode: the only permitted difference is one complete
 * Latin-letter annotation in the Jiaowubao display name, for example
 * `张三（VIC）` versus the master-sheet `张三`.
 */
export const STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1 =
  "jwb_latin_parenthetical_annotation_v1" as const;

export type StudentImportIdentityMatchStrategy =
  | typeof STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1;

export type StudentImportIdentityLink = Readonly<{
  masterSourceRow: StudentImportSourceKey;
  studentId: string;
  jwbSourceRow?: StudentImportSourceKey;
  /**
   * Omitted means the strict complete-display-name rule. A supplied strategy
   * is durable review evidence and is revalidated at every write, preview and
   * canonical-projection boundary.
   */
  matchStrategy?: StudentImportIdentityMatchStrategy;
}>;

export type MasterStudentImportRow = Readonly<{
  sourceRow: StudentImportSourceKey;
  name: string;
  status: string;
  /**
   * Optional authoritative Jiaowubao `mem_id` supplied by the master sheet.
   * It only chooses between JWB rows whose full normalized name already
   * matches this master row; it never authorizes a cross-name match.
   */
  jwbMemId?: StudentImportSourceKey;
  attributes?: StudentImportAttributes;
}>;

export type MasterStudentDuplicateResolution = Readonly<{
  decision: "select" | "ignore";
  sourceRows: readonly StudentImportSourceKey[];
  selectedSourceRow?: StudentImportSourceKey;
  /** Required when a selected source row had a blank source status. */
  selectedStatus?: MasterStudentStatus;
  /** Server-resolved stable identity; never accepted from the browser. */
  selectedStudentId?: string;
}>;

export type JwbStudentImportRow = Readonly<{
  sourceRow: StudentImportSourceKey;
  name: string;
  remainingHours?: number | string | null;
  contractHours?: number | string | null;
  contractEffectiveDate?: string | null;
  /**
   * Earliest positive JWB contract date: `contract_dated`, falling back to
   * `dated` and then `start`. It is a conservative, auditable approximation
   * of when the learner entered the business, not a literal DB created_at.
   */
  firstJwbHourEntryDate?: string | null;
  /**
   * Authoritative package-level data. Aggregate balances never create a
   * package because one balance may represent several subjects or contracts.
   */
  lessonPackages?: readonly JwbLessonPackageImportRow[];
  /** Explicitly scopes whether package rows cover every JWB current course. */
  packageCoverage?: "complete" | "partial" | "none";
  attributes?: StudentImportAttributes;
}>;

export type JwbLessonPackagePurchaseImportRow = Readonly<{
  sourcePurchaseId: StudentImportSourceKey;
  purchasedAt: string;
  hours: number | string;
  note?: string;
}>;

export type JwbLessonPackageImportRow = Readonly<{
  sourcePackageId: StudentImportSourceKey;
  name: string;
  subjectIds: readonly string[];
  purchaseRecords: readonly JwbLessonPackagePurchaseImportRow[];
  consumedHours: number | string;
}>;

export type ExistingStudentImportRecord = Readonly<Record<string, unknown> & {
  id: string;
  /** Human-facing immutable number: YYYYMMDD plus a daily three-digit serial. */
  studentNumber?: string;
  name: string;
  status?: string;
  segment?: string;
  sourceRow?: StudentImportSourceKey;
  masterSourceKey?: string;
  importSource?: "master" | "manual_trial";
  lessonPackages?: readonly StudentLessonPackage[];
}>;

/**
 * An immutable student-number reservation retained by the database even when
 * a later formal roster no longer projects that student's record. Keeping the
 * stable student ID here lets a returning formal row recover its original
 * number instead of consuming a new one.
 */
export type StudentNumberReservation = Readonly<{
  studentId: string;
  studentNumber: string;
}>;

export type ImportedStudentRecord = Readonly<Record<string, unknown> & {
  id: string;
  studentNumber?: string;
  name: string;
  status: string;
  sourceRow?: StudentImportSourceKey;
  masterSourceKey?: string;
  importSource?: "master" | "manual_trial";
  jwbMatchStatus?: "matched" | "unmatched" | "ambiguous";
  jwbSourceRow?: StudentImportSourceKey;
  remainingHours?: number;
  contractHours?: number;
  contractEffectiveDate?: string;
  firstJwbHourEntryDate?: string;
  lessonPackages?: readonly StudentLessonPackage[];
  packageCoverage?: "complete" | "partial" | "none";
}>;

export type StudentImportExcluded = Readonly<{
  sourceRow: StudentImportSourceKey;
  name: string;
  status: MasterStudentStatus;
  reason: "inactive_without_hours" | "empty_name";
}>;

export type StudentImportUnmatched = Readonly<{
  source: "master" | "jwb";
  sourceRow: StudentImportSourceKey;
  name: string;
  reason: "missing_jwb" | "not_in_master" | "empty_name";
}>;

export type StudentImportAmbiguity = Readonly<{
  kind: "name" | "existing_source" | "existing_name";
  normalizedName?: string;
  masterSourceRows: readonly StudentImportSourceKey[];
  jwbSourceRows: readonly StudentImportSourceKey[];
  existingStudentIds: readonly string[];
}>;

export type StudentImportAction = Readonly<{
  kind: "insert" | "update" | "unchanged";
  studentId: string;
  sourceRow: StudentImportSourceKey;
  name: string;
  changedFields: readonly string[];
}>;

export type StudentImportSummary = Readonly<{
  insert: number;
  update: number;
  unchanged: number;
  excluded: number;
  unmatched: number;
  ambiguous: number;
  preservedManualTrials: number;
  /** Historical records retained only because canonical entities still reference their IDs. */
  preservedReferencedArchived: number;
  /** Number of authoritative package rows imported from JWB. */
  importedPackages: number;
  /** Imported master students still lacking a package-level ledger. */
  studentsMissingPackageData: number;
}>;

export type StudentImportPlan = Readonly<{
  students: readonly ImportedStudentRecord[];
  actions: readonly StudentImportAction[];
  excluded: readonly StudentImportExcluded[];
  unmatched: readonly StudentImportUnmatched[];
  ambiguous: readonly StudentImportAmbiguity[];
  summary: StudentImportSummary;
}>;

export type BuildStudentImportPlanInput = Readonly<{
  masterRows: readonly MasterStudentImportRow[];
  jwbRows: readonly JwbStudentImportRow[];
  existingStudents?: readonly ExistingStudentImportRecord[];
  /**
   * Server-provided identities that override conservative name matching for
   * the explicitly linked rows. This is intentionally not accepted from the
   * current client import contract.
   */
  identityLinks?: readonly StudentImportIdentityLink[];
  /** Stable identity of the master source; separates identical row keys from different masters. */
  masterSourceNamespace?: string;
  /** Defaults to true for generic callers; formal imports must set false. */
  allowLegacyIdentityFallback?: boolean;
  /** Defaults to true. A manual trial is a trial-segment record without a master source key. */
  preserveManualTrials?: boolean;
  /** Formal JWB-backed imports allocate missing visible student numbers. */
  assignStudentNumbers?: boolean;
  /**
   * Internal server snapshot of every historical student-number reservation.
   * It is not accepted from a browser request. It keeps preview allocation in
   * lockstep with the database's permanent non-reuse registry.
   */
  studentNumberReservations?: readonly StudentNumberReservation[];
  /** Server-derived canonical references; never accepted from the browser import request. */
  preserveReferencedStudentIds?: ReadonlySet<string> | readonly string[];
}>;

export type StudentImportErrorCode =
  | "invalid_status"
  | "missing_source_key"
  | "duplicate_master_source_key"
  | "invalid_hours"
  | "invalid_lesson_package"
  | "duplicate_package_source_key"
  | "duplicate_purchase_source_key"
  | "package_balance_mismatch"
  | "invalid_identity_link"
  | "invalid_identity_link_match_strategy"
  | "identity_link_name_mismatch"
  | "duplicate_identity_link"
  | "invalid_master_jwb_member_id"
  | "duplicate_master_jwb_member_id"
  | "master_jwb_member_id_name_mismatch"
  | "master_jwb_member_id_identity_link_conflict"
  | "invalid_master_source_namespace"
  | "invalid_master_duplicate_resolution"
  | "duplicate_output_id";

export class StudentImportError extends Error {
  constructor(
    readonly code: StudentImportErrorCode,
    message: string,
    readonly sourceRow?: StudentImportSourceKey,
  ) {
    super(message);
    this.name = "StudentImportError";
  }
}

const managedFields = new Set([
  "id",
  "name",
  "status",
  "sourceRow",
  "masterSourceKey",
  "importSource",
  "jwbMatchStatus",
  "jwbSourceRow",
  "remainingHours",
  "contractHours",
  "contractEffectiveDate",
  "firstJwbHourEntryDate",
  "lessonPackages",
  "packageCoverage",
  "importArchived",
  "importArchivedReason",
]);

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cleanDisplayName(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

function importedStudentInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const initials = parts.length > 1
    ? parts.map((part) => [...part][0] ?? "").join("")
    : name;
  // Keep truncation code-point safe. String#slice can split a supplementary
  // character into an unpaired UTF-16 surrogate, which cannot be represented
  // faithfully by PostgreSQL text. Only ASCII case folding is needed for the
  // roster names and has identical semantics in JavaScript and SQL.
  return [...initials]
    .slice(0, 2)
    .join("")
    .replace(/[a-z]/g, (character) => character.toUpperCase()) || "新";
}

function importedStudentTimezone(location: unknown): string {
  if (typeof location !== "string") return "Australia/Melbourne";
  const key = location.normalize("NFKC").trim().toLocaleLowerCase();
  if (/\b(?:nsw|act|sydney|canberra)\b|悉尼|堪培拉/.test(key)) return "Australia/Sydney";
  if (/\b(?:qld|brisbane)\b|布里斯班/.test(key)) return "Australia/Brisbane";
  if (/\b(?:sa|adelaide)\b|阿德莱德/.test(key)) return "Australia/Adelaide";
  if (/\b(?:wa|perth)\b|珀斯/.test(key)) return "Australia/Perth";
  if (/\b(?:tas|hobart)\b|霍巴特/.test(key)) return "Australia/Hobart";
  if (/\b(?:nz|auckland|new zealand)\b|新西兰/.test(key)) return "Pacific/Auckland";
  if (/\b(?:china|shanghai)\b|中国|上海/.test(key)) return "Asia/Shanghai";
  if (/\bargentina\b|阿根廷/.test(key)) return "America/Argentina/Buenos_Aires";
  if (/\b(?:bosnia|sarajevo)\b|波斯尼亚/.test(key)) return "Europe/Sarajevo";
  return "Australia/Melbourne";
}

function importedStudentDefaults(name: string, attributes: StudentImportAttributes | undefined) {
  const location = typeof attributes?.location === "string" ? attributes.location.trim() : "";
  const grade = typeof attributes?.year === "string" ? attributes.year.trim() : "";
  return {
    initials: importedStudentInitials(name),
    owner: "待分配",
    planner: "待分配",
    course: "待确认",
    timezone: importedStudentTimezone(location),
    teacher: "待匹配",
    next: "核对课程、课包与老师",
    nextTone: "amber",
    files: 0,
    segment: "已报名",
    followUp: "未记录",
    ...(location ? { location } : {}),
    ...(grade ? { grade } : {}),
  };
}

/**
 * The only automatic identity comparison key. It preserves every visible
 * punctuation and every Chinese character, so a non-identical full name can
 * never inherit a JWB account merely because a punctuation-free alias happens
 * to look similar. NFKC/whitespace/ASCII-case are the deliberately narrow,
 * cross-runtime safe normalisations shared with the SQL write boundary.
 */
export function normalizeStudentImportName(value: string) {
  // Keep identity grouping deterministic across JavaScript and PostgreSQL.
  // NFKC already folds width/compatibility variants; only ASCII case folding
  // is required for the current roster contract and avoids locale-dependent
  // Unicode case mappings diverging between runtimes.
  const displayName = cleanDisplayName(value);
  return displayName.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

// This closed alphabet intentionally excludes digits, whitespace, punctuation
// and every non-Latin script. It is for a single trailing display annotation
// such as `(VIC)` or `(Mia)`, not a general "ignore brackets" rule.
// `cleanDisplayName` has already applied NFKC, so full-width parentheses and
// letters are represented consistently.
const JWB_LATIN_PARENTHETICAL_ANNOTATION = /^[A-Za-z]+$/;

/**
 * Returns the strict comparison key after removing exactly one complete,
 * trailing ASCII-letter parenthetical annotation from a Jiaowubao display
 * name. Any prefix/middle annotation, second segment, digit, whitespace,
 * punctuation, non-Latin script, nesting, blank annotation or empty body
 * fails closed and returns an empty key.
 */
export function studentImportJwbLatinParentheticalAnnotationKey(value: string) {
  const displayName = cleanDisplayName(value);
  const match = /^([^()]+)\(([A-Za-z]+)\)$/.exec(displayName);
  if (!match) return "";
  const [, body, annotation] = match;
  if (!JWB_LATIN_PARENTHETICAL_ANNOTATION.test(annotation)) {
    return "";
  }
  const cleanBody = cleanDisplayName(body);
  return cleanBody ? normalizeStudentImportName(cleanBody) : "";
}

/**
 * The high-confidence annotation strategy is intentionally one-way. The
 * master name itself may not contain a parenthetical segment; only JWB can
 * contain the sole removable annotation. Global source uniqueness is checked
 * by the caller because that needs both source arrays.
 */
export function isStudentImportJwbLatinParentheticalAnnotationMatch(
  masterName: string,
  jwbName: string,
) {
  const masterDisplayName = cleanDisplayName(masterName);
  if (!masterDisplayName || /[()]/.test(masterDisplayName)) return false;
  const masterKey = normalizeStudentImportName(masterDisplayName);
  const jwbKey = studentImportJwbLatinParentheticalAnnotationKey(jwbName);
  return Boolean(masterKey) && masterKey === jwbKey;
}

/**
 * Returns only duplicate, import-eligible master groups. The normalized name
 * is an internal comparison key and must not be sent to the browser.
 */
export function findMasterStudentDuplicateGroups(
  rows: readonly MasterStudentImportRow[],
): readonly Readonly<{
  normalizedName: string;
  rows: readonly MasterStudentImportRow[];
}>[] {
  const sourceRows = new Set<string>();
  const groups = new Map<string, MasterStudentImportRow[]>();
  for (const row of rows) {
    const key = sourceKey(row.sourceRow, "master source row");
    if (sourceRows.has(key)) {
      throw new StudentImportError(
        "duplicate_master_source_key",
        `Duplicate master source row: ${key}`,
        row.sourceRow,
      );
    }
    sourceRows.add(key);
    const normalizedName = normalizeStudentImportName(row.name);
    const status = typeof row.status === "string" ? row.status.trim() : "";
    if (!normalizedName || status === EXCLUDED_MASTER_STUDENT_STATUS) continue;
    if (status && !isMasterStudentStatus(status)) {
      throw new StudentImportError("invalid_status", `Unsupported master student status: ${String(row.status)}`, row.sourceRow);
    }
    groups.set(normalizedName, [...(groups.get(normalizedName) ?? []), row]);
  }
  const duplicates = [...groups.entries()]
    .filter(([, groupRows]) => groupRows.length > 1)
    .sort(([left], [right]) => compareText(left, right))
    .map(([normalizedName, groupRows]) => ({
      normalizedName,
      rows: [...groupRows].sort((left, right) => compareText(String(left.sourceRow), String(right.sourceRow))),
    }));
  const duplicateKeys = new Set(duplicates.flatMap((group) =>
    group.rows.map((row) => sourceKey(row.sourceRow, "master source row"))));
  const unclosedBlank = rows.find((row) => !String(row.status ?? "").trim()
    && !duplicateKeys.has(sourceKey(row.sourceRow, "master source row")));
  if (unclosedBlank) {
    throw new StudentImportError(
      "invalid_status",
      "A blank master status is allowed only inside a current duplicate-resolution group",
      unclosedBlank.sourceRow,
    );
  }
  return duplicates;
}

/** Applies explicit hard decisions without ever selecting a duplicate row by name. */
export function applyMasterStudentDuplicateResolutions(
  rows: readonly MasterStudentImportRow[],
  resolutions: readonly MasterStudentDuplicateResolution[],
): readonly MasterStudentImportRow[] {
  const groups = findMasterStudentDuplicateGroups(rows);
  const groupByRows = new Map(groups.map((group) => [
    group.rows.map((row) => sourceKey(row.sourceRow, "master source row")).sort(compareText).join("\u0000"),
    group,
  ]));
  const decidedRows = new Set<string>();
  const selectedStatuses = new Map<string, MasterStudentStatus | undefined>();
  for (const resolution of resolutions) {
    if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)
      || (resolution.decision !== "select" && resolution.decision !== "ignore")
      || !Array.isArray(resolution.sourceRows) || resolution.sourceRows.length < 2) {
      throw new StudentImportError("invalid_master_duplicate_resolution", "Master duplicate resolution is invalid");
    }
    const keys = resolution.sourceRows.map((row) => sourceKey(row, "duplicate master source row"));
    if (new Set(keys).size !== keys.length) {
      throw new StudentImportError("invalid_master_duplicate_resolution", "Master duplicate resolution reuses a source row");
    }
    const groupKey = [...keys].sort(compareText).join("\u0000");
    if (!groupByRows.has(groupKey) || keys.some((key) => decidedRows.has(key))) {
      throw new StudentImportError("invalid_master_duplicate_resolution", "Master duplicate resolution does not match a current group");
    }
    keys.forEach((key) => decidedRows.add(key));
    if (resolution.decision === "select") {
      if (resolution.selectedSourceRow === undefined) {
        throw new StudentImportError("invalid_master_duplicate_resolution", "Selected master duplicate row is missing");
      }
      const selected = sourceKey(resolution.selectedSourceRow, "selected duplicate master source row");
      if (!keys.includes(selected)) {
        throw new StudentImportError("invalid_master_duplicate_resolution", "Selected master duplicate row is not in the group");
      }
      const selectedRow = groupByRows.get(groupKey)!.rows.find((row) =>
        sourceKey(row.sourceRow, "master source row") === selected)!;
      const sourceStatus = String(selectedRow.status ?? "").trim();
      if (!sourceStatus) {
        if (!isMasterStudentStatus(resolution.selectedStatus)
          || resolution.selectedStatus === EXCLUDED_MASTER_STUDENT_STATUS) {
          throw new StudentImportError(
            "invalid_master_duplicate_resolution",
            "A selected blank-status master row requires one fixed master status",
          );
        }
        selectedStatuses.set(selected, resolution.selectedStatus);
      } else {
        if (!isMasterStudentStatus(sourceStatus) || resolution.selectedStatus !== undefined) {
          throw new StudentImportError(
            "invalid_master_duplicate_resolution",
            "A selected master row must preserve its valid source status",
          );
        }
        selectedStatuses.set(selected, undefined);
      }
    } else if (resolution.selectedSourceRow !== undefined
      || resolution.selectedStudentId !== undefined
      || resolution.selectedStatus !== undefined) {
      throw new StudentImportError("invalid_master_duplicate_resolution", "Ignored master duplicate group cannot select a row");
    }
  }
  return rows.flatMap((row) => {
    const key = sourceKey(row.sourceRow, "master source row");
    if (!decidedRows.has(key)) return [row];
    if (!selectedStatuses.has(key)) return [];
    const selectedStatus = selectedStatuses.get(key);
    return [{ ...row, ...(selectedStatus ? { status: selectedStatus } : {}) }];
  });
}

export function isMasterStudentStatus(value: unknown): value is MasterStudentStatus {
  return typeof value === "string" && (MASTER_STUDENT_STATUSES as readonly string[]).includes(value);
}

export function parseMasterStudentStatus(value: unknown, sourceRow?: StudentImportSourceKey): MasterStudentStatus {
  if (!isMasterStudentStatus(value)) {
    throw new StudentImportError("invalid_status", `Unsupported master student status: ${String(value)}`, sourceRow);
  }
  return value;
}

function sourceKey(value: unknown, field: string) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new StudentImportError("missing_source_key", `${field} must be a stable string or integer`);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new StudentImportError("missing_source_key", `${field} must be a stable string or integer`, value);
  }
  const key = String(value).trim();
  if (!key || key.length > 240) {
    throw new StudentImportError("missing_source_key", `${field} must contain 1 to 240 characters`, value);
  }
  return key;
}

function optionalMasterJwbMemberKey(value: unknown, sourceRow: StudentImportSourceKey) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return undefined;
  }
  if ((typeof value !== "string" && typeof value !== "number")
    || (typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new StudentImportError(
      "invalid_master_jwb_member_id",
      "Master Jiaowubao member ID must be a stable string or integer",
      sourceRow,
    );
  }
  const key = String(value).trim();
  if (!key || key.length > 240) {
    throw new StudentImportError(
      "invalid_master_jwb_member_id",
      "Master Jiaowubao member ID must contain 1 to 240 characters",
      sourceRow,
    );
  }
  return key;
}

function fnv1a(value: string, seed: number) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(7, "0");
}

function masterSourceNamespace(value: string | undefined) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new StudentImportError(
      "invalid_master_source_namespace",
      "masterSourceNamespace must be text",
    );
  }
  const namespace = value.trim();
  if (!namespace || namespace.length > 160) {
    throw new StudentImportError(
      "invalid_master_source_namespace",
      "masterSourceNamespace must contain 1 to 160 characters",
    );
  }
  return namespace;
}

/** Stable master identity key, namespaced without exposing delimiter collisions. */
export function masterSourceKeyForSource(
  sourceRow: StudentImportSourceKey,
  namespace?: string,
) {
  const key = sourceKey(sourceRow, "master source row");
  const cleanNamespace = masterSourceNamespace(namespace);
  if (cleanNamespace === undefined) return key;
  const identity = JSON.stringify([cleanNamespace, key]);
  return `MSK-N-${fnv1a(identity, 0x811c9dc5)}${fnv1a([...identity].reverse().join(""), 0x9e3779b9)}`;
}

/** Stable across reruns and independent of input row ordering. */
export function studentIdForMasterSource(sourceRow: StudentImportSourceKey, namespace?: string) {
  const key = masterSourceKeyForSource(sourceRow, namespace);
  return `STU-M-${fnv1a(key, 0x811c9dc5)}${fnv1a([...key].reverse().join(""), 0x9e3779b9)}`;
}

/** Stable across reruns and independent of JWB row order or display names. */
export function lessonPackageIdForSource(studentId: string, sourcePackageId: StudentImportSourceKey) {
  const studentKey = sourceKey(studentId, "student id");
  const packageKey = sourceKey(sourcePackageId, "lesson package source id");
  const identity = `${studentKey}\u0000${packageKey}`;
  return `PKG-JWB-${fnv1a(identity, 0x811c9dc5)}${fnv1a([...identity].reverse().join(""), 0x9e3779b9)}`;
}

/** Stable across reruns and independent of purchase ordering. */
export function lessonPackagePurchaseIdForSource(
  lessonPackageId: string,
  sourcePurchaseId: StudentImportSourceKey,
) {
  const packageKey = sourceKey(lessonPackageId, "lesson package id");
  const purchaseKey = sourceKey(sourcePurchaseId, "lesson package purchase source id");
  const identity = `${packageKey}\u0000${purchaseKey}`;
  return `BUY-JWB-${fnv1a(identity, 0x811c9dc5)}${fnv1a([...identity].reverse().join(""), 0x9e3779b9)}`;
}

function optionalHours(value: number | string | null | undefined, field: string, row: StudentImportSourceKey) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new StudentImportError("invalid_hours", `${field} must be a non-negative number`, row);
  }
  if (roundedHours(parsed) !== parsed || Math.abs(parsed * 1_000_000) > Number.MAX_SAFE_INTEGER) {
    throw new StudentImportError("invalid_hours", `${field} must use at most six decimal places`, row);
  }
  return parsed;
}

function optionalSignedHours(value: number | string | null | undefined, field: string, row: StudentImportSourceKey) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new StudentImportError("invalid_hours", `${field} must be a finite number`, row);
  }
  if (roundedHours(parsed) !== parsed || Math.abs(parsed * 1_000_000) > Number.MAX_SAFE_INTEGER) {
    throw new StudentImportError("invalid_hours", `${field} must use at most six decimal places`, row);
  }
  return parsed;
}

function positiveHours(value: unknown, field: string, row: StudentImportSourceKey) {
  const parsed = optionalHours(value as number | string | null | undefined, field, row);
  if (parsed === undefined || parsed <= 0) {
    throw new StudentImportError("invalid_lesson_package", `${field} must be a positive number`, row);
  }
  return parsed;
}

function importDateTime(value: unknown, row: StudentImportSourceKey) {
  if (typeof value !== "string" || !value.trim()) {
    throw new StudentImportError("invalid_lesson_package", "purchasedAt is required", row);
  }
  const clean = value.trim();
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(clean) ? `${clean}T00:00:00.000Z` : clean;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp)
    || !/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
    || !Number.isFinite(new Date(timestamp).getTime())) {
    throw new StudentImportError(
      "invalid_lesson_package",
      "purchasedAt must be YYYY-MM-DD or an ISO timestamp with a timezone",
      row,
    );
  }
  return new Date(timestamp).toISOString();
}

function roundedHours(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function microhourInteger(value: number) {
  const microhours = Math.round(value * 1_000_000);
  if (roundedHours(value) !== value || !Number.isSafeInteger(microhours)) {
    throw new StudentImportError(
      "invalid_hours",
      "Package hour values must be exact micro-hours within the safe aggregate range",
    );
  }
  return microhours;
}

function summedMicrohours(values: readonly number[]) {
  let result = 0;
  for (const value of values) {
    const next = result + microhourInteger(value);
    if (!Number.isSafeInteger(next)) {
      throw new StudentImportError(
        "invalid_hours",
        "Package hour totals exceed the safe aggregate range",
      );
    }
    result = next;
  }
  return result;
}

function hoursMatch(left: number, right: number) {
  return roundedHours(left) === roundedHours(right);
}

function exactObjectFields(value: Record<string, unknown>, allowed: readonly string[]) {
  const fieldSet = new Set(allowed);
  return Object.keys(value).every((field) => fieldSet.has(field));
}

/**
 * Validates and canonicalises package-level JWB rows. No aggregate balance is
 * accepted here and no subject/package relationship is inferred.
 */
export function importLessonPackagesForStudent(
  studentId: string,
  value: unknown,
  sourceRow: StudentImportSourceKey,
): readonly StudentLessonPackage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new StudentImportError(
      "invalid_lesson_package",
      "lessonPackages must contain 1 to 100 authoritative package rows",
      sourceRow,
    );
  }

  const packageKeys = new Set<string>();
  return value.map((packageValue) => {
    if (!packageValue || typeof packageValue !== "object" || Array.isArray(packageValue)) {
      throw new StudentImportError("invalid_lesson_package", "Each lesson package must be an object", sourceRow);
    }
    const sourcePackage = packageValue as Record<string, unknown>;
    if (!exactObjectFields(sourcePackage, [
      "sourcePackageId", "name", "subjectIds", "purchaseRecords", "consumedHours",
    ])) {
      throw new StudentImportError("invalid_lesson_package", "Lesson package contains unsupported fields", sourceRow);
    }
    const packageKey = sourceKey(sourcePackage.sourcePackageId as StudentImportSourceKey, "lesson package source id");
    if (packageKeys.has(packageKey)) {
      throw new StudentImportError(
        "duplicate_package_source_key",
        `Duplicate lesson package source id: ${packageKey}`,
        sourceRow,
      );
    }
    packageKeys.add(packageKey);
    const name = typeof sourcePackage.name === "string" ? cleanDisplayName(sourcePackage.name) : "";
    if (!name || name.length > 240) {
      throw new StudentImportError("invalid_lesson_package", "Lesson package name is required", sourceRow);
    }
    if (!Array.isArray(sourcePackage.subjectIds)
      || sourcePackage.subjectIds.length < 1
      || sourcePackage.subjectIds.length > 100) {
      throw new StudentImportError("invalid_lesson_package", "subjectIds must contain 1 to 100 subjects", sourceRow);
    }
    const subjectIds = sourcePackage.subjectIds.map((subject) =>
      typeof subject === "string" ? cleanDisplayName(subject) : "");
    if (subjectIds.some((subject) => !subject || subject.length > 240)
      || new Set(subjectIds).size !== subjectIds.length) {
      throw new StudentImportError("invalid_lesson_package", "subjectIds must be unique non-empty strings", sourceRow);
    }
    if (!Array.isArray(sourcePackage.purchaseRecords)
      || sourcePackage.purchaseRecords.length < 1
      || sourcePackage.purchaseRecords.length > 1_000) {
      throw new StudentImportError(
        "invalid_lesson_package",
        "purchaseRecords must contain 1 to 1,000 authoritative purchase rows",
        sourceRow,
      );
    }

    const lessonPackageId = lessonPackageIdForSource(studentId, packageKey);
    const purchaseKeys = new Set<string>();
    const purchaseRecords = sourcePackage.purchaseRecords.map((purchaseValue) => {
      if (!purchaseValue || typeof purchaseValue !== "object" || Array.isArray(purchaseValue)) {
        throw new StudentImportError("invalid_lesson_package", "Each purchase record must be an object", sourceRow);
      }
      const purchase = purchaseValue as Record<string, unknown>;
      if (!exactObjectFields(purchase, ["sourcePurchaseId", "purchasedAt", "hours", "note"])) {
        throw new StudentImportError("invalid_lesson_package", "Purchase record contains unsupported fields", sourceRow);
      }
      const purchaseKey = sourceKey(
        purchase.sourcePurchaseId as StudentImportSourceKey,
        "lesson package purchase source id",
      );
      if (purchaseKeys.has(purchaseKey)) {
        throw new StudentImportError(
          "duplicate_purchase_source_key",
          `Duplicate lesson package purchase source id: ${purchaseKey}`,
          sourceRow,
        );
      }
      purchaseKeys.add(purchaseKey);
      if (purchase.note !== undefined && (typeof purchase.note !== "string" || purchase.note.length > 1_000)) {
        throw new StudentImportError("invalid_lesson_package", "Purchase note must be text up to 1,000 characters", sourceRow);
      }
      const note = typeof purchase.note === "string" ? purchase.note.trim() : "";
      return {
        id: lessonPackagePurchaseIdForSource(lessonPackageId, purchaseKey),
        purchasedAt: importDateTime(purchase.purchasedAt, sourceRow),
        hours: positiveHours(purchase.hours, "purchase hours", sourceRow),
        ...(note ? { note } : {}),
      };
    });
    const consumedHours = optionalHours(
      sourcePackage.consumedHours as number | string | null | undefined,
      "consumedHours",
      sourceRow,
    );
    if (consumedHours === undefined) {
      throw new StudentImportError("invalid_lesson_package", "consumedHours is required", sourceRow);
    }
    return {
      id: lessonPackageId,
      name,
      subjectIds,
      purchaseRecords,
      consumedHours: roundedHours(consumedHours),
    };
  });
}

function packageTotals(packages: readonly StudentLessonPackage[]) {
  const contractMicrohours = summedMicrohours(packages.flatMap((lessonPackage) =>
    lessonPackage.purchaseRecords.map((purchase) => purchase.hours)));
  const consumedMicrohours = summedMicrohours(packages.map((lessonPackage) => lessonPackage.consumedHours));
  const remainingMicrohours = contractMicrohours - consumedMicrohours;
  if (!Number.isSafeInteger(remainingMicrohours)) {
    throw new StudentImportError("invalid_hours", "Package remaining hours exceed the safe aggregate range");
  }
  return {
    contractHours: contractMicrohours / 1_000_000,
    remainingHours: remainingMicrohours / 1_000_000,
  };
}

function copyLessonPackages(packages: readonly StudentLessonPackage[]) {
  return packages.map((lessonPackage) => ({
    ...lessonPackage,
    subjectIds: [...lessonPackage.subjectIds],
    purchaseRecords: lessonPackage.purchaseRecords.map((purchase) => ({ ...purchase })),
  }));
}

function isManagedJwbPackage(lessonPackage: StudentLessonPackage) {
  return lessonPackage.id.startsWith("PKG-JWB-");
}

function copyUnmanaged(attributes: StudentImportAttributes | ExistingStudentImportRecord | undefined) {
  const result: Record<string, unknown> = {};
  if (!attributes) return result;
  for (const [key, value] of Object.entries(attributes)) {
    if (!managedFields.has(key)) result[key] = value;
  }
  return result;
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`);
  return `{${entries.join(",")}}`;
}

function changedFields(before: ExistingStudentImportRecord, after: ImportedStudentRecord) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => stableValue(before[key]) !== stableValue(after[key]))
    .sort(compareText);
}

const STUDENT_NUMBER_PATTERN = /^\d{11}$/;

function dateKeyForStudentNumber(value: unknown, sourceRow: StudentImportSourceKey) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  const date = value.slice(0, 10);
  if (Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
    throw new StudentImportError("invalid_hours", "firstJwbHourEntryDate is not a valid date", sourceRow);
  }
  return date.replaceAll("-", "");
}

/**
 * A student number records the earliest positive JWB contract date, not when
 * this application happened to import the record. Existing numbers are
 * immutable; missing numbers are allocated deterministically by contract date
 * then system ID so retrying an unchanged import cannot renumber anyone.
 */
function assignStudentNumbersFromJwb(
  imported: readonly ImportedStudentRecord[],
  existingStudents: readonly ExistingStudentImportRecord[],
  reservations: readonly StudentNumberReservation[],
) {
  const usedNumbers = new Set<string>();
  const reservedNumberByStudentId = new Map<string, string>();
  const reservedStudentIdByNumber = new Map<string, string>();
  for (const reservation of reservations) {
    if (typeof reservation.studentId !== "string" || !reservation.studentId.trim()
      || typeof reservation.studentNumber !== "string" || !STUDENT_NUMBER_PATTERN.test(reservation.studentNumber)) {
      throw new StudentImportError("invalid_hours", "student number reservation is invalid", reservation.studentId);
    }
    const studentId = reservation.studentId.trim();
    const priorNumber = reservedNumberByStudentId.get(studentId);
    const priorStudentId = reservedStudentIdByNumber.get(reservation.studentNumber);
    if ((priorNumber !== undefined && priorNumber !== reservation.studentNumber)
      || (priorStudentId !== undefined && priorStudentId !== studentId)) {
      throw new StudentImportError("duplicate_output_id", "student number reservations must be one-to-one", studentId);
    }
    reservedNumberByStudentId.set(studentId, reservation.studentNumber);
    reservedStudentIdByNumber.set(reservation.studentNumber, studentId);
    usedNumbers.add(reservation.studentNumber);
  }
  for (const student of existingStudents) {
    if (student.studentNumber === undefined) continue;
    if (typeof student.studentNumber !== "string" || !STUDENT_NUMBER_PATTERN.test(student.studentNumber)) {
      throw new StudentImportError("invalid_hours", "existing studentNumber must be YYYYMMDD plus a three-digit serial", student.id);
    }
    const reservedNumber = reservedNumberByStudentId.get(student.id);
    const reservedStudentId = reservedStudentIdByNumber.get(student.studentNumber);
    if ((reservedNumber !== undefined && reservedNumber !== student.studentNumber)
      || (reservedStudentId !== undefined && reservedStudentId !== student.id)) {
      throw new StudentImportError("duplicate_output_id", "existing studentNumber conflicts with the historical reservation", student.id);
    }
    if (usedNumbers.has(student.studentNumber)) {
      // A current record is expected to repeat its own permanent reservation.
      if (reservedStudentId !== student.id) {
        throw new StudentImportError("duplicate_output_id", "duplicate existing studentNumber", student.id);
      }
    }
    usedNumbers.add(student.studentNumber);
  }

  const existingById = new Map(existingStudents.map((student) => [student.id, student]));
  const importedStudentIdByNumber = new Map<string, string>();
  for (const student of imported) {
    if (student.studentNumber === undefined) continue;
    if (typeof student.studentNumber !== "string" || !STUDENT_NUMBER_PATTERN.test(student.studentNumber)) {
      throw new StudentImportError("invalid_hours", "imported studentNumber must be YYYYMMDD plus a three-digit serial", student.id);
    }
    const existingNumber = existingById.get(student.id)?.studentNumber;
    const reservedNumber = reservedNumberByStudentId.get(student.id);
    const reservedStudentId = reservedStudentIdByNumber.get(student.studentNumber);
    const importedStudentId = importedStudentIdByNumber.get(student.studentNumber);
    if ((existingNumber !== undefined && existingNumber !== student.studentNumber)
      || (reservedNumber !== undefined && reservedNumber !== student.studentNumber)
      || (reservedStudentId !== undefined && reservedStudentId !== student.id)
      || (importedStudentId !== undefined && importedStudentId !== student.id)) {
      throw new StudentImportError("duplicate_output_id", "imported studentNumber conflicts with the historical reservation", student.id);
    }
    importedStudentIdByNumber.set(student.studentNumber, student.id);
    usedNumbers.add(student.studentNumber);
  }
  const pending = imported
    .filter((student) => {
      const existingNumber = existingById.get(student.id)?.studentNumber;
      const reservedNumber = reservedNumberByStudentId.get(student.id);
      if (existingNumber !== undefined && reservedNumber !== undefined && existingNumber !== reservedNumber) {
        throw new StudentImportError("duplicate_output_id", "existing studentNumber conflicts with the historical reservation", student.id);
      }
      if (student.studentNumber !== undefined && reservedNumber !== undefined && student.studentNumber !== reservedNumber) {
        throw new StudentImportError("duplicate_output_id", "imported studentNumber conflicts with the historical reservation", student.id);
      }
      return existingNumber === undefined && student.studentNumber === undefined && reservedNumber === undefined;
    })
    .map((student) => ({
      student,
      dateKey: dateKeyForStudentNumber(student.firstJwbHourEntryDate, student.sourceRow ?? student.id),
    }))
    .filter((entry): entry is { student: ImportedStudentRecord; dateKey: string } => Boolean(entry.dateKey))
    .sort((left, right) => compareText(left.dateKey, right.dateKey) || compareText(left.student.id, right.student.id));

  const nextSerialByDate = new Map<string, number>();
  for (const number of usedNumbers) {
    const dateKey = number.slice(0, 8);
    const serial = Number(number.slice(8));
    nextSerialByDate.set(dateKey, Math.max(nextSerialByDate.get(dateKey) ?? 0, serial));
  }
  const assigned = new Map<string, string>();
  for (const { student, dateKey } of pending) {
    const serial = (nextSerialByDate.get(dateKey) ?? 0) + 1;
    if (serial > 999) {
      throw new StudentImportError("invalid_hours", `student number daily sequence exceeds 999 for ${dateKey}`, student.sourceRow ?? student.id);
    }
    const studentNumber = `${dateKey}${String(serial).padStart(3, "0")}`;
    if (usedNumbers.has(studentNumber)) {
      throw new StudentImportError("duplicate_output_id", "generated duplicate studentNumber", student.sourceRow ?? student.id);
    }
    nextSerialByDate.set(dateKey, serial);
    usedNumbers.add(studentNumber);
    assigned.set(student.id, studentNumber);
  }
  return imported.map((student) => {
    const existingNumber = existingById.get(student.id)?.studentNumber;
    const reservedNumber = reservedNumberByStudentId.get(student.id);
    const importedNumber = student.studentNumber;
    if ((typeof existingNumber === "string" && reservedNumber !== undefined && existingNumber !== reservedNumber)
      || (typeof importedNumber === "string" && reservedNumber !== undefined && importedNumber !== reservedNumber)) {
      throw new StudentImportError("duplicate_output_id", "studentNumber conflicts with the historical reservation", student.id);
    }
    const studentNumber = typeof existingNumber === "string"
      ? existingNumber
      : typeof importedNumber === "string"
        ? importedNumber
        : reservedNumber ?? assigned.get(student.id);
    return studentNumber === undefined ? student : { ...student, studentNumber };
  });
}

function groupByName<Row extends { name: string }>(rows: readonly Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = normalizeStudentImportName(row.name);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

function existingMasterKey(student: ExistingStudentImportRecord, trustLegacySourceRow = true) {
  if (student.masterSourceKey !== undefined) return sourceKey(student.masterSourceKey, "existing master source key");
  if (trustLegacySourceRow && student.sourceRow !== undefined) {
    return sourceKey(student.sourceRow, "existing source row");
  }
  return null;
}

function isManualTrial(student: ExistingStudentImportRecord) {
  return student.importSource === "manual_trial"
    || (existingMasterKey(student) === null && student.segment === "试听");
}

function sortedSourceRows(rows: readonly StudentImportSourceKey[]) {
  return [...rows].sort((left, right) => compareText(String(left), String(right)));
}

function makeAmbiguity(
  kind: StudentImportAmbiguity["kind"],
  normalizedName: string | undefined,
  masterRows: readonly MasterStudentImportRow[] = [],
  jwbRows: readonly JwbStudentImportRow[] = [],
  existingStudents: readonly ExistingStudentImportRecord[] = [],
): StudentImportAmbiguity {
  return {
    kind,
    ...(normalizedName ? { normalizedName } : {}),
    masterSourceRows: sortedSourceRows(masterRows.map((row) => row.sourceRow)),
    jwbSourceRows: sortedSourceRows(jwbRows.map((row) => row.sourceRow)),
    existingStudentIds: existingStudents.map((student) => student.id).sort(compareText),
  };
}

/**
 * Builds a dry-run and the exact replacement student list without mutating any
 * input. The returned list can be supplied as `existingStudents` on the next
 * run; if the sources did not change, that run has zero inserts and updates.
 */
export function buildStudentImportPlan(input: BuildStudentImportPlanInput): StudentImportPlan {
  const existingStudents = input.existingStudents ?? [];
  const preserveManualTrials = input.preserveManualTrials !== false;
  const allowLegacyIdentityFallback = input.allowLegacyIdentityFallback !== false;
  const preserveReferencedStudentIds = input.preserveReferencedStudentIds instanceof Set
    ? input.preserveReferencedStudentIds
    : new Set(input.preserveReferencedStudentIds ?? []);
  const namespace = masterSourceNamespace(input.masterSourceNamespace);
  const excluded: StudentImportExcluded[] = [];
  const unmatched: StudentImportUnmatched[] = [];
  const ambiguous: StudentImportAmbiguity[] = [];

  const masterKeys = new Set<string>();
  const masterJwbMemberKeys = new Set<string>();
  const masterJwbMemberOwnerByKey = new Map<string, string>();
  // Validate every authoritative master row before excluding inactive/blank
  // rows. A populated JWB member ID is source identity evidence, so an
  // unknown, duplicate, or cross-name ID must never be hidden in a row that
  // happens not to produce a current student record.
  const masterEntries = [...input.masterRows]
    .map((row) => {
      const rawKey = sourceKey(row.sourceRow, "master source row");
      if (masterKeys.has(rawKey)) {
        throw new StudentImportError("duplicate_master_source_key", `Duplicate master source row: ${rawKey}`, row.sourceRow);
      }
      masterKeys.add(rawKey);
      const jwbMemberKey = optionalMasterJwbMemberKey(row.jwbMemId, row.sourceRow);
      if (jwbMemberKey !== undefined && masterJwbMemberKeys.has(jwbMemberKey)) {
        throw new StudentImportError(
          "duplicate_master_jwb_member_id",
          `Duplicate master Jiaowubao member ID: ${jwbMemberKey}`,
          row.sourceRow,
        );
      }
      if (jwbMemberKey !== undefined) {
        masterJwbMemberKeys.add(jwbMemberKey);
        masterJwbMemberOwnerByKey.set(jwbMemberKey, rawKey);
      }
      return {
        row,
        rawKey,
        key: masterSourceKeyForSource(row.sourceRow, namespace),
        status: parseMasterStudentStatus(row.status, row.sourceRow),
        name: cleanDisplayName(row.name),
        ...(jwbMemberKey !== undefined ? { jwbMemberKey } : {}),
      };
    })
    .sort((left, right) => compareText(left.rawKey, right.rawKey));
  const eligibleMasterRows = masterEntries
    .filter(({ row, status, name }) => {
      if (!name) {
        excluded.push({ sourceRow: row.sourceRow, name: "", status, reason: "empty_name" });
        return false;
      }
      if (status === EXCLUDED_MASTER_STUDENT_STATUS) {
        excluded.push({ sourceRow: row.sourceRow, name, status, reason: "inactive_without_hours" });
        return false;
      }
      return true;
    });

  const cleanJwbRows = [...input.jwbRows]
    .map((row) => ({ row, key: sourceKey(row.sourceRow, "JWB source row"), name: cleanDisplayName(row.name) }))
    .sort((left, right) => compareText(left.key, right.key));

  // The annotation exception is not a second automatic matching key. These
  // source-wide indexes are used only to revalidate a link that was explicitly
  // confirmed through the dedicated high-confidence review flow. Every raw
  // master/JWB/current-student display name participates in its relaxed-body
  // collision key, even if it cannot be the candidate itself. Thus `张三` and
  // `张三（VIC）` can never be mistaken for one unique account on any side.
  const annotationMasterRowsByKey = new Map<string, string[]>();
  for (const entry of masterEntries) {
    const key = studentImportJwbLatinParentheticalAnnotationKey(entry.name)
      || normalizeStudentImportName(entry.name);
    if (key) annotationMasterRowsByKey.set(key, [
      ...(annotationMasterRowsByKey.get(key) ?? []),
      entry.rawKey,
    ]);
  }
  const annotationJwbRowsByKey = new Map<string, string[]>();
  for (const entry of cleanJwbRows) {
    const key = studentImportJwbLatinParentheticalAnnotationKey(entry.name)
      || normalizeStudentImportName(entry.name);
    if (key) annotationJwbRowsByKey.set(key, [
      ...(annotationJwbRowsByKey.get(key) ?? []),
      entry.key,
    ]);
  }

  if (input.identityLinks !== undefined && !Array.isArray(input.identityLinks)) {
    throw new StudentImportError("invalid_identity_link", "identityLinks must be an array");
  }
  const eligibleMasterByRawKey = new Map(eligibleMasterRows.map((entry) => [entry.rawKey, entry]));
  // A deterministic master identity belongs to its active master source row,
  // even when that row cannot itself qualify for the narrow annotation
  // exception (for example, its display name contains parentheses).  Without
  // this ownership check, a reviewed link could point another master row at
  // an existing student whose ID is reserved by such a row, then later make
  // the canonical output contain that ID twice.
  const derivedMasterOwnersByStudentId = new Map<string, string[]>();
  for (const entry of eligibleMasterRows) {
    const derivedStudentId = studentIdForMasterSource(entry.row.sourceRow, namespace);
    derivedMasterOwnersByStudentId.set(derivedStudentId, [
      ...(derivedMasterOwnersByStudentId.get(derivedStudentId) ?? []),
      entry.rawKey,
    ]);
  }
  const jwbByKey = new Map<string, typeof cleanJwbRows>();
  for (const entry of cleanJwbRows) {
    jwbByKey.set(entry.key, [...(jwbByKey.get(entry.key) ?? []), entry]);
  }
  // A master-provided JWB member ID is evidence for choosing one otherwise
  // exact-name JWB row. It is deliberately not a name override: wrong,
  // missing or duplicate IDs stop the import instead of silently attaching
  // someone else's account.
  const explicitJwbByMasterKey = new Map<string, typeof cleanJwbRows[number]>();
  for (const masterEntry of masterEntries) {
    if (masterEntry.jwbMemberKey === undefined) continue;
    const matches = jwbByKey.get(masterEntry.jwbMemberKey) ?? [];
    if (matches.length !== 1) {
      throw new StudentImportError(
        "invalid_master_jwb_member_id",
        `Master Jiaowubao member ID ${masterEntry.jwbMemberKey} must identify exactly one current JWB row`,
        masterEntry.row.sourceRow,
      );
    }
    const jwbEntry = matches[0];
    const masterName = normalizeStudentImportName(masterEntry.name);
    const jwbName = normalizeStudentImportName(jwbEntry.name);
    if (!masterName || masterName !== jwbName) {
      throw new StudentImportError(
        "master_jwb_member_id_name_mismatch",
        "Master Jiaowubao member ID may only disambiguate an exact full-name match; correct the master name first",
        masterEntry.row.sourceRow,
      );
    }
    if (eligibleMasterByRawKey.has(masterEntry.rawKey)) {
      explicitJwbByMasterKey.set(masterEntry.rawKey, jwbEntry);
    }
  }
  const existingById = new Map<string, ExistingStudentImportRecord[]>();
  const annotationExistingIdsByKey = new Map<string, string[]>();
  for (const student of existingStudents) {
    const id = sourceKey(student.id, "existing student id");
    existingById.set(id, [...(existingById.get(id) ?? []), student]);
    const annotationKey = studentImportJwbLatinParentheticalAnnotationKey(student.name)
      || normalizeStudentImportName(student.name);
    if (annotationKey) annotationExistingIdsByKey.set(annotationKey, [
      ...(annotationExistingIdsByKey.get(annotationKey) ?? []),
      id,
    ]);
  }

  const linkedMasterKeys = new Set<string>();
  const linkedJwbKeys = new Set<string>();
  const linkedStudentIds = new Set<string>();
  const identityByMasterKey = new Map<string, Readonly<{
    existing?: ExistingStudentImportRecord;
    jwb?: JwbStudentImportRow;
  }>>();
  for (const [index, linkValue] of (input.identityLinks ?? []).entries()) {
    if (!linkValue || typeof linkValue !== "object" || Array.isArray(linkValue)
      || !exactObjectFields(linkValue as unknown as Record<string, unknown>, [
        "masterSourceRow", "studentId", "jwbSourceRow", "matchStrategy",
      ])) {
      throw new StudentImportError("invalid_identity_link", `Identity link ${index + 1} is invalid`);
    }
    const masterKey = sourceKey(linkValue.masterSourceRow, "identity link master source row");
    if (typeof linkValue.studentId !== "string") {
      throw new StudentImportError(
        "invalid_identity_link",
        `Identity link ${index + 1} studentId must be text`,
        linkValue.masterSourceRow,
      );
    }
    const studentId = sourceKey(linkValue.studentId, "identity link student id");
    const jwbKey = linkValue.jwbSourceRow === undefined
      ? undefined
      : sourceKey(linkValue.jwbSourceRow, "identity link JWB source row");
    const matchStrategy = linkValue.matchStrategy;
    if (matchStrategy !== undefined
      && matchStrategy !== STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1) {
      throw new StudentImportError(
        "invalid_identity_link_match_strategy",
        `Identity link ${index + 1} has an unsupported match strategy`,
        linkValue.masterSourceRow,
      );
    }
    if (matchStrategy !== undefined && jwbKey === undefined) {
      throw new StudentImportError(
        "invalid_identity_link_match_strategy",
        `Identity link ${index + 1} needs a JWB row for its match strategy`,
        linkValue.masterSourceRow,
      );
    }
    if (linkedMasterKeys.has(masterKey)
      || linkedStudentIds.has(studentId)
      || (jwbKey !== undefined && linkedJwbKeys.has(jwbKey))) {
      throw new StudentImportError(
        "duplicate_identity_link",
        `Identity link ${index + 1} reuses a master row, student or JWB row`,
        linkValue.masterSourceRow,
      );
    }
    if (!eligibleMasterByRawKey.has(masterKey)) {
      throw new StudentImportError(
        "invalid_identity_link",
        `Identity link ${index + 1} references an unknown or excluded master row`,
        linkValue.masterSourceRow,
      );
    }
    const existingMatches = existingById.get(studentId) ?? [];
    const masterEntry = eligibleMasterByRawKey.get(masterKey)!;
    const conflictingDerivedOwner = (derivedMasterOwnersByStudentId.get(studentId) ?? [])
      .find((ownerKey) => ownerKey !== masterKey);
    if (conflictingDerivedOwner !== undefined) {
      throw new StudentImportError(
        "invalid_identity_link",
        `Identity link ${index + 1} targets the deterministic identity owned by another active master row`,
        linkValue.masterSourceRow,
      );
    }
    const explicitJwb = explicitJwbByMasterKey.get(masterKey);
    const exactDerivedCreateId = studentIdForMasterSource(
      masterEntry.row.sourceRow,
      namespace,
    );
    const reviewedCreate = existingMatches.length === 0 && studentId === exactDerivedCreateId;
    if (existingMatches.length > 1 || (existingMatches.length === 0 && !reviewedCreate)) {
      throw new StudentImportError(
        "invalid_identity_link",
        `Identity link ${index + 1} must reference one existing student or the exact derived identity`,
        linkValue.masterSourceRow,
      );
    }
    if (existingMatches[0]) {
      const masterName = normalizeStudentImportName(masterEntry.name);
      const existingName = normalizeStudentImportName(existingMatches[0].name);
      if (!masterName || masterName !== existingName) {
        throw new StudentImportError(
          "identity_link_name_mismatch",
          `Identity link ${index + 1} does not satisfy the exact master/current-student full-name contract; correct the master source and review it again`,
          linkValue.masterSourceRow,
        );
      }
    }
    const jwbMatches = jwbKey === undefined ? [] : (jwbByKey.get(jwbKey) ?? []);
    if (jwbKey !== undefined && jwbMatches.length !== 1) {
      throw new StudentImportError(
        "invalid_identity_link",
        `Identity link ${index + 1} must reference exactly one JWB row`,
        linkValue.masterSourceRow,
      );
    }
    if (explicitJwb !== undefined && jwbKey !== undefined && jwbKey !== explicitJwb.key) {
      throw new StudentImportError(
        "master_jwb_member_id_identity_link_conflict",
        "The reviewed JWB row conflicts with the authoritative master Jiaowubao member ID",
        linkValue.masterSourceRow,
      );
    }
    const explicitOwner = jwbKey === undefined ? undefined : masterJwbMemberOwnerByKey.get(jwbKey);
    if (explicitOwner !== undefined && explicitOwner !== masterKey) {
      throw new StudentImportError(
        "master_jwb_member_id_identity_link_conflict",
        "The reviewed JWB row is reserved by another master Jiaowubao member ID",
        linkValue.masterSourceRow,
      );
    }
    if (jwbMatches[0]) {
      const masterName = normalizeStudentImportName(masterEntry.name);
      const jwbName = normalizeStudentImportName(jwbMatches[0].name);
      const exactNameMatch = Boolean(masterName) && masterName === jwbName;
      const annotationExistingConflict = (annotationExistingIdsByKey.get(masterName) ?? [])
        .some((existingId) => existingId !== studentId);
      const annotationMatch = matchStrategy === STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1
        && !exactNameMatch
        && isStudentImportJwbLatinParentheticalAnnotationMatch(masterEntry.name, jwbMatches[0].name)
        && annotationMasterRowsByKey.get(masterName)?.length === 1
        && annotationMasterRowsByKey.get(masterName)?.[0] === masterKey
        && annotationJwbRowsByKey.get(masterName)?.length === 1
        && annotationJwbRowsByKey.get(masterName)?.[0] === jwbKey
        && !annotationExistingConflict;
      // A cross-name link is valid only when it carries the narrow durable
      // annotation strategy and its source-wide one-to-one proof still holds.
      // A strategy on an already exact pair is rejected instead of becoming a
      // meaningless escape hatch for future broader matching rules.
      if (!exactNameMatch && !annotationMatch) {
        throw new StudentImportError(
          "identity_link_name_mismatch",
          `Identity link ${index + 1} does not satisfy the strict or reviewed JWB annotation identity contract`,
          linkValue.masterSourceRow,
        );
      }
      if (exactNameMatch && matchStrategy !== undefined) {
        throw new StudentImportError(
          "invalid_identity_link_match_strategy",
          `Identity link ${index + 1} must not label an exact full-name match as an annotation exception`,
          linkValue.masterSourceRow,
        );
      }
    }
    linkedMasterKeys.add(masterKey);
    linkedStudentIds.add(studentId);
    if (jwbKey !== undefined) linkedJwbKeys.add(jwbKey);
    identityByMasterKey.set(masterKey, {
      ...(existingMatches[0] ? { existing: existingMatches[0] } : {}),
      ...(jwbMatches[0] ? { jwb: jwbMatches[0].row } : {}),
    });
  }

  const explicitMasterKeys = new Set(explicitJwbByMasterKey.keys());
  const declaredJwbMemberKeys = new Set(masterJwbMemberOwnerByKey.keys());
  const unlinkedMasterRows = eligibleMasterRows.filter(({ rawKey }) =>
    !linkedMasterKeys.has(rawKey) && !explicitMasterKeys.has(rawKey));
  const unlinkedJwbRows = cleanJwbRows.filter(({ key }) =>
    !linkedJwbKeys.has(key) && !declaredJwbMemberKeys.has(key));
  for (const { row, name } of unlinkedJwbRows) {
    if (!name) unmatched.push({ source: "jwb", sourceRow: row.sourceRow, name: "", reason: "empty_name" });
  }

  const masterNameGroups = groupByName(unlinkedMasterRows.map(({ row, name }) => ({ ...row, name })));
  const jwbNameGroups = groupByName(unlinkedJwbRows.filter(({ name }) => name).map(({ row, name }) => ({ ...row, name })));
  const intentionallyExcludedNames = new Set(
    excluded.map((entry) => normalizeStudentImportName(entry.name)).filter(Boolean),
  );
  const allNames = [...new Set([...masterNameGroups.keys(), ...jwbNameGroups.keys()])].sort(compareText);
  const matchedJwbByMasterKey = new Map<string, JwbStudentImportRow>();
  for (const [masterKey, jwb] of explicitJwbByMasterKey) {
    matchedJwbByMasterKey.set(masterKey, jwb.row);
  }
  for (const [masterKey, identity] of identityByMasterKey) {
    if (identity.jwb) {
      const explicitJwb = explicitJwbByMasterKey.get(masterKey);
      if (explicitJwb !== undefined && sourceKey(identity.jwb.sourceRow, "reviewed JWB source row") !== explicitJwb.key) {
        throw new StudentImportError(
          "master_jwb_member_id_identity_link_conflict",
          "The reviewed JWB row conflicts with the authoritative master Jiaowubao member ID",
          identity.jwb.sourceRow,
        );
      }
      matchedJwbByMasterKey.set(masterKey, identity.jwb);
    }
  }
  const ambiguousNames = new Set<string>();

  for (const name of allNames) {
    const masters = masterNameGroups.get(name) ?? [];
    const jwb = jwbNameGroups.get(name) ?? [];
    if (masters.length > 1 || jwb.length > 1) {
      // Duplicate JWB-only rows are outside the authoritative master scope.
      // Keep them visible as unmatched source data, but do not block an import
      // that cannot attach them to any formal student record.
      if (masters.length === 0 && jwb.length > 1) {
        if (!intentionallyExcludedNames.has(name)) {
          for (const row of jwb) {
            unmatched.push({
              source: "jwb",
              sourceRow: row.sourceRow,
              name: cleanDisplayName(row.name),
              reason: "not_in_master",
            });
          }
        }
      } else {
        ambiguousNames.add(name);
        ambiguous.push(makeAmbiguity("name", name, masters, jwb));
      }
      continue;
    }
    if (masters.length === 1 && jwb.length === 1) {
      matchedJwbByMasterKey.set(
        sourceKey(masters[0].sourceRow, "master source row"),
        jwb[0],
      );
    } else if (masters.length === 1) {
      unmatched.push({ source: "master", sourceRow: masters[0].sourceRow, name: cleanDisplayName(masters[0].name), reason: "missing_jwb" });
    } else if (jwb.length === 1 && !intentionallyExcludedNames.has(name)) {
      unmatched.push({ source: "jwb", sourceRow: jwb[0].sourceRow, name: cleanDisplayName(jwb[0].name), reason: "not_in_master" });
    }
  }

  const existingByKey = new Map<string, ExistingStudentImportRecord[]>();
  const legacyExistingByName = new Map<string, ExistingStudentImportRecord[]>();
  const currentNamespacedIds = new Map(eligibleMasterRows.map(({ row, key }) => [
    key,
    studentIdForMasterSource(row.sourceRow, namespace),
  ]));
  for (const student of existingStudents) {
    if (linkedStudentIds.has(student.id)) continue;
    const key = existingMasterKey(student, namespace === undefined);
    const currentNamespacedIdentity = namespace !== undefined
      && key !== null
      && currentNamespacedIds.get(key) === student.id;
    if (currentNamespacedIdentity || (allowLegacyIdentityFallback && key !== null)) {
      existingByKey.set(key!, [...(existingByKey.get(key!) ?? []), student]);
    } else if (allowLegacyIdentityFallback && !isManualTrial(student)) {
      const name = normalizeStudentImportName(student.name);
      if (name) legacyExistingByName.set(name, [...(legacyExistingByName.get(name) ?? []), student]);
    }
  }

  const actions: StudentImportAction[] = [];
  const imported: ImportedStudentRecord[] = [];
  const matchedJwbByStudentId = new Map<string, JwbStudentImportRow>();
  const usedExistingIds = new Set<string>();

  for (const { row, rawKey, key, status, name } of eligibleMasterRows) {
    const normalizedName = normalizeStudentImportName(name);
    const byKey = existingByKey.get(key) ?? [];
    const byName = legacyExistingByName.get(normalizedName) ?? [];
    const linkedIdentity = identityByMasterKey.get(rawKey);
    let existing: ExistingStudentImportRecord | undefined = linkedIdentity?.existing;

    if (!linkedIdentity) {
      if (byKey.length === 1) existing = byKey[0];
      else if (byKey.length > 1) ambiguous.push(makeAmbiguity("existing_source", normalizedName, [row], [], byKey));
      else if (allowLegacyIdentityFallback && !ambiguousNames.has(normalizedName) && byName.length === 1) existing = byName[0];
      else if (allowLegacyIdentityFallback && !ambiguousNames.has(normalizedName) && byName.length > 1) ambiguous.push(makeAmbiguity("existing_name", normalizedName, [row], [], byName));
    }

    if (existing && usedExistingIds.has(existing.id)) {
      ambiguous.push(makeAmbiguity("existing_name", normalizedName, [row], [], [existing]));
      existing = undefined;
    }

    const matchedJwb = matchedJwbByMasterKey.get(rawKey);
    if (matchedJwb) matchedJwbByStudentId.set(existing?.id ?? studentIdForMasterSource(row.sourceRow, namespace), matchedJwb);
    const jwbStatus: ImportedStudentRecord["jwbMatchStatus"] = !linkedIdentity && ambiguousNames.has(normalizedName)
      ? "ambiguous"
      : matchedJwb
        ? "matched"
        : "unmatched";
    const id = existing?.id ?? studentIdForMasterSource(row.sourceRow, namespace);
    const sourceRemainingHours = matchedJwb
      ? optionalSignedHours(matchedJwb.remainingHours, "remainingHours", matchedJwb.sourceRow)
      : undefined;
    const sourceContractHours = matchedJwb
      ? optionalHours(matchedJwb.contractHours, "contractHours", matchedJwb.sourceRow)
      : undefined;
    const authoritativeJwbPackages = matchedJwb?.lessonPackages === undefined
      ? undefined
      : importLessonPackagesForStudent(id, matchedJwb.lessonPackages, matchedJwb.sourceRow);
    const existingPackages = Array.isArray(existing?.lessonPackages)
      ? copyLessonPackages(existing.lessonPackages)
      : [];
    const existingManualPackages = existingPackages.filter((lessonPackage) => !isManagedJwbPackage(lessonPackage));
    const existingJwbPackages = existingPackages.filter(isManagedJwbPackage);
    const existingPackageCoverage = existing?.packageCoverage === "complete"
      || existing?.packageCoverage === "partial"
      || existing?.packageCoverage === "none"
      ? existing.packageCoverage
      : undefined;
    const preserveExistingAggregate = matchedJwb === undefined
      && (existingPackageCoverage === "partial" || existingPackageCoverage === "none");
    const existingRemainingHours = preserveExistingAggregate
      ? optionalSignedHours(
        existing?.remainingHours as number | string | null | undefined,
        "remainingHours",
        existing?.sourceRow ?? existing?.id ?? row.sourceRow,
      )
      : undefined;
    const existingContractHours = preserveExistingAggregate
      ? optionalHours(
        existing?.contractHours as number | string | null | undefined,
        "contractHours",
        existing?.sourceRow ?? existing?.id ?? row.sourceRow,
      )
      : undefined;
    const packageCoverage = matchedJwb?.packageCoverage
      ?? (matchedJwb?.lessonPackages?.length
        ? "complete"
        : existingJwbPackages.length
          ? existingPackageCoverage ?? "partial"
          : "none");
    if (sourceRemainingHours !== undefined && sourceRemainingHours < 0 && packageCoverage !== "none") {
      throw new StudentImportError(
        "package_balance_mismatch",
        "Negative JWB aggregate balances must use none package coverage",
        matchedJwb!.sourceRow,
      );
    }
    const shouldReplaceManagedJwbPackages = matchedJwb?.packageCoverage !== undefined
      || authoritativeJwbPackages !== undefined;
    const jwbPackages = authoritativeJwbPackages
      ?? (shouldReplaceManagedJwbPackages ? [] : existingJwbPackages);
    const lessonPackages = [...existingManualPackages, ...jwbPackages];
    const authoritativeTotals = authoritativeJwbPackages?.length
      ? packageTotals(authoritativeJwbPackages)
      : undefined;
    // The top-level totals are the Jiaowubao aggregate. Manual packages remain
    // visible in the package list, but must never inflate that source balance.
    const fallbackTotals = jwbPackages.length ? packageTotals(jwbPackages) : undefined;
    if (packageCoverage === "complete" && authoritativeJwbPackages && sourceRemainingHours !== undefined
      && !hoursMatch(sourceRemainingHours, authoritativeTotals!.remainingHours)) {
      throw new StudentImportError(
        "package_balance_mismatch",
        "remainingHours does not equal the authoritative lesson package balance",
        matchedJwb!.sourceRow,
      );
    }
    if (packageCoverage === "complete" && authoritativeJwbPackages && sourceContractHours !== undefined
      && !hoursMatch(sourceContractHours, authoritativeTotals!.contractHours)) {
      throw new StudentImportError(
        "package_balance_mismatch",
        "contractHours does not equal authoritative lesson package purchases",
        matchedJwb!.sourceRow,
      );
    }
    const record: ImportedStudentRecord = {
      ...importedStudentDefaults(name, row.attributes),
      ...copyUnmanaged(existing),
      ...copyUnmanaged(matchedJwb?.attributes),
      ...copyUnmanaged(row.attributes),
      id,
      name,
      status,
      sourceRow: row.sourceRow,
      masterSourceKey: key,
      importSource: "master",
      jwbMatchStatus: jwbStatus,
      ...(matchedJwb ? { jwbSourceRow: matchedJwb.sourceRow } : {}),
      ...(matchedJwb?.packageCoverage || jwbPackages.length || existingPackageCoverage
        ? { packageCoverage }
        : {}),
      ...(sourceRemainingHours !== undefined
        ? { remainingHours: sourceRemainingHours }
        : existingRemainingHours !== undefined
        ? { remainingHours: existingRemainingHours }
        : fallbackTotals
        ? { remainingHours: fallbackTotals.remainingHours }
        : {}),
      ...(sourceContractHours !== undefined
        ? { contractHours: sourceContractHours }
        : existingContractHours !== undefined
        ? { contractHours: existingContractHours }
        : fallbackTotals
        ? { contractHours: fallbackTotals.contractHours }
        : {}),
      ...(matchedJwb?.contractEffectiveDate?.trim()
        ? { contractEffectiveDate: matchedJwb.contractEffectiveDate.trim() }
        : {}),
      ...(matchedJwb?.firstJwbHourEntryDate?.trim()
        ? { firstJwbHourEntryDate: matchedJwb.firstJwbHourEntryDate.trim() }
        : {}),
      ...(lessonPackages?.length ? { lessonPackages } : {}),
    };

    const fields = existing ? changedFields(existing, record) : [];
    actions.push({
      kind: existing ? (fields.length ? "update" : "unchanged") : "insert",
      studentId: id,
      sourceRow: row.sourceRow,
      name,
      changedFields: fields,
    });
    if (existing) usedExistingIds.add(existing.id);
    imported.push(record);
  }

  // JWB's earliest positive contract date is the auditable proxy for the
  // visible student-number date. Do this after every match is known, then recompute the
  // corresponding action fields so the dry-run truthfully shows the backfill.
  const numberedImported = input.assignStudentNumbers
    ? assignStudentNumbersFromJwb(imported, existingStudents, input.studentNumberReservations ?? [])
    : imported;
  for (let index = 0; index < numberedImported.length; index += 1) {
    const numbered = numberedImported[index];
    imported[index] = numbered;
    const existing = existingStudents.find((student) => student.id === numbered.id);
    const previous = actions[index];
    if (previous) {
      const fields = existing ? changedFields(existing, numbered) : [];
      actions[index] = {
        ...previous,
        kind: existing ? (fields.length ? "update" : "unchanged") : "insert",
        changedFields: fields,
      };
    }
  }

  const manualTrialActions: StudentImportAction[] = [];
  const manualTrials = preserveManualTrials
    ? existingStudents
      .filter((student) => isManualTrial(student) && !usedExistingIds.has(student.id))
      .map((student): ImportedStudentRecord => {
        const preserved: ImportedStudentRecord = {
          ...importedStudentDefaults(cleanDisplayName(student.name), student),
          ...student,
          status: typeof student.status === "string" && student.status.trim() ? student.status : "在读 + 加课待排",
          importSource: "manual_trial",
        };
        const fields = changedFields(student, preserved);
        manualTrialActions.push({
          kind: fields.length ? "update" : "unchanged",
          studentId: preserved.id,
          sourceRow: student.sourceRow ?? student.id,
          name: preserved.name,
          changedFields: fields,
        });
        return preserved;
      })
      .sort((left, right) => compareText(left.id, right.id))
    : [];
  actions.push(...manualTrialActions);
  const referencedArchivedActions: StudentImportAction[] = [];
  const referencedArchived = existingStudents
    .filter((student) => preserveReferencedStudentIds.has(student.id)
      && !usedExistingIds.has(student.id)
      && !isManualTrial(student))
    .map((student): ImportedStudentRecord => {
      const archived: ImportedStudentRecord = {
        ...importedStudentDefaults(cleanDisplayName(student.name), student),
        ...student,
        status: EXCLUDED_MASTER_STUDENT_STATUS,
        next: "历史引用归档，只读",
        nextTone: "neutral",
        importArchived: true,
        importArchivedReason: "referenced_history",
      };
      const fields = changedFields(student, archived);
      referencedArchivedActions.push({
        kind: fields.length ? "update" : "unchanged",
        studentId: archived.id,
        sourceRow: student.sourceRow ?? student.id,
        name: archived.name,
        changedFields: fields,
      });
      return archived;
    })
    .sort((left, right) => compareText(left.id, right.id));
  actions.push(...referencedArchivedActions);
  const outputIds = new Set<string>();
  const students = [...imported, ...manualTrials, ...referencedArchived];
  for (const student of students) {
    if (outputIds.has(student.id)) {
      throw new StudentImportError("duplicate_output_id", `Duplicate output student id: ${student.id}`);
    }
    outputIds.add(student.id);
  }

  excluded.sort((left, right) => compareText(String(left.sourceRow), String(right.sourceRow)));
  unmatched.sort((left, right) => compareText(`${left.source}:${left.sourceRow}`, `${right.source}:${right.sourceRow}`));
  ambiguous.sort((left, right) => compareText(
    `${left.kind}:${left.normalizedName ?? ""}:${left.masterSourceRows.join(",")}:${left.existingStudentIds.join(",")}`,
    `${right.kind}:${right.normalizedName ?? ""}:${right.masterSourceRows.join(",")}:${right.existingStudentIds.join(",")}`,
  ));

  return {
    students,
    actions,
    excluded,
    unmatched,
    ambiguous,
    summary: {
      insert: actions.filter((action) => action.kind === "insert").length,
      update: actions.filter((action) => action.kind === "update").length,
      unchanged: actions.filter((action) => action.kind === "unchanged").length,
      excluded: excluded.length,
      unmatched: unmatched.length,
      ambiguous: ambiguous.length,
      preservedManualTrials: manualTrials.length,
      preservedReferencedArchived: referencedArchived.length,
      importedPackages: imported.reduce(
        (count, student) => count + (matchedJwbByStudentId.get(student.id)?.lessonPackages?.length ?? 0),
        0,
      ),
      studentsMissingPackageData: imported.filter((student) => {
        return !student.lessonPackages?.length
          || student.packageCoverage === "partial"
          || student.packageCoverage === "none";
      }).length,
    },
  };
}
