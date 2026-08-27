import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS,
  recurrenceIntervalForFrequency,
  recurrenceOccurrenceCount,
  recurrenceSourceEndDate,
  validateBookingRecurrence,
} from "../lib/booking-recurrence.ts";

test("the six booking frequencies map to the shared interval contract", () => {
  assert.equal(recurrenceIntervalForFrequency("single"), undefined);
  assert.equal(recurrenceIntervalForFrequency("daily"), 1);
  assert.equal(recurrenceIntervalForFrequency("every_other_day"), 2);
  assert.equal(recurrenceIntervalForFrequency("weekly"), 7);
  assert.equal(recurrenceIntervalForFrequency("biweekly"), 14);
  assert.equal(recurrenceIntervalForFrequency("custom", 31), 31);
});

test("legacy recurring rows default to weekly while finite bounds take the earlier date", () => {
  assert.equal(LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS, 7);
  assert.equal(recurrenceSourceEndDate({ startDate: "2026-09-01", recurring: true, repeatCount: 3 }), "2026-09-15");
  assert.equal(recurrenceSourceEndDate({ startDate: "2026-09-01", recurring: true, repeatCount: 10, recurrenceIntervalDays: 2, recurrenceEndDate: "2026-09-05" }), "2026-09-05");
  assert.equal(recurrenceSourceEndDate({ startDate: "2026-09-01", recurring: true, recurrenceEndDate: "2026-09-05" }), "2026-09-05");
  assert.equal(recurrenceSourceEndDate({ startDate: "2026-09-01", recurring: true }), undefined);
  assert.equal(recurrenceOccurrenceCount({ startDate: "2026-09-01", recurring: true, recurrenceIntervalDays: 2, recurrenceEndDate: "2026-09-05" }), 3);
  assert.equal(recurrenceOccurrenceCount({ startDate: "2026-01-01", recurring: true, recurrenceEndDate: "2028-01-01" }), 105);
});

test("recurrence validation rejects malformed interval, count, and end-date input", () => {
  assert.throws(() => validateBookingRecurrence({ recurring: true, recurrenceIntervalDays: 0 }), /1 to 365/);
  assert.throws(() => validateBookingRecurrence({ recurring: true, repeatCount: 105 }), /1 to 104/);
  assert.throws(() => validateBookingRecurrence({ startDate: "2026-09-10", recurring: true, repeatCount: 2, recurrenceEndDate: "2026-09-09" }), /on or after/);
  assert.throws(() => validateBookingRecurrence({ recurring: false, repeatCount: 2 }), /repeatCount 1/);
});
