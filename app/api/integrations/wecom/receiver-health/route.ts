import { OpsStoreError, recordWecomReceiverHealth } from "@/lib/ops-store";
import { normalizeWecomReceiverHealth } from "@/lib/wecom-receiver-health";
import { wecomReceiverHealthFailure } from "@/lib/wecom-receiver-health-http";
import { readTrustedWecomJsonRequest, wecomNoStoreJson as noStore } from "@/lib/wecom-private-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function opsStoreErrorCode(error: unknown) {
  return error instanceof OpsStoreError ? error.code ?? "ops_rpc" : undefined;
}

function logReceiverHealthFailure(category: string | null) {
  if (category) console.error("wecom_receiver_health_failed", { category });
}

/** Trusted worker heartbeat; only aggregate counters and bounded error codes are accepted. */
export async function POST(request: Request) {
  try {
    const prepared = await readTrustedWecomJsonRequest(request);
    if ("rejection" in prepared) return prepared.rejection;
    const health = normalizeWecomReceiverHealth(prepared.payload);
    await recordWecomReceiverHealth(health);
    return noStore({ outcome: "committed" });
  } catch (error) {
    const failure = wecomReceiverHealthFailure(error, opsStoreErrorCode(error));
    logReceiverHealthFailure(failure.logCategory);
    return noStore(failure.payload, failure.status);
  }
}
