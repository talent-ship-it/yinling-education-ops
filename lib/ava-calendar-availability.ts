import type { AvaCalendarDisplay } from "./ava-calendar-display";
import type { AvaCalendarAvailabilitySnapshot, AvaCalendarHealth } from "./ava-calendar-health";
import { parseAvaCalendarInstant } from "./ava-calendar-health";
import type { AvaCalendarWindow } from "./ava-calendar-snapshot";
import { validateAvaCalendarWindow } from "./ava-calendar-snapshot";
import type { OpsStateRow } from "./ops-store";
import { expandTeacherAvailability, localTimeToInstant, type TeacherAvailabilityWindow } from "./teacher-availability";
import { scheduleDateInTimezone, scheduleOccurrenceInstant, shiftScheduleDate, subtractBookedFromAvailability, type ScheduleAvailabilityRange } from "./schedule-calendar";
import { expandLessonOccurrences, LESSON_OCCURRENCE_STATUSES, type LegacyLessonSeries, type LessonOccurrence, type LessonOccurrenceOverride } from "./lesson-occurrences";
import { recurrenceOccurrenceCount, recurrenceSourceEndDate } from "./booking-recurrence";

export type AvaCalendarAvailabilityReason = "ready" | "no_current_availability" | "no_remaining_availability" | "health_not_ready" | "teacher_identity_unproven" | "source_occupancy_unmapped" | "native_occupancy_invalid" | "availability_invalid" | "native_state_invalid" | "resource_limit";
export type AvaCalendarAvailability = Readonly<{
  remainingAVA: { id: string; teacherId: string; startsAt: string; endsAt: string }[];
  availabilityStatus: { teacherId: string; reason: AvaCalendarAvailabilityReason }[];
}>;
export type AvaCalendarAvailabilityInput = Readonly<{
  rows: readonly OpsStateRow[];
  snapshot: AvaCalendarAvailabilitySnapshot;
  window: AvaCalendarWindow;
  visibleTeacherIds: ReadonlySet<string>;
  health: AvaCalendarHealth | null;
  display?: AvaCalendarDisplay;
}>;

type CalendarRange = { start: number; end: number };
type ReadyHealth = Extract<AvaCalendarHealth, { state: "ready" }>;
type SnapshotEvent = AvaCalendarAvailabilitySnapshot["events"][number];
type NativeRecord = Record<string, unknown> & { id: string };
type TeacherIndex = ReturnType<typeof teacherIndex>;
type Occupancy = Map<string, ScheduleAvailabilityRange[]>;

class AvailabilityFailure extends Error {
  constructor(readonly reason: AvaCalendarAvailabilityReason) {
    super(reason);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function literalId(value: unknown, maximum = 240): value is string {
  return typeof value === "string" && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function literalText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function denied(ids: readonly string[], reason: AvaCalendarAvailabilityReason): AvaCalendarAvailability {
  return { remainingAVA: [], availabilityStatus: ids.map((teacherId) => ({ teacherId, reason })) };
}

function completeCollector(snapshot: AvaCalendarAvailabilitySnapshot) {
  return snapshot.sourceWindow && snapshot.freshness === "fresh" && snapshot.coverage === "complete" && snapshot.paginationComplete === true && snapshot.invalidTimeEventCount === 0;
}

function proofWindowMatches(input: AvaCalendarAvailabilityInput, health: ReadyHealth) {
  return health.window.start === input.window.start && health.window.end === input.window.end
    && health.sourceWindow.start === input.snapshot.sourceWindow!.start && health.sourceWindow.end === input.snapshot.sourceWindow!.end;
}

function proofPublicationMatches(snapshot: AvaCalendarAvailabilitySnapshot, health: ReadyHealth) {
  const published = parseAvaCalendarInstant(snapshot.publishedAt);
  const proof = parseAvaCalendarInstant(health.publishedAt);
  return published !== null && proof !== null && published.microseconds === proof.microseconds && health.revision === snapshot.revision;
}

function healthBound(input: AvaCalendarAvailabilityInput) {
  const { health, snapshot } = input;
  if (health?.state !== "ready") return false;
  return completeCollector(snapshot) && proofPublicationMatches(snapshot, health) && proofWindowMatches(input, health) && parseAvaCalendarInstant(health.evaluatedAt) !== null;
}

function nativeEntityRow(rows: readonly OpsStateRow[], entity: string) {
  const matches = rows.filter((row) => row?.entity === entity);
  const row = matches[0];
  if (matches.length !== 1 || !row || !Array.isArray(row.payload) || !Number.isSafeInteger(row.version) || row.version < 0) throw new AvailabilityFailure("native_state_invalid");
  return { payload: row.payload as unknown[], version: row.version };
}

function rowVersionMatches(input: AvaCalendarAvailabilityInput, entity: string, version: number) {
  if (input.display || entity === "lpItems") return true;
  return input.health?.state === "ready" && version === input.health.nativeVersions[entity as "students" | "teachers" | "bookings"];
}
function readRows(input: AvaCalendarAvailabilityInput) {
  if (!Array.isArray(input.rows) || !input.display && input.health?.state !== "ready") throw new AvailabilityFailure("native_state_invalid");
  const result = new Map<string, unknown[]>();
  for (const entity of ["students", "teachers", "bookings", "lpItems"]) {
    const row = nativeEntityRow(input.rows, entity);
    if (!rowVersionMatches(input, entity, row.version)) throw new AvailabilityFailure("native_state_invalid");
    result.set(entity, row.payload);
  }
  return result;
}

function identifiedNativeRecord(value: unknown, seen: ReadonlySet<string>, reason: AvaCalendarAvailabilityReason): NativeRecord {
  const item = record(value);
  if (!item || !literalId(item.id) || seen.has(item.id)) throw new AvailabilityFailure(reason);
  return item as NativeRecord;
}

function addTeacherSource(teacher: NativeRecord, sources: Map<string, string[]>) {
  const sourceId = record(teacher.jiaowubaoOpenApi)?.sourceId;
  if (literalId(sourceId, 200)) sources.set(sourceId, [...(sources.get(sourceId) ?? []), teacher.id]);
}

function teacherIndex(values: unknown[]) {
  if (values.length > 1000) throw new AvailabilityFailure("resource_limit");
  const teachers = new Map<string, NativeRecord>();
  const sources = new Map<string, string[]>();
  const seen = new Set<string>();
  let windowCount = 0;
  for (const value of values) {
    const teacher = identifiedNativeRecord(value, seen, "native_state_invalid");
    seen.add(teacher.id);
    teachers.set(teacher.id, teacher);
    if (Array.isArray(teacher.availabilityWindows)) windowCount += teacher.availabilityWindows.length;
    if (windowCount > 4096) throw new AvailabilityFailure("resource_limit");
    addTeacherSource(teacher, sources);
  }
  return { teachers, sources };
}

function teacherProven(teacher: Record<string, unknown>, sources: Map<string, string[]>, revision?: string) {
  const metadata = record(teacher.jiaowubaoOpenApi);
  return metadata !== null && literalId(metadata.sourceId, 200) && sources.get(metadata.sourceId)?.length === 1
    && (revision === undefined || metadata.snapshotRevision === revision) && ["stable_source_id", "created"].includes(metadata.resolution as string) && metadata.confidence === "exact";
}

function sourceTeacher(event: SnapshotEvent, index: TeacherIndex, revision?: string) {
  const sourceId = event?.sourceTeacherId;
  if (!literalId(sourceId, 200)) throw new AvailabilityFailure("source_occupancy_unmapped");
  const teacherId = index.sources.get(sourceId)?.[0];
  const teacher = teacherId ? index.teachers.get(teacherId) : undefined;
  if (!teacher || !teacherId || !teacherProven(teacher, index.sources, revision)) throw new AvailabilityFailure("source_occupancy_unmapped");
  return teacherId;
}

function sourceInterval(event: SnapshotEvent, seen: Set<string>) {
  if (!event || !literalId(event.eventId, 200) || seen.has(event.eventId)) throw new AvailabilityFailure("source_occupancy_unmapped");
  const start = parseAvaCalendarInstant(event.startsAt);
  const end = parseAvaCalendarInstant(event.endsAt);
  if (!start || !end || start.microseconds >= end.microseconds) throw new AvailabilityFailure("source_occupancy_unmapped");
  seen.add(event.eventId);
  return { id: event.eventId, startsAt: new Date(start.floor).toISOString(), endsAt: new Date(end.ceil).toISOString() };
}

function addOccupancy(occupied: Occupancy, teacherId: string, interval: ScheduleAvailabilityRange) {
  const entries = occupied.get(teacherId) ?? [];
  entries.push(interval);
  occupied.set(teacherId, entries);
}

function sourceOccupancy(input: AvaCalendarAvailabilityInput, index: TeacherIndex) {
  const occupied: Occupancy = new Map();
  const seen = new Set<string>();
  if (!Array.isArray(input.snapshot.events)) throw new AvailabilityFailure("source_occupancy_unmapped");
  if (input.snapshot.events.length > 10000) throw new AvailabilityFailure("resource_limit");
  for (const event of input.snapshot.events) {
    const teacherId = sourceTeacher(event, index, input.display ? undefined : input.snapshot.revision);
    addOccupancy(occupied, teacherId, sourceInterval(event, seen));
  }
  return occupied;
}

function durationValid(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1440;
}

function validateNativeTimezone(timezone: string, timezones: Set<string>) {
  if (timezones.has(timezone)) return;
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  timezones.add(timezone);
}

function nativeSeries(booking: Record<string, unknown>, timezones: Set<string>) {
  if (!literalId(booking.id) || ![booking.date, booking.start, booking.timezone].every(literalText) || !durationValid(booking.duration)
    || booking.recurring !== undefined && typeof booking.recurring !== "boolean"
    || booking.teacherId !== undefined && booking.teacherId !== null && !literalId(booking.teacherId)) throw new AvailabilityFailure("native_occupancy_invalid");
  validateNativeTimezone(booking.timezone as string, timezones);
  return booking as unknown as LegacyLessonSeries;
}

function overrideTimingValid(override: Record<string, unknown>) {
  return (override.date === undefined || typeof override.date === "string") && (override.start === undefined || typeof override.start === "string")
    && (override.durationMinutes === undefined || durationValid(override.durationMinutes));
}

function overrideTeacherValid(override: Record<string, unknown>) {
  return !Object.hasOwn(override, "teacherId") || override.teacherId === null || literalId(override.teacherId);
}

function overrideStatusValid(value: unknown) {
  return value === undefined || LESSON_OCCURRENCE_STATUSES.includes(value as NonNullable<LessonOccurrenceOverride["status"]>);
}

function nativeOverride(value: unknown, seriesId: string) {
  const override = record(value);
  if (!override || !literalId(override.occurrenceId, 300) || !override.occurrenceId.startsWith(`${seriesId}:`)
    || !overrideStatusValid(override.status) || !overrideTimingValid(override) || !overrideTeacherValid(override)) throw new AvailabilityFailure("native_occupancy_invalid");
  return override as unknown as LessonOccurrenceOverride;
}

function finiteOccurrences(booking: Record<string, unknown>, timezones: Set<string>) {
  const series = nativeSeries(booking, timezones);
  const bounds = { ...series, startDate: series.date };
  const end = recurrenceSourceEndDate(bounds);
  const count = recurrenceOccurrenceCount(bounds);
  if (!end || !count || count > 104) throw new AvailabilityFailure("native_occupancy_invalid");
  const values = booking.occurrenceOverrides === undefined ? [] : booking.occurrenceOverrides;
  if (!Array.isArray(values)) throw new AvailabilityFailure("native_occupancy_invalid");
  if (values.length > 104) throw new AvailabilityFailure("resource_limit");
  const overrides = values.map((value) => nativeOverride(value, series.id));
  const occurrences = expandLessonOccurrences(series, { rangeStart: series.date, rangeEnd: end, overrides });
  const ids = new Set(occurrences.map((occurrence) => occurrence.occurrenceId));
  if (overrides.some((override) => !ids.has(override.occurrenceId))) throw new AvailabilityFailure("native_occupancy_invalid");
  return occurrences;
}

function knownTeacher(value: unknown, teachers: TeacherIndex["teachers"]): value is string {
  return literalId(value) && teachers.has(value);
}

function affectedTeachers(booking: Record<string, unknown>, teachers: TeacherIndex["teachers"]) {
  if (!knownTeacher(booking.teacherId, teachers)) return null;
  const ids = new Set([booking.teacherId]);
  const overrides = booking.occurrenceOverrides;
  if (overrides === undefined) return ids;
  if (!Array.isArray(overrides)) return null;
  for (const raw of overrides) {
    const override = record(raw);
    if (!override) return null;
    if (!Object.hasOwn(override, "teacherId")) continue;
    if (!knownTeacher(override.teacherId, teachers)) return null;
    ids.add(override.teacherId);
  }
  return ids;
}

function occurrenceInterval(occurrence: LessonOccurrence, intervals: Map<string, { start: number; end: number }>) {
  const timezone = occurrence.timezone!;
  const key = JSON.stringify([occurrence.date, occurrence.start, timezone, occurrence.scheduledDurationMinutes]);
  const cached = intervals.get(key);
  if (cached) return { id: occurrence.occurrenceId, ...cached };
  const earlier = localTimeToInstant(occurrence.date, occurrence.start, timezone, "earlier").valueOf();
  const later = localTimeToInstant(occurrence.date, occurrence.start, timezone, "later").valueOf();
  const native = scheduleOccurrenceInstant({ ...occurrence, timezone }).valueOf();
  if (native < earlier || native > later) throw new AvailabilityFailure("native_occupancy_invalid");
  const interval = { start: earlier, end: Math.ceil(later + occurrence.scheduledDurationMinutes * 60_000) };
  intervals.set(key, interval);
  return { id: occurrence.occurrenceId, ...interval };
}

function sourceDateRange(range: CalendarRange, timezone: string) {
  return { from: shiftScheduleDate(scheduleDateInTimezone(new Date(range.start), timezone), -2), to: shiftScheduleDate(scheduleDateInTimezone(new Date(range.end), timezone), 2) };
}

function recordNativeOccurrences(occurrences: readonly LessonOccurrence[], timezone: string, teachers: TeacherIndex["teachers"], range: CalendarRange, occupied: Occupancy, dateRanges: Map<string, ReturnType<typeof sourceDateRange>>, intervals: Map<string, { start: number; end: number }>) {
  const dates = dateRanges.get(timezone) ?? sourceDateRange(range, timezone);
  dateRanges.set(timezone, dates);
  for (const occurrence of occurrences) {
    if (["cancelled", "leave"].includes(occurrence.status) || occurrence.date < dates.from || occurrence.date > dates.to) continue;
    const interval = occurrenceInterval(occurrence, intervals);
    if (interval.end <= range.start || interval.start >= range.end) continue;
    if (!knownTeacher(occurrence.teacherId, teachers)) throw new AvailabilityFailure("native_occupancy_invalid");
    addOccupancy(occupied, occurrence.teacherId, { id: interval.id, startsAt: new Date(interval.start).toISOString(), endsAt: new Date(interval.end).toISOString() });
  }
}

function recordNativeFailure(booking: NativeRecord, teachers: TeacherIndex["teachers"], invalid: Set<string>, error: unknown) {
  if (error instanceof AvailabilityFailure && error.reason === "resource_limit") throw error;
  const affected = affectedTeachers(booking, teachers);
  if (!affected) throw new AvailabilityFailure("native_occupancy_invalid");
  for (const teacherId of affected) invalid.add(teacherId);
}

function nativeOccupancy(values: unknown[], teachers: TeacherIndex["teachers"], range: CalendarRange, occupied: Occupancy) {
  if (values.length > 20000) throw new AvailabilityFailure("resource_limit");
  const invalid = new Set<string>();
  const seen = new Set<string>();
  let expandedCount = 0;
  const timezones = new Set<string>();
  const dateRanges = new Map<string, ReturnType<typeof sourceDateRange>>();
  const intervals = new Map<string, { start: number; end: number }>();
  for (const value of values) {
    const booking = identifiedNativeRecord(value, seen, "native_occupancy_invalid");
    seen.add(booking.id);
    try {
      const occurrences = finiteOccurrences(booking, timezones);
      expandedCount += occurrences.length;
      if (expandedCount > 50000) throw new AvailabilityFailure("resource_limit");
      recordNativeOccurrences(occurrences, booking.timezone as string, teachers, range, occupied, dateRanges, intervals);
    } catch (error) {
      recordNativeFailure(booking, teachers, invalid, error);
    }
  }
  return invalid;
}

function dateOverrideValid(value: unknown) {
  const override = record(value);
  return override !== null && literalId(override.id) && [override.date, override.start, override.end].every((item) => typeof item === "string");
}

function windowDatesValid(window: Record<string, unknown>) {
  if (!Array.isArray(window.excludedDates) || !Array.isArray(window.overrides)) return false;
  if (window.excludedDates.length > 64 || window.overrides.length > 64) throw new AvailabilityFailure("resource_limit");
  return window.excludedDates.every((date) => typeof date === "string") && window.overrides.every(dateOverrideValid);
}

function concreteWindow(value: unknown, teacherId: string) {
  const window = record(value);
  if (!window || !literalId(window.id) || window.teacherId !== teacherId || !["submission", "manual", "legacy-promoted"].includes(window.source as string)
    || ![window.start, window.end, window.timezone, window.validFrom, window.validTo].every(literalText) || !windowDatesValid(window)) throw new AvailabilityFailure("availability_invalid");
  new Intl.DateTimeFormat("en", { timeZone: window.timezone as string }).format(0);
  return window as unknown as TeacherAvailabilityWindow;
}

function concreteWindows(teacher: Record<string, unknown>, teacherId: string) {
  const values = teacher.availabilityWindows;
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new AvailabilityFailure("availability_invalid");
  if (values.length > 64) throw new AvailabilityFailure("resource_limit");
  return values.map((value) => concreteWindow(value, teacherId));
}

function nativeAvailability(teacher: Record<string, unknown>, teacherId: string, range: CalendarRange) {
  const windows = concreteWindows(teacher, teacherId);
  if (!windows.length || range.start >= range.end) return [];
  const dates = windows.map((window) => sourceDateRange(range, window.timezone));
  const from = dates.map((date) => date.from).sort()[0]!;
  const to = dates.map((date) => date.to).sort().at(-1)!;
  return expandTeacherAvailability(windows, { from, to, displayTimezone: "UTC" }).flatMap((occurrence) => {
    const start = Math.max(Date.parse(occurrence.startsAt), range.start);
    const end = Math.min(Date.parse(occurrence.endsAt), range.end);
    return start < end ? [{ id: `ava:${teacherId}:${occurrence.id}`, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }] : [];
  });
}

function teacherAvailability(teacher: Record<string, unknown>, teacherId: string, range: CalendarRange, occupied: readonly ScheduleAvailabilityRange[]) {
  try {
    const available = nativeAvailability(teacher, teacherId, range);
    const free = subtractBookedFromAvailability(available, occupied, "UTC");
    return {
      remainingAVA: free.map(({ occurrenceId, startsAt, endsAt }) => ({ id: occurrenceId, teacherId, startsAt, endsAt })),
      reason: (available.length === 0 ? "no_current_availability" : free.length === 0 ? "no_remaining_availability" : "ready") as AvaCalendarAvailabilityReason,
    };
  } catch (error) {
    return { remainingAVA: [], reason: error instanceof AvailabilityFailure ? error.reason : "availability_invalid" as const };
  }
}

function projectedTeacher(input: AvaCalendarAvailabilityInput, index: TeacherIndex, teacherId: string, invalid: ReadonlySet<string>, range: CalendarRange, occupied: Occupancy) {
  if (invalid.has(teacherId)) return { remainingAVA: [], reason: "native_occupancy_invalid" as const };
  const teacher = index.teachers.get(teacherId);
  if (!teacher || !teacherProven(teacher, index.sources, input.display ? undefined : input.snapshot.revision)) return { remainingAVA: [], reason: "teacher_identity_unproven" as const };
  return teacherAvailability(teacher, teacherId, range, occupied.get(teacherId) ?? []);
}

export function projectCalendarAvailability(input: AvaCalendarAvailabilityInput): AvaCalendarAvailability {
  let ids: string[] = [];
  try {
    ids = [...input.visibleTeacherIds].filter((id) => literalId(id)).sort();
    if (input.display ? !input.display.canSubtract : input.health?.state !== "ready" || !healthBound(input)) return denied(ids, "health_not_ready");
    const range = validateAvaCalendarWindow(input.window);
    const evaluatedAt = input.display?.evaluatedAt ?? (input.health?.state === "ready" ? input.health.evaluatedAt : "");
    range.start = Math.max(range.start, parseAvaCalendarInstant(evaluatedAt)!.ceil);
    const rows = readRows(input);
    const index = teacherIndex(rows.get("teachers")!);
    const occupied = sourceOccupancy(input, index);
    const invalid = nativeOccupancy(rows.get("bookings")!, index.teachers, range, occupied);
    const remainingAVA: AvaCalendarAvailability["remainingAVA"] = [];
    const availabilityStatus: AvaCalendarAvailability["availabilityStatus"] = [];
    for (const teacherId of ids) {
      const projected = projectedTeacher(input, index, teacherId, invalid, range, occupied);
      remainingAVA.push(...projected.remainingAVA);
      availabilityStatus.push({ teacherId, reason: projected.reason });
    }
    return { remainingAVA, availabilityStatus };
  } catch (error) {
    return denied(ids, error instanceof AvailabilityFailure ? error.reason : "native_state_invalid");
  }
}
