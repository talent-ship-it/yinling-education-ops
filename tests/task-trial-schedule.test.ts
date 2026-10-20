import assert from "node:assert/strict";
import test from "node:test";

import { resolveTaskTrialSchedule } from "../lib/task-trial-schedule";

const startsAt = "2026-10-20T13:30:00.000Z";
const endsAt = "2026-10-20T14:30:00.000Z";
const sourceTask = {
  studentId: "SYNTH-STUDENT-1", ruleKey: "trial.jiaowubao.prep-n1",
  requestAnchorBookingId: "SYNTH-LP-1", anchorBookingId: "JWB:synthetic-event-1",
};
const lp = {
  id: "SYNTH-LP-1", studentId: "SYNTH-STUDENT-1", workflowType: "试听 LP", stage: "待备课确认",
  trialSchedule: { source: "jiaowubao-open-api", eventId: "synthetic-event-1", startsAt, endsAt },
};
const booking = {
  id: "SYNTH-BOOKING-1", studentId: "SYNTH-STUDENT-1", kind: "试听", status: "已确认",
  date: "2026-10-21", start: "00:30", timezone: "Australia/Melbourne", duration: 60,
};
const bookingTask = { studentId: "SYNTH-STUDENT-1", ruleKey: "trial.prep", anchorBookingId: booking.id };
const input = { lpItems: [lp], bookings: [booking], bookingStartsAt: () => startsAt };

test("reads the persisted exact JWB LP link without deriving from task deadlines or a live feed", () => {
  assert.deepEqual(resolveTaskTrialSchedule(sourceTask, input), { startsAt, endsAt });
  assert.deepEqual(resolveTaskTrialSchedule(sourceTask, { ...input, lpItems: [{ ...lp, workflowType: "换老师试听" }] }), { startsAt, endsAt });
});

test("missing, cancelled and rematched LP links never borrow another student's or event's time", () => {
  for (const lpItems of [
    [], [{ ...lp, studentId: "SYNTH-OTHER-STUDENT" }], [{ ...lp, stage: "完成" }],
    [{ ...lp, resultStatus: "已取消" }], [{ ...lp, workflowType: "老师新 LP" }],
    [{ ...lp, trialSchedule: undefined }],
    [{ ...lp, trialSchedule: { ...lp.trialSchedule, eventId: "synthetic-event-2" } }],
    [{ ...lp, trialSchedule: { ...lp.trialSchedule, source: "manual" } }],
  ]) assert.equal(resolveTaskTrialSchedule(sourceTask, { ...input, lpItems }), null);
  assert.equal(resolveTaskTrialSchedule({ ...sourceTask, requestAnchorBookingId: undefined }, input), null);
  assert.equal(resolveTaskTrialSchedule({ ...sourceTask, anchorBookingId: undefined }, input), null);
});

test("invalid or incomplete JWB instants are hidden rather than converted into a guessed lesson", () => {
  for (const timing of [
    { startsAt: "2026-10-21", endsAt }, { startsAt: "invalid", endsAt },
    { startsAt, endsAt: "" }, { startsAt, endsAt: startsAt },
    { startsAt, endsAt: "2026-10-19T14:30:00.000Z" },
  ]) assert.equal(resolveTaskTrialSchedule(sourceTask, { ...input, lpItems: [{ ...lp, trialSchedule: { ...lp.trialSchedule, ...timing } }] }), null);
});

test("an exact local trial booking uses the existing booking instant conversion", () => {
  const calls: string[] = [];
  const schedule = resolveTaskTrialSchedule(bookingTask, { ...input, bookingStartsAt: (row) => { calls.push(row.id); return startsAt; } });
  assert.deepEqual(schedule, { startsAt, endsAt });
  assert.deepEqual(calls, [booking.id]);
});

test("local bookings require an exact task identity and an explicit valid source timezone", () => {
  for (const candidate of [
    { ...booking, id: "SYNTH-OTHER-BOOKING" }, { ...booking, studentId: "SYNTH-OTHER-STUDENT" },
    { ...booking, kind: "常规课" }, { ...booking, timezone: undefined }, { ...booking, timezone: "" },
    { ...booking, timezone: "Invalid/Zone" }, { ...booking, status: "cancelled" },
    { ...booking, recurring: true }, { ...booking, occurrenceOverrides: [{ status: "cancelled" }] },
  ]) assert.equal(resolveTaskTrialSchedule(bookingTask, { ...input, bookings: [candidate] }), null);
  assert.equal(resolveTaskTrialSchedule({ ...bookingTask, anchorBookingId: undefined }, input), null);
  assert.equal(resolveTaskTrialSchedule({ ...bookingTask, ruleKey: undefined }, input), null);
  assert.equal(resolveTaskTrialSchedule({ ...bookingTask, ruleKey: "exam:synthetic:care" }, input), null);
});

test("a local booking conversion must round-trip its wall clock, including a nonexistent DST hour", () => {
  assert.equal(resolveTaskTrialSchedule(bookingTask, { ...input, bookingStartsAt: () => "2026-10-20T14:30:00.000Z" }), null);
  assert.equal(resolveTaskTrialSchedule(bookingTask, {
    ...input, bookings: [{ ...booking, date: "2026-10-04", start: "02:30" }],
    bookingStartsAt: () => "2026-10-03T16:30:00.000Z",
  }), null);
  assert.equal(resolveTaskTrialSchedule(bookingTask, { ...input, bookingStartsAt: () => { throw new RangeError("synthetic invalid clock"); } }), null);
});
