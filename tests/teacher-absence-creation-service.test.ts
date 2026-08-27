import assert from "node:assert/strict";
import test from "node:test";

import type { OpsStateRow } from "../lib/ops-store";
import { parseTeacherAbsenceCreationCommand, prepareTeacherAbsenceCreation } from "../lib/teacher-absence-creation-service";

const commandKey = "teacher-absence-create:123e4567-e89b-42d3-a456-426614174000";
const command = {
  commandKey,
  sourceTeacherId: "T-1",
  eventStart: "2026-09-15",
  eventEnd: "2026-09-22",
  type: "老师请假",
  detail: "原老师请假，先生成受影响学生预览与交接任务。",
  expectedVersions: { bookings: 3, operations: 4, students: 5, tasks: 6, teachers: 7 },
};
function rows(): OpsStateRow[] {
  return [
    { entity: "bookings", version: 3, updated_at: "", updated_by: "", payload: [{ id: "B-1", studentId: "S-1", teacherId: "T-1", date: "2026-09-15", start: "17:00", duration: 60, timezone: "Australia/Melbourne", kind: "常规课", status: "已确认", teacherSubjectId: "Maths", recurring: true, repeatCount: 2 }] },
    { entity: "operations", version: 4, updated_at: "", updated_by: "", payload: [] },
    { entity: "students", version: 5, updated_at: "", updated_by: "", payload: [{ id: "S-1", status: "在读", owner: "Abby" }] },
    { entity: "tasks", version: 6, updated_at: "", updated_by: "", payload: [] },
    { entity: "teachers", version: 7, updated_at: "", updated_by: "", payload: [{ id: "T-1", name: "原老师", subjects: ["Maths"] }, { id: "T-2", name: "代课老师", subjects: ["Maths"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: [{ id: "A-2", teacherId: "T-2", day: 2, start: "16:00", end: "20:00", timezone: "Australia/Melbourne", validFrom: "2026-09-01", validTo: "2026-09-30", excludedDates: [], overrides: [], source: "submission" }] }] },
  ];
}
function singleBooking(value: Record<string, unknown>) {
  const result = { ...value, recurring: false };
  delete result.repeatCount;
  delete result.recurrenceIntervalDays;
  delete result.recurrenceEndDate;
  return result;
}

test("teacher absence parser accepts only the narrow command", () => {
  assert.deepEqual(parseTeacherAbsenceCreationCommand(command), command);
  assert.throws(() => parseTeacherAbsenceCreationCommand({ ...command, expectedVersions: { ...command.expectedVersions, operations: 0 } }));
  assert.throws(() => parseTeacherAbsenceCreationCommand({ ...command, preview: true }));
});

test("teacher absence derives authoritative occurrence/student/subject preview and atomic payload", () => {
  const prepared = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(command), rows: rows(), actor: "Nixon", role: "admin", fullAdmin: true, now: new Date("2026-09-10T00:00:00.000Z") });
  assert.equal(prepared.affectedOccurrenceCount, 2);
  assert.equal(prepared.affectedGroups[0].firstAffectedAt, "2026-09-15T07:00:00.000Z");
  assert.deepEqual(prepared.affectedGroups[0].subjects, ["Maths"]);
  assert.deepEqual(prepared.operations.find((item) => item.id === prepared.operationIds[0])?.recommendedTeacherIds, ["T-2"]);
  assert.equal(prepared.tasks.filter((task) => task.ruleKey?.endsWith(":lp-handover")).length, 0, "no fabricated historical LP deadline");
  assert.equal(prepared.operations.length, prepared.operationIds.length);
});

test("teacher absence uses occurrence overrides to exclude moved-away lessons", () => {
  const current = rows().map((row) => row.entity === "bookings" ? { ...row, payload: [{ ...(row.payload as Record<string, unknown>[])[0], occurrenceOverrides: [{ occurrenceId: "B-1:2026-09-15", teacherId: "T-2", status: "confirmed" }] }] } : row);
  const prepared = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(command), rows: current, actor: "Nixon", role: "admin", fullAdmin: true });
  assert.deepEqual(prepared.affectedGroups[0].affectedOccurrenceIds, ["B-1:2026-09-22"]);
});

test("a confirmed workflow still prevents a duplicate teacher/range workflow", () => {
  const current = rows().map((row) => row.entity === "operations" ? { ...row, payload: [{ id: "OPS-EXISTING", type: "老师请假", teacherId: "T-1", eventStart: command.eventStart, eventEnd: command.eventEnd, status: "已确认" }] } : row);
  assert.throws(() => prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(command), rows: current, actor: "Nixon", role: "admin", fullAdmin: true }), /already exists/);
});

test("teacher absence includes a moved-in occurrence and ignores an explicit null teacher override", () => {
  const current = rows().map((row) => row.entity === "bookings" ? {
    ...row,
    payload: [
      ...(row.payload as Record<string, unknown>[]),
      { id: "B-IN", studentId: "S-1", teacherId: "T-OTHER", date: "2026-09-15", start: "18:00", duration: 60, timezone: "Australia/Melbourne", kind: "常规课", status: "已确认", teacherSubjectId: "Maths", occurrenceOverrides: [{ occurrenceId: "B-IN:2026-09-15", date: "2026-09-16", teacherId: "T-1", status: "confirmed" }] },
      { id: "B-NULL", studentId: "S-1", teacherId: "T-1", date: "2026-09-22", start: "18:00", duration: 60, timezone: "Australia/Melbourne", kind: "常规课", status: "已确认", teacherSubjectId: "Maths", occurrenceOverrides: [{ occurrenceId: "B-NULL:2026-09-22", teacherId: null, status: "confirmed" }] },
    ],
  } : row);
  const prepared = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(command), rows: current, actor: "Nixon", role: "admin", fullAdmin: true });
  assert.ok(prepared.affectedGroups[0].affectedOccurrenceIds.includes("B-IN:2026-09-15"));
  assert.ok(!prepared.affectedGroups[0].affectedOccurrenceIds.includes("B-NULL:2026-09-22"));
});

test("candidate AVA uses real instants, JS Sunday, exclusions, overrides, and DST-aware timezones", () => {
  const localCommand = { ...command, eventStart: "2026-10-03", eventEnd: "2026-10-03" };
  const window = { teacherId: "", day: 0, start: "09:30", end: "11:30", timezone: "Australia/Melbourne", validFrom: "2026-10-01", validTo: "2026-10-31", excludedDates: [] as string[], overrides: [] as Record<string, unknown>[], source: "submission" };
  const current = rows().map((row) => {
    if (row.entity === "bookings") return { ...row, payload: [{ id: "B-TZ", studentId: "S-1", teacherId: "T-1", date: "2026-10-03", start: "16:30", duration: 60, timezone: "America/Los_Angeles", kind: "常规课", teacherSubjectId: "Maths" }] };
    if (row.entity === "teachers") return { ...row, payload: [
      { id: "T-1", name: "原老师", subjects: ["Maths"] },
      { id: "T-SUN", subjects: ["Maths"], acceptsStudents: true, newStudentCapacity: 1, capacityAssignments: [], availabilityWindows: [{ ...window, id: "A-SUN", teacherId: "T-SUN" }] },
      { id: "T-EXCLUDED", subjects: ["Maths"], acceptsStudents: true, newStudentCapacity: 1, capacityAssignments: [], availabilityWindows: [{ ...window, id: "A-EX", teacherId: "T-EXCLUDED", excludedDates: ["2026-10-04"] }] },
      { id: "T-OVERRIDE", subjects: ["Maths"], acceptsStudents: true, newStudentCapacity: 1, capacityAssignments: [], availabilityWindows: [{ ...window, id: "A-OV", teacherId: "T-OVERRIDE", start: "12:00", end: "13:00", overrides: [{ id: "A-OV-DST", date: "2026-10-04", start: "09:30", end: "11:30" }] }] },
    ] };
    return row;
  });
  const prepared = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(localCommand), rows: current, actor: "Nixon", role: "admin", fullAdmin: true, now: new Date("2026-09-20T00:00:00.000Z") });
  assert.deepEqual(prepared.affectedGroups[0].candidateTeacherIds, ["T-OVERRIDE", "T-SUN"]);
});

test("candidate conflicts compare instants across booking timezones", () => {
  const current = rows().map((row) => row.entity === "bookings" ? { ...row, payload: [
    singleBooking((row.payload as Record<string, unknown>[])[0]),
    { id: "B-LA-CONFLICT", studentId: "S-OTHER", teacherId: "T-2", date: "2026-09-14", start: "23:30", duration: 60, timezone: "America/Los_Angeles", kind: "常规课", teacherSubjectId: "Maths" },
  ] } : row);
  const prepared = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand({ ...command, eventEnd: "2026-09-15" }), rows: current, actor: "Nixon", role: "admin", fullAdmin: true });
  assert.deepEqual(prepared.affectedGroups[0].candidateTeacherIds, []);
});

test("candidate range derives extreme cross-timezone local dates and catches the matching conflict day", () => {
  const localCommand = { ...command, eventStart: "2026-09-14", eventEnd: "2026-09-14" };
  const makeCurrent = (withConflict: boolean) => rows().map((row) => {
    if (row.entity === "bookings") return { ...row, payload: [
      { id: "B-DATELINE", studentId: "S-1", teacherId: "T-1", date: "2026-09-14", start: "00:30", duration: 60, timezone: "Pacific/Kiritimati", kind: "常规课", teacherSubjectId: "Maths" },
      ...(withConflict ? [{ id: "B-PAGO-CONFLICT", studentId: "S-OTHER", teacherId: "T-PAGO", date: "2026-09-12", start: "23:45", duration: 30, timezone: "Pacific/Pago_Pago", kind: "常规课", teacherSubjectId: "Maths" }] : []),
    ] };
    if (row.entity === "teachers") return { ...row, payload: [
      { id: "T-1", name: "原老师", subjects: ["Maths"] },
      { id: "T-PAGO", subjects: ["Maths"], acceptsStudents: true, newStudentCapacity: 1, capacityAssignments: [], availabilityWindows: [{ id: "A-PAGO", teacherId: "T-PAGO", day: 6, start: "23:00", end: "01:00", timezone: "Pacific/Pago_Pago", validFrom: "2026-09-01", validTo: "2026-09-30", excludedDates: [], overrides: [], source: "submission" }] },
    ] };
    return row;
  });
  const available = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(localCommand), rows: makeCurrent(false), actor: "Nixon", role: "admin", fullAdmin: true });
  assert.deepEqual(available.affectedGroups[0].candidateTeacherIds, ["T-PAGO"]);
  const conflicted = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(localCommand), rows: makeCurrent(true), actor: "Nixon", role: "admin", fullAdmin: true });
  assert.deepEqual(conflicted.affectedGroups[0].candidateTeacherIds, []);
});

test("recurring conflict projection honors cancelled, moved-away, and moved-in occurrence overrides", () => {
  const base = rows().map((row) => row.entity === "bookings" ? { ...row, payload: [
    singleBooking((row.payload as Record<string, unknown>[])[0]),
    { id: "B-CANDIDATE", studentId: "S-OTHER", teacherId: "T-2", date: "2026-09-15", start: "17:00", duration: 60, timezone: "Australia/Melbourne", kind: "常规课", teacherSubjectId: "Maths", recurring: true, repeatCount: 2, occurrenceOverrides: [{ occurrenceId: "B-CANDIDATE:2026-09-15", status: "cancelled" }] },
  ] } : row);
  const cancelled = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand({ ...command, eventEnd: "2026-09-15" }), rows: base, actor: "Nixon", role: "admin", fullAdmin: true });
  assert.deepEqual(cancelled.affectedGroups[0].candidateTeacherIds, ["T-2"]);

  const movedAway = base.map((row) => row.entity === "bookings" ? { ...row, payload: (row.payload as Record<string, unknown>[]).map((booking) => booking.id === "B-CANDIDATE" ? { ...booking, occurrenceOverrides: [{ occurrenceId: "B-CANDIDATE:2026-09-15", date: "2026-09-16", start: "20:00" }] } : booking) } : row);
  const moved = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand({ ...command, eventEnd: "2026-09-15" }), rows: movedAway, actor: "Nixon", role: "admin", fullAdmin: true });
  assert.deepEqual(moved.affectedGroups[0].candidateTeacherIds, ["T-2"]);

  const movedIn = base.map((row) => row.entity === "bookings" ? { ...row, payload: (row.payload as Record<string, unknown>[]).map((booking) => booking.id === "B-CANDIDATE" ? { ...booking, date: "2026-09-08", repeatCount: 1, occurrenceOverrides: [{ occurrenceId: "B-CANDIDATE:2026-09-08", date: "2026-09-15", start: "17:00", status: "confirmed" }] } : booking) } : row);
  const incoming = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand({ ...command, eventEnd: "2026-09-15" }), rows: movedIn, actor: "Nixon", role: "admin", fullAdmin: true });
  assert.deepEqual(incoming.affectedGroups[0].candidateTeacherIds, []);
});

test("durationMinutes, explicit null student identity, and explicit repeat limits are authoritative", () => {
  const longLesson = rows().map((row) => {
    if (row.entity === "bookings") return { ...row, payload: [{ ...singleBooking((row.payload as Record<string, unknown>[])[0]), occurrenceOverrides: [{ occurrenceId: "B-1:2026-09-15", durationMinutes: 120 }] }] };
    if (row.entity === "teachers") return { ...row, payload: (row.payload as Record<string, unknown>[]).map((teacher) => teacher.id === "T-2" ? { ...teacher, availabilityWindows: [{ ...(teacher.availabilityWindows as Record<string, unknown>[])[0], end: "18:30" }] } : teacher) };
    return row;
  });
  const prepared = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand({ ...command, eventEnd: "2026-09-15" }), rows: longLesson, actor: "Nixon", role: "admin", fullAdmin: true });
  assert.deepEqual(prepared.affectedGroups[0].candidateTeacherIds, []);

  const nullStudent = rows().map((row) => row.entity === "bookings" ? { ...row, payload: [{ ...(row.payload as Record<string, unknown>[])[0], occurrenceOverrides: [{ occurrenceId: "B-1:2026-09-15", studentId: null }] }] } : row);
  assert.throws(() => prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(command), rows: nullStudent, actor: "Nixon", role: "admin", fullAdmin: true }), /valid student identity/);

  const oversized = rows().map((row) => row.entity === "bookings" ? { ...row, payload: [{ ...(row.payload as Record<string, unknown>[])[0], repeatCount: 105 }] } : row);
  assert.throws(() => prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(command), rows: oversized, actor: "Nixon", role: "admin", fullAdmin: true }), /safely expanded/);
});

test("custom recurrence interval and recurrence end date define the affected closure", () => {
  const localCommand = { ...command, eventStart: "2026-09-01", eventEnd: "2026-09-30" };
  const current = rows().map((row) => row.entity === "bookings" ? { ...row, payload: [{
    ...(row.payload as Record<string, unknown>[])[0],
    date: "2026-09-01",
    recurring: true,
    repeatCount: 5,
    recurrenceIntervalDays: 2,
    recurrenceEndDate: "2026-09-05",
  }] } : row);
  const prepared = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(localCommand), rows: current, actor: "Nixon", role: "admin", fullAdmin: true });
  assert.deepEqual(prepared.affectedGroups[0].affectedOccurrenceIds, ["B-1:2026-09-01", "B-1:2026-09-03", "B-1:2026-09-05"]);
});

test("LP due date uses a future source occurrence moved into the 730-day history window and its real end instant", () => {
  const current = rows().map((row) => row.entity === "bookings" ? { ...row, payload: [
    ...(row.payload as Record<string, unknown>[]),
    { id: "B-HISTORY-MOVED", studentId: "S-1", teacherId: "T-1", date: "2026-10-01", start: "23:30", duration: 120, timezone: "America/Los_Angeles", kind: "常规课", teacherSubjectId: "Maths", occurrenceOverrides: [{ occurrenceId: "B-HISTORY-MOVED:2026-10-01", date: "2026-09-14" }] },
  ] } : row);
  const prepared = prepareTeacherAbsenceCreation({ command: parseTeacherAbsenceCreationCommand(command), rows: current, actor: "Nixon", role: "admin", fullAdmin: true, now: new Date("2026-09-10T00:00:00.000Z") });
  const lpTask = prepared.tasks.find((task) => task.ruleKey?.endsWith(":lp-handover"));
  assert.equal(lpTask?.due, "2026-09-16 18:00");
  assert.equal(lpTask?.owner, "原老师");
});

test("substitute lessons are affected, define LP history, and block a busy candidate", () => {
  const localCommand = { ...command, eventEnd: "2026-09-15" };
  const current = rows().map((row) => {
    if (row.entity !== "bookings") return row;
    const source = singleBooking((row.payload as Record<string, unknown>[])[0]);
    return { ...row, payload: [
      { ...source, kind: "代课" },
      { id: "B-SUB-HISTORY", studentId: "S-1", teacherId: "T-1", date: "2026-09-14", start: "17:00", duration: 60, timezone: "Australia/Melbourne", kind: "代课", teacherSubjectId: "Maths" },
      { id: "B-SUB-CONFLICT", studentId: "S-OTHER", teacherId: "T-2", date: "2026-09-15", start: "17:00", duration: 60, timezone: "Australia/Melbourne", kind: "代课", teacherSubjectId: "Maths" },
    ] };
  });
  const prepared = prepareTeacherAbsenceCreation({
    command: parseTeacherAbsenceCreationCommand(localCommand),
    rows: current,
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-09-10T00:00:00.000Z"),
  });

  assert.deepEqual(prepared.affectedGroups[0].affectedOccurrenceIds, ["B-1:2026-09-15"]);
  assert.deepEqual(prepared.affectedGroups[0].candidateTeacherIds, []);
  assert.equal(prepared.tasks.find((task) => task.ruleKey?.endsWith(":lp-handover"))?.due, "2026-09-15 18:00");
});
