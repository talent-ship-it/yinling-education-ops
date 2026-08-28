import assert from "node:assert/strict";
import test from "node:test";

import {
  isManagedTrialPaymentTask,
  isManagedTrialPaymentTaskRecipient,
  managedTrialPaymentTaskKind,
  managedTrialPaymentSnapshotCanReplace,
  managedTrialPaymentSnapshotIsCurrent,
  managedTrialPaymentTaskLifecycleChange,
  parseManagedTrialPaymentCompletionReceipt,
  parseManagedTrialPaymentAuthorityVersions,
  parseManagedTrialPaymentProjectionSnapshot,
} from "../lib/managed-trial-payment";

const versions = { bookings: 2, students: 3, lpItems: 5, tasks: 4 } as const;

test("managed trial payment projections accept only minimal identity bound to authority versions", () => {
  const snapshot = parseManagedTrialPaymentProjectionSnapshot({
    versions,
    students: [{ id: "STU-1", name: "Student", initials: "ST" }],
  }, versions);
  assert.deepEqual(snapshot, {
    versions,
    students: [{ id: "STU-1", name: "Student", initials: "ST" }],
  });
  assert.equal(managedTrialPaymentSnapshotIsCurrent(snapshot, versions), true);
  assert.equal(managedTrialPaymentSnapshotIsCurrent(snapshot, { ...versions, tasks: 5 }), false);
  assert.equal(managedTrialPaymentSnapshotCanReplace(snapshot, { ...versions, tasks: 3 }), true);
  assert.equal(managedTrialPaymentSnapshotCanReplace(snapshot, { ...versions, tasks: 5 }), false);

  for (const invalid of [
    { versions, students: [{ id: "STU-1", name: "Student", initials: "ST", owner: "Abby" }] },
    { versions, students: [{ id: "STU-1", name: "Student", initials: "ST" }, { id: "STU-1", name: "Again", initials: "AG" }] },
    { versions: { ...versions, tasks: 5 }, students: [] },
    { versions: { ...versions, extra: 1 }, students: [] },
  ]) {
    assert.throws(() => parseManagedTrialPaymentProjectionSnapshot(invalid, versions), TypeError);
  }
});

test("completion response requires either matched authoritative rows or a PII-free receipt", () => {
  const task = {
    id: "TASK-1",
    category: "试听",
    ruleKey: "trial.payment-urgent",
    anchorBookingId: "BOOK-1",
    owner: "Tara",
    assignees: ["Tara"],
    watchers: ["Ops Admin"],
    status: "done",
    tone: "green",
    result: "已由规划老师确认试听付款",
    closedAt: "2026-08-21T00:00:00.000Z",
  };
  const full = parseManagedTrialPaymentCompletionReceipt({
    committed: true,
    applied: true,
    receiptOnly: false,
    taskId: "TASK-1",
    taskRow: { entity: "tasks", payload: [task], version: 7, updated_at: "now", updated_by: "Tara" },
    managedTrialPaymentSnapshot: {
      versions: { bookings: 2, students: 3, lpItems: 5, tasks: 7 },
      students: [{ id: "STU-1", name: "Student", initials: "ST" }],
    },
    auditEntryId: "11111111-1111-4111-8111-111111111111",
  }, "TASK-1", "Tara");
  assert.equal(full.receiptOnly, false);
  assert.equal(full.taskRow?.version, 7);

  const adminFull = parseManagedTrialPaymentCompletionReceipt({
    ...full,
    taskRow: {
      ...full.taskRow,
      payload: [{ ...task, result: "已由管理员确认试听付款" }],
      updated_by: "Nixon",
    },
  }, "TASK-1", "Nixon", "admin");
  assert.equal(adminFull.receiptOnly, false);

  const receiptOnly = parseManagedTrialPaymentCompletionReceipt({
    committed: true,
    applied: false,
    receiptOnly: true,
    taskId: "TASK-1",
    taskRow: null,
    managedTrialPaymentSnapshot: null,
    auditEntryId: "11111111-1111-4111-8111-111111111111",
  }, "TASK-1", "Tara");
  assert.equal(receiptOnly.taskRow, null);

  assert.throws(() => parseManagedTrialPaymentCompletionReceipt({
    ...receiptOnly,
    taskRow: { entity: "tasks", payload: [], version: 7, updated_at: "now", updated_by: "Tara" },
  }, "TASK-1", "Tara"), /exposed state/);
  assert.throws(() => parseManagedTrialPaymentCompletionReceipt({
    ...full,
    taskRow: { ...full.taskRow, payload: [{ ...task, owner: "Abby" }] },
  }, "TASK-1", "Tara"), /task evidence/);
  assert.throws(() => parseManagedTrialPaymentCompletionReceipt({
    ...full,
    taskRow: { ...full.taskRow, updated_by: "Nixon" },
  }, "TASK-1", "Tara"), /task evidence/);
  assert.throws(() => parseManagedTrialPaymentCompletionReceipt({
    ...full,
    taskRow: {
      ...full.taskRow,
      payload: [{ ...task, result: "已由规划老师确认试听付款" }],
      updated_by: "Nixon",
    },
  }, "TASK-1", "Nixon", "admin"), /task evidence/);
  assert.throws(() => parseManagedTrialPaymentCompletionReceipt({
    ...full,
    managedTrialPaymentSnapshot: {
      versions: { bookings: 2, students: 3, lpItems: 5, tasks: 8 },
      students: [],
    },
  }, "TASK-1", "Tara"), /versions are inconsistent/);
});

test("payment authority versions and exact planner recipient fail closed", () => {
  assert.deepEqual(parseManagedTrialPaymentAuthorityVersions([
    { entity: "bookings", version: 2 },
    { entity: "students", version: 3 },
    { entity: "lpItems", version: 5 },
    { entity: "tasks", version: 4 },
  ]), versions);
  assert.throws(() => parseManagedTrialPaymentAuthorityVersions([
    { entity: "bookings", version: 2 },
    { entity: "students", version: 3 },
  ]), /lpItems authority row is missing or duplicated/);

  const task = {
    category: "试听",
    ruleKey: "trial.payment-urgent",
    anchorBookingId: "BOOK-1",
    owner: "Tara",
    assignees: ["Tara"],
    watchers: ["Ops Admin"],
  };
  assert.equal(isManagedTrialPaymentTaskRecipient(task, "tara"), true);
  assert.equal(isManagedTrialPaymentTaskRecipient({ ...task, owner: "Abby" }, "Tara"), false);
  assert.equal(isManagedTrialPaymentTaskRecipient({ ...task, assignees: ["Tara", "Abby"] }, "Tara"), false);
  assert.equal(isManagedTrialPaymentTaskRecipient({ ...task, watchers: ["Abby"] }, "Tara"), false);

  const jiaowubaoTask = {
    ...task,
    ruleKey: "trial.jiaowubao.payment-n2",
    anchorBookingId: "JWB:event-1",
    requestAnchorBookingId: "LP-1",
  };
  assert.equal(isManagedTrialPaymentTask(jiaowubaoTask), true);
  assert.equal(managedTrialPaymentTaskKind(jiaowubaoTask), "jiaowubao");
  assert.equal(isManagedTrialPaymentTaskRecipient(jiaowubaoTask, "tara"), true);
  assert.equal(isManagedTrialPaymentTask({ ...jiaowubaoTask, requestAnchorBookingId: "" }), false);
  assert.equal(isManagedTrialPaymentTask({ ...jiaowubaoTask, anchorBookingId: "JWB:event/1" }), false);
});

test("managed payment lifecycle permits notes and Can't Do without permitting payment confirmation", () => {
  const task = {
    id: "TASK-PAY-LIFECYCLE",
    title: "确认试听收费",
    studentId: "STU-1",
    category: "试听",
    ruleKey: "trial.payment-urgent",
    anchorBookingId: "BOOK-1",
    owner: "Tara",
    assignees: ["Tara"],
    watchers: ["Ops Admin"],
    status: "today",
    tone: "red",
    dueAt: "2026-08-28T00:00:00.000Z",
  };
  const noted = { ...task, completionNote: "家长晚些回复" };
  assert.equal(managedTrialPaymentTaskLifecycleChange(task, noted), "note");
  const cannot = {
    ...noted,
    status: "done",
    tone: "red",
    completionOutcome: "cannot_do",
    result: "无法完成：家长晚些回复",
    closedAt: "2026-08-28T01:00:00.000Z",
  };
  assert.equal(managedTrialPaymentTaskLifecycleChange(noted, cannot), "cannot_do");
  assert.equal(managedTrialPaymentTaskLifecycleChange(cannot, noted), "reopen");
  assert.equal(managedTrialPaymentTaskLifecycleChange(task, {
    ...task,
    status: "done",
    tone: "green",
    result: "已由规划老师确认试听付款",
  }), null);
  assert.equal(managedTrialPaymentTaskLifecycleChange(task, { ...noted, owner: "Abby" }), null);
  assert.equal(managedTrialPaymentTaskLifecycleChange(task, { ...task, completionNote: "x".repeat(1001) }), null);
});
