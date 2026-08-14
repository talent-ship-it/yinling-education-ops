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
  { id: "T-1", name: "Teacher One", capacityAssignments: ["S-1"], availabilityWindows: availability("T-1") },
  { id: "T-2", name: "Teacher Two", capacityAssignments: [], availabilityWindows: availability("T-2") },
  { id: "T-3", name: "Teacher Without AVA", capacityAssignments: [] },
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
  });
}

function rejected(value: unknown) {
  return value instanceof OpsStateTransitionError && [400, 403].includes(value.status);
}

test("app-state applies invariant validation after scoped merge", async () => {
  const source = await readFile(new URL("../app/api/app-state/route.ts", import.meta.url), "utf8");
  const merge = source.indexOf("const payload = mergeScopedPayload");
  const guard = source.indexOf("assertOpsStateTransition({");
  const write = source.indexOf("const saved = await putOpsState");
  assert.ok(merge >= 0 && guard > merge && write > guard);
  assert.match(source, /error instanceof OpsStateTransitionError/);
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
