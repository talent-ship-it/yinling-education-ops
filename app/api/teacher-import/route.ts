import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DEMO_ADMIN_USER,
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { hasDemoSessionPermission, hasUnrestrictedDemoSessionScope } from "@/lib/demo-session-token";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  commitTeacherImportPlanAtomic,
  getLatestTeacherImportSources,
  getOpsState,
  OpsStoreError,
  TEACHER_IMPORT_ATOMIC_COMMIT_RPC,
  TEACHER_IMPORT_SOURCE_RPC,
} from "@/lib/ops-store";
import { TeacherImportError } from "@/lib/teacher-import";
import {
  assertTeacherImportCommit,
  hasTeacherImportAdminAccess,
  parseTeacherImportCommitRequest,
  prepareTeacherImport,
  TeacherImportServiceError,
} from "@/lib/teacher-import-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function requireAdmin(permission: "operations.read" | "operations.write") {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) {
    return { response: noStore({ error: resolved.error }, resolved.status) } as const;
  }
  const { session } = resolved;
  const fullAdmin = session.user === DEMO_ADMIN_USER && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!hasTeacherImportAdminAccess(session.user, fullAdmin)
      || !hasDemoSessionPermission(session, permission)
      || !hasUnrestrictedDemoSessionScope(session)) {
    return { response: noStore({ error: "只有管理员可以执行老师正式导入。" }, 403) } as const;
  }
  return { actor: session.user } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "PGRST202" || error.code === "42883");
}

function unavailable() {
  return noStore({
    error: "老师导入数据库合同尚未部署，当前不能读取或提交正式导入。",
    code: "teacher_import_contract_unavailable",
    requiredRpcs: [TEACHER_IMPORT_SOURCE_RPC, TEACHER_IMPORT_ATOMIC_COMMIT_RPC],
  }, 501);
}

function serviceError(error: TeacherImportServiceError) {
  if (["blocked_plan", "stale_plan", "stale_teachers_version"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  const sourceFailure = error.code === "invalid_source_snapshot"
    || error.code === "invalid_teachers_state";
  return noStore({ error: error.message, code: error.code }, sourceFailure ? 503 : 400);
}

async function currentPlan() {
  const [sourceSnapshot, rows] = await Promise.all([
    getLatestTeacherImportSources(),
    getOpsState(["teachers"]),
  ]);
  return prepareTeacherImport({
    sourceSnapshot,
    teachersRow: rows.find((row) => row.entity === "teachers"),
  });
}

/** Server-computed dry-run over the two latest server-owned workbooks. */
export async function GET() {
  const access = await requireAdmin("operations.read");
  if ("response" in access) return access.response;

  try {
    return noStore((await currentPlan()).response);
  } catch (error) {
    if (missingRpc(error)) return unavailable();
    if (error instanceof TeacherImportServiceError) return serviceError(error);
    if (error instanceof TeacherImportError) {
      return noStore({ error: error.message, code: error.code }, 422);
    }
    return noStore({
      error: error instanceof Error ? error.message : "老师导入预检失败。",
    }, 503);
  }
}

/** Recomputes the plan and submits only that server-owned result atomically. */
export async function POST(request: Request) {
  const access = await requireAdmin("operations.write");
  if ("response" in access) return access.response;

  try {
    const confirmation = parseTeacherImportCommitRequest(await request.json().catch(() => null));
    const prepared = await currentPlan();
    assertTeacherImportCommit(confirmation, prepared);
    const saved = await commitTeacherImportPlanAtomic({
      planFingerprint: prepared.response.planFingerprint,
      expectedTeacherVersion: prepared.response.expectedTeacherVersion,
      sourceRevisions: prepared.sourceRevisions,
      teachers: prepared.plan.teachers,
      actor: access.actor,
    });
    if (!saved[0]) {
      throw new OpsStoreError("老师导入原子提交没有返回保存结果。", "invalid_commit_result");
    }
    return noStore({
      committed: true,
      applied: saved[0].applied,
      teacherVersion: saved[0].version,
      summary: prepared.response.summary,
      actions: prepared.response.actions,
      issues: prepared.response.issues,
    });
  } catch (error) {
    if (missingRpc(error)) return unavailable();
    if (error instanceof TeacherImportServiceError) return serviceError(error);
    if (error instanceof TeacherImportError) {
      return noStore({ error: error.message, code: error.code }, 422);
    }
    if (error instanceof OpsStoreError
      && (error.code === "40001"
        || error.code === "23503"
        || error.code === "23505"
        || error.message === "version_conflict"
        || error.message === "teacher_import_source_changed")) {
      return noStore({
        error: "老师资料或导入来源刚刚发生变化，请重新预检。",
        code: "teacher_import_conflict",
      }, 409);
    }
    return noStore({
      error: error instanceof Error ? error.message : "老师导入提交失败。",
    }, 503);
  }
}
