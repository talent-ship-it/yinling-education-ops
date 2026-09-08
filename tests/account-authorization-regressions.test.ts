import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpsAccessContext,
  canAccessStudent,
  filterOpsStateRows,
  managedExamStudentProjectionSnapshot,
  managedTrialPaymentStudentProjectionSnapshot,
  mergeScopedPayload,
} from "../lib/ops-access.ts";
import { prepareBookingCapacityMutation } from "../lib/booking-capacity-service.ts";
import { meetingIdForOccurrenceValue } from "../lib/bbb-analytics.ts";
import type { DemoSessionIdentity } from "../lib/demo-session-token.ts";
import type { OpsStateRow } from "../lib/ops-store.ts";

function row(entity: string, payload: unknown): OpsStateRow {
  return { entity, payload, version: 1, updated_at: "2026-09-08T00:00:00.000Z", updated_by: "Synthetic" };
}

function booking(id: string, studentId: string, teacherId: string) {
  return {
    id, studentId, teacherId, date: "2026-09-09", start: "10:00", duration: 60,
    recurring: false, kind: "试听", status: "待确认", timezone: "Australia/Melbourne", course: "English",
  };
}

function fixtureRows(): OpsStateRow[] {
  return [
    row("students", [
      { id: "S1", name: "Student one", teacher: "Teacher A", owner: "Abby", planner: "Tara",
        exams: [{ id: "EXM-1", subject: "English", examType: "other", examMonth: "2026-09" }] },
      { id: "S2", name: "Student two", teacher: "Teacher A", owner: "Abby", planner: "Tara" },
      { id: "S3", name: "Student three", teacher: "Teacher B", owner: "Abby", planner: "Tara" },
    ]),
    row("teachers", [
      { id: "T1", name: "Teacher A" },
      { id: "T2", name: "Teacher B" },
    ]),
    row("bookings", [booking("B1", "S1", "T1"), booking("B2", "S2", "T1"), booking("B3", "S1", "T2"), booking("B4", "S3", "T2")]),
    row("tasks", [
      { id: "TASK-EXAM", studentId: "S1", owner: "Tara", assignees: ["Tara"], watchers: ["Ops Admin"],
        category: "考试", ruleKey: "exam:EXM-1:results", anchorBookingId: "exam:EXM-1", title: "Exam follow-up" },
      { id: "TASK-PAYMENT", studentId: "S1", owner: "Tara", assignees: ["Tara"], watchers: ["Ops Admin"],
        category: "试听", ruleKey: "trial.payment-urgent", anchorBookingId: "B1", title: "Trial payment", status: "upcoming" },
    ]),
    row("lpItems", []),
    row("files", []),
  ];
}

const teacherIdentity: DemoSessionIdentity = {
  user: "Teacher A", role: "teacher",
  permissions: ["students.read.assigned", "bookings.read.assigned", "bookings.write.assigned"],
  scopeMembers: [{ kind: "student", key: "S1" }],
};

function visibleIds(rows: OpsStateRow[], identity: DemoSessionIdentity, entity: string) {
  const access = buildOpsAccessContext(rows, identity.user, false, identity);
  const payload = filterOpsStateRows(rows, access).find((value) => value.entity === entity)?.payload;
  return (payload as Array<{ id: string }>).map((value) => value.id);
}

test("a student-limited teacher cannot read excluded students or inherit co-teacher authority", () => {
  const rows = fixtureRows();
  const access = buildOpsAccessContext(rows, teacherIdentity.user, false, teacherIdentity);
  assert.deepEqual([...access.studentIds], ["S1"]);
  assert.equal(canAccessStudent(access, "S2"), false);
  assert.deepEqual([...access.teacherIds], ["T1"]);
  assert.deepEqual([...access.visibleTeacherIds], ["T1", "T2"]);
  assert.deepEqual(visibleIds(rows, teacherIdentity, "bookings"), ["B1"]);
  assert.deepEqual(visibleIds(rows, teacherIdentity, "teachers"), ["T1", "T2"]);
  assert.throws(() => mergeScopedPayload({
    entity: "bookings",
    currentPayload: rows.find((value) => value.entity === "bookings")!.payload,
    submittedPayload: [{ ...booking("B3", "S1", "T2"), start: "11:00" }],
    context: access,
  }), /不能修改/u);
  assert.deepEqual(visibleIds(rows, { ...teacherIdentity, scopeMembers: [{ kind: "all", key: "*" }] }, "bookings"), ["B1", "B2"]);
});

test("teacher scope narrows students without changing the signed teaching identity", () => {
  const rows = fixtureRows();
  const identity = { ...teacherIdentity, scopeMembers: [{ kind: "teacher", key: "T2" }] };
  const access = buildOpsAccessContext(rows, identity.user, false, identity);
  assert.deepEqual([...access.studentIds], ["S1"]);
  assert.deepEqual([...access.teacherIds], ["T1"]);
  assert.deepEqual(visibleIds(rows, identity, "bookings"), ["B1"]);
  const scopedAdmin = { ...identity, user: "Ops Admin", role: "limited-admin" as const, permissions: ["operations.read"] };
  assert.deepEqual(visibleIds(rows, scopedAdmin, "students"), ["S1", "S3"]);
});

test("student-limited substitutes keep their own occurrence and classroom binding", () => {
  const occurrenceId = "B1:2026-09-09";
  const rows = fixtureRows().map((value) => value.entity === "bookings"
    ? row("bookings", [{ ...booking("B1", "S1", "T1"), occurrenceOverrides: [{ occurrenceId, teacherId: "T2", status: "confirmed" }] }])
    : value);
  const substitute = { ...teacherIdentity, user: "Teacher B" };
  assert.deepEqual(visibleIds(rows, substitute, "students"), ["S1"]);
  assert.deepEqual(visibleIds(rows, substitute, "bookings"), ["B1"]);
  assert.deepEqual(visibleIds(rows, teacherIdentity, "bookings"), []);
  const command = {
    action: "bind_classroom" as const,
    bookingId: "B1", occurrenceId,
    classroom: { meetingId: meetingIdForOccurrenceValue(occurrenceId), status: "ready" as const },
    expectedVersions: { bookings: 1, students: 1, lpItems: 1, tasks: 1, teachers: 1 },
  };
  const bound = prepareBookingCapacityMutation({
    command, rows, actor: substitute.user, role: "teacher", authorization: substitute,
    fullAdmin: false, now: new Date("2026-09-08T00:00:00.000Z"),
  });
  assert.equal(bound.teacherId, "T2");
  assert.throws(() => prepareBookingCapacityMutation({
    command, rows, actor: teacherIdentity.user, role: "teacher", authorization: teacherIdentity,
    fullAdmin: false, now: new Date("2026-09-08T00:00:00.000Z"),
  }), /当前账号不能绑定/u);
});

test("managed student snapshots honor revoked read permissions and entity restrictions", () => {
  const rows = fixtureRows();
  const identities: DemoSessionIdentity[] = [
    { user: "Tara", role: "staff", permissions: [], scopeMembers: [{ kind: "all", key: "*" }] },
    ...["files", "students", "tasks"].map((key) => ({
      user: "Tara", role: "staff" as const, permissions: ["operations.read"], scopeMembers: [{ kind: "entity", key }],
    })),
    { user: "Tara", role: "staff", permissions: ["operations.write"], scopeMembers: [{ kind: "all", key: "*" }] },
  ];
  for (const identity of identities) {
    const access = buildOpsAccessContext(rows, identity.user, false, identity);
    assert.deepEqual(managedExamStudentProjectionSnapshot(rows, access).students, []);
    assert.deepEqual(managedTrialPaymentStudentProjectionSnapshot(rows, access).students, []);
  }
  for (const scopeMembers of [
    [{ kind: "all", key: "*" }],
    [{ kind: "entity", key: "students" }, { kind: "entity", key: "tasks" }],
  ]) {
    const identity = { user: "Tara", role: "staff" as const, permissions: ["operations.read"], scopeMembers };
    const access = buildOpsAccessContext(rows, identity.user, false, identity);
    assert.deepEqual(managedExamStudentProjectionSnapshot(rows, access).students.map((student) => student.id), ["S1"]);
    assert.deepEqual(managedTrialPaymentStudentProjectionSnapshot(rows, access).students.map((student) => student.id), ["S1"]);
  }
});
