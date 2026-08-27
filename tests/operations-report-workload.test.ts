import assert from "node:assert/strict";
import test from "node:test";

import {
  operationsReportOwnerOptions,
  pendingOperationsTaskWorkload,
} from "../lib/operations-report-workload";

const tasks = (owner: string, count: number, status = "today") => (
  Array.from({ length: count }, () => ({ owner, status }))
);

test("pending workload omits zero-count owners and scales against the largest count", () => {
  const workload = pendingOperationsTaskWorkload([
    ...tasks("One", 1),
    ...tasks("Five", 5),
    ...tasks("Six", 6),
    ...tasks("Zero", 3, "done"),
  ]);

  assert.deepEqual(workload, [
    { owner: "Five", count: 5, widthPercent: 83.33 },
    { owner: "One", count: 1, widthPercent: 16.67 },
    { owner: "Six", count: 6, widthPercent: 100 },
  ]);
});

test("pending workload is empty when no pending tasks exist", () => {
  assert.deepEqual(pendingOperationsTaskWorkload(tasks("Abby", 1, "done")), []);
});

test("report owner options include owners introduced by generated teacher tasks", () => {
  assert.deepEqual(
    operationsReportOwnerOptions(["Abby", "Tiffany"], [
      { owner: "Teacher Handover" },
      { owner: "Abby" },
    ]),
    ["Abby", "Teacher Handover", "Tiffany"],
  );
});
