import assert from "node:assert/strict";
import test from "node:test";
import { attendanceEvidenceFromBbb, parseBbbAnalyticsPayload } from "../lib/bbb-analytics.ts";
import { evaluateLessonAttendance, type AttendanceSpan, type LessonAttendanceEvidence, type LessonOccurrence } from "../lib/lesson-occurrences.ts";
import { prepareLessonOccurrenceSettlement } from "../lib/lesson-occurrence-service.ts";

const occurrence: LessonOccurrence = {
  occurrenceId: "B1:2026-09-07", seriesId: "B1", sourceDate: "2026-09-07", date: "2026-09-07",
  start: "10:00", timezone: "UTC", scheduledDurationMinutes: 60, status: "confirmed",
  studentId: "S1", teacherId: "T1", packageId: "P1", subjectId: "English",
};
const span = (joined: string, left: string): AttendanceSpan => ({
  joinedAt: `2026-09-07T${joined}:00.000Z`, leftAt: `2026-09-07T${left}:00.000Z`,
});
const evidence = (student: readonly AttendanceSpan[], teacher: readonly AttendanceSpan[]): LessonAttendanceEvidence => ({
  student: { userId: "S1", joinLeave: student }, teacher: { userId: "T1", joinLeave: teacher },
});

test("early arrival cannot offset early departure or time outside the scheduled lesson", () => {
  for (const [student, teacher, expected] of [
    [[span("10:00", "11:00")], [span("09:45", "10:45")], 2700],
    [[span("09:45", "10:45")], [span("09:45", "10:45")], 2700],
    [[span("10:15", "11:15")], [span("10:15", "11:15")], 2700],
    [[span("09:00", "10:00")], [span("10:00", "11:00")], 0],
  ] as const) {
    const result = evaluateLessonAttendance(occurrence, evidence(student, teacher));
    assert.equal(result.studentSeconds, 3600);
    assert.equal(result.teacherSeconds, 3600);
    assert.equal(result.jointSeconds, expected);
    assert.equal(result.classification, "abnormal");
    assert.ok(result.reasons.includes("joint_duration_short"));
  }
});

test("overlapping and reconnect spans count once and shared gaps respect the five-minute tolerance", () => {
  const student = [span("10:30", "11:00"), span("10:00", "10:40")];
  assert.equal(evaluateLessonAttendance(occurrence, evidence(student, [span("10:00", "10:20"), span("10:25", "11:00")])).classification, "normal");
  const short = evaluateLessonAttendance(occurrence, evidence(student, [span("10:00", "10:20"), span("10:26", "11:00")]));
  assert.equal(short.jointSeconds, 3240);
  assert.equal(short.classification, "abnormal");
});

test("duration-only, malformed, and empty timelines cannot be automatically settled", () => {
  for (const value of [
    { student: { userId: "S1", accumulatedSeconds: 3600 }, teacher: { userId: "T1", accumulatedSeconds: 3600 } },
    evidence([span("10:00", "11:00")], [{ joinedAt: "invalid", leftAt: "invalid" }]),
    evidence([span("10:00", "11:00")], []),
    evidence([span("10:00", "11:00")], [span("11:00", "10:00")]),
  ]) assert.equal(evaluateLessonAttendance(occurrence, value).classification, "abnormal");
});

test("the booking timezone controls the billing window, including Australian daylight saving", () => {
  for (const [date, utcHour] of [["2026-09-07", "00"], ["2026-12-07", "23"]]) {
    const utcDate = date === "2026-12-07" ? "2026-12-06" : date;
    const start = `${utcDate}T${utcHour}:00:00.000Z`;
    const spans = [{ joinedAt: start, leftAt: new Date(Date.parse(start) + 3600_000).toISOString() }];
    const result = evaluateLessonAttendance({ ...occurrence, date, timezone: "Australia/Melbourne" }, evidence(spans, spans));
    assert.equal(result.jointSeconds, 3600);
    assert.equal(result.classification, "normal");
  }
});

test("real BBB parsing through settlement flags early departure without changing balances or payroll", () => {
  const payload = parseBbbAnalyticsPayload({
    version: "1.0", meeting_id: "synthetic", internal_meeting_id: "synthetic-internal",
    data: {
      metadata: { "occurrence-id": occurrence.occurrenceId, "booking-id": "B1", "student-id": "S1", "teacher-id": "T1" },
      start: "2026-09-07T09:45:00Z", finish: "2026-09-07T11:00:00Z", duration: 4500,
      attendees: [
        { ext_user_id: "S1", name: "Synthetic student", moderator: false, joins: ["2026-09-07T10:00:00Z"], leaves: ["2026-09-07T11:00:00Z"], duration: 3600 },
        { ext_user_id: "T1", name: "Synthetic teacher", moderator: true, joins: ["2026-09-07T09:45:00Z"], leaves: ["2026-09-07T10:45:00Z"], duration: 3600 },
      ],
    },
  });
  const payloads = {
    bookings: [{ id: "B1", date: occurrence.date, start: "10:00", timezone: "UTC", duration: 60,
      studentId: "S1", teacherId: "T1", packageId: "P1", course: "English" }],
    students: [{ id: "S1", name: "Synthetic", owner: "Abby", lessonPackages: [{ id: "P1", name: "English",
      subjectIds: ["English"], consumedHours: 0, purchaseRecords: [{ id: "purchase", hours: 10, purchasedAt: "2026-09-01T00:00:00Z" }] }] }],
    teachers: [{ id: "T1", name: "Synthetic teacher" }], payroll: [],
  };
  const prepared = prepareLessonOccurrenceSettlement({
    request: { occurrenceId: occurrence.occurrenceId, expectedVersion: 1, attendanceEvidenceReference: "synthetic" },
    rows: Object.entries(payloads).map(([entity, payload]) => ({ entity, payload, version: 1, updated_at: "2026-09-01T00:00:00Z", updated_by: "fixture" })),
    actor: "BigBlueButton", fullAdmin: false, trustedProvider: "bbb", attendance: attendanceEvidenceFromBbb(payload), completedAt: payload.finishedAt,
  });
  assert.equal(prepared.settlement.attendance?.jointSeconds, 2700);
  assert.equal(prepared.settlement.disposition, "abnormal");
  assert.equal(prepared.settlement.packages[0].consumedHours, 0);
  assert.equal(prepared.settlement.studentHoursLedger.length, 0);
  assert.equal(prepared.settlement.teacherPayrollLedger.length, 0);
});
