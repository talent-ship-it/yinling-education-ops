import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, DEMO_LIMITED_ADMIN_USER, getCurrentDemoSession } from "@/lib/demo-auth";
import { buildOpsAccessContext, filterOpsStateRows } from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { getOpsSources, getOpsState } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const { session } = resolved;

  try {
    const rows = await getOpsState();
    const actor = session.user;
    const fullAdmin = actor === DEMO_ADMIN_USER && session.role === "admin" && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
    const access = buildOpsAccessContext(rows, actor, fullAdmin, session.role);
    const visibleRows = filterOpsStateRows(rows, access);
    const sourceAccess = fullAdmin || actor === DEMO_LIMITED_ADMIN_USER;
    const payload = Object.fromEntries(visibleRows.map((row) => [row.entity, row.payload]));
    const versions = Object.fromEntries(visibleRows.map((row) => [row.entity, row.version]));
    const syncSources = sourceAccess ? await getOpsSources() : [];
    return NextResponse.json({ ...payload, versions, syncSources }, {
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
