import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  runTencentTrialLedgerSystemSync,
  TencentTrialLedgerSystemSyncError,
} from "@/lib/tencent-trial-ledger-system-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function hasCronSecret(request: Request) {
  const expected = process.env.TENCENT_TRIAL_LEDGER_CRON_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

/** Supabase pg_cron invokes this production worker; Codex is never in the run path. */
export async function GET(request: Request) {
  if (!hasCronSecret(request)) return noStore({ error: "Not found" }, 404);
  const bridgeToken = process.env.TENCENT_TRIAL_LEDGER_BRIDGE_TOKEN?.trim() ?? "";
  const tencentToken = process.env.TENCENT_DOCS_TOKEN?.trim() ?? "";
  if (!bridgeToken || !tencentToken) {
    return noStore({ error: "腾讯台账系统同步配置不可用。" }, 503);
  }

  try {
    const result = await runTencentTrialLedgerSystemSync({
      bridgeUrl: new URL("/api/integrations/tencent-trial-ledger", request.url),
      bridgeToken,
      tencentToken,
    });
    return noStore(result);
  } catch (error) {
    console.error("tencent_trial_ledger_system_sync_failed", {
      phase: error instanceof TencentTrialLedgerSystemSyncError ? error.phase : "unknown",
      category: error instanceof TencentTrialLedgerSystemSyncError ? error.code : "system_sync_failed",
    });
    return noStore({ error: "腾讯试听台账同步未完成；系统会在下一轮重试。" }, 503);
  }
}
