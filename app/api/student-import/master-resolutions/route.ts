import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getLatestStudentImportSourceRows,
  getOpsState,
  OpsStoreError,
  putStudentImportMasterDuplicateResolution,
  STUDENT_IMPORT_MASTER_DUPLICATE_RESOLUTION_PUT_RPC,
} from "@/lib/ops-store";
import {
  buildMasterDuplicateResolutionCandidates,
  hasStudentImportAdminAccess,
  masterDuplicateDecisionForCandidate,
  parseMasterDuplicateResolutionRequest,
  parseStudentImportSourceSnapshot,
  resolveMasterDuplicateCandidate,
  StudentImportServiceError,
} from "@/lib/student-import-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function requireAdmin() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return { response: noStore({ error: resolved.error }, resolved.status) } as const;
  const fullAdmin = resolved.session.user === DEMO_ADMIN_USER && resolved.session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!hasStudentImportAdminAccess(resolved.session.user, fullAdmin)) {
    return { response: noStore({ error: "只有管理员可以确认学生总表重复项。" }, 403) } as const;
  }
  return { actor: resolved.session.user } as const;
}

/** Validates the opaque option locally, then asks the database to recompute and persist it. */
export async function POST(request: Request) {
  const access = await requireAdmin();
  if ("response" in access) return access.response;
  try {
    const confirmation = parseMasterDuplicateResolutionRequest(await request.json().catch(() => null));
    const [rawSnapshot, rows] = await Promise.all([
      getLatestStudentImportSourceRows(),
      getOpsState(["students"]),
    ]);
    const snapshot = parseStudentImportSourceSnapshot(rawSnapshot);
    const studentsRow = rows.find((row) => row.entity === "students");
    const candidates = buildMasterDuplicateResolutionCandidates({
      sourceId: snapshot.master.sourceId,
      revision: snapshot.master.revision,
      studentVersion: studentsRow?.version ?? -1,
      rows: snapshot.master.rows,
    });
    const resolved = resolveMasterDuplicateCandidate(confirmation, candidates);
    if (!Array.isArray(studentsRow?.payload)) {
      throw new StudentImportServiceError("invalid_students_state", "Students state is not available for import.");
    }
    // Resolve only from the current revision-bound reviewed link snapshot.
    masterDuplicateDecisionForCandidate(
      resolved.candidate,
      resolved.option,
      snapshot.identityLinks,
    );
    const saved = await putStudentImportMasterDuplicateResolution({
      resolutionKey: confirmation.resolutionKey,
      decision: confirmation.decision,
      actor: access.actor,
    });
    return noStore(saved);
  } catch (error) {
    if (error instanceof StudentImportServiceError) {
      const conflict = error.code === "master_duplicate_resolution_unavailable";
      return noStore({ error: error.message, code: error.code }, conflict ? 409 : 422);
    }
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({
        error: "学生总表重复项数据库合同尚未部署，当前选择未保存。",
        code: "student_master_duplicate_resolution_contract_unavailable",
        requiredRpc: STUDENT_IMPORT_MASTER_DUPLICATE_RESOLUTION_PUT_RPC,
      }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "23503" || error.code === "40001")) {
      return noStore({ error: "该选择已失效，请重新预检。", code: "master_duplicate_resolution_unavailable" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "该重复组已确认其他选择，请重新预检。", code: "master_duplicate_resolution_conflict" }, 409);
    }
    return noStore({ error: error instanceof Error ? error.message : "学生总表重复项确认失败。" }, 503);
  }
}
