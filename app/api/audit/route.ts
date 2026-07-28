import { randomUUID } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getDemoSessionUser } from "@/lib/demo-auth";
import { getOpsState, OpsStoreError, putOpsState } from "@/lib/ops-store";

export const dynamic = "force-dynamic";

const TONES = new Set(["neutral", "blue", "green", "amber", "red", "purple"]);

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const actor = getDemoSessionUser(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!actor) return noStore({ error: "请先输入访问密码。" }, 401);

  const body = await request.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action.trim() : "";
  const detail = typeof body?.detail === "string" ? body.detail.trim() : "";
  const tone = typeof body?.tone === "string" && TONES.has(body.tone) ? body.tone : "blue";
  if (!action || !detail || action.length > 120 || detail.length > 1200) {
    return noStore({ error: "操作审计内容不完整或过长。" }, 400);
  }

  const entry = {
    id: `AUD-${randomUUID()}`,
    time: new Date().toISOString(),
    actor,
    action,
    detail,
    tone,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const row = (await getOpsState(["audit"]))[0];
      if (!row || !Array.isArray(row.payload)) return noStore({ error: "操作审计尚未初始化。" }, 503);
      const saved = await putOpsState({
        entity: "audit",
        payload: [entry, ...row.payload],
        expectedVersion: row.version,
        actor,
      });
      return noStore({ row: saved[0], entry });
    } catch (error) {
      if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) continue;
      return noStore({ error: error instanceof Error ? error.message : "操作审计保存失败。" }, 503);
    }
  }

  return noStore({ error: "操作审计正在被其他人更新，请重试。" }, 409);
}
