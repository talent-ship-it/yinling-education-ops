import assert from "node:assert/strict";
import test from "node:test";

import { ClassroomMaterialsError } from "../lib/classroom-materials.ts";
import { materialsMeetingBooking, materialsMeetingInput, materialsMeetingOccurrence, requireMaterialsMeetingOpen } from "../lib/classroom-materials-meeting.ts";
import { buildOpsAccessContext } from "../lib/ops-access.ts";
import type { OpsStateRow } from "../lib/ops-store.ts";

const input = { bookingId: "B1", occurrenceId: "B1:2026-10-19", sourceDate: "2026-10-19" };
const booking = { id: "B1", studentId: "S1", teacherId: "T1", date: "2026-10-19", start: "11:00", duration: 60, timezone: "Australia/Melbourne" };
function fixture(value: Record<string, unknown> = booking, student: Record<string, unknown> = {}) {
  const payloads = {
    bookings: [value], students: [{ id: "S1", name: "Student", teacher: "Teacher A", ...student }],
    teachers: [{ id: "T1", name: "Teacher A" }, { id: "T2", name: "Teacher B" }],
  };
  const state: OpsStateRow[] = Object.entries(payloads).map(([entity, payload]) => ({ entity, payload, version: 1, updated_at: "2026-10-19T00:00:00Z", updated_by: "Synthetic" }));
  return { state, access: buildOpsAccessContext(state, "Teacher A", false, "teacher") };
}

const forbidden = (error: unknown) => error instanceof ClassroomMaterialsError && error.code === "materials_forbidden";

test("meeting input and booking authority require matching occurrence identity and write permission", () => {
  assert.deepEqual(materialsMeetingInput(input), input);
  for (const patch of [{ bookingId: 1 }, { occurrenceId: "B2:2026-10-19" }, { occurrenceId: "B1:bad" }, { sourceDate: "2026-10-20" }]) {
    assert.throws(() => materialsMeetingInput({ ...input, ...patch }), ClassroomMaterialsError);
  }
  const { state, access } = fixture();
  assert.deepEqual(materialsMeetingBooking(state, access, "B1"), booking);
  assert.throws(() => materialsMeetingBooking(state, access, "missing"), forbidden);
  assert.throws(() => materialsMeetingBooking(state, { ...access, permissions: new Set() }, "B1"), forbidden);
  assert.throws(() => materialsMeetingBooking([], access, "B1"), forbidden);
});

test("effective teacher, active student, and occurrence status gate material classroom use", () => {
  const { access } = fixture();
  const occurrence = materialsMeetingOccurrence(booking, access, input);
  assert.equal(occurrence.teacherId, "T1");
  for (const status of ["cancelled", "leave", "completed", "abnormal"]) {
    assert.throws(() => materialsMeetingOccurrence({ ...booking, occurrenceOverrides: [{ occurrenceId: input.occurrenceId, status }] }, access, input), forbidden);
  }
  assert.throws(() => materialsMeetingOccurrence(booking, { ...access, teacherIds: new Set(["T2"]) }, input), forbidden);
  assert.throws(() => materialsMeetingOccurrence(booking, fixture(booking, { importArchived: true }).access, input), forbidden);
  const substituted = { ...booking, occurrenceOverrides: [{ occurrenceId: input.occurrenceId, teacherId: "T2" }] };
  const { state, access: original } = fixture(substituted);
  assert.throws(() => materialsMeetingOccurrence(substituted, original, input), forbidden);
  assert.equal(materialsMeetingOccurrence(substituted, buildOpsAccessContext(state, "Teacher B", false, "teacher"), input).teacherId, "T2");
});

test("recurring occurrence expansion preserves moved lessons and original source date", () => {
  const value = { ...booking, recurring: true, repeatCount: 2, recurrenceIntervalDays: 7, recurrenceEndDate: "2026-10-26", occurrenceOverrides: [{ occurrenceId: "B1:2026-10-26", date: "2026-10-27", start: "12:00", durationMinutes: 30 }] };
  const { access } = fixture(value);
  const occurrence = materialsMeetingOccurrence(value, access, materialsMeetingInput({ bookingId: "B1", occurrenceId: "B1:2026-10-26" }));
  assert.equal(occurrence.date, "2026-10-27");
  assert.equal(occurrence.sourceDate, "2026-10-26");
  assert.equal(occurrence.scheduledDurationMinutes, 30);
});

test("classroom availability respects scheduled window and ended occurrence state", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-19T00:00:00Z"));
  const { access } = fixture();
  const occurrence = materialsMeetingOccurrence(booking, access, input);
  assert.doesNotThrow(() => requireMaterialsMeetingOpen(booking, occurrence, input.occurrenceId));
  const unavailable = (error: unknown) => error instanceof ClassroomMaterialsError && error.status === 409;
  assert.throws(() => requireMaterialsMeetingOpen({ ...booking, classroom: { status: "ended" } }, occurrence, input.occurrenceId), unavailable);
  assert.throws(() => requireMaterialsMeetingOpen({ ...booking, recurring: true, occurrenceOverrides: [{ occurrenceId: input.occurrenceId, classroom: { status: "ended" } }] }, occurrence, input.occurrenceId), unavailable);
  assert.throws(() => requireMaterialsMeetingOpen(booking, { ...occurrence, start: "12:00" }, input.occurrenceId), unavailable);
  assert.throws(() => requireMaterialsMeetingOpen(booking, { ...occurrence, start: "09:00" }, input.occurrenceId), unavailable);
  assert.doesNotThrow(() => requireMaterialsMeetingOpen({ ...booking, recurring: true, classroom: { status: "ended" } }, occurrence, input.occurrenceId));
});
