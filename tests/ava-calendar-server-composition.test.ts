import assert from "node:assert/strict";
import test from "node:test";
import { fixture, serverFixture, window, publishedAt } from "./ava-calendar-server-fixture";

test("queued machine revocation at the health boundary stops every new metadata getter", async () => {
  let completed = false;
  let afterSnapshot = 0;
  const server = serverFixture(fixture(), (rpc) => { if (rpc === "get_jiaowubao_open_api_schedule_snapshot_window") completed = true; });
  let current: string | undefined = server.environment.AVA_CALENDAR_SERVICE_TOKEN_SHA256;
  Object.defineProperty(server.environment, "AVA_CALENDAR_SERVICE_TOKEN_SHA256", { get: () => {
    if (completed && ++afterSnapshot === 2) queueMicrotask(() => { current = undefined; });
    return current;
  } });
  const response = await server.get("machine");
  assert.equal(response.status, 503);
  assert.deepEqual(server.calls.filter(({ rpc }) => ["get_ops_sources", "get_jiaowubao_open_api_schedule_projection_target", "get_ops_versions"].includes(rpc)), []);
  assert.doesNotMatch(await response.text(), /events|students|Synthetic/);
});

for (const kind of ["human", "machine"] as const) {
  test(`${kind} strict trial links preserve microsecond proof and literal native student IDs`, async () => {
    const state = fixture();
    const sourceEvent = state.page.events[0]!;
    state.page = { ...state.page, events: [{ ...sourceEvent, sourceParticipants: [{ memberId: "shared-A", label: "试听学员A" }] }] };
    const link = { source: "jiaowubao-open-api", sourceRevision: state.page.revision, eventId: sourceEvent.eventId, teacherId: "T1", startsAt: "2026-10-12T02:00:00.123Z", endsAt: "2026-10-12T03:00:00.123Z" };
    const lp = { id: "LP1", workflowType: "试听 LP", studentId: "S1", trialSchedule: link };
    state.rows.find(({ entity }) => entity === "lpItems")!.payload = [lp];
    let response = await serverFixture(state).get(kind);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).events[0].students, []);
    lp.trialSchedule = { ...link, startsAt: sourceEvent.startsAt, endsAt: sourceEvent.endsAt };
    response = await serverFixture(state).get(kind);
    assert.equal((await response.json()).events[0].students[0].studentId, "S1");
    lp.studentId = " S1 ";
    response = await serverFixture(state).get(kind);
    assert.deepEqual((await response.json()).events[0].students, []);
  });

  test(`${kind} actual GET composes complete raw pages into outward-rounded private occupancy`, async () => {
    const state = fixture();
    const sourceEvent = state.page.events[0]!;
    state.page = { ...state.page, events: Array.from({ length: 251 }, (_, index) => ({ ...sourceEvent, eventId: `event-${String(index).padStart(3, "0")}` })) };
    state.target.rowCount = 251;
    state.sources[0]!.payload.coverage.snapshotRows = 251;
    state.sources[0]!.row_count = 251;
    const server = serverFixture(state);
    const response = await server.get(kind);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.remainingAVA?.map(({ teacherId, startsAt, endsAt }: { teacherId: string; startsAt: string; endsAt: string }) => ({ teacherId, startsAt, endsAt })), [
      { teacherId: "T1", startsAt: window.start, endsAt: "2026-10-12T02:00:00.123Z" },
      { teacherId: "T1", startsAt: "2026-10-12T03:00:00.124Z", endsAt: window.end },
    ]);
    assert.equal(data.events.length, 251);
    assert.equal(data.events[0].endsAt, "2026-10-12T03:00:00.123Z");
    assert.equal(data.events[0].teacherId, "T1");
    assert.equal(data.events[0].students[0].ownerId, "staff-tiffany");
    assert.equal(data.source.publishedAt, publishedAt);
    assert.deepEqual(data.source.window, { start: "2026-09-30T14:00:00.000Z", end: "2026-11-30T13:00:00.000Z" });
    assert.deepEqual(data.nativeVersions, { students: 1, teachers: 1, bookings: 1, lpItems: 1, courses: 1 });
    assert.match(data.consistencyKey, /^[a-f0-9]{64}$/);
    assert.deepEqual(data.availabilityStatus, [{ teacherId: "T1", reason: "ready" }]);
    assert.deepEqual(Object.keys(data).sort(), ["availabilityStatus", "consistencyKey", "events", "nativeVersions", "remainingAVA", "source", "teachers"]);
    assert.equal(server.calls.filter(({ rpc }) => rpc === "get_jiaowubao_open_api_schedule_snapshot_window").length, 2);
    assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_versions").length, 1);
    assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_sources").length, 1);
    assert.doesNotMatch(JSON.stringify(data), /private|sourceParticipants|sourceTeacherId|sourceId|nativeApply|matches|prices|updated_by|jwbSourceRow|tokenSha256/);
  });
}
