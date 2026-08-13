const DAY_MS = 86_400_000;
const MINUTES_PER_DAY = 1_440;
const MINUTES_PER_WEEK = 10_080;
const MAX_EFFECTIVE_DAYS = 370;

export type AvailabilitySource = "submission" | "manual" | "legacy-promoted";

export interface AvailabilitySlotInput {
  id?: string;
  day: number;
  start: string;
  end: string;
}

export interface TeacherAvailabilityDateOverride {
  id: string;
  date: string;
  start: string;
  end: string;
}

/**
 * A recurring local-time window with an explicit effective range. A window is
 * intentionally bounded: an old, unbounded weekly template must first be
 * normalized as legacy data and explicitly promoted for a month.
 */
export interface TeacherAvailabilityWindow {
  id: string;
  teacherId: string;
  day: number;
  start: string;
  end: string;
  timezone: string;
  validFrom: string;
  validTo: string;
  excludedDates: string[];
  overrides: TeacherAvailabilityDateOverride[];
  source: AvailabilitySource;
  sourceSubmissionId?: string;
}

export interface LegacyAvailabilitySlot extends AvailabilitySlotInput {
  id: string;
}

/** Legacy data is deliberately not assignable to TeacherAvailabilityWindow. */
export interface LegacyAvailabilityTemplate {
  kind: "legacy-weekly-template";
  teacherId: string;
  timezone: string;
  monthlyConfirmed: false;
  slots: LegacyAvailabilitySlot[];
}

export interface TeacherAvailabilitySubmission {
  id: string;
  teacherId: string;
  month: string;
  timezone: string;
  slots: readonly AvailabilitySlotInput[];
}

export interface TeacherAvailabilityOccurrence {
  id: string;
  windowId: string;
  teacherId: string;
  sourceDate: string;
  sourceStart: string;
  sourceEndDate: string;
  sourceEnd: string;
  sourceTimezone: string;
  startsAt: string;
  endsAt: string;
  displayStartDate: string;
  displayStart: string;
  displayEndDate: string;
  displayEnd: string;
  displayTimezone: string;
  isOverride: boolean;
}

export type TeacherAvailabilityErrorCode =
  | "duplicate-id"
  | "duplicate-slot"
  | "invalid-date"
  | "invalid-day"
  | "invalid-month"
  | "invalid-range"
  | "invalid-time"
  | "invalid-timezone"
  | "missing-window"
  | "nonexistent-local-time"
  | "overlap";

export class TeacherAvailabilityValidationError extends Error {
  readonly code: TeacherAvailabilityErrorCode;

  constructor(code: TeacherAvailabilityErrorCode, message: string) {
    super(message);
    this.name = "TeacherAvailabilityValidationError";
    this.code = code;
  }
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

interface ZonedParts extends DateParts {
  hour: number;
  minute: number;
  second: number;
}

function fail(code: TeacherAvailabilityErrorCode, message: string): never {
  throw new TeacherAvailabilityValidationError(code, message);
}

function parseDate(value: string, label = "date"): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) fail("invalid-date", `${label} must use YYYY-MM-DD.`);

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  if (parts.year < 1900 || parts.month < 1 || parts.month > 12) {
    fail("invalid-date", `${label} is not a valid calendar date.`);
  }

  const roundTrip = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    roundTrip.getUTCFullYear() !== parts.year ||
    roundTrip.getUTCMonth() + 1 !== parts.month ||
    roundTrip.getUTCDate() !== parts.day
  ) {
    fail("invalid-date", `${label} is not a valid calendar date.`);
  }
  return parts;
}

function formatDate(parts: DateParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateValue(value: string): number {
  const parts = parseDate(value);
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function shiftDate(value: string, days: number): string {
  const instant = new Date(dateValue(value) + days * DAY_MS);
  return formatDate({
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  });
}

function daysBetween(from: string, to: string): number {
  return Math.round((dateValue(to) - dateValue(from)) / DAY_MS);
}

function weekday(value: string): number {
  return new Date(dateValue(value)).getUTCDay();
}

function parseMonth(month: string): { start: string; end: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) fail("invalid-month", "month must use YYYY-MM.");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (year < 1900 || monthNumber < 1 || monthNumber > 12) {
    fail("invalid-month", "month is not valid.");
  }
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    start: `${match[1]}-${match[2]}-01`,
    end: `${match[1]}-${match[2]}-${String(last).padStart(2, "0")}`,
  };
}

function parseTime(value: string, label = "time"): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) fail("invalid-time", `${label} must use HH:MM.`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    fail("invalid-time", `${label} is not a valid time.`);
  }
  return hour * 60 + minute;
}

function validateTimeRange(start: string, end: string): void {
  const startMinutes = parseTime(start, "start");
  const endMinutes = parseTime(end, "end");
  if (startMinutes === endMinutes) {
    fail("invalid-time", "start and end cannot be the same.");
  }
}

function assertDay(day: number): void {
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    fail("invalid-day", "day must be an integer from 0 (Sunday) to 6 (Saturday).");
  }
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    fail("invalid-timezone", `${timezone || "(blank)"} is not a valid IANA timezone.`);
  }
}

function stableHash(input: string): string {
  let forward = 2_166_136_261;
  let reverse = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    forward = Math.imul(forward ^ input.charCodeAt(index), 16_777_619);
    reverse = Math.imul(
      reverse ^ input.charCodeAt(input.length - index - 1),
      16_777_619,
    );
  }
  return `${(forward >>> 0).toString(36)}${(reverse >>> 0).toString(36)}`;
}

function canonicalSlot(slot: AvailabilitySlotInput): string {
  return `${slot.day}|${slot.start}|${slot.end}`;
}

function weeklyInterval(slot: AvailabilitySlotInput): [number, number] {
  const start = slot.day * MINUTES_PER_DAY + parseTime(slot.start);
  let end = slot.day * MINUTES_PER_DAY + parseTime(slot.end);
  if (end < start) end += MINUTES_PER_DAY;
  return [start, end];
}

function intervalsOverlap(
  first: readonly [number, number],
  second: readonly [number, number],
): boolean {
  return first[0] < second[1] && second[0] < first[1];
}

function weeklySlotsOverlap(
  first: AvailabilitySlotInput,
  second: AvailabilitySlotInput,
): boolean {
  const firstInterval = weeklyInterval(first);
  const secondInterval = weeklyInterval(second);
  return [-MINUTES_PER_WEEK, 0, MINUTES_PER_WEEK].some((shift) =>
    intervalsOverlap(firstInterval, [secondInterval[0] + shift, secondInterval[1] + shift]),
  );
}

export function assertValidAvailabilitySlots(
  slots: readonly AvailabilitySlotInput[],
): void {
  const ids = new Set<string>();
  const canonical = new Set<string>();

  slots.forEach((slot, index) => {
    assertDay(slot.day);
    validateTimeRange(slot.start, slot.end);
    if (slot.id) {
      if (ids.has(slot.id)) {
        fail("duplicate-id", `Slot id ${slot.id} is duplicated.`);
      }
      ids.add(slot.id);
    }

    const key = canonicalSlot(slot);
    if (canonical.has(key)) {
      fail("duplicate-slot", `Slot ${index + 1} duplicates another slot.`);
    }
    canonical.add(key);
  });

  for (let left = 0; left < slots.length; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      if (weeklySlotsOverlap(slots[left], slots[right])) {
        fail(
          "overlap",
          `Availability slots ${left + 1} and ${right + 1} overlap in the teacher's local week.`,
        );
      }
    }
  }
}

function zonedParts(instant: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function timezoneOffsetMs(instant: Date, timezone: string): number {
  const parts = zonedParts(instant, timezone);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) - instant.getTime()
  );
}

function localTimeToInstant(
  date: string,
  time: string,
  timezone: string,
  disambiguation: "earlier" | "later",
): Date {
  const dateParts = parseDate(date);
  const minutes = parseTime(time);
  assertTimezone(timezone);
  const target = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    Math.floor(minutes / 60),
    minutes % 60,
  );

  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 3) {
    const sample = new Date(target + hours * 60 * 60 * 1_000);
    offsets.add(timezoneOffsetMs(sample, timezone));
  }

  const candidates = [...offsets]
    .map((offset) => new Date(target - offset))
    .filter((candidate) => {
      const candidateParts = zonedParts(candidate, timezone);
      return (
        candidateParts.year === dateParts.year &&
        candidateParts.month === dateParts.month &&
        candidateParts.day === dateParts.day &&
        candidateParts.hour === Math.floor(minutes / 60) &&
        candidateParts.minute === minutes % 60
      );
    })
    .sort((left, right) => left.getTime() - right.getTime());

  if (candidates.length === 0) {
    fail(
      "nonexistent-local-time",
      `${date} ${time} does not exist in ${timezone} because of a timezone transition.`,
    );
  }
  return disambiguation === "earlier" ? candidates[0] : candidates[candidates.length - 1];
}

function displayParts(instant: Date, timezone: string): { date: string; time: string } {
  const parts = zonedParts(instant, timezone);
  return {
    date: formatDate(parts),
    time: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
  };
}

function assertWindowShape(window: TeacherAvailabilityWindow): void {
  if (!window.id.trim()) fail("duplicate-id", "Availability id cannot be blank.");
  if (!window.teacherId.trim()) fail("invalid-range", "teacherId cannot be blank.");
  assertDay(window.day);
  validateTimeRange(window.start, window.end);
  assertTimezone(window.timezone);
  parseDate(window.validFrom, "validFrom");
  parseDate(window.validTo, "validTo");
  const effectiveDays = daysBetween(window.validFrom, window.validTo);
  if (effectiveDays < 0 || effectiveDays > MAX_EFFECTIVE_DAYS) {
    fail(
      "invalid-range",
      `Availability ${window.id} must have a bounded effective range of at most ${MAX_EFFECTIVE_DAYS + 1} days.`,
    );
  }

  const exclusionDates = new Set<string>();
  window.excludedDates.forEach((date) => {
    parseDate(date, "excluded date");
    if (date < window.validFrom || date > window.validTo || weekday(date) !== window.day) {
      fail("invalid-date", `Excluded date ${date} is not an occurrence of ${window.id}.`);
    }
    if (exclusionDates.has(date)) {
      fail("duplicate-id", `Excluded date ${date} is duplicated on ${window.id}.`);
    }
    exclusionDates.add(date);
  });

  const overrideDates = new Set<string>();
  window.overrides.forEach((override) => {
    if (!override.id.trim()) fail("duplicate-id", "Override id cannot be blank.");
    parseDate(override.date, "override date");
    validateTimeRange(override.start, override.end);
    if (
      override.date < window.validFrom ||
      override.date > window.validTo ||
      weekday(override.date) !== window.day
    ) {
      fail("invalid-date", `Override date ${override.date} is not an occurrence of ${window.id}.`);
    }
    if (overrideDates.has(override.date)) {
      fail("duplicate-id", `Override date ${override.date} is duplicated on ${window.id}.`);
    }
    if (exclusionDates.has(override.date)) {
      fail("invalid-date", `${override.date} cannot be both overridden and excluded.`);
    }
    overrideDates.add(override.date);
  });
}

function assertWindowShapes(windows: readonly TeacherAvailabilityWindow[]): void {
  const ids = new Set<string>();
  windows.forEach((window) => {
    assertWindowShape(window);
    for (const id of [window.id, ...window.overrides.map((override) => override.id)]) {
      if (ids.has(id)) fail("duplicate-id", `Availability id ${id} is duplicated.`);
      ids.add(id);
    }
  });
}

function occurrenceFor(
  window: TeacherAvailabilityWindow,
  sourceDate: string,
  displayTimezone: string,
): TeacherAvailabilityOccurrence | null {
  if (
    sourceDate < window.validFrom ||
    sourceDate > window.validTo ||
    weekday(sourceDate) !== window.day ||
    window.excludedDates.includes(sourceDate)
  ) {
    return null;
  }

  const override = window.overrides.find((entry) => entry.date === sourceDate);
  const start = override?.start ?? window.start;
  const end = override?.end ?? window.end;
  const sourceEndDate = parseTime(end) < parseTime(start) ? shiftDate(sourceDate, 1) : sourceDate;
  const startsAt = localTimeToInstant(sourceDate, start, window.timezone, "earlier");
  const endsAt = localTimeToInstant(sourceEndDate, end, window.timezone, "later");
  if (endsAt.getTime() <= startsAt.getTime()) {
    fail("invalid-time", `Availability ${window.id} does not end after it starts.`);
  }
  const displayStart = displayParts(startsAt, displayTimezone);
  const displayEnd = displayParts(endsAt, displayTimezone);

  return {
    id: override?.id ?? `${window.id}@${sourceDate}`,
    windowId: window.id,
    teacherId: window.teacherId,
    sourceDate,
    sourceStart: start,
    sourceEndDate,
    sourceEnd: end,
    sourceTimezone: window.timezone,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    displayStartDate: displayStart.date,
    displayStart: displayStart.time,
    displayEndDate: displayEnd.date,
    displayEnd: displayEnd.time,
    displayTimezone,
    isOverride: Boolean(override),
  };
}

function expandInternal(
  windows: readonly TeacherAvailabilityWindow[],
  from: string | undefined,
  to: string | undefined,
  displayTimezone: string,
): TeacherAvailabilityOccurrence[] {
  const occurrences: TeacherAvailabilityOccurrence[] = [];
  windows.forEach((window) => {
    const first = from && from > window.validFrom ? from : window.validFrom;
    const last = to && to < window.validTo ? to : window.validTo;
    if (first > last) return;
    for (let date = first; date <= last; date = shiftDate(date, 1)) {
      const occurrence = occurrenceFor(window, date, displayTimezone);
      if (occurrence) occurrences.push(occurrence);
    }
  });
  return occurrences.sort(
    (left, right) =>
      left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id),
  );
}

function assertOccurrenceOverlaps(occurrences: readonly TeacherAvailabilityOccurrence[]): void {
  const byTeacher = new Map<string, TeacherAvailabilityOccurrence[]>();
  occurrences.forEach((occurrence) => {
    const bucket = byTeacher.get(occurrence.teacherId) ?? [];
    bucket.push(occurrence);
    byTeacher.set(occurrence.teacherId, bucket);
  });

  byTeacher.forEach((entries) => {
    const sorted = [...entries].sort(
      (left, right) =>
        left.startsAt.localeCompare(right.startsAt) || left.endsAt.localeCompare(right.endsAt),
    );
    let active: TeacherAvailabilityOccurrence | undefined;
    sorted.forEach((entry) => {
      if (active && entry.startsAt < active.endsAt) {
        fail("overlap", `${active.id} overlaps ${entry.id}.`);
      }
      if (!active || entry.endsAt > active.endsAt) active = entry;
    });
  });
}

export function assertValidTeacherAvailability(
  windows: readonly TeacherAvailabilityWindow[],
): void {
  assertWindowShapes(windows);
  const occurrences = expandInternal(windows, undefined, undefined, "UTC");
  assertOccurrenceOverlaps(occurrences);
}

export function expandTeacherAvailability(
  windows: readonly TeacherAvailabilityWindow[],
  options: { from: string; to: string; displayTimezone: string },
): TeacherAvailabilityOccurrence[] {
  parseDate(options.from, "from");
  parseDate(options.to, "to");
  if (options.from > options.to) fail("invalid-range", "from must be on or before to.");
  assertTimezone(options.displayTimezone);
  assertWindowShapes(windows);
  const occurrences = expandInternal(
    windows,
    options.from,
    options.to,
    options.displayTimezone,
  );
  assertOccurrenceOverlaps(occurrences);
  return occurrences;
}

export function createMonthlyAvailabilityWindows(input: {
  teacherId: string;
  month: string;
  timezone: string;
  slots: readonly AvailabilitySlotInput[];
  idSeed: string;
  source?: AvailabilitySource;
  sourceSubmissionId?: string;
}): TeacherAvailabilityWindow[] {
  if (!input.teacherId.trim()) fail("invalid-range", "teacherId cannot be blank.");
  if (!input.idSeed.trim()) fail("invalid-range", "idSeed cannot be blank.");
  assertTimezone(input.timezone);
  assertValidAvailabilitySlots(input.slots);
  const range = parseMonth(input.month);
  const windows = input.slots.map((slot) => ({
    id: `ava_${stableHash(
      `${input.teacherId}|${input.month}|${input.idSeed}|${slot.id ?? canonicalSlot(slot)}`,
    )}`,
    teacherId: input.teacherId,
    day: slot.day,
    start: slot.start,
    end: slot.end,
    timezone: input.timezone,
    validFrom: range.start,
    validTo: range.end,
    excludedDates: [],
    overrides: [],
    source: input.source ?? "manual",
    ...(input.sourceSubmissionId
      ? { sourceSubmissionId: input.sourceSubmissionId }
      : {}),
  } satisfies TeacherAvailabilityWindow));
  assertValidTeacherAvailability(windows);
  return sortWindows(windows);
}

export function normalizeLegacyAvailability(
  teacherId: string,
  timezone: string,
  slots: readonly AvailabilitySlotInput[],
): LegacyAvailabilityTemplate {
  if (!teacherId.trim()) fail("invalid-range", "teacherId cannot be blank.");
  assertTimezone(timezone);
  assertValidAvailabilitySlots(slots);
  return {
    kind: "legacy-weekly-template",
    teacherId,
    timezone,
    monthlyConfirmed: false,
    slots: slots.map((slot) => ({
      id: slot.id ?? `legacy_${stableHash(`${teacherId}|${timezone}|${canonicalSlot(slot)}`)}`,
      day: slot.day,
      start: slot.start,
      end: slot.end,
    })),
  };
}

/** Explicit opt-in is required before legacy weekly data becomes month-scoped. */
export function promoteLegacyAvailabilityForMonth(
  template: LegacyAvailabilityTemplate,
  month: string,
): TeacherAvailabilityWindow[] {
  if (template.kind !== "legacy-weekly-template" || template.monthlyConfirmed !== false) {
    fail("invalid-range", "Only an explicit legacy weekly template can be promoted.");
  }
  return createMonthlyAvailabilityWindows({
    teacherId: template.teacherId,
    month,
    timezone: template.timezone,
    slots: template.slots,
    idSeed: `legacy|${month}`,
    source: "legacy-promoted",
  });
}

function cloneWindowForRange(
  window: TeacherAvailabilityWindow,
  validFrom: string,
  validTo: string,
  id: string,
): TeacherAvailabilityWindow {
  return {
    ...window,
    id,
    validFrom,
    validTo,
    excludedDates: window.excludedDates.filter(
      (date) => date >= validFrom && date <= validTo,
    ),
    overrides: window.overrides
      .filter((override) => override.date >= validFrom && override.date <= validTo)
      .map((override) => ({ ...override })),
  };
}

function retainOutsideMonth(
  window: TeacherAvailabilityWindow,
  month: string,
  monthStart: string,
  monthEnd: string,
): TeacherAvailabilityWindow[] {
  if (window.validTo < monthStart || window.validFrom > monthEnd) {
    return [cloneWindowForRange(window, window.validFrom, window.validTo, window.id)];
  }

  const pieces: TeacherAvailabilityWindow[] = [];
  if (window.validFrom < monthStart) {
    pieces.push(
      cloneWindowForRange(window, window.validFrom, shiftDate(monthStart, -1), window.id),
    );
  }
  if (window.validTo > monthEnd) {
    const afterId = pieces.length > 0 ? `${window.id}:after:${month}` : window.id;
    pieces.push(cloneWindowForRange(window, shiftDate(monthEnd, 1), window.validTo, afterId));
  }
  return pieces;
}

function sortWindows(
  windows: readonly TeacherAvailabilityWindow[],
): TeacherAvailabilityWindow[] {
  return [...windows].sort(
    (left, right) =>
      left.teacherId.localeCompare(right.teacherId) ||
      left.validFrom.localeCompare(right.validFrom) ||
      left.day - right.day ||
      left.start.localeCompare(right.start) ||
      left.id.localeCompare(right.id),
  );
}

/** Pure approval/writeback: replace one teacher-month and retain every other date. */
export function approveTeacherAvailabilitySubmission(
  existing: readonly TeacherAvailabilityWindow[],
  submission: TeacherAvailabilitySubmission,
): TeacherAvailabilityWindow[] {
  if (!submission.id.trim()) fail("invalid-range", "submission id cannot be blank.");
  const range = parseMonth(submission.month);
  const retained = existing.flatMap((window) =>
    window.teacherId === submission.teacherId
      ? retainOutsideMonth(window, submission.month, range.start, range.end)
      : [cloneWindowForRange(window, window.validFrom, window.validTo, window.id)],
  );
  const approved = createMonthlyAvailabilityWindows({
    teacherId: submission.teacherId,
    month: submission.month,
    timezone: submission.timezone,
    slots: submission.slots,
    idSeed: submission.id,
    source: "submission",
    sourceSubmissionId: submission.id,
  });
  const result = sortWindows([...retained, ...approved]);
  assertValidTeacherAvailability(result);
  return result;
}

function replaceWindow(
  windows: readonly TeacherAvailabilityWindow[],
  replacement: TeacherAvailabilityWindow,
): TeacherAvailabilityWindow[] {
  return windows.map((window) => (window.id === replacement.id ? replacement : window));
}

export function editAvailabilityDate(
  windows: readonly TeacherAvailabilityWindow[],
  input: { windowId: string; date: string; start: string; end: string },
): TeacherAvailabilityWindow[] {
  parseDate(input.date);
  validateTimeRange(input.start, input.end);
  const target = windows.find((window) => window.id === input.windowId);
  if (!target) fail("missing-window", `Availability ${input.windowId} was not found.`);
  if (
    input.date < target.validFrom ||
    input.date > target.validTo ||
    weekday(input.date) !== target.day
  ) {
    fail("invalid-date", `${input.date} is not an occurrence of ${target.id}.`);
  }

  const currentOverride = target.overrides.find((override) => override.date === input.date);
  const replacement: TeacherAvailabilityWindow = {
    ...target,
    excludedDates: target.excludedDates.filter((date) => date !== input.date),
    overrides: [
      ...target.overrides.filter((override) => override.date !== input.date),
      {
        id: currentOverride?.id ?? `${target.id}:override:${input.date}`,
        date: input.date,
        start: input.start,
        end: input.end,
      },
    ].sort((left, right) => left.date.localeCompare(right.date)),
  };
  const result = replaceWindow(windows, replacement);
  assertValidTeacherAvailability(result);
  return sortWindows(result);
}

export function deleteAvailabilityDate(
  windows: readonly TeacherAvailabilityWindow[],
  input: { windowId: string; date: string },
): TeacherAvailabilityWindow[] {
  parseDate(input.date);
  const target = windows.find((window) => window.id === input.windowId);
  if (!target) fail("missing-window", `Availability ${input.windowId} was not found.`);
  if (
    input.date < target.validFrom ||
    input.date > target.validTo ||
    weekday(input.date) !== target.day
  ) {
    fail("invalid-date", `${input.date} is not an occurrence of ${target.id}.`);
  }
  const replacement: TeacherAvailabilityWindow = {
    ...target,
    excludedDates: [...new Set([...target.excludedDates, input.date])].sort(),
    overrides: target.overrides.filter((override) => override.date !== input.date),
  };
  const result = replaceWindow(windows, replacement);
  assertValidTeacherAvailability(result);
  return sortWindows(result);
}

function mondayOfWeek(date: string): string {
  const offset = (weekday(date) + 6) % 7;
  return shiftDate(date, -offset);
}

export function deleteAvailabilityWeek(
  windows: readonly TeacherAvailabilityWindow[],
  input: { teacherId: string; weekOf: string },
): TeacherAvailabilityWindow[] {
  parseDate(input.weekOf, "weekOf");
  const monday = mondayOfWeek(input.weekOf);
  const sunday = shiftDate(monday, 6);
  const result = windows.map((window) => {
    if (window.teacherId !== input.teacherId) return window;
    const dates = new Set(window.excludedDates);
    for (let date = monday; date <= sunday; date = shiftDate(date, 1)) {
      if (
        date >= window.validFrom &&
        date <= window.validTo &&
        weekday(date) === window.day
      ) {
        dates.add(date);
      }
    }
    return {
      ...window,
      excludedDates: [...dates].sort(),
      overrides: window.overrides.filter(
        (override) => override.date < monday || override.date > sunday,
      ),
    };
  });
  assertValidTeacherAvailability(result);
  return sortWindows(result);
}

export function deleteAllTeacherAvailability(
  windows: readonly TeacherAvailabilityWindow[],
  teacherId: string,
): TeacherAvailabilityWindow[] {
  const result = windows
    .filter((window) => window.teacherId !== teacherId)
    .map((window) => cloneWindowForRange(window, window.validFrom, window.validTo, window.id));
  assertValidTeacherAvailability(result);
  return sortWindows(result);
}
