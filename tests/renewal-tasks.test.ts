import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TEACHING_CONTROL_WATCHER, type OpsTask } from "../lib/ops-tasks";
import {
  buildRenewalDateNote,
  calculateRenewalTaskDueAt,
  generateRenewalTask,
  reconcileRenewalTasks,
  RENEWAL_COMPLETED_RESULT,
  RENEWAL_INACTIVE_RESULT,
  RENEWAL_NOT_DUE_RESULT,
  RENEWAL_TASK_RULE_KEY,
  renewalProjectionStateForStudent,
  renewalTaskAnchor,
  renewalStatusForPackage,
} from "../lib/renewal-tasks";

const NOW = "2026-08-10T00:00:00.000Z";

function projection(overrides: Record<string, unknown> = {}) {
  return {
    studentId: "STU-1",
    packageId: "PKG-1",
    packageName: "数学 20 小时",
    owner: "Abby",
    depletionAt: "2026-08-20T09:00:00.000Z",
    status: "active" as const,
    ...overrides,
  };
}

function legacyTask(overrides: Partial<OpsTask> = {}): OpsTask {
  return {
    id: "legacy",
    title: "旧任务",
    owner: "Abby",
    studentId: "STU-LEGACY",
    due: "等待确认",
    status: "waiting",
    tone: "blue",
    category: "续课",
    trigger: "旧任务没有规则字段",
    ...overrides,
  };
}

test("uses a collision-safe stable anchor for each student and package", () => {
  assert.equal(renewalTaskAnchor("STU:1", "PKG / A"), "renewal:STU%3A1:PKG%20%2F%20A");
  assert.notEqual(renewalTaskAnchor("STU-1", "PKG-1"), renewalTaskAnchor("STU-1", "PKG-2"));
});

test("keeps one package task and puts depletion evidence in its trigger", () => {
  const task = generateRenewalTask(projection({
    renewalDateNote: "预计由 Local English 课耗尽",
  }), { now: NOW });
  assert.ok(task);
  assert.equal(task.anchorBookingId, renewalTaskAnchor("STU-1", "PKG-1"));
  assert.equal(task.title, "课包续课跟进 · 数学 20 小时");
  assert.equal(task.trigger, "预计由 Local English 课耗尽");
  assert.equal(generateRenewalTask(projection(), { now: NOW })?.anchorBookingId, renewalTaskAnchor("STU-1", "PKG-1"));
});

test("automatic renewal notes explain subject, insufficient balance, and a lesson within seven days", () => {
  assert.equal(buildRenewalDateNote({
    depletionSubjectId: "Math",
    remainingHours: 0.5,
    depletionLessonHours: 1,
    nextLessonAfterDepletion: { subjectId: "English", date: "2026-08-22", start: "10:30", withinSevenDays: true },
  }), "预计由 Math 课耗尽；当前余额 0.5 小时，不足耗尽课次 1 小时；耗尽后下一节 English 课：2026-08-22 10:30（不足 7 天）");
  assert.equal(buildRenewalDateNote({
    remainingHours: 0.5,
    nextScheduledLesson: { subjectId: "Math", date: "2026-08-20", start: "09:00", hours: 1 },
  }), "当前余额 0.5 小时，不足下一节 Math 课 1 小时");
});

test("generates one active renewal task at depletion with explicit recipients", () => {
  const task = generateRenewalTask(projection(), { now: NOW });
  assert.ok(task);
  assert.equal(task.ruleKey, RENEWAL_TASK_RULE_KEY);
  assert.equal(task.anchorBookingId, renewalTaskAnchor("STU-1", "PKG-1"));
  assert.equal(task.category, "续课");
  assert.equal(task.dueAt, "2026-08-20T09:00:00.000Z");
  assert.equal(task.status, "upcoming");
  assert.deepEqual(task.assignees, ["Abby"]);
  assert.deepEqual(task.watchers, [DEFAULT_TEACHING_CONTROL_WATCHER]);
  assert.equal(generateRenewalTask(projection({ status: "renewed" }), { now: NOW }), null);
});

test("supports an explicit lead time and clamps a stale deadline just after now", () => {
  assert.equal(
    calculateRenewalTaskDueAt("2026-08-20T09:00:00.000Z", NOW, 8).toISOString(),
    "2026-08-12T09:00:00.000Z",
  );
  assert.equal(
    calculateRenewalTaskDueAt("2026-08-09T09:00:00.000Z", NOW).toISOString(),
    "2026-08-10T00:00:00.001Z",
  );
  assert.throws(() => calculateRenewalTaskDueAt("2026-08-20T09:00:00.000Z", NOW, -1), /non-negative integer/);
});

test("reconciles multiple packages to one independent task each", () => {
  const tasks = reconcileRenewalTasks([], [
    projection(),
    projection({ packageId: "PKG-2", packageName: "英语 10 小时", depletionAt: "2026-08-18T09:00:00.000Z" }),
  ], { now: NOW });
  assert.equal(tasks.length, 2);
  assert.equal(new Set(tasks.map((task) => task.anchorBookingId)).size, 2);
  assert.deepEqual(tasks.map((task) => task.anchorBookingId), [
    renewalTaskAnchor("STU-1", "PKG-2"),
    renewalTaskAnchor("STU-1", "PKG-1"),
  ]);
});

test("resolves renewal state by student and package without spreading one package across siblings", () => {
  const records = [
    { studentId: "STU-1", packageId: "PKG-1", status: "renewed" as const },
    { studentId: "STU-1", packageId: "PKG-2", status: "not_renewed_active" as const },
  ];
  assert.equal(renewalStatusForPackage(records, { studentId: "STU-1", packageId: "PKG-1", packageCount: 2 }), "renewed");
  assert.equal(renewalStatusForPackage(records, { studentId: "STU-1", packageId: "PKG-2", packageCount: 2 }), "not_renewed_active");

  const legacy = [{ studentId: "STU-1", status: "renewed" as const }];
  assert.equal(renewalStatusForPackage(legacy, { studentId: "STU-1", packageId: "ONLY", packageCount: 1 }), "renewed");
  assert.equal(renewalStatusForPackage(legacy, { studentId: "STU-1", packageId: "PKG-1", packageCount: 2 }), undefined);

});

test("student activity explicitly closes and later rebuilds the stable automatic package task", () => {
  assert.equal(renewalProjectionStateForStudent("not_renewed_active", false), "inactive");
  assert.equal(renewalProjectionStateForStudent("not_renewed_inactive", true), "active");
  assert.equal(renewalProjectionStateForStudent("not_renewed_exam_finished", true), "active");
  assert.equal(renewalProjectionStateForStudent("renewed", true), "renewed");
  assert.equal(renewalProjectionStateForStudent("renewed", false), "renewed");

  const active = reconcileRenewalTasks([], [projection()], { now: NOW, idFactory: () => "stable-activity-id" });
  const inactive = reconcileRenewalTasks(active, [projection({
    status: renewalProjectionStateForStudent("not_renewed_active", false),
  })], { now: "2026-08-11T00:00:00.000Z" });
  assert.equal(inactive[0].result, RENEWAL_INACTIVE_RESULT);
  const restored = reconcileRenewalTasks(inactive, [projection({
    status: renewalProjectionStateForStudent("not_renewed_inactive", true),
  })], { now: "2026-08-12T00:00:00.000Z", idFactory: () => "discarded-id" });
  assert.equal(restored[0].id, "stable-activity-id");
  assert.notEqual(restored[0].status, "done");
  assert.equal(restored[0].result, undefined);
});

test("legacy subject statuses never decide a shared package task in either source order", () => {
  const mathRenewed = {
    studentId: "STU-1",
    packageId: "PKG-1",
    subjectId: "Math",
    status: "renewed" as const,
  };
  const englishActive = {
    studentId: "STU-1",
    packageId: "PKG-1",
    subjectId: "English",
    status: "not_renewed_active" as const,
  };

  for (const records of [
    [mathRenewed, englishActive],
    [englishActive, mathRenewed],
  ]) {
    const status = renewalStatusForPackage(records, {
      studentId: "STU-1",
      packageId: "PKG-1",
      packageCount: 1,
    });
    assert.equal(status, undefined);
    const tasks = reconcileRenewalTasks([], [projection({
      status: status ?? "not_renewed_active",
    })], { now: NOW });
    assert.equal(tasks.length, 1);
    assert.notEqual(tasks[0].status, "done");
  }
});

test("legacy subject-anchor tasks close safely when the package task is reconciled", () => {
  const legacySubjectTasks = ["MATH", "ENGLISH"].map((subject): OpsTask => ({
    ...legacyTask(),
    id: `legacy-${subject}`,
    studentId: "STU-1",
    ruleKey: RENEWAL_TASK_RULE_KEY,
    anchorBookingId: `renewal:STU-1:PKG-1:subject:${subject}`,
  }));
  const reconciled = reconcileRenewalTasks(legacySubjectTasks, [projection()], {
    now: NOW,
    scopeStudentIds: ["STU-1"],
  });
  assert.equal(reconciled.filter((task) => task.anchorBookingId?.includes(":subject:") && task.result === RENEWAL_NOT_DUE_RESULT).length, 2);
  assert.equal(reconciled.filter((task) => task.anchorBookingId === renewalTaskAnchor("STU-1", "PKG-1")).length, 1);
});

test("renewing one package closes only that package task", () => {
  const initialProjections = [
    projection(),
    projection({ packageId: "PKG-2", packageName: "英语 10 小时" }),
  ];
  const active = reconcileRenewalTasks([], initialProjections, { now: NOW, scopeStudentIds: ["STU-1"] });
  const statusRecords = [
    { studentId: "STU-1", packageId: "PKG-1", status: "renewed" as const },
    { studentId: "STU-1", packageId: "PKG-2", status: "not_renewed_active" as const },
  ];
  const reconciled = reconcileRenewalTasks(active, initialProjections.map((entry) => ({
    ...entry,
    status: renewalStatusForPackage(statusRecords, {
      studentId: entry.studentId,
      packageId: entry.packageId,
      packageCount: 2,
    }),
  })), { now: "2026-08-11T00:00:00.000Z", scopeStudentIds: ["STU-1"] });

  assert.equal(reconciled.find((task) => task.anchorBookingId === renewalTaskAnchor("STU-1", "PKG-1"))?.result, RENEWAL_COMPLETED_RESULT);
  assert.notEqual(reconciled.find((task) => task.anchorBookingId === renewalTaskAnchor("STU-1", "PKG-2"))?.status, "done");
});

test("depletion and owner changes update the stable task without duplication", () => {
  const first = reconcileRenewalTasks([], [projection()], {
    now: NOW,
    idFactory: () => "stable-generated-id",
  });
  const updated = reconcileRenewalTasks(first, [projection({
    owner: "Molly",
    depletionAt: "2026-08-25T09:00:00.000Z",
  })], {
    now: NOW,
    idFactory: () => "discarded-new-id",
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, "stable-generated-id");
  assert.equal(updated[0].dueAt, "2026-08-25T09:00:00.000Z");
  assert.equal(updated[0].owner, "Molly");
  assert.deepEqual(updated[0].assignees, ["Molly"]);
});

test("renewed and inactive statuses close an existing task but do not create empty history", () => {
  const active = reconcileRenewalTasks([], [projection()], { now: NOW });
  const renewed = reconcileRenewalTasks(active, [projection({ status: "已续课" })], {
    now: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0].status, "done");
  assert.equal(renewed[0].tone, "green");
  assert.equal(renewed[0].result, RENEWAL_COMPLETED_RESULT);
  assert.equal(renewed[0].closedAt, "2026-08-11T00:00:00.000Z");

  const inactive = reconcileRenewalTasks(active, [projection({ status: "not_renewed_inactive" })], {
    now: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(inactive[0].result, RENEWAL_INACTIVE_RESULT);
  assert.deepEqual(reconcileRenewalTasks([], [projection({ status: "inactive" })], { now: NOW }), []);
});

test("reactivating an automatically closed package reuses its id", () => {
  const active = reconcileRenewalTasks([], [projection()], { now: NOW, idFactory: () => "keep-id" });
  const closed = reconcileRenewalTasks(active, [projection({ status: "inactive" })], {
    now: "2026-08-11T00:00:00.000Z",
  });
  const reopened = reconcileRenewalTasks(closed, [projection({ depletionAt: "2026-08-26T09:00:00.000Z" })], {
    now: "2026-08-12T00:00:00.000Z",
    idFactory: () => "new-id",
  });
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].id, "keep-id");
  assert.notEqual(reopened[0].status, "done");
  assert.equal(reopened[0].result, undefined);
});

test("a human-completed task is never reopened or overwritten", () => {
  const [generated] = reconcileRenewalTasks([], [projection()], { now: NOW });
  const completed = {
    ...generated,
    status: "done" as const,
    tone: "green" as const,
    result: "家长已明确回复",
    closedAt: "2026-08-11T03:00:00.000Z",
  };
  const changed = reconcileRenewalTasks([completed], [projection({
    owner: "Molly",
    depletionAt: "2026-08-28T09:00:00.000Z",
  })], { now: "2026-08-12T00:00:00.000Z" });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, "done");
  assert.equal(changed[0].result, "家长已明确回复");
  assert.equal(changed[0].closedAt, "2026-08-11T03:00:00.000Z");
  assert.equal(changed[0].dueAt, "2026-08-28T09:00:00.000Z");
  assert.equal(changed[0].owner, "Molly");

  const terminal = reconcileRenewalTasks(changed, [projection({
    owner: "Molly",
    status: "已续课",
  })], { now: "2026-08-13T00:00:00.000Z" });
  assert.equal(terminal[0].result, "家长已明确回复");
  assert.equal(terminal[0].closedAt, "2026-08-11T03:00:00.000Z");
});

test("closes missing package projections in scope and reopens only their automatic tasks", () => {
  const initial = reconcileRenewalTasks([], [
    projection(),
    projection({ packageId: "PKG-2", packageName: "英语 10 小时" }),
  ], { now: NOW, scopeStudentIds: ["STU-1"] });
  const humanCompleted = {
    ...initial.find((task) => task.anchorBookingId === renewalTaskAnchor("STU-1", "PKG-2"))!,
    status: "done" as const,
    tone: "green" as const,
    result: "家长已明确回复",
    closedAt: "2026-08-10T12:00:00.000Z",
  };
  const current = initial.map((task) => task.anchorBookingId === humanCompleted.anchorBookingId ? humanCompleted : task);

  const missing = reconcileRenewalTasks(current, [], {
    now: "2026-08-11T00:00:00.000Z",
    scopeStudentIds: ["STU-1"],
  });
  const automatic = missing.find((task) => task.anchorBookingId === renewalTaskAnchor("STU-1", "PKG-1"));
  assert.equal(automatic?.status, "done");
  assert.equal(automatic?.result, RENEWAL_NOT_DUE_RESULT);
  assert.equal(missing.find((task) => task.anchorBookingId === humanCompleted.anchorBookingId)?.result, "家长已明确回复");

  const reopened = reconcileRenewalTasks(missing, [projection({ depletionAt: "2026-08-30T09:00:00.000Z" })], {
    now: "2026-08-12T00:00:00.000Z",
    scopeStudentIds: ["STU-1"],
  });
  const restored = reopened.find((task) => task.anchorBookingId === renewalTaskAnchor("STU-1", "PKG-1"));
  assert.notEqual(restored?.status, "done");
  assert.equal(restored?.result, undefined);
  assert.equal(reopened.find((task) => task.anchorBookingId === humanCompleted.anchorBookingId)?.result, "家长已明确回复");
});

test("an empty scoped projection set never closes another student's task", () => {
  const own = reconcileRenewalTasks([], [projection()], { now: NOW });
  const other = reconcileRenewalTasks([], [projection({ studentId: "STU-2", packageId: "PKG-2" })], { now: NOW });
  const reconciled = reconcileRenewalTasks([...own, ...other], [], {
    now: "2026-08-11T00:00:00.000Z",
    scopeStudentIds: ["STU-1"],
  });
  assert.equal(reconciled.find((task) => task.studentId === "STU-1")?.result, RENEWAL_NOT_DUE_RESULT);
  assert.notEqual(reconciled.find((task) => task.studentId === "STU-2")?.status, "done");
});

test("legacy tasks remain untouched while a matching owner-only rule task is enriched", () => {
  const unrelated = legacyTask();
  const matching = legacyTask({
    id: "legacy-rule-id",
    studentId: "STU-1",
    ruleKey: RENEWAL_TASK_RULE_KEY,
    anchorBookingId: renewalTaskAnchor("STU-1", "PKG-1"),
    dueAt: "2026-08-19T09:00:00.000Z",
  });
  const result = reconcileRenewalTasks([unrelated, matching], [projection()], { now: NOW });
  assert.equal(result.find((task) => task.id === "legacy")?.trigger, "旧任务没有规则字段");
  const enriched = result.find((task) => task.id === "legacy-rule-id");
  assert.deepEqual(enriched?.assignees, ["Abby"]);
  assert.deepEqual(enriched?.watchers, [DEFAULT_TEACHING_CONTROL_WATCHER]);
  assert.equal(enriched?.dueAt, "2026-08-20T09:00:00.000Z");
});

test("rejects duplicate package projections and malformed required data", () => {
  assert.throws(
    () => reconcileRenewalTasks([], [projection(), projection()], { now: NOW }),
    /duplicate renewal projection/,
  );
  assert.throws(() => generateRenewalTask(projection({ owner: "" }), { now: NOW }), /owner is required/);
  assert.throws(() => generateRenewalTask(projection({ depletionAt: "bad" }), { now: NOW }), /depletionAt/);
  assert.throws(() => generateRenewalTask(projection({ renewalDateNote: "" }), { now: NOW }), /renewalDateNote/);
});
