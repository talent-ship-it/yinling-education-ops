import type { StudentExamRecord } from "./student-records";

export const MANAGED_EXAM_AUTHORITY_ENTITIES = ["students", "tasks"] as const;
export type ManagedExamAuthorityEntity = (typeof MANAGED_EXAM_AUTHORITY_ENTITIES)[number];

/** The complete cross-owner student surface exposed to an assigned staff user. */
export type ManagedExamStudentProjection = Readonly<{
  id: string;
  name: string;
  initials: string;
  owner: string;
  exams: readonly StudentExamRecord[];
}>;

/**
 * The versions and projection are one envelope derived from one ops_state read.
 * Keeping them together prevents a later task snapshot from being paired with
 * student details authorized by an earlier assignment snapshot.
 */
export type ManagedExamProjectionSnapshot = Readonly<{
  versions: Readonly<Record<ManagedExamAuthorityEntity, number>>;
  students: readonly ManagedExamStudentProjection[];
}>;

type RecordValue = Record<string, unknown>;

const EXAM_FIELDS = new Set([
  "id",
  "subject",
  "examType",
  "examVariant",
  "examMonth",
  "examDate",
  "resultDateOverride",
  "includeRecall",
  "followUpState",
]);
const FOLLOW_UP_KINDS = new Set([
  "exam_care",
  "exam_recall",
  "exam_month_planning",
  "exam_results_follow_up",
]);
const FOLLOW_UP_FIELDS = new Set(["status", "completedAt", "completedBy"]);

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: RecordValue, allowed: ReadonlySet<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function validFollowUpState(value: unknown) {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, FOLLOW_UP_KINDS)) return false;
  return Object.entries(value).every(([, step]) => {
    if (!isRecord(step) || !hasOnlyKeys(step, FOLLOW_UP_FIELDS)) return false;
    if (step.status !== "pending" && step.status !== "completed" && step.status !== "not_required") return false;
    if (!optionalString(step.completedAt) || !optionalString(step.completedBy)) return false;
    return step.status === "completed" ? typeof step.completedAt === "string" : step.completedAt === undefined;
  });
}

/**
 * Whitelists the structured exam fields required by the exam workspace. Any
 * old or unexpected student/exam property is excluded from the cross-owner
 * projection instead of becoming an accidental PII side channel.
 */
export function projectManagedExamRecord(value: unknown): StudentExamRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()
    || typeof value.subject !== "string"
    || typeof value.examType !== "string"
    || typeof value.examMonth !== "string"
    || !optionalString(value.examVariant)
    || !optionalString(value.examDate)
    || !optionalString(value.resultDateOverride)
    || (value.includeRecall !== undefined && typeof value.includeRecall !== "boolean")
    || !validFollowUpState(value.followUpState)) return null;

  return {
    id: value.id,
    subject: value.subject,
    examType: value.examType as StudentExamRecord["examType"],
    examMonth: value.examMonth,
    ...(typeof value.examVariant === "string" ? { examVariant: value.examVariant as StudentExamRecord["examVariant"] } : {}),
    ...(typeof value.examDate === "string" ? { examDate: value.examDate } : {}),
    ...(typeof value.resultDateOverride === "string" ? { resultDateOverride: value.resultDateOverride } : {}),
    ...(typeof value.includeRecall === "boolean" ? { includeRecall: value.includeRecall } : {}),
    ...(value.followUpState !== undefined ? { followUpState: value.followUpState as StudentExamRecord["followUpState"] } : {}),
  };
}

function parseVersion(value: unknown, field: ManagedExamAuthorityEntity) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`managed exam ${field} version is invalid`);
  }
  return value as number;
}

/**
 * Extracts the two authority versions from either the lightweight versions
 * response or the full state response. Missing and duplicate rows are unsafe:
 * retaining an older cross-owner projection in either case would fail open.
 */
export function parseManagedExamAuthorityVersions(value: unknown) {
  if (!Array.isArray(value)) throw new TypeError("managed exam authority rows are invalid");
  return Object.fromEntries(MANAGED_EXAM_AUTHORITY_ENTITIES.map((entity) => {
    const matches = value.filter((candidate) => isRecord(candidate) && candidate.entity === entity);
    if (matches.length !== 1) throw new TypeError(`managed exam ${entity} authority row is missing or duplicated`);
    return [entity, parseVersion(matches[0].version, entity)];
  })) as Record<ManagedExamAuthorityEntity, number>;
}

function parseStudent(value: unknown): ManagedExamStudentProjection {
  if (!isRecord(value)
    || !hasOnlyKeys(value, new Set(["id", "name", "initials", "owner", "exams"]))
    || typeof value.id !== "string" || !value.id.trim()
    || typeof value.name !== "string"
    || typeof value.initials !== "string"
    || typeof value.owner !== "string"
    || !Array.isArray(value.exams)) {
    throw new TypeError("managed exam student projection is invalid");
  }
  if (value.exams.some((exam) => !isRecord(exam) || !hasOnlyKeys(exam, EXAM_FIELDS))) {
    throw new TypeError("managed exam record projection contains unexpected fields");
  }
  const exams = value.exams.map(projectManagedExamRecord);
  if (exams.some((exam) => exam === null)) throw new TypeError("managed exam record projection is invalid");
  const examIds = exams.map((exam) => exam!.id);
  if (new Set(examIds).size !== examIds.length) throw new TypeError("managed exam projection contains duplicate exams");
  return {
    id: value.id,
    name: value.name,
    initials: value.initials,
    owner: value.owner,
    exams: exams as StudentExamRecord[],
  };
}

/**
 * Parses a server envelope and binds it to the exact authority row versions in
 * the same response. A missing row, extra PII field, or mixed snapshot fails
 * closed before any shared row is applied by the caller.
 */
export function parseManagedExamProjectionSnapshot(
  value: unknown,
  authorityVersions: Readonly<Partial<Record<ManagedExamAuthorityEntity, unknown>>>,
): ManagedExamProjectionSnapshot {
  if (!isRecord(value)
    || !hasOnlyKeys(value, new Set(["versions", "students"]))
    || !isRecord(value.versions)
    || !hasOnlyKeys(value.versions, new Set(MANAGED_EXAM_AUTHORITY_ENTITIES))
    || !Array.isArray(value.students)) {
    throw new TypeError("managed exam snapshot is invalid");
  }
  const versions = {
    students: parseVersion(value.versions.students, "students"),
    tasks: parseVersion(value.versions.tasks, "tasks"),
  };
  for (const entity of MANAGED_EXAM_AUTHORITY_ENTITIES) {
    if (versions[entity] !== parseVersion(authorityVersions[entity], entity)) {
      throw new TypeError("managed exam snapshot versions do not match response rows");
    }
  }
  const students = value.students.map(parseStudent);
  if (new Set(students.map((student) => student.id)).size !== students.length) {
    throw new TypeError("managed exam projection contains duplicate students");
  }
  return { versions, students };
}

export function managedExamSnapshotIsCurrent(
  snapshot: ManagedExamProjectionSnapshot,
  versions: Readonly<Record<ManagedExamAuthorityEntity, number>>,
) {
  return MANAGED_EXAM_AUTHORITY_ENTITIES.every((entity) => snapshot.versions[entity] === versions[entity]);
}

export function managedExamSnapshotCanReplace(
  snapshot: ManagedExamProjectionSnapshot,
  currentVersions: Readonly<Record<ManagedExamAuthorityEntity, number>>,
) {
  return MANAGED_EXAM_AUTHORITY_ENTITIES.every((entity) => snapshot.versions[entity] >= currentVersions[entity]);
}
