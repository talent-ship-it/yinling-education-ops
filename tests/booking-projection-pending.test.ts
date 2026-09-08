import assert from "node:assert/strict";
import test from "node:test";

import {
  persistBookingProjectionPendingCommands,
  prepareBookingProjectionPendingCommand,
  readBookingProjectionPendingCommands,
  removeBookingProjectionPendingCommand,
  upsertBookingProjectionPendingCommand,
  type BookingProjectionPendingCommand,
  type BookingProjectionPendingStorage,
} from "../lib/booking-projection-pending.ts";
import { meetingIdForOccurrenceValue } from "../lib/bbb-analytics.ts";
import { bookingCapacityCommandKey, bookingCapacityCommandIntent, bookingCapacityCommandRequiresRefresh, parseBookingCapacityCommand } from "../lib/booking-capacity-service.ts";

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

test("legacy pending receipts remain recoverable while subsequent actions require refresh", () => {
  const pending = parseBookingCapacityCommand(JSON.parse(entry.command));
  assert.equal(bookingCapacityCommandRequiresRefresh(pending, versions.bookings + 1), false);
  assert.equal(bookingCapacityCommandRequiresRefresh(pending), true);
  for (const bookings of [versions.bookings + 1, versions.bookings + 10]) {
    const repeatedAction = { ...pending, expectedVersions: { ...versions, bookings } };
    assert.equal(bookingCapacityCommandRequiresRefresh(repeatedAction, versions.bookings + 1), true);
  }
  const identifiedAction = { ...pending, requestKey: "d8389242-2b21-4345-8501-3f9e85b74934" };
  assert.equal(bookingCapacityCommandRequiresRefresh(identifiedAction), false);
  assert.equal(bookingCapacityCommandRequiresRefresh(identifiedAction, versions.bookings), false);
});

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

test("returning to a previous time is a new action while a lost-response retry keeps its key", () => {
  const target = storage();
  let nextId = 0;
  const requestKeyFactory = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
  const actions = ["11:00", "12:00", "11:00"].map((start) => prepareBookingProjectionPendingCommand({
    intentValue: {
      action: "update_occurrence", bookingId: "B-1", occurrenceId: "B-1:2026-09-14",
      occurrence: { date: "2026-09-14", start, duration: 60, status: "confirmed" },
    },
    expectedVersions: versions,
    requestKeyFactory,
  }));
  const commands = actions.map((action) => parseBookingCapacityCommand(JSON.parse(action.command)));
  assert.equal(new Set(commands.map(bookingCapacityCommandKey)).size, 3);
  assert.deepEqual(bookingCapacityCommandIntent(commands[0]), bookingCapacityCommandIntent(commands[2]));

  persistBookingProjectionPendingCommands(target, "Abby", [actions[2]]);
  const previous = readBookingProjectionPendingCommands(target, "Abby").get(actions[2].intent);
  const retried = prepareBookingProjectionPendingCommand({
    intentValue: JSON.parse(actions[2].intent), expectedVersions: { ...versions, bookings: 99 }, previous,
    requestKeyFactory: () => { throw new Error("A retry must not mint another identity"); },
  });
  assert.deepEqual(retried, actions[2]);
  assert.equal(bookingCapacityCommandKey(parseBookingCapacityCommand(JSON.parse(retried.command))), bookingCapacityCommandKey(commands[2]));

  const alteredRetry = parseBookingCapacityCommand({ ...commands[2], occurrence: { ...commands[2].occurrence, start: "13:00" } });
  assert.equal(bookingCapacityCommandKey(alteredRetry), bookingCapacityCommandKey(commands[2]));
  assert.notDeepEqual(bookingCapacityCommandIntent(alteredRetry), bookingCapacityCommandIntent(commands[2]));
});

test("cancel, restore, then cancel receives separate durable identities", () => {
  const cancel = { action: "cancel_occurrence", bookingId: "B-1", occurrenceId: "B-1:2026-09-14" };
  const restore = { ...cancel, action: "update_occurrence", occurrence: { date: "2026-09-14", start: "10:00", duration: 60, status: "confirmed" } };
  const commands = [cancel, restore, cancel].map((intentValue) => parseBookingCapacityCommand(JSON.parse(
    prepareBookingProjectionPendingCommand({ intentValue, expectedVersions: versions }).command,
  )));
  assert.equal(new Set(commands.map(bookingCapacityCommandKey)).size, 3);
});

test("legacy uncertain commands retain their pre-upgrade replay identity", () => {
  const retried = prepareBookingProjectionPendingCommand({
    intentValue, expectedVersions: { ...versions, bookings: 99 }, previous: entry,
    requestKeyFactory: () => { throw new Error("A legacy receipt must stay recoverable"); },
  });
  assert.deepEqual(retried, entry);
  assert.equal(parseBookingCapacityCommand(JSON.parse(retried.command)).requestKey, undefined);
  for (const requestKey of ["", "not-a-uuid", 1, null]) {
    assert.throws(() => parseBookingCapacityCommand({ ...JSON.parse(entry.command), requestKey }));
  }
});
