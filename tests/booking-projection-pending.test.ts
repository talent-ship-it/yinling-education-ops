import assert from "node:assert/strict";
import test from "node:test";

import {
  persistBookingProjectionPendingCommands,
  readBookingProjectionPendingCommands,
  removeBookingProjectionPendingCommand,
  upsertBookingProjectionPendingCommand,
  type BookingProjectionPendingCommand,
  type BookingProjectionPendingStorage,
} from "../lib/booking-projection-pending.ts";
import { meetingIdForOccurrenceValue } from "../lib/bbb-analytics.ts";

function storage(): BookingProjectionPendingStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const versions = { bookings: 4, students: 7, lpItems: 2, tasks: 9, teachers: 3 } as const;
const intentValue = {
  action: "upsert",
  bookingId: "LES-RECOVERY-1",
  booking: {
    studentId: "STU-1", teacherId: "TEA-1", date: "2026-09-01", start: "18:00",
    duration: 60, kind: "试听", timezone: "Australia/Melbourne", recurring: false,
    repeatCount: 1, subjectId: "English", teacherSubjectId: "Local English",
  },
};
const entry: BookingProjectionPendingCommand = {
  intent: JSON.stringify(intentValue),
  command: JSON.stringify({ ...intentValue, expectedVersions: versions }),
  expectedVersions: versions,
};

test("booking pending command survives reload with the exact original OCC command", () => {
  const target = storage();
  const pending = upsertBookingProjectionPendingCommand([], entry);
  persistBookingProjectionPendingCommands(target, "Abby", pending.values());
  const restored = readBookingProjectionPendingCommands(target, "Abby");
  assert.deepEqual(restored.get(entry.intent), entry);
  assert.equal(readBookingProjectionPendingCommands(target, "Ella").size, 0);
  assert.equal(removeBookingProjectionPendingCommand(restored.values(), entry.intent).size, 0);
});

test("occurrence cancellation and update commands survive reload without derived rows", () => {
  const target = storage();
  const cancelIntent = {
    action: "cancel_occurrence",
    bookingId: "LES-RECOVERY-1",
    occurrenceId: "LES-RECOVERY-1:2026-09-01",
  };
  const updateIntent = {
    action: "update_occurrence",
    bookingId: "LES-RECOVERY-1",
    occurrenceId: "LES-RECOVERY-1:2026-09-01",
    occurrence: { date: "2026-09-02", start: "18:30", duration: 90, status: "confirmed" },
  };
  const commands = [cancelIntent, updateIntent].map((intent) => ({
    intent: JSON.stringify(intent),
    command: JSON.stringify({ ...intent, expectedVersions: versions }),
    expectedVersions: versions,
  } satisfies BookingProjectionPendingCommand));
  persistBookingProjectionPendingCommands(target, "Abby", commands);
  const restored = readBookingProjectionPendingCommands(target, "Abby");
  assert.equal(restored.size, 2);
  assert.deepEqual([...restored.values()], commands);
});

test("classroom binding survives reload with only the narrow provider fields", () => {
  const target = storage();
  const occurrenceId = "LES-RECOVERY-1:2026-09-01";
  const intent = {
    action: "bind_classroom",
    bookingId: "LES-RECOVERY-1",
    occurrenceId,
    classroom: { meetingId: meetingIdForOccurrenceValue(occurrenceId), status: "ended" },
  };
  const classroomEntry = {
    intent: JSON.stringify(intent),
    command: JSON.stringify({ ...intent, expectedVersions: versions }),
    expectedVersions: versions,
  } satisfies BookingProjectionPendingCommand;
  persistBookingProjectionPendingCommands(target, "Abby", [classroomEntry]);
  assert.deepEqual([...readBookingProjectionPendingCommands(target, "Abby").values()], [classroomEntry]);
  persistBookingProjectionPendingCommands(target, "Abby", [{
    ...classroomEntry,
    command: JSON.stringify({ ...intent, occurrenceId: "LES-OTHER:2026-09-01", expectedVersions: versions }),
    intent: JSON.stringify({ ...intent, occurrenceId: "LES-OTHER:2026-09-01" }),
  }]);
  assert.deepEqual([...readBookingProjectionPendingCommands(target, "Abby").values()], [classroomEntry]);
  persistBookingProjectionPendingCommands(target, "Abby", [{
    ...classroomEntry,
    command: JSON.stringify({ ...intent, classroom: { ...intent.classroom, createdAt: "2026-08-24T00:00:00.000Z" }, expectedVersions: versions }),
  }]);
  assert.deepEqual([...readBookingProjectionPendingCommands(target, "Abby").values()], [classroomEntry]);
});

test("booking pending storage rejects any browser-derived rows or altered versions", () => {
  const target = storage();
  const poisoned = {
    ...entry,
    command: JSON.stringify({ ...JSON.parse(entry.command), tasks: [{ id: "forged" }] }),
  };
  persistBookingProjectionPendingCommands(target, "Abby", [poisoned]);
  assert.equal(readBookingProjectionPendingCommands(target, "Abby").size, 0);

  persistBookingProjectionPendingCommands(target, "Abby", [{
    ...entry,
    expectedVersions: { ...versions, tasks: versions.tasks + 1 },
  }]);
  assert.equal(readBookingProjectionPendingCommands(target, "Abby").size, 0);
});
