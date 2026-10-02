import assert from "node:assert/strict";
import test from "node:test";
import { buildPayrollXlsx, payrollXlsxFilename, type PayrollExportEvidence, type PayrollWorkbookExport } from "../lib/payroll-export";
import { readXlsx } from "../lib/xlsx-reader";
import { completeHourRecords } from "../lib/payroll-complete-hours";
import { jiaowubaoCompletedLessonTeacherIdentityKey as teacherKey } from "../lib/jiaowubao-completed-lesson-reconciliation";

const teacher = { role: "primary" as const, sourceTeacherId: "source-1", sourceTeacherName: "Teacher One", teacherId: "teacher-1", teacherName: "Teacher One", teacherMatch: "source_id" };
function fixture(): PayrollExportEvidence {
  return {
    revision: `sha256:${"a".repeat(64)}`, projectionRevision: `sha256:${"b".repeat(64)}`, publishedAt: "2026-10-02T00:00:00.000Z",
    lessonRowCount: 1, scheduleRowCount: 1, teacherLessonSourceKeys: [],
    matchCounts: { matchedStudents: 1, unmatchedStudents: 0, ambiguousStudents: 0, matchedTeachers: 1, unmatchedTeachers: 0, ambiguousTeachers: 0 },
    lessons: [{ sourceKey: "lesson-1", branchId: "branch-1", calendarId: "cal-1", memberId: "member-1", memberName: "Learner One",
      displayStudentName: "Learner One", studentId: "student-1", studentName: "Learner One", studentMatch: "source_id", lessonDate: "2026-09-15",
      timeTitle: "16:00-18:00", hours: 1.75, isTrial: false, attendanceCode: 1, attendanceTitle: "已到达", courseTitle: "English", teamTitle: "One", teachers: [teacher] }],
    schedules: [{ sourceKey: "schedule-1", calendarId: "cal-1", lessonDate: "2026-09-15", timeTitle: "16:00-18:00", courseTitle: "English", teamTitle: "One", teachers: [{ ...teacher, sourceTeacherHours: 1 }] }],
  };
}
function workbook(evidence: PayrollExportEvidence, month = "2026-09"): PayrollWorkbookExport {
  const roles = new Map([...evidence.lessons.flatMap((lesson) => lesson.teachers), ...evidence.schedules.flatMap((schedule) => schedule.teachers)].map((role) => [teacherKey(role), role]));
  const rows = [...roles].map(([key, role]) => {
    const lessons = evidence.lessons.filter((lesson) => lesson.teachers.some((link) => teacherKey(link) === key));
    return {
      teacherKey: key, teacherId: role.teacherId, teacherName: role.teacherName ?? "Pending", month, section: "Teachers", currency: "AUD" as const,
      status: "需核对", payrollHours: 0, sourceHours: null, amount: 987654, bankName: "PRIVATE BANK", bankAccount: "PRIVATE ACCOUNT", paymentNote: "PRIVATE PAYMENT",
      paymentMode: "review_only" as const,
      lines: lessons.map((lesson) => ({ studentName: lesson.displayStudentName ?? `${lesson.memberName ?? lesson.memberId}（待核对姓名）`,
        hours: lesson.hours, hoursIssue: lesson.hoursIssue, sourceKey: lesson.sourceKey, sourceMemberId: lesson.memberId, studentId: lesson.studentId,
        studentMatch: lesson.studentMatch, isTrial: lesson.isTrial, evidenceOnly: true, rate: 0, subtotal: 0 })),
    };
  });
  return { month, generatedAt: "2026-10-02T01:00:00.000Z", exportMode: "hours_complete", rows,
    evidence: { ...evidence, lessonRowCount: evidence.lessons.length, scheduleRowCount: evidence.schedules.length,
      teacherLessonSourceKeys: rows.map((row) => ({ teacherKey: row.teacherKey, sourceKeys: row.lines.map((line) => line.sourceKey) })) } };
}
async function sheets(input: PayrollWorkbookExport) {
  const result = await readXlsx(buildPayrollXlsx(input));
  return result.worksheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.map((row) => row.cells.map((cell) => cell.value)) }));
}

test("complete export preserves the four reference sheets and uses teacher role hours", async () => {
  const input = workbook(fixture());
  const result = await sheets(input);
  assert.deepEqual(result.map((sheet) => sheet.name), ["Sheet1", "学生明细", "课节原始明细", "数据说明"]);
  assert.equal(result[0].rows[0][0], "2026年9月教务宝课时表");
  assert.deepEqual(result[0].rows[2], ["序号", "教师姓名", "学生姓名", "课时（小时）", "课时费单价（小时）", "合计（待补费率）", "老师总课时（小时）", "老师总薪资（待补）", "老师薪资备注"]);
  assert.equal(result[0].rows[3][3], 1); assert.equal(result[0].rows[3][6], 1);
  for (const index of [4, 5, 7]) assert.ok(!result[0].rows[3][index]);
  assert.equal(result[1].rows[1][3], 1); assert.equal(result[1].rows[1][4], 1);
  assert.equal(result[1].rows[1][6], "2026-09-15 至 2026-09-15");
  assert.equal(result[1].rows[1][7], "已到达 1；请假 0；未签到 0");
  assert.equal(result[2].rows[1][5], 1);
  const source = new Map(result[3].rows.slice(2).map((row) => [row[0], row[1]]));
  assert.equal(source.get("教师总课时"), 1); assert.equal(source.get("学员总课时"), 1.75);
  assert.equal(source.get("来源修订"), input.evidence!.revision);
  assert.equal(source.get("映射修订"), input.evidence!.projectionRevision);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|987654|api\/cal\/list/u);
  assert.equal(payrollXlsxFilename("2027-01", "hours_complete"), "2027年01月教务宝课时表_完整版.xlsx");
});

test("a group lesson counts each teacher role once and does not allocate group hours to individual students", async () => {
  const evidence = fixture();
  const assistant = { ...teacher, role: "assistant" as const, teacherId: "teacher-2", sourceTeacherId: "source-2", teacherName: "Assistant" };
  const lessons = [evidence.lessons[0], { ...evidence.lessons[0], sourceKey: "lesson-2", memberId: "member-2", studentId: "student-2", memberName: "Learner Two", displayStudentName: "Learner Two" }].map((lesson) => ({ ...lesson, teachers: [teacher, assistant] }));
  const result = await sheets(workbook({ ...evidence, lessons, schedules: [{ ...evidence.schedules[0], teachers: [...evidence.schedules[0].teachers, { ...assistant, sourceTeacherHours: 0.5 }] }] }));
  assert.equal(result[2].rows.length, 3);
  assert.equal(result[2].rows.slice(1).reduce((sum, row) => sum + Number(row[5]), 0), 1.5);
  assert.equal(result[1].rows.slice(1).reduce((sum, row) => sum + Number(row[3]), 0), 1.5);
  assert.match(String(result[1].rows[1][2]), /Learner One.*Learner Two/u);
  assert.match(String(result[1].rows[1][9]), /小组课合列/u);
});

test("missing and conflicting role sources remain unknown and never use student hours or scheduled duration", async () => {
  const evidence = fixture();
  const missing = await sheets(workbook({ ...evidence, schedules: [] }));
  assert.equal(missing[0].rows[3][3], "待核对"); assert.equal(missing[2].rows[1][5], "待核对");
  assert.match(String(missing[2].rows[1][12]), /缺少可核实的排课角色关联/u);
  const missingSource = new Map(missing[3].rows.slice(2).map((row) => [row[0], row[1]]));
  assert.equal(missingSource.get("待核对课节"), 1);
  const noRoles = await sheets(workbook({ ...evidence, schedules: [{ ...evidence.schedules[0], teachers: [] }] }));
  const noRoleSource = new Map(noRoles[3].rows.slice(2).map((row) => [row[0], row[1]]));
  assert.equal(noRoleSource.get("老师角色明细行数"), 0);
  assert.equal(noRoleSource.get("教师总课时"), "待核对");
  const mismatch = { ...teacher, teacherId: "teacher-2", sourceTeacherId: "source-2", teacherName: "Other Teacher", sourceTeacherHours: 1 };
  const conflict = await sheets(workbook({ ...evidence, schedules: [{ ...evidence.schedules[0], teachers: [mismatch] }] }));
  assert.equal(conflict[2].rows.length, 3);
  assert.ok(conflict[2].rows.slice(1).some((row) => row[5] === "待核对"));
  assert.match(JSON.stringify(conflict), /双源课节资料冲突待核对/u);
});

test("finite outliers retain their source value while unsafe totals stay unknown", async () => {
  const evidence = fixture();
  const anomalous = (hours: number) => workbook({ ...evidence, schedules: [{ ...evidence.schedules[0], teachers: [{ ...teacher, sourceTeacherHours: hours, sourceTeacherHoursIssue: "out_of_range" }] }] });
  const result = await sheets(anomalous(58.53));
  assert.equal(result[2].rows[1][5], 58.53); assert.equal(result[0].rows[3][6], 58.53);
  assert.match(String(result[2].rows[1][12]), /老师角色课时待核对/u);
  const unsafe = await sheets(anomalous(1e13));
  assert.equal(unsafe[2].rows[1][5], "10000000000000"); assert.equal(unsafe[0].rows[3][6], "待核对");
  assert.throws(() => buildPayrollXlsx(anomalous(Infinity)), /课时格式无效/u);
});

test("shared trial candidates and unknown names retain raw accounts without becoming confirmed identities", async () => {
  const evidence = fixture();
  const lesson = { ...evidence.lessons[0], memberName: "试听学员B", displayStudentName: "Candidate One", studentMatch: "trial_course_title" };
  const result = await sheets(workbook({ ...evidence, lessons: [lesson] }));
  assert.equal(result[2].rows[1][6], "试听学员B"); assert.equal(result[2].rows[1][7], "Candidate One（试听）");
  assert.equal(result[2].rows[1][10], "是"); assert.match(String(result[2].rows[1][12]), /候选待核对/u);
  const unknown = await sheets(workbook({ ...evidence, lessons: [{ ...lesson, displayStudentName: null }] }));
  assert.match(String(unknown[0].rows[3][8]), /待核对/u);
  assert.equal(unknown[2].rows[1][6], "试听学员B");
});

test("complete export rejects duplicate schedule evidence, invalid dates and incomplete source mapping", () => {
  const evidence = fixture();
  assert.throws(() => buildPayrollXlsx(workbook({ ...evidence, schedules: [evidence.schedules[0], evidence.schedules[0]] })), /重复排课来源键/u);
  assert.throws(() => completeHourRecords({ ...evidence, lessons: [{ ...evidence.lessons[0], lessonDate: "2026-09-31" }] }, "2026-09"), /无效的课节日期/u);
  assert.throws(() => buildPayrollXlsx({ ...workbook(evidence), evidence: { ...workbook(evidence).evidence!, teacherLessonSourceKeys: [] } }), /不完整或不一致/u);
  assert.throws(() => buildPayrollXlsx({ ...workbook(evidence), evidence: undefined }), /缺少完整双源快照/u);
});

test("complete template follows selected month across years and treats spreadsheet formulas as plain names", async () => {
  const evidence = fixture();
  const name = '=HYPERLINK("https://example.invalid")';
  const result = await sheets(workbook({ ...evidence, lessons: [{ ...evidence.lessons[0], displayStudentName: name, lessonDate: "2027-01-02" }], schedules: [{ ...evidence.schedules[0], lessonDate: "2027-01-02" }] }, "2027-01"));
  assert.equal(result[0].rows[0][0], "2027年1月教务宝课时表"); assert.equal(result[1].rows[1][2], name);
  assert.match(JSON.stringify(result[3].rows), /2027-01-01 至 2027-01-31/u);
});

test("zero hours stay numeric and test teacher accounts remain explicitly pending", async () => {
  const evidence = fixture();
  const role = { ...teacher, sourceTeacherName: "测试老师账号", teacherName: "测试老师账号", sourceTeacherHours: 0 };
  const result = await sheets(workbook({ ...evidence, lessons: [{ ...evidence.lessons[0], hours: 0, teachers: [role] }], schedules: [{ ...evidence.schedules[0], teachers: [role] }] }));
  assert.equal(result[0].rows[3][3], 0); assert.equal(result[0].rows[3][6], 0);
  assert.equal(result[2].rows[1][5], 0); assert.match(String(result[2].rows[1][12]), /测试老师账号待核对/u);
});

test("repeated teacher-student lessons aggregate role hours, dates and attendance across courses", async () => {
  const evidence = fixture();
  const lessons = [evidence.lessons[0], { ...evidence.lessons[0], sourceKey: "lesson-2", calendarId: "cal-2", lessonDate: "2026-09-22", attendanceTitle: "请假" },
    { ...evidence.lessons[0], sourceKey: "lesson-3", calendarId: "cal-3", lessonDate: "2026-09-23", courseTitle: "Maths" }];
  const schedules = lessons.map((lesson) => ({ ...evidence.schedules[0], sourceKey: `schedule-${lesson.calendarId}`, calendarId: lesson.calendarId, lessonDate: lesson.lessonDate, courseTitle: lesson.courseTitle }));
  const result = await sheets(workbook({ ...evidence, lessons, schedules }));
  assert.equal(result[0].rows.length, 4); assert.equal(result[0].rows[3][3], 3); assert.equal(result[0].rows[3][6], 3);
  assert.equal(result[1].rows.length, 3); assert.equal(result[1].rows[1][3], 2); assert.equal(result[1].rows[1][4], 2);
  assert.equal(result[1].rows[1][6], "2026-09-15 至 2026-09-22"); assert.equal(result[1].rows[1][7], "已到达 1；请假 1；未签到 0");
});


test("historical branch-less rows can show only explicitly pending candidate associations", async () => {
  const evidence = fixture();
  const result = await sheets(workbook({ ...evidence, lessons: [{ ...evidence.lessons[0], branchId: "~" }] }));
  assert.equal(result[0].rows[3][3], 1); assert.match(String(result[0].rows[3][2]), /关联待核对/u);
  assert.match(String(result[1].rows[1][2]), /关联待核对/u);
  assert.match(String(result[2].rows[1][7]), /关联待核对/u);
  assert.match(String(result[2].rows[1][12]), /分校来源缺失.*候选/u);
  const other = { ...evidence.lessons[0], sourceKey: "lesson-2", memberId: "member-2", studentId: "student-2", displayStudentName: "Learner Two", branchId: "~" };
  const grouped = await sheets(workbook({ ...evidence, lessons: [{ ...evidence.lessons[0], branchId: "~" }, other] }));
  for (const [sheet, column] of [[0, 2], [1, 2], [2, 7]]) {
    const name = String(grouped[sheet].rows[sheet === 0 ? 3 : 1][column]);
    assert.equal(name, "Learner One（关联待核对）、Learner Two（关联待核对）");
  }
});

test("conflicting metadata never assigns role hours to a learner", async () => {
  const evidence = fixture();
  for (const change of [{ lessonDate: "2026-09-16" }, { timeTitle: "11:00-12:00" }, { courseTitle: "Different" }, { teamTitle: "Different" }]) {
    const result = await sheets(workbook({ ...evidence, lessons: [{ ...evidence.lessons[0], ...change }] }));
    const detail = result[1].rows.slice(1);
    assert.equal(detail.find((row) => row[2] === "Learner One")?.[3], "待核对");
    assert.equal(detail.find((row) => String(row[2]).includes("未分配老师课时"))?.[3], 1);
    assert.equal(result[0].rows[3][6], 1);
  }
});

test("distinct schedule sources sharing a calendar retain both credits without assigning them to the learner", async () => {
  const evidence = fixture();
  const result = await sheets(workbook({ ...evidence, schedules: [evidence.schedules[0], { ...evidence.schedules[0], sourceKey: "schedule-duplicate-calendar", teachers: [{ ...teacher, sourceTeacherHours: 2 }] }] }));
  assert.equal(result[2].rows.length, 4);
  assert.deepEqual(result[2].rows.slice(1).map((row) => row[5]).sort(), [1, 2, "待核对"]);
  assert.equal(result[0].rows[3][6], 3);
  assert.equal(result[1].rows.slice(1).find((row) => row[2] === "Learner One")?.[3], "待核对");
});

test("multiple branches and extra schedule teacher roles keep learner hours unallocated", async () => {
  const evidence = fixture();
  const other = { ...evidence.lessons[0], sourceKey: "lesson-other-branch", branchId: "other", memberId: "member-2", displayStudentName: "Other Learner" };
  const branches = await sheets(workbook({ ...evidence, lessons: [evidence.lessons[0], other] }));
  assert.ok(branches[1].rows.slice(1).filter((row) => !String(row[2]).includes("未分配老师课时")).every((row) => row[3] === "待核对"));
  const roles = await sheets(workbook({ ...evidence, schedules: [{ ...evidence.schedules[0], teachers: [...evidence.schedules[0].teachers, { ...teacher, role: "assistant", sourceTeacherId: "assistant", teacherId: "assistant", sourceTeacherHours: 0.5 }] }] }));
  assert.ok(roles[1].rows.slice(1).filter((row) => row[2] === "Learner One").every((row) => row[3] === "待核对"));
});


test("absent schedule metadata cannot hide contradictory learner facts", async () => {
  const evidence = fixture();
  const other = { ...evidence.lessons[0], sourceKey: "lesson-2", memberId: "member-2", studentId: "student-2", displayStudentName: "Learner Two", timeTitle: "11:00-12:00", courseTitle: "Maths", teamTitle: "Another class" };
  const result = await sheets(workbook({ ...evidence, lessons: [evidence.lessons[0], other], schedules: [{ ...evidence.schedules[0], timeTitle: null, courseTitle: null, teamTitle: null }] }));
  assert.equal(result[2].rows.length, 4);
  assert.ok(result[1].rows.slice(1).filter((row) => !String(row[2]).includes("未分配老师课时")).every((row) => row[3] === "待核对"));
  assert.equal(result[0].rows[3][6], 1);
});

test("conflicting learners retain each source date, time, course, name and attendance", async () => {
  const evidence = fixture();
  const other = { ...evidence.lessons[0], sourceKey: "lesson-2", memberId: "member-2", studentId: "student-2", memberName: "Learner Two", displayStudentName: "Learner Two", lessonDate: "2026-09-16", timeTitle: "11:00-12:00", courseTitle: "Maths", attendanceTitle: "请假" };
  const result = await sheets(workbook({ ...evidence, lessons: [evidence.lessons[0], other] }));
  const raw = result[2].rows.slice(1);
  assert.equal(raw.length, 3);
  assert.deepEqual(raw.filter((row) => row[5] === "待核对").map((row) => [row[1], row[2], row[6], row[8], row[9]]), [
    ["2026-09-15", "16:00-18:00", "Learner One", "English", "已到达"],
    ["2026-09-16", "11:00-12:00", "Learner Two", "Maths", "请假"],
  ]);
  assert.equal(raw.filter((row) => typeof row[5] === "number").reduce((sum, row) => sum + Number(row[5]), 0), 1);
});


test("learner-only teachers do not obscure known schedule totals or add physical role events", async () => {
  const evidence = fixture();
  const otherTeacher = { ...teacher, teacherId: "teacher-2", sourceTeacherId: "source-2", teacherName: "Pending Teacher", sourceTeacherName: "Pending Teacher" };
  const result = await sheets(workbook({ ...evidence, lessons: [{ ...evidence.lessons[0], teachers: [otherTeacher] }] }));
  const source = new Map(result[3].rows.slice(2).map((row) => [row[0], row[1]]));
  assert.equal(source.get("教师总课时"), 1);
  assert.equal(source.get("老师角色明细行数"), 1);
  const pendingTeacher = result[0].rows.slice(3).find((row) => row[1] === "Pending Teacher")!;
  assert.equal(pendingTeacher[6], "待核对"); assert.match(String(pendingTeacher[8]), /课节 待核对/u);
  const detail = result[1].rows.slice(1).find((row) => row[1] === "Pending Teacher")!;
  assert.equal(detail[3], "待核对"); assert.equal(detail[4], "待核对");
});


test("unallocated trial schedule credits keep the course flag without student allocation", async () => {
  const evidence = fixture();
  for (const courseTitle of ["试听 English", "测试 English"]) {
    for (const lessons of [[], evidence.lessons]) {
      const result = await sheets(workbook({ ...evidence, lessons, schedules: [{ ...evidence.schedules[0], courseTitle }] }));
      const rawCredit = result[2].rows.slice(1).find((row) => row[5] === 1)!;
      assert.equal(rawCredit[10], "是"); assert.match(String(rawCredit[7]), /未分配老师课时/u);
      const detailCredit = result[1].rows.slice(1).find((row) => row[3] === 1)!;
      assert.equal(detailCredit[8], "试听"); assert.match(String(result[0].rows[3][8]), /试听 1/u);
      const source = new Map(result[3].rows.slice(2).map((row) => [row[0], row[1]]));
      assert.equal(source.get("试听/测试账号或课程标识课节"), 1);
      assert.equal(source.get("老师角色明细行数"), 1);
      if (!lessons.length) {
        assert.match(String(rawCredit[12]), /缺少学生消课记录/u);
        assert.doesNotMatch(String(rawCredit[12]), /冲突/u);
      }
    }
  }
});
