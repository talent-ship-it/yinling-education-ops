import { NextResponse } from "next/server";

import {
  hasWecomArchiveBridgeToken,
  readBoundedWecomArchiveJson,
  wecomArchiveBridgeConfiguration,
} from "@/lib/wecom-archive-bridge";
import { OpsStoreError, recordWecomReceiverHealth } from "@/lib/ops-store";
import { normalizeWecomReceiverHealth } from "@/lib/wecom-receiver-health";
import { wecomReceiverHealthFailure } from "@/lib/wecom-receiver-health-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function opsStoreErrorCode(error: unknown) {
  return error instanceof OpsStoreError ? error.code ?? "ops_rpc" : undefined;
}

function logReceiverHealthFailure(category: string | null) {
  if (category) console.error("wecom_receiver_health_failed", { category });
}

function receiverHealthRequestRejection(
  request: Request,
  configuration: ReturnType<typeof wecomArchiveBridgeConfiguration>,
) {
  if (!hasWecomArchiveBridgeToken(request.headers.get("authorization"), configuration)) {
    return noStore({ error: "Not found" }, 404);
  }
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers.get("content-type") ?? "")) {
    return noStore({ error: "Unsupported media type" }, 415);
  }
  return null;
}

/** Trusted worker heartbeat; only aggregate counters and bounded error codes are accepted. */
export async function POST(request: Request) {
  const configuration = wecomArchiveBridgeConfiguration();
  const rejection = receiverHealthRequestRejection(request, configuration);
  if (rejection) return rejection;
  try {
    const health = normalizeWecomReceiverHealth(await readBoundedWecomArchiveJson(request));
    await recordWecomReceiverHealth(health);
    return noStore({ outcome: "committed" });
  } catch (error) {
    const failure = wecomReceiverHealthFailure(error, opsStoreErrorCode(error));
    logReceiverHealthFailure(failure.logCategory);
    return noStore(failure.payload, failure.status);
  }
}
