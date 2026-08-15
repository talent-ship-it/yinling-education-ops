import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DEMO_ADMIN_USER,
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  clearStudentImportIdentityLinks,
  getLatestStudentImportSourceRows,
  getOpsState,
  getStudentImportIdentityReviewContract,
  getStudentImportIdentityReviewTokenSecret,
  OpsStoreError,
  putStudentImportIdentityReviewDecision,
  putStudentImportIdentityReviewPair,
  STUDENT_IMPORT_IDENTITY_CLEAR_RPC,
  STUDENT_IMPORT_IDENTITY_REVIEW_PAIR_RPC,
  STUDENT_IMPORT_IDENTITY_REVIEW_CONTRACT_RPC,
  STUDENT_IMPORT_IDENTITY_REVIEW_PUT_RPC,
} from "@/lib/ops-store";
import {
  hasStudentImportAdminAccess,
  parseStudentIdentityManualReviewRequest,
  parseStudentIdentityReviewClearRequest,
  parseStudentIdentityReviewRequest,
  prepareStudentIdentityReview,
  resolveStudentIdentityReviewCandidate,
  StudentImportServiceError,
} from "@/lib/student-import-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 4 * 1024;

class InvalidIdentityReviewError extends Error {}

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
    return { response: noStore({ error: "只有管理员可以确认学生身份关联。" }, 403) } as const;
  }
  return { actor: session.user } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "PGRST202" || error.code === "42883");
}

async function currentReview() {
  const [sourceSnapshot, rows, contract] = await Promise.all([
    getLatestStudentImportSourceRows(),
    getOpsState(["students"]),
    getStudentImportIdentityReviewContract(),
  ]);
  if (contract.contractVersion !== 2) {
    throw new OpsStoreError("学生身份审核数据库合同版本不匹配。", "PGRST202");
  }
  return {
    sourceSnapshot,
    review: prepareStudentIdentityReview({
      sourceSnapshot,
      studentsRow: rows.find((row) => row.entity === "students"),
      manualTokenSecret: getStudentImportIdentityReviewTokenSecret(),
    }),
  };
}

/** Returns display evidence and opaque closed options; normalized keys and IDs stay server-side. */
export async function GET() {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  try {
    const { review } = await currentReview();
    return noStore({
      candidates: review.candidates,
      identityLinkCount: review.identityLinkCount,
      clearKey: review.clearKey,
      manualReview: review.manualReview,
    });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "学生身份审核数据库合同尚未部署。",
        code: "student_import_identity_review_contract_unavailable",
        requiredRpcs: [
          STUDENT_IMPORT_IDENTITY_CLEAR_RPC,
          STUDENT_IMPORT_IDENTITY_REVIEW_CONTRACT_RPC,
          STUDENT_IMPORT_IDENTITY_REVIEW_PAIR_RPC,
          STUDENT_IMPORT_IDENTITY_REVIEW_PUT_RPC,
        ],
      }, 501);
    }
    if (error instanceof StudentImportServiceError) {
      return noStore({ error: error.message, code: error.code }, 503);
    }
    return noStore({
      error: error instanceof Error ? error.message : "学生身份审核候选读取失败。",
    }, 503);
  }
}

/** Accepts only opaque clear, suggested-decision, or manual-pair tokens. */
export async function POST(request: Request) {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return noStore({ error: "身份审核请求不能超过 4 KB。", code: "identity_review_too_large" }, 413);
  }

  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      return noStore({ error: "身份审核请求不能超过 4 KB。", code: "identity_review_too_large" }, 413);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new InvalidIdentityReviewError("身份审核请求必须是有效 JSON。");
    }
    const { review } = await currentReview();
    if (payload && typeof payload === "object" && !Array.isArray(payload)
      && "decision" in payload && payload.decision === "clear") {
      const confirmation = parseStudentIdentityReviewClearRequest(payload);
      const saved = await clearStudentImportIdentityLinks({
        resolutionKey: confirmation.resolutionKey,
        actor: access.actor,
      });
      return noStore({
        saved: true,
        fingerprint: saved.fingerprint,
        count: saved.count,
        unchanged: saved.unchanged,
        reviewEpoch: saved.reviewEpoch,
      });
    }

    if (payload && typeof payload === "object" && !Array.isArray(payload)
      && "masterToken" in payload) {
      const confirmation = parseStudentIdentityManualReviewRequest(payload);
      const saved = await putStudentImportIdentityReviewPair({
        ...confirmation,
        actor: access.actor,
      });
      return noStore({
        saved: true,
        resolutionKey: saved.resolutionKey,
        decision: saved.decision,
        fingerprint: saved.fingerprint,
        count: saved.count,
        unchanged: saved.unchanged,
      });
    }

    const confirmation = parseStudentIdentityReviewRequest(payload);
    resolveStudentIdentityReviewCandidate(confirmation, review.decisionCandidates);
    const saved = await putStudentImportIdentityReviewDecision({
      resolutionKey: confirmation.resolutionKey,
      decision: confirmation.decision,
      actor: access.actor,
    });
    // Shape the response explicitly so a future database response can never
    // expose a resolved target student ID to the browser.
    return noStore({
      saved: true,
      resolutionKey: saved.resolutionKey,
      decision: saved.decision,
      fingerprint: saved.fingerprint,
      count: saved.count,
      unchanged: saved.unchanged,
    });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "学生身份审核数据库合同尚未部署。",
        code: "student_import_identity_review_contract_unavailable",
        requiredRpcs: [
          STUDENT_IMPORT_IDENTITY_CLEAR_RPC,
          STUDENT_IMPORT_IDENTITY_REVIEW_CONTRACT_RPC,
          STUDENT_IMPORT_IDENTITY_REVIEW_PAIR_RPC,
          STUDENT_IMPORT_IDENTITY_REVIEW_PUT_RPC,
        ],
      }, 501);
    }
    if (error instanceof StudentImportServiceError) {
      return noStore({ error: error.message, code: error.code },
        error.code === "identity_review_unavailable" ? 409 : 422);
    }
    if (error instanceof InvalidIdentityReviewError
      || (error instanceof OpsStoreError && error.code === "22023")) {
      return noStore({
        error: error.message,
        code: "invalid_student_import_identity_review",
      }, 422);
    }
    if (error instanceof OpsStoreError
      && (["23503", "23505", "40001"].includes(error.code ?? "")
        || error.message === "student_import_identity_review_unavailable"
        || error.message === "student_import_identity_links_conflict")) {
      return noStore({
        error: "来源版本、学生记录或审核候选已变化，请刷新后重新确认。",
        code: "student_import_identity_review_conflict",
      }, 409);
    }
    return noStore({
      error: error instanceof Error ? error.message : "学生身份审核保存失败。",
    }, 503);
  }
}
