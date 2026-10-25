import assert from "node:assert/strict";
import test from "node:test";
import { buildOpsAccessContext, canAccessStudent, filterOpsStateRows, managedTrialPaymentStudentProjections } from "../lib/ops-access";
import type { OpsStateRow } from "../lib/ops-store";
import { authorizeTrialPaymentTaskLifecycle, parseTrialPaymentLifecycleCommand, TrialPaymentTaskServiceError } from "../lib/trial-payment-task-service";

type Value = Record<string, unknown>;
const versions = { bookings: 1, students: 1, lpItems: 1, tasks: 1, teachers: 1 };
function command(action: "complete" | "reopen" = "complete") {
  return parseTrialPaymentLifecycleCommand({ action, commandKey: `trial-payment-${action}:123e4567-e89b-42d3-a456-426614174000`, taskId: "TASK-OVERRIDE", expectedVersions: versions });
}
function fixture(): OpsStateRow[] {
  const entities: Record<string, Value[]> = {
    students: [{ id: "STU-OVERRIDE", name: "Synthetic Child", owner: "Ella", planner: "Tara", guardianWechat: "private-parent" }],
    lpItems: [{ id: "LP-OVERRIDE", studentId: "STU-OVERRIDE", workflowType: "试听 LP", stage: "待资料", trialIntake: { planner: "Tara" }, trialLedgerOverrides: { planner: "Eileen" },
      trialSchedule: { source: "jiaowubao-open-api", sourceRevision: `sha256:${"a".repeat(64)}`, eventId: "event-override" }, fields: { trialPaymentMethod: "后置付费试听" } }],
    tasks: [{ id: "TASK-OVERRIDE", studentId: "STU-OVERRIDE", category: "试听", ruleKey: "trial.jiaowubao.payment-n2", anchorBookingId: "JWB:event-override", requestAnchorBookingId: "LP-OVERRIDE", owner: "Eileen", assignees: ["Eileen"], watchers: ["Ops Admin"], status: "today" }],
    bookings: [], teachers: [], files: [{ id: "FILE-PRIVATE", studentId: "STU-OVERRIDE" }],
  };
  return Object.entries(entities).map(([entity, payload]) => ({ entity, payload, version: 1, updated_at: "2026-10-20T00:00:00.000Z", updated_by: "fixture" }));
}
function change(rows: OpsStateRow[], entity: string, update: (value: Value) => Value) {
  return rows.map((row) => row.entity === entity ? { ...row, payload: (row.payload as Value[]).map(update) } : row);
}
function visibleTasks(rows: OpsStateRow[], actor: string) {
  return filterOpsStateRows(rows, buildOpsAccessContext(rows, actor, false, "staff")).find((row) => row.entity === "tasks")?.payload;
}
function denied(rows: OpsStateRow[], actor = "Eileen", action: "complete" | "reopen" = "complete") {
  assert.throws(() => authorizeTrialPaymentTaskLifecycle({ rows, actor, role: "staff", command: command(action) }),
    (error: unknown) => error instanceof TrialPaymentTaskServiceError && error.code === "task_forbidden");
}

test("a canonical ledger planner override grants only the addressed payment task and revokes the original planner", () => {
  const rows = fixture();
  const context = buildOpsAccessContext(rows, "Eileen", false, "staff");
  assert.equal(canAccessStudent(context, "STU-OVERRIDE"), false);
  const visible = filterOpsStateRows(rows, context);
  assert.deepEqual(visible.find((row) => row.entity === "tasks")?.payload, rows.find((row) => row.entity === "tasks")?.payload);
  for (const entity of ["students", "lpItems", "files"]) assert.deepEqual(visible.find((row) => row.entity === entity)?.payload, []);
  assert.deepEqual(managedTrialPaymentStudentProjections(rows, context), [{ id: "STU-OVERRIDE", name: "Synthetic Child", initials: "" }]);
  assert.equal(authorizeTrialPaymentTaskLifecycle({ command: command(), rows, actor: "Eileen", role: "staff" }).kind, "jiaowubao");
  assert.deepEqual(visibleTasks(rows, "Tara"), []);
  denied(rows, "Tara");
  const staleTask = change(rows, "tasks", (task) => ({ ...task, owner: "Tara", assignees: ["Tara"] }));
  assert.deepEqual(visibleTasks(staleTask, "Tara"), []);
  denied(staleTask, "Tara");
});

test("the replacement planner alone may reopen the exact explicit payment confirmation", () => {
  const rows = change(fixture(), "tasks", (task) => ({ ...task, status: "done", tone: "green", result: "已由规划老师确认试听付款", closedAt: "2026-10-20T00:00:00.000Z" }));
  assert.equal((visibleTasks(rows, "Eileen") as Value[]).length, 1);
  assert.equal(authorizeTrialPaymentTaskLifecycle({ command: command("reopen"), rows, actor: "Eileen", role: "staff" }).kind, "jiaowubao");
  denied(rows, "Tara", "reopen");
  denied(change(rows, "tasks", (task) => ({ ...task, result: "自动关闭" })), "Eileen", "reopen");
});

test("planner corrections preserve event, recipient, active-student and workflow authority checks", () => {
  const rows = fixture();
  const variants = [
    change(rows, "lpItems", (item) => ({ ...item, trialSchedule: { ...(item.trialSchedule as Value), eventId: "other-event" } })),
    change(rows, "lpItems", (item) => ({ ...item, trialSchedule: { ...(item.trialSchedule as Value), sourceRevision: "sha256:invalid" } })),
    change(rows, "lpItems", (item) => ({ ...item, stage: "完成" })),
    change(rows, "lpItems", (item) => ({ ...item, studentId: "OTHER-STUDENT" })),
    change(rows, "students", (item) => ({ ...item, importArchived: true })),
    change(rows, "tasks", (task) => ({ ...task, requestAnchorBookingId: "OTHER-LP" })),
    change(rows, "tasks", (task) => ({ ...task, assignees: ["Eileen", "Tara"] })),
    change(rows, "tasks", (task) => ({ ...task, watchers: ["Ops Admin", "Tara"] })),
  ];
  for (const variant of variants) {
    assert.deepEqual(visibleTasks(variant, "Eileen"), []);
    denied(variant);
  }
  for (const role of ["teacher", "limited-admin", "admin"] as const) {
    assert.throws(() => authorizeTrialPaymentTaskLifecycle({ rows, actor: "Eileen", role, command: command() }), TrialPaymentTaskServiceError);
  }
  const noPermission = buildOpsAccessContext(rows, "Eileen", false, { user: "Eileen", role: "staff", permissions: [], scopeMembers: [{ kind: "all", key: "*" }] });
  assert.equal(filterOpsStateRows(rows, noPermission).some((row) => row.entity === "tasks"), false);
});

test("clearing a planner correction restores the existing intake then student fallback", () => {
  const original = change(fixture(), "tasks", (task) => ({ ...task, owner: "Tara", assignees: ["Tara"] }));
  for (const withoutIntake of [false, true]) {
    const rows = change(original, "lpItems", (item) => ({ ...item, trialLedgerOverrides: {}, trialIntake: withoutIntake ? {} : item.trialIntake }));
    assert.equal((visibleTasks(rows, "Tara") as Value[]).length, 1);
    assert.equal(authorizeTrialPaymentTaskLifecycle({ command: command(), rows, actor: "Tara", role: "staff" }).kind, "jiaowubao");
    assert.deepEqual(visibleTasks(rows, "Eileen"), []);
    denied(rows);
  }
});

test("an LP planner correction does not reassign booking-based payment authority", () => {
  let rows = fixture();
  rows = rows.map((row) => row.entity === "bookings" ? { ...row, payload: [{ id: "BOOK-OVERRIDE", studentId: "STU-OVERRIDE", kind: "试听" }] } : row);
  rows = change(rows, "tasks", (task) => ({ ...task, ruleKey: "trial.payment-urgent", anchorBookingId: "BOOK-OVERRIDE", owner: "Tara", assignees: ["Tara"] }));
  assert.equal(authorizeTrialPaymentTaskLifecycle({ command: command(), rows, actor: "Tara", role: "staff" }).kind, "booking");
  assert.equal((visibleTasks(rows, "Tara") as Value[]).length, 1);
  assert.deepEqual(visibleTasks(rows, "Eileen"), []);
  denied(rows);
});
