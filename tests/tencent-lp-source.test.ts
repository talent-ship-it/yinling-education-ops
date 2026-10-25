import assert from "node:assert/strict";
import test from "node:test";

import { planTencentLpSourceChanges, TENCENT_LP_SOURCE_HEADERS, type TencentLpSourceCell } from "../lib/tencent-lp-source";

const header = TENCENT_LP_SOURCE_HEADERS.map((title, col) => ({ row: 0, col, string_value: title, value_type: "STRING" }));
const student = { id: "ST-1", name: "Alex王小明", guardianWechat: "Parent Synthetic" };
const lp = { id: "LP-1", studentId: student.id, workflowType: "试听 LP", trialIntake: {
  requestSentAt: "2026-10-22T09:47:00.000Z", planner: "Tara", studentName: student.name,
} };
function row(values: Record<number, string | boolean>, rowIndex = 1): TencentLpSourceCell[] {
  return Object.entries({ 0: student.name, 1: student.guardianWechat, 3: "试听", 4: "10月22日17:47", ...values })
    .map(([col, value]) => ({ row: rowIndex, col: Number(col), value_type: typeof value === "boolean" ? "BOOL" : "STRING",
      ...(typeof value === "boolean" ? { bool_value: value } : { string_value: value }) }));
}
function plan(cells: TencentLpSourceCell[], lpItems: unknown[] = [lp]) {
  return planTencentLpSourceChanges({ cells: [...header, ...cells], lpItems, students: [student] });
}

test("Beijing partial timestamps match the original request without resetting it", () => {
  const result = plan(row({ 9: "Eileen校长号", 14: "试听成功", 15: false, 16: "Synthetic note" }));
  assert.equal(result.matchedCount, 1);
  assert.equal(result.changes.find((change) => change.field === "planner")?.value, "Eileen");
  assert.equal(result.changes.find((change) => change.field === "resultStatus")?.value, "试听成功");
  assert.equal(result.changes.find((change) => change.field === "trialPaid")?.value, false);
  assert.ok(result.changes.every((change) => change.field !== "requestedAt"));
  assert.equal(lp.trialIntake.requestSentAt, "2026-10-22T09:47:00.000Z");
});
test("Tencent takes precedence over local corrections and explicit false is retained", () => {
  const result = plan(row({ 9: "Eileen", 15: false }), [{ ...lp, trialPaid: true, trialLedgerOverrides: { planner: "Abby" } }]);
  assert.deepEqual(result.changes.map(({ field, expectedValue, value }) => ({ field, expectedValue, value })), [
    { field: "planner", expectedValue: "Abby", value: "Eileen" }, { field: "trialPaid", expectedValue: true, value: false },
  ]);
});
test("same-name multiple requests require the precise original request time", () => {
  const second = { ...lp, id: "LP-2", trialIntake: { ...lp.trialIntake, requestSentAt: "2026-10-23T09:47:00Z" } };
  const result = plan(row({ 9: "Abby" }), [lp, second]);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.changes[0]?.lpItemId, "LP-1");
});
test("multiple matching operational records and duplicate source rows are held", () => {
  const duplicateLp = plan(row({ 9: "Abby" }), [lp, { ...lp, id: "LP-2" }]);
  assert.equal(duplicateLp.ambiguousCount, 1); assert.equal(duplicateLp.changes.length, 0);
  const duplicateSource = plan([...row({ 9: "Abby" }), ...row({ 9: "Tara" }, 2)]);
  assert.equal(duplicateSource.ambiguousCount, 2); assert.equal(duplicateSource.changes.length, 0);
});
test("same parent with another child never supplies an identity match", () => {
  const result = plan(row({ 0: "Alex王小红", 9: "Abby" }));
  assert.equal(result.unmatchedCount, 1); assert.equal(result.changes.length, 0);
});
test("blank fields do not erase system values and unsupported LP types are excluded", () => {
  assert.equal(plan(row({ 9: "", 14: "", 15: "", 16: "" })).changes.length, 0);
  assert.equal(plan(row({ 3: "老生LP修改", 9: "Abby" })).matchedCount, 0);
});
test("missing year is resolved against each candidate, never against the current year", () => {
  const historical = { ...lp, id: "LP-OLD", trialIntake: { ...lp.trialIntake, requestSentAt: "2025-10-22T09:47:00Z" } };
  assert.equal(plan(row({ 9: "Abby" }), [historical]).changes[0]?.lpItemId, "LP-OLD");
  assert.equal(plan(row({ 9: "Abby" }), [lp, historical]).ambiguousCount, 1);
});
test("full dated requests and midnight China boundaries are handled exactly", () => {
  const midnight = { ...lp, trialIntake: { ...lp.trialIntake, requestSentAt: "2025-12-31T16:01:00Z" } };
  assert.equal(plan(row({ 4: "2026/1/1 0:01", 9: "Abby" }), [midnight]).matchedCount, 1);
  assert.equal(plan(row({ 4: "2026-01-01T00:01:00+08:00", 9: "Abby" }), [midnight]).matchedCount, 1);
  assert.equal(plan(row({ 4: "1月1日0:01", 9: "Abby" }), [midnight]).matchedCount, 1);
});
test("unknown result labels do not manufacture a trial result", () => {
  const result = plan(row({ 14: "未知业务结果" }));
  assert.equal(result.invalidFieldCount, 1); assert.equal(result.changes.length, 0);
});
test("header drift and duplicate coordinates fail closed before any writes", () => {
  assert.throws(() => planTencentLpSourceChanges({ cells: [], lpItems: [], students: [] }), /headers_changed/u);
  assert.throws(() => plan([...row({ 9: "Abby" }), { row: 1, col: 9, value_type: "STRING", string_value: "Tara" }]), /duplicate_cell/u);
});

test("source cancellation display labels retain the existing canonical result", () => {
  assert.equal(plan(row({ 14: "取消不安排" })).changes[0]?.value, "被家长取消");
});
