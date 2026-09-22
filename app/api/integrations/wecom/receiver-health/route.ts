import { NextResponse } from "next/server";

import {
  hasWecomArchiveBridgeToken,
  readBoundedWecomArchiveJson,
  wecomArchiveBridgeConfiguration,
} from "@/lib/wecom-archive-bridge";
import { OpsStoreError, recordWecomReceiverHealth } from "@/lib/ops-store";
import { normalizeWecomReceiverHealth, WecomReceiverHealthError } from "@/lib/wecom-receiver-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** Trusted worker heartbeat; only aggregate counters and bounded error codes are accepted. */
export async function POST(request: Request) {
  const configuration = wecomArchiveBridgeConfiguration();
  if (!hasWecomArchiveBridgeToken(request.headers.get("authorization"), configuration)) {
    return noStore({ error: "Not found" }, 404);
  }
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers.get("content-type") ?? "")) {
    return noStore({ error: "Unsupported media type" }, 415);
  }
  try {
    const health = normalizeWecomReceiverHealth(await readBoundedWecomArchiveJson(request));
    await recordWecomReceiverHealth(health);
    return noStore({ outcome: "committed" });
  } catch (error) {
    if (error instanceof RangeError) return noStore({ error: "WeCom health request is too large.", code: "payload_too_large" }, 413);
    if (error instanceof SyntaxError) return noStore({ error: "WeCom health request is not valid JSON.", code: "invalid_json" }, 400);
    if (error instanceof WecomReceiverHealthError) return noStore({ error: error.message, code: error.code }, 422);
    const contractMissing = error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
    console.error("wecom_receiver_health_failed", {
      category: contractMissing ? "contract_unavailable" : error instanceof OpsStoreError ? error.code ?? "ops_rpc" : "health",
    });
    return noStore({
      error: contractMissing ? "WeCom receiver health contract is not deployed." : "WeCom receiver health was not committed.",
      code: contractMissing ? "contract_unavailable" : "health_commit_failed",
    }, contractMissing ? 501 : 503);
  }
}
