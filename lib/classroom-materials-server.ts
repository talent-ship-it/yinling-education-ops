import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { BigBlueButtonError, meetingIdForOccurrence, meetingStatus } from "@/lib/bigbluebutton";
import { ClassroomMaterialsError, materialRecord } from "@/lib/classroom-materials";
import { DEMO_COOKIE_NAME, getCurrentDemoSession, type DemoSessionIdentity } from "@/lib/demo-auth";
import { materialsMeetingBooking, materialsMeetingInput, materialsMeetingOccurrence, requireMaterialsMeetingOpen } from "@/lib/classroom-materials-meeting";
import { buildOpsAccessContext } from "@/lib/ops-access";
import { getOpsState, readClassroomEndRequests } from "@/lib/ops-store";

export function materialsResponse(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function materialsErrorResponse(error: unknown) {
  if (error instanceof ClassroomMaterialsError || error instanceof BigBlueButtonError) {
    return materialsResponse({ error: error.message, code: error.code }, error.status);
  }
  return materialsResponse({ error: "资料库操作失败，请稍后重试。", code: "materials_failed" }, 500);
}

function requireMaterialsSession(resolved: Awaited<ReturnType<typeof getCurrentDemoSession>>) {
  if (!("session" in resolved)) throw new ClassroomMaterialsError("请先登录账号。", "materials_unauthorized", 401);
  const { session } = resolved;
  if (!session.accountId) throw new ClassroomMaterialsError("请先登录账号。", "materials_unauthorized", 401);
  if (!["admin", "limited-admin", "teacher"].includes(session.role)) throw new ClassroomMaterialsError("当前账号无权访问教学资料。", "materials_forbidden", 403);
  return session as DemoSessionIdentity & { accountId: string };
}

export async function materialsSession(): Promise<DemoSessionIdentity & { accountId: string }> {
  const cookieStore = await cookies();
  return requireMaterialsSession(await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value));
}

export async function materialsBody(request: Request) {
  if (Number(request.headers.get("content-length")) > 64 * 1024) throw new ClassroomMaterialsError("资料请求过大。", "materials_invalid_input", 413);
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

export async function authorizedMaterialsMeeting(session: DemoSessionIdentity, body: Record<string, unknown>) {
  if (session.role !== "teacher") throw new ClassroomMaterialsError("请使用本节课教师账号打开教材。", "materials_forbidden", 403);
  const input = materialsMeetingInput(body);
  const state = await getOpsState(["students", "teachers", "bookings"]);
  const access = buildOpsAccessContext(state, session.user, false, session);
  const booking = materialsMeetingBooking(state, access, input.bookingId);
  const occurrence = materialsMeetingOccurrence(booking, access, input);
  requireMaterialsMeetingOpen(booking, occurrence, input.occurrenceId);
  if ((await readClassroomEndRequests(input.occurrenceId)).length > 0) {
    throw new ClassroomMaterialsError("这节课尚未开放、正在结束或已经结束。", "materials_classroom_unavailable", 409);
  }
  const meetingId = meetingIdForOccurrence(input.occurrenceId);
  if (!(await meetingStatus(meetingId)).running) throw new ClassroomMaterialsError("请先进入正在进行的课堂。", "materials_classroom_not_running", 409);
  return meetingId;
}
