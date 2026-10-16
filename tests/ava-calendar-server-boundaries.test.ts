import assert from "node:assert/strict";
import test from "node:test";
import { fetchAvaCalendarWindow } from "../lib/ava-calendar-live-client";
import { fixture, serverFixture, student, teacher, event, window, type ServerFixture } from "./ava-calendar-server-fixture";

for (const kind of ["human", "machine"] as const) {
  test(`${kind} actual GET preserves native and coordinator publication fences around health reads`, async () => {
    for (const entity of ["students", "teachers", "bookings", "lpItems"]) {
      const state = fixture();
      const server = serverFixture(state, (rpc) => { if (rpc === "get_ops_sources") state.versions.find((version) => version.entity === entity)!.version++; });
      const response = await server.get(kind);
      assert.equal(response.status, 409);
      assert.doesNotMatch(await response.text(), /events|Synthetic|students/);
    }
    const state = fixture();
    const server = serverFixture(state, (rpc) => { if (rpc === "get_ops_sources") state.accounts[0]!.account_id = "changed-coordinator"; });
    assert.equal((await server.get(kind)).status, 409);
  });

  test(`${kind} literal current teacher source IDs survive provider display aliases`, async () => {
    const state = fixture();
    state.page = { ...state.page, events: [{ ...event, sourceTeacherLabel: "private provider alias" }] };
    const response = await serverFixture(state).get(kind);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.events[0].teacherId, "T1");
    assert.equal(data.events[0].identityPending, false);
    assert.equal(data.remainingAVA.length, 2);
    assert.doesNotMatch(JSON.stringify(data), /provider alias/);
  });

  test(`${kind} absent dated native AVA stays empty without replacing verified lessons`, async () => {
    const state = fixture();
    state.rows[1]!.payload = [{ ...teacher, availabilityWindows: [], availabilitySourceText: "private raw availability text" }];
    const response = await serverFixture(state).get(kind);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.events.length, 1);
    assert.deepEqual(data.remainingAVA, []);
    assert.deepEqual(data.availabilityStatus, [{ teacherId: "T1", reason: "no_current_availability" }]);
  });
  test(`${kind} sync metadata failures retain lessons and safe occupancy-subtracted green`, async () => {
    for (const failing of ["get_ops_sources", "get_jiaowubao_open_api_schedule_projection_target"]) {
      const server = serverFixture(fixture(), (rpc) => { if (rpc === failing) throw new Error("private synthetic diagnostic"); });
      const response = await server.get(kind);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.events.length, 1);
      assert.equal(data.events[0].students[0].studentId, "S1");
      assert.equal(data.remainingAVA.length, 2);
      assert.deepEqual(data.availabilityStatus, [{ teacherId: "T1", reason: "ready" }]);
      assert.equal(data.source.sync.state, failing === "get_ops_sources" ? "unknown" : "fresh");
      assert.doesNotMatch(JSON.stringify(data), /private|nativeApply|sourceParticipants/);
    }
  });

  test(`${kind} old receipts and teacher versions no longer gate complete snapshot subtraction`, async () => {
    const mutations: ((state: ServerFixture) => void)[] = [
      (state) => { state.sources = []; },
      (state) => { state.target.projectionState = "pending"; },
      (state) => { state.target.publishedAt = "2026-10-12T00:00:00.123457+00:00"; },
      (state) => { state.versions.find(({ entity }) => entity === "courses")!.version = 2; },
      (state) => { state.versions = state.versions.filter(({ entity }) => entity !== "courses"); },
      (state) => { state.now += 76 * 60_000; },
      (state) => { state.page = { ...state.page, state: "stale", freshness: "stale" }; },
      (state) => { state.sources[0]!.payload.coverage.nativeRecordsSynchronized = false; },
    ];
    for (const mutate of mutations) {
      const state = fixture();
      mutate(state);
      const response = await serverFixture(state).get(kind);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.events.length, 1);
      assert.equal(data.remainingAVA.length, 2);
      assert.equal(data.availabilityStatus[0].reason, "ready");
      for (const free of data.remainingAVA) assert.ok(Date.parse(free.endsAt) <= Date.parse(data.events[0].startsAt) || Date.parse(free.startsAt) >= Date.parse(data.events[0].endsAt));
    }
  });

  test(`${kind} runtime identity never falls back from unknown source IDs to unique names`, async () => {
    const state = fixture();
    state.page = { ...state.page, events: [{ ...event, sourceTeacherId: "unknown-source", sourceParticipants: [{ memberId: null, label: student.name }] }] };
    const response = await serverFixture(state).get(kind);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.events[0].teacherId, null);
    assert.equal(data.events[0].teacherName, null);
    assert.deepEqual(data.events[0].students, []);
    assert.equal(data.events[0].startsAt, "2026-10-12T02:00:00.123Z");
    assert.equal(data.events[0].identityPending, true);
    assert.deepEqual(data.remainingAVA, []);
  });

  test(`${kind} archived student collisions remain ambiguous before activity filtering`, async () => {
    const state = fixture();
    state.rows[0]!.payload = [student, { ...student, id: "S2", importArchived: true, owner: "Ella" }];
    const response = await serverFixture(state).get(kind);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.events[0].students, []);
    assert.equal(data.events[0].identityPending, true);
    assert.equal(data.events[0].teacherId, "T1");
  });

  test(`${kind} consistency keys cover one stable publication rather than request windows or clock`, async () => {
    const state = fixture();
    const server = serverFixture(state);
    const first = await (await server.get(kind)).json();
    state.now += 1000;
    state.accounts.reverse();
    const second = await (await server.get(kind, { start: "2026-10-19T01:00:00.000Z", end: "2026-10-19T06:00:00.000Z" })).json();
    assert.equal(first.consistencyKey, second.consistencyKey);
    assert.deepEqual(first.source, second.source);
    state.versions.find(({ entity }) => entity === "courses")!.version = 2;
    const nativeChanged = await (await server.get(kind)).json();
    assert.notEqual(nativeChanged.consistencyKey, first.consistencyKey);
    state.versions.find(({ entity }) => entity === "courses")!.version = 1;
    state.accounts[0]!.account_id = "changed-coordinator";
    const ownerChanged = await (await server.get(kind)).json();
    assert.notEqual(ownerChanged.consistencyKey, first.consistencyKey);
    state.page = { ...state.page, publishedAt: "2026-10-12T00:00:00.123457+00:00" };
    const publishedChanged = await (await server.get(kind)).json();
    assert.notEqual(publishedChanged.consistencyKey, ownerChanged.consistencyKey);
  });

  test(`${kind} collector failures never authorize partial captures or start health reads`, async () => {
    const state = fixture();
    state.page = { ...state.page, events: Array.from({ length: 251 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}` })) };
    const server = serverFixture(state, (rpc, body) => {
      if (rpc === "get_jiaowubao_open_api_schedule_snapshot_window" && body.p_cursor_start !== null) throw new Error("private later page");
    });
    const response = await server.get(kind);
    assert.equal(response.status, 503);
    assert.equal(server.calls.filter(({ rpc }) => rpc === "get_jiaowubao_open_api_schedule_snapshot_window").length, 2);
    assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_sources").length, 0);
    assert.doesNotMatch(await response.text(), /events|students|private|event-000/);
  });
}

test("human scoped DTOs subtract hidden native occupancies from full unfiltered rows", async () => {
  const state = fixture();
  state.session = { user: "Tiffany", role: "staff", permissions: ["operations.read"], scopeMembers: [{ kind: "teacher", key: "T1" }] };
  state.fullAdmin = false;
  state.rows[0]!.payload = [student, { ...student, id: "S2", name: "private hidden student", owner: "Ella", teacher: "Other Teacher", jwbSourceRow: "102" }];
  state.rows[1]!.payload = [teacher, { ...teacher, id: "T2", name: "Other Teacher", jiaowubaoOpenApi: { ...teacher.jiaowubaoOpenApi, sourceId: "902" }, availabilityWindows: [] }];
  state.rows[2]!.payload = [{ id: "B1", studentId: "S2", teacherId: "T1", date: "2026-10-12", start: "04:00", duration: 60, timezone: "UTC", recurring: false }];
  const response = await serverFixture(state).get("human");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.teachers, [{ id: "T1", name: "Synthetic Teacher" }]);
  assert.deepEqual(data.remainingAVA.map(({ startsAt, endsAt }: { startsAt: string; endsAt: string }) => [startsAt, endsAt]), [
    [window.start, "2026-10-12T02:00:00.123Z"], ["2026-10-12T03:00:00.124Z", "2026-10-12T04:00:00.000Z"], ["2026-10-12T05:00:00.000Z", window.end],
  ]);
  assert.doesNotMatch(JSON.stringify(data), /S2|T2|Other Teacher|hidden student/);
});

test("out-of-scope teacher source collisions cannot look unique inside a staff scope", async () => {
  const state = fixture();
  state.session = { user: "Tiffany", role: "staff", permissions: ["operations.read"], scopeMembers: [{ kind: "teacher", key: "T1" }] };
  state.fullAdmin = false;
  state.rows[1]!.payload = [teacher, { ...teacher, id: "T2", name: "private hidden teacher", availabilityWindows: [] }];
  const response = await serverFixture(state).get("human");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.events[0].teacherId, null);
  assert.deepEqual(data.remainingAVA, []);
  assert.deepEqual(data.teachers, [{ id: "T1", name: "Synthetic Teacher" }]);
});

test("human permission revocation during health reading stops the next getter", async () => {
  const state = fixture();
  const server = serverFixture(state, (rpc) => { if (rpc === "get_ops_sources") state.session = { ...state.session, permissions: [] }; });
  const response = await server.get("human");
  assert.equal(response.status, 409);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_jiaowubao_open_api_schedule_projection_target").length, 0);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_versions").length, 0);
  assert.doesNotMatch(await response.text(), /events|students|Synthetic/);
});

test("machine revocation hidden behind a failing health getter stops further reads", async () => {
  const server = serverFixture(fixture(), (rpc, _body, environment) => {
    if (rpc === "get_ops_sources") { environment.AVA_CALENDAR_SERVICE_TOKEN_SHA256 = ""; throw new Error("private synthetic diagnostic"); }
  });
  const response = await server.get("machine");
  assert.equal(response.status, 503);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_jiaowubao_open_api_schedule_projection_target").length, 0);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_versions").length, 0);
  assert.doesNotMatch(await response.text(), /events|students|private/);
});

test("existing live client accepts the actual scoped multi-slice server consistency DTO", async () => {
  const state = fixture();
  const server = serverFixture(state);
  let requests = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    const url = new URL(String(input), "https://example.test");
    requests++;
    state.now += 1000;
    return server.get("human", { start: url.searchParams.get("start")!, end: url.searchParams.get("end")! });
  };
  const data = await fetchAvaCalendarWindow({ start: window.start, end: "2026-10-27T01:00:00.000Z" }, new AbortController().signal, fetchImpl);
  assert.equal(requests, 2);
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0]!.students[0]!.owner, "Tiffany");
  assert.equal(data.remainingAVA.length, 4);
  assert.deepEqual(data.teachers, [{ id: "T1", name: "Synthetic Teacher" }]);
});

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("parallel metadata revocation remains isolated from another machine and human GET", async () => {
  const entered = Array.from({ length: 3 }, latch);
  const resume = latch();
  const revoked = serverFixture(fixture(), async (rpc, _body, environment) => {
    if (rpc === "get_ops_sources") { entered[0]!.release(); await resume.promise; environment.AVA_CALENDAR_SERVICE_TOKEN_SHA256 = ""; }
  });
  const valid = serverFixture(fixture(), async (rpc) => { if (rpc === "get_ops_sources") { entered[1]!.release(); await resume.promise; } });
  const human = serverFixture(fixture(), async (rpc) => { if (rpc === "get_ops_sources") { entered[2]!.release(); await resume.promise; } });
  const pending = [revoked.get("machine"), valid.get("machine"), human.get("human")];
  await Promise.all(entered.map(({ promise }) => promise));
  resume.release();
  const [denied, allowed, cookie] = await Promise.all(pending);
  assert.equal(denied!.status, 503);
  assert.equal(allowed!.status, 200);
  assert.equal(cookie!.status, 200);
  assert.equal((await allowed!.json()).remainingAVA.length, 2);
  assert.equal((await cookie!.json()).remainingAVA.length, 2);
  assert.equal(revoked.calls.filter(({ rpc }) => rpc === "get_jiaowubao_open_api_schedule_projection_target").length, 0);
});
