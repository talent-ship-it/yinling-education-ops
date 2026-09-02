import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, hasValidDemoSession } from "@/lib/demo-auth";
import { listWecomCliRecipients } from "@/lib/wecom-cli-bridge";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  if (!hasValidDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "请先登录内部系统。" }, { status: 401 });
  }

  return NextResponse.json({ recipients: listWecomCliRecipients() }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
