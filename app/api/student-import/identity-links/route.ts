import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  DEMO_ADMIN_USER,
  DEMO_COOKIE_NAME,
  getCurrentDemoSession,
} from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getLatestStudentImportSourceRows,
  OpsStoreError,
  putStudentImportIdentityLinks,
  STUDENT_IMPORT_IDENTITY_LINKS_PUT_RPC,
} from "@/lib/ops-store";
import { hasStudentImportAdminAccess } from "@/lib/student-import-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

class InvalidIdentityLinksError extends Error {}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseIdentityLinks(value: unknown): readonly [] {
  if (!isRecord(value)
    || Object.keys(value).length !== 1
    || !("links" in value)
    || !Array.isArray(value.links)) {
    throw new InvalidIdentityLinksError(
      "请求必须只包含 links 数组。",
    );
  }
  if (value.links.length !== 0) {
    throw new InvalidIdentityLinksError(
      "当前只允许清除旧身份链接；非空链接必须等待服务端证据审核流程。",
    );
  }
  return [];
}

function missingRpc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "PGRST202" || error.code === "42883");
}

/** Clears legacy links. Non-empty links require a future server-derived opaque review flow. */
export async function POST(request: Request) {
  const access = await requireAdmin();
  if ("response" in access) return access.response;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return noStore({ error: "身份关联 JSON 不能超过 2 MB。", code: "identity_links_too_large" }, 413);
  }

  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      return noStore({ error: "身份关联 JSON 不能超过 2 MB。", code: "identity_links_too_large" }, 413);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new InvalidIdentityLinksError("身份关联请求必须是有效 JSON。");
    }
    const links = parseIdentityLinks(payload);
    const sourceSnapshot = await getLatestStudentImportSourceRows();
    const saved = await putStudentImportIdentityLinks({
      sourceRevisions: {
        master: sourceSnapshot.master.revision,
        jwb: sourceSnapshot.jwb.revision,
      },
      links,
      actor: access.actor,
    });
    return noStore({ saved: true, ...saved });
  } catch (error) {
    if (missingRpc(error)) {
      return noStore({
        error: "学生身份关联数据库合同尚未部署。",
        code: "student_import_identity_links_contract_unavailable",
        requiredRpc: STUDENT_IMPORT_IDENTITY_LINKS_PUT_RPC,
      }, 501);
    }
    if (error instanceof InvalidIdentityLinksError
      || (error instanceof OpsStoreError && error.code === "22023")) {
      return noStore({
        error: error.message,
        code: "invalid_student_import_identity_links",
      }, 422);
    }
    if (error instanceof OpsStoreError
      && (["23503", "23505", "40001"].includes(error.code ?? "")
        || error.message === "student_import_identity_links_conflict")) {
      return noStore({
        error: "来源版本或学生记录已变化，请重新读取来源后再确认。",
        code: "student_import_identity_links_conflict",
      }, 409);
    }
    return noStore({
      error: error instanceof Error ? error.message : "学生身份关联保存失败。",
    }, 503);
  }
}
