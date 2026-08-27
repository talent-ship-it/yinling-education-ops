import assert from "node:assert/strict";
import test from "node:test";

import {
  TEACHER_ABSENCE_PENDING_LIMIT,
  TEACHER_ABSENCE_PENDING_NAMESPACE,
  TEACHER_ABSENCE_PENDING_SCHEMA,
  clearTeacherAbsencePendingCommands,
  persistTeacherAbsencePendingCommands,
  readTeacherAbsencePendingCommands,
  removeTeacherAbsencePendingCommand,
  teacherAbsencePendingDisposition,
  upsertTeacherAbsencePendingCommand,
  type TeacherAbsencePendingCommand,
  type TeacherAbsencePendingStorage,
} from "@/lib/teacher-absence-pending";

class MemoryStorage implements TeacherAbsencePendingStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const versions = { bookings: 3, operations: 4, students: 5, tasks: 6, teachers: 7 } as const;

function pending(index = 1): TeacherAbsencePendingCommand {
  return {
    intent: JSON.stringify({
      sourceTeacherId: `T-${index}`,
      eventStart: "2026-09-15",
      eventEnd: "2026-09-16",
      type: "老师请假",
      detail: `第 ${index} 个可安全重试的请假命令`,
    }),
    commandKey: `teacher-absence-create:11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    expectedVersions: versions,
  };
}

test("teacher absence pending command survives reload under the exact actor namespace", () => {
  const storage = new MemoryStorage();
  const original = pending();
  persistTeacherAbsencePendingCommands(storage, "Nixon", [original]);

  assert.deepEqual(readTeacherAbsencePendingCommands(storage, "Nixon").get(original.intent), original);
  assert.equal(readTeacherAbsencePendingCommands(storage, "Other").size, 0);

  clearTeacherAbsencePendingCommands(storage, "Nixon");
  assert.equal(readTeacherAbsencePendingCommands(storage, "Nixon").size, 0);
});

test("teacher absence pending storage rejects malformed entries and keeps at most eight", () => {
  const storage = new MemoryStorage();
  persistTeacherAbsencePendingCommands(
    storage,
    "Nixon",
    Array.from({ length: TEACHER_ABSENCE_PENDING_LIMIT + 2 }, (_, index) => pending(index + 1)),
  );
  assert.equal(readTeacherAbsencePendingCommands(storage, "Nixon").size, TEACHER_ABSENCE_PENDING_LIMIT);

  const key = [...storage.values.keys()][0];
  storage.values.set(key, JSON.stringify({
    namespace: TEACHER_ABSENCE_PENDING_NAMESPACE,
    schema: TEACHER_ABSENCE_PENDING_SCHEMA,
    entries: [{ ...pending(), unexpected: true }],
  }));
  assert.equal(readTeacherAbsencePendingCommands(storage, "Nixon").size, 0);
  assert.equal(storage.getItem(key), null);
});

test("pending retries preserve key and versions until the exact intent is removed", () => {
  const first = pending(1);
  const recovered = upsertTeacherAbsencePendingCommand([], first);
  assert.deepEqual(recovered.get(first.intent), first);

  const withoutFirst = removeTeacherAbsencePendingCommand(recovered.values(), first.intent);
  assert.equal(withoutFirst.size, 0);
});

test("unknown failures and missing rows retain the command; success and explicit conflict clear it", () => {
  assert.equal(teacherAbsencePendingDisposition({ status: 503, committed: false, hasAuthoritativeRows: false }), "retain");
  assert.equal(teacherAbsencePendingDisposition({ status: 200, committed: true, hasAuthoritativeRows: false }), "retain");
  assert.equal(teacherAbsencePendingDisposition({ status: 200, committed: true, hasAuthoritativeRows: true }), "clear");
  assert.equal(teacherAbsencePendingDisposition({ status: 409, committed: false, hasAuthoritativeRows: false }), "clear");
});
