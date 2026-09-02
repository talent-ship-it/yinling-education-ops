import { NextResponse } from "next/server";

import {
  BbbAnalyticsError,
  bbbMeetingBindings,
  parseBbbAnalyticsPayload,
  verifyBbbCallbackSignature,
} from "@/lib/bbb-analytics";
import { processBbbAnalyticsCallback } from "@/lib/bbb-analytics-service";
import { OpsStoreError } from "@/lib/ops-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_CALLBACK_BYTES = 2_000_000;

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function queryText(url: URL, name: string, maximum = 300) {
  const value = url.searchParams.get(name)?.trim() ?? "";
  return value.length <= maximum ? value : "";
}

function callbackSecret() {
  const secret = process.env.BBB_API_SECRET?.trim();
  if (!secret) throw new BbbAnalyticsError("Callback secret is unavailable.", "missing_configuration", 503);
  return secret;
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_CALLBACK_BYTES) return response({ error: "Callback body is too large." }, 413);
  const url = new URL(request.url);
  const occurrenceId = queryText(url, "occurrenceId");
  const meetingId = queryText(url, "meetingId");
  const nonce = queryText(url, "nonce");
  const issuedAtText = queryText(url, "issuedAt", 20);
  const issuedAt = /^\d{10}$/u.test(issuedAtText) ? Number(issuedAtText) : Number.NaN;
  const signature = queryText(url, "signature");

  try {
    if (!verifyBbbCallbackSignature({
      secret: callbackSecret(),
      occurrenceId,
      meetingId,
      nonce,
      issuedAt,
      signature,
    })) {
      return response({ error: "Invalid callback signature.", code: "invalid_signature" }, 401);
    }
    const raw = await request.text();
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_CALLBACK_BYTES) {
      return response({ error: "Callback body is invalid." }, raw ? 413 : 400);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return response({ error: "Callback JSON is invalid." }, 400);
    }
    const payload = parseBbbAnalyticsPayload(json);
    if (payload.meetingId !== meetingId) {
      return response({ error: "Callback meeting does not match its signed URL.", code: "meeting_mismatch" }, 401);
    }
    if (bbbMeetingBindings(payload).occurrenceId !== occurrenceId) {
      return response({ error: "Callback occurrence does not match its signed URL.", code: "occurrence_mismatch" }, 401);
    }
    const result = await processBbbAnalyticsCallback({ payload, callbackNonce: nonce });
    return response({ accepted: true, ...result });
  } catch (error) {
    if (error instanceof BbbAnalyticsError) {
      return response({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof OpsStoreError && ["40001", "23505"].includes(error.code ?? "")) {
      return response({ error: "Callback conflicts with current lesson state.", code: error.code }, 409);
    }
    if (error instanceof OpsStoreError && ["PGRST202", "42883"].includes(error.code ?? "")) {
      return response({ error: "Attendance contract is not deployed.", code: "contract_unavailable" }, 503);
    }
    return response({
      error: "Analytics callback failed.",
      code: "callback_failed",
    }, 503);
  }
}
