import assert from "node:assert/strict";
import test from "node:test";

import {
  clearTemporaryClassroomPending,
  createTemporaryClassroomPending,
  normalizeTemporaryClassroomIntent,
  readTemporaryClassroomPending,
  writeTemporaryClassroomPending,
  type TemporaryClassroomStorage,
} from "../lib/temporary-classroom-request.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } satisfies TemporaryClassroomStorage & { values: Map<string, string> };
}

function recordedPayload(overrides: Partial<{
  studentId: string;
  teacherId: string;
  duration: 60 | 90 | 120;
  date: string;
  start: string;
  timezone: string;
}> = {}) {
  return {
    mode: "recorded" as const,
    studentId: "S-1",
    teacherId: "T-1",
    subjectId: "English",
    teacherSubjectId: "Local English",
    packageId: "P-1",
    duration: 60 as const,
    date: "2026-08-24",
    start: "16:07",
    timezone: "Australia/Sydney",
    ...overrides,
  };
}

test("temporary classroom retry ledger preserves A→B→A payloads and keys", () => {
  const browserStorage = storage();
  const first = createTemporaryClassroomPending({
    actor: "Nixon",
    requestKey: "temporary-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    payload: recordedPayload(),
  });
  const second = createTemporaryClassroomPending({
    actor: "Nixon",
    requestKey: "temporary-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    payload: recordedPayload({ studentId: "S-2", date: "2026-08-24", start: "16:08" }),
  });
  assert.ok(first && second);
  assert.equal(writeTemporaryClassroomPending(first, browserStorage), true);
  assert.equal(writeTemporaryClassroomPending(second, browserStorage), true);

  const entries = readTemporaryClassroomPending("Nixon", browserStorage);
  assert.deepEqual(entries.map((entry) => entry.requestKey), [second.requestKey, first.requestKey]);
  const recoveredFirst = entries.find((entry) => entry.intent === first.intent);
  assert.equal(recoveredFirst?.requestKey, first.requestKey);
  assert.equal(recoveredFirst?.payload.mode === "recorded" ? recoveredFirst.payload.start : "", "16:07");
  assert.equal(normalizeTemporaryClassroomIntent({
    mode: "recorded",
    studentId: "S-1",
    teacherId: "T-1",
    subjectId: "English",
    teacherSubjectId: "Local English",
    packageId: "P-1",
    duration: 60,
    timezone: "Australia/Sydney",
  }), first.intent);

  // The storage key and envelope actor check prevent another signed actor
  // from reusing Nixon's pending provider identity.
  assert.deepEqual(readTemporaryClassroomPending("Abby", browserStorage), []);
  clearTemporaryClassroomPending("Nixon", first.intent, browserStorage);
  assert.equal(readTemporaryClassroomPending("Nixon", browserStorage)[0]?.requestKey, second.requestKey);
});

test("temporary classroom pending records fail closed on tampered intent/schema and remain bounded", () => {
  const browserStorage = storage();
  const pending = createTemporaryClassroomPending({
    actor: "Nixon",
    requestKey: "temporary-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    payload: { mode: "test" },
  });
  assert.ok(pending);
  assert.equal(writeTemporaryClassroomPending(pending, browserStorage), true);
  const key = [...browserStorage.values.keys()][0]!;
  const envelope = JSON.parse(browserStorage.values.get(key)!);
  envelope.entries[0].intent = JSON.stringify({ mode: "test", changed: true });
  browserStorage.values.set(key, JSON.stringify(envelope));
  assert.deepEqual(readTemporaryClassroomPending("Nixon", browserStorage), []);
  assert.equal(browserStorage.values.has(key), false);

  for (let index = 0; index < 12; index += 1) {
    const entry = createTemporaryClassroomPending({
      actor: "Nixon",
      requestKey: `temporary-${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      payload: recordedPayload({ studentId: `S-${index}` }),
    });
    assert.ok(entry);
    writeTemporaryClassroomPending(entry, browserStorage);
  }
  const entries = readTemporaryClassroomPending("Nixon", browserStorage);
  assert.equal(entries.length, 8);
  assert.equal(entries[0]?.payload.mode === "recorded" ? entries[0].payload.studentId : "", "S-11");
});
