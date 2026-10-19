import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { BigBlueButtonError, meetingIdForOccurrence, meetingStatus } from "@/lib/bigbluebutton";
import { classroomEntryOpen } from "@/lib/classroom-entry";
import { ClassroomMaterialsError, materialRecord } from "@/lib/classroom-materials";
import { DEMO_COOKIE_NAME, getCurrentDemoSession, type DemoSessionIdentity } from "@/lib/demo-auth";
import { expandLessonOccurrences, type LegacyLessonSeries, type LessonOccurrenceOverride } from "@/lib/lesson-occurrences";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsEntity } from "@/lib/ops-access";
import { getOpsState, readClassroomEndRequests } from "@/lib/ops-store";
import { cleanTimezone } from "@/lib/timezone";

export function materialsResponse(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function materialsErrorResponse(error: unknown) {
  if (error instanceof ClassroomMaterialsError || error instanceof BigBlueButtonError) {
    return materialsResponse({ error: error.message, code: error.code }, error.status);
  }
  return materialsResponse({ error: "资料库操作失败，请稍后重试。", code: "materials_failed" }, 500);
}

export async function materialsSession(): Promise<DemoSessionIdentity & { accountId: string }> {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved) || !resolved.session.accountId) throw new ClassroomMaterialsError("请先登录账号。", "materials_unauthorized", 401);
  const { session } = resolved;
  if (!["admin", "limited-admin", "teacher"].includes(session.role)) throw new ClassroomMaterialsError("当前账号无权访问教学资料。", "materials_forbidden", 403);
  return session as DemoSessionIdentity & { accountId: string };
}

export async function materialsBody(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > 64 * 1024) throw new ClassroomMaterialsError("资料请求过大。", "materials_invalid_input", 413);
  const text = await request.text();
  if (text.length > 64 * 1024) throw new ClassroomMaterialsError("资料请求过大。", "materials_invalid_input", 413);
  try { return materialRecord(JSON.parse(text)); } catch { throw new ClassroomMaterialsError("资料参数无效。", "materials_invalid_input"); }
}

export function publicMaterial(value: Record<string, unknown>) {
  const material = { ...value };
  delete material.bucketId;
  delete material.objectPath;
  return material;
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

export async function authorizedMaterialsMeeting(session: DemoSessionIdentity, body: Record<string, unknown>) {
  if (session.role !== "teacher") throw new ClassroomMaterialsError("请使用本节课教师账号打开教材。", "materials_forbidden", 403);
  const { bookingId, occurrenceId, sourceDate: suppliedDate } = body;
  if (typeof bookingId !== "string" || bookingId.length > 180 || typeof occurrenceId !== "string" || occurrenceId.length > 240
    || !occurrenceId.startsWith(`${bookingId}:`) || !/^.+:\d{4}-\d{2}-\d{2}$/u.test(occurrenceId)) {
    throw new ClassroomMaterialsError("课次参数无效。", "materials_invalid_input");
  }
  const sourceDate = occurrenceId.slice(-10);
  if (suppliedDate !== undefined && suppliedDate !== sourceDate) throw new ClassroomMaterialsError("课次日期不一致。", "materials_invalid_input");
  const state = await getOpsState(["students", "teachers", "bookings"]);
  const access = buildOpsAccessContext(state, session.user, false, session);
  const bookings = state.find((row) => row.entity === "bookings")?.payload;
  const booking = (Array.isArray(bookings) ? bookings : []).map(materialRecord).find((row) => row.id === bookingId);
  if (!booking || !canWriteOpsEntity(access, "bookings")) throw new ClassroomMaterialsError("当前账号无权操作此课堂。", "materials_forbidden", 403);
  let occurrence;
  try {
    occurrence = expandLessonOccurrences({
      id: bookingId, date: String(booking.date ?? ""), start: String(booking.start ?? ""), duration: Number(booking.duration),
      recurring: booking.recurring === true, studentId: String(booking.studentId ?? ""), teacherId: String(booking.teacherId ?? ""),
      ...(typeof booking.repeatCount === "number" ? { repeatCount: booking.repeatCount } : {}),
      ...(typeof booking.recurrenceIntervalDays === "number" ? { recurrenceIntervalDays: booking.recurrenceIntervalDays } : {}),
      ...(typeof booking.recurrenceEndDate === "string" ? { recurrenceEndDate: booking.recurrenceEndDate } : {}),
    } satisfies LegacyLessonSeries, {
      rangeStart: sourceDate, rangeEnd: sourceDate,
      overrides: (Array.isArray(booking.occurrenceOverrides) ? booking.occurrenceOverrides : []) as LessonOccurrenceOverride[],
    }).find((row) => row.occurrenceId === occurrenceId && row.sourceDate === sourceDate);
  } catch { throw new ClassroomMaterialsError("课次参数无效。", "materials_invalid_input"); }
  if (!occurrence || !access.teacherIds.has(occurrence.teacherId ?? "") || !canOperateStudent(access, occurrence.studentId ?? "")
    || ["cancelled", "leave", "completed", "abnormal"].includes(occurrence.status)) {
    throw new ClassroomMaterialsError("当前账号无权操作此课堂。", "materials_forbidden", 403);
  }
  const override = (Array.isArray(booking.occurrenceOverrides) ? booking.occurrenceOverrides : []).map(materialRecord).find((row) => row.occurrenceId === occurrenceId);
  const classroom = materialRecord(override?.classroom);
  const startsAt = lessonStartsAt(occurrence.date, occurrence.start, cleanTimezone(booking.timezone));
  if (classroom.status === "ended" || (!booking.recurring && materialRecord(booking.classroom).status === "ended")
    || !classroomEntryOpen(startsAt, occurrence.scheduledDurationMinutes) || (await readClassroomEndRequests(occurrenceId)).length > 0) {
    throw new ClassroomMaterialsError("这节课尚未开放、正在结束或已经结束。", "materials_classroom_unavailable", 409);
  }
  const meetingId = meetingIdForOccurrence(occurrenceId);
  if (!(await meetingStatus(meetingId)).running) throw new ClassroomMaterialsError("请先进入正在进行的课堂。", "materials_classroom_not_running", 409);
  return meetingId;
}
