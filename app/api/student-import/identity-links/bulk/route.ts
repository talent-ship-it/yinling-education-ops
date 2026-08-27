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
  getStudentImportIdentityBulkReviewPreview,
  OpsStoreError,
  putStudentImportIdentityBulkReview,
  STUDENT_IMPORT_IDENTITY_BULK_PREVIEW_RPC,
  STUDENT_IMPORT_IDENTITY_BULK_PUT_RPC,
} from "@/lib/ops-store";
import { hasStudentImportAdminAccess } from "@/lib/student-import-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 512;
const OPAQUE_KEY = /^sha256:[a-f0-9]{64}$/;

class InvalidBulkIdentityReviewError extends Error {}

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
  if (!hasStudentImportAdminAccess(session.user, fullAdmin)
      || !hasDemoSessionPermission(session, permission)
      || !hasUnrestrictedDemoSessionScope(session)) {
    return { response: noStore({ error: "只有管理员可以批量确认学生身份关联。" }, 403) } as const;
  }
  return { actor: session.user } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "PGRST202" || error.code === "42883");
}

function unavailableContract() {
  return noStore({
    error: "学生身份批量审核数据库合同尚未部署。",
    code: "student_import_identity_bulk_review_contract_unavailable",
    requiredRpcs: [
      STUDENT_IMPORT_IDENTITY_BULK_PREVIEW_RPC,
      STUDENT_IMPORT_IDENTITY_BULK_PUT_RPC,
    ],
  }, 501);
}

/** Returns counts plus one opaque, state-bound merge-only confirmation key. */
export async function GET() {
  const access = await requireAdmin("operations.read");
  if ("response" in access) return access.response;

  try {
    const preview = await getStudentImportIdentityBulkReviewPreview();
    return noStore({
      confirmationKey: preview.confirmationKey,
      mergeCandidateCount: preview.mergeCandidateCount,
      pendingMergeCount: preview.pendingMergeCount,
      alreadyLinkedMergeCount: preview.alreadyLinkedMergeCount,
      currentLinkCount: preview.currentLinkCount,
      resultingLinkCount: preview.resultingLinkCount,
      canSubmit: preview.canSubmit,
    });
  } catch (error) {
    if (missingRpc(error)) return unavailableContract();
    if (error instanceof OpsStoreError && ["23503", "23505", "40001"].includes(error.code ?? "")) {
      return noStore({
        error: "来源版本、学生记录或身份链接已变化，请刷新后重新确认。",
        code: "student_import_identity_bulk_review_conflict",
      }, 409);
    }
    return noStore({
      error: error instanceof Error ? error.message : "批量身份审核预检失败。",
    }, 503);
  }
}

/** Accepts no identities or decisions: only the exact opaque key returned by GET. */
export async function POST(request: Request) {
  const access = await requireAdmin("operations.write");
  if ("response" in access) return access.response;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return noStore({ error: "批量身份审核请求不能超过 512 bytes。", code: "identity_bulk_review_too_large" }, 413);
  }

  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      return noStore({ error: "批量身份审核请求不能超过 512 bytes。", code: "identity_bulk_review_too_large" }, 413);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new InvalidBulkIdentityReviewError("批量身份审核请求必须是有效 JSON。");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).length !== 1 || !("confirmationKey" in payload)
      || typeof payload.confirmationKey !== "string" || !OPAQUE_KEY.test(payload.confirmationKey)) {
      throw new InvalidBulkIdentityReviewError("批量身份审核只接受当前预检生成的确认令牌。");
    }

    const saved = await putStudentImportIdentityBulkReview({
      confirmationKey: payload.confirmationKey,
      actor: access.actor,
    });
    return noStore({
      saved: true,
      confirmationKey: saved.confirmationKey,
      fingerprint: saved.fingerprint,
      count: saved.count,
      requestedCount: saved.requestedCount,
      newlyAppliedCount: saved.newlyAppliedCount,
      alreadyAppliedCount: saved.alreadyAppliedCount,
      finalCount: saved.finalCount,
      unchanged: saved.unchanged,
    });
  } catch (error) {
    if (missingRpc(error)) return unavailableContract();
    if (error instanceof InvalidBulkIdentityReviewError
      || (error instanceof OpsStoreError && error.code === "22023")) {
      return noStore({
        error: error.message,
        code: "invalid_student_import_identity_bulk_review",
      }, 422);
    }
    if (error instanceof OpsStoreError
      && (["23503", "23505", "40001"].includes(error.code ?? "")
        || error.message.startsWith("student_import_identity_bulk_review_"))) {
      return noStore({
        error: "来源版本、学生记录、重复记录或身份链接已变化，请刷新后重新确认。",
        code: "student_import_identity_bulk_review_conflict",
      }, 409);
    }
    return noStore({
      error: error instanceof Error ? error.message : "学生身份批量审核保存失败。",
    }, 503);
  }
}
