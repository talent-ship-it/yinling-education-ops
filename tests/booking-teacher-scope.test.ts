import assert from "node:assert/strict";
import test from "node:test";

import { bookingHasEffectiveTeacher } from "../lib/booking-teacher-scope";

const ids = (...values: string[]) => new Set(values);

test("a one-off substitute override replaces the parent teacher scope", () => {
  const booking = {
    id: "B-1",
    date: "2026-09-01",
    teacherId: "T-1",
    occurrenceOverrides: [{
      occurrenceId: "B-1:2026-09-01",
      teacherId: "T-2",
      status: "confirmed",
    }],
  };

  assert.equal(bookingHasEffectiveTeacher(booking, ids("T-1")), false);
  assert.equal(bookingHasEffectiveTeacher(booking, ids("T-2")), true);
});

test("a recurring series can belong to its parent and substitute teachers", () => {
  const booking = {
    id: "B-2",
    date: "2026-09-01",
    teacherId: "T-1",
    recurring: true,
    occurrenceOverrides: [{
      occurrenceId: "B-2:2026-09-08",
      teacherId: "T-2",
      status: "confirmed",
    }],
  };

  assert.equal(bookingHasEffectiveTeacher(booking, ids("T-1")), true);
  assert.equal(bookingHasEffectiveTeacher(booking, ids("T-2")), true);
});

test("an explicit null teacher override grants neither parent nor another teacher", () => {
  const booking = {
    id: "B-3",
    date: "2026-09-01",
    teacherId: "T-1",
    occurrenceOverrides: [{
      occurrenceId: "B-3:2026-09-01",
      teacherId: null,
      status: "confirmed",
    }],
  };

  assert.equal(bookingHasEffectiveTeacher(booking, ids("T-1")), false);
  assert.equal(bookingHasEffectiveTeacher(booking, ids("T-2")), false);
});
