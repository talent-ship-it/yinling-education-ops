import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, DEMO_LIMITED_ADMIN_USER, getCurrentDemoSession } from "@/lib/demo-auth";
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
import { OpsRulesValidationError, parseRulesWrite } from "@/lib/ops-rules";
import { assertOpsStateTransition, OpsStateTransitionError } from "@/lib/ops-state-transition";
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
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return resolved;
  const { session } = resolved;
  const fullAdmin = session.user === DEMO_ADMIN_USER && session.role === "admin" && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  return { session: { actor: session.user, role: session.role, fullAdmin } } as const;
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

function bookingScopeVersions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scope = value as Record<string, unknown>;
  if (Object.keys(scope).length !== 2
    || !Number.isSafeInteger(scope.students) || (scope.students as number) < 1
    || !Number.isSafeInteger(scope.teachers) || (scope.teachers as number) < 1) return null;
  return { students: scope.students as number, teachers: scope.teachers as number };
}

export async function GET(request: NextRequest) {
  const session = await sessionContext();
  if (!("session" in session)) return noStore({ error: session.error }, session.status);
  const context = session.session;

  try {
    if (request.nextUrl.searchParams.get("mode") === "versions") {
      const [rows, versions] = await Promise.all([getOpsState(), getOpsVersions()]);
      const access = buildOpsAccessContext(rows, context.actor, context.fullAdmin, context.role);
      return noStore({ versions: filterOpsVersions(versions, access) });
    }

    const entities = request.nextUrl.searchParams
      .get("entities")
      ?.split(",")
      .map((entity) => entity.trim())
      .filter(Boolean);
    const rows = await getOpsState();
    const access = buildOpsAccessContext(rows, context.actor, context.fullAdmin, context.role);
    if (entities?.some((entity) => !canReadOpsEntity(access, entity))) {
      return noStore({ error: "当前账号没有读取这部分资料的权限。" }, 403);
    }

    const visibleRows = filterOpsStateRows(rows, access)
      .filter((row) => !entities?.length || entities.includes(row.entity));
    const sources = entities?.length || !(await canReadSources(context.actor, context.fullAdmin))
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
  if (!("session" in session)) return noStore({ error: session.error }, session.status);
  const context = session.session;

  const body = await request.json().catch(() => null);
  if (!body || typeof body.entity !== "string"
    || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1
    || !("payload" in body)) {
    return noStore({ error: "共享数据写入参数不完整。" }, 400);
  }
  const submittedBookingScopeVersions = body.entity === "bookings"
    ? bookingScopeVersions(body.scopeVersions)
    : null;
  if (body.entity === "bookings" && !submittedBookingScopeVersions) {
    return noStore({ error: "排课保存必须携带学生和老师资料版本，请刷新后重试。" }, 400);
  }

  try {
    const allRows = await getOpsState();
    const access = buildOpsAccessContext(allRows, context.actor, context.fullAdmin, context.role);
    if (body.entity === "audit") return noStore({ error: "操作审计由服务器自动记录，不能直接修改。" }, 403);

    const currentRow = allRows.find((row) => row.entity === body.entity);
    if (!currentRow || !canReadOpsEntity(access, body.entity)) {
      return noStore({ error: "当前账号没有读取这部分资料的权限。" }, 403);
    }
    // Invariants below must be evaluated against the exact versions the
    // browser intends to replace. The database locks and checks these same
    // versions again after validation, closing both sides of the race.
    if (currentRow.version !== body.expectedVersion) {
      throw new OpsStoreError("version_conflict", "40001");
    }
    if (submittedBookingScopeVersions) {
      const currentStudentsVersion = allRows.find((row) => row.entity === "students")?.version;
      const currentTeachersVersion = allRows.find((row) => row.entity === "teachers")?.version;
      if (submittedBookingScopeVersions.students !== currentStudentsVersion
        || submittedBookingScopeVersions.teachers !== currentTeachersVersion) {
        throw new OpsStoreError("access_scope_changed", "40001");
      }
    }
    const submittedPayload = body.entity === "rules" ? parseRulesWrite(body.payload) : body.payload;
    const payload = mergeScopedPayload({
      entity: body.entity,
      currentPayload: currentRow.payload,
      submittedPayload,
      context: access,
    });
    assertOpsStateTransition({
      entity: body.entity,
      currentPayload: currentRow.payload,
      nextPayload: payload,
      rows: allRows,
      context: access,
    });
    const scopeVersions = submittedBookingScopeVersions ?? getAccessScopeVersions(allRows, access);
    const saved = await putOpsState({
      entity: body.entity,
      payload,
      expectedVersion: body.expectedVersion,
      actor: context.actor,
      scopeVersions,
    });
    return noStore({ row: filterOpsStateRows(saved, access)[0] });
  } catch (error) {
    if (error instanceof OpsRulesValidationError) return noStore({ error: error.message }, 400);
    if (error instanceof OpsAccessError) return noStore({ error: error.message }, 403);
    if (error instanceof OpsStateTransitionError) return noStore({ error: error.message }, error.status);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      const allRows = await getOpsState().catch(() => []);
      const access = buildOpsAccessContext(allRows, context.actor, context.fullAdmin, context.role);
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
