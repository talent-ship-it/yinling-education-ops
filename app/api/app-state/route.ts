import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { privateJsonResponse } from "@/lib/private-json-response";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import {
  buildOpsAccessContext,
  canReadOpsEntity,
  canReadUnrestrictedOpsData,
  filterOpsStateRows,
  filterOpsVersions,
  getAccessScopeVersions,
  managedExamStudentProjectionSnapshot,
  managedTrialPaymentStudentProjectionSnapshot,
  mergeScopedPayload,
  OpsAccessError,
} from "@/lib/ops-access";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import { OpsRulesValidationError, parseRulesWrite } from "@/lib/ops-rules";
import { assertOpsStateTransition, OpsStateTransitionError } from "@/lib/ops-state-transition";
import { hasAppendedLessonPackagePurchase } from "@/lib/lesson-package-purchase-command";
import { assertJiaowubaoPayrollAuthority, JiaowubaoPayrollAuthorityError } from "@/lib/jiaowubao-payroll-authority";
import {
  getOpsSources,
  getOpsState,
  OpsStoreError,
  putOpsState,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function sessionContext() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return resolved;
  const { session } = resolved;
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
  return { session: { actor: session.user, role: session.role, fullAdmin, identity: session } } as const;
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
      // Scope and versions must come from the same ops_state statement. A
      // separate versions RPC can race an ownership/archive change and make a
      // client believe its managed-exam projection is current when it is not.
      const rows = await getOpsState();
      const access = buildOpsAccessContext(rows, context.actor, context.fullAdmin, context.identity);
      const versions = rows.map((row) => ({
        entity: row.entity,
        version: row.version,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      }));
      return noStore({ versions: filterOpsVersions(versions, access) });
    }

    const entities = request.nextUrl.searchParams
      .get("entities")
      ?.split(",")
      .map((entity) => entity.trim())
      .filter(Boolean);
    const includeManagedExamSnapshot = request.nextUrl.searchParams.get("includeManagedExamSnapshot") === "1";
    const includeManagedTrialPaymentSnapshot = request.nextUrl.searchParams.get("includeManagedTrialPaymentSnapshot") === "1";
    if (includeManagedExamSnapshot
      && (!entities?.includes("students") || !entities.includes("tasks"))) {
      return noStore({ error: "考试提醒刷新必须同时读取学生和任务权威版本。" }, 400);
    }
    if (includeManagedTrialPaymentSnapshot
      && (!entities?.includes("bookings") || !entities.includes("students")
        || !entities.includes("lpItems") || !entities.includes("tasks"))) {
      return noStore({ error: "试听收费提醒刷新必须同时读取排课、学生、LP 和任务权威版本。" }, 400);
    }
    const rows = await getOpsState();
    const access = buildOpsAccessContext(rows, context.actor, context.fullAdmin, context.identity);
    if (entities?.some((entity) => !canReadOpsEntity(access, entity))) {
      return noStore({ error: "当前账号没有读取这部分资料的权限。" }, 403);
    }

    const visibleRows = filterOpsStateRows(rows, access)
      .filter((row) => !entities?.length || entities.includes(row.entity));
    const sources = entities?.length || !canReadUnrestrictedOpsData(access)
      ? []
      : await getOpsSources();
    const managedExamSnapshot = includeManagedExamSnapshot
      ? managedExamStudentProjectionSnapshot(rows, access)
      : undefined;
    const managedTrialPaymentSnapshot = includeManagedTrialPaymentSnapshot
      ? managedTrialPaymentStudentProjectionSnapshot(rows, access)
      : undefined;

    return privateJsonResponse({
      rows: visibleRows,
      sources,
      ...(managedExamSnapshot ? { managedExamSnapshot } : {}),
      ...(managedTrialPaymentSnapshot ? { managedTrialPaymentSnapshot } : {}),
    }, request);
  } catch {
    const message = "共享数据读取失败。";
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
    const access = buildOpsAccessContext(allRows, context.actor, context.fullAdmin, context.identity);
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
    if (body.entity === "students" && hasAppendedLessonPackagePurchase(currentRow.payload, payload)) {
      return noStore({ error: "课包购买必须使用可重试的购买命令，请刷新页面后重新录入。", code: "purchase_command_required" }, 409);
    }
    assertOpsStateTransition({
      entity: body.entity,
      currentPayload: currentRow.payload,
      nextPayload: payload,
      rows: allRows,
      context: access,
    });
    if (body.entity === "payroll") {
      await assertJiaowubaoPayrollAuthority({
        currentPayload: currentRow.payload,
        nextPayload: payload,
        stateRows: allRows,
      });
    }
    const scopeVersions = submittedBookingScopeVersions ?? getAccessScopeVersions(allRows, access);
    const saved = await putOpsState({
      entity: body.entity,
      payload,
      expectedVersion: body.expectedVersion,
      actor: context.actor,
      scopeVersions,
    });
    return privateJsonResponse({ row: filterOpsStateRows(saved, access)[0] }, request);
  } catch (error) {
    if (error instanceof JiaowubaoPayrollAuthorityError) {
      return noStore({ error: "教务宝课时或老师、学生映射需要重新核对，请刷新后重试。" }, 409);
    }
    if (error instanceof OpsRulesValidationError) return noStore({ error: error.message }, 400);
    if (error instanceof OpsAccessError) return noStore({ error: error.message }, 403);
    if (error instanceof OpsStateTransitionError) return noStore({ error: error.message }, error.status);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      const allRows = await getOpsState().catch(() => []);
      const access = buildOpsAccessContext(allRows, context.actor, context.fullAdmin, context.identity);
      const current = filterOpsStateRows(allRows.filter((row) => row.entity === body.entity), access)[0];
      const currentStudentsVersion = allRows.find((row) => row.entity === "students")?.version;
      const currentTeachersVersion = allRows.find((row) => row.entity === "teachers")?.version;
      const accessChanged = error.message === "access_scope_changed"
        || (body.entity === "bookings"
          && submittedBookingScopeVersions !== null
          && (submittedBookingScopeVersions.students !== currentStudentsVersion
            || submittedBookingScopeVersions.teachers !== currentTeachersVersion));
      return noStore({
        error: accessChanged ? "你的权限或负责范围刚刚变更，本次保存没有执行。请刷新页面后继续。" : "其他人刚刚修改了同一部分资料。",
        current,
        accessChanged,
      }, 409);
    }
    const message = "共享数据保存失败。";
    return noStore({ error: message }, 503);
  }
}
