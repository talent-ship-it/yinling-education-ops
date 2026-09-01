import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_ADMIN_USER, DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasValidNixonSession, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getOpsState,
  getWecomArchiveStatus,
  ingestWecomArchiveBatch,
  linkWecomArchiveMessage,
  OpsStoreError,
  readWecomArchiveInbox,
  WECOM_ARCHIVE_INGEST_RPC,
} from "@/lib/ops-store";
import { normalizeWecomArchiveBatch, WecomArchiveParseError } from "@/lib/wecom-archive";
import {
  hasWecomArchiveBridgeToken,
  readBoundedWecomArchiveJson,
  wecomArchiveBridgeConfiguration,
} from "@/lib/wecom-archive-bridge";
import { wecomCallbackHttpConfiguration } from "@/lib/wecom-callback-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function fullAdminSession() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) {
    return { ok: false, error: resolved.error, status: resolved.status } as const;
  }
  const { session } = resolved;
  const fullAdmin = session.user === DEMO_ADMIN_USER
    && session.role === "admin"
    && hasValidNixonSession(cookieStore.get(NIXON_COOKIE_NAME)?.value);
  return fullAdmin
    ? { ok: true, session } as const
    : { ok: false, error: "只有超级管理员可以管理企业微信接入。", status: 403 } as const;
}

/** Admin-only readiness and review inbox; no credential value is returned. */
export async function GET() {
  const resolved = await fullAdminSession();
  if (!resolved.ok) return noStore({ error: resolved.error }, resolved.status);
  const bridge = wecomArchiveBridgeConfiguration();
  const callback = wecomCallbackHttpConfiguration();
  try {
    const [status, inbox] = await Promise.all([
      getWecomArchiveStatus(),
      readWecomArchiveInbox(100),
    ]);
    return noStore({
      contractReady: true,
      enabled: bridge.ready,
      bridge: { ready: bridge.ready, missing: bridge.missing },
      callback: { ready: callback.ready, invalid: callback.invalid, missing: callback.missing },
      status,
      inbox,
    });
  } catch (error) {
    const contractMissing = error instanceof OpsStoreError
      && (error.code === "PGRST202" || error.code === "42883");
    if (!contractMissing) {
      console.error("wecom_archive_status_failed", {
        category: error instanceof OpsStoreError ? error.code ?? "ops_rpc" : "status",
      });
    }
    return noStore({
      contractReady: false,
      enabled: false,
      bridge: { ready: bridge.ready, missing: bridge.missing },
      callback: { ready: callback.ready, invalid: callback.invalid, missing: callback.missing },
      status: null,
      inbox: [],
      code: contractMissing ? "contract_unavailable" : "status_unavailable",
      requiredRpc: WECOM_ARCHIVE_INGEST_RPC,
    }, contractMissing ? 501 : 503);
  }
}

/** Trusted worker boundary for decrypted, media-complete conversation records. */
export async function POST(request: Request) {
  const configuration = wecomArchiveBridgeConfiguration();
  if (!hasWecomArchiveBridgeToken(request.headers.get("authorization"), configuration)) {
    return noStore({ error: "Not found" }, 404);
  }
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers.get("content-type") ?? "")) {
    return noStore({ error: "Unsupported media type" }, 415);
  }
  try {
    const payload = await readBoundedWecomArchiveJson(request);
    const records = normalizeWecomArchiveBatch(payload);
    if (!configuration.startedAt) return noStore({ error: "Not found" }, 404);
    const result = await ingestWecomArchiveBatch({
      records,
      startedAt: configuration.startedAt,
    });
    return noStore({ outcome: "committed", ...result });
  } catch (error) {
    if (error instanceof RangeError) return noStore({ error: "WeCom archive batch is too large.", code: "payload_too_large" }, 413);
    if (error instanceof SyntaxError) return noStore({ error: "WeCom archive request is not valid JSON.", code: "invalid_json" }, 400);
    if (error instanceof WecomArchiveParseError) {
      return noStore({ error: error.message, code: error.code }, 422);
    }
    const contractMissing = error instanceof OpsStoreError
      && (error.code === "PGRST202" || error.code === "42883");
    const conflict = error instanceof OpsStoreError && error.code === "23505";
    const rejected = error instanceof OpsStoreError && error.code === "22023";
    console.error("wecom_archive_ingest_failed", {
      category: contractMissing ? "contract_unavailable" : conflict ? "archive_identity_conflict"
        : rejected ? "archive_record_rejected"
        : error instanceof OpsStoreError ? error.code ?? "ops_rpc" : "ingest",
    });
    return noStore({
      error: contractMissing
        ? "WeCom archive database contract is not deployed."
        : conflict ? "A WeCom message or attachment identifier conflicts with existing content."
          : rejected ? "The WeCom archive record was rejected by the database contract."
          : "WeCom archive batch was not committed.",
      code: contractMissing ? "contract_unavailable" : conflict ? "archive_conflict"
        : rejected ? "archive_record_rejected" : "ingest_failed",
      ...(contractMissing ? { requiredRpc: WECOM_ARCHIVE_INGEST_RPC } : {}),
    }, contractMissing ? 501 : conflict ? 409 : rejected ? 422 : 503);
  }
}

/** Explicit full-admin association for pending/ambiguous records; it is atomic and audited. */
export async function PATCH(request: Request) {
  const resolved = await fullAdminSession();
  if (!resolved.ok) return noStore({ error: resolved.error }, resolved.status);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).sort().join(",") !== "messageId,studentId"
    || typeof body.messageId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$/u.test(body.messageId)
    || typeof body.studentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(body.studentId)) {
    return noStore({ error: "企业微信关联参数无效。", code: "invalid_link" }, 400);
  }
  try {
    const rows = await getOpsState(["students"]);
    const students = rows[0]?.entity === "students" && Array.isArray(rows[0].payload)
      ? rows[0].payload.filter((student): student is Record<string, unknown> => Boolean(student)
        && typeof student === "object" && !Array.isArray(student))
      : [];
    if (!students.some((student) => student.id === body.studentId && student.importArchived !== true)) {
      return noStore({ error: "未找到可关联的活跃学生。", code: "student_not_found" }, 404);
    }
    const result = await linkWecomArchiveMessage({
      messageId: body.messageId,
      studentId: body.studentId,
      actor: resolved.session.user,
    });
    return noStore({ committed: true, ...result });
  } catch (error) {
    const conflict = error instanceof OpsStoreError && error.code === "23505";
    const missing = error instanceof OpsStoreError && error.code === "P0002";
    return noStore({
      error: conflict ? "该企业微信记录已关联到其他学生。" : missing ? "未找到该企业微信记录。" : "企业微信记录关联失败。",
      code: conflict ? "link_conflict" : missing ? "message_not_found" : "link_failed",
    }, conflict ? 409 : missing ? 404 : 503);
  }
}
