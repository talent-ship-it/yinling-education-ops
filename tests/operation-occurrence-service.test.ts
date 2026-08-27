import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  OperationConfirmationError,
  parseConfirmOperationCommand,
  parsePermanentTeacherReplacementCommand,
  permanentTeacherReplacementCommandKey,
  preparePermanentTeacherReplacement,
  prepareOperationConfirmation,
} from "../lib/operation-occurrence-service";
import { createMonthlyAvailabilityWindows } from "../lib/teacher-availability";

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

test("operation closure expands a moved-in occurrence from its stable source date", () => {
  const movedOperation = {
    ...operation,
    eventStart: "2026-09-10",
    eventEnd: "2026-09-10",
  };
  const movedBooking = {
    ...booking,
    date: "2026-08-01",
    repeatCount: 12,
    occurrenceOverrides: [{ occurrenceId: "B-1:2026-08-08", date: "2026-09-10" }],
  };
  const movedRows = rows.map((row) => row.entity === "bookings"
    ? { ...row, payload: [movedBooking] }
    : row.entity === "operations"
      ? { ...row, payload: [movedOperation] }
      : row);
  const prepared = prepareOperationConfirmation({
    command: { operationId: "OPS-1", expectedVersions: { bookings: 3, operations: 4, teachers: 5 } },
    rows: movedRows,
    actor: "Abby",
    fullAdmin: false,
  });
  assert.deepEqual(prepared.affectedOccurrenceIds, ["B-1:2026-08-08"]);
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

const departureCreationCommandKey = "teacher-departure-create:123e4567-e89b-42d3-a456-426614174000";
const departureOperationId = `OPS-DEPARTURE-${createHash("sha256")
  .update(`${departureCreationCommandKey}\u001fSTU-1`)
  .digest("hex")
  .slice(0, 24)}`;

function departureRows(options: { repeatCount?: number; targetCapacity?: number } = {}) {
  const replacementAvailability = createMonthlyAvailabilityWindows({
    teacherId: "T-2",
    month: "2026-09",
    timezone: "Australia/Melbourne",
    slots: [{ day: 2, start: "16:00", end: "21:00" }],
    idSeed: "departure-target",
  });
  const departureBooking = {
    ...booking,
    repeatCount: options.repeatCount ?? 5,
    kind: "常规课",
    packageId: "PKG-1",
    teacherSubjectId: "Math",
  };
  if (options.repeatCount === 0) delete (departureBooking as { repeatCount?: number }).repeatCount;
  return [
    { entity: "bookings", payload: [departureBooking], version: 3, updated_at: "", updated_by: "" },
    { entity: "operations", payload: [{
      ...operation,
      id: departureOperationId,
      type: "老师离职",
      eventStart: "2026-09-08",
      eventEnd: "2026-09-08",
      recommendedTeacherIds: ["T-2"],
      affectedOccurrenceIds: [
        "B-1:2026-09-08", "B-1:2026-09-15", "B-1:2026-09-22", "B-1:2026-09-29",
      ],
      creationCommandKey: departureCreationCommandKey,
    }], version: 4, updated_at: "", updated_by: "" },
    { entity: "teachers", payload: [
      { id: "T-1", name: "Teacher One", subjects: ["Math"], newStudentCapacity: 0, capacityAssignments: ["STU-1"] },
      {
        id: "T-2", name: "Teacher Two", subjects: ["Math"], acceptsStudents: true,
        newStudentCapacity: options.targetCapacity ?? 2, capacityAssignments: [], availabilityWindows: replacementAvailability,
      },
    ], version: 5, updated_at: "", updated_by: "" },
    { entity: "students", payload: [{ id: "STU-1", owner: "Abby", teacher: "Teacher One" }], version: 1, updated_at: "", updated_by: "" },
  ];
}

const permanentCommand = {
  operationId: departureOperationId,
  chosenTeacherId: "T-2",
  expectedVersions: { bookings: 3, operations: 4, teachers: 5, students: 1 },
} as const;

test("permanent replacement command accepts only the reviewed decision and OCC versions", () => {
  assert.deepEqual(parsePermanentTeacherReplacementCommand(permanentCommand), permanentCommand);
  assert.throws(() => parsePermanentTeacherReplacementCommand({
    ...permanentCommand,
    effectiveDate: "2026-09-08",
  }), (error: unknown) => error instanceof OperationConfirmationError && error.code === "client_fields_forbidden");
  for (const entity of ["bookings", "operations", "teachers", "students"] as const) {
    assert.throws(() => parsePermanentTeacherReplacementCommand({
      ...permanentCommand,
      expectedVersions: { ...permanentCommand.expectedVersions, [entity]: 0 },
    }), (error: unknown) => error instanceof OperationConfirmationError && error.code === "invalid_request");
  }
});

test("an already-confirmed departure requires a real command-ledger replay", () => {
  const rows = departureRows().map((row) => row.entity === "operations"
    ? {
        ...row,
        payload: (row.payload as Array<Record<string, unknown>>).map((operation) => ({
          ...operation,
          status: "已确认",
          chosenTeacherId: permanentCommand.chosenTeacherId,
          confirmationAction: "permanent_replacement",
          confirmationCommandKey: permanentTeacherReplacementCommandKey(permanentCommand),
        })),
      }
    : row);

  assert.throws(() => preparePermanentTeacherReplacement({
    command: permanentCommand,
    rows,
    actor: "Abby",
    fullAdmin: false,
  }), (error: unknown) => error instanceof OperationConfirmationError
    && error.code === "operation_already_confirmed"
    && /原子命令结果/.test(error.message));
});

test("departure replacement reaches every finite future lesson beyond the operation range", () => {
  const prepared = preparePermanentTeacherReplacement({
    command: permanentCommand,
    rows: departureRows(),
    actor: "Abby",
    fullAdmin: false,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  assert.equal(prepared.effectiveDate, "2026-09-08");
  assert.deepEqual(prepared.affectedOccurrenceIds, [
    "B-1:2026-09-08", "B-1:2026-09-15", "B-1:2026-09-22", "B-1:2026-09-29",
  ]);
  const overrides = prepared.bookings[0].occurrenceOverrides as Array<Record<string, unknown>>;
  assert.equal(prepared.bookings[0].teacherId, "T-2", "future relationship becomes the series default");
  assert.equal(overrides.find((override) => override.occurrenceId === "B-1:2026-09-01")?.teacherId, "T-1", "pre-departure history stays with the original teacher");
  for (const occurrenceId of prepared.affectedOccurrenceIds) {
    assert.equal(overrides.find((override) => override.occurrenceId === occurrenceId)?.teacherId, "T-2");
  }
  assert.equal(prepared.students[0].teacher, "Teacher Two");
  assert.deepEqual(prepared.teachers.map((teacher) => ({
    id: teacher.id,
    remaining: teacher.newStudentCapacity,
    assignments: teacher.capacityAssignments,
  })), [
    { id: "T-1", remaining: 1, assignments: [] },
    { id: "T-2", remaining: 1, assignments: ["STU-1"] },
  ]);
  assert.equal(prepared.operations[0].confirmationAction, "permanent_replacement");
});

test("paused intake can continue an established relationship without consuming capacity again", () => {
  const existingRelationshipBooking = {
    id: "B-EXISTING",
    studentId: "STU-1",
    teacherId: "T-2",
    date: "2026-09-10",
    start: "14:00",
    duration: 60,
    recurring: false,
    timezone: "Australia/Melbourne",
    kind: "常规课",
    teacherSubjectId: "Math",
  };
  for (const evidence of ["active-booking", "capacity-assignment"] as const) {
    const establishedRows = departureRows().map((row) => {
      if (row.entity === "bookings" && evidence === "active-booking") {
        return { ...row, payload: [...row.payload as Record<string, unknown>[], existingRelationshipBooking] };
      }
      if (row.entity === "teachers") return {
        ...row,
        payload: (row.payload as Array<Record<string, unknown>>).map((teacher) => teacher.id === "T-2" ? {
          ...teacher,
          acceptsStudents: false,
          newStudentCapacity: 0,
          capacityAssignments: evidence === "capacity-assignment" ? ["STU-1"] : [],
        } : teacher),
      };
      return row;
    });
    const prepared = preparePermanentTeacherReplacement({
      command: permanentCommand,
      rows: establishedRows,
      actor: "Abby",
      fullAdmin: false,
      now: new Date("2026-08-15T00:00:00.000Z"),
    });
    const replacement = prepared.teachers.find((teacher) => teacher.id === "T-2")!;
    assert.equal(replacement.newStudentCapacity, 0);
    assert.deepEqual(replacement.capacityAssignments, evidence === "capacity-assignment" ? ["STU-1"] : []);
    assert.deepEqual(prepared.changedTeacherIds, ["T-1"]);
  }
});

test("permanent replacement rejects a departure operation without deterministic creation provenance", () => {
  const forgedRows = departureRows().map((row) => row.entity === "operations" ? {
    ...row,
    payload: (row.payload as Array<Record<string, unknown>>).map((entry) => ({
      ...entry,
      creationCommandKey: "teacher-departure-create:223e4567-e89b-42d3-a456-426614174000",
    })),
  } : row);
  assert.throws(() => preparePermanentTeacherReplacement({
    command: permanentCommand,
    rows: forgedRows,
    actor: "Abby",
    fullAdmin: false,
  }), (error: unknown) => error instanceof OperationConfirmationError
    && error.code === "invalid_shared_state"
    && /原子创建来源/.test(error.message));
});

test("departure replacement fails closed for unbounded series and exhausted capacity", () => {
  assert.throws(() => preparePermanentTeacherReplacement({
    command: permanentCommand,
    rows: departureRows({ repeatCount: 0 }),
    actor: "Abby",
    fullAdmin: false,
  }), (error: unknown) => error instanceof OperationConfirmationError && error.code === "unbounded_future_series");

  assert.throws(() => preparePermanentTeacherReplacement({
    command: permanentCommand,
    rows: departureRows({ targetCapacity: 0 }),
    actor: "Abby",
    fullAdmin: false,
  }), (error: unknown) => error instanceof OperationConfirmationError && error.code === "replacement_capacity_exhausted");
});

test("departure replacement requires an exact Tencent teacher subject when the booking stores one", () => {
  const mismatchedRows = departureRows().map((row) => row.entity === "bookings"
    ? {
        ...row,
        payload: (row.payload as Array<Record<string, unknown>>).map((entry) => ({
          ...entry,
          teacherSubjectId: "Local English",
        })),
      }
    : row);
  assert.throws(() => preparePermanentTeacherReplacement({
    command: permanentCommand,
    rows: mismatchedRows,
    actor: "Abby",
    fullAdmin: false,
  }), (error: unknown) => error instanceof OperationConfirmationError
    && error.code === "substitute_not_candidate"
    && /腾讯表科目分类/.test(error.message));
});

test("departure replacement never falls back to fuzzy matching when teacher subject classification is missing", () => {
  const unclassifiedRows = departureRows().map((row) => row.entity === "bookings"
    ? {
        ...row,
        payload: (row.payload as Array<Record<string, unknown>>).map((entry) => {
          const next = { ...entry };
          delete next.teacherSubjectId;
          return next;
        }),
      }
    : row);
  assert.throws(() => preparePermanentTeacherReplacement({
    command: permanentCommand,
    rows: unclassifiedRows,
    actor: "Abby",
    fullAdmin: false,
  }), (error: unknown) => error instanceof OperationConfirmationError
    && error.code === "invalid_shared_state"
    && /缺少老师腾讯表科目分类/.test(error.message));
});

test("departure conflict check includes lessons moved far from their source date", () => {
  const conflict = {
    id: "B-CONFLICT",
    studentId: "STU-OTHER",
    teacherId: "T-2",
    date: "2026-09-01",
    start: "17:00",
    duration: 60,
    recurring: false,
    timezone: "Australia/Melbourne",
    course: "Math",
    occurrenceOverrides: [{ occurrenceId: "B-CONFLICT:2026-09-01", date: "2026-09-22" }],
  };
  const conflictRows = departureRows().map((row) => row.entity === "bookings"
    ? { ...row, payload: [...row.payload as Record<string, unknown>[], conflict] }
    : row);
  assert.throws(() => preparePermanentTeacherReplacement({
    command: permanentCommand,
    rows: conflictRows,
    actor: "Abby",
    fullAdmin: false,
  }), (error: unknown) => error instanceof OperationConfirmationError && error.code === "substitute_conflict");
});
