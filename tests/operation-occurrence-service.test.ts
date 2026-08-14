import assert from "node:assert/strict";
import test from "node:test";

import {
  OperationConfirmationError,
  parseConfirmOperationCommand,
  prepareOperationConfirmation,
} from "../lib/operation-occurrence-service";

const operation = {
  id: "OPS-1", studentId: "STU-1", type: "学生请假", detail: "Family leave",
  status: "待处理", createdAt: "today", teacherId: "T-1",
  eventStart: "2026-09-01", eventEnd: "2026-09-15",
};
const booking = {
  id: "B-1", studentId: "STU-1", teacherId: "T-1", date: "2026-09-01",
  start: "17:00", duration: 60, recurring: true, repeatCount: 3,
  timezone: "Australia/Melbourne", course: "Math",
  occurrenceOverrides: [{ occurrenceId: "B-1:2026-09-08", start: "18:30" }],
};
const teachers = [{ id: "T-1", name: "Teacher One", subjects: ["Math"] }];
const students = [{ id: "STU-1", owner: "Abby" }];
const rows = [
  { entity: "bookings", payload: [booking], version: 3, updated_at: "", updated_by: "" },
  { entity: "operations", payload: [operation], version: 4, updated_at: "", updated_by: "" },
  { entity: "teachers", payload: teachers, version: 5, updated_at: "", updated_by: "" },
  { entity: "students", payload: students, version: 1, updated_at: "", updated_by: "" },
];

test("operation command is narrow and requires every expected version", () => {
  assert.deepEqual(parseConfirmOperationCommand({
    operationId: "OPS-1",
    expectedVersions: { bookings: 3, operations: 4, teachers: 5 },
  }), {
    operationId: "OPS-1",
    expectedVersions: { bookings: 3, operations: 4, teachers: 5 },
  });
  assert.throws(() => parseConfirmOperationCommand({
    operationId: "OPS-1", affectedOccurrenceIds: ["B-1:2026-09-01"],
    expectedVersions: { bookings: 3, operations: 4, teachers: 5 },
  }), (error: unknown) => error instanceof OperationConfirmationError && error.code === "client_fields_forbidden");
});

test("server derives exact occurrence IDs and preserves prior occurrence edits", () => {
  const prepared = prepareOperationConfirmation({
    command: { operationId: "OPS-1", expectedVersions: { bookings: 3, operations: 4, teachers: 5 } },
    rows, actor: "Abby", fullAdmin: false,
  });
  assert.deepEqual(prepared.affectedOccurrenceIds, [
    "B-1:2026-09-01", "B-1:2026-09-08", "B-1:2026-09-15",
  ]);
  const nextBooking = prepared.bookings[0];
  const overrides = nextBooking.occurrenceOverrides as Array<Record<string, unknown>>;
  assert.equal(overrides.find((item) => item.occurrenceId === "B-1:2026-09-08")?.start, "18:30");
  assert.equal(overrides.find((item) => item.occurrenceId === "B-1:2026-09-08")?.status, "leave");
  assert.equal(prepared.operations[0].status, "已确认");
});

test("stale state and out-of-scope staff confirmation are rejected", () => {
  assert.throws(() => prepareOperationConfirmation({
    command: { operationId: "OPS-1", expectedVersions: { bookings: 2, operations: 4, teachers: 5 } },
    rows, actor: "Abby", fullAdmin: false,
  }), (error: unknown) => error instanceof OperationConfirmationError && error.code === "stale_expected_version");
  assert.throws(() => prepareOperationConfirmation({
    command: { operationId: "OPS-1", expectedVersions: { bookings: 3, operations: 4, teachers: 5 } },
    rows, actor: "Molly", fullAdmin: false,
  }), (error: unknown) => error instanceof OperationConfirmationError && error.code === "operation_scope_forbidden");
});

test("archived student operations cannot be confirmed by staff or admins", () => {
  const archivedRows = rows.map((row) => row.entity === "students"
    ? { ...row, payload: [{ ...students[0], importArchived: true }] }
    : row);
  for (const input of [
    { actor: "Abby", fullAdmin: false },
    { actor: "Nixon", fullAdmin: true },
    { actor: "Ops Admin", fullAdmin: false },
  ]) {
    assert.throws(() => prepareOperationConfirmation({
      command: { operationId: "OPS-1", expectedVersions: { bookings: 3, operations: 4, teachers: 5 } },
      rows: archivedRows,
      ...input,
    }), (error: unknown) => error instanceof OperationConfirmationError && error.code === "operation_scope_forbidden");
  }
});

test("substitution must use a server-validated recommended teacher", () => {
  const substituteRows = rows.map((row) => row.entity === "operations" ? {
    ...row, payload: [{ ...operation, type: "代课", recommendedTeacherIds: ["T-2"] }],
  } : row.entity === "teachers" ? { ...row, payload: [...teachers, { id: "T-2", name: "Two", subjects: ["Math"], availabilityWindows: [] }] } : row);
  assert.throws(() => prepareOperationConfirmation({
    command: { operationId: "OPS-1", chosenTeacherId: "T-X", expectedVersions: { bookings: 3, operations: 4, teachers: 5 } },
    rows: substituteRows, actor: "Abby", fullAdmin: false,
  }), (error: unknown) => error instanceof OperationConfirmationError && error.code === "substitute_not_found");
});
