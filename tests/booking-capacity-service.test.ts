import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

// Fixtures describe August/September 2026; freeze the implicit clock for repeatable validation.
beforeEach((context) => context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-24T00:00:00Z") }));

import {
  BookingCapacityServiceError,
  bookingCapacityTeacherReplayAllowed,
  parseBookingCapacityCommand,
  prepareBookingCapacityMutation,
  reconcileTeacherStudentCapacity,
  type BookingCapacityCommand,
} from "../lib/booking-capacity-service.ts";
import { meetingIdForOccurrenceValue } from "../lib/bbb-analytics.ts";
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
const octoberAvailability = createMonthlyAvailabilityWindows({
  teacherId: "T-1",
  month: "2026-10",
  timezone: "Australia/Melbourne",
  slots: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "00:00", end: "23:59" })),
  idSeed: "fixture-october-1",
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
    row("lpItems", []),
    row("tasks", []),
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
    expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
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
  assert.throws(() => parseBookingCapacityCommand({ ...upsert(), students: [], tasks: [] }), error("client_fields_forbidden"));
  assert.throws(() => parseBookingCapacityCommand({ ...upsert(), booking: { ...upsert().booking, status: "已完成" } }), error("client_fields_forbidden"));
  assert.deepEqual(parseBookingCapacityCommand({
    action: "delete", bookingId: "B-1", expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
  }).action, "delete");
  assert.deepEqual(parseBookingCapacityCommand({
    action: "cancel_occurrence",
    bookingId: "B-1",
    occurrenceId: "B-1:2026-09-07",
    expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
  }).action, "cancel_occurrence");
  assert.deepEqual(parseBookingCapacityCommand({
    action: "update_occurrence",
    bookingId: "B-1",
    occurrenceId: "B-1:2026-09-07",
    occurrence: { date: "2026-09-08", start: "11:00", duration: 90, status: "confirmed" },
    expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
  }).occurrence?.duration, 90);
  assert.throws(() => parseBookingCapacityCommand({
    action: "cancel_occurrence",
    bookingId: "B-1",
    occurrenceId: "B-OTHER:2026-09-07",
    expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
  }), error("invalid_request"));
  assert.throws(() => parseBookingCapacityCommand({
    action: "update_occurrence",
    bookingId: "B-1",
    occurrenceId: "B-1:2026-09-07",
    occurrence: { date: "2026-09-08", start: "11:00", duration: 90, status: "confirmed", tasks: [] },
    expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
  }), error("client_fields_forbidden"));
  const classroomCommand = {
    action: "bind_classroom",
    bookingId: "B-1",
    occurrenceId: "B-1:2026-09-07",
    classroom: { meetingId: meetingIdForOccurrenceValue("B-1:2026-09-07"), status: "ready" },
    expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
  } as const;
  assert.deepEqual(parseBookingCapacityCommand(classroomCommand), classroomCommand);
  assert.throws(() => parseBookingCapacityCommand({ ...classroomCommand, classroom: { ...classroomCommand.classroom, createdAt: "2026-08-24T00:00:00.000Z" } }), error("client_fields_forbidden"));
  assert.throws(() => parseBookingCapacityCommand({ ...classroomCommand, action: "update_occurrence", occurrence: { date: "2026-09-07", start: "10:00", duration: 60, status: "confirmed" } }), error("client_fields_forbidden"));
});

test("a substituted occurrence uses its effective teacher AVA and leaves sibling availability alone", () => {
  const series = {
    ...upsert().booking!, id: "B-1", recurring: true, repeatCount: 3, recurrenceIntervalDays: 7,
    course: "English",
    occurrenceOverrides: [
      { occurrenceId: "B-1:2026-09-07", status: "completed" },
      { occurrenceId: "B-1:2026-09-21", teacherId: "T-2" },
    ],
  };
  const rows = sharedRows([series]).map((state) => state.entity === "teachers"
    ? row("teachers", [
        { id: "T-1", name: "Teacher A", subjects: ["Local English"], availabilityWindows: [] },
        { id: "T-2", name: "Teacher B", subjects: ["Local English"], availabilityWindows: availability2 },
      ]) : state);
  const command: BookingCapacityCommand = {
    action: "update_occurrence", bookingId: "B-1", occurrenceId: "B-1:2026-09-21",
    occurrence: { date: "2026-09-22", start: "11:00", duration: 60, status: "confirmed" },
    expectedVersions: upsert().expectedVersions,
  };
  const prepared = prepareBookingCapacityMutation({ command, rows, actor: "Nixon", fullAdmin: true, now: new Date("2026-09-15T00:00:00Z") });
  const overrides = prepared.bookings[0].occurrenceOverrides as Array<Record<string, unknown>>;
  assert.deepEqual(overrides.find((item) => item.occurrenceId === "B-1:2026-09-07"), series.occurrenceOverrides[0]);
  assert.equal(overrides.find((item) => item.occurrenceId === command.occurrenceId)?.teacherId, "T-2");
  assert.equal(overrides.find((item) => item.occurrenceId === command.occurrenceId)?.date, "2026-09-22");

  const unavailableSubstitute = rows.map((state) => state.entity === "teachers"
    ? row("teachers", [
        { id: "T-1", name: "Teacher A", subjects: ["Local English"], availabilityWindows: availability },
        { id: "T-2", name: "Teacher B", subjects: ["Local English"], availabilityWindows: [] },
      ]) : state);
  assert.throws(() => prepareBookingCapacityMutation({ command, rows: unavailableSubstitute, actor: "Nixon", fullAdmin: true }), error("teacher_unavailable"));
});

test("single-occurrence edits still reject both same-series and effective-teacher conflicts", () => {
  const series = {
    ...upsert().booking!, id: "B-1", recurring: true, repeatCount: 3, recurrenceIntervalDays: 7,
    course: "English", occurrenceOverrides: [{ occurrenceId: "B-1:2026-09-21", teacherId: "T-2" }],
  };
  const command: BookingCapacityCommand = {
    action: "update_occurrence", bookingId: "B-1", occurrenceId: "B-1:2026-09-21",
    occurrence: { date: "2026-09-14", start: "10:00", duration: 60, status: "confirmed" },
    expectedVersions: upsert().expectedVersions,
  };
  assert.throws(() => prepareBookingCapacityMutation({ command, rows: sharedRows([series]), actor: "Nixon", fullAdmin: true }), error("schedule_conflict"));
  const other = { ...series, id: "B-2", studentId: "S-2", teacherId: "T-2", date: "2026-09-22", start: "11:00", recurring: false, repeatCount: 1, occurrenceOverrides: [] };
  const moved = { ...command, occurrence: { ...command.occurrence!, date: "2026-09-22", start: "11:00" } };
  assert.throws(() => prepareBookingCapacityMutation({ command: moved, rows: sharedRows([series, other]), actor: "Nixon", fullAdmin: true }), error("schedule_conflict"));
});

test("bind_classroom merges an authoritative occurrence classroom without changing schedule fields", () => {
  const current = {
    id: "B-CLASSROOM", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "试听", status: "待确认", timezone: "Australia/Melbourne", recurring: false, repeatCount: 1,
    course: "English", teacherSubjectId: "Local English",
  };
  const occurrenceId = "B-CLASSROOM:2026-09-07";
  const meetingId = meetingIdForOccurrenceValue(occurrenceId);
  const command = {
    action: "bind_classroom" as const,
    bookingId: "B-CLASSROOM",
    occurrenceId,
    classroom: { meetingId, status: "ready" as const },
    expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
  };
  const prepared = prepareBookingCapacityMutation({
    command,
    rows: sharedRows([current]),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-24T00:00:00.000Z"),
  });
  assert.equal(prepared.action, "update");
  assert.equal(prepared.studentId, "S-1");
  assert.equal(prepared.teacherId, "T-1");
  assert.deepEqual(prepared.bookings[0], {
    ...current,
    occurrenceOverrides: [{
      occurrenceId,
      classroom: {
        occurrenceId,
        meetingId,
        status: "ready",
        createdAt: "2026-08-24T00:00:00.000Z",
      },
    }],
  });
  const running = prepareBookingCapacityMutation({
    command: { ...command, classroom: { meetingId, status: "running" } },
    rows: sharedRows(prepared.bookings as unknown[]),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-24T00:01:00.000Z"),
  });
  const ended = prepareBookingCapacityMutation({
    command: { ...command, classroom: { meetingId, status: "ended" } },
    rows: sharedRows(running.bookings as unknown[]),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-24T00:02:00.000Z"),
  });
  assert.equal((ended.bookings[0].occurrenceOverrides as Record<string, unknown>[])[0].classroom && ((ended.bookings[0].occurrenceOverrides as Record<string, unknown>[])[0].classroom as Record<string, unknown>).status, "ended");
  const replayedStale = prepareBookingCapacityMutation({
    command: { ...command, classroom: { meetingId, status: "ready" } },
    rows: sharedRows(ended.bookings as unknown[]),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-24T00:03:00.000Z"),
  });
  assert.equal(((replayedStale.bookings[0].occurrenceOverrides as Record<string, unknown>[])[0].classroom as Record<string, unknown>).status, "ended");
  assert.throws(() => prepareBookingCapacityMutation({
    command: { ...command, classroom: { meetingId: "yinling-occ-000000000000000000000000000000000000000000000000", status: "ready" } },
    rows: sharedRows([current]),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
  }), error("classroom_meeting_id_mismatch"));
  assert.throws(() => prepareBookingCapacityMutation({
    command,
    rows: sharedRows([current]),
    actor: "Abby",
    role: "staff",
    fullAdmin: false,
  }), error("classroom_scope_forbidden"));
  const fabricatedOccurrenceId = "B-CLASSROOM:2026-09-08";
  assert.throws(() => prepareBookingCapacityMutation({
    command: {
      ...command,
      occurrenceId: fabricatedOccurrenceId,
      classroom: { meetingId: meetingIdForOccurrenceValue(fabricatedOccurrenceId), status: "ready" },
    },
    rows: sharedRows([current]),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
  }), error("classroom_occurrence_not_found"));

  const substituted = {
    ...current,
    teacherId: "T-1",
    occurrenceOverrides: [{ occurrenceId, teacherId: "T-2", status: "confirmed" }],
  };
  const teacherBinding = prepareBookingCapacityMutation({
    command,
    rows: sharedRows([substituted]),
    actor: "Teacher B",
    role: "teacher",
    fullAdmin: false,
  });
  assert.equal(teacherBinding.teacherId, "T-2");
});

test("upsert_bind_classroom validates and prepares Booking plus classroom in one projection payload", () => {
  const bookingId = "TMP-COMBINED";
  const occurrenceId = `${bookingId}:2026-09-07`;
  const command = {
    ...upsert({}, bookingId),
    action: "upsert_bind_classroom" as const,
    occurrenceId,
    classroom: { meetingId: meetingIdForOccurrenceValue(occurrenceId), status: "ready" as const },
  };
  assert.deepEqual(parseBookingCapacityCommand(command), command);
  const prepared = prepareBookingCapacityMutation({
    command,
    rows: sharedRows(),
    actor: "Ops Admin",
    role: "limited-admin",
    fullAdmin: false,
    now: new Date("2026-08-24T00:00:00.000Z"),
  });
  const saved = prepared.bookings[0] as Record<string, unknown>;
  const override = (saved.occurrenceOverrides as Record<string, unknown>[])[0];
  assert.equal(prepared.action, "create");
  assert.equal(override.occurrenceId, occurrenceId);
  assert.deepEqual(override.classroom, {
    occurrenceId,
    meetingId: command.classroom.meetingId,
    status: "ready",
    createdAt: "2026-08-24T00:00:00.000Z",
  });
  assert.throws(() => prepareBookingCapacityMutation({
    command,
    rows: sharedRows(),
    actor: "Abby",
    role: "staff",
    fullAdmin: false,
  }), error("classroom_scope_forbidden"));
  assert.throws(() => parseBookingCapacityCommand({
    ...command,
    classroom: { meetingId: "yinling-occ-000000000000000000000000000000000000000000000000", status: "ready" },
  }), error("classroom_meeting_id_mismatch"));
});

test("temporary classroom booking semantics accept a supported non-Melbourne display zone across DST", () => {
  const command = upsert({
    date: "2026-10-05",
    start: "10:00",
    timezone: "Australia/Sydney",
  }, "TMP-SYDNEY-DST");
  const prepared = prepareBookingCapacityMutation({
    command: {
      ...command,
      action: "upsert_bind_classroom",
      occurrenceId: "TMP-SYDNEY-DST:2026-10-05",
      classroom: {
        meetingId: meetingIdForOccurrenceValue("TMP-SYDNEY-DST:2026-10-05"),
        status: "ready",
      },
    },
    rows: sharedRows().map((state) => state.entity === "teachers"
      ? row("teachers", [
        { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 1, capacityAssignments: [], availabilityWindows: octoberAvailability },
        { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
      ])
      : state),
    actor: "Ops Admin",
    role: "limited-admin",
    fullAdmin: false,
    now: new Date("2026-08-24T00:00:00.000Z"),
  });
  assert.equal((prepared.bookings[0] as Record<string, unknown>).timezone, "Australia/Sydney");
});

test("classroom binds reject a fabricated non-recurring source date", () => {
  const bookingId = "TMP-CROSS-DATE";
  const occurrenceId = `${bookingId}:2026-09-08`;
  const command = {
    ...upsert({}, bookingId),
    action: "upsert_bind_classroom" as const,
    occurrenceId,
    classroom: { meetingId: meetingIdForOccurrenceValue(occurrenceId), status: "ready" as const },
  };
  assert.throws(() => prepareBookingCapacityMutation({
    command,
    rows: sharedRows(),
    actor: "Ops Admin",
    role: "admin",
    fullAdmin: true,
  }), error("classroom_occurrence_not_found"));
});

test("classroom binds accept only concrete source dates in a recurring series", () => {
  const bookingId = "TMP-RECURRING";
  const recurring = upsert({ recurring: true, repeatCount: 3, recurrenceIntervalDays: 7, recurrenceEndDate: "2026-09-21" }, bookingId);
  const invalidOccurrenceId = `${bookingId}:2026-09-08`;
  assert.throws(() => prepareBookingCapacityMutation({
    command: {
      ...recurring,
      action: "upsert_bind_classroom" as const,
      occurrenceId: invalidOccurrenceId,
      classroom: { meetingId: meetingIdForOccurrenceValue(invalidOccurrenceId), status: "ready" as const },
    },
    rows: sharedRows(),
    actor: "Ops Admin",
    role: "admin",
    fullAdmin: true,
  }), error("classroom_occurrence_not_found"));

  const validOccurrenceId = `${bookingId}:2026-09-14`;
  const prepared = prepareBookingCapacityMutation({
    command: {
      ...recurring,
      action: "upsert_bind_classroom" as const,
      occurrenceId: validOccurrenceId,
      classroom: { meetingId: meetingIdForOccurrenceValue(validOccurrenceId), status: "ready" as const },
    },
    rows: sharedRows(),
    actor: "Ops Admin",
    role: "admin",
    fullAdmin: true,
  });
  assert.equal(prepared.action, "create");
});

test("persists interval recurrence and rejects invalid custom intervals", () => {
  const custom = upsert({ recurring: true, repeatCount: 3, recurrenceIntervalDays: 3 });
  const parsed = parseBookingCapacityCommand(custom);
  assert.equal(parsed.booking?.recurrenceIntervalDays, 3);
  assert.equal(prepareBookingCapacityMutation({ command: custom, rows: sharedRows(), actor: "Abby", fullAdmin: false, now: new Date("2026-08-13T00:00:00Z") }).bookings[0].recurrenceIntervalDays, 3);
  assert.throws(() => parseBookingCapacityCommand(upsert({ recurring: true, repeatCount: 2, recurrenceIntervalDays: 366 })), error("invalid_request"));
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
  const command: BookingCapacityCommand = { action: "delete", bookingId: "B-1", expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 } };
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

test("recurring cancellation releases capacity only after the last active occurrence", () => {
  const series = {
    id: "B-SERIES", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "试听", status: "待确认", timezone: "Australia/Melbourne", recurring: true, repeatCount: 3,
    recurrenceIntervalDays: 7, recurrenceEndDate: "2026-09-21", course: "English",
    teacherSubjectId: "Local English", requestedAt: "2026-08-01T00:00:00.000Z",
  };
  const withCapacity = (bookings: unknown[], teachers?: readonly Record<string, unknown>[]) => sharedRows(bookings)
    .map((state) => state.entity === "teachers" ? row("teachers", teachers ?? [
      { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 0, capacityAssignments: ["S-1"], availabilityWindows: availability },
      { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
    ]) : state);
  const cancel = (occurrenceId: string): BookingCapacityCommand => ({
    action: "cancel_occurrence",
    bookingId: "B-SERIES",
    occurrenceId,
    expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
  });

  const middle = prepareBookingCapacityMutation({
    command: cancel("B-SERIES:2026-09-14"), rows: withCapacity([series]), actor: "Nixon", fullAdmin: true,
  });
  assert.equal(middle.action, "update");
  assert.equal(middle.teachers[0].newStudentCapacity, 0);
  assert.deepEqual(middle.teachers[0].capacityAssignments, ["S-1"]);
  assert.deepEqual((middle.bookings[0].occurrenceOverrides as Record<string, unknown>[])[0], {
    occurrenceId: "B-SERIES:2026-09-14", status: "cancelled",
  });

  const first = prepareBookingCapacityMutation({
    command: cancel("B-SERIES:2026-09-07"),
    rows: withCapacity(middle.bookings as unknown[], middle.teachers),
    actor: "Nixon",
    fullAdmin: true,
  });
  assert.equal(first.teachers[0].newStudentCapacity, 0);

  const last = prepareBookingCapacityMutation({
    command: cancel("B-SERIES:2026-09-21"),
    rows: withCapacity(first.bookings as unknown[], first.teachers),
    actor: "Nixon",
    fullAdmin: true,
  });
  assert.equal(last.teachers[0].newStudentCapacity, 1);
  assert.deepEqual(last.teachers[0].capacityAssignments, []);
  assert.deepEqual(last.changedTeacherIds, ["T-1"]);
});

test("occurrence commands honor a 14-day end bound and reject out-of-series dates", () => {
  const series = {
    id: "B-14", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "试听", status: "待确认", timezone: "Australia/Melbourne", recurring: true,
    recurrenceIntervalDays: 14, recurrenceEndDate: "2026-10-20", course: "English",
    teacherSubjectId: "Local English", requestedAt: "2026-08-01T00:00:00.000Z",
  };
  const rows = sharedRows([series]).map((state) => state.entity === "teachers" ? row("teachers", [
    { id: "T-1", name: "Teacher A", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 0, capacityAssignments: ["S-1"], availabilityWindows: availability },
    { id: "T-2", name: "Teacher B", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: availability2 },
  ]) : state);
  const valid: BookingCapacityCommand = {
    action: "cancel_occurrence", bookingId: "B-14", occurrenceId: "B-14:2026-10-05",
    expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
  };
  const prepared = prepareBookingCapacityMutation({ command: valid, rows, actor: "Nixon", fullAdmin: true });
  assert.equal(prepared.bookings[0].recurrenceIntervalDays, 14);
  assert.equal(prepared.bookings[0].recurrenceEndDate, "2026-10-20");
  assert.throws(() => prepareBookingCapacityMutation({
    command: { ...valid, occurrenceId: "B-14:2026-10-12" }, rows, actor: "Nixon", fullAdmin: true,
  }), error("occurrence_not_found"));
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
    command: upsert({ recurring: true, repeatCount: 4, recurrenceIntervalDays: 7 }),
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
    command: upsert({ recurring: true, repeatCount: 3, recurrenceIntervalDays: 7 }),
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

test("capacity conflict closure includes a far source occurrence moved into the target range", () => {
  const movedIn = {
    id: "B-MOVED-IN", studentId: "S-1", teacherId: "T-1", date: "2026-08-01", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: true, repeatCount: 12,
    recurrenceIntervalDays: 7, packageId: "P-1", course: "English",
    occurrenceOverrides: [{ occurrenceId: "B-MOVED-IN:2026-08-08", date: "2026-09-10" }],
  };
  assert.throws(() => prepareBookingCapacityMutation({
    command: upsert({ date: "2026-09-10" }, "B-NEW"),
    rows: sharedRows([movedIn]),
    actor: "Nixon",
    fullAdmin: true,
    now: new Date("2026-08-13T00:00:00Z"),
  }), error("schedule_conflict"));
});

test("series updates retain moved overrides and reject a collision at the moved target", () => {
  const current = {
    id: "B-EDIT-MOVED", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: true, repeatCount: 2,
    recurrenceIntervalDays: 7, packageId: "P-1", course: "English",
    occurrenceOverrides: [{ occurrenceId: "B-EDIT-MOVED:2026-09-14", date: "2026-09-20" }],
  };
  const other = {
    id: "B-OTHER-MOVED", studentId: "S-1", teacherId: "T-2", date: "2026-09-20", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: false, repeatCount: 1,
    packageId: "P-1", course: "English",
  };
  assert.throws(() => prepareBookingCapacityMutation({
    command: upsert({ recurring: true, repeatCount: 2, recurrenceIntervalDays: 7 }, current.id),
    rows: sharedRows([current, other]),
    actor: "Nixon",
    fullAdmin: true,
    now: new Date("2026-08-13T00:00:00Z"),
  }), error("schedule_conflict"));
});

test("series updates reject two own source occurrences that resolve to one overlapping target", () => {
  const current = {
    id: "B-OWN-COLLISION", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: true, repeatCount: 2,
    recurrenceIntervalDays: 7, packageId: "P-1", course: "English",
    occurrenceOverrides: [{ occurrenceId: "B-OWN-COLLISION:2026-09-14", date: "2026-09-07" }],
  };
  assert.throws(() => prepareBookingCapacityMutation({
    command: upsert({ recurring: true, repeatCount: 2, recurrenceIntervalDays: 7 }, current.id),
    rows: sharedRows([current]),
    actor: "Nixon",
    fullAdmin: true,
    now: new Date("2026-08-13T00:00:00Z"),
  }), error("schedule_conflict"));
});

test("series updates check teacher AVA at a moved target date, not only source dates", () => {
  const current = {
    id: "B-AVA-MOVED", studentId: "S-1", teacherId: "T-1", date: "2026-09-07", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: true, repeatCount: 2,
    recurrenceIntervalDays: 7, packageId: "P-1", course: "English",
    occurrenceOverrides: [{ occurrenceId: "B-AVA-MOVED:2026-09-14", date: "2026-10-01" }],
  };
  assert.throws(() => prepareBookingCapacityMutation({
    command: upsert({ recurring: true, repeatCount: 2, recurrenceIntervalDays: 7 }, current.id),
    rows: sharedRows([current]),
    actor: "Nixon",
    fullAdmin: true,
    now: new Date("2026-08-13T00:00:00Z"),
  }), error("teacher_unavailable"));
});

test("editing a legacy derived end date re-derives from the new repeat count", () => {
  const current = {
    id: "B-DERIVED-END", studentId: "S-1", teacherId: "T-1", date: "2026-09-01", start: "10:00", duration: 60,
    kind: "常规课", status: "待确认", timezone: "Australia/Melbourne", recurring: true, repeatCount: 2,
    recurrenceIntervalDays: 7, recurrenceEndDate: "2026-09-08", packageId: "P-1", course: "English",
  };
  const prepared = prepareBookingCapacityMutation({
    command: upsert({ date: "2026-09-01", recurring: true, repeatCount: 4, recurrenceIntervalDays: 7 }, current.id),
    rows: sharedRows([current]),
    actor: "Nixon",
    fullAdmin: true,
    now: new Date("2026-08-13T00:00:00Z"),
  });
  assert.equal(prepared.bookings[0].repeatCount, 4);
  assert.equal(prepared.bookings[0].recurrenceEndDate, undefined);
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
    expectedVersions: { bookings: 3, students: 3, lpItems: 3, tasks: 3, teachers: 3 },
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

test("a teacher cannot replay a staff/admin command or another teacher's receipt", () => {
  const allowedTeacherIds = new Set(["T-1"]);
  const base = {
    sessionRole: "teacher" as const,
    ledgerActorRole: "teacher" as const,
    action: "update" as const,
    allowedTeacherIds,
    teacherId: "T-1",
    previousTeacherId: "T-1",
    currentTeacherId: "T-1",
  };
  assert.equal(bookingCapacityTeacherReplayAllowed(base), true);
  assert.equal(bookingCapacityTeacherReplayAllowed({ ...base, ledgerActorRole: "staff" }), false);
  assert.equal(bookingCapacityTeacherReplayAllowed({ ...base, ledgerActorRole: "admin" }), false);
  assert.equal(bookingCapacityTeacherReplayAllowed({ ...base, action: "delete" }), false);
  assert.equal(bookingCapacityTeacherReplayAllowed({ ...base, currentTeacherId: "T-2" }), false);
  assert.equal(bookingCapacityTeacherReplayAllowed({ ...base, teacherId: "T-2" }), false);
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
