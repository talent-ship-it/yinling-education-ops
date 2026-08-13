import assert from "node:assert/strict";
import test from "node:test";

import {
  MASTER_STUDENT_STATUSES,
  StudentImportError,
  buildStudentImportPlan,
  lessonPackageIdForSource,
  isMasterStudentStatus,
  normalizeStudentImportName,
  parseMasterStudentStatus,
  type ExistingStudentImportRecord,
  type JwbStudentImportRow,
  type MasterStudentImportRow,
} from "../lib/student-import.ts";

const master = (
  sourceRow: number,
  name: string,
  status: string = "在读",
  attributes?: Record<string, unknown>,
): MasterStudentImportRow => ({ sourceRow, name, status, attributes });

const jwb = (
  sourceRow: number,
  name: string,
  remainingHours: number,
  contractHours: number,
): JwbStudentImportRow => ({ sourceRow, name, remainingHours, contractHours });

test("accepts exactly the six master statuses and rejects every other value", () => {
  assert.deepEqual(MASTER_STUDENT_STATUSES, [
    "在读",
    "不活跃 + 无课时",
    "活跃 + 无课时",
    "活跃 + 有课时",
    "不活跃 + 有课时",
    "在读 + 加课待排",
  ]);
  for (const status of MASTER_STUDENT_STATUSES) {
    assert.equal(isMasterStudentStatus(status), true);
    assert.equal(parseMasterStudentStatus(status), status);
  }
  for (const status of ["不活跃", "待确认", "在读+加课待排", "", null]) {
    assert.equal(isMasterStudentStatus(status), false);
    assert.throws(() => parseMasterStudentStatus(status), (error: unknown) =>
      error instanceof StudentImportError && error.code === "invalid_status");
  }
  assert.throws(() => buildStudentImportPlan({
    masterRows: [master(1, "Sample Learner", "停课")],
    jwbRows: [],
  }), /Unsupported master student status/);
});

test("excludes inactive students without hours even if JWB contains a balance", () => {
  const plan = buildStudentImportPlan({
    masterRows: [
      master(1, "Excluded Learner", "不活跃 + 无课时"),
      master(2, "Included Learner", "不活跃 + 有课时"),
    ],
    jwbRows: [
      jwb(101, "Excluded Learner", 9, 12),
      jwb(102, "Included Learner", 4, 12),
    ],
  });

  assert.deepEqual(plan.students.map((student) => student.name), ["Included Learner"]);
  assert.deepEqual(plan.excluded, [{
    sourceRow: 1,
    name: "Excluded Learner",
    status: "不活跃 + 无课时",
    reason: "inactive_without_hours",
  }]);
  assert.equal(plan.summary.excluded, 1);
  assert.equal(plan.summary.unmatched, 0);
  assert.equal(plan.students[0].remainingHours, 4);
});

test("normalises names conservatively, merges JWB balances and preserves manual trials", () => {
  const manualTrial: ExistingStudentImportRecord = {
    id: "STU-TRIAL-1",
    name: "Pending Trial",
    status: "待排课",
    segment: "试听",
    notes: "Created manually",
  };
  const plan = buildStudentImportPlan({
    masterRows: [master(20, "Ａvery   Example", "活跃 + 有课时", { owner: "Ops A" })],
    jwbRows: [{
      sourceRow: 220,
      name: "avery example",
      remainingHours: "5.5",
      contractHours: 10,
      contractEffectiveDate: "2026-08-01",
    }],
    existingStudents: [manualTrial],
  });

  assert.equal(normalizeStudentImportName("  Ａvery   Example  "), "avery example");
  assert.equal(plan.summary.insert, 1);
  assert.equal(plan.summary.preservedManualTrials, 1);
  assert.equal(plan.students.length, 2);
  assert.deepEqual(plan.students[0], {
    owner: "Ops A",
    id: plan.students[0].id,
    name: "Avery Example",
    status: "活跃 + 有课时",
    sourceRow: 20,
    masterSourceKey: "20",
    importSource: "master",
    jwbMatchStatus: "matched",
    jwbSourceRow: 220,
    remainingHours: 5.5,
    contractHours: 10,
    contractEffectiveDate: "2026-08-01",
  });
  assert.deepEqual(plan.students[1], manualTrial);
});

test("is deterministic and produces no write actions when the same import is rerun", () => {
  const input = {
    masterRows: [master(8, "Repeatable Learner", "在读")],
    jwbRows: [jwb(88, "Repeatable Learner", 3, 8)],
  };
  const first = buildStudentImportPlan(input);
  const second = buildStudentImportPlan({ ...input, existingStudents: first.students });

  assert.equal(first.summary.insert, 1);
  assert.equal(second.summary.insert, 0);
  assert.equal(second.summary.update, 0);
  assert.equal(second.summary.unchanged, 1);
  assert.deepEqual(second.students, first.students);
});

test("imports authoritative package rows with stable IDs and preserves exact balances", () => {
  const packageRows = [{
    sourcePackageId: "contract-english-1",
    name: "English 20 hours",
    subjectIds: ["English"],
    purchaseRecords: [{
      sourcePurchaseId: "invoice-001",
      purchasedAt: "2026-07-01",
      hours: "20",
      note: "Initial purchase",
    }],
    consumedHours: "7.5",
  }];
  const source = {
    masterRows: [master(8, "Package Learner", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 88,
      name: "Package Learner",
      remainingHours: 12.5,
      contractHours: 20,
      lessonPackages: packageRows,
    }],
  };
  const first = buildStudentImportPlan(source);
  const second = buildStudentImportPlan({ ...source, existingStudents: first.students });
  const student = first.students[0];

  assert.equal(student.lessonPackages?.length, 1);
  assert.equal(student.lessonPackages?.[0].id, lessonPackageIdForSource(student.id, "contract-english-1"));
  assert.match(student.lessonPackages?.[0].purchaseRecords[0].id ?? "", /^BUY-JWB-/);
  assert.equal(student.lessonPackages?.[0].purchaseRecords[0].purchasedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(student.remainingHours, 12.5);
  assert.equal(student.contractHours, 20);
  assert.equal(first.summary.importedPackages, 1);
  assert.equal(first.summary.studentsMissingPackageData, 0);
  assert.deepEqual(second.students, first.students);
  assert.equal(second.summary.unchanged, 1);
});

test("aggregate balances never invent a package and existing packages survive aggregate-only refreshes", () => {
  const aggregateOnly = buildStudentImportPlan({
    masterRows: [master(81, "Aggregate Learner", "活跃 + 有课时")],
    jwbRows: [jwb(881, "Aggregate Learner", 10, 20)],
  });
  assert.equal(aggregateOnly.students[0].lessonPackages, undefined);
  assert.equal(aggregateOnly.summary.importedPackages, 0);
  assert.equal(aggregateOnly.summary.studentsMissingPackageData, 1);

  const withPackage = buildStudentImportPlan({
    masterRows: [master(81, "Aggregate Learner", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 881,
      name: "Aggregate Learner",
      remainingHours: 10,
      contractHours: 20,
      lessonPackages: [{
        sourcePackageId: "package-81",
        name: "Math package",
        subjectIds: ["Math"],
        purchaseRecords: [{ sourcePurchaseId: "purchase-81", purchasedAt: "2026-01-01", hours: 20 }],
        consumedHours: 10,
      }],
    }],
  });
  const refreshed = buildStudentImportPlan({
    masterRows: [master(81, "Aggregate Learner", "活跃 + 有课时")],
    jwbRows: [jwb(881, "Aggregate Learner", 10, 20)],
    existingStudents: withPackage.students,
  });
  assert.deepEqual(refreshed.students[0].lessonPackages, withPackage.students[0].lessonPackages);
});

test("rejects duplicate package identities and aggregate/package balance mismatches", () => {
  const duplicatePackage = {
    sourcePackageId: "same-package",
    name: "Math package",
    subjectIds: ["Math"],
    purchaseRecords: [{ sourcePurchaseId: "purchase-1", purchasedAt: "2026-01-01", hours: 10 }],
    consumedHours: 0,
  };
  assert.throws(() => buildStudentImportPlan({
    masterRows: [master(82, "Invalid Package Learner")],
    jwbRows: [{
      sourceRow: 882,
      name: "Invalid Package Learner",
      lessonPackages: [duplicatePackage, { ...duplicatePackage, name: "Duplicate" }],
    }],
  }), (error: unknown) => error instanceof StudentImportError
    && error.code === "duplicate_package_source_key");

  assert.throws(() => buildStudentImportPlan({
    masterRows: [master(83, "Mismatched Balance Learner")],
    jwbRows: [{
      sourceRow: 883,
      name: "Mismatched Balance Learner",
      remainingHours: 9,
      contractHours: 10,
      lessonPackages: [{
        sourcePackageId: "package-83",
        name: "Science package",
        subjectIds: ["Science"],
        purchaseRecords: [{ sourcePurchaseId: "purchase-83", purchasedAt: "2026-01-01", hours: 10 }],
        consumedHours: 0,
      }],
    }],
  }), (error: unknown) => error instanceof StudentImportError
    && error.code === "package_balance_mismatch");
});

test("uses the stable master source row for a rename and excludes an empty master name", () => {
  const existing: ExistingStudentImportRecord = {
    id: "STU-KEEP-ID",
    name: "Previous Display Name",
    status: "在读",
    sourceRow: 31,
    masterSourceKey: "31",
    importSource: "master",
    jwbMatchStatus: "matched",
    jwbSourceRow: 310,
    remainingHours: 6,
    contractHours: 10,
  };
  const plan = buildStudentImportPlan({
    masterRows: [master(31, "Updated Display Name"), master(32, "   ", "在读")],
    jwbRows: [jwb(311, "Updated Display Name", 7, 10)],
    existingStudents: [existing],
  });

  assert.equal(plan.summary.update, 1);
  assert.equal(plan.summary.excluded, 1);
  assert.equal(plan.students[0].id, "STU-KEEP-ID");
  assert.equal(plan.students[0].name, "Updated Display Name");
  assert.equal(plan.students[0].remainingHours, 7);
  assert.equal(plan.excluded[0].reason, "empty_name");
});

test("never guesses when either master or JWB contains duplicate normalised names", () => {
  const legacyExisting: ExistingStudentImportRecord = {
    id: "STU-LEGACY",
    name: "Same Name",
    status: "在读",
  };
  const duplicateMaster = buildStudentImportPlan({
    masterRows: [
      master(41, "Same Name", "在读"),
      master(42, " same   name ", "活跃 + 有课时"),
    ],
    jwbRows: [jwb(410, "SAME NAME", 9, 12)],
    existingStudents: [legacyExisting],
  });
  assert.equal(duplicateMaster.summary.ambiguous, 1);
  assert.equal(duplicateMaster.summary.update, 0);
  assert.equal(duplicateMaster.summary.insert, 2);
  assert.equal(duplicateMaster.students.length, 2);
  assert.ok(duplicateMaster.students.every((student) => student.jwbMatchStatus === "ambiguous"));
  assert.ok(duplicateMaster.students.every((student) => student.remainingHours === undefined));

  const duplicateJwb = buildStudentImportPlan({
    masterRows: [master(51, "Another Name", "在读")],
    jwbRows: [
      jwb(510, "Another Name", 2, 8),
      jwb(511, " another name ", 7, 10),
    ],
  });
  assert.equal(duplicateJwb.summary.ambiguous, 1);
  assert.equal(duplicateJwb.students[0].jwbMatchStatus, "ambiguous");
  assert.equal(duplicateJwb.students[0].remainingHours, undefined);
});
