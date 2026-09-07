import { NextRequest, NextResponse } from "next/server";
import { verifyClassroomEntry, classroomEntryOpen } from "@/lib/classroom-entry";
import { createJoinUrl, createMeeting, meetingIdForOccurrence } from "@/lib/bigbluebutton";
import { getOpsState } from "@/lib/ops-store";
import { expandLessonOccurrences, type LegacyLessonSeries, type LessonOccurrenceOverride } from "@/lib/lesson-occurrences";
import { localTimeToInstant } from "@/lib/teacher-availability";
import { cleanTimezone } from "@/lib/timezone";
export const dynamic = "force-dynamic";
function message(text: string, status: number) {
  return new NextResponse(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
}
export async function GET(request: NextRequest) {
  try {
    const entry = verifyClassroomEntry(request.nextUrl.searchParams.get("token") ?? "");
    if (!entry) return message("链接无效，请联系教务重新获取。", 403);
    const sourceDate = entry.occurrenceId.slice(-10);
    const bookingId = entry.occurrenceId.slice(0, -11);
    const rows = await getOpsState(["bookings", "students"]);
    const bookings = rows.find((row) => row.entity === "bookings")?.payload as Array<LegacyLessonSeries & { timezone?: string; occurrenceOverrides?: LessonOccurrenceOverride[] }>;
    const students = rows.find((row) => row.entity === "students")?.payload as Array<{ id: string; name: string; importArchived?: boolean }>;
    const booking = bookings?.find((item) => item.id === bookingId);
    const student = students?.find((item) => item.id === entry.studentId && !item.importArchived);
    if (!booking || !student) return message("课程已更新，请联系教务重新获取链接。", 409);
    const occurrence = expandLessonOccurrences(booking, { rangeStart: sourceDate, rangeEnd: sourceDate, overrides: booking.occurrenceOverrides }).find((item) => item.occurrenceId === entry.occurrenceId);
    const override = booking.occurrenceOverrides?.find((item) => item.occurrenceId === entry.occurrenceId);
    if (!occurrence || occurrence.status !== "confirmed" || override?.classroom?.status === "ended" || (!booking.recurring && booking.status === "已完成") || occurrence.studentId !== entry.studentId || occurrence.teacherId !== entry.teacherId || occurrence.date !== entry.date || occurrence.start !== entry.start || occurrence.scheduledDurationMinutes !== entry.duration || cleanTimezone(booking.timezone) !== entry.timezone) return message("课程已调整或结束，请联系教务重新获取链接。", 409);
    const startsAt = localTimeToInstant(entry.date, entry.start, entry.timezone, "earlier").getTime();
    if (!classroomEntryOpen(startsAt, entry.duration)) return message("教室在课前 15 分钟开放；课程结束后链接失效。请在开放时间重新打开此链接。", 409);
    const meetingId = meetingIdForOccurrence(entry.occurrenceId);
    await createMeeting({ meetingId, name: `${student.name} · ${booking.course ?? "在线课堂"}`, durationMinutes: entry.duration, logoutUrl: request.nextUrl.origin, occurrenceId: entry.occurrenceId, bookingId, studentId: entry.studentId, teacherId: entry.teacherId });
    return new NextResponse(null, { status: 302, headers: { Location: createJoinUrl({ meetingId, fullName: student.name, role: "VIEWER", userId: student.id }), "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  } catch { return message("暂时无法进入课堂，请稍后重试或联系教务。", 503); }
}
