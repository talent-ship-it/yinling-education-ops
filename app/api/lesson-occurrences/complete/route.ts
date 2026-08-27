import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import {
  parseCompleteLessonOccurrenceRequest,
  prepareLessonOccurrenceSettlement,
  LessonOccurrenceServiceError,
} from "@/lib/lesson-occurrence-service";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  completeLessonOccurrenceAtomic,
  getLessonAttendanceEvidence,
  getOpsState,
  LESSON_ATTENDANCE_EVIDENCE_RPC,
  LESSON_OCCURRENCE_ATOMIC_COMPLETE_RPC,
  OpsStoreError,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
}

function contractUnavailable() {
  return noStore({
    error: "课次结算数据库合同尚未部署，当前不能正式结算。",
    code: "lesson_occurrence_contract_unavailable",
    requiredRpcs: [LESSON_ATTENDANCE_EVIDENCE_RPC, LESSON_OCCURRENCE_ATOMIC_COMPLETE_RPC],
  }, 501);
}

function serviceError(error: LessonOccurrenceServiceError) {
  if (["teacher_forbidden", "student_scope_forbidden", "override_admin_required"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 403);
  }
  if (error.code === "occurrence_not_found" || error.code === "student_not_found" || error.code === "teacher_not_found" || error.code === "package_not_found" || error.code === "attendance_not_found") {
    return noStore({ error: error.message, code: error.code }, 404);
  }
  if (error.code === "stale_expected_version") {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (error.code === "attendance_abnormal") {
    return noStore({ error: error.message, code: error.code }, 422);
  }
  if (error.code === "occurrence_not_billable" || error.code === "insufficient_hours") {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (error.code === "invalid_shared_state") {
    return noStore({ error: error.message, code: error.code }, 503);
  }
  return noStore({ error: error.message, code: error.code }, 400);
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  const actor = session.user;
  if (session.role === "teacher") return noStore({ error: "老师账号不能执行课次结算。", code: "teacher_forbidden" }, 403);
  const fullAdmin = actor === DEMO_ADMIN_USER && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);

  try {
    const completionRequest = parseCompleteLessonOccurrenceRequest(await request.json().catch(() => null));
    const rows = await getOpsState(["students", "teachers", "bookings", "payroll"]);
    const attendanceRecord = completionRequest.attendanceEvidenceReference
      ? await getLessonAttendanceEvidence({
          reference: completionRequest.attendanceEvidenceReference,
          occurrenceId: completionRequest.occurrenceId,
        })
      : null;
    if (completionRequest.attendanceEvidenceReference && (!attendanceRecord || attendanceRecord.occurrenceId !== completionRequest.occurrenceId)) {
      throw new LessonOccurrenceServiceError("attendance_not_found", "Attendance evidence was not found.");
    }
    const completedAt = attendanceRecord?.capturedAt ?? new Date().toISOString();
    const prepared = prepareLessonOccurrenceSettlement({
      request: completionRequest,
      rows,
      actor,
      fullAdmin,
      role: session.role,
      authorization: session,
      attendance: attendanceRecord?.evidence,
      completedAt,
    });
    const saved = await completeLessonOccurrenceAtomic({
      occurrenceId: prepared.occurrence.occurrenceId,
      expectedVersion: completionRequest.expectedVersion,
      stateVersions: prepared.stateVersions,
      idempotencyKey: prepared.idempotencyKey,
      settlement: prepared.settlement,
      attendanceReference: prepared.attendanceReference,
      overrideReason: prepared.overrideReason,
      actor,
    });
    if (!saved[0]) throw new OpsStoreError("课次结算没有返回保存结果。", "invalid_commit_result");
    if (prepared.overrideReason && !saved[0].audit_entry_id) {
      throw new OpsStoreError("人工覆盖结算没有返回审计记录。", "missing_override_audit");
    }
    return noStore({
      committed: true,
      occurrenceId: saved[0].occurrence_id,
      idempotencyKey: saved[0].idempotency_key,
      applied: saved[0].applied,
      disposition: saved[0].disposition,
      version: saved[0].version,
      ...(saved[0].audit_entry_id ? { auditEntryId: saved[0].audit_entry_id } : {}),
    });
  } catch (error) {
    if (missingRpc(error)) return contractUnavailable();
    if (error instanceof LessonOccurrenceServiceError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "这节课或相关余额刚刚发生变化，请刷新后重试。", code: "settlement_conflict" }, 409);
    }
    return noStore({ error: error instanceof Error ? error.message : "课次结算失败。" }, 503);
  }
}
