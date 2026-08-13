import { createHash } from "node:crypto";

import { DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER } from "@/lib/demo-users";
import {
  buildStudentImportPlan,
  importLessonPackagesForStudent,
  isMasterStudentStatus,
  StudentImportError,
  type ExistingStudentImportRecord,
  type JwbStudentImportRow,
  type MasterStudentImportRow,
  type StudentImportPlan,
  type StudentImportSourceKey,
} from "@/lib/student-import";
import type { OpsStateRow, StudentImportSourceRowsSnapshot } from "@/lib/ops-store";

const FINGERPRINT_CONTRACT = "student-import-plan-v2-packages";
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_CLIENT_PLAN_FIELDS = ["students", "masterRows", "jwbRows", "actions", "plan"] as const;
const COMMIT_REQUEST_FIELDS = new Set(["planFingerprint", "expectedStudentVersion"]);
const SOURCE_INGEST_REQUEST_FIELDS = new Set(["sourceKind", "sourceId", "revision", "rows"]);
const MASTER_SOURCE_ROW_FIELDS = new Set(["sourceRow", "name", "status", "attributes"]);
const JWB_SOURCE_ROW_FIELDS = new Set([
  "sourceRow",
  "name",
  "remainingHours",
  "contractHours",
  "contractEffectiveDate",
  "lessonPackages",
  "attributes",
]);

type RecordValue = Record<string, unknown>;

export type StudentImportDryRunResponse = Readonly<{
  planFingerprint: string;
  expectedStudentVersion: number;
  canCommit: boolean;
  sources: Readonly<{
    master: Readonly<{ sourceId: string; revision: string; rowCount: number }>;
    jwb: Readonly<{ sourceId: string; revision: string; rowCount: number }>;
  }>;
  summary: StudentImportPlan["summary"];
  excluded: StudentImportPlan["excluded"];
  unmatched: StudentImportPlan["unmatched"];
  ambiguous: StudentImportPlan["ambiguous"];
}>;

export type PreparedStudentImport = Readonly<{
  plan: StudentImportPlan;
  response: StudentImportDryRunResponse;
  sourceRevisions: Readonly<{ master: string; jwb: string }>;
}>;

export type StudentImportCommitRequest = Readonly<{
  planFingerprint: string;
  expectedStudentVersion: number;
}>;

export type StudentImportSourceKind = "master" | "jwb";

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
  | "client_plan_forbidden"
  | "ambiguous_plan"
  | "stale_plan"
  | "stale_students_version";

export class StudentImportServiceError extends Error {
  constructor(readonly code: StudentImportServiceErrorCode, message: string) {
    super(message);
    this.name = "StudentImportServiceError";
  }
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

function sourceKey(value: unknown): value is StudentImportSourceKey {
  return (typeof value === "string" && Boolean(value.trim()) && value.length <= 240)
    || (typeof value === "number" && Number.isSafeInteger(value));
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

function masterRows(value: unknown): readonly MasterStudentImportRow[] {
  const source = sourceIdentity(value, "Master");
  return source.rows.map((row) => {
    if (!isRecord(row) || !sourceKey(row.sourceRow) || typeof row.name !== "string" || typeof row.status !== "string") {
      throw new StudentImportServiceError("invalid_source_snapshot", "Master source rows do not match the import contract.");
    }
    return row as MasterStudentImportRow;
  });
}

function jwbRows(value: unknown): readonly JwbStudentImportRow[] {
  const source = sourceIdentity(value, "JWB");
  return source.rows.map((row) => {
    if (!isRecord(row) || !sourceKey(row.sourceRow) || typeof row.name !== "string") {
      throw new StudentImportServiceError("invalid_source_snapshot", "JWB source rows do not match the import contract.");
    }
    const parsed = row as JwbStudentImportRow;
    if (!parsed.name.trim()
      || (!isRecord(parsed.attributes) && parsed.attributes !== undefined)
      || (parsed.remainingHours !== undefined && parsed.remainingHours !== null
        && typeof parsed.remainingHours !== "number" && typeof parsed.remainingHours !== "string")
      || (parsed.contractHours !== undefined && parsed.contractHours !== null
        && typeof parsed.contractHours !== "number" && typeof parsed.contractHours !== "string")
      || (parsed.contractEffectiveDate !== undefined && parsed.contractEffectiveDate !== null
        && typeof parsed.contractEffectiveDate !== "string")
      || !isOptionalNonNegativeNumber(parsed.remainingHours)
      || !isOptionalNonNegativeNumber(parsed.contractHours)
      || !isOptionalIsoDate(parsed.contractEffectiveDate)
      || Object.keys(parsed).some((field) => !JWB_SOURCE_ROW_FIELDS.has(field))) {
      throw new StudentImportServiceError("invalid_source_snapshot", "JWB source rows do not match the import contract.");
    }
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
    return parsed;
  });
}

function isOptionalNonNegativeNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "number" && typeof value !== "string") return false;
  const parsed = typeof value === "number" ? value : Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0;
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
  return {
    master: { sourceId: master.sourceId, revision: master.revision, rows: masterRows(value.master) },
    jwb: { sourceId: jwb.sourceId, revision: jwb.revision, rows: jwbRows(value.jwb) },
  };
}

/**
 * Parses one explicitly uploaded source file. This never infers the source,
 * revision or freshness and never accepts a mixed master/JWB payload.
 */
export function parseStudentImportSourceIngestRequest(
  value: unknown,
): StudentImportSourceIngestRequest {
  if (!isRecord(value)
    || Object.keys(value).some((field) => !SOURCE_INGEST_REQUEST_FIELDS.has(field))
    || (value.sourceKind !== "master" && value.sourceKind !== "jwb")
    || typeof value.sourceId !== "string"
    || !value.sourceId.trim()
    || value.sourceId.length > 160
    || typeof value.revision !== "string"
    || !value.revision.trim()
    || value.revision.length > 240
    || !Array.isArray(value.rows)
    || value.rows.length < 1
    || value.rows.length > 10_000) {
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
    const rows = value.sourceKind === "master"
      ? masterRows(source)
      : jwbRows(source);
    if (value.sourceKind === "master") {
      for (const row of rows as readonly MasterStudentImportRow[]) {
        if (!row.name.trim()
          || !isMasterStudentStatus(row.status)
          || (!isRecord(row.attributes) && row.attributes !== undefined)
          || Object.keys(row).some((field) => !MASTER_SOURCE_ROW_FIELDS.has(field))) {
          throw new StudentImportServiceError("invalid_source_snapshot", "Master source rows do not match the import contract.");
        }
      }
    } else {
      // `jwbRows` already applies the complete strict package-level contract.
    }
    return {
      sourceKind: value.sourceKind,
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

export function studentImportPlanFingerprint(input: {
  plan: StudentImportPlan;
  studentVersion: number;
  sources: StudentImportSourceRowsSnapshot;
}) {
  const sourceIdentityOnly = {
    master: { sourceId: input.sources.master.sourceId, revision: input.sources.master.revision },
    jwb: { sourceId: input.sources.jwb.sourceId, revision: input.sources.jwb.revision },
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
}): PreparedStudentImport {
  const sources = parseStudentImportSourceSnapshot(input.sourceSnapshot);
  const current = studentsState(input.studentsRow);
  const plan = buildStudentImportPlan({
    masterRows: sources.master.rows,
    jwbRows: sources.jwb.rows,
    existingStudents: current.students,
    preserveManualTrials: true,
  });
  const planFingerprint = studentImportPlanFingerprint({ plan, studentVersion: current.version, sources });
  return {
    plan,
    sourceRevisions: { master: sources.master.revision, jwb: sources.jwb.revision },
    response: {
      planFingerprint,
      expectedStudentVersion: current.version,
      canCommit: plan.ambiguous.length === 0,
      sources: {
        master: { sourceId: sources.master.sourceId, revision: sources.master.revision, rowCount: sources.master.rows.length },
        jwb: { sourceId: sources.jwb.sourceId, revision: sources.jwb.revision, rowCount: sources.jwb.rows.length },
      },
      summary: plan.summary,
      excluded: plan.excluded,
      unmatched: plan.unmatched,
      ambiguous: plan.ambiguous,
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
  if (prepared.plan.ambiguous.length) {
    throw new StudentImportServiceError("ambiguous_plan", "Ambiguous student matches must be resolved before import.");
  }
  if (request.expectedStudentVersion !== prepared.response.expectedStudentVersion) {
    throw new StudentImportServiceError("stale_students_version", "The students list changed after this plan was reviewed.");
  }
  if (request.planFingerprint !== prepared.response.planFingerprint) {
    throw new StudentImportServiceError("stale_plan", "The import sources or plan changed after review.");
  }
}
