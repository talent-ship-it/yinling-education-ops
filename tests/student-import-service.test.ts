import assert from "node:assert/strict";
import test from "node:test";

import type { OpsStateRow } from "../lib/ops-store.ts";
import {
  assertStudentImportCommit,
  buildMasterDuplicateResolutionCandidates,
  hasStudentImportAdminAccess,
  masterDuplicateDecisionForCandidate,
  parseMasterDuplicateResolutionRequest,
  parseStudentImportCommitRequest,
  parseStudentImportSourceIngestRequest,
  prepareStudentImport as prepareStudentImportStrict,
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
    identityLinkFingerprint: `sha256:${"a".repeat(64)}`,
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
  assert.equal(prepared.plan.students[0].jwbSourceRow, 101);
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
  assert.equal(candidate.options.filter((option) => option.selectedSourceRow === 32).length, 5);
  assert.deepEqual(
    candidate.options.filter((option) => option.selectedSourceRow === 32).map((option) => option.selectedStatus),
    MASTER_STUDENT_STATUSES.filter((status) => status !== "不活跃 + 无课时"),
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

function sourceSnapshot(input?: Readonly<{
  masterRevision?: string;
  jwbRevision?: string;
  duplicate?: boolean;
}>) {
  return {
    identityLinks: [],
    identityLinkFingerprint: `sha256:${"0".repeat(64)}`,
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
  assert.throws(() => assertStudentImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedStudentVersion: prepared.response.expectedStudentVersion,
  }, prepared), serviceError("ambiguous_plan"));
});

test("an empty replacement plan is visible but cannot be committed", () => {
  const snapshot = sourceSnapshot();
  snapshot.master.rows = [{ sourceRow: 1, name: "Excluded Learner", status: "不活跃 + 无课时" }];
  snapshot.jwb.rows = [];
  const prepared = prepareStudentImport({ sourceSnapshot: snapshot, studentsRow: studentsRow() });

  assert.equal(prepared.plan.students.length, 0);
  assert.equal(prepared.response.canCommit, false);
  assert.equal(prepared.response.summary.excluded, 1);
  assert.throws(() => assertStudentImportCommit({
    planFingerprint: prepared.response.planFingerprint,
    expectedStudentVersion: prepared.response.expectedStudentVersion,
  }, prepared), serviceError("empty_plan"));
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
    name: "Old Name",
    status: "在读",
  };
  const snapshot = sourceSnapshot();
  snapshot.master.sourceId = "stable-master-source";
  snapshot.master.rows[0].name = "Renamed Learner";
  snapshot.jwb.rows[0].name = "Different JWB Name";
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
