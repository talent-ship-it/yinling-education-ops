import assert from "node:assert/strict";
import test from "node:test";
import { projectAvaCalendarEvents } from "../lib/ava-calendar-projection";
import { buildOpsAccessContext } from "../lib/ops-access";
import { createAvaCalendarHandler } from "../lib/ava-calendar-service";
import { readAvaCalendarSnapshot } from "../lib/ava-calendar-snapshot";
import { sourceNameFixture } from "./ava-calendar-source-name-fixture";
import { fetchAvaCalendarWindow, fetchAvaCalendarRange } from "../lib/ava-calendar-live-client";
import { fixture as serverState, serverFixture } from "./ava-calendar-server-fixture";
import type { DemoSessionIdentity } from "../lib/demo-session-token";
import type { AvaCalendarMachineCapability } from "../lib/ava-calendar-machine-auth";

const { revision, student, event, archivedCollision, rows: fixtureRows, accounts } = sourceNameFixture();
const admin: DemoSessionIdentity = { user: "Synthetic Admin", role: "admin", permissions: ["*"] };
function project(students: unknown[] = [student, archivedCollision], source = event, session = admin, fullAdmin = true) {
  const rows = fixtureRows.map((row) => row.entity === "students" ? { ...row, payload: students } : row);
  const access = buildOpsAccessContext(rows, session.user, fullAdmin, session);
  return projectAvaCalendarEvents({ rows, events: [source], sourceEvents: [source], access, accounts, revision, strictSourceIdentity: true });
}

test("an authorized source name survives an archived name collision without inventing a Native identity", () => {
  const result = project().events[0]!;
  assert.equal(result.eventId, event.eventId);
  assert.equal(result.startsAt, event.startsAt);
  assert.equal(result.endsAt, event.endsAt);
  assert.deepEqual(result.students, []);
  assert.equal(result.identityPending, true);
  assert.deepEqual(result.unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
});

test("malformed source labels are not promoted to student display names", () => {
  for (const label of ["<script>synthetic</script>", "合成\u0000学生", "合成\u202e学生", "x".repeat(241), " ".repeat(241) + "Name", "   ", null]) {
    const source = { ...event, sourceParticipants: [{ memberId: "unknown-member", label }] };
    assert.equal(project([], source).events[0]!.unresolvedSourceStudents, undefined);
    assert.deepEqual(project([], source).events[0]!.students, []);
  }
});

test("active and different-member name collisions cannot acquire Native IDs or ownership from a display name", () => {
  for (const collision of [{ ...archivedCollision, importArchived: false }, { ...archivedCollision, importArchived: false, jwbSourceRow: "other-member" }]) {
    const result = project([student, collision]).events[0]!;
    assert.deepEqual(result.students, []);
    assert.deepEqual(result.unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
    assert.equal(result.identityPending, true);
  }
});

test("duplicate archived member identities remain unresolved while a source name stays presentation-only", () => {
  const result = project([student, { ...student, id: "duplicate", importArchived: true }]).events[0]!;
  assert.deepEqual(result.students, []);
  assert.deepEqual(result.unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
  assert.equal(result.identityPending, true);
});

test("source display neither depends on a Native student nor manufactures one", () => {
  const result = project([]).events[0]!;
  assert.deepEqual(result.students, []);
  assert.deepEqual(result.unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
  assert.equal(result.identityPending, true);
});

test("invalid or absent members do not become display-name evidence", () => {
  for (const memberId of [null, " member-1", "member-1 ", "bad/member"]) {
    const result = project([], { ...event, sourceParticipants: [{ memberId, label: student.name }] }).events[0]!;
    assert.deepEqual(result.students, []);
    assert.equal(result.unresolvedSourceStudents, undefined);
    assert.equal(result.identityPending, true);
  }
});

test("already resolved participants retain their exact Native DTO without duplicate source names", () => {
  const result = project([student]).events[0]!;
  assert.equal(result.students[0]!.studentId, student.id);
  assert.equal(result.students[0]!.owner, "Tiffany");
  assert.equal(result.unresolvedSourceStudents, undefined);
  assert.equal(result.identityPending, false);
});

test("shared trial aliases never masquerade as actual student display names", () => {
  for (const label of ["试听学员A", "试听学员A(Tara龙) 2026", "试听学员B 校长号1️⃣ 2026", "trial account C"]) {
    const result = project([], { ...event, sourceParticipants: [{ memberId: "shared-member", label }] }).events[0]!;
    assert.equal(result.trial, true);
    assert.equal(result.identityPending, true);
    assert.deepEqual(result.students, []);
    assert.equal(result.unresolvedSourceStudents, undefined);
    assert.ok(!JSON.stringify(result).includes(label));
  }
});

const restrictedSessions: { session: DemoSessionIdentity; fullAdmin: boolean }[] = [
  { session: { user: "Tiffany", role: "staff", permissions: ["*"] }, fullAdmin: false },
  { session: { user: "Synthetic Teacher", role: "teacher", permissions: ["*"] }, fullAdmin: false },
  { session: { user: "Synthetic Limited", role: "limited-admin", permissions: ["*"] }, fullAdmin: false },
  { session: { ...admin, scopeMembers: [{ kind: "student", key: "S1" }] }, fullAdmin: true },
  { session: { ...admin, scopeMembers: [{ kind: "teacher", key: "T1" }] }, fullAdmin: true },
  { session: { ...admin, scopeMembers: [{ kind: "entity", key: "students" }] }, fullAdmin: true },
  { session: { ...admin, permissions: ["students.read.assigned", "bookings.read.assigned"] }, fullAdmin: true },
];
for (const { session, fullAdmin } of restrictedSessions) {
  test(`unresolved source names do not widen ${session.role} scope ${JSON.stringify(session.scopeMembers ?? session.permissions)}`, () => {
    const result = project(undefined, event, session, fullAdmin);
    assert.ok(result.events.every((item) => item.unresolvedSourceStudents === undefined));
    assert.ok(!JSON.stringify(result).includes(student.name));
  });
}

test("teacher event visibility cannot disclose another unresolved student's source name", () => {
  const source = { ...event, sourceParticipants: [{ memberId: "foreign-member", label: "合成范围外学生" }] };
  const result = project(undefined, source, { user: "Synthetic Teacher", role: "teacher", permissions: ["*"] }, false);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0]!.students, []);
  assert.equal(result.events[0]!.identityPending, true);
  assert.doesNotMatch(JSON.stringify(result), /合成范围外学生|foreign-member/);
});

test("machine calendars do not inherit the human administrator source-name display permission", () => {
  const access: AvaCalendarMachineCapability = { kind: "machine", subject: "ava-calendar-service", permission: "calendar:read", scope: "company", tokenSha256: "a".repeat(64) };
  const result = projectAvaCalendarEvents({ rows: fixtureRows, events: [event], access, accounts, revision, strictSourceIdentity: true });
  assert.equal(result.events[0]!.unresolvedSourceStudents, undefined);
  assert.doesNotMatch(JSON.stringify(result), /合成学生甲/);
});

async function api(session = admin, fullAdmin = true, source = event, revoked = false) {
  let reads = 0;
  const response = await createAvaCalendarHandler({
    strictSourceIdentity: true,
    readSession: async () => revoked && ++reads > 1 ? { error: "revoked", status: 401 } : { session, fullAdmin },
    readRows: async () => fixtureRows,
    readVersions: async () => fixtureRows,
    readAccounts: async () => accounts,
    readSnapshot: (window) => readAvaCalendarSnapshot(window, async () => ({ state: "complete", freshness: "fresh", revision, publishedAt: "2026-10-17T00:00:00Z", sourceWindow: { start: "2026-10-01", end: "2027-01-01" }, invalidTimeEventCount: 0, hasMore: false, nextCursor: null, empty: false, events: [source] })),
  })(new Request("http://127.0.0.1/api/ava-calendar?start=2026-10-17T00:00:00.000Z&end=2026-10-18T00:00:00.000Z"));
  return { response, data: await response.json() };
}

test("the actual API emits only studentName and null owner for an unresolved source participant", async () => {
  const malicious = { ...event, privateRecord: "private-source-record", sourceParticipants: [{ ...event.sourceParticipants[0]!, studentId: "forged-student", owner: "Abby", ownerId: "forged-owner", color: "owner-3", privateField: "private-source-field" }] };
  const { response, data } = await api(admin, true, malicious);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /private.*no-store/);
  assert.deepEqual(Object.keys(data.events[0]).sort(), ["endsAt", "eventId", "identityPending", "startsAt", "students", "teacherId", "teacherName", "trial", "unresolvedSourceStudents"].sort());
  assert.deepEqual(data.events[0].unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
  assert.deepEqual(data.events[0].students, []);
  assert.equal(data.events[0].identityPending, true);
  assert.doesNotMatch(JSON.stringify(data), /private-source|forged|member-1|sourceParticipants|courseName|jwbSourceRow|Tiffany|Abby|owner-3|Legacy/);
});

test("API caller scopes and revocation still prevent publication of source names", async () => {
  for (const { session, fullAdmin } of restrictedSessions) {
    const { data } = await api(session, fullAdmin);
    assert.ok(!JSON.stringify(data).includes(student.name));
    assert.ok(!JSON.stringify(data).includes("unresolvedSourceStudents"));
  }
  const { response, data } = await api(admin, true, event, true);
  assert.equal(response.status, 401);
  assert.ok(!JSON.stringify(data).includes(student.name));
});

const dayWindow = { start: "2026-10-17T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" };
test("a complete synthetic 1576-lesson month preserves 958 Native identities, 602 display-only names and 16 unresolved shared accounts", () => {
  const resolvedStudent = { ...student, id: "S2", name: "合成学生乙", jwbSourceRow: "member-2" };
  const rows = fixtureRows.map((row) => row.entity === "students" ? { ...row, payload: [student, archivedCollision, resolvedStudent] } : row);
  const access = buildOpsAccessContext(rows, admin.user, true, admin);
  const events = Array.from({ length: 1576 }, (_, index) => ({ ...event, eventId: `month-${index}`, sourceParticipants: [index < 958 ? { memberId: resolvedStudent.jwbSourceRow, label: resolvedStudent.name } : index < 1560 ? event.sourceParticipants[0]! : { memberId: "shared-member", label: "试听学员A" }] }));
  const result = projectAvaCalendarEvents({ rows, events, sourceEvents: events, access, accounts, revision, strictSourceIdentity: true });
  assert.equal(result.events.length, 1576);
  assert.equal(result.events.filter((item) => item.students.length === 1).length, 958);
  assert.equal(result.events.filter((item) => item.unresolvedSourceStudents?.length === 1).length, 602);
  assert.equal(result.events.filter((item) => item.trial && item.students.length === 0 && item.unresolvedSourceStudents === undefined).length, 16);
  assert.ok(result.events.filter((item) => item.unresolvedSourceStudents).every((item) => item.identityPending && item.students.length === 0 && item.unresolvedSourceStudents![0]!.owner === null));
  assert.deepEqual(result.events.map(({ eventId, startsAt, endsAt }) => [eventId, startsAt, endsAt]), events.map(({ eventId, startsAt, endsAt }) => [eventId, startsAt, endsAt]));
});
test("API-to-live decoding retains source names as pending neutral display-only DTOs", async () => {
  const { data } = await api();
  const result = await fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json(data));
  assert.deepEqual(result.events[0]!.unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
  assert.deepEqual(result.events[0]!.students, []);
  assert.equal(result.events[0]!.identityPending, true);
  assert.deepEqual(result.remainingAVA, []);
});

test("the live decoder cannot turn source display fields into IDs, ownership or resolved identity", async () => {
  const { data } = await api();
  data.events[0].unresolvedSourceStudents[0] = { studentName: student.name, owner: null, studentId: "forged", ownerId: "forged", color: "owner-1", secret: "synthetic-private" };
  const result = await fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json(data));
  assert.deepEqual(result.events[0]!.unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
  assert.doesNotMatch(JSON.stringify(result), /forged|synthetic-private/);
});

test("malformed source-name DTOs and false resolved flags fail closed", async () => {
  const { data } = await api();
  for (const unresolvedSourceStudents of [null, {}, [null], [{ studentName: "试听学员A", owner: null }], [{ studentName: "<img src=x>", owner: null }], [{ studentName: student.name, owner: "Tiffany" }], [{ studentName: " ", owner: null }], Array.from({ length: 129 }, () => ({ studentName: student.name, owner: null }))]) {
    const body = { ...data, events: [{ ...data.events[0], unresolvedSourceStudents }] };
    await assert.rejects(() => fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json(body)), /课表暂时无法读取/);
  }
  const body = { ...data, events: [{ ...data.events[0], identityPending: false }] };
  await assert.rejects(() => fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json(body)), /课表暂时无法读取/);
});

function mixedSharedState(order = [0, 1, 2], linked = true, alias = "试听学员A") {
  const state = serverState();
  const resolved = { ...student, id: "S2", name: "独立合成学生乙", jwbSourceRow: "member-2" };
  const participants = [{ memberId: "shared-member", label: alias }, { memberId: resolved.jwbSourceRow, label: resolved.name }, event.sourceParticipants[0]!];
  const mixed = { ...event, sourceParticipants: order.map((index) => participants[index]!) };
  const lp = { id: "synthetic-lp", studentId: resolved.id, workflowType: "试听 LP", trialSchedule: { source: "jiaowubao-open-api", sourceRevision: revision, eventId: event.eventId, startsAt: event.startsAt, endsAt: event.endsAt, teacherId: sourceNameFixture().teacher.id } };
  state.rows = fixtureRows.map((row) => row.entity === "students" ? { ...row, payload: [student, archivedCollision, resolved] } : row.entity === "lpItems" ? { ...row, payload: linked ? [lp] : [] } : row);
  state.page = { ...state.page, revision, publishedAt: "2026-10-17T00:00:00.000Z", sourceWindow: { start: "2026-09-01", end: "2027-02-01" }, events: [mixed, { ...event, eventId: "zz-resolved-control", sourceParticipants: [participants[1]!] }] };
  state.now = Date.parse("2026-10-17T00:00:01Z");
  state.session = admin;
  return state;
}

for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  for (const linked of [true, false]) {
    test(`mixed shared participants preserve the entire decoded range in order ${order} with LP ${linked}`, async () => {
      const server = serverFixture(mixedSharedState(order, linked), () => {}, true);
      const range = { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" };
      const response = await server.getRange(range);
      assert.equal(response.status, 200);
      const data = await fetchAvaCalendarRange(range, new AbortController().signal, async () => response);
      assert.equal(data.events.length, 2);
      const mixed = data.events.find((item) => item.eventId === event.eventId)!;
      assert.equal(mixed.identityPending, true);
      assert.equal(mixed.trial, true);
      assert.deepEqual(mixed.students.map((item) => item.studentId), ["S2"]);
      assert.deepEqual(mixed.unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
      assert.equal(data.events.find((item) => item.eventId === "zz-resolved-control")!.identityPending, false);
      assert.deepEqual(data.remainingAVA, []);
    });
  }
}

for (const alias of ["试听学员A", "试听学员B 校长号1️⃣ 2026", "trial account C"]) {
  test(`mixed shared alias ${alias} never becomes display or identity evidence`, async () => {
    const response = await serverFixture(mixedSharedState(undefined, true, alias), () => {}, true).get("human", dayWindow);
    assert.equal(response.status, 200);
    const data = await fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => response);
    assert.equal(data.events[0]!.identityPending, true);
    assert.deepEqual(data.events[0]!.unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
    assert.ok(!JSON.stringify(data).includes(alias));
  });
}

for (const participants of [
  [{ memberId: "never-bound-member", label: student.name }],
  [event.sourceParticipants[0]!, { memberId: "never-bound-member", label: student.name }],
  [{ memberId: "never-bound-member", label: student.name }, event.sourceParticipants[0]!],
]) {
  test(`strict unknown member retains source-only display beside ${participants.map((item) => item.memberId)}`, async () => {
    const state = mixedSharedState();
    state.rows = fixtureRows.map((row) => row.entity === "students" ? { ...row, payload: [student] } : row);
    state.page = { ...state.page, events: [{ ...event, sourceParticipants: participants }] };
    const response = await serverFixture(state, () => {}, true).get("human", dayWindow);
    assert.equal(response.status, 200);
    const data = await fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => response);
    const result = data.events[0]!;
    assert.equal(result.identityPending, true);
    assert.deepEqual(result.students.map((item) => item.studentId), participants.length === 1 ? [] : [student.id]);
    assert.deepEqual(result.unresolvedSourceStudents, [{ studentName: student.name, owner: null }]);
  });
}

for (const role of ["teacher", "staff", "limited-admin", "machine"] as const) {
  test(`mixed pending and strict unknown source display cannot widen ${role} visibility`, async () => {
    const state = mixedSharedState();
    state.fullAdmin = false;
    state.session = { user: role === "teacher" ? "Synthetic Teacher" : "Tiffany", role: role === "machine" ? "admin" : role, permissions: ["*"] };
    const response = await serverFixture(state, () => {}, true).get(role === "machine" ? "machine" : "human", dayWindow);
    assert.equal(response.status, 200);
    const data = await fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => response);
    assert.equal(data.events.length, 2);
    assert.equal(data.events[0]!.identityPending, true);
    assert.equal(data.events[0]!.unresolvedSourceStudents, undefined);
    assert.deepEqual(data.events[0]!.students.map((item) => item.studentId), ["S2"]);
    assert.ok(!JSON.stringify(data).includes(student.name));
  });
}
