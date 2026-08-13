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

export type MasterStudentImportRow = Readonly<{
  sourceRow: StudentImportSourceKey;
  name: string;
  status: string;
  attributes?: StudentImportAttributes;
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
  /** Defaults to true. A manual trial is a trial-segment record without a master source key. */
  preserveManualTrials?: boolean;
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

/** Conservative comparison key; it deliberately does not remove punctuation or transliterate names. */
export function normalizeStudentImportName(value: string) {
  return cleanDisplayName(value).toLocaleLowerCase("en-AU");
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

/** Stable across reruns and independent of input row ordering. */
export function studentIdForMasterSource(sourceRow: StudentImportSourceKey) {
  const key = sourceKey(sourceRow, "master source row");
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
    const totalHours = purchaseRecords.reduce((sum, purchase) => sum + purchase.hours, 0);
    if (roundedHours(consumedHours) > roundedHours(totalHours)) {
      throw new StudentImportError(
        "invalid_lesson_package",
        "consumedHours cannot exceed purchased hours",
        sourceRow,
      );
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
  const contractHours = roundedHours(packages.reduce(
    (sum, lessonPackage) => sum + lessonPackage.purchaseRecords.reduce(
      (purchaseSum, purchase) => purchaseSum + purchase.hours,
      0,
    ),
    0,
  ));
  const consumedHours = roundedHours(packages.reduce(
    (sum, lessonPackage) => sum + lessonPackage.consumedHours,
    0,
  ));
  return { contractHours, remainingHours: roundedHours(contractHours - consumedHours) };
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

function existingMasterKey(student: ExistingStudentImportRecord) {
  if (student.masterSourceKey !== undefined) return sourceKey(student.masterSourceKey, "existing master source key");
  if (student.sourceRow !== undefined) return sourceKey(student.sourceRow, "existing source row");
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
  const excluded: StudentImportExcluded[] = [];
  const unmatched: StudentImportUnmatched[] = [];
  const ambiguous: StudentImportAmbiguity[] = [];

  const masterKeys = new Set<string>();
  const eligibleMasterRows = [...input.masterRows]
    .map((row) => {
      const key = sourceKey(row.sourceRow, "master source row");
      if (masterKeys.has(key)) {
        throw new StudentImportError("duplicate_master_source_key", `Duplicate master source row: ${key}`, row.sourceRow);
      }
      masterKeys.add(key);
      return { row, key, status: parseMasterStudentStatus(row.status, row.sourceRow), name: cleanDisplayName(row.name) };
    })
    .sort((left, right) => compareText(left.key, right.key))
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

  for (const { row, name } of cleanJwbRows) {
    if (!name) unmatched.push({ source: "jwb", sourceRow: row.sourceRow, name: "", reason: "empty_name" });
  }

  const masterNameGroups = groupByName(eligibleMasterRows.map(({ row, name }) => ({ ...row, name })));
  const jwbNameGroups = groupByName(cleanJwbRows.filter(({ name }) => name).map(({ row, name }) => ({ ...row, name })));
  const intentionallyExcludedNames = new Set(
    excluded.map((entry) => normalizeStudentImportName(entry.name)).filter(Boolean),
  );
  const allNames = [...new Set([...masterNameGroups.keys(), ...jwbNameGroups.keys()])].sort(compareText);
  const jwbMatchByName = new Map<string, JwbStudentImportRow>();
  const ambiguousNames = new Set<string>();

  for (const name of allNames) {
    const masters = masterNameGroups.get(name) ?? [];
    const jwb = jwbNameGroups.get(name) ?? [];
    if (masters.length > 1 || jwb.length > 1) {
      ambiguousNames.add(name);
      ambiguous.push(makeAmbiguity("name", name, masters, jwb));
      continue;
    }
    if (masters.length === 1 && jwb.length === 1) {
      jwbMatchByName.set(name, jwb[0]);
    } else if (masters.length === 1) {
      unmatched.push({ source: "master", sourceRow: masters[0].sourceRow, name: cleanDisplayName(masters[0].name), reason: "missing_jwb" });
    } else if (jwb.length === 1 && !intentionallyExcludedNames.has(name)) {
      unmatched.push({ source: "jwb", sourceRow: jwb[0].sourceRow, name: cleanDisplayName(jwb[0].name), reason: "not_in_master" });
    }
  }

  const existingByKey = new Map<string, ExistingStudentImportRecord[]>();
  const legacyExistingByName = new Map<string, ExistingStudentImportRecord[]>();
  for (const student of existingStudents) {
    const key = existingMasterKey(student);
    if (key !== null) existingByKey.set(key, [...(existingByKey.get(key) ?? []), student]);
    else if (!isManualTrial(student)) {
      const name = normalizeStudentImportName(student.name);
      if (name) legacyExistingByName.set(name, [...(legacyExistingByName.get(name) ?? []), student]);
    }
  }

  const actions: StudentImportAction[] = [];
  const imported: ImportedStudentRecord[] = [];
  const usedExistingIds = new Set<string>();

  for (const { row, key, status, name } of eligibleMasterRows) {
    const normalizedName = normalizeStudentImportName(name);
    const byKey = existingByKey.get(key) ?? [];
    const byName = legacyExistingByName.get(normalizedName) ?? [];
    let existing: ExistingStudentImportRecord | undefined;

    if (byKey.length === 1) existing = byKey[0];
    else if (byKey.length > 1) ambiguous.push(makeAmbiguity("existing_source", normalizedName, [row], [], byKey));
    else if (!ambiguousNames.has(normalizedName) && byName.length === 1) existing = byName[0];
    else if (!ambiguousNames.has(normalizedName) && byName.length > 1) ambiguous.push(makeAmbiguity("existing_name", normalizedName, [row], [], byName));

    if (existing && usedExistingIds.has(existing.id)) {
      ambiguous.push(makeAmbiguity("existing_name", normalizedName, [row], [], [existing]));
      existing = undefined;
    }

    const matchedJwb = jwbMatchByName.get(normalizedName);
    const jwbStatus: ImportedStudentRecord["jwbMatchStatus"] = ambiguousNames.has(normalizedName)
      ? "ambiguous"
      : matchedJwb
        ? "matched"
        : "unmatched";
    const id = existing?.id ?? studentIdForMasterSource(row.sourceRow);
    const authoritativePackages = matchedJwb?.lessonPackages === undefined
      ? undefined
      : importLessonPackagesForStudent(id, matchedJwb.lessonPackages, matchedJwb.sourceRow);
    const existingPackages = authoritativePackages === undefined && Array.isArray(existing?.lessonPackages)
      ? existing.lessonPackages.map((lessonPackage: StudentLessonPackage) => ({
        ...lessonPackage,
        subjectIds: [...lessonPackage.subjectIds],
        purchaseRecords: lessonPackage.purchaseRecords.map((purchase: StudentLessonPackage["purchaseRecords"][number]) => ({ ...purchase })),
      }))
      : undefined;
    const lessonPackages = authoritativePackages ?? existingPackages;
    const totals = lessonPackages?.length ? packageTotals(lessonPackages) : undefined;
    const sourceRemainingHours = matchedJwb
      ? optionalHours(matchedJwb.remainingHours, "remainingHours", matchedJwb.sourceRow)
      : undefined;
    const sourceContractHours = matchedJwb
      ? optionalHours(matchedJwb.contractHours, "contractHours", matchedJwb.sourceRow)
      : undefined;
    if (authoritativePackages && sourceRemainingHours !== undefined
      && !hoursMatch(sourceRemainingHours, totals!.remainingHours)) {
      throw new StudentImportError(
        "package_balance_mismatch",
        "remainingHours does not equal the authoritative lesson package balance",
        matchedJwb!.sourceRow,
      );
    }
    if (authoritativePackages && sourceContractHours !== undefined
      && !hoursMatch(sourceContractHours, totals!.contractHours)) {
      throw new StudentImportError(
        "package_balance_mismatch",
        "contractHours does not equal authoritative lesson package purchases",
        matchedJwb!.sourceRow,
      );
    }
    const record: ImportedStudentRecord = {
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
      ...(totals
        ? { remainingHours: totals.remainingHours }
        : sourceRemainingHours !== undefined
          ? { remainingHours: sourceRemainingHours }
        : {}),
      ...(totals
        ? { contractHours: totals.contractHours }
        : sourceContractHours !== undefined
          ? { contractHours: sourceContractHours }
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

  const manualTrials = preserveManualTrials
    ? existingStudents.filter(isManualTrial).map((student) => ({ ...student } as ImportedStudentRecord)).sort((left, right) => compareText(left.id, right.id))
    : [];
  const outputIds = new Set<string>();
  const students = [...imported, ...manualTrials];
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
      importedPackages: imported.reduce(
        (count, student) => count + (jwbMatchByName.get(normalizeStudentImportName(student.name))?.lessonPackages?.length ?? 0),
        0,
      ),
      studentsMissingPackageData: imported.filter((student) => !student.lessonPackages?.length).length,
    },
  };
}
