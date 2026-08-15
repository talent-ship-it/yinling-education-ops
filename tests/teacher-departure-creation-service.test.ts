import assert from "node:assert/strict";
import test from "node:test";

import type { OpsStateRow } from "../lib/ops-store";
import {
  parseTeacherDepartureCreationCommand,
  prepareTeacherDepartureCreation,
  TeacherDepartureCreationError,
} from "../lib/teacher-departure-creation-service";

const commandKey = "teacher-departure-create:123e4567-e89b-42d3-a456-426614174000";

function command(overrides: Record<string, unknown> = {}) {
  return {
    commandKey,
    sourceTeacherId: "T-SOURCE",
    effectiveDate: "2026-09-01",
    detail: "老师已确认离职，启动完整交接。",
    expectedVersions: { bookings: 3, operations: 4, students: 5, tasks: 6, teachers: 7 },
    ...overrides,
  };
}

function window(teacherId: string) {
  return [{
    id: `AVA-${teacherId}`,
    teacherId,
    day: 2,
    start: "16:00",
    end: "20:00",
    timezone: "Australia/Melbourne",
    validFrom: "2026-09-01",
    validTo: "2026-09-30",
    excludedDates: [],
    overrides: [],
    source: "submission",
  }];
}

function rows(options: { unbounded?: boolean; missingSubject?: boolean; includeConflict?: boolean } = {}): OpsStateRow[] {
  const bookings = [
    {
      id: "B-1",
      studentId: "S-1",
      teacherId: "T-SOURCE",
      date: "2026-09-01",
      start: "17:00",
      duration: 60,
      timezone: "Australia/Melbourne",
      kind: "常规课",
      status: "已确认",
      recurring: true,
      ...(options.unbounded ? {} : { repeatCount: 2 }),
      ...(options.missingSubject ? {} : { teacherSubjectId: "Maths&Science" }),
    },
    {
      id: "B-2",
      studentId: "S-2",
      teacherId: "T-SOURCE",
      date: "2026-09-01",
      start: "18:00",
      duration: 60,
      timezone: "Australia/Melbourne",
      kind: "常规课",
      status: "已确认",
      teacherSubjectId: "Maths&Science",
    },
    ...(options.includeConflict ? [{
      id: "B-CONFLICT",
      studentId: "S-3",
      teacherId: "T-GOOD",
      date: "2026-09-01",
      start: "17:30",
      duration: 60,
      timezone: "Australia/Melbourne",
      kind: "常规课",
      status: "已确认",
      teacherSubjectId: "Maths&Science",
    }] : []),
  ];
  return [
    { entity: "bookings", payload: bookings, version: 3, updated_at: "", updated_by: "" },
    { entity: "operations", payload: [{ id: "OPS-OLD", studentId: "S-1", type: "调课", status: "已确认" }], version: 4, updated_at: "", updated_by: "" },
    { entity: "students", payload: [
      { id: "S-1", name: "Student One", status: "在读", owner: "Abby" },
      { id: "S-2", name: "Student Two", status: "活跃 + 有课时", owner: "Ella" },
      { id: "S-3", name: "Student Three", status: "在读", owner: "Abby" },
    ], version: 5, updated_at: "", updated_by: "" },
    { entity: "tasks", payload: [{ id: "TSK-OLD", studentId: "S-1", owner: "Abby" }], version: 6, updated_at: "", updated_by: "" },
    { entity: "teachers", payload: [
      { id: "T-SOURCE", name: "Source Teacher", subjects: ["Maths&Science"], acceptsStudents: false },
      { id: "T-GOOD", name: "Good Teacher", subjects: ["Maths&Science"], acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityWindows: window("T-GOOD") },
      { id: "T-WRONG", name: "Wrong Subject", subjects: ["Local English"], acceptsStudents: true, newStudentCapacity: 5, capacityAssignments: [], availabilityWindows: window("T-WRONG") },
      { id: "T-RAW", name: "No Structured AVA", subjects: ["Maths&Science"], acceptsStudents: true, newStudentCapacity: 5, capacityAssignments: [] },
      { id: "T-FULL", name: "Full Teacher", subjects: ["Maths&Science"], acceptsStudents: true, newStudentCapacity: 0, capacityAssignments: [], availabilityWindows: window("T-FULL") },
    ], version: 7, updated_at: "", updated_by: "" },
  ];
}

test("departure parser accepts only the narrow five-entity OCC command", () => {
  assert.deepEqual(parseTeacherDepartureCreationCommand(command()), command());
  assert.throws(
    () => parseTeacherDepartureCreationCommand(command({ operations: [] })),
    (error: unknown) => error instanceof TeacherDepartureCreationError && error.code === "client_fields_forbidden",
  );
  assert.throws(
    () => parseTeacherDepartureCreationCommand(command({ expectedVersions: { bookings: 3, operations: 4, students: 5, tasks: 0, teachers: 7 } })),
    (error: unknown) => error instanceof TeacherDepartureCreationError && error.code === "invalid_request",
  );
  assert.throws(
    () => parseTeacherDepartureCreationCommand(command({ commandKey: commandKey.toUpperCase() })),
    (error: unknown) => error instanceof TeacherDepartureCreationError && error.code === "invalid_request",
  );
});

test("server derives one operation and five watched tasks per affected student", () => {
  const prepared = prepareTeacherDepartureCreation({
    command: parseTeacherDepartureCreationCommand(command()),
    rows: rows(),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  assert.equal(prepared.affectedGroups.length, 2);
  assert.equal(prepared.operationIds.length, 2);
  assert.equal(prepared.operationIds[0], "OPS-DEPARTURE-a7bff281fd38f8e19efe75c7");
  assert.equal(prepared.generatedTaskCount, 10);
  assert.equal(prepared.affectedOccurrenceCount, 3);
  assert.deepEqual(prepared.affectedGroups.map((group) => group.candidateTeacherIds), [["T-GOOD"], ["T-GOOD"]]);
  assert.equal(prepared.operations.at(-1)?.id, "OPS-OLD", "existing operation order/value is retained");
  assert.equal(prepared.tasks.at(-1)?.id, "TSK-OLD", "existing task order/value is retained");
  for (const operationId of prepared.operationIds) {
    const operation = prepared.operations.find((entry) => entry.id === operationId)!;
    assert.equal(operation.type, "老师离职");
    assert.equal(operation.status, "待处理");
    assert.equal(operation.creationCommandKey, commandKey);
    assert.ok(Array.isArray(operation.affectedOccurrenceIds));
    const tasks = prepared.tasks.filter((task) => task.anchorBookingId === operationId);
    assert.equal(tasks.length, 5);
    assert.ok(tasks.every((task) => Array.isArray(task.watchers) && task.watchers.length === 1 && task.watchers[0] === "Ops Admin"));
    assert.ok(tasks.every((task) => Array.isArray(task.assignees) && task.assignees.length === 1 && task.assignees[0] === task.owner));
  }
  assert.equal(
    prepared.tasks.find((task) => task.anchorBookingId === prepared.operationIds[0])?.id,
    "TSK-DEPARTURE-33b1857fea16f74280c16518",
  );
});

test("a zero-candidate student aborts the entire workflow and AVA correction permits a clean retry", () => {
  assert.throws(() => prepareTeacherDepartureCreation({
    command: parseTeacherDepartureCreationCommand(command()),
    rows: rows({ includeConflict: true }),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  }), (error: unknown) => error instanceof TeacherDepartureCreationError
    && error.code === "replacement_candidate_not_found");

  const retried = prepareTeacherDepartureCreation({
    command: parseTeacherDepartureCreationCommand(command()),
    rows: rows(),
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  assert.deepEqual(retried.affectedGroups.map((group) => group.candidateTeacherIds), [["T-GOOD"], ["T-GOOD"]]);
});

test("conflict closure compares absolute instants across different local dates", () => {
  const crossDateRows = rows().map((row) => {
    if (row.entity === "bookings") {
      const shifted = (row.payload as Record<string, unknown>[]).map((booking) => ({
        ...booking,
        start: booking.id === "B-1" ? "00:30" : booking.id === "B-2" ? "01:30" : booking.start,
      }));
      return { ...row, payload: [...shifted, {
        id: "B-PERTH",
        studentId: "S-3",
        teacherId: "T-GOOD",
        date: "2026-08-31",
        start: "22:30",
        duration: 60,
        timezone: "Australia/Perth",
        kind: "常规课",
        status: "已确认",
        teacherSubjectId: "Maths&Science",
      }] };
    }
    if (row.entity === "teachers") return {
      ...row,
      payload: [...(row.payload as Record<string, unknown>[]).map((teacher) => teacher.id === "T-GOOD" ? {
        ...teacher,
        availabilityWindows: [{ ...window("T-GOOD")[0], start: "00:00", end: "04:00" }],
      } : teacher), {
        id: "T-BACKUP",
        name: "Backup Teacher",
        subjects: ["Maths&Science"],
        acceptsStudents: true,
        newStudentCapacity: 1,
        capacityAssignments: [],
        availabilityWindows: [{ ...window("T-BACKUP")[0], start: "00:00", end: "01:30" }],
      }],
    };
    return row;
  });
  const prepared = prepareTeacherDepartureCreation({
    command: parseTeacherDepartureCreationCommand(command()),
    rows: crossDateRows,
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  assert.deepEqual(prepared.affectedGroups.map((group) => group.candidateTeacherIds), [["T-BACKUP"], ["T-GOOD"]]);
});

test("paused intake remains eligible for an established teacher-student relationship", () => {
  const establishedRows = rows().map((row) => {
    if (row.entity === "bookings") return {
      ...row,
      payload: [...row.payload as Record<string, unknown>[], {
        id: "B-EXISTING",
        studentId: "S-1",
        teacherId: "T-GOOD",
        date: "2026-09-03",
        start: "14:00",
        duration: 60,
        timezone: "Australia/Melbourne",
        kind: "常规课",
        status: "已确认",
        teacherSubjectId: "Maths&Science",
      }],
    };
    if (row.entity === "teachers") return {
      ...row,
      payload: (row.payload as Record<string, unknown>[]).map((teacher) => teacher.id === "T-GOOD" ? {
        ...teacher,
        acceptsStudents: false,
        newStudentCapacity: 0,
        capacityAssignments: ["S-2"],
      } : teacher),
    };
    return row;
  });
  const prepared = prepareTeacherDepartureCreation({
    command: parseTeacherDepartureCreationCommand(command()),
    rows: establishedRows,
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  assert.deepEqual(prepared.affectedGroups.map((group) => group.candidateTeacherIds), [["T-GOOD"], ["T-GOOD"]]);
});

test("a pending workflow for the source teacher blocks rebuilding under a different effective date", () => {
  const duplicateRows = rows().map((row) => row.entity === "operations" ? {
    ...row,
    payload: [{
      id: "OPS-DEPARTURE-EXISTING",
      studentId: "S-3",
      type: "老师离职",
      status: "待处理",
      teacherId: "T-SOURCE",
      eventEnd: "2026-10-01",
    }],
  } : row);
  assert.throws(() => prepareTeacherDepartureCreation({
    command: parseTeacherDepartureCreationCommand(command()),
    rows: duplicateRows,
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
  }), (error: unknown) => error instanceof TeacherDepartureCreationError
    && error.code === "departure_already_exists");
});

test("student, occurrence and candidate identities use PostgreSQL C byte ordering", () => {
  const punctuationRows = rows().map((row) => {
    if (row.entity === "bookings") return {
      ...row,
      payload: (row.payload as Record<string, unknown>[]).map((booking) => ({
        ...booking,
        studentId: booking.studentId === "S-1" ? "S:1" : booking.studentId === "S-2" ? "S.1" : booking.studentId,
      })),
    };
    if (row.entity === "students") return {
      ...row,
      payload: (row.payload as Record<string, unknown>[]).map((student) => ({
        ...student,
        id: student.id === "S-1" ? "S:1" : student.id === "S-2" ? "S.1" : student.id,
      })),
    };
    if (row.entity === "teachers") {
      const teachers = row.payload as Record<string, unknown>[];
      const good = teachers.find((teacher) => teacher.id === "T-GOOD")!;
      return {
        ...row,
        payload: [
          ...teachers.filter((teacher) => teacher.id !== "T-GOOD"),
          { ...good, id: "T:GOOD", availabilityWindows: window("T:GOOD") },
          { ...good, id: "T.GOOD", availabilityWindows: window("T.GOOD") },
        ],
      };
    }
    return row;
  });
  const prepared = prepareTeacherDepartureCreation({
    command: parseTeacherDepartureCreationCommand(command()),
    rows: punctuationRows,
    actor: "Nixon",
    role: "admin",
    fullAdmin: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  assert.deepEqual(prepared.affectedStudentIds, ["S.1", "S:1"]);
  assert.deepEqual(prepared.affectedGroups[0].candidateTeacherIds, ["T.GOOD", "T:GOOD"]);
});

test("departure creation fails closed for unbounded series and missing Tencent subject", () => {
  for (const [options, code] of [
    [{ unbounded: true }, "unbounded_future_series"],
    [{ missingSubject: true }, "teacher_subject_missing"],
  ] as const) {
    assert.throws(
      () => prepareTeacherDepartureCreation({
        command: parseTeacherDepartureCreationCommand(command()),
        rows: rows(options),
        actor: "Nixon",
        role: "admin",
        fullAdmin: true,
      }),
      (error: unknown) => error instanceof TeacherDepartureCreationError && error.code === code,
    );
  }
});

test("a staff caller cannot create a global departure outside every affected student scope", () => {
  assert.throws(
    () => prepareTeacherDepartureCreation({
      command: parseTeacherDepartureCreationCommand(command()),
      rows: rows(),
      actor: "Abby",
      role: "staff",
      fullAdmin: false,
    }),
    (error: unknown) => error instanceof TeacherDepartureCreationError && error.code === "affected_student_scope_forbidden",
  );
});
