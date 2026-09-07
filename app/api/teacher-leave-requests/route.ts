import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { buildOpsAccessContext, filterOpsStateRows } from "@/lib/ops-access";
import { getOpsState, readTeacherLeaveRequests, submitTeacherLeaveRequest } from "@/lib/ops-store";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
async function context() {
 const store = await cookies();
 const resolved = await getCurrentDemoSession(store.get(DEMO_COOKIE_NAME)?.value);
 if (!("session" in resolved)) return null;
 const session = resolved.session;
 const rows = await getOpsState(["students", "teachers", "bookings"]);
 const access = buildOpsAccessContext(rows, session.user, hasFullAdminAccess(session, store.get(NIXON_COOKIE_NAME)?.value), session);
 const visible = filterOpsStateRows(rows, access);
 const bookings = visible.find((row) => row.entity === "bookings")?.payload as Array<{ teacherId: string; occurrenceOverrides?: Array<{ teacherId?: string }> }>;
 const teachers = visible.find((row) => row.entity === "teachers")?.payload as Array<{ id: string; name: string }>;
 const related = new Set((bookings ?? []).flatMap((item) => [item.teacherId, ...(item.occurrenceOverrides ?? []).map((override) => override.teacherId)]));
 const ids = session.role === "teacher" ? [...access.teacherIds] : (teachers ?? []).filter((teacher) => access.fullAdmin || access.limitedAdmin || related.has(teacher.id)).map((teacher) => teacher.id);
 return { session, ids, teachers: teachers ?? [] };
}
export async function GET() {
 try {
  const ctx = await context();
  if (!ctx) return reply({ error: "请先登录。" }, 401);
  const rows = await readTeacherLeaveRequests(ctx.ids);
  return reply({ requests: rows.map((row) => ({ ...row, teacherName: ctx.teachers.find((teacher) => teacher.id === row.teacher_id)?.name ?? "老师" })) });
 } catch { return reply({ error: "暂时无法读取请假申请。" }, 503); }
}
export async function POST(request: Request) {
 try {
  const ctx = await context();
  if (!ctx) return reply({ error: "请先登录。" }, 401);
  if (ctx.session.role !== "teacher") return reply({ error: "请假申请由老师本人提交。" }, 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Object.keys(body).some((key) => !["id", "teacherId", "start", "end", "reason"].includes(key)) || !ctx.ids.includes(body.teacherId)) return reply({ error: "只能为本人提交申请。" }, 403);
  if (typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id) || typeof body.start !== "string" || typeof body.end !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.start) || !/^\d{4}-\d{2}-\d{2}$/.test(body.end) || body.end < body.start || typeof body.reason !== "string" || body.reason.trim().length < 8 || body.reason.trim().length > 1000) return reply({ error: "请填写有效日期及 8–1000 字的请假原因。" }, 400);
  const id = await submitTeacherLeaveRequest({ id: body.id, teacherId: body.teacherId, actor: ctx.session.user, start: body.start, end: body.end, reason: body.reason.trim() });
  return reply({ id });
 } catch { return reply({ error: "请假申请未确认保存，请检查日期后重试；系统会防止重复提交。" }, 503); }
}
