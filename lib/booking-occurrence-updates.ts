import {
  expandLessonOccurrences,
  type LegacyLessonSeries,
  type LessonOccurrenceOverride,
  type LessonOccurrenceStatus,
} from "./lesson-occurrences";

export type BookingWithOccurrenceOverrides = LegacyLessonSeries & Readonly<{
  occurrenceOverrides?: readonly LessonOccurrenceOverride[];
}>;

export type OccurrenceMutation = Readonly<{
  occurrenceId: string;
  status?: LessonOccurrenceStatus;
  date?: string;
  start?: string;
  durationMinutes?: number;
  teacherId?: string | null;
  studentId?: string | null;
  packageId?: string | null;
  subjectId?: string | null;
  classroom?: LessonOccurrenceOverride["classroom"];
}>;

export type OperationOccurrenceChange = Readonly<{
  sourceTeacherId: string;
  studentId?: string;
  rangeStart: string;
  rangeEnd: string;
  action: "leave" | "substitute";
  substituteTeacherId?: string;
}>;

export type OperationOccurrenceChangeResult<T extends BookingWithOccurrenceOverrides> = Readonly<{
  bookings: readonly T[];
  affectedOccurrenceIds: readonly string[];
}>;

function requireText(value: string | undefined, field: string) {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function sameOverride(left: LessonOccurrenceOverride, right: LessonOccurrenceOverride) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeOverride(
  overrides: readonly LessonOccurrenceOverride[],
  mutation: OccurrenceMutation,
): LessonOccurrenceOverride[] {
  const existing = overrides.find((item) => item.occurrenceId === mutation.occurrenceId);
  const replacement: LessonOccurrenceOverride = {
    ...(existing ?? { occurrenceId: mutation.occurrenceId }),
    ...mutation,
  };
  if (existing && sameOverride(existing, replacement)) return [...overrides];
  return [
    ...overrides.filter((item) => item.occurrenceId !== mutation.occurrenceId),
    replacement,
  ].sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId));
}

/** Applies a single-lesson edit without changing the parent weekly series. */
export function updateBookingOccurrence<T extends BookingWithOccurrenceOverrides>(
  bookings: readonly T[],
  mutation: OccurrenceMutation,
): readonly T[] {
  const separator = mutation.occurrenceId.lastIndexOf(":");
  if (separator <= 0) throw new Error("occurrenceId must contain a series id and source date");
  const seriesId = mutation.occurrenceId.slice(0, separator);
  const sourceDate = mutation.occurrenceId.slice(separator + 1);
  const target = bookings.find((booking) => booking.id === seriesId);
  if (!target) throw new Error(`booking series ${seriesId} was not found`);
  const occurrence = expandLessonOccurrences(target, {
    rangeStart: sourceDate,
    rangeEnd: sourceDate,
    overrides: target.occurrenceOverrides,
  }).find((item) => item.occurrenceId === mutation.occurrenceId);
  if (!occurrence) throw new Error(`occurrence ${mutation.occurrenceId} was not found`);
  return bookings.map((booking) => booking.id === seriesId
    ? { ...booking, occurrenceOverrides: mergeOverride(booking.occurrenceOverrides ?? [], mutation) }
    : booking);
}

/**
 * Converts every affected occurrence in a leave/substitution range into an
 * explicit override. Repeating lessons outside the range remain untouched.
 */
export function applyOperationOccurrenceChange<T extends BookingWithOccurrenceOverrides>(
  bookings: readonly T[],
  input: OperationOccurrenceChange,
): OperationOccurrenceChangeResult<T> {
  const sourceTeacherId = requireText(input.sourceTeacherId, "sourceTeacherId");
  if (input.rangeStart > input.rangeEnd) throw new RangeError("rangeEnd must not be before rangeStart");
  const substituteTeacherId = input.action === "substitute"
    ? requireText(input.substituteTeacherId, "substituteTeacherId")
    : undefined;
  if (substituteTeacherId === sourceTeacherId) {
    throw new Error("substitute teacher must be different from the source teacher");
  }

  let next = [...bookings];
  const affectedOccurrenceIds: string[] = [];
  for (const booking of bookings) {
    if (booking.teacherId !== sourceTeacherId) continue;
    if (input.studentId && booking.studentId !== input.studentId) continue;
    const occurrences = expandLessonOccurrences(booking, {
      rangeStart: input.rangeStart,
      rangeEnd: input.rangeEnd,
      overrides: booking.occurrenceOverrides,
    }).filter((occurrence) => occurrence.status !== "cancelled" && occurrence.status !== "completed");
    for (const occurrence of occurrences) {
      next = [...updateBookingOccurrence(next, input.action === "substitute"
        ? {
            occurrenceId: occurrence.occurrenceId,
            status: "confirmed",
            teacherId: substituteTeacherId,
          }
        : {
            occurrenceId: occurrence.occurrenceId,
            status: "leave",
          })];
      affectedOccurrenceIds.push(occurrence.occurrenceId);
    }
  }
  return { bookings: next, affectedOccurrenceIds: affectedOccurrenceIds.sort() };
}
