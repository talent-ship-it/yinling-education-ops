import assert from "node:assert/strict";
import test from "node:test";
import * as live from "../lib/ava-calendar-live-client";

const window = { start: "2026-10-01T00:00:00.000Z", end: "2026-11-12T00:00:00.000Z" };
const lesson = { eventId: "E1", startsAt: "2026-10-10T23:45:00.000Z", endsAt: "2026-10-11T00:30:00.000Z", teacherId: "T1", teacherName: "Synthetic Teacher", trial: true, identityPending: false, students: [{ studentId: "S1", studentName: "Synthetic Student", owner: "Tiffany", ownerId: "C1", color: "owner-1" }] };
function dto() {
  return { events: [structuredClone(lesson)], teachers: [{ id: "T1", name: "Synthetic Teacher" }], source: { revision: `sha256:${"a".repeat(64)}`, publishedAt: "2026-10-01T00:00:00.000Z", freshness: "fresh", coverage: "complete" } };
}

test("same-cookie sequential reads merge producer DTOs without duplicate cross-boundary lessons or legacy green", async () => {
  assert.equal(typeof live.fetchAvaCalendarWindow, "function", "live DTO reader is missing");
  const calls: { url: string; init?: RequestInit }[] = [];
  let active = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    active += 1;
    assert.equal(active, 1);
    await Promise.resolve();
    active -= 1;
    return Response.json(dto());
  };
  const signal = new AbortController().signal;
  const result = await live.fetchAvaCalendarWindow(window, signal, fetchImpl);
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.ok(call.url.startsWith("/api/ava-calendar?"));
    assert.equal(call.init?.credentials, "same-origin");
    assert.equal(call.init?.cache, "no-store");
    assert.equal(call.init?.signal, signal);
    assert.equal(call.init?.method, "GET");
  }
  assert.deepEqual(result.events, [lesson]);
  assert.equal(result.teachers.length, 1);
  assert.deepEqual(result.remainingAVA, []);
});

function approvedDto() {
  return { ...dto(), nativeVersions: { students: 1, teachers: 2, bookings: 3, lpItems: 4 }, consistencyKey: "b".repeat(64), remainingAVA: [{ id: "A1", teacherId: "T1", startsAt: "2026-10-10T12:00:00.000Z", endsAt: "2026-10-10T13:00:00.000Z" }], availabilityStatus: [] };
}
const dayWindow = { start: "2026-10-10T00:00:00.000Z", end: "2026-10-11T00:00:00.000Z" };

test("only approved fresh complete versioned metadata can expose remaining AVA", async () => {
  const body = approvedDto();
  const result = await live.fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json(body));
  assert.deepEqual(result.remainingAVA, body.remainingAVA);
});

test("unverified, pending and unavailable metadata fail closed for green without hiding authorized courses", async () => {
  const base = approvedDto();
  const cases: Record<string, unknown>[] = [
    { ...base, source: { ...base.source, revision: "invalid" } },
    { ...base, source: { ...base.source, revision: [base.source.revision] } },
    { ...base, consistencyKey: [base.consistencyKey] },
    { ...base, source: { ...base.source, window: null } },
    { ...base, source: { ...base.source, window: false } },
    { ...base, source: { ...base.source, publishedAt: "invalid" } },
    { ...base, source: { ...base.source, coverage: "partial" } },
    { ...base, source: { ...base.source, freshness: "stale" } },
    { ...base, nativeVersions: undefined },
    { ...base, consistencyKey: "not-a-digest" },
    { ...base, remainingAVA: undefined },
    { ...base, remainingAVA: [{ ...base.remainingAVA[0], teacherId: "missing" }] },
    { ...base, remainingAVA: [{ ...base.remainingAVA[0], endsAt: "invalid" }] },
    { ...base, remainingAVA: [{ ...base.remainingAVA[0], startsAt: "2026-10-09T12:00:00.000Z" }] },
    { ...base, events: [{ ...lesson, identityPending: true }] },
    { ...base, events: [{ ...lesson, teacherId: null, identityPending: true }] },
    { ...base, availabilityStatus: [{ teacherId: "T1", reason: "no_approved_availability" }] },
    { ...base, availabilityStatus: "invalid" },
    { ...base, source: { ...base.source, window: { start: "invalid", end: "invalid" } } },
  ];
  for (const body of cases) {
    const result = await live.fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json(body));
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.remainingAVA, [], JSON.stringify(body));
  }
});

test("revision, native data, permissions and actual source-window drift discard every slice and retry fresh once", async () => {
  const base = approvedDto();
  const changes = [
    { ...base, consistencyKey: "c".repeat(64) },
    { ...base, nativeVersions: { ...base.nativeVersions, students: 99 } },
    { ...base, source: { ...base.source, revision: `sha256:${"c".repeat(64)}` } },
    { ...base, source: { ...base.source, publishedAt: "2026-10-02T00:00:00.000Z" } },
    { ...base, source: { ...base.source, window } },
    { ...base, teachers: [{ id: "T2", name: "Synthetic Other" }] },
    { ...base, events: [{ ...lesson, students: [] }] },
  ];
  for (const changed of changes) {
    let reads = 0;
    await assert.rejects(() => live.fetchAvaCalendarWindow(window, new AbortController().signal, async () => Response.json(++reads % 2 ? base : changed)), /课表或身份已更新/);
    assert.equal(reads, 4, "one fresh retry, not an unbounded loop");
  }
});

test("a 409 retries the entire group once and never publishes the failed group's lessons", async () => {
  let reads = 0;
  const result = await live.fetchAvaCalendarWindow(window, new AbortController().signal, async () => {
    reads += 1;
    if (reads === 2) return Response.json({}, { status: 409 });
    return Response.json(reads > 2 ? { ...dto(), events: [] } : dto());
  });
  assert.equal(reads, 7);
  assert.deepEqual(result.events, []);
});

test("malformed public DTO fields reject the whole read rather than reaching the renderer", async () => {
  const body = dto();
  const invalid = [
    { ...body, events: null }, { ...body, teachers: null },
    { ...body, events: [{ ...lesson, startsAt: "not-a-time" }] },
    { ...body, events: [{ ...lesson, endsAt: lesson.startsAt }] },
    { ...body, events: [{ ...lesson, students: [null] }] },
    { ...body, events: [{ ...lesson, trial: "true" }] },
    { ...body, events: [{ ...lesson, eventId: " E1 " }] },
    { ...body, teachers: [{ id: "T1", name: 42 }] },
  ];
  for (const malformed of invalid) await assert.rejects(() => live.fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json(malformed)), /课表暂时无法读取/);
});

test("missing ownership stays neutral and only whitelisted public student and event fields survive", async () => {
  const body = dto();
  const event = { ...lesson, secret: "synthetic-must-not-copy", students: [{ ...lesson.students[0], ownerId: null, color: "owner-1", secret: "synthetic-must-not-copy" }] };
  const result = await live.fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json({ ...body, events: [event] }));
  assert.equal(result.events[0]!.students[0]!.color, "owner-unassigned");
  assert.equal(result.events[0]!.students[0]!.owner, null);
  assert.ok(!JSON.stringify(result).includes("synthetic-must-not-copy"));
});

test("a pending teacher in any slice removes that teacher's green from the entire group", async () => {
  let reads = 0;
  const result = await live.fetchAvaCalendarWindow(window, new AbortController().signal, async () => {
    reads += 1;
    return Response.json({ ...approvedDto(), events: reads === 2 ? [{ ...lesson, identityPending: true }] : [], remainingAVA: reads === 1 ? approvedDto().remainingAVA : [] });
  });
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.remainingAVA, []);
});

test("green cannot cover an authorized lesson's occupied time", async () => {
  const body = approvedDto();
  const result = await live.fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json({ ...body, events: [{ ...lesson, startsAt: body.remainingAVA[0]!.startsAt, endsAt: body.remainingAVA[0]!.endsAt }] }));
  assert.deepEqual(result.remainingAVA, []);
});

test("invalid window tokens are rejected without trimming or normalizing malformed dates", () => {
  for (const start of [" 2026-10-01T00:00:00.000Z", "2026-02-30T00:00:00.000Z", "2026-10-01", "2026-10-01T24:00:00.000Z"]) assert.throws(() => live.splitAvaCalendarWindow({ start, end: "2026-10-02T00:00:00.000Z" }), /有效的日期范围/);
});

test("a malformed JSON response never surfaces payload fragments in the failure", async () => {
  await assert.rejects(() => live.fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => new Response('{"studentName":"synthetic-private",broken}')), /课表暂时无法读取/);
});

test("unknown coordinator names cannot borrow a recognized coordinator's palette", async () => {
  const event = { ...lesson, students: [{ ...lesson.students[0]!, owner: "Unknown Synthetic Owner" }] };
  const result = await live.fetchAvaCalendarWindow(dayWindow, new AbortController().signal, async () => Response.json({ ...dto(), events: [event] }));
  assert.equal(result.events[0]!.students[0]!.color, "owner-unassigned");
});

test("freshness may vary across slices without a false authority retry, but any stale slice removes all green", async () => {
  for (const stale of [false, true]) {
    let reads = 0;
    const result = await live.fetchAvaCalendarWindow(window, new AbortController().signal, async (input) => {
      reads += 1;
      const params = new URL(String(input), "http://synthetic.invalid").searchParams;
      const point = Date.parse(params.get("start")!);
      return Response.json({ ...approvedDto(), events: [], source: { ...approvedDto().source, window, freshness: stale && reads === 3 ? "stale" : "fresh" }, remainingAVA: [{ id: `A${reads}`, teacherId: "T1", startsAt: new Date(point + 3600000).toISOString(), endsAt: new Date(point + 7200000).toISOString() }] });
    });
    assert.equal(reads, 5);
    assert.equal(result.remainingAVA.length, stale ? 0 : 5);
  }
});

test("401 in a later slice discards the group without retrying the session", async () => {
  let reads = 0;
  await assert.rejects(() => live.fetchAvaCalendarWindow(window, new AbortController().signal, async () => Response.json(++reads === 2 ? {} : dto(), { status: reads === 2 ? 401 : 200 })), /登录已失效/);
  assert.equal(reads, 2);
});

test("aborted reads cannot publish even when a fetch implementation finishes late", async () => {
  const abort = new AbortController();
  let reads = 0;
  await assert.rejects(() => live.fetchAvaCalendarWindow(window, abort.signal, async () => { reads += 1; abort.abort(); return Response.json(dto()); }), { name: "AbortError" });
  assert.equal(reads, 1);
});

test("month display windows split into five sequential UTC slices of at most ten days", async () => {
  const splitter = await import("../lib/ava-calendar-live-client").catch(() => null);
  assert.equal(typeof splitter?.splitAvaCalendarWindow, "function", "live window splitter is missing");
  const slices = splitter!.splitAvaCalendarWindow({ start: "2026-09-27T14:00:00.000Z", end: "2026-11-08T13:00:00.000Z" });
  assert.equal(slices.length, 5);
  assert.equal(slices[0]!.start, "2026-09-27T14:00:00.000Z");
  assert.equal(slices.at(-1)!.end, "2026-11-08T13:00:00.000Z");
  for (const [index, slice] of slices.entries()) {
    assert.ok(Date.parse(slice.end) - Date.parse(slice.start) <= 10 * 86400000);
    if (index) assert.equal(slice.start, slices[index - 1]!.end);
  }
});

function sliceStatusFixture(greenSlice: number, emptyReason: string) {
  const range = { start: "2026-10-12T01:00:00.000Z", end: "2026-10-27T01:00:00.000Z" };
  const startsAt = ["2026-10-19T01:00:00.000Z", "2026-10-26T01:00:00.000Z"][greenSlice]!;
  const remaining = [{ id: "A1", teacherId: "T1", startsAt, endsAt: new Date(Date.parse(startsAt) + 3600000).toISOString() }];
  let reads = 0;
  const fetchImpl: typeof fetch = async () => {
    const ready = reads++ === greenSlice;
    return Response.json({ ...approvedDto(), events: [], remainingAVA: ready ? remaining : [], availabilityStatus: [{ teacherId: "T1", reason: ready ? "ready" : emptyReason }] });
  };
  return { range, remaining, fetchImpl, reads: () => reads };
}

test("normal empty AVA statuses are slice-local before or after proved future availability", async () => {
  for (const reason of ["no_current_availability", "no_remaining_availability"]) {
    for (const greenSlice of [0, 1]) {
      const fixture = sliceStatusFixture(greenSlice, reason);
      const result = await live.fetchAvaCalendarWindow(fixture.range, new AbortController().signal, fixture.fetchImpl);
      assert.equal(fixture.reads(), 2);
      assert.deepEqual(result.remainingAVA, fixture.remaining, `${reason}:${greenSlice}`);
    }
  }
});

test("unsafe and unknown AVA statuses in either slice still deny the teacher's entire group", async () => {
  for (const reason of ["health_not_ready", "teacher_identity_unproven", "source_occupancy_unmapped", "native_occupancy_invalid", "availability_invalid", "native_state_invalid", "resource_limit", "unknown_availability_reason", ""]) {
    for (const greenSlice of [0, 1]) {
      const fixture = sliceStatusFixture(greenSlice, reason);
      const result = await live.fetchAvaCalendarWindow(fixture.range, new AbortController().signal, fixture.fetchImpl);
      assert.equal(fixture.reads(), 2);
      assert.deepEqual(result.remainingAVA, [], `${reason}:${greenSlice}`);
    }
  }
});
