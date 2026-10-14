import assert from "node:assert/strict";
import test from "node:test";
import { createAvaCalendarHandler } from "../lib/ava-calendar-service";
import { readAvaCalendarSnapshot } from "../lib/ava-calendar-snapshot";
import type { OpsStateRow, JiaowubaoOpenApiScheduleSnapshotWindow } from "../lib/ops-store";

const row = (entity: string, payload: unknown): OpsStateRow => ({ entity, payload, version: 1, updated_at: "2026-10-11T00:00:00Z", updated_by: "fixture" });
const rows = [row("students", [{ id: "S1", name: "Synthetic One", jwbSourceRow: "101", owner: "Tiffany", teacher: "Synthetic Teacher" }]), row("teachers", [{ id: "T1", name: "Synthetic Teacher" }]), row("bookings", []), row("lpItems", [])];
const page: JiaowubaoOpenApiScheduleSnapshotWindow = {
  state: "complete", freshness: "fresh", revision: `sha256:${"a".repeat(64)}`, publishedAt: "2026-10-11T00:00:00Z", sourceWindow: { start: "2026-10-10", end: "2027-01-10" }, invalidTimeEventCount: 0, hasMore: false, nextCursor: null, empty: false,
  events: [{ eventId: "event-1", sourceDate: "2026-10-11", startsAt: "2026-10-11T04:00:00Z", endsAt: "2026-10-11T05:00:00Z", courseName: "Private One", sourceTeacherId: "900", sourceTeacherLabel: "Synthetic Teacher", sourceStudentsTruncated: false, sourceParticipants: [{ memberId: "101", label: "Synthetic One" }] }],
};
const session = { user: "Tiffany", role: "staff" as const, permissions: ["operations.read"] };
const accounts = [{ account_id: "staff-tiffany", account_name: "Tiffany", account_role: "staff" as const, status: "active" as const }];
const dependencies = {
  readSession: async () => ({ session, fullAdmin: false }),
  readRows: async () => rows,
  readVersions: async () => rows.map(({ entity, version, updated_at, updated_by }) => ({ entity, version, updated_at, updated_by })),
  readAccounts: async () => accounts,
  readSnapshot: (window: { start: string; end: string }) => readAvaCalendarSnapshot(window, async () => page),
};
const request = () => new Request("https://example.test/api/ava-calendar?start=2026-10-11T00%3A00%3A00.000Z&end=2026-10-18T00%3A00%3A00.000Z");

test("the read-only handler returns only the current caller-scoped calendar DTO", async () => {
  const response = await createAvaCalendarHandler(dependencies)(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /private.*no-store/);
  const data = await response.json();
  assert.equal(data.events[0].students[0].ownerId, "staff-tiffany");
  assert.equal(data.events[0].students[0].studentName, "Synthetic One");
  assert.equal(data.source.freshness, "fresh");
  assert.doesNotMatch(JSON.stringify(data), /Private One|sourceTeacherId|sourceParticipants|jwbSourceRow|updated_by/);
});

test("anonymous requests never read a roster or schedule", async () => {
  const handler = createAvaCalendarHandler({ ...dependencies, readSession: async () => ({ error: "请先登录。", status: 401 }), readRows: async () => { assert.fail("anonymous roster read"); } });
  const response = await handler(request());
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /events|teachers|students/);
});

test("denied permissions cannot reach the raw snapshot", async () => {
  const response = await createAvaCalendarHandler({ ...dependencies, readSession: async () => ({ session: { ...session, permissions: [] }, fullAdmin: false }), readSnapshot: async () => { assert.fail("denied snapshot read"); } })(request());
  assert.equal(response.status, 403);
});

test("every identity and timetable version is checked before publishing the DTO", async () => {
  for (const entity of ["students", "teachers", "bookings", "lpItems"]) {
    const response = await createAvaCalendarHandler({ ...dependencies, readVersions: async () => rows.map((row) => ({ ...row, version: row.entity === entity ? 2 : 1 })) })(request());
    assert.equal(response.status, 409);
    assert.doesNotMatch(await response.text(), /Synthetic One|staff-tiffany/);
  }
});

test("session revocation during the read cannot release private calendar data", async () => {
  let calls = 0;
  const response = await createAvaCalendarHandler({ ...dependencies, readSession: async () => ++calls === 1 ? { session, fullAdmin: false } : { error: "登录已失效。", status: 401 } })(request());
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /Synthetic One|events/);
});

test("coordinator lifecycle changes invalidate the in-flight projection", async () => {
  let calls = 0;
  const response = await createAvaCalendarHandler({ ...dependencies, readAccounts: async () => ++calls === 1 ? accounts : [{ ...accounts[0]!, status: "disabled" as const }] })(request());
  assert.equal(response.status, 409);
});

test("provider errors never expose raw source records or credentials", async () => {
  const response = await createAvaCalendarHandler({ ...dependencies, readSnapshot: async () => { throw new Error("private-provider-key Synthetic One"); } })(request());
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-provider-key|Synthetic One|events/);
});

test("invalid and oversized windows fail before any business-state read", async () => {
  for (const query of ["", "start=invalid&end=invalid", "start=2026-10-11T00:00:00Z&end=2027-01-11T00:00:00Z", "start=2026-10-11T00:00:00Z&start=2026-10-12T00:00:00Z&end=2026-10-18T00:00:00Z", "start=2026-10-11T00:00:00Z&end=2026-10-18T00:00:00Z&teacher=private"]) {
    const response = await createAvaCalendarHandler({ ...dependencies, readRows: async () => { assert.fail("invalid window read"); } })(new Request(`https://example.test/api/ava-calendar?${query}`));
    assert.equal(response.status, 400);
  }
});

test("returns HTTP 200 and all 251 authorized events across PostgreSQL timestamp formats", async () => {
  const event = page.events[0]!;
  const firstEvents = Array.from({ length: 250 }, (_, index) => ({ ...event, eventId: `event-${String(index).padStart(3, "0")}`, startsAt: "2026-10-11T04:00:00+00:00", endsAt: "2026-10-11T05:00:00+00:00" }));
  const cursor = { startsAt: "2026-10-11T04:00:00.000000Z", eventId: firstEvents.at(-1)!.eventId };
  const requests: unknown[] = [];
  const response = await createAvaCalendarHandler({ ...dependencies, readSnapshot: (window) => readAvaCalendarSnapshot(window, async (input) => {
    requests.push(input);
    return input.cursor ? { ...page, events: [{ ...event, eventId: "event-999" }] } : { ...page, events: firstEvents, hasMore: true, nextCursor: cursor };
  }) })(request());
  assert.equal(response.status, 200);
  assert.deepEqual(requests, [{ cursor: null, revision: null, limit: 250 }, { cursor, revision: page.revision, limit: 250 }]);
  const data = await response.json();
  assert.equal(data.events.length, 251);
  assert.ok(data.events.every((item: { startsAt: string; endsAt: string }) => item.startsAt === "2026-10-11T04:00:00.000Z" && item.endsAt === "2026-10-11T05:00:00.000Z"));
  assert.doesNotMatch(JSON.stringify(data), /Private One|sourceTeacherId|sourceParticipants|jwbSourceRow|updated_by/);
});
