import assert from "node:assert/strict";
import test from "node:test";
import * as service from "../lib/ava-calendar-service";
import * as live from "../lib/ava-calendar-live-client";
import type { AvaCalendarDependencies } from "../lib/ava-calendar-service";
import { fixture, serverFixture, event } from "./ava-calendar-server-fixture";

const range = { start: "2026-09-27T14:00:00.000Z", end: "2026-11-08T13:00:00.000Z" };

function setup(hook: (stage: string) => void = () => {}) {
  const state = fixture();
  const reads: string[] = [];
  const composition = service.createAvaCalendarRouteComposition(async (window, fetchPage) => {
    const { readAvaCalendarSnapshot } = await import("../lib/ava-calendar-snapshot");
    return readAvaCalendarSnapshot(window, fetchPage);
  }, {
    getOpsSources: async () => { reads.push("sources"); hook("sources"); return state.sources.map((source) => ({ ...source, title: "Synthetic schedule", source_type: "synthetic", url: null, modified_at: null })); },
    getJiaowubaoOpenApiScheduleSnapshotWindow: async (input) => {
      reads.push("page"); hook("page");
      const start = new Date(Date.parse(input.windowStart) + 3_600_000).toISOString();
      return { ...state.page, events: [{ ...event, eventId: `e-${reads.filter((x) => x === "page").length}`, startsAt: start, endsAt: new Date(Date.parse(start) + 3_600_000).toISOString(), sourceDate: start.slice(0, 10) }] };
    },
  }, state.now + 45_000, () => state.now);
  const dependencies: AvaCalendarDependencies = {
    ...composition,
    readSession: async () => { reads.push("session"); hook("session"); return { session: structuredClone(state.session), fullAdmin: state.fullAdmin }; },
    readRows: async () => { reads.push("rows"); hook("rows"); return structuredClone(state.rows); },
    readVersions: async () => { reads.push("versions"); hook("versions"); return structuredClone(state.versions); },
    readAccounts: async () => { reads.push("accounts"); hook("accounts"); return structuredClone(state.accounts); },
    strictSourceIdentity: true,
  };
  return { state, reads, dependencies };
}

test("actual range GET reuses one complete old-reader snapshot across five bounded source windows", async () => {
  const server = serverFixture(fixture(), undefined, true);
  const response = await server.getRange(range);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.slices.length, 5);
  assert.equal(data.slices.flatMap((slice: { events: unknown[] }) => slice.events).length, 1);
  const reads = server.calls.filter(({ rpc }) => rpc === "get_ops_state");
  assert.equal(reads.length, 1);
  assert.deepEqual(Object.keys(reads[0]!.body).sort(), ["p_entities", "p_secret"]);
  assert.deepEqual(reads[0]!.body.p_entities, ["students", "teachers", "bookings", "lpItems"]);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_jiaowubao_open_api_schedule_snapshot_window").length, 5);
});

test("actual range GET keeps the 45s route budget and never publishes a completed prefix", async () => {
  const state = fixture();
  const server = serverFixture(state, (rpc) => { if (rpc === "get_jiaowubao_open_api_schedule_snapshot_window") state.now += 45_001; }, true);
  const response = await server.getRange(range);
  assert.equal(response.status, 503);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_versions").length, 0);
  assert.doesNotMatch(await response.text(), /events|students|Synthetic/);
});

for (const role of ["teacher", "staff"] as const) {
  test(`actual range GET retains ${role} scope without exposing another teacher's courses`, async () => {
    const state = fixture();
    state.fullAdmin = false;
    state.session = { user: role === "teacher" ? "Synthetic Teacher" : "Tiffany", role, permissions: ["operations.read"], scopeMembers: [{ kind: "teacher", key: "T1" }] };
    const originalStudent = (state.rows.find(({ entity }) => entity === "students")!.payload as Record<string, unknown>[])[0]!;
    const originalTeacher = (state.rows.find(({ entity }) => entity === "teachers")!.payload as Record<string, unknown>[])[0]!;
    state.rows.find(({ entity }) => entity === "students")!.payload = [originalStudent, { ...originalStudent, id: "hidden-S2", name: "hidden student", owner: "Ella", teacher: "hidden teacher", jwbSourceRow: "102" }];
    state.rows.find(({ entity }) => entity === "teachers")!.payload = [originalTeacher, { ...originalTeacher, id: "hidden-T2", name: "hidden teacher", jiaowubaoOpenApi: { sourceId: "902", resolution: "stable_source_id", confidence: "exact" }, availabilityWindows: [] }];
    state.page = { ...state.page, events: [event, { ...event, eventId: "hidden-course", sourceTeacherId: "902", sourceParticipants: [{ memberId: "102", label: "hidden student" }] }] };
    const server = serverFixture(state, undefined, true);
    const response = await server.getRange(range);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.slices.flatMap((slice: { events: unknown[] }) => slice.events).length, 1);
    assert.doesNotMatch(JSON.stringify(data), /hidden-course|hidden-S2|hidden-T2|hidden student|hidden teacher/);
  });
}

test("month reads one complete native snapshot and preserves all five sequential source windows", async () => {
  assert.equal(typeof service.createAvaCalendarRangeHandler, "function");
  assert.equal(typeof live.fetchAvaCalendarRange, "function");
  const f = setup();
  const handler = service.createAvaCalendarRangeHandler(f.dependencies);
  let calls = 0;
  const result = await live.fetchAvaCalendarRange(range, new AbortController().signal, async (input, init) => {
    calls++;
    assert.match(String(input), /^\/api\/ava-calendar\/range\?/);
    return handler(new Request(`https://synthetic.invalid${String(input)}`, init));
  });
  assert.equal(calls, 1);
  assert.equal(result.events.length, 5);
  assert.equal(new Set(result.events.map(({ eventId }) => eventId)).size, 5);
  for (const stage of ["rows", "versions", "sources"]) assert.equal(f.reads.filter((x) => x === stage).length, 1, stage);
  assert.equal(f.reads.filter((x) => x === "accounts").length, 2);
  assert.equal(f.reads.filter((x) => x === "page").length, 5);
});

for (const boundary of ["rows", "page", "sources"] as const) {
  test(`range revocation at ${boundary} stops subsequent data getters and exposes no partial courses`, async () => {
    const f = setup((stage) => { if (stage === boundary) f.state.session = { ...f.state.session, permissions: [] }; });
    const response = await service.createAvaCalendarRangeHandler(f.dependencies)(new Request(`https://synthetic.invalid/api/ava-calendar/range?${new URLSearchParams(range)}`));
    assert.equal(response.status, 409);
    assert.doesNotMatch(await response.text(), /events|Synthetic|students|sourceParticipants/);
    const last = f.reads.lastIndexOf(boundary);
    assert.deepEqual(f.reads.slice(last + 1).filter((x) => x !== "session"), []);
  });
}

const sourceChanges: Record<string, (state: ReturnType<typeof fixture>) => void> = {
  revision: (state) => { state.page = { ...state.page, revision: `sha256:${"b".repeat(64)}` }; },
  publication: (state) => { state.page = { ...state.page, publishedAt: "2026-10-12T00:00:01Z" }; },
  sourceWindow: (state) => { state.page = { ...state.page, sourceWindow: { start: "2026-09-01", end: "2026-12-01" } }; },
};
for (const drift of ["students", "teachers", "bookings", "lpItems", "accounts", "revision", "publication", "sourceWindow"]) {
  test(`range ${drift} drift discards the whole stable native capture`, async () => {
    const mutation = sourceChanges[drift];
    const f = setup((stage) => {
      if (mutation && stage === "page" && f.reads.filter((x) => x === "page").length === 2) mutation(f.state);
      if (stage === "sources" && !mutation) {
        if (drift === "accounts") f.state.accounts[0]!.status = "disabled" as "active";
        else f.state.versions.find(({ entity }) => entity === drift)!.version++;
      }
    });
    const response = await service.createAvaCalendarRangeHandler(f.dependencies)(new Request(`https://synthetic.invalid/api/ava-calendar/range?${new URLSearchParams(range)}`));
    assert.equal(response.status, 409);
    assert.doesNotMatch(await response.text(), /events|Synthetic|students/);
  });
}

test("range rejects invalid windows and anonymous readers before native getters", async () => {
  const f = setup();
  const handler = service.createAvaCalendarRangeHandler(f.dependencies);
  for (const query of ["start=bad&end=bad", "start=2026-01-01T00:00:00Z&end=2026-12-31T00:00:00Z", `${new URLSearchParams(range)}&scope=all`, `${new URLSearchParams(range)}&start=bad`]) {
    assert.equal((await handler(new Request(`https://synthetic.invalid/api/ava-calendar/range?${query}`))).status, 400);
  }
  assert.equal(f.reads.filter((x) => x !== "session").length, 0);
  const denied = service.createAvaCalendarRangeHandler({ ...f.dependencies, readSession: async () => ({ error: "请先登录。", status: 401 }) });
  assert.equal((await denied(new Request(`https://synthetic.invalid/api/ava-calendar/range?${new URLSearchParams(range)}`))).status, 401);
});

test("range decoder rejects short envelopes, malformed JSON and late aborts without publishing partial courses", async () => {
  for (const body of ["{broken", JSON.stringify({ slices: [] }), JSON.stringify({ slices: Array(5).fill({}) })]) {
    await assert.rejects(() => live.fetchAvaCalendarRange(range, new AbortController().signal, async () => new Response(body)), /课表暂时无法读取/);
  }
  const abort = new AbortController();
  await assert.rejects(() => live.fetchAvaCalendarRange(range, abort.signal, async () => { abort.abort(); return Response.json({ slices: [] }); }), { name: "AbortError" });
});

test("range transport retries a changed publication once as a whole, not with partial native caches", async () => {
  let calls = 0;
  const f = setup();
  const handler = service.createAvaCalendarRangeHandler(f.dependencies);
  const data = await live.fetchAvaCalendarRange(range, new AbortController().signal, async (input, init) => ++calls === 1 ? Response.json({}, { status: 409 }) : handler(new Request(`https://synthetic.invalid${String(input)}`, init)));
  assert.equal(calls, 2);
  assert.equal(data.events.length, 5);
  assert.equal(f.reads.filter((x) => x === "rows").length, 1);
});
