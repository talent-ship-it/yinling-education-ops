import assert from "node:assert/strict";
import test from "node:test";
import { classroomMeetingDurationMinutes } from "../lib/classroom-duration.ts";
import { classroomProvisionPlan } from "../lib/classroom-provision-plan.ts";
import { localTimeToInstant } from "../lib/teacher-availability.ts";

test("the first pre-provisioned room lasts through the entire scheduled lesson", () => {
  const now = new Date("2026-09-09T23:42:00Z");
  const booking = { id: "B", date: "2026-09-10", start: "10:00", duration: 60, timezone: "Australia/Melbourne", studentId: "S", teacherId: "T" };
  const [{ occurrence, startsAt }] = classroomProvisionPlan([booking], now);
  const providerDuration = classroomMeetingDurationMinutes(startsAt, occurrence.scheduledDurationMinutes, now.getTime());
  assert.equal(providerDuration, 78);
  const originalProviderEnd = now.getTime() + providerDuration * 60_000;
  assert.equal(originalProviderEnd, startsAt + 60 * 60_000);
  assert.equal(occurrence.scheduledDurationMinutes, 60);

  // BBB ignores subsequent create durations: coverage must not depend on a
  // second request extending or restarting the first room's timer.
  const joinTime = startsAt - 15 * 60_000;
  const duplicateDuration = classroomMeetingDurationMinutes(startsAt, 60, joinTime);
  assert.equal(duplicateDuration, 75);
  assert.equal(originalProviderEnd, joinTime + duplicateDuration * 60_000);
});

test("six-hour lessons retain all teaching minutes after early creation", () => {
  const startsAt = Date.parse("2026-09-10T00:00:00Z");
  for (const duration of [15, 40, 180, 360]) {
    const createdAt = startsAt - 20 * 60_000;
    const roomMinutes = classroomMeetingDurationMinutes(startsAt, duration, createdAt);
    assert.equal(roomMinutes, duration + 20);
    assert.equal(createdAt + roomMinutes * 60_000, startsAt + duration * 60_000);
  }
});

test("on-demand and late rooms use the scheduled end with whole-minute rounding", () => {
  const startsAt = localTimeToInstant("2026-10-04", "01:30", "Australia/Melbourne", "earlier").getTime();
  assert.equal(classroomMeetingDurationMinutes(startsAt, 60, startsAt), 60);
  assert.equal(classroomMeetingDurationMinutes(startsAt, 60, startsAt + 10 * 60_000), 50);
  const createdAt = startsAt - 15 * 60_000 - 1;
  const end = createdAt + classroomMeetingDurationMinutes(startsAt, 60, createdAt) * 60_000;
  assert.ok(end >= startsAt + 60 * 60_000 && end < startsAt + 61 * 60_000);
  for (const [start, duration, now] of [[NaN, 60, startsAt], [startsAt, 361, startsAt], [startsAt, 60, Infinity], [startsAt, 60, startsAt + 60 * 60_000]]) {
    assert.throws(() => classroomMeetingDurationMinutes(start, duration, now), RangeError);
  }
});
