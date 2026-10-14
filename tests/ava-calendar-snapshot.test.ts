import assert from "node:assert/strict";
import test from "node:test";
import { readAvaCalendarSnapshot } from "../lib/ava-calendar-snapshot";
import type { JiaowubaoOpenApiScheduleSnapshotWindow } from "../lib/ops-store";

const revision = `sha256:${"a".repeat(64)}`;
const window = { start: "2026-10-11T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" };
const event: JiaowubaoOpenApiScheduleSnapshotWindow["events"][number] = {
  eventId: "event-1", sourceDate: "2026-10-11", startsAt: "2026-10-11T04:00:00.000Z", endsAt: "2026-10-11T05:00:00.000Z", courseName: null,
  sourceTeacherId: "900", sourceTeacherLabel: "Synthetic Teacher", sourceParticipants: [{ memberId: "101", label: "Synthetic One" }], sourceStudentsTruncated: false,
};
const page: JiaowubaoOpenApiScheduleSnapshotWindow = { state: "complete", events: [event], hasMore: false, nextCursor: null, invalidTimeEventCount: 0, revision, publishedAt: "2026-10-11T02:00:00.000Z", sourceWindow: { start: "2026-10-10", end: "2027-01-10" }, freshness: "fresh", empty: false };

test("reads one complete immutable calendar snapshot without changing lesson times", async () => {
  const result = await readAvaCalendarSnapshot(window, async () => page);
  assert.deepEqual(result.events, [event]);
  assert.equal(result.revision, revision);
  assert.equal(result.coverage, "complete");
  assert.equal(result.freshness, "fresh");
});

test("collects all pages from one revision before returning any events", async () => {
  const firstEvents = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}` }));
  const last = firstEvents.at(-1)!;
  const cursor = { startsAt: last.startsAt, eventId: last.eventId };
  const requests: unknown[] = [];
  const result = await readAvaCalendarSnapshot(window, async (input) => {
    requests.push(input);
    return input.cursor ? { ...page, events: [{ ...event, eventId: "event-999" }] } : { ...page, events: firstEvents, hasMore: true, nextCursor: cursor };
  });
  assert.equal(result.events.length, 251);
  assert.deepEqual(requests, [{ cursor: null, revision: null, limit: 250 }, { cursor, revision, limit: 250 }]);
});

test("accepts PostgreSQL timezone timestamps without changing the represented time", async () => {
  const result = await readAvaCalendarSnapshot(window, async () => ({ ...page, publishedAt: "2026-10-11T02:00:00+00:00", events: [{ ...event, startsAt: "2026-10-11T15:00:00+11:00", endsAt: "2026-10-11T16:00:00+11:00" }] }));
  assert.equal(result.events[0]!.startsAt, event.startsAt);
  assert.equal(result.events[0]!.endsAt, event.endsAt);
  assert.equal(result.publishedAt, page.publishedAt);
});

test("absent, reset, invalid-time and malformed receipts never masquerade as empty success", async () => {
  const invalid = [
    { ...page, state: "absent" }, { ...page, state: "reset" }, { ...page, invalidTimeEventCount: 1 },
    { ...page, empty: true }, { ...page, revision: ` ${revision}` }, { ...page, sourceWindow: { start: "2026-02-30", end: "2027-01-10" } },
    { ...page, events: [{ ...event, eventId: 123 }] }, { ...page, events: [{ ...event, sourceTeacherLabel: undefined }] },
    { ...page, events: [{ ...event, endsAt: event.startsAt }] }, { ...page, events: [{ ...event, sourceParticipants: [{ memberId: " 101", label: "Synthetic One" }] }] },
  ];
  for (const receipt of invalid) await assert.rejects(() => readAvaCalendarSnapshot(window, async () => receipt as unknown as JiaowubaoOpenApiScheduleSnapshotWindow), /source_unavailable/);
});

test("a failed later page never returns the already collected partial page", async () => {
  const events = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}` }));
  const last = events.at(-1)!;
  await assert.rejects(() => readAvaCalendarSnapshot(window, async (input) => {
    if (input.cursor) throw new Error("later page unavailable");
    return { ...page, events, hasMore: true, nextCursor: { startsAt: last.startsAt, eventId: last.eventId } };
  }), /later page unavailable/);
});

test("revision drift between pages is rejected", async () => {
  const events = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}` }));
  const last = events.at(-1)!;
  await assert.rejects(() => readAvaCalendarSnapshot(window, async (input) => input.cursor ? { ...page, revision: `sha256:${"b".repeat(64)}`, events: [{ ...event, eventId: "event-999" }] } : { ...page, events, hasMore: true, nextCursor: { startsAt: last.startsAt, eventId: last.eventId } }), /source_changed/);
});

test("stale source data remains explicitly stale and never gains a fresh empty state", async () => {
  const result = await readAvaCalendarSnapshot(window, async () => ({ ...page, state: "stale", freshness: "stale" }));
  assert.equal(result.freshness, "stale");
  assert.equal(result.events.length, 1);
});

test("source coverage gaps remain visible even when the query has no events", async () => {
  const result = await readAvaCalendarSnapshot(window, async () => ({ ...page, events: [], empty: true, sourceWindow: { start: "2026-10-12", end: "2027-01-10" } }));
  assert.equal(result.coverage, "partial");
});

test("collects all 251 PostgreSQL-shaped events with a six-digit UTC continuation cursor", async () => {
  const firstEvents = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}`, startsAt: "2026-10-11T04:00:00+00:00", endsAt: "2026-10-11T05:00:00+00:00" }));
  const cursor = { startsAt: "2026-10-11T04:00:00.000000Z", eventId: firstEvents.at(-1)!.eventId };
  const requests: unknown[] = [];
  const result = await readAvaCalendarSnapshot(window, async (input) => {
    requests.push(input);
    return input.cursor ? { ...page, events: [{ ...event, eventId: "event-999" }] } : { ...page, events: firstEvents, hasMore: true, nextCursor: cursor };
  });
  assert.equal(result.events.length, 251);
  assert.deepEqual(requests, [{ cursor: null, revision: null, limit: 250 }, { cursor, revision, limit: 250 }]);
  assert.deepEqual(result.events, [...firstEvents.map((item) => ({ ...item, startsAt: event.startsAt, endsAt: event.endsAt })), { ...event, eventId: "event-999" }]);
});

test("accepts offset-equivalent continuation instants at every supported fractional precision", async () => {
  for (const fraction of ["", ".1", ".12", ".123", ".1234", ".12345", ".123456"]) {
    const startsAt = `2026-10-11T15:00:00${fraction}+11:00`;
    const firstEvents = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}`, startsAt }));
    const cursor = { startsAt: `2026-10-10T23:00:00.${fraction.slice(1).padEnd(6, "0")}-05:00`, eventId: firstEvents.at(-1)!.eventId };
    let calls = 0;
    const result = await readAvaCalendarSnapshot(window, async (input) => {
      calls += 1;
      if (input.cursor) {
        assert.deepEqual(input.cursor, cursor);
        return { ...page, events: [{ ...event, eventId: "event-999", startsAt: "2026-10-11T04:00:01+00:00" }] };
      }
      return { ...page, events: firstEvents, hasMore: true, nextCursor: cursor };
    });
    assert.equal(calls, 2);
    assert.equal(result.events.length, 251);
    assert.equal(result.events[0]!.startsAt, new Date(startsAt).toISOString());
    assert.equal(result.events[0]!.endsAt, event.endsAt);
  }
});

test("rejects different continuation instants even when their microseconds share a millisecond", async () => {
  for (const [startsAt, cursorStartsAt] of [
    ["2026-10-11T04:00:00+00:00", "2026-10-11T04:00:01.000000Z"],
    ["2026-10-11T04:00:00+00:00", "2026-10-11T04:00:00.000001Z"],
    ["2026-10-11T04:00:00.123456+00:00", "2026-10-11T04:00:00.123457Z"],
    ["2026-10-11T04:00:00.123456+00:00", "2026-10-11T04:00:00.123455Z"],
  ]) {
    const events = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}`, startsAt }));
    let calls = 0;
    await assert.rejects(() => readAvaCalendarSnapshot(window, async () => {
      calls += 1;
      return { ...page, events, hasMore: true, nextCursor: { startsAt: cursorStartsAt, eventId: events.at(-1)!.eventId } };
    }), /source_unavailable/);
    assert.equal(calls, 1);
  }
});

test("rejects a continuation cursor with the wrong exact last-event identifier", async () => {
  const events = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}`, startsAt: "2026-10-11T04:00:00+00:00" }));
  for (const eventId of ["event-998", ` ${events.at(-1)!.eventId}`, `${events.at(-1)!.eventId} `]) {
    let calls = 0;
    await assert.rejects(() => readAvaCalendarSnapshot(window, async () => {
      calls += 1;
      return { ...page, events, hasMore: true, nextCursor: { startsAt: "2026-10-11T04:00:00.000000Z", eventId } };
    }), /source_unavailable/);
    assert.equal(calls, 1);
  }
});

test("rejects invalid continuation timestamp tokens without trimming or repairing them", async () => {
  const events = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}` }));
  for (const startsAt of ["invalid", "2026-02-30T04:00:00.000000Z", "2026-10-11T04:00:00", "2026-10-11T04:00:00.0000000Z", "2026-10-11T04:00:00+25:00", "2026-10-11T04:00:00.000000z", " 2026-10-11T04:00:00.000000Z", "2026-10-11T04:00:00.000000Z ", "2026-10-11T04:00:00.000000Z\n"]) {
    let calls = 0;
    await assert.rejects(() => readAvaCalendarSnapshot(window, async () => {
      calls += 1;
      return { ...page, events, hasMore: true, nextCursor: { startsAt, eventId: events.at(-1)!.eventId } };
    }), /source_unavailable/);
    assert.equal(calls, 1);
  }
});

test("rejects short continuation pages even with an equivalent timestamp and exact identifier", async () => {
  for (const length of [1, 249]) {
    const events = Array.from({ length }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}`, startsAt: "2026-10-11T04:00:00+00:00" }));
    let calls = 0;
    await assert.rejects(() => readAvaCalendarSnapshot(window, async () => {
      calls += 1;
      return { ...page, events, hasMore: true, nextCursor: { startsAt: "2026-10-11T04:00:00.000000Z", eventId: events.at(-1)!.eventId } };
    }), /source_unavailable/);
    assert.equal(calls, 1);
  }
});
