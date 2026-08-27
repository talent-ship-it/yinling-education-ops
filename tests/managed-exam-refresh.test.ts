import assert from "node:assert/strict";
import test from "node:test";

import {
  managedExamSnapshotCanReplace,
  managedExamSnapshotIsCurrent,
  parseManagedExamAuthorityVersions,
  parseManagedExamProjectionSnapshot,
} from "../lib/managed-exam-refresh";

const exam = {
  id: "EXM-CROSS-1",
  subject: "Mathematics",
  examType: "other",
  examMonth: "2026-09",
  examDate: "2026-09-18",
};

function envelope(students: unknown[], studentsVersion: number, tasksVersion: number) {
  return {
    versions: { students: studentsVersion, tasks: tasksVersion },
    students,
  };
}

test("a later assigned cross-owner exam snapshot appears without rebuilding initial page data", () => {
  const initial = parseManagedExamProjectionSnapshot(
    envelope([], 4, 7),
    { students: 4, tasks: 7 },
  );
  assert.deepEqual(initial.students, []);

  const assigned = parseManagedExamProjectionSnapshot(
    envelope([{
      id: "STU-CROSS-1",
      name: "Cross Owner Student",
      initials: "CS",
      owner: "Thea",
      exams: [exam],
    }], 4, 8),
    { students: 4, tasks: 8 },
  );
  assert.equal(managedExamSnapshotCanReplace(assigned, initial.versions), true);
  assert.deepEqual(assigned.students.map((student) => student.id), ["STU-CROSS-1"]);
  assert.equal(managedExamSnapshotIsCurrent(assigned, { students: 4, tasks: 8 }), true);
});

test("archive or assignment revocation replaces the live projection with empty authorization", () => {
  const assigned = parseManagedExamProjectionSnapshot(
    envelope([{
      id: "STU-CROSS-1",
      name: "Cross Owner Student",
      initials: "CS",
      owner: "Thea",
      exams: [exam],
    }], 4, 8),
    { students: 4, tasks: 8 },
  );
  const archived = parseManagedExamProjectionSnapshot(
    envelope([], 5, 8),
    { students: 5, tasks: 8 },
  );
  const revoked = parseManagedExamProjectionSnapshot(
    envelope([], 5, 9),
    { students: 5, tasks: 9 },
  );

  assert.equal(managedExamSnapshotCanReplace(archived, assigned.versions), true);
  assert.deepEqual(archived.students, []);
  assert.equal(managedExamSnapshotCanReplace(revoked, archived.versions), true);
  assert.deepEqual(revoked.students, []);
});

test("mixed-version and stale snapshots fail before they can be paired with shared rows", () => {
  assert.throws(() => parseManagedExamProjectionSnapshot(
    envelope([], 5, 9),
    { students: 5, tasks: 10 },
  ), /versions do not match/);

  const stale = parseManagedExamProjectionSnapshot(
    envelope([], 5, 9),
    { students: 5, tasks: 9 },
  );
  assert.equal(managedExamSnapshotCanReplace(stale, { students: 5, tasks: 10 }), false);
});

test("authority version responses fail closed when either row is absent, duplicated, or rolled back", () => {
  assert.deepEqual(parseManagedExamAuthorityVersions([
    { entity: "students", version: 5, updated_by: "server" },
    { entity: "tasks", version: 9, updated_by: "server" },
  ]), { students: 5, tasks: 9 });
  assert.throws(() => parseManagedExamAuthorityVersions([
    { entity: "students", version: 5 },
  ]), /tasks authority row is missing or duplicated/);
  assert.throws(() => parseManagedExamAuthorityVersions([
    { entity: "students", version: 5 },
    { entity: "students", version: 6 },
    { entity: "tasks", version: 9 },
  ]), /students authority row is missing or duplicated/);

  const advertisedRollback = {
    versions: parseManagedExamAuthorityVersions([
      { entity: "students", version: 4 },
      { entity: "tasks", version: 9 },
    ]),
    students: [],
  };
  assert.equal(managedExamSnapshotCanReplace(advertisedRollback, { students: 5, tasks: 9 }), false);
});

test("the refresh parser rejects extra student or exam PII fields", () => {
  assert.throws(() => parseManagedExamProjectionSnapshot(
    envelope([{
      id: "STU-CROSS-1",
      name: "Cross Owner Student",
      initials: "CS",
      owner: "Thea",
      guardianWechat: "secret",
      exams: [exam],
    }], 4, 8),
    { students: 4, tasks: 8 },
  ), /student projection is invalid/);

  assert.throws(() => parseManagedExamProjectionSnapshot(
    envelope([{
      id: "STU-CROSS-1",
      name: "Cross Owner Student",
      initials: "CS",
      owner: "Thea",
      exams: [{ ...exam, privateStudentNote: "secret" }],
    }], 4, 8),
    { students: 4, tasks: 8 },
  ), /unexpected fields/);
});
