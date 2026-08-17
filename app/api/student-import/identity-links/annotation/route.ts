import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DEMO_ADMIN_USER,
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getStudentImportIdentityAnnotationReviewPreview,
  OpsStoreError,
  putStudentImportIdentityAnnotationReview,
  STUDENT_IMPORT_IDENTITY_ANNOTATION_PREVIEW_RPC,
  STUDENT_IMPORT_IDENTITY_ANNOTATION_PUT_RPC,
} from "@/lib/ops-store";
import { hasStudentImportAdminAccess } from "@/lib/student-import-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 512;
const OPAQUE_KEY = /^sha256:[a-f0-9]{64}$/;

class InvalidAnnotationReviewError extends Error {}

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function requireAdmin() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) {
    return { response: noStore({ error: resolved.error }, resolved.status) } as const;
  }
  const { session } = resolved;
  const fullAdmin = session.user === DEMO_ADMIN_USER && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!hasStudentImportAdminAccess(session.user, fullAdmin)) {
    return { response: noStore({ error: "只有管理员可以确认教务宝括号备注身份关联。" }, 403) } as const;
  }
  return { actor: session.user } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "PGRST202" || error.code === "42883");
}

function unavailableContract() {
  return noStore({
    error: "教务宝括号备注身份审核数据库合同尚未部署。",
    code: "student_import_identity_annotation_review_contract_unavailable",
    requiredRpcs: [
      STUDENT_IMPORT_IDENTITY_ANNOTATION_PREVIEW_RPC,
      STUDENT_IMPORT_IDENTITY_ANNOTATION_PUT_RPC,
    ],
  }, 501);
}

/**
 * Shows only counts plus a state-bound opaque key. The database has already
 * required a single trailing ASCII-letter annotation, exact body equality and
 * source-wide one-to-one uniqueness before issuing this key.
 */
export async function GET() {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  try {
    const preview = await getStudentImportIdentityAnnotationReviewPreview();
    return noStore({
      confirmationKey: preview.confirmationKey,
      candidateCount: preview.candidateCount,
      pendingCount: preview.pendingCount,
      alreadyLinkedCount: preview.alreadyLinkedCount,
      currentLinkCount: preview.currentLinkCount,
      resultingLinkCount: preview.resultingLinkCount,
      canSubmit: preview.canSubmit,
    });
  } catch (error) {
    if (missingRpc(error)) return unavailableContract();
    if (error instanceof OpsStoreError && ["23503", "23505", "40001"].includes(error.code ?? "")) {
      return noStore({
        error: "来源版本、学生记录、重复项决定或身份链接已变化，请刷新后重新确认。",
        code: "student_import_identity_annotation_review_conflict",
      }, 409);
    }
    return noStore({
      error: error instanceof Error ? error.message : "教务宝括号备注身份预检失败。",
    }, 503);
  }
}

/** Accepts no rows, names, IDs, strategies or decisions: only the opaque key. */
export async function POST(request: Request) {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return noStore({ error: "身份审核请求不能超过 512 bytes。", code: "identity_annotation_review_too_large" }, 413);
  }

  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      return noStore({ error: "身份审核请求不能超过 512 bytes。", code: "identity_annotation_review_too_large" }, 413);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new InvalidAnnotationReviewError("身份审核请求必须是有效 JSON。");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).length !== 1 || !("confirmationKey" in payload)
      || typeof payload.confirmationKey !== "string" || !OPAQUE_KEY.test(payload.confirmationKey)) {
      throw new InvalidAnnotationReviewError("括号备注身份审核只接受当前预检生成的确认令牌。");
    }

    const saved = await putStudentImportIdentityAnnotationReview({
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
    if (error instanceof InvalidAnnotationReviewError
      || (error instanceof OpsStoreError && error.code === "22023")) {
      return noStore({
        error: error.message,
        code: "invalid_student_import_identity_annotation_review",
      }, 422);
    }
    if (error instanceof OpsStoreError
      && (["23503", "23505", "40001"].includes(error.code ?? "")
        || error.message.startsWith("student_import_identity_annotation_review_"))) {
      return noStore({
        error: "来源版本、学生记录、重复项决定或身份链接已变化，请刷新后重新确认。",
        code: "student_import_identity_annotation_review_conflict",
      }, 409);
    }
    return noStore({
      error: error instanceof Error ? error.message : "教务宝括号备注身份审核保存失败。",
    }, 503);
  }
}
