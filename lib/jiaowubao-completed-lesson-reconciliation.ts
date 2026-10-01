/**
 * Browser-safe reconciliation of JiaoWuBao's two completed-month feeds.
 *
 * Learner rows come from query_lesson_list; one schedule event contributes a
 * role-specific teacher credit from query_schedule_list. This module never
 * derives a teacher credit from participant `hours`.
 */

import { isJiaowubaoCompletedLessonUnknownBranchId } from "@/lib/jiaowubao-completed-lesson-branch";
import type { JiaowubaoHourIssue } from "@/lib/jiaowubao-hour-evidence";

export type JiaowubaoCompletedLessonMatch =
  | "source_id"
  | "unique_name"
  | "trial_course_title"
  | "unmatched"
  | "ambiguous";

export type JiaowubaoCompletedLessonTeacherRole = "primary" | "assistant" | "third";

export type JiaowubaoCompletedLessonTeacherLink = Readonly<{
  role: JiaowubaoCompletedLessonTeacherRole;
  sourceTeacherId: string | null;
  sourceTeacherName: string | null;
  teacherId: string | null;
  teacherName: string | null;
  teacherMatch: JiaowubaoCompletedLessonMatch;
}>;

export type JiaowubaoCompletedLessonStudentEvidence = Readonly<{
  sourceKey: string;
  branchId: string;
  calendarId: string;
  memberId: string;
  memberName: string | null;
  lessonDate: string;
  timeTitle: string | null;
  hours: number | null;
  hoursIssue?: JiaowubaoHourIssue | null;
  isTrial: boolean;
  attendanceCode: number | null;
  attendanceTitle: string | null;
  courseTitle: string | null;
  teamTitle: string | null;
  studentId: string | null;
  studentName: string | null;
  /** Best source-backed name for reports, even when no internal ID is safe. */
  displayStudentName: string | null;
  studentMatch: JiaowubaoCompletedLessonMatch;
  teachers: readonly JiaowubaoCompletedLessonTeacherLink[];
}>;

export type JiaowubaoCompletedScheduleTeacherEvidence = JiaowubaoCompletedLessonTeacherLink & Readonly<{
  sourceTeacherHours: number | null;
  sourceTeacherHoursIssue?: JiaowubaoHourIssue | null;
}>;

export type JiaowubaoCompletedScheduleEventEvidence = Readonly<{
  sourceKey: string;
  calendarId: string;
  lessonDate: string;
  timeTitle: string | null;
  courseTitle: string | null;
  teamTitle: string | null;
  teachers: readonly JiaowubaoCompletedScheduleTeacherEvidence[];
}>;

export type JiaowubaoCompletedLessonTeacherSummary = Readonly<{
  /** Stable only within the immutable source revision; used for evidence rows. */
  identityKey: string;
  sourceTeacherId: string | null;
  sourceTeacherName: string | null;
  teacherId: string | null;
  teacherName: string | null;
  teacherMatch: JiaowubaoCompletedLessonMatch;
  /** Sum of documented schedule role-hours, or null if a credit omits hours. */
  sourceHours: number | null;
  /** Null means some credited event cannot safely be classified as trial/normal. */
  trialSourceHours: number | null;
  /** Number of source events represented for this teacher (not student rows). */
  sourceLessonCount: number;
  /** Missing / ambiguous / conflicting source join or teacher-hour evidence. */
  unresolvedLessonCount: number;
  /** Events whose trial classification is unavailable or unsafe. */
  unresolvedTrialLessonCount: number;
  /** Event-expanded learner detail count for the Excel evidence section. */
  studentLineCount: number;
  /** Learner rows with neither a source name nor a safely parsed trial title. */
  missingStudentDisplayNameCount: number;
}>;

export type JiaowubaoCompletedLessonReconciliation = Readonly<{
  teachers: readonly JiaowubaoCompletedLessonTeacherSummary[];
  teacherStudentSourceKeys: ReadonlyMap<string, ReadonlySet<string>>;
  matchedTeacherCount: number;
  unmatchedTeacherCount: number;
  ambiguousTeacherCount: number;
}>;

type EventStatus = "reconciled" | "schedule_missing" | "branch_ambiguous" | "source_conflict" | "schedule_only";

type EventPlan = Readonly<{
  status: EventStatus;
  members: readonly JiaowubaoCompletedLessonStudentEvidence[];
  teachers: readonly JiaowubaoCompletedScheduleTeacherEvidence[];
  isTrial: boolean | null;
}>;

function nameKey(value: string | null) {
  return value
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-AU")
    : "";
}

export function jiaowubaoCompletedLessonTeacherIdentityKey(input: Readonly<{
  role: JiaowubaoCompletedLessonTeacherRole;
  sourceTeacherId: string | null;
  sourceTeacherName: string | null;
  teacherId: string | null;
}>) {
  if (input.teacherId) return `internal:${input.teacherId}`;
  if (input.sourceTeacherId) return `source:${input.sourceTeacherId}`;
  const name = nameKey(input.sourceTeacherName);
  return name ? `name:${input.role}:${name}` : `unassigned:${input.role}`;
}

function eventKey(item: Pick<JiaowubaoCompletedLessonStudentEvidence, "branchId" | "calendarId">) {
  return `${item.branchId}\u0000${item.calendarId}`;
}

function sameNullableText(expected: string | null, values: readonly (string | null)[]) {
  if (expected === null) return true;
  return values.every((value) => value === null || value === expected);
}

function sameTeacher(left: JiaowubaoCompletedLessonTeacherLink, right: JiaowubaoCompletedLessonTeacherLink) {
  if (left.role !== right.role) return false;
  if (left.sourceTeacherId !== null || right.sourceTeacherId !== null) {
    if (left.sourceTeacherId !== right.sourceTeacherId) return false;
  }
  if (left.sourceTeacherName !== null || right.sourceTeacherName !== null) {
    if (nameKey(left.sourceTeacherName) !== nameKey(right.sourceTeacherName)) return false;
  }
  return true;
}

function hasDuplicateSourceTeacherRoleIdentity(teachers: readonly JiaowubaoCompletedScheduleTeacherEvidence[]) {
  const ids = new Set<string>();
  for (const teacher of teachers) {
    if (!teacher.sourceTeacherId) continue;
    if (ids.has(teacher.sourceTeacherId)) return true;
    ids.add(teacher.sourceTeacherId);
  }
  return false;
}

function scheduleMatchesGroup(
  schedule: JiaowubaoCompletedScheduleEventEvidence,
  members: readonly JiaowubaoCompletedLessonStudentEvidence[],
) {
  if (!members.length || hasDuplicateSourceTeacherRoleIdentity(schedule.teachers)) return false;
  if (!sameNullableText(schedule.lessonDate, members.map((member) => member.lessonDate))) return false;
  if (!sameNullableText(schedule.timeTitle, members.map((member) => member.timeTitle))) return false;
  if (!sameNullableText(schedule.courseTitle, members.map((member) => member.courseTitle))) return false;
  if (!sameNullableText(schedule.teamTitle, members.map((member) => member.teamTitle))) return false;
  for (const member of members) {
    // A source must agree in both directions. Checking only lesson roles
    // would let an extra assistant/third schedule credit escape reconciliation
    // when the participant feed omitted that role.
    if (member.teachers.length !== schedule.teachers.length) return false;
    for (const scheduleTeacher of schedule.teachers) {
      const lessonTeacher = member.teachers.find((candidate) => candidate.role === scheduleTeacher.role);
      if (!lessonTeacher || !sameTeacher(lessonTeacher, scheduleTeacher)) return false;
    }
  }
  return true;
}

function allSameTrial(members: readonly JiaowubaoCompletedLessonStudentEvidence[]) {
  if (!members.length) return null;
  return members.every((member) => member.isTrial === members[0]!.isTrial)
    ? members[0]!.isTrial
    : null;
}

function scheduleEventPlan(input: Readonly<{
  status: EventStatus;
  members: readonly JiaowubaoCompletedLessonStudentEvidence[];
  schedule: JiaowubaoCompletedScheduleEventEvidence;
}>) {
  return Object.freeze({
    status: input.status,
    members: input.members,
    teachers: input.schedule.teachers,
    isTrial: input.status === "reconciled" ? allSameTrial(input.members) : null,
  } satisfies EventPlan);
}

function lessonOnlyPlan(status: Extract<EventStatus, "schedule_missing" | "branch_ambiguous" | "source_conflict">, members: readonly JiaowubaoCompletedLessonStudentEvidence[]) {
  const byIdentity = new Map<string, JiaowubaoCompletedScheduleTeacherEvidence>();
  for (const member of members) {
    for (const teacher of member.teachers) {
      const key = jiaowubaoCompletedLessonTeacherIdentityKey(teacher);
      byIdentity.set(key, Object.freeze({ ...teacher, sourceTeacherHours: null }));
    }
  }
  return Object.freeze({ status, members, teachers: Object.freeze([...byIdentity.values()]), isTrial: null } satisfies EventPlan);
}

function plannedEvents(
  items: readonly JiaowubaoCompletedLessonStudentEvidence[],
  schedules: readonly JiaowubaoCompletedScheduleEventEvidence[],
) {
  const lessonGroups = new Map<string, JiaowubaoCompletedLessonStudentEvidence[]>();
  const branchesByCalendar = new Map<string, Set<string>>();
  for (const item of items) {
    const key = eventKey(item);
    lessonGroups.set(key, [...(lessonGroups.get(key) ?? []), item]);
    const branches = branchesByCalendar.get(item.calendarId) ?? new Set<string>();
    branches.add(item.branchId);
    branchesByCalendar.set(item.calendarId, branches);
  }
  const schedulesByCalendar = new Map<string, JiaowubaoCompletedScheduleEventEvidence[]>();
  for (const schedule of schedules) {
    schedulesByCalendar.set(schedule.calendarId, [...(schedulesByCalendar.get(schedule.calendarId) ?? []), schedule]);
  }

  const plans: EventPlan[] = [];
  for (const members of lessonGroups.values()) {
    const sample = members[0]!;
    const sourceSchedules = schedulesByCalendar.get(sample.calendarId) ?? [];
    const branchCount = branchesByCalendar.get(sample.calendarId)?.size ?? 0;
    if (isJiaowubaoCompletedLessonUnknownBranchId(sample.branchId)) {
      // Some historical query_lesson_list rows omit branch_id entirely. Keep
      // their learner evidence, but never let a synthetic branch marker prove
      // a join to the branch-less schedule feed or create payable hours.
      plans.push(lessonOnlyPlan("branch_ambiguous", members));
    } else if (sourceSchedules.length === 0) {
      plans.push(lessonOnlyPlan("schedule_missing", members));
    } else if (sourceSchedules.length !== 1 || branchCount !== 1) {
      plans.push(lessonOnlyPlan("branch_ambiguous", members));
    } else if (!scheduleMatchesGroup(sourceSchedules[0]!, members)) {
      plans.push(lessonOnlyPlan("source_conflict", members));
      // Preserve the role-credit source as a separate unresolved event below.
    } else {
      plans.push(scheduleEventPlan({ status: "reconciled", members, schedule: sourceSchedules[0]! }));
    }
  }
  for (const schedule of schedules) {
    const groups = [...lessonGroups.values()].filter((members) => members[0]?.calendarId === schedule.calendarId);
    const matched = groups.length === 1
      && !isJiaowubaoCompletedLessonUnknownBranchId(groups[0]![0]!.branchId)
      && (branchesByCalendar.get(schedule.calendarId)?.size ?? 0) === 1
      && scheduleMatchesGroup(schedule, groups[0]!);
    if (!matched) plans.push(scheduleEventPlan({ status: "schedule_only", members: [], schedule }));
  }
  return Object.freeze(plans);
}

type SummaryAccumulator = {
  identityKey: string;
  sourceTeacherId: string | null;
  sourceTeacherName: string | null;
  teacherId: string | null;
  teacherName: string | null;
  teacherMatch: JiaowubaoCompletedLessonMatch;
  sourceHours: number;
  trialSourceHours: number;
  sourceLessonCount: number;
  unresolvedLessonCount: number;
  unresolvedTrialLessonCount: number;
  missingHours: boolean;
  missingTrialHours: boolean;
  studentSourceKeys: Set<string>;
};

function accumulatorFor(teacher: JiaowubaoCompletedScheduleTeacherEvidence) {
  return {
    identityKey: jiaowubaoCompletedLessonTeacherIdentityKey(teacher),
    sourceTeacherId: teacher.sourceTeacherId,
    sourceTeacherName: teacher.sourceTeacherName,
    teacherId: teacher.teacherId,
    teacherName: teacher.teacherName,
    teacherMatch: teacher.teacherMatch,
    sourceHours: 0,
    trialSourceHours: 0,
    sourceLessonCount: 0,
    unresolvedLessonCount: 0,
    unresolvedTrialLessonCount: 0,
    missingHours: false,
    missingTrialHours: false,
    studentSourceKeys: new Set<string>(),
  } satisfies SummaryAccumulator;
}

/**
 * Creates payroll-safe role totals and event-expanded learner line keys. A
 * total may be visible as a source fact while still being excluded from
 * automatic payment when the cross-source reconciliation is incomplete.
 */
export function reconcileJiaowubaoCompletedLessonEvidence(
  items: readonly JiaowubaoCompletedLessonStudentEvidence[],
  schedules: readonly JiaowubaoCompletedScheduleEventEvidence[],
): JiaowubaoCompletedLessonReconciliation {
  const summaries = new Map<string, SummaryAccumulator>();
  const assignmentCounts = { matched: 0, unmatched: 0, ambiguous: 0 };
  for (const plan of plannedEvents(items, schedules)) {
    const teachers = plan.teachers.length ? plan.teachers : [Object.freeze({
      role: "primary" as const,
      sourceTeacherId: null,
      sourceTeacherName: null,
      sourceTeacherHours: null,
      sourceTeacherHoursIssue: null,
      teacherId: null,
      teacherName: null,
      teacherMatch: "unmatched" as const,
    })];
    for (const teacher of teachers) {
      if (teacher.teacherMatch === "source_id" || teacher.teacherMatch === "unique_name") assignmentCounts.matched += 1;
      if (teacher.teacherMatch === "unmatched") assignmentCounts.unmatched += 1;
      if (teacher.teacherMatch === "ambiguous") assignmentCounts.ambiguous += 1;
      const key = jiaowubaoCompletedLessonTeacherIdentityKey(teacher);
      const summary = summaries.get(key) ?? accumulatorFor(teacher);
      summary.sourceLessonCount += 1;
      plan.members.forEach((member) => summary.studentSourceKeys.add(member.sourceKey));
      if (teacher.sourceTeacherHoursIssue) summary.unresolvedLessonCount += 1;
      if (teacher.sourceTeacherHours === null) {
        summary.missingHours = true;
        summary.unresolvedLessonCount += 1;
      } else {
        const total = summary.sourceHours + teacher.sourceTeacherHours;
        if (!Number.isFinite(total)) {
          summary.missingHours = true;
          summary.unresolvedLessonCount += 1;
        } else {
          summary.sourceHours = Number(total.toFixed(4));
        }
      }
      if (plan.status !== "reconciled") {
        summary.unresolvedLessonCount += 1;
        summary.unresolvedTrialLessonCount += 1;
        summary.missingTrialHours = true;
      } else {
        if (plan.members.some((member) => member.hoursIssue)) summary.unresolvedLessonCount += 1;
        if (plan.isTrial === null || teacher.sourceTeacherHours === null) {
          summary.unresolvedTrialLessonCount += 1;
          summary.missingTrialHours = true;
        } else if (plan.isTrial) {
          if (teacher.sourceTeacherHoursIssue) summary.unresolvedTrialLessonCount += 1;
          const trialTotal = summary.trialSourceHours + teacher.sourceTeacherHours;
          if (!Number.isFinite(trialTotal)) {
            summary.unresolvedTrialLessonCount += 1;
            summary.missingTrialHours = true;
          }
          else summary.trialSourceHours = Number(trialTotal.toFixed(4));
        } else if (teacher.sourceTeacherHoursIssue) {
          summary.unresolvedTrialLessonCount += 1;
        }
      }
      summaries.set(key, summary);
    }
  }
  const teacherStudentSourceKeys = new Map<string, ReadonlySet<string>>();
  const studentsBySourceKey = new Map(items.map((item) => [item.sourceKey, item]));
  const teachers = [...summaries.values()].map((summary) => {
    teacherStudentSourceKeys.set(summary.identityKey, new Set(summary.studentSourceKeys));
    return Object.freeze({
      identityKey: summary.identityKey,
      sourceTeacherId: summary.sourceTeacherId,
      sourceTeacherName: summary.sourceTeacherName,
      teacherId: summary.teacherId,
      teacherName: summary.teacherName,
      teacherMatch: summary.teacherMatch,
      sourceHours: summary.missingHours ? null : summary.sourceHours,
      trialSourceHours: summary.missingHours || summary.missingTrialHours ? null : summary.trialSourceHours,
      sourceLessonCount: summary.sourceLessonCount,
      unresolvedLessonCount: summary.unresolvedLessonCount,
      unresolvedTrialLessonCount: summary.unresolvedTrialLessonCount,
      studentLineCount: summary.studentSourceKeys.size,
      missingStudentDisplayNameCount: [...summary.studentSourceKeys].filter((sourceKey) => {
        const student = studentsBySourceKey.get(sourceKey);
        return !student?.displayStudentName;
      }).length,
    });
  }).sort((left, right) => (
    (left.teacherName ?? left.sourceTeacherName ?? "未匹配老师").localeCompare(
      right.teacherName ?? right.sourceTeacherName ?? "未匹配老师",
    )
  ));
  return Object.freeze({
    teachers: Object.freeze(teachers),
    teacherStudentSourceKeys,
    matchedTeacherCount: assignmentCounts.matched,
    unmatchedTeacherCount: assignmentCounts.unmatched,
    ambiguousTeacherCount: assignmentCounts.ambiguous,
  });
}
