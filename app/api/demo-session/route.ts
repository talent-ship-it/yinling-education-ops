import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, hasValidDemoSession } from "@/lib/demo-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const authenticated = hasValidDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);

  return NextResponse.json(
    { ok: authenticated },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
