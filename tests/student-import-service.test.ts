import assert from "node:assert/strict";
import test from "node:test";

import type { OpsStateRow } from "../lib/ops-store.ts";
import {
  assertStudentImportCommit,
  buildMasterDuplicateResolutionCandidates,
  buildStudentIdentityReviewCandidates,
  hasStudentImportAdminAccess,
  masterDuplicateDecisionForCandidate,
  parseMasterDuplicateResolutionRequest,
  parseStudentIdentityManualReviewRequest,
  parseStudentIdentityReviewClearRequest,
  parseStudentIdentityReviewRequest,
  parseStudentImportMasterSourceSnapshot,
  parseStudentImportCommitRequest,
  parseStudentImportSourceIngestRequest,
  parseStudentImportSourceUnavailableDetail,
  prepareStudentImport as prepareStudentImportStrict,
  prepareStudentIdentityReview,
  resolveStudentIdentityReviewCandidate,
  resolveMasterDuplicateCandidate,
  StudentImportServiceError,
} from "../lib/student-import-service.ts";
import { MASTER_STUDENT_STATUSES, studentIdForMasterSource } from "../lib/student-import.ts";

test("master duplicate hard options are opaque, revision-bound and contain only non-PII evidence", () => {
  const snapshot = sourceSnapshot({ duplicate: true });
  const prepared = prepareStudentImport({ sourceSnapshot: snapshot, studentsRow: studentsRow() });
  assert.equal(prepared.response.canCommit, false);
  assert.equal(prepared.response.masterDuplicateResolutions.length, 1);
  const candidate = prepared.response.masterDuplicateResolutions[0];
  assert.deepEqual(candidate.sourceRows.map((row) => Object.keys(row).sort()), [
    ["sourceRow", "status"],
    ["sourceRow", "status"],
  ]);
  assert.deepEqual(candidate.options.map((option) => option.decision), ["select", "select", "ignore"]);
  assert.equal(candidate.options.every((option) => /^sha256:[a-f0-9]{64}$/.test(option.resolutionKey)), true);
  const selected = candidate.options[1];
  const request = parseMasterDuplicateResolutionRequest({
    resolutionKey: selected.resolutionKey,
    decision: selected.decision,
  });
  const resolved = resolveMasterDuplicateCandidate(request, prepared.response.masterDuplicateResolutions);
  assert.equal(resolved.option.selectedSourceRow, 2);
  assert.throws(() => parseMasterDuplicateResolutionRequest({
    resolutionKey: selected.resolutionKey,
    decision: "select",
    sourceRow: 2,
  }), serviceError("invalid_master_duplicate_resolution_request"));
  const changed = buildMasterDuplicateResolutionCandidates({
    sourceId: snapshot.master.sourceId,
    revision: "master-revision-changed",
    studentVersion: 7,
    rows: snapshot.master.rows,
  });
  assert.throws(() => resolveMasterDuplicateCandidate(request, changed), serviceError("master_duplicate_resolution_unavailable"));
});

test("selected duplicate row binds only to its current reviewed identity link", () => {
  const candidates = buildMasterDuplicateResolutionCandidates({
    sourceId: "master-list",
    revision: "revision-a",
    studentVersion: 7,
    rows: [
      { sourceRow: 32, name: "Duplicate Learner", status: "在读" },
      { sourceRow: 69, name: "duplicate learner", status: "在读" },
    ],
  });
  const option = candidates[0].options.find((item) => item.selectedSourceRow === 69)!;
  const unreviewedDecision = masterDuplicateDecisionForCandidate(candidates[0], option);
  assert.equal(unreviewedDecision.selectedStudentId, undefined);
  const reviewedLink = { masterSourceRow: 69, jwbSourceRow: 101, studentId: "STU-OLD-69" } as const;
  const decision = masterDuplicateDecisionForCandidate(candidates[0], option, [reviewedLink]);
  assert.equal(decision.selectedStudentId, "STU-OLD-69");

  const snapshot = {
    identityLinks: [reviewedLink],
    studentNumberReservations: [],
    identityLinkFingerprint: `sha256:${"a".repeat(64)}`,
    identityReviewEpoch: 0,
    masterDuplicateResolutions: [],
    masterDuplicateResolutionFingerprint: `sha256:${"0".repeat(64)}`,
    fuAttachmentReferences: {
      studentIds: [],
      fingerprint: `sha256:${"0".repeat(64)}`,
    },
    master: {
      sourceId: "master-list",
      revision: "revision-a",
      rows: [
        { sourceRow: 32, name: "Duplicate Learner", status: "在读" },
        { sourceRow: 69, name: "duplicate learner", status: "在读" },
      ],
    },
    jwb: {
      sourceId: "jwb",
      revision: "jwb-a",
      rows: [{ sourceRow: 101, name: "Duplicate Learner" }],
    },
  };
  const prepared = prepareStudentImport({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(7, [
      { id: "STU-OLD-32", name: "Duplicate Learner", sourceRow: 32 },
      { id: "STU-OLD-69", name: "Duplicate Learner", sourceRow: 69 },
    ]),
    masterDuplicateResolutions: [decision],
  });
  assert.equal(prepared.response.masterDuplicateResolutions.length, 0);
  assert.equal(prepared.plan.students[0].id, "STU-OLD-69");
  // The reviewed JWB identity is still used, but a sparse JWB row must not
  // become an active ledger just because the identity link is valid.
  assert.equal(prepared.plan.students[0].jwbMatchStatus, "matched");
  assert.equal(prepared.plan.students[0].jwbSourceRow, undefined);
});

test("formal prepare never reuses legacy row or name identity and its namespaced replay is unchanged", () => {
  const snapshot = sourceSnapshot();
  snapshot.master.sourceId = "formal-master-namespace";
  const legacy = {
    id: "STU-LEGACY-ROW-1",
    name: "Sample Learner",
    status: "在读",
    sourceRow: 1,
    masterSourceKey: "1",
    importSource: "master",
  };
  const references = referenceRows({ bookings: [{ id: "BOOK-LEGACY", studentId: legacy.id }] });
  const first = prepareStudentImport({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(7, [legacy]),
    referenceRows: references,
  });
  const namespacedId = studentIdForMasterSource(1, snapshot.master.sourceId);
  assert.notEqual(namespacedId, legacy.id);
  assert.equal(first.plan.students.some((student) =>
    student.id === namespacedId && student.importArchived !== true), true);
  assert.equal(first.plan.students.some((student) =>
    student.id === legacy.id && student.importArchived === true), true);

  const replay = prepareStudentImport({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(8, [...first.plan.students]),
    referenceRows: references,
  });
  assert.deepEqual(replay.plan.students, first.plan.students);
  assert.equal(replay.response.summary.insert, 0);
  assert.equal(replay.response.summary.update, 0);
  assert.equal(replay.response.summary.unchanged, first.plan.students.length);
});

test("blank-status duplicate exposes only opaque fixed-status choices and saved snapshots close the plan", () => {
  const snapshot = sourceSnapshot();
  snapshot.master.rows = [
    { sourceRow: 32, name: "Blank Duplicate", status: "" },
    { sourceRow: 69, name: "blank duplicate", status: "在读" },
  ];
  snapshot.jwb.rows = [{ sourceRow: 101, name: "Blank Duplicate" }];
  const pending = prepareStudentImport({ sourceSnapshot: snapshot, studentsRow: studentsRow() });
  const candidate = pending.response.masterDuplicateResolutions[0];
  assert.equal(candidate.options.filter((option) => option.selectedSourceRow === 32).length, 6);
  assert.deepEqual(
    candidate.options.filter((option) => option.selectedSourceRow === 32).map((option) => option.selectedStatus),
    MASTER_STUDENT_STATUSES,
  );
  const option = candidate.options.find((item) =>
    item.selectedSourceRow === 32 && item.selectedStatus === "活跃 + 有课时")!;
  snapshot.masterDuplicateResolutions = [masterDuplicateDecisionForCandidate(candidate, option)];
  snapshot.masterDuplicateResolutionFingerprint = `sha256:${"b".repeat(64)}`;
  const resolved = prepareStudentImport({ sourceSnapshot: snapshot, studentsRow: studentsRow() });
  assert.equal(resolved.response.masterDuplicateResolutions.length, 0);
  assert.equal(resolved.plan.students[0].status, "活跃 + 有课时");
  assert.equal(resolved.sourceRevisions.masterDuplicateResolutions, snapshot.masterDuplicateResolutionFingerprint);
});

test("duplicate hard keys also bind to the current students version", () => {
  const input = {
    sourceId: "master-list",
    revision: "revision-a",
    rows: [
      { sourceRow: 32, name: "Duplicate Learner", status: "在读" },
      { sourceRow: 69, name: "duplicate learner", status: "在读" },
    ],
  };
  const before = buildMasterDuplicateResolutionCandidates({ ...input, studentVersion: 7 });
  const after = buildMasterDuplicateResolutionCandidates({ ...input, studentVersion: 8 });
  assert.notEqual(before[0].candidateKey, after[0].candidateKey);
  assert.notEqual(before[0].options[0].resolutionKey, after[0].options[0].resolutionKey);
});

test("identity review exposes only evidence plus opaque closed merge/create options", () => {
  const base = {
    master: {
      sourceId: "master-private",
      revision: "master-r1",
      rows: [{ sourceRow: "M-7", name: " Ａvery   Example ", status: "在读" }],
    },
    jwb: {
      sourceId: "jwb-private",
      revision: "jwb-r1",
      rows: [{ sourceRow: "J-9", name: "avery example", remainingHours: 3, contractHours: 5 }],
    },
    studentsVersion: 4,
    existingStudents: [{ id: "STU-PRIVATE-7", name: "AVERY EXAMPLE", status: "在读" }],
  } as const;
  const merge = buildStudentIdentityReviewCandidates(base);
  assert.equal(merge.length, 1);
  assert.deepEqual(merge[0].options.map((option) => option.decision), ["merge", "create"]);
  assert.match(merge[0].options[0].resolutionKey, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(merge[0].master, { name: "Avery Example", sourceRow: "M-7" });
  assert.deepEqual(merge[0].jwb, { name: "avery example", sourceRow: "J-9" });
  assert.deepEqual(merge[0].existing, { name: "AVERY EXAMPLE" });
  assert.equal(merge[0].existingMatchCount, 1);
  const serialized = JSON.stringify(merge);
  assert.doesNotMatch(serialized, /STU-PRIVATE-7|reviewKey|normalized/i);

  const create = buildStudentIdentityReviewCandidates({ ...base, existingStudents: [] });
  assert.equal(create[0].options[0].decision, "create");
  assert.notEqual(create[0].options[0].resolutionKey, merge[0].options[0].resolutionKey);

  const changedRevision = buildStudentIdentityReviewCandidates({
    ...base,
    master: { ...base.master, revision: "master-r2" },
  });
  const changedStudents = buildStudentIdentityReviewCandidates({ ...base, studentsVersion: 5 });
  const changedEpoch = buildStudentIdentityReviewCandidates({ ...base, reviewEpoch: 1 });
  assert.notEqual(changedRevision[0].options[0].resolutionKey, merge[0].options[0].resolutionKey);
  assert.notEqual(changedStudents[0].options[0].resolutionKey, merge[0].options[0].resolutionKey);
  assert.notEqual(changedEpoch[0].options[0].resolutionKey, merge[0].options[0].resolutionKey);
});

test("identity review is globally unique, fail-closed and never trusts browser refs", () => {
  const input = {
    master: {
      sourceId: "master",
      revision: "m1",
      rows: [{ sourceRow: 1, name: "Alice Example", status: "在读" }],
    },
    jwb: {
      sourceId: "jwb",
      revision: "j1",
      rows: [{ sourceRow: 2, name: "alice example" }],
    },
    studentsVersion: 1,
    existingStudents: [
      { id: "S-1", name: "ALICE EXAMPLE" },
      { id: "S-2", name: "Alice   Example" },
    ],
  } as const;
  const ambiguousExisting = buildStudentIdentityReviewCandidates(input);
  assert.equal(ambiguousExisting.length, 1);
  assert.deepEqual(ambiguousExisting[0].options.map((option) => option.decision), ["create"]);
  assert.equal(ambiguousExisting[0].existingMatchCount, 2);
  assert.equal(ambiguousExisting[0].blockedReason, undefined);
  assert.deepEqual(buildStudentIdentityReviewCandidates({
    ...input,
    master: { ...input.master, rows: [...input.master.rows, { sourceRow: 3, name: "Alice Example", status: "在读" }] },
  }), []);
  assert.deepEqual(buildStudentIdentityReviewCandidates({
    ...input,
    master: {
      ...input.master,
      rows: [...input.master.rows, { sourceRow: 3, name: "Alice Example", status: "不活跃 + 无课时" }],
    },
  }), []);
  assert.deepEqual(buildStudentIdentityReviewCandidates({
    ...input,
    existingStudents: [],
    jwb: { ...input.jwb, rows: [...input.jwb.rows, { sourceRow: 4, name: "Alice Example" }] },
  }), []);

  const available = buildStudentIdentityReviewCandidates({ ...input, existingStudents: [] });
  const option = available[0].options[0];
  const request = parseStudentIdentityReviewRequest({
    resolutionKey: option.resolutionKey,
    decision: option.decision,
  });
  assert.equal(resolveStudentIdentityReviewCandidate(request, available).option, option);
  assert.throws(() => parseStudentIdentityReviewRequest({
    resolutionKey: option.resolutionKey,
    decision: option.decision,
    masterSourceRow: 1,
  }), serviceError("invalid_identity_review_request"));
  assert.throws(() => resolveStudentIdentityReviewCandidate(request, buildStudentIdentityReviewCandidates({
    ...input,
    existingStudents: [],
    studentsVersion: 2,
  })), serviceError("identity_review_unavailable"));
});

test("prepared identity review uses the parsed current link set and students version", () => {
  const snapshot = sourceSnapshot();
  // Keep this review fixture focused on its one deliberate master/JWB pair.
  snapshot.master.rows = [snapshot.master.rows[0]];
  snapshot.master.rows[0].name = " Ｓample   Learner ";
  snapshot.jwb.rows[0].name = "sample learner";
  const first = prepareStudentIdentityReview({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(7, []),
    manualTokenSecret: "test-secret",
  });
  assert.equal(first.candidates.length, 1);
  assert.equal(first.manualReview.masters.length, 1);
  assert.equal(first.manualReview.jwb.length, 1);
  assert.match(first.manualReview.masters[0].token, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first.manualReview), /STU-/);
  assert.deepEqual(parseStudentIdentityManualReviewRequest({
    masterToken: first.manualReview.masters[0].token,
    jwbToken: first.manualReview.jwb[0].token,
    decision: "create",
  }), {
    masterToken: first.manualReview.masters[0].token,
    jwbToken: first.manualReview.jwb[0].token,
    decision: "create",
  });
  assert.throws(() => parseStudentIdentityManualReviewRequest({
    masterToken: first.manualReview.masters[0].token,
    jwbToken: first.manualReview.jwb[0].token,
    decision: "create",
    masterSourceRow: 1,
  }), serviceError("invalid_identity_review_request"));
  assert.deepEqual(parseStudentIdentityReviewClearRequest({
    resolutionKey: first.clearKey,
    decision: "clear",
  }), { resolutionKey: first.clearKey, decision: "clear" });
  snapshot.identityLinks = [{
    masterSourceRow: 1,
    jwbSourceRow: 101,
    studentId: studentIdForMasterSource(1, snapshot.master.sourceId),
  }];
  snapshot.identityLinkFingerprint = `sha256:${"a".repeat(64)}`;
  const linked = prepareStudentIdentityReview({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(7, []),
    manualTokenSecret: "test-secret",
  });
  assert.equal(linked.identityLinkCount, 1);
  assert.deepEqual(linked.candidates, []);
  assert.deepEqual(linked.manualReview.masters, []);
  assert.deepEqual(linked.manualReview.jwb, []);
  assert.equal(linked.decisionCandidates.length, 1);
  const replay = linked.decisionCandidates[0].options[0];
  assert.doesNotThrow(() => resolveStudentIdentityReviewCandidate({
    resolutionKey: replay.resolutionKey,
    decision: replay.decision,
  }, linked.decisionCandidates));

  snapshot.identityLinks = [{
    masterSourceRow: 1,
    jwbSourceRow: 101,
    studentId: "STU-EXISTING",
  }];
  const merged = prepareStudentIdentityReview({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(7, [{ id: "STU-EXISTING", name: "SAMPLE LEARNER" }]),
    manualTokenSecret: "test-secret",
  });
  assert.deepEqual(merged.candidates, []);
  assert.equal(merged.decisionCandidates.length, 1);
  assert.equal(merged.decisionCandidates[0].options[0].decision, "merge");
});

test("prepared identity review opens only after an explicit duplicate-row decision", () => {
  const snapshot = sourceSnapshot();
  snapshot.master.rows = [
    { sourceRow: 1, name: "Sample Learner", status: "在读" },
    { sourceRow: 2, name: "Sample Learner", status: "在读" },
  ];
  snapshot.jwb.rows = [{ sourceRow: 101, name: "sample learner" }];
  const pending = prepareStudentIdentityReview({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(7, []),
    manualTokenSecret: "test-secret",
  });
  assert.deepEqual(pending.candidates, []);
  assert.deepEqual(pending.manualReview.masters, []);

  snapshot.masterDuplicateResolutions = [{
    decision: "select",
    sourceRows: [1, 2],
    selectedSourceRow: 1,
  }];
  snapshot.masterDuplicateResolutionFingerprint = `sha256:${"b".repeat(64)}`;
  const resolved = prepareStudentIdentityReview({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(7, []),
    manualTokenSecret: "test-secret",
  });
  assert.equal(resolved.candidates.length, 1);
  assert.equal(resolved.candidates[0].master.sourceRow, 1);
  assert.equal(resolved.manualReview.masters.length, 1);
  assert.equal(resolved.manualReview.masters[0].sourceRow, 1);
});

test("manual review tokens are HMAC-bound to secret, source/student CAS and epoch", () => {
  const snapshot = sourceSnapshot();
  snapshot.master.rows = [snapshot.master.rows[0]];
  snapshot.master.rows[0].name = "No automatic evidence";
  snapshot.jwb.rows[0].name = "Different JWB evidence";
  const prepare = (manualTokenSecret: string) => prepareStudentIdentityReview({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(7, [{ id: "PRIVATE-CURRENT-ID", name: "Current Evidence" }]),
    manualTokenSecret,
  });
  const first = prepare("secret-a");
  const changedSecret = prepare("secret-b");
  assert.equal(first.candidates.length, 0);
  assert.equal(first.manualReview.masters.length, 1);
  assert.equal(first.manualReview.jwb.length, 1);
  assert.equal(first.manualReview.existing.length, 1);
  assert.notEqual(first.manualReview.masters[0].token, changedSecret.manualReview.masters[0].token);
  assert.doesNotMatch(JSON.stringify(first.manualReview), /PRIVATE-CURRENT-ID/);

  const linkedSnapshot = structuredClone(snapshot);
  linkedSnapshot.identityLinks = [{
    masterSourceRow: 1,
    jwbSourceRow: 101,
    studentId: studentIdForMasterSource(1, snapshot.master.sourceId),
  }];
  linkedSnapshot.identityLinkFingerprint = `sha256:${"c".repeat(64)}`;
  // A stale/cross-name reviewed JWB leg is optional enrichment, not a reason
  // to suppress the Tencent master record or attach the wrong JWB account.
  const downgraded = prepareStudentImport({
    sourceSnapshot: linkedSnapshot,
    studentsRow: studentsRow(7, [{ id: "PRIVATE-CURRENT-ID", name: "Current Evidence" }]),
  });
  const imported = downgraded.plan.students.find((student) =>
    student.id === studentIdForMasterSource(1, snapshot.master.sourceId));
  assert.equal(imported?.jwbMatchStatus, "unmatched");
  assert.equal(imported?.jwbSourceRow, undefined);
  assert.equal(imported?.historicalJwbSnapshot, undefined);

  snapshot.identityReviewEpoch = 1;
  const changedEpoch = prepare("secret-a");
  assert.notEqual(first.manualReview.masters[0].token, changedEpoch.manualReview.masters[0].token);
  assert.notEqual(first.clearKey, changedEpoch.clearKey);
});

function sourceSnapshot(input?: Readonly<{
  masterRevision?: string;
  jwbRevision?: string;
  duplicate?: boolean;
  firstJwbHourEntryDate?: string;
  studentNumberReservations?: readonly Readonly<{
    studentId: string;
    studentNumber: string;
    studentNumberDateSource?: "jwb_first_positive_contract" | "formal_import_date" | "system_entry_date";
  }>[];
}>) {
  return {
    identityLinks: [],
    studentNumberReservations: input?.studentNumberReservations ?? [],
    identityLinkFingerprint: `sha256:${"0".repeat(64)}`,
    identityReviewEpoch: 0,
    masterDuplicateResolutions: [],
    masterDuplicateResolutionFingerprint: `sha256:${"0".repeat(64)}`,
    fuAttachmentReferences: {
      studentIds: [],
      fingerprint: `sha256:${"0".repeat(64)}`,
    },
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
      rows: [{
        sourceRow: 101,
        name: "Sample Learner",
        remainingHours: 5,
        contractHours: 10,
        ...(input?.firstJwbHourEntryDate ? { firstJwbHourEntryDate: input.firstJwbHourEntryDate } : {}),
      }],
    },
  };
}

test("the static Excel path can read only the authoritative Tencent master snapshot", () => {
  const source = sourceSnapshot();
  const master = { ...source.master, rowsSha256: "a".repeat(64) };
  const parsed = parseStudentImportMasterSourceSnapshot({ master });
  assert.equal(parsed.sourceId, source.master.sourceId);
  assert.equal(parsed.revision, source.master.revision);
  assert.equal(parsed.rowsSha256, "a".repeat(64));
  assert.deepEqual(parsed.rows, source.master.rows);

  // Offline JWB workbooks must not be blocked merely because no legacy JWB
  // API snapshot has been uploaded.
  assert.doesNotThrow(() => parseStudentImportMasterSourceSnapshot({ master }));
  assert.throws(
    () => parseStudentImportMasterSourceSnapshot({ master: { ...master, rows: [{ sourceRow: 1, name: "Bad", status: "unknown" }] } }),
    serviceError("invalid_source_snapshot"),
  );
  assert.throws(
    () => parseStudentImportMasterSourceSnapshot({ master: source.master }),
    serviceError("invalid_source_snapshot"),
  );
});

test("rejects duplicate canonical JWB source rows before a formal preview", () => {
  const source = sourceSnapshot();
  const snapshot = {
    ...source,
    jwb: {
      ...source.jwb,
      rows: [
        { sourceRow: " 101 ", name: "Sample Learner", remainingHours: 5, contractHours: 10 },
        { sourceRow: 101, name: "Different Learner", remainingHours: 8, contractHours: 12 },
      ],
    },
  };
  assert.throws(
    () => prepareStudentImport({ sourceSnapshot: snapshot, studentsRow: studentsRow() }),
    serviceError("invalid_source_snapshot"),
  );
});

function studentsRow(version = 7, payload: unknown[] = []): OpsStateRow {
  return {
    entity: "students",
    payload,
    version,
    updated_at: "2026-01-01T00:00:00.000Z",
    updated_by: "Fixture Admin",
  };
}

function referenceRows(payloads: Partial<Record<string, unknown[]>> = {}): OpsStateRow[] {
  return ["bookings", "files", "lpItems", "messages", "operations", "payroll", "renewals", "tasks"].map((entity) => ({
    entity,
    payload: payloads[entity] ?? [],
    version: 1,
    updated_at: "2026-01-01T00:00:00.000Z",
    updated_by: "Fixture Admin",
  }));
}

type PrepareFixtureInput = Omit<Parameters<typeof prepareStudentImportStrict>[0], "referenceRows"> & Readonly<{
  referenceRows?: readonly OpsStateRow[];
}>;

function prepareStudentImport(input: PrepareFixtureInput) {
  return prepareStudentImportStrict({
    ...input,
    referenceRows: input.referenceRows ?? referenceRows(),
    // Keep all fixtures deterministic across an Australia/Melbourne midnight.
    formalImportDate: input.formalImportDate ?? "2026-08-18",
  });
}

function serviceError(code: StudentImportServiceError["code"]) {
  return (error: unknown) => error instanceof StudentImportServiceError && error.code === code;
}

function rawJwbStudent(overrides: Record<string, unknown> = {}) {
  return {
    mem_id: "MEM-1",
    mem_name: "Sample Learner",
    ks_total: 20,
    ks_used: 6,
    ks_rest: 14,
    ...overrides,
  };
}

function rawJwbContract(overrides: Record<string, unknown> = {}) {
  return {
    contract_id: "CONTRACT-1",
    contract_code: "CODE-1",
    mem_id: "MEM-1",
    course_id: "COURSE-1",
    course_title: "English",
    nature: 1,
    nature_title: "新签",
    ks: 20,
    ks_use: 6,
    ks_left: 14,
    contract_dated: "2026-08-01",
    dated: "2026-08-02",
    start: "2026-08-03",
    end: null,
    detail_lists: [{
      detail_id: "DETAIL-1",
      course_id: "COURSE-1",
      course_title: "English",
      ks: 20,
      ks_left: 14,
      end: null,
    }],
    ...overrides,
  };
}

function rawJwbRequest(overrides: Record<string, unknown> = {}) {
  return {
    sourceKind: "jwb",
    sourceFormat: "jiaowubao-api-v2",
    sourceId: "jiaowubao-api",
    revision: "2026-08-13T12:00Z",
    negativeAdjustmentPolicy: "reject",
    students: [rawJwbStudent()],
    contracts: [rawJwbContract()],
    courseBalances: [{
      mem_id: "MEM-1",
      ks_total: 20,
      ks_used: 6,
      ks_rest: 14,
      courses: [{
        course_id: "COURSE-1",
        title: "English",
        ks: 20,
        ks_use: 6,
        ks_left: 14,
      }],
    }],
    courses: [{ course_id: "COURSE-1", title: "English" }],
    ...overrides,
  };
}

test("only a verified full admin or the limited admin can access formal import", () => {
  assert.equal(hasStudentImportAdminAccess("Nixon", true), true);
  assert.equal(hasStudentImportAdminAccess("Nixon", false), false);
  assert.equal(hasStudentImportAdminAccess("Ops Admin", false), true);
  assert.equal(hasStudentImportAdminAccess("Abby", false), false);
  assert.equal(hasStudentImportAdminAccess(null, false), false);
});

test("missing source detail is narrow, ordered and never guessed", () => {
  assert.deepEqual(parseStudentImportSourceUnavailableDetail("missing_sources=master"), ["master"]);
  assert.deepEqual(parseStudentImportSourceUnavailableDetail("missing_sources=jwb"), ["jwb"]);
  assert.deepEqual(
    parseStudentImportSourceUnavailableDetail("missing_sources=master,jwb"),
    ["master", "jwb"],
  );
  assert.deepEqual(
    parseStudentImportSourceUnavailableDetail("missing_sources=jwb,master"),
    ["master", "jwb"],
  );
  assert.equal(parseStudentImportSourceUnavailableDetail("missing_sources=master,master"), null);
  assert.equal(parseStudentImportSourceUnavailableDetail("student_import_source_rows_unavailable"), null);
  assert.equal(parseStudentImportSourceUnavailableDetail(undefined), null);
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
  assert.deepEqual(first.response.excluded.map((entry) => entry.reason), ["inactive_no_hours"]);
  assert.deepEqual(first.response.unmatched, []);
  assert.deepEqual(first.response.ambiguous, []);
});

test("rejects stored JWB snapshots with sub-microhour precision", () => {
  const snapshot = sourceSnapshot();
  snapshot.jwb.rows[0].remainingHours = 0.0001245;
  assert.throws(() => prepareStudentImport({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(),
  }), serviceError("invalid_source_snapshot"));
});

test("derives historical archive retention only from server-owned canonical references", () => {
  const historical = {
    id: "STU-HISTORY-1",
    name: "Historical Learner",
    initials: "HL",
    status: "在读",
    owner: "Abby",
    course: "English",
    timezone: "Australia/Melbourne",
    teacher: "Legacy Teacher",
    next: "Old reminder",
    nextTone: "red",
    files: 0,
    sourceRow: 3,
  };
  const prepared = prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(7, [historical]),
    referenceRows: referenceRows({ bookings: [{ id: "BOOK-HISTORY", studentId: historical.id }] }),
  });

  assert.equal(prepared.response.summary.preservedReferencedArchived, 1);
  assert.equal(prepared.plan.students.some((student) => student.id === historical.id && student.importArchived === true), true);
});

test("retains a historical student referenced only by a booking occurrence override", () => {
  const historical = {
    id: "STU-OCCURRENCE-HISTORY",
    name: "Occurrence History",
    initials: "OH",
    status: "在读",
    owner: "Abby",
    course: "English",
    timezone: "Australia/Melbourne",
    teacher: "Legacy Teacher",
    next: "Old reminder",
    nextTone: "red",
    files: 0,
    sourceRow: 98,
  };
  const prepared = prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(7, [historical]),
    referenceRows: referenceRows({
      bookings: [{
        id: "BOOK-OTHER-STUDENT",
        studentId: "STU-CURRENT",
        occurrenceOverrides: [{
          occurrenceId: "BOOK-OTHER-STUDENT:2026-08-01",
          studentId: historical.id,
        }],
      }],
    }),
  });

  assert.equal(prepared.response.summary.preservedReferencedArchived, 1);
  assert.equal(prepared.plan.students.some((student) =>
    student.id === historical.id
    && student.importArchived === true
    && student.importArchivedReason === "referenced_history"), true);
});

test("retains an attachment-only historical student without exposing attachment references", () => {
  const historical = {
    id: "STU-ATTACHMENT-HISTORY",
    name: "Attachment History",
    initials: "AH",
    status: "在读",
    owner: "Abby",
    course: "English",
    timezone: "Australia/Melbourne",
    teacher: "Legacy Teacher",
    next: "Old reminder",
    nextTone: "red",
    files: 1,
    sourceRow: 99,
  };
  const snapshot = sourceSnapshot();
  snapshot.fuAttachmentReferences = {
    studentIds: [historical.id],
    fingerprint: `sha256:${"a".repeat(64)}`,
  };
  const prepared = prepareStudentImport({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(7, [historical]),
    referenceRows: referenceRows(),
  });

  assert.equal(prepared.response.summary.preservedReferencedArchived, 1);
  assert.equal(prepared.plan.students.some((student) =>
    student.id === historical.id
    && student.importArchived === true
    && student.importArchivedReason === "referenced_history"), true);
  assert.equal(prepared.sourceRevisions.fuAttachments, snapshot.fuAttachmentReferences.fingerprint);
  assert.doesNotMatch(JSON.stringify(prepared.response), /STU-ATTACHMENT-HISTORY|fuAttachment|attachment/i);
});

test("binds the plan fingerprint to the server-owned attachment reference revision", () => {
  const firstSnapshot = sourceSnapshot();
  const secondSnapshot = sourceSnapshot();
  firstSnapshot.fuAttachmentReferences.fingerprint = `sha256:${"a".repeat(64)}`;
  secondSnapshot.fuAttachmentReferences.fingerprint = `sha256:${"b".repeat(64)}`;
  const first = prepareStudentImport({ sourceSnapshot: firstSnapshot, studentsRow: studentsRow() });
  const second = prepareStudentImport({ sourceSnapshot: secondSnapshot, studentsRow: studentsRow() });
  assert.deepEqual(first.plan, second.plan);
  assert.notEqual(first.response.planFingerprint, second.response.planFingerprint);
});

test("fails closed on malformed attachment reference snapshots", () => {
  for (const fuAttachmentReferences of [
    undefined,
    { studentIds: ["STU-1", "STU-1"], fingerprint: `sha256:${"a".repeat(64)}` },
    { studentIds: [" STU-1 "], fingerprint: `sha256:${"a".repeat(64)}` },
    { studentIds: ["STU-1"], fingerprint: "not-a-fingerprint" },
    { studentIds: ["STU-1"], fingerprint: `sha256:${"a".repeat(64)}`, attachmentIds: ["forbidden"] },
  ]) {
    assert.throws(() => prepareStudentImport({
      sourceSnapshot: { ...sourceSnapshot(), fuAttachmentReferences },
      studentsRow: studentsRow(),
    }), serviceError("invalid_source_snapshot"));
  }
});

test("fails closed when any canonical reference state is missing or malformed", () => {
  assert.throws(() => prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(),
    referenceRows: referenceRows().slice(1),
  }), serviceError("invalid_students_state"));
  assert.throws(() => prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(),
    referenceRows: referenceRows({ bookings: [null as unknown as Record<string, unknown>] }),
  }), serviceError("invalid_students_state"));
  assert.throws(() => prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(),
    referenceRows: referenceRows({ bookings: [{ occurrenceOverrides: {} }] }),
  }), serviceError("invalid_students_state"));
  assert.throws(() => prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(),
    referenceRows: referenceRows({ bookings: [{ occurrenceOverrides: [null] }] }),
  }), serviceError("invalid_students_state"));
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

test("binds an exact full-name plan to the reviewed JWB revision", () => {
  const firstSnapshot = sourceSnapshot();
  firstSnapshot.master.rows[0].name = " Ａvery   Example ";
  firstSnapshot.jwb.rows[0].name = "avery example";
  const secondSnapshot = structuredClone(firstSnapshot);
  secondSnapshot.jwb.revision = "jwb-revision-b";

  const first = prepareStudentImport({ sourceSnapshot: firstSnapshot, studentsRow: studentsRow() });
  const second = prepareStudentImport({ sourceSnapshot: secondSnapshot, studentsRow: studentsRow() });

  assert.equal(first.plan.students[0].jwbMatchStatus, "matched");
  assert.equal(first.plan.students[0].jwbSourceRow, undefined);
  assert.equal(first.plan.students[0].historicalJwbSnapshot?.currentAggregate?.jwbSourceRow, 101);
  assert.deepEqual(first.plan.students, second.plan.students);
  assert.notEqual(first.response.planFingerprint, second.response.planFingerprint);
  assert.equal(second.sourceRevisions.jwb, "jwb-revision-b");
});

test("binds the fingerprint and commit source revisions to the locked bookings version", () => {
  const beforeRows = referenceRows();
  const afterRows = referenceRows();
  const bookingsBefore = beforeRows.find((row) => row.entity === "bookings")!;
  const bookingsAfter = afterRows.find((row) => row.entity === "bookings")!;
  bookingsBefore.version = 11;
  bookingsAfter.version = 12;
  const before = prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(),
    referenceRows: beforeRows,
  });
  const after = prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(),
    referenceRows: afterRows,
  });

  assert.deepEqual(before.plan, after.plan);
  assert.equal(before.sourceRevisions.bookingsVersion, 11);
  assert.equal(after.sourceRevisions.bookingsVersion, 12);
  assert.notEqual(before.response.planFingerprint, after.response.planFingerprint);
  assert.equal("bookingsVersion" in before.response, false);
});

test("fails closed when the locked bookings row is missing, duplicated or has an unsafe version", () => {
  const missing = referenceRows().filter((row) => row.entity !== "bookings");
  const duplicated = referenceRows();
  duplicated.push({ ...duplicated.find((row) => row.entity === "bookings")! });

  for (const referenceRows of [missing, duplicated]) {
    assert.throws(() => prepareStudentImport({
      sourceSnapshot: sourceSnapshot(),
      studentsRow: studentsRow(),
      referenceRows,
    }), serviceError("invalid_students_state"));
  }
  for (const version of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const rows = referenceRows();
    rows.find((row) => row.entity === "bookings")!.version = version;
    assert.throws(() => prepareStudentImport({
      sourceSnapshot: sourceSnapshot(),
      studentsRow: studentsRow(),
      referenceRows: rows,
    }), serviceError("invalid_students_state"));
  }
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
  assert.doesNotMatch(JSON.stringify(prepared.response.ambiguous), /existingStudentIds|normalizedName/);
  assert.equal(typeof prepared.response.ambiguous[0].existingStudentCount, "number");
  assert.throws(() => assertStudentImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedStudentVersion: prepared.response.expectedStudentVersion,
  }, prepared), serviceError("ambiguous_plan"));
});

test("a named inactive/no-hours Tencent roster row is excluded from the formal import", () => {
  const snapshot = sourceSnapshot();
  snapshot.master.rows = [{ sourceRow: 1, name: "Excluded Learner", status: "不活跃 + 无课时" }];
  snapshot.jwb.rows = [];
  const prepared = prepareStudentImport({ sourceSnapshot: snapshot, studentsRow: studentsRow() });

  assert.equal(prepared.plan.students.length, 0);
  assert.equal(prepared.response.canCommit, false);
  assert.equal(prepared.response.summary.excluded, 1);
  assert.deepEqual(prepared.response.excluded.map((entry) => entry.reason), ["inactive_no_hours"]);
  assert.throws(() => assertStudentImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedStudentVersion: prepared.response.expectedStudentVersion,
  }, prepared), serviceError("empty_plan"));
});

test("JWB identity coverage remains diagnostic and never blocks named Tencent master rows", () => {
  const snapshot = sourceSnapshot();
  snapshot.master.rows = [
    { sourceRow: 1, name: "Unmatched Studying Learner", status: "在读" },
    { sourceRow: 2, name: "No Hours Learner", status: "活跃 + 无课时" },
  ];
  snapshot.jwb.rows = [];
  const prepared = prepareStudentImport({ sourceSnapshot: snapshot, studentsRow: studentsRow() });

  assert.deepEqual(prepared.response.identityCoverage, {
    requiredMasterRows: 2,
    matchedRequiredMasterRows: 0,
    missingRequiredMasterRows: 2,
    ready: true,
  });
  assert.equal(prepared.response.canCommit, true);
  assert.doesNotThrow(() => assertStudentImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedStudentVersion: prepared.response.expectedStudentVersion,
  }, prepared));
  assert.equal(prepared.plan.students.every((student) =>
    student.jwbMatchStatus === "unmatched" && student.studentNumberDateSource === "formal_import_date"), true);
});

test("allows a master row explicitly marked active without hours to omit a JWB identity", () => {
  const snapshot = sourceSnapshot();
  snapshot.master.rows = [{ sourceRow: 1, name: "No Hours Learner", status: "活跃 + 无课时" }];
  snapshot.jwb.rows = [];
  const prepared = prepareStudentImport({ sourceSnapshot: snapshot, studentsRow: studentsRow() });

  assert.deepEqual(prepared.response.identityCoverage, {
    requiredMasterRows: 1,
    matchedRequiredMasterRows: 0,
    missingRequiredMasterRows: 1,
    ready: true,
  });
  assert.equal(prepared.response.canCommit, true);
  assert.doesNotThrow(() => assertStudentImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedStudentVersion: prepared.response.expectedStudentVersion,
  }, prepared));
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
  assert.throws(() => prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(7, [{
      id: "STU-BAD-PACKAGES",
      name: "Bad Packages",
      segment: "试听",
      lessonPackages: {},
    }]),
  }), serviceError("invalid_students_state"));

  const droppedOrphan = prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(7, [{ id: "STU-DROPPED-BAD-PACKAGES", name: "Dropped", lessonPackages: {} }]),
  });
  assert.equal(droppedOrphan.plan.students.some((student) => student.id === "STU-DROPPED-BAD-PACKAGES"), false);
});

test("server preview consumes the durable student-number reservation snapshot", () => {
  const returningId = studentIdForMasterSource(1, "master-list");
  const prepared = prepareStudentImport({
    sourceSnapshot: sourceSnapshot({
      firstJwbHourEntryDate: "2026-08-17",
      studentNumberReservations: [{ studentId: returningId, studentNumber: "20260817007" }],
    }),
    studentsRow: studentsRow(),
  });
  assert.equal(prepared.plan.students[0]?.studentNumber, "20260817007");

  const snapshot = sourceSnapshot();
  delete (snapshot as { studentNumberReservations?: unknown }).studentNumberReservations;
  assert.throws(() => prepareStudentImport({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(),
  }), serviceError("invalid_source_snapshot"));
});

test("number provenance is fingerprinted and distinguishes JWB history from the formal import day", () => {
  const jwbDated = prepareStudentImport({
    sourceSnapshot: sourceSnapshot({ firstJwbHourEntryDate: "2024-02-03" }),
    studentsRow: studentsRow(),
  });
  const fallbackSnapshot = sourceSnapshot();
  fallbackSnapshot.master.rows = [{ sourceRow: 2, name: "Formal Fallback", status: "在读" }];
  fallbackSnapshot.jwb.rows = [];
  const fallback = prepareStudentImport({
    sourceSnapshot: fallbackSnapshot,
    studentsRow: studentsRow(),
  });
  const nextDay = prepareStudentImport({
    sourceSnapshot: fallbackSnapshot,
    studentsRow: studentsRow(),
    formalImportDate: "2026-08-19",
  });

  assert.equal(jwbDated.plan.students[0]?.studentNumber, "20240203001");
  assert.equal(jwbDated.plan.students[0]?.studentNumberDateSource, "jwb_first_positive_contract");
  // Aggregate-only JWB facts stay read-only, even while their verified first
  // positive contract date supplies the immutable student-number origin.
  assert.equal(jwbDated.plan.students[0]?.firstJwbHourEntryDate, undefined);
  assert.equal(jwbDated.plan.students[0]?.historicalJwbSnapshot?.currentAggregate?.firstJwbHourEntryDate, "2024-02-03");
  assert.equal(fallback.plan.students[0]?.studentNumber, "20260818001");
  assert.equal(fallback.plan.students[0]?.studentNumberDateSource, "formal_import_date");
  assert.equal(fallback.sourceRevisions.formalImportDate, "2026-08-18");
  assert.equal(nextDay.plan.students[0]?.studentNumber, "20260819001");
  assert.notEqual(fallback.response.planFingerprint, nextDay.response.planFingerprint);
});

test("preserves valid date-only purchases in current manual lesson packages", () => {
  const prepared = prepareStudentImport({
    sourceSnapshot: sourceSnapshot(),
    studentsRow: studentsRow(7, [{
      id: "TRIAL-DATE-ONLY",
      name: "Date Only Trial",
      segment: "试听",
      lessonPackages: [{
        id: "PKG-MANUAL-DATE",
        name: "Manual package",
        subjectIds: ["English"],
        purchaseRecords: [{
          id: "BUY-MANUAL-DATE",
          purchasedAt: "2026-01-01",
          hours: 2,
        }],
        consumedHours: 0,
      }],
    }]),
  });
  const trial = prepared.plan.students.find((student) => student.id === "TRIAL-DATE-ONLY");
  assert.equal(trial?.lessonPackages?.[0].purchaseRecords[0].purchasedAt, "2026-01-01");
  assert.equal(prepared.response.canCommit, true);
});

test("source ingest accepts an identified master snapshot and rejects normalized JWB rows", () => {
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
  assert.throws(() => parseStudentImportSourceIngestRequest({
    sourceKind: "jwb",
    sourceId: "jiaowubao-export",
    revision: "export-15",
    rows: [{ sourceRow: "101", name: "Sample Learner", remainingHours: 5 }],
  }), serviceError("invalid_source_ingest_request"));

  const canonical = parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "student-master-list",
    revision: "trimmed-source-row",
    rows: [{ sourceRow: "\tROW-1\u00A0", name: "Sample Learner", status: "在读" }],
  });
  assert.equal(canonical.rows[0].sourceRow, "ROW-1");
});

test("master ingest recognizes the authoritative 教务宝学员编号 header and drops blanks", () => {
  const withMemberId = parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "student-master-list",
    revision: "jwb-member-id-header",
    rows: [{
      sourceRow: 1,
      name: "Sample Learner",
      status: "在读",
      "教务宝学员编号": "  MEM-101  ",
    }],
  });
  assert.deepEqual(withMemberId.rows, [{
    sourceRow: 1,
    name: "Sample Learner",
    status: "在读",
    jwbMemId: "MEM-101",
  }]);

  const blank = parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "student-master-list",
    revision: "blank-jwb-member-id-header",
    rows: [{
      sourceRow: 2,
      name: "Another Learner",
      status: "在读",
      "教务宝学员编号": "  ",
    }],
  });
  assert.deepEqual(blank.rows, [{ sourceRow: 2, name: "Another Learner", status: "在读" }]);

  assert.throws(() => parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "student-master-list",
    revision: "ambiguous-jwb-member-id-header",
    rows: [{
      sourceRow: 3,
      name: "Ambiguous Learner",
      status: "在读",
      jwbMemId: "MEM-103",
      "教务宝学员编号": "MEM-103",
    }],
  }), serviceError("invalid_source_ingest_request"));
});

test("master ingest accepts only its four trimmed non-PII attributes", () => {
  const parsed = parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "student-master-list",
    revision: "revision-attributes",
    rows: [{
      sourceRow: 1,
      name: " Sample Learner ",
      status: "在读",
      attributes: {
        location: " NSW ",
        year: " Year 9 ",
        owner: " Abby ",
        planner: " Tara ",
      },
    }],
  });
  assert.deepEqual(parsed.rows, [{
    sourceRow: 1,
    name: "Sample Learner",
    status: "在读",
    attributes: { location: "NSW", year: "Year 9", owner: "Abby", planner: "Tara" },
  }]);
  for (const attributes of [
    { mobile: "0400000000" },
    { owner: "" },
    { planner: "x".repeat(121) },
    { location: 123 },
  ]) {
    assert.throws(() => parseStudentImportSourceIngestRequest({
      sourceKind: "master",
      sourceId: "student-master-list",
      revision: "revision-invalid-attributes",
      rows: [{ sourceRow: 1, name: "Sample Learner", status: "在读", attributes }],
    }), serviceError("invalid_source_ingest_request"));
  }
});

test("master ingest admits blank status only inside a closed duplicate hard-decision group", () => {
  const parsed = parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "student-master-list",
    revision: "full-538",
    rows: [
      { sourceRow: 32, name: "Duplicate Learner", status: "" },
      { sourceRow: 69, name: "duplicate learner", status: "在读" },
    ],
  });
  assert.equal(parsed.rows.length, 2);
  assert.throws(() => parseStudentImportSourceIngestRequest({
    sourceKind: "master",
    sourceId: "student-master-list",
    revision: "unique-blank",
    rows: [{ sourceRow: 32, name: "Unique Learner", status: "" }],
  }), serviceError("invalid_source_ingest_request"));
});

test("normalized JWB cannot forge internal package audit metadata", () => {
  assert.throws(() => parseStudentImportSourceIngestRequest({
    sourceKind: "jwb",
    sourceId: "jwb-normalized",
    revision: "forged",
    rows: [{
      sourceRow: "MEM-1",
      name: "Sample Learner",
      remainingHours: 10,
      contractHours: 10,
      packageCoverage: "none",
      attributes: {
        jiaowubaoPackageImport: {
          status: "aggregate_only_no_current_courses",
          currentTotalHours: 10,
          currentUsedHours: 0,
          currentRemainingHours: 10,
          adjustmentContracts: [],
        },
      },
    }],
  }), serviceError("invalid_source_ingest_request"));
});

test("raw JWB ingest adapts strict API rows before returning the normalized storage contract", () => {
  const parsed = parseStudentImportSourceIngestRequest(rawJwbRequest());
  assert.equal(parsed.sourceKind, "jwb");
  assert.equal(parsed.sourceId, "jiaowubao-api");
  assert.equal(parsed.revision, "2026-08-13T12:00Z");
  assert.deepEqual(parsed.rows, [{
    sourceRow: "MEM-1",
    name: "Sample Learner",
    remainingHours: 14,
    contractHours: 20,
    packageCoverage: "complete",
    contractEffectiveDate: "2026-08-03",
    firstJwbHourEntryDate: "2026-08-01",
    lessonPackages: [{
      sourcePackageId: "COURSE-1",
      name: "English",
      subjectIds: ["English"],
      purchaseRecords: [{
        sourcePurchaseId: "CONTRACT-1",
        purchasedAt: "2026-08-01",
        hours: 20,
        note: "新签",
      }],
      consumedHours: 6,
    }],
    attributes: {
      jiaowubaoPackageImport: {
        status: "packages_from_current_course_balances",
        currentTotalHours: 20,
        currentUsedHours: 6,
        currentRemainingHours: 14,
        adjustmentContracts: [],
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(parsed), /sourceFormat|negativeAdjustmentPolicy|detail_lists/);
});

test("raw JWB ingest requires an explicit negative policy and maps adapter failures", () => {
  assert.throws(
    () => parseStudentImportSourceIngestRequest(rawJwbRequest({ negativeAdjustmentPolicy: undefined })),
    serviceError("invalid_source_ingest_request"),
  );
  assert.throws(
    () => parseStudentImportSourceIngestRequest(rawJwbRequest({
      students: [rawJwbStudent({ ks_total: 21 })],
    })),
    (error: unknown) => error instanceof StudentImportServiceError
      && error.code === "invalid_jiaowubao_source"
      && error.sourceErrorCode === "balance_mismatch",
  );

  const negativeContract = rawJwbContract({
    contract_id: "REFUND-1",
    nature: 5,
    nature_title: "退费",
    ks: -2,
    ks_use: 0,
    ks_left: -2,
    detail_lists: [{
      detail_id: "REFUND-DETAIL-1",
      course_id: "COURSE-1",
      course_title: "English",
      ks: -2,
      ks_left: -2,
      end: null,
    }],
  });
  const adjusted = rawJwbRequest({
    contracts: [rawJwbContract(), negativeContract],
  });
  assert.throws(
    () => parseStudentImportSourceIngestRequest(adjusted),
    (error: unknown) => error instanceof StudentImportServiceError
      && error.code === "invalid_jiaowubao_source"
      && error.sourceErrorCode === "negative_adjustment_requires_review",
  );
  const [reviewed] = parseStudentImportSourceIngestRequest({
    ...adjusted,
    negativeAdjustmentPolicy: "aggregate-only",
  }).rows;
  assert.equal(reviewed.lessonPackages, undefined);
  assert.equal(reviewed.packageCoverage, "none");
  assert.equal(
    (reviewed.attributes?.jiaowubaoPackageImport as { status: string }).status,
    "aggregate_only_negative_adjustment",
  );
});

test("raw JWB ingest rejects unsupported top-level, student, contract, detail, and course fields", () => {
  for (const request of [
    rawJwbRequest({ cookie: "must-not-be-accepted" }),
    rawJwbRequest({ students: [rawJwbStudent({ mobile: "must-not-be-stored" })] }),
    rawJwbRequest({ contracts: [rawJwbContract({ amount: "must-not-be-stored" })] }),
    rawJwbRequest({ contracts: [rawJwbContract({
      detail_lists: [{
        detail_id: "DETAIL-1",
        course_id: "COURSE-1",
        course_title: "English",
        ks: 20,
        ks_left: 14,
        end: null,
        teacher_name: "must-not-be-stored",
      }],
    })] }),
    rawJwbRequest({ courses: [{ course_id: "COURSE-1", title: "English", price: 100 }] }),
  ]) {
    assert.throws(
      () => parseStudentImportSourceIngestRequest(request),
      serviceError("invalid_source_ingest_request"),
    );
  }
});

test("raw JWB ingest enforces independent 10,000-record bounds", () => {
  assert.throws(() => parseStudentImportSourceIngestRequest(rawJwbRequest({
    contracts: Array.from({ length: 10_001 }, () => null),
  })), serviceError("invalid_source_ingest_request"));
  assert.throws(() => parseStudentImportSourceIngestRequest(rawJwbRequest({
    courses: Array.from({ length: 10_001 }, () => null),
  })), serviceError("invalid_source_ingest_request"));
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
  snapshot.master.rows = [snapshot.master.rows[0]];
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

test("dry run binds the stable master namespace and revision-bound identity links", () => {
  const existing = {
    id: "STU-EXISTING-STABLE",
    name: "RENAMED LEARNER",
    status: "在读",
  };
  const snapshot = sourceSnapshot();
  snapshot.master.sourceId = "stable-master-source";
  snapshot.master.rows[0].name = "Renamed Learner";
  snapshot.jwb.rows[0].name = "renamed learner";
  snapshot.identityLinks = [{ masterSourceRow: 1, jwbSourceRow: 101, studentId: existing.id }];
  snapshot.identityLinkFingerprint = `sha256:${"a".repeat(64)}`;
  const prepared = prepareStudentImport({
    sourceSnapshot: snapshot,
    studentsRow: studentsRow(7, [existing]),
  });
  assert.equal(prepared.plan.students[0].id, existing.id);
  assert.equal(prepared.plan.students[0].jwbMatchStatus, "matched");
  assert.equal(prepared.response.identityLinkCount, 1);
  assert.equal(prepared.sourceRevisions.identityLinks, snapshot.identityLinkFingerprint);
});
