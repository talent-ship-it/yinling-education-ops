import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, DEMO_LIMITED_ADMIN_USER, getDemoSessionUser } from "@/lib/demo-auth";
import {
  buildOpsAccessContext,
  canReadOpsEntity,
  filterOpsStateRows,
  filterOpsVersions,
  getAccessScopeVersions,
  mergeScopedPayload,
  OpsAccessError,
} from "@/lib/ops-access";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getOpsSources,
  getOpsState,
  getOpsVersions,
  OpsStoreError,
  putOpsState,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

async function sessionContext() {
  const cookieStore = await cookies();
  const actor = getDemoSessionUser(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!actor) return null;
  const fullAdmin = actor === DEMO_ADMIN_USER && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  return { actor, fullAdmin };
}

async function canReadSources(actor: string, fullAdmin: boolean) {
  return actor === DEMO_LIMITED_ADMIN_USER || fullAdmin;
}

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(request: NextRequest) {
  const session = await sessionContext();
  if (!session) return noStore({ error: "请先输入访问密码。" }, 401);

  try {
    if (request.nextUrl.searchParams.get("mode") === "versions") {
      const [rows, versions] = await Promise.all([getOpsState(), getOpsVersions()]);
      const access = buildOpsAccessContext(rows, session.actor, session.fullAdmin);
      return noStore({ versions: filterOpsVersions(versions, access) });
    }

    const entities = request.nextUrl.searchParams
      .get("entities")
      ?.split(",")
      .map((entity) => entity.trim())
      .filter(Boolean);
    const rows = await getOpsState();
    const access = buildOpsAccessContext(rows, session.actor, session.fullAdmin);
    if (entities?.some((entity) => !canReadOpsEntity(access, entity))) {
      return noStore({ error: "当前账号没有读取这部分资料的权限。" }, 403);
    }

    const visibleRows = filterOpsStateRows(rows, access)
      .filter((row) => !entities?.length || entities.includes(row.entity));
    const sources = entities?.length || !(await canReadSources(session.actor, session.fullAdmin))
      ? []
      : await getOpsSources();

    return noStore({ rows: visibleRows, sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : "共享数据读取失败。";
    return noStore({ error: message }, 503);
  }
}

export async function PUT(request: NextRequest) {
  const session = await sessionContext();
  if (!session) return noStore({ error: "请先输入访问密码。" }, 401);

  const body = await request.json().catch(() => null);
  if (!body || typeof body.entity !== "string" || typeof body.expectedVersion !== "number" || !("payload" in body)) {
    return noStore({ error: "共享数据写入参数不完整。" }, 400);
  }

  try {
    const allRows = await getOpsState();
    const access = buildOpsAccessContext(allRows, session.actor, session.fullAdmin);
    if (body.entity === "audit") return noStore({ error: "操作审计由服务器自动记录，不能直接修改。" }, 403);

    const currentRow = allRows.find((row) => row.entity === body.entity);
    if (!currentRow || !canReadOpsEntity(access, body.entity)) {
      return noStore({ error: "当前账号没有读取这部分资料的权限。" }, 403);
    }
    const payload = mergeScopedPayload({
      entity: body.entity,
      currentPayload: currentRow.payload,
      submittedPayload: body.payload,
      context: access,
    });
    const scopeVersions = getAccessScopeVersions(allRows, access);
    const saved = await putOpsState({
      entity: body.entity,
      payload,
      expectedVersion: body.expectedVersion,
      actor: session.actor,
      scopeVersions,
    });
    return noStore({ row: filterOpsStateRows(saved, access)[0] });
  } catch (error) {
    if (error instanceof OpsAccessError) return noStore({ error: error.message }, 403);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      const allRows = await getOpsState().catch(() => []);
      const access = buildOpsAccessContext(allRows, session.actor, session.fullAdmin);
      const current = filterOpsStateRows(allRows.filter((row) => row.entity === body.entity), access)[0];
      const accessChanged = error.message === "access_scope_changed";
      return noStore({
        error: accessChanged ? "你的权限或负责范围刚刚变更，本次保存没有执行。请刷新页面后继续。" : "其他人刚刚修改了同一部分资料。",
        current,
        accessChanged,
      }, 409);
    }
    const message = error instanceof Error ? error.message : "共享数据保存失败。";
    return noStore({ error: message }, 503);
  }
}
