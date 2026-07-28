import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, DEMO_LIMITED_ADMIN_USER, getDemoSessionUser } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getOpsSources, getOpsState } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const demoUser = getDemoSessionUser(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!demoUser) {
    return NextResponse.json({ error: "请先输入访问密码。" }, { status: 401 });
  }

  try {
    const [rows, syncSources] = await Promise.all([getOpsState(), getOpsSources()]);
    const nixonSession = demoUser === DEMO_ADMIN_USER && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const sourceAccess = nixonSession || demoUser === DEMO_LIMITED_ADMIN_USER;
    const visibleRows = nixonSession ? rows : rows.filter((row) => row.entity !== "payroll");
    const payload = Object.fromEntries(visibleRows.map((row) => [row.entity, row.payload]));
    const versions = Object.fromEntries(visibleRows.map((row) => [row.entity, row.version]));
    return NextResponse.json({ ...payload, versions, syncSources: sourceAccess ? syncSources : [] }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Supabase 真实资料读取失败。";
    return NextResponse.json({ error: message }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
