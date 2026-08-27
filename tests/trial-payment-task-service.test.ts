import assert from "node:assert/strict";
import test from "node:test";

import type { DemoSessionRole } from "../lib/demo-session-token";
import type { OpsStateRow } from "../lib/ops-store";
import {
  authorizeTrialPaymentTaskCompletion,
  parseTrialPaymentCompletionCommand,
  trialPaymentCompletionIntent,
  TrialPaymentTaskServiceError,
} from "../lib/trial-payment-task-service";

const COMMAND_KEY = "trial-payment-complete:123e4567-e89b-42d3-a456-426614174000";
const VERSIONS = { bookings: 3, students: 4, lpItems: 5, tasks: 6, teachers: 7 } as const;

function row(entity: string, payload: unknown, version: number): OpsStateRow {
  return {
    entity,
    payload,
    version,
    updated_at: "2026-08-20T00:00:00.000Z",
    updated_by: "fixture",
  };
}

function fixtureRows(): OpsStateRow[] {
  return [
    row("bookings", [{
      id: "BOOK-PAY-1",
      studentId: "STU-ABBY",
      kind: "试听",
      date: "2026-08-21",
      start: "10:00",
      timezone: "Australia/Melbourne",
    }], VERSIONS.bookings),
    row("students", [{
      id: "STU-ABBY",
      name: "Student Private Name",
      owner: "Abby",
      planner: "Tara",
      guardianWechat: "must-not-be-returned-by-projection",
    }], VERSIONS.students),
    row("lpItems", [{
      id: "LP-PAY-1",
      studentId: "STU-ABBY",
      workflowType: "试听 LP",
      fields: { trialPaymentMethod: "付费试听（未付费）" },
    }], VERSIONS.lpItems),
    row("tasks", [{
      id: "TASK-PAY-1",
      studentId: "STU-ABBY",
      owner: "Tara",
      assignees: ["Tara"],
      watchers: ["Ops Admin"],
      category: "试听",
      ruleKey: "trial.payment-urgent",
      anchorBookingId: "BOOK-PAY-1",
      status: "today",
    }], VERSIONS.tasks),
    row("teachers", [], VERSIONS.teachers),
  ];
}

function command() {
  return parseTrialPaymentCompletionCommand({
    commandKey: COMMAND_KEY,
    taskId: "TASK-PAY-1",
    expectedVersions: VERSIONS,
  });
}

function forbidden(action: () => unknown) {
  assert.throws(action, (error: unknown) => error instanceof TrialPaymentTaskServiceError
    && error.code === "task_forbidden");
}

test("payment completion accepts only a narrow idempotent command envelope", () => {
  const parsed = command();
  assert.deepEqual(parsed, {
    commandKey: COMMAND_KEY,
    taskId: "TASK-PAY-1",
    expectedVersions: VERSIONS,
  });
  assert.deepEqual(trialPaymentCompletionIntent(parsed), {
    action: "complete",
    taskId: "TASK-PAY-1",
  });

  for (const invalid of [
    null,
    { commandKey: COMMAND_KEY, taskId: "TASK-PAY-1" },
    { commandKey: "not-idempotent", taskId: "TASK-PAY-1", expectedVersions: VERSIONS },
    { commandKey: COMMAND_KEY, taskId: "TASK-PAY-1", expectedVersions: { ...VERSIONS, tasks: 0 } },
    { commandKey: COMMAND_KEY, taskId: "TASK-PAY-1", expectedVersions: VERSIONS, tasks: [] },
  ]) {
    assert.throws(() => parseTrialPaymentCompletionCommand(invalid), (error: unknown) =>
      error instanceof TrialPaymentTaskServiceError && error.code === "invalid_request");
  }
});

test("only the current cross-owner planner can authorize the exact payment task", () => {
  const rows = fixtureRows();
  const authorized = authorizeTrialPaymentTaskCompletion({
    command: command(),
    rows,
    actor: "Tara",
    role: "staff",
  });
  assert.equal(authorized.task.id, "TASK-PAY-1");
  assert.equal(authorized.booking.id, "BOOK-PAY-1");
  assert.equal(authorized.student.id, "STU-ABBY");

  for (const [actor, role] of [
    ["Abby", "staff"],
    ["Ops Admin", "limited-admin"],
    ["Nixon", "admin"],
    ["Tara", "teacher"],
  ] as Array<[string, DemoSessionRole]>) {
    forbidden(() => authorizeTrialPaymentTaskCompletion({ command: command(), rows, actor, role }));
  }
});

test("payment completion fails closed when any task, booking or planner authority drifts", () => {
  const base = fixtureRows();
  const mutate = (entity: string, change: (payload: Array<Record<string, unknown>>) => unknown) =>
    base.map((candidate) => candidate.entity === entity
      ? { ...candidate, payload: change(candidate.payload as Array<Record<string, unknown>>) }
      : candidate);

  const variants = [
    mutate("tasks", (payload) => payload.map((task) => ({ ...task, owner: "Abby" }))),
    mutate("tasks", (payload) => payload.map((task) => ({ ...task, assignees: ["Tara", "Abby"] }))),
    mutate("tasks", (payload) => payload.map((task) => ({ ...task, watchers: ["Abby"] }))),
    mutate("tasks", (payload) => payload.map((task) => ({ ...task, ruleKey: "trial.prep" }))),
    mutate("bookings", (payload) => payload.map((booking) => ({ ...booking, studentId: "STU-OTHER" }))),
    mutate("bookings", (payload) => payload.map((booking) => ({ ...booking, kind: "常规课" }))),
    mutate("students", (payload) => payload.map((student) => ({ ...student, planner: "Molly" }))),
    mutate("students", (payload) => payload.map((student) => ({ ...student, importArchived: true }))),
  ];
  for (const rows of variants) {
    forbidden(() => authorizeTrialPaymentTaskCompletion({
      command: command(),
      rows,
      actor: "Tara",
      role: "staff",
    }));
  }
});
