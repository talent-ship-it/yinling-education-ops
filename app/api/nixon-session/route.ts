import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  const session = "session" in resolved ? resolved.session : null;
  const nixonSession = session
    ? hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value)
    : false;

  return NextResponse.json(
    { ok: nixonSession },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
