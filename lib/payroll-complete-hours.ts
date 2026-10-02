import type { PayrollExportEvidence, PayrollExportLessonEvidence, PayrollExportScheduleEvidence, PayrollExportTeacherLink } from "@/lib/payroll-export";
import { jiaowubaoCompletedLessonTeacherIdentityKey as teacherKey } from "@/lib/jiaowubao-completed-lesson-reconciliation";
import { isJiaowubaoSharedTrialAccountLabel } from "@/lib/trial-operations";

type Lesson = PayrollExportLessonEvidence;
type Role = PayrollExportTeacherLink & { sourceTeacherHours?: number | null; sourceTeacherHoursIssue?: string | null };

export type CompleteHourRecord = Readonly<{
  calendarId: string; date: string; time: string; course: string;
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
  calendarId: string; lessonDate: string; timeTitle: string | null; courseTitle: string | null;
}, role: Role | null, lessons: readonly Lesson[], source: string, extraIssue?: string): CompleteHourRecord {
  const learners = recordLearners(lessons);
  const course = lessons.length === 1 ? lessons[0].courseTitle : input.courseTitle;
  return {
    calendarId: input.calendarId, date: input.lessonDate, time: input.timeTitle ?? "",
    course: course ?? input.courseTitle ?? "", ...roleFields(role), ...learners,
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

function scheduleRecords(schedule: PayrollExportScheduleEvidence, lessons: readonly Lesson[]) {
  const roles = new Set(schedule.teachers.map((teacher) => teacher.role));
  if (roles.size !== schedule.teachers.length) throw new Error("完整课时表包含重复老师角色。");
  const conflict = lessons.some((lesson) => lesson.lessonDate !== schedule.lessonDate)
    ? "双源课节日期冲突待核对" : undefined;
  const records = (schedule.teachers.length ? schedule.teachers : [null]).map((role) =>
    roleRecord(schedule, role, lessons, "教务宝开放 API 双源", conflict));
  const present = new Set(schedule.teachers.map((role) => JSON.stringify([teacherKey(role), role.role])));
  for (const role of missingRoles(lessons, present)) {
    records.push(roleRecord(schedule, role, lessons, "教务宝消课 API", "双源老师角色冲突待核对"));
  }
  return records;
}

export function completeHourRecords(evidence: PayrollExportEvidence, month: string) {
  const lessonsByCalendar = indexLessons(evidence.lessons, month);
  const records: CompleteHourRecord[] = [];
  const calendars = new Set<string>();
  for (const schedule of evidence.schedules) {
    assertMonth(schedule.lessonDate, month);
    if (calendars.has(schedule.calendarId)) throw new Error("完整课时表包含重复排课 ID。");
    calendars.add(schedule.calendarId);
    records.push(...scheduleRecords(schedule, lessonsByCalendar.get(schedule.calendarId) ?? []));
  }
  for (const [calendarId, lessons] of lessonsByCalendar) {
    if (calendars.has(calendarId)) continue;
    const roles = missingRoles(lessons, new Set());
    records.push(...(roles.length ? roles : [null]).map((role) =>
      roleRecord(lessons[0], role, lessons, "教务宝消课 API", "缺少排课角色来源")));
  }
  return records.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
    || a.calendarId.localeCompare(b.calendarId) || a.teacherKey.localeCompare(b.teacherKey) || a.role.localeCompare(b.role));
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
