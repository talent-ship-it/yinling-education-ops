import assert from "node:assert/strict";
import test from "node:test";

import {
  MASTER_STUDENT_STATUSES,
  StudentImportError,
  applyMasterStudentDuplicateResolutions,
  buildStudentImportPlan,
  findMasterStudentDuplicateGroups,
  lessonPackageIdForSource,
  isMasterStudentStatus,
  isStudentImportJwbLatinParentheticalAnnotationMatch,
  masterSourceKeyForSource,
  normalizeStudentImportName,
  parseMasterStudentStatus,
  studentImportJwbLatinParentheticalAnnotationKey,
  studentIdForMasterSource,
  STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1,
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

test("master duplicate groups require an explicit select or ignore decision", () => {
  const rows = [
    master(32, "Duplicate Learner", "在读", { location: "NSW" }),
    master(69, " duplicate learner ", "活跃 + 有课时", { year: "Year 9" }),
    master(70, "Unique Learner"),
  ];
  const groups = findMasterStudentDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].rows.map((row) => row.sourceRow), [32, 69]);
  assert.deepEqual(applyMasterStudentDuplicateResolutions(rows, [{
    decision: "select",
    sourceRows: [32, 69],
    selectedSourceRow: 69,
  }]).map((row) => row.sourceRow), [69, 70]);
  assert.deepEqual(applyMasterStudentDuplicateResolutions(rows, [{
    decision: "ignore",
    sourceRows: [32, 69],
  }]).map((row) => row.sourceRow), [70]);
  assert.throws(() => applyMasterStudentDuplicateResolutions(rows, [{
    decision: "select",
    sourceRows: [32, 69],
    selectedSourceRow: 999,
  }]), (error: unknown) => error instanceof StudentImportError
    && error.code === "invalid_master_duplicate_resolution");
});

test("blank status is closed inside a duplicate group and requires a fixed-status hard option", () => {
  const rows = [
    master(32, "Duplicate Learner", ""),
    master(69, " duplicate learner ", "在读"),
  ];
  assert.deepEqual(findMasterStudentDuplicateGroups(rows)[0].rows.map((row) => row.sourceRow), [32, 69]);
  assert.deepEqual(applyMasterStudentDuplicateResolutions(rows, [{
    decision: "select",
    sourceRows: [32, 69],
    selectedSourceRow: 32,
    selectedStatus: "活跃 + 有课时",
  }]), [master(32, "Duplicate Learner", "活跃 + 有课时")]);
  assert.throws(() => applyMasterStudentDuplicateResolutions(rows, [{
    decision: "select",
    sourceRows: [32, 69],
    selectedSourceRow: 32,
  }]), (error: unknown) => error instanceof StudentImportError
    && error.code === "invalid_master_duplicate_resolution");
  assert.throws(() => findMasterStudentDuplicateGroups([
    master(32, "Unique blank learner", ""),
  ]), (error: unknown) => error instanceof StudentImportError && error.code === "invalid_status");
});

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

test("imports every named inactive master student and keeps aggregate-only JWB facts read-only", () => {
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

  assert.deepEqual(plan.students.map((student) => student.name), ["Excluded Learner", "Included Learner"]);
  assert.deepEqual(plan.excluded, []);
  assert.equal(plan.summary.excluded, 0);
  assert.equal(plan.summary.unmatched, 0);
  assert.equal(plan.students[0].status, "不活跃 + 无课时");
  assert.equal(plan.students[0].jwbMatchStatus, "matched");
  assert.equal(plan.students[0].remainingHours, undefined);
  assert.equal(plan.students[0].lessonPackages, undefined);
  assert.deepEqual(plan.students[0].historicalJwbSnapshot?.currentAggregate, {
    remainingHours: 9,
    contractHours: 12,
    jwbSourceRow: 101,
  });
});

test("assigns stable student numbers from the first JWB hour-entry date and preserves prior numbers", () => {
  const plan = buildStudentImportPlan({
    masterRows: [master(2, "Later Source"), master(1, "Earlier Source")],
    jwbRows: [
      { ...jwb(102, "Later Source", 4, 12), firstJwbHourEntryDate: "2026-08-17" },
      { ...jwb(101, "Earlier Source", 4, 12), firstJwbHourEntryDate: "2026-08-17" },
    ],
    assignStudentNumbers: true,
  });
  const first = plan.students.find((student) => student.sourceRow === 1);
  const second = plan.students.find((student) => student.sourceRow === 2);
  assert.equal(first?.studentNumber, "20260817001");
  assert.equal(second?.studentNumber, "20260817002");

  const replay = buildStudentImportPlan({
    masterRows: [master(2, "Later Source"), master(1, "Earlier Source")],
    jwbRows: [
      { ...jwb(102, "Later Source", 4, 12), firstJwbHourEntryDate: "2026-08-17" },
      { ...jwb(101, "Earlier Source", 4, 12), firstJwbHourEntryDate: "2026-08-17" },
    ],
    existingStudents: plan.students,
    assignStudentNumbers: true,
  });
  assert.equal(replay.students.find((student) => student.sourceRow === 1)?.studentNumber, "20260817001");
  assert.equal(replay.students.find((student) => student.sourceRow === 2)?.studentNumber, "20260817002");
});

test("rejects a malformed present JWB number date instead of falling back to the formal import day", () => {
  assert.throws(() => buildStudentImportPlan({
    masterRows: [master(1, "Bad JWB Number Date")],
    jwbRows: [{
      ...jwb(101, "Bad JWB Number Date", 4, 12),
      firstJwbHourEntryDate: "2026-02-30",
    }],
    assignStudentNumbers: true,
    formalImportDate: "2026-08-18",
  }), (error: unknown) => error instanceof StudentImportError
    && error.code === "invalid_hours");

});

test("rejects duplicate JWB source rows before identity matching", () => {
  assert.throws(() => buildStudentImportPlan({
    masterRows: [master(1, "Duplicate JWB Source")],
    jwbRows: [
      jwb(101, "Duplicate JWB Source", 4, 12),
      jwb(101, "Different JWB Person", 8, 12),
    ],
  }), (error: unknown) => error instanceof StudentImportError
    && error.code === "duplicate_jwb_source_key");
});

test("reserves numbers for removed historical IDs and uses JavaScript UTF-16 ordering", () => {
  const returningId = studentIdForMasterSource(1, "student-number-reservation-fixture");
  const reservationPlan = buildStudentImportPlan({
    masterRows: [master(1, "Returning Learner"), master(2, "New Learner")],
    jwbRows: [
      { ...jwb(101, "Returning Learner", 4, 12), firstJwbHourEntryDate: "2026-08-17" },
      { ...jwb(102, "New Learner", 4, 12), firstJwbHourEntryDate: "2026-08-17" },
    ],
    masterSourceNamespace: "student-number-reservation-fixture",
    studentNumberReservations: [{ studentId: returningId, studentNumber: "20260817007" }],
    assignStudentNumbers: true,
  });
  assert.equal(reservationPlan.students.find((student) => student.sourceRow === 1)?.studentNumber, "20260817007");
  assert.equal(reservationPlan.students.find((student) => student.sourceRow === 2)?.studentNumber, "20260817008");

  // JS compares UTF-16 code units: 😀 starts with D83D and therefore sorts
  // before BMP private-use E000. PostgreSQL C collation would do the reverse.
  const utf16Plan = buildStudentImportPlan({
    masterRows: [master(11, "BMP Learner"), master(12, "Emoji Learner")],
    jwbRows: [
      { ...jwb(111, "BMP Learner", 4, 12), firstJwbHourEntryDate: "2026-08-18" },
      { ...jwb(112, "Emoji Learner", 4, 12), firstJwbHourEntryDate: "2026-08-18" },
    ],
    existingStudents: [
      { id: "STU-\uE000", name: "BMP Learner" },
      { id: "STU-😀", name: "Emoji Learner" },
    ],
    identityLinks: [
      { masterSourceRow: 11, jwbSourceRow: 111, studentId: "STU-\uE000" },
      { masterSourceRow: 12, jwbSourceRow: 112, studentId: "STU-😀" },
    ],
    assignStudentNumbers: true,
  });
  assert.equal(utf16Plan.students.find((student) => student.id === "STU-😀")?.studentNumber, "20260818001");
  assert.equal(utf16Plan.students.find((student) => student.id === "STU-\uE000")?.studentNumber, "20260818002");
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
  assert.equal(normalizeStudentImportName("ÉLODIE"), "Élodie");
  assert.equal(plan.summary.insert, 1);
  assert.equal(plan.summary.preservedManualTrials, 1);
  assert.equal(plan.students.length, 2);
  assert.equal(plan.students[0].name, "Avery Example");
  assert.equal(plan.students[0].status, "活跃 + 有课时");
  assert.equal(plan.students[0].jwbMatchStatus, "matched");
  assert.equal(plan.students[0].jwbSourceRow, undefined);
  assert.equal(plan.students[0].remainingHours, undefined);
  assert.equal(plan.students[0].contractHours, undefined);
  assert.deepEqual(plan.students[0].historicalJwbSnapshot?.currentAggregate, {
    remainingHours: 5.5,
    contractHours: 10,
    contractEffectiveDate: "2026-08-01",
    jwbSourceRow: 220,
  });
  assert.deepEqual(plan.students[1], {
    initials: "PT",
    owner: "待分配",
    planner: "待分配",
    course: "待确认",
    timezone: "Australia/Melbourne",
    teacher: "待匹配",
    next: "核对课程、课包与老师",
    nextTone: "amber",
    files: 0,
    followUp: "未记录",
    ...manualTrial,
    importSource: "manual_trial",
  });
});

test("the sole identity key preserves Chinese punctuation and mixed-script order", () => {
  assert.notEqual(normalizeStudentImportName("张·三"), normalizeStudentImportName("张（三）"));
  assert.notEqual(normalizeStudentImportName("Alice 张三"), normalizeStudentImportName("张三 Alice"));
  assert.equal(normalizeStudentImportName("  Ａvery   Example  "), "avery example");
});

test("matches only exact full names after safe normalization", () => {
  const punctuationMismatch = buildStudentImportPlan({
    masterRows: [master(201, "张·三", "活跃 + 有课时")],
    jwbRows: [jwb(301, "张（三）", 5, 10)],
  });
  assert.equal(punctuationMismatch.students[0].jwbMatchStatus, "unmatched");
  assert.equal(punctuationMismatch.students[0].jwbSourceRow, undefined);
  assert.equal(punctuationMismatch.students[0].remainingHours, undefined);

  const safeExact = buildStudentImportPlan({
    masterRows: [master(202, " Ａvery   Example ", "活跃 + 有课时")],
    jwbRows: [jwb(302, "avery example", 5, 10)],
  });
  assert.equal(safeExact.students[0].jwbMatchStatus, "matched");
  assert.equal(safeExact.students[0].jwbSourceRow, undefined);
  assert.equal(safeExact.students[0].remainingHours, undefined);
  assert.deepEqual(safeExact.students[0].historicalJwbSnapshot?.currentAggregate, {
    remainingHours: 5,
    contractHours: 10,
    jwbSourceRow: 302,
  });

  const mixedAliases = buildStudentImportPlan({
    masterRows: [master(203, "Alice 张三", "在读")],
    jwbRows: [jwb(304, "张三 Alice", 5, 10)],
  });
  assert.equal(mixedAliases.students[0].jwbMatchStatus, "unmatched");
  assert.equal(mixedAliases.summary.ambiguous, 0);
  assert.equal(mixedAliases.students[0].jwbSourceRow, undefined);
});

test("replays only the reviewed one-way JWB trailing-Latin annotation exception", () => {
  assert.equal(studentImportJwbLatinParentheticalAnnotationKey("Learner(VIC)"), "learner");
  assert.equal(studentImportJwbLatinParentheticalAnnotationKey("Learner（VIC）"), "learner");
  for (const unsafe of [
    "Learner(G10)",
    "Learner(É)",
    "Learner(AB CD)",
    "Learner(VIC)(NSW)",
    "(VIC)Learner",
    "Learner(中文)",
    "Learner(VIC) suffix",
    "Learner",
  ]) {
    assert.equal(studentImportJwbLatinParentheticalAnnotationKey(unsafe), "");
  }
  assert.equal(isStudentImportJwbLatinParentheticalAnnotationMatch("Learner", "Learner(VIC)"), true);
  assert.equal(isStudentImportJwbLatinParentheticalAnnotationMatch("Learner(VIC)", "Learner(VIC)"), false);

  const linked = buildStudentImportPlan({
    masterRows: [master(210, "Learner")],
    jwbRows: [jwb(310, "Learner(VIC)", 5, 10)],
    identityLinks: [{
      masterSourceRow: 210,
      jwbSourceRow: 310,
      studentId: studentIdForMasterSource(210),
      matchStrategy: STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1,
    }],
  });
  assert.equal(linked.students[0].jwbMatchStatus, "matched");
  assert.equal(linked.students[0].jwbSourceRow, undefined);
  assert.deepEqual(linked.students[0].historicalJwbSnapshot?.currentAggregate, {
    remainingHours: 5,
    contractHours: 10,
    jwbSourceRow: 310,
  });

  for (const jwbName of ["Learner(G10)", "Learner(中文)"]) {
    const downgraded = buildStudentImportPlan({
      masterRows: [master(211, "Learner")],
      jwbRows: [jwb(311, jwbName, 5, 10)],
      identityLinks: [{
        masterSourceRow: 211,
        jwbSourceRow: 311,
        studentId: studentIdForMasterSource(211),
        matchStrategy: STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1,
      }],
    });
    assert.equal(downgraded.students[0].jwbMatchStatus, "unmatched");
    assert.equal(downgraded.students[0].jwbSourceRow, undefined);
    assert.equal(downgraded.students[0].remainingHours, undefined);
  }

  const collisionDowngraded = buildStudentImportPlan({
    masterRows: [master(212, "Learner")],
    jwbRows: [jwb(312, "Learner(VIC)", 5, 10), jwb(313, "Learner", 5, 10)],
    identityLinks: [{
      masterSourceRow: 212,
      jwbSourceRow: 312,
      studentId: studentIdForMasterSource(212),
      matchStrategy: STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1,
    }],
  });
  assert.equal(collisionDowngraded.students[0].jwbMatchStatus, "unmatched");
  assert.equal(collisionDowngraded.students[0].remainingHours, undefined);

  const exactStrategyDowngraded = buildStudentImportPlan({
    masterRows: [master(213, "Learner(VIC)")],
    jwbRows: [jwb(314, "Learner(VIC)", 5, 10)],
    identityLinks: [{
      masterSourceRow: 213,
      jwbSourceRow: 314,
      studentId: studentIdForMasterSource(213),
      matchStrategy: STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1,
    }],
  });
  assert.equal(exactStrategyDowngraded.students[0].jwbMatchStatus, "unmatched");

  // A validated reviewed annotation remains safe supplemental evidence even
  // when the master supplies the same JWB account ID.
  const memberIdAnnotation = buildStudentImportPlan({
    masterRows: [{ sourceRow: 219, name: "Learner", status: "在读", jwbMemId: 319 }],
    jwbRows: [jwb(319, "Learner(VIC)", 5, 10)],
    identityLinks: [{
      masterSourceRow: 219,
      jwbSourceRow: 319,
      studentId: studentIdForMasterSource(219),
      matchStrategy: STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1,
    }],
  });
  assert.equal(memberIdAnnotation.students[0].jwbMatchStatus, "matched");
  assert.equal(memberIdAnnotation.students[0].historicalJwbSnapshot?.currentAggregate?.jwbSourceRow, 319);

  // A collision invalidates the optional annotation leg; it must not attach,
  // but the authoritative master records still import.
  const masterShadowDowngraded = buildStudentImportPlan({
    masterRows: [master(214, "Learner"), master(215, "Learner(VIC)")],
    jwbRows: [jwb(315, "Learner(VIC)", 5, 10)],
    identityLinks: [{
      masterSourceRow: 214,
      jwbSourceRow: 315,
      studentId: studentIdForMasterSource(214),
      matchStrategy: STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1,
    }],
  });
  assert.equal(masterShadowDowngraded.students.find((student) => student.sourceRow === 214)?.jwbMatchStatus, "unmatched");

  // An existing literal annotation similarly prevents JWB enrichment without
  // blocking the distinct master source row.
  const existingShadowDowngraded = buildStudentImportPlan({
    masterRows: [master(216, "Learner")],
    jwbRows: [jwb(316, "Learner(VIC)", 5, 10)],
    existingStudents: [{ id: "STU-ANNOTATED-LEARNER", name: "Learner(VIC)", status: "在读" }],
    identityLinks: [{
      masterSourceRow: 216,
      jwbSourceRow: 316,
      studentId: studentIdForMasterSource(216),
      matchStrategy: STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1,
    }],
  });
  assert.equal(existingShadowDowngraded.students[0].jwbMatchStatus, "unmatched");

  // A parenthesized master row is not eligible for the annotation exception,
  // but its deterministic system ID is still reserved. A link must not borrow
  // that ID through an otherwise exact current-student name match.
  assert.throws(() => buildStudentImportPlan({
    masterRows: [master(217, "Learner"), master(218, "Other(VIC)")],
    jwbRows: [jwb(317, "Learner(VIC)", 5, 10)],
    existingStudents: [{
      id: studentIdForMasterSource(218),
      name: "Learner",
      status: "在读",
    }],
    identityLinks: [{
      masterSourceRow: 217,
      jwbSourceRow: 317,
      studentId: studentIdForMasterSource(218),
      matchStrategy: STUDENT_IMPORT_JWB_LATIN_PARENTHETICAL_ANNOTATION_V1,
    }],
  }), (error: unknown) => error instanceof StudentImportError
    && error.code === "invalid_identity_link");
});

test("master JWB member IDs only disambiguate otherwise exact full-name JWB rows", () => {
  const plan = buildStudentImportPlan({
    masterRows: [{
      sourceRow: "master-with-jwb-id",
      name: " Ａvery   Example ",
      status: "在读",
      jwbMemId: "  JWB-SECOND  ",
    }],
    jwbRows: [
      { sourceRow: "JWB-FIRST", name: "avery example", remainingHours: 3, contractHours: 6 },
      { sourceRow: "JWB-SECOND", name: "avery example", remainingHours: 7, contractHours: 12 },
    ],
  });

  assert.equal(plan.students[0].jwbMatchStatus, "matched");
  assert.equal(plan.students[0].jwbSourceRow, undefined);
  assert.equal(plan.students[0].remainingHours, undefined);
  assert.deepEqual(plan.students[0].historicalJwbSnapshot?.currentAggregate, {
    remainingHours: 7,
    contractHours: 12,
    jwbSourceRow: "JWB-SECOND",
  });
  assert.equal(plan.summary.ambiguous, 0);
  assert.deepEqual(plan.unmatched, [{
    source: "jwb",
    sourceRow: "JWB-FIRST",
    name: "avery example",
    reason: "not_in_master",
  }]);
});

test("invalid JWB member IDs suppress enrichment but never suppress the master student", () => {
  const base = {
    masterRows: [{ sourceRow: "M-1", name: "Exact Learner", status: "在读", jwbMemId: "J-1" }],
    jwbRows: [{ sourceRow: "J-1", name: "exact learner", remainingHours: 2, contractHours: 4 }],
  } as const;

  const unknownId = buildStudentImportPlan({
    ...base,
    masterRows: [{ ...base.masterRows[0], jwbMemId: "MISSING" }],
    assignStudentNumbers: true,
    formalImportDate: "2026-08-18",
  });
  assert.equal(unknownId.students[0].jwbMatchStatus, "unmatched");
  assert.equal(unknownId.students[0].jwbSourceRow, undefined);
  assert.equal(unknownId.students[0].remainingHours, undefined);
  assert.equal(unknownId.students[0].studentNumber, "20260818001");
  assert.equal(unknownId.students[0].studentNumberDateSource, "formal_import_date");
  assert.equal(unknownId.unmatched.some((entry) => entry.reason === "invalid_jwb_member_id"), true);

  const inactiveUnknownId = buildStudentImportPlan({
    masterRows: [{
      sourceRow: "M-EXCLUDED",
      name: "Excluded Learner",
      status: "不活跃 + 无课时",
      jwbMemId: "MISSING",
    }],
    jwbRows: base.jwbRows,
  });
  assert.equal(inactiveUnknownId.students[0].status, "不活跃 + 无课时");
  assert.equal(inactiveUnknownId.students[0].jwbMatchStatus, "unmatched");

  const crossName = buildStudentImportPlan({
    ...base,
    jwbRows: [{ ...base.jwbRows[0], name: "Different Learner" }],
  });
  assert.equal(crossName.students[0].jwbMatchStatus, "unmatched");
  assert.equal(crossName.students[0].historicalJwbSnapshot, undefined);

  assert.throws(() => buildStudentImportPlan({
    masterRows: [
      { sourceRow: "M-1", name: "Exact Learner", status: "在读", jwbMemId: "J-1" },
      { sourceRow: "M-2", name: "Another Learner", status: "在读", jwbMemId: "J-1" },
    ],
    jwbRows: [{ sourceRow: "J-1", name: "Exact Learner", remainingHours: 2, contractHours: 4 }],
  }), (error: unknown) => error instanceof StudentImportError
    && error.code === "duplicate_master_jwb_member_id");

  const reviewedConflict = buildStudentImportPlan({
    ...base,
    jwbRows: [
      ...base.jwbRows,
      { sourceRow: "J-2", name: "exact learner", remainingHours: 5, contractHours: 8 },
    ],
    identityLinks: [{
      masterSourceRow: "M-1",
      jwbSourceRow: "J-2",
      studentId: studentIdForMasterSource("M-1"),
    }],
  });
  assert.equal(reviewedConflict.students[0].jwbMatchStatus, "matched");
  assert.equal(reviewedConflict.students[0].historicalJwbSnapshot?.currentAggregate?.jwbSourceRow, "J-1");

  const reviewedCrossNameExisting = buildStudentImportPlan({
    masterRows: [{ sourceRow: "M-3", name: "Exact Learner", status: "在读", jwbMemId: "J-3" }],
    jwbRows: [{ sourceRow: "J-3", name: "Different Learner", remainingHours: 4, contractHours: 8 }],
    existingStudents: [{ id: "STU-EXACT", name: "Exact Learner", status: "在读" }],
    identityLinks: [{ masterSourceRow: "M-3", jwbSourceRow: "J-3", studentId: "STU-EXACT" }],
  });
  assert.equal(reviewedCrossNameExisting.students[0].id, "STU-EXACT");
  assert.equal(reviewedCrossNameExisting.students[0].jwbMatchStatus, "unmatched");
  assert.equal(reviewedCrossNameExisting.students[0].remainingHours, undefined);
});

test("student initials never split Unicode characters and use cross-runtime ASCII case folding", () => {
  const plan = buildStudentImportPlan({
    masterRows: [
      master(1, "😀 Beta"),
      master(2, "A 😀"),
      master(3, "𐐷 Foo"),
      master(4, "alice smith"),
    ],
    jwbRows: [],
    masterSourceNamespace: "unicode-initials",
    allowLegacyIdentityFallback: false,
  });

  assert.deepEqual(plan.students.map((student) => student.initials), ["😀B", "A😀", "𐐷F", "AS"]);
  for (const student of plan.students) {
    const initials = String(student.initials);
    for (let index = 0; index < initials.length; index += 1) {
      const unit = initials.charCodeAt(index);
      if (unit >= 0xD800 && unit <= 0xDBFF) {
        assert.ok(index + 1 < initials.length);
        const next = initials.charCodeAt(index + 1);
        assert.ok(next >= 0xDC00 && next <= 0xDFFF);
        index += 1;
      } else {
        assert.ok(unit < 0xDC00 || unit > 0xDFFF);
      }
    }
  }
});

test("orders source rows by JavaScript UTF-16 code units", () => {
  const plan = buildStudentImportPlan({
    masterRows: [
      { sourceRow: "\uE000", name: "Private Use Learner", status: "在读" },
      { sourceRow: "😀", name: "Emoji Learner", status: "在读" },
    ],
    jwbRows: [],
    masterSourceNamespace: "utf16-source-order",
    allowLegacyIdentityFallback: false,
  });

  assert.deepEqual(plan.students.map((student) => student.sourceRow), ["😀", "\uE000"]);
});

test("new imported students receive the complete runtime contract and map master year to grade", () => {
  const plan = buildStudentImportPlan({
    masterRows: [master(21, "Sydney Learner", "在读", {
      location: "NSW",
      year: "Year 8",
      owner: "Molly",
      planner: "Tara",
    })],
    jwbRows: [],
  });

  assert.deepEqual(plan.students[0], {
    initials: "SL",
    owner: "Molly",
    planner: "Tara",
    course: "待确认",
    timezone: "Australia/Sydney",
    teacher: "待匹配",
    next: "核对课程、课包与老师",
    nextTone: "amber",
    files: 0,
    segment: "已报名",
    followUp: "未记录",
    location: "NSW",
    grade: "Year 8",
    year: "Year 8",
    id: plan.students[0].id,
    name: "Sydney Learner",
    status: "在读",
    sourceRow: 21,
    masterSourceKey: "21",
    importSource: "master",
    jwbMatchStatus: "unmatched",
  });
});

test("keeps a referenced inactive master student as its normal formal record", () => {
  const historical: ExistingStudentImportRecord = {
    id: "STU-HISTORICAL-1",
    name: "Historical Learner",
    initials: "HL",
    status: "在读",
    owner: "Abby",
    course: "English",
    timezone: "Australia/Melbourne",
    teacher: "Legacy Teacher",
    next: "Old active reminder",
    nextTone: "red",
    files: 2,
    sourceRow: 44,
  };
  const input = {
    masterRows: [master(44, "Historical Learner", "不活跃 + 无课时")],
    jwbRows: [] as JwbStudentImportRow[],
    preserveReferencedStudentIds: [historical.id],
  };
  const first = buildStudentImportPlan({ ...input, existingStudents: [historical] });
  const imported = first.students[0];

  assert.equal(first.summary.excluded, 0);
  assert.equal(first.summary.preservedReferencedArchived, 0);
  assert.equal(first.summary.update, 1);
  assert.equal(imported.id, historical.id);
  assert.equal(imported.status, "不活跃 + 无课时");
  assert.equal(imported.importArchived, undefined);
  assert.equal(imported.importArchivedReason, undefined);

  const second = buildStudentImportPlan({ ...input, existingStudents: first.students });
  assert.deepEqual(second.students, first.students);
  assert.equal(second.summary.preservedReferencedArchived, 0);
  assert.equal(second.summary.update, 0);
  assert.equal(second.summary.unchanged, 1);
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

test("canonicalises purchase timestamps to JavaScript millisecond precision", () => {
  const plan = buildStudentImportPlan({
    masterRows: [master(84, "Timestamp Learner", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 884,
      name: "Timestamp Learner",
      remainingHours: 1,
      contractHours: 1,
      packageCoverage: "complete",
      lessonPackages: [{
        sourcePackageId: "timestamp-package",
        name: "Timestamp package",
        subjectIds: ["English"],
        purchaseRecords: [{
          sourcePurchaseId: "timestamp-purchase",
          purchasedAt: "2026-01-02T03:04:05.123999Z",
          hours: 1,
        }],
        consumedHours: 0,
      }],
    }],
  });

  assert.equal(
    plan.students[0].lessonPackages?.[0].purchaseRecords[0].purchasedAt,
    "2026-01-02T03:04:05.123Z",
  );
});

test("rejects JWB values that are not exact integer micro-hours", () => {
  assert.throws(() => buildStudentImportPlan({
    masterRows: [master(86, "Precision Learner", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 886,
      name: "Precision Learner",
      remainingHours: 0.0001245,
      contractHours: 1,
    }],
  }), (error: unknown) => error instanceof StudentImportError && error.code === "invalid_hours");

  assert.throws(() => buildStudentImportPlan({
    masterRows: [master(86, "Precision Learner", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 886,
      name: "Precision Learner",
      remainingHours: 1,
      contractHours: 1,
      packageCoverage: "complete",
      lessonPackages: [{
        sourcePackageId: "precision-package",
        name: "Precision package",
        subjectIds: ["English"],
        purchaseRecords: [{
          sourcePurchaseId: "precision-purchase",
          purchasedAt: "2026-01-01",
          hours: 0.0001245,
        }],
        consumedHours: 0,
      }],
    }],
  }), (error: unknown) => error instanceof StudentImportError && error.code === "invalid_hours");
});

test("sums large package ledgers as safe integer micro-hours", () => {
  const purchaseRecords = Array.from({ length: 1_000 }, (_, index) => ({
    sourcePurchaseId: `precision-purchase-${index}`,
    purchasedAt: "2026-01-01",
    hours: 90_000.000001,
  }));
  const plan = buildStudentImportPlan({
    masterRows: [master(861, "Aggregate Precision Learner", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 8861,
      name: "Aggregate Precision Learner",
      remainingHours: 1,
      contractHours: 90_000_000.001,
      packageCoverage: "complete",
      lessonPackages: [{
        sourcePackageId: "precision-package",
        name: "Precision package",
        subjectIds: ["English"],
        purchaseRecords,
        consumedHours: 89_999_999.001,
      }],
    }],
  });

  assert.equal(plan.students[0].contractHours, 90_000_000.001);
  assert.equal(plan.students[0].remainingHours, 1);
});

test("matches JavaScript ASCII word boundaries when deriving timezones", () => {
  const plan = buildStudentImportPlan({
    masterRows: [{
      sourceRow: 87,
      name: "Timezone Learner",
      status: "在读",
      attributes: { location: "澳洲NSW" },
    }],
    jwbRows: [],
  });
  assert.equal(plan.students[0].timezone, "Australia/Sydney");
});

test("rejects normalized JWB rows that attach packages to a negative aggregate balance", () => {
  assert.throws(() => buildStudentImportPlan({
    masterRows: [master(9, "Overdrawn Learner", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 89,
      name: "Overdrawn Learner",
      remainingHours: -3,
      contractHours: 20,
      packageCoverage: "complete",
      lessonPackages: [{
        sourcePackageId: "package-overdrawn",
        name: "English package",
        subjectIds: ["English"],
        purchaseRecords: [{ sourcePurchaseId: "purchase-overdrawn", purchasedAt: "2026-01-01", hours: 20 }],
        consumedHours: 23,
      }],
    }],
  }), (error: unknown) => error instanceof StudentImportError
    && error.code === "package_balance_mismatch");
});

test("partial package coverage activates only verified packages and snapshots aggregate totals", () => {
  const plan = buildStudentImportPlan({
    masterRows: [master(10, "Partial Learner", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 90,
      name: "Partial Learner",
      remainingHours: 17,
      contractHours: 25,
      packageCoverage: "partial",
      lessonPackages: [{
        sourcePackageId: "known-package",
        name: "English package",
        subjectIds: ["English"],
        purchaseRecords: [{ sourcePurchaseId: "known-purchase", purchasedAt: "2026-01-01", hours: 20 }],
        consumedHours: 6,
      }],
    }],
  });
  assert.equal(plan.students[0].remainingHours, 14);
  assert.equal(plan.students[0].contractHours, 20);
  assert.equal(plan.students[0].packageCoverage, "partial");
  assert.equal(plan.students[0].lessonPackages?.length, 1);
  assert.deepEqual(plan.students[0].historicalJwbSnapshot?.currentAggregate, {
    remainingHours: 17,
    contractHours: 25,
    packageCoverage: "partial",
    jwbSourceRow: 90,
  });
  assert.equal(plan.summary.importedPackages, 1);
  assert.equal(plan.summary.studentsMissingPackageData, 1);
});

test("JWB refresh replaces only managed JWB packages and always preserves manual packages", () => {
  const first = buildStudentImportPlan({
    masterRows: [master(11, "Mixed Packages", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 91,
      name: "Mixed Packages",
      remainingHours: 14,
      contractHours: 20,
      packageCoverage: "complete",
      lessonPackages: [{
        sourcePackageId: "old-jwb-source",
        name: "Old JWB package",
        subjectIds: ["English"],
        purchaseRecords: [{ sourcePurchaseId: "old-buy", purchasedAt: "2026-01-01", hours: 20 }],
        consumedHours: 6,
      }],
    }],
  });
  const manualPackage = {
    id: "PKG-MANUAL-KEEP",
    name: "Manual tutoring package",
    subjectIds: ["Writing"],
    purchaseRecords: [{ id: "BUY-MANUAL-KEEP", purchasedAt: "2026-02-01T00:00:00.000Z", hours: 5 }],
    consumedHours: 1,
  };
  const existing = [{ ...first.students[0], lessonPackages: [...first.students[0].lessonPackages!, manualPackage] }];
  const refreshed = buildStudentImportPlan({
    masterRows: [master(11, "Mixed Packages", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 91,
      name: "Mixed Packages",
      remainingHours: 8,
      contractHours: 12,
      packageCoverage: "complete",
      lessonPackages: [{
        sourcePackageId: "new-jwb-source",
        name: "New JWB package",
        subjectIds: ["Math"],
        purchaseRecords: [{ sourcePurchaseId: "new-buy", purchasedAt: "2026-03-01", hours: 12 }],
        consumedHours: 4,
      }],
    }],
    existingStudents: existing,
  });
  assert.deepEqual(refreshed.students[0].lessonPackages?.map((item) => item.id).sort(), [
    "PKG-MANUAL-KEEP",
    lessonPackageIdForSource(first.students[0].id, "new-jwb-source"),
  ].sort());
  assert.equal(refreshed.students[0].lessonPackages?.some((item) => item.name === "Old JWB package"), false);
  assert.equal(refreshed.students[0].remainingHours, 8);
  assert.equal(refreshed.students[0].contractHours, 12);
  assert.equal(refreshed.summary.importedPackages, 1);

  const replay = buildStudentImportPlan({
    masterRows: [master(11, "Mixed Packages", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 91,
      name: "Mixed Packages",
      remainingHours: 8,
      contractHours: 12,
      packageCoverage: "complete",
      lessonPackages: [{
        sourcePackageId: "new-jwb-source",
        name: "New JWB package",
        subjectIds: ["Math"],
        purchaseRecords: [{ sourcePurchaseId: "new-buy", purchasedAt: "2026-03-01", hours: 12 }],
        consumedHours: 4,
      }],
    }],
    existingStudents: refreshed.students,
  });
  assert.deepEqual(replay.students, refreshed.students);
  assert.equal(replay.summary.unchanged, 1);
});

test("partial JWB refresh keeps old managed packages historical and only activates verified rows", () => {
  const studentId = "STU-PARTIAL-KEEP";
  const oldJwbId = lessonPackageIdForSource(studentId, "old-partial");
  const manual = {
    id: "MANUAL-PARTIAL-KEEP",
    name: "Manual package",
    subjectIds: ["Writing"],
    purchaseRecords: [{ id: "MANUAL-PARTIAL-BUY", purchasedAt: "2026-01-01T00:00:00.000Z", hours: 5 }],
    consumedHours: 1,
  };
  const plan = buildStudentImportPlan({
    masterRows: [master(13, "Partial Mixed", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 93,
      name: "Partial Mixed",
      remainingHours: 18,
      contractHours: 30,
      packageCoverage: "partial",
      lessonPackages: [{
        sourcePackageId: "new-partial",
        name: "New partial JWB",
        subjectIds: ["Math"],
        purchaseRecords: [{ sourcePurchaseId: "new-partial-buy", purchasedAt: "2026-02-01", hours: 20 }],
        consumedHours: 2,
      }],
    }],
    existingStudents: [{
      id: studentId,
      name: "Partial Mixed",
      status: "在读",
      sourceRow: 13,
      masterSourceKey: "13",
      importSource: "master",
      lessonPackages: [{
        id: oldJwbId,
        name: "Old partial JWB",
        subjectIds: ["English"],
        purchaseRecords: [{ id: "OLD-JWB-BUY", purchasedAt: "2026-01-01T00:00:00.000Z", hours: 10 }],
        consumedHours: 1,
      }, manual],
    }],
  });
  assert.deepEqual(plan.students[0].lessonPackages?.map((item) => item.id).sort(), [
    "MANUAL-PARTIAL-KEEP",
    lessonPackageIdForSource(studentId, "new-partial"),
  ].sort());
  assert.equal(plan.students[0].remainingHours, 18);
  assert.equal(plan.students[0].contractHours, 20);
  assert.deepEqual(plan.students[0].historicalJwbSnapshot?.retained?.lessonPackages?.map((item) => item.id), [oldJwbId]);
  assert.deepEqual(plan.students[0].historicalJwbSnapshot?.currentAggregate, {
    remainingHours: 18,
    contractHours: 30,
    packageCoverage: "partial",
    jwbSourceRow: 93,
  });
  assert.equal(plan.summary.importedPackages, 1);
  assert.equal(plan.summary.studentsMissingPackageData, 1);
});

test("aggregate-only refreshes move prior JWB ledgers into non-billable historical evidence", () => {
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
  assert.equal(refreshed.students[0].lessonPackages, undefined);
  assert.equal(refreshed.students[0].packageCoverage, undefined);
  assert.deepEqual(
    refreshed.students[0].historicalJwbSnapshot?.retained?.lessonPackages,
    withPackage.students[0].lessonPackages,
  );
  assert.deepEqual(refreshed.students[0].historicalJwbSnapshot?.currentAggregate, {
    remainingHours: 10,
    contractHours: 20,
    jwbSourceRow: 881,
  });

  const explicitNone = buildStudentImportPlan({
    masterRows: [master(81, "Aggregate Learner", "活跃 + 有课时")],
    jwbRows: [{ ...jwb(881, "Aggregate Learner", 10, 20), packageCoverage: "none" }],
    existingStudents: withPackage.students,
  });
  assert.equal(explicitNone.students[0].lessonPackages, undefined);
  assert.equal(explicitNone.students[0].packageCoverage, undefined);
  assert.equal(explicitNone.students[0].historicalJwbSnapshot?.currentAggregate?.packageCoverage, "none");
});

test("unmatched students retain JWB facts only in non-billable history", () => {
  const studentId = "STU-UNMATCHED-PACKAGES";
  const managedPackage = {
    id: lessonPackageIdForSource(studentId, "preserved-jwb"),
    name: "Preserved JWB package",
    subjectIds: ["English"],
    purchaseRecords: [{ id: "BUY-JWB-PRESERVED", purchasedAt: "2026-01-01T00:00:00.000Z", hours: 10 }],
    consumedHours: 4,
  };
  const manualPackage = {
    id: "PKG-MANUAL-UNMATCHED",
    name: "Manual package",
    subjectIds: ["Writing"],
    purchaseRecords: [{ id: "BUY-MANUAL-UNMATCHED", purchasedAt: "2026-02-01T00:00:00.000Z", hours: 2 }],
    consumedHours: 0,
  };
  const plan = buildStudentImportPlan({
    masterRows: [master(85, "Unmatched Package Learner", "活跃 + 有课时")],
    jwbRows: [],
    existingStudents: [{
      id: studentId,
      name: "Unmatched Package Learner",
      status: "活跃 + 有课时",
      sourceRow: 85,
      masterSourceKey: "85",
      importSource: "master",
      packageCoverage: "complete",
      lessonPackages: [managedPackage, manualPackage],
    }],
  });

  assert.deepEqual(plan.students[0].lessonPackages, [manualPackage]);
  assert.equal(plan.students[0].packageCoverage, undefined);
  assert.equal(plan.students[0].contractHours, undefined);
  assert.equal(plan.students[0].remainingHours, undefined);
  assert.deepEqual(plan.students[0].historicalJwbSnapshot?.retained?.lessonPackages, [managedPackage]);
  assert.equal(plan.students[0].historicalJwbSnapshot?.retained?.packageCoverage, "complete");
});

test("unmatched partial and none coverage move prior JWB aggregates to history", () => {
  const partialId = "STU-UNMATCHED-PARTIAL";
  const partial = buildStudentImportPlan({
    masterRows: [master(86, "Unmatched Partial Learner", "活跃 + 有课时")],
    jwbRows: [],
    existingStudents: [{
      id: partialId,
      name: "Unmatched Partial Learner",
      status: "活跃 + 有课时",
      sourceRow: 86,
      masterSourceKey: "86",
      importSource: "master",
      packageCoverage: "partial",
      contractHours: 30,
      remainingHours: 18,
      lessonPackages: [{
        id: lessonPackageIdForSource(partialId, "known-subset"),
        name: "Known subset",
        subjectIds: ["English"],
        purchaseRecords: [{ id: "BUY-KNOWN-SUBSET", purchasedAt: "2026-01-01T00:00:00.000Z", hours: 10 }],
        consumedHours: 4,
      }],
    }],
  });
  assert.equal(partial.students[0].packageCoverage, undefined);
  assert.equal(partial.students[0].contractHours, undefined);
  assert.equal(partial.students[0].remainingHours, undefined);
  assert.equal(partial.students[0].historicalJwbSnapshot?.retained?.packageCoverage, "partial");
  assert.equal(partial.students[0].historicalJwbSnapshot?.retained?.contractHours, 30);
  assert.equal(partial.students[0].historicalJwbSnapshot?.retained?.remainingHours, 18);
  assert.equal(partial.summary.studentsMissingPackageData, 1);

  const none = buildStudentImportPlan({
    masterRows: [master(87, "Unmatched Aggregate Learner", "活跃 + 无课时")],
    jwbRows: [],
    existingStudents: [{
      id: "STU-UNMATCHED-NONE",
      name: "Unmatched Aggregate Learner",
      status: "活跃 + 无课时",
      sourceRow: 87,
      masterSourceKey: "87",
      importSource: "master",
      packageCoverage: "none",
      contractHours: 20,
      remainingHours: -2,
    }],
  });
  assert.equal(none.students[0].packageCoverage, undefined);
  assert.equal(none.students[0].contractHours, undefined);
  assert.equal(none.students[0].remainingHours, undefined);
  assert.equal(none.students[0].historicalJwbSnapshot?.retained?.packageCoverage, "none");
  assert.equal(none.students[0].historicalJwbSnapshot?.retained?.contractHours, 20);
  assert.equal(none.students[0].historicalJwbSnapshot?.retained?.remainingHours, -2);
  assert.equal(none.summary.studentsMissingPackageData, 1);
});

test("preserves the JSON scalar type of a retained historical JWB source row", () => {
  const namespace = "numeric-historical-jwb";
  const existing: ExistingStudentImportRecord = {
    id: studentIdForMasterSource(1, namespace),
    name: "Numeric Historical JWB",
    status: "在读",
    importSource: "master",
    masterSourceKey: masterSourceKeyForSource(1, namespace),
    historicalJwbSnapshot: {
      currentAggregate: {
        remainingHours: 7,
        contractHours: 10,
        jwbSourceRow: 101,
      },
    },
  };
  const plan = buildStudentImportPlan({
    masterRows: [master(1, "Numeric Historical JWB")],
    jwbRows: [],
    existingStudents: [existing],
    masterSourceNamespace: namespace,
    allowLegacyIdentityFallback: false,
  });
  const sourceRow = plan.students[0].historicalJwbSnapshot?.currentAggregate?.jwbSourceRow;
  assert.equal(sourceRow, 101);
  assert.equal(typeof sourceRow, "number");
});

test("manual package IDs are scoped to their student", () => {
  const sharedPackageId = "PKG-MANUAL-SHARED";
  const manualPackage = (purchaseId: string) => ({
    id: sharedPackageId,
    name: "Manual package",
    subjectIds: ["Writing"],
    purchaseRecords: [{ id: purchaseId, purchasedAt: "2026-01-01T00:00:00.000Z", hours: 2 }],
    consumedHours: 0,
  });
  const plan = buildStudentImportPlan({
    masterRows: [],
    jwbRows: [],
    existingStudents: [{
      id: "TRIAL-A",
      name: "Trial A",
      status: "在读 + 加课待排",
      segment: "试听",
      importSource: "manual_trial",
      lessonPackages: [manualPackage("BUY-MANUAL-A")],
    }, {
      id: "TRIAL-B",
      name: "Trial B",
      status: "在读 + 加课待排",
      segment: "试听",
      importSource: "manual_trial",
      lessonPackages: [manualPackage("BUY-MANUAL-B")],
    }],
  });

  assert.deepEqual(
    plan.students.map((student) => student.lessonPackages?.[0].id),
    [sharedPackageId, sharedPackageId],
  );
  assert.equal(plan.summary.preservedManualTrials, 2);
});

test("coverage none clears active JWB facts but retains them as historical evidence", () => {
  const seeded = buildStudentImportPlan({
    masterRows: [master(12, "None Coverage", "活跃 + 有课时")],
    jwbRows: [{
      sourceRow: 92,
      name: "None Coverage",
      remainingHours: 5,
      contractHours: 10,
      packageCoverage: "complete",
      lessonPackages: [{
        sourcePackageId: "stale-jwb",
        name: "Stale JWB",
        subjectIds: ["English"],
        purchaseRecords: [{ sourcePurchaseId: "stale-buy", purchasedAt: "2026-01-01", hours: 10 }],
        consumedHours: 5,
      }],
    }],
  });
  const manual = {
    id: "CUSTOM-PACKAGE",
    name: "Manual package",
    subjectIds: ["Writing"],
    purchaseRecords: [{ id: "CUSTOM-BUY", purchasedAt: "2026-01-01T00:00:00.000Z", hours: 3 }],
    consumedHours: 0,
  };
  const next = buildStudentImportPlan({
    masterRows: [master(12, "None Coverage", "活跃 + 有课时")],
    jwbRows: [{ ...jwb(92, "None Coverage", -2, 10), packageCoverage: "none" }],
    existingStudents: [{ ...seeded.students[0], lessonPackages: [...seeded.students[0].lessonPackages!, manual] }],
  });
  assert.deepEqual(next.students[0].lessonPackages, [manual]);
  assert.equal(next.students[0].remainingHours, undefined);
  assert.equal(next.students[0].contractHours, undefined);
  assert.deepEqual(next.students[0].historicalJwbSnapshot?.retained?.lessonPackages,
    seeded.students[0].lessonPackages);
  assert.deepEqual(next.students[0].historicalJwbSnapshot?.currentAggregate, {
    remainingHours: -2,
    contractHours: 10,
    packageCoverage: "none",
    jwbSourceRow: 92,
  });
  assert.equal(next.summary.importedPackages, 0);
  assert.equal(next.summary.studentsMissingPackageData, 1);
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
  assert.equal(plan.students[0].remainingHours, undefined);
  assert.deepEqual(plan.students[0].historicalJwbSnapshot?.currentAggregate, {
    remainingHours: 7,
    contractHours: 10,
    jwbSourceRow: 311,
  });
  assert.equal(plan.excluded[0].reason, "empty_name");
});

test("a historical reviewed link with non-exact JWB name fails closed without changing the record", () => {
  const existing: ExistingStudentImportRecord = {
    id: "STU-STABLE-LINK",
    name: "Previous CRM Display Name",
    status: "在读",
    sourceRow: "legacy-row-99",
    masterSourceKey: "legacy-master-key",
    importSource: "master",
    remainingHours: 1,
  };
  assert.throws(() => buildStudentImportPlan({
    masterRows: [{ sourceRow: "master-2026-17", name: "Current Master Display Name", status: "活跃 + 有课时" }],
    jwbRows: [{
      sourceRow: "jwb-member-501",
      name: "Completely Different JWB Name",
      remainingHours: 9,
      contractHours: 15,
    }],
    existingStudents: [existing],
    masterSourceNamespace: "master-sheet:students:v2",
    allowLegacyIdentityFallback: false,
    identityLinks: [{
      masterSourceRow: "master-2026-17",
      studentId: "STU-STABLE-LINK",
      jwbSourceRow: "jwb-member-501",
    }],
  }), (error: unknown) => error instanceof StudentImportError
    && error.code === "identity_link_name_mismatch");
});

test("a historical reviewed merge with a non-exact current name fails closed", () => {
  assert.throws(() => buildStudentImportPlan({
    masterRows: [{ sourceRow: "master-current-name", name: "Exact Learner", status: "在读" }],
    jwbRows: [{ sourceRow: "jwb-current-name", name: "exact learner", remainingHours: 2, contractHours: 4 }],
    existingStudents: [{ id: "STU-OLD-NAME", name: "Legacy Alias", status: "在读" }],
    identityLinks: [{
      masterSourceRow: "master-current-name",
      jwbSourceRow: "jwb-current-name",
      studentId: "STU-OLD-NAME",
    }],
  }), (error: unknown) => error instanceof StudentImportError
    && error.code === "identity_link_name_mismatch");
});

test("a reviewed create link may use only the exact namespaced derived identity", () => {
  const namespace = "master-reviewed-create";
  const sourceRow = "M-CREATE-1";
  const derivedId = studentIdForMasterSource(sourceRow, namespace);
  const input = {
    masterRows: [{ sourceRow, name: "Alice 张三", status: "在读" }],
    jwbRows: [{ sourceRow: "J-CREATE-1", name: "alice 张三", remainingHours: 2, contractHours: 4 }],
    existingStudents: [],
    masterSourceNamespace: namespace,
    allowLegacyIdentityFallback: false,
  } as const;
  const plan = buildStudentImportPlan({
    ...input,
    identityLinks: [{
      masterSourceRow: sourceRow,
      jwbSourceRow: "J-CREATE-1",
      studentId: derivedId,
    }],
  });
  assert.equal(plan.students[0].id, derivedId);
  assert.equal(plan.students[0].jwbMatchStatus, "matched");
  assert.equal(plan.actions[0].kind, "insert");

  assert.throws(() => buildStudentImportPlan({
    ...input,
    identityLinks: [{
      masterSourceRow: sourceRow,
      jwbSourceRow: "J-CREATE-1",
      studentId: "STU-CLIENT-CHOSEN",
    }],
  }), (error: unknown) => error instanceof StudentImportError
    && error.code === "invalid_identity_link");
});

test("linked rows are consumed before conservative name ambiguity and unmatched reporting", () => {
  const existing: ExistingStudentImportRecord = {
    id: "STU-LINKED-DUPLICATE-NAME",
    name: "Shared Source Name",
    status: "在读",
  };
  const plan = buildStudentImportPlan({
    masterRows: [
      master(61, "Shared Source Name"),
      master(62, "Shared Source Name"),
    ],
    jwbRows: [
      jwb(610, "Shared Source Name", 4, 10),
      jwb(620, "Shared Source Name", 7, 12),
    ],
    existingStudents: [existing],
    identityLinks: [{ masterSourceRow: 61, studentId: existing.id, jwbSourceRow: 610 }],
  });

  assert.equal(plan.students.find((student) => student.id === existing.id)?.remainingHours, undefined);
  assert.equal(plan.students.find((student) => student.sourceRow === 62)?.remainingHours, undefined);
  assert.equal(
    plan.students.find((student) => student.id === existing.id)
      ?.historicalJwbSnapshot?.currentAggregate?.remainingHours,
    4,
  );
  assert.equal(
    plan.students.find((student) => student.sourceRow === 62)
      ?.historicalJwbSnapshot?.currentAggregate?.remainingHours,
    7,
  );
  assert.deepEqual(plan.unmatched, []);
  assert.deepEqual(plan.ambiguous, []);
});

test("rejects duplicate and unknown server identity links", () => {
  const existing = [
    { id: "STU-LINK-A", name: "Master A", status: "在读" },
    { id: "STU-LINK-B", name: "Master B", status: "在读" },
  ] satisfies ExistingStudentImportRecord[];
  const base = {
    masterRows: [master(71, "Master A"), master(72, "Master B")],
    jwbRows: [jwb(710, "master a", 1, 2), jwb(720, "master b", 2, 3)],
    existingStudents: existing,
  };
  const duplicateMasterOrStudentCases = [
    [
      { masterSourceRow: 71, studentId: "STU-LINK-A", jwbSourceRow: 710 },
      { masterSourceRow: 71, studentId: "STU-LINK-B", jwbSourceRow: 720 },
    ],
    [
      { masterSourceRow: 71, studentId: "STU-LINK-A", jwbSourceRow: 710 },
      { masterSourceRow: 72, studentId: "STU-LINK-A", jwbSourceRow: 720 },
    ],
  ];
  for (const identityLinks of duplicateMasterOrStudentCases) {
    assert.throws(
      () => buildStudentImportPlan({ ...base, identityLinks }),
      (error: unknown) => error instanceof StudentImportError && error.code === "duplicate_identity_link",
    );
  }

  const unknownMasterOrStudentCases = [
    [{ masterSourceRow: 999, studentId: "STU-LINK-A", jwbSourceRow: 710 }],
    [{ masterSourceRow: 71, studentId: "STU-UNKNOWN", jwbSourceRow: 710 }],
  ];
  for (const identityLinks of unknownMasterOrStudentCases) {
    assert.throws(
      () => buildStudentImportPlan({ ...base, identityLinks }),
      (error: unknown) => error instanceof StudentImportError && error.code === "invalid_identity_link",
    );
  }

  const staleOptionalJwb = buildStudentImportPlan({
    ...base,
    identityLinks: [{ masterSourceRow: 71, studentId: "STU-LINK-A", jwbSourceRow: 999 }],
  });
  assert.equal(staleOptionalJwb.students.find((student) => student.id === "STU-LINK-A")?.jwbMatchStatus, "unmatched");
  assert.equal(staleOptionalJwb.students.find((student) => student.id === "STU-LINK-A")?.remainingHours, undefined);

  const duplicateOptionalJwb = buildStudentImportPlan({
    ...base,
    identityLinks: [
      { masterSourceRow: 71, studentId: "STU-LINK-A", jwbSourceRow: 710 },
      { masterSourceRow: 72, studentId: "STU-LINK-B", jwbSourceRow: 710 },
    ],
  });
  assert.equal(duplicateOptionalJwb.students.every((student) => student.jwbMatchStatus === "unmatched"), true);
  assert.equal(duplicateOptionalJwb.students.every((student) => student.remainingHours === undefined), true);
});

test("master namespaces produce stable identities without trusting a colliding legacy sourceRow", () => {
  const legacy: ExistingStudentImportRecord = {
    id: "STU-LEGACY-ROW-COLLISION",
    name: "Unrelated Legacy Student",
    status: "在读",
    sourceRow: 81,
    importSource: "master",
  };
  const namespace = "master-sheet:authoritative:v3";
  const input = {
    masterRows: [master(81, "New Namespaced Student")],
    jwbRows: [],
    existingStudents: [legacy],
    masterSourceNamespace: namespace,
  };
  const first = buildStudentImportPlan(input);
  const expectedId = studentIdForMasterSource(81, namespace);
  const expectedKey = masterSourceKeyForSource(81, namespace);

  assert.equal(first.students[0].id, expectedId);
  assert.notEqual(first.students[0].id, legacy.id);
  assert.equal(first.students[0].masterSourceKey, expectedKey);
  assert.notEqual(first.students[0].masterSourceKey, "81");
  assert.notEqual(expectedId, studentIdForMasterSource(81));
  assert.notEqual(expectedId, studentIdForMasterSource(81, "another-master"));
  assert.equal(first.summary.insert, 1);

  const replay = buildStudentImportPlan({ ...input, existingStudents: first.students });
  assert.equal(replay.students[0].id, expectedId);
  assert.equal(replay.summary.unchanged, 1);
});

test("formal identity ignores legacy row and name collisions but replays the exact current namespace id", () => {
  const namespace = "authoritative-master:students:2026";
  const rawRowCollision: ExistingStudentImportRecord = {
    id: "STU-LEGACY-ROW-32",
    name: "Different Legacy Person",
    status: "在读",
    sourceRow: 32,
    masterSourceKey: "32",
    importSource: "master",
  };
  const legacyNameCollision: ExistingStudentImportRecord = {
    id: "STU-LEGACY-NAME",
    name: "Current Formal Person",
    status: "在读",
    sourceRow: 999,
    masterSourceKey: "999",
    importSource: "master",
  };
  const preservedReferences = new Set([rawRowCollision.id, legacyNameCollision.id]);
  const input = {
    masterRows: [master(32, "Current Formal Person")],
    jwbRows: [],
    existingStudents: [rawRowCollision, legacyNameCollision],
    masterSourceNamespace: namespace,
    allowLegacyIdentityFallback: false,
    preserveReferencedStudentIds: preservedReferences,
  };

  const first = buildStudentImportPlan(input);
  const formalId = studentIdForMasterSource(32, namespace);
  const active = first.students.find((student) => student.id === formalId);
  assert.ok(active);
  assert.equal(active.masterSourceKey, masterSourceKeyForSource(32, namespace));
  assert.equal(active.importArchived, undefined);
  assert.equal(first.summary.insert, 1);
  assert.equal(first.summary.preservedReferencedArchived, 2);
  for (const legacyId of preservedReferences) {
    assert.equal(first.students.find((student) => student.id === legacyId)?.importArchived, true);
  }

  const replay = buildStudentImportPlan({ ...input, existingStudents: first.students });
  assert.deepEqual(replay.students, first.students);
  assert.equal(replay.summary.insert, 0);
  assert.equal(replay.summary.update, 0);
  assert.equal(replay.summary.unchanged, 3);
  assert.equal(replay.students.filter((student) => student.id === formalId).length, 1);
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
  assert.equal(duplicateJwb.summary.ambiguous, 0);
  assert.equal(duplicateJwb.students[0].jwbMatchStatus, "ambiguous");
  assert.equal(duplicateJwb.students[0].remainingHours, undefined);
});

test("duplicate JWB-only names stay unmatched without blocking the authoritative master import", () => {
  const plan = buildStudentImportPlan({
    masterRows: [master(61, "Formal Student", "在读")],
    jwbRows: [
      jwb(610, "Outside Duplicate", 2, 8),
      jwb(611, " outside duplicate ", 7, 10),
    ],
  });

  assert.equal(plan.summary.ambiguous, 0);
  assert.equal(plan.summary.unmatched, 3);
  assert.equal(plan.unmatched.filter((item) => item.source === "jwb").length, 2);
  assert.equal(plan.students[0].jwbMatchStatus, "unmatched");
});
