import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { readWecomMirrorReview } from "@/lib/ops-store";
import { mirrorReviewFilters } from "@/lib/wecom-mirror-review";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
 const headers = { "Cache-Control": "private, no-store" };
 const jar = await cookies();
 const resolved = await getCurrentDemoSession(jar.get(DEMO_COOKIE_NAME)?.value);
 if (!("session" in resolved)) return NextResponse.json({ error: "请先登录。" }, { status: resolved.status, headers });
 if (!hasFullAdminAccess(resolved.session, jar.get(NIXON_COOKIE_NAME)?.value)) return NextResponse.json({ error: "仅管理员可查看群交接核对。" }, { status: 403, headers });
 try {
  return NextResponse.json(await readWecomMirrorReview(mirrorReviewFilters(new URL(request.url).searchParams)), { headers });
 } catch {
  return NextResponse.json({ error: "群交接记录暂时无法读取，请稍后重试。" }, { status: 503, headers });
 }
}
