import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { hasDemoSessionPermission, hasUnrestrictedDemoSessionScope } from "@/lib/demo-session-token";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getLatestStudentImportSourceRows,
  OpsStoreError,
  putStudentImportSourceRows,
  STUDENT_IMPORT_SOURCE_INGEST_RPC,
  STUDENT_IMPORT_SOURCE_ROWS_RPC,
} from "@/lib/ops-store";
import {
  hasStudentImportAdminAccess,
  parseStudentImportSourceSnapshot,
  parseStudentImportSourceIngestRequest,
  parseStudentImportSourceUnavailableDetail,
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

async function requireAdmin(permission: "operations.read" | "operations.write") {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return { response: noStore({ error: resolved.error }, resolved.status) } as const;
  const { session } = resolved;
  const actor = session.user;
  const fullAdmin = hasFullAdminAccess(session, cookieStore.get(NIXON_COOKIE_NAME)?.value);
  if (!hasStudentImportAdminAccess(actor, fullAdmin)
      || !hasDemoSessionPermission(session, permission)
      || !hasUnrestrictedDemoSessionScope(session)) {
    return { response: noStore({ error: "只有管理员可以录入正式学生来源。" }, 403) } as const;
  }
  return { actor } as const;
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "PGRST202" || error.code === "42883");
}

function missingSourceRows(error: unknown): error is OpsStoreError {
  return error instanceof OpsStoreError
    && error.code === "P0002"
    && error.message === "student_import_source_rows_unavailable";
}

function sourceRowsUnavailable(error: OpsStoreError) {
  const missingSources = parseStudentImportSourceUnavailableDetail(error.detail);
  return noStore({
    ready: false,
    code: "student_import_source_rows_unavailable",
    ...(missingSources ? { missingSources } : {}),
  }, 503);
}

/** Returns readiness metadata only; source rows and student PII stay server-side. */
export async function GET() {
  const access = await requireAdmin("operations.read");
  if ("response" in access) return access.response;

  try {
    const snapshot = parseStudentImportSourceSnapshot(await getLatestStudentImportSourceRows());
    return noStore({
      ready: true,
      sources: {
        master: {
          sourceId: snapshot.master.sourceId,
          revision: snapshot.master.revision,
          rowCount: snapshot.master.rows.length,
        },
        jwb: {
          sourceId: snapshot.jwb.sourceId,
          revision: snapshot.jwb.revision,
          rowCount: snapshot.jwb.rows.length,
        },
      },
    });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        ready: false,
        code: "student_import_source_contract_unavailable",
        requiredRpc: STUDENT_IMPORT_SOURCE_ROWS_RPC,
      }, 501);
    }
    if (missingSourceRows(error)) return sourceRowsUnavailable(error);
    if (error instanceof StudentImportServiceError) {
      return noStore({ ready: false, error: error.message, code: error.code }, 503);
    }
    return noStore({
      ready: false,
      error: "学生来源状态读取失败。",
    }, 503);
  }
}

/**
 * Stores one named, revisioned JSON source snapshot. It never fetches a remote
 * source and never infers that an upload is newer than another revision.
 */
export async function POST(request: Request) {
  const access = await requireAdmin("operations.write");
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
    if (input.sourceKind === "jwb") {
      // Material JWB API snapshots must use the resumable, terminal-only
      // staging protocol. This keeps a browser/request retry from replacing
      // the active source pointer with one oversized, non-resumable payload.
      return noStore({
        error: "教务宝来源必须使用分块 staging 导入，不能通过一次性上传替换。",
        code: "jiaowubao_student_source_chunked_ingest_required",
      }, 409);
    }
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
      return noStore({
        error: error.message,
        code: error.code,
        ...(error.sourceErrorCode ? { sourceCode: error.sourceErrorCode } : {}),
      }, 422);
    }
    if (error instanceof OpsStoreError
      && (error.code === "23505" || error.message === "student_import_revision_conflict")) {
      return noStore({
        error: "相同 revision 已存在不同内容，请使用新的 revision 或核对文件。",
        code: "student_import_revision_conflict",
      }, 409);
    }
    if (error instanceof OpsStoreError && error.code === "22023") {
      return noStore({ error: "学生来源内容无效，请检查后重试。", code: "invalid_student_import_source_rows" }, 422);
    }
    return noStore({
      error: "学生来源录入失败。",
    }, 503);
  }
}
