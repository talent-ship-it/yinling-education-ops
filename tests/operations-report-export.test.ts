import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOperationsReportExport,
  operationsReportFilename,
} from "../lib/operations-report-export";

const GENERATED_AT = "2026-08-24T03:04:05.000Z";

test("owner-filtered report export contains only the small report projection", () => {
  const report = buildOperationsReportExport({
    ownerFilter: "Abby",
    generatedAt: GENERATED_AT,
    tasks: [
      { id: "TASK-ABBY-DONE", owner: "Abby", status: "done" },
      { id: "TASK-ABBY-WAITING", owner: "Abby", status: "waiting" },
      { id: "TASK-TIFFANY", owner: "Tiffany", status: "waiting" },
    ],
    students: [
      { id: "STU-ABBY", owner: "Abby", segment: "试听", files: 3 },
      { id: "STU-TIFFANY", owner: "Tiffany", segment: "已报名", files: 1 },
    ],
    teachers: [
      { id: "TEA-1", acceptsStudents: true },
      { id: "TEA-2", acceptsStudents: false },
    ],
    bookings: [
      { status: "待确认" },
      { status: "已确认" },
    ],
    filesIndexed: true,
  });

  assert.equal(report.meta.report, "operations");
  assert.equal(report.meta.ownerFilter, "Abby");
  assert.deepEqual(report.scope, { ownerFilter: "Abby", taskCount: 2, studentCount: 1 });
  assert.deepEqual(report.metrics.tasks, { total: 2, completed: 1, pending: 1 });
  assert.deepEqual(report.metrics.students, { total: 1, trials: 1 });
  assert.deepEqual(report.metrics.teachers, { active: 1, total: 2 });
  assert.deepEqual(report.metrics.files, { indexed: true, missing: 1 });
  assert.deepEqual(report.metrics.bookings, { awaitingConfirmation: 1 });
  assert.deepEqual(report.breakdowns.pendingTasksByOwner, { Abby: 1 });
  assert.deepEqual(report.records.tasks, [
    { id: "TASK-ABBY-DONE", owner: "Abby", status: "done" },
    { id: "TASK-ABBY-WAITING", owner: "Abby", status: "waiting" },
  ]);
  assert.deepEqual(report.records.students, [
    { id: "STU-ABBY", owner: "Abby", segment: "试听", files: 3 },
  ]);

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("TASK-TIFFANY"), false);
  assert.equal(serialized.includes("STU-TIFFANY"), false);
  assert.equal(serialized.includes("payroll"), false);
  assert.equal(serialized.includes("secret"), false);
});

test("empty owner scopes export zero indicators instead of placeholders", () => {
  const report = buildOperationsReportExport({
    ownerFilter: "No owner",
    generatedAt: GENERATED_AT,
    tasks: [{ id: "TASK-1", owner: "Abby", status: "waiting" }],
    students: [{ id: "STU-1", owner: "Abby", segment: "试听", files: 1 }],
    teachers: [],
    bookings: [],
    filesIndexed: false,
  });

  assert.deepEqual(report.metrics, {
    tasks: { total: 0, completed: 0, pending: 0 },
    students: { total: 0, trials: 0 },
    teachers: { active: 0, total: 0 },
    files: { indexed: false, missing: 0 },
    bookings: { awaitingConfirmation: 0 },
  });
  assert.deepEqual(report.breakdowns.pendingTasksByOwner, { "No owner": 0 });
  assert.deepEqual(report.records, { tasks: [], students: [] });
});

test("report filenames identify the report and owner scope without reusing the snapshot name", () => {
  assert.equal(
    operationsReportFilename("all", GENERATED_AT),
    "yinling-education-ops-report-all-owners-2026-08-24.json",
  );
  assert.equal(
    operationsReportFilename("Abby", GENERATED_AT),
    "yinling-education-ops-report-owner-abby-2026-08-24.json",
  );
  assert.equal(operationsReportFilename("Abby", GENERATED_AT).includes("ops-data"), false);
});


test("report exports reconcile canonical staff filters with aliases and retain historical scopes", () => {
  const input = {
    generatedAt: GENERATED_AT,
    tasks: [
      { id: "TASK-1", owner: "Ella", status: "waiting" },
      { id: "TASK-2", owner: "ELLA 教务", status: "waiting" },
      { id: "TASK-3", owner: "Historical Owner", status: "waiting" },
    ],
    students: [
      { id: "STU-1", owner: " ＥＬＬＡ 教务 ", segment: "试听", files: 1 },
      { id: "STU-2", owner: "Historical Owner", segment: "试听", files: 1 },
    ],
    teachers: [], bookings: [], filesIndexed: true,
  };
  for (const ownerFilter of ["Ella", "ELLA 教务"]) {
    const report = buildOperationsReportExport({ ...input, ownerFilter });
    assert.deepEqual(report.scope, { ownerFilter: "Ella", taskCount: 2, studentCount: 1 });
    assert.deepEqual(report.breakdowns.pendingTasksByOwner, { Ella: 2 });
    assert.equal(report.records.students[0].owner, " ＥＬＬＡ 教务 ");
  }
  assert.deepEqual(buildOperationsReportExport({ ...input, ownerFilter: "all" }).breakdowns.pendingTasksByOwner, { Ella: 2, "Historical Owner": 1 });
  assert.deepEqual(buildOperationsReportExport({ ...input, ownerFilter: "Historical Owner" }).scope, { ownerFilter: "Historical Owner", taskCount: 1, studentCount: 1 });
});
