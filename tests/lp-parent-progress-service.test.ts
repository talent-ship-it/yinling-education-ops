import assert from "node:assert/strict";
import test from "node:test";

import {
  eligibleLpParentProgressRecords,
  LP_PARENT_PROGRESS_AUTO_ADVANCED_RESULT,
  LP_PARENT_PROGRESS_CLOSED_RESULT,
  reconcileAllLpParentProgressTasks,
  reconcileLpParentProgressTasks,
} from "../lib/lp-parent-progress-service";
import {
  DEFAULT_TEACHING_CONTROL_WATCHER,
  deterministicTaskId,
  TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT,
  TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT,
  upsertTasksByRule,
  type OpsTask,
} from "../lib/ops-tasks";

function task(overrides: Partial<OpsTask> = {}): OpsTask {
  return {
    id: "old-task",
    title: "old",
    owner: "Abby",
    assignees: ["Abby"],
    watchers: ["Nixon"],
    studentId: "STU-1",
    due: "old",
    dueAt: "2026-08-11T00:00:00.000Z",
    status: "overdue",
    tone: "red",
    category: "试听",
    trigger: "old",
    ruleKey: "trial.parent-progress-sync.1",
    anchorBookingId: "LP-1",
    ...overrides,
  };
}

const lp = {
  id: "LP-1",
  studentId: "STU-1",
  owner: "Abby",
  stage: "待资料",
  requestedAt: "2026-08-10T00:00:00.000Z",
} as const;

test("reconciliation creates only the current 24-hour task and preserves recipients", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [],
    lp,
    now: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].ruleKey, "trial.parent-progress-sync.1");
  assert.equal(result[0].dueAt, "2026-08-11T00:00:00.000Z");
  assert.deepEqual(result[0].assignees, ["Abby"]);
  assert.deepEqual(result[0].watchers, [DEFAULT_TEACHING_CONTROL_WATCHER]);

  const withCustomRecipients = reconcileLpParentProgressTasks({
    tasks: [task({ owner: "Custom owner", assignees: ["Custom owner", "Control"], watchers: ["Watch"] })],
    lp,
    now: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(withCustomRecipients.length, 1);
  assert.equal(withCustomRecipients[0].id, "old-task");
  assert.equal(withCustomRecipients[0].owner, "Custom owner");
  assert.deepEqual(withCustomRecipients[0].assignees, ["Custom owner", "Control"]);
  assert.deepEqual(withCustomRecipients[0].watchers, ["Watch", DEFAULT_TEACHING_CONTROL_WATCHER]);
});

test("a reload after a missed completion advances from the exact request instant without pre-generating cycles", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [task()],
    lp,
    now: "2026-08-12T01:00:00.000Z", // 49h after request: cycle 3 is next
  });
  const managed = result.filter((entry) => entry.anchorBookingId === "LP-1" && entry.ruleKey?.startsWith("trial.parent-progress-sync."));
  assert.equal(managed.length, 2);
  assert.equal(managed.find((entry) => entry.ruleKey === "trial.parent-progress-sync.1")?.result, LP_PARENT_PROGRESS_AUTO_ADVANCED_RESULT);
  assert.equal(managed.find((entry) => entry.ruleKey === "trial.parent-progress-sync.3")?.dueAt, "2026-08-13T00:00:00.000Z");
  assert.equal(managed.some((entry) => entry.ruleKey === "trial.parent-progress-sync.2"), false);

  const completed = result.map((entry) => entry.ruleKey === "trial.parent-progress-sync.3"
    ? { ...entry, status: "done" as const, result: "人工已完成" }
    : entry);
  const nextDay = reconcileLpParentProgressTasks({
    tasks: completed,
    lp,
    now: "2026-08-13T00:01:00.000Z",
  });
  assert.equal(nextDay.find((entry) => entry.ruleKey === "trial.parent-progress-sync.4")?.dueAt, "2026-08-14T00:00:00.000Z");
  assert.equal(nextDay.find((entry) => entry.ruleKey === "trial.parent-progress-sync.3")?.result, "人工已完成");
});

test("reconciliation removes duplicate copies of the same managed cycle", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [
      task({ id: "duplicate-open" }),
      task({ id: "duplicate-done", status: "done", result: "人工已完成" }),
    ],
    lp,
    now: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(result.filter((entry) => entry.ruleKey === "trial.parent-progress-sync.1").length, 1);
  assert.equal(result.find((entry) => entry.ruleKey === "trial.parent-progress-sync.1")?.id, "duplicate-done");
});

test("booking, parent stop, and LP closure close remaining managed escalation tasks", () => {
  const open = [
    task({ ruleKey: "trial.parent-progress-sync.1", status: "overdue" }),
    task({ id: "escalation", ruleKey: "trial.parent-no-reply-follow-up", status: "today" }),
  ];
  const scheduled = reconcileLpParentProgressTasks({
    tasks: open,
    lp,
    bookings: [{
      id: "BOOK-1",
      studentId: "STU-1",
      lpId: "LP-1",
      kind: "试听",
      status: "待确认",
      requestedAt: lp.requestedAt,
      scheduledAt: "2026-08-11T00:00:00.000Z",
    }],
    now: "2026-08-10T12:00:00.000Z",
  });
  assert.ok(scheduled.every((entry) => entry.status === "done"));

  const stopped = reconcileLpParentProgressTasks({
    tasks: open,
    lp: { ...lp, parentProgressStatus: "not_continuing" },
    now: "2026-08-10T12:00:00.000Z",
  });
  assert.ok(stopped.every((entry) => entry.status === "done"));
  assert.equal(stopped[0].result, LP_PARENT_PROGRESS_CLOSED_RESULT);

  const closed = reconcileLpParentProgressTasks({
    tasks: open,
    lp: { ...lp, stage: "完成" },
    now: "2026-08-10T12:00:00.000Z",
  });
  assert.ok(closed.every((entry) => entry.status === "done"));
});

test("does not fabricate a deadline from a date-only published field", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [],
    lp: {
      ...lp,
      requestedAt: undefined,
      requestAt: "2026-08-10T00:00:00.000Z",
      requestedAtExact: "2026-08-10T00:00:00.000Z",
      publishedAt: "2026-08-10T00:00:00.000Z",
      publishedAtExact: "2026-08-10T00:00:00.000Z",
      publishedDate: "2026-08-10",
    } as never,
    now: "2026-08-12T00:00:00.000Z",
  });
  assert.deepEqual(result, []);

  const dateOnlyRequestedAt = reconcileLpParentProgressTasks({
    tasks: [],
    lp: { ...lp, requestedAt: "2026-08-10" },
    now: "2026-08-12T00:00:00.000Z",
  });
  assert.deepEqual(dateOnlyRequestedAt, []);
});

test("an exact scheduled-closure task is terminal even without bookings", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [task({
      status: "done",
      result: TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT,
      closedAt: "2026-08-10T12:00:00.000Z",
    })],
    lp,
    now: "2026-08-12T12:00:00.000Z",
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].status, "done");
  assert.equal(result[0].result, TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT);
});

test("a recorded parent reply is terminal and never reopens a later 24-hour cycle", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [task({
      status: "done",
      result: TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT,
      closedAt: "2026-08-10T12:00:00.000Z",
    })],
    lp,
    now: "2026-08-13T12:00:00.000Z",
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].status, "done");
  assert.equal(result[0].result, TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT);
});

test("an unrelated done result does not close or suppress a new progress cycle", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [task({ status: "done", result: "人工已完成" })],
    lp,
    now: "2026-08-11T00:01:00.000Z",
  });

  const current = result.find((entry) => entry.ruleKey === "trial.parent-progress-sync.2");
  assert.equal(current?.status, "upcoming");
  assert.equal(current?.result, undefined);
  assert.equal(result.find((entry) => entry.ruleKey === "trial.parent-progress-sync.1")?.result, "人工已完成");
});

test("an old same-student booking is not terminal evidence for a new LP", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [],
    lp,
    bookings: [{
      id: "BOOK-OLD",
      studentId: "STU-1",
      kind: "试听",
      status: "待确认",
      scheduledAt: "2026-08-09T00:00:00.000Z",
    }],
    now: "2026-08-10T12:00:00.000Z",
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].ruleKey, "trial.parent-progress-sync.1");
  assert.notEqual(result[0].status, "done");
});

test("an unanchored trusted ordinary booking is not terminal evidence", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [],
    lp,
    bookings: [{
      id: "BOOK-NEW-CLASS",
      studentId: "STU-1",
      kind: "常规课",
      status: "待确认",
      trusted: true,
      scheduledAt: "2026-08-11T00:00:00.000Z",
      requestedAt: lp.requestedAt,
    }],
    now: "2026-08-10T12:00:00.000Z",
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].ruleKey, "trial.parent-progress-sync.1");
  assert.notEqual(result[0].status, "done");
});

test("an unanchored trusted trial booking is not terminal evidence either", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [],
    lp,
    bookings: [{
      id: "BOOK-UNANCHORED-TRIAL",
      studentId: "STU-1",
      kind: "试听",
      status: "已确认",
      trusted: true,
      scheduledAt: "2026-08-11T00:00:00.000Z",
    }],
    now: "2026-08-10T12:00:00.000Z",
  });

  assert.equal(result.length, 1);
  assert.notEqual(result[0].status, "done");
});

test("only an anchored trial booking with the exact request instant closes progress", () => {
  const result = reconcileLpParentProgressTasks({
    tasks: [task({ status: "overdue" })],
    lp,
    bookings: [{
      id: "BOOK-ANCHORED-TRIAL",
      studentId: "STU-1",
      anchorBookingId: "LP-1",
      kind: "试听",
      status: "已确认",
      requestedAt: lp.requestedAt,
      scheduledAt: "2026-08-11T00:00:00.000Z",
    }],
    now: "2026-08-10T12:00:00.000Z",
  });

  assert.ok(result.every((entry) => entry.status === "done"));
});

test("two independent reconciles produce one deterministic task after merge", () => {
  const first = reconcileLpParentProgressTasks({
    tasks: [],
    lp,
    now: "2026-08-10T12:00:00.000Z",
    idFactory: () => "random-client-id-1",
  });
  const second = reconcileLpParentProgressTasks({
    tasks: [],
    lp,
    now: "2026-08-10T12:00:00.000Z",
    idFactory: () => "random-client-id-2",
  });

  assert.equal(first[0].id, second[0].id);
  assert.equal(first[0].id, deterministicTaskId("LP-1", "trial.parent-progress-sync.1"));
  const merged = upsertTasksByRule(first, second);
  assert.equal(merged.filter((entry) => entry.ruleKey === "trial.parent-progress-sync.1").length, 1);
});

test("scheduler eligibility excludes every non-trial LP workflow even with an exact request instant", () => {
  const records = [
    { ...lp, workflowType: "试听 LP" },
    { ...lp, id: "LP-REPLACEMENT", workflowType: "换老师试听" },
    {
      ...lp,
      id: "LP-HANDBOOK",
      workflowType: "试听 LP",
      trialIntake: {
        requestSentAt: "2026-08-10T00:00:00.000Z",
        contactParents: true,
        contactStudent: false,
      },
    },
    { ...lp, id: "LP-DIRECT", workflowType: "学生直报（无试听）" },
    { ...lp, id: "LP-RENEWAL", workflowType: "续课" },
    { ...lp, id: "LP-MISSING" },
  ];

  const eligible = eligibleLpParentProgressRecords(records);
  assert.deepEqual(eligible.map((record) => record.id), ["LP-1", "LP-REPLACEMENT"]);

  const tasks = reconcileAllLpParentProgressTasks({
    tasks: [],
    lps: eligibleLpParentProgressRecords(records.slice(2)),
    now: "2026-08-10T12:00:00.000Z",
  });
  assert.deepEqual(tasks, []);
});

test("parent-cancelled trial results close legacy progress reminders while NIL keeps existing scheduling", () => {
  const cancelled = reconcileLpParentProgressTasks({
    tasks: [task()], lp: { ...lp, resultStatus: "被家长取消" },
    now: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].status, "done");
  assert.equal(cancelled[0].result, LP_PARENT_PROGRESS_CLOSED_RESULT);
  assert.deepEqual(reconcileLpParentProgressTasks({
    tasks: [], lp: { ...lp, resultStatus: "被家长取消" },
    now: "2026-08-12T12:00:00.000Z",
  }), []);
  const nil = reconcileLpParentProgressTasks({
    tasks: [], lp: { ...lp, resultStatus: "NIL" },
    now: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(nil.length, 1);
  assert.notEqual(nil[0].status, "done");
});
