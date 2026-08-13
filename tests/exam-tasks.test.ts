import assert from "node:assert/strict";
import test from "node:test";

import {
  EXAM_RULE_NO_LONGER_APPLICABLE_RESULT,
  reconcileExamTasks,
} from "../lib/exam-tasks";
import type { RuleBoundTask } from "../lib/ops-tasks";

function examTask(suffix: "care" | "recall" | "results", overrides: Partial<RuleBoundTask> = {}): RuleBoundTask {
  return {
    id: `task-${suffix}`,
    title: suffix,
    owner: "Abby",
    assignees: ["Abby"],
    watchers: ["Ops Admin"],
    studentId: "STU-1",
    due: "2026-09-01 18:00",
    dueAt: "2026-09-01T08:00:00.000Z",
    status: "upcoming",
    tone: "amber",
    category: "考试",
    trigger: "exam",
    ruleKey: `exam:exam-1:${suffix}`,
    anchorBookingId: "exam:exam-1",
    ...overrides,
  };
}

test("closes omitted exam rules and reopens only automatic closures", () => {
  const closed = reconcileExamTasks(
    [examTask("care"), examTask("recall")],
    [examTask("care", { dueAt: "2026-09-02T08:00:00.000Z" })],
    { examId: "exam-1", closedAt: "2026-08-13T00:00:00.000Z" },
  );
  assert.equal(closed.find((task) => task.ruleKey.endsWith(":recall"))?.status, "done");
  assert.equal(closed.find((task) => task.ruleKey.endsWith(":recall"))?.result, EXAM_RULE_NO_LONGER_APPLICABLE_RESULT);

  const reopened = reconcileExamTasks(
    closed,
    [examTask("care"), examTask("recall", { dueAt: "2026-09-03T08:00:00.000Z" })],
    { examId: "exam-1", closedAt: "2026-08-14T00:00:00.000Z" },
  );
  const recall = reopened.find((task) => task.ruleKey.endsWith(":recall"));
  assert.equal(recall?.id, "task-recall");
  assert.equal(recall?.status, "upcoming");
  assert.equal(recall?.result, undefined);
});

test("never reopens an exam task completed by a person", () => {
  const completed = examTask("care", {
    status: "done",
    tone: "green",
    result: "已由当前操作员确认完成",
    closedAt: "2026-09-01T09:00:00.000Z",
  });
  const [reconciled] = reconcileExamTasks(
    [completed],
    [examTask("care", { dueAt: "2026-09-05T08:00:00.000Z" })],
    { examId: "exam-1", closedAt: "2026-08-13T00:00:00.000Z" },
  );
  assert.equal(reconciled.id, completed.id);
  assert.equal(reconciled.status, "done");
  assert.equal(reconciled.result, completed.result);
  assert.equal(reconciled.dueAt, "2026-09-05T08:00:00.000Z");
});

test("rejects tasks outside the requested exam lifecycle", () => {
  assert.throws(() => reconcileExamTasks([], [examTask("care", { anchorBookingId: "exam:other" })], {
    examId: "exam-1",
    closedAt: "2026-08-13T00:00:00.000Z",
  }), /does not belong/);
});
