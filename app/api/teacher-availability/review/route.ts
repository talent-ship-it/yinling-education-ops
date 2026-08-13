import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DEMO_ADMIN_USER,
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getOpsState,
  getTeacherAvailabilitySubmissions,
  OpsStoreError,
  reviewTeacherAvailabilitySubmissionAtomic,
  TEACHER_AVAILABILITY_ATOMIC_REVIEW_RPC,
  TEACHER_AVAILABILITY_SUBMISSIONS_RPC,
} from "@/lib/ops-store";
import {
  buildTeacherAvailabilityReviewInbox,
  hasTeacherAvailabilityReviewAdminAccess,
  parseTeacherAvailabilityReviewRequest,
  prepareTeacherAvailabilityReview,
  TeacherAvailabilityReviewServiceError,
} from "@/lib/teacher-availability-review-service";

export const dynamic = "force-dynamic";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function requireAdmin() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return { response: noStore({ error: resolved.error }, resolved.status) } as const;
  const { session } = resolved;
  const actor = session.user;
  const fullAdmin = actor === DEMO_ADMIN_USER && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!hasTeacherAvailabilityReviewAdminAccess(actor, fullAdmin)) {
    return { response: noStore({ error: "只有管理员可以审核老师 AVA。" }, 403) } as const;
  }
  return { session: { actor, fullAdmin } } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "PGRST202" || error.code === "42883");
}

function contractUnavailable() {
  return noStore({
    error: "AVA 审批数据库合同尚未部署，当前不能读取或提交审批。",
    code: "teacher_availability_review_contract_unavailable",
    requiredRpcs: [
      TEACHER_AVAILABILITY_SUBMISSIONS_RPC,
      TEACHER_AVAILABILITY_ATOMIC_REVIEW_RPC,
    ],
  }, 501);
}

function serviceError(error: TeacherAvailabilityReviewServiceError) {
  if (error.code === "submission_not_found" || error.code === "teacher_not_found") {
    return noStore({ error: error.message, code: error.code }, 404);
  }
  if (error.code === "submission_changed" || error.code === "stale_teacher_version") {
    return noStore({ error: error.message, code: error.code }, 409);
  }
  if (error.code === "invalid_teachers_state" || error.code === "invalid_submission_rows") {
    return noStore({ error: error.message, code: error.code }, 503);
  }
  return noStore({ error: error.message, code: error.code }, 422);
}

async function currentReviewRows() {
  const [submissions, rows] = await Promise.all([
    getTeacherAvailabilitySubmissions(),
    getOpsState(["teachers"]),
  ]);
  return {
    submissions,
    teachersRow: rows.find((row) => row.entity === "teachers"),
  };
}

export async function GET() {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  try {
    const current = await currentReviewRows();
    return noStore(buildTeacherAvailabilityReviewInbox({
      rows: current.submissions,
      teachersRow: current.teachersRow,
    }));
  } catch (error) {
    if (missingRpc(error)) return contractUnavailable();
    if (error instanceof TeacherAvailabilityReviewServiceError) return serviceError(error);
    return noStore({
      error: error instanceof Error ? error.message : "AVA 审批列表读取失败。",
    }, 503);
  }
}

/**
 * Re-reads the pending submission and current teacher state, computes the
 * approved windows on the server, then delegates exactly one atomic RPC.
 */
export async function POST(request: Request) {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  try {
    const reviewRequest = parseTeacherAvailabilityReviewRequest(
      await request.json().catch(() => null),
    );
    const current = await currentReviewRows();
    const prepared = prepareTeacherAvailabilityReview({
      request: reviewRequest,
      rows: current.submissions,
      teachersRow: current.teachersRow,
      actor: access.session.actor,
      fullAdmin: access.session.fullAdmin,
    });
    const saved = await reviewTeacherAvailabilitySubmissionAtomic(prepared);
    if (!saved[0]) {
      throw new OpsStoreError("AVA 原子审批没有返回保存结果。", "invalid_review_result");
    }
    const teacherRow = (await getOpsState(["teachers"]))
      .find((row) => row.entity === "teachers");
    if (!teacherRow || teacherRow.version < saved[0].teacher_version) {
      throw new OpsStoreError("AVA 审批后没有读到老师目录结果。", "missing_teacher_result");
    }
    return noStore({
      reviewed: true,
      submissionId: saved[0].submission_id,
      status: saved[0].status,
      teacherVersion: saved[0].teacher_version,
      reviewedAt: saved[0].reviewed_at,
      reviewedBy: saved[0].reviewed_by,
      auditEntryId: saved[0].audit_entry_id,
      teacherRow,
    });
  } catch (error) {
    if (missingRpc(error)) return contractUnavailable();
    if (error instanceof TeacherAvailabilityReviewServiceError) return serviceError(error);
    if (error instanceof OpsStoreError
      && (error.code === "40001"
        || error.code === "23505"
        || error.message === "version_conflict"
        || error.message === "availability_submission_status_changed"
        || error.message === "availability_submission_already_reviewed")) {
      return noStore({
        error: "老师资料或该 AVA 提交刚刚发生变化，请刷新后重试。",
        code: "availability_review_conflict",
      }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "P0002") {
      return noStore({ error: error.message, code: "availability_review_not_found" }, 404);
    }
    if (error instanceof OpsStoreError && error.code === "22023") {
      return noStore({ error: error.message, code: "invalid_availability_review" }, 422);
    }
    return noStore({
      error: error instanceof Error ? error.message : "AVA 审批失败。",
    }, 503);
  }
}
