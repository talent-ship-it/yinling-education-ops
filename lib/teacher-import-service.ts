import { createHash } from "node:crypto";

import {
  buildTeacherImportPlan,
  type ExistingTeacherImportRecord,
  type ImportedTeacherRecord,
  type TeacherHardResolutionDecision,
  type TeacherIdentityLink,
  type TeacherImportPlan,
  type TeacherImportSourceKey,
  type TeacherSourceReference,
  type TeacherRosterImportRow,
  type TeacherSubjectImportRow,
  type TeacherWorkbookKind,
  type TeacherWorkbookSnapshot,
} from "@/lib/teacher-import";
import { DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER } from "@/lib/demo-users";
import type { OpsStateRow } from "@/lib/ops-store";

const FINGERPRINT_CONTRACT = "teacher-import-plan-v1";
const ATOMIC_COMMIT_CONTRACT = "teacher-import-atomic-v1";
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TOP_LEVEL_FIELDS = new Set(["k12", "university", "identityLinks", "hardResolutions"]);
const WORKBOOK_FIELDS = new Set(["workbook", "sourceId", "revision", "sheetNames", "rosterRows", "subjectRows"]);
const ROSTER_ROW_FIELDS = new Set(["workbook", "sourceRow", "name", "availabilityText", "capacityText", "attributes"]);
const ROSTER_ATTRIBUTE_FIELDS = new Set(["location"]);
const SUBJECT_ROW_FIELDS = new Set(["workbook", "sheetName", "sourceRow", "name", "subjectDetail"]);
const SOURCE_REF_FIELDS = new Set(["workbook", "sourceId", "sourceRow"]);
const IDENTITY_LINK_FIELDS = new Set(["resolutionKey", "decision", "sourceRevisions", "sourceRefs"]);
const HARD_RESOLUTION_FIELDS = new Set(["kind", "resolutionKey", "decision", "sourceRevisions", "sourceRefs", "subjectRef", "rosterRef"]);
const SUBJECT_REF_FIELDS = new Set(["workbook", "sourceId", "sheetName", "sourceRow"]);
const SOURCE_REVISION_FIELDS = new Set(["k12", "university"]);
const COMMIT_REQUEST_FIELDS = new Set(["planFingerprint", "expectedTeacherVersion"]);
const RESOLUTION_REQUEST_FIELDS = new Set(["resolutionKey", "decision"]);
const FORBIDDEN_CLIENT_PLAN_FIELDS = [
  "teachers",
  "plan",
  "actions",
  "issues",
  "workbooks",
  "sources",
  "sourceRevisions",
] as const;

type RecordValue = Record<string, unknown>;

export type TeacherImportSourceSnapshot = Readonly<{
  k12: TeacherWorkbookSnapshot & Readonly<{ workbook: "k12" }>;
  university: TeacherWorkbookSnapshot & Readonly<{ workbook: "university" }>;
  identityLinks: readonly TeacherIdentityLink[];
  hardResolutions: readonly TeacherHardResolutionDecision[];
}>;

export type TeacherImportSourceIngestRequest = TeacherWorkbookSnapshot;

export type TeacherImportDryRunResponse = Readonly<{
  planFingerprint: string;
  expectedTeacherVersion: number;
  canCommit: boolean;
  sources: Readonly<Record<TeacherWorkbookKind, Readonly<{
    sourceId: string;
    revision: string;
    rosterRowCount: number;
    subjectRowCount: number;
  }>>>;
  summary: TeacherImportPlan["summary"];
  actions: TeacherImportPlan["actions"];
  issues: TeacherImportPlan["issues"];
  identityResolutions: TeacherImportPlan["identityResolutions"];
  subjectResolutions: TeacherImportPlan["subjectResolutions"];
}>;

export type PreparedTeacherImport = Readonly<{
  plan: TeacherImportPlan;
  response: TeacherImportDryRunResponse;
  sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
}>;

/** The complete and only teacher-import confirmation accepted from a browser. */
export type TeacherImportCommitRequest = Readonly<{
  planFingerprint: string;
  expectedTeacherVersion: number;
}>;

export type TeacherIdentityResolutionRequest = Readonly<{
  resolutionKey: string;
  decision: "merge" | "separate" | "assign" | "ignore";
}>;

/** Every field except the two client confirmation fields is server-computed. */
export type TeacherImportAtomicCommitContract = Readonly<{
  contract: typeof ATOMIC_COMMIT_CONTRACT;
  entity: "teachers";
  planFingerprint: string;
  expectedTeacherVersion: number;
  sourceRevisions: Readonly<Record<TeacherWorkbookKind, string>>;
  teachers: readonly ImportedTeacherRecord[];
}>;

export type TeacherImportServiceErrorCode =
  | "invalid_source_snapshot"
  | "invalid_source_ingest_request"
  | "invalid_teachers_state"
  | "invalid_commit_request"
  | "invalid_identity_resolution_request"
  | "identity_resolution_unavailable"
  | "client_plan_forbidden"
  | "blocked_plan"
  | "stale_plan"
  | "stale_teachers_version";

export class TeacherImportServiceError extends Error {
  constructor(readonly code: TeacherImportServiceErrorCode, message: string) {
    super(message);
    this.name = "TeacherImportServiceError";
  }
}

export function hasTeacherImportAdminAccess(actor: string | null, fullAdmin: boolean) {
  return actor === DEMO_LIMITED_ADMIN_USER || (actor === DEMO_ADMIN_USER && fullAdmin);
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value: RecordValue, allowed: ReadonlySet<string>) {
  return Object.keys(value).every((field) => allowed.has(field));
}

function requiredText(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${label} is invalid.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, maximum = 2_000): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length > maximum) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${label} is invalid.`);
  }
  return value;
}

function sourceKey(value: unknown, label: string): TeacherImportSourceKey {
  if ((typeof value === "string" && Boolean(value.trim()) && value.length <= 240)
    || (typeof value === "number" && Number.isSafeInteger(value))) {
    return value as TeacherImportSourceKey;
  }
  throw new TeacherImportServiceError("invalid_source_snapshot", `${label} must be a stable string or integer.`);
}

function workbookKind(value: unknown, expected: TeacherWorkbookKind, label: string): TeacherWorkbookKind {
  if (value !== expected) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${label} must be ${expected}.`);
  }
  return expected;
}

function parseRosterRow(value: unknown, expected: TeacherWorkbookKind, index: number): TeacherRosterImportRow {
  if (!isRecord(value) || !exactFields(value, ROSTER_ROW_FIELDS)) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${expected} rosterRows[${index}] has unsupported fields.`);
  }
  const attributes = value.attributes;
  if (attributes !== undefined && !isRecord(attributes)) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${expected} rosterRows[${index}].attributes must be an object.`);
  }
  if (attributes && !exactFields(attributes, ROSTER_ATTRIBUTE_FIELDS)) {
    throw new TeacherImportServiceError(
      "invalid_source_snapshot",
      `${expected} rosterRows[${index}].attributes contains unsupported fields.`,
    );
  }
  const location = attributes?.location === undefined
    ? undefined
    : optionalText(attributes.location, `${expected} rosterRows[${index}].attributes.location`, 240);
  return {
    workbook: workbookKind(value.workbook, expected, `${expected} rosterRows[${index}].workbook`),
    sourceRow: sourceKey(value.sourceRow, `${expected} rosterRows[${index}].sourceRow`),
    name: requiredText(value.name, `${expected} rosterRows[${index}].name`),
    ...(value.availabilityText !== undefined
      ? { availabilityText: optionalText(value.availabilityText, `${expected} rosterRows[${index}].availabilityText`) }
      : {}),
    ...(value.capacityText !== undefined
      ? { capacityText: optionalText(value.capacityText, `${expected} rosterRows[${index}].capacityText`) }
      : {}),
    ...(location ? { attributes: { location } } : {}),
  };
}

function parseSubjectRow(value: unknown, expected: TeacherWorkbookKind, index: number): TeacherSubjectImportRow {
  if (!isRecord(value) || !exactFields(value, SUBJECT_ROW_FIELDS)) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${expected} subjectRows[${index}] has unsupported fields.`);
  }
  return {
    workbook: workbookKind(value.workbook, expected, `${expected} subjectRows[${index}].workbook`),
    sheetName: requiredText(value.sheetName, `${expected} subjectRows[${index}].sheetName`),
    sourceRow: sourceKey(value.sourceRow, `${expected} subjectRows[${index}].sourceRow`),
    name: requiredText(value.name, `${expected} subjectRows[${index}].name`),
    ...(value.subjectDetail !== undefined
      ? { subjectDetail: optionalText(value.subjectDetail, `${expected} subjectRows[${index}].subjectDetail`) }
      : {}),
  };
}

function parseSourceRevisions(value: unknown, label: string): Readonly<Record<TeacherWorkbookKind, string>> {
  if (!isRecord(value) || !exactFields(value, SOURCE_REVISION_FIELDS)
    || typeof value.k12 !== "string" || !value.k12.trim()
    || typeof value.university !== "string" || !value.university.trim()) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${label} source revisions are invalid.`);
  }
  return { k12: value.k12.trim(), university: value.university.trim() };
}

function parseHardSourceRef(value: unknown, label: string): TeacherSourceReference {
  if (!isRecord(value) || !exactFields(value, SOURCE_REF_FIELDS)
    || (value.workbook !== "k12" && value.workbook !== "university")
    || typeof value.sourceId !== "string" || !value.sourceId.trim() || value.sourceId.length > 160) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${label} is invalid.`);
  }
  return {
    workbook: value.workbook,
    sourceId: value.sourceId.trim(),
    sourceRow: sourceKey(value.sourceRow, `${label}.sourceRow`),
  };
}

function parseTeacherHardResolution(value: unknown, index: number): TeacherHardResolutionDecision {
  const label = `Teacher hard resolution ${index}`;
  if (!isRecord(value) || !exactFields(value, HARD_RESOLUTION_FIELDS)
    || typeof value.resolutionKey !== "string" || !FINGERPRINT_PATTERN.test(value.resolutionKey)) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${label} is invalid.`);
  }
  const sourceRevisions = parseSourceRevisions(value.sourceRevisions, label);
  if (value.kind === "same_workbook_identity" || value.kind === "cross_workbook_identity") {
    if ((value.decision !== "merge" && value.decision !== "separate")
      || !Array.isArray(value.sourceRefs) || value.sourceRefs.length < 2
      || value.subjectRef !== undefined || value.rosterRef !== undefined) {
      throw new TeacherImportServiceError("invalid_source_snapshot", `${label} identity decision is invalid.`);
    }
    return {
      kind: value.kind,
      resolutionKey: value.resolutionKey,
      decision: value.decision,
      sourceRevisions,
      sourceRefs: value.sourceRefs.map((reference, refIndex) => parseHardSourceRef(reference, `${label} source ref ${refIndex}`)),
    };
  }
  if (value.kind !== "subject_assignment" || (value.decision !== "assign" && value.decision !== "ignore")
    || !isRecord(value.subjectRef) || !exactFields(value.subjectRef, SUBJECT_REF_FIELDS)
    || (value.subjectRef.workbook !== "k12" && value.subjectRef.workbook !== "university")
    || typeof value.subjectRef.sourceId !== "string" || !value.subjectRef.sourceId.trim()
    || typeof value.subjectRef.sheetName !== "string" || !value.subjectRef.sheetName.trim()
    || value.sourceRefs !== undefined
    || (value.decision === "assign") !== Boolean(value.rosterRef)) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${label} subject decision is invalid.`);
  }
  return {
    kind: "subject_assignment",
    resolutionKey: value.resolutionKey,
    decision: value.decision,
    sourceRevisions,
    subjectRef: {
      workbook: value.subjectRef.workbook,
      sourceId: value.subjectRef.sourceId.trim(),
      sheetName: value.subjectRef.sheetName.trim(),
      sourceRow: sourceKey(value.subjectRef.sourceRow, `${label} subject sourceRow`),
    },
    ...(value.rosterRef ? { rosterRef: parseHardSourceRef(value.rosterRef, `${label} roster ref`) } : {}),
  };
}

function parseWorkbook(value: unknown, expected: TeacherWorkbookKind): TeacherWorkbookSnapshot {
  if (!isRecord(value) || !exactFields(value, WORKBOOK_FIELDS)) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${expected} workbook snapshot has unsupported fields.`);
  }
  workbookKind(value.workbook, expected, `${expected} workbook`);
  const sourceId = requiredText(value.sourceId, `${expected} sourceId`, 160);
  const revision = requiredText(value.revision, `${expected} revision`, 240);
  if (!Array.isArray(value.sheetNames) || value.sheetNames.length < 1 || value.sheetNames.length > 100
    || !Array.isArray(value.rosterRows) || value.rosterRows.length > 10_000
    || !Array.isArray(value.subjectRows) || value.subjectRows.length > 100_000) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${expected} workbook arrays are invalid.`);
  }
  const sheetNames = value.sheetNames.map((sheet, index) => requiredText(sheet, `${expected} sheetNames[${index}]`, 200));
  if (new Set(sheetNames).size !== sheetNames.length) {
    throw new TeacherImportServiceError("invalid_source_snapshot", `${expected} sheetNames contains duplicates.`);
  }
  return {
    workbook: expected,
    sourceId,
    revision,
    sheetNames,
    rosterRows: value.rosterRows.map((row, index) => parseRosterRow(row, expected, index)),
    subjectRows: value.subjectRows.map((row, index) => parseSubjectRow(row, expected, index)),
  };
}

export function parseTeacherImportSourceSnapshot(value: unknown): TeacherImportSourceSnapshot {
  if (!isRecord(value) || !exactFields(value, TOP_LEVEL_FIELDS)
    || !("k12" in value) || !("university" in value)) {
    throw new TeacherImportServiceError("invalid_source_snapshot", "Both K12 and university teacher snapshots are required.");
  }
  if (value.identityLinks !== undefined && (!Array.isArray(value.identityLinks) || value.identityLinks.length > 10_000)) {
    throw new TeacherImportServiceError("invalid_source_snapshot", "Teacher identity links are invalid.");
  }
  if (value.hardResolutions !== undefined && (!Array.isArray(value.hardResolutions) || value.hardResolutions.length > 100_000)) {
    throw new TeacherImportServiceError("invalid_source_snapshot", "Teacher hard resolutions are invalid.");
  }
  const identityLinks = (value.identityLinks ?? []).map((link, index): TeacherIdentityLink => {
    if (!isRecord(link) || !exactFields(link, IDENTITY_LINK_FIELDS)
      || typeof link.resolutionKey !== "string" || !FINGERPRINT_PATTERN.test(link.resolutionKey)
      || (link.decision !== "merge" && link.decision !== "separate")
      || !isRecord(link.sourceRevisions) || !exactFields(link.sourceRevisions, SOURCE_REVISION_FIELDS)
      || typeof link.sourceRevisions.k12 !== "string" || !link.sourceRevisions.k12.trim()
      || typeof link.sourceRevisions.university !== "string" || !link.sourceRevisions.university.trim()
      || !Array.isArray(link.sourceRefs) || link.sourceRefs.length !== 2) {
      throw new TeacherImportServiceError("invalid_source_snapshot", `Teacher identity link ${index} is invalid.`);
    }
    const sourceRefs = link.sourceRefs.map((reference, refIndex): TeacherSourceReference => {
      if (!isRecord(reference) || !exactFields(reference, SOURCE_REF_FIELDS)
        || (reference.workbook !== "k12" && reference.workbook !== "university")
        || typeof reference.sourceId !== "string" || !reference.sourceId.trim()
        || reference.sourceId.length > 160) {
        throw new TeacherImportServiceError("invalid_source_snapshot", `Teacher identity link ${index} source ref ${refIndex} is invalid.`);
      }
      return {
        workbook: reference.workbook,
        sourceId: reference.sourceId.trim(),
        sourceRow: sourceKey(reference.sourceRow, `Teacher identity link ${index} source ref ${refIndex}`),
      };
    });
    return {
      resolutionKey: link.resolutionKey,
      decision: link.decision,
      sourceRevisions: {
        k12: link.sourceRevisions.k12.trim(),
        university: link.sourceRevisions.university.trim(),
      },
      sourceRefs,
    };
  });
  return {
    k12: parseWorkbook(value.k12, "k12") as TeacherImportSourceSnapshot["k12"],
    university: parseWorkbook(value.university, "university") as TeacherImportSourceSnapshot["university"],
    identityLinks,
    hardResolutions: (value.hardResolutions ?? []).map(parseTeacherHardResolution),
  };
}

/** Parses exactly one explicitly identified workbook upload. */
export function parseTeacherImportSourceIngestRequest(
  value: unknown,
): TeacherImportSourceIngestRequest {
  if (!isRecord(value) || (value.workbook !== "k12" && value.workbook !== "university")) {
    throw new TeacherImportServiceError(
      "invalid_source_ingest_request",
      "Teacher source upload must identify one K12 or university workbook.",
    );
  }
  try {
    const parsed = parseWorkbook(value, value.workbook);
    if (parsed.rosterRows.length < 1) {
      throw new TeacherImportServiceError(
        "invalid_source_ingest_request",
        "Teacher source upload must contain at least one active roster row.",
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof TeacherImportServiceError) {
      throw new TeacherImportServiceError("invalid_source_ingest_request", error.message);
    }
    throw error;
  }
}

const NON_BLOCKING_ISSUE_CODES = new Set([
  "subject_row_ignored",
  "timezone_defaulted",
  "unstructured_availability",
  "unstructured_capacity",
]);

export function teacherImportHasBlockingIssues(plan: TeacherImportPlan) {
  return plan.summary.blocked > 0
    || plan.issues.some((issue) => !NON_BLOCKING_ISSUE_CODES.has(issue.code));
}

function parseSourceReference(value: unknown, label: string) {
  if (!isRecord(value) || !exactFields(value, SOURCE_REF_FIELDS)
    || (value.workbook !== "k12" && value.workbook !== "university")) {
    throw new TeacherImportServiceError("invalid_teachers_state", `${label} is invalid.`);
  }
  return {
    workbook: value.workbook,
    sourceId: typeof value.sourceId === "string" && value.sourceId.trim() && value.sourceId.length <= 160
      ? value.sourceId.trim()
      : (() => { throw new TeacherImportServiceError("invalid_teachers_state", `${label}.sourceId is invalid.`); })(),
    sourceRow: (() => {
      try {
        return sourceKey(value.sourceRow, `${label}.sourceRow`);
      } catch {
        throw new TeacherImportServiceError("invalid_teachers_state", `${label}.sourceRow is invalid.`);
      }
    })(),
  };
}

function teachersState(row: OpsStateRow | undefined) {
  if (!row || row.entity !== "teachers" || !Number.isSafeInteger(row.version) || row.version < 0 || !Array.isArray(row.payload)) {
    throw new TeacherImportServiceError("invalid_teachers_state", "Teachers state is not available for import.");
  }
  const ids = new Set<string>();
  const teachers = row.payload.map((value, index): ExistingTeacherImportRecord => {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()
      || typeof value.name !== "string" || !value.name.trim()) {
      throw new TeacherImportServiceError("invalid_teachers_state", `Teachers state row ${index} is invalid.`);
    }
    if (ids.has(value.id)) throw new TeacherImportServiceError("invalid_teachers_state", `Teacher id ${value.id} is duplicated.`);
    ids.add(value.id);
    if (value.teacherSourceRefs !== undefined && !Array.isArray(value.teacherSourceRefs)) {
      throw new TeacherImportServiceError("invalid_teachers_state", `Teacher ${value.id} source refs are invalid.`);
    }
    const teacherSourceRefs = (value.teacherSourceRefs as unknown[] | undefined)?.map((reference, refIndex) =>
      parseSourceReference(reference, `Teacher ${value.id} source ref ${refIndex}`));
    return { ...value, ...(teacherSourceRefs ? { teacherSourceRefs } : {}) } as ExistingTeacherImportRecord;
  });
  return { teachers, version: row.version };
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

export function teacherImportPlanFingerprint(input: {
  plan: TeacherImportPlan;
  teacherVersion: number;
  sources: TeacherImportSourceSnapshot;
  identityLinks?: readonly TeacherIdentityLink[];
}) {
  const sourceIdentity = {
    k12: { sourceId: input.sources.k12.sourceId, revision: input.sources.k12.revision },
    university: { sourceId: input.sources.university.sourceId, revision: input.sources.university.revision },
  };
  return `sha256:${createHash("sha256").update(stableValue({
    contract: FINGERPRINT_CONTRACT,
    teacherVersion: input.teacherVersion,
    sources: sourceIdentity,
    identityLinks: input.identityLinks ?? [],
    hardResolutions: input.sources.hardResolutions,
    plan: input.plan,
  })).digest("hex")}`;
}

export function prepareTeacherImport(input: {
  sourceSnapshot: unknown;
  teachersRow: OpsStateRow | undefined;
  identityLinks?: readonly TeacherIdentityLink[];
}): PreparedTeacherImport {
  const sources = parseTeacherImportSourceSnapshot(input.sourceSnapshot);
  const current = teachersState(input.teachersRow);
  const identityLinks = input.identityLinks ?? sources.identityLinks;
  const plan = buildTeacherImportPlan({
    workbooks: [sources.k12, sources.university],
    existingTeachers: current.teachers,
    identityLinks,
    hardResolutions: sources.hardResolutions,
  });
  const planFingerprint = teacherImportPlanFingerprint({ plan, teacherVersion: current.version, sources, identityLinks });
  return {
    plan,
    sourceRevisions: { k12: sources.k12.revision, university: sources.university.revision },
    response: {
      planFingerprint,
      expectedTeacherVersion: current.version,
      canCommit: !teacherImportHasBlockingIssues(plan),
      sources: {
        k12: { sourceId: sources.k12.sourceId, revision: sources.k12.revision, rosterRowCount: sources.k12.rosterRows.length, subjectRowCount: sources.k12.subjectRows.length },
        university: { sourceId: sources.university.sourceId, revision: sources.university.revision, rosterRowCount: sources.university.rosterRows.length, subjectRowCount: sources.university.subjectRows.length },
      },
      summary: plan.summary,
      actions: plan.actions,
      issues: plan.issues,
      identityResolutions: plan.identityResolutions,
      subjectResolutions: plan.subjectResolutions,
    },
  };
}

export function parseTeacherIdentityResolutionRequest(value: unknown): TeacherIdentityResolutionRequest {
  if (!isRecord(value) || !exactFields(value, RESOLUTION_REQUEST_FIELDS)
    || typeof value.resolutionKey !== "string" || !FINGERPRINT_PATTERN.test(value.resolutionKey)
    || !["merge", "separate", "assign", "ignore"].includes(String(value.decision))) {
    throw new TeacherImportServiceError(
      "invalid_identity_resolution_request",
      "请选择一个当前预检提供的教师身份确认项。",
    );
  }
  return { resolutionKey: value.resolutionKey, decision: value.decision as TeacherIdentityResolutionRequest["decision"] };
}

export function resolveTeacherIdentityCandidate(
  request: TeacherIdentityResolutionRequest,
  prepared: PreparedTeacherImport,
) {
  const identityResolution = prepared.response.identityResolutions.find((candidate) =>
    candidate.options.some((option) => option.resolutionKey === request.resolutionKey
      && option.decision === request.decision));
  const subjectResolution = prepared.response.subjectResolutions.find((candidate) =>
    candidate.options.some((option) => option.resolutionKey === request.resolutionKey
      && option.decision === request.decision));
  const resolution = identityResolution ?? (subjectResolution
    ? { ...subjectResolution, selectedOption: subjectResolution.options.find((option) => option.resolutionKey === request.resolutionKey)! }
    : undefined);
  if (!resolution) {
    throw new TeacherImportServiceError(
      "identity_resolution_unavailable",
      "该身份确认项已失效，请重新预检。",
    );
  }
  return resolution;
}

export function parseTeacherImportCommitRequest(value: unknown): TeacherImportCommitRequest {
  if (!isRecord(value)) {
    throw new TeacherImportServiceError("invalid_commit_request", "Teacher import confirmation is incomplete.");
  }
  if (FORBIDDEN_CLIENT_PLAN_FIELDS.some((field) => field in value)) {
    throw new TeacherImportServiceError("client_plan_forbidden", "Teachers, sources and plans must be recomputed by the server.");
  }
  if (!exactFields(value, COMMIT_REQUEST_FIELDS)
    || typeof value.planFingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(value.planFingerprint)
    || !Number.isSafeInteger(value.expectedTeacherVersion)
    || (value.expectedTeacherVersion as number) < 0) {
    throw new TeacherImportServiceError("invalid_commit_request", "A valid fingerprint and expected teacher version are required.");
  }
  return {
    planFingerprint: value.planFingerprint,
    expectedTeacherVersion: value.expectedTeacherVersion as number,
  };
}

export function assertTeacherImportCommit(
  request: TeacherImportCommitRequest,
  prepared: PreparedTeacherImport,
): void {
  if (teacherImportHasBlockingIssues(prepared.plan)) {
    throw new TeacherImportServiceError(
      "blocked_plan",
      "Teacher source structure or identity conflicts must be resolved before import.",
    );
  }
  if (request.expectedTeacherVersion !== prepared.response.expectedTeacherVersion) {
    throw new TeacherImportServiceError("stale_teachers_version", "The teachers list changed after this plan was reviewed.");
  }
  if (request.planFingerprint !== prepared.response.planFingerprint) {
    throw new TeacherImportServiceError("stale_plan", "The teacher sources or import plan changed after review.");
  }
}

export function prepareTeacherImportAtomicCommit(
  request: TeacherImportCommitRequest,
  prepared: PreparedTeacherImport,
): TeacherImportAtomicCommitContract {
  assertTeacherImportCommit(request, prepared);
  return {
    contract: ATOMIC_COMMIT_CONTRACT,
    entity: "teachers",
    planFingerprint: prepared.response.planFingerprint,
    expectedTeacherVersion: prepared.response.expectedTeacherVersion,
    sourceRevisions: prepared.sourceRevisions,
    teachers: prepared.plan.teachers,
  };
}
