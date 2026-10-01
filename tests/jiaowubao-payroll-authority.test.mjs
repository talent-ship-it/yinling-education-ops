import assert from "node:assert/strict";
import test from "node:test";

const { assertJiaowubaoPayrollAuthority, assertJiaowubaoPayrollProjectedSummary } = await import("../lib/jiaowubao-payroll-authority.ts");
const { projectJiaowubaoCompletedLessonRecord } = await import("../lib/jiaowubao-completed-lessons.ts");
const { projectJiaowubaoCompletedScheduleRecord } = await import("../lib/jiaowubao-completed-schedule.ts");
const { projectJiaowubaoCompletedLessonRecords } = await import("../lib/jiaowubao-completed-lesson-projection.ts");

const period = { start: "2026-09-01", end: "2026-09-30" };
const lesson = {
  branch_id: 1, cal_id: 900, mem_id: 701, mem_title: "Student One", dated: "2026-09-02",
  hours: 1, type: 1, sign: 1, course_title: "Math", teacher_id: 80,
  teacher_title: "Tutor One", over: 1,
};
const schedule = {
  cal_id: 900, dated: "2026-09-02", course_title: "Math", teacher_id: 80,
  teacher_title: "Tutor One", teacher_hour: 1, over: 1,
};
const stateRows = [
  { entity: "students", version: 3, updated_at: "2026-10-01T00:00:00.000Z", updated_by: "test",
    payload: [{ id: "S1", name: "Student One", jwbSourceRow: "701" }] },
  { entity: "teachers", version: 4, updated_at: "2026-10-01T00:00:00.000Z", updated_by: "test",
    payload: [{ id: "T1", name: "Tutor One", jwbSourceRow: "80" }] },
];

function projection(lessonChanges = {}, scheduleChanges = {}, rows = stateRows) {
  return projectJiaowubaoCompletedLessonRecords({
    records: [projectJiaowubaoCompletedLessonRecord({ ...lesson, ...lessonChanges }, period)],
    scheduleRecords: [projectJiaowubaoCompletedScheduleRecord({ ...schedule, ...scheduleChanges }, period)],
    stateRows: rows,
  });
}

function summaryRow(projected) {
  const item = projected.items[0];
  const teacher = projected.teachers[0];
  return {
    teacherId: "T1", sourceHours: teacher.sourceHours,
    sourceLessonCount: teacher.sourceLessonCount, trialLessons: teacher.trialSourceHours,
    lines: [{
      sourceKey: item.sourceKey, hours: item.hours, hoursIssue: item.hoursIssue ?? null,
      isTrial: item.isTrial, sourceMemberId: item.memberId, studentId: item.studentId,
      studentMatch: item.studentMatch, studentName: item.displayStudentName,
      evidenceOnly: true, rate: 0, subtotal: 0,
    }],
  };
}

test("the server payroll precheck accepts a complete, reconciled source row", () => {
  const projected = projection();
  assert.doesNotThrow(() => assertJiaowubaoPayrollProjectedSummary(summaryRow(projected), projected));
});

test("the server payroll precheck rejects conflicting ID and name teacher proofs", () => {
  const rows = structuredClone(stateRows);
  rows[1].payload.push({ id: "T2", name: "Tutor Two" });
  const projected = projection({ teacher_title: "Tutor Two" }, { teacher_title: "Tutor Two" }, rows);
  assert.equal(projected.scheduleEvents[0].teachers[0].teacherMatch, "ambiguous");
  assert.throws(() => assertJiaowubaoPayrollProjectedSummary({ teacherId: "T1", lines: [] }, projected),
    /jiaowubao_payroll_source_unverified/u);
});

test("the server payroll precheck rejects a source course conflict", () => {
  const projected = projection({ course_title: "English" });
  assert.ok(projected.teachers.some((teacher) => teacher.unresolvedLessonCount > 0));
  assert.throws(() => assertJiaowubaoPayrollProjectedSummary({ teacherId: "T1", lines: [] }, projected),
    /jiaowubao_payroll_source_unverified/u);
});

test("reordered unchanged JWB object keys do not trigger a source fetch for a manual payroll edit", async () => {
  const currentPayload = [{ id: "J1", source: "jiaowubao-completed-lessons", sourceRevision: "old", teacherId: "T1" },
    { id: "manual", amount: 1 }];
  const nextPayload = [{ teacherId: "T1", sourceRevision: "old", source: "jiaowubao-completed-lessons", id: "J1" },
    { id: "manual", amount: 2 }];
  await assert.doesNotReject(assertJiaowubaoPayrollAuthority({ currentPayload, nextPayload, stateRows: [] }));
});
