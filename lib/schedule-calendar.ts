import { cleanTimezone } from "./timezone";
import type { LessonOccurrenceStatus } from "./lesson-occurrences";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type ScheduleCalendarOccurrence = Readonly<{
  occurrenceId: string;
  date: string;
  start: string;
  timezone: string;
  studentId: string;
  status: LessonOccurrenceStatus;
}>;

export type ScheduleMonthWindow = Readonly<{
  month: string;
  monthStart: string;
  monthEnd: string;
  gridStart: string;
  gridEnd: string;
}>;

export type ScheduleAttendanceSummary = Readonly<{
  scheduled: number;
  present: number;
  unresolved: number;
  rate: number | null;
  basis: "occurrence_status";
}>;

export type StudentCalendarColor = Readonly<{
  background: string;
  border: string;
  ink: string;
}>;

export type ScheduleAvailabilityRange = Readonly<{
  id: string;
  startsAt: string;
  endsAt: string;
}>;

export type ScheduleFreeAvailability = Readonly<{
  occurrenceId: string;
  date: string;
  startsAt: string;
  endsAt: string;
}>;

function parseIsoDate(value: string, field = "date") {
  if (!ISO_DATE_PATTERN.test(value)) throw new Error(`${field} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date`);
  }
  return parsed;
}

function parseMonth(value: string) {
  if (!MONTH_PATTERN.test(value)) throw new Error("month must use YYYY-MM");
  let parsed: Date;
  try {
    parsed = parseIsoDate(`${value}-01`, "month");
  } catch {
    throw new Error("month must be a valid calendar month");
  }
  if (parsed.toISOString().slice(0, 7) !== value) throw new Error("month must be a valid calendar month");
  return parsed;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function shiftScheduleDate(value: string, days: number) {
  const parsed = parseIsoDate(value);
  if (!Number.isSafeInteger(days)) throw new Error("days must be an integer");
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return isoDate(parsed);
}

export function shiftScheduleMonth(value: string, months: number) {
  const parsed = parseMonth(value);
  if (!Number.isSafeInteger(months)) throw new Error("months must be an integer");
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  return parsed.toISOString().slice(0, 7);
}

/** Monday-first calendar range, including the leading/trailing days needed by the grid. */
export function scheduleMonthWindow(month: string): ScheduleMonthWindow {
  const first = parseMonth(month);
  const nextMonth = new Date(first);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const last = new Date(nextMonth);
  last.setUTCDate(0);
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const sundayOffset = 6 - ((last.getUTCDay() + 6) % 7);

  return {
    month,
    monthStart: isoDate(first),
    monthEnd: isoDate(last),
    gridStart: shiftScheduleDate(isoDate(first), -mondayOffset),
    gridEnd: shiftScheduleDate(isoDate(last), sundayOffset),
  };
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: cleanTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])) as Record<string, string>;
}

function timezoneOffsetMs(date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - date.getTime();
}

/** Converts the occurrence's source wall-clock time to one stable instant. */
export function scheduleOccurrenceInstant(occurrence: Pick<ScheduleCalendarOccurrence, "date" | "start" | "timezone">) {
  parseIsoDate(occurrence.date, "occurrence date");
  if (!TIME_PATTERN.test(occurrence.start)) throw new Error("occurrence start must use HH:MM");
  const [year, month, day] = occurrence.date.split("-").map(Number);
  const [hour, minute] = occurrence.start.split(":").map(Number);
  const timezone = cleanTimezone(occurrence.timezone);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  const first = new Date(wallClock - timezoneOffsetMs(new Date(wallClock), timezone));
  return new Date(wallClock - timezoneOffsetMs(first, timezone));
}

export function scheduleDateInTimezone(date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function scheduleOccurrenceDisplayDate(
  occurrence: Pick<ScheduleCalendarOccurrence, "date" | "start" | "timezone">,
  displayTimezone: string,
) {
  return scheduleDateInTimezone(scheduleOccurrenceInstant(occurrence), displayTimezone);
}

export type ScheduleMonthDay<Occurrence> = Readonly<{
  date: string;
  inMonth: boolean;
  occurrences: readonly Occurrence[];
}>;

/** Groups already-expanded occurrences by their date in the selected display timezone. */
export function buildScheduleMonth<Occurrence extends ScheduleCalendarOccurrence>(
  month: string,
  occurrences: readonly Occurrence[],
  displayTimezone: string,
): readonly ScheduleMonthDay<Occurrence>[] {
  const window = scheduleMonthWindow(month);
  const grouped = new Map<string, Occurrence[]>();
  const seen = new Set<string>();

  for (const occurrence of occurrences) {
    if (seen.has(occurrence.occurrenceId)) continue;
    seen.add(occurrence.occurrenceId);
    const date = scheduleOccurrenceDisplayDate(occurrence, displayTimezone);
    if (date < window.gridStart || date > window.gridEnd) continue;
    const entries = grouped.get(date) ?? [];
    entries.push(occurrence);
    grouped.set(date, entries);
  }

  for (const entries of grouped.values()) {
    entries.sort((left, right) => scheduleOccurrenceInstant(left).getTime() - scheduleOccurrenceInstant(right).getTime() || left.occurrenceId.localeCompare(right.occurrenceId));
  }

  const days: ScheduleMonthDay<Occurrence>[] = [];
  for (let date = window.gridStart; date <= window.gridEnd; date = shiftScheduleDate(date, 1)) {
    days.push({ date, inMonth: date.startsWith(`${month}-`), occurrences: grouped.get(date) ?? [] });
  }
  return days;
}

/**
 * Reports attendance from concrete occurrence state only. No meeting-provider
 * evidence is inferred here: completed means present; a past confirmed or
 * abnormal occurrence remains scheduled but not present.
 */
export function summarizeScheduleAttendance(
  occurrences: readonly ScheduleCalendarOccurrence[],
  options: Readonly<{ rangeStart: string; rangeEnd: string; now: Date; reportingTimezone: string }>,
): ScheduleAttendanceSummary {
  parseIsoDate(options.rangeStart, "rangeStart");
  parseIsoDate(options.rangeEnd, "rangeEnd");
  if (options.rangeEnd < options.rangeStart) throw new Error("rangeEnd must not be before rangeStart");
  if (Number.isNaN(options.now.valueOf())) throw new Error("now must be valid");

  const eligibleStatuses = new Set<LessonOccurrenceStatus>(["confirmed", "completed", "abnormal"]);
  const eligible = new Map<string, ScheduleCalendarOccurrence>();
  for (const occurrence of occurrences) {
    if (!eligibleStatuses.has(occurrence.status) || eligible.has(occurrence.occurrenceId)) continue;
    const instant = scheduleOccurrenceInstant(occurrence);
    const reportingDate = scheduleDateInTimezone(instant, options.reportingTimezone);
    if (reportingDate < options.rangeStart || reportingDate > options.rangeEnd || instant.getTime() > options.now.getTime()) continue;
    eligible.set(occurrence.occurrenceId, occurrence);
  }

  const scheduled = eligible.size;
  const present = [...eligible.values()].filter((occurrence) => occurrence.status === "completed").length;
  return {
    scheduled,
    present,
    unresolved: scheduled - present,
    rate: scheduled ? Math.round((present / scheduled) * 100) : null,
    basis: "occurrence_status",
  };
}

/** Stable, data-derived colours keep the same student recognisable across months. */
export function stableStudentCalendarColor(studentId: string): StudentCalendarColor {
  let hash = 2166136261;
  for (const character of studentId.trim() || "unknown-student") {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  const hue = unsigned % 360;
  const saturation = 48 + ((unsigned >>> 9) % 13);
  return {
    background: `hsl(${hue} ${saturation}% 95%)`,
    border: `hsl(${hue} ${Math.min(72, saturation + 8)}% 67%)`,
    ink: `hsl(${hue} ${Math.min(70, saturation + 6)}% 27%)`,
  };
}

/** Removes already-booked instants from a teacher's confirmed AVA ranges. */
export function subtractBookedFromAvailability(
  availability: readonly ScheduleAvailabilityRange[],
  booked: readonly ScheduleAvailabilityRange[],
  displayTimezone: string,
): readonly ScheduleFreeAvailability[] {
  const timezone = cleanTimezone(displayTimezone);
  const parseRange = (range: ScheduleAvailabilityRange) => {
    const start = new Date(range.startsAt).getTime();
    const end = new Date(range.endsAt).getTime();
    if (!range.id.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new Error("availability ranges require an id and increasing ISO instants");
    }
    return { ...range, start, end };
  };
  const bookedRanges = booked.map(parseRange).sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
  const free: ScheduleFreeAvailability[] = [];
  availability.map(parseRange).sort((left, right) => left.start - right.start || left.id.localeCompare(right.id)).forEach((range) => {
    let pieces: Array<{ start: number; end: number }> = [{ start: range.start, end: range.end }];
    bookedRanges.forEach((lesson) => {
      pieces = pieces.flatMap((piece) => {
        if (lesson.end <= piece.start || lesson.start >= piece.end) return [piece];
        return [
          ...(lesson.start > piece.start ? [{ start: piece.start, end: lesson.start }] : []),
          ...(lesson.end < piece.end ? [{ start: lesson.end, end: piece.end }] : []),
        ];
      });
    });
    pieces.forEach((piece, index) => {
      const startsAt = new Date(piece.start).toISOString();
      free.push({
        occurrenceId: `${range.id}:free:${index}:${piece.start}`,
        date: scheduleDateInTimezone(new Date(piece.start), timezone),
        startsAt,
        endsAt: new Date(piece.end).toISOString(),
      });
    });
  });
  return free;
}
