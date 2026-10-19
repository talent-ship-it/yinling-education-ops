import assert from "node:assert/strict";
import test from "node:test";
import { loadClassroomAttendance, projectClassroomAttendance } from "../lib/classroom-attendance.ts";

const expected = { teacherId: "T1", studentId: "S1", startsAt: Date.parse("2026-10-19T00:00:00Z") };

test("attendance shows actual first entry and merged time after reconnects", () => {
  const result = projectClassroomAttendance({ teacher: { userId: "T1", joinLeave: [
    { joinedAt: "2026-10-19T00:12:00Z", leftAt: "2026-10-19T00:30:00Z" },
    { joinedAt: "2026-10-19T00:02:30Z", leftAt: "2026-10-19T00:15:00Z" },
    { joinedAt: "2026-10-19T00:40:00Z", leftAt: "2026-10-19T01:00:00Z" },
  ] } }, expected);
  assert.deepEqual(result.teacher, { firstJoinedAt: "2026-10-19T00:02:30.000Z", lastLeftAt: "2026-10-19T01:00:00.000Z", durationSeconds: 2850, lateSeconds: 150 });
  assert.equal(result.student, null);
});

test("reassigned teacher and invalid or missing evidence are never shown as the current party", () => {
  const result = projectClassroomAttendance({ teacher: { userId: "OLD", accumulatedSeconds: 3600, joinLeave: [{ joinedAt: "2026-10-19T00:00:00Z", leftAt: "2026-10-19T01:00:00Z" }] }, student: { userId: "S1", joinLeave: [{ joinedAt: "invalid", leftAt: "invalid" }] } }, expected);
  assert.deepEqual(result, { teacher: null, student: null });
  assert.deepEqual(projectClassroomAttendance({ teacher: { userId: "T1", accumulatedSeconds: 3600 } }, expected), { teacher: null, student: null });
});

test("early arrival is displayed as punctual without moving timestamps to lesson start", () => {
  const result = projectClassroomAttendance({ student: { userId: "S1", joinLeave: [{ joinedAt: "2026-10-18T23:55:00Z", leftAt: "2026-10-19T01:00:00Z" }] } }, expected);
  assert.equal(result.student?.lateSeconds, 0);
  assert.equal(result.student?.firstJoinedAt, "2026-10-18T23:55:00.000Z");
});


test("attendance reads only a matching occurrence and distinguishes failed synchronization", async () => {
  const evidence = { student: { userId: "S1", joinLeave: [{ joinedAt: "2026-10-19T00:00:00Z", leftAt: "2026-10-19T01:00:00Z" }] } };
  let reads = 0;
  const loader = async () => { reads += 1; return { occurrenceId: "B1:2026-10-19", evidence }; };
  assert.equal((await loadClassroomAttendance(undefined, "B1:2026-10-19", expected, loader)).attendance, null);
  assert.equal(reads, 0);
  const matched = await loadClassroomAttendance("synthetic-reference", "B1:2026-10-19", expected, loader);
  assert.equal(matched.attendance?.student?.durationSeconds, 3600);
  assert.equal(matched.attendanceUnavailable, false);
  assert.equal((await loadClassroomAttendance("synthetic-reference", "B2:2026-10-19", expected, loader)).attendance, null);
  assert.deepEqual(await loadClassroomAttendance("synthetic-reference", "B1:2026-10-19", expected, async () => { throw new Error("unavailable"); }), { attendance: null, attendanceUnavailable: true });
});
