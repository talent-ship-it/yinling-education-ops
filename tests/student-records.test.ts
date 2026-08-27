import assert from "node:assert/strict";
import test from "node:test";

import {
  FU_ATTACHMENT_CATEGORIES,
  DEFAULT_EXAM_RESULT_DATE_RULES,
  EXAM_VARIANTS,
  MAX_REPORT_PDF_BYTES,
  RENEWAL_STATUS_LABELS,
  addCalendarMonths,
  addLessonPackageHours,
  addWeekdays,
  applyExamResultDateRule,
  appendLpDocumentLink,
  appendStudentFollowUp,
  bindSubjectToLessonPackage,
  buildExamTaskDefinitions,
  createStudentLessonPackage,
  deductCompletedLesson,
  deriveExamFollowUpStatuses,
  estimateExamResultDate,
  estimateLessonPackageDepletion,
  getLatestLpDocumentLink,
  getLatestStudentFollowUp,
  getLessonPackageBalance,
  getLessonPackageForSubject,
  isFuAttachmentCategory,
  mapLessonPackageDepletionEstimates,
  normalizeRenewalBusinessStatus,
  resolveExamResultDateRule,
  resolveExamVariant,
  reverseLessonDeduction,
  setExamFollowUpStepState,
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

test("validates Report uploads as non-empty PDFs no larger than 4 MB", () => {
  assert.equal(MAX_REPORT_PDF_BYTES, 4 * 1024 * 1024);
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

test("sorts equal-date exam ids by deterministic UTF-8/C byte order", () => {
  const base = {
    subject: "Math",
    examType: "selective" as const,
    examMonth: "2026-12",
    examDate: "2026-12-05",
  };
  assert.deepEqual(
    sortStudentExams([{ ...base, id: "EXM_FIXTURE" }, { ...base, id: "EXM-FIXTURE" }])
      .map((exam) => exam.id),
    ["EXM-FIXTURE", "EXM_FIXTURE"],
  );
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

test("exposes every specified exam variant while resolving legacy records", () => {
  assert.deepEqual(EXAM_VARIANTS, [
    "scholarship", "selective", "oc", "mgs", "gate", "jmss", "aeas", "school_interview",
    "australian_university_final", "australian_university_assignment", "vce", "wace", "hsc", "qce", "sace",
    "icas", "amc", "ielts_paper", "ielts_computer", "pte", "ccl", "other",
  ]);
  assert.equal(resolveExamVariant({ examType: "selective" }), "selective");
  assert.equal(resolveExamVariant({ examType: "other", examVariant: "jmss" }), "jmss");
});

test("applies reusable calendar, weekday, month and fixed-date rules", () => {
  assert.equal(applyExamResultDateRule("2026-01-31", { kind: "calendar_days", days: 1 }), "2026-02-01");
  assert.equal(applyExamResultDateRule("2026-08-07", { kind: "weekdays", days: 1 }), "2026-08-10");
  assert.equal(addCalendarMonths("2027-01-31", 1), "2027-02-28");
  assert.equal(addCalendarMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(applyExamResultDateRule("2026-08-10", { kind: "fixed_date", date: "2026-12-10" }), "2026-12-10");
  assert.equal(applyExamResultDateRule("2026-06-10", { kind: "australian_university_final" }), "2026-07-15");
  assert.equal(applyExamResultDateRule("2026-11-10", { kind: "australian_university_final" }), "2026-12-15");
  assert.equal(applyExamResultDateRule("2026-12-20", { kind: "australian_university_final" }), "2027-07-15");
  assert.equal(applyExamResultDateRule("2026-08-10", { kind: "explicit_date_required" }), null);
  assert.throws(() => addCalendarMonths("2026-01-01", -1), /non-negative integer/);
});

test("covers every documented relative exam result-date rule", () => {
  const base = { id: "exam", subject: "Exam", examType: "other" as const, examMonth: "2026-08", examDate: "2026-08-10" };
  const expected: Partial<Record<(typeof EXAM_VARIANTS)[number], string | null>> = {
    scholarship: "2026-09-09", selective: "2026-09-09", oc: "2026-09-09", mgs: "2026-09-09",
    gate: "2026-09-09", jmss: "2026-09-09", aeas: "2026-08-24", school_interview: "2026-08-13",
    australian_university_final: "2026-12-15", australian_university_assignment: "2026-08-24",
    icas: "2026-10-10", amc: "2026-10-10", ielts_paper: "2026-08-24", ielts_computer: "2026-08-13",
    pte: "2026-08-11", ccl: "2026-09-21", other: null,
  };
  for (const [examVariant, resultDate] of Object.entries(expected)) {
    assert.equal(estimateExamResultDate({ ...base, examVariant: examVariant as (typeof EXAM_VARIANTS)[number] }), resultDate, examVariant);
  }
});

test("uses the next July or December university-final date and honours overrides", () => {
  const exam: StudentExamRecord = {
    id: "university-final",
    subject: "University final",
    examType: "other",
    examVariant: "australian_university_final",
    examMonth: "2026-06",
    examDate: "2026-06-30",
  };
  assert.equal(DEFAULT_EXAM_RESULT_DATE_RULES.australian_university_final.kind, "australian_university_final");
  assert.equal(estimateExamResultDate(exam), "2026-07-15");
  assert.equal(estimateExamResultDate({ ...exam, examMonth: "2026-11", examDate: "2026-11-30" }), "2026-12-15");
  assert.equal(estimateExamResultDate({ ...exam, resultDateOverride: "2026-07-20" }), "2026-07-20");
  assert.equal(estimateExamResultDate(exam, { resultDateOverride: "2026-07-25" }), "2026-07-25");
});

test("requires current fixed state-exam dates and honours explicit override precedence", () => {
  const stateVariants = ["vce", "wace", "hsc", "qce", "sace"] as const;
  const exam: StudentExamRecord = {
    id: "state", subject: "State exam", examType: "other", examVariant: "vce", examMonth: "2026-11", examDate: "2026-11-10",
  };
  for (const examVariant of stateVariants) {
    const record = { ...exam, examVariant };
    assert.equal(DEFAULT_EXAM_RESULT_DATE_RULES[examVariant].kind, "explicit_date_required");
    assert.equal(estimateExamResultDate(record), null);
  }
  assert.equal(estimateExamResultDate(exam, { fixedResultDates: { vce: "2026-12-11" } }), "2026-12-11");
  assert.deepEqual(resolveExamResultDateRule(
    { ...exam, resultDateOverride: "2026-12-12" },
    { resultDateOverride: "2026-12-13", fixedResultDates: { vce: "2026-12-11" } },
  ), { kind: "fixed_date", date: "2026-12-13" });
  assert.equal(estimateExamResultDate(exam, {
    ruleOverrides: { vce: { kind: "calendar_days", days: 20 } },
  }), "2026-11-30");
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
    ["exam_month_planning", "2026-08-01", "course_planner"],
    ["exam_care", "2026-09-01", "academic_coordinator"],
    ["exam_recall", "2026-09-01", "academic_coordinator"],
    ["exam_results_follow_up", "2026-10-01", "course_planner"],
  ]);
  assert.deepEqual(tasks.map((task) => task.assigneeRoles), [
    ["course_planner"],
    ["academic_coordinator"],
    ["academic_coordinator"],
    ["course_planner"],
  ]);
  assert.deepEqual(buildExamTaskDefinitions(exam, { includeRecall: false }).map((task) => task.kind), [
    "exam_month_planning",
    "exam_care",
    "exam_results_follow_up",
  ]);
  assert.deepEqual(buildExamTaskDefinitions({ ...exam, examDate: undefined }), []);
});

test("plans one calendar month before the exact exam date, including month ends", () => {
  const base: StudentExamRecord = {
    id: "exam-planning",
    subject: "Maths",
    examType: "other",
    examMonth: "2026-03",
    examDate: "2026-03-31",
  };
  assert.equal(buildExamTaskDefinitions(base)[0].dueDate, "2026-02-28");
  assert.equal(buildExamTaskDefinitions({ ...base, examDate: "2026-04-30", examMonth: "2026-04" })[0].dueDate, "2026-03-30");
  assert.equal(buildExamTaskDefinitions({ ...base, examDate: undefined })[0], undefined);
});

test("persists the recall preference on the exam record with a legacy true default", () => {
  const exam: StudentExamRecord = {
    id: "exam-recall",
    subject: "English",
    examType: "selective",
    examMonth: "2026-09",
    examDate: "2026-09-01",
    includeRecall: false,
  };
  assert.deepEqual(buildExamTaskDefinitions(exam).map((task) => task.kind), [
    "exam_month_planning",
    "exam_care",
    "exam_results_follow_up",
  ]);
  assert.equal(deriveExamFollowUpStatuses(exam).exam_recall, "not_required");
  assert.equal(buildExamTaskDefinitions({ ...exam, includeRecall: undefined }).some((task) => task.kind === "exam_recall"), true);
  assert.throws(() => buildExamTaskDefinitions({ ...exam, includeRecall: "false" as unknown as boolean }), /must be a boolean/);
});

test("updates and restores one durable exam follow-up step without mutation", () => {
  const exam: StudentExamRecord = {
    id: "exam-state-helper",
    subject: "English",
    examType: "selective",
    examMonth: "2026-09",
    examDate: "2026-09-01",
  };
  const completed = setExamFollowUpStepState(exam, "exam_recall", {
    status: "completed",
    completedAt: "2026-09-01T09:00:00.000Z",
    completedBy: "Abby",
  });
  assert.equal(exam.followUpState, undefined);
  assert.equal(completed.followUpState?.exam_recall?.status, "completed");
  assert.equal(setExamFollowUpStepState(completed, "exam_recall").followUpState, undefined);
});

test("builds three stable definitions with completion state and never schedules a month-only exam", () => {
  const completedAt = "2026-09-01T19:00:00+10:00";
  const exam: StudentExamRecord = {
    id: "exam-state",
    subject: "VCE English",
    examType: "other",
    examVariant: "vce",
    examMonth: "2026-09",
    examDate: "2026-09-01",
    followUpState: {
      exam_care: { status: "completed", completedAt, completedBy: "Abby" },
      exam_recall: { status: "pending" },
    },
  };
  const tasks = buildExamTaskDefinitions(exam, { fixedResultDates: { vce: "2026-12-10" } });
  assert.deepEqual(tasks.map((task) => task.key), [
    "exam:exam-state:planning",
    "exam:exam-state:care",
    "exam:exam-state:recall",
    "exam:exam-state:results",
  ]);
  assert.deepEqual(tasks.map((task) => task.completionStatus), ["pending", "completed", "pending", "pending"]);
  assert.equal(tasks[1].completedAt, completedAt);
  assert.deepEqual(deriveExamFollowUpStatuses(exam, { fixedResultDates: { vce: "2026-12-10" } }), {
    exam_month_planning: "pending",
    exam_care: "completed",
    exam_recall: "pending",
    exam_results_follow_up: "pending",
  });

  const monthOnly = { ...exam, examDate: undefined };
  assert.deepEqual(buildExamTaskDefinitions(monthOnly, { fixedResultDates: { vce: "2026-12-10" } }), []);
  assert.deepEqual(deriveExamFollowUpStatuses(monthOnly, { fixedResultDates: { vce: "2026-12-10" } }), {
    exam_month_planning: "not_required",
    exam_care: "not_required",
    exam_recall: "not_required",
    exam_results_follow_up: "not_required",
  });
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

test("keeps manual purchase and bonus hours structured while accepting legacy records", () => {
  const structured = createStudentLessonPackage({
    id: "package-breakdown",
    name: "Breakdown",
    subjectIds: ["math"],
    initialPurchase: {
      id: "purchase-breakdown",
      purchasedAt: "2026-08-01",
      hours: 10,
      purchasedHours: 8,
      bonusHours: 2,
    },
  });
  assert.deepEqual(structured.purchaseRecords[0], {
    id: "purchase-breakdown",
    purchasedAt: "2026-08-01",
    hours: 10,
    purchasedHours: 8,
    bonusHours: 2,
  });
  assert.equal(getLessonPackageBalance(structured).totalHours, 10);

  const legacy = createStudentLessonPackage({
    id: "package-legacy",
    name: "Legacy",
    subjectIds: ["math"],
    initialPurchase: { id: "purchase-legacy", purchasedAt: "2026-08-01", hours: 4 },
  });
  assert.equal(getLessonPackageBalance(legacy).totalHours, 4);

  assert.throws(() => createStudentLessonPackage({
    id: "package-invalid-breakdown",
    name: "Invalid",
    subjectIds: ["math"],
    initialPurchase: {
      id: "purchase-invalid-breakdown",
      purchasedAt: "2026-08-01",
      hours: 10,
      purchasedHours: 7,
      bonusHours: 2,
    },
  }), /add up to hours/);
  assert.throws(() => createStudentLessonPackage({
    id: "package-partial-breakdown",
    name: "Invalid",
    subjectIds: ["math"],
    initialPurchase: {
      id: "purchase-partial-breakdown",
      purchasedAt: "2026-08-01",
      hours: 10,
      purchasedHours: 10,
    },
  }), /include purchasedHours and bonusHours together/);
});

test("requires an old package to have no remaining hours before rebinding its subject", () => {
  const shared = packageFixture();
  const physics = createStudentLessonPackage({
    id: "physics-package",
    name: "Kevin 刘凯文物理课包",
    subjectIds: ["physics"],
    initialPurchase: { id: "physics-purchase", purchasedAt: "2026-08-01", hours: 10 },
  });
  assert.throws(() => bindSubjectToLessonPackage([shared, physics], physics.id, "math"), /non-zero balance/);
  const depletedShared = { ...shared, consumedHours: 24 };
  const rebound = bindSubjectToLessonPackage([depletedShared, physics], physics.id, "math");

  assert.deepEqual(rebound[0].subjectIds, ["english"]);
  assert.deepEqual(rebound[1].subjectIds, ["physics", "math"]);
  assert.equal(getLessonPackageForSubject(rebound, "math")?.id, physics.id);
  assert.deepEqual(depletedShared.subjectIds, ["math", "english"]);
});

test("does not move a subject away from an overdrawn package debt", () => {
  const overdrawn = { ...packageFixture(), consumedHours: 25 };
  const destination = createStudentLessonPackage({
    id: "destination-package",
    name: "Destination",
    subjectIds: ["physics"],
    initialPurchase: { id: "destination-purchase", purchasedAt: "2026-08-01", hours: 10 },
  });
  assert.throws(
    () => bindSubjectToLessonPackage([overdrawn, destination], destination.id, "math"),
    /non-zero balance/,
  );
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

test("represents an authoritative overdrawn package without allowing another deduction", () => {
  const overdrawn = { ...packageFixture(), consumedHours: 26 };
  assert.deepEqual(getLessonPackageBalance(overdrawn), {
    totalHours: 24,
    consumedHours: 26,
    remainingHours: -2,
  });
  assert.throws(() => deductCompletedLesson([overdrawn], [], {
    entryId: "overdrawn-ledger",
    lessonId: "overdrawn-lesson",
    packageId: overdrawn.id,
    subjectId: "math",
    hours: 0.5,
    completedAt: "2026-08-13T10:00:00+10:00",
  }), /insufficient/);
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
