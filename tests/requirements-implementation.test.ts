import assert from "node:assert/strict";
import test from "node:test";
import { isLessonDuration } from "../lib/lesson-duration.ts";
import { splitAvailability } from "../lib/availability-occupancy.ts";
test("durations accept 180 and custom whole minutes with bounded input", () => {
  for (const value of [15, 40, 60, 90, 120, 180, 360]) assert.equal(isLessonDuration(value), true);
  for (const value of [0, 14, 361, -1, 40.5, NaN, Infinity, "60", null]) assert.equal(isLessonDuration(value), false);
});
test("AVA splits a broad window around occupied lessons and unions overlaps", () => {
  const window = { teacherId: "T", startsAt: "2026-09-07T08:00:00Z", endsAt: "2026-09-07T13:00:00Z" };
  const result = splitAvailability(window, [{ id: "B", teacherId: "T", startsAt: "2026-09-07T08:20:00Z", endsAt: "2026-09-07T09:20:00Z", label: "Student A · English" }]);
  assert.deepEqual(result.map((part) => [part.occupied, Date.parse(part.endsAt) - Date.parse(part.startsAt)]), [[false, 20*60000], [true, 60*60000], [false, 220*60000]]);
  assert.equal(splitAvailability(window, [{ id: "B", teacherId: "Other", startsAt: window.startsAt, endsAt: window.endsAt, label: "Other" }]).length, 1);
  const overlaps = splitAvailability(window, [{ id: "1", teacherId: "T", startsAt: window.startsAt, endsAt: "2026-09-07T10:00:00Z", label: "A" }, { id: "2", teacherId: "T", startsAt: "2026-09-07T09:00:00Z", endsAt: window.endsAt, label: "B" }]);
  assert(overlaps.every((part) => part.occupied));
  assert.deepEqual(overlaps[1].labels, ["A", "B"]);
});
import { classroomEntryOpen, signClassroomEntry, verifyClassroomEntry } from "../lib/classroom-entry.ts";
test("classroom time gate checks the precise opening boundary and signed course identity", () => {
  const start = Date.parse("2026-09-07T08:00:00Z");
  assert.equal(classroomEntryOpen(start, 60, start - 900001), false);
  assert.equal(classroomEntryOpen(start, 60, start - 900000), true);
  assert.equal(classroomEntryOpen(start, 60, start + 3600001), false);
  const prior = process.env.BBB_API_SECRET;
  process.env.BBB_API_SECRET = "synthetic-test-only-secret";
  try {
    const entry = { occurrenceId: "B:2026-09-07", studentId: "S", teacherId: "T", date: "2026-09-07", start: "18:00", duration: 60, timezone: "Australia/Melbourne" };
    const token = signClassroomEntry(entry);
    assert.deepEqual(verifyClassroomEntry(token), entry);
    assert.equal(verifyClassroomEntry(`x${token}`), null);
    assert.equal(verifyClassroomEntry(token + ".extra"), null);
  } finally { if (prior === undefined) delete process.env.BBB_API_SECRET; else process.env.BBB_API_SECRET = prior; }
});
import { classroomProvisionPlan } from "../lib/classroom-provision-plan.ts";
test("background provision selects concrete upcoming lessons including moved occurrences", () => {
 const now = new Date("2026-09-07T07:45:00Z");
 const booking = { id: "B", date: "2026-09-07", start: "18:00", duration: 60, studentId: "S", teacherId: "T", timezone: "Australia/Melbourne" };
 assert.equal(classroomProvisionPlan([booking], now).length, 1);
 assert.equal(classroomProvisionPlan([{ ...booking, occurrenceOverrides: [{ occurrenceId: "B:2026-09-07", status: "cancelled" }] }], now).length, 0);
 assert.equal(classroomProvisionPlan([{ ...booking, date: "2026-09-01", occurrenceOverrides: [{ occurrenceId: "B:2026-09-01", date: "2026-09-07" }] }], now).length, 1);
 assert.equal(classroomProvisionPlan([booking], new Date("2026-09-07T07:00:00Z")).length, 0);
});
