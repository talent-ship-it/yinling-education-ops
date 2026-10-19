import { classroomEntryOpen } from "./classroom-entry";
import { ClassroomMaterialsError, materialRecord } from "./classroom-materials";
import { expandLessonOccurrences, type LegacyLessonSeries, type LessonOccurrence, type LessonOccurrenceOverride } from "./lesson-occurrences";
import { canOperateStudent, canWriteOpsEntity, type OpsAccessContext } from "./ops-access";
import type { OpsStateRow } from "./ops-store";
import { cleanTimezone } from "./timezone";

export function materialsMeetingInput(body: Record<string, unknown>) {
  const { bookingId, occurrenceId, sourceDate: suppliedDate } = body;
  if (typeof bookingId !== "string" || bookingId.length > 180 || typeof occurrenceId !== "string" || occurrenceId.length > 240
    || !occurrenceId.startsWith(`${bookingId}:`) || !/^.+:\d{4}-\d{2}-\d{2}$/u.test(occurrenceId)) {
    throw new ClassroomMaterialsError("课次参数无效。", "materials_invalid_input");
  }
  const sourceDate = occurrenceId.slice(-10);
  if (suppliedDate !== undefined && suppliedDate !== sourceDate) throw new ClassroomMaterialsError("课次日期不一致。", "materials_invalid_input");
  return { bookingId, occurrenceId, sourceDate };
}

export function materialsMeetingBooking(state: OpsStateRow[], access: OpsAccessContext, bookingId: string) {
  const bookings = state.find((row) => row.entity === "bookings")?.payload;
  const booking = (Array.isArray(bookings) ? bookings : []).map(materialRecord).find((row) => row.id === bookingId);
  if (!booking || !canWriteOpsEntity(access, "bookings")) throw new ClassroomMaterialsError("当前账号无权操作此课堂。", "materials_forbidden", 403);
  return booking;
}

function materialBookingSeries(booking: Record<string, unknown>, bookingId: string): LegacyLessonSeries {
  return {
    id: bookingId, date: String(booking.date ?? ""), start: String(booking.start ?? ""), duration: Number(booking.duration),
    recurring: booking.recurring === true, studentId: String(booking.studentId ?? ""), teacherId: String(booking.teacherId ?? ""),
    ...(typeof booking.repeatCount === "number" ? { repeatCount: booking.repeatCount } : {}),
    ...(typeof booking.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
    ...(typeof booking.recurrenceEndDate === "string" ? { recurrenceEndDate: booking.recurrenceEndDate } : {}),
  };
}

function materialBookingOverrides(booking: Record<string, unknown>) {
  return (Array.isArray(booking.occurrenceOverrides) ? booking.occurrenceOverrides : []) as LessonOccurrenceOverride[];
}

function requireMaterialsOccurrence(access: OpsAccessContext, occurrence: LessonOccurrence | undefined) {
  if (!occurrence || !access.teacherIds.has(occurrence.teacherId ?? "") || !canOperateStudent(access, occurrence.studentId ?? "")
    || ["cancelled", "leave", "completed", "abnormal"].includes(occurrence.status)) {
    throw new ClassroomMaterialsError("当前账号无权操作此课堂。", "materials_forbidden", 403);
  }
  return occurrence;
}

export function materialsMeetingOccurrence(booking: Record<string, unknown>, access: OpsAccessContext, input: ReturnType<typeof materialsMeetingInput>) {
  let occurrence;
  try {
    occurrence = expandLessonOccurrences(materialBookingSeries(booking, input.bookingId), {
      rangeStart: input.sourceDate, rangeEnd: input.sourceDate, overrides: materialBookingOverrides(booking),
    }).find((row) => row.occurrenceId === input.occurrenceId && row.sourceDate === input.sourceDate);
  } catch { throw new ClassroomMaterialsError("课次参数无效。", "materials_invalid_input"); }
  return requireMaterialsOccurrence(access, occurrence);
}

function lessonStartsAt(date: string, start: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = start.split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  function offset(instant: number) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - instant;
  }
  const first = wallClock - offset(wallClock);
  return wallClock - offset(first);
}

export function requireMaterialsMeetingOpen(booking: Record<string, unknown>, occurrence: LessonOccurrence, occurrenceId: string) {
  const override = materialBookingOverrides(booking).map(materialRecord).find((row) => row.occurrenceId === occurrenceId);
  const classroom = materialRecord(override?.classroom);
  const startsAt = lessonStartsAt(occurrence.date, occurrence.start, cleanTimezone(booking.timezone));
  if (classroom.status === "ended" || (!booking.recurring && materialRecord(booking.classroom).status === "ended")
    || !classroomEntryOpen(startsAt, occurrence.scheduledDurationMinutes)) {
    throw new ClassroomMaterialsError("这节课尚未开放、正在结束或已经结束。", "materials_classroom_unavailable", 409);
  }
}
