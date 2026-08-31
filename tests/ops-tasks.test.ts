import assert from "node:assert/strict";
import test from "node:test";

import {
  closeTrialEscalationTasks,
  closeStudentLpLifecycleTasks,
  closeTasksForBooking,
  DEFAULT_TEACHING_CONTROL_WATCHER,
  deterministicTaskId,
  formatCompactTaskDeadline,
  formatTaskDeadline,
  generateTrialBookingTasks,
  generateTrialEscalationTasks,
  generateTrialRequestTasks,
  isTrialAcceptanceFixtureTask,
  linkTrialRequestTasksToBooking,
  OpsTask,
  reconcileTrialBookingTasks,
  refreshTaskStatus,
  restoreTrialRequestTasksToWorkflow,
  RuleBoundTask,
  sortTasksByDueAt,
  statusForDueAt,
  taskTitlePresentation,
  TASK_SPACING_MS,
  TaskCategory,
  TRIAL_MANAGED_TASK_RULES,
  TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT,
  TRIAL_ESCALATION_TASK_RULES,
  TRIAL_REQUEST_TASK_RULES,
  TRIAL_RULE_NO_LONGER_APPLICABLE_RESULT,
  TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT,
  TRIAL_SHORT_NOTICE_TASK_RULES,
  TRIAL_STANDARD_TASK_RULES,
  upsertTaskByRule,
} from "../lib/ops-tasks";

test("task categories retain every legacy UI value and include exam and cover workflows", () => {
  const categories = ["试听", "LP", "排课", "课后", "续课", "薪资", "资料", "考试", "请假代课"] satisfies TaskCategory[];
  assert.deepEqual(categories.slice(0, 7), ["试听", "LP", "排课", "课后", "续课", "薪资", "资料"]);
  assert.deepEqual(categories.slice(7), ["考试", "请假代课"]);
});

function ruleTask(overrides: Partial<RuleBoundTask> = {}): RuleBoundTask {
  return {
    id: "new-id",
    title: "Task",
    owner: "Abby",
    studentId: "STU-1",
    due: "2026-08-13 10:00",
    dueAt: "2026-08-13T00:00:00.000Z",
    status: "upcoming",
    tone: "blue",
    category: "试听",
    trigger: "test",
    ruleKey: "trial.lp-review",
    anchorBookingId: "BOOK-1",
    ...overrides,
  };
}

test("status uses the Melbourne calendar date, including its midnight boundary", () => {
  assert.equal(statusForDueAt("2026-08-12T14:30:00.000Z", "2026-08-12T13:30:00.000Z"), "upcoming");
  assert.equal(statusForDueAt("2026-08-12T14:30:00.000Z", "2026-08-12T15:30:00.000Z"), "today");
  assert.equal(statusForDueAt("2026-08-12T13:30:00.000Z", "2026-08-12T14:30:00.000Z"), "overdue");

  // Melbourne is UTC+11 in January, so these two UTC dates are one local day.
  assert.equal(statusForDueAt("2026-01-04T23:30:00.000Z", "2026-01-04T22:00:00.000Z"), "today");
});

test("formats the canonical task deadline as an exact Melbourne date and time", () => {
  assert.equal(
    formatTaskDeadline("2026-08-19T08:00:00.000Z"),
    "2026年8月19日 18:00",
  );
  // Melbourne observes daylight saving in January, so the same wall-clock
  // deadline has a different UTC offset.
  assert.equal(
    formatTaskDeadline("2026-01-04T07:00:00.000Z"),
    "2026年1月4日 18:00",
  );
  assert.equal(
    formatTaskDeadline("2026-01-04T07:00:00.000Z", "Australia/Melbourne", "12h"),
    "2026年1月4日 下午06:00",
  );
  assert.equal(formatTaskDeadline("not-a-deadline"), undefined);
  assert.equal(formatTaskDeadline(undefined), undefined);
});

test("formats a compact task-list deadline without year or time", () => {
  assert.equal(formatCompactTaskDeadline("2026-08-19T08:00:00.000Z"), "8月19日");
  assert.equal(formatCompactTaskDeadline("2026-08-19T14:30:00.000Z", "Asia/Shanghai"), "8月19日");
  assert.equal(formatCompactTaskDeadline("not-a-deadline"), undefined);
});

test("presents handbook action text as the headline and angle-bracket context as details", () => {
  assert.deepEqual(
    taskTitlePresentation("《教务+教统》【试听待排课】<Heather孙晓琳> <Daisy>"),
    { primary: "【试听待排课】", details: ["Heather孙晓琳", "Daisy"] },
  );
  assert.deepEqual(taskTitlePresentation("普通内部任务"), { primary: "普通内部任务", details: [] });
});

test("presents retained legacy trial history with the current bracketed visual hierarchy", () => {
  assert.deepEqual(
    taskTitlePresentation("试听 LP：核对交接信息 <历史学生>"),
    { primary: "【试听 LP 交接】", details: ["历史学生"] },
  );
  assert.deepEqual(taskTitlePresentation("完成试听排课"), { primary: "【试听待排课】", details: [] });
  assert.deepEqual(taskTitlePresentation("审核试听 LP"), { primary: "【LP 定稿】", details: [] });
  assert.deepEqual(taskTitlePresentation("紧急审核试听 LP"), { primary: "【今日 LP 定稿】", details: [] });
  assert.deepEqual(
    taskTitlePresentation("确认老师备课内容与资料"),
    { primary: "【跟进老师备课内容】", details: [] },
  );
  assert.deepEqual(
    taskTitlePresentation("向家长同步试听安排进度（第 2 次）"),
    { primary: "【二次向家长交待排课进度】", details: [] },
  );
  assert.deepEqual(
    taskTitlePresentation("将 LP 发审核群并发给老师"),
    { primary: "【将 LP 发审核群并发给老师】", details: [] },
  );
  assert.deepEqual(
    taskTitlePresentation("旧版首次交接任务", "student.initial-handover"),
    { primary: "【学生信息交接】", details: [] },
  );
  assert.deepEqual(
    taskTitlePresentation("旧版创建任务", "student.create-lp"),
    { primary: "【创建 LP】", details: [] },
  );
});

test("identifies only the retained named acceptance fixture for task-board hiding", () => {
  assert.equal(isTrialAcceptanceFixtureTask({ title: "【试听待排课】<QA 系统验收 20260827>" }), true);
  assert.equal(isTrialAcceptanceFixtureTask({ title: "普通历史任务" }, "QA 系统验收 20260827"), true);
  assert.equal(isTrialAcceptanceFixtureTask({ title: "普通历史任务" }, "真实学生"), false);
  assert.equal(isTrialAcceptanceFixtureTask({ title: "QA 系统验收 20260828" }), false);
});

test("refresh preserves completed tasks and recalculates active tasks", () => {
  const active = refreshTaskStatus(ruleTask({ status: "waiting" }), "2026-08-14T00:00:00.000Z");
  const done = refreshTaskStatus(ruleTask({ status: "done" }), "2026-08-14T00:00:00.000Z");
  assert.equal(active.status, "overdue");
  assert.equal(done.status, "done");
});

test("sorts by dueAt stably and puts legacy or malformed dates last", () => {
  const tasks: OpsTask[] = [
    ruleTask({ id: "later", dueAt: "2026-08-14T00:00:00.000Z" }),
    ruleTask({ id: "legacy", dueAt: undefined, ruleKey: undefined, anchorBookingId: undefined }),
    ruleTask({ id: "first-tie", dueAt: "2026-08-12T00:00:00.000Z" }),
    ruleTask({ id: "second-tie", dueAt: "2026-08-12T00:00:00.000Z" }),
    ruleTask({ id: "malformed", dueAt: "not-a-date" }),
  ];
  assert.deepEqual(sortTasksByDueAt(tasks).map((task) => task.id), [
    "first-tie",
    "second-tie",
    "later",
    "legacy",
    "malformed",
  ]);
  assert.deepEqual(tasks.map((task) => task.id), ["later", "legacy", "first-tie", "second-tie", "malformed"]);
});

test("upsert deduplicates by ruleKey plus anchorBookingId and reuses the first id", () => {
  const current = [
    ruleTask({ id: "keep-id", dueAt: "2026-08-13T00:00:00.000Z" }),
    ruleTask({ id: "duplicate-id", dueAt: "2026-08-14T00:00:00.000Z" }),
    ruleTask({ id: "other-booking", anchorBookingId: "BOOK-2" }),
  ];
  const result = upsertTaskByRule(
    current,
    ruleTask({ id: "discard-new-id", title: "Recalculated", dueAt: "2026-08-20T00:00:00.000Z" }),
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "keep-id");
  assert.equal(result[0].title, "Recalculated");
  assert.equal(result[0].dueAt, "2026-08-20T00:00:00.000Z");
  assert.equal(result[1].id, "other-booking");
});

test("upsert never reopens a completed rule task", () => {
  const result = upsertTaskByRule(
    [ruleTask({ id: "completed-id", status: "done", tone: "green", result: "Handled" })],
    ruleTask({ id: "new-id", status: "upcoming", tone: "red", dueAt: "2026-08-20T00:00:00.000Z" }),
  );
  assert.equal(result[0].id, "completed-id");
  assert.equal(result[0].dueAt, "2026-08-20T00:00:00.000Z");
  assert.equal(result[0].status, "done");
  assert.equal(result[0].tone, "green");
  assert.equal(result[0].result, "Handled");
});

test("upsert prefers a completed duplicate even when it is not the first match", () => {
  const result = upsertTaskByRule(
    [
      ruleTask({ id: "unfinished-first", status: "upcoming", tone: "red" }),
      ruleTask({
        id: "completed-second",
        status: "done",
        tone: "green",
        result: "Sent to parent",
        closedAt: "2026-08-12T01:02:03.000Z",
      }),
    ],
    ruleTask({
      id: "new-id",
      status: "upcoming",
      tone: "blue",
      dueAt: "2026-08-20T00:00:00.000Z",
    }),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "completed-second");
  assert.equal(result[0].status, "done");
  assert.equal(result[0].tone, "green");
  assert.equal(result[0].result, "Sent to parent");
  assert.equal(result[0].closedAt, "2026-08-12T01:02:03.000Z");
  assert.equal(result[0].dueAt, "2026-08-20T00:00:00.000Z");
});

test("upsert keeps manual tasks without rule metadata and rejects an unkeyed incoming task", () => {
  const manual = ruleTask({
    id: "manual",
    ruleKey: undefined as unknown as string,
    anchorBookingId: undefined as unknown as string,
  });
  const result = upsertTaskByRule([manual, ruleTask({ id: "existing" })], ruleTask({ title: "Updated" }));
  assert.equal(result[0].id, "manual");
  assert.equal(result[1].id, "existing");
  assert.equal(result[1].title, "Updated");
  assert.throws(() => upsertTaskByRule([manual], manual), /requires ruleKey and anchorBookingId/);
});

test("LP creation closes only this student's open create-LP task idempotently", () => {
  const tasks = [
    ruleTask({ id: "create-open", studentId: "STU-1", ruleKey: "student.create-lp", status: "today" }),
    ruleTask({ id: "create-duplicate", studentId: "STU-1", ruleKey: "student.create-lp", status: "upcoming" }),
    ruleTask({ id: "create-done", studentId: "STU-1", ruleKey: "student.create-lp", status: "done", result: "历史人工完成", closedAt: "2026-08-10T00:00:00.000Z" }),
    ruleTask({ id: "other-student", studentId: "STU-2", ruleKey: "student.create-lp", status: "today" }),
    ruleTask({ id: "other-rule", studentId: "STU-1", ruleKey: "student.initial-handover", status: "today" }),
  ];
  const completed = closeStudentLpLifecycleTasks(tasks, {
    studentId: "STU-1",
    workflowType: "老师新 LP",
    isFirstWorkflow: false,
    closedAt: "2026-08-20T01:02:03.000Z",
  });

  assert.deepEqual(completed.map((task) => [task.id, task.status]), [
    ["create-open", "done"],
    ["create-duplicate", "done"],
    ["create-done", "done"],
    ["other-student", "today"],
    ["other-rule", "today"],
  ]);
  assert.equal(completed[0].closedAt, "2026-08-20T01:02:03.000Z");
  assert.equal(completed[2].result, "历史人工完成");
  assert.deepEqual(
    closeStudentLpLifecycleTasks(completed, {
      studentId: "STU-1",
      workflowType: "老师新 LP",
      isFirstWorkflow: false,
      closedAt: "2026-08-20T01:02:03.000Z",
    }),
    completed,
  );
});

test("initial handover closes only after an audited first trial/enrollment workflow", () => {
  const openTasks = [
    ruleTask({ id: "initial", studentId: "STU-1", ruleKey: "student.initial-handover", status: "today" }),
    ruleTask({ id: "create", studentId: "STU-1", ruleKey: "student.create-lp", status: "today" }),
  ];
  const laterWorkflow = closeStudentLpLifecycleTasks(openTasks, {
    studentId: "STU-1",
    workflowType: "老师 LP 修改",
    isFirstWorkflow: false,
    closedAt: "2026-08-20T01:02:03.000Z",
  });
  assert.equal(laterWorkflow.find((task) => task.id === "initial")?.status, "today");
  assert.equal(laterWorkflow.find((task) => task.id === "create")?.status, "done");

  const firstTrial = closeStudentLpLifecycleTasks(openTasks, {
    studentId: "STU-1",
    workflowType: "试听 LP",
    isFirstWorkflow: true,
    closedAt: "2026-08-20T01:02:03.000Z",
  });
  assert.equal(firstTrial.find((task) => task.id === "initial")?.status, "done");
  assert.equal(firstTrial.find((task) => task.id === "create")?.status, "done");
});

test("trial request immediately creates stable same-day 18:00 and scheduling +24h tasks", () => {
  const input = {
    anchorBookingId: "WORKFLOW-1",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z", // 10:00 Melbourne
    now: "2026-08-10T00:00:00.000Z",
  } as const;
  const tasks = generateTrialRequestTasks(input);
  assert.deepEqual(tasks.map((task) => task.ruleKey), TRIAL_REQUEST_TASK_RULES);
  assert.deepEqual(tasks.map((task) => task.dueAt), [
    "2026-08-10T08:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
  ]);
  assert.deepEqual(tasks.map((task) => task.anchorBookingId), ["WORKFLOW-1", "WORKFLOW-1"]);
  assert.deepEqual(
    generateTrialRequestTasks(input).map((task) => task.id),
    tasks.map((task) => task.id),
  );
});

test("materializes stable 4h, 8h and recurring 24h escalation tasks", () => {
  const input = {
    anchorBookingId: "WORKFLOW-ESCALATION",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now: "2026-08-10T00:00:00.000Z",
    parentProgressSyncCount: 3,
  } as const;
  const tasks = generateTrialEscalationTasks(input);

  assert.deepEqual(tasks.map((task) => task.ruleKey), [
    ...TRIAL_ESCALATION_TASK_RULES,
    "trial.parent-progress-sync.1",
    "trial.parent-progress-sync.2",
    "trial.parent-progress-sync.3",
  ]);
  assert.deepEqual(tasks.map((task) => task.dueAt), [
    "2026-08-10T04:00:00.000Z",
    "2026-08-10T08:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
    "2026-08-12T00:00:00.000Z",
    "2026-08-13T00:00:00.000Z",
  ]);
  assert.deepEqual(
    generateTrialEscalationTasks(input).map((task) => task.id),
    tasks.map((task) => task.id),
  );
  const clientGenerated = generateTrialEscalationTasks({ ...input, idFactory: () => "random-client-id" });
  assert.equal(
    clientGenerated.find((task) => task.ruleKey === "trial.parent-progress-sync.1")?.id,
    deterministicTaskId(input.anchorBookingId, "trial.parent-progress-sync.1"),
  );
  tasks.forEach((task) => {
    assert.deepEqual(task.assignees, ["Abby"]);
    assert.deepEqual(task.watchers, [DEFAULT_TEACHING_CONTROL_WATCHER]);
  });
  assert.throws(
    () => generateTrialEscalationTasks({ ...input, parentProgressSyncCount: 366 }),
    /integer from 0 to 365/,
  );
});

test("closes every pending no-reply escalation after a parent reply without overwriting evidence", () => {
  const generated = generateTrialEscalationTasks({
    anchorBookingId: "WORKFLOW-PARENT-REPLIED",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now: "2026-08-10T00:00:00.000Z",
    parentProgressSyncCount: 2,
  });
  const completed = generated.map((task) => task.ruleKey === "trial.parent-no-reply-follow-up"
    ? { ...task, status: "done" as const, tone: "green" as const, result: "家长已回消息" }
    : task);
  const unrelated = ruleTask({ id: "unrelated", anchorBookingId: "OTHER" });
  const closed = closeTrialEscalationTasks([...completed, unrelated], {
    anchorBookingId: "WORKFLOW-PARENT-REPLIED",
    studentId: "STU-1",
    closedAt: "2026-08-10T09:00:00.000Z",
  });

  assert.equal(closed.find((task) => task.ruleKey === "trial.parent-no-reply-follow-up")?.result, "家长已回消息");
  for (const task of closed.filter((item) => item.anchorBookingId === "WORKFLOW-PARENT-REPLIED" && item.status === "done" && item.ruleKey !== "trial.parent-no-reply-follow-up")) {
    assert.equal(task.result, TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT);
    assert.equal(task.closedAt, "2026-08-10T09:00:00.000Z");
  }
  assert.equal(closed.find((task) => task.id === "unrelated")?.status, unrelated.status);
});

test("automatic trial tasks explicitly assign their owner and teaching-control watcher", () => {
  const tasks = [
    ...generateTrialRequestTasks({
      anchorBookingId: "WORKFLOW-RECIPIENTS",
      studentId: "STU-1",
      owner: "Abby",
      requestedAt: "2026-08-10T00:00:00.000Z",
      now: "2026-08-10T00:00:00.000Z",
    }),
    ...generateTrialBookingTasks({
      anchorBookingId: "BOOK-RECIPIENTS",
      studentId: "STU-1",
      owner: "Abby",
      requestedAt: "2026-08-10T00:00:00.000Z",
      now: "2026-08-10T00:00:00.000Z",
      trialStartsAt: "2026-08-20T09:00:00.000Z",
    }),
  ];

  tasks.forEach((task) => {
    assert.ok(task.assignees?.includes(task.owner));
    assert.deepEqual(task.watchers, [DEFAULT_TEACHING_CONTROL_WATCHER]);
  });
});

test("stale request deadlines use the exact creation instant", () => {
  const now = new Date("2026-08-13T00:00:00.000Z");
  const tasks = generateTrialRequestTasks({
    anchorBookingId: "WORKFLOW-LATE",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now,
  });
  const dueTimes = tasks.map((task) => Date.parse(task.dueAt));
  assert.deepEqual(dueTimes, [now.getTime(), now.getTime()]);
});

test("normal trial workflow uses same-day 18:00, +24h, and N-3/N-2/N-1 18:00", () => {
  const tasks = generateTrialBookingTasks({
    anchorBookingId: "BOOK-1",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z", // 10:00 Melbourne
    now: "2026-08-10T00:00:00.000Z",
    trialStartsAt: "2026-08-20T09:00:00.000Z", // 19:00 Melbourne
  });
  assert.deepEqual(tasks.map((task) => task.ruleKey), TRIAL_STANDARD_TASK_RULES);
  assert.deepEqual(tasks.map((task) => task.dueAt), [
    "2026-08-10T08:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
    "2026-08-17T08:00:00.000Z",
    "2026-08-18T08:00:00.000Z",
    "2026-08-19T08:00:00.000Z",
  ]);
  assert.deepEqual(tasks.map((task) => task.due), [
    "2026-08-10 18:00",
    "2026-08-11 10:00",
    "2026-08-17 18:00",
    "2026-08-18 18:00",
    "2026-08-19 18:00",
  ]);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 5);
  assert.equal(new Set(tasks.map((task) => task.dueAt)).size, 5);
  assert.match(tasks.find((task) => task.ruleKey === "trial.lp-review")?.trigger ?? "", /N-3/);
  assert.match(tasks.find((task) => task.ruleKey === "trial.prep")?.trigger ?? "", /N-2/);
});

test("18:00 rules remain correct when the trial crosses Melbourne daylight saving", () => {
  const tasks = generateTrialBookingTasks({
    anchorBookingId: "BOOK-DST",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-09-30T00:00:00.000Z",
    now: "2026-09-30T00:00:00.000Z",
    trialStartsAt: "2026-10-06T08:00:00.000Z", // 19:00 AEDT, after DST begins
  });
  assert.deepEqual(tasks.slice(2).map((task) => task.dueAt), [
    "2026-10-03T08:00:00.000Z", // 18:00 AEST
    "2026-10-04T07:00:00.000Z", // 18:00 AEDT
    "2026-10-05T07:00:00.000Z",
  ]);
});

test("a trial 71 hours away keeps distinct immediate LP-review and preparation tasks", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const trial = new Date(now.getTime() + 71 * TASK_SPACING_MS);
  const tasks = generateTrialBookingTasks({
    anchorBookingId: "BOOK-SHORT",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: now,
    now,
    trialStartsAt: trial,
  });
  assert.deepEqual(tasks.map((task) => task.ruleKey), TRIAL_SHORT_NOTICE_TASK_RULES);
  assert.equal(tasks.find((task) => task.ruleKey === "trial.lp-review")?.dueAt, "2026-08-10T00:00:00.000Z");
  assert.equal(tasks.find((task) => task.ruleKey === "trial.prep")?.dueAt, "2026-08-10T00:00:00.000Z");
  assert.match(tasks.find((task) => task.ruleKey === "trial.lp-review")?.trigger ?? "", /立即审核 LP/);
  assert.match(tasks.find((task) => task.ruleKey === "trial.prep")?.trigger ?? "", /立即确认备课/);
  assert.ok(tasks.every((task) => Date.parse(task.dueAt) < trial.getTime()));
  assert.ok(tasks.every((task) => !["trial.minimum", "trial.short-notice-prep"].includes(task.ruleKey)));
});

test("a trial under 24 hours clamps future request deadlines and keeps two urgent tasks", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const trial = new Date("2026-08-10T02:00:00.000Z");
  const tasks = generateTrialBookingTasks({
    anchorBookingId: "BOOK-LAST-MINUTE",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: now,
    now,
    trialStartsAt: trial,
  });
  const dueTimes = tasks.map((task) => Date.parse(task.dueAt));
  assert.deepEqual(tasks.map((task) => task.ruleKey), TRIAL_SHORT_NOTICE_TASK_RULES);
  assert.equal(dueTimes.length, 4);
  assert.equal(new Set(dueTimes).size, 1, "all immediate tasks share the real reconciliation instant");
  assert.ok(dueTimes.every((dueAt) => dueAt >= now.getTime() && dueAt < trial.getTime()));
  assert.equal(Date.parse(tasks[2].dueAt), now.getTime());
  assert.equal(Date.parse(tasks[3].dueAt), now.getTime());
});

test("short notice retains genuinely overdue request history", () => {
  const now = new Date("2026-08-13T00:00:00.000Z");
  const tasks = generateTrialBookingTasks({
    anchorBookingId: "BOOK-OVERDUE-SHORT",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now,
    trialStartsAt: "2026-08-13T02:00:00.000Z",
  });
  assert.deepEqual(tasks.slice(0, 2).map((task) => task.dueAt), [
    "2026-08-10T08:00:00.000Z",
    "2026-08-11T00:00:00.000Z",
  ]);
  assert.equal(tasks[2].ruleKey, "trial.lp-review");
  assert.equal(tasks[3].ruleKey, "trial.prep");
  assert.equal(Date.parse(tasks[2].dueAt), now.getTime());
  assert.equal(Date.parse(tasks[3].dueAt), now.getTime());
});

test("exactly 72 hours uses the standard fixed workflow", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const tasks = generateTrialBookingTasks({
    anchorBookingId: "BOOK-72",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: now,
    now,
    trialStartsAt: new Date(now.getTime() + 72 * TASK_SPACING_MS),
  });
  assert.deepEqual(tasks.map((task) => task.ruleKey), TRIAL_STANDARD_TASK_RULES);
});

test("only a trial that has started or passed is rejected", () => {
  assert.throws(
    () =>
      generateTrialBookingTasks({
        anchorBookingId: "BOOK-STARTED",
        studentId: "STU-1",
        owner: "Abby",
        requestedAt: "2026-08-10T00:00:00.000Z",
        now: "2026-08-10T00:00:00.000Z",
        trialStartsAt: "2026-08-10T00:00:00.000Z",
      }),
    /must be after now/,
  );
});

test("rescheduling recalculates deadlines, reuses ids, and does not duplicate rules", () => {
  const base = {
    anchorBookingId: "BOOK-1",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now: "2026-08-10T00:00:00.000Z",
  } as const;
  const original = generateTrialBookingTasks({ ...base, trialStartsAt: "2026-08-20T09:00:00.000Z" });
  const completed = original.map((task) =>
    task.ruleKey === "trial.parent-follow-up"
      ? { ...task, status: "done" as const, tone: "green" as const, result: "Sent" }
      : task,
  );
  const updated = reconcileTrialBookingTasks(completed, {
    ...base,
    trialStartsAt: "2026-08-21T09:00:00.000Z",
  });

  assert.equal(updated.length, 5);
  for (const ruleKey of TRIAL_STANDARD_TASK_RULES) {
    const before = original.find((task) => task.ruleKey === ruleKey);
    const after = updated.find((task) => task.ruleKey === ruleKey);
    assert.equal(after?.id, before?.id);
  }
  assert.equal(updated.find((task) => task.ruleKey === "trial.parent-follow-up")?.status, "done");
  assert.equal(updated.find((task) => task.ruleKey === "trial.parent-follow-up")?.result, "Sent");
  assert.notEqual(
    updated.find((task) => task.ruleKey === "trial.lp-review")?.dueAt,
    original.find((task) => task.ruleKey === "trial.lp-review")?.dueAt,
  );
});

test("rescheduling enters and exits short notice without duplicates or reopening human-completed work", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const base = {
    anchorBookingId: "BOOK-SWITCH",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: now,
    now,
  } as const;
  const standard = [
    ...generateTrialBookingTasks({
      ...base,
      trialStartsAt: "2026-08-20T09:00:00.000Z",
    }),
    ruleTask({
      id: "legacy-combined-short-notice",
      studentId: base.studentId,
      anchorBookingId: base.anchorBookingId,
      ruleKey: "trial.short-notice-prep",
    }),
  ].map((task) => task.ruleKey === "trial.lp-review"
    ? {
        ...task,
        status: "done" as const,
        tone: "green" as const,
        result: "人工审核完成",
        closedAt: "2026-08-10T00:30:00.000Z",
      }
    : task);

  const shortInput = {
    ...base,
    trialStartsAt: new Date(now.getTime() + 71 * TASK_SPACING_MS),
  };
  const entered = reconcileTrialBookingTasks(standard, shortInput);
  assert.equal(entered.length, TRIAL_MANAGED_TASK_RULES.length);
  assert.equal(new Set(entered.map((task) => `${task.ruleKey}:${task.anchorBookingId}`)).size, entered.length);
  assert.equal(entered.find((task) => task.ruleKey === "trial.prep")?.status === "done", false);
  assert.equal(entered.find((task) => task.ruleKey === "trial.prep")?.dueAt, "2026-08-10T00:00:00.000Z");
  for (const ruleKey of ["trial.minimum", "trial.short-notice-prep"] as const) {
    const closed = entered.find((task) => task.ruleKey === ruleKey);
    assert.equal(closed?.status, "done");
    assert.equal(closed?.result, TRIAL_RULE_NO_LONGER_APPLICABLE_RESULT);
  }
  assert.equal(entered.find((task) => task.ruleKey === "trial.lp-review")?.result, "人工审核完成");

  const enteredAgain = reconcileTrialBookingTasks(entered, shortInput);
  assert.equal(enteredAgain.length, TRIAL_MANAGED_TASK_RULES.length);
  assert.equal(new Set(enteredAgain.map((task) => `${task.ruleKey}:${task.anchorBookingId}`)).size, enteredAgain.length);

  const prepIdBeforeExit = enteredAgain.find((task) => task.ruleKey === "trial.prep")?.id;
  const exited = reconcileTrialBookingTasks(enteredAgain, {
    ...base,
    trialStartsAt: "2026-08-20T09:00:00.000Z",
  });
  assert.equal(exited.length, TRIAL_MANAGED_TASK_RULES.length);
  assert.equal(new Set(exited.map((task) => `${task.ruleKey}:${task.anchorBookingId}`)).size, exited.length);
  assert.equal(exited.find((task) => task.ruleKey === "trial.lp-review")?.status, "done");
  assert.equal(exited.find((task) => task.ruleKey === "trial.lp-review")?.result, "人工审核完成");
  assert.notEqual(exited.find((task) => task.ruleKey === "trial.prep")?.status, "done");
  assert.equal(exited.find((task) => task.ruleKey === "trial.prep")?.id, prepIdBeforeExit);
  assert.equal(exited.find((task) => task.ruleKey === "trial.short-notice-prep")?.status, "done");
  assert.equal(
    exited.find((task) => task.ruleKey === "trial.short-notice-prep")?.result,
    TRIAL_RULE_NO_LONGER_APPLICABLE_RESULT,
  );
});

test("linking request tasks migrates the first two ids and reconciles one complete five-rule set", () => {
  const requestTasks = generateTrialRequestTasks({
    anchorBookingId: "WORKFLOW-1",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now: "2026-08-10T00:00:00.000Z",
    idFactory: (ruleKey) => `request:${ruleKey}`,
  }).map((task) =>
    task.ruleKey === "trial.parent-follow-up"
      ? { ...task, status: "done" as const, tone: "green" as const, result: "Sent" }
      : task,
  );
  const unrelatedSameAnchor = ruleTask({
    id: "other-student-request",
    studentId: "STU-2",
    ruleKey: "trial.scheduling",
    anchorBookingId: "WORKFLOW-1",
  });
  const existingPrep = ruleTask({
    id: "existing-prep-id",
    ruleKey: "trial.prep",
    anchorBookingId: "BOOK-1",
  });
  const existingRealRequestDuplicate = ruleTask({
    id: "discard-real-parent",
    ruleKey: "trial.parent-follow-up",
    anchorBookingId: "BOOK-1",
  });
  const duplicateTemporaryScheduling = {
    ...requestTasks[1],
    id: "discard-temp-scheduling",
  };

  const linked = linkTrialRequestTasksToBooking(
    [
      ...requestTasks,
      duplicateTemporaryScheduling,
      unrelatedSameAnchor,
      existingPrep,
      existingRealRequestDuplicate,
    ],
    {
      requestAnchorBookingId: "WORKFLOW-1",
      anchorBookingId: "BOOK-1",
      studentId: "STU-1",
      owner: "Abby",
      requestedAt: "2026-08-10T00:00:00.000Z",
      now: "2026-08-10T00:00:00.000Z",
      trialStartsAt: "2026-08-20T09:00:00.000Z",
      idFactory: (ruleKey) => `booking:${ruleKey}`,
    },
  );

  const studentBookingTasks = linked.filter(
    (task) => task.studentId === "STU-1" && task.anchorBookingId === "BOOK-1",
  );
  assert.equal(studentBookingTasks.length, 5);
  assert.deepEqual(new Set(studentBookingTasks.map((task) => task.ruleKey)), new Set(TRIAL_STANDARD_TASK_RULES));
  assert.equal(
    studentBookingTasks.find((task) => task.ruleKey === "trial.parent-follow-up")?.id,
    "request:trial.parent-follow-up",
  );
  assert.equal(
    studentBookingTasks.find((task) => task.ruleKey === "trial.scheduling")?.id,
    "request:trial.scheduling",
  );
  assert.equal(
    studentBookingTasks.find((task) => task.ruleKey === "trial.scheduling")?.dueAt,
    requestTasks.find((task) => task.ruleKey === "trial.scheduling")?.dueAt,
  );
  assert.equal(studentBookingTasks.find((task) => task.ruleKey === "trial.prep")?.id, "existing-prep-id");
  assert.equal(studentBookingTasks.find((task) => task.ruleKey === "trial.parent-follow-up")?.status, "done");
  assert.equal(studentBookingTasks.find((task) => task.ruleKey === "trial.parent-follow-up")?.result, "Sent");
  assert.equal(
    linked.filter(
      (task) => task.studentId === "STU-1" && task.anchorBookingId === "WORKFLOW-1",
    ).length,
    0,
  );
  assert.ok(linked.some((task) => task.id === "other-student-request"));
  assert.ok(!linked.some((task) => task.id === "discard-real-parent" || task.id === "discard-temp-scheduling"));
});

test("linking a booked trial closes every unfinished request escalation but preserves completed evidence", () => {
  const escalations = generateTrialEscalationTasks({
    anchorBookingId: "WORKFLOW-ESCALATION-LINK",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now: "2026-08-10T00:00:00.000Z",
    parentProgressSyncCount: 2,
  }).map((task) => task.ruleKey === "trial.parent-no-reply-follow-up"
    ? { ...task, status: "done" as const, tone: "green" as const, result: "人工完成" }
    : task);
  const requestTasks = generateTrialRequestTasks({
    anchorBookingId: "WORKFLOW-ESCALATION-LINK",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now: "2026-08-10T00:00:00.000Z",
  });

  const linked = linkTrialRequestTasksToBooking([...requestTasks, ...escalations], {
    requestAnchorBookingId: "WORKFLOW-ESCALATION-LINK",
    anchorBookingId: "BOOK-ESCALATION-LINK",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now: "2026-08-11T01:00:00.000Z",
    trialStartsAt: "2026-08-20T09:00:00.000Z",
  });
  const closedEscalations = linked.filter((task) => task.anchorBookingId === "WORKFLOW-ESCALATION-LINK");

  assert.equal(closedEscalations.length, escalations.length);
  assert.equal(closedEscalations.find((task) => task.ruleKey === "trial.parent-no-reply-follow-up")?.result, "人工完成");
  for (const task of closedEscalations.filter((item) => item.ruleKey !== "trial.parent-no-reply-follow-up")) {
    assert.equal(task.status, "done");
    assert.equal(task.result, TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT);
    assert.equal(task.closedAt, "2026-08-11T01:00:00.000Z");
  }
});

test("linking preserves request deadlines that were already genuinely overdue", () => {
  const requestTasks = generateTrialRequestTasks({
    anchorBookingId: "WORKFLOW-OVERDUE",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now: "2026-08-10T00:00:00.000Z",
    idFactory: (ruleKey) => `request:${ruleKey}`,
  });
  const linkNow = new Date("2026-08-13T00:00:00.000Z");
  const linked = linkTrialRequestTasksToBooking(requestTasks, {
    requestAnchorBookingId: "WORKFLOW-OVERDUE",
    anchorBookingId: "BOOK-OVERDUE",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now: linkNow,
    trialStartsAt: "2026-08-20T09:00:00.000Z",
    idFactory: (ruleKey) => `booking:${ruleKey}`,
  });

  for (const ruleKey of TRIAL_REQUEST_TASK_RULES) {
    assert.equal(
      linked.find((task) => task.ruleKey === ruleKey)?.dueAt,
      requestTasks.find((task) => task.ruleKey === ruleKey)?.dueAt,
    );
  }
  const openBookingNodes = linked
    .filter((task) => Date.parse(task.dueAt ?? "") > linkNow.getTime())
    .map((task) => Date.parse(task.dueAt!));
  assert.ok(openBookingNodes.every((dueAt, index) => index === 0 || dueAt > openBookingNodes[index - 1]));
});

test("linking clamps future request deadlines when an early trial would put them after booking nodes", () => {
  const now = new Date("2026-08-10T00:00:00.000Z"); // 10:00 Melbourne
  const trialStartsAt = new Date("2026-08-10T02:00:00.000Z"); // 12:00 Melbourne
  const requestTasks = generateTrialRequestTasks({
    anchorBookingId: "WORKFLOW-EARLY",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: now,
    now,
    sameDayHour: 11,
    idFactory: (ruleKey) => `request:${ruleKey}`,
  });
  const generated = generateTrialBookingTasks({
    anchorBookingId: "BOOK-EARLY",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: now,
    now,
    trialStartsAt,
    sameDayHour: 11,
    idFactory: (ruleKey) => `generated:${ruleKey}`,
  });
  const linked = linkTrialRequestTasksToBooking(requestTasks, {
    requestAnchorBookingId: "WORKFLOW-EARLY",
    anchorBookingId: "BOOK-EARLY",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: now,
    now,
    trialStartsAt,
    sameDayHour: 11,
    idFactory: (ruleKey) => `booking:${ruleKey}`,
  });

  assert.deepEqual(
    linked.map((task) => task.dueAt),
    sortTasksByDueAt(generated).map((task) => task.dueAt),
  );
  assert.equal(linked.find((task) => task.ruleKey === "trial.parent-follow-up")?.id, "request:trial.parent-follow-up");
  assert.equal(linked.find((task) => task.ruleKey === "trial.scheduling")?.id, "request:trial.scheduling");
  const dueTimes = linked.map((task) => Date.parse(task.dueAt!));
  assert.ok(dueTimes.every((dueAt) => dueAt >= now.getTime() && dueAt < trialStartsAt.getTime()));
  assert.ok(dueTimes.every((dueAt, index) => index === 0 || dueAt >= dueTimes[index - 1]));
});

test("linking keeps completion state but clamps its still-future deadline before an early trial", () => {
  const now = new Date("2026-08-10T00:00:00.000Z");
  const trialStartsAt = new Date("2026-08-10T02:00:00.000Z");
  const requestTasks = generateTrialRequestTasks({
    anchorBookingId: "WORKFLOW-COMPLETED-FUTURE",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: now,
    now,
    sameDayHour: 11,
  }).map((task) => task.ruleKey === "trial.scheduling"
    ? { ...task, status: "done" as const, tone: "green" as const, result: "已排课" }
    : task);
  const linked = linkTrialRequestTasksToBooking(requestTasks, {
    requestAnchorBookingId: "WORKFLOW-COMPLETED-FUTURE",
    anchorBookingId: "BOOK-COMPLETED-FUTURE",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: now,
    now,
    trialStartsAt,
    sameDayHour: 11,
  });
  const scheduling = linked.find((task) => task.ruleKey === "trial.scheduling");
  assert.equal(scheduling?.status, "done");
  assert.equal(scheduling?.result, "已排课");
  assert.ok(Date.parse(scheduling?.dueAt ?? "") < trialStartsAt.getTime());
});

test("cancelling a booking closes only its unfinished associated tasks", () => {
  const tasks = [
    ruleTask({ id: "active", anchorBookingId: "BOOK-1" }),
    ruleTask({ id: "already-done", anchorBookingId: "BOOK-1", status: "done", result: "Sent" }),
    ruleTask({ id: "other", anchorBookingId: "BOOK-2" }),
  ];
  const result = closeTasksForBooking(tasks, "BOOK-1", "2026-08-12T01:02:03.000Z");
  assert.deepEqual(
    result.map((task) => ({ id: task.id, status: task.status, result: task.result, closedAt: task.closedAt })),
    [
      {
        id: "active",
        status: "done",
        result: "关联试听已取消",
        closedAt: "2026-08-12T01:02:03.000Z",
      },
      { id: "already-done", status: "done", result: "Sent", closedAt: undefined },
      { id: "other", status: "upcoming", result: undefined, closedAt: undefined },
    ],
  );
  assert.equal(tasks[0].status, "upcoming");
});

test("restores linked request tasks to their workflow anchor", () => {
  const linked = generateTrialRequestTasks({
    anchorBookingId: "BOOK-1",
    studentId: "STU-1",
    owner: "Abby",
    requestedAt: "2026-08-10T00:00:00.000Z",
    now: "2026-08-10T00:00:00.000Z",
  });
  const restored = restoreTrialRequestTasksToWorkflow(linked, {
    bookingAnchorBookingId: "BOOK-1",
    requestAnchorBookingId: "WORKFLOW-1",
    studentId: "STU-1",
  });
  assert.ok(restored.every((task) => task.anchorBookingId === "WORKFLOW-1"));
});
