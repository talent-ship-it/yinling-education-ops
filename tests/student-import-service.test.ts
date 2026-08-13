import assert from "node:assert/strict";
import test from "node:test";

import type { OpsStateRow } from "../lib/ops-store.ts";
import {
  assertStudentImportCommit,
  hasStudentImportAdminAccess,
  parseStudentImportCommitRequest,
  parseStudentImportSourceIngestRequest,
  prepareStudentImport,
  StudentImportServiceError,
} from "../lib/student-import-service.ts";

function sourceSnapshot(input?: Readonly<{
  masterRevision?: string;
  jwbRevision?: string;
  duplicate?: boolean;
}>) {
  return {
    master: {
      sourceId: "master-list",
      revision: input?.masterRevision ?? "master-revision-a",
      rows: [
        { sourceRow: 1, name: "Sample Learner", status: "在读" },
        ...(input?.duplicate ? [{ sourceRow: 2, name: " sample learner ", status: "活跃 + 有课时" }] : []),
        { sourceRow: 3, name: "Excluded Learner", status: "不活跃 + 无课时" },
      ],
    },
    jwb: {
      sourceId: "jwb-export",
      revision: input?.jwbRevision ?? "jwb-revision-a",
      rows: [{ sourceRow: 101, name: "Sample Learner", remainingHours: 5, contractHours: 10 }],
    },
  };
}

function studentsRow(version = 7, payload: unknown[] = []): OpsStateRow {
  return {
    entity: "students",
    payload,
    version,
    updated_at: "2026-01-01T00:00:00.000Z",
    updated_by: "Fixture Admin",
  };
}

function serviceError(code: StudentImportServiceError["code"]) {
  return (error: unknown) => error instanceof StudentImportServiceError && error.code === code;
}

test("only a verified full admin or the limited admin can access formal import", () => {
  assert.equal(hasStudentImportAdminAccess("Nixon", true), true);
  assert.equal(hasStudentImportAdminAccess("Nixon", false), false);
  assert.equal(hasStudentImportAdminAccess("Ops Admin", false), true);
  assert.equal(hasStudentImportAdminAccess("Abby", false), false);
  assert.equal(hasStudentImportAdminAccess(null, false), false);
});

test("builds a deterministic server-side dry run without exposing replacement students", () => {
  const first = prepareStudentImport({ sourceSnapshot: sourceSnapshot(), studentsRow: studentsRow() });
  const second = prepareStudentImport({ sourceSnapshot: sourceSnapshot(), studentsRow: studentsRow() });

  assert.equal(first.response.planFingerprint, second.response.planFingerprint);
  assert.match(first.response.planFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.response.expectedStudentVersion, 7);
  assert.equal(first.response.canCommit, true);
  assert.equal(first.response.summary.insert, 1);
  assert.equal(first.response.summary.excluded, 1);
  assert.equal("students" in first.response, false);
  assert.deepEqual(first.response.excluded.map((entry) => entry.name), ["Excluded Learner"]);
  assert.deepEqual(first.response.unmatched, []);
  assert.deepEqual(first.response.ambiguous, []);
});

test("binds the fingerprint to both source revisions, exact plan and students version", () => {
  const base = prepareStudentImport({ sourceSnapshot: sourceSnapshot(), studentsRow: studentsRow() });
  const changedSource = prepareStudentImport({
    sourceSnapshot: sourceSnapshot({ masterRevision: "master-revision-b" }),
    studentsRow: studentsRow(),
  });
  const changedVersion = prepareStudentImport({ sourceSnapshot: sourceSnapshot(), studentsRow: studentsRow(8) });

  assert.notEqual(base.response.planFingerprint, changedSource.response.planFingerprint);
  assert.notEqual(base.response.planFingerprint, changedVersion.response.planFingerprint);
});

test("accepts only fingerprint and expected version, never client-supplied rows or plans", () => {
  const prepared = prepareStudentImport({ sourceSnapshot: sourceSnapshot(), studentsRow: studentsRow() });
  const valid = {
    planFingerprint: prepared.response.planFingerprint,
    expectedStudentVersion: prepared.response.expectedStudentVersion,
  };
  assert.deepEqual(parseStudentImportCommitRequest(valid), valid);

  for (const forbidden of ["students", "masterRows", "jwbRows", "actions", "plan"] as const) {
    assert.throws(
      () => parseStudentImportCommitRequest({ ...valid, [forbidden]: [] }),
      serviceError("client_plan_forbidden"),
    );
  }
  assert.throws(
    () => parseStudentImportCommitRequest({ ...valid, unexpected: true }),
    serviceError("invalid_commit_request"),
  );
});

test("ambiguity blocks commit by default and is still returned in the dry run", () => {
  const prepared = prepareStudentImport({
    sourceSnapshot: sourceSnapshot({ duplicate: true }),
    studentsRow: studentsRow(),
  });
  assert.equal(prepared.response.canCommit, false);
  assert.equal(prepared.response.summary.ambiguous, 1);
  assert.equal(prepared.response.ambiguous.length, 1);
  assert.throws(() => assertStudentImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedStudentVersion: prepared.response.expectedStudentVersion,
  }, prepared), serviceError("ambiguous_plan"));
});

test("commit confirmation rejects a stale fingerprint or students version", () => {
  const prepared = prepareStudentImport({ sourceSnapshot: sourceSnapshot(), studentsRow: studentsRow() });
  assert.throws(() => assertStudentImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedStudentVersion: 6,
  }, prepared), serviceError("stale_students_version"));
  assert.throws(() => assertStudentImportCommit({
    planFingerprint: `sha256:${"0".repeat(64)}`,
    expectedStudentVersion: 7,
  }, prepared), serviceError("stale_plan"));
});

test("invalid source rows and invalid current students fail closed", () => {
  assert.throws(() => prepareStudentImport({
    sourceSnapshot: { ...sourceSnapshot(), master: { sourceId: "master", revision: "x", rows: [] } },
    studentsRow: studentsRow(7, [{ id: "missing-name" }]),
  }), serviceError("invalid_students_state"));
  assert.throws(() => prepareStudentImport({
    sourceSnapshot: { ...sourceSnapshot(), master: { sourceId: "master", revision: "x", rows: [{ name: "No row key", status: "在读" }] } },
    studentsRow: studentsRow(),
  }), serviceError("invalid_source_snapshot"));
});

test("source ingest accepts exactly one explicitly identified master or JWB snapshot", () => {
  assert.deepEqual(parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "student-master-list",
    revision: "2026-08-13T12:00Z",
    rows: [{ sourceRow: 1, name: "Sample Learner", status: "在读" }],
  }), {
    sourceKind: "master",
    sourceId: "student-master-list",
    revision: "2026-08-13T12:00Z",
    rows: [{ sourceRow: 1, name: "Sample Learner", status: "在读" }],
  });
  assert.deepEqual(parseStudentImportSourceIngestRequest({
    sourceKind: "jwb",
    sourceId: "jiaowubao-export",
    revision: "export-15",
    rows: [{ sourceRow: "101", name: "Sample Learner", remainingHours: "5" }],
  }).sourceKind, "jwb");
});

test("source ingest rejects mixed, inferred or weakly typed uploads", () => {
  assert.throws(() => parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "master",
    revision: "r1",
    rows: [],
  }), serviceError("invalid_source_ingest_request"));
  assert.throws(() => parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "master",
    revision: "r1",
    rows: [{ sourceRow: 1, name: "Sample", status: "unknown" }],
  }), serviceError("invalid_source_ingest_request"));
  assert.throws(() => parseStudentImportSourceIngestRequest({
    sourceKind: "jwb",
    sourceId: "jwb",
    revision: "r1",
    rows: [{ sourceRow: 1, name: "Sample", remainingHours: {} }],
  }), serviceError("invalid_source_ingest_request"));
  assert.throws(() => parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "master",
    revision: "r1",
    rows: [{ sourceRow: 1, name: "Sample", status: "在读", teacher: "Not mapped" }],
  }), serviceError("invalid_source_ingest_request"));
  assert.throws(() => parseStudentImportSourceIngestRequest({
    sourceKind: "jwb",
    sourceId: "jwb",
    revision: "r1",
    rows: [{ sourceRow: 1, name: "Sample", remainingHours: "not-a-number" }],
  }), serviceError("invalid_source_ingest_request"));
  assert.throws(() => parseStudentImportSourceIngestRequest({
    sourceKind: "jwb",
    sourceId: "jwb",
    revision: "r1",
    rows: [{
      sourceRow: 1,
      name: "Sample",
      lessonPackages: [{
        sourcePackageId: "pkg-1",
        name: "English",
        subjectIds: ["English"],
        purchaseRecords: [{
          sourcePurchaseId: "buy-1",
          purchasedAt: "2026-01-01",
          hours: 10,
          unexpected: true,
        }],
        consumedHours: 0,
      }],
    }],
  }), serviceError("invalid_source_ingest_request"));
});

test("dry run reports authoritative packages and missing package-level source data", () => {
  const snapshot = sourceSnapshot();
  snapshot.jwb.rows[0].lessonPackages = [{
    sourcePackageId: "pkg-101",
    name: "English",
    subjectIds: ["English"],
    purchaseRecords: [{ sourcePurchaseId: "buy-101", purchasedAt: "2026-01-01", hours: 10 }],
    consumedHours: 5,
  }];
  const prepared = prepareStudentImport({ sourceSnapshot: snapshot, studentsRow: studentsRow() });
  assert.equal(prepared.response.summary.importedPackages, 1);
  assert.equal(prepared.response.summary.studentsMissingPackageData, 0);
});
