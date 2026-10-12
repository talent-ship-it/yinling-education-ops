import assert from "node:assert/strict";
import test from "node:test";
import { projectAvaCalendarEvents } from "../lib/ava-calendar-projection";
import { buildOpsAccessContext } from "../lib/ops-access";
import type { OpsStateRow, JiaowubaoOpenApiScheduleSnapshotWindow } from "../lib/ops-store";

const revision = `sha256:${"a".repeat(64)}`;
const row = (entity: string, payload: unknown): OpsStateRow => ({ entity, payload, version: 1, updated_at: "2026-10-12T00:00:00Z", updated_by: "synthetic" });
const student = { id: "S1", name: "Synthetic Student", jwbSourceRow: "101", owner: "Tiffany", teacher: "Synthetic Teacher" };
const metadata = { sourceId: "901", snapshotRevision: revision, resolution: "stable_source_id", confidence: "exact" };
const teacher = { id: "T1", name: "Synthetic Teacher", jiaowubaoOpenApi: metadata };
const event: JiaowubaoOpenApiScheduleSnapshotWindow["events"][number] = { eventId: "event-1", sourceDate: "2026-10-12", startsAt: "2026-10-12T02:00:00.000Z", endsAt: "2026-10-12T03:00:00.000Z", sourceTeacherId: "901", sourceTeacherLabel: "Synthetic Teacher", courseName: "private synthetic course", sourceParticipants: [{ memberId: "101", label: student.name }], sourceStudentsTruncated: false };
const accounts = [{ account_id: "staff-tiffany", account_name: "Tiffany", account_role: "staff" as const, status: "active" as const }];
function project(teachers: unknown[], students: unknown[] = [student], source = event) {
  const rows = [row("students", students), row("teachers", teachers), row("bookings", []), row("lpItems", [])];
  const access = buildOpsAccessContext(rows, "Synthetic Administrator", true, { user: "Synthetic Administrator", role: "admin", permissions: ["*"] });
  return projectAvaCalendarEvents({ rows, access, accounts, events: [source], revision, ...{ strictSourceIdentity: true } });
}

test("strict calendars require current exact source teacher evidence instead of a unique label", () => {
  for (const jiaowubaoOpenApi of [undefined, { ...metadata, sourceId: 901 }, { ...metadata, sourceId: " 901" }, { ...metadata, snapshotRevision: `sha256:${"b".repeat(64)}` }, { ...metadata, resolution: "same_name" }, { ...metadata, confidence: "strong" }]) {
    const output = project([{ ...teacher, jiaowubaoOpenApi }]);
    assert.equal(output.events[0]!.teacherId, null);
    assert.equal(output.events[0]!.teacherName, null);
    assert.equal(output.events[0]!.identityPending, true);
    assert.equal(output.events[0]!.startsAt, event.startsAt);
  }
  assert.equal(project([teacher]).events[0]!.teacherId, "T1");
  assert.equal(project([teacher], [student], { ...event, sourceTeacherLabel: "different source alias" }).events[0]!.teacherId, "T1");
  assert.equal(project([teacher, { ...teacher, id: "T2" }]).events[0]!.teacherId, null);
});

test("strict students require stable member IDs and cannot hide archived identity conflicts", () => {
  for (const memberId of [null, "missing", " 101", "101 "]) {
    const output = project([teacher], [student], { ...event, sourceParticipants: [{ memberId, label: student.name }] });
    assert.deepEqual(output.events[0]!.students, []);
    assert.equal(output.events[0]!.identityPending, true);
  }
  for (const jwbSourceRow of [undefined, " 101", "101 ", 101.5, -101]) {
    assert.deepEqual(project([teacher], [{ ...student, jwbSourceRow }]).events[0]!.students, []);
  }
  assert.deepEqual(project([teacher], [student, { ...student, id: "S2", importArchived: true }]).events[0]!.students, []);
  assert.equal(project([teacher], [{ ...student, jwbSourceRow: 101 }]).events[0]!.students[0]!.studentId, "S1");
  assert.equal(project([teacher], [student], { ...event, sourceParticipants: [{ memberId: "101", label: null }] }).events[0]!.students[0]!.studentId, "S1");
  const conflict = project([teacher], [student, { ...student, id: "S2", name: "Other Student", jwbSourceRow: "102", importArchived: true }], { ...event, sourceParticipants: [{ memberId: "101", label: "Other Student" }] });
  assert.deepEqual(conflict.events[0]!.students, []);
});
