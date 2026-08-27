import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_OPERATION_TASK_PENDING_LIMIT,
  LEGACY_OPERATION_TASK_PENDING_NAMESPACE,
  LEGACY_OPERATION_TASK_PENDING_SCHEMA,
  clearLegacyOperationTaskPendingCommands,
  legacyOperationTaskPendingDisposition,
  persistLegacyOperationTaskPendingCommands,
  readLegacyOperationTaskPendingCommands,
  removeLegacyOperationTaskPendingCommand,
  upsertLegacyOperationTaskPendingCommand,
  type LegacyOperationTaskPendingCommand,
  type LegacyOperationTaskPendingStorage,
} from "../lib/legacy-operation-task-pending";

class MemoryStorage implements LegacyOperationTaskPendingStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const versions = { bookings: 1, operations: 2, students: 3, tasks: 4, teachers: 5 } as const;

function pending(index = 1): LegacyOperationTaskPendingCommand {
  const intent = {
    type: "换老师" as const,
    detail: `为学生 ${index} 匹配新老师`,
    studentId: `S-${index}`,
    teacherId: `T-${index}`,
    eventStart: "2026-09-15",
    eventEnd: "2026-09-16",
    sourceBookingId: `B-${index}`,
  };
  return {
    intent: JSON.stringify(intent),
    commandIntent: JSON.stringify(intent),
    commandKey: `operation-task-create:123e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, "0")}`,
    expectedVersions: versions,
  };
}

function actorKey(storage: MemoryStorage) {
  const key = [...storage.values.keys()][0];
  assert.ok(key);
  return key;
}

test("legacy operation pending is actor-scoped and stores no server projection", () => {
  const storage = new MemoryStorage();
  const original = pending();
  persistLegacyOperationTaskPendingCommands(storage, "Nixon", [original]);

  assert.deepEqual(readLegacyOperationTaskPendingCommands(storage, "Nixon").get(original.intent), original);
  assert.equal(readLegacyOperationTaskPendingCommands(storage, "Other").size, 0);

  const envelope = JSON.parse(storage.getItem(actorKey(storage))!);
  assert.deepEqual(Object.keys(envelope).sort(), ["entries", "namespace", "schema"]);
  assert.equal(envelope.namespace, LEGACY_OPERATION_TASK_PENDING_NAMESPACE);
  assert.equal(envelope.schema, LEGACY_OPERATION_TASK_PENDING_SCHEMA);
  assert.deepEqual(Object.keys(envelope.entries[0]).sort(), ["commandIntent", "commandKey", "expectedVersions", "intent"]);
  assert.equal("operationRow" in envelope.entries[0], false);
  assert.equal("taskRow" in envelope.entries[0], false);
  assert.equal("rows" in envelope.entries[0], false);

  clearLegacyOperationTaskPendingCommands(storage, "Nixon");
  assert.equal(readLegacyOperationTaskPendingCommands(storage, "Nixon").size, 0);
});

test("legacy operation pending accepts legal optional intent subsets but rejects unknown keys and duplicates", () => {
  const storage = new MemoryStorage();
  const leave: LegacyOperationTaskPendingCommand = {
    ...pending(1),
    intent: JSON.stringify({ type: "学生请假", detail: "学生请假", studentId: "S-1", eventStart: "2026-09-15", eventEnd: "2026-09-15" }),
    commandIntent: JSON.stringify({ type: "学生请假", detail: "学生请假", studentId: "S-1", eventStart: "2026-09-15", eventEnd: "2026-09-15" }),
  };
  persistLegacyOperationTaskPendingCommands(storage, "Nixon", [leave]);
  assert.equal(readLegacyOperationTaskPendingCommands(storage, "Nixon").size, 1);

  const key = actorKey(storage);
  storage.values.set(key, JSON.stringify({
    namespace: LEGACY_OPERATION_TASK_PENDING_NAMESPACE,
    schema: LEGACY_OPERATION_TASK_PENDING_SCHEMA,
    entries: [{ ...leave, operationRow: { id: "must-not-be-stored" } }],
  }));
  assert.equal(readLegacyOperationTaskPendingCommands(storage, "Nixon").size, 0);
  assert.equal(storage.getItem(key), null);

  persistLegacyOperationTaskPendingCommands(storage, "Nixon", [pending(1)]);
  const duplicateKey = actorKey(storage);
  storage.values.set(duplicateKey, JSON.stringify({
    namespace: LEGACY_OPERATION_TASK_PENDING_NAMESPACE,
    schema: LEGACY_OPERATION_TASK_PENDING_SCHEMA,
    entries: [pending(1), pending(1)],
  }));
  assert.equal(readLegacyOperationTaskPendingCommands(storage, "Nixon").size, 0);
  assert.equal(storage.getItem(duplicateKey), null);
});

test("legacy operation pending retains original versions and refuses duplicate keys on write", () => {
  const storage = new MemoryStorage();
  const first = pending(1);
  const duplicateIntent = { ...first, commandKey: pending(2).commandKey };
  persistLegacyOperationTaskPendingCommands(storage, "Nixon", [first, duplicateIntent]);
  assert.equal(storage.values.size, 0);

  const duplicateKey = { ...pending(2), commandKey: first.commandKey };
  persistLegacyOperationTaskPendingCommands(storage, "Nixon", [first, duplicateKey]);
  assert.equal(storage.values.size, 0);

  const recovered = upsertLegacyOperationTaskPendingCommand([], first);
  assert.deepEqual(recovered.get(first.intent), first);
  assert.equal(upsertLegacyOperationTaskPendingCommand(recovered.values(), duplicateKey).size, 0);

  persistLegacyOperationTaskPendingCommands(storage, "Nixon", [first]);
  const envelope = JSON.parse(storage.getItem(actorKey(storage))!);
  assert.deepEqual(envelope.entries[0].expectedVersions, versions);
});

test("legacy operation pending bounds size and clears only definitive outcomes", () => {
  const storage = new MemoryStorage();
  const entries = Array.from({ length: LEGACY_OPERATION_TASK_PENDING_LIMIT + 3 }, (_, index) => pending(index + 1));
  persistLegacyOperationTaskPendingCommands(storage, "Nixon", entries);
  assert.equal(readLegacyOperationTaskPendingCommands(storage, "Nixon").size, LEGACY_OPERATION_TASK_PENDING_LIMIT);

  const key = actorKey(storage);
  storage.values.set(key, "x".repeat(32 * 1024 + 1));
  assert.equal(readLegacyOperationTaskPendingCommands(storage, "Nixon").size, 0);
  assert.equal(storage.getItem(key), null);

  for (const status of [400, 403, 404, 409]) {
    assert.equal(legacyOperationTaskPendingDisposition({ status, committed: false, hasAuthoritativeRows: false }), "clear");
  }
  for (const status of [0, 401, 429, 500, 503]) {
    assert.equal(legacyOperationTaskPendingDisposition({ status, committed: false, hasAuthoritativeRows: false }), "retain");
  }
  assert.equal(legacyOperationTaskPendingDisposition({ status: 200, committed: true, hasAuthoritativeRows: false }), "retain");
  assert.equal(legacyOperationTaskPendingDisposition({ status: 200, committed: false, hasAuthoritativeRows: true }), "retain");
  assert.equal(legacyOperationTaskPendingDisposition({ status: 200, committed: true, receiptOnly: true, hasAuthoritativeRows: false }), "clear");
  assert.equal(legacyOperationTaskPendingDisposition({ status: 200, committed: true, hasAuthoritativeRows: true }), "clear");
});

test("legacy operation pending removes one exact semantic intent", () => {
  const first = pending(1);
  const second = pending(2);
  const recovered = upsertLegacyOperationTaskPendingCommand([first], second);
  assert.equal(recovered.size, 2);
  const remaining = removeLegacyOperationTaskPendingCommand(recovered.values(), first.intent);
  assert.deepEqual([...remaining.values()], [second]);
});
