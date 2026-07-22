import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, hasValidDemoSession } from "@/lib/demo-auth";
import { getOpsSources, getOpsState } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  if (!hasValidDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "请先输入访问密码。" }, { status: 401 });
  }

  try {
    const [rows, syncSources] = await Promise.all([getOpsState(), getOpsSources()]);
    const payload = Object.fromEntries(rows.map((row) => [row.entity, row.payload]));
    const versions = Object.fromEntries(rows.map((row) => [row.entity, row.version]));
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
