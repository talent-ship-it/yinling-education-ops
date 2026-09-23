import { WecomArchiveParseError } from "@/lib/wecom-archive";
import { WecomBotRecordError, normalizeWecomBotBatch } from "@/lib/wecom-bot-receiver";
import { enrichWecomBotRecords } from "@/lib/wecom-bot-routing";
import { ingestWecomBotBatch, OpsStoreError } from "@/lib/ops-store";
import { readTrustedWecomJsonRequest, wecomNoStoreJson as noStore } from "@/lib/wecom-private-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Private receiver boundary. Text callbacks share the archive classifier so
 * handovers reach the internal inbox immediately; the database auto-links
 * only a unique exact active-student identity. Media callbacks and
 * unclassified text remain pending evidence without changing business state.
 */
export async function POST(request: Request) {
  try {
    const prepared = await readTrustedWecomJsonRequest(request);
    if ("rejection" in prepared) return prepared.rejection;
    const { configuration, payload } = prepared;
    const records = normalizeWecomBotBatch(payload);
    if (!configuration.startedAt) return noStore({ error: "Not found" }, 404);
    const enrichedRecords = enrichWecomBotRecords(records);
    const result = await ingestWecomBotBatch({ records: enrichedRecords, startedAt: configuration.startedAt });
    return noStore({ outcome: "committed", ...result });
  } catch (error) {
    if (error instanceof RangeError) return noStore({ error: "WeCom bot batch is too large.", code: "payload_too_large" }, 413);
    if (error instanceof SyntaxError) return noStore({ error: "WeCom bot request is not valid JSON.", code: "invalid_json" }, 400);
    if (error instanceof WecomBotRecordError) return noStore({ error: error.message, code: error.code }, 422);
    if (error instanceof WecomArchiveParseError) return noStore({ error: error.message, code: error.code }, 422);

    const contractMissing = error instanceof OpsStoreError
      && (error.code === "PGRST202" || error.code === "42883");
    const conflict = error instanceof OpsStoreError && error.code === "23505";
    const rejected = error instanceof OpsStoreError && error.code === "22023";
    console.error("wecom_bot_ingest_failed", {
      category: contractMissing ? "contract_unavailable" : conflict ? "bot_identity_conflict"
        : rejected ? "bot_record_rejected" : error instanceof OpsStoreError ? error.code ?? "ops_rpc" : "ingest",
    });
    return noStore({
      error: contractMissing
        ? "WeCom bot database contract is not deployed."
        : conflict ? "A WeCom bot message identifier conflicts with existing content."
          : rejected ? "The WeCom bot record was rejected by the database contract."
            : "WeCom bot batch was not committed.",
      code: contractMissing ? "contract_unavailable" : conflict ? "bot_conflict"
        : rejected ? "bot_record_rejected" : "ingest_failed",
    }, contractMissing ? 501 : conflict ? 409 : rejected ? 422 : 503);
  }
}
