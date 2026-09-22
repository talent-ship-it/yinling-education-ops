import assert from "node:assert/strict";
import test from "node:test";
import { collectJiaowubaoScheduleHorizon, jiaowubaoScheduleCollectionWindows, buildJiaowubaoScheduleSnapshotEnvelope } from "../lib/jiaowubao-open-api-schedule-snapshot";
import { jiaowubaoTrialProjectionWindow } from "../lib/jiaowubao-trial-auto-sync-core";

const horizon = { start: "2026-09-22", end: "2026-12-23" };

test("93-day horizon uses three adjacent valid source/projection windows, including day 60", () => {
  const windows = jiaowubaoScheduleCollectionWindows(horizon);
  assert.deepEqual(windows, [
    { start: "2026-09-22", end: "2026-10-22" },
    { start: "2026-10-23", end: "2026-11-22" },
    { start: "2026-11-23", end: "2026-12-23" },
  ]);
  for (const part of windows) assert.doesNotThrow(() => jiaowubaoTrialProjectionWindow(part));
  const instants = windows.map(jiaowubaoTrialProjectionWindow);
  assert.equal(instants[0].endsAt, instants[1].startsAt);
  assert.equal(instants[1].endsAt, instants[2].startsAt);
  assert.throws(() => jiaowubaoScheduleCollectionWindows({ ...horizon, end: "2026-12-24" }));
});

test("partial source pages are repacked into exact publication chunks and retain distant lessons", async () => {
  let batch = 0;
  const snapshot = await collectJiaowubaoScheduleHorizon(horizon, async (query) => {
    assert.equal(query.page, 1);
    const prefix = ++batch;
    return { lists: Array.from({ length: 60 }, (_, index) => ({ cal_id: prefix * 1000 + index, dated: query.start, type: 1 })) };
  });
  assert.equal(batch, 3);
  assert.deepEqual(snapshot.pages.map((page) => page.records.length), [100, 80]);
  assert.equal(snapshot.manifest.recordCount, 180);
  const envelope = buildJiaowubaoScheduleSnapshotEnvelope(snapshot, null);
  assert.equal(envelope.expectedPageCount, 2);
  assert.equal(envelope.query.end, horizon.end);
  assert.ok(snapshot.pages.flatMap((page) => page.records).some((record) => record.cal_id === "3000"));
});

test("a missing later window or duplicate lesson prevents publishing partial coverage", async () => {
  let calls = 0;
  await assert.rejects(collectJiaowubaoScheduleHorizon(horizon, async () => {
    if (++calls === 2) throw new Error("upstream unavailable");
    return { lists: [{ cal_id: 1 }] };
  }), /upstream unavailable/);
  await assert.rejects(collectJiaowubaoScheduleHorizon(horizon, async () => ({ lists: [{ cal_id: 1 }] })), /重复排课/);
});

test("source-call budget is shared across windows, including terminal empty pages", async () => {
  let calls = 0;
  await assert.rejects(collectJiaowubaoScheduleHorizon(horizon, async (query) => {
    calls++;
    const window = query.start === horizon.start ? 1 : 2;
    if (query.page === 40) return { lists: [] };
    return { lists: Array.from({ length: 100 }, (_, index) => ({ cal_id: window * 100000 + query.page! * 100 + index })) };
  }), /本轮请求上限/);
  assert.equal(calls, 60);
});
