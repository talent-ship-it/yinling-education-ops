/** Shared recurrence contract for booking series and occurrence expansion. */
export const BOOKING_RECURRENCE_INTERVAL_MIN_DAYS = 1;
export const BOOKING_RECURRENCE_INTERVAL_MAX_DAYS = 365;
export const BOOKING_REPEAT_COUNT_MIN = 1;
export const BOOKING_REPEAT_COUNT_MAX = 104;
export const LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS = 7;

export type BookingRecurrenceFrequency =
  | "single" | "daily" | "every_other_day" | "everyOtherDay" | "weekly" | "biweekly" | "custom";

export type BookingRecurrenceInput = Readonly<{
  /** Series start date, supplied by callers that need end-date ordering validation. */
  startDate?: string;
  recurring?: boolean;
  repeatCount?: number;
  recurrenceIntervalDays?: number;
  recurrenceEndDate?: string;
}>;

export type NormalizedBookingRecurrence = Readonly<{
  recurring: boolean;
  repeatCount: number;
  recurrenceIntervalDays?: number;
  recurrenceEndDate?: string;
}>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, field: string) {
  if (!DATE_PATTERN.test(value)) throw new RangeError(`${field} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} must be a valid calendar date`);
  }
}

export function shiftBookingDate(date: string, days: number) {
  assertDate(date, "date");
  if (!Number.isSafeInteger(days)) throw new RangeError("days must be an integer");
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function recurrenceIntervalForFrequency(frequency: BookingRecurrenceFrequency, customIntervalDays?: number) {
  const interval = frequency === "single" ? undefined
    : frequency === "daily" ? 1
      : frequency === "every_other_day" || frequency === "everyOtherDay" ? 2
        : frequency === "weekly" ? 7
          : frequency === "biweekly" ? 14 : customIntervalDays;
  if (frequency === "single") return undefined;
  if (typeof interval !== "number" || !Number.isSafeInteger(interval)
    || interval < BOOKING_RECURRENCE_INTERVAL_MIN_DAYS
    || interval > BOOKING_RECURRENCE_INTERVAL_MAX_DAYS) {
    throw new RangeError("recurrenceIntervalDays must be an integer from 1 to 365");
  }
  return interval;
}

export function normalizeBookingRecurrence(input: BookingRecurrenceInput): NormalizedBookingRecurrence {
  if (input.startDate !== undefined) assertDate(input.startDate, "startDate");
  if (input.recurring !== true) {
    if (input.repeatCount !== undefined && input.repeatCount !== 1) {
      throw new RangeError("non-recurring bookings must have repeatCount 1");
    }
    if (input.recurrenceEndDate !== undefined) {
      assertDate(input.recurrenceEndDate, "recurrenceEndDate");
      if (input.startDate !== undefined && input.recurrenceEndDate < input.startDate) {
        throw new RangeError("recurrenceEndDate must be on or after the booking date");
      }
    }
    return { recurring: false, repeatCount: 1 };
  }
  const interval = input.recurrenceIntervalDays ?? LEGACY_BOOKING_RECURRENCE_INTERVAL_DAYS;
  const count = input.repeatCount;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 365) {
    throw new RangeError("recurrenceIntervalDays must be an integer from 1 to 365");
  }
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1 || count > 104)) {
    throw new RangeError("repeatCount must be an integer from 1 to 104");
  }
  if (input.recurrenceEndDate !== undefined) {
    assertDate(input.recurrenceEndDate, "recurrenceEndDate");
    if (input.startDate !== undefined && input.recurrenceEndDate < input.startDate) {
      throw new RangeError("recurrenceEndDate must be on or after the booking date");
    }
  }
  return {
    recurring: true,
    // Count-less legacy rows remain expandable by their caller's range.
    repeatCount: count ?? 104,
    recurrenceIntervalDays: interval,
    ...(input.recurrenceEndDate ? { recurrenceEndDate: input.recurrenceEndDate } : {}),
  };
}

export const validateBookingRecurrence = normalizeBookingRecurrence;

/**
 * Returns the authoritative last source date for a series.  Count and an
 * explicit end date are both upper bounds; the earlier one wins.  A legacy
 * count-less series remains unbounded for calendar/read projections, while a
 * finite end date is enough to make it safe for server mutations.
 */
export function recurrenceSourceEndDate(input: BookingRecurrenceInput & { startDate: string }) {
  const normalized = normalizeBookingRecurrence(input);
  if (!normalized.recurring) return input.startDate;
  const interval = normalized.recurrenceIntervalDays!;
  const byCount = input.repeatCount !== undefined
    ? shiftBookingDate(input.startDate, (input.repeatCount - 1) * interval)
    : undefined;
  const byDate = input.recurrenceEndDate;
  if (byCount && byDate) return byCount < byDate ? byCount : byDate;
  return byCount ?? byDate;
}

/** Number of source occurrences through the authoritative end date. */
export function recurrenceOccurrenceCount(input: BookingRecurrenceInput & { startDate: string }) {
  const normalized = normalizeBookingRecurrence(input);
  const endDate = recurrenceSourceEndDate(input);
  if (!endDate) return undefined;
  if (!normalized.recurring) return 1;
  const interval = normalized.recurrenceIntervalDays!;
  const startMs = Date.parse(`${input.startDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.floor((endMs - startMs) / 86_400_000 / interval) + 1;
}
