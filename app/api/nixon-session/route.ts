import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, hasValidDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const demoSession = hasValidDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  const nixonSession = hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  return NextResponse.json(
    { ok: demoSession && nixonSession },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
