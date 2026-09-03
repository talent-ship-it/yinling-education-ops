/** Read-only, ID-linked facts derived from documented `query_lesson_list` rows. */

export type CompletedStudentFact = {
  memberId: string;
  memberName: string;
  completedLessons: number;
  completedHours: number;
  attendance: { arrived: number; leave: number; other: number };
  latestLesson: { dated: string; course: string; hours: number; attendance: string } | null;
};

export type CompletedTeacherFact = {
  teacherId: string;
  teacherName: string;
  completedLessons: number;
  completedHours: number;
};

export type CompletedLessonFacts = {
  students: CompletedStudentFact[];
  teachers: CompletedTeacherFact[];
  summary: { uniqueLessons: number; completedHours: number };
};

type RecordValue = Record<string, unknown>;

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function sourceId(value: unknown) {
  const raw = stringValue(value);
  return /^\d+$/.test(raw) && !/^0+$/.test(raw) ? raw.replace(/^0+(?=\d)/, "") : "";
}

function hours(value: unknown) {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

function rounded(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Only the documented primary teacher receives lesson hours; assistants have no documented allocation. */
export function normalizeCompletedLessonFacts(rows: RecordValue[]): CompletedLessonFacts {
  const students = new Map<string, CompletedStudentFact>();
  const teachers = new Map<string, CompletedTeacherFact>();
  const keys = new Set<string>();

  for (const row of rows) {
    if (Number(row.over) !== 1) throw new Error("已结课事实只能包含 over=1 的教务宝记录。");
    const memberId = sourceId(row.mem_id);
    const calendarId = sourceId(row.cal_id);
    if (!memberId || !calendarId) throw new Error("教务宝已结课记录缺少 mem_id 或 cal_id。");
    const key = `${sourceId(row.branch_id) || "unknown"}:${calendarId}:${memberId}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const lessonHours = hours(row.hours);
    const attendance = stringValue(row.sign_title) || (Number(row.sign) === 1 ? "已到达" : Number(row.sign) === 0 ? "请假" : "待确认");
    const existing = students.get(memberId) ?? {
      memberId, memberName: stringValue(row.mem_title) || "教务宝未返回姓名", completedLessons: 0, completedHours: 0,
      attendance: { arrived: 0, leave: 0, other: 0 }, latestLesson: null,
    };
    existing.completedLessons += 1;
    existing.completedHours = rounded(existing.completedHours + lessonHours);
    if (/到达|出席|正常/.test(attendance)) existing.attendance.arrived += 1;
    else if (/请假|缺席/.test(attendance)) existing.attendance.leave += 1;
    else existing.attendance.other += 1;
    const dated = stringValue(row.dated);
    if (!existing.latestLesson || dated >= existing.latestLesson.dated) {
      existing.latestLesson = { dated, course: stringValue(row.course_title) || "课程待确认", hours: lessonHours, attendance };
    }
    students.set(memberId, existing);

    const teacherId = sourceId(row.teacher_id);
    if (teacherId) {
      const teacher = teachers.get(teacherId) ?? { teacherId, teacherName: stringValue(row.teacher_title) || "教务宝未返回教师姓名", completedLessons: 0, completedHours: 0 };
      teacher.completedLessons += 1;
      teacher.completedHours = rounded(teacher.completedHours + lessonHours);
      teachers.set(teacherId, teacher);
    }
  }
  const studentFacts = [...students.values()].sort((left, right) => left.memberId.localeCompare(right.memberId));
  return {
    students: studentFacts,
    teachers: [...teachers.values()].sort((left, right) => left.teacherId.localeCompare(right.teacherId)),
    summary: { uniqueLessons: keys.size, completedHours: rounded(studentFacts.reduce((sum, student) => sum + student.completedHours, 0)) },
  };
}
