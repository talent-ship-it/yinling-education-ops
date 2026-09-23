import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJiaowubaoScheduleSnapshotEnvelope,
  collectJiaowubaoScheduleHorizon,
  jiaowubaoScheduleCollectionWindows,
  jiaowubaoScheduleSnapshotSourceKey,
} from "../lib/jiaowubao-open-api-schedule-snapshot";
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
  let calls = 0;
  const prefixByWindow = new Map([
    ["2026-09-22", 1],
    ["2026-10-23", 2],
    ["2026-11-23", 3],
  ]);
  const snapshot = await collectJiaowubaoScheduleHorizon(horizon, async (query) => {
    calls++;
    assert.equal(query.page, 1);
    const prefix = prefixByWindow.get(query.start)!;
    return { lists: Array.from({ length: 60 }, (_, index) => ({ cal_id: prefix * 1000 + index, dated: query.start, type: 1 })) };
  }, null);
  assert.equal(calls, 3);
  assert.deepEqual(snapshot.pages.map((page) => page.records.length), [100, 80]);
  assert.equal(snapshot.manifest.recordCount, 180);
  const envelope = buildJiaowubaoScheduleSnapshotEnvelope(snapshot, null);
  assert.equal(envelope.expectedPageCount, 2);
  assert.equal(envelope.query.end, horizon.end);
  assert.ok(snapshot.pages.flatMap((page) => page.records).some((record) => record.cal_id === "3000"));
});

test("a page shift cannot turn a one-scan omission into destructive absence", async () => {
  const ids = Array.from({ length: 101 }, (_, index) => index + 1);
  let calls = 0;
  const snapshot = await collectJiaowubaoScheduleHorizon(
    { start: "2026-09-22", end: "2026-09-22" },
    async ({ page = 1, limit = 100 }) => {
      calls++;
      const visible = calls === 1 ? ids : ids.slice(1);
      const start = (page - 1) * limit;
      return { lists: visible.slice(start, start + limit).map((cal_id) => ({ cal_id, dated: "2026-09-22" })) };
    },
    ids.map((calId) => ({ sourceKey: jiaowubaoScheduleSnapshotSourceKey(calId), sourceDate: "2026-09-22" })),
  );
  const captured = snapshot.pages.flatMap((page) => page.records).map((record) => Number(record.cal_id));
  assert.equal(calls, 4);
  assert.equal(captured.length, 101);
  assert.deepEqual(captured, ids);
});

test("an event moving into an already-read window is recovered by the independent scan", async () => {
  let eventDate = "2026-10-23";
  let calls = 0;
  const snapshot = await collectJiaowubaoScheduleHorizon(horizon, async (query) => {
    calls++;
    const rows = eventDate >= query.start && eventDate <= query.end
      ? [{ cal_id: "moving-event", dated: eventDate, state: calls }]
      : [];
    if (calls === 1) eventDate = "2026-10-22";
    return { lists: rows };
  }, [{ sourceKey: jiaowubaoScheduleSnapshotSourceKey("moving-event"), sourceDate: "2026-10-23" }]);
  const captured = snapshot.pages.flatMap((page) => page.records);
  assert.equal(calls, 6);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].cal_id, "moving-event");
  assert.equal(captured[0].dated, "2026-10-22");
});

test("an event moving from outside the horizon into an already-read window is confirmed", async () => {
  let calls = 0;
  let movedIntoFirstWindow = false;
  const snapshot = await collectJiaowubaoScheduleHorizon(horizon, async (query) => {
    calls += 1;
    const rows = movedIntoFirstWindow && query.start === horizon.start
      ? [{ cal_id: "moved-from-expired-date", dated: horizon.start }]
      : [];
    if (calls === 1) movedIntoFirstWindow = true;
    return { lists: rows };
  }, [{
    sourceKey: jiaowubaoScheduleSnapshotSourceKey("moved-from-expired-date"),
    sourceDate: "2026-09-21",
  }]);
  const captured = snapshot.pages.flatMap((page) => page.records);
  assert.equal(calls, 6);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].dated, horizon.start);
});

test("the confirmation scan publishes additions and updates while retaining one-scan absences", async () => {
  let call = 0;
  const snapshot = await collectJiaowubaoScheduleHorizon(
    { start: "2026-09-22", end: "2026-09-22" },
    async () => ({ lists: ++call === 1
      ? [{ cal_id: "retained", version: 1 }, { cal_id: "updated", version: 1 }]
      : [{ cal_id: "updated", version: 2 }, { cal_id: "added", version: 1 }] }),
    ["retained", "updated", "deleted"].map((calId) => ({
      sourceKey: jiaowubaoScheduleSnapshotSourceKey(calId),
      sourceDate: "2026-09-22",
    })),
  );
  const byId = new Map(snapshot.pages.flatMap((page) => page.records).map((record) => [record.cal_id, record]));
  assert.equal(byId.get("retained")?.version, 1);
  assert.equal(byId.get("updated")?.version, 2);
  assert.equal(byId.get("added")?.version, 1);
  assert.equal(byId.has("deleted"), false);
});

test("a missing later window or duplicate lesson prevents publishing partial coverage", async () => {
  let calls = 0;
  await assert.rejects(collectJiaowubaoScheduleHorizon(horizon, async () => {
    if (++calls === 2) throw new Error("upstream unavailable");
    return { lists: [{ cal_id: 1 }] };
  }, null), /upstream unavailable/);
  await assert.rejects(collectJiaowubaoScheduleHorizon(
    horizon,
    async () => ({ lists: [{ cal_id: 1 }] }),
    null,
  ), /重复排课/);
});

test("source-call budget is shared across windows, including terminal empty pages", async () => {
  let calls = 0;
  await assert.rejects(collectJiaowubaoScheduleHorizon(horizon, async (query) => {
    calls++;
    const window = query.start === horizon.start ? 1 : 2;
    if (query.page === 40) return { lists: [] };
    return { lists: Array.from({ length: 100 }, (_, index) => ({ cal_id: window * 100000 + query.page! * 100 + index })) };
  }, null), /本轮请求上限/);
  assert.equal(calls, 66);
});

function rowsForStableWindow(query: Readonly<{ start: string; page?: number; limit?: number }>, extraFirstWindow = 0) {
  const windowIndex = jiaowubaoScheduleCollectionWindows(horizon).findIndex((part) => part.start === query.start);
  const size = 1_000 + (windowIndex === 0 ? extraFirstWindow : 0);
  const page = query.page ?? 1;
  const limit = query.limit ?? 100;
  return Array.from({ length: size }, (_, index) => ({
    cal_id: `stable-${windowIndex + 1}-${index + 1}`,
    dated: query.start,
  })).slice((page - 1) * limit, page * limit);
}

test("a stable 3000-row current horizon completes in one bounded scan", async () => {
  const identities = jiaowubaoScheduleCollectionWindows(horizon).flatMap((part, windowIndex) =>
    Array.from({ length: 1_000 }, (_, index) => ({
      sourceKey: jiaowubaoScheduleSnapshotSourceKey(`stable-${windowIndex + 1}-${index + 1}`),
      sourceDate: part.start,
    })));
  let calls = 0;
  const snapshot = await collectJiaowubaoScheduleHorizon(horizon, async (query) => {
    calls += 1;
    return { lists: rowsForStableWindow(query) };
  }, identities);
  assert.equal(calls, 33);
  assert.equal(snapshot.manifest.recordCount, 3_000);
  assert.equal(snapshot.manifest.pageCount, 30);
});

test("a destructive candidate can confirm a stable 3000-row horizon within 66 calls", async () => {
  let calls = 0;
  const snapshot = await collectJiaowubaoScheduleHorizon(horizon, async (query) => {
    calls += 1;
    return { lists: rowsForStableWindow(query) };
  }, [{ sourceKey: jiaowubaoScheduleSnapshotSourceKey("missing-current-row"), sourceDate: horizon.start }]);
  assert.equal(calls, 66);
  assert.equal(snapshot.manifest.recordCount, 3_000);
});

test("an invalid current source date forces a complete confirmation scan", async () => {
  let calls = 0;
  const snapshot = await collectJiaowubaoScheduleHorizon(
    { start: "2026-09-22", end: "2026-09-22" },
    async () => {
      calls += 1;
      return { lists: [] };
    },
    [{ sourceKey: jiaowubaoScheduleSnapshotSourceKey("invalid-date"), sourceDate: null }],
  );
  assert.equal(calls, 2);
  assert.equal(snapshot.manifest.recordCount, 0);
});

test("a 3001-row rolling horizon fails before publication", async () => {
  let calls = 0;
  await assert.rejects(collectJiaowubaoScheduleHorizon(horizon, async (query) => {
    calls += 1;
    return { lists: rowsForStableWindow(query, 1) };
  }, null), /滚动排课记录超过安全上限/);
  assert.equal(calls, 33);
});
