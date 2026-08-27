type BookingTeacherScopeRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): BookingTeacherScopeRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as BookingTeacherScopeRecord
    : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function owns(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Returns whether a booking series contains at least one occurrence whose
 * effective teacher is in `teacherIds`. Occurrence overrides are authoritative:
 * a one-off lesson moved to a substitute no longer belongs to the parent
 * teacher, while a recurring parent series still has unoverridden occurrences.
 */
export function bookingHasEffectiveTeacher(
  bookingValue: unknown,
  teacherIds: ReadonlySet<string>,
) {
  const booking = record(bookingValue);
  if (!booking || teacherIds.size === 0) return false;

  const overrides = Array.isArray(booking.occurrenceOverrides)
    ? booking.occurrenceOverrides.map(record).filter((value): value is BookingTeacherScopeRecord => value !== null)
    : [];
  if (overrides.some((override) => teacherIds.has(text(override.teacherId)))) return true;

  const parentTeacherId = text(booking.teacherId);
  if (!teacherIds.has(parentTeacherId)) return false;
  if (booking.recurring === true) return true;

  const bookingId = text(booking.id);
  const sourceDate = text(booking.date);
  if (!bookingId || !/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) return true;
  const baseOverride = overrides.find((override) => text(override.occurrenceId) === `${bookingId}:${sourceDate}`);
  return !baseOverride || !owns(baseOverride, "teacherId");
}
