import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, hasValidDemoSession } from "@/lib/demo-auth";
import {
  getOpsSources,
  getOpsState,
  getOpsVersions,
  OpsStoreError,
  putOpsState,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

async function authorized() {
  const cookieStore = await cookies();
  return hasValidDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
}

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(request: NextRequest) {
  if (!(await authorized())) return noStore({ error: "请先输入访问密码。" }, 401);

  try {
    if (request.nextUrl.searchParams.get("mode") === "versions") {
      const versions = await getOpsVersions();
      return noStore({ versions });
    }

    const entities = request.nextUrl.searchParams
      .get("entities")
      ?.split(",")
      .map((entity) => entity.trim())
      .filter(Boolean);
    const [rows, sources] = await Promise.all([
      getOpsState(entities),
      entities?.length ? Promise.resolve([]) : getOpsSources(),
    ]);

    return noStore({ rows, sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : "共享数据读取失败。";
    return noStore({ error: message }, 503);
  }
}

export async function PUT(request: NextRequest) {
  if (!(await authorized())) return noStore({ error: "请先输入访问密码。" }, 401);

  const body = await request.json().catch(() => null);
  if (
    !body
    || typeof body.entity !== "string"
    || typeof body.expectedVersion !== "number"
    || typeof body.actor !== "string"
    || !("payload" in body)
  ) {
    return noStore({ error: "共享数据写入参数不完整。" }, 400);
  }

  try {
    const rows = await putOpsState({
      entity: body.entity,
      payload: body.payload,
      expectedVersion: body.expectedVersion,
      actor: body.actor,
    });
    return noStore({ row: rows[0] });
  } catch (error) {
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      const current = await getOpsState([body.entity]).catch(() => []);
      return noStore({ error: "其他人刚刚修改了同一部分资料。", current: current[0] }, 409);
    }
    const message = error instanceof Error ? error.message : "共享数据保存失败。";
    return noStore({ error: message }, 503);
  }
}
