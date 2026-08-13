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
  putStudentImportSourceRows,
  STUDENT_IMPORT_SOURCE_INGEST_RPC,
} from "@/lib/ops-store";
import {
  hasStudentImportAdminAccess,
  parseStudentImportSourceIngestRequest,
  StudentImportServiceError,
} from "@/lib/student-import-service";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

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
  if (!hasStudentImportAdminAccess(actor, fullAdmin)) {
    return { response: noStore({ error: "只有管理员可以录入正式学生来源。" }, 403) } as const;
  }
  return { actor } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "PGRST202" || error.code === "42883");
}

/**
 * Stores one named, revisioned JSON source snapshot. It never fetches a remote
 * source and never infers that an upload is newer than another revision.
 */
export async function POST(request: Request) {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return noStore({ error: "来源 JSON 不能超过 8 MB。", code: "source_upload_too_large" }, 413);
  }

  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      return noStore({ error: "来源 JSON 不能超过 8 MB。", code: "source_upload_too_large" }, 413);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new StudentImportServiceError(
        "invalid_source_ingest_request",
        "Source upload must be valid JSON.",
      );
    }
    const input = parseStudentImportSourceIngestRequest(payload);
    const saved = await putStudentImportSourceRows({ ...input, actor: access.actor });
    return noStore({ ingested: true, source: saved });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "学生来源录入数据库合同尚未部署。",
        code: "student_import_source_ingest_contract_unavailable",
        requiredRpc: STUDENT_IMPORT_SOURCE_INGEST_RPC,
      }, 501);
    }
    if (error instanceof StudentImportServiceError) {
      return noStore({ error: error.message, code: error.code }, 422);
    }
    if (error instanceof OpsStoreError
      && (error.code === "23505" || error.message === "student_import_revision_conflict")) {
      return noStore({
        error: "相同 revision 已存在不同内容，请使用新的 revision 或核对文件。",
        code: "student_import_revision_conflict",
      }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "22023") {
      return noStore({ error: error.message, code: "invalid_student_import_source_rows" }, 422);
    }
    return noStore({
      error: error instanceof Error ? error.message : "学生来源录入失败。",
    }, 503);
  }
}
