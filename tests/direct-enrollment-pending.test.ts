import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECT_ENROLLMENT_PENDING_LIMIT,
  DIRECT_ENROLLMENT_PENDING_NAMESPACE,
  DIRECT_ENROLLMENT_PENDING_SCHEMA,
  clearDirectEnrollmentPendingCommands,
  persistDirectEnrollmentPendingCommands,
  readDirectEnrollmentPendingCommands,
  upsertDirectEnrollmentPendingCommand,
  type DirectEnrollmentPendingCommand,
  type DirectEnrollmentPendingStorage,
} from "@/lib/direct-enrollment-pending";

class MemoryStorage implements DirectEnrollmentPendingStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const versions = { students: 3, lpItems: 4, tasks: 5 } as const;

function pending(index = 1): DirectEnrollmentPendingCommand {
  const intent = JSON.stringify({
    studentId: `STU-${index}`,
    workflowType: "学生直报（无试听）",
    fields: { contactPerson: "家长" },
    purchasedHours: 10,
    bonusHours: 2,
    subject: "English",
  });
  return {
    intent,
    commandIntent: JSON.stringify({
      ...JSON.parse(intent),
      expectedVersions: versions,
    }),
    commandKey: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    expectedVersions: versions,
  };
}

test("direct enrollment pending command survives a reload with the same exact key and versions", () => {
  const storage = new MemoryStorage();
  const original = pending();
  persistDirectEnrollmentPendingCommands(storage, "Tara", [original]);

  const afterReload = readDirectEnrollmentPendingCommands(storage, "Tara");
  assert.deepEqual(afterReload.get(original.intent), original);
  assert.equal(readDirectEnrollmentPendingCommands(storage, "Other").size, 0);

  clearDirectEnrollmentPendingCommands(storage, "Tara");
  assert.equal(readDirectEnrollmentPendingCommands(storage, "Tara").size, 0);
});

test("direct enrollment pending storage fails closed on malformed schema and caps entries", () => {
  const storage = new MemoryStorage();
  const entries = Array.from({ length: DIRECT_ENROLLMENT_PENDING_LIMIT + 2 }, (_, index) => pending(index + 1));
  persistDirectEnrollmentPendingCommands(storage, "Tara", entries);
  assert.equal(readDirectEnrollmentPendingCommands(storage, "Tara").size, DIRECT_ENROLLMENT_PENDING_LIMIT);

  const storageKey = [...storage.values.keys()][0];
  storage.values.set(storageKey, JSON.stringify({
    namespace: DIRECT_ENROLLMENT_PENDING_NAMESPACE,
    schema: DIRECT_ENROLLMENT_PENDING_SCHEMA,
    entries: [{ ...entries[0], unexpected: true }],
  }));
  assert.equal(readDirectEnrollmentPendingCommands(storage, "Tara").size, 0);
  assert.equal(storage.getItem(storageKey), null);
});

test("upsert keeps the newest exact intent while preserving bounded unknown-outcome retries", () => {
  const first = pending(1);
  const replacement = { ...first, commandKey: pending(2).commandKey };
  const entries = upsertDirectEnrollmentPendingCommand([first], replacement);
  assert.equal(entries.size, 1);
  assert.equal(entries.get(first.intent)?.commandKey, replacement.commandKey);
});
