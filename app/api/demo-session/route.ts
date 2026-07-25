import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getDemoSessionUser } from "@/lib/demo-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const user = getDemoSessionUser(cookieStore.get(DEMO_COOKIE_NAME)?.value);

  return NextResponse.json(
    { ok: Boolean(user), user },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
