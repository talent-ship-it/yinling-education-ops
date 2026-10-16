import type { OpsStateRow, JiaowubaoOpenApiScheduleSnapshotWindow } from "../lib/ops-store";

export function sourceNameFixture() {
  const revision = `sha256:${"a".repeat(64)}`;
  const student = { id: "S1", name: "合成学生甲 Synthetic Alpha", jwbSourceRow: "member-1", owner: "Tiffany", teacher: "Synthetic Teacher", jiaowubaoOpenApi: { sourceId: "member-1", resolution: "stable_source_id", confidence: "exact", snapshotRevision: revision } };
  const teacher = { id: "T1", name: "Synthetic Teacher", jiaowubaoOpenApi: { sourceId: "teacher-1", resolution: "stable_source_id", confidence: "exact", snapshotRevision: revision } };
  const event: JiaowubaoOpenApiScheduleSnapshotWindow["events"][number] = { eventId: "synthetic-event-1", sourceDate: "2026-10-17", startsAt: "2026-10-17T02:00:00.000Z", endsAt: "2026-10-17T03:00:00.000Z", courseName: "Private title must not escape", sourceTeacherId: "teacher-1", sourceTeacherLabel: teacher.name, sourceParticipants: [{ memberId: "member-1", label: student.name }], sourceStudentsTruncated: false };
  const archivedCollision = { id: "legacy", name: "合成学生甲 Legacy", importArchived: true };
  const row = (entity: string, payload: unknown): OpsStateRow => ({ entity, payload, version: 1, updated_at: "2026-10-17T00:00:00Z", updated_by: "synthetic" });
  const rows = [row("students", [student, archivedCollision]), row("teachers", [teacher]), row("bookings", []), row("lpItems", [])];
  const accounts = [{ account_id: "staff-tiffany", account_name: "Tiffany", account_role: "staff" as const, status: "active" as const }];
  return { revision, student, teacher, event, archivedCollision, rows, accounts };
}
