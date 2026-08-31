import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLegacyTaskDeadlineSetCommand,
  authorizeLegacyTaskDeadlineCommand,
  hasLegacyTaskDeadlineAdminAccess,
  legacyTaskDeadlineIntent,
  LegacyTaskDeadlineServiceError,
  melbourneDateTimeToUtc,
  parseLegacyTaskDeadlineCommand,
  prepareLegacyTaskDeadline,
  type LegacyTaskDeadlineSetCommand,
} from "../lib/legacy-task-deadline-service";
import type { OpsStateRow } from "../lib/ops-store";

const COMMAND_KEY = "legacy-task-deadline:123e4567-e89b-42d3-a456-426614174000";

function row(entity: string, payload: unknown, version = 7): OpsStateRow {
  return {
    entity,
    payload,
    version,
    updated_at: "2026-08-20T00:00:00.000Z",
    updated_by: "Nixon",
  };
}

function student(overrides: Record<string, unknown> = {}) {
  return {
    id: "STU-LEGACY",
    name: "历史学生",
    owner: "Abby",
    status: "在读",
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "TSK-LEGACY",
    title: "核对历史交接信息",
    owner: "Abby",
    studentId: "STU-LEGACY",
    due: "发布后立即",
    status: "waiting",
    tone: "red",
    category: "LP",
    trigger: "历史导入",
    ...overrides,
  };
}

function rows(
  studentValue: Record<string, unknown> = student(),
  taskValue: Record<string, unknown> = task(),
  versions: Readonly<{ students: number; tasks: number }> = { students: 7, tasks: 7 },
): OpsStateRow[] {
  return [
    row("students", [studentValue], versions.students),
    row("tasks", [taskValue], versions.tasks),
  ];
}

function command(overrides: Partial<LegacyTaskDeadlineSetCommand> = {}): LegacyTaskDeadlineSetCommand {
  return {
    commandKey: COMMAND_KEY,
    action: "set",
    taskId: "TSK-LEGACY",
    melbourneDateTime: "2026-08-19T18:00",
    expectedVersions: { students: 7, tasks: 7 },
    ...overrides,
  };
}

function errorCode(error: unknown) {
  return error instanceof LegacyTaskDeadlineServiceError ? error.code : "unexpected";
}

test("accepts set commands and only replay-shaped historical clear commands", () => {
  const parsed = parseLegacyTaskDeadlineCommand(command());
  assert.deepEqual(legacyTaskDeadlineIntent(parsed), {
    action: "set",
    taskId: "TSK-LEGACY",
    melbourneDateTime: "2026-08-19T18:00",
  });

  for (const forbidden of ["dueAt", "studentId", "tasks", "students", "actor", "updatedAt"]) {
    assert.throws(
      () => parseLegacyTaskDeadlineCommand({ ...command(), [forbidden]: "browser-owned" }),
      (error) => errorCode(error) === "client_fields_forbidden",
    );
  }
  assert.throws(
    () => parseLegacyTaskDeadlineCommand({ ...command(), action: "clear", melbourneDateTime: "2026-08-19T18:00" }),
    (error) => errorCode(error) === "client_fields_forbidden",
  );
  const clear = parseLegacyTaskDeadlineCommand({ ...command(), action: "clear", melbourneDateTime: undefined });
  assert.deepEqual(legacyTaskDeadlineIntent(clear), { action: "clear", taskId: "TSK-LEGACY" });
  assert.throws(
    () => assertLegacyTaskDeadlineSetCommand(clear),
    (error) => errorCode(error) === "clear_disabled",
  );
  assert.throws(
    () => parseLegacyTaskDeadlineCommand({ ...command(), commandKey: COMMAND_KEY.toUpperCase() }),
    (error) => errorCode(error) === "invalid_request",
  );
  assert.throws(
    () => parseLegacyTaskDeadlineCommand({ ...command(), expectedVersions: { students: 7, tasks: 7, bookings: 7 } }),
    (error) => errorCode(error) === "client_fields_forbidden",
  );
});

test("maps an unambiguous Melbourne wall-clock minute to its exact UTC instant", () => {
  assert.equal(
    melbourneDateTimeToUtc("2026-08-19T18:00").toISOString(),
    "2026-08-19T08:00:00.000Z",
  );
  assert.throws(
    () => melbourneDateTimeToUtc("2026-10-04T02:30"),
    (error) => errorCode(error) === "melbourne_time_nonexistent",
  );
  assert.throws(
    () => melbourneDateTimeToUtc("2026-04-05T02:30"),
    (error) => errorCode(error) === "melbourne_time_ambiguous",
  );
  assert.throws(
    () => melbourneDateTimeToUtc("2026-02-30T18:00"),
    (error) => errorCode(error) === "melbourne_time_invalid",
  );
});

test("derives only dueAt from the explicit Melbourne input and leaves legacy copy untouched", () => {
  const before = rows();
  const prepared = prepareLegacyTaskDeadline({
    command: command(),
    rows: before,
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
  });
  assert.deepEqual(prepared, {
    commandKey: COMMAND_KEY,
    commandIntent: {
      action: "set",
      taskId: "TSK-LEGACY",
      melbourneDateTime: "2026-08-19T18:00",
    },
    action: "set",
    taskId: "TSK-LEGACY",
    melbourneDateTime: "2026-08-19T18:00",
    dueAt: "2026-08-19T08:00:00.000Z",
    expectedVersions: { students: 7, tasks: 7 },
  });
  assert.deepEqual(before[1]?.payload, [task()], "the source task snapshot must remain immutable");

});

test("permits only full or limited admins and fails closed for managed, closed, archived, or stale targets", () => {
  assert.equal(hasLegacyTaskDeadlineAdminAccess("Nixon", true), true);
  assert.equal(hasLegacyTaskDeadlineAdminAccess("Nixon", false), false);
  assert.equal(hasLegacyTaskDeadlineAdminAccess("Ops Admin", false), true);
  assert.equal(hasLegacyTaskDeadlineAdminAccess("Abby", false), false);

  assert.doesNotThrow(() => authorizeLegacyTaskDeadlineCommand({
    command: command(), rows: rows(), actor: "Nixon", role: "admin", fullAdmin: true,
  }));
  assert.doesNotThrow(() => authorizeLegacyTaskDeadlineCommand({
    command: command(), rows: rows(), actor: "Ops Admin", role: "limited-admin", fullAdmin: false,
  }));
  assert.throws(() => authorizeLegacyTaskDeadlineCommand({
    command: command(), rows: rows(), actor: "Abby", role: "staff", fullAdmin: false,
  }), (error) => errorCode(error) === "admin_forbidden");
  assert.throws(() => authorizeLegacyTaskDeadlineCommand({
    command: command(), rows: rows(), actor: "Helen", role: "teacher", fullAdmin: false,
  }), (error) => errorCode(error) === "teacher_forbidden");

  for (const managed of [task({ ruleKey: "exam:EXM-1:care" }), task({ anchorBookingId: "LES-1" })]) {
    assert.throws(() => authorizeLegacyTaskDeadlineCommand({
      command: command(), rows: rows(student(), managed), actor: "Nixon", role: "admin", fullAdmin: true,
    }), (error) => errorCode(error) === "task_not_legacy");
  }
  assert.throws(() => authorizeLegacyTaskDeadlineCommand({
    command: command(), rows: rows(student(), task({ status: "done" })), actor: "Nixon", role: "admin", fullAdmin: true,
  }), (error) => errorCode(error) === "task_closed");
  assert.throws(() => authorizeLegacyTaskDeadlineCommand({
    command: command(), rows: rows(student({ importArchived: true })), actor: "Nixon", role: "admin", fullAdmin: true,
  }), (error) => errorCode(error) === "archived_student_read_only");
  assert.throws(() => prepareLegacyTaskDeadline({
    command: command({ expectedVersions: { students: 6, tasks: 7 } }),
    rows: rows(), actor: "Nixon", role: "admin", fullAdmin: true,
  }), (error) => errorCode(error) === "stale_expected_version");
});

test("allows a historic task whose former student no longer has a current row", () => {
  assert.doesNotThrow(() => prepareLegacyTaskDeadline({
    command: command(),
    rows: [row("students", [], 7), row("tasks", [task({ studentId: "STU-FORMER" })], 7)],
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
  }));
});
