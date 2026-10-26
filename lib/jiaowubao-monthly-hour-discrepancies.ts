import { scheduleMatchesGroup, type JiaowubaoCompletedScheduleTeacherEvidence } from "./jiaowubao-completed-lesson-reconciliation";
import type { JiaowubaoCompletedLessonProjection, JiaowubaoCompletedLessonProjectionItem } from "./jiaowubao-completed-lesson-projection";
import { isJiaowubaoCompletedLessonUnknownBranchId } from "./jiaowubao-completed-lesson-branch";
import { resolveAssignableOperationsOwner } from "./demo-users";
import type { OpsStateRow } from "./ops-store";

export type MonthlyHourDiscrepancyScope = Readonly<{ studentIds: ReadonlySet<string>; includeUnmatched: boolean }>;
export type MonthlyHourDiscrepancy = Readonly<{
  id: string;
  lessonDate: string;
  timeTitle: string | null;
  courseTitle: string | null;
  students: readonly Readonly<{ id: string | null; name: string }>[];
  teacher: string;
  teacherRole: "primary" | "assistant" | "third";
  teacherHours: number | null;
  studentHours: number | null;
  difference: number | null;
  sourceMatch: "matched" | "candidate" | "unlinked";
  operationsOwners: readonly string[];
  ownerUnmatched: boolean;
  status: "待核查";
  reason: string;
}>;

type Member = JiaowubaoCompletedLessonProjectionItem;
type Schedule = JiaowubaoCompletedLessonProjection["scheduleEvents"][number];
type Teacher = JiaowubaoCompletedScheduleTeacherEvidence;
type Owners = ReadonlyMap<string, string | null>;

type LessonGroup = Readonly<{ members: readonly Member[]; schedules: readonly Schedule[]; branchCount: number }>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ownersByStudent(rows: readonly OpsStateRow[]): Owners {
  const payload = rows.find((row) => row.entity === "students")?.payload;
  const owners = new Map<string, string | null>();
  if (!Array.isArray(payload)) return owners;
  for (const item of payload.filter(record)) {
    if (typeof item.id !== "string") continue;
    const owner = resolveAssignableOperationsOwner(item.owner);
    owners.set(item.id, owners.has(item.id) ? null : owner);
  }
  return owners;
}

function groupedLessons(projection: JiaowubaoCompletedLessonProjection): LessonGroup[] {
  const groups = new Map<string, Member[]>();
  const branches = new Map<string, Set<string>>();
  const schedules = new Map<string, Schedule[]>();
  for (const member of projection.items) {
    const key = `${member.branchId}\u0000${member.calendarId}`;
    groups.set(key, [...groups.get(key) ?? [], member]);
    const values = branches.get(member.calendarId) ?? new Set<string>();
    values.add(member.branchId);
    branches.set(member.calendarId, values);
  }
  for (const schedule of projection.scheduleEvents) {
    schedules.set(schedule.calendarId, [...schedules.get(schedule.calendarId) ?? [], schedule]);
  }
  return [...groups.values()].map((members) => ({ members, schedules: schedules.get(members[0]!.calendarId) ?? [], branchCount: branches.get(members[0]!.calendarId)!.size }));
}

function groupVisible(members: readonly Member[], scope: MonthlyHourDiscrepancyScope, owners: Owners) {
  if (!members.length) return scope.includeUnmatched;
  return members.every((member) => {
    if (!member.studentId) return scope.includeUnmatched;
    if (!scope.studentIds.has(member.studentId)) return false;
    return scope.includeUnmatched || Boolean(owners.get(member.studentId));
  });
}

function joinProblem(group: LessonGroup): string | null {
  if (group.branchCount !== 1 || isJiaowubaoCompletedLessonUnknownBranchId(group.members[0]!.branchId)) return "分校来源不明确";
  if (group.schedules.length === 0) return "缺少教师课时来源";
  if (group.schedules.length !== 1 || !scheduleMatchesGroup(group.schedules[0]!, group.members)) return "课节来源冲突";
  return null;
}

function candidateSchedule(group: LessonGroup): Schedule | null {
  if (group.branchCount !== 1 || !isJiaowubaoCompletedLessonUnknownBranchId(group.members[0]!.branchId) || group.schedules.length !== 1) return null;
  const schedule = group.schedules[0]!;
  if (!schedule.timeTitle || (!schedule.courseTitle && !schedule.teamTitle) || !schedule.teachers.length) return null;
  const complete = group.members.every((member) => member.lessonDate === schedule.lessonDate
    && member.timeTitle === schedule.timeTitle && member.courseTitle === schedule.courseTitle && member.teamTitle === schedule.teamTitle);
  return complete && scheduleMatchesGroup(schedule, group.members) ? schedule : null;
}

function unverifiedTeachers(members: readonly Member[]): Teacher[] {
  const teachers = new Map<string, Teacher>();
  for (const member of members) {
    for (const teacher of member.teachers) {
      const key = `${teacher.role}\u0000${teacher.sourceTeacherId}\u0000${teacher.sourceTeacherName}`;
      teachers.set(key, { ...teacher, sourceTeacherHours: null });
    }
  }
  if (!teachers.size) teachers.set("unknown", { role: "primary", sourceTeacherId: null, sourceTeacherName: null, teacherId: null, teacherName: null, teacherMatch: "unmatched", sourceTeacherHours: null });
  return [...teachers.values()];
}

function studentHours(members: readonly Member[]) {
  if (!members.length || members.some((member) => member.hours === null || member.hoursIssue)) return null;
  return members.reduce((total, member) => total + Math.round(member.hours! * 10_000), 0) / 10_000;
}

function ownersFor(members: readonly Member[], owners: Owners) {
  const values = members.map((member) => member.studentId ? owners.get(member.studentId) : null);
  return { operationsOwners: [...new Set(values.filter((owner): owner is string => Boolean(owner)))].sort(), ownerUnmatched: !values.length || values.some((owner) => !owner) };
}

function differenceReason(teacher: Teacher, hours: number | null, problem: string | null) {
  if (problem) return problem;
  if (teacher.sourceTeacherHoursIssue) return "教师课时异常";
  if (teacher.sourceTeacherHours === null) return "教师课时缺失";
  if (hours === null) return "学生课时缺失或异常";
  return "课时不等";
}

function discrepancyRows(input: Readonly<{ members: readonly Member[]; teachers: readonly Teacher[]; sample: Pick<Schedule, "lessonDate" | "timeTitle" | "courseTitle">; id: string; problem: string | null; owners: Owners; candidate?: boolean }>): MonthlyHourDiscrepancy[] {
  const hours = studentHours(input.members);
  return input.teachers.flatMap((teacher, index) => {
    const comparable = !input.problem && !teacher.sourceTeacherHoursIssue && teacher.sourceTeacherHours !== null && hours !== null;
    const difference = comparable ? (Math.round(teacher.sourceTeacherHours! * 10_000) - Math.round(hours! * 10_000)) / 10_000 : null;
    if (difference === 0) return [];
    return [{
      id: `${input.id}:${teacher.role}:${index}`,
      lessonDate: input.sample.lessonDate,
      timeTitle: input.sample.timeTitle,
      courseTitle: input.sample.courseTitle,
      students: input.members.map((member) => ({ id: member.studentId, name: member.displayStudentName ?? member.memberName ?? "未匹配学生" })),
      teacher: teacher.teacherName ?? teacher.sourceTeacherName ?? "未匹配老师",
      teacherRole: teacher.role,
      teacherHours: teacher.sourceTeacherHours,
      studentHours: hours,
      difference,
      sourceMatch: input.candidate ? "candidate" as const : input.problem ? "unlinked" as const : "matched" as const,
      ...ownersFor(input.members, input.owners),
      status: "待核查" as const,
      reason: differenceReason(teacher, hours, input.problem),
    }];
  });
}

function groupDiscrepancies(group: LessonGroup, owners: Owners, candidate: Schedule | null) {
  const problem = joinProblem(group);
  const sample = group.members[0]!;
  if (candidate) return discrepancyRows({ members: group.members, teachers: candidate.teachers, sample, id: sample.sourceKey, problem: "分校来源待确认（候选对照）", owners, candidate: true });
  const matchedTeachers = problem ? [] : group.schedules[0]!.teachers;
  const teachers = matchedTeachers.length ? matchedTeachers : unverifiedTeachers(group.members);
  return discrepancyRows({ members: group.members, teachers, sample, id: sample.sourceKey, problem, owners });
}

export function monthlyHourDiscrepancies(input: Readonly<{ projection: JiaowubaoCompletedLessonProjection; stateRows: readonly OpsStateRow[]; scope: MonthlyHourDiscrepancyScope; owner?: string }>) {
  const owners = ownersByStudent(input.stateRows);
  const groups = groupedLessons(input.projection);
  const candidates = new Map(groups.map((group) => [group, candidateSchedule(group)]));
  const reconciled = new Set(groups.filter((group) => joinProblem(group) === null).map((group) => group.schedules[0]!.sourceKey));
  const displayedCandidates = new Set([...candidates.values()].filter((schedule): schedule is Schedule => schedule !== null).map((schedule) => schedule.sourceKey));
  const rows = groups.filter((group) => groupVisible(group.members, input.scope, owners)).flatMap((group) => groupDiscrepancies(group, owners, candidates.get(group) ?? null));
  if (input.scope.includeUnmatched) {
    for (const schedule of input.projection.scheduleEvents) {
      if (reconciled.has(schedule.sourceKey) || displayedCandidates.has(schedule.sourceKey)) continue;
      rows.push(...discrepancyRows({ members: [], teachers: schedule.teachers.length ? schedule.teachers : unverifiedTeachers([]), sample: schedule, id: schedule.sourceKey, problem: "缺少可核对的学生记录", owners }));
    }
  }
  const operationsOwners = [...new Set(rows.flatMap((row) => row.operationsOwners))].sort();
  const selected = input.owner ? rows.filter((row) => input.owner === "unmatched" ? row.ownerUnmatched : row.operationsOwners.includes(input.owner!)) : rows;
  selected.sort((left, right) => left.lessonDate.localeCompare(right.lessonDate) || (left.timeTitle ?? "").localeCompare(right.timeTitle ?? "") || left.id.localeCompare(right.id));
  return { rows: selected, operationsOwners };
}
