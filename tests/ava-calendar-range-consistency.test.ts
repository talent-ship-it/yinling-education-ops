import assert from "node:assert/strict";
import test from "node:test";
import { fixture, serverFixture, event } from "./ava-calendar-server-fixture";
import { fetchAvaCalendarRange, fetchAvaCalendarWindow } from "../lib/ava-calendar-live-client";
import { readAvaCalendarSnapshot } from "../lib/ava-calendar-snapshot";
import { createAvaCalendarRangeHandler, type AvaCalendarDependencies } from "../lib/ava-calendar-service";

const range = { start: "2026-09-27T14:00:00.000Z", end: "2026-11-08T13:00:00.000Z" };
function setup() {
  const state = fixture();
  state.now = Date.parse("2026-10-12T00:00:01Z");
  state.page = { ...state.page, sourceWindow: { start: "2026-09-01", end: "2026-11-30" } };
  return state;
}
function bridge(server: ReturnType<typeof serverFixture>, kind: "range" | "sequential"): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input), "https://synthetic.invalid");
    const window = { start: url.searchParams.get("start")!, end: url.searchParams.get("end")! };
    return kind === "range" ? server.getRange(window, init) : server.get("human", window, init);
  };
}

test("257 actual route events across pages equal the legacy five-request complete result", async () => {
  const state = setup();
  state.page = { ...state.page, events: Array.from({ length: 257 }, (_, index) => {
    const startsAt = new Date(Date.parse("2026-10-12T02:00:00Z") + index * 1000).toISOString();
    return { ...event, eventId: `batch-${String(index).padStart(4, "0")}`, sourceDate: "2026-10-12", startsAt, endsAt: new Date(Date.parse(startsAt) + 60000).toISOString() };
  }) };
  const current = serverFixture(structuredClone(state), undefined, true);
  const legacy = serverFixture(structuredClone(state), undefined, true);
  const result = await fetchAvaCalendarRange(range, new AbortController().signal, bridge(current, "range"));
  const original = await fetchAvaCalendarWindow(range, new AbortController().signal, bridge(legacy, "sequential"));
  assert.deepEqual(result, original);
  assert.equal(result.events.length, 257);
  assert.equal(new Set(result.events.map(({ eventId }) => eventId)).size, 257);
  assert.ok(result.remainingAVA.length > 0);
  assert.equal(current.calls.filter(({ rpc }) => rpc === "get_jiaowubao_open_api_schedule_snapshot_window").length, 6);
  assert.equal(current.calls.filter(({ rpc }) => rpc === "get_ops_state").length, 1);
  assert.equal(legacy.calls.filter(({ rpc }) => rpc === "get_ops_state").length, 5);
});

test("complete native bookings retain moved occupancy in a later slice", async () => {
  const state = setup();
  state.rows.find(({ entity }) => entity === "bookings")!.payload = [{ id: "B-cross", date: "2026-09-28", start: "02:00", timezone: "UTC", duration: 60, teacherId: "T1", studentId: "S1", status: "confirmed", recurring: false, occurrenceOverrides: [{ occurrenceId: "B-cross:2026-09-28", date: "2026-10-19", start: "02:00", durationMinutes: 60, teacherId: "T1" }], arbitraryPreservedField: { nested: [1, "完整"] } }];
  state.page = { ...state.page, events: [] };
  const server = serverFixture(state, undefined, true);
  const result = await fetchAvaCalendarRange(range, new AbortController().signal, bridge(server, "range"));
  const day = result.remainingAVA.filter(({ teacherId, startsAt }) => teacherId === "T1" && startsAt.startsWith("2026-10-19"));
  assert.ok(day.length > 0);
  assert.ok(day.every(({ startsAt, endsAt }) => Date.parse(endsAt) <= Date.parse("2026-10-19T02:00:00Z") || Date.parse(startsAt) >= Date.parse("2026-10-19T03:00:00Z")));
});

test("revoked and valid ranges, machine and unscoped reads stay isolated", async () => {
  const state = setup();
  const revoked = serverFixture(state, (rpc) => { if (rpc === "get_ops_state") state.session = { ...state.session, permissions: [] }; }, true);
  const valid = serverFixture(setup(), undefined, true);
  const machine = serverFixture(setup(), undefined, true);
  const [denied, allowed, service, unscoped] = await Promise.all([
    revoked.getRange(range), valid.getRange(range), machine.get("machine"),
    readAvaCalendarSnapshot({ start: "2026-10-12T01:00:00Z", end: "2026-10-12T06:00:00Z" }, async () => structuredClone(setup().page)),
  ]);
  assert.equal(denied.status, 409);
  assert.equal(allowed.status, 200);
  assert.equal(service.status, 200);
  assert.equal(unscoped.events.length, 1);
  assert.equal(revoked.calls.filter(({ rpc }) => !["read_account_session", "get_ops_state"].includes(rpc)).length, 0);
  assert.doesNotMatch(await denied.text(), /events|students|Synthetic|remainingAVA/);
  assert.equal((await valid.getRange(range)).status, 200);
});

test("final session revocation returns no DTO and never trusts an earlier grant", async () => {
  let sessions = 0;
  const server = serverFixture(setup(), (rpc) => { if (rpc === "read_account_session" && ++sessions === 18) return Response.json([]); }, true);
  const response = await server.getRange(range);
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /events|Synthetic|students|remainingAVA/);
  assert.equal(sessions, 18);
});

test("a subsequent request rereads native state and sees the new version", async () => {
  const state = setup();
  const server = serverFixture(state, undefined, true);
  const first = await server.getRange(range);
  assert.equal(first.status, 200);
  const before = await first.json();
  state.rows.find(({ entity }) => entity === "bookings")!.version++;
  state.versions.find(({ entity }) => entity === "bookings")!.version++;
  const second = await server.getRange(range);
  assert.equal(second.status, 200);
  const after = await second.json();
  assert.notEqual(before.slices[0].consistencyKey, after.slices[0].consistencyKey);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_state").length, 2);
});

for (const failingRpc of ["get_ops_state", "get_jiaowubao_open_api_schedule_snapshot_window"]) {
  test(`old-reader or source 57014 at ${failingRpc} fails closed without green`, async () => {
    const server = serverFixture(setup(), (rpc) => rpc === failingRpc ? Response.json({ code: "57014", message: "synthetic statement timeout" }, { status: 500 }) : undefined, true);
    const response = await server.getRange(range);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /events|students|remainingAVA|Synthetic/);
    assert.ok(server.warnings.some((warning) => JSON.parse(warning).code === "57014"));
  });
}

test("an already cancelled range starts no native getter", async () => {
  const abort = new AbortController();
  abort.abort();
  const server = serverFixture(setup(), undefined, true);
  const response = await server.getRange(range, { signal: abort.signal });
  assert.equal(response.status, 503);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_state").length, 0);
});

test("revocation in the initial authorization microtask prevents the first native read", async () => {
  const state = setup();
  let revoked = false;
  let nativeReads = 0;
  const dependencies: AvaCalendarDependencies = {
    readSession: async () => {
      if (revoked) return { error: "synthetic revoked session", status: 401 };
      queueMicrotask(() => { revoked = true; });
      return { session: structuredClone(state.session), fullAdmin: state.fullAdmin };
    },
    readRows: async () => { nativeReads++; return state.rows; },
    readVersions: async () => state.versions,
    readAccounts: async () => state.accounts,
    readSnapshot: async () => assert.fail("unauthorized source getter"),
  };
  const response = await createAvaCalendarRangeHandler(dependencies)(new Request(`https://synthetic.invalid/api/ava-calendar/range?${new URLSearchParams(range)}`));
  assert.equal(response.status, 401);
  assert.equal(nativeReads, 0);
  assert.doesNotMatch(await response.text(), /events|students|remainingAVA/);
});

test("revocation queued after a full page stops the next pagination getter", async () => {
  const state = setup();
  state.page = { ...state.page, events: Array.from({ length: 251 }, (_, index) => ({ ...event, eventId: `page-${String(index).padStart(3, "0")}` })) };
  let pages = 0;
  const server = serverFixture(state, (rpc) => {
    if (rpc === "get_jiaowubao_open_api_schedule_snapshot_window" && ++pages === 1) queueMicrotask(() => { state.session = { ...state.session, permissions: [] }; });
  }, true);
  const response = await server.getRange({ start: "2026-10-12T01:00:00Z", end: "2026-10-12T06:00:00Z" });
  assert.equal(response.status, 409);
  assert.equal(pages, 1);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_sources").length, 0);
  assert.doesNotMatch(await response.text(), /events|students|remainingAVA|Synthetic/);
});
