import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpsAccessContext,
  canAccessStudent,
  canOperateStudent,
  filterOpsStateRows,
  filterOpsVersions,
  getAccessScopeVersions,
  mergeScopedPayload,
  managedExamStudentProjections,
  managedTrialPaymentStudentProjectionSnapshot,
  managedTrialPaymentStudentProjections,
  OpsAccessError,
} from "../lib/ops-access";
import type { OpsStateRow, OpsVersionRow } from "../lib/ops-store";

const rows: OpsStateRow[] = [
  {
    entity: "students",
    version: 4,
    updated_at: "2026-07-28T00:00:00.000Z",
    updated_by: "Admin",
    payload: [
      { id: "STU-ABBY", name: "Abby student", owner: "Abby", planner: "Tara", teacher: "Helen Ceperkovic", exams: [{ id: "EXM-1", subject: "Maths", examType: "other", examMonth: "2026-08", privateStudentNote: "must not cross scope" }] },
      { id: "STU-THEA", name: "Thea student", owner: "Thea", planner: "Tara", teacher: "Another teacher", exams: [{ id: "EXM-2", subject: "English", examType: "other", examMonth: "2026-09" }] },
    ],
  },
  {
    entity: "teachers",
    version: 1,
    updated_at: "2026-07-28T00:00:00.000Z",
    updated_by: "Admin",
    payload: [
      { id: "TEA-HELEN", name: "Helen Ceperkovic" },
      { id: "TEA-OTHER", name: "Another teacher" },
    ],
  },
  {
    entity: "bookings",
    version: 2,
    updated_at: "2026-07-28T00:00:00.000Z",
    updated_by: "Admin",
    payload: [
      { id: "BOOK-ABBY", studentId: "STU-ABBY", teacherId: "TEA-HELEN" },
      { id: "BOOK-THEA", studentId: "STU-THEA", teacherId: "TEA-OTHER" },
    ],
  },
  {
    entity: "files",
    version: 3,
    updated_at: "2026-07-28T00:00:00.000Z",
    updated_by: "Admin",
    payload: [
      { id: "FILE-ABBY", studentId: "STU-ABBY", title: "Abby FU" },
      { id: "FILE-THEA", studentId: "STU-THEA", title: "Thea FU" },
    ],
  },
  {
    entity: "tasks",
    version: 1,
    updated_at: "2026-07-28T00:00:00.000Z",
    updated_by: "Admin",
    payload: [
      { id: "TASK-ABBY", studentId: "STU-ABBY", owner: "Abby", title: "Abby task" },
      { id: "TASK-THEA", studentId: "STU-THEA", owner: "Abby", title: "Cross-owner task" },
      { id: "TASK-PLANNER", studentId: "STU-ABBY", owner: "Tara", assignees: ["Tara"], watchers: ["Ops Admin"], title: "Planner task" },
      { id: "TASK-EXAM-RESULT", studentId: "STU-ABBY", owner: "Tara", assignees: ["Tara"], watchers: ["Ops Admin"], category: "考试", ruleKey: "exam:EXM-1:results", anchorBookingId: "exam:EXM-1", title: "Exam result task" },
      { id: "TASK-EXAM-RECALL-LEGACY", studentId: "STU-ABBY", owner: "Abby", category: "考试", ruleKey: "exam:EXM-1:recall", anchorBookingId: "exam:EXM-1", title: "Legacy recall task" },
      { id: "TASK-WATCHED", studentId: "STU-ABBY", owner: "Tara", watchers: ["Abby"], title: "Watched by Abby" },
      { id: "TASK-TEACHER", studentId: "STU-ABBY", owner: "Abby", assignees: ["Helen Ceperkovic"], teacherVisible: true, title: "Teacher-visible task" },
      { id: "TASK-TEACHER-GENERIC", studentId: "STU-ABBY", owner: "Abby", teacherVisible: true, title: "Flag without a teacher recipient" },
    ],
  },
  {
    entity: "rules",
    version: 1,
    updated_at: "2026-07-28T00:00:00.000Z",
    updated_by: "Admin",
    payload: { lowHours: "5" },
  },
  {
    entity: "payroll",
    version: 1,
    updated_at: "2026-07-28T00:00:00.000Z",
    updated_by: "Admin",
    payload: [{ id: "PAY-1", bankAccount: "sensitive" }],
  },
];

function row(entity: string) {
  const value = rows.find((item) => item.entity === entity);
  assert.ok(value, `expected ${entity} row`);
  return value;
}

test("staff receive only their assigned student records and cannot access payroll", () => {
  const access = buildOpsAccessContext(rows, "Abby", false);
  const visible = filterOpsStateRows(rows, access);

  assert.deepEqual((visible.find((item) => item.entity === "students")?.payload as Array<{ id: string }>).map((item) => item.id), ["STU-ABBY"]);
  assert.deepEqual((visible.find((item) => item.entity === "files")?.payload as Array<{ id: string }>).map((item) => item.id), ["FILE-ABBY"]);
  assert.deepEqual((visible.find((item) => item.entity === "tasks")?.payload as Array<{ id: string }>).map((item) => item.id), ["TASK-ABBY", "TASK-EXAM-RESULT", "TASK-EXAM-RECALL-LEGACY", "TASK-WATCHED", "TASK-TEACHER", "TASK-TEACHER-GENERIC"]);
  assert.equal(visible.some((item) => item.entity === "payroll"), false);
  assert.equal(visible.some((item) => item.entity === "rules"), false);
  assert.equal(canAccessStudent(access, "STU-THEA"), false);
});

test("a managed exam planner receives only the addressed task, not the student's other records", () => {
  const access = buildOpsAccessContext(rows, "Tara", false, "staff");
  const visible = filterOpsStateRows(rows, access);

  assert.deepEqual(visible.find((item) => item.entity === "students")?.payload, []);
  assert.deepEqual(visible.find((item) => item.entity === "bookings")?.payload, []);
  assert.deepEqual((visible.find((item) => item.entity === "tasks")?.payload as Array<{ id: string }>).map((item) => item.id), ["TASK-EXAM-RESULT"]);

  const current = row("tasks").payload as Array<Record<string, unknown>>;
  const submitted = current
    .filter((task) => task.id === "TASK-EXAM-RESULT")
    .map((task) => ({ ...task, status: "done", tone: "green", closedAt: "2026-08-15T00:00:00.000Z", result: "已完成" }));
  const merged = mergeScopedPayload({ entity: "tasks", currentPayload: current, submittedPayload: submitted, context: access }) as Array<{ id: string; status?: string }>;
  assert.equal(merged.find((task) => task.id === "TASK-EXAM-RESULT")?.status, "done");

  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: current,
    submittedPayload: submitted.map((task) => ({ ...task, title: "planner attempted to change content" })),
    context: access,
  }), /不能修改未分配/);
});

test("managed exam staff receive only a minimal projection for the assigned exam row", () => {
  const access = buildOpsAccessContext(rows, "Tara", false, "staff");
  const projections = managedExamStudentProjections(rows, access);

  assert.deepEqual(projections, [{
    id: "STU-ABBY",
    name: "Abby student",
    initials: "",
    owner: "Abby",
    exams: [{ id: "EXM-1", subject: "Maths", examType: "other", examMonth: "2026-08" }],
  }]);
  assert.equal("guardianWechat" in projections[0], false);
  assert.equal("planner" in projections[0], false);
  assert.equal("lessonPackages" in projections[0], false);
  assert.equal("privateStudentNote" in projections[0].exams[0], false);

  const unassigned = buildOpsAccessContext(rows, "Molly", false, "staff");
  assert.deepEqual(managedExamStudentProjections(rows, unassigned), []);
  assert.deepEqual(filterOpsStateRows(rows, unassigned).find((item) => item.entity === "tasks")?.payload, []);
  assert.deepEqual(managedExamStudentProjections(rows, buildOpsAccessContext(rows, "Helen Ceperkovic", false, "teacher")), []);
  assert.deepEqual(managedExamStudentProjections(rows, buildOpsAccessContext(rows, "Ops Admin", false, "limited-admin")), []);
});

test("cross-owner trial payment access is exact, minimal, and planner-only", () => {
  const paymentRows = rows.map((item) => {
    if (item.entity === "bookings") return {
      ...item,
      payload: (item.payload as Array<Record<string, unknown>>).map((booking) => booking.id === "BOOK-ABBY"
        ? { ...booking, kind: "试听" }
        : booking),
    };
    if (item.entity === "tasks") return {
      ...item,
      payload: [...(item.payload as Array<Record<string, unknown>>), {
        id: "TASK-TRIAL-PAYMENT",
        studentId: "STU-ABBY",
        owner: "Tara",
        assignees: ["Tara"],
        watchers: ["Ops Admin"],
        category: "试听",
        ruleKey: "trial.payment-urgent",
        anchorBookingId: "BOOK-ABBY",
        title: "试听不足 24 小时仍未付款",
        dueAt: "2026-08-20T00:00:00.000Z",
      }],
    };
    return item;
  });

  const planner = buildOpsAccessContext(paymentRows, "Tara", false, "staff");
  const plannerTasks = filterOpsStateRows(paymentRows, planner)
    .find((item) => item.entity === "tasks")?.payload as Array<{ id: string }>;
  assert.equal(plannerTasks.some((task) => task.id === "TASK-TRIAL-PAYMENT"), true);
  assert.deepEqual(managedTrialPaymentStudentProjections(paymentRows, planner), [{
    id: "STU-ABBY",
    name: "Abby student",
    initials: "",
  }]);
  assert.deepEqual(managedTrialPaymentStudentProjectionSnapshot(paymentRows, planner), {
    versions: { bookings: 2, students: 4, tasks: 1 },
    students: [{ id: "STU-ABBY", name: "Abby student", initials: "" }],
  });
  assert.deepEqual(Object.keys(managedTrialPaymentStudentProjections(paymentRows, planner)[0]).sort(), [
    "id", "initials", "name",
  ]);

  const operationsOwner = buildOpsAccessContext(paymentRows, "Abby", false, "staff");
  const ownerTasks = filterOpsStateRows(paymentRows, operationsOwner)
    .find((item) => item.entity === "tasks")?.payload as Array<{ id: string }>;
  assert.equal(ownerTasks.some((task) => task.id === "TASK-TRIAL-PAYMENT"), false);
  assert.deepEqual(managedTrialPaymentStudentProjections(paymentRows, operationsOwner), []);

  const unassigned = buildOpsAccessContext(paymentRows, "Molly", false, "staff");
  assert.equal((filterOpsStateRows(paymentRows, unassigned)
    .find((item) => item.entity === "tasks")?.payload as Array<{ id: string }>)
    .some((task) => task.id === "TASK-TRIAL-PAYMENT"), false);
  assert.deepEqual(managedTrialPaymentStudentProjections(paymentRows, unassigned), []);

  const taskPayload = paymentRows.find((item) => item.entity === "tasks")!.payload as Array<Record<string, unknown>>;
  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: taskPayload,
    submittedPayload: taskPayload.map((task) => task.id === "TASK-TRIAL-PAYMENT"
      ? { ...task, status: "done", result: "已由规划老师确认试听付款" }
      : task),
    context: planner,
  }), /专用确认流程/);
});

test("archiving a cross-owner exam student removes both the managed task and minimal projection", () => {
  const archivedRows = rows.map((item) => item.entity !== "students" ? item : {
    ...item,
    payload: (item.payload as Array<Record<string, unknown>>).map((student) => student.id === "STU-ABBY"
      ? { ...student, importArchived: true }
      : student),
  });
  const planner = buildOpsAccessContext(archivedRows, "Tara", false, "staff");
  const visible = filterOpsStateRows(archivedRows, planner);

  assert.deepEqual(visible.find((item) => item.entity === "students")?.payload, []);
  assert.deepEqual(visible.find((item) => item.entity === "tasks")?.payload, []);
  assert.deepEqual(managedExamStudentProjections(archivedRows, planner), []);

  const current = rows.find((item) => item.entity === "tasks")?.payload as Array<Record<string, unknown>>;
  const completion = current
    .filter((task) => task.id === "TASK-EXAM-RESULT")
    .map((task) => ({ ...task, status: "done", tone: "green", closedAt: "2026-08-15T00:00:00.000Z", result: "已完成" }));
  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: current,
    submittedPayload: completion,
    context: planner,
  }), /不能修改未分配/);
});

test("teachers receive only their own assigned and booked students", () => {
  const access = buildOpsAccessContext(rows, "Helen Ceperkovic", false, "teacher");
  const visible = filterOpsStateRows(rows, access);

  assert.deepEqual((visible.find((item) => item.entity === "students")?.payload as Array<{ id: string }>).map((item) => item.id), ["STU-ABBY"]);
  assert.deepEqual((visible.find((item) => item.entity === "bookings")?.payload as Array<{ id: string }>).map((item) => item.id), ["BOOK-ABBY"]);
  assert.deepEqual((visible.find((item) => item.entity === "teachers")?.payload as Array<{ id: string }>).map((item) => item.id), ["TEA-HELEN"]);
  assert.deepEqual((visible.find((item) => item.entity === "tasks")?.payload as Array<{ id: string }>).map((item) => item.id), ["TASK-TEACHER"]);
  assert.throws(() => mergeScopedPayload({
    entity: "files",
    currentPayload: row("files").payload,
    submittedPayload: [{ id: "FILE-NEW", studentId: "STU-ABBY", title: "Teacher upload" }],
    context: access,
  }), OpsAccessError);
});

test("archived students and their historical bookings remain readable but are never operable", () => {
  const archivedRows = rows.map((item) => {
    if (item.entity === "students") return {
      ...item,
      payload: [
        ...(item.payload as object[]),
        { id: "STU-ARCHIVED", name: "Archived student", owner: "Abby", teacher: "Helen Ceperkovic", importArchived: true },
      ],
    };
    if (item.entity === "bookings") return {
      ...item,
      payload: [
        ...(item.payload as object[]),
        { id: "BOOK-ARCHIVED", studentId: "STU-ARCHIVED", teacherId: "TEA-HELEN" },
      ],
    };
    return item;
  });

  for (const access of [
    buildOpsAccessContext(archivedRows, "Abby", false, "staff"),
    buildOpsAccessContext(archivedRows, "Helen Ceperkovic", false, "teacher"),
    buildOpsAccessContext(archivedRows, "Ops Admin", false, "limited-admin"),
    buildOpsAccessContext(archivedRows, "Nixon", true, "admin"),
  ]) {
    const visible = filterOpsStateRows(archivedRows, access);
    assert.equal(canAccessStudent(access, "STU-ARCHIVED"), true);
    assert.equal(canOperateStudent(access, "STU-ARCHIVED"), false);
    assert.equal(
      (visible.find((item) => item.entity === "students")?.payload as Array<{ id: string }>).some((item) => item.id === "STU-ARCHIVED"),
      true,
    );
    assert.equal(
      (visible.find((item) => item.entity === "bookings")?.payload as Array<{ id: string }>).some((item) => item.id === "BOOK-ARCHIVED"),
      true,
    );
  }

  const staff = buildOpsAccessContext(archivedRows, "Abby", false, "staff");
  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: [],
    submittedPayload: [{ id: "TASK-ARCHIVED", studentId: "STU-ARCHIVED", owner: "Abby" }],
    context: staff,
  }), OpsAccessError);
  assert.throws(() => mergeScopedPayload({
    entity: "students",
    currentPayload: archivedRows.find((item) => item.entity === "students")?.payload,
    submittedPayload: [{ id: "STU-ARCHIVED", name: "Changed", owner: "Abby", importArchived: true }],
    context: staff,
  }), OpsAccessError);
});

test("a roster teacher outside the seeded demo list receives teacher-only scope from the signed role", () => {
  const access = buildOpsAccessContext(rows, "Another teacher", false, "teacher");
  const visible = filterOpsStateRows(rows, access);

  assert.equal(access.teacher, true);
  assert.equal(access.staff, false);
  assert.deepEqual((visible.find((item) => item.entity === "students")?.payload as Array<{ id: string }>).map((item) => item.id), ["STU-THEA"]);
  assert.deepEqual((visible.find((item) => item.entity === "bookings")?.payload as Array<{ id: string }>).map((item) => item.id), ["BOOK-THEA"]);
  assert.deepEqual((visible.find((item) => item.entity === "teachers")?.payload as Array<{ id: string }>).map((item) => item.id), ["TEA-OTHER"]);
  assert.equal(visible.some((item) => item.entity === "lpItems"), false);
});

test("a substitute teacher receives the student and series through the effective occurrence teacher", () => {
  const substitutedRows = rows.map((item) => {
    if (item.entity === "teachers") return {
      ...item,
      payload: [...(item.payload as object[]), { id: "TEA-SUB", name: "Sub Teacher" }],
    };
    if (item.entity === "bookings") return {
      ...item,
      payload: [{
        id: "BOOK-SUB",
        studentId: "STU-ABBY",
        teacherId: "TEA-HELEN",
        date: "2026-09-01",
        occurrenceOverrides: [{
          occurrenceId: "BOOK-SUB:2026-09-01",
          teacherId: "TEA-SUB",
          status: "confirmed",
        }],
      }],
    };
    return item;
  });
  const substitute = buildOpsAccessContext(substitutedRows, "Sub Teacher", false, "teacher");
  const substituteVisible = filterOpsStateRows(substitutedRows, substitute);
  assert.deepEqual((substituteVisible.find((item) => item.entity === "students")?.payload as Array<{ id: string }>).map((item) => item.id), ["STU-ABBY"]);
  assert.deepEqual((substituteVisible.find((item) => item.entity === "bookings")?.payload as Array<{ id: string }>).map((item) => item.id), ["BOOK-SUB"]);
  assert.throws(() => mergeScopedPayload({
    entity: "bookings",
    currentPayload: substitutedRows.find((item) => item.entity === "bookings")?.payload,
    submittedPayload: [{
      ...(substituteVisible.find((item) => item.entity === "bookings")?.payload as Array<Record<string, unknown>>)[0],
      status: "已确认",
    }],
    context: substitute,
  }), OpsAccessError);

  const parent = buildOpsAccessContext(substitutedRows, "Helen Ceperkovic", false, "teacher");
  const parentVisible = filterOpsStateRows(substitutedRows, parent);
  assert.deepEqual(parentVisible.find((item) => item.entity === "bookings")?.payload, []);
});

test("a signed teacher role is not promoted to staff when its name resembles a staff account", () => {
  const access = buildOpsAccessContext(rows, "Abby", false, "teacher");
  assert.equal(access.teacher, true);
  assert.equal(access.staff, false);
  assert.equal(access.studentIds.size, 0);
});

test("teachers cannot write tasks even when explicitly assigned or linked to the student", () => {
  const access = buildOpsAccessContext(rows, "Helen Ceperkovic", false);
  const current = row("tasks").payload as Array<Record<string, unknown>>;
  const submitted = current
    .filter((task) => task.id === "TASK-TEACHER")
    .map((task) => ({ ...task, status: "done" }));

  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: current,
    submittedPayload: submitted,
    context: access,
  }), /没有修改这部分资料的权限/);
  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: current,
    submittedPayload: [{ id: "TASK-TEACHER-NEW", studentId: "STU-ABBY", owner: "Helen Ceperkovic", teacherVisible: true }],
    context: access,
  }), OpsAccessError);
});

test("test teacher can create a classroom booking only for the linked test student", () => {
  const testRows: OpsStateRow[] = rows.map((item) => {
    if (item.entity === "students") return { ...item, payload: [...(item.payload as object[]), { id: "STU-TEST-NIXON", name: "Nixon（测试）", owner: "Nixon", teacher: "Nixon（测试）" }] };
    if (item.entity === "teachers") return { ...item, payload: [...(item.payload as object[]), { id: "TEA-TEST-NIXON", name: "Nixon（测试）" }] };
    return item;
  });
  const access = buildOpsAccessContext(testRows, "Nixon（测试）", false);
  const currentBookings = testRows.find((item) => item.entity === "bookings")?.payload as object[];
  const ownBooking = { id: "TMP-TEST", studentId: "STU-TEST-NIXON", teacherId: "TEA-TEST-NIXON" };
  const merged = mergeScopedPayload({ entity: "bookings", currentPayload: currentBookings, submittedPayload: [ownBooking], context: access }) as Array<{ id: string }>;
  assert.equal(merged.some((item) => item.id === "TMP-TEST"), true);

  assert.throws(() => mergeScopedPayload({
    entity: "bookings",
    currentPayload: currentBookings,
    submittedPayload: [{ id: "TMP-CROSS", studentId: "STU-THEA", teacherId: "TEA-TEST-NIXON" }],
    context: access,
  }), OpsAccessError);
});

test("limited admin can use operations data but payroll stays exclusive to full admin", () => {
  const limited = buildOpsAccessContext(rows, "Ops Admin", false);
  const full = buildOpsAccessContext(rows, "Nixon", true);
  const versions: OpsVersionRow[] = rows.map((item) => ({
    entity: item.entity,
    version: item.version,
    updated_at: item.updated_at,
    updated_by: item.updated_by,
  }));

  assert.equal(filterOpsStateRows(rows, limited).some((item) => item.entity === "payroll"), false);
  assert.equal(filterOpsVersions(versions, limited).some((item) => item.entity === "payroll"), false);
  assert.equal(filterOpsStateRows(rows, full).some((item) => item.entity === "payroll"), true);
});

test("full and limited admins retain unrestricted task writes", () => {
  for (const context of [
    buildOpsAccessContext(rows, "Ops Admin", false),
    buildOpsAccessContext(rows, "Nixon", true),
  ]) {
    const submitted = [{ id: "TASK-ADMIN", studentId: "STU-THEA", owner: "Tara", title: "Admin task" }];
    assert.equal(mergeScopedPayload({
      entity: "tasks",
      currentPayload: row("tasks").payload,
      submittedPayload: submitted,
      context,
    }), submitted);
  }
});

test("scoped writes bind their access decision to the current scope versions", () => {
  const scoped = buildOpsAccessContext(rows, "Abby", false);
  const global = buildOpsAccessContext(rows, "Ops Admin", false);

  assert.deepEqual(getAccessScopeVersions(rows, scoped), {
    bookings: 2,
    students: 4,
    teachers: 1,
  });
  assert.equal(getAccessScopeVersions(rows, global), null);
});

test("scoped writes preserve other users' records and reject cross-owner writes", () => {
  const access = buildOpsAccessContext(rows, "Abby", false);
  const current = row("students");
  const merged = mergeScopedPayload({
    entity: "students",
    currentPayload: current.payload,
    submittedPayload: [
      { id: "STU-ABBY", name: "Updated", owner: "Abby", teacher: "Helen Ceperkovic" },
    ],
    context: access,
  }) as Array<{ id: string; name: string }>;
  assert.deepEqual(merged.map((item) => item.id), ["STU-ABBY", "STU-THEA"]);
  assert.equal(merged[0].name, "Updated");

  assert.throws(() => mergeScopedPayload({
    entity: "students",
    currentPayload: current.payload,
    submittedPayload: [
      { id: "STU-ABBY", name: "Updated", owner: "Abby", teacher: "Helen Ceperkovic" },
      { id: "STU-THEA", name: "Tampered", owner: "Thea", teacher: "Another teacher" },
    ],
    context: access,
  }), OpsAccessError);
  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: row("tasks").payload,
    submittedPayload: [
      { id: "TASK-ABBY", studentId: "STU-ABBY", owner: "Abby", title: "Abby task" },
      { id: "TASK-PLANNER", studentId: "STU-ABBY", owner: "Tara", assignees: ["Tara"], watchers: ["Ops Admin"], title: "Tampered planner task" },
    ],
    context: access,
  }), /不能修改未分配/);
  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: row("tasks").payload,
    submittedPayload: [
      { id: "TASK-ABBY", studentId: "STU-ABBY", owner: "Abby", title: "Abby task" },
      { id: "TASK-NEW-OTHER", studentId: "STU-ABBY", owner: "Tara", assignees: ["Tara"], title: "Other owner task" },
    ],
    context: access,
  }), /不能新增未分配/);
  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: row("tasks").payload,
    submittedPayload: [
      { id: "TASK-EXAM-RESULT", studentId: "STU-ABBY", owner: "Tara", assignees: ["Tara"], watchers: ["Ops Admin"], category: "考试", ruleKey: "exam:EXM-1:results", anchorBookingId: "exam:EXM-1", title: "Exam result task", status: "done" },
    ],
    context: access,
  }), /不能修改未分配/);
  const reconciledExamTask = mergeScopedPayload({
    entity: "tasks",
    currentPayload: row("tasks").payload,
    submittedPayload: [
      { id: "TASK-EXAM-RESULT", studentId: "STU-ABBY", owner: "Tara", assignees: ["Tara"], watchers: ["Ops Admin"], category: "考试", ruleKey: "exam:EXM-1:results", anchorBookingId: "exam:EXM-1", title: "Reconciled exam title" },
    ],
    context: access,
  }) as Array<{ id: string; title?: string }>;
  assert.equal(reconciledExamTask.find((task) => task.id === "TASK-EXAM-RESULT")?.title, "Reconciled exam title");
  const generatedResultTask = {
    id: "TASK-EXAM-RESULT-NEW",
    studentId: "STU-ABBY",
    owner: "Tara",
    assignees: ["Tara"],
    watchers: ["Ops Admin"],
    category: "考试",
    ruleKey: "exam:EXM-1:results",
    anchorBookingId: "exam:EXM-1",
    title: "Generated result task",
  };
  const generated = mergeScopedPayload({
    entity: "tasks",
    currentPayload: row("tasks").payload,
    submittedPayload: [generatedResultTask],
    context: access,
  }) as Array<{ id: string }>;
  assert.equal(generated.some((task) => task.id === generatedResultTask.id), true);
  const enrichedLegacy = mergeScopedPayload({
    entity: "tasks",
    currentPayload: row("tasks").payload,
    submittedPayload: [{
      id: "TASK-EXAM-RECALL-LEGACY",
      studentId: "STU-ABBY",
      owner: "Abby",
      assignees: ["Abby"],
      watchers: ["Ops Admin"],
      category: "考试",
      ruleKey: "exam:EXM-1:recall",
      anchorBookingId: "exam:EXM-1",
      title: "Reconciled recall task",
    }],
    context: access,
  }) as Array<{ id: string; assignees?: string[] }>;
  assert.deepEqual(enrichedLegacy.find((task) => task.id === "TASK-EXAM-RECALL-LEGACY")?.assignees, ["Abby"]);
  for (const invalid of [
    { ...generatedResultTask, id: "TASK-EXAM-BAD-ASSIGNEE", assignees: ["Tara", "Abby"] },
    { ...generatedResultTask, id: "TASK-EXAM-BAD-WATCHER", watchers: ["Abby"] },
    { ...generatedResultTask, id: "TASK-EXAM-BAD-ANCHOR", anchorBookingId: "exam:EXM-OTHER" },
    { ...generatedResultTask, id: "TASK-EXAM-BAD-RULE", ruleKey: "exam:EXM-404:results", anchorBookingId: "exam:EXM-404" },
    { ...generatedResultTask, id: "TASK-EXAM-BAD-OWNER", owner: "Abby", assignees: ["Abby"] },
  ]) {
    assert.throws(() => mergeScopedPayload({
      entity: "tasks",
      currentPayload: row("tasks").payload,
      submittedPayload: [invalid],
      context: access,
    }), /不能新增未分配/);
  }
  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: row("tasks").payload,
    submittedPayload: [
      { id: "TASK-PLANNER", studentId: "STU-ABBY", owner: "Tara", assignees: ["Tara", "Abby"], watchers: ["Ops Admin"], category: "考试", title: "Pretend exam task" },
    ],
    context: access,
  }), /不能修改未分配/);
  const ownTaskWrite = mergeScopedPayload({
    entity: "tasks",
    currentPayload: row("tasks").payload,
    submittedPayload: [
      { id: "TASK-ABBY", studentId: "STU-ABBY", owner: "Abby", title: "Updated own task" },
      { id: "TASK-WATCHED", studentId: "STU-ABBY", owner: "Tara", watchers: ["Abby"], title: "Watched by Abby" },
      { id: "TASK-TEACHER", studentId: "STU-ABBY", owner: "Abby", assignees: ["Helen Ceperkovic"], teacherVisible: true, title: "Teacher-visible task" },
      { id: "TASK-TEACHER-GENERIC", studentId: "STU-ABBY", owner: "Abby", teacherVisible: true, title: "Flag without a teacher recipient" },
      { id: "TASK-NEW-OWN", studentId: "STU-ABBY", owner: "Abby", title: "New own task" },
    ],
    context: access,
  }) as Array<{ id: string; title: string }>;
  assert.equal(ownTaskWrite.find((task) => task.id === "TASK-ABBY")?.title, "Updated own task");
  assert.equal(ownTaskWrite.some((task) => task.id === "TASK-NEW-OWN"), true);
  assert.equal(ownTaskWrite.find((task) => task.id === "TASK-PLANNER")?.title, "Planner task");
  assert.throws(() => mergeScopedPayload({
    entity: "tasks",
    currentPayload: row("tasks").payload,
    submittedPayload: [
      { id: "TASK-ABBY", studentId: "STU-ABBY", owner: "Abby", title: "Abby task" },
      { id: "TASK-NEW", studentId: "STU-THEA", owner: "Abby", title: "Attempted cross-owner task" },
    ],
    context: access,
  }), OpsAccessError);
  assert.throws(() => mergeScopedPayload({
    entity: "rules",
    currentPayload: row("rules").payload,
    submittedPayload: { lowHours: "1" },
    context: access,
  }), OpsAccessError);
});
