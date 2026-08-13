import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  const session = "session" in resolved ? resolved.session : null;
  const nixonSession = hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  return NextResponse.json(
    { ok: session?.user === DEMO_ADMIN_USER && session.role === "admin" && nixonSession },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
