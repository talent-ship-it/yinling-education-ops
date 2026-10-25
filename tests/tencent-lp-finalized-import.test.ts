import assert from "node:assert/strict";
import test from "node:test";

import { planTencentLpSourceChanges, TENCENT_LP_SOURCE_HEADERS, type TencentLpSourceCell } from "../lib/tencent-lp-source";

const header: TencentLpSourceCell[] = TENCENT_LP_SOURCE_HEADERS.map((title, col) => ({ row: 0, col, value_type: "STRING", string_value: title }));
const student = { id: "S-IMPORT", name: "Synthetic Wang", guardianWechat: "Synthetic Parent" };
const originalRequest = "2026-10-25T16:01:00.000Z";
function plan(finalized: boolean, stored?: boolean, resultStatus?: string) {
  const values = [student.name, student.guardianWechat, "English", "试听", "10月26日0:01"];
  const cells: TencentLpSourceCell[] = values.map((value, col) => ({ row: 1, col, value_type: "STRING", string_value: value }));
  if (resultStatus) cells.push({ row: 1, col: 14, value_type: "STRING", string_value: resultStatus });
  return planTencentLpSourceChanges({
    cells: [...header, ...cells, { row: 1, col: 10, value_type: "BOOL", bool_value: finalized }],
    students: [student], lpItems: [{ id: "LP-IMPORT", studentId: student.id, workflowType: "试听 LP",
      trialIntake: { requestSentAt: originalRequest, studentName: student.name }, trialLpFinalized: stored }],
  });
}

test("Tencent LP checkbox changes use the dedicated atomic field with original request identity", () => {
  assert.deepEqual(plan(true).changes.map(({ lpItemId, field, expectedValue, value }) => ({ lpItemId, field, expectedValue, value })),
    [{ lpItemId: "LP-IMPORT", field: "lpFinalized", expectedValue: null, value: true }]);
  assert.deepEqual(plan(false, true).changes.map(({ field, expectedValue, value }) => ({ field, expectedValue, value })),
    [{ field: "lpFinalized", expectedValue: true, value: false }]);
});
test("unchanged Tencent finalized state is idempotent and does not reschedule or reset the request", () => {
  assert.equal(plan(true, true).changes.length, 0);
  assert.equal(plan(false, false).changes.length, 0);
  assert.equal(plan(true).changes.some((change) => change.field === "requestedAt" || change.field === "scheduledAt"), false);
});


test("Tencent delayed arrangement remains distinct when imported", () => {
  assert.equal(plan(true, undefined, "延迟待安排").changes.find((change) => change.field === "resultStatus")?.value, "延迟待安排");
});
