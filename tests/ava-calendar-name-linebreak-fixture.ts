import { sourceNameFixture } from "./ava-calendar-source-name-fixture";

export function nameLinebreakFixture() {
  const base = sourceNameFixture();
  const sourceLabel = "SynthName\n测试学生";
  const student = { ...base.student, name: "SynthName 测试学生" };
  const collision = { id: "synthetic-name-collision", name: "OtherName 测试学生", owner: "" };
  const resolvedStudent = { ...base.student, id: "S2", name: "合成独立学生 Native Positive", jwbSourceRow: "member-2" };
  const events = Array.from({ length: 3 }, (_, index) => ({
    ...base.event,
    eventId: `synthetic-linebreak-${index + 1}`,
    startsAt: `2026-10-17T0${index + 2}:00:00.000Z`,
    endsAt: `2026-10-17T0${index + 3}:00:00.000Z`,
    sourceParticipants: [{ memberId: student.jwbSourceRow, label: sourceLabel }],
  }));
  const nativeEvent = { ...base.event, eventId: "synthetic-native-control", startsAt: "2026-10-17T05:00:00.000Z", endsAt: "2026-10-17T06:00:00.000Z", sourceParticipants: [{ memberId: resolvedStudent.jwbSourceRow, label: resolvedStudent.name }] };
  const rows = base.rows.map((row) => row.entity === "students" ? { ...row, payload: [student, collision, resolvedStudent] } : row);
  return { ...base, student, sourceLabel, collision, resolvedStudent, events, nativeEvent, rows };
}
