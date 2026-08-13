import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) {
    return NextResponse.json(
      { ok: false, user: null, role: null, error: resolved.error },
      { status: resolved.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const { session } = resolved;

  return NextResponse.json(
    { ok: true, user: session.user, role: session.role },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
