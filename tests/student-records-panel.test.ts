import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStudentRecordsPanelData,
  filterStudentRecordExams,
  studentFileRecordSection,
  studentHistoricalJwbSnapshotEvidence,
  studentJwbPackageNotice,
  type StudentRecordsPanelFile,
  type StudentRecordsPanelStudent,
} from "../app/student-records-panel";

const files: StudentRecordsPanelFile[] = [
  { id: "other-student", studentId: "student-2", title: "Ignore", type: "Learning Plan", source: "腾讯文档", addedAt: "2026-08-10" },
  { id: "lp-old", studentId: "student-1", title: "LP v1", type: "Learning Plan", source: "腾讯文档", addedAt: "2026-01-01" },
  { id: "lp-new", studentId: "student-1", title: "LP v2", type: "学校资料", source: "腾讯文档", addedAt: "2026-08-01" },
  { id: "report", studentId: "student-1", title: "Semester report", type: "Report 资料", source: "上传", addedAt: "2026-07-01" },
  { id: "fu", studentId: "student-1", title: "Parent chat", type: "FU", source: "上传", addedAt: "2026-07-02" },
];

const student: StudentRecordsPanelStudent = {
  id: "student-1",
  name: "Student One",
  followUpHistory: [
    { id: "follow-old", followedUpAt: "2026-01-03", note: "First" },
    { id: "follow-new", followedUpAt: "2026-08-03", note: "Latest" },
  ],
  lessonPackages: [{
    id: "package-1",
    name: "Shared package",
    subjectIds: ["math", "english"],
    purchaseRecords: [
      { id: "purchase-old", purchasedAt: "2026-01-01", hours: 10 },
      { id: "purchase-new", purchasedAt: "2026-08-01", hours: 5 },
    ],
    consumedHours: 4,
  }],
  exams: [
    { id: "dated", subject: "Math", examType: "selective", examMonth: "2026-12", examDate: "2026-12-02" },
    { id: "month-only", subject: "Writing", examType: "other", examMonth: "2026-12" },
    { id: "aeas", subject: "English", examType: "aeas", examMonth: "2026-11", examDate: "2026-11-06" },
  ],
};

test("groups the existing FileRecord shape into complete student histories", () => {
  const data = buildStudentRecordsPanelData(student, files);

  assert.deepEqual(data.files.lp.map((file) => file.id), ["lp-new", "lp-old"]);
  assert.deepEqual(data.files.report.map((file) => file.id), ["report"]);
  assert.deepEqual(data.files.fu.map((file) => file.id), ["fu"]);
  assert.equal(data.files.lp.some((file) => file.id === "other-student"), false);
});

test("derives the three care/recall/results states and filters current-month incomplete exams", () => {
  const currentMonthStudent: StudentRecordsPanelStudent = {
    id: "student-exams",
    name: "Exam Student",
    exams: [
      {
        id: "month-only",
        subject: "Writing",
        examType: "other",
        examVariant: "vce",
        examMonth: "2026-08",
        resultDateOverride: "2026-09-10",
        followUpState: {
          exam_care: { status: "completed", completedAt: "2026-08-01T00:00:00Z" },
          exam_recall: { status: "not_required" },
          exam_results_follow_up: { status: "pending" },
        },
      },
      {
        id: "dated-complete",
        subject: "English",
        examType: "aeas",
        examVariant: "aeas",
        examMonth: "2026-08",
        examDate: "2026-08-02",
        followUpState: {
          exam_care: { status: "completed", completedAt: "2026-08-02T00:00:00Z" },
          exam_recall: { status: "completed", completedAt: "2026-08-02T00:00:00Z" },
          exam_results_follow_up: { status: "completed", completedAt: "2026-08-16T00:00:00Z" },
        },
      },
      {
        id: "dated-incomplete",
        subject: "Science",
        examType: "selective",
        examVariant: "selective",
        examMonth: "2026-08",
        examDate: "2026-08-03",
        followUpState: {
          exam_care: { status: "completed", completedAt: "2026-08-03T00:00:00Z" },
          exam_recall: { status: "pending" },
          exam_results_follow_up: { status: "pending" },
        },
      },
      { id: "later", subject: "Math", examType: "selective", examMonth: "2026-09" },
    ],
  };
  const data = buildStudentRecordsPanelData(currentMonthStudent, []);

  assert.deepEqual(data.exams.map(({ exam }) => exam.id), ["month-only", "dated-complete", "dated-incomplete", "later"]);
  assert.deepEqual(data.exams[0].followUpStatuses, {
    exam_care: "not_required",
    exam_recall: "not_required",
    exam_results_follow_up: "not_required",
  });
  assert.deepEqual(filterStudentRecordExams(data.exams, "2026-08", "all").map(({ exam }) => exam.id), [
    "month-only",
    "dated-complete",
    "dated-incomplete",
  ]);
  assert.deepEqual(filterStudentRecordExams(data.exams, "2026-08", "incomplete").map(({ exam }) => exam.id), [
    "dated-incomplete",
  ]);
  assert.equal(data.exams[0].estimatedResultDate, "2026-09-10");
});

test("supports explicit file grouping and stable legacy defaults", () => {
  assert.equal(studentFileRecordSection(files[1]), "lp");
  assert.equal(studentFileRecordSection(files[3]), "report");
  assert.equal(studentFileRecordSection(files[4]), "fu");
  assert.equal(studentFileRecordSection({ ...files[1], recordSection: "fu" }), "fu");
});

test("derives latest follow-up while retaining the full sorted history", () => {
  const data = buildStudentRecordsPanelData(student, files);

  assert.equal(data.latestFollowUp?.id, "follow-new");
  assert.deepEqual(data.followUps.map((followUp) => followUp.id), ["follow-new", "follow-old"]);
});

test("shows legacy follow-up only when the structured history is empty", () => {
  const legacyStudent: StudentRecordsPanelStudent = {
    id: "legacy-follow-up-student",
    name: "Legacy Follow-up",
    followUp: "2026-07-17",
    followUpHistory: [],
  };
  const data = buildStudentRecordsPanelData(legacyStudent, []);

  assert.equal(data.latestFollowUp?.followedUpAt, "2026-07-17");
  assert.deepEqual(data.followUps.map((followUp) => followUp.id), ["legacy-follow-up:legacy-follow-up-student"]);

  const structured = buildStudentRecordsPanelData({
    ...legacyStudent,
    followUpHistory: [{ id: "structured", followedUpAt: "2026-08-12" }],
  }, []);
  assert.deepEqual(structured.followUps.map((followUp) => followUp.id), ["structured"]);
});

test("does not turn legacy empty follow-up labels into history", () => {
  const data = buildStudentRecordsPanelData({
    id: "legacy-empty-follow-up",
    name: "No Follow-up",
    followUp: "未记录",
  }, []);

  assert.equal(data.latestFollowUp, null);
  assert.deepEqual(data.followUps, []);
});

test("shows package balances and every purchase newest first", () => {
  const data = buildStudentRecordsPanelData(student, files);

  assert.deepEqual(data.lessonPackages[0].balance, {
    totalHours: 15,
    consumedHours: 4,
    remainingHours: 11,
  });
  assert.deepEqual(data.lessonPackages[0].lessonPackage.purchaseRecords.map((purchase) => purchase.id), [
    "purchase-new",
    "purchase-old",
  ]);
});

test("retains package coverage so the UI can distinguish complete, partial and missing ledgers", () => {
  const partial = buildStudentRecordsPanelData({ ...student, packageCoverage: "partial" }, files);
  const missing = buildStudentRecordsPanelData({ id: "missing", name: "Missing", packageCoverage: "none" }, []);
  const masterOnly = buildStudentRecordsPanelData({
    id: "master-only",
    name: "Master only",
    jwbMatchStatus: "unmatched",
  }, []);
  const ambiguousJwb = buildStudentRecordsPanelData({
    id: "ambiguous-jwb",
    name: "Ambiguous JWB",
    jwbMatchStatus: "ambiguous",
  }, []);
  const retainedAggregate = buildStudentRecordsPanelData({
    id: "retained-aggregate",
    name: "Retained aggregate",
    jwbMatchStatus: "unmatched",
    historicalJwbSnapshot: { retained: { remainingHours: 4, contractHours: 10, packageCoverage: "none" } },
  }, []);
  assert.equal(partial.packageCoverage, "partial");
  assert.equal(missing.packageCoverage, "none");
  assert.equal(masterOnly.jwbMatchStatus, "unmatched");
  assert.equal(masterOnly.packageCoverage, "none");
  assert.equal(ambiguousJwb.jwbMatchStatus, "ambiguous");
  assert.equal(ambiguousJwb.packageCoverage, "none");
  assert.equal(retainedAggregate.hasHistoricalJwbFacts, true);
  assert.equal(retainedAggregate.lessonPackages.length, 0);
  assert.equal(buildStudentRecordsPanelData(student, files).packageCoverage, "complete");
});

test("labels absent and historical Jiaowubao snapshots without treating them as active packages", () => {
  const masterOnly = buildStudentRecordsPanelData({
    id: "master-only-notice",
    name: "Master only",
    jwbMatchStatus: "unmatched",
  }, []);
  const ambiguous = buildStudentRecordsPanelData({
    id: "ambiguous-notice",
    name: "Ambiguous",
    jwbMatchStatus: "ambiguous",
  }, []);
  const unmatchedWithActivePackage = buildStudentRecordsPanelData({
    id: "unmatched-active-package",
    name: "Unmatched with active package",
    jwbMatchStatus: "unmatched",
    lessonPackages: [{
      id: "manual-active-package",
      name: "Existing active package",
      subjectIds: ["english"],
      purchaseRecords: [{ id: "manual-active-purchase", purchasedAt: "2026-08-01", hours: 8 }],
      consumedHours: 2,
    }],
  }, []);
  const retainedAggregate = buildStudentRecordsPanelData({
    id: "retained-notice",
    name: "Retained",
    jwbMatchStatus: "unmatched",
    historicalJwbSnapshot: {
      retained: {
        lessonPackages: [{
          id: "historic-package",
          name: "Historic package",
          subjectIds: ["math"],
          purchaseRecords: [{ id: "historic-purchase", purchasedAt: "2026-01-01", hours: 10 }],
          consumedHours: 3,
        }],
        remainingHours: 4,
        contractHours: 10,
        firstJwbHourEntryDate: "2026-01-01",
        packageCoverage: "none",
      },
      currentAggregate: { remainingHours: 2, contractHours: 8, packageCoverage: "none" },
    },
  }, []);
  const unresolvedLedger = buildStudentRecordsPanelData({
    id: "ledger-notice",
    name: "Ledger",
    jwbMatchStatus: "matched",
    historicalJwbSnapshot: { currentAggregate: { remainingHours: 4, contractHours: 10, packageCoverage: "none" } },
  }, []);
  const activePartialWithSnapshot = buildStudentRecordsPanelData({
    id: "active-partial-with-snapshot",
    name: "Current verified package plus history",
    jwbMatchStatus: "matched",
    packageCoverage: "partial",
    lessonPackages: [{
      id: "active-package",
      name: "Verified current package",
      subjectIds: ["english"],
      purchaseRecords: [{ id: "active-purchase", purchasedAt: "2026-08-01", hours: 8 }],
      consumedHours: 2,
    }],
    historicalJwbSnapshot: {
      retained: {
        lessonPackages: [{
          id: "historic-package-2",
          name: "Historical package",
          subjectIds: ["math"],
          purchaseRecords: [{ id: "historic-purchase-2", purchasedAt: "2026-01-01", hours: 10 }],
          consumedHours: 3,
        }],
      },
    },
  }, []);

  assert.equal(studentJwbPackageNotice(masterOnly), "腾讯总表已建档，暂未关联教务宝资料；课时和课包暂为空。");
  assert.equal(studentJwbPackageNotice(ambiguous), "腾讯总表已建档，教务宝有多个候选待核对；当前不采用任何候选，课时和课包暂为空。");
  assert.equal(studentJwbPackageNotice(unmatchedWithActivePackage), "暂未关联教务宝资料；当前未采用教务宝补充。下方仅显示现有可用课包。");
  assert.equal(studentJwbPackageNotice(retainedAggregate), "腾讯总表已建档，暂未关联教务宝资料。历史教务宝资料已作为只读快照保留待核验，不可用于排课或扣课。");
  assert.equal(studentJwbPackageNotice(unresolvedLedger), "当前教务宝资料无法安全建立可用课包。历史教务宝资料已作为只读快照保留待核验，不可用于排课或扣课。");
  assert.deepEqual(studentHistoricalJwbSnapshotEvidence(retainedAggregate.historicalJwbSnapshot), [
    "历史保留课包 1 个",
    "历史保留汇总：余额 4 · 总 10 · 首笔正向合同 2026-01-01",
    "当前教务宝汇总（只读）：余额 2 · 总 8",
  ]);
  assert.equal(retainedAggregate.lessonPackages.length, 0);
  assert.equal(activePartialWithSnapshot.lessonPackages.length, 1);
  assert.equal(studentJwbPackageNotice(activePartialWithSnapshot), "下方仅显示当前可用课包。当前可核对课包仍可使用；历史教务宝资料已作为只读快照保留待核验，不可用于排课或扣课。");
});

test("sorts month-only exams before dated exams and estimates result dates", () => {
  const data = buildStudentRecordsPanelData(student, files);

  assert.deepEqual(data.exams.map(({ exam }) => exam.id), ["aeas", "month-only", "dated"]);
  assert.equal(data.exams[0].estimatedResultDate, "2026-11-20");
  assert.equal(data.exams[1].estimatedResultDate, null);
  assert.equal(data.exams[2].estimatedResultDate, "2027-01-01");
});

test("shows a legacy dated exam without manufacturing a typed exam month", () => {
  const data = buildStudentRecordsPanelData({
    id: "legacy-dated-exam",
    name: "Legacy Exam",
    examSubject: "VCE Chemistry",
    examDate: "2026-10-29",
    exams: [],
  }, []);

  assert.equal(data.exams.length, 1);
  assert.deepEqual(data.exams[0], {
    exam: {
      id: "legacy-exam:legacy-dated-exam",
      subject: "VCE Chemistry",
      examType: null,
      examDate: "2026-10-29",
    },
    estimatedResultDate: null,
    followUpStatuses: null,
  });
  assert.equal("examMonth" in data.exams[0].exam, false);
});

test("keeps a subject-only legacy exam visible without guessing its month", () => {
  const data = buildStudentRecordsPanelData({
    id: "legacy-subject-only-exam",
    name: "Legacy Subject",
    examSubject: "IB Mathematics",
  }, []);

  assert.equal(data.exams[0].exam.subject, "IB Mathematics");
  assert.equal(data.exams[0].exam.examDate, undefined);
  assert.equal(data.exams[0].exam.examMonth, undefined);

  const structured = buildStudentRecordsPanelData({
    id: "structured-exam-wins",
    name: "Structured Exam",
    examSubject: "Legacy subject",
    examDate: "2026-01-01",
    exams: [{ id: "structured", subject: "English", examType: "aeas", examMonth: "2026-11" }],
  }, []);
  assert.deepEqual(structured.exams.map(({ exam }) => exam.id), ["structured"]);
});

test("does not mutate student or file inputs", () => {
  const originalExamOrder = student.exams?.map((exam) => exam.id);
  const originalPurchaseOrder = student.lessonPackages?.[0].purchaseRecords.map((purchase) => purchase.id);
  const originalFileOrder = files.map((file) => file.id);

  buildStudentRecordsPanelData(student, files);

  assert.deepEqual(student.exams?.map((exam) => exam.id), originalExamOrder);
  assert.deepEqual(student.lessonPackages?.[0].purchaseRecords.map((purchase) => purchase.id), originalPurchaseOrder);
  assert.deepEqual(files.map((file) => file.id), originalFileOrder);
});
