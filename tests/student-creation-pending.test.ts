import assert from "node:assert/strict";
import test from "node:test";

import {
  STUDENT_CREATION_PENDING_LIMIT,
  STUDENT_CREATION_PENDING_NAMESPACE,
  STUDENT_CREATION_PENDING_SCHEMA,
  clearStudentCreationPendingCommands,
  persistStudentCreationPendingCommands,
  readStudentCreationPendingCommands,
  removeStudentCreationPendingCommand,
  studentCreationPendingDisposition,
  upsertStudentCreationPendingCommand,
  type StudentCreationPendingCommand,
  type StudentCreationPendingStorage,
} from "../lib/student-creation-pending";

class MemoryStorage implements StudentCreationPendingStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const versions = { students: 3, tasks: 4 } as const;

function pending(index = 1, notes = "无特殊备注"): StudentCreationPendingCommand {
  const studentFields = {
    name: `学生 ${index}`,
    course: "英语",
    segment: "已报名" as const,
    guardianWechat: `guardian-${index}`,
    lpNeed: "待确认" as const,
    owner: "Nixon",
    planner: "待分配",
    grade: "Year 8",
    location: "Melbourne",
    timezone: "Australia/Melbourne",
    notes,
  };
  return {
    intent: JSON.stringify({ studentFields }),
    commandIntent: JSON.stringify({ studentFields, expectedVersions: versions }),
    commandKey: `student-create:123e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, "0")}`,
    expectedVersions: versions,
  };
}

function actorKey(storage: MemoryStorage) {
  const key = [...storage.values.keys()][0];
  assert.ok(key);
  return key;
}

test("student creation pending survives reload under an exact actor/versioned envelope", () => {
  const storage = new MemoryStorage();
  const original = pending();

  persistStudentCreationPendingCommands(storage, "Nixon", [original]);

  const restored = readStudentCreationPendingCommands(storage, "Nixon");
  assert.deepEqual(restored.get(original.intent), original);
  assert.equal(readStudentCreationPendingCommands(storage, "Other").size, 0);

  const envelope = JSON.parse(storage.getItem(actorKey(storage))!);
  assert.deepEqual(Object.keys(envelope).sort(), ["entries", "namespace", "schema"]);
  assert.equal(envelope.namespace, STUDENT_CREATION_PENDING_NAMESPACE);
  assert.equal(envelope.schema, STUDENT_CREATION_PENDING_SCHEMA);
  assert.deepEqual(Object.keys(envelope.entries[0]).sort(), ["commandIntent", "commandKey", "expectedVersions", "intent"]);
  assert.equal("rows" in envelope.entries[0], false);
  assert.equal("studentsRow" in envelope.entries[0], false);
  assert.equal("tasksRow" in envelope.entries[0], false);

  clearStudentCreationPendingCommands(storage, "Nixon");
  assert.equal(readStudentCreationPendingCommands(storage, "Nixon").size, 0);
});

test("student creation pending bounds to eight and removes malformed or duplicate storage", () => {
  const storage = new MemoryStorage();
  const entries = Array.from({ length: STUDENT_CREATION_PENDING_LIMIT + 2 }, (_, index) => pending(index + 1));
  persistStudentCreationPendingCommands(storage, "Nixon", entries);
  assert.equal(readStudentCreationPendingCommands(storage, "Nixon").size, STUDENT_CREATION_PENDING_LIMIT);

  const key = actorKey(storage);
  storage.values.set(key, JSON.stringify({
    namespace: STUDENT_CREATION_PENDING_NAMESPACE,
    schema: STUDENT_CREATION_PENDING_SCHEMA,
    entries: [{ ...pending(), unexpected: true }],
  }));
  assert.equal(readStudentCreationPendingCommands(storage, "Nixon").size, 0);
  assert.equal(storage.getItem(key), null);

  persistStudentCreationPendingCommands(storage, "Nixon", [pending(1)]);
  const duplicateKey = actorKey(storage);
  storage.values.set(duplicateKey, JSON.stringify({
    namespace: STUDENT_CREATION_PENDING_NAMESPACE,
    schema: STUDENT_CREATION_PENDING_SCHEMA,
    entries: [pending(1), pending(1)],
  }));
  assert.equal(readStudentCreationPendingCommands(storage, "Nixon").size, 0);
  assert.equal(storage.getItem(duplicateKey), null);
});

test("student creation pending rejects duplicate intent/key and preserves exact command versions", () => {
  const storage = new MemoryStorage();
  const first = pending(1);
  persistStudentCreationPendingCommands(storage, "Nixon", [first, { ...first, commandKey: pending(2).commandKey }]);
  assert.equal(storage.values.size, 0);

  persistStudentCreationPendingCommands(storage, "Nixon", [first]);
  const secondIntentSameKey = { ...pending(2), commandKey: first.commandKey };
  persistStudentCreationPendingCommands(storage, "Nixon", [first, secondIntentSameKey]);
  assert.deepEqual(readStudentCreationPendingCommands(storage, "Nixon").get(first.intent), first);

  const next = upsertStudentCreationPendingCommand([], first);
  assert.deepEqual(next.get(first.intent), first);
  assert.equal(upsertStudentCreationPendingCommand(next.values(), secondIntentSameKey).size, 0);

  const changedVersions = {
    ...first,
    commandKey: pending(3).commandKey,
    expectedVersions: { students: 99, tasks: 4 },
  };
  clearStudentCreationPendingCommands(storage, "Nixon");
  persistStudentCreationPendingCommands(storage, "Nixon", [changedVersions]);
  assert.equal(storage.values.size, 0);
});

test("student creation pending enforces a 32KB aggregate and fail-closed dispositions", () => {
  const storage = new MemoryStorage();
  const oversized = Array.from({ length: STUDENT_CREATION_PENDING_LIMIT }, (_, index) => pending(index + 1, "x".repeat(4_000)));
  persistStudentCreationPendingCommands(storage, "Nixon", oversized);
  assert.equal(storage.values.size, 0);

  persistStudentCreationPendingCommands(storage, "Nixon", [pending()]);
  const key = actorKey(storage);
  storage.values.set(key, "x".repeat(32 * 1024 + 1));
  assert.equal(readStudentCreationPendingCommands(storage, "Nixon").size, 0);
  assert.equal(storage.getItem(key), null);

  for (const status of [400, 403, 404, 409]) {
    assert.equal(studentCreationPendingDisposition({ status, committed: false, hasAuthoritativeRows: false }), "clear");
  }
  for (const status of [0, 401, 429, 500, 503]) {
    assert.equal(studentCreationPendingDisposition({ status, committed: false, hasAuthoritativeRows: false }), "retain");
  }
  assert.equal(studentCreationPendingDisposition({ status: 200, committed: false, hasAuthoritativeRows: true }), "retain");
  assert.equal(studentCreationPendingDisposition({ status: 200, committed: true, hasAuthoritativeRows: false }), "retain");
  assert.equal(studentCreationPendingDisposition({ status: 200, committed: true, receiptOnly: true, hasAuthoritativeRows: false }), "clear");
  assert.equal(studentCreationPendingDisposition({ status: 200, committed: true, hasAuthoritativeRows: true }), "clear");
});

test("student creation pending removes only the exact semantic intent", () => {
  const first = pending(1);
  const second = pending(2);
  const recovered = upsertStudentCreationPendingCommand([first], second);
  assert.equal(recovered.size, 2);
  const remaining = removeStudentCreationPendingCommand(recovered.values(), first.intent);
  assert.deepEqual([...remaining.values()], [second]);
});
