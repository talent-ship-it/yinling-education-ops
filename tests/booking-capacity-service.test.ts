import assert from "node:assert/strict";
import test from "node:test";

import {
  BookingCapacityServiceError,
  parseBookingCapacityCommand,
  prepareBookingCapacityMutation,
  reconcileTeacherStudentCapacity,
  type BookingCapacityCommand,
} from "../lib/booking-capacity-service.ts";
import { createMonthlyAvailabilityWindows } from "../lib/teacher-availability.ts";
import type { OpsStateRow } from "../lib/ops-store.ts";

function row(entity: string, payload: unknown, version = 3): OpsStateRow {
  return { entity, payload, version, updated_at: "2026-08-13T00:00:00.000Z", updated_by: "Nixon" };
}

const availability = createMonthlyAvailabilityWindows({
  teacherId: "T-1",
  month: "2026-09",
  timezone: "Australia/Melbourne",
  slots: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "00:00", end: "23:59" })),
  idSeed: "fixture-1",
});
const availability2 = availability.map((window) => ({ ...window, teacherId: "T-2", id: window.id.replace("fixture-1", "fixture-2") }));

function sharedRows(bookings: unknown[] = [], owner = "Abby") {
  return [
    row("bookings", bookings),
    row("students", [{
      id: "S-1",
      name: "Student A",
      owner,
      course: "English",
      lessonPackages: [{
        id: "P-1",
        name: "English package",
        subjectIds: ["English"],
        purchaseRecords: [{ id: "BUY-1", purchasedAt: "2026-08-01T00:00:00.000Z", hours: 20 }],
        consumedHours: 0,
      }],
    }]),
    row("teachers", [
      { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 1, capacityAssignments: [], availabilityWindows: availability },
      { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
    ]),
  ];
}

function upsert(overrides: Partial<NonNullable<BookingCapacityCommand["booking"]>> = {}, bookingId = "B-1"): BookingCapacityCommand {
  return {
    action: "upsert",
    bookingId,
    expectedVersions: { bookings: 3, students: 3, teachers: 3 },
    booking: {
      studentId: "S-1",
      teacherId: "T-1",
      date: "2026-09-07",
      start: "10:00",
      duration: 60,
      kind: "常规课",
      timezone: "Australia/Melbourne",
      recurring: false,
      repeatCount: 1,
      packageId: "P-1",
      subjectId: "English",
      teacherSubjectId: "Local English",
      ...overrides,
    },
  };
}

function error(code: BookingCapacityServiceError["code"]) {
  return (value: unknown) => value instanceof BookingCapacityServiceError && value.code === code;
}

test("request is a narrow command and rejects client state payloads", () => {
  assert.deepEqual(parseBookingCapacityCommand(upsert()), upsert());
  assert.throws(() => parseBookingCapacityCommand({ ...upsert(), teachers: [] }), error("client_fields_forbidden"));
  assert.throws(() => parseBookingCapacityCommand({ ...upsert(), booking: { ...upsert().booking, status: "已完成" } }), error("client_fields_forbidden"));
  assert.deepEqual(parseBookingCapacityCommand({
    action: "delete", bookingId: "B-1", expectedVersions: { bookings: 3, students: 3, teachers: 3 },
  }).action, "delete");
});

test("first non-substitute booking consumes exactly one stable capacity assignment", () => {
  const prepared = prepareBookingCapacityMutation({ command: upsert(), rows: sharedRows(), actor: "Abby", fullAdmin: false, now: new Date("2026-08-13T00:00:00Z") });
  assert.equal(prepared.action, "create");
  assert.match(prepared.commandKey, /^booking-capacity:[a-f0-9]{64}$/);
  assert.equal(prepared.teachers[0].newStudentCapacity, 0);
  assert.deepEqual(prepared.teachers[0].capacityAssignments, ["S-1"]);
  assert.equal(prepared.bookings[0].course, "English");
  assert.equal(prepared.bookings[0].packageId, "P-1");
  assert.equal(prepared.bookings[0].teacherSubjectId, "Local English");
});

test("every first non-substitute relationship requires explicit teacher acceptance", () => {
  const notAccepting = sharedRows().map((state) => state.entity === "teachers" ? row("teachers", [
    { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: false, newStudentCapacity: 1, capacityAssignments: [], availabilityWindows: availability },
    { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
  ]) : state);

  assert.throws(() => prepareBookingCapacityMutation({
    command: upsert({ kind: "常规课" }),
    rows: notAccepting,
    actor: "Abby",
    fullAdmin: false,
    now: new Date("2026-08-13T00:00:00Z"),
  }), error("teacher_not_accepting"));
});

test("an existing non-substitute teacher/student relationship may be scheduled while intake is paused", () => {
  const existing = {
    id: "B-EXISTING", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: false, repeatCount: 1,
    packageId: "P-1", course: "English",
  };
  const rows = sharedRows([existing]).map((state) => state.entity === "teachers" ? row("teachers", [
    { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: false, newStudentCapacity: 0, capacityAssignments: ["S-1"], availabilityWindows: availability },
    { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
  ]) : state);

  const prepared = prepareBookingCapacityMutation({
    command: upsert({ date: "2026-09-08" }, "B-2"),
    rows,
    actor: "Abby",
    fullAdmin: false,
    now: new Date("2026-08-13T00:00:00Z"),
  });
  assert.equal(prepared.action, "create");
  assert.equal(prepared.teachers[0].newStudentCapacity, 0);
  assert.deepEqual(prepared.teachers[0].capacityAssignments, ["S-1"]);
});

test("first non-substitute relationship requires explicitly configured capacity", () => {
  const missingCapacity = sharedRows().map((state) => state.entity === "teachers" ? row("teachers", [
    { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: true, capacityAssignments: [], availabilityWindows: availability },
    { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
  ]) : state);
  assert.throws(() => prepareBookingCapacityMutation({
    command: upsert(), rows: missingCapacity, actor: "Abby", fullAdmin: false, now: new Date("2026-08-13T00:00:00Z"),
  }), error("teacher_capacity_unconfigured"));

  const unsafeCapacity = sharedRows().map((state) => state.entity === "teachers" ? row("teachers", [
    { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 1.5, capacityAssignments: [], availabilityWindows: availability },
    { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
  ]) : state);
  assert.throws(() => prepareBookingCapacityMutation({
    command: upsert(), rows: unsafeCapacity, actor: "Abby", fullAdmin: false, now: new Date("2026-08-13T00:00:00Z"),
  }), error("invalid_shared_state"));
});

test("another booking for the same teacher/student does not consume again", () => {
  const first = prepareBookingCapacityMutation({ command: upsert(), rows: sharedRows(), actor: "Abby", fullAdmin: false, now: new Date("2026-08-13T00:00:00Z") });
  const rows = sharedRows(first.bookings as unknown[]).map((state) => state.entity === "teachers" ? row("teachers", first.teachers) : state);
  const second = prepareBookingCapacityMutation({
    command: upsert({ date: "2026-09-08" }, "B-2"), rows, actor: "Abby", fullAdmin: false, now: new Date("2026-08-13T00:00:00Z"),
  });
  assert.equal(second.teachers[0].newStudentCapacity, 0);
  assert.deepEqual(second.teachers[0].capacityAssignments, ["S-1"]);
});

test("substitute never consumes capacity", () => {
  const paused = sharedRows().map((state) => state.entity === "teachers" ? row("teachers", [
    { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: false, newStudentCapacity: 1, capacityAssignments: [], availabilityWindows: availability },
    { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
  ]) : state);
  const prepared = prepareBookingCapacityMutation({
    command: upsert({ kind: "代课" }), rows: paused, actor: "Abby", fullAdmin: false, now: new Date("2026-08-13T00:00:00Z"),
  });
  assert.equal(prepared.teachers[0].newStudentCapacity, 1);
  assert.deepEqual(prepared.teachers[0].capacityAssignments, []);
});

test("admin teacher move releases the old relationship and consumes the new one", () => {
  const currentBooking = {
    id: "B-1", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: false, repeatCount: 1,
    packageId: "P-1", course: "English", requestedAt: "2026-08-01T00:00:00Z",
  };
  const rows = sharedRows([currentBooking]).map((state) => state.entity === "teachers" ? row("teachers", [
    { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 0, capacityAssignments: ["S-1"], availabilityWindows: availability },
    { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
  ]) : state);
  const prepared = prepareBookingCapacityMutation({ command: upsert({ teacherId: "T-2" }), rows, actor: "Nixon", fullAdmin: true, now: new Date("2026-08-13T00:00:00Z") });
  assert.deepEqual(prepared.changedTeacherIds, ["T-1", "T-2"]);
  assert.equal(prepared.teachers[0].newStudentCapacity, 1);
  assert.deepEqual(prepared.teachers[0].capacityAssignments, []);
  assert.equal(prepared.teachers[1].newStudentCapacity, 1);
  assert.deepEqual(prepared.teachers[1].capacityAssignments, ["S-1"]);
});

test("deleting the final relationship restores capacity, but not while another relationship remains", () => {
  const current = {
    id: "B-1", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: false, repeatCount: 1,
    packageId: "P-1", course: "English",
  };
  const teachers = [
    { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 0, capacityAssignments: ["S-1"], availabilityWindows: availability },
    { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
  ];
  const command: BookingCapacityCommand = { action: "delete", bookingId: "B-1", expectedVersions: { bookings: 3, students: 3, teachers: 3 } };
  const singleRows = sharedRows([current]).map((state) => state.entity === "teachers" ? row("teachers", teachers) : state);
  const single = prepareBookingCapacityMutation({ command, rows: singleRows, actor: "Nixon", fullAdmin: true });
  assert.equal(single.teachers[0].newStudentCapacity, 1);
  assert.deepEqual(single.teachers[0].capacityAssignments, []);

  const other = { ...current, id: "B-2", date: "2026-09-08" };
  const multipleRows = sharedRows([current, other]).map((state) => state.entity === "teachers" ? row("teachers", teachers) : state);
  const multiple = prepareBookingCapacityMutation({ command, rows: multipleRows, actor: "Nixon", fullAdmin: true });
  assert.equal(multiple.teachers[0].newStudentCapacity, 0);
  assert.deepEqual(multiple.teachers[0].capacityAssignments, ["S-1"]);
});

test("non-trial package/subject is mandatory and checked on the server", () => {
  assert.throws(() => prepareBookingCapacityMutation({ command: upsert({ packageId: undefined }), rows: sharedRows(), actor: "Abby", fullAdmin: false }), error("package_required"));
  assert.throws(() => prepareBookingCapacityMutation({ command: upsert({ subjectId: "Math" }), rows: sharedRows(), actor: "Abby", fullAdmin: false }), error("subject_not_allowed"));
  assert.throws(() => prepareBookingCapacityMutation({ command: upsert({ packageId: "P-X" }), rows: sharedRows(), actor: "Abby", fullAdmin: false }), error("package_subject_mismatch"));
});

test("teacher subject qualification is bound to the authoritative Tencent sub-sheet", () => {
  assert.throws(() => prepareBookingCapacityMutation({
    command: upsert({ teacherSubjectId: "Maths&Science" }),
    rows: sharedRows(),
    actor: "Abby",
    fullAdmin: false,
  }), error("teacher_subject_not_allowed"));
  assert.throws(() => parseBookingCapacityCommand({
    ...upsert(),
    booking: { ...upsert().booking, teacherSubjectId: undefined },
  }), error("invalid_request"));
});

test("non-trial bookings cannot use an exhausted or overdrawn package", () => {
  for (const consumedHours of [20, 21]) {
    const rows = sharedRows().map((state) => state.entity === "students" ? row("students", [{
      id: "S-1",
      name: "Student A",
      owner: "Abby",
      course: "English",
      lessonPackages: [{
        id: "P-1",
        name: "English package",
        subjectIds: ["English"],
        purchaseRecords: [{ id: "BUY-1", purchasedAt: "2026-08-01T00:00:00.000Z", hours: 20 }],
        consumedHours,
      }],
    }]) : state);
    assert.throws(() => prepareBookingCapacityMutation({
      command: upsert(), rows, actor: "Abby", fullAdmin: false, now: new Date("2026-08-13T00:00:00Z"),
    }), error("package_balance_insufficient"));
  }
});

test("package balance reserves every active occurrence without double-counting an edited series", () => {
  const lowBalanceRows = sharedRows().map((state) => state.entity === "students" ? row("students", [{
    id: "S-1",
    name: "Student A",
    owner: "Abby",
    course: "English",
    lessonPackages: [{
      id: "P-1",
      name: "English package",
      subjectIds: ["English"],
      purchaseRecords: [{ id: "BUY-1", purchasedAt: "2026-08-01T00:00:00.000Z", hours: 20 }],
      consumedHours: 17,
    }],
  }]) : state);
  assert.throws(() => prepareBookingCapacityMutation({
    command: upsert({ recurring: true, repeatCount: 4 }),
    rows: lowBalanceRows,
    actor: "Abby",
    fullAdmin: false,
    now: new Date("2026-08-13T00:00:00Z"),
  }), error("package_balance_insufficient"));

  const existing = {
    id: "B-1", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: true, repeatCount: 3,
    packageId: "P-1", course: "English", requestedAt: "2026-08-01T00:00:00.000Z",
  };
  const edited = prepareBookingCapacityMutation({
    command: upsert({ recurring: true, repeatCount: 3 }),
    rows: lowBalanceRows.map((state) => state.entity === "bookings" ? row("bookings", [existing]) : state),
    actor: "Nixon",
    fullAdmin: true,
    now: new Date("2026-08-13T00:00:00Z"),
  });
  assert.equal(edited.action, "update");
});

test("package reservations include other series and ignore cancelled or leave occurrences", () => {
  const existing = {
    id: "B-OTHER", studentId: "S-1", teacherId: "T-2", date: "2026-09-08", start: "12:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: true, repeatCount: 20,
    packageId: "P-1", course: "English",
  };
  assert.throws(() => prepareBookingCapacityMutation({
    command: upsert({}, "B-NEW"),
    rows: sharedRows([existing]),
    actor: "Nixon",
    fullAdmin: true,
    now: new Date("2026-08-13T00:00:00Z"),
  }), error("package_balance_insufficient"));

  const cancelled = {
    ...existing,
    occurrenceOverrides: Array.from({ length: 20 }, (_, index) => {
      const date = new Date("2026-09-08T00:00:00.000Z");
      date.setUTCDate(date.getUTCDate() + index * 7);
      return { occurrenceId: `B-OTHER:${date.toISOString().slice(0, 10)}`, status: index % 2 ? "leave" : "cancelled" };
    }),
  };
  const prepared = prepareBookingCapacityMutation({
    command: upsert({}, "B-NEW"),
    rows: sharedRows([cancelled]),
    actor: "Nixon",
    fullAdmin: true,
    now: new Date("2026-08-13T00:00:00Z"),
  });
  assert.equal(prepared.action, "create");
});

test("historical unsettled occurrences do not consume the future scheduling balance", () => {
  const historical = {
    id: "B-HISTORY", studentId: "S-1", teacherId: "T-2", date: "2026-01-05", start: "12:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: true, repeatCount: 20,
    packageId: "P-1", course: "English",
  };
  const prepared = prepareBookingCapacityMutation({
    command: upsert({}, "B-NEW"),
    rows: sharedRows([historical]),
    actor: "Nixon",
    fullAdmin: true,
    now: new Date("2026-08-13T00:00:00Z"),
  });
  assert.equal(prepared.action, "create");
});

test("archived students reject booking creates, edits, and deletes for every operator role", () => {
  const current = {
    id: "B-1", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: false, repeatCount: 1,
    packageId: "P-1", course: "English",
  };
  const archivedRows = sharedRows([current]).map((state) => state.entity === "students"
    ? { ...state, payload: (state.payload as Record<string, unknown>[]).map((student) => ({ ...student, importArchived: true })) }
    : state);

  for (const input of [
    { command: upsert({}, "B-NEW"), actor: "Abby", fullAdmin: false },
    { command: upsert(), actor: "Nixon", fullAdmin: true },
    { command: upsert(), actor: "Ops Admin", fullAdmin: false },
  ]) {
    assert.throws(() => prepareBookingCapacityMutation({
      ...input,
      rows: archivedRows,
      now: new Date("2026-08-13T00:00:00Z"),
    }), error("student_scope_forbidden"));
  }

  const command: BookingCapacityCommand = {
    action: "delete",
    bookingId: "B-1",
    expectedVersions: { bookings: 3, students: 3, teachers: 3 },
  };
  for (const input of [
    { actor: "Abby", fullAdmin: false },
    { actor: "Nixon", fullAdmin: true },
    { actor: "Ops Admin", fullAdmin: false },
  ]) {
    assert.throws(() => prepareBookingCapacityMutation({ command, rows: archivedRows, ...input }), error("student_scope_forbidden"));
  }
});

test("staff is owner-scoped and teachers cannot mutate capacity or assignments", () => {
  assert.throws(() => prepareBookingCapacityMutation({ command: upsert(), rows: sharedRows([], "Thea"), actor: "Abby", fullAdmin: false }), error("student_scope_forbidden"));
  assert.throws(() => prepareBookingCapacityMutation({ command: upsert(), rows: sharedRows(), actor: "Helen Ceperkovic", fullAdmin: false }), error("student_scope_forbidden"));
});

test("reviewed relationship transitions atomically release and consume capacity", () => {
  const result = reconcileTeacherStudentCapacity({
    teachers: [
      { id: "T-1", name: "Old", newStudentCapacity: 0, capacityAssignments: ["S-1"] },
      { id: "T-2", name: "New", newStudentCapacity: 2, capacityAssignments: [] },
    ],
    transitions: [
      { teacherId: "T-1", studentId: "S-1", beforeActive: true, afterActive: false },
      { teacherId: "T-2", studentId: "S-1", beforeActive: false, afterActive: true },
    ],
  });
  assert.deepEqual(result.changedTeacherIds, ["T-1", "T-2"]);
  assert.deepEqual(result.teachers.map((teacher) => ({
    id: teacher.id,
    remaining: teacher.newStudentCapacity,
    assignments: teacher.capacityAssignments,
  })), [
    { id: "T-1", remaining: 1, assignments: [] },
    { id: "T-2", remaining: 1, assignments: ["S-1"] },
  ]);
});

test("reviewed relationship transitions fail closed without configured capacity", () => {
  assert.throws(() => reconcileTeacherStudentCapacity({
    teachers: [{ id: "T-2", name: "New", capacityAssignments: [] }],
    transitions: [{ teacherId: "T-2", studentId: "S-1", beforeActive: false, afterActive: true }],
  }), error("teacher_capacity_unconfigured"));
});
