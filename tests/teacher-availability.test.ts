import assert from "node:assert/strict";
import test from "node:test";

import {
  TeacherAvailabilityValidationError,
  approveTeacherAvailabilitySubmission,
  assertValidAvailabilitySlots,
  createMonthlyAvailabilityWindows,
  deleteAllTeacherAvailability,
  deleteAvailabilityDate,
  deleteAvailabilityWeek,
  editAvailabilityDate,
  expandTeacherAvailability,
  normalizeLegacyAvailability,
  projectTeacherSchedulingReadiness,
  promoteLegacyAvailabilityForMonth,
  type TeacherAvailabilityWindow,
} from "../lib/teacher-availability";

test("raw teacher wording remains review evidence and is never guessed into AVA or capacity", () => {
  const review = projectTeacherSchedulingReadiness({
    teacherId: "teacher-a",
    availabilitySourceText: "周一下午，具体再问我",
    capacitySourceText: "大概还能接三个",
    acceptsStudents: true,
  });
  assert.equal(review.availability.status, "review_required");
  assert.equal(review.availability.rawSourceText, "周一下午，具体再问我");
  assert.equal(review.capacity.status, "review_required");
  assert.equal(review.capacity.rawSourceText, "大概还能接三个");
  assert.equal(review.capacity.remaining, undefined);
  assert.equal(review.readyForNewStudentMatching, false);
  assert.deepEqual(review.reviewReasons, ["availability_missing", "capacity_missing"]);
});

test("teacher scheduling readiness requires confirmed structured inputs", () => {
  const windows = monthly("teacher-a", "2026-10", [{ day: 1, start: "09:00", end: "10:00" }]);
  const ready = projectTeacherSchedulingReadiness({
    teacherId: "teacher-a",
    availabilityWindows: windows,
    newStudentCapacity: 0,
    acceptsStudents: true,
    now: new Date("2026-10-05T00:00:00.000Z"),
  });
  assert.equal(ready.availability.confirmedWindowCount, 1);
  assert.equal(ready.capacity.remaining, 0);
  assert.equal(ready.readyForNewStudentMatching, false, "zero remaining capacity is configured but not matchable");
  assert.deepEqual(ready.reviewReasons, []);

  const wrongTeacher = projectTeacherSchedulingReadiness({
    teacherId: "teacher-b",
    availabilityWindows: windows,
    newStudentCapacity: 1,
    acceptsStudents: true,
    now: new Date("2026-10-05T00:00:00.000Z"),
  });
  assert.deepEqual(wrongTeacher.reviewReasons, ["availability_invalid"]);
});

test("expired-only structured AVA is not ready for new-student matching", () => {
  const review = projectTeacherSchedulingReadiness({
    teacherId: "teacher-a",
    availabilityWindows: monthly("teacher-a", "2026-07", [{ day: 1, start: "09:00", end: "10:00" }]),
    newStudentCapacity: 2,
    acceptsStudents: true,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });

  assert.equal(review.availability.status, "review_required");
  assert.equal(review.availability.confirmedWindowCount, 0);
  assert.equal(review.readyForNewStudentMatching, false);
  assert.deepEqual(review.reviewReasons, ["availability_expired"]);
});

function monthly(
  teacherId: string,
  month: string,
  slots: Array<{ day: number; start: string; end: string }>,
  timezone = "Australia/Melbourne",
): TeacherAvailabilityWindow[] {
  return createMonthlyAvailabilityWindows({
    teacherId,
    month,
    timezone,
    slots,
    idSeed: `${teacherId}-${month}`,
  });
}

function expectCode(
  code: TeacherAvailabilityValidationError["code"],
  operation: () => unknown,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof TeacherAvailabilityValidationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("legacy normalization stays explicitly unbounded and unconfirmed", () => {
  const legacy = normalizeLegacyAvailability("teacher-a", "Australia/Melbourne", [
    { day: 1, start: "09:00", end: "12:00" },
  ]);

  assert.equal(legacy.kind, "legacy-weekly-template");
  assert.equal(legacy.monthlyConfirmed, false);
  assert.equal("month" in legacy, false);
  assert.match(legacy.slots[0].id, /^legacy_/);

  const promoted = promoteLegacyAvailabilityForMonth(legacy, "2026-10");
  assert.equal(promoted[0].validFrom, "2026-10-01");
  assert.equal(promoted[0].validTo, "2026-10-31");
  assert.equal(promoted[0].source, "legacy-promoted");
});

test("cross-midnight availability uses the source timezone and next source date", () => {
  const windows = monthly("teacher-a", "2026-01", [
    { day: 6, start: "23:30", end: "01:00" },
  ]);
  const occurrences = expandTeacherAvailability(windows, {
    from: "2026-01-03",
    to: "2026-01-03",
    displayTimezone: "UTC",
  });

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].sourceDate, "2026-01-03");
  assert.equal(occurrences[0].sourceEndDate, "2026-01-04");
  assert.equal(occurrences[0].startsAt, "2026-01-03T12:30:00.000Z");
  assert.equal(occurrences[0].endsAt, "2026-01-03T14:00:00.000Z");
  assert.equal(occurrences[0].displayStart, "12:30");
  assert.equal(occurrences[0].displayEnd, "14:00");
});

test("recurrences follow source-zone DST while rendering in a display timezone", () => {
  const windows: TeacherAvailabilityWindow[] = [
    {
      id: "dst-window",
      teacherId: "teacher-a",
      day: 1,
      start: "09:00",
      end: "10:00",
      timezone: "Australia/Melbourne",
      validFrom: "2026-09-28",
      validTo: "2026-10-05",
      excludedDates: [],
      overrides: [],
      source: "manual",
    },
  ];
  const occurrences = expandTeacherAvailability(windows, {
    from: "2026-09-28",
    to: "2026-10-05",
    displayTimezone: "Asia/Shanghai",
  });

  assert.deepEqual(
    occurrences.map(({ sourceDate, startsAt, displayStart }) => ({
      sourceDate,
      startsAt,
      displayStart,
    })),
    [
      {
        sourceDate: "2026-09-28",
        startsAt: "2026-09-27T23:00:00.000Z",
        displayStart: "07:00",
      },
      {
        sourceDate: "2026-10-05",
        startsAt: "2026-10-04T22:00:00.000Z",
        displayStart: "06:00",
      },
    ],
  );
});

test("an interval spanning a DST jump represents the real elapsed duration", () => {
  const windows = monthly("teacher-a", "2026-10", [
    { day: 0, start: "01:30", end: "03:30" },
  ]);
  const [transition] = expandTeacherAvailability(windows, {
    from: "2026-10-04",
    to: "2026-10-04",
    displayTimezone: "Australia/Melbourne",
  });

  assert.equal(transition.startsAt, "2026-10-03T15:30:00.000Z");
  assert.equal(transition.endsAt, "2026-10-03T16:30:00.000Z");
  assert.equal(
    new Date(transition.endsAt).getTime() - new Date(transition.startsAt).getTime(),
    60 * 60 * 1_000,
  );
});

test("editing one occurrence leaves the next weekly occurrence unchanged", () => {
  const original = monthly("teacher-a", "2026-10", [
    { day: 1, start: "09:00", end: "10:00" },
  ]);
  const edited = editAvailabilityDate(original, {
    windowId: original[0].id,
    date: "2026-10-12",
    start: "14:00",
    end: "15:30",
  });
  const occurrences = expandTeacherAvailability(edited, {
    from: "2026-10-12",
    to: "2026-10-19",
    displayTimezone: "Australia/Melbourne",
  });

  assert.deepEqual(
    occurrences.map(({ sourceDate, sourceStart, sourceEnd, isOverride }) => ({
      sourceDate,
      sourceStart,
      sourceEnd,
      isOverride,
    })),
    [
      {
        sourceDate: "2026-10-12",
        sourceStart: "14:00",
        sourceEnd: "15:30",
        isOverride: true,
      },
      {
        sourceDate: "2026-10-19",
        sourceStart: "09:00",
        sourceEnd: "10:00",
        isOverride: false,
      },
    ],
  );
  assert.equal(original[0].overrides.length, 0);
});

test("deleting one occurrence does not delete the following week", () => {
  const original = monthly("teacher-a", "2026-10", [
    { day: 1, start: "09:00", end: "10:00" },
  ]);
  const deleted = deleteAvailabilityDate(original, {
    windowId: original[0].id,
    date: "2026-10-12",
  });
  const occurrences = expandTeacherAvailability(deleted, {
    from: "2026-10-12",
    to: "2026-10-19",
    displayTimezone: "Australia/Melbourne",
  });

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.sourceDate),
    ["2026-10-19"],
  );
  assert.deepEqual(original[0].excludedDates, []);
});

test("deleting a week removes that week only, including its overrides", () => {
  const original = monthly("teacher-a", "2026-10", [
    { day: 1, start: "09:00", end: "10:00" },
    { day: 3, start: "13:00", end: "14:00" },
  ]);
  const edited = editAvailabilityDate(original, {
    windowId: original.find((window) => window.day === 3)!.id,
    date: "2026-10-14",
    start: "15:00",
    end: "16:00",
  });
  const deleted = deleteAvailabilityWeek(edited, {
    teacherId: "teacher-a",
    weekOf: "2026-10-14",
  });
  const occurrences = expandTeacherAvailability(deleted, {
    from: "2026-10-12",
    to: "2026-10-21",
    displayTimezone: "Australia/Melbourne",
  });

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.sourceDate),
    ["2026-10-19", "2026-10-21"],
  );
  assert.equal(deleted.flatMap((window) => window.overrides).length, 0);
});

test("deleting all availability is teacher-scoped and never touches bookings", () => {
  const teacherA = monthly("teacher-a", "2026-10", [
    { day: 1, start: "09:00", end: "10:00" },
  ]);
  const teacherB = monthly("teacher-b", "2026-10", [
    { day: 2, start: "11:00", end: "12:00" },
  ]);
  const bookings = Object.freeze([
    Object.freeze({ id: "booking-1", teacherId: "teacher-a", startsAt: "2026-10-12T00:00:00Z" }),
  ]);

  const result = deleteAllTeacherAvailability([...teacherA, ...teacherB], "teacher-a");

  assert.deepEqual(result, teacherB);
  assert.deepEqual(bookings, [
    { id: "booking-1", teacherId: "teacher-a", startsAt: "2026-10-12T00:00:00Z" },
  ]);
});

test("approval replaces only the submitted teacher-month and preserves other dates", () => {
  const spanning: TeacherAvailabilityWindow = {
    id: "existing-span",
    teacherId: "teacher-a",
    day: 1,
    start: "09:00",
    end: "10:00",
    timezone: "Australia/Melbourne",
    validFrom: "2026-09-01",
    validTo: "2026-11-30",
    excludedDates: ["2026-09-14", "2026-10-12", "2026-11-16"],
    overrides: [
      {
        id: "november-override",
        date: "2026-11-09",
        start: "13:00",
        end: "14:00",
      },
    ],
    source: "manual",
  };
  const otherTeacher = monthly("teacher-b", "2026-10", [
    { day: 4, start: "15:00", end: "16:00" },
  ])[0];
  const existing = [spanning, otherTeacher];
  const snapshot = structuredClone(existing);
  const submission = {
    id: "submission-42",
    teacherId: "teacher-a",
    month: "2026-10",
    timezone: "Australia/Melbourne",
    slots: [{ day: 2, start: "11:00", end: "12:30" }],
  } as const;

  const result = approveTeacherAvailabilitySubmission(existing, submission);
  const teacherA = result.filter((window) => window.teacherId === "teacher-a");

  assert.deepEqual(existing, snapshot);
  assert.deepEqual(
    teacherA.map(({ validFrom, validTo, day, source }) => ({
      validFrom,
      validTo,
      day,
      source,
    })),
    [
      { validFrom: "2026-09-01", validTo: "2026-09-30", day: 1, source: "manual" },
      {
        validFrom: "2026-10-01",
        validTo: "2026-10-31",
        day: 2,
        source: "submission",
      },
      { validFrom: "2026-11-01", validTo: "2026-11-30", day: 1, source: "manual" },
    ],
  );
  assert.deepEqual(
    teacherA.flatMap((window) => window.excludedDates),
    ["2026-09-14", "2026-11-16"],
  );
  assert.equal(result.find((window) => window.teacherId === "teacher-b")!.id, otherTeacher.id);
  assert.deepEqual(
    approveTeacherAvailabilitySubmission(existing, submission),
    result,
    "the same approval produces stable ids and output",
  );
});

test("duplicate and overlapping weekly inputs are rejected before writeback", () => {
  expectCode("duplicate-id", () =>
    assertValidAvailabilitySlots([
      { id: "same", day: 1, start: "09:00", end: "10:00" },
      { id: "same", day: 2, start: "11:00", end: "12:00" },
    ]),
  );
  expectCode("duplicate-slot", () =>
    assertValidAvailabilitySlots([
      { day: 1, start: "09:00", end: "10:00" },
      { day: 1, start: "09:00", end: "10:00" },
    ]),
  );
  expectCode("overlap", () =>
    assertValidAvailabilitySlots([
      { day: 1, start: "09:00", end: "11:00" },
      { day: 1, start: "10:30", end: "12:00" },
    ]),
  );
  expectCode("overlap", () =>
    assertValidAvailabilitySlots([
      { day: 1, start: "23:00", end: "02:00" },
      { day: 2, start: "01:30", end: "03:00" },
    ]),
  );
  assert.doesNotThrow(() =>
    assertValidAvailabilitySlots([
      { day: 1, start: "09:00", end: "10:00" },
      { day: 1, start: "10:00", end: "11:00" },
    ]),
  );
});

test("an edit that overlaps another window fails without mutating either window", () => {
  const original = monthly("teacher-a", "2026-10", [
    { day: 1, start: "09:00", end: "10:00" },
    { day: 1, start: "11:00", end: "12:00" },
  ]);
  const snapshot = structuredClone(original);

  expectCode("overlap", () =>
    editAvailabilityDate(original, {
      windowId: original[1].id,
      date: "2026-10-12",
      start: "09:30",
      end: "11:30",
    }),
  );
  assert.deepEqual(original, snapshot);
});
