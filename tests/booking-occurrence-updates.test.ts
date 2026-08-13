import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOperationOccurrenceChange,
  updateBookingOccurrence,
} from "../lib/booking-occurrence-updates.ts";
import { expandLessonOccurrences } from "../lib/lesson-occurrences.ts";

const series = {
  id: "SERIES-A",
  date: "2026-09-01",
  start: "16:00",
  duration: 60,
  recurring: true,
  repeatCount: 5,
  studentId: "STUDENT-A",
  teacherId: "TEACHER-A",
  packageId: "PACKAGE-A",
  course: "English",
} as const;

test("edits one occurrence without mutating the weekly series", () => {
  const updated = updateBookingOccurrence([series], {
    occurrenceId: "SERIES-A:2026-09-08",
    date: "2026-09-09",
    start: "17:30",
  });
  assert.equal(updated[0].date, "2026-09-01");
  assert.equal(updated[0].start, "16:00");
  const occurrences = expandLessonOccurrences(updated[0], {
    rangeStart: "2026-09-01",
    rangeEnd: "2026-09-15",
    overrides: updated[0].occurrenceOverrides,
  });
  assert.deepEqual(occurrences.map(({ sourceDate, date, start }) => ({ sourceDate, date, start })), [
    { sourceDate: "2026-09-01", date: "2026-09-01", start: "16:00" },
    { sourceDate: "2026-09-08", date: "2026-09-09", start: "17:30" },
    { sourceDate: "2026-09-15", date: "2026-09-15", start: "16:00" },
  ]);
});

test("marks only affected leave occurrences and preserves completed lessons", () => {
  const withCompleted = updateBookingOccurrence([series], {
    occurrenceId: "SERIES-A:2026-09-08",
    status: "completed",
  });
  const changed = applyOperationOccurrenceChange(withCompleted, {
    sourceTeacherId: "TEACHER-A",
    rangeStart: "2026-09-08",
    rangeEnd: "2026-09-22",
    action: "leave",
  });
  assert.deepEqual(changed.affectedOccurrenceIds, [
    "SERIES-A:2026-09-15",
    "SERIES-A:2026-09-22",
  ]);
  const statuses = expandLessonOccurrences(changed.bookings[0], {
    rangeStart: "2026-09-08",
    rangeEnd: "2026-09-22",
    overrides: changed.bookings[0].occurrenceOverrides,
  }).map(({ sourceDate, status }) => [sourceDate, status]);
  assert.deepEqual(statuses, [
    ["2026-09-08", "completed"],
    ["2026-09-15", "leave"],
    ["2026-09-22", "leave"],
  ]);
});

test("moves the selected student occurrences to a substitute teacher only", () => {
  const otherStudent = { ...series, id: "SERIES-B", studentId: "STUDENT-B" };
  const changed = applyOperationOccurrenceChange([series, otherStudent], {
    sourceTeacherId: "TEACHER-A",
    studentId: "STUDENT-A",
    rangeStart: "2026-09-01",
    rangeEnd: "2026-09-08",
    action: "substitute",
    substituteTeacherId: "TEACHER-C",
  });
  assert.deepEqual(changed.affectedOccurrenceIds, [
    "SERIES-A:2026-09-01",
    "SERIES-A:2026-09-08",
  ]);
  assert.equal(changed.bookings[0].occurrenceOverrides?.[0].teacherId, "TEACHER-C");
  assert.equal(changed.bookings[1].occurrenceOverrides, undefined);
});

test("reapplying an operation is idempotent and invalid substitutes fail", () => {
  const input = {
    sourceTeacherId: "TEACHER-A",
    rangeStart: "2026-09-01",
    rangeEnd: "2026-09-08",
    action: "substitute" as const,
    substituteTeacherId: "TEACHER-C",
  };
  const first = applyOperationOccurrenceChange([series], input);
  const second = applyOperationOccurrenceChange(first.bookings, input);
  assert.deepEqual(second.bookings, first.bookings);
  assert.throws(() => applyOperationOccurrenceChange([series], {
    ...input,
    substituteTeacherId: "TEACHER-A",
  }), /must be different/);
});
