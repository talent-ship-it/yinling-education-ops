import assert from "node:assert/strict";
import test from "node:test";
import { projectCalendarAvailability, type AvaCalendarAvailabilityInput } from "../lib/ava-calendar-availability";

function repeatedBookings(count: number): AvaCalendarAvailabilityInput {
  const publishedAt = "2026-10-12T00:00:00.000Z";
  const window = { start: "2026-10-12T01:00:00.000Z", end: "2026-10-12T06:00:00.000Z" };
  const revision = `sha256:${"a".repeat(64)}`;
  const teacher = { id: "T1", jiaowubaoOpenApi: { sourceId: "901", snapshotRevision: revision, resolution: "stable_source_id", confidence: "exact" }, availabilityWindows: [{ id: "A1", teacherId: "T1", day: 1, start: "01:00", end: "06:00", timezone: "UTC", validFrom: "2026-10-01", validTo: "2026-10-31", excludedDates: [], overrides: [], source: "manual" }] };
  const bookings = Array.from({ length: count }, (_, index) => ({ id: `B${index}`, date: "2026-10-12", start: "02:00", duration: 60, timezone: "UTC", teacherId: "T1" }));
  const rows = Object.entries({ students: [], teachers: [teacher], bookings, lpItems: [] }).map(([entity, payload]) => ({ entity, payload, version: 1, updated_at: publishedAt, updated_by: "synthetic" }));
  return { rows, window, visibleTeacherIds: new Set(["T1"]), snapshot: { events: [], revision, publishedAt, freshness: "fresh", coverage: "complete", sourceWindow: { start: "2026-10-01", end: "2026-10-31" }, paginationComplete: true, invalidTimeEventCount: 0 }, health: { state: "ready", revision, publishedAt, projectionRunId: "8d3184a3-c2f6-4092-9be2-0c6afba2682a", nativeVersions: { students: 1, teachers: 1, bookings: 1, courses: 1 }, sourceWindow: { start: "2026-10-01", end: "2026-10-31" }, window, evaluatedAt: publishedAt } };
}

function formatterConstructions(run: () => void) {
  const original = Intl.DateTimeFormat;
  let constructions = 0;
  Intl.DateTimeFormat = new Proxy(original, { construct(target, args) { constructions++; return Reflect.construct(target, args); } });
  try { run(); } finally { Intl.DateTimeFormat = original; }
  return constructions;
}

test("validates repeated native booking timezones once per projection without dropping occupancy", () => {
  const input = repeatedBookings(64);
  const expected = projectCalendarAvailability(repeatedBookings(1));
  const constructions = formatterConstructions(() => assert.deepEqual(projectCalendarAvailability(input), expected));
  assert.ok(constructions <= 2, `expected at most two timezone validators, received ${constructions}`);
  assert.deepEqual(expected.remainingAVA.map(({ startsAt, endsAt }) => [startsAt, endsAt]), [[input.window.start, "2026-10-12T02:00:00.000Z"], ["2026-10-12T03:00:00.000Z", input.window.end]]);
});

function partConversions(run: () => void) {
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) { calls++; return original.apply(this, args); };
  try { run(); } finally { Intl.DateTimeFormat.prototype.formatToParts = original; }
  return calls;
}

test("resolves equal native wall-clock intervals once per projection and recomputes on the next call", () => {
  const small = repeatedBookings(1);
  const large = repeatedBookings(64);
  const expected = projectCalendarAvailability(small);
  const once = partConversions(() => assert.deepEqual(projectCalendarAvailability(small), expected));
  const repeated = partConversions(() => assert.deepEqual(projectCalendarAvailability(large), expected));
  const nextRequest = partConversions(() => assert.deepEqual(projectCalendarAvailability(large), expected));
  assert.ok(once > 0);
  assert.ok(repeated <= once + 2, `wall-clock conversions grew from ${once} to ${repeated}`);
  assert.equal(nextRequest, repeated);
});
