import assert from "node:assert/strict";
import test from "node:test";
import { LP_BUSINESS_CLOSED_RESULT, LP_BUSINESS_SCHEDULED_RESULT, LP_MODIFICATION_REVIEW_ADVANCED_RESULT } from "../lib/lp-business-tasks";
import { eligibleLpParentProgressRecords, reconcileAllLpParentProgressTasks, reconcileLpParentProgressTasks, type LpParentProgressRecord, type LpParentProgressBooking } from "../lib/lp-parent-progress-service";
import { deterministicTaskId, type OpsTask } from "../lib/ops-tasks";

const anchor = "2026-10-21T03:00:00.000Z";
const newLp: LpParentProgressRecord = {
  id: "LP-NEW", studentId: "STU-1", owner: "Abby", workflowType: "老师新 LP", stage: "待资料",
  fields: { requestSentAt: anchor, teacher: "Teacher A", subject: "English", preparationFollowUp: "是" },
};
const modification: LpParentProgressRecord = { ...newLp, id: "LP-MOD", workflowType: "老师 LP 修改", fields: { requestSentAt: anchor, subject: "English", modificationRequirements: "Exam revision" } };
const teachers = [{ id: "T-1", name: "Teacher A" }, { id: "T-2", name: "Teacher B" }];
const booking = { id: "BOOK-1", studentId: "STU-1", teacherId: "T-1", course: "English", kind: "常规课", date: "2026-10-30", start: "10:00", duration: 60, timezone: "Australia/Melbourne", status: "已确认" };
const now = "2026-10-22T03:00:00.000Z";
const runNew = (tasks: readonly OpsTask[] = [], bookings = [booking], lp = newLp, at = now) => reconcileAllLpParentProgressTasks({ tasks, lps: [lp], bookings, teachers, now: at });
const runModification = (tasks: readonly OpsTask[] = [], at = now, lp = modification) => reconcileLpParentProgressTasks({ tasks, lp, now: at });

test("the existing scheduler includes old-student and modification workflows while preserving trial exclusions", () => {
  assert.deepEqual(eligibleLpParentProgressRecords([newLp, modification, { ...newLp, id: "DIRECT", workflowType: "学生直报（无试听）" }]).map((lp) => lp.id), ["LP-NEW", "LP-MOD"]);
});

test("LP modification creates a source-anchored weekly screenshot check and is idempotent", () => {
  const tasks = runModification();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].ruleKey, "lp.modification-review");
  assert.equal(tasks[0].anchorBookingId, "LP-MOD");
  assert.equal(tasks[0].id, deterministicTaskId("LP-MOD", "lp.modification-review"));
  assert.equal(tasks[0].dueAt, "2026-10-28T03:00:00.000Z");
  assert.match(tasks[0].title, /截图/);
  assert.deepEqual(runModification(tasks), tasks);
});

test("a completed weekly check preserves its evidence and schedules the next week", () => {
  const first = runModification()[0];
  const done = { ...first, status: "done" as const, tone: "green" as const, closedAt: "2026-10-28T06:00:00.000Z", completionOutcome: "done" as const, completionNote: "FU-MOD-1 screenshot checked", result: "Operator verified screenshot" };
  const tasks = runModification([done], "2026-10-28T06:01:00.000Z");
  assert.deepEqual(tasks.find((task) => task.ruleKey === "lp.modification-review"), done);
  assert.equal(tasks.find((task) => task.ruleKey === "lp.modification-review.2")?.dueAt, "2026-11-04T03:00:00.000Z");
  assert.equal(tasks.filter((task) => task.status !== "done").length, 1);
  assert.deepEqual(runModification(tasks, "2026-10-28T06:01:00.000Z"), tasks);
});

test("missed weekly checks advance once and the LP completion stops all future checks", () => {
  const first = runModification();
  const late = runModification(first, "2026-11-12T03:00:00.000Z");
  assert.equal(late.find((task) => task.ruleKey === "lp.modification-review")?.result, LP_MODIFICATION_REVIEW_ADVANCED_RESULT);
  assert.equal(late.filter((task) => task.status !== "done").length, 1);
  assert.equal(late.find((task) => task.status !== "done")?.ruleKey, "lp.modification-review.3");
  const closed = runModification(late, "2026-11-12T04:00:00.000Z", { ...modification, stage: "完成" });
  assert.ok(closed.every((task) => task.status === "done"));
  assert.equal(closed.find((task) => task.ruleKey === "lp.modification-review.3")?.result, LP_BUSINESS_CLOSED_RESULT);
  assert.deepEqual(runModification(closed, "2026-12-12T04:00:00.000Z", { ...modification, stage: "完成" }), closed);
});

test("no date-only publication or guessed instant can create business deadlines", () => {
  assert.deepEqual(runModification([], now, { ...modification, fields: {}, publishedAt: "2026-10-21" }), []);
  assert.deepEqual(runNew([], [], { ...newLp, fields: { ...newLp.fields, requestSentAt: "2026-10-21" } }), []);
});

test("old-student new LP has an N+2 scheduling deadline and uses the actual first class for N-2/N-1", () => {
  const waiting = runNew([], []);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].ruleKey, "lp.scheduling");
  assert.equal(waiting[0].dueAt, "2026-10-23T03:00:00.000Z");
  const tasks = runNew(waiting);
  assert.equal(tasks.find((task) => task.ruleKey === "lp.scheduling")?.result, LP_BUSINESS_SCHEDULED_RESULT);
  assert.equal(tasks.find((task) => task.ruleKey === "lp.first-lesson-finalize-n2")?.dueAt, "2026-10-28T07:00:00.000Z");
  assert.equal(tasks.find((task) => task.ruleKey === "lp.first-lesson-prep-n1")?.dueAt, "2026-10-29T07:00:00.000Z");
  assert.deepEqual(runNew(tasks, [booking], newLp, "2026-10-22T03:05:00.000Z"), tasks);
  assert.ok(tasks.every((task) => !task.ruleKey?.includes("payment")));
});

test("old or different courses/teachers and ambiguous LP matches do not satisfy first scheduling", () => {
  for (const invalid of [{ ...booking, course: "Math" }, { ...booking, teacherId: "T-2" }, { ...booking, teacherId: "T-2", sourceTeacherName: "Teacher A" }, { ...booking, date: "2026-10-20" }, { ...booking, status: "已取消" }, { ...booking, studentId: "OTHER" }]) {
    const tasks = runNew([], [invalid]);
    assert.equal(tasks.length, 1);
    assert.notEqual(tasks[0].status, "done");
  }
  const ambiguous = reconcileAllLpParentProgressTasks({ tasks: [], lps: [newLp, { ...newLp, id: "LP-OTHER" }], bookings: [booking], teachers, now });
  assert.ok(ambiguous.every((task) => task.ruleKey === "lp.scheduling" && task.status !== "done"));
});

test("recurring first lessons use live occurrence overrides instead of a cancelled first date", () => {
  const series = { ...booking, date: "2026-10-23", recurring: true, repeatCount: 2, occurrenceOverrides: [{ occurrenceId: "BOOK-1:2026-10-23", status: "cancelled" as const }] };
  const tasks = reconcileAllLpParentProgressTasks({ tasks: [], lps: [newLp], bookings: [series], teachers, now });
  assert.equal(tasks.find((task) => task.ruleKey === "lp.first-lesson-finalize-n2")?.dueAt, "2026-10-28T07:00:00.000Z");
  const changedTeacher = { ...series, repeatCount: 1, occurrenceOverrides: [{ occurrenceId: "BOOK-1:2026-10-23", teacherId: "T-2" }] };
  const unmatched = reconcileAllLpParentProgressTasks({ tasks: [], lps: [newLp], bookings: [changedTeacher], teachers, now });
  assert.equal(unmatched.length, 1);
  assert.notEqual(unmatched[0].status, "done");
});

test("removing a first schedule reopens scheduling while retaining human task evidence", () => {
  const tasks = runNew();
  const before = tasks.map((task) => task.ruleKey === "lp.first-lesson-finalize-n2" ? { ...task, status: "done" as const, result: "Reviewed", closedAt: now, completionOutcome: "done" as const, completionNote: "FU-1" } : task);
  const cancelled = runNew(before, []);
  assert.notEqual(cancelled.find((task) => task.ruleKey === "lp.scheduling")?.status, "done");
  const resumed = runNew(cancelled);
  assert.deepEqual(resumed.find((task) => task.ruleKey === "lp.first-lesson-finalize-n2"), before.find((task) => task.ruleKey === "lp.first-lesson-finalize-n2"));
  assert.notEqual(resumed.find((task) => task.ruleKey === "lp.first-lesson-prep-n1")?.status, "done");
});

test("short-notice first lessons compress deadlines and preparation follows the handover flag", () => {
  const nextDay = { ...booking, date: "2026-10-22" };
  const tasks = runNew([], [nextDay]);
  assert.equal(tasks.find((task) => task.ruleKey === "lp.first-lesson-finalize-n2")?.dueAt, "2026-10-21T07:00:00.000Z");
  assert.equal(tasks.find((task) => task.ruleKey === "lp.first-lesson-prep-n1")?.dueAt, "2026-10-21T07:00:00.000Z");
  const noPrep = runNew([], [booking], { ...newLp, fields: { ...newLp.fields, preparationFollowUp: "否" } });
  assert.ok(noPrep.every((task) => task.ruleKey !== "lp.first-lesson-prep-n1"));
});

test("delivery and preparation stages close only their matching reminders and remain idempotent", () => {
  const delivered = runNew([], [booking], { ...newLp, stage: "已发老师" });
  assert.equal(delivered.find((task) => task.ruleKey === "lp.first-lesson-finalize-n2")?.status, "done");
  assert.notEqual(delivered.find((task) => task.ruleKey === "lp.first-lesson-prep-n1")?.status, "done");
  const prepared = runNew(delivered, [booking], { ...newLp, stage: "备课完成" });
  assert.ok(prepared.every((task) => task.status === "done"));
  assert.deepEqual(runNew(prepared, [booking], { ...newLp, stage: "备课完成" }, "2026-10-22T03:05:00.000Z"), prepared);
});

test("N+2 scheduling retains the source handover instant across daylight saving", () => {
  const tasks = runNew([], [], { ...newLp, fields: { ...newLp.fields, requestSentAt: "2026-10-02T02:00:00.000Z" } });
  assert.equal(tasks[0].dueAt, "2026-10-04T02:00:00.000Z");
});

function runOccurrenceBooking(actual: LpParentProgressBooking, lps = [newLp]) {
  return reconcileAllLpParentProgressTasks({ tasks: [], lps, bookings: [actual], teachers, now });
}

test("the first occurrence can override a different series teacher to the LP teacher", () => {
  const actual = { ...booking, teacherId: "T-2", recurring: true, repeatCount: 2, occurrenceOverrides: [{ occurrenceId: "BOOK-1:2026-10-30", teacherId: "T-1" }] };
  const tasks = runOccurrenceBooking(actual);
  assert.equal(tasks.find((task) => task.ruleKey === "lp.scheduling")?.result, LP_BUSINESS_SCHEDULED_RESULT);
  assert.equal(tasks.find((task) => task.ruleKey === "lp.first-lesson-finalize-n2")?.dueAt, "2026-10-28T07:00:00.000Z");
});

test("first-lesson matching uses the actual occurrence student and subject", () => {
  const overridden = { ...booking, studentId: "OTHER", course: "Math", occurrenceOverrides: [{ occurrenceId: "BOOK-1:2026-10-30", studentId: "STU-1", subjectId: "English" }] };
  const tasks = runOccurrenceBooking(overridden);
  assert.equal(tasks.find((task) => task.ruleKey === "lp.scheduling")?.result, LP_BUSINESS_SCHEDULED_RESULT);
  for (const override of [{ studentId: "OTHER" }, { subjectId: "Math" }]) {
    const mismatch = runOccurrenceBooking({ ...booking, occurrenceOverrides: [{ occurrenceId: "BOOK-1:2026-10-30", ...override }] });
    assert.equal(mismatch.length, 1);
    assert.notEqual(mismatch[0].status, "done");
  }
});

test("occurrence overrides determine ambiguity separately from the series identity", () => {
  const teacherB = { ...newLp, id: "LP-B", fields: { ...newLp.fields, teacher: "Teacher B" } };
  const actual = { ...booking, teacherId: "T-2", recurring: true, repeatCount: 2, occurrenceOverrides: [{ occurrenceId: "BOOK-1:2026-10-30", teacherId: "T-1" }] };
  const tasks = runOccurrenceBooking(actual, [newLp, teacherB]);
  const firstA = tasks.find((task) => task.anchorBookingId === newLp.id && task.ruleKey === "lp.first-lesson-finalize-n2");
  const firstB = tasks.find((task) => task.anchorBookingId === teacherB.id && task.ruleKey === "lp.first-lesson-finalize-n2");
  assert.equal(firstA?.dueAt, "2026-10-28T07:00:00.000Z");
  assert.equal(firstB?.dueAt, "2026-11-04T07:00:00.000Z");
  const ambiguous = runOccurrenceBooking(actual, [newLp, { ...newLp, id: "LP-DUPLICATE" }]);
  assert.ok(ambiguous.every((task) => task.ruleKey === "lp.scheduling" && task.status !== "done"));
});

test("cancelling the only matching override does not satisfy first scheduling", () => {
  const actual = { ...booking, teacherId: "T-2", recurring: true, repeatCount: 2, occurrenceOverrides: [{ occurrenceId: "BOOK-1:2026-10-30", teacherId: "T-1", status: "cancelled" as const }] };
  const tasks = runOccurrenceBooking(actual);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].ruleKey, "lp.scheduling");
  assert.notEqual(tasks[0].status, "done");
});

test("a later LP request cannot displace the earlier LP's first lesson or reopen its scheduling", () => {
  const first = { ...booking, date: "2026-10-22" };
  const before = reconcileAllLpParentProgressTasks({ tasks: [], lps: [newLp], bookings: [first], teachers, now });
  const later = {
    ...newLp, id: "LP-LATER", requestedAt: "2026-10-20T03:00:00.000Z",
    fields: { ...newLp.fields, requestSentAt: "2026-10-23T03:00:00.000Z" },
  };
  const after = reconcileAllLpParentProgressTasks({ tasks: before, lps: [newLp, later], bookings: [first], teachers, now: "2026-10-23T04:00:00.000Z" });
  assert.deepEqual(after.filter((task) => task.anchorBookingId === newLp.id), before);
  const waiting = after.filter((task) => task.anchorBookingId === later.id);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].ruleKey, "lp.scheduling");
  assert.notEqual(waiting[0].status, "done");
});

test("only exact eligible request instants let another LP compete for an occurrence", () => {
  const first = { ...booking, date: "2026-10-22" };
  const noIntakeFields = { teacher: "Teacher A", subject: "English", preparationFollowUp: "是" };
  const competitors = [
    { ...newLp, id: "LATER", fields: noIntakeFields, requestedAt: "2026-10-23T03:00:00.000Z" },
    { ...newLp, id: "UNKNOWN", fields: noIntakeFields },
    { ...newLp, id: "DATE-ONLY", fields: noIntakeFields, requestedAt: "2026-10-21" },
  ];
  const tasks = reconcileAllLpParentProgressTasks({ tasks: [], lps: [newLp, ...competitors], bookings: [first], teachers, now });
  assert.equal(tasks.find((task) => task.anchorBookingId === newLp.id && task.ruleKey === "lp.scheduling")?.result, LP_BUSINESS_SCHEDULED_RESULT);
});

test("duplicate teacher names cannot bind either roster identity through a name-valued LP", () => {
  const duplicateRoster = [{ id: "T-1", name: "Teacher A" }, { id: "T-2", name: "Teacher A" }];
  for (const teacherId of ["T-1", "T-2"]) {
    const tasks = reconcileAllLpParentProgressTasks({ tasks: [], lps: [newLp], bookings: [{ ...booking, teacherId, sourceTeacherName: "Teacher A" }], teachers: duplicateRoster, now });
    assert.equal(tasks.length, 1);
    assert.notEqual(tasks[0].status, "done");
  }
});

test("an exact teacher ID remains specific even when roster names are duplicated", () => {
  const duplicateRoster = [{ id: "T-1", name: "Teacher A" }, { id: "T-2", name: "Teacher A" }];
  const identified = { ...newLp, fields: { ...newLp.fields, teacher: "T-1" } };
  const matching = reconcileAllLpParentProgressTasks({ tasks: [], lps: [identified], bookings: [booking], teachers: duplicateRoster, now });
  assert.equal(matching.find((task) => task.ruleKey === "lp.scheduling")?.result, LP_BUSINESS_SCHEDULED_RESULT);
  const other = reconcileAllLpParentProgressTasks({ tasks: [], lps: [identified], bookings: [{ ...booking, teacherId: "T-2" }], teachers: duplicateRoster, now });
  assert.equal(other.length, 1);
  assert.notEqual(other[0].status, "done");
});

test("source teacher text cannot invent an identity while an explicit LP binding remains authoritative", () => {
  const unknownTeacher = { ...booking, teacherId: "EXTERNAL-UNKNOWN", sourceTeacherName: "Teacher A" };
  const pending = runOccurrenceBooking(unknownTeacher);
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].status, "done");
  const bound = runOccurrenceBooking({ ...unknownTeacher, lpId: newLp.id });
  assert.equal(bound.find((task) => task.ruleKey === "lp.scheduling")?.result, LP_BUSINESS_SCHEDULED_RESULT);
});
