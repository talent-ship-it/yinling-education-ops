import assert from "node:assert/strict";
import test from "node:test";
import { buildOpsAccessContext } from "../lib/ops-access";
import type { OpsStateRow, JiaowubaoOpenApiScheduleSnapshotWindow } from "../lib/ops-store";
import { projectAvaCalendarEvents } from "../lib/ava-calendar-projection";

function row(entity: string, payload: unknown): OpsStateRow {
  return { entity, payload, version: 1, updated_at: "2026-10-11T00:00:00.000Z", updated_by: "fixture" };
}
const rows = [
  row("students", [{ id: "S1", name: "Synthetic One", jwbSourceRow: "101", owner: "Tiffany", planner: "Tara", teacher: "Synthetic Teacher" }]),
  row("teachers", [{ id: "T1", name: "Synthetic Teacher" }]),
  row("bookings", []), row("lpItems", []),
];
const event: JiaowubaoOpenApiScheduleSnapshotWindow["events"][number] = {
  eventId: "event-1", sourceDate: "2026-10-11", startsAt: "2026-10-11T04:00:00.000Z", endsAt: "2026-10-11T05:00:00.000Z",
  courseName: "Private source title", sourceTeacherId: "900", sourceTeacherLabel: "Synthetic Teacher",
  sourceParticipants: [{ memberId: "101", label: "Synthetic One" }], sourceStudentsTruncated: false,
};
const accounts = [{ account_id: "staff-tiffany", account_name: "Tiffany", account_role: "staff" as const, status: "active" as const }];
const admin = (state = rows) => buildOpsAccessContext(state, "Nixon", true, { user: "Nixon", role: "admin", permissions: ["*"], scopeMembers: [{ kind: "all", key: "*" }] });

test("links a source participant to the current student owner, not the planner or raw color", () => {
  const result = projectAvaCalendarEvents({ rows, events: [event], access: admin(), accounts });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.teacherId, "T1");
  assert.deepEqual(result.events[0]!.students, [{ studentId: "S1", studentName: "Synthetic One", owner: "Tiffany", ownerId: "staff-tiffany", color: "owner-1" }]);
  assert.equal(result.events[0]!.startsAt, event.startsAt);
  assert.equal(result.events[0]!.endsAt, event.endsAt);
  assert.doesNotMatch(JSON.stringify(result), /Private source title|sourceParticipants|sourceTeacherId|memberId|planner|Tara/);
});

const revision = `sha256:${"a".repeat(64)}`;
const trial = { ...event, courseName: "Synthetic One试听", sourceParticipants: [{ memberId: "shared-A", label: "试听学员A" }] };
const lp = { id: "LP1", studentId: "S1", workflowType: "试听 LP", trialSchedule: { source: "jiaowubao-open-api", sourceRevision: revision, eventId: event.eventId, startsAt: event.startsAt, endsAt: event.endsAt, teacherId: "T1" } };

test("resolves a shared trial account only through its exact current-revision LP link", () => {
  const state = [...rows.filter((row) => row.entity !== "lpItems"), row("lpItems", [lp])];
  const result = projectAvaCalendarEvents({ rows: state, events: [trial], access: admin(state), accounts, revision });
  assert.equal(result.events[0]!.trial, true);
  assert.equal(result.events[0]!.students[0]!.studentId, "S1");
  assert.equal(result.events[0]!.students[0]!.owner, "Tiffany");
  assert.doesNotMatch(JSON.stringify(result), /shared-A|试听学员A|Tara|Synthetic One试听/);
});

test("a second trial LP outside the caller scope still makes the source identity ambiguous", () => {
  const state = [row("students", [
    { id: "S1", name: "Synthetic One", owner: "Tiffany", teacher: "Synthetic Teacher" },
    { id: "S2", name: "Private Two", owner: "Ella", teacher: "Other Teacher" },
  ]), rows[1]!, rows[2]!, row("lpItems", [lp, { ...lp, id: "LP2", studentId: "S2" }])];
  const access = buildOpsAccessContext(state, "Tiffany", false, { user: "Tiffany", role: "staff", permissions: ["operations.read"] });
  assert.deepEqual(projectAvaCalendarEvents({ rows: state, events: [trial], access, accounts, revision }).events, []);
});

test("missing owners remain neutral and the occupied event keeps its exact time", () => {
  for (const owner of ["", "待分配", "Tara", "试听学员A"]) {
    const state = [row("students", [{ id: "S1", name: "Synthetic One", jwbSourceRow: "101", owner, planner: "Abby" }]), ...rows.slice(1)];
    const result = projectAvaCalendarEvents({ rows: state, events: [event], access: admin(state), accounts });
    assert.equal(result.events[0]!.students[0]!.ownerId, null);
    assert.equal(result.events[0]!.students[0]!.color, "owner-unassigned");
    assert.equal(result.events[0]!.startsAt, event.startsAt);
  }
});

test("inactive, wrong-role, or duplicate coordinator accounts cannot supply a color", () => {
  for (const current of [[{ ...accounts[0]!, status: "disabled" as const }], [{ ...accounts[0]!, account_role: "teacher" as const }], [...accounts, { ...accounts[0]!, account_id: "other" }]]) {
    assert.equal(projectAvaCalendarEvents({ rows, events: [event], access: admin(), accounts: current }).events[0]!.students[0]!.owner, null);
  }
});

test("all six colors stay bound to coordinator identity regardless of roster order", () => {
  const names = ["Tiffany", "Ella", "Abby", "Molly", "Thea", "Erin"];
  names.forEach((owner, index) => {
    const state = [row("students", [{ id: "S1", name: "Synthetic One", jwbSourceRow: "101", owner }]), ...rows.slice(1)];
    const current = [...names].reverse().map((name) => ({ ...accounts[0]!, account_name: name, account_id: `staff-${name}` }));
    const student = projectAvaCalendarEvents({ rows: state, events: [event], access: admin(state), accounts: current }).events[0]!.students[0]!;
    assert.equal(student.color, `owner-${index + 1}`);
    assert.equal(student.ownerId, `staff-${owner}`);
  });
});

test("conflicting member and name identities never become a combined or guessed student", () => {
  const state = [row("students", [{ id: "S1", name: "Synthetic One", jwbSourceRow: "101", owner: "Tiffany" }, { id: "S2", name: "Private Two", jwbSourceRow: "102", owner: "Ella" }]), ...rows.slice(1)];
  const result = projectAvaCalendarEvents({ rows: state, events: [{ ...event, sourceParticipants: [{ memberId: "102", label: "Synthetic One" }] }], access: admin(state), accounts });
  assert.deepEqual(result.events[0]!.students, []);
  assert.equal(result.events[0]!.identityPending, true);
});

test("duplicate global names cannot look unique inside a staff scope", () => {
  const state = [row("students", [{ id: "S1", name: "Same Name", owner: "Tiffany" }, { id: "S2", name: "Same Name", owner: "Ella" }]), ...rows.slice(1)];
  const access = buildOpsAccessContext(state, "Tiffany", false, { user: "Tiffany", role: "staff", permissions: ["operations.read"] });
  assert.deepEqual(projectAvaCalendarEvents({ rows: state, events: [{ ...event, sourceParticipants: [{ memberId: null, label: "Same Name" }] }], access, accounts }).events, []);
});

test("teachers retain unidentified occupied lessons without receiving unauthorized names", () => {
  const access = buildOpsAccessContext(rows, "Synthetic Teacher", false, { user: "Synthetic Teacher", role: "teacher", permissions: ["operations.read"] });
  const own = { ...event, sourceParticipants: [{ memberId: "private-unknown", label: "Private Unknown" }] };
  const result = projectAvaCalendarEvents({ rows, events: [own, { ...own, eventId: "other", sourceTeacherLabel: "Other Teacher" }], access, accounts });
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0]!.students, []);
  assert.equal(result.events[0]!.identityPending, true);
  assert.doesNotMatch(JSON.stringify(result), /Private Unknown|private-unknown|Other Teacher/);
});

test("shared accounts without a current proven LP remain unidentified occupied lessons", () => {
  for (const state of [rows, [...rows.slice(0, 3), row("lpItems", [{ ...lp, trialSchedule: { ...lp.trialSchedule, sourceRevision: `sha256:${"b".repeat(64)}` } }])]]) {
    const result = projectAvaCalendarEvents({ rows: state, events: [trial], access: admin(state), accounts, revision });
    assert.deepEqual(result.events[0]!.students, []);
    assert.equal(result.events[0]!.identityPending, true);
  }
});

test("permissions and entity scopes do not become weaker on the new calendar", () => {
  for (const identity of [{ user: "Tiffany", role: "staff" as const, permissions: [] }, { user: "Tiffany", role: "staff" as const, permissions: ["operations.read"], scopeMembers: [{ kind: "entity", key: "students" }] }]) {
    const access = buildOpsAccessContext(rows, identity.user, false, identity);
    assert.deepEqual(projectAvaCalendarEvents({ rows, events: [event], access, accounts }), { events: [], teachers: [] });
  }
});

test("duplicate internal IDs cannot silently choose the last student's ownership", () => {
  const state = [row("students", [{ id: "S1", name: "Synthetic One", jwbSourceRow: "101", owner: "Tiffany" }, { id: "S1", name: "Private Two", jwbSourceRow: "102", owner: "Ella" }]), ...rows.slice(1)];
  assert.throws(() => projectAvaCalendarEvents({ rows: state, events: [event], access: admin(state), accounts }), /source_unavailable/);
});

test("malformed source tokens are not repaired into a successful stable-ID match", () => {
  const state = [row("students", [{ id: "S1", name: "Synthetic One", jwbSourceRow: " 101 ", owner: "Tiffany" }]), ...rows.slice(1)];
  const result = projectAvaCalendarEvents({ rows: state, events: [{ ...event, sourceParticipants: [{ memberId: "101", label: null }] }], access: admin(state), accounts });
  assert.deepEqual(result.events[0]!.students, []);
});
