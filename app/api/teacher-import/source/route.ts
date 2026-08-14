import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DEMO_ADMIN_USER,
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  OpsStoreError,
  putTeacherImportSource,
  TEACHER_IMPORT_SOURCE_INGEST_RPC,
} from "@/lib/ops-store";
import {
  hasTeacherImportAdminAccess,
  parseTeacherImportSourceIngestRequest,
  TeacherImportServiceError,
} from "@/lib/teacher-import-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

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
  if (!hasTeacherImportAdminAccess(session.user, fullAdmin)) {
    return { response: noStore({ error: "只有管理员可以录入正式老师来源。" }, 403) } as const;
  }
  return { actor: session.user } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "PGRST202" || error.code === "42883");
}

/** Stores one workbook snapshot; this route never fetches Tencent documents. */
export async function POST(request: Request) {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return noStore({ error: "老师来源 JSON 不能超过 16 MB。", code: "source_upload_too_large" }, 413);
  }

  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      return noStore({ error: "老师来源 JSON 不能超过 16 MB。", code: "source_upload_too_large" }, 413);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new TeacherImportServiceError(
        "invalid_source_ingest_request",
        "Teacher source upload must be valid JSON.",
      );
    }
    const input = parseTeacherImportSourceIngestRequest(payload);
    const saved = await putTeacherImportSource({ ...input, actor: access.actor });
    return noStore({ ingested: true, source: saved });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "老师来源录入数据库合同尚未部署。",
        code: "teacher_import_source_contract_unavailable",
        requiredRpc: TEACHER_IMPORT_SOURCE_INGEST_RPC,
      }, 501);
    }
    if (error instanceof TeacherImportServiceError) {
      return noStore({ error: error.message, code: error.code }, 422);
    }
    if (error instanceof OpsStoreError
      && (error.code === "23505" || error.message === "teacher_import_revision_conflict")) {
      return noStore({
        error: "相同 revision 已存在不同内容，请使用新的 revision 或核对文件。",
        code: "teacher_import_revision_conflict",
      }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "22023") {
      return noStore({ error: error.message, code: "invalid_teacher_import_source" }, 422);
    }
    return noStore({
      error: error instanceof Error ? error.message : "老师来源录入失败。",
    }, 503);
  }
}
