import assert from "node:assert/strict";
import test from "node:test";

import {
  FU_ATTACHMENT_CATEGORIES,
  MAX_REPORT_PDF_BYTES,
  RENEWAL_STATUS_LABELS,
  addLessonPackageHours,
  addWeekdays,
  appendLpDocumentLink,
  appendStudentFollowUp,
  bindSubjectToLessonPackage,
  buildExamTaskDefinitions,
  createStudentLessonPackage,
  deductCompletedLesson,
  estimateExamResultDate,
  estimateLessonPackageDepletion,
  getLatestLpDocumentLink,
  getLatestStudentFollowUp,
  getLessonPackageBalance,
  getLessonPackageForSubject,
  isFuAttachmentCategory,
  mapLessonPackageDepletionEstimates,
  normalizeRenewalBusinessStatus,
  reverseLessonDeduction,
  sortLpDocumentHistory,
  sortStudentExams,
  sortStudentFollowUpHistory,
  validateReportPdfMetadata,
  type FutureLessonBooking,
  type LessonHourLedgerEntry,
  type StudentExamRecord,
  type StudentLessonPackage,
} from "../lib/student-records";

test("keeps every LP link version and returns the newest without mutating history", () => {
  const first = {
    id: "lp-1",
    kind: "lp" as const,
    title: "Initial LP",
    url: "https://docs.qq.com/doc/first",
    addedAt: "2026-01-01T00:00:00Z",
  };
  const original = [first];
  const history = appendLpDocumentLink(original, {
    id: "lp-2",
    kind: "school_document",
    title: "School information",
    url: "https://docs.qq.com/doc/second",
    addedAt: "2026-02-01T00:00:00Z",
  });

  assert.equal(original.length, 1);
  assert.deepEqual(sortLpDocumentHistory(history).map((item) => item.id), ["lp-2", "lp-1"]);
  assert.equal(getLatestLpDocumentLink(history)?.id, "lp-2");
  assert.equal(appendLpDocumentLink(history, history[1]).length, 2);
  assert.throws(() => appendLpDocumentLink(history, { ...history[1], title: "Conflicting version" }), /already exists/);
});

test("validates Report uploads as non-empty PDFs no larger than 20 MB", () => {
  assert.deepEqual(validateReportPdfMetadata({
    name: "Semester report.pdf",
    mimeType: "application/pdf",
    sizeBytes: MAX_REPORT_PDF_BYTES,
  }), { valid: true, errors: [] });
  assert.deepEqual(validateReportPdfMetadata({
    name: "photo.png",
    mimeType: "image/png",
    sizeBytes: MAX_REPORT_PDF_BYTES + 1,
  }), { valid: false, errors: ["invalid_mime", "file_too_large"] });
  assert.deepEqual(validateReportPdfMetadata({
    name: "",
    mimeType: "application/pdf",
    sizeBytes: 0,
  }), { valid: false, errors: ["empty_name", "invalid_size"] });
});

test("provides the required FU attachment categories", () => {
  assert.deepEqual(FU_ATTACHMENT_CATEGORIES, [
    "renewal_update",
    "parent_communication",
    "teacher_feedback",
    "complaint",
    "other",
  ]);
  assert.equal(isFuAttachmentCategory("complaint"), true);
  assert.equal(isFuAttachmentCategory("random"), false);
});

test("keeps follow-up history and derives the latest record", () => {
  const original = [{ id: "fu-1", followedUpAt: "2026-07-01", note: "First" }];
  const history = appendStudentFollowUp(original, {
    id: "fu-2",
    followedUpAt: "2026-08-02T10:00:00+10:00",
    note: "Latest",
  });
  assert.equal(original.length, 1);
  assert.deepEqual(sortStudentFollowUpHistory(history).map((entry) => entry.id), ["fu-2", "fu-1"]);
  assert.equal(getLatestStudentFollowUp(history)?.note, "Latest");
  assert.equal(getLatestStudentFollowUp([]), null);
});

test("sorts month-only exams before dated exams in the same month", () => {
  const exams: StudentExamRecord[] = [
    { id: "dec-5", subject: "Math", examType: "selective", examMonth: "2026-12", examDate: "2026-12-05" },
    { id: "nov", subject: "English", examType: "aeas", examMonth: "2026-11" },
    { id: "dec-2", subject: "English", examType: "aeas", examMonth: "2026-12", examDate: "2026-12-02" },
    { id: "dec-month", subject: "Writing", examType: "other", examMonth: "2026-12" },
  ];
  assert.deepEqual(sortStudentExams(exams).map((exam) => exam.id), ["nov", "dec-month", "dec-2", "dec-5"]);
});

test("estimates results at 30 calendar days or 10 weekdays without holiday assumptions", () => {
  assert.equal(estimateExamResultDate({
    id: "s1", subject: "Math", examType: "scholarship", examMonth: "2026-08", examDate: "2026-08-10",
  }), "2026-09-09");
  assert.equal(estimateExamResultDate({
    id: "a1", subject: "English", examType: "aeas", examMonth: "2026-08", examDate: "2026-08-07",
  }), "2026-08-21");
  assert.equal(addWeekdays("2026-08-08", 1), "2026-08-10");
});

test("builds stable care, recall and results task definitions", () => {
  const exam: StudentExamRecord = {
    id: "exam-1",
    subject: "Selective English",
    examType: "selective",
    examMonth: "2026-09",
    examDate: "2026-09-01",
  };
  const tasks = buildExamTaskDefinitions(exam);
  assert.deepEqual(tasks.map((task) => [task.kind, task.dueDate, task.assigneeRole]), [
    ["exam_care", "2026-09-01", "academic_coordinator"],
    ["exam_recall", "2026-09-01", "academic_coordinator"],
    ["exam_results_follow_up", "2026-10-01", "course_planner"],
  ]);
  assert.deepEqual(buildExamTaskDefinitions(exam, { includeRecall: false }).map((task) => task.kind), [
    "exam_care",
    "exam_results_follow_up",
  ]);
  assert.deepEqual(buildExamTaskDefinitions({ ...exam, examDate: undefined }), []);
});

function packageFixture(): StudentLessonPackage {
  return createStudentLessonPackage({
    id: "package-shared",
    name: "Kevin 刘凯文课包",
    subjectIds: ["math", "english"],
    initialPurchase: { id: "purchase-1", purchasedAt: "2026-01-01", hours: 24, note: "24送2" },
  });
}

test("supports custom multi-subject packages, purchase history and appended hours", () => {
  const first = packageFixture();
  const withBonus = addLessonPackageHours(first, {
    id: "purchase-2",
    purchasedAt: "2026-01-01",
    hours: 2,
    note: "赠送",
  });
  assert.equal(withBonus.name, "Kevin 刘凯文课包");
  assert.deepEqual(withBonus.subjectIds, ["math", "english"]);
  assert.equal(withBonus.purchaseRecords.length, 2);
  assert.deepEqual(getLessonPackageBalance(withBonus), {
    totalHours: 26,
    consumedHours: 0,
    remainingHours: 26,
  });
  assert.equal(addLessonPackageHours(withBonus, withBonus.purchaseRecords[1]).purchaseRecords.length, 2);
  assert.equal(first.purchaseRecords.length, 1);
});

test("requires an old package to have no remaining hours before rebinding its subject", () => {
  const shared = packageFixture();
  const physics = createStudentLessonPackage({
    id: "physics-package",
    name: "Kevin 刘凯文物理课包",
    subjectIds: ["physics"],
    initialPurchase: { id: "physics-purchase", purchasedAt: "2026-08-01", hours: 10 },
  });
  assert.throws(() => bindSubjectToLessonPackage([shared, physics], physics.id, "math"), /remaining hours/);
  const depletedShared = { ...shared, consumedHours: 24 };
  const rebound = bindSubjectToLessonPackage([depletedShared, physics], physics.id, "math");

  assert.deepEqual(rebound[0].subjectIds, ["english"]);
  assert.deepEqual(rebound[1].subjectIds, ["physics", "math"]);
  assert.equal(getLessonPackageForSubject(rebound, "math")?.id, physics.id);
  assert.deepEqual(depletedShared.subjectIds, ["math", "english"]);
});

test("deducts a completed lesson once and reverses it once through an audit ledger", () => {
  const packages = [packageFixture(), createStudentLessonPackage({
    id: "package-physics",
    name: "Kevin 刘凯文物理课包",
    subjectIds: ["physics"],
    initialPurchase: { id: "physics-purchase", purchasedAt: "2026-01-01", hours: 10 },
  })];
  const first = deductCompletedLesson(packages, [], {
    entryId: "ledger-1",
    lessonId: "lesson-1",
    packageId: "package-shared",
    subjectId: "math",
    hours: 1.5,
    completedAt: "2026-08-01T10:00:00+10:00",
  });
  assert.equal(first.applied, true);
  assert.deepEqual(getLessonPackageBalance(first.packages[0]), {
    totalHours: 24,
    consumedHours: 1.5,
    remainingHours: 22.5,
  });
  assert.equal(getLessonPackageBalance(first.packages[1]).remainingHours, 10);

  const retry = deductCompletedLesson(first.packages, first.ledger, {
    entryId: "a-different-retry-id",
    lessonId: "lesson-1",
    packageId: "package-shared",
    subjectId: "math",
    hours: 1.5,
    completedAt: "2026-08-01T10:00:00+10:00",
  });
  assert.equal(retry.applied, false);
  assert.equal(retry.ledger.length, 1);
  assert.equal(getLessonPackageBalance(retry.packages[0]).consumedHours, 1.5);
  assert.throws(() => deductCompletedLesson(first.packages, first.ledger, {
    entryId: "conflicting-retry",
    lessonId: "lesson-1",
    packageId: "package-shared",
    subjectId: "math",
    hours: 2,
    completedAt: "2026-08-01T10:00:00+10:00",
  }), /different deduction/);

  const reversed = reverseLessonDeduction(retry.packages, retry.ledger, {
    deductionEntryId: "ledger-1",
    reversalEntryId: "reversal-1",
    reversedAt: "2026-08-02T09:00:00+10:00",
  });
  assert.equal(reversed.applied, true);
  assert.equal(reversed.ledger.length, 2);
  assert.equal(getLessonPackageBalance(reversed.packages[0]).remainingHours, 24);

  const reversedAgain = reverseLessonDeduction(reversed.packages, reversed.ledger, {
    deductionEntryId: "ledger-1",
    reversalEntryId: "another-reversal-id",
    reversedAt: "2026-08-03T09:00:00+10:00",
  });
  assert.equal(reversedAgain.applied, false);
  assert.equal(reversedAgain.ledger.length, 2);
  assert.equal(getLessonPackageBalance(reversedAgain.packages[0]).remainingHours, 24);
});

test("rejects deductions from the wrong subject or without enough hours", () => {
  const lessonPackage = packageFixture();
  const input = {
    entryId: "ledger-x",
    lessonId: "lesson-x",
    packageId: lessonPackage.id,
    subjectId: "physics",
    hours: 1,
    completedAt: "2026-08-01",
  };
  assert.throws(() => deductCompletedLesson([lessonPackage], [], input), /not bound/);
  assert.throws(() => deductCompletedLesson([lessonPackage], [], {
    ...input,
    subjectId: "math",
    hours: 25,
  }), /insufficient/);
});

test("exposes exactly four renewal statuses", () => {
  assert.deepEqual(Object.values(RENEWAL_STATUS_LABELS), [
    "已续课",
    "未续课-活跃",
    "未续课-不活跃",
    "未续课-不活跃（已考完）",
  ]);
});

test("normalizes legacy renewal values without inferring inactivity", () => {
  assert.equal(normalizeRenewalBusinessStatus("已确认"), "renewed");
  assert.equal(normalizeRenewalBusinessStatus("已续课"), "renewed");
  assert.equal(normalizeRenewalBusinessStatus("等待家长"), "not_renewed_active");
  assert.equal(normalizeRenewalBusinessStatus("本次未跟进"), "not_renewed_active");
  assert.equal(normalizeRenewalBusinessStatus("unknown legacy value"), "not_renewed_active");
  assert.equal(normalizeRenewalBusinessStatus("未续课-不活跃"), "not_renewed_inactive");
  assert.equal(normalizeRenewalBusinessStatus("not_renewed_exam_finished"), "not_renewed_exam_finished");
});

test("estimates depletion by package and optionally by subject from future scheduled lessons", () => {
  const lessonPackage = { ...packageFixture(), consumedHours: 21 };
  const bookings: FutureLessonBooking[] = [
    { id: "cancelled", packageId: lessonPackage.id, subjectId: "math", startsAt: "2026-08-10T10:00:00+10:00", hours: 3, status: "cancelled" },
    { id: "english-1", packageId: lessonPackage.id, subjectId: "english", startsAt: "2026-08-11T10:00:00+10:00", hours: 1 },
    { id: "math-1", packageId: lessonPackage.id, subjectId: "math", startsAt: "2026-08-12T10:00:00+10:00", hours: 1.5 },
    { id: "math-2", packageId: lessonPackage.id, subjectId: "math", startsAt: "2026-08-19T10:00:00+10:00", hours: 1.5 },
    { id: "other-package", packageId: "another", subjectId: "math", startsAt: "2026-08-09T10:00:00+10:00", hours: 10 },
  ];
  assert.deepEqual(estimateLessonPackageDepletion(lessonPackage, bookings), {
    date: "2026-08-19",
    bookingId: "math-2",
    packageId: lessonPackage.id,
    subjectId: "math",
  });
  assert.deepEqual(estimateLessonPackageDepletion(lessonPackage, bookings, { subjectId: "math" }), {
    date: "2026-08-19",
    bookingId: "math-2",
    packageId: lessonPackage.id,
    subjectId: "math",
  });
  assert.equal(estimateLessonPackageDepletion(lessonPackage, bookings, { subjectId: "english" }), null);
});

test("maps depletion per package using each occurrence local date as authoritative", () => {
  const shared = { ...packageFixture(), consumedHours: 23 };
  const physics = {
    ...createStudentLessonPackage({
      id: "package-physics",
      name: "Physics",
      subjectIds: ["physics"],
      initialPurchase: { id: "physics-purchase", purchasedAt: "2026-08-01", hours: 2 },
    }),
    consumedHours: 0.5,
  };
  const mapped = mapLessonPackageDepletionEstimates([shared, physics], [
    {
      id: "ignored-completed",
      packageId: shared.id,
      subjectId: "math",
      date: "2026-08-31",
      start: "23:00",
      timezone: "Australia/Melbourne",
      duration: 60,
      status: "已完成",
    },
    {
      id: "auckland-midnight",
      packageId: shared.id,
      subjectId: "english",
      date: "2026-09-01",
      start: "00:15",
      timezone: "Pacific/Auckland",
      duration: 60,
      status: "已确认",
    },
    {
      id: "physics-first",
      packageId: physics.id,
      subjectId: "physics",
      date: "2026-09-02",
      start: "18:00",
      timezone: "America/Los_Angeles",
      duration: 60,
      status: "scheduled",
    },
    {
      id: "physics-last",
      packageId: physics.id,
      subjectId: "physics",
      date: "2026-09-09",
      start: "18:00",
      timezone: "America/Los_Angeles",
      duration: 30,
      status: "待确认",
    },
  ]);

  assert.deepEqual(mapped, [
    { packageId: shared.id, depletionDate: "2026-09-01", subjectId: "english", occurrenceId: "auckland-midnight" },
    { packageId: physics.id, depletionDate: "2026-09-09", subjectId: "physics", occurrenceId: "physics-last" },
  ]);
});

test("returns a null per-package estimate when future occurrences do not use all hours", () => {
  assert.deepEqual(mapLessonPackageDepletionEstimates([packageFixture()], [{
    id: "one-hour",
    packageId: "package-shared",
    subjectId: "math",
    date: "2026-09-01",
    start: "10:00",
    timezone: "Australia/Melbourne",
    duration: 60,
    status: "已确认",
  }]), [{ packageId: "package-shared", depletionDate: null, subjectId: null, occurrenceId: null }]);
});

test("does not mutate package or ledger inputs", () => {
  const lessonPackage = packageFixture();
  const ledger: LessonHourLedgerEntry[] = [];
  deductCompletedLesson([lessonPackage], ledger, {
    entryId: "immutable-entry",
    lessonId: "immutable-lesson",
    packageId: lessonPackage.id,
    subjectId: "english",
    hours: 1,
    completedAt: "2026-08-01",
  });
  assert.equal(lessonPackage.consumedHours, 0);
  assert.equal(ledger.length, 0);
});
