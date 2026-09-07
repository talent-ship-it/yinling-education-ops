import { expandLessonOccurrences, lessonOccurrenceSourceRangeForTargetRange, type LegacyLessonSeries, type LessonOccurrenceOverride } from "./lesson-occurrences";
import { localTimeToInstant } from "./teacher-availability";
import { cleanTimezone } from "./timezone";
export type ProvisionBooking = LegacyLessonSeries & { timezone?: string; kind?: string; occurrenceOverrides?: LessonOccurrenceOverride[] };
export function classroomProvisionPlan(bookings: readonly ProvisionBooking[], now: Date) {
  const start = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  return bookings.flatMap((booking) => {
    if (!booking.recurring && booking.status === "已完成") return [];
    const range = lessonOccurrenceSourceRangeForTargetRange(start, end, booking.occurrenceOverrides);
    try {
      return expandLessonOccurrences(booking, { ...range, overrides: booking.occurrenceOverrides }).flatMap((occurrence) => {
        if (occurrence.status !== "confirmed" || !occurrence.studentId || !occurrence.teacherId || booking.occurrenceOverrides?.some((item) => item.occurrenceId === occurrence.occurrenceId && item.classroom?.status === "ended")) return [];
        const startsAt = localTimeToInstant(occurrence.date, occurrence.start, cleanTimezone(booking.timezone), "earlier").getTime();
        // Provision just before the entry window, while retries remain useful.
        if (startsAt - now.getTime() > 20 * 60000 || startsAt < now.getTime()) return [];
        return [{ occurrence, booking, startsAt }];
      });
    } catch { return []; }
  }).sort((a, b) => a.startsAt - b.startsAt);
}
