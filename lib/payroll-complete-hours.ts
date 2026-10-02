import type { PayrollExportEvidence, PayrollExportLessonEvidence, PayrollExportScheduleEvidence, PayrollExportTeacherLink } from "@/lib/payroll-export";
import { jiaowubaoCompletedLessonTeacherIdentityKey as teacherKey, scheduleMatchesGroup } from "@/lib/jiaowubao-completed-lesson-reconciliation";
import { isJiaowubaoSharedTrialAccountLabel } from "@/lib/trial-operations";

import { isJiaowubaoCompletedLessonUnknownBranchId } from "@/lib/jiaowubao-completed-lesson-branch";

type Lesson = PayrollExportLessonEvidence;
type Role = PayrollExportTeacherLink & { sourceTeacherHours?: number | null; sourceTeacherHoursIssue?: string | null };

export type CompleteHourRecord = Readonly<{
  calendarId: string; eventKey: string; credit: boolean; date: string; time: string; course: string;
  teacherKey: string; teacherName: string; role: string; hours: number | null;
  studentKey: string; studentName: string; originalNames: string;
  trial: boolean; lessons: readonly Lesson[]; issues: readonly string[]; source: string;
}>;

export function completeHourSum(values: readonly (number | null)[]) {
  let total = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) return null;
    total += value;
    if (!Number.isFinite(total) || Math.abs(total) > 1_000_000_000_000) return null;
  }
  return Number(total.toFixed(4));
}

function studentNameIssue(lesson: Lesson, shared: boolean) {
  if (shared || lesson.studentMatch === "trial_course_title") return "试听姓名候选待核对";
  return !lesson.displayStudentName || lesson.studentMatch === "ambiguous" ? "学生姓名待核对" : null;
}

function learnerKey(lesson: Lesson, shared: boolean) {
  if (shared) return JSON.stringify([lesson.memberId, lesson.displayStudentName?.trim() || lesson.calendarId]);
  return lesson.studentId ?? JSON.stringify([lesson.branchId, lesson.memberId]);
}

function studentIdentity(lesson: Lesson) {
  const shared = Boolean(isJiaowubaoSharedTrialAccountLabel(lesson.memberName));
  const candidate = lesson.displayStudentName?.trim();
  const name = candidate && !isJiaowubaoSharedTrialAccountLabel(candidate)
    ? candidate : lesson.memberName ?? lesson.memberId;
  const trial = lesson.isTrial || shared || /试听|测试/u.test(lesson.courseTitle ?? "");
  return { key: learnerKey(lesson, shared), name: `${name}${trial ? "（试听）" : ""}`, trial, issue: studentNameIssue(lesson, shared) };
}

function recordLearners(lessons: readonly Lesson[]) {
  const students = new Map(lessons.map((lesson) => {
    const student = studentIdentity(lesson);
    return [student.key, student] as const;
  }));
  const sorted = [...students.values()].sort((a, b) => a.key.localeCompare(b.key));
  return {
    studentKey: JSON.stringify(sorted.map((student) => student.key)),
    studentName: sorted.map((student) => student.name).join("、") || "学生待核对",
    originalNames: [...new Set(lessons.map((lesson) => lesson.memberName ?? lesson.memberId))].join("、"),
    trial: sorted.some((student) => student.trial),
    issues: [...new Set(sorted.flatMap((student) => student.issue ? [student.issue] : [])),
      ...(sorted.length > 1 ? ["小组课合列，未拆分个人老师课时"] : []),
      ...(!sorted.length ? ["缺少学生消课记录"] : []),
      ...(lessons.some((lesson) => lesson.hoursIssue) ? ["学生来源课时异常待核对"] : []),
    ],
  };
}

function roleFields(role: Role | null) {
  return {
    teacherKey: role ? teacherKey(role) : "unassigned:primary",
    teacherName: role?.teacherName ?? role?.sourceTeacherName ?? "老师待核对",
    role: role ? { primary: "主讲", assistant: "助教", third: "第三老师" }[role.role] : "角色待核对",
    hours: role?.sourceTeacherHours ?? null,
  };
}

function roleIssues(role: Role | null) {
  const issues: string[] = [];
  if (role?.sourceTeacherHours == null || role.sourceTeacherHoursIssue) issues.push("老师角色课时待核对");
  if (!role || !["source_id", "unique_name"].includes(role.teacherMatch)) issues.push("老师身份待核对");
  if (/测试/u.test(role?.sourceTeacherName ?? "")) issues.push("测试老师账号待核对");
  return issues;
}

function roleRecord(input: {
  sourceKey: string; calendarId: string; lessonDate: string; timeTitle: string | null; courseTitle: string | null;
}, role: Role | null, lessons: readonly Lesson[], source: string, extraIssue?: string): CompleteHourRecord {
  const learners = recordLearners(lessons);
  const course = lessons.length === 1 ? lessons[0].courseTitle : input.courseTitle;
  return {
    calendarId: input.calendarId, eventKey: input.sourceKey, credit: true, date: input.lessonDate, time: input.timeTitle ?? "",
    course: course ?? input.courseTitle ?? "", ...roleFields(role), ...learners,
    trial: learners.trial || /试听|测试/u.test(course ?? input.courseTitle ?? ""),
    issues: [...learners.issues, ...roleIssues(role), ...(extraIssue ? [extraIssue] : [])],
    lessons, source,
  };
}

function assertMonth(date: string, month: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !date.startsWith(`${month}-`)
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("完整课时表包含月份以外或无效的课节日期。");
  }
}

function missingRoles(lessons: readonly Lesson[], present: ReadonlySet<string>) {
  const roles = new Map<string, Role>();
  for (const lesson of lessons) {
    for (const role of lesson.teachers) {
      const key = JSON.stringify([teacherKey(role), role.role]);
      if (!present.has(key)) roles.set(key, role);
    }
  }
  return [...roles.values()];
}

function indexLessons(lessons: readonly Lesson[], month: string) {
  const result = new Map<string, Lesson[]>();
  for (const lesson of lessons) {
    assertMonth(lesson.lessonDate, month);
    const group = result.get(lesson.calendarId) ?? [];
    group.push(lesson);
    result.set(lesson.calendarId, group);
  }
  return result;
}

function contradictoryLearners(lessons: readonly Lesson[]) {
  return (["lessonDate", "timeTitle", "courseTitle", "teamTitle"] as const).some((field) =>
    new Set(lessons.map((lesson) => lesson[field]).filter((value) => value !== null)).size > 1);
}

function associationIssue(schedule: PayrollExportScheduleEvidence, lessons: readonly Lesson[], duplicateCalendar: boolean) {
  if (duplicateCalendar || new Set(lessons.map((lesson) => lesson.branchId)).size !== 1) return "课节编号或分校关联冲突待核对";
  if (contradictoryLearners(lessons) || !scheduleMatchesGroup(schedule, lessons)) return "双源课节资料冲突待核对";
  return null;
}

function scheduleRecords(schedule: PayrollExportScheduleEvidence, lessons: readonly Lesson[], duplicateCalendar: boolean) {
  const conflict = associationIssue(schedule, lessons, duplicateCalendar);
  const members = conflict ? [] : lessons;
  const historical = members.some((lesson) => isJiaowubaoCompletedLessonUnknownBranchId(lesson.branchId));
  const issue = conflict ?? (historical ? "分校来源缺失，学生关联为候选，待核对" : undefined);
  return (schedule.teachers.length ? schedule.teachers : [null]).map((role) => {
    const record = roleRecord(schedule, role, members, "教务宝开放 API 双源", issue);
    if (conflict) return { ...record, studentKey: "unallocated", studentName: "未分配老师课时（关联待核对）" };
    if (historical) return { ...record, studentKey: JSON.stringify(["historical", record.studentKey]), studentName: `${record.studentName}（关联待核对）` };
    return record;
  });
}

function learnerOnlyRecords(lessons: readonly Lesson[]) {
  const roles = missingRoles(lessons, new Set());
  return (roles.length ? roles : [null]).map((role) => ({
    ...roleRecord(lessons[0], role, lessons, "教务宝消课 API", "缺少可核实的排课角色关联"),
    credit: false,
  }));
}

function indexSchedules(schedules: readonly PayrollExportScheduleEvidence[], month: string) {
  const byCalendar = new Map<string, PayrollExportScheduleEvidence[]>();
  const sourceKeys = new Set<string>();
  for (const schedule of schedules) {
    assertMonth(schedule.lessonDate, month);
    if (sourceKeys.has(schedule.sourceKey)) throw new Error("完整课时表包含重复排课来源键。");
    sourceKeys.add(schedule.sourceKey);
    const group = byCalendar.get(schedule.calendarId) ?? [];
    group.push(schedule);
    byCalendar.set(schedule.calendarId, group);
  }
  return byCalendar;
}

function recordsForCalendar(schedules: readonly PayrollExportScheduleEvidence[], lessons: readonly Lesson[]) {
  const records = schedules.flatMap((schedule) => scheduleRecords(schedule, lessons, schedules.length > 1));
  const matched = schedules.length === 1 && associationIssue(schedules[0], lessons, false) === null;
  if (lessons.length && !matched) {
    records.push(...lessons.flatMap((lesson) => learnerOnlyRecords([lesson])));
  }
  return records;
}

export function completeHourRecords(evidence: PayrollExportEvidence, month: string) {
  const lessonsByCalendar = indexLessons(evidence.lessons, month);
  const schedulesByCalendar = indexSchedules(evidence.schedules, month);
  const calendars = new Set([...lessonsByCalendar.keys(), ...schedulesByCalendar.keys()]);
  const records = [...calendars].flatMap((calendarId) => recordsForCalendar(schedulesByCalendar.get(calendarId) ?? [], lessonsByCalendar.get(calendarId) ?? []));
  return records.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
    || a.calendarId.localeCompare(b.calendarId) || a.eventKey.localeCompare(b.eventKey) || a.teacherKey.localeCompare(b.teacherKey) || a.role.localeCompare(b.role));
}

export function completeHourAttendance(records: readonly CompleteHourRecord[]) {
  const lessons = new Map(records.flatMap((record) => record.lessons.map((lesson) => [lesson.sourceKey, lesson] as const)));
  const counts = new Map<string, number>([["已到达", 0], ["请假", 0], ["未签到", 0]]);
  for (const lesson of lessons.values()) {
    const label = lesson.attendanceTitle?.trim() || "签到待核对";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (!lessons.size) return "签到待核对";
  return [...counts].map(([label, count]) => `${label} ${count}`).join("；");
}

export function completeHourGroups(records: readonly CompleteHourRecord[], key: (record: CompleteHourRecord) => string) {
  const groups = new Map<string, CompleteHourRecord[]>();
  for (const record of records) {
    const groupKey = key(record);
    const group = groups.get(groupKey) ?? [];
    group.push(record);
    groups.set(groupKey, group);
  }
  return [...groups.values()];
}
