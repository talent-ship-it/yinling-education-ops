import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { listWecomCliRecipients } from "@/lib/wecom-cli-bridge";
import { hasWecomDispatchAdminSession } from "@/lib/wecom-dispatch-access";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  if (!hasWecomDispatchAdminSession(cookieStore)) {
    return NextResponse.json({ error: "需要完整管理员权限。" }, { status: 403 });
  }

  return NextResponse.json({ recipients: listWecomCliRecipients() }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
