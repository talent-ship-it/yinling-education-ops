import assert from "node:assert/strict";
import test from "node:test";

import {
  LESSON_OCCURRENCE_STATUSES,
  completeLessonOccurrence,
  earliestLessonOccurrenceTargetDate,
  evaluateLessonAttendance,
  expandLessonOccurrences,
  lessonOccurrenceId,
  lessonOccurrenceSourceRangeForTargetRange,
  reverseLessonOccurrenceCompletion,
  type LessonAttendanceEvidence,
  type LessonOccurrence,
  type LessonOccurrenceSettlementState,
} from "../lib/lesson-occurrences.ts";
import { createStudentLessonPackage } from "../lib/student-records.ts";

const completedAt = "2026-09-07T11:00:00.000Z";

function occurrence(overrides: Partial<LessonOccurrence> = {}): LessonOccurrence {
  return {
    occurrenceId: "SERIES-A:2026-09-07",
    seriesId: "SERIES-A",
    sourceDate: "2026-09-07",
    date: "2026-09-07",
    start: "10:00",
    scheduledDurationMinutes: 60,
    status: "confirmed",
    studentId: "STUDENT-A",
    teacherId: "TEACHER-A",
    packageId: "PACKAGE-A",
    subjectId: "SUBJECT-A",
    ...overrides,
  };
}

function packages(hours = 4) {
  return [createStudentLessonPackage({
    id: "PACKAGE-A",
    name: "Sample package",
    subjectIds: ["SUBJECT-A"],
    initialPurchase: {
      id: "PURCHASE-A",
      purchasedAt: "2026-09-01T00:00:00.000Z",
      hours,
    },
  })];
}

function state(overrides: Partial<LessonOccurrenceSettlementState> = {}): LessonOccurrenceSettlementState {
  return {
    occurrence: occurrence(),
    packages: packages(),
    studentHoursLedger: [],
    teacherPayrollLedger: [],
    ...overrides,
  };
}

function attendance(studentSeconds = 3_600, teacherSeconds = 3_600): LessonAttendanceEvidence {
  return {
    student: { userId: "STUDENT-A", accumulatedSeconds: studentSeconds },
    teacher: { userId: "TEACHER-A", accumulatedSeconds: teacherSeconds },
  };
}

test("defines the five single-occurrence statuses", () => {
  assert.deepEqual(LESSON_OCCURRENCE_STATUSES, [
    "confirmed",
    "completed",
    "cancelled",
    "leave",
    "abnormal",
  ]);
});

test("expands a legacy recurring series into independent occurrences and ignores the parent status", () => {
  const secondId = lessonOccurrenceId("LEGACY-SERIES", "2026-09-14");
  const occurrences = expandLessonOccurrences({
    id: "LEGACY-SERIES",
    date: "2026-09-07",
    start: "16:00",
    duration: 60,
    recurring: true,
    repeatCount: 3,
    status: "已完成",
    studentId: "STUDENT-A",
    teacherId: "TEACHER-A",
    packageId: "PACKAGE-A",
    course: "SUBJECT-A",
  }, {
    rangeStart: "2026-09-01",
    rangeEnd: "2026-09-30",
    overrides: [{
      occurrenceId: secondId,
      status: "cancelled",
      date: "2026-09-15",
      start: "18:30",
      durationMinutes: 90,
      teacherId: "TEACHER-B",
      studentId: "STUDENT-B",
      packageId: "PACKAGE-B",
      subjectId: "SUBJECT-B",
    }],
  });

  assert.deepEqual(occurrences.map((item) => item.occurrenceId), [
    "LEGACY-SERIES:2026-09-07",
    "LEGACY-SERIES:2026-09-14",
    "LEGACY-SERIES:2026-09-21",
  ]);
  assert.deepEqual(occurrences.map((item) => item.status), ["confirmed", "cancelled", "confirmed"]);
  assert.deepEqual(occurrences[1], {
    occurrenceId: secondId,
    seriesId: "LEGACY-SERIES",
    sourceDate: "2026-09-14",
    date: "2026-09-15",
    start: "18:30",
    scheduledDurationMinutes: 90,
    status: "cancelled",
    studentId: "STUDENT-B",
    teacherId: "TEACHER-B",
    packageId: "PACKAGE-B",
    subjectId: "SUBJECT-B",
  });
  assert.equal(occurrences[0].teacherId, "TEACHER-A");
  assert.equal(occurrences[2].teacherId, "TEACHER-A");
});

test("expands daily, every-other-day, weekly, biweekly and custom intervals", () => {
  for (const [interval, expectedSecondDate] of [[1, "2026-09-08"], [2, "2026-09-09"], [7, "2026-09-14"], [14, "2026-09-21"], [31, "2026-10-08"]] as const) {
    const occurrences = expandLessonOccurrences({
      id: `INTERVAL-${interval}`,
      date: "2026-09-07",
      start: "16:00",
      duration: 60,
      recurring: true,
      repeatCount: 2,
      recurrenceIntervalDays: interval,
      studentId: "STUDENT-A",
      teacherId: "TEACHER-A",
    }, { rangeStart: "2026-09-07", rangeEnd: "2026-10-31" });
    assert.equal(occurrences[1].date, expectedSecondDate);
    assert.equal(occurrences[1].sourceDate, expectedSecondDate);
  }
});

test("expansion truncates at the earlier repeat-count or recurrence-end bound", () => {
  const occurrences = expandLessonOccurrences({
    id: "END-DATE-SERIES",
    date: "2026-09-01",
    start: "16:00",
    duration: 60,
    recurring: true,
    repeatCount: 10,
    recurrenceIntervalDays: 2,
    recurrenceEndDate: "2026-09-05",
  }, { rangeStart: "2026-09-01", rangeEnd: "2026-09-30" });
  assert.deepEqual(occurrences.map((item) => item.date), ["2026-09-01", "2026-09-03", "2026-09-05"]);
  assert.equal(occurrences.at(-1)?.sourceDate, "2026-09-05");
});

test("rejects recurrence intervals outside the persisted contract", () => {
  assert.throws(() => expandLessonOccurrences({
    id: "INVALID-INTERVAL",
    date: "2026-09-07",
    start: "16:00",
    duration: 60,
    recurring: true,
    repeatCount: 2,
    recurrenceIntervalDays: 0,
  }, { rangeStart: "2026-09-01", rangeEnd: "2026-09-30" }), /1 to 365/);
});

test("finds occurrences moved before the series start or into an earlier target range", () => {
  const overrides = [{
    occurrenceId: lessonOccurrenceId("LEGACY-SERIES", "2026-08-10"),
    date: "2026-08-03",
    status: "completed" as const,
  }];

  assert.equal(earliestLessonOccurrenceTargetDate("2026-08-10", overrides), "2026-08-03");
  assert.deepEqual(
    lessonOccurrenceSourceRangeForTargetRange("2026-08-03", "2026-08-03", overrides),
    { rangeStart: "2026-08-03", rangeEnd: "2026-08-10" },
  );

  const occurrences = expandLessonOccurrences({
    id: "LEGACY-SERIES",
    date: "2026-08-10",
    start: "16:00",
    duration: 60,
    recurring: true,
    repeatCount: 2,
  }, {
    ...lessonOccurrenceSourceRangeForTargetRange("2026-08-03", "2026-08-03", overrides),
    overrides,
  }).filter((occurrence) => occurrence.date === "2026-08-03");

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].sourceDate, "2026-08-10");
  assert.equal(occurrences[0].status, "completed");
});

test("keeps two source occurrences distinct when both move to one target date", () => {
  const movedTarget = "2026-09-20";
  const overrides = [
    { occurrenceId: lessonOccurrenceId("COLLISION-SERIES", "2026-09-06"), date: movedTarget },
    { occurrenceId: lessonOccurrenceId("COLLISION-SERIES", "2026-09-13"), date: movedTarget },
  ];
  const occurrences = expandLessonOccurrences({
    id: "COLLISION-SERIES",
    date: "2026-09-06",
    start: "16:00",
    duration: 60,
    recurring: true,
    repeatCount: 2,
  }, {
    ...lessonOccurrenceSourceRangeForTargetRange(movedTarget, movedTarget, overrides),
    overrides,
  }).filter((item) => item.date === movedTarget);

  assert.deepEqual(occurrences.map((item) => item.occurrenceId), [
    "COLLISION-SERIES:2026-09-06",
    "COLLISION-SERIES:2026-09-13",
  ]);
  assert.deepEqual(occurrences.map((item) => item.sourceDate), ["2026-09-06", "2026-09-13"]);
  assert.equal(new Set(occurrences.map((item) => item.occurrenceId)).size, 2);
});

test("accumulates overlapping join/leave spans once and applies the attendance tolerance", () => {
  const result = evaluateLessonAttendance(occurrence(), {
    student: {
      userId: "STUDENT-A",
      joinLeave: [
        { joinedAt: "2026-09-07T10:00:00.000Z", leftAt: "2026-09-07T10:40:00.000Z" },
        { joinedAt: "2026-09-07T10:30:00.000Z", leftAt: "2026-09-07T11:00:00.000Z" },
      ],
    },
    teacher: { userId: "TEACHER-A", accumulatedSeconds: 3_300 },
  }, 300);

  assert.equal(result.studentSeconds, 3_600);
  assert.equal(result.teacherSeconds, 3_300);
  assert.equal(result.requiredSeconds, 3_300);
  assert.equal(result.classification, "normal");
});

test("completes once and duplicate webhook delivery neither re-deducts nor re-pays", () => {
  const initial = state();
  const first = completeLessonOccurrence(initial, { completedAt, attendance: attendance() });
  assert.equal(first.applied, true);
  assert.equal(first.occurrence.status, "completed");
  assert.equal(first.packages[0].consumedHours, 1);
  assert.equal(first.studentHoursLedger.length, 1);
  assert.equal(first.teacherPayrollLedger.length, 1);
  assert.equal(first.teacherPayrollLedger[0].id, "teacher-hours:SERIES-A:2026-09-07");

  const duplicate = completeLessonOccurrence(first, { completedAt, attendance: attendance() });
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.packages[0].consumedHours, 1);
  assert.equal(duplicate.studentHoursLedger.length, 1);
  assert.equal(duplicate.teacherPayrollLedger.length, 1);
  assert.throws(() => completeLessonOccurrence(first, {
    completedAt: "2026-09-07T11:00:01.000Z",
    attendance: attendance(),
  }), /different student deduction/);
});

test("missing either party or insufficient attendance marks only that occurrence abnormal", () => {
  const missingTeacher = completeLessonOccurrence(state(), {
    completedAt,
    attendance: { student: { userId: "STUDENT-A", accumulatedSeconds: 3_600 } },
  });
  assert.equal(missingTeacher.disposition, "abnormal");
  assert.equal(missingTeacher.occurrence.status, "abnormal");
  assert.ok(missingTeacher.attendance?.reasons.includes("missing_teacher"));
  assert.equal(missingTeacher.studentHoursLedger.length, 0);
  assert.equal(missingTeacher.teacherPayrollLedger.length, 0);

  const shortTeacher = completeLessonOccurrence(state(), {
    completedAt,
    attendance: attendance(3_600, 3_299),
  });
  assert.equal(shortTeacher.disposition, "abnormal");
  assert.ok(shortTeacher.attendance?.reasons.includes("teacher_duration_short"));
  assert.equal(shortTeacher.packages[0].consumedHours, 0);
});

test("expansion alone never deducts, and cancelled or leave occurrences are never billable", () => {
  const untouchedPackages = packages();
  expandLessonOccurrences({
    id: "SERIES-B",
    date: "2026-09-01",
    start: "10:00",
    duration: 60,
    recurring: true,
    repeatCount: 2,
  }, { rangeStart: "2026-09-01", rangeEnd: "2026-09-30" });
  assert.equal(untouchedPackages[0].consumedHours, 0);

  for (const status of ["cancelled", "leave"] as const) {
    const result = completeLessonOccurrence(state({ occurrence: occurrence({ status }) }), {
      completedAt,
      attendance: attendance(),
    });
    assert.equal(result.disposition, "not_billable");
    assert.equal(result.applied, false);
    assert.equal(result.packages[0].consumedHours, 0);
    assert.equal(result.studentHoursLedger.length, 0);
    assert.equal(result.teacherPayrollLedger.length, 0);
  }
});

test("requires every completion binding before attendance can settle the lesson", () => {
  for (const field of ["studentId", "teacherId", "packageId", "subjectId"] as const) {
    const incomplete = occurrence({ [field]: undefined });
    assert.throws(() => completeLessonOccurrence(state({ occurrence: incomplete }), {
      completedAt,
      attendance: attendance(),
    }), new RegExp(`occurrence\\.${field} is required`));
  }
  assert.throws(() => completeLessonOccurrence(state({
    occurrence: occurrence({ scheduledDurationMinutes: 0 }),
  }), { completedAt, attendance: attendance() }), /scheduled duration must be a positive number/);
});

test("reversal restores student balance and adds one payroll reversal idempotently", () => {
  const completed = completeLessonOccurrence(state(), { completedAt, attendance: attendance() });
  const reversedAt = "2026-09-08T00:00:00.000Z";
  const reversed = reverseLessonOccurrenceCompletion(completed, { reversedAt });
  assert.equal(reversed.applied, true);
  assert.equal(reversed.disposition, "reversed");
  assert.equal(reversed.occurrence.status, "confirmed");
  assert.equal(reversed.packages[0].consumedHours, 0);
  assert.equal(reversed.studentHoursLedger.length, 2);
  assert.equal(reversed.teacherPayrollLedger.length, 2);
  assert.equal(reversed.teacherPayrollLedger[1].kind, "reversal");

  const repeated = reverseLessonOccurrenceCompletion(reversed, { reversedAt });
  assert.equal(repeated.applied, false);
  assert.equal(repeated.packages[0].consumedHours, 0);
  assert.equal(repeated.studentHoursLedger.length, 2);
  assert.equal(repeated.teacherPayrollLedger.length, 2);
});

test("insufficient package balance throws atomically without changing any input", () => {
  const initial = state({ packages: packages(0.5) });
  const snapshot = structuredClone(initial);
  assert.throws(() => completeLessonOccurrence(initial, {
    completedAt,
    attendance: attendance(),
  }), /insufficient hours/);
  assert.deepEqual(initial, snapshot);
  assert.equal(initial.studentHoursLedger.length, 0);
  assert.equal(initial.teacherPayrollLedger.length, 0);
});
