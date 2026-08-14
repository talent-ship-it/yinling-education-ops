import type { StudentLessonPackage } from "./student-records";

/**
 * Pure domain logic for replacing the system student list from the latest
 * master sheet and enriching it with JWB balances.
 *
 * Matching is intentionally conservative: names are normalised only for
 * whitespace, Unicode width and case. A name shared by more than one row on
 * either side is reported as ambiguous and is never used to attach JWB data.
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

export type StudentImportIdentityLink = Readonly<{
  masterSourceRow: StudentImportSourceKey;
  studentId: string;
  jwbSourceRow?: StudentImportSourceKey;
}>;

export type MasterStudentImportRow = Readonly<{
  sourceRow: StudentImportSourceKey;
  name: string;
  status: string;
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
  name: string;
  status?: string;
  segment?: string;
  sourceRow?: StudentImportSourceKey;
  masterSourceKey?: string;
  importSource?: "master" | "manual_trial";
  lessonPackages?: readonly StudentLessonPackage[];
}>;

export type ImportedStudentRecord = Readonly<Record<string, unknown> & {
  id: string;
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
  | "duplicate_identity_link"
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

/** Conservative comparison key; it deliberately does not remove punctuation or transliterate names. */
export function normalizeStudentImportName(value: string) {
  // Keep identity grouping deterministic across JavaScript and PostgreSQL.
  // NFKC already folds width/compatibility variants; only ASCII case folding
  // is required for the current roster contract and avoids locale-dependent
  // Unicode case mappings diverging between runtimes.
  return cleanDisplayName(value).replace(/[A-Z]/g, (character) => character.toLowerCase());
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
  const eligibleMasterRows = [...input.masterRows]
    .map((row) => {
      const rawKey = sourceKey(row.sourceRow, "master source row");
      if (masterKeys.has(rawKey)) {
        throw new StudentImportError("duplicate_master_source_key", `Duplicate master source row: ${rawKey}`, row.sourceRow);
      }
      masterKeys.add(rawKey);
      return {
        row,
        rawKey,
        key: masterSourceKeyForSource(row.sourceRow, namespace),
        status: parseMasterStudentStatus(row.status, row.sourceRow),
        name: cleanDisplayName(row.name),
      };
    })
    .sort((left, right) => compareText(left.rawKey, right.rawKey))
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

  if (input.identityLinks !== undefined && !Array.isArray(input.identityLinks)) {
    throw new StudentImportError("invalid_identity_link", "identityLinks must be an array");
  }
  const eligibleMasterByRawKey = new Map(eligibleMasterRows.map((entry) => [entry.rawKey, entry]));
  const jwbByKey = new Map<string, typeof cleanJwbRows>();
  for (const entry of cleanJwbRows) {
    jwbByKey.set(entry.key, [...(jwbByKey.get(entry.key) ?? []), entry]);
  }
  const existingById = new Map<string, ExistingStudentImportRecord[]>();
  for (const student of existingStudents) {
    const id = sourceKey(student.id, "existing student id");
    existingById.set(id, [...(existingById.get(id) ?? []), student]);
  }

  const linkedMasterKeys = new Set<string>();
  const linkedJwbKeys = new Set<string>();
  const linkedStudentIds = new Set<string>();
  const identityByMasterKey = new Map<string, Readonly<{
    existing: ExistingStudentImportRecord;
    jwb?: JwbStudentImportRow;
  }>>();
  for (const [index, linkValue] of (input.identityLinks ?? []).entries()) {
    if (!linkValue || typeof linkValue !== "object" || Array.isArray(linkValue)
      || !exactObjectFields(linkValue as unknown as Record<string, unknown>, [
        "masterSourceRow", "studentId", "jwbSourceRow",
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
    if (existingMatches.length !== 1) {
      throw new StudentImportError(
        "invalid_identity_link",
        `Identity link ${index + 1} must reference exactly one existing student`,
        linkValue.masterSourceRow,
      );
    }
    const jwbMatches = jwbKey === undefined ? [] : (jwbByKey.get(jwbKey) ?? []);
    if (jwbKey !== undefined && jwbMatches.length !== 1) {
      throw new StudentImportError(
        "invalid_identity_link",
        `Identity link ${index + 1} must reference exactly one JWB row`,
        linkValue.masterSourceRow,
      );
    }
    linkedMasterKeys.add(masterKey);
    linkedStudentIds.add(studentId);
    if (jwbKey !== undefined) linkedJwbKeys.add(jwbKey);
    identityByMasterKey.set(masterKey, {
      existing: existingMatches[0],
      ...(jwbMatches[0] ? { jwb: jwbMatches[0].row } : {}),
    });
  }

  const unlinkedMasterRows = eligibleMasterRows.filter(({ rawKey }) => !linkedMasterKeys.has(rawKey));
  const unlinkedJwbRows = cleanJwbRows.filter(({ key }) => !linkedJwbKeys.has(key));
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
  for (const [masterKey, identity] of identityByMasterKey) {
    if (identity.jwb) matchedJwbByMasterKey.set(masterKey, identity.jwb);
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
