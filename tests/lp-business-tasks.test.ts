import assert from "node:assert/strict";
import test from "node:test";
import { LP_BUSINESS_CLOSED_RESULT, LP_BUSINESS_SCHEDULED_RESULT, LP_MODIFICATION_REVIEW_ADVANCED_RESULT } from "../lib/lp-business-tasks";
import { eligibleLpParentProgressRecords, reconcileAllLpParentProgressTasks, reconcileLpParentProgressTasks, type LpParentProgressRecord } from "../lib/lp-parent-progress-service";
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
