import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { meetingIdForOccurrenceValue } from "../lib/bbb-analytics.ts";
import { buildOpsAccessContext } from "../lib/ops-access.ts";
import {
  assertOpsStateTransition,
  OpsStateTransitionError,
} from "../lib/ops-state-transition.ts";
import type { OpsStateRow } from "../lib/ops-store.ts";
import { createMonthlyAvailabilityWindows } from "../lib/teacher-availability.ts";

type RecordValue = Record<string, unknown>;

function row(entity: string, payload: unknown, version = 1): OpsStateRow {
  return {
    entity,
    payload,
    version,
    updated_at: "2026-08-13T00:00:00.000Z",
    updated_by: "Nixon",
  };
}

function availability(teacherId: string) {
  return createMonthlyAvailabilityWindows({
    teacherId,
    month: "2026-09",
    timezone: "Australia/Melbourne",
    slots: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "00:00", end: "23:59" })),
    idSeed: `transition-${teacherId}`,
  });
}

const booking = {
  id: "B-1",
  studentId: "S-1",
  teacherId: "T-1",
  date: "2026-09-07",
  start: "10:00",
  duration: 60,
  kind: "常规课",
  status: "待确认",
  timezone: "Australia/Melbourne",
  recurring: true,
  repeatCount: 4,
  packageId: "P-1",
  course: "English",
};

const conflictingBooking = {
  ...booking,
  id: "B-2",
  studentId: "S-1",
  teacherId: "T-2",
  date: "2026-09-14",
  start: "12:00",
  recurring: false,
  repeatCount: 1,
  packageId: "P-2",
};

const student = {
  id: "S-1",
  name: "Student One",
  owner: "Abby",
  lessonPackages: [{
    id: "P-1",
    name: "English",
    subjectIds: ["English"],
    purchaseRecords: [{ id: "PUR-1", purchasedAt: "2026-08-01T00:00:00.000Z", hours: 20 }],
    consumedHours: 1,
  }],
  lessonLedger: [{
    id: "LEDGER-1",
    kind: "deduction",
    lessonId: "B-0:2026-08-01",
    packageId: "P-1",
    subjectId: "English",
    hours: 1,
    occurredAt: "2026-08-01T10:00:00.000Z",
  }],
};

const teachers = [
  { id: "T-1", name: "Teacher One", acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: ["S-1"], availabilityStatus: "可接新生", availabilityWindows: availability("T-1") },
  { id: "T-2", name: "Teacher Two", acceptsStudents: true, newStudentCapacity: 2, capacityAssignments: [], availabilityStatus: "可接新生", availabilityWindows: availability("T-2") },
  { id: "T-3", name: "Teacher Without AVA", acceptsStudents: false, newStudentCapacity: 0, capacityAssignments: [], availabilityStatus: "暂停接新" },
];

const operation = {
  id: "OPS-1",
  studentId: "S-1",
  teacherId: "T-1",
  type: "代课",
  detail: "Teacher leave",
  status: "待处理",
  createdAt: "2026-08-13",
  recommendedTeacherIds: ["T-2"],
  eventStart: "2026-09-14",
  eventEnd: "2026-09-14",
};

const payrollLedger = {
  id: "teacher-hours:B-0:2026-08-01",
  kind: "teacher_hours",
  occurrenceId: "B-0:2026-08-01",
  teacherId: "T-1",
  studentId: "S-1",
  packageId: "P-1",
  subjectId: "English",
  payableHours: 1,
  occurredAt: "2026-08-01T10:00:00.000Z",
};

const payrollSummary = {
  id: "PAY-1",
  teacherId: "T-1",
  lessons: 1,
  trialLessons: 0,
  amount: 30,
  status: "需核对",
  note: "",
};

function fixtureRows(bookings: RecordValue[] = [booking, conflictingBooking]) {
  return [
    row("students", [student]),
    row("teachers", teachers),
    row("bookings", bookings),
    row("operations", [operation]),
    row("payroll", [payrollSummary, payrollLedger]),
  ];
}

function adminContext(rows: OpsStateRow[], limited = false) {
  return limited
    ? buildOpsAccessContext(rows, "Ops Admin", false, "limited-admin")
    : buildOpsAccessContext(rows, "Nixon", true, "admin");
}

function transition(
  entity: string,
  currentPayload: unknown,
  nextPayload: unknown,
  rows = fixtureRows(),
  limited = false,
) {
  return assertOpsStateTransition({
    entity,
    currentPayload,
    nextPayload,
    rows,
    context: adminContext(rows, limited),
    now: new Date("2026-08-13T00:00:00.000Z"),
  });
}

function rejected(value: unknown) {
  return value instanceof OpsStateTransitionError && [400, 403].includes(value.status);
}

test("app-state applies invariant validation after scoped merge", async () => {
  const source = await readFile(new URL("../app/api/app-state/route.ts", import.meta.url), "utf8");
  const transitionSource = await readFile(new URL("../lib/ops-state-transition.ts", import.meta.url), "utf8");
  const merge = source.indexOf("const payload = mergeScopedPayload");
  const guard = source.indexOf("assertOpsStateTransition({");
  const write = source.indexOf("const saved = await putOpsState");
  assert.ok(merge >= 0 && guard > merge && write > guard);
  assert.match(source, /error instanceof OpsStateTransitionError/);
  const teacherGuard = transitionSource.indexOf("if (currentTeacherId !== nextTeacherId)");
  const cancelledReturn = transitionSource.indexOf('if (!scheduleChanged || nextOccurrence.status === "cancelled") return');
  assert.ok(teacherGuard >= 0 && cancelledReturn > teacherGuard, "the direct API guard must reject teacher changes before cancelled occurrences return");
  assert.match(transitionSource, /请使用代课或永久换老师专用流程/);
});

test("legal parent confirmation, one occurrence edit and deterministic classroom metadata pass", () => {
  const current = [booking, conflictingBooking];
  transition("bookings", current, [{ ...booking, status: "已确认" }, conflictingBooking]);

  const occurrenceId = "B-1:2026-09-14";
  const edited = {
    ...booking,
    occurrenceOverrides: [{ occurrenceId, date: "2026-09-14", start: "10:30", durationMinutes: 60, status: "confirmed" }],
  };
  transition("bookings", current, [edited, conflictingBooking]);

  const cancelled = {
    ...booking,
    occurrenceOverrides: [{ occurrenceId, status: "cancelled" }],
  };
  transition("bookings", current, [cancelled, conflictingBooking]);

  const moved = {
    ...booking,
    occurrenceOverrides: [{ occurrenceId, date: "2026-09-15", start: "10:30", status: "confirmed" }],
  };
  transition("bookings", current, [moved, conflictingBooking]);

  const substitutedCurrent = {
    ...booking,
    occurrenceOverrides: [{ occurrenceId, teacherId: "T-2", status: "confirmed" }],
  };
  const substitutedRescheduled = {
    ...booking,
    occurrenceOverrides: [{ occurrenceId, teacherId: "T-2", start: "10:30", status: "confirmed" }],
  };
  transition(
    "bookings",
    [substitutedCurrent, conflictingBooking],
    [substitutedRescheduled, conflictingBooking],
    fixtureRows([substitutedCurrent, conflictingBooking]),
  );

  const withClassroom = {
    ...booking,
    occurrenceOverrides: [{
      occurrenceId,
      classroom: {
        occurrenceId,
        meetingId: meetingIdForOccurrenceValue(occurrenceId),
        status: "ready",
        createdAt: "2026-08-13T01:00:00.000Z",
      },
    }],
  };
  transition("bookings", current, [withClassroom, conflictingBooking], fixtureRows(current), true);
});

test("generic booking writes cannot change parent ownership, subject or completion state", () => {
  const current = [booking, conflictingBooking];
  for (const changed of [
    { ...booking, studentId: "S-X" },
    { ...booking, course: "Math" },
    { ...booking, status: "已完成" },
  ]) {
    assert.throws(() => transition("bookings", current, [changed, conflictingBooking]), rejected);
  }
  assert.throws(() => transition("bookings", current, current.slice(1)), rejected);
  assert.throws(() => transition("bookings", current, [...current, { ...booking, id: "B-X" }]), rejected);
});

test("generic occurrence writes cannot fabricate, settle, mark leave, skip AVA or create conflicts", () => {
  const current = [booking, conflictingBooking];
  const attempts = [
    [{ occurrenceId: "B-1:2026-09-14", status: "completed", settledAt: "2026-09-14T11:00:00Z" }],
    [{ occurrenceId: "B-1:2026-09-14", status: "abnormal" }],
    [{ occurrenceId: "B-1:2026-09-14", status: "leave" }],
    [{ occurrenceId: "B-1:2026-09-08", status: "confirmed" }],
    [{ occurrenceId: "B-1:2026-09-14", teacherId: "T-3", status: "confirmed" }],
    [{ occurrenceId: "B-1:2026-09-14", start: "12:00", status: "confirmed" }],
  ];
  for (const occurrenceOverrides of attempts) {
    assert.throws(() => transition("bookings", current, [{ ...booking, occurrenceOverrides }, conflictingBooking]), rejected);
  }
});

test("an old client cannot change an occurrence's effective teacher through app-state", () => {
  const current = [booking, conflictingBooking];
  const occurrenceId = "B-1:2026-09-14";
  assert.throws(() => transition("bookings", current, [{
    ...booking,
    occurrenceOverrides: [{ occurrenceId, teacherId: "T-2", status: "confirmed" }],
  }, conflictingBooking]), (error: unknown) => error instanceof OpsStateTransitionError
    && error.status === 403
    && /代课或永久换老师专用流程/.test(error.message));

  const substitutedCurrent = {
    ...booking,
    occurrenceOverrides: [{ occurrenceId, teacherId: "T-2", status: "confirmed" }],
  };
  assert.throws(() => transition(
    "bookings",
    [substitutedCurrent, conflictingBooking],
    [{ ...booking, occurrenceOverrides: [{ occurrenceId, status: "confirmed" }] }, conflictingBooking],
    fixtureRows([substitutedCurrent, conflictingBooking]),
  ), (error: unknown) => error instanceof OpsStateTransitionError
    && error.status === 403
    && /代课或永久换老师专用流程/.test(error.message));
});

function packageReservationRows(
  primary: RecordValue,
  otherRepeatCount: number,
) {
  const sharedPackageStudent = {
    ...student,
    lessonPackages: [{
      id: "P-1",
      name: "Shared package",
      subjectIds: ["English", "Math"],
      purchaseRecords: [{ id: "PUR-SHARED", purchasedAt: "2026-08-01T00:00:00.000Z", hours: 20 }],
      consumedHours: 1,
    }],
  };
  const otherSubjectSeries = {
    ...booking,
    id: "B-SHARED-MATH",
    teacherId: "T-2",
    date: "2026-09-08",
    start: "12:00",
    course: "Math",
    recurring: true,
    repeatCount: otherRepeatCount,
  };
  return [
    row("students", [sharedPackageStudent]),
    row("teachers", teachers),
    row("bookings", [primary, otherSubjectSeries]),
    row("operations", [operation]),
    row("payroll", [payrollSummary, payrollLedger]),
  ];
}

test("generic duration increases recalculate all subjects sharing one package", () => {
  const current = [booking, {
    ...booking,
    id: "B-SHARED-MATH",
    teacherId: "T-2",
    date: "2026-09-08",
    start: "12:00",
    course: "Math",
    recurring: true,
    repeatCount: 15,
  }];
  const occurrenceId = "B-1:2026-09-14";
  const increased = { ...booking, occurrenceOverrides: [{ occurrenceId, durationMinutes: 120, status: "confirmed" }] };
  assert.throws(() => transition(
    "bookings",
    current,
    [increased, current[1]],
    packageReservationRows(booking, 15),
  ), (error: unknown) => error instanceof OpsStateTransitionError
    && error.status === 403
    && /共享课包未来排课/.test(error.message));
});

test("generic cancelled-to-confirmed edits cannot over-reserve a shared package", () => {
  const occurrenceId = "B-1:2026-09-14";
  const cancelled = { ...booking, occurrenceOverrides: [{ occurrenceId, status: "cancelled" }] };
  const confirmed = { ...booking, occurrenceOverrides: [{ occurrenceId, status: "confirmed" }] };
  const rows = packageReservationRows(cancelled, 16);
  const other = (rows.find((entry) => entry.entity === "bookings")!.payload as RecordValue[])[1];
  assert.throws(
    () => transition("bookings", [cancelled, other], [confirmed, other], rows),
    (error: unknown) => error instanceof OpsStateTransitionError
      && error.status === 403
      && /共享课包未来排课/.test(error.message),
  );
});

test("generic duration reductions remain saveable even when legacy reservations are still high", () => {
  const occurrenceId = "B-1:2026-09-14";
  const long = { ...booking, occurrenceOverrides: [{ occurrenceId, durationMinutes: 120, status: "confirmed" }] };
  const shorter = { ...booking, occurrenceOverrides: [{ occurrenceId, durationMinutes: 60, status: "confirmed" }] };
  const rows = packageReservationRows(long, 16);
  const other = (rows.find((entry) => entry.entity === "bookings")!.payload as RecordValue[])[1];
  transition("bookings", [long, other], [shorter, other], rows);
});

test("generic cancellations remain saveable because they reduce future package reservation", () => {
  const occurrenceId = "B-1:2026-09-14";
  const cancelled = { ...booking, occurrenceOverrides: [{ occurrenceId, status: "cancelled" }] };
  const rows = packageReservationRows(booking, 16);
  const other = (rows.find((entry) => entry.entity === "bookings")!.payload as RecordValue[])[1];
  transition("bookings", [booking, other], [cancelled, other], rows);
});

test("operations allow pending creation and candidate selection but reject generic confirmation", () => {
  const current = [operation];
  const created = {
    ...operation,
    id: "OPS-2",
    type: "学生请假",
    teacherId: undefined,
    recommendedTeacherIds: [],
  };
  transition("operations", current, [operation, created]);
  transition("operations", current, [{ ...operation, chosenTeacherId: "T-2" }]);
  transition("operations", [{ ...operation, chosenTeacherId: "T-2" }], [operation]);
  assert.throws(() => transition("operations", current, [operation, {
    ...created,
    type: "老师离职",
  }]), (error: unknown) => error instanceof OpsStateTransitionError
    && error.status === 403
    && /专用原子创建流程/.test(error.message));

  assert.throws(() => transition("operations", current, [{
    ...operation,
    status: "已确认",
    chosenTeacherId: "T-2",
    affectedOccurrenceIds: ["B-1:2026-09-14"],
    confirmationAction: "substitute",
    confirmationCommandKey: "forged",
    confirmedAt: "2026-08-13T01:00:00.000Z",
    confirmedBy: "Nixon",
  }]), rejected);
  assert.throws(() => transition("operations", current, []), rejected);
  assert.throws(() => transition("operations", current, [{ ...operation, chosenTeacherId: "T-3" }]), rejected);
});

test("teacher capacity assignments remain dedicated-API owned for all admin scopes", () => {
  for (const limited of [false, true]) {
    assert.throws(() => transition(
      "teachers",
      teachers,
      teachers.map((teacher) => teacher.id === "T-1" ? { ...teacher, capacityAssignments: [] } : teacher),
      fixtureRows(),
      limited,
    ), rejected);
    transition(
      "teachers",
      teachers,
      teachers.map((teacher) => teacher.id === "T-1" ? { ...teacher, newStudentCapacity: 3 } : teacher),
      fixtureRows(),
      limited,
    );
  }
});

test("generic task writes require unique legal watchers and preserve Ops Admin even for full admin", () => {
  const validTask = {
    id: "TASK-1",
    studentId: "S-1",
    owner: "Abby",
    title: "Follow up",
    watchers: ["Abby", "Ops Admin"],
  };
  transition("tasks", [validTask], [{ ...validTask, title: "Updated" }]);

  for (const watchers of [
    ["Abby"],
    ["Ops Admin", "Ops Admin"],
    ["ops admin", "Ops Admin"],
    ["Ops Admin", " Abby"],
    ["Ops Admin", ""],
    ["Ops Admin", 42],
  ]) {
    assert.throws(() => transition("tasks", [validTask], [{ ...validTask, title: "Updated", watchers }]), rejected);
  }
  assert.throws(() => transition("tasks", [validTask], [{ ...validTask, title: "Updated", watchers: undefined }]), rejected);
});

test("an unchanged legacy task remains deploy-order compatible but must be repaired before editing", () => {
  const legacy = { id: "TASK-LEGACY", studentId: "S-1", owner: "Abby", title: "Legacy" };
  transition("tasks", [legacy], [legacy]);
  assert.throws(() => transition("tasks", [legacy], [{ ...legacy, title: "Edited" }]), rejected);
  transition("tasks", [legacy], [{ ...legacy, title: "Edited", watchers: ["Ops Admin"] }]);
});

test("generic teacher writes freeze authority and identity while validating reviewed manual state", () => {
  assert.throws(() => transition("teachers", teachers, teachers.slice(1)), rejected);
  assert.throws(() => transition("teachers", teachers, [...teachers, {
    id: "T-NEW", name: "New", acceptsStudents: false, newStudentCapacity: 0, capacityAssignments: [],
  }]), rejected);

  for (const changed of [
    { ...teachers[0], name: "Forged identity" },
    { ...teachers[0], subjects: ["Forged subject"] },
    { ...teachers[0], teacherSourceRefs: [{ workbook: "k12", sourceId: "fake", sourceRow: 1 }] },
    { ...teachers[0], availabilitySourceText: "forged source" },
    { ...teachers[0], arbitraryField: "forged" },
  ]) {
    assert.throws(() => transition("teachers", teachers, [changed, ...teachers.slice(1)]), rejected);
  }

  for (const changed of [
    { ...teachers[0], acceptsStudents: "true" },
    { ...teachers[0], newStudentCapacity: -1 },
    { ...teachers[0], newStudentCapacity: 1.5 },
    { ...teachers[0], newStudentCapacity: Number.MAX_SAFE_INTEGER + 1 },
    { ...teachers[0], newStudentCapacity: 0, acceptsStudents: true },
    { ...teachers[0], availabilityStatus: "forged" },
    { ...teachers[0], availabilityWindows: availability("T-2") },
  ]) {
    assert.throws(() => transition("teachers", teachers, [changed, ...teachers.slice(1)]), rejected);
  }

  transition("teachers", teachers, [{
    ...teachers[0],
    acceptsStudents: false,
    newStudentCapacity: 0,
    availabilityStatus: "暂停接新",
  }, ...teachers.slice(1)]);
});

test("student settlement ledger and consumed hours are immutable while package purchases still work", () => {
  const current = [student];
  assert.throws(() => transition("students", current, [{ ...student, lessonLedger: [] }]), rejected);
  assert.throws(() => transition("students", current, [{
    ...student,
    lessonPackages: (student.lessonPackages as RecordValue[]).map((item) => ({ ...item, consumedHours: 0 })),
  }]), rejected);

  const purchased = {
    ...student,
    lessonPackages: (student.lessonPackages as RecordValue[]).map((item) => ({
      ...item,
      purchaseRecords: [...(item.purchaseRecords as RecordValue[]), {
        id: "PUR-2",
        purchasedAt: "2026-08-13T00:00:00.000Z",
        hours: 10,
      }],
    })),
  };
  transition("students", current, [purchased]);
  assert.throws(() => transition("students", [purchased], [{
    ...purchased,
    lessonPackages: (purchased.lessonPackages as RecordValue[]).map((item) => ({
      ...item,
      purchaseRecords: (item.purchaseRecords as RecordValue[]).slice(1),
    })),
  }]), rejected);
  assert.throws(() => transition("students", [purchased], [{
    ...purchased,
    lessonPackages: (purchased.lessonPackages as RecordValue[]).map((item) => ({
      ...item,
      purchaseRecords: (item.purchaseRecords as RecordValue[]).map((purchase) => ({ ...purchase, hours: 999 })),
    })),
  }]), rejected);
  assert.throws(() => transition("students", current, [{
    ...student,
    lessonPackages: (student.lessonPackages as RecordValue[]).map((item) => ({
      ...item,
      purchaseRecords: [...(item.purchaseRecords as RecordValue[]), {
        id: "PUR-BAD",
        purchasedAt: "not-a-date",
        hours: -1,
      }],
    })),
  }]), rejected);
});

test("generic student writes cannot create or mutate managed exam history", () => {
  const exam = {
    id: "EXM-1",
    subject: "Selective",
    examType: "selective",
    examMonth: "2026-09",
  };
  const withExam = { ...student, exams: [exam] };
  transition("students", [withExam], [{ ...withExam, name: "Allowed profile edit" }]);
  assert.throws(() => transition("students", [withExam], [{
    ...withExam,
    exams: [{ ...exam, followUpState: { exam_care: { status: "completed", completedAt: "2026-08-15T00:00:00.000Z" } } }],
  }]), rejected);
  assert.throws(() => transition("students", [], [{
    id: "S-NEW",
    name: "New Student",
    owner: "Abby",
    exams: [exam],
  }]), rejected);
  assert.throws(() => transition("students", [], [{
    id: "S-NEW",
    name: "New Student",
    owner: "Abby",
    exams: { injected: true },
  }]), rejected);
  transition("students", [], [{ id: "S-NEW", name: "New Student", owner: "Abby", exams: [] }]);
});

test("generic task writes cannot bypass managed exam completion", () => {
  const managed = {
    id: "TSK-EXAM-1",
    title: "Selective考试当天关心",
    owner: "Abby",
    assignees: ["Abby"],
    watchers: ["Ops Admin"],
    studentId: "S-1",
    due: "2026-09-01 18:00",
    status: "upcoming",
    tone: "amber",
    category: "考试",
    trigger: "exam",
    ruleKey: "exam:EXM-1:care",
    anchorBookingId: "exam:EXM-1",
  };
  transition("tasks", [managed], [managed]);
  assert.throws(() => transition("tasks", [managed], [{
    ...managed,
    status: "done",
    tone: "green",
    result: "forged",
    closedAt: "2026-08-15T00:00:00.000Z",
  }]), rejected);
  assert.throws(() => transition("tasks", [managed], []), rejected);
  assert.throws(() => transition("tasks", [], [managed]), rejected);
});

test("student follow-up and LP revision/audit histories are append-only", () => {
  const followedUp = {
    ...student,
    followUpHistory: [{ id: "FU-1", followedUpAt: "2026-08-13T00:00:00.000Z", note: "Called" }],
  };
  transition("students", [student], [followedUp]);
  assert.throws(() => transition("students", [followedUp], [{ ...followedUp, followUpHistory: [] }]), rejected);
  assert.throws(() => transition("students", [followedUp], [{
    ...followedUp,
    followUpHistory: [{ id: "FU-1", followedUpAt: "2026-08-13T00:00:00.000Z", note: "Changed" }],
  }]), rejected);

  const revision = {
    id: "LPR-1",
    workflowId: "LP-1",
    number: 1,
    changedAt: "2026-08-13T00:00:00.000Z",
    changedBy: "Nixon",
    before: {},
    after: { subject: "English" },
  };
  const stageAudit = {
    id: "LPA-1",
    workflowId: "LP-1",
    action: "stage_changed",
    occurredAt: "2026-08-13T01:00:00.000Z",
    actor: "Nixon",
    fromStage: "待资料",
    toStage: "写作中",
  };
  const lp = {
    id: "LP-1",
    studentId: "S-1",
    title: "Trial LP",
    workflowType: "试听 LP",
    stage: "写作中",
    owner: "Abby",
    due: "2026-08-14",
    fields: { subject: "English" },
    revisionNumber: 1,
    revisions: [revision],
    stageAudit: [stageAudit],
    resultAudit: [],
  };
  const lpRows = [...fixtureRows(), row("lpItems", [lp])];
  const appended = {
    ...lp,
    fields: { subject: "English", note: "Updated" },
    revisionNumber: 2,
    revisions: [...lp.revisions, { ...revision, id: "LPR-2", number: 2 }],
  };
  transition("lpItems", [lp], [appended], lpRows);
  assert.throws(() => transition("lpItems", [lp], [{ ...lp, revisions: [] }], lpRows), rejected);
  assert.throws(() => transition("lpItems", [lp], [{ ...lp, stageAudit: [{ ...stageAudit, actor: "Forged" }] }], lpRows), rejected);
  assert.throws(() => transition("lpItems", [lp], [{ ...lp, revisionNumber: 0 }], lpRows), rejected);
});

test("generic saves cannot change import archive markers or mutate any archived-student business record", () => {
  const archivedStudent = {
    ...student,
    importArchived: true,
    importArchivedReason: "referenced_history",
  };
  const archivedBooking = { ...booking, studentId: archivedStudent.id };
  const archivedTask = { id: "TASK-ARCHIVED", studentId: archivedStudent.id, owner: "Abby", title: "Historical task" };
  const archivedLp = { id: "LP-ARCHIVED", studentId: archivedStudent.id, revisions: [], stageAudit: [], resultAudit: [], revisionNumber: 0 };
  const archivedOperation = { ...operation, id: "OPS-ARCHIVED", studentId: archivedStudent.id };
  const archivedRenewal = { id: "REN-ARCHIVED", studentId: archivedStudent.id, status: "已联系" };
  const archivedMessage = { id: "MSG-ARCHIVED", studentId: archivedStudent.id, body: "Historical message" };
  const archivedFile = { id: "FILE-ARCHIVED", studentId: archivedStudent.id, title: "Historical file" };
  const archivedPayroll = { ...payrollSummary, id: "PAY-ARCHIVED", studentId: archivedStudent.id };
  const rows = [
    row("students", [archivedStudent]),
    row("teachers", teachers),
    row("bookings", [archivedBooking]),
    row("tasks", [archivedTask]),
    row("lpItems", [archivedLp]),
    row("operations", [archivedOperation]),
    row("renewals", [archivedRenewal]),
    row("messages", [archivedMessage]),
    row("files", [archivedFile]),
    row("payroll", [payrollSummary, payrollLedger, archivedPayroll]),
  ];

  for (const limited of [false, true]) {
    assert.throws(() => transition("students", [archivedStudent], [{ ...archivedStudent, name: "Rewritten history" }], rows, limited), rejected);
    assert.throws(() => transition("students", [archivedStudent], [{ ...archivedStudent, status: "在读" }], rows, limited), rejected);
    assert.throws(() => transition("students", [archivedStudent], [{ ...archivedStudent, injected: true }], rows, limited), rejected);
    assert.throws(() => transition("students", [archivedStudent], [{ ...archivedStudent, importArchived: false }], rows, limited), rejected);
    assert.throws(() => transition("students", [archivedStudent], [{ ...archivedStudent, importArchivedReason: "tampered" }], rows, limited), rejected);
    assert.throws(() => transition("students", [student], [{ ...student, importArchived: true }], fixtureRows(), limited), rejected);

    for (const [entity, existing] of [
      ["bookings", archivedBooking],
      ["tasks", archivedTask],
      ["lpItems", archivedLp],
      ["operations", archivedOperation],
      ["renewals", archivedRenewal],
      ["messages", archivedMessage],
      ["files", archivedFile],
      ["payroll", archivedPayroll],
    ] as const) {
      assert.throws(() => transition(entity, [existing], [{ ...existing, archiveTamper: true }], rows, limited), rejected);
      assert.throws(() => transition(entity, [existing], [], rows, limited), rejected);
      assert.throws(() => transition(entity, [existing], [existing, { ...existing, id: `${existing.id}-NEW` }], rows, limited), rejected);
      transition(entity, [existing], [existing], rows, limited);
    }
  }

  transition("students", [archivedStudent], [archivedStudent], rows);
  transition("students", [student], [{ ...student, name: "Active student edit", status: "在读" }], fixtureRows());
});

test("payroll summaries remain editable but teacher-hours and reversal ledger entries are immutable", () => {
  const current = [payrollSummary, payrollLedger];
  transition("payroll", current, [{ ...payrollSummary, amount: 35 }, payrollLedger]);
  assert.throws(() => transition("payroll", current, [payrollSummary]), rejected);
  assert.throws(() => transition("payroll", current, [payrollSummary, { ...payrollLedger, payableHours: 3 }]), rejected);
});

test("generic saves cannot add, change, or remove atomic FU and Report file indexes", () => {
  const atomicFile = {
    id: "FU-5e35b8d4-d345-4d44-a2fb-1431e5c07b5f",
    studentId: "S-1",
    title: "沟通截图",
    type: "FU",
    source: "/api/fu-attachments/5e35b8d4-d345-4d44-a2fb-1431e5c07b5f",
    addedAt: "2026-08-13T00:00:00.000Z",
  };
  const ordinaryFile = {
    id: "FILE-1",
    studentId: "S-1",
    title: "External link",
    type: "资料链接",
    source: "https://example.com/file",
    addedAt: "2026-08-13T00:00:00.000Z",
  };
  const rows = [...fixtureRows(), row("files", [atomicFile, ordinaryFile])];
  assert.throws(() => transition("files", [atomicFile, ordinaryFile], [ordinaryFile], rows), rejected);
  assert.throws(() => transition("files", [atomicFile, ordinaryFile], [{ ...atomicFile, title: "Changed" }, ordinaryFile], rows), rejected);
  assert.throws(() => transition("files", [ordinaryFile], [atomicFile, ordinaryFile], rows), rejected);
  assert.doesNotThrow(() => transition("files", [ordinaryFile], [{ ...ordinaryFile, title: "Updated link" }], rows));
});
