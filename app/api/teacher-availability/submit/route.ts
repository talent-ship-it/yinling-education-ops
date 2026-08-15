import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import {
  getOpsState,
  OpsStoreError,
  submitTeacherAvailabilityAtomic,
  TEACHER_AVAILABILITY_ATOMIC_SUBMIT_RPC,
} from "@/lib/ops-store";
import {
  parseTeacherAvailabilitySubmitRequest,
  prepareTeacherAvailabilitySubmission,
  TeacherAvailabilitySubmitError,
} from "@/lib/teacher-availability-submission-service";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function serviceError(error: TeacherAvailabilitySubmitError) {
  if (["teacher_only", "teacher_identity_not_found", "teacher_identity_ambiguous"].includes(error.code)) {
    return noStore({ error: error.message, code: error.code }, 403);
  }
  if (error.code === "invalid_teachers_state") {
    return noStore({ error: error.message, code: error.code }, 503);
  }
  return noStore({ error: error.message, code: error.code }, 422);
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return noStore({ error: resolved.error }, resolved.status);
  const { session } = resolved;
  if (session.role !== "teacher") {
    return noStore({ error: "只有当前登录老师本人可以提交月度 AVA。", code: "teacher_only" }, 403);
  }

  try {
    const submitRequest = parseTeacherAvailabilitySubmitRequest(
      await request.json().catch(() => null),
    );
    const rows = await getOpsState(["teachers"]);
    const prepared = prepareTeacherAvailabilitySubmission({
      request: submitRequest,
      teachersRow: rows.find((row) => row.entity === "teachers"),
      actor: session.user,
      role: session.role,
    });
    const saved = await submitTeacherAvailabilityAtomic(prepared);
    if (!saved[0]) throw new OpsStoreError("AVA 提交事务没有返回结果。", "invalid_submit_result");
    return noStore({
      submitted: true,
      applied: saved[0].applied,
      unchanged: !saved[0].applied,
      submissionKey: saved[0].submission_key,
      submissionId: saved[0].submission_id,
      teacherId: saved[0].teacher_id,
      status: saved[0].status,
      submittedAt: saved[0].submitted_at,
      auditEntryId: saved[0].audit_entry_id,
    });
  } catch (error) {
    if (error instanceof TeacherAvailabilitySubmitError) return serviceError(error);
    if (error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883")) {
      return noStore({
        error: "老师 AVA 提交数据库合同尚未部署，当前不能提交。",
        code: "teacher_availability_submit_contract_unavailable",
        requiredRpc: TEACHER_AVAILABILITY_ATOMIC_SUBMIT_RPC,
      }, 501);
    }
    if (error instanceof OpsStoreError && (error.code === "40001" || error.message === "version_conflict")) {
      return noStore({ error: "老师资料刚刚发生变化，请刷新后重试。", code: "teacher_availability_submit_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.message === "teacher_availability_pending_submission_exists") {
      return noStore({ error: "这个月份已有一份待审核 AVA，请等待审核后再重新提交。", code: "teacher_availability_pending_submission_exists" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "23505") {
      return noStore({ error: "同一个 submissionKey 已用于另一份 AVA 内容。", code: "teacher_availability_submit_idempotency_conflict" }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "22023") {
      return noStore({ error: error.message, code: "invalid_teacher_availability_submission" }, 422);
    }
    return noStore({ error: error instanceof Error ? error.message : "老师 AVA 提交失败。" }, 503);
  }
}
