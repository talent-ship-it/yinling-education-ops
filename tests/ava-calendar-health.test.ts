import assert from "node:assert/strict";
import test from "node:test";
import type { AvaCalendarHealthInput } from "../lib/ava-calendar-health";

const revision = `sha256:${"a".repeat(64)}`;
const publishedAt = "2026-10-12T00:00:00.000Z";
const nativeVersions = { students: 3, teachers: 4, courses: 5, bookings: 6 };
const sourceWindow = { start: "2026-10-01", end: "2026-11-30" };
const projectionRunId = "8d3184a3-c2f6-4092-9be2-0c6afba2682a";
const window = { start: "2026-10-12T01:00:00.000Z", end: "2026-10-13T01:00:00.000Z" };
const stats = { total: 0, matched: 0, unmatched: 0, conflict: 0, sourceOnly: 0, matchRate: 0 };

function fixture() {
  return {
    now: Date.parse(publishedAt), window,
    snapshot: { events: [], revision, publishedAt, freshness: "fresh", coverage: "complete", sourceWindow, paginationComplete: true, invalidTimeEventCount: 0 },
    target: { state: "ready", revision, rowCount: 0, projectionState: "complete", window: sourceWindow, publishedAt },
    currentVersions: Object.entries(nativeVersions).map(([entity, version]) => ({ entity, version })),
    sources: [{
      source_id: "jiaowubao-open-api-schedule", status: "synced", synced_at: publishedAt, row_count: 0,
      payload: {
        schemaVersion: 1, authorityMode: "one_of_multiple", tool: "query_schedule_list", cadenceMinutes: 30,
        snapshotRevision: revision, projectionRunId, snapshotPublishedAt: publishedAt, snapshotChangedAt: publishedAt,
        checkedAt: publishedAt, projectedAt: publishedAt, sourceWindow,
        matches: { schedule: stats, student: stats, teacher: stats, course: stats, class: stats, room: stats },
        anomalies: { duplicateScheduleIds: 0, missingScheduleIds: 0, invalidTimeRecords: 0, missingStudentIds: 0, missingTeacherIds: 0, missingCourseIds: 0, identityConflicts: 0, identityVariantConflicts: 0 },
        prices: { present: false, schedulePriceRecords: 0, studentPriceRecords: 0, persistedPrivately: true, browserExposed: false },
        fields: { topLevelFields: [], studentFields: [] },
        coverage: { snapshotRows: 0, normalizedEntityRows: 0, matchedEntityRows: 0, sourceOnlyEntityRows: 0, sourceSnapshotPersisted: true, normalizedProjectionPersisted: true, nativeRecordsSynchronized: true, connectedTools: ["query_schedule_list"] },
        nativeApply: { schemaVersion: 1, snapshotRevision: revision, projectionRunId, nativeStateVersions: nativeVersions },
        rawStudents: [{ name: "private synthetic student" }],
      },
    }],
  } satisfies AvaCalendarHealthInput;
}

const calendarModule = await import("../lib/ava-calendar-health").catch(() => null);

function evaluate(input: AvaCalendarHealthInput = fixture()) {
  assert.equal(typeof calendarModule?.evaluateAvaCalendarHealth, "function");
  return calendarModule!.evaluateAvaCalendarHealth(input);
}

test("allowlists a complete exact-current projection receipt without private payloads", () => {
  assert.deepEqual(evaluate(), { state: "ready", revision, publishedAt, projectionRunId, nativeVersions, sourceWindow, window, evaluatedAt: publishedAt });
  assert.doesNotMatch(JSON.stringify(evaluate()), /rawStudents|synthetic student|matches|prices|nativeApply|source_id/);
});

test("does not authorize green from an incomplete source collector receipt", () => {
  for (const patch of [{ freshness: "stale" }, { coverage: "partial" }, { paginationComplete: false }, { paginationComplete: undefined }, { invalidTimeEventCount: 1 }, { invalidTimeEventCount: undefined }]) {
    const input = fixture();
    assert.deepEqual(evaluate({ ...input, snapshot: { ...input.snapshot, ...patch } } as AvaCalendarHealthInput), { state: "not_ready", reason: "source_incomplete" });
  }
});

test("keeps pending and authority-only targets separate from complete publication", () => {
  for (const projectionState of ["pending", "authority_done"]) {
    const input = fixture();
    assert.deepEqual(evaluate({ ...input, target: { ...input.target, projectionState } }), { state: "not_ready", reason: "projection_pending" });
  }
});

test("fails closed on missing malformed duplicate or unreadable health receipts", () => {
  const input = fixture();
  for (const patch of [{ target: null }, { target: { state: "absent" } }, { target: { ...input.target, projectionState: "unknown" } }, { sources: [] }, { sources: [input.sources[0], input.sources[0]] }, { sources: new Error("private synthetic provider error") }, { sources: [{ ...input.sources[0], source_id: "other" }] }, { sources: [{ ...input.sources[0], payload: {} }] }]) {
    assert.deepEqual(evaluate({ ...input, ...patch }), { state: "not_ready", reason: "health_unavailable" });
  }
  const broken = { ...input, get target() { throw new Error("private synthetic provider error"); } };
  assert.deepEqual(evaluate(broken), { state: "not_ready", reason: "health_unavailable" });
});

test("requires literal native synchronization and a fresh authority receipt", () => {
  for (const synchronized of [false, "true", 1, undefined]) {
    const input = fixture();
    input.sources[0]!.payload.coverage.nativeRecordsSynchronized = synchronized as boolean;
    assert.equal(evaluate(input).state, "not_ready");
  }
  const input = fixture();
  input.now += 76 * 60_000;
  assert.deepEqual(evaluate(input), { state: "not_ready", reason: "health_unavailable" });
});

test("requires exact integer native apply versions for all four receipt entities", () => {
  for (const entity of ["students", "teachers", "courses", "bookings"] as const) {
    for (const value of [nativeVersions[entity] - 1, nativeVersions[entity] + 1, "4", -1, 0.5, undefined]) {
      const input = fixture();
      input.currentVersions.find((row) => row.entity === entity)!.version = value as number;
      assert.deepEqual(evaluate(input), { state: "not_ready", reason: "native_version_mismatch" });
    }
    const input = fixture();
    input.currentVersions = input.currentVersions.filter((row) => row.entity !== entity);
    assert.equal(evaluate(input).state, "not_ready");
  }
  const input = fixture();
  input.currentVersions.push(input.currentVersions[0]!);
  assert.equal(evaluate(input).state, "not_ready");
  const missingApply = fixture();
  missingApply.sources[0]!.payload.nativeApply = undefined as unknown as typeof missingApply.sources[0]["payload"]["nativeApply"];
  assert.equal(evaluate(missingApply).state, "not_ready");
});

test("pins snapshot target authority and native apply to the same revision run and publication", () => {
  const otherRevision = `sha256:${"b".repeat(64)}`;
  const mutations = [
    (input: ReturnType<typeof fixture>) => { input.target.revision = otherRevision; },
    (input: ReturnType<typeof fixture>) => { input.sources[0]!.payload.snapshotRevision = otherRevision; },
    (input: ReturnType<typeof fixture>) => { input.sources[0]!.payload.nativeApply.snapshotRevision = otherRevision; },
    (input: ReturnType<typeof fixture>) => { input.sources[0]!.payload.nativeApply.projectionRunId = "00000000-0000-4000-8000-000000000001"; },
    (input: ReturnType<typeof fixture>) => { input.sources[0]!.payload.nativeApply.schemaVersion = 2; },
    (input: ReturnType<typeof fixture>) => { input.target.publishedAt = "2026-10-12T00:00:01Z"; },
    (input: ReturnType<typeof fixture>) => { input.sources[0]!.payload.snapshotPublishedAt = "2026-10-12T00:00:01Z"; },
    (input: ReturnType<typeof fixture>) => { input.target.window = { ...sourceWindow, end: "2026-12-01" }; },
    (input: ReturnType<typeof fixture>) => { input.sources[0]!.payload.sourceWindow = { ...sourceWindow, start: "2026-10-02" }; },
    (input: ReturnType<typeof fixture>) => { input.target.rowCount = 1; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.deepEqual(evaluate(input), { state: "not_ready", reason: "receipt_mismatch" });
  }
  const input = fixture();
  input.target.publishedAt = "2026-10-12T11:00:00.000000+11:00";
  assert.equal(evaluate(input).state, "ready");
});

test("validates exact Melbourne source-date coverage and bounded request windows", () => {
  const input = fixture();
  for (const range of [
    { start: "2026-09-30T12:59:59.999Z", end: "2026-09-30T14:00:00Z" },
    { start: "2026-11-30T12:00:00Z", end: "2026-11-30T13:00:00.001Z" },
    { start: "2026-10-12T00:00:00Z", end: "2026-10-23T00:00:00Z" },
    { start: "2026-02-30T00:00:00Z", end: "2026-03-01T01:00:00Z" },
  ]) assert.equal(evaluate({ ...input, window: range }).state, "not_ready");
  assert.equal(evaluate({ ...input, window: { start: "2026-11-30T12:00:00Z", end: "2026-11-30T13:00:00Z" } }).state, "ready");
});

test("preserves microsecond receipt identity and rejects malformed instants without normalization", () => {
  for (const value of ["2026-10-12T00:00:00.000001Z", "2026-02-30T00:00:00Z", " 2026-10-12T00:00:00Z", "2026-10-12T00:00:00+14:30", 123]) {
    const input = fixture();
    input.target.publishedAt = value as string;
    assert.equal(evaluate(input).state, "not_ready");
  }
  assert.equal(typeof calendarModule?.parseAvaCalendarInstant, "function");
  const parse = calendarModule!.parseAvaCalendarInstant;
  assert.deepEqual(parse("2026-10-12T01:00:00.123001Z"), { floor: Date.parse("2026-10-12T01:00:00.123Z"), ceil: Date.parse("2026-10-12T01:00:00.124Z"), microseconds: BigInt(Date.parse("2026-10-12T01:00:00.123Z")) * BigInt(1000) + BigInt(1) });
  assert.deepEqual(parse("2026-10-12T12:00:00.123001+11:00"), parse("2026-10-12T01:00:00.123001Z"));
  assert.notDeepEqual(parse("2026-10-12T01:00:00.123001Z"), parse("2026-10-12T01:00:00.123002Z"));
});

test("requires an explicit captured source window even when the requested window looks covered", () => {
  const input = fixture();
  assert.equal(evaluate({ ...input, snapshot: { ...input.snapshot, sourceWindow: undefined } }).state, "not_ready");
});

test("accepts producer-shaped full-precision publication evidence captured separately from display conversion", () => {
  const input = fixture();
  const exact = "2026-10-12T00:00:00.123456+00:00";
  input.snapshot.publishedAt = exact;
  input.target.publishedAt = "2026-10-12T11:00:00.123456+11:00";
  input.sources[0]!.payload.snapshotPublishedAt = exact;
  assert.equal(evaluate(input).state, "ready");
  input.target.publishedAt = "2026-10-12T11:00:00.123457+11:00";
  assert.equal(evaluate(input).state, "not_ready");
});
