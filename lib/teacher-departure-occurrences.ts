import {
  expandLessonOccurrences,
  type LegacyLessonSeries,
  type LessonOccurrence,
  type LessonOccurrenceOverride,
} from "./lesson-occurrences";
import { recurrenceSourceEndDate } from "./booking-recurrence";

export type TeacherDepartureBooking = LegacyLessonSeries & Readonly<{
  kind?: string;
  occurrenceOverrides?: readonly LessonOccurrenceOverride[];
}>;

export type ProjectedTeacherDepartureOccurrence<Booking extends TeacherDepartureBooking> = Readonly<{
  booking: Booking;
  occurrence: LessonOccurrence;
}>;

export class TeacherDepartureProjectionError extends Error {
  constructor(
    readonly code: "invalid_effective_date" | "invalid_booking" | "unbounded_future_series",
    message: string,
  ) {
    super(message);
    this.name = "TeacherDepartureProjectionError";
  }
}

function validCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function overrideRelationshipMatches(
  booking: TeacherDepartureBooking,
  teacherId: string,
  studentId?: string,
) {
  return (booking.occurrenceOverrides ?? []).some((override) => {
    const resolvedTeacherId = Object.prototype.hasOwnProperty.call(override, "teacherId")
      ? override.teacherId
      : booking.teacherId;
    const resolvedStudentId = Object.prototype.hasOwnProperty.call(override, "studentId")
      ? override.studentId
      : booking.studentId;
    return resolvedTeacherId === teacherId && (!studentId || resolvedStudentId === studentId);
  });
}

/**
 * Projects every confirmed, finite lesson taught by a departing teacher from
 * the effective date onward. The projection deliberately rejects a matching
 * count-less legacy series: silently choosing an arbitrary horizon could omit
 * students from a permanent handover.
 */
export function projectTeacherDepartureOccurrences<Booking extends TeacherDepartureBooking>(input: {
  bookings: readonly Booking[];
  teacherId: string;
  effectiveDate: string;
  studentId?: string;
}): ProjectedTeacherDepartureOccurrence<Booking>[] {
  if (!input.teacherId.trim()) {
    throw new TeacherDepartureProjectionError("invalid_booking", "离职老师不能为空。");
  }
  if (!validCalendarDate(input.effectiveDate)) {
    throw new TeacherDepartureProjectionError("invalid_effective_date", "离职生效日期无效。");
  }

  const projected: ProjectedTeacherDepartureOccurrence<Booking>[] = [];
  for (const booking of input.bookings) {
    if (booking.kind === "代课") continue;
    const canContainTeacher = (
      booking.teacherId === input.teacherId
      && (!input.studentId || booking.studentId === input.studentId)
    ) || overrideRelationshipMatches(booking, input.teacherId, input.studentId);
    if (!canContainTeacher) continue;

    let sourceEnd: string | undefined;
    try {
      sourceEnd = recurrenceSourceEndDate({
        startDate: booking.date,
        recurring: booking.recurring === true,
        ...(Number.isSafeInteger(booking.repeatCount) ? { repeatCount: booking.repeatCount as number } : {}),
        ...(typeof booking.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
        ...(typeof booking.recurrenceEndDate === "string" ? { recurrenceEndDate: booking.recurrenceEndDate } : {}),
      });
    } catch (error) {
      throw new TeacherDepartureProjectionError(
        "invalid_booking",
        error instanceof Error ? error.message : "循环课结束范围无效。",
      );
    }
    if (!sourceEnd) {
      throw new TeacherDepartureProjectionError(
        "unbounded_future_series",
        "永久换师不能自动处理没有结束次数或结束日期的旧循环课，请先编辑整个课程系列并限定范围（repeatCount 需为 1-104，或填写结束日期）。",
      );
    }
    let occurrences: LessonOccurrence[];
    try {
      occurrences = expandLessonOccurrences(booking, {
        rangeStart: booking.date,
        rangeEnd: sourceEnd,
        overrides: booking.occurrenceOverrides,
      });
    } catch (error) {
      throw new TeacherDepartureProjectionError(
        "invalid_booking",
        error instanceof Error ? error.message : "课程系列数据无效。",
      );
    }
    for (const occurrence of occurrences) {
      if (occurrence.date < input.effectiveDate
        || occurrence.status !== "confirmed"
        || occurrence.teacherId !== input.teacherId
        || (input.studentId && occurrence.studentId !== input.studentId)) continue;
      projected.push({ booking, occurrence });
    }
  }

  return projected.sort((left, right) =>
    left.occurrence.date.localeCompare(right.occurrence.date)
    || left.occurrence.start.localeCompare(right.occurrence.start)
    || left.occurrence.occurrenceId.localeCompare(right.occurrence.occurrenceId),
  );
}
