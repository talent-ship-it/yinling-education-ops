import assert from "node:assert/strict";
import test from "node:test";

import {
  lessonSettlementAccess,
  LessonOccurrenceServiceError,
  parseCompleteLessonOccurrenceRequest,
  prepareLessonOccurrenceSettlement,
} from "../lib/lesson-occurrence-service.ts";
import type { LessonAttendanceEvidence } from "../lib/lesson-occurrences.ts";
import type { OpsStateRow } from "../lib/ops-store.ts";

const occurrenceId = "BOOK-A:2026-09-07";
const completedAt = "2026-09-07T11:00:00.000Z";

function row(entity: string, payload: unknown, version = 4): OpsStateRow {
  return {
    entity,
    payload,
    version,
    updated_at: "2026-09-07T11:00:00.000Z",
    updated_by: "Fixture Staff",
  };
}

function sharedRows(owner = "Abby"): OpsStateRow[] {
  return [
    row("bookings", [{
      id: "BOOK-A",
      date: "2026-09-07",
      start: "10:00",
      duration: 60,
      studentId: "STUDENT-A",
      teacherId: "TEACHER-A",
      packageId: "PACKAGE-A",
      course: "SUBJECT-A",
    }]),
    row("students", [{
      id: "STUDENT-A",
      name: "Sample Learner",
      owner,
      lessonPackages: [{
        id: "PACKAGE-A",
        name: "English package",
        subjectIds: ["SUBJECT-A"],
        purchaseRecords: [{ id: "PURCHASE-A", purchasedAt: "2026-09-01T00:00:00.000Z", hours: 4 }],
        consumedHours: 0,
      }],
      lessonLedger: [],
    }]),
    row("teachers", [{ id: "TEACHER-A", name: "Sample Teacher" }]),
    row("payroll", []),
  ];
}

function attendance(studentSeconds = 3_600, teacherSeconds = 3_600): LessonAttendanceEvidence {
  return {
    student: { userId: "STUDENT-A", accumulatedSeconds: studentSeconds },
    teacher: { userId: "TEACHER-A", accumulatedSeconds: teacherSeconds },
  };
}

function serviceError(code: LessonOccurrenceServiceError["code"]) {
  return (error: unknown) => error instanceof LessonOccurrenceServiceError && error.code === code;
}

test("request accepts only an evidence reference or an admin override, never settlement values", () => {
  assert.deepEqual(parseCompleteLessonOccurrenceRequest({
    occurrenceId,
    expectedVersion: 4,
    attendanceEvidenceReference: "bbb:recording/opaque-1",
  }), {
    occurrenceId,
    expectedVersion: 4,
    attendanceEvidenceReference: "bbb:recording/opaque-1",
  });
  assert.deepEqual(parseCompleteLessonOccurrenceRequest({
    occurrenceId,
    expectedVersion: 4,
    overrideReason: "Provider outage confirmed by operations.",
  }), {
    occurrenceId,
    expectedVersion: 4,
    overrideReason: "Provider outage confirmed by operations.",
  });
  for (const field of ["hours", "amount", "studentId", "teacherId", "packageId", "subjectId", "attendance"] as const) {
    assert.throws(() => parseCompleteLessonOccurrenceRequest({
      occurrenceId,
      expectedVersion: 4,
      attendanceEvidenceReference: "evidence-1",
      [field]: field === "hours" ? 99 : "tampered",
    }), serviceError("client_fields_forbidden"));
  }
  assert.throws(() => parseCompleteLessonOccurrenceRequest({ occurrenceId, expectedVersion: 4 }), serviceError("invalid_request"));
  assert.throws(() => parseCompleteLessonOccurrenceRequest({
    occurrenceId,
    expectedVersion: 4,
    attendanceEvidenceReference: "evidence-1",
    overrideReason: "This reason must not accompany evidence.",
  }), serviceError("invalid_request"));
});

test("teachers never settle; staff only settle their own students; admins can settle globally", () => {
  assert.equal(lessonSettlementAccess({ actor: "Helen Ceperkovic", fullAdmin: false, studentOwner: "Helen Ceperkovic" }).allowed, false);
  assert.equal(lessonSettlementAccess({ actor: "Abby", fullAdmin: false, studentOwner: "Abby" }).allowed, true);
  assert.equal(lessonSettlementAccess({ actor: "Abby", fullAdmin: false, studentOwner: "Thea" }).allowed, false);
  assert.equal(lessonSettlementAccess({ actor: "Ops Admin", fullAdmin: false, studentOwner: "Thea" }).allowed, true);
  assert.equal(lessonSettlementAccess({ actor: "Nixon", fullAdmin: true, studentOwner: "Thea" }).allowed, true);
});

test("entity-scoped settlement authorizes every atomically mutated projection", () => {
  const request = parseCompleteLessonOccurrenceRequest({ occurrenceId, expectedVersion: 4, attendanceEvidenceReference: "evidence-1" });
  const baseAuthorization = {
    user: "Ops Admin",
    role: "limited-admin" as const,
    permissions: ["operations.read", "operations.write"],
  };
  assert.throws(() => prepareLessonOccurrenceSettlement({
    request,
    rows: sharedRows(),
    actor: "Ops Admin",
    fullAdmin: false,
    role: "limited-admin",
    authorization: {
      ...baseAuthorization,
      scopeMembers: [
        { kind: "student", key: "STUDENT-A" },
        { kind: "entity", key: "bookings" },
      ],
    },
    attendance: attendance(),
    completedAt,
  }), serviceError("student_scope_forbidden"));

  const prepared = prepareLessonOccurrenceSettlement({
    request,
    rows: sharedRows(),
    actor: "Ops Admin",
    fullAdmin: false,
    role: "limited-admin",
    authorization: {
      ...baseAuthorization,
      scopeMembers: [
        { kind: "student", key: "STUDENT-A" },
        { kind: "entity", key: "bookings" },
        { kind: "entity", key: "students" },
        { kind: "entity", key: "payroll" },
      ],
    },
    attendance: attendance(),
    completedAt,
  });
  assert.equal(prepared.settlement.disposition, "completed");
});

test("automatic completion derives all billable fields from shared state and creates a stable key", () => {
  const request = parseCompleteLessonOccurrenceRequest({ occurrenceId, expectedVersion: 4, attendanceEvidenceReference: "evidence-1" });
  const first = prepareLessonOccurrenceSettlement({ request, rows: sharedRows(), actor: "Abby", fullAdmin: false, attendance: attendance(), completedAt });
  const second = prepareLessonOccurrenceSettlement({ request, rows: sharedRows(), actor: "Abby", fullAdmin: false, attendance: attendance(), completedAt });

  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.match(first.idempotencyKey, /^lesson-complete:[a-f0-9]{64}$/);
  assert.equal(first.occurrence.studentId, "STUDENT-A");
  assert.equal(first.occurrence.teacherId, "TEACHER-A");
  assert.equal(first.occurrence.packageId, "PACKAGE-A");
  assert.equal(first.occurrence.subjectId, "SUBJECT-A");
  assert.equal(first.settlement.disposition, "completed");
  assert.equal(first.settlement.packages[0].consumedHours, 1);
  assert.equal(first.settlement.teacherPayrollLedger[0].payableHours, 1);
  assert.deepEqual(first.stateVersions, {
    bookings: 4,
    students: 4,
    teachers: 4,
    payroll: 4,
  });
});

test("short or one-sided evidence cannot automatically complete or mutate settlement", () => {
  const request = parseCompleteLessonOccurrenceRequest({ occurrenceId, expectedVersion: 4, attendanceEvidenceReference: "evidence-1" });
  assert.throws(() => prepareLessonOccurrenceSettlement({
    request,
    rows: sharedRows(),
    actor: "Abby",
    fullAdmin: false,
    attendance: attendance(3_600, 3_000),
    completedAt,
  }), serviceError("attendance_abnormal"));
  assert.throws(() => prepareLessonOccurrenceSettlement({
    request,
    rows: sharedRows(),
    actor: "Abby",
    fullAdmin: false,
    attendance: { student: attendance().student },
    completedAt,
  }), serviceError("attendance_abnormal"));
});

test("a trusted BBB callback returns an abnormal no-money result for durable review", () => {
  const request = parseCompleteLessonOccurrenceRequest({ occurrenceId, expectedVersion: 4, attendanceEvidenceReference: "bbb:evidence-1" });
  const prepared = prepareLessonOccurrenceSettlement({
    request,
    rows: sharedRows(),
    actor: "BigBlueButton",
    fullAdmin: false,
    trustedProvider: "bbb",
    attendance: attendance(3_600, 3_000),
    completedAt,
  });
  assert.equal(prepared.settlement.disposition, "abnormal");
  assert.equal(prepared.settlement.applied, false);
  assert.equal(prepared.occurrence.status, "confirmed");
  assert.equal(prepared.settlement.occurrence.status, "abnormal");
  assert.equal(prepared.settlement.packages[0].consumedHours, 0);
  assert.equal(prepared.settlement.studentHoursLedger.length, 0);
  assert.equal(prepared.settlement.teacherPayrollLedger.length, 0);
});

test("override requires an administrator and retains the reason for atomic audit", () => {
  const request = parseCompleteLessonOccurrenceRequest({
    occurrenceId,
    expectedVersion: 4,
    overrideReason: "Provider outage confirmed by operations.",
  });
  assert.throws(() => prepareLessonOccurrenceSettlement({
    request,
    rows: sharedRows(),
    actor: "Abby",
    fullAdmin: false,
    completedAt,
  }), serviceError("override_admin_required"));

  const prepared = prepareLessonOccurrenceSettlement({
    request,
    rows: sharedRows("Thea"),
    actor: "Ops Admin",
    fullAdmin: false,
    completedAt,
  });
  assert.equal(prepared.overrideReason, request.overrideReason);
  assert.equal(prepared.attendanceReference, undefined);
  assert.equal(prepared.settlement.disposition, "completed");
});

test("stale booking versions and cross-owner staff fail closed", () => {
  const request = parseCompleteLessonOccurrenceRequest({ occurrenceId, expectedVersion: 3, attendanceEvidenceReference: "evidence-1" });
  assert.throws(() => prepareLessonOccurrenceSettlement({
    request,
    rows: sharedRows(),
    actor: "Abby",
    fullAdmin: false,
    attendance: attendance(),
    completedAt,
  }), serviceError("stale_expected_version"));

  const current = parseCompleteLessonOccurrenceRequest({ occurrenceId, expectedVersion: 4, attendanceEvidenceReference: "evidence-1" });
  assert.throws(() => prepareLessonOccurrenceSettlement({
    request: current,
    rows: sharedRows("Thea"),
    actor: "Abby",
    fullAdmin: false,
    attendance: attendance(),
    completedAt,
  }), serviceError("student_scope_forbidden"));
  assert.throws(() => prepareLessonOccurrenceSettlement({
    request: current,
    rows: sharedRows(),
    actor: "Helen Ceperkovic",
    fullAdmin: false,
    attendance: attendance(),
    completedAt,
  }), serviceError("teacher_forbidden"));
});

test("archived students cannot be settled by staff, admins or trusted BBB callbacks", () => {
  const request = parseCompleteLessonOccurrenceRequest({
    occurrenceId,
    expectedVersion: 4,
    attendanceEvidenceReference: "evidence-1",
  });
  const archivedRows = sharedRows().map((item) => item.entity === "students"
    ? {
        ...item,
        payload: (item.payload as Record<string, unknown>[]).map((student) => ({ ...student, importArchived: true })),
      }
    : item);
  for (const input of [
    { actor: "Abby", fullAdmin: false },
    { actor: "Nixon", fullAdmin: true },
    { actor: "BigBlueButton", fullAdmin: false, trustedProvider: "bbb" as const },
  ]) {
    assert.throws(() => prepareLessonOccurrenceSettlement({
      request,
      rows: archivedRows,
      attendance: attendance(),
      completedAt,
      ...input,
    }), serviceError("student_scope_forbidden"));
  }
});

test("cancelled occurrences and insufficient balances never reach the atomic commit", () => {
  const request = parseCompleteLessonOccurrenceRequest({ occurrenceId, expectedVersion: 4, attendanceEvidenceReference: "evidence-1" });
  const cancelledRows = sharedRows().map((item) => item.entity === "bookings"
    ? {
        ...item,
        payload: (item.payload as Record<string, unknown>[]).map((booking) => ({
          ...booking,
          occurrenceOverrides: [{ occurrenceId, status: "cancelled" }],
        })),
      }
    : item);
  assert.throws(() => prepareLessonOccurrenceSettlement({
    request,
    rows: cancelledRows,
    actor: "Abby",
    fullAdmin: false,
    attendance: attendance(),
    completedAt,
  }), serviceError("occurrence_not_billable"));

  const noBalanceRows = sharedRows().map((item) => item.entity === "students"
    ? {
        ...item,
        payload: (item.payload as Record<string, unknown>[]).map((student) => ({
          ...student,
          lessonPackages: [{
            id: "PACKAGE-A",
            name: "English package",
            subjectIds: ["SUBJECT-A"],
            purchaseRecords: [{ id: "PURCHASE-A", purchasedAt: "2026-09-01T00:00:00.000Z", hours: 0.5 }],
            consumedHours: 0,
          }],
        })),
      }
    : item);
  assert.throws(() => prepareLessonOccurrenceSettlement({
    request,
    rows: noBalanceRows,
    actor: "Abby",
    fullAdmin: false,
    attendance: attendance(),
    completedAt,
  }), serviceError("insufficient_hours"));
});

test("a duplicate request reuses the original completion time and makes no second deduction or credit", () => {
  const request = parseCompleteLessonOccurrenceRequest({ occurrenceId, expectedVersion: 4, attendanceEvidenceReference: "evidence-1" });
  const first = prepareLessonOccurrenceSettlement({ request, rows: sharedRows(), actor: "Abby", fullAdmin: false, attendance: attendance(), completedAt });
  const duplicateRows = sharedRows().map((item) => {
    if (item.entity === "students") {
      const students = item.payload as Record<string, unknown>[];
      return {
        ...item,
        payload: students.map((student) => ({
          ...student,
          lessonPackages: first.settlement.packages,
          lessonLedger: first.settlement.studentHoursLedger,
        })),
      };
    }
    if (item.entity === "payroll") return { ...item, payload: first.settlement.teacherPayrollLedger };
    return item;
  });
  const duplicate = prepareLessonOccurrenceSettlement({
    request,
    rows: duplicateRows,
    actor: "Abby",
    fullAdmin: false,
    attendance: attendance(),
    completedAt: "2026-09-07T11:05:00.000Z",
  });
  assert.equal(duplicate.settlement.applied, false);
  assert.equal(duplicate.settlement.studentHoursLedger.length, 1);
  assert.equal(duplicate.settlement.teacherPayrollLedger.length, 1);
  assert.equal(duplicate.idempotencyKey, first.idempotencyKey);
});
