import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientPath = new URL("../app/operations-client.tsx", import.meta.url);

test("payroll rows use occurrence-safe display keys and source-indexed mutations", async () => {
  const source = await readFile(clientPath, "utf8");

  assert.match(source, /type PayrollDisplayRow = PayrollRow & \{[\s\S]*viewKey: string;[\s\S]*sourceIndex: number \| null;/);
  assert.match(source, /payrollDisplayKey\("persisted", row\.id, ordinal\)/);
  assert.match(source, /key=\{row\.viewKey\}/);
  assert.match(source, /setSelectedPayrollKey\(row\.viewKey\)/);
  assert.match(source, /setPayrollDraftSourceIndex\(selectedPayroll\.sourceIndex\)/);
  assert.match(source, /const draftSourceIndex = payrollDraftSourceIndex;/);
  assert.match(source, /index === targetIndex \? updated : row/);
  assert.doesNotMatch(source, /selectedPayrollId|setSelectedPayrollId/);
});
