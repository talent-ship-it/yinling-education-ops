import assert from "node:assert/strict";
import test from "node:test";

import {
  EXAM_VARIANT_LABELS,
  parseExamFormData,
  parseFollowUpFormData,
  parseLessonPackageFormData,
  STUDENT_RECORD_FORM_NAMES,
  StudentRecordFormDataError,
} from "../app/student-record-forms.tsx";

function form(values: Record<string, string | readonly string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((item) => data.append(key, item));
    else data.set(key, value as string);
  }
  return data;
}

function assertFieldError(action: () => unknown, fieldName: string) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof StudentRecordFormDataError);
    assert.equal(error.fieldName, fieldName);
    return true;
  });
}

test("follow-up parser keeps an exact timestamp and trims the optional note", () => {
  const localDateTime = "2026-08-12T14:35";
  assert.deepEqual(parseFollowUpFormData(form({
    followedUpAt: localDateTime,
    followUpNote: "  Parent confirmed next month.  ",
  })), {
    followedUpAt: new Date(localDateTime).toISOString(),
    note: "Parent confirmed next month.",
  });

  assertFieldError(
    () => parseFollowUpFormData(form({ followedUpAt: "2026-02-30T09:00" })),
    STUDENT_RECORD_FORM_NAMES.followedUpAt,
  );
});

test("new-package parser accepts multiple and comma-separated subjects and splits purchased and bonus hours", () => {
  assert.deepEqual(parseLessonPackageFormData(form({
    packageMode: "new",
    newPackageName: "Kevin physics package",
    subjectIds: ["Physics, Mathematics", "Physics", "English，Chemistry"],
    purchasedHours: "24",
    bonusHours: "2.5",
    purchaseNote: "  August purchase  ",
  })), {
    packageMode: "new",
    newPackageName: "Kevin physics package",
    subjectIds: ["Physics", "Mathematics", "English", "Chemistry"],
    purchasedHours: 24,
    bonusHours: 2.5,
    totalHours: 26.5,
    purchaseNote: "August purchase",
  });
});

test("existing-package parser ignores stale new-package values", () => {
  assert.deepEqual(parseLessonPackageFormData(form({
    packageMode: "existing",
    packageId: "PKG-001",
    newPackageName: "stale value",
    subjectIds: "Mathematics",
    purchasedHours: "0",
    bonusHours: "1",
  })), {
    packageMode: "existing",
    packageId: "PKG-001",
    subjectIds: ["Mathematics"],
    purchasedHours: 0,
    bonusHours: 1,
    totalHours: 1,
  });
});

test("lesson-package parser rejects negative hours, zero totals and missing subjects", () => {
  const base = {
    packageMode: "new",
    newPackageName: "Package",
    subjectIds: "Mathematics",
    purchasedHours: "1",
    bonusHours: "0",
  };
  assertFieldError(
    () => parseLessonPackageFormData(form({ ...base, purchasedHours: "-1" })),
    STUDENT_RECORD_FORM_NAMES.purchasedHours,
  );
  assertFieldError(
    () => parseLessonPackageFormData(form({ ...base, purchasedHours: "0" })),
    STUDENT_RECORD_FORM_NAMES.purchasedHours,
  );
  assertFieldError(
    () => parseLessonPackageFormData(form({ ...base, subjectIds: " , ， " })),
    STUDENT_RECORD_FORM_NAMES.subjectIds,
  );
});

test("exam parser accepts an optional date and recall flag", () => {
  assert.deepEqual(parseExamFormData(form({
    examSubject: "AEAS English",
    examType: "aeas",
    examVariant: "aeas",
    examMonth: "2026-09",
    examDate: "",
  })), {
    subject: "AEAS English",
    examType: "aeas",
    examVariant: "aeas",
    examMonth: "2026-09",
    includeRecall: false,
  });

  assert.deepEqual(parseExamFormData(form({
    examSubject: "Scholarship test",
    examType: "scholarship",
    examVariant: "scholarship",
    examMonth: "2026-10",
    examDate: "2026-10-18",
    includeRecall: "true",
  })).includeRecall, true);
});

test("exam parser requires a real date inside the selected month", () => {
  const base = {
    examSubject: "Scholarship test",
    examType: "scholarship",
    examVariant: "scholarship",
    examMonth: "2026-10",
    includeRecall: "true",
  };
  assertFieldError(
    () => parseExamFormData(form({ ...base, examDate: "2026-09-30" })),
    STUDENT_RECORD_FORM_NAMES.examDate,
  );
  assertFieldError(
    () => parseExamFormData(form({ ...base, examMonth: "2026-02", examDate: "2026-02-30" })),
    STUDENT_RECORD_FORM_NAMES.examDate,
  );
});

test("exam parser keeps a stable edit id, full variant and exact result-date override", () => {
  assert.deepEqual(parseExamFormData(form({
    examId: "EXAM-STABLE",
    examSubject: "State English",
    examType: "other",
    examVariant: "vce",
    examMonth: "2026-11",
    examDate: "2026-11-10",
    resultDateOverride: "2026-12-11",
    includeRecall: "true",
  })), {
    examId: "EXAM-STABLE",
    subject: "State English",
    examType: "other",
    examVariant: "vce",
    examMonth: "2026-11",
    examDate: "2026-11-10",
    resultDateOverride: "2026-12-11",
    includeRecall: true,
  });
  assert.equal(EXAM_VARIANT_LABELS.vce, "VCE");
  assert.equal(Object.keys(EXAM_VARIANT_LABELS).length, 22);
});

test("exam parser rejects unsupported variants and invalid result dates", () => {
  const base = {
    examSubject: "Exam",
    examType: "other",
    examVariant: "vce",
    examMonth: "2026-11",
  };
  assertFieldError(
    () => parseExamFormData(form({ ...base, examVariant: "invented" })),
    STUDENT_RECORD_FORM_NAMES.examVariant,
  );
  assertFieldError(
    () => parseExamFormData(form({ ...base, resultDateOverride: "2026-02-30" })),
    STUDENT_RECORD_FORM_NAMES.resultDateOverride,
  );
});
