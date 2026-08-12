import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpsAccessContext,
  canAccessStudent,
  filterOpsStateRows,
  filterOpsVersions,
  getAccessScopeVersions,
  mergeScopedPayload,
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
      { id: "STU-ABBY", name: "Abby student", owner: "Abby", teacher: "Helen Ceperkovic" },
      { id: "STU-THEA", name: "Thea student", owner: "Thea", teacher: "Another teacher" },
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
  assert.deepEqual((visible.find((item) => item.entity === "tasks")?.payload as Array<{ id: string }>).map((item) => item.id), ["TASK-ABBY"]);
  assert.equal(visible.some((item) => item.entity === "payroll"), false);
  assert.equal(visible.some((item) => item.entity === "rules"), false);
  assert.equal(canAccessStudent(access, "STU-THEA"), false);
});

test("teachers receive only their own assigned and booked students", () => {
  const access = buildOpsAccessContext(rows, "Helen Ceperkovic", false);
  const visible = filterOpsStateRows(rows, access);

  assert.deepEqual((visible.find((item) => item.entity === "students")?.payload as Array<{ id: string }>).map((item) => item.id), ["STU-ABBY"]);
  assert.deepEqual((visible.find((item) => item.entity === "bookings")?.payload as Array<{ id: string }>).map((item) => item.id), ["BOOK-ABBY"]);
  assert.deepEqual((visible.find((item) => item.entity === "teachers")?.payload as Array<{ id: string }>).map((item) => item.id), ["TEA-HELEN"]);
  assert.throws(() => mergeScopedPayload({
    entity: "files",
    currentPayload: row("files").payload,
    submittedPayload: [{ id: "FILE-NEW", studentId: "STU-ABBY", title: "Teacher upload" }],
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
