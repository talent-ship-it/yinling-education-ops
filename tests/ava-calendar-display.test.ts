import assert from "node:assert/strict";
import test from "node:test";
import { fixture, serverFixture, window } from "./ava-calendar-server-fixture";
import { fetchAvaCalendarWindow } from "../lib/ava-calendar-live-client";

test("current native AVA renders after teacherVersion changes independently of old apply/final receipts", async () => {
  const state = fixture();
  state.sources[0]!.payload.nativeApply.projectionRunId = "another-apply-run";
  state.rows[1]!.version++;
  state.versions.find(({ entity }) => entity === "teachers")!.version++;
  state.target.projectionState = "pending";
  const server = serverFixture(state);
  const response = await server.get("human");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.remainingAVA.length, 2, "self edits must not wait for native apply");
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_jiaowubao_open_api_schedule_projection_target").length, 0);
});

test("stable unique source teacher IDs do not require a new native apply for every snapshot revision", async () => {
  const state = fixture();
  const teacher = (state.rows[1]!.payload as Record<string, unknown>[])[0]!;
  teacher.jiaowubaoOpenApi = { ...(teacher.jiaowubaoOpenApi as Record<string, unknown>), snapshotRevision: `sha256:${"b".repeat(64)}` };
  const data = await (await serverFixture(state).get("human")).json();
  assert.equal(data.events[0].teacherId, "T1");
  assert.equal(data.remainingAVA.length, 2);
});

test("stale snapshot remains usable with a 90-minute warning and exact last successful sync", async () => {
  const state = fixture();
  state.page = { ...state.page, state: "stale", freshness: "stale" };
  const server = serverFixture(state);
  const fetchImpl: typeof fetch = async () => server.get("human");
  const data = await fetchAvaCalendarWindow(window, new AbortController().signal, fetchImpl);
  assert.equal(data.remainingAVA.length, 2);
  assert.deepEqual(data.sync, { state: "stale", lastSuccessAt: "2026-10-12T00:00:00.000Z", staleAfterMinutes: 90 });
});

test("freshness changes at exactly 90 minutes and failed sync is advisory", async () => {
  const state = fixture();
  const server = serverFixture(state);
  state.now += 90 * 60000 - 1;
  assert.equal((await (await server.get("human")).json()).source.sync.state, "fresh");
  state.now++;
  assert.equal((await (await server.get("human")).json()).source.sync.state, "stale");
  state.now -= 90 * 60000;
  state.sources[0]!.status = "failed";
  const failed = await (await server.get("human")).json();
  assert.equal(failed.source.sync.state, "sync_failed");
  assert.equal(failed.remainingAVA.length, 2);
});

test("multi-slice display keeps the worst freshness warning instead of trusting only the first slice", async () => {
  const state = fixture();
  const server = serverFixture(state);
  let reads = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (reads++ > 0) state.page = { ...state.page, state: "stale", freshness: "stale" };
    const url = new URL(String(input), "https://synthetic.test");
    return server.get("human", { start: url.searchParams.get("start")!, end: url.searchParams.get("end")! });
  };
  const data = await fetchAvaCalendarWindow({ ...window, end: "2026-10-27T06:00:00.000Z" }, new AbortController().signal, fetchImpl);
  assert.ok(data.remainingAVA.length > 0);
  assert.equal(data.sync?.state, "stale");
});

test("a stale snapshot still warns about age when sync metadata is unavailable", async () => {
  const state = fixture();
  state.page = { ...state.page, state: "stale", freshness: "stale" };
  const server = serverFixture(state, (rpc) => { if (rpc === "get_ops_sources") throw new Error("synthetic metadata outage"); });
  const data = await (await server.get("human")).json();
  assert.equal(data.source.sync.state, "stale");
  assert.equal(data.remainingAVA.length, 2);
});

test("sync metadata failure does not become an occupancy failure or expose private receipts", async () => {
  const server = serverFixture(fixture(), (rpc) => { if (rpc === "get_ops_sources") throw new Error("private fixture failure"); });
  const data = await (await server.get("human")).json();
  assert.equal(data.remainingAVA.length, 2);
  assert.equal(data.source.sync.state, "unknown");
  assert.equal(data.source.sync.lastSuccessAt, "2026-10-12T00:00:00.123Z");
  assert.doesNotMatch(JSON.stringify(data), /private|nativeApply|projectionRunId/);
});
