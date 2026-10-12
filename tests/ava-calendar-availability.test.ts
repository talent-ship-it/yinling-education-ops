import assert from "node:assert/strict";
import test from "node:test";
import type { AvaCalendarAvailabilityInput } from "../lib/ava-calendar-availability";
import type { AvaCalendarHealth, AvaCalendarAvailabilitySnapshot } from "../lib/ava-calendar-health";
import type { OpsStateRow } from "../lib/ops-store";
import type { TeacherAvailabilityWindow } from "../lib/teacher-availability";

const revision = `sha256:${"a".repeat(64)}`;
const publishedAt = "2026-10-12T00:00:00.000Z";
const window = { start: "2026-10-12T01:00:00.000Z", end: "2026-10-12T06:00:00.000Z" };
const sourceWindow = { start: "2026-10-01", end: "2026-11-30" };
const row = (entity: string, payload: unknown): OpsStateRow => ({ entity, payload, version: 1, updated_at: publishedAt, updated_by: "private synthetic actor" });
const nativeWindow = (teacherId = "T1", patch: Partial<TeacherAvailabilityWindow> = {}): TeacherAvailabilityWindow => ({ id: `ava-${teacherId}`, teacherId, day: 1, start: "01:00", end: "06:00", timezone: "UTC", validFrom: "2026-10-01", validTo: "2026-10-31", excludedDates: [], overrides: [], source: "manual", ...patch });
const teacher = (id = "T1", sourceId = "901") => ({ id, name: "Synthetic Teacher", timezone: "UTC", availabilityWindows: [nativeWindow(id)], availabilitySourceText: "private raw evidence", jiaowubaoOpenApi: { sourceId, snapshotRevision: revision, resolution: "stable_source_id", confidence: "exact" } });
const snapshot = (events: AvaCalendarAvailabilitySnapshot["events"] = []): AvaCalendarAvailabilitySnapshot => ({ events, revision, publishedAt, freshness: "fresh", coverage: "complete", sourceWindow, paginationComplete: true, invalidTimeEventCount: 0 });
const health = (): AvaCalendarHealth => ({ state: "ready", revision, publishedAt, projectionRunId: "8d3184a3-c2f6-4092-9be2-0c6afba2682a", nativeVersions: { students: 1, teachers: 1, courses: 1, bookings: 1 }, sourceWindow, window, evaluatedAt: publishedAt });
const fixture = (teachers: unknown[] = [teacher()], bookings: unknown[] = []): { -readonly [Key in keyof AvaCalendarAvailabilityInput]: AvaCalendarAvailabilityInput[Key] } => ({ rows: [row("students", [{ id: "S1", name: "private hidden student" }]), row("teachers", teachers), row("bookings", bookings), row("lpItems", [])], snapshot: snapshot(), window, visibleTeacherIds: new Set(["T1"]), health: health() });
const calendarModule = await import("../lib/ava-calendar-availability").catch(() => null);

function project(input = fixture()) {
  assert.equal(typeof calendarModule?.projectCalendarAvailability, "function");
  return calendarModule!.projectCalendarAvailability(input);
}

function spans(input = fixture()) {
  return project(input).remainingAVA.map(({ teacherId, startsAt, endsAt }) => ({ teacherId, startsAt, endsAt }));
}

test("returns only scoped concrete native availability and stable minimal interval DTOs", () => {
  const input = fixture([teacher(), teacher("T2", "902")]);
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: window.start, endsAt: window.end }]);
  const output = project(input);
  assert.deepEqual(output.availabilityStatus, [{ teacherId: "T1", reason: "ready" }]);
  assert.deepEqual(Object.keys(output.remainingAVA[0]!).sort(), ["endsAt", "id", "startsAt", "teacherId"]);
  assert.deepEqual(output, project(input));
  assert.doesNotMatch(JSON.stringify(output), /T2|private|sourceId|sourceTeacherId|jiaowubao|student|timezone|availabilityWindows/);
});

test("does not throw or change existing lessons when health is missing pending or stale", () => {
  const input = fixture();
  const before = structuredClone(input.rows);
  for (const health of [null, { state: "not_ready", reason: "projection_pending" }, { state: "not_ready", reason: "health_unavailable" }, {}]) {
    assert.deepEqual(project({ ...input, health } as AvaCalendarAvailabilityInput), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "health_not_ready" }] });
  }
  assert.deepEqual(input.rows, before);
});

test("requires current exact stable or created source-ID evidence rather than a unique name", () => {
  for (const patch of [{ sourceId: " 901" }, { sourceId: 901 }, { snapshotRevision: `sha256:${"b".repeat(64)}` }, { resolution: "same_name" }, { resolution: "existing_source_id" }, { confidence: "inferred" }, { confidence: "strong" }]) {
    const item = teacher();
    const input = fixture([{ ...item, jiaowubaoOpenApi: { ...item.jiaowubaoOpenApi, ...patch } }]);
    assert.deepEqual(project(input), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "teacher_identity_unproven" }] });
  }
  assert.equal(project(fixture([{ ...teacher(), jiaowubaoOpenApi: null }])).remainingAVA.length, 0);
  const item = teacher();
  assert.equal(project(fixture([{ ...item, jiaowubaoOpenApi: { ...item.jiaowubaoOpenApi, resolution: "created" } }])).remainingAVA.length, 1);
});

test("refuses native duplicate IDs and source-ID collisions even outside the public teacher scope", () => {
  for (const teachers of [[teacher(), teacher()], [teacher(), teacher("T2", "901")]]) assert.equal(project(fixture(teachers)).remainingAVA.length, 0);
  assert.equal(project(fixture([{ ...teacher(), id: " T1" }])).remainingAVA.length, 0);
});

test("requires complete unfiltered native rows and versions rather than best-effort rows", () => {
  const input = fixture();
  for (const entity of ["students", "teachers", "bookings", "lpItems"]) {
    assert.equal(project({ ...input, rows: input.rows.filter((row) => row.entity !== entity) }).remainingAVA.length, 0);
    assert.equal(project({ ...input, rows: [...input.rows, input.rows.find((row) => row.entity === entity)!] }).remainingAVA.length, 0);
  }
  for (const entity of ["students", "teachers", "bookings"]) {
    assert.equal(project({ ...input, rows: input.rows.map((row) => row.entity === entity ? { ...row, version: row.version + 1 } : row) }).remainingAVA.length, 0);
  }
});

test("does not reuse a ready health proof for a different snapshot or request window", () => {
  const input = fixture();
  for (const patch of [{ freshness: "stale" }, { coverage: "partial" }, { paginationComplete: false }, { invalidTimeEventCount: 1 }, { revision: `sha256:${"b".repeat(64)}` }, { sourceWindow: { ...sourceWindow, end: "2026-12-01" } }, { sourceWindow: undefined }]) {
    assert.equal(project({ ...input, snapshot: { ...input.snapshot, ...patch } } as AvaCalendarAvailabilityInput).remainingAVA.length, 0);
  }
  assert.equal(project({ ...input, window: { ...window, end: "2026-10-12T07:00:00Z" } }).remainingAVA.length, 0);
});

const sourceEvent = (patch: Partial<AvaCalendarAvailabilitySnapshot["events"][number]> = {}): AvaCalendarAvailabilitySnapshot["events"][number] => ({ eventId: "jwb-open-api:schedule:101", sourceDate: "2026-10-12", startsAt: "2026-10-12T02:00:00Z", endsAt: "2026-10-12T03:00:00Z", sourceTeacherId: "901", sourceTeacherLabel: "different synthetic display alias", courseName: "private course", sourceParticipants: [{ memberId: "unknown-student", label: "private hidden participant" }], sourceStudentsTruncated: true, ...patch });

test("subtracts every source-ID teacher occupancy even when no participant is visible or known", () => {
  const input = fixture();
  input.snapshot = snapshot([sourceEvent()]);
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: window.start, endsAt: "2026-10-12T02:00:00.000Z" }, { teacherId: "T1", startsAt: "2026-10-12T03:00:00.000Z", endsAt: window.end }]);
  assert.doesNotMatch(JSON.stringify(project(input)), /hidden participant|unknown-student|private course|sourceTeacher|alias/);
});

test("conservatively denies all green for an unmapped teacher occupancy or hidden source alias", () => {
  for (const sourceTeacherId of ["unmapped-alias", " 901", null, 901]) {
    const input = fixture([teacher(), teacher("T2", "902")]);
    input.snapshot = snapshot([sourceEvent({ sourceTeacherId: sourceTeacherId as string, sourceTeacherLabel: "Synthetic Teacher" })]);
    assert.deepEqual(project(input), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "source_occupancy_unmapped" }] });
  }
});

test("does not leak or subtract unrelated proven hidden teachers and permits distinct stable IDs with equal names", () => {
  const input = fixture([teacher(), teacher("T2", "902")]);
  input.snapshot = snapshot([sourceEvent({ sourceTeacherId: "902" })]);
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: window.start, endsAt: window.end }]);
});

test("outward-rounds microsecond occupancy and accepts positive same-millisecond intervals", () => {
  const input = fixture();
  input.snapshot = snapshot([sourceEvent({ startsAt: "2026-10-12T02:00:00.123001Z", endsAt: "2026-10-12T02:00:00.123002Z" })]);
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: window.start, endsAt: "2026-10-12T02:00:00.123Z" }, { teacherId: "T1", startsAt: "2026-10-12T02:00:00.124Z", endsAt: window.end }]);
  input.snapshot = snapshot([sourceEvent({ startsAt: "2026-10-12T13:00:00.000000+11:00", endsAt: "2026-10-12T14:00:00.000001+11:00" })]);
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: window.start, endsAt: "2026-10-12T02:00:00.000Z" }, { teacherId: "T1", startsAt: "2026-10-12T03:00:00.001Z", endsAt: window.end }]);
});

test("does not silently ignore malformed or duplicate source occupancy", () => {
  for (const patch of [{ startsAt: "2026-02-30T02:00:00Z" }, { endsAt: "2026-10-12T02:00:00Z" }, { startsAt: "2026-10-12T02:00:00.000002Z", endsAt: "2026-10-12T02:00:00.000001Z" }]) {
    const input = fixture();
    input.snapshot = snapshot([sourceEvent(patch)]);
    assert.equal(project(input).remainingAVA.length, 0);
  }
  const input = fixture();
  input.snapshot = snapshot([sourceEvent(), sourceEvent()]);
  assert.equal(project(input).remainingAVA.length, 0);
});

function requested(input: ReturnType<typeof fixture>, range = window, evaluatedAt = publishedAt) {
  input.window = range;
  input.health = { ...health(), window: range, publishedAt: evaluatedAt, evaluatedAt } as AvaCalendarHealth;
  input.snapshot = { ...input.snapshot, publishedAt: evaluatedAt };
  return input;
}

test("clips green exactly to the requested half-open window and future instants", () => {
  const input = fixture([{ ...teacher(), availabilityWindows: [nativeWindow("T1", { start: "00:00", end: "08:00" })] }]);
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: window.start, endsAt: window.end }]);
  requested(input, window, "2026-10-12T03:00:00.000Z");
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: "2026-10-12T03:00:00.000Z", endsAt: window.end }]);
  requested(input, window, "2026-10-13T00:00:00.000Z");
  assert.deepEqual(project(input), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "no_current_availability" }] });
});

test("never promotes legacy slots or raw text when concrete windows are missing or expired", () => {
  for (const availabilityWindows of [undefined, [], [nativeWindow("T1", { validFrom: "2026-09-01", validTo: "2026-09-30" })]]) {
    const input = fixture([{ ...teacher(), availabilityWindows, availabilitySlots: [{ day: 1, start: "01:00", end: "06:00" }], availability: "Monday 1-6" }]);
    assert.deepEqual(project(input), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "no_current_availability" }] });
  }
});

test("retains native exclusion and dated override semantics without inventing a separate block table", () => {
  const excluded = fixture([{ ...teacher(), availabilityWindows: [nativeWindow("T1", { excludedDates: ["2026-10-12"] })] }]);
  assert.deepEqual(project(excluded), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "no_current_availability" }] });
  const changed = fixture([{ ...teacher(), availabilityWindows: [nativeWindow("T1", { overrides: [{ id: "override-1", date: "2026-10-12", start: "02:00", end: "04:00" }] })] }]);
  assert.deepEqual(spans(changed), [{ teacherId: "T1", startsAt: "2026-10-12T02:00:00.000Z", endsAt: "2026-10-12T04:00:00.000Z" }]);
});

test("requires each native window's literal teacher ID and unique IDs", () => {
  for (const windows of [[nativeWindow("T2")], [nativeWindow(" T1")], [nativeWindow(), nativeWindow()], [nativeWindow("T1", { id: " ava-T1" })]]) {
    const output = project(fixture([{ ...teacher(), availabilityWindows: windows }]));
    assert.deepEqual(output, { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "availability_invalid" }] });
  }
});

test("isolates a malformed availability teacher instead of removing other provable green", () => {
  const input = fixture([{ ...teacher(), availabilityWindows: null }, teacher("T2", "902")]);
  input.visibleTeacherIds = new Set(["T1", "T2"]);
  assert.deepEqual(spans(input), [{ teacherId: "T2", startsAt: window.start, endsAt: window.end }]);
  assert.deepEqual(project(input).availabilityStatus, [{ teacherId: "T1", reason: "availability_invalid" }, { teacherId: "T2", reason: "ready" }]);
});

test("expands source-timezone dates beyond UTC dates and includes prior-day cross-midnight windows", () => {
  const melbourne = fixture([{ ...teacher(), availabilityWindows: [nativeWindow("T1", { timezone: "Australia/Melbourne", start: "00:00", end: "02:00" })] }]);
  const range = { start: "2026-10-11T13:30:00.000Z", end: "2026-10-11T14:30:00.000Z" };
  assert.deepEqual(spans(requested(melbourne, range, "2026-10-11T12:00:00.000Z")), [{ teacherId: "T1", startsAt: range.start, endsAt: range.end }]);
  const midnight = fixture([{ ...teacher(), availabilityWindows: [nativeWindow("T1", { day: 0, start: "23:30", end: "01:30" })] }]);
  const midnightRange = { start: "2026-10-12T00:00:00.000Z", end: "2026-10-12T01:00:00.000Z" };
  assert.deepEqual(spans(requested(midnight, midnightRange)), [{ teacherId: "T1", startsAt: midnightRange.start, endsAt: midnightRange.end }]);
});

test("fails closed on nonexistent native AVA wall times rather than normalizing across DST", () => {
  const input = fixture([{ ...teacher(), availabilityWindows: [nativeWindow("T1", { day: 0, timezone: "Australia/Melbourne", start: "02:30", end: "04:00" })] }]);
  requested(input, { start: "2026-10-03T14:00:00.000Z", end: "2026-10-03T18:00:00.000Z" }, "2026-10-03T13:00:00.000Z");
  assert.deepEqual(project(input), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "availability_invalid" }] });
});

const booking = (patch: Record<string, unknown> = {}) => ({ id: "booking-1", date: "2026-10-12", start: "02:00", duration: 60, timezone: "UTC", studentId: "unknown-hidden-native-student", teacherId: "T1", status: "已确认", ...patch });
const cutSpan = [{ teacherId: "T1", startsAt: window.start, endsAt: "2026-10-12T02:00:00.000Z" }, { teacherId: "T1", startsAt: "2026-10-12T03:00:00.000Z", endsAt: window.end }];

test("subtracts native effective occurrences without requiring visible or known students", () => {
  const input = fixture([teacher()], [booking()]);
  assert.deepEqual(spans(input), cutSpan);
  assert.doesNotMatch(JSON.stringify(project(input)), /hidden-native-student|studentId|booking-1/);
});

test("uses the exact override teacher and never falls back from explicit null to the parent", () => {
  const substitute = booking({ occurrenceOverrides: [{ occurrenceId: "booking-1:2026-10-12", teacherId: "T2" }] });
  const input = fixture([teacher(), teacher("T2", "902")], [substitute]);
  input.visibleTeacherIds = new Set(["T1", "T2"]);
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: window.start, endsAt: window.end }, ...cutSpan.map((span) => ({ ...span, teacherId: "T2" }))]);
  const missing = fixture([teacher()], [booking({ occurrenceOverrides: [{ occurrenceId: "booking-1:2026-10-12", teacherId: null }] })]);
  assert.deepEqual(project(missing), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "native_occupancy_invalid" }] });
});

test("ignores only cancelled and leave occurrences rather than inheriting a parent status", () => {
  for (const status of ["cancelled", "leave"]) {
    assert.deepEqual(spans(fixture([teacher()], [booking({ occurrenceOverrides: [{ occurrenceId: "booking-1:2026-10-12", status, teacherId: null }] })])), [{ teacherId: "T1", startsAt: window.start, endsAt: window.end }]);
  }
  for (const status of ["confirmed", "completed", "abnormal"]) {
    assert.deepEqual(spans(fixture([teacher()], [booking({ status: "已完成", occurrenceOverrides: [{ occurrenceId: "booking-1:2026-10-12", status }] })])), cutSpan);
  }
  assert.deepEqual(spans(fixture([teacher()], [booking({ status: "cancelled" })])), cutSpan);
});

test("includes moved-in occurrences from outside the target dates using finite recurrence", () => {
  const moved = booking({ date: "2026-09-28", recurring: true, repeatCount: 2, recurrenceIntervalDays: 7, occurrenceOverrides: [{ occurrenceId: "booking-1:2026-09-28", date: "2026-10-12" }] });
  assert.deepEqual(spans(fixture([teacher()], [moved])), cutSpan);
  const endBounded = booking({ date: "2026-10-05", recurring: true, recurrenceEndDate: "2026-10-12" });
  assert.deepEqual(spans(fixture([teacher()], [endBounded])), cutSpan);
});

test("keeps both source and native occupancies when their shared source lesson key has different timing", () => {
  const input = fixture([teacher()], [booking({ start: "01:00", sourceLessonId: "jwb-open-api:schedule:101" })]);
  input.snapshot = snapshot([sourceEvent()]);
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: "2026-10-12T03:00:00.000Z", endsAt: window.end }]);
});

test("isolates identifiable invalid native occupancy while unknown identity denies all green", () => {
  const input = fixture([teacher(), teacher("T2", "902")], [booking({ duration: "60" })]);
  input.visibleTeacherIds = new Set(["T1", "T2"]);
  assert.deepEqual(spans(input), [{ teacherId: "T2", startsAt: window.start, endsAt: window.end }]);
  assert.deepEqual(project(input).availabilityStatus, [{ teacherId: "T1", reason: "native_occupancy_invalid" }, { teacherId: "T2", reason: "ready" }]);
  for (const teacherId of [null, "unknown", " T1", 1]) {
    const unknown = fixture([teacher(), teacher("T2", "902")], [booking({ teacherId })]);
    assert.equal(project(unknown).remainingAVA.length, 0);
  }
});

test("rejects malformed recurrence orphan overrides duplicate bookings and unvalidated native timezones", () => {
  for (const patch of [{ recurring: true }, { recurring: true, repeatCount: 1_000_000 }, { recurring: "true", repeatCount: 2 }, { timezone: "bad/timezone" }, { timezone: undefined }, { occurrenceOverrides: [{ occurrenceId: "booking-1:2026-10-11", date: "2026-10-12" }] }, { occurrenceOverrides: [{ occurrenceId: "booking-1:2026-10-12", status: "unknown" }] }, { occurrenceOverrides: [{ occurrenceId: "booking-1:2026-10-12", teacherId: " T1" }] }]) {
    assert.equal(project(fixture([teacher()], [booking(patch)])).remainingAVA.length, 0);
  }
  assert.equal(project(fixture([teacher()], [booking(), booking()])).remainingAVA.length, 0);
});

test("does not normalize nonexistent native lesson wall times across DST", () => {
  const item = { ...teacher(), availabilityWindows: [nativeWindow("T1", { day: 0, timezone: "Australia/Melbourne", start: "01:00", end: "05:00" })] };
  const input = fixture([item], [booking({ date: "2026-10-04", start: "02:30", timezone: "Australia/Melbourne" })]);
  requested(input, { start: "2026-10-03T14:00:00.000Z", end: "2026-10-03T18:00:00.000Z" }, "2026-10-03T13:00:00.000Z");
  assert.deepEqual(project(input), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "native_occupancy_invalid" }] });
});

test("bounds oversized native rows source events and teacher windows without partial green", () => {
  const tooManyTeachers = fixture(Array.from({ length: 1001 }, (_, index) => teacher(`T${index + 1}`, String(901 + index))));
  assert.deepEqual(project(tooManyTeachers), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "resource_limit" }] });
  const tooManyBookings = fixture([teacher()], Array.from({ length: 20001 }, () => booking()));
  assert.equal(project(tooManyBookings).availabilityStatus[0]?.reason, "resource_limit");
  const tooManyEvents = fixture();
  tooManyEvents.snapshot = snapshot(Array.from({ length: 10001 }, (_, index) => sourceEvent({ eventId: `event-${index}` })));
  assert.equal(project(tooManyEvents).availabilityStatus[0]?.reason, "resource_limit");
  const tooManyWindows = fixture([{ ...teacher(), availabilityWindows: Array.from({ length: 65 }, (_, index) => nativeWindow("T1", { id: `window-${index}` })) }]);
  assert.equal(project(tooManyWindows).availabilityStatus[0]?.reason, "resource_limit");
  const tooManyOverrides = fixture([teacher()], [booking({ occurrenceOverrides: Array.from({ length: 105 }, () => ({ occurrenceId: "booking-1:2026-10-12" })) })]);
  assert.equal(project(tooManyOverrides).availabilityStatus[0]?.reason, "resource_limit");
});

test("supports a bounded 92-teacher synthetic view without inventing free slots", () => {
  const teachers = Array.from({ length: 92 }, (_, index) => teacher(`T${index + 1}`, String(901 + index)));
  const input = fixture(teachers);
  input.visibleTeacherIds = new Set(teachers.map((teacher) => teacher.id));
  assert.equal(project(input).remainingAVA.length, 92);
  const before = structuredClone(input);
  assert.deepEqual(project(input), project(before));
  assert.deepEqual(input, before);
});

test("honors half-open adjacency and reports fully occupied current AVA without a false ready span", () => {
  const input = fixture([{ ...teacher(), availabilityWindows: [nativeWindow("T1", { start: "02:00", end: "03:00" })] }], [booking({ start: "01:00" }), booking({ id: "booking-2", start: "03:00" })]);
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: "2026-10-12T02:00:00.000Z", endsAt: "2026-10-12T03:00:00.000Z" }]);
  input.snapshot = snapshot([sourceEvent()]);
  assert.deepEqual(project(input), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "no_remaining_availability" }] });
});

test("conservatively occupies both possible instants of an ambiguous native DST lesson", () => {
  const item = { ...teacher(), availabilityWindows: [nativeWindow("T1", { day: 0, timezone: "Australia/Melbourne", validFrom: "2026-04-01", validTo: "2026-04-30", start: "01:00", end: "04:00" })] };
  const input = fixture([item], [booking({ date: "2026-04-05", start: "02:30", duration: 30, timezone: "Australia/Melbourne" })]);
  requested(input, { start: "2026-04-04T14:00:00.000Z", end: "2026-04-04T18:00:00.000Z" }, "2026-04-04T13:00:00.000Z");
  assert.deepEqual(spans(input), [{ teacherId: "T1", startsAt: "2026-04-04T14:00:00.000Z", endsAt: "2026-04-04T15:30:00.000Z" }, { teacherId: "T1", startsAt: "2026-04-04T17:00:00.000Z", endsAt: "2026-04-04T18:00:00.000Z" }]);
});

test("checks dated-window detail limits before walking oversized exclusion or override arrays", () => {
  const exclusions = new Proxy(Array.from({ length: 65 }, () => "2026-10-12"), { get(target, key, receiver) { if (key === "every") throw new Error("must not walk oversized evidence"); return Reflect.get(target, key, receiver); } });
  const input = fixture([{ ...teacher(), availabilityWindows: [nativeWindow("T1", { excludedDates: exclusions })] }]);
  assert.equal(project(input).availabilityStatus[0]?.reason, "resource_limit");
});

test("bounds aggregate expanded native occurrences including wholly historical series", () => {
  const input = fixture([teacher()], Array.from({ length: 481 }, (_, index) => booking({ id: `historical-${index}`, date: "1970-01-01", recurring: true, repeatCount: 104 })));
  assert.deepEqual(project(input), { remainingAVA: [], availabilityStatus: [{ teacherId: "T1", reason: "resource_limit" }] });
});
