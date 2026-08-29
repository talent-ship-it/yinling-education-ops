import assert from "node:assert/strict";
import test from "node:test";

import {
  persistTrialPaymentPendingCommands,
  readTrialPaymentPendingCommands,
  removeTrialPaymentPendingCommand,
  trialPaymentPendingDisposition,
  upsertTrialPaymentPendingCommand,
  type TrialPaymentPendingCommand,
} from "../lib/trial-payment-pending";

const pending: TrialPaymentPendingCommand = {
  action: "complete",
  taskId: "TSK-BOOKING-abc123",
  commandKey: "trial-payment-complete:123e4567-e89b-42d3-a456-426614174000",
  expectedVersions: { bookings: 2, students: 3, lpItems: 4, tasks: 5, teachers: 6 },
};

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("pending payment completion is actor-scoped and replays its original key and OCC versions", () => {
  const store = storage();
  persistTrialPaymentPendingCommands(store, "Tara", [pending]);
  assert.deepEqual(readTrialPaymentPendingCommands(store, "Tara").get(`complete:${pending.taskId}`), pending);
  assert.equal(readTrialPaymentPendingCommands(store, "Molly").size, 0);

  const replacement = {
    ...pending,
    commandKey: "trial-payment-complete:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expectedVersions: { ...pending.expectedVersions, tasks: 9 },
  };
  const updated = upsertTrialPaymentPendingCommand([pending], replacement);
  assert.deepEqual(updated.get(`complete:${pending.taskId}`), replacement);
  assert.equal(removeTrialPaymentPendingCommand(updated.values(), "complete", pending.taskId).size, 0);
});

test("malformed or extra pending data fails closed and is removed", () => {
  const store = storage();
  persistTrialPaymentPendingCommands(store, "Tara", [pending]);
  const [key] = store.values.keys();
  const envelope = JSON.parse(store.values.get(key)!) as { entries: Array<Record<string, unknown>> };
  envelope.entries[0].payload = [];
  store.values.set(key, JSON.stringify(envelope));
  assert.equal(readTrialPaymentPendingCommands(store, "Tara").size, 0);
  assert.equal(store.values.has(key), false);
});

test("only definitive authority failures or complete authoritative success clear pending", () => {
  for (const status of [403, 404]) {
    assert.equal(trialPaymentPendingDisposition({
      status,
      committed: false,
      receiptOnly: false,
      hasAuthoritativeTaskRow: false,
      hasAuthoritativeProjection: false,
    }), "clear");
  }
  for (const code of ["idempotency_conflict", "invalid_completion", "invalid_lifecycle"]) {
    assert.equal(trialPaymentPendingDisposition({
      status: 409,
      code,
      committed: false,
      receiptOnly: false,
      hasAuthoritativeTaskRow: false,
      hasAuthoritativeProjection: false,
    }), "clear");
  }
  assert.equal(trialPaymentPendingDisposition({
    status: 409,
    code: "version_conflict",
    expectedVersionsChanged: true,
    committed: false,
    receiptOnly: false,
    hasAuthoritativeTaskRow: false,
    hasAuthoritativeProjection: false,
  }), "retry");
  assert.equal(trialPaymentPendingDisposition({
    status: 409,
    code: "version_conflict",
    expectedVersionsChanged: false,
    committed: false,
    receiptOnly: false,
    hasAuthoritativeTaskRow: false,
    hasAuthoritativeProjection: false,
  }), "retain");
  assert.equal(trialPaymentPendingDisposition({
    status: 409,
    code: "unrecognised_conflict",
    committed: false,
    receiptOnly: false,
    hasAuthoritativeTaskRow: false,
    hasAuthoritativeProjection: false,
  }), "retain");
  for (const status of [0, 400, 500, 503]) {
    assert.equal(trialPaymentPendingDisposition({
      status,
      committed: false,
      receiptOnly: false,
      hasAuthoritativeTaskRow: false,
      hasAuthoritativeProjection: false,
    }), "retain");
  }
  assert.equal(trialPaymentPendingDisposition({
    status: 200,
    committed: true,
    receiptOnly: false,
    hasAuthoritativeTaskRow: false,
    hasAuthoritativeProjection: true,
  }), "retain");
  assert.equal(trialPaymentPendingDisposition({
    status: 200,
    committed: true,
    receiptOnly: false,
    hasAuthoritativeTaskRow: true,
    hasAuthoritativeProjection: true,
  }), "clear");
  assert.equal(trialPaymentPendingDisposition({
    status: 200,
    committed: true,
    receiptOnly: true,
    hasAuthoritativeTaskRow: false,
    hasAuthoritativeProjection: false,
  }), "clear");
});

test("two same-version pending commands preserve both keys and rebase the second after the first commits", () => {
  const first: TrialPaymentPendingCommand = {
    ...pending,
    taskId: "TSK-BOOKING-first",
    commandKey: "trial-payment-complete:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const second: TrialPaymentPendingCommand = {
    ...pending,
    taskId: "TSK-BOOKING-second",
    commandKey: "trial-payment-complete:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  let commands = upsertTrialPaymentPendingCommand([], first);
  commands = upsertTrialPaymentPendingCommand(commands.values(), second);
  assert.equal(commands.size, 2);
  const nextVersions = { ...second.expectedVersions, tasks: second.expectedVersions.tasks + 1 };
  assert.equal(trialPaymentPendingDisposition({
    status: 409,
    code: "version_conflict",
    expectedVersionsChanged: nextVersions.tasks !== second.expectedVersions.tasks,
    committed: false,
    receiptOnly: false,
    hasAuthoritativeTaskRow: false,
    hasAuthoritativeProjection: false,
  }), "retry");
  const rebasedSecond = { ...second, expectedVersions: nextVersions };
  commands = upsertTrialPaymentPendingCommand(commands.values(), rebasedSecond);
  assert.equal(commands.size, 2);
  assert.equal(commands.get(`complete:${first.taskId}`)?.expectedVersions.tasks, first.expectedVersions.tasks);
  assert.equal(commands.get(`complete:${second.taskId}`)?.commandKey, second.commandKey);
  assert.equal(commands.get(`complete:${second.taskId}`)?.expectedVersions.tasks, nextVersions.tasks);
});

test("completion and reopen retries for one task keep separate ordered scopes", () => {
  const reopen: TrialPaymentPendingCommand = {
    ...pending,
    action: "reopen",
    commandKey: "trial-payment-reopen:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  let commands = upsertTrialPaymentPendingCommand([], pending);
  commands = upsertTrialPaymentPendingCommand(commands.values(), reopen);
  assert.deepEqual([...commands.keys()], [`complete:${pending.taskId}`, `reopen:${pending.taskId}`]);
  commands = removeTrialPaymentPendingCommand(commands.values(), "complete", pending.taskId);
  assert.deepEqual([...commands.keys()], [`reopen:${pending.taskId}`]);
});

test("completion and reopen retries for one task both survive a storage round trip", () => {
  const store = storage();
  const reopen: TrialPaymentPendingCommand = {
    ...pending,
    action: "reopen",
    commandKey: "trial-payment-reopen:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  persistTrialPaymentPendingCommands(store, "Tara", [pending, reopen]);
  const restored = readTrialPaymentPendingCommands(store, "Tara");
  assert.deepEqual([...restored.keys()], [`complete:${pending.taskId}`, `reopen:${pending.taskId}`]);
});
