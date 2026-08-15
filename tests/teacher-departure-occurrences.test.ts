import assert from "node:assert/strict";
import test from "node:test";

import {
  projectTeacherDepartureOccurrences,
  TeacherDepartureProjectionError,
} from "../lib/teacher-departure-occurrences";

test("departure projection starts at the effective date and includes every student's finite future lesson", () => {
  const projected = projectTeacherDepartureOccurrences({
    teacherId: "T-1",
    effectiveDate: "2026-09-08",
    bookings: [
      {
        id: "B-1",
        studentId: "S-1",
        teacherId: "T-1",
        date: "2026-09-01",
        start: "17:00",
        duration: 60,
        recurring: true,
        repeatCount: 4,
        occurrenceOverrides: [{ occurrenceId: "B-1:2026-09-15", status: "cancelled" }],
      },
      {
        id: "B-2",
        studentId: "S-2",
        teacherId: "T-1",
        date: "2026-09-10",
        start: "18:00",
        duration: 90,
        recurring: false,
      },
      {
        id: "B-SUB",
        studentId: "S-3",
        teacherId: "T-1",
        date: "2026-09-12",
        start: "19:00",
        duration: 60,
        recurring: false,
        kind: "代课",
      },
    ],
  });

  assert.deepEqual(projected.map(({ occurrence }) => occurrence.occurrenceId), [
    "B-1:2026-09-08",
    "B-2:2026-09-10",
    "B-1:2026-09-22",
  ]);
  assert.deepEqual(new Set(projected.map(({ occurrence }) => occurrence.studentId)), new Set(["S-1", "S-2"]));
});

test("departure projection follows moved occurrence dates and teacher overrides", () => {
  const projected = projectTeacherDepartureOccurrences({
    teacherId: "T-1",
    effectiveDate: "2026-09-20",
    bookings: [{
      id: "B-1",
      studentId: "S-1",
      teacherId: "T-OTHER",
      date: "2026-09-01",
      start: "17:00",
      duration: 60,
      recurring: true,
      repeatCount: 3,
      occurrenceOverrides: [{
        occurrenceId: "B-1:2026-09-08",
        date: "2026-10-01",
        teacherId: "T-1",
      }],
    }],
  });

  assert.deepEqual(projected.map(({ occurrence }) => ({
    id: occurrence.occurrenceId,
    date: occurrence.date,
    teacherId: occurrence.teacherId,
  })), [{ id: "B-1:2026-09-08", date: "2026-10-01", teacherId: "T-1" }]);
});

test("departure projection fails closed for a matching count-less legacy series", () => {
  assert.throws(() => projectTeacherDepartureOccurrences({
    teacherId: "T-1",
    effectiveDate: "2026-09-08",
    bookings: [{
      id: "B-OLD",
      studentId: "S-1",
      teacherId: "T-1",
      date: "2026-09-01",
      start: "17:00",
      duration: 60,
      recurring: true,
    }],
  }), (error: unknown) => error instanceof TeacherDepartureProjectionError
    && error.code === "unbounded_future_series"
    && /1-104/.test(error.message));
});

test("student-scoped projection ignores another student's count-less series", () => {
  const projected = projectTeacherDepartureOccurrences({
    teacherId: "T-1",
    studentId: "S-TARGET",
    effectiveDate: "2026-09-08",
    bookings: [
      {
        id: "B-OLD-OTHER",
        studentId: "S-OTHER",
        teacherId: "T-1",
        date: "2026-09-01",
        start: "17:00",
        duration: 60,
        recurring: true,
      },
      {
        id: "B-TARGET",
        studentId: "S-TARGET",
        teacherId: "T-1",
        date: "2026-09-08",
        start: "18:00",
        duration: 60,
        recurring: false,
      },
    ],
  });

  assert.deepEqual(projected.map(({ occurrence }) => occurrence.occurrenceId), ["B-TARGET:2026-09-08"]);
});
