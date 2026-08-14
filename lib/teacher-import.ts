import { createHash } from "node:crypto";

/**
 * Pure, read-only planning for the two Tencent teacher workbooks.
 *
 * The source sheets contain useful roster, subject and free-text availability
 * data, but they are not an authority for a calendar month or a numeric new
 * student capacity. This module deliberately preserves those cells as source
 * text and reports them for review instead of guessing structured values.
 */

export const TEACHER_WORKBOOK_SHEETS = {
  k12: [
    "在职总表",
    "Local English",
    "ABC华裔English",
    "Maths&Science",
    "VCE数学科学",
    "VCE其他",
    "奖学金",
    "AEAS",
    "青少英语",
    "QCE",
    "HSC",
    "WACE",
    "SACE",
    "AMC数学竞赛",
    "科学竞赛",
    "雅思PTE",
    "IB",
    "已离职教师",
  ],
  university: [
    "大学老师在职总表",
    "Engineering",
    "商科",
    "IT",
    "理科",
    "文科（含论文辅导）",
    "教育学",
    "其他科目",
  ],
} as const;

export type TeacherWorkbookKind = keyof typeof TEACHER_WORKBOOK_SHEETS;
export type TeacherImportSourceKey = string | number;

export type TeacherRosterImportRow = Readonly<{
  workbook: TeacherWorkbookKind;
  sourceRow: TeacherImportSourceKey;
  name: string;
  availabilityText?: string | null;
  capacityText?: string | null;
  attributes?: Readonly<Record<string, unknown>>;
}>;

export type TeacherSubjectImportRow = Readonly<{
  workbook: TeacherWorkbookKind;
  sheetName: string;
  sourceRow: TeacherImportSourceKey;
  name: string;
  subjectDetail?: string | null;
}>;

export type TeacherWorkbookSnapshot = Readonly<{
  workbook: TeacherWorkbookKind;
  sourceId: string;
  revision: string;
  sheetNames: readonly string[];
  rosterRows: readonly TeacherRosterImportRow[];
  subjectRows: readonly TeacherSubjectImportRow[];
}>;

export type TeacherSourceReference = Readonly<{
  workbook: TeacherWorkbookKind;
  sourceId: string;
  sourceRow: TeacherImportSourceKey;
}>;

export type TeacherSubjectSourceReference = Readonly<{
  workbook: TeacherWorkbookKind;
  sourceId: string;
  sheetName: string;
  sourceRow: TeacherImportSourceKey;
}>;

export type TeacherIdentityLink = Readonly<{
  resolutionKey: string;
  decision: "merge" | "separate";
  sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
  sourceRefs: readonly TeacherSourceReference[];
}>;

export type TeacherIdentityResolution = Readonly<{
  kind: "cross_workbook_identity" | "same_workbook_identity";
  resolutionKey: string;
  options: readonly Readonly<{ resolutionKey: string; decision: "merge" | "separate"; label: string }>[];
  name: string;
  sourceRefs: readonly TeacherSourceReference[];
  /** The existing database RPC can persist only an exact K12/university pair. */
  persistenceContract: "teacher_identity_link_v1" | "teacher_hard_resolution_v2";
}>;

export type TeacherSubjectResolutionOption = Readonly<{
  resolutionKey: string;
  decision: "assign" | "ignore";
  label: string;
  rosterRef?: TeacherSourceReference;
}>;

export type TeacherSubjectResolution = Readonly<{
  kind: "subject_assignment";
  workbook: TeacherWorkbookKind;
  name: string;
  sheetName: string;
  subjectRef: TeacherSubjectSourceReference;
  options: readonly TeacherSubjectResolutionOption[];
  persistenceContract: "teacher_hard_resolution_v2";
}>;

/**
 * Future persisted decisions for cases the original cross-workbook identity
 * table cannot represent. They remain server-owned and revision-bound; the
 * browser submits only an opaque key plus one enumerated decision.
 */
export type TeacherHardResolutionDecision = Readonly<
  | {
    kind: "same_workbook_identity" | "cross_workbook_identity";
    resolutionKey: string;
    decision: "merge" | "separate";
    sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
    sourceRefs: readonly TeacherSourceReference[];
  }
  | {
    kind: "subject_assignment";
    resolutionKey: string;
    decision: "assign" | "ignore";
    sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
    subjectRef: TeacherSubjectSourceReference;
    rosterRef?: TeacherSourceReference;
  }
>;

export type ExistingTeacherImportRecord = Readonly<Record<string, unknown> & {
  id: string;
  name: string;
  teacherSourceRefs?: readonly TeacherSourceReference[];
}>;

export type ImportedTeacherRecord = Readonly<Record<string, unknown> & {
  id: string;
  name: string;
  initials: string;
  subjects: readonly string[];
  subjectDetail?: string;
  departments: readonly ("中小学" | "大学")[];
  sourceCategories: readonly string[];
  teacherSourceRefs: readonly TeacherSourceReference[];
  availability: string;
  availabilityStatus: "可接新生" | "暂停接新" | "待确认";
  timezone: string;
  load: number;
  capacity: number;
  acceptsStudents: boolean;
  note: string;
  availabilitySourceText?: string;
  capacitySourceText?: string;
  /** Import never creates this; an existing separately-confirmed value is preserved. */
  availabilityWindows?: unknown;
  /** Import never creates this; an existing separately-confirmed value is preserved. */
  newStudentCapacity?: number;
}>;

export type TeacherImportIssueCode =
  | "duplicate_roster_name"
  | "duplicate_source_reference"
  | "existing_name_ambiguous"
  | "cross_workbook_name_ambiguous"
  | "identity_link_invalid"
  | "identity_link_existing_conflict"
  | "hard_resolution_invalid"
  | "subject_name_ambiguous"
  | "subject_teacher_not_in_roster"
  | "subject_row_ignored"
  | "unknown_subject_sheet"
  | "missing_expected_sheet"
  | "sheet_order_mismatch"
  | "timezone_defaulted"
  | "unstructured_availability"
  | "unstructured_capacity";

export type TeacherImportIssue = Readonly<{
  code: TeacherImportIssueCode;
  workbook?: TeacherWorkbookKind;
  name?: string;
  sourceRows?: readonly TeacherImportSourceKey[];
  existingTeacherIds?: readonly string[];
  sheetName?: string;
  detail: string;
}>;

export type TeacherImportAction = Readonly<{
  kind: "insert" | "update" | "unchanged" | "blocked";
  teacherId?: string;
  name: string;
  matchMethod: "source_reference" | "identity_link" | "identity_separate" | "unique_name" | "new" | "ambiguous" | "preserved_existing";
  changedFields: readonly string[];
}>;

export type TeacherImportPlan = Readonly<{
  teachers: readonly ImportedTeacherRecord[];
  actions: readonly TeacherImportAction[];
  issues: readonly TeacherImportIssue[];
  identityResolutions: readonly TeacherIdentityResolution[];
  subjectResolutions: readonly TeacherSubjectResolution[];
  summary: Readonly<{
    insert: number;
    update: number;
    unchanged: number;
    blocked: number;
    issues: number;
    unstructuredAvailability: number;
    unstructuredCapacity: number;
  }>;
}>;

export type BuildTeacherImportPlanInput = Readonly<{
  workbooks: readonly TeacherWorkbookSnapshot[];
  existingTeachers?: readonly ExistingTeacherImportRecord[];
  identityLinks?: readonly TeacherIdentityLink[];
  hardResolutions?: readonly TeacherHardResolutionDecision[];
}>;

export class TeacherImportError extends Error {
  constructor(
    readonly code: "invalid_source" | "duplicate_workbook" | "duplicate_output_id",
    message: string,
  ) {
    super(message);
    this.name = "TeacherImportError";
  }
}

type PreparedRoster = {
  workbook: TeacherWorkbookKind;
  sourceId: string;
  sourceRow: TeacherImportSourceKey;
  sourceKey: string;
  name: string;
  normalizedName: string;
  databaseNameKey: string;
  availabilityText?: string;
  capacityText?: string;
  attributes: Readonly<Record<string, unknown>>;
  subjects: string[];
  subjectDetails: string[];
};

type PendingSubjectResolution = {
  snapshot: TeacherWorkbookSnapshot;
  subjectRef: TeacherSubjectSourceReference;
  name: string;
  sheetName: string;
  detail?: string;
  candidateRows: PreparedRoster[];
  issueCode: "subject_name_ambiguous" | "subject_teacher_not_in_roster";
};

type ResolvedRoster = {
  row: PreparedRoster;
  reference: TeacherSourceReference;
  existing?: ExistingTeacherImportRecord;
  canonicalId: string;
  matchMethod: "source_reference" | "identity_link" | "identity_separate" | "unique_name" | "new";
};

const managedFields = new Set([
  "id",
  "name",
  "subjects",
  "subjectDetail",
  "departments",
  "sourceCategories",
  "teacherSourceRefs",
  "availability",
  "availabilityStatus",
  "availabilitySourceText",
  "capacitySourceText",
  "initials",
  "timezone",
  "load",
  "capacity",
  "acceptsStudents",
  "note",
  "location",
]);

function teacherInitials(name: string): string {
  const tokens = name.normalize("NFKC").trim().split(/[\s·・_-]+/).filter(Boolean);
  if (tokens.length > 1) {
    return tokens.slice(0, 2).map((token) => [...token][0] ?? "").join("").toLocaleUpperCase("en-AU");
  }
  return [...(tokens[0] ?? name)].slice(0, 2).join("").toLocaleUpperCase("en-AU");
}

function timezoneForLocation(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const key = location.normalize("NFKC").toLocaleLowerCase("en-AU");
  const mappings: readonly [RegExp, string][] = [
    [/\b(melbourne|vic|victoria)\b|墨尔本|维州/, "Australia/Melbourne"],
    [/\b(sydney|nsw|new south wales|canberra|act)\b|悉尼|新州|堪培拉/, "Australia/Sydney"],
    [/\b(brisbane|qld|queensland)\b|布里斯班|昆州/, "Australia/Brisbane"],
    [/\b(adelaide|sa|south australia)\b|阿德莱德|南澳/, "Australia/Adelaide"],
    [/\b(perth|wa|western australia)\b|珀斯|西澳/, "Australia/Perth"],
    [/\b(hobart|tas|tasmania)\b|霍巴特|塔州/, "Australia/Hobart"],
    [/\b(darwin|nt|northern territory)\b|达尔文|北领地/, "Australia/Darwin"],
    [/\b(china|beijing|shanghai|guangzhou|shenzhen)\b|中国|北京|上海|广州|深圳/, "Asia/Shanghai"],
  ];
  return mappings.find(([pattern]) => pattern.test(key))?.[1];
}

function cleanText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[\s\u3000]+/g, " ").trim();
  return result || undefined;
}

/** Conservative identity key: width, whitespace and case only. */
export function normalizeTeacherImportName(value: string): string {
  return cleanText(value)?.toLocaleLowerCase("en-AU") ?? "";
}

const OPERATIONAL_NAME_ANNOTATION = /(?:弱化|离职|先不安排)/u;

function trailingNameAnnotation(value: string): Readonly<{ base: string; annotation: string }> | undefined {
  const clean = cleanText(value);
  if (!clean) return undefined;
  const match = /^(.*?)\s*\(([^()]*)\)\s*$/u.exec(clean);
  const base = cleanText(match?.[1]);
  const annotation = cleanText(match?.[2]);
  return base && annotation ? { base, annotation } : undefined;
}

/**
 * The workbooks append operational state to display names inconsistently.
 * Remove only those known annotations; arbitrary parentheses remain identity
 * significant unless a nickname is independently corroborated below.
 */
function operationalTeacherNameKey(value: string): string {
  let clean = cleanText(value) ?? "";
  for (;;) {
    const annotated = trailingNameAnnotation(clean);
    if (!annotated || !OPERATIONAL_NAME_ANNOTATION.test(annotated.annotation)) break;
    clean = annotated.base;
  }
  clean = clean.replace(/\s*(?:已弱化|弱化)\s*$/u, "");
  return normalizeTeacherImportName(clean);
}

function sourceTextCorroboratesNickname(row: PreparedRoster, nickname: string): boolean {
  const key = normalizeTeacherImportName(nickname);
  if (!key || key.length > 80) return false;
  return [row.availabilityText, row.capacityText].some((value) => {
    const text = value ? value.normalize("NFKC").toLocaleLowerCase("en-AU") : "";
    return text.includes(`${key}老师`);
  });
}

function sourceKey(value: TeacherImportSourceKey, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TeacherImportError("invalid_source", `${label} must be a stable string or integer.`);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TeacherImportError("invalid_source", `${label} must be a stable string or integer.`);
  }
  const key = String(value).trim();
  if (!key || key.length > 240) throw new TeacherImportError("invalid_source", `${label} is missing.`);
  return key;
}

function requiredText(value: string, label: string): string {
  const result = cleanText(value);
  if (!result || result.length > 500) throw new TeacherImportError("invalid_source", `${label} is invalid.`);
  return result;
}

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(7, "0");
}

export function teacherIdForSource(reference: TeacherSourceReference): string {
  const identity = `${reference.workbook}\u0000${requiredText(reference.sourceId, "sourceId")}\u0000${sourceKey(reference.sourceRow, "sourceRow")}`;
  return `TEA-TX-${fnv1a(identity, 0x811c9dc5)}${fnv1a([...identity].reverse().join(""), 0x9e3779b9)}`;
}

function expectedSubjectSheets(workbook: TeacherWorkbookKind): readonly string[] {
  const sheets = TEACHER_WORKBOOK_SHEETS[workbook];
  return workbook === "k12" ? sheets.slice(1, -1) : sheets.slice(1);
}

function sheetKey(value: string, label: string): string {
  return requiredText(value, label);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en-AU");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function groupBy<T>(values: readonly T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function sourceReferenceKey(reference: TeacherSourceReference): string {
  return `${reference.workbook}\u0000${reference.sourceId}\u0000${String(reference.sourceRow).trim()}`;
}

function orderedIdentityReferences(references: readonly TeacherSourceReference[]): TeacherSourceReference[] {
  return [...references].sort((left, right) => compareText(sourceReferenceKey(left), sourceReferenceKey(right)));
}

function subjectSourceReferenceKey(reference: TeacherSubjectSourceReference): string {
  return `${reference.workbook}\u0000${reference.sourceId}\u0000${reference.sheetName}\u0000${String(reference.sourceRow).trim()}`;
}

function currentSourceRevisions(workbooks: readonly TeacherWorkbookSnapshot[]): Readonly<Record<TeacherWorkbookKind, string>> | undefined {
  const revisions = Object.fromEntries(
    workbooks.map((workbook) => [workbook.workbook, workbook.revision]),
  ) as Partial<Record<TeacherWorkbookKind, string>>;
  return revisions.k12 && revisions.university
    ? { k12: revisions.k12, university: revisions.university }
    : undefined;
}

function hardResolutionKey(input: {
  kind: "same_workbook_identity" | "cross_workbook_identity" | "subject_assignment";
  sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
  sourceRefs: readonly (TeacherSourceReference | TeacherSubjectSourceReference)[];
  decision?: "merge" | "separate" | "assign" | "ignore";
}): string {
  const refs = [...input.sourceRefs]
    .map((reference) => "sheetName" in reference
      ? `subject\u0000${subjectSourceReferenceKey(reference)}`
      : `roster\u0000${sourceReferenceKey(reference)}`)
    .sort(compareText);
  const identity = [
    "teacher-import-hard-resolution-v2",
    input.kind,
    requiredText(input.sourceRevisions.k12, "K12 source revision"),
    requiredText(input.sourceRevisions.university, "university source revision"),
    ...refs,
    ...(input.decision ? [input.decision] : []),
  ].join("\u0000");
  return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export function teacherCrossWorkbookDecisionKey(input: {
  sourceRefs: readonly TeacherSourceReference[];
  sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
  decision: "merge" | "separate";
}): string {
  const refs = orderedIdentityReferences(input.sourceRefs);
  if (refs.length < 2 || new Set(refs.map((reference) => reference.workbook)).size !== 2) {
    throw new TeacherImportError("invalid_source", "A cross-workbook identity decision requires current rows from both workbooks.");
  }
  return hardResolutionKey({
    kind: "cross_workbook_identity",
    sourceRefs: refs,
    sourceRevisions: input.sourceRevisions,
    decision: input.decision,
  });
}

export function teacherSameWorkbookResolutionKey(input: {
  sourceRefs: readonly TeacherSourceReference[];
  sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
}): string {
  const refs = orderedIdentityReferences(input.sourceRefs);
  if (refs.length < 2 || refs.some((reference) => reference.workbook !== refs[0]?.workbook)) {
    throw new TeacherImportError("invalid_source", "A same-workbook identity resolution requires at least two rows from one workbook.");
  }
  return hardResolutionKey({ kind: "same_workbook_identity", sourceRefs: refs, sourceRevisions: input.sourceRevisions });
}

export function teacherSameWorkbookDecisionKey(input: {
  sourceRefs: readonly TeacherSourceReference[];
  sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
  decision: "merge" | "separate";
}): string {
  const refs = orderedIdentityReferences(input.sourceRefs);
  if (refs.length < 2 || refs.some((reference) => reference.workbook !== refs[0]?.workbook)) {
    throw new TeacherImportError("invalid_source", "A same-workbook identity decision requires at least two rows from one workbook.");
  }
  return hardResolutionKey({
    kind: "same_workbook_identity",
    sourceRefs: refs,
    sourceRevisions: input.sourceRevisions,
    decision: input.decision,
  });
}

export function teacherSubjectResolutionKey(input: {
  subjectRef: TeacherSubjectSourceReference;
  rosterRef?: TeacherSourceReference;
  decision: "assign" | "ignore";
  sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
}): string {
  if (input.rosterRef && input.rosterRef.workbook !== input.subjectRef.workbook) {
    throw new TeacherImportError("invalid_source", "A subject row can only be assigned inside its workbook.");
  }
  if ((input.decision === "assign") !== Boolean(input.rosterRef)) {
    throw new TeacherImportError("invalid_source", "Subject assignment keys require exactly one roster row; ignore keys require none.");
  }
  return hardResolutionKey({
    kind: "subject_assignment",
    sourceRevisions: input.sourceRevisions,
    sourceRefs: input.rosterRef ? [input.subjectRef, input.rosterRef] : [input.subjectRef],
    decision: input.decision,
  });
}

/**
 * Binds an identity decision to the exact two source rows and both source
 * revisions. A later workbook refresh therefore requires a fresh review.
 */
export function teacherIdentityResolutionKey(input: {
  sourceRefs: readonly TeacherSourceReference[];
  sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
}): string {
  const refs = orderedIdentityReferences(input.sourceRefs);
  if (refs.length !== 2 || refs[0]?.workbook !== "k12" || refs[1]?.workbook !== "university") {
    throw new TeacherImportError("invalid_source", "An identity resolution requires one K12 and one university source reference.");
  }
  const identity = [
    "teacher-import-identity-link-v1",
    requiredText(input.sourceRevisions.k12, "K12 source revision"),
    refs[0].sourceId,
    sourceKey(refs[0].sourceRow, "K12 sourceRow"),
    requiredText(input.sourceRevisions.university, "university source revision"),
    refs[1].sourceId,
    sourceKey(refs[1].sourceRow, "university sourceRow"),
  ].join("\u0000");
  return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

function teacherIdForIdentityLink(resolutionKey: string): string {
  return `TEA-TX-${fnv1a(resolutionKey, 0x811c9dc5)}${fnv1a([...resolutionKey].reverse().join(""), 0x9e3779b9)}`;
}

/** Mirrors the database's deliberately narrow identity-link name check. */
function identityLinkNameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-AU");
}

function changedFields(existing: ExistingTeacherImportRecord, next: ImportedTeacherRecord): string[] {
  return [...managedFields].filter((field) => !same(existing[field], next[field])).sort(compareText);
}

function preservedExistingTeacher(existing: ExistingTeacherImportRecord): ImportedTeacherRecord {
  const subjects = Array.isArray(existing.subjects)
    ? existing.subjects.filter((value): value is string => typeof value === "string" && Boolean(cleanText(value)))
    : [];
  const departments = Array.isArray(existing.departments)
    ? existing.departments.filter((value): value is "中小学" | "大学" => value === "中小学" || value === "大学")
    : [];
  const sourceCategories = Array.isArray(existing.sourceCategories)
    ? existing.sourceCategories.filter((value): value is string => typeof value === "string" && Boolean(cleanText(value)))
    : subjects;
  const location = typeof existing.location === "string" ? cleanText(existing.location) : undefined;
  const timezone = typeof existing.timezone === "string" && cleanText(existing.timezone)
    ? cleanText(existing.timezone)!
    : timezoneForLocation(location) ?? "Australia/Melbourne";
  return {
    ...existing,
    id: requiredText(existing.id, "existing teacher id"),
    name: requiredText(existing.name, "existing teacher name"),
    initials: typeof existing.initials === "string" && cleanText(existing.initials)
      ? cleanText(existing.initials)!
      : teacherInitials(existing.name),
    subjects,
    departments,
    sourceCategories,
    teacherSourceRefs: existing.teacherSourceRefs ?? [],
    availability: typeof existing.availability === "string" && cleanText(existing.availability)
      ? cleanText(existing.availability)!
      : "待老师按月提交",
    availabilityStatus: existing.availabilityStatus === "可接新生"
      || existing.availabilityStatus === "暂停接新"
      || existing.availabilityStatus === "待确认"
      ? existing.availabilityStatus
      : "待确认",
    timezone,
    load: typeof existing.load === "number" && Number.isFinite(existing.load) && existing.load >= 0
      ? existing.load
      : 0,
    capacity: typeof existing.capacity === "number" && Number.isFinite(existing.capacity) && existing.capacity >= 0
      ? existing.capacity
      : 0,
    acceptsStudents: typeof existing.acceptsStudents === "boolean" ? existing.acceptsStudents : false,
    note: typeof existing.note === "string" && cleanText(existing.note)
      ? cleanText(existing.note)!
      : "待教务审核教师资料与月度 AVA",
    ...(location ? { location } : {}),
  };
}

export function buildTeacherImportPlan(input: BuildTeacherImportPlanInput): TeacherImportPlan {
  const existingTeachers = input.existingTeachers ?? [];
  const identityLinks = input.identityLinks ?? [];
  const hardResolutions = input.hardResolutions ?? [];
  const workbookKinds = new Set<TeacherWorkbookKind>();
  const issues: TeacherImportIssue[] = [];
  const roster: PreparedRoster[] = [];
  const pendingSubjectResolutions: PendingSubjectResolution[] = [];
  const sourceRevisions = currentSourceRevisions(input.workbooks);

  for (const snapshot of input.workbooks) {
    if (workbookKinds.has(snapshot.workbook)) {
      throw new TeacherImportError("duplicate_workbook", `Workbook ${snapshot.workbook} was supplied more than once.`);
    }
    workbookKinds.add(snapshot.workbook);
    const sourceId = requiredText(snapshot.sourceId, `${snapshot.workbook} sourceId`);
    requiredText(snapshot.revision, `${snapshot.workbook} revision`);
    const expected = [...TEACHER_WORKBOOK_SHEETS[snapshot.workbook]];
    const expectedByKey = new Map(expected.map((sheet) => [sheetKey(sheet, "expected sheet"), sheet]));
    const expectedKeys = expected.map((sheet) => sheetKey(sheet, "expected sheet"));
    const actualKeys = snapshot.sheetNames.map((sheet, index) => sheetKey(sheet, `${snapshot.workbook} sheetNames[${index}]`));
    const actualSet = new Set(actualKeys);

    for (const sheetName of expected.filter((sheet) => !actualSet.has(sheetKey(sheet, "expected sheet")))) {
      issues.push({ code: "missing_expected_sheet", workbook: snapshot.workbook, sheetName, detail: `Expected sheet “${sheetName}” is missing.` });
    }
    for (const sheetName of actualKeys.filter((sheet) => !expectedByKey.has(sheet))) {
      issues.push({ code: "unknown_subject_sheet", workbook: snapshot.workbook, sheetName, detail: `Unknown sheet “${sheetName}” is not imported as a subject.` });
    }
    const knownActual = actualKeys.filter((sheet) => expectedByKey.has(sheet));
    const knownExpected = expectedKeys.filter((sheet) => actualSet.has(sheet));
    if (!same(knownActual, knownExpected)) {
      issues.push({ code: "sheet_order_mismatch", workbook: snapshot.workbook, detail: "Known sheets are not in the authoritative workbook order." });
    }

    const rows = snapshot.rosterRows.map((row): PreparedRoster => {
      if (row.workbook !== snapshot.workbook) throw new TeacherImportError("invalid_source", "Roster row workbook does not match its snapshot.");
      const name = requiredText(row.name, "teacher name");
      const availabilityText = cleanText(row.availabilityText);
      const capacityText = cleanText(row.capacityText);
      return {
        workbook: row.workbook,
        sourceId,
        sourceRow: row.sourceRow,
        sourceKey: sourceKey(row.sourceRow, "teacher sourceRow"),
        name,
        normalizedName: normalizeTeacherImportName(name),
        databaseNameKey: identityLinkNameKey(row.name),
        ...(availabilityText ? { availabilityText } : {}),
        ...(capacityText ? { capacityText } : {}),
        attributes: row.attributes ?? {},
        subjects: [],
        subjectDetails: [],
      };
    });
    const byName = groupBy(rows, (row) => row.normalizedName);
    const byOperationalName = groupBy(rows, (row) => operationalTeacherNameKey(row.name));

    const subjectSheetByKey = new Map(expectedSubjectSheets(snapshot.workbook)
      .filter((sheet) => actualSet.has(sheetKey(sheet, "expected subject sheet")))
      .map((sheet) => [sheetKey(sheet, "expected subject sheet"), sheet]));
    for (const subjectRow of snapshot.subjectRows) {
      if (subjectRow.workbook !== snapshot.workbook) throw new TeacherImportError("invalid_source", "Subject row workbook does not match its snapshot.");
      sourceKey(subjectRow.sourceRow, "subject sourceRow");
      const name = requiredText(subjectRow.name, "subject teacher name");
      const sourceSheetName = requiredText(subjectRow.sheetName, "subject sheetName");
      const sheetName = subjectSheetByKey.get(sheetKey(sourceSheetName, "subject sheetName"));
      if (!sheetName) {
        issues.push({ code: "unknown_subject_sheet", workbook: snapshot.workbook, name, sheetName: sourceSheetName, sourceRows: [subjectRow.sourceRow], detail: "This row is on a non-subject or unknown sheet and was ignored." });
        continue;
      }
      const matches = byName.get(normalizeTeacherImportName(name)) ?? [];
      let safeMatches = matches;
      if (!safeMatches.length) {
        const operationalMatches = byOperationalName.get(operationalTeacherNameKey(name)) ?? [];
        if (operationalMatches.length > 0
          && operationalMatches.some((match) => operationalTeacherNameKey(match.name) !== match.normalizedName
            || operationalTeacherNameKey(name) !== normalizeTeacherImportName(name))) {
          safeMatches = operationalMatches;
        }
      }
      if (!safeMatches.length) {
        const nickname = trailingNameAnnotation(name);
        const nicknameMatches = nickname
          ? rows.filter((row) => row.normalizedName === normalizeTeacherImportName(nickname.base)
            && sourceTextCorroboratesNickname(row, nickname.annotation))
          : [];
        if (nicknameMatches.length === 1) {
          safeMatches = nicknameMatches;
        }
      }
      if (!safeMatches.length) {
        pendingSubjectResolutions.push({
          snapshot,
          subjectRef: { workbook: snapshot.workbook, sourceId, sheetName, sourceRow: subjectRow.sourceRow },
          name,
          sheetName,
          ...(cleanText(subjectRow.subjectDetail) ? { detail: cleanText(subjectRow.subjectDetail) } : {}),
          candidateRows: rows,
          issueCode: "subject_teacher_not_in_roster",
        });
        continue;
      }
      if (safeMatches.length > 1) {
        pendingSubjectResolutions.push({
          snapshot,
          subjectRef: { workbook: snapshot.workbook, sourceId, sheetName, sourceRow: subjectRow.sourceRow },
          name,
          sheetName,
          ...(cleanText(subjectRow.subjectDetail) ? { detail: cleanText(subjectRow.subjectDetail) } : {}),
          candidateRows: safeMatches,
          issueCode: "subject_name_ambiguous",
        });
        continue;
      }
      if (!safeMatches[0].subjects.includes(sheetName)) safeMatches[0].subjects.push(sheetName);
      const detail = cleanText(subjectRow.subjectDetail);
      if (detail && !safeMatches[0].subjectDetails.includes(detail)) safeMatches[0].subjectDetails.push(detail);
    }
    const order = new Map(expectedSubjectSheets(snapshot.workbook).map((sheet, index) => [sheet, index]));
    for (const row of rows) row.subjects.sort((left, right) => (order.get(left) ?? 999) - (order.get(right) ?? 999));
    roster.push(...rows);
  }

  const existingBySource = new Map<string, ExistingTeacherImportRecord[]>();
  const existingByName = groupBy(existingTeachers, (teacher) => normalizeTeacherImportName(teacher.name));
  for (const teacher of existingTeachers) {
    for (const reference of teacher.teacherSourceRefs ?? []) {
      const key = sourceReferenceKey(reference);
      existingBySource.set(key, [...(existingBySource.get(key) ?? []), teacher]);
    }
  }


  const rosterByReference = groupBy(roster, (row) => `${row.workbook}\u0000${row.sourceId}\u0000${row.sourceKey}`);
  const rosterByName = groupBy(roster, (row) => row.normalizedName);
  const partialSourceRevisions = Object.fromEntries(input.workbooks.map((workbook) => [workbook.workbook, workbook.revision])) as Partial<Record<TeacherWorkbookKind, string>>;
  const currentHardResolutions = sourceRevisions
    ? hardResolutions.filter((resolution) => resolution.sourceRevisions.k12 === sourceRevisions.k12
      && resolution.sourceRevisions.university === sourceRevisions.university)
    : [];
  const hardDecisionByKey = new Map(currentHardResolutions.map((resolution) => [resolution.resolutionKey, resolution]));
  const consumedHardResolutionKeys = new Set<string>();
  const hardIdentityLinkByReference = new Map<string, Extract<TeacherHardResolutionDecision, { kind: "same_workbook_identity" | "cross_workbook_identity" }>>();
  const invalidHardRows = new Set<PreparedRoster>();
  for (const resolution of currentHardResolutions) {
    if (resolution.kind === "subject_assignment") continue;
    const refs = orderedIdentityReferences(resolution.sourceRefs);
    const rows = refs.flatMap((reference) => rosterByReference.get(sourceReferenceKey(reference)) ?? []);
    const expectedKey = sourceRevisions
      ? resolution.kind === "same_workbook_identity"
        ? teacherSameWorkbookDecisionKey({ sourceRefs: refs, sourceRevisions, decision: resolution.decision })
        : teacherCrossWorkbookDecisionKey({ sourceRefs: refs, sourceRevisions, decision: resolution.decision })
      : null;
    const expectedWorkbookCount = resolution.kind === "same_workbook_identity" ? 1 : 2;
    const validRows = expectedKey === resolution.resolutionKey
      && rows.length === refs.length
      && refs.length >= 2
      && refs.every((reference) => (rosterByReference.get(sourceReferenceKey(reference)) ?? []).length === 1)
      && new Set(refs.map((reference) => reference.workbook)).size === expectedWorkbookCount
      && new Set(rows.map((row) => row.normalizedName)).size === 1
      && refs.every((reference) => !hardIdentityLinkByReference.has(sourceReferenceKey(reference)));
    if (!validRows) {
      rows.forEach((row) => invalidHardRows.add(row));
      issues.push({
        code: "hard_resolution_invalid",
        name: rows[0]?.name,
        sourceRows: refs.map((reference) => reference.sourceRow),
        detail: "Saved same-workbook identity decision no longer matches its exact current source rows.",
      });
      continue;
    }
    consumedHardResolutionKeys.add(resolution.resolutionKey);
    refs.forEach((reference) => hardIdentityLinkByReference.set(sourceReferenceKey(reference), resolution));
  }
  const linkByReference = new Map<string, TeacherIdentityLink>();
  const invalidLinkedRows = new Set<PreparedRoster>();
  for (const link of identityLinks) {
    const refs = orderedIdentityReferences(link.sourceRefs);
    const onePerWorkbook = refs.length === 2
      && refs[0]?.workbook === "k12"
      && refs[1]?.workbook === "university";
    const expectedKey = onePerWorkbook && partialSourceRevisions.k12 && partialSourceRevisions.university
      ? teacherIdentityResolutionKey({
        sourceRefs: refs,
        sourceRevisions: { k12: partialSourceRevisions.k12, university: partialSourceRevisions.university },
      })
      : null;
    const rows = refs.flatMap((reference) => rosterByReference.get(sourceReferenceKey(reference)) ?? []);
    const exactCurrentRevisions = link.sourceRevisions.k12 === partialSourceRevisions.k12
      && link.sourceRevisions.university === partialSourceRevisions.university;
    // Historical confirmations remain auditable in the database, but only
    // links bound to both current workbook revisions participate in a plan.
    if (!exactCurrentRevisions) continue;
    const uniqueRosterRows = rows.length === 2
      && refs.every((reference) => (rosterByReference.get(sourceReferenceKey(reference)) ?? []).length === 1);
    const sameLinkName = uniqueRosterRows
      && rows[0].normalizedName === rows[1].normalizedName
      && rows[0].databaseNameKey === rows[1].databaseNameKey;
    const noSameWorkbookDuplicate = sameLinkName
      && rows.every((row) => (rosterByName.get(row.normalizedName) ?? [])
        .filter((candidate) => candidate.workbook === row.workbook).length === 1);
    const refsUnused = refs.every((reference) => !linkByReference.has(sourceReferenceKey(reference)));
    if (!onePerWorkbook || !expectedKey || link.resolutionKey !== expectedKey
      || !uniqueRosterRows || !sameLinkName || !noSameWorkbookDuplicate || !refsUnused) {
      rows.forEach((row) => invalidLinkedRows.add(row));
      issues.push({
        code: "identity_link_invalid",
        name: rows[0]?.name,
        sourceRows: refs.map((reference) => reference.sourceRow),
        detail: "Saved identity confirmation no longer matches exactly one current row in each workbook and must be reviewed again.",
      });
      continue;
    }
    refs.forEach((reference) => linkByReference.set(sourceReferenceKey(reference), link));
  }

  const blocked = new Set<PreparedRoster>();
  invalidLinkedRows.forEach((row) => blocked.add(row));
  invalidHardRows.forEach((row) => blocked.add(row));
  for (const sameReference of rosterByReference.values()) {
    if (sameReference.length < 2) continue;
    sameReference.forEach((row) => blocked.add(row));
    issues.push({
      code: "duplicate_source_reference",
      workbook: sameReference[0].workbook,
      name: sameReference[0].name,
      sourceRows: sameReference.map((row) => row.sourceRow),
      detail: "More than one roster row uses the same stable source reference.",
    });
  }
  const identityResolutions: TeacherIdentityResolution[] = [];
  const subjectResolutions: TeacherSubjectResolution[] = [];
  for (const sameName of rosterByName.values()) {
    const workbooks = new Set(sameName.map((row) => row.workbook));
    const stableMatches = sameName.map((row) => existingBySource.get(sourceReferenceKey({
      workbook: row.workbook,
      sourceId: row.sourceId,
      sourceRow: row.sourceRow,
    })) ?? []);
    const explicitlySameExistingTeacher = stableMatches.every((matches) => matches.length === 1)
      && new Set(stableMatches.map((matches) => matches[0].id)).size === 1;
    const sameWorkbookDuplicate = sameName.some((row) => sameName.filter((candidate) => candidate.workbook === row.workbook).length > 1);
    const candidateRefs = orderedIdentityReferences(sameName.map((row) => ({
      workbook: row.workbook,
      sourceId: row.sourceId,
      sourceRow: row.sourceRow,
    })));
    const sourceLink = candidateRefs.length === 2
      ? linkByReference.get(sourceReferenceKey(candidateRefs[0]))
      : undefined;
    const explicitlyLinked = Boolean(sourceLink)
      && candidateRefs.every((reference) => linkByReference.get(sourceReferenceKey(reference))?.resolutionKey === sourceLink?.resolutionKey);
    const hardSourceLink = candidateRefs.length
      ? hardIdentityLinkByReference.get(sourceReferenceKey(candidateRefs[0]))
      : undefined;
    const explicitlyHardLinked = Boolean(hardSourceLink)
      && candidateRefs.every((reference) => hardIdentityLinkByReference.get(sourceReferenceKey(reference))?.resolutionKey === hardSourceLink?.resolutionKey);
    const sameWorkbookDuplicateGroups = [...workbooks]
      .map((workbook) => sameName.filter((row) => row.workbook === workbook))
      .filter((rows) => rows.length > 1);
    const allSameWorkbookDuplicatesResolved = sameWorkbookDuplicateGroups.length > 0
      && sameWorkbookDuplicateGroups.every((rows) => {
        const first = hardIdentityLinkByReference.get(sourceReferenceKey({
          workbook: rows[0].workbook,
          sourceId: rows[0].sourceId,
          sourceRow: rows[0].sourceRow,
        }));
        return Boolean(first) && rows.every((row) => hardIdentityLinkByReference.get(sourceReferenceKey({
          workbook: row.workbook,
          sourceId: row.sourceId,
          sourceRow: row.sourceRow,
        }))?.resolutionKey === first?.resolutionKey);
      });
    if (workbooks.size > 1 && (!explicitlySameExistingTeacher || sameWorkbookDuplicate)
      && !explicitlyLinked && !explicitlyHardLinked) {
      sameName.forEach((row) => blocked.add(row));
      issues.push({
        code: "cross_workbook_name_ambiguous",
        name: sameName[0].name,
        sourceRows: sameName.map((row) => row.sourceRow),
        detail: "The same name appears in both workbooks; sources are not merged without an explicit stable identity link.",
      });
      if (!sameWorkbookDuplicate && sameName.length === 2
        && sameName[0].databaseNameKey === sameName[1].databaseNameKey && sourceRevisions) {
        identityResolutions.push({
          kind: "cross_workbook_identity",
          resolutionKey: teacherIdentityResolutionKey({
            sourceRefs: candidateRefs,
            sourceRevisions,
          }),
          options: [
            { resolutionKey: teacherIdentityResolutionKey({ sourceRefs: candidateRefs, sourceRevisions }), decision: "separate", label: "确认是两位老师" },
            { resolutionKey: teacherIdentityResolutionKey({ sourceRefs: candidateRefs, sourceRevisions }), decision: "merge", label: "确认是同一位老师" },
          ],
          name: sameName[0].name,
          sourceRefs: candidateRefs,
          persistenceContract: "teacher_identity_link_v1",
        });
      } else if (sourceRevisions) {
        identityResolutions.push({
          kind: "cross_workbook_identity",
          resolutionKey: teacherCrossWorkbookDecisionKey({ sourceRefs: candidateRefs, sourceRevisions, decision: "separate" }),
          options: [
            { resolutionKey: teacherCrossWorkbookDecisionKey({ sourceRefs: candidateRefs, sourceRevisions, decision: "separate" }), decision: "separate", label: "确认跨表不是同一位老师" },
            { resolutionKey: teacherCrossWorkbookDecisionKey({ sourceRefs: candidateRefs, sourceRevisions, decision: "merge" }), decision: "merge", label: "确认跨表是同一位老师" },
          ],
          name: sameName[0].name,
          sourceRefs: candidateRefs,
          persistenceContract: "teacher_hard_resolution_v2",
        });
      }
    }
    if (sameWorkbookDuplicate && !allSameWorkbookDuplicatesResolved && !explicitlyHardLinked) {
      sameName.forEach((row) => blocked.add(row));
      // A mixed-workbook group is one closed V2 decision (merge all rows or
      // keep every row separate).  Emitting overlapping same/cross decisions
      // would permit contradictory partitions.  Pure same-workbook groups
      // retain their own merge/separate choice.
      for (const workbook of workbooks.size === 1 ? [...workbooks].sort(compareText) : []) {
        const duplicateRows = sameName.filter((row) => row.workbook === workbook);
        if (duplicateRows.length < 2 || !sourceRevisions) continue;
        const refs = orderedIdentityReferences(duplicateRows.map((row) => ({
          workbook: row.workbook,
          sourceId: row.sourceId,
          sourceRow: row.sourceRow,
        })));
        const resolutionKey = teacherSameWorkbookResolutionKey({ sourceRefs: refs, sourceRevisions });
        identityResolutions.push({
          kind: "same_workbook_identity",
          resolutionKey,
          options: [
            { resolutionKey: teacherSameWorkbookDecisionKey({ sourceRefs: refs, sourceRevisions, decision: "separate" }), decision: "separate", label: "确认是多位老师" },
            { resolutionKey: teacherSameWorkbookDecisionKey({ sourceRefs: refs, sourceRevisions, decision: "merge" }), decision: "merge", label: "确认是同一位老师" },
          ],
          name: duplicateRows[0].name,
          sourceRefs: refs,
          persistenceContract: "teacher_hard_resolution_v2",
        });
      }
      issues.push({
        code: "duplicate_roster_name",
        name: sameName[0].name,
        sourceRows: sameName.map((row) => row.sourceRow),
        detail: "The active roster contains duplicate conservative-name rows that require an explicit merge or separate decision.",
      });
    }
  }

  for (const pending of pendingSubjectResolutions) {
    const assignmentOptions = pending.candidateRows.map((row): TeacherSubjectResolutionOption => ({
      resolutionKey: sourceRevisions ? teacherSubjectResolutionKey({
        subjectRef: pending.subjectRef,
        rosterRef: { workbook: row.workbook, sourceId: row.sourceId, sourceRow: row.sourceRow },
        decision: "assign",
        sourceRevisions,
      }) : "",
      decision: "assign",
      label: `${row.name} · roster ${row.sourceRow}`,
      rosterRef: { workbook: row.workbook, sourceId: row.sourceId, sourceRow: row.sourceRow },
    })).filter((option) => Boolean(option.resolutionKey));
    const ignoreOption: TeacherSubjectResolutionOption | undefined = sourceRevisions ? {
      resolutionKey: teacherSubjectResolutionKey({ subjectRef: pending.subjectRef, decision: "ignore", sourceRevisions }),
      decision: "ignore",
      label: "明确忽略此科目行",
    } : undefined;
    const options = [...assignmentOptions, ...(ignoreOption ? [ignoreOption] : [])];
    const selected = options.map((option) => hardDecisionByKey.get(option.resolutionKey))
      .find((resolution): resolution is Extract<TeacherHardResolutionDecision, { kind: "subject_assignment" }> => resolution?.kind === "subject_assignment");
    const selectedOption = selected ? options.find((option) => option.resolutionKey === selected.resolutionKey) : undefined;
    const selectedRoster = selectedOption?.rosterRef
      ? rosterByReference.get(sourceReferenceKey(selectedOption.rosterRef))?.[0]
      : undefined;
    const validSelected = Boolean(selectedOption)
      && selected?.sourceRevisions.k12 === sourceRevisions?.k12
      && selected?.sourceRevisions.university === sourceRevisions?.university
      && same(selected?.subjectRef, pending.subjectRef)
      && same(selected?.rosterRef, selectedOption?.rosterRef)
      && ((selected?.decision === "ignore" && !selectedRoster)
        || (selected?.decision === "assign" && Boolean(selectedRoster)));
    if (validSelected && selected?.decision === "assign" && selectedRoster) {
      consumedHardResolutionKeys.add(selected.resolutionKey);
      if (!selectedRoster.subjects.includes(pending.sheetName)) selectedRoster.subjects.push(pending.sheetName);
      if (pending.detail && !selectedRoster.subjectDetails.includes(pending.detail)) selectedRoster.subjectDetails.push(pending.detail);
      continue;
    }
    if (validSelected && selected?.decision === "ignore") {
      consumedHardResolutionKeys.add(selected.resolutionKey);
      issues.push({
        code: "subject_row_ignored",
        workbook: pending.subjectRef.workbook,
        name: pending.name,
        sheetName: pending.sheetName,
        sourceRows: [pending.subjectRef.sourceRow],
        detail: "An administrator explicitly ignored this revision-bound subject row.",
      });
      continue;
    }
    if (selected) {
      issues.push({
        code: "hard_resolution_invalid",
        workbook: pending.subjectRef.workbook,
        name: pending.name,
        sheetName: pending.sheetName,
        sourceRows: [pending.subjectRef.sourceRow],
        detail: "Saved subject assignment no longer matches a current closed option.",
      });
    } else {
      issues.push({
        code: pending.issueCode,
        workbook: pending.subjectRef.workbook,
        name: pending.name,
        sheetName: pending.sheetName,
        sourceRows: [pending.subjectRef.sourceRow, ...pending.candidateRows.map((row) => row.sourceRow)],
        detail: pending.issueCode === "subject_name_ambiguous"
          ? "Subject row cannot be assigned because the roster name is duplicated."
          : "Subject row has no exact conservative-name match in the active roster.",
      });
    }
    subjectResolutions.push({
      kind: "subject_assignment",
      workbook: pending.subjectRef.workbook,
      name: pending.name,
      sheetName: pending.sheetName,
      subjectRef: pending.subjectRef,
      options,
      persistenceContract: "teacher_hard_resolution_v2",
    });
  }

  for (const resolution of currentHardResolutions) {
    if (consumedHardResolutionKeys.has(resolution.resolutionKey)) continue;
    if (issues.some((issue) => issue.code === "hard_resolution_invalid"
      && issue.sourceRows?.some((sourceRow) => String(sourceRow) === String(
        resolution.kind === "subject_assignment" ? resolution.subjectRef.sourceRow : resolution.sourceRefs[0]?.sourceRow,
      )))) continue;
    issues.push({
      code: "hard_resolution_invalid",
      workbook: resolution.kind === "subject_assignment" ? resolution.subjectRef.workbook : resolution.sourceRefs[0]?.workbook,
      sourceRows: resolution.kind === "subject_assignment"
        ? [resolution.subjectRef.sourceRow]
        : resolution.sourceRefs.map((reference) => reference.sourceRow),
      detail: "A current hard decision no longer maps to any current server-generated choice.",
    });
  }

  for (const row of roster) {
    const order = new Map(expectedSubjectSheets(row.workbook).map((sheet, index) => [sheet, index]));
    row.subjects.sort((left, right) => (order.get(left) ?? 999) - (order.get(right) ?? 999));
  }

  const actions: TeacherImportAction[] = [];
  const resolved: ResolvedRoster[] = [];
  for (const row of roster) {
    if (blocked.has(row)) {
      actions.push({ kind: "blocked", name: row.name, matchMethod: "ambiguous", changedFields: [] });
      continue;
    }
    const reference: TeacherSourceReference = { workbook: row.workbook, sourceId: row.sourceId, sourceRow: row.sourceRow };
    const hardIdentityLink = hardIdentityLinkByReference.get(sourceReferenceKey(reference));
    if (hardIdentityLink) {
      const sourceMatches = existingBySource.get(sourceReferenceKey(reference)) ?? [];
      const linkedSourceMatches = hardIdentityLink.sourceRefs.flatMap((linkedReference) =>
        existingBySource.get(sourceReferenceKey(linkedReference)) ?? []);
      const linkedExistingIds = [...new Set(linkedSourceMatches.map((teacher) => teacher.id))];
      const nameMatches = existingByName.get(row.normalizedName) ?? [];
      if (hardIdentityLink.decision === "merge") {
        if (linkedExistingIds.length > 1 || (!linkedExistingIds.length && nameMatches.length > 1)) {
          issues.push({
            code: "identity_link_existing_conflict",
            workbook: row.workbook,
            name: row.name,
            sourceRows: hardIdentityLink.sourceRefs.map((linkedReference) => linkedReference.sourceRow),
            existingTeacherIds: linkedExistingIds.length ? linkedExistingIds : nameMatches.map((teacher) => teacher.id),
            detail: "The same-workbook merge maps to more than one existing teacher.",
          });
          actions.push({ kind: "blocked", name: row.name, matchMethod: "ambiguous", changedFields: [] });
          continue;
        }
        const existing = linkedSourceMatches[0] ?? nameMatches[0];
        resolved.push({
          row,
          reference,
          ...(existing ? { existing } : {}),
          canonicalId: existing?.id ?? teacherIdForIdentityLink(hardIdentityLink.resolutionKey),
          matchMethod: "identity_link",
        });
        continue;
      }
      const allLinkedOwners = hardIdentityLink.sourceRefs.flatMap((linkedReference) =>
        existingBySource.get(sourceReferenceKey(linkedReference)) ?? []);
      const linkedOwnersByReference = hardIdentityLink.sourceRefs.map((linkedReference) =>
        existingBySource.get(sourceReferenceKey(linkedReference)) ?? []);
      const sameExistingOwnsMultipleRefs = [...new Set(allLinkedOwners.map((teacher) => teacher.id))]
        .some((teacherId) => linkedOwnersByReference.filter((owners) =>
          owners.some((owner) => owner.id === teacherId)).length > 1);
      const unlinkedNameMatches = nameMatches.filter((teacher) => !allLinkedOwners.some((owner) => owner.id === teacher.id));
      if (sourceMatches.length > 1 || unlinkedNameMatches.length || sameExistingOwnsMultipleRefs) {
        issues.push({
          code: sourceMatches.length > 1 ? "duplicate_source_reference" : "identity_link_existing_conflict",
          workbook: row.workbook,
          name: row.name,
          sourceRows: [row.sourceRow],
          existingTeacherIds: sourceMatches.length > 1
            ? sourceMatches.map((teacher) => teacher.id)
            : sameExistingOwnsMultipleRefs
              ? [...new Set(allLinkedOwners.map((teacher) => teacher.id))]
              : unlinkedNameMatches.map((teacher) => teacher.id),
          detail: sameExistingOwnsMultipleRefs
            ? "More than one chosen source row already belongs to the same canonical teacher and cannot be separated by this import."
            : "A separate decision conflicts with an unowned same-name existing teacher.",
        });
        actions.push({ kind: "blocked", name: row.name, matchMethod: "ambiguous", changedFields: [] });
        continue;
      }
      const existing = sourceMatches[0];
      resolved.push({
        row,
        reference,
        ...(existing ? { existing } : {}),
        canonicalId: existing?.id ?? teacherIdForSource(reference),
        matchMethod: "identity_separate",
      });
      continue;
    }
    const identityLink = linkByReference.get(sourceReferenceKey(reference));
    if (identityLink) {
      const linkedSourceMatches = identityLink.sourceRefs.flatMap((linkedReference) =>
        existingBySource.get(sourceReferenceKey(linkedReference)) ?? []);
      const linkedOwnersByReference = identityLink.sourceRefs.map((linkedReference) =>
        existingBySource.get(sourceReferenceKey(linkedReference)) ?? []);
      const linkedExistingIds = [...new Set(linkedSourceMatches.map((teacher) => teacher.id))];
      const nameMatches = existingByName.get(row.normalizedName) ?? [];
      const unlinkedNameMatches = nameMatches.filter((teacher) => !linkedExistingIds.includes(teacher.id));
      if (identityLink.decision === "separate") {
        const sourceMatches = existingBySource.get(sourceReferenceKey(reference)) ?? [];
        const sameExistingOwnsBothRefs = linkedOwnersByReference.every((owners) => owners.length === 1)
          && new Set(linkedOwnersByReference.map((owners) => owners[0].id)).size === 1;
        if (sourceMatches.length > 1 || unlinkedNameMatches.length || sameExistingOwnsBothRefs) {
          issues.push({
            code: sourceMatches.length > 1 ? "duplicate_source_reference" : "identity_link_existing_conflict",
            workbook: row.workbook,
            name: row.name,
            sourceRows: [row.sourceRow],
            existingTeacherIds: sourceMatches.length > 1
              ? sourceMatches.map((teacher) => teacher.id)
              : sameExistingOwnsBothRefs ? [linkedOwnersByReference[0][0].id] : unlinkedNameMatches.map((teacher) => teacher.id),
            detail: sourceMatches.length > 1
              ? "More than one existing teacher owns this stable source reference."
              : sameExistingOwnsBothRefs
                ? "Both source rows already belong to one canonical teacher and cannot be separated by this import."
              : "A same-name existing teacher has no stable ownership of either confirmed source row.",
          });
          actions.push({ kind: "blocked", name: row.name, matchMethod: "ambiguous", changedFields: [] });
          continue;
        }
        // An explicit separate decision disables name fallback. Each source
        // row keeps or creates its own stable canonical teacher.
        const existing = sourceMatches[0];
        resolved.push({
          row,
          reference,
          ...(existing ? { existing } : {}),
          canonicalId: existing?.id ?? teacherIdForSource(reference),
          matchMethod: "identity_separate",
        });
        continue;
      }
      if (linkedExistingIds.length > 1
        || (!linkedExistingIds.length && nameMatches.length > 1)
        || (linkedExistingIds.length > 0 && unlinkedNameMatches.length > 0)) {
        identityLink.sourceRefs.flatMap((linkedReference) => rosterByReference.get(sourceReferenceKey(linkedReference)) ?? [])
          .forEach((linkedRow) => blocked.add(linkedRow));
        issues.push({
          code: "identity_link_existing_conflict",
          name: row.name,
          sourceRows: identityLink.sourceRefs.map((linkedReference) => linkedReference.sourceRow),
          existingTeacherIds: linkedExistingIds.length ? linkedExistingIds : nameMatches.map((teacher) => teacher.id),
          detail: "The confirmed merge maps to more than one existing teacher; a separate existing-record review is required.",
        });
        actions.push({ kind: "blocked", name: row.name, matchMethod: "ambiguous", changedFields: [] });
        continue;
      }
      const existing = linkedSourceMatches[0] ?? nameMatches[0];
      resolved.push({
        row,
        reference,
        ...(existing ? { existing } : {}),
        canonicalId: existing?.id ?? teacherIdForIdentityLink(identityLink.resolutionKey),
        matchMethod: "identity_link",
      });
      continue;
    }
    const sourceMatches = existingBySource.get(sourceReferenceKey(reference)) ?? [];
    if (sourceMatches.length > 1) {
      issues.push({ code: "duplicate_source_reference", workbook: row.workbook, name: row.name, sourceRows: [row.sourceRow], existingTeacherIds: sourceMatches.map((teacher) => teacher.id), detail: "More than one existing teacher owns this stable source reference." });
      actions.push({ kind: "blocked", name: row.name, matchMethod: "ambiguous", changedFields: [] });
      continue;
    }
    const nameMatches = existingByName.get(row.normalizedName) ?? [];
    if (!sourceMatches.length && nameMatches.length > 1) {
      issues.push({ code: "existing_name_ambiguous", workbook: row.workbook, name: row.name, sourceRows: [row.sourceRow], existingTeacherIds: nameMatches.map((teacher) => teacher.id), detail: "Name fallback is unsafe because more than one existing teacher has this name." });
      actions.push({ kind: "blocked", name: row.name, matchMethod: "ambiguous", changedFields: [] });
      continue;
    }
    const existing = sourceMatches[0] ?? nameMatches[0];
    resolved.push({
      row,
      reference,
      ...(existing ? { existing } : {}),
      canonicalId: existing?.id ?? teacherIdForSource(reference),
      matchMethod: sourceMatches.length ? "source_reference" : existing ? "unique_name" : "new",
    });
  }

  const teachers: ImportedTeacherRecord[] = [];
  for (const [id, group] of groupBy(resolved, (item) => item.canonicalId)) {
    const existing = group.find((item) => item.existing)?.existing;
    if (group.some((item) => item.existing && item.existing.id !== id)) {
      throw new TeacherImportError("duplicate_output_id", `Teacher output id ${id} resolves to conflicting existing teachers.`);
    }
    const rows = [...group].sort((left, right) => compareText(sourceReferenceKey(left.reference), sourceReferenceKey(right.reference)));
    const uniqueTexts = (values: readonly (string | null | undefined)[]) => [...new Set(values.map(cleanText).filter((value): value is string => Boolean(value)))];
    const joinedText = (values: readonly (string | null | undefined)[]) => {
      const unique = uniqueTexts(values);
      return unique.length ? unique.join("；") : undefined;
    };
    const refs = [...new Map([...(existing?.teacherSourceRefs ?? []), ...rows.map((item) => item.reference)]
      .map((reference) => [sourceReferenceKey(reference), reference])).values()]
      .sort((left, right) => compareText(sourceReferenceKey(left), sourceReferenceKey(right)));
    const subjects = [...new Set(rows.flatMap((item) => item.row.subjects))];
    const departments = [...new Set(rows.map((item): "中小学" | "大学" => item.row.workbook === "k12" ? "中小学" : "大学"))]
      .sort((left, right) => left === right ? 0 : left === "中小学" ? -1 : 1);
    // These are snapshots of the current Tencent sources, not append-only
    // histories. Re-importing a newer revision must replace stale source text
    // and subject detail instead of accumulating every prior revision forever.
    const availabilitySourceText = joinedText(rows.map((item) => item.row.availabilityText));
    const capacitySourceText = joinedText(rows.map((item) => item.row.capacityText));
    const subjectDetail = joinedText(rows.flatMap((item) => item.row.subjectDetails));
    const sourceLocations = [...new Set(rows
      .map((item) => typeof item.row.attributes.location === "string"
        ? cleanText(item.row.attributes.location)
        : undefined)
      .filter((value): value is string => Boolean(value)))];
    const location = typeof existing?.location === "string" && cleanText(existing.location)
      ? cleanText(existing.location)
      : sourceLocations.length === 1 ? sourceLocations[0] : undefined;
    const existingTimezone = typeof existing?.timezone === "string" && cleanText(existing.timezone)
      ? cleanText(existing.timezone)
      : undefined;
    const mappedTimezone = timezoneForLocation(location);
    const timezone = existingTimezone ?? mappedTimezone ?? "Australia/Melbourne";
    const existingAvailability = typeof existing?.availability === "string" && existing.availability.trim()
      ? existing.availability
      : undefined;
    const existingAvailabilityStatus = existing?.availabilityStatus === "可接新生"
      || existing?.availabilityStatus === "暂停接新"
      || existing?.availabilityStatus === "待确认"
      ? existing.availabilityStatus
      : undefined;
    const next: ImportedTeacherRecord = {
      ...Object.fromEntries(Object.entries(existing ?? {}).filter(([field]) => !managedFields.has(field))),
      id,
      name: group.length > 1 && existing ? existing.name : rows[0].row.name,
      initials: typeof existing?.initials === "string" && cleanText(existing.initials)
        ? cleanText(existing.initials)!
        : teacherInitials(group.length > 1 && existing ? existing.name : rows[0].row.name),
      subjects,
      ...(subjectDetail ? { subjectDetail } : {}),
      departments,
      sourceCategories: subjects,
      teacherSourceRefs: refs,
      // Free-form source AVA is retained for review only. Scheduling consumes
      // reviewed monthly availabilityWindows, never this source sentence.
      availability: existingAvailability ?? "待老师按月提交",
      availabilityStatus: existingAvailabilityStatus ?? "待确认",
      timezone,
      load: typeof existing?.load === "number" && Number.isFinite(existing.load) && existing.load >= 0
        ? existing.load
        : 0,
      capacity: typeof existing?.capacity === "number" && Number.isFinite(existing.capacity) && existing.capacity >= 0
        ? existing.capacity
        : 0,
      acceptsStudents: typeof existing?.acceptsStudents === "boolean" ? existing.acceptsStudents : false,
      note: typeof existing?.note === "string" && cleanText(existing.note)
        ? cleanText(existing.note)!
        : "待教务审核教师资料与月度 AVA",
      ...(location ? { location } : {}),
      ...(availabilitySourceText ? { availabilitySourceText } : {}),
      ...(capacitySourceText ? { capacitySourceText } : {}),
    };
    for (const item of rows) {
      if (item.row.availabilityText) issues.push({ code: "unstructured_availability", workbook: item.row.workbook, name: item.row.name, sourceRows: [item.row.sourceRow], detail: "AVA source text was preserved but not converted to monthly windows." });
      if (item.row.capacityText) issues.push({ code: "unstructured_capacity", workbook: item.row.workbook, name: item.row.name, sourceRows: [item.row.sourceRow], detail: "Capacity source text was preserved but not converted to a numeric new-student capacity." });
    }
    if (!existingTimezone && !mappedTimezone) {
      issues.push({
        code: "timezone_defaulted",
        name: next.name,
        detail: "No reviewed location-to-timezone match was available; Australia/Melbourne is retained as the safe scheduling default until review.",
      });
    }
    const changes = existing ? changedFields(existing, next) : [...managedFields].filter((field) => field in next).sort(compareText);
    teachers.push(next);
    actions.push({
      kind: !existing ? "insert" : changes.length ? "update" : "unchanged",
      teacherId: id,
      name: next.name,
      matchMethod: group.some((item) => item.matchMethod === "identity_link")
        ? "identity_link"
        : group.some((item) => item.matchMethod === "identity_separate") ? "identity_separate"
        : group.some((item) => item.matchMethod === "source_reference") ? "source_reference" : group[0].matchMethod,
      changedFields: changes,
    });
  }

  const importedIds = new Set(teachers.map((teacher) => teacher.id));
  for (const existing of existingTeachers) {
    if (importedIds.has(existing.id)) continue;
    const preserved = preservedExistingTeacher(existing);
    const changes = changedFields(existing, preserved);
    teachers.push(preserved);
    actions.push({
      kind: changes.length ? "update" : "unchanged",
      teacherId: existing.id,
      name: existing.name,
      matchMethod: "preserved_existing",
      changedFields: changes,
    });
  }

  issues.sort((left, right) => compareText(`${left.code}:${left.workbook ?? ""}:${left.name ?? ""}:${left.sheetName ?? ""}`, `${right.code}:${right.workbook ?? ""}:${right.name ?? ""}:${right.sheetName ?? ""}`));
  identityResolutions.sort((left, right) => compareText(`${left.name}:${left.resolutionKey}`, `${right.name}:${right.resolutionKey}`));
  subjectResolutions.sort((left, right) => compareText(subjectSourceReferenceKey(left.subjectRef), subjectSourceReferenceKey(right.subjectRef)));
  actions.sort((left, right) => compareText(`${left.name}:${left.teacherId ?? ""}`, `${right.name}:${right.teacherId ?? ""}`));
  teachers.sort((left, right) => compareText(`${left.name}:${left.id}`, `${right.name}:${right.id}`));
  return {
    teachers,
    actions,
    issues,
    identityResolutions,
    subjectResolutions,
    summary: {
      insert: actions.filter((action) => action.kind === "insert").length,
      update: actions.filter((action) => action.kind === "update").length,
      unchanged: actions.filter((action) => action.kind === "unchanged").length,
      blocked: actions.filter((action) => action.kind === "blocked").length,
      issues: issues.length,
      unstructuredAvailability: issues.filter((issue) => issue.code === "unstructured_availability").length,
      unstructuredCapacity: issues.filter((issue) => issue.code === "unstructured_capacity").length,
    },
  };
}
