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
  masterSourceKeyForSource,
  normalizeStudentImportName,
  parseMasterStudentStatus,
  studentImportCjkNameKey,
  studentImportReviewCjkKey,
  studentIdForMasterSource,
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
  assert.equal(normalizeStudentImportName("ÉLODIE"), "Élodie");
  assert.equal(plan.summary.insert, 1);
  assert.equal(plan.summary.preservedManualTrials, 1);
  assert.equal(plan.students.length, 2);
  assert.deepEqual(plan.students[0], {
    initials: "AE",
    owner: "Ops A",
    planner: "待分配",
    course: "待确认",
    timezone: "Australia/Melbourne",
    teacher: "待匹配",
    next: "核对课程、课包与老师",
    nextTone: "amber",
    files: 0,
    segment: "已报名",
    followUp: "未记录",
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

test("uses a Chinese-only punctuation fallback and rejects mixed or short keys", () => {
  assert.equal(studentImportCjkNameKey(" 张 · 三 "), "张三");
  assert.equal(studentImportCjkNameKey("张（三）"), "张三");
  assert.equal(studentImportCjkNameKey("Alice 张三"), "");
  assert.equal(studentImportCjkNameKey("张三 2"), "");
  assert.equal(studentImportCjkNameKey("张"), "");
  assert.equal(studentImportCjkNameKey("𠀀·𠀁"), "𠀀𠀁");
  assert.equal(normalizeStudentImportName("张·三"), normalizeStudentImportName("张（三）"));
  assert.notEqual(normalizeStudentImportName("Alice 张三"), normalizeStudentImportName("张三 Alice"));
});

test("review evidence requires exactly one qualifying contiguous Han run", () => {
  assert.equal(studentImportReviewCjkKey("Alice 张三"), "张三");
  assert.equal(studentImportReviewCjkKey("Alice 张三 王"), "张三");
  assert.equal(studentImportReviewCjkKey("张三 / 李四"), "");
  assert.equal(studentImportReviewCjkKey("Alice 张"), "");
  assert.equal(studentImportReviewCjkKey("Alice Smith"), "");
});

test("matches only a unique Chinese fallback key and fails closed on duplicates", () => {
  const matched = buildStudentImportPlan({
    masterRows: [master(201, "张·三", "活跃 + 有课时")],
    jwbRows: [jwb(301, "张（三）", 5, 10)],
  });
  assert.equal(matched.students[0].jwbMatchStatus, "matched");
  assert.equal(matched.students[0].jwbSourceRow, 301);
  assert.equal(matched.students[0].remainingHours, 5);

  const duplicateJwb = buildStudentImportPlan({
    masterRows: [master(202, "张三", "活跃 + 有课时")],
    jwbRows: [
      jwb(302, "张·三", 5, 10),
      jwb(303, "张（三）", 7, 12),
    ],
  });
  assert.equal(duplicateJwb.summary.ambiguous, 1);
  assert.equal(duplicateJwb.students[0].jwbMatchStatus, "ambiguous");
  assert.equal(duplicateJwb.students[0].jwbSourceRow, undefined);
  assert.equal(duplicateJwb.students[0].remainingHours, undefined);

  const mixedAliases = buildStudentImportPlan({
    masterRows: [master(203, "Alice 张三", "在读")],
    jwbRows: [jwb(304, "张三 Alice", 5, 10)],
  });
  assert.equal(mixedAliases.students[0].jwbMatchStatus, "unmatched");
  assert.equal(mixedAliases.summary.ambiguous, 0);
  assert.equal(mixedAliases.students[0].jwbSourceRow, undefined);
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

test("preserves referenced removed students as idempotent read-only archives", () => {
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
  const archived = first.students[0];

  assert.equal(first.summary.excluded, 1);
  assert.equal(first.summary.preservedReferencedArchived, 1);
  assert.equal(first.summary.update, 1);
  assert.equal(archived.id, historical.id);
  assert.equal(archived.status, "不活跃 + 无课时");
  assert.equal(archived.next, "历史引用归档，只读");
  assert.equal(archived.nextTone, "neutral");
  assert.equal(archived.importArchived, true);
  assert.equal(archived.importArchivedReason, "referenced_history");

  const second = buildStudentImportPlan({ ...input, existingStudents: first.students });
  assert.deepEqual(second.students, first.students);
  assert.equal(second.summary.preservedReferencedArchived, 1);
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

test("partial package coverage preserves overall JWB aggregates and counts as missing data", () => {
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
  assert.equal(plan.students[0].remainingHours, 17);
  assert.equal(plan.students[0].contractHours, 25);
  assert.equal(plan.students[0].packageCoverage, "partial");
  assert.equal(plan.students[0].lessonPackages?.length, 1);
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

test("partial JWB refresh preserves manual packages while replacing its managed subset", () => {
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
  assert.equal(plan.students[0].contractHours, 30);
  assert.equal(plan.summary.importedPackages, 1);
  assert.equal(plan.summary.studentsMissingPackageData, 1);
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
  assert.equal(refreshed.students[0].packageCoverage, "complete");

  const explicitNone = buildStudentImportPlan({
    masterRows: [master(81, "Aggregate Learner", "活跃 + 有课时")],
    jwbRows: [{ ...jwb(881, "Aggregate Learner", 10, 20), packageCoverage: "none" }],
    existingStudents: withPackage.students,
  });
  assert.equal(explicitNone.students[0].lessonPackages, undefined);
  assert.equal(explicitNone.students[0].packageCoverage, "none");
});

test("unmatched students preserve JWB totals without counting manual packages", () => {
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

  assert.deepEqual(plan.students[0].lessonPackages, [manualPackage, managedPackage]);
  assert.equal(plan.students[0].packageCoverage, "complete");
  assert.equal(plan.students[0].contractHours, 10);
  assert.equal(plan.students[0].remainingHours, 6);
});

test("unmatched partial and none coverage preserve their prior JWB aggregates", () => {
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
  assert.equal(partial.students[0].packageCoverage, "partial");
  assert.equal(partial.students[0].contractHours, 30);
  assert.equal(partial.students[0].remainingHours, 18);
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
  assert.equal(none.students[0].packageCoverage, "none");
  assert.equal(none.students[0].contractHours, 20);
  assert.equal(none.students[0].remainingHours, -2);
  assert.equal(none.summary.studentsMissingPackageData, 1);
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

test("coverage none clears stale JWB packages but preserves manual packages", () => {
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
  assert.equal(next.students[0].remainingHours, -2);
  assert.equal(next.students[0].contractHours, 10);
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
  assert.equal(plan.students[0].remainingHours, 7);
  assert.equal(plan.excluded[0].reason, "empty_name");
});

test("server identity links map differently named master, existing and JWB records while preserving the student ID", () => {
  const existing: ExistingStudentImportRecord = {
    id: "STU-STABLE-LINK",
    name: "Previous CRM Display Name",
    status: "在读",
    sourceRow: "legacy-row-99",
    masterSourceKey: "legacy-master-key",
    importSource: "master",
    remainingHours: 1,
  };
  const plan = buildStudentImportPlan({
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
  });

  assert.equal(plan.students.length, 1);
  assert.equal(plan.students[0].id, "STU-STABLE-LINK");
  assert.equal(plan.students[0].name, "Current Master Display Name");
  assert.equal(plan.students[0].jwbMatchStatus, "matched");
  assert.equal(plan.students[0].jwbSourceRow, "jwb-member-501");
  assert.equal(plan.students[0].remainingHours, 9);
  assert.equal(plan.students[0].contractHours, 15);
  assert.equal(
    plan.students[0].masterSourceKey,
    masterSourceKeyForSource("master-2026-17", "master-sheet:students:v2"),
  );
  assert.deepEqual(plan.unmatched, []);
  assert.deepEqual(plan.ambiguous, []);
  assert.equal(plan.summary.update, 1);
});

test("a reviewed create link may use only the exact namespaced derived identity", () => {
  const namespace = "master-reviewed-create";
  const sourceRow = "M-CREATE-1";
  const derivedId = studentIdForMasterSource(sourceRow, namespace);
  const input = {
    masterRows: [{ sourceRow, name: "Alice 张三", status: "在读" }],
    jwbRows: [{ sourceRow: "J-CREATE-1", name: "张三", remainingHours: 2, contractHours: 4 }],
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
    name: "Old Linked Name",
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

  assert.equal(plan.students.find((student) => student.id === existing.id)?.remainingHours, 4);
  assert.equal(plan.students.find((student) => student.sourceRow === 62)?.remainingHours, 7);
  assert.deepEqual(plan.unmatched, []);
  assert.deepEqual(plan.ambiguous, []);
});

test("rejects duplicate and unknown server identity links", () => {
  const existing = [
    { id: "STU-LINK-A", name: "Existing A", status: "在读" },
    { id: "STU-LINK-B", name: "Existing B", status: "在读" },
  ] satisfies ExistingStudentImportRecord[];
  const base = {
    masterRows: [master(71, "Master A"), master(72, "Master B")],
    jwbRows: [jwb(710, "JWB A", 1, 2), jwb(720, "JWB B", 2, 3)],
    existingStudents: existing,
  };
  const duplicateCases = [
    [
      { masterSourceRow: 71, studentId: "STU-LINK-A", jwbSourceRow: 710 },
      { masterSourceRow: 71, studentId: "STU-LINK-B", jwbSourceRow: 720 },
    ],
    [
      { masterSourceRow: 71, studentId: "STU-LINK-A", jwbSourceRow: 710 },
      { masterSourceRow: 72, studentId: "STU-LINK-A", jwbSourceRow: 720 },
    ],
    [
      { masterSourceRow: 71, studentId: "STU-LINK-A", jwbSourceRow: 710 },
      { masterSourceRow: 72, studentId: "STU-LINK-B", jwbSourceRow: 710 },
    ],
  ];
  for (const identityLinks of duplicateCases) {
    assert.throws(
      () => buildStudentImportPlan({ ...base, identityLinks }),
      (error: unknown) => error instanceof StudentImportError && error.code === "duplicate_identity_link",
    );
  }

  const unknownCases = [
    [{ masterSourceRow: 999, studentId: "STU-LINK-A", jwbSourceRow: 710 }],
    [{ masterSourceRow: 71, studentId: "STU-UNKNOWN", jwbSourceRow: 710 }],
    [{ masterSourceRow: 71, studentId: "STU-LINK-A", jwbSourceRow: 999 }],
  ];
  for (const identityLinks of unknownCases) {
    assert.throws(
      () => buildStudentImportPlan({ ...base, identityLinks }),
      (error: unknown) => error instanceof StudentImportError && error.code === "invalid_identity_link",
    );
  }
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
  assert.equal(duplicateJwb.summary.ambiguous, 1);
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
