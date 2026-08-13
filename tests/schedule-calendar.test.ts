import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScheduleMonth,
  scheduleMonthWindow,
  shiftScheduleMonth,
  stableStudentCalendarColor,
  subtractBookedFromAvailability,
  summarizeScheduleAttendance,
  type ScheduleCalendarOccurrence,
} from "../lib/schedule-calendar.ts";

function occurrence(
  occurrenceId: string,
  date: string,
  status: ScheduleCalendarOccurrence["status"] = "confirmed",
  overrides: Partial<ScheduleCalendarOccurrence> = {},
): ScheduleCalendarOccurrence {
  return {
    occurrenceId,
    date,
    start: "10:00",
    timezone: "Australia/Melbourne",
    studentId: "STUDENT-A",
    status,
    ...overrides,
  };
}

test("builds a Monday-first month grid and navigates across year boundaries", () => {
  assert.deepEqual(scheduleMonthWindow("2026-09"), {
    month: "2026-09",
    monthStart: "2026-09-01",
    monthEnd: "2026-09-30",
    gridStart: "2026-08-31",
    gridEnd: "2026-10-04",
  });
  assert.equal(shiftScheduleMonth("2026-01", -1), "2025-12");
  assert.equal(shiftScheduleMonth("2026-12", 1), "2027-01");
});

test("groups concrete occurrences in display timezone, sorts them, and does not duplicate an occurrence", () => {
  const lateSydney = occurrence("SERIES-A:2026-08-31", "2026-08-31", "confirmed", {
    start: "23:30",
    timezone: "Australia/Sydney",
  });
  const early = occurrence("SERIES-B:2026-09-01", "2026-09-01", "confirmed", { start: "08:00" });
  const days = buildScheduleMonth("2026-09", [lateSydney, early, early], "Australia/Perth");

  assert.equal(days.length, 35);
  assert.deepEqual(days.find((day) => day.date === "2026-08-31")?.occurrences.map((item) => item.occurrenceId), [lateSydney.occurrenceId]);
  assert.deepEqual(days.find((day) => day.date === "2026-09-01")?.occurrences.map((item) => item.occurrenceId), [early.occurrenceId]);
});

test("attendance uses occurrence status only and excludes future, leave, and cancelled lessons", () => {
  const summary = summarizeScheduleAttendance([
    occurrence("completed", "2026-08-10", "completed"),
    occurrence("unresolved", "2026-08-11", "confirmed"),
    occurrence("abnormal", "2026-08-12", "abnormal"),
    occurrence("future", "2026-08-13", "completed", { start: "19:00" }),
    occurrence("leave", "2026-08-12", "leave"),
    occurrence("cancelled", "2026-08-12", "cancelled"),
    occurrence("duplicate", "2026-08-12", "completed"),
    occurrence("duplicate", "2026-08-12", "completed"),
  ], {
    rangeStart: "2026-08-07",
    rangeEnd: "2026-08-13",
    now: new Date("2026-08-13T06:00:00.000Z"),
    reportingTimezone: "Australia/Melbourne",
  });

  assert.deepEqual(summary, {
    scheduled: 4,
    present: 2,
    unresolved: 2,
    rate: 50,
    basis: "occurrence_status",
  });
});

test("attendance reports no rate when there are no elapsed scheduled occurrences", () => {
  assert.deepEqual(summarizeScheduleAttendance([], {
    rangeStart: "2026-08-01",
    rangeEnd: "2026-08-31",
    now: new Date("2026-08-13T00:00:00.000Z"),
    reportingTimezone: "Australia/Melbourne",
  }), {
    scheduled: 0,
    present: 0,
    unresolved: 0,
    rate: null,
    basis: "occurrence_status",
  });
});

test("student colours are stable, opaque identifiers do not leak, and students spread across the palette", () => {
  const first = stableStudentCalendarColor("STUDENT-A");
  assert.deepEqual(stableStudentCalendarColor("STUDENT-A"), first);
  assert.notDeepEqual(stableStudentCalendarColor("STUDENT-B"), first);
  assert.equal(JSON.stringify(first).includes("STUDENT-A"), false);
});

test("subtracts booked instants from confirmed teacher availability", () => {
  const free = subtractBookedFromAvailability([
    { id: "ava-1", startsAt: "2026-09-07T06:00:00.000Z", endsAt: "2026-09-07T10:00:00.000Z" },
  ], [
    { id: "lesson-1", startsAt: "2026-09-07T07:00:00.000Z", endsAt: "2026-09-07T08:00:00.000Z" },
  ], "Australia/Melbourne");

  assert.deepEqual(free.map((entry) => ({ date: entry.date, startsAt: entry.startsAt, endsAt: entry.endsAt })), [
    { date: "2026-09-07", startsAt: "2026-09-07T06:00:00.000Z", endsAt: "2026-09-07T07:00:00.000Z" },
    { date: "2026-09-07", startsAt: "2026-09-07T08:00:00.000Z", endsAt: "2026-09-07T10:00:00.000Z" },
  ]);
});

test("rejects malformed calendar inputs", () => {
  assert.throws(() => scheduleMonthWindow("2026-13"), /valid calendar month/);
  assert.throws(() => summarizeScheduleAttendance([], {
    rangeStart: "2026-08-31",
    rangeEnd: "2026-08-01",
    now: new Date(),
    reportingTimezone: "Australia/Melbourne",
  }), /rangeEnd/);
});
