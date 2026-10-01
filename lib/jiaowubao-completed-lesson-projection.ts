import type {
  JiaowubaoCompletedLessonRecord,
  JiaowubaoCompletedLessonTeacherRole,
} from "@/lib/jiaowubao-completed-lessons";
import type { JiaowubaoCompletedScheduleRecord } from "@/lib/jiaowubao-completed-schedule";
import type { JiaowubaoHourIssue } from "@/lib/jiaowubao-hour-evidence";
import {
  reconcileJiaowubaoCompletedLessonEvidence,
  type JiaowubaoCompletedLessonMatch,
  type JiaowubaoCompletedLessonReconciliation,
  type JiaowubaoCompletedScheduleEventEvidence,
  type JiaowubaoCompletedScheduleTeacherEvidence,
} from "@/lib/jiaowubao-completed-lesson-reconciliation";
import type { OpsStateRow } from "@/lib/ops-store";
import {
  normalizeStudentImportName,
  studentImportAutomaticJwbNameKey,
  studentImportJwbLatinParentheticalAnnotationKey,
} from "@/lib/student-import";
import {
  jiaowubaoTrialCourseTitleMatchesStudentName,
  jiaowubaoTrialStudentNameFromCourseTitle,
  isJiaowubaoSharedTrialAccountLabel,
} from "@/lib/trial-operations";

type JsonRecord = Record<string, unknown>;
type MatchStrategy = JiaowubaoCompletedLessonMatch;

export type JiaowubaoCompletedLessonProjectionTeacher = Readonly<{
  role: JiaowubaoCompletedLessonTeacherRole;
  sourceTeacherId: string | null;
  sourceTeacherName: string | null;
  teacherId: string | null;
  teacherName: string | null;
  teacherMatch: MatchStrategy;
}>;

export type JiaowubaoCompletedLessonProjectionItem = Readonly<{
  sourceKey: string;
  branchId: string;
  calendarId: string;
  memberId: string;
  memberName: string | null;
  lessonDate: string;
  timeTitle: string | null;
  /** Per-student JWB consumption/attendance evidence; never a teacher allocation. */
  hours: number | null;
  hoursIssue?: JiaowubaoHourIssue | null;
  isTrial: boolean;
  attendanceCode: number | null;
  attendanceTitle: string | null;
  courseTitle: string | null;
  teamTitle: string | null;
  studentId: string | null;
  studentName: string | null;
  displayStudentName: string | null;
  studentMatch: MatchStrategy;
  teachers: readonly JiaowubaoCompletedLessonProjectionTeacher[];
}>;

export type JiaowubaoCompletedLessonTeacherSummary = Readonly<{
  identityKey: string;
  sourceTeacherId: string | null;
  sourceTeacherName: string | null;
  teacherId: string | null;
  teacherName: string | null;
  teacherMatch: MatchStrategy;
  /** Null means one or more lesson events cannot safely establish a teacher total. */
  sourceHours: number | null;
  /** Null means trial/regular classification cannot be safely established for every event. */
  trialSourceHours: number | null;
  sourceLessonCount: number;
  unresolvedLessonCount: number;
  unresolvedTrialLessonCount: number;
  studentLineCount: number;
  missingStudentDisplayNameCount: number;
}>;

export type JiaowubaoCompletedLessonProjection = Readonly<{
  items: readonly JiaowubaoCompletedLessonProjectionItem[];
  scheduleEvents: readonly JiaowubaoCompletedScheduleProjectionEvent[];
  teachers: readonly JiaowubaoCompletedLessonTeacherSummary[];
  teacherEvidenceSourceKeys: ReadonlyMap<string, ReadonlySet<string>>;
  matchedStudentCount: number;
  unmatchedStudentCount: number;
  ambiguousStudentCount: number;
  matchedTeacherCount: number;
  unmatchedTeacherCount: number;
  ambiguousTeacherCount: number;
}>;

export type JiaowubaoCompletedScheduleProjectionTeacher = JiaowubaoCompletedScheduleTeacherEvidence;
export type JiaowubaoCompletedScheduleProjectionEvent = JiaowubaoCompletedScheduleEventEvidence;

function record(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown, maximum = 240) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : null;
}

function id(value: unknown) {
  const raw = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : text(value, 160);
  return raw && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(raw) ? raw : null;
}

function entityRows(rows: readonly OpsStateRow[], entity: string) {
  const payload = rows.find((row) => row.entity === entity)?.payload;
  return Array.isArray(payload) ? payload.map(record).filter((item): item is JsonRecord => item !== null) : [];
}

function nameKeys(value: string | null) {
  if (!value) return [];
  try {
    return [...new Set([
      normalizeStudentImportName(value),
      studentImportAutomaticJwbNameKey(value),
      studentImportJwbLatinParentheticalAnnotationKey(value),
    ].filter(Boolean))];
  } catch {
    return [];
  }
}

function addCandidate(index: Map<string, string[]>, key: string | null, entityId: string) {
  if (!key) return;
  const candidates = index.get(key) ?? [];
  if (!candidates.includes(entityId)) candidates.push(entityId);
  index.set(key, candidates);
}

function uniqueCandidates(index: ReadonlyMap<string, readonly string[]>, keys: readonly string[]) {
  return [...new Set(keys.flatMap((key) => index.get(key) ?? []))];
}

type EntityLookup = Readonly<{
  namesById: ReadonlyMap<string, string>;
  idsBySourceId: ReadonlyMap<string, readonly string[]>;
  idsByNameKey: ReadonlyMap<string, readonly string[]>;
}>;

function sourceIds(item: JsonRecord) {
  const nested = record(item.jiaowubaoOpenApi);
  const historical = record(item.historicalJwbSnapshot);
  const currentAggregate = record(historical?.currentAggregate);
  const retained = record(historical?.retained);
  return [...new Set([
    id(item.jwbSourceRow),
    id(nested?.sourceId),
    id(currentAggregate?.jwbSourceRow),
    id(retained?.jwbSourceRow),
  ].filter((value): value is string => Boolean(value)))];
}

function buildLookup(rows: readonly JsonRecord[]): EntityLookup {
  const namesById = new Map<string, string>();
  const idsBySourceId = new Map<string, string[]>();
  const idsByNameKey = new Map<string, string[]>();
  for (const item of rows) {
    const entityId = id(item.id);
    const name = text(item.name);
    if (!entityId || !name) continue;
    namesById.set(entityId, name);
    sourceIds(item).forEach((sourceId) => addCandidate(idsBySourceId, sourceId, entityId));
    nameKeys(name).forEach((key) => addCandidate(idsByNameKey, key, entityId));
  }
  return Object.freeze({ namesById, idsBySourceId, idsByNameKey });
}

function resolveEntity(input: Readonly<{
  sourceId: string | null;
  sourceName: string | null;
  lookup: EntityLookup;
}>): Readonly<{ id: string | null; name: string | null; match: MatchStrategy }> {
  const sourceCandidates = input.sourceId ? [...new Set(input.lookup.idsBySourceId.get(input.sourceId) ?? [])] : [];
  const byName = uniqueCandidates(input.lookup.idsByNameKey, nameKeys(input.sourceName));
  if (sourceCandidates.length > 1 || byName.length > 1) return Object.freeze({ id: null, name: null, match: "ambiguous" });
  const sourceIdCandidate = sourceCandidates[0] ?? null;
  const nameCandidate = byName[0] ?? null;
  // Never use name evidence to paper over conflicting durable IDs.
  if (sourceIdCandidate && nameCandidate && sourceIdCandidate !== nameCandidate) {
    return Object.freeze({ id: null, name: null, match: "ambiguous" });
  }
  const resolved = sourceIdCandidate ?? nameCandidate;
  if (!resolved) return Object.freeze({ id: null, name: null, match: "unmatched" });
  return Object.freeze({
    id: resolved,
    name: input.lookup.namesById.get(resolved) ?? null,
    match: sourceIdCandidate ? "source_id" : "unique_name",
  });
}

function usesCourseTitleStudentIdentity(recordValue: JiaowubaoCompletedLessonRecord) {
  // A/B/C are shared supplier accounts regardless of the row's lesson type;
  // their member ID can never identify the real learner. When a trial row has
  // no usable supplier title, apply the same fail-closed rule because it may be
  // a malformed shared-account row.
  return isJiaowubaoSharedTrialAccountLabel(recordValue.memberName)
    || (recordValue.isTrial && recordValue.memberName === null);
}

function resolveStudent(recordValue: JiaowubaoCompletedLessonRecord, lookup: EntityLookup) {
  if (usesCourseTitleStudentIdentity(recordValue)) {
    // Shared trial accounts A/B/C never provide a durable student identity.
    // A missing supplier title cannot prove that an otherwise shared account
    // is a normal learner either, so never fall back to its member ID. Match
    // known internal names against the course title instead; the title can
    // include a course/subject suffix after the actual name.
    const candidates = [...lookup.namesById.entries()]
      .filter(([, name]) => jiaowubaoTrialCourseTitleMatchesStudentName(recordValue.courseTitle, name))
      .map(([entityId]) => entityId);
    if (candidates.length !== 1) {
      return Object.freeze({ id: null, name: null, match: candidates.length > 1 ? "ambiguous" : "unmatched" as MatchStrategy });
    }
    const resolved = candidates[0]!;
    return Object.freeze({
      id: resolved,
      name: lookup.namesById.get(resolved) ?? null,
      match: "trial_course_title" as const,
    });
  }
  return resolveEntity({ sourceId: recordValue.memberId, sourceName: recordValue.memberName, lookup });
}

export function projectJiaowubaoCompletedLessonRecords(input: Readonly<{
  records: readonly JiaowubaoCompletedLessonRecord[];
  scheduleRecords?: readonly JiaowubaoCompletedScheduleRecord[];
  stateRows: readonly OpsStateRow[];
}>): JiaowubaoCompletedLessonProjection {
  const studentLookup = buildLookup(entityRows(input.stateRows, "students"));
  const teacherLookup = buildLookup(entityRows(input.stateRows, "teachers"));
  const items = input.records.map((recordValue) => {
    const student = resolveStudent(recordValue, studentLookup);
    const courseTitleTrialIdentity = usesCourseTitleStudentIdentity(recordValue);
    // Historical exports must still show the actual source-backed learner
    // after an internal record is archived or when a one-off trial never
    // became a student record. The display name is not an identity link.
    const displayStudentName = student.name
      ?? (courseTitleTrialIdentity
        ? jiaowubaoTrialStudentNameFromCourseTitle(recordValue.courseTitle) ?? null
        : recordValue.memberName);
    const teachers = Object.freeze(recordValue.teachers.map((sourceTeacher) => {
      const teacher = resolveEntity({ sourceId: sourceTeacher.id, sourceName: sourceTeacher.name, lookup: teacherLookup });
      return Object.freeze({
        role: sourceTeacher.role,
        sourceTeacherId: sourceTeacher.id,
        sourceTeacherName: sourceTeacher.name,
        teacherId: teacher.id,
        teacherName: teacher.name,
        teacherMatch: teacher.match,
      });
    }));
    return Object.freeze({
      sourceKey: recordValue.sourceKey,
      branchId: recordValue.branchId,
      calendarId: recordValue.calendarId,
      memberId: recordValue.memberId,
      memberName: recordValue.memberName,
      lessonDate: recordValue.lessonDate,
      timeTitle: recordValue.timeTitle,
      hours: recordValue.hours,
      ...(recordValue.hoursIssue ? { hoursIssue: recordValue.hoursIssue } : {}),
      isTrial: recordValue.isTrial,
      attendanceCode: recordValue.attendanceCode,
      attendanceTitle: recordValue.attendanceTitle,
      courseTitle: recordValue.courseTitle,
      teamTitle: recordValue.teamTitle,
      studentId: student.id,
      studentName: student.name,
      displayStudentName,
      studentMatch: student.match,
      teachers,
    });
  });
  const scheduleEvents = Object.freeze((input.scheduleRecords ?? []).map((recordValue) => Object.freeze({
    sourceKey: recordValue.sourceKey,
    calendarId: recordValue.calendarId,
    lessonDate: recordValue.lessonDate,
    timeTitle: recordValue.timeTitle,
    courseTitle: recordValue.courseTitle,
    teamTitle: recordValue.teamTitle,
    teachers: Object.freeze(recordValue.teachers.map((sourceTeacher) => {
      const teacher = resolveEntity({ sourceId: sourceTeacher.id, sourceName: sourceTeacher.name, lookup: teacherLookup });
      return Object.freeze({
        role: sourceTeacher.role,
        sourceTeacherId: sourceTeacher.id,
        sourceTeacherName: sourceTeacher.name,
        sourceTeacherHours: sourceTeacher.hours,
        ...(sourceTeacher.hoursIssue ? { sourceTeacherHoursIssue: sourceTeacher.hoursIssue } : {}),
        teacherId: teacher.id,
        teacherName: teacher.name,
        teacherMatch: teacher.match,
      });
    })),
  } satisfies JiaowubaoCompletedScheduleProjectionEvent)));
  const reconciliation: JiaowubaoCompletedLessonReconciliation = reconcileJiaowubaoCompletedLessonEvidence(items, scheduleEvents);
  const counts = (value: MatchStrategy) => items.filter((item) => item.studentMatch === value).length;
  return Object.freeze({
    items: Object.freeze(items),
    scheduleEvents,
    teachers: reconciliation.teachers,
    teacherEvidenceSourceKeys: reconciliation.teacherStudentSourceKeys,
    matchedStudentCount: counts("source_id") + counts("unique_name") + counts("trial_course_title"),
    unmatchedStudentCount: counts("unmatched"),
    ambiguousStudentCount: counts("ambiguous"),
    matchedTeacherCount: reconciliation.matchedTeacherCount,
    unmatchedTeacherCount: reconciliation.unmatchedTeacherCount,
    ambiguousTeacherCount: reconciliation.ambiguousTeacherCount,
  });
}
