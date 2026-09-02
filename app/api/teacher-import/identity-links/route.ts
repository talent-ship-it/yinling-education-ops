import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasDemoSessionPermission, hasUnrestrictedDemoSessionScope } from "@/lib/demo-session-token";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getLatestTeacherImportSources,
  getOpsState,
  OpsStoreError,
  putTeacherImportHardResolution,
  putTeacherImportIdentityLink,
  TEACHER_HARD_RESOLUTION_PUT_RPC,
  TEACHER_IDENTITY_LINK_PUT_RPC,
} from "@/lib/ops-store";
import {
  hasTeacherImportAdminAccess,
  parseTeacherIdentityResolutionRequest,
  prepareTeacherImport,
  resolveTeacherIdentityCandidate,
  TeacherImportServiceError,
} from "@/lib/teacher-import-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function requireAdmin() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return { response: noStore({ error: resolved.error }, resolved.status) } as const;
  const fullAdmin = hasFullAdminAccess(resolved.session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!hasTeacherImportAdminAccess(resolved.session.user, fullAdmin)
      || !hasDemoSessionPermission(resolved.session, "operations.write")
      || !hasUnrestrictedDemoSessionScope(resolved.session)) {
    return { response: noStore({ error: "只有管理员可以确认老师身份关联。" }, 403) } as const;
  }
  return { actor: resolved.session.user } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

/** Persists one exact candidate from a fresh server-owned dry-run. */
export async function POST(request: Request) {
  const access = await requireAdmin();
  if ("response" in access) return access.response;
  try {
    const confirmation = parseTeacherIdentityResolutionRequest(await request.json().catch(() => null));
    const [sourceSnapshot, rows] = await Promise.all([
      getLatestTeacherImportSources(),
      getOpsState(["teachers"]),
    ]);
    const prepared = prepareTeacherImport({
      sourceSnapshot,
      teachersRow: rows.find((row) => row.entity === "teachers"),
    });
    const resolution = resolveTeacherIdentityCandidate(confirmation, prepared);
    const saved = resolution.persistenceContract === "teacher_identity_link_v1"
      && (confirmation.decision === "merge" || confirmation.decision === "separate")
      ? await putTeacherImportIdentityLink({
        resolutionKey: confirmation.resolutionKey,
        decision: confirmation.decision,
        actor: access.actor,
      })
      : await putTeacherImportHardResolution({
        resolutionKey: confirmation.resolutionKey,
        decision: confirmation.decision,
        actor: access.actor,
      });
    return noStore({ saved: true, resolutionKey: saved.resolutionKey, decision: saved.decision, unchanged: saved.unchanged });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "老师身份确认数据库合同尚未部署。",
        code: "teacher_hard_resolution_contract_unavailable",
        requiredRpcs: [TEACHER_IDENTITY_LINK_PUT_RPC, TEACHER_HARD_RESOLUTION_PUT_RPC],
      }, 501);
    }
    if (error instanceof TeacherImportServiceError) {
      const conflict = error.code === "identity_resolution_unavailable";
      return noStore({ error: error.message, code: error.code }, conflict ? 409 : 422);
    }
    if (error instanceof OpsStoreError && ["22023", "23503", "23505", "40001"].includes(error.code ?? "")) {
      return noStore({ error: "来源或身份候选已变化，请重新预检。", code: "teacher_identity_link_conflict" }, 409);
    }
    return noStore({ error: "老师身份确认失败。" }, 503);
  }
}
