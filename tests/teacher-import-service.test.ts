import assert from "node:assert/strict";
import test from "node:test";

import type { OpsStateRow } from "../lib/ops-store.ts";
import { TEACHER_WORKBOOK_SHEETS } from "../lib/teacher-import.ts";
import {
  assertTeacherImportCommit,
  parseTeacherIdentityResolutionRequest,
  parseTeacherImportCommitRequest,
  parseTeacherImportSourceSnapshot,
  parseTeacherImportSourceIngestRequest,
  prepareTeacherImport,
  prepareTeacherImportAtomicCommit,
  resolveTeacherIdentityCandidate,
  TeacherImportServiceError,
} from "../lib/teacher-import-service.ts";

function snapshot(input: { k12Revision?: string; duplicateAcrossBooks?: boolean } = {}) {
  const sharedName = input.duplicateAcrossBooks ? "Shared Teacher" : "University Teacher";
  return {
    k12: {
      workbook: "k12",
      sourceId: "fixture-k12",
      revision: input.k12Revision ?? "k12-r1",
      sheetNames: TEACHER_WORKBOOK_SHEETS.k12,
      rosterRows: [{ workbook: "k12", sourceRow: 2, name: "K12 Teacher", availabilityText: "周二晚" }],
      subjectRows: [{ workbook: "k12", sheetName: "IB", sourceRow: 12, name: "K12 Teacher", subjectDetail: "Physics" }],
    },
    university: {
      workbook: "university",
      sourceId: "fixture-university",
      revision: "university-r1",
      sheetNames: TEACHER_WORKBOOK_SHEETS.university,
      rosterRows: [{ workbook: "university", sourceRow: 4, name: sharedName }],
      subjectRows: [{ workbook: "university", sheetName: "Engineering", sourceRow: 14, name: sharedName }],
    },
  };
}

function teachersRow(version = 6, payload: unknown[] = []): OpsStateRow {
  return {
    entity: "teachers",
    payload,
    version,
    updated_at: "2026-08-13T00:00:00.000Z",
    updated_by: "Fixture Admin",
  };
}

function serviceError(code: TeacherImportServiceError["code"]) {
  return (error: unknown) => error instanceof TeacherImportServiceError && error.code === code;
}

test("strictly parses both identified workbook snapshots", () => {
  const parsed = parseTeacherImportSourceSnapshot(snapshot());
  assert.equal(parsed.k12.workbook, "k12");
  assert.equal(parsed.university.workbook, "university");
  assert.equal(parsed.k12.rosterRows.length, 1);
  assert.equal(parsed.university.subjectRows.length, 1);
});

test("source ingest accepts exactly one identified workbook and rejects an empty roster", () => {
  assert.equal(parseTeacherImportSourceIngestRequest(snapshot().k12).workbook, "k12");
  assert.throws(() => parseTeacherImportSourceIngestRequest({ ...snapshot().k12, rosterRows: [] }), serviceError("invalid_source_ingest_request"));
  assert.throws(() => parseTeacherImportSourceIngestRequest({ ...snapshot().k12, extra: true }), serviceError("invalid_source_ingest_request"));
});

test("source parser rejects missing books, mixed workbook rows and unsupported fields", () => {
  assert.throws(() => parseTeacherImportSourceSnapshot({ k12: snapshot().k12 }), serviceError("invalid_source_snapshot"));
  assert.throws(() => parseTeacherImportSourceSnapshot({ ...snapshot(), unexpected: true }), serviceError("invalid_source_snapshot"));
  assert.throws(() => parseTeacherImportSourceSnapshot({
    ...snapshot(),
    k12: { ...snapshot().k12, rosterRows: [{ workbook: "university", sourceRow: 1, name: "Wrong Book" }] },
  }), serviceError("invalid_source_snapshot"));
  assert.throws(() => parseTeacherImportSourceSnapshot({
    ...snapshot(),
    k12: { ...snapshot().k12, subjectRows: [{ workbook: "k12", sheetName: "IB", sourceRow: 1, name: "Teacher", extra: true }] },
  }), serviceError("invalid_source_snapshot"));
  assert.throws(() => parseTeacherImportSourceSnapshot({
    ...snapshot(),
    k12: { ...snapshot().k12, rosterRows: [{ workbook: "k12", sourceRow: 1, name: "Teacher", attributes: { acceptsStudents: true } }] },
  }), serviceError("invalid_source_snapshot"));
  const withLocation = parseTeacherImportSourceSnapshot({
    ...snapshot(),
    k12: { ...snapshot().k12, rosterRows: [{ workbook: "k12", sourceRow: 1, name: "Teacher", attributes: { location: "VIC" } }] },
  });
  assert.deepEqual(withLocation.k12.rosterRows[0].attributes, { location: "VIC" });
});

test("builds a deterministic dry run without exposing replacement teachers", () => {
  const first = prepareTeacherImport({ sourceSnapshot: snapshot(), teachersRow: teachersRow() });
  const second = prepareTeacherImport({ sourceSnapshot: snapshot(), teachersRow: teachersRow() });
  assert.match(first.response.planFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.response.planFingerprint, second.response.planFingerprint);
  assert.equal(first.response.expectedTeacherVersion, 6);
  assert.equal(first.response.canCommit, true);
  assert.equal(first.response.summary.insert, 2);
  assert.equal(first.response.sources.k12.rosterRowCount, 1);
  assert.equal(first.response.sources.university.subjectRowCount, 1);
  assert.equal("teachers" in first.response, false);
  assert.equal(first.response.issues.some((issue) => issue.code === "unstructured_availability"), true);
});

test("fingerprint binds source revisions, exact plan and current teacher version", () => {
  const base = prepareTeacherImport({ sourceSnapshot: snapshot(), teachersRow: teachersRow() });
  const newRevision = prepareTeacherImport({ sourceSnapshot: snapshot({ k12Revision: "k12-r2" }), teachersRow: teachersRow() });
  const newVersion = prepareTeacherImport({ sourceSnapshot: snapshot(), teachersRow: teachersRow(7) });
  assert.notEqual(base.response.planFingerprint, newRevision.response.planFingerprint);
  assert.notEqual(base.response.planFingerprint, newVersion.response.planFingerprint);
});

test("strictly parses existing teachers and their stable source references", () => {
  const prepared = prepareTeacherImport({
    sourceSnapshot: snapshot(),
    teachersRow: teachersRow(6, [{
      id: "TEA-EXISTING",
      name: "K12 Teacher",
      teacherSourceRefs: [{ workbook: "k12", sourceId: "fixture-k12", sourceRow: 2 }],
    }]),
  });
  assert.equal(prepared.plan.teachers.find((teacher) => teacher.name === "K12 Teacher")?.id, "TEA-EXISTING");
  assert.throws(() => prepareTeacherImport({
    sourceSnapshot: snapshot(),
    teachersRow: teachersRow(6, [{ id: "TEA-X", name: "Bad Ref", teacherSourceRefs: [{ workbook: "other", sourceId: "x", sourceRow: 1 }] }]),
  }), serviceError("invalid_teachers_state"));
  assert.throws(() => prepareTeacherImport({
    sourceSnapshot: snapshot(),
    teachersRow: teachersRow(6, [{ id: "TEA-X", name: "One" }, { id: "TEA-X", name: "Two" }]),
  }), serviceError("invalid_teachers_state"));
});

test("client commit request accepts only fingerprint and expected version", () => {
  const prepared = prepareTeacherImport({ sourceSnapshot: snapshot(), teachersRow: teachersRow() });
  const valid = {
    planFingerprint: prepared.response.planFingerprint,
    expectedTeacherVersion: prepared.response.expectedTeacherVersion,
  };
  assert.deepEqual(parseTeacherImportCommitRequest(valid), valid);
  for (const forbidden of ["teachers", "plan", "actions", "issues", "workbooks", "sources", "sourceRevisions"] as const) {
    assert.throws(() => parseTeacherImportCommitRequest({ ...valid, [forbidden]: [] }), serviceError("client_plan_forbidden"));
  }
  assert.throws(() => parseTeacherImportCommitRequest({ ...valid, extra: true }), serviceError("invalid_commit_request"));
  assert.throws(() => parseTeacherImportCommitRequest({ ...valid, planFingerprint: "not-a-fingerprint" }), serviceError("invalid_commit_request"));
});

test("blocked identity issues cannot commit", () => {
  const blocked = snapshot({ duplicateAcrossBooks: true });
  blocked.k12.rosterRows[0].name = "Shared Teacher";
  blocked.k12.subjectRows[0].name = "Shared Teacher";
  const prepared = prepareTeacherImport({ sourceSnapshot: blocked, teachersRow: teachersRow() });
  assert.equal(prepared.response.canCommit, false);
  assert.equal(prepared.response.summary.blocked, 2);
  assert.throws(() => assertTeacherImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedTeacherVersion: prepared.response.expectedTeacherVersion,
  }, prepared), serviceError("blocked_plan"));
});

test("identity confirmation accepts only a current server-provided resolution key", () => {
  const blocked = snapshot({ duplicateAcrossBooks: true });
  blocked.k12.rosterRows[0].name = "Shared Teacher";
  blocked.k12.subjectRows[0].name = "Shared Teacher";
  const prepared = prepareTeacherImport({ sourceSnapshot: blocked, teachersRow: teachersRow() });
  const candidate = prepared.response.identityResolutions[0];
  assert.ok(candidate);
  const request = parseTeacherIdentityResolutionRequest({ resolutionKey: candidate.resolutionKey, decision: "merge" });
  assert.deepEqual(resolveTeacherIdentityCandidate(request, prepared), candidate);
  assert.throws(() => parseTeacherIdentityResolutionRequest({ resolutionKey: candidate.resolutionKey, teacherId: "TEA-X" }), serviceError("invalid_identity_resolution_request"));
  assert.throws(() => resolveTeacherIdentityCandidate({ resolutionKey: `sha256:${"0".repeat(64)}`, decision: "merge" }, prepared), serviceError("identity_resolution_unavailable"));
});

test("subject confirmation accepts only an exact closed option key and enumerated decision", () => {
  const source = snapshot();
  source.k12.rosterRows = [
    { workbook: "k12", sourceRow: 2, name: "Roster One" },
    { workbook: "k12", sourceRow: 3, name: "Roster Two" },
  ];
  source.k12.subjectRows = [{ workbook: "k12", sheetName: "IB", sourceRow: 20, name: "Legacy Alias" }];
  const prepared = prepareTeacherImport({ sourceSnapshot: source, teachersRow: teachersRow() });
  const candidate = prepared.response.subjectResolutions[0];
  const option = candidate.options[0];
  assert.ok(option);
  const request = parseTeacherIdentityResolutionRequest({ resolutionKey: option.resolutionKey, decision: option.decision });
  const resolved = resolveTeacherIdentityCandidate(request, prepared);
  assert.equal("selectedOption" in resolved && resolved.selectedOption.resolutionKey, option.resolutionKey);
  assert.throws(() => resolveTeacherIdentityCandidate({ resolutionKey: option.resolutionKey, decision: "ignore" }, prepared), serviceError("identity_resolution_unavailable"));
  assert.throws(() => parseTeacherIdentityResolutionRequest({ resolutionKey: option.resolutionKey, decision: "Roster One" }), serviceError("invalid_identity_resolution_request"));
});

test("source snapshot accepts revision-bound V2 decisions and ignores old revisions in the plan", () => {
  const source = snapshot();
  source.k12.rosterRows = [
    { workbook: "k12", sourceRow: 2, name: "Duplicate Teacher" },
    { workbook: "k12", sourceRow: 3, name: "duplicate teacher" },
  ];
  source.k12.subjectRows = [];
  const pending = prepareTeacherImport({ sourceSnapshot: source, teachersRow: teachersRow() });
  const option = pending.response.identityResolutions[0]?.options.find((candidate) => candidate.decision === "separate");
  assert.ok(option);
  const refs = pending.response.identityResolutions[0].sourceRefs;
  const persisted = prepareTeacherImport({
    sourceSnapshot: {
      ...source,
      hardResolutions: [{
        kind: "same_workbook_identity",
        resolutionKey: option.resolutionKey,
        decision: "separate",
        sourceRevisions: { k12: "k12-r1", university: "university-r1" },
        sourceRefs: refs,
      }],
    },
    teachersRow: teachersRow(),
  });
  assert.equal(persisted.response.canCommit, true);

  const stale = prepareTeacherImport({
    sourceSnapshot: {
      ...source,
      hardResolutions: [{
        kind: "same_workbook_identity",
        resolutionKey: option.resolutionKey,
        decision: "separate",
        sourceRevisions: { k12: "old", university: "university-r1" },
        sourceRefs: refs,
      }],
    },
    teachersRow: teachersRow(),
  });
  assert.equal(stale.response.canCommit, false);
  assert.ok(stale.response.identityResolutions.length > 0);
});

test("persisted identity links are part of the source snapshot and fingerprint", () => {
  const blocked = snapshot({ duplicateAcrossBooks: true });
  blocked.k12.rosterRows[0].name = "Shared Teacher";
  blocked.k12.subjectRows[0].name = "Shared Teacher";
  const first = prepareTeacherImport({ sourceSnapshot: blocked, teachersRow: teachersRow() });
  const resolution = first.response.identityResolutions[0];
  assert.ok(resolution);
  const linkedSnapshot = {
    ...blocked,
    identityLinks: [{
      resolutionKey: resolution.resolutionKey,
      decision: "merge",
      sourceRevisions: { k12: "k12-r1", university: "university-r1" },
      sourceRefs: resolution.sourceRefs,
    }],
  };
  const linked = prepareTeacherImport({ sourceSnapshot: linkedSnapshot, teachersRow: teachersRow() });
  assert.equal(linked.response.canCommit, true);
  assert.equal(linked.plan.teachers.length, 1);
  assert.notEqual(linked.response.planFingerprint, first.response.planFingerprint);
});

test("structural source issues block commit while AVA and timezone review issues do not", () => {
  const reviewOnly = prepareTeacherImport({ sourceSnapshot: snapshot(), teachersRow: teachersRow() });
  assert.equal(reviewOnly.response.canCommit, true);

  const missingSheet = snapshot();
  missingSheet.k12.sheetNames = missingSheet.k12.sheetNames.filter((sheet) => sheet !== "IB");
  const blocked = prepareTeacherImport({ sourceSnapshot: missingSheet, teachersRow: teachersRow() });
  assert.equal(blocked.response.canCommit, false);
  assert.throws(() => assertTeacherImportCommit({
    planFingerprint: blocked.response.planFingerprint,
    expectedTeacherVersion: blocked.response.expectedTeacherVersion,
  }, blocked), serviceError("blocked_plan"));
});

test("commit confirmation rejects stale version and stale fingerprint", () => {
  const prepared = prepareTeacherImport({ sourceSnapshot: snapshot(), teachersRow: teachersRow() });
  assert.throws(() => assertTeacherImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedTeacherVersion: 5,
  }, prepared), serviceError("stale_teachers_version"));
  assert.throws(() => assertTeacherImportCommit({
    planFingerprint: `sha256:${"0".repeat(64)}`,
    expectedTeacherVersion: 6,
  }, prepared), serviceError("stale_plan"));
});

test("server-only atomic contract contains the recomputed plan, source revisions and version", () => {
  const prepared = prepareTeacherImport({ sourceSnapshot: snapshot(), teachersRow: teachersRow() });
  const request = parseTeacherImportCommitRequest({
    planFingerprint: prepared.response.planFingerprint,
    expectedTeacherVersion: prepared.response.expectedTeacherVersion,
  });
  const contract = prepareTeacherImportAtomicCommit(request, prepared);
  assert.deepEqual(contract, {
    contract: "teacher-import-atomic-v1",
    entity: "teachers",
    planFingerprint: prepared.response.planFingerprint,
    expectedTeacherVersion: 6,
    sourceRevisions: { k12: "k12-r1", university: "university-r1" },
    teachers: prepared.plan.teachers,
  });
});
