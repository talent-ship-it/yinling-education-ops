import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  claimTencentTrialLedgerSyncBatch,
  completeTencentTrialLedgerSyncBatch,
  failTencentTrialLedgerSyncBatch,
  OpsStoreError,
  TENCENT_TRIAL_LEDGER_SYNC_CLAIM_RPC,
  type OpsStateRow,
} from "@/lib/ops-store";
import {
  buildTencentTrialLedgerMirrorRows,
  TENCENT_TRIAL_LEDGER_FIELD_KINDS,
  TENCENT_TRIAL_LEDGER_FILE_ID,
  TENCENT_TRIAL_LEDGER_SHEET_ID,
  TENCENT_TRIAL_LEDGER_URL,
} from "@/lib/tencent-trial-ledger-mirror";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const ACTOR = "Tencent Trial Ledger MCP Bridge";
const WORKER_ID = "codex-mcp-bridge";
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ERROR_CODE = /^[a-z0-9_.:-]{1,80}$/u;
const LP_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const TENCENT_RECORD_ID = /^[A-Za-z0-9_-]{1,160}$/u;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function hasBridgeToken(request: Request) {
  const expected = process.env.TENCENT_TRIAL_LEDGER_BRIDGE_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function sameSecretValue(expected: string, supplied: string) {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stateRow(rows: readonly OpsStateRow[], entity: "students" | "lpItems") {
  const matches = rows.filter((row) => row.entity === entity);
  if (matches.length !== 1 || !Array.isArray(matches[0].payload)
    || !Number.isSafeInteger(matches[0].version) || matches[0].version < 1) {
    throw new OpsStoreError(`Tencent trial ledger source row is unavailable: ${entity}`, "source_state_invalid");
  }
  return matches[0] as OpsStateRow & { payload: readonly unknown[] };
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function completionProof(input: {
  secret: string;
  leaseToken: string;
  payloadSha256: string;
  rows: readonly Readonly<{ lpItemId: string; payloadSha256: string }>[];
}) {
  const manifest = [...input.rows]
    .map((row) => ({ lpItemId: row.lpItemId, payloadSha256: row.payloadSha256 }))
    .sort((left, right) => left.lpItemId.localeCompare(right.lpItemId));
  return createHmac("sha256", input.secret).update(JSON.stringify({
    leaseToken: input.leaseToken,
    payloadSha256: input.payloadSha256,
    rows: manifest,
  })).digest("hex");
}

function target() {
  return {
    fileId: TENCENT_TRIAL_LEDGER_FILE_ID,
    sheetId: TENCENT_TRIAL_LEDGER_SHEET_ID,
    url: TENCENT_TRIAL_LEDGER_URL,
    fieldKinds: TENCENT_TRIAL_LEDGER_FIELD_KINDS,
  } as const;
}

/**
 * Claims a database outbox batch and returns the complete deterministic mirror
 * projection. This endpoint never talks to Tencent itself: the bearer-scoped
 * Codex bridge performs MCP writes and must read them back before POSTing the
 * completion mapping.
 */
export async function GET(request: Request) {
  if (!hasBridgeToken(request)) return noStore({ error: "Not found" }, 404);
  try {
    const [claim] = await claimTencentTrialLedgerSyncBatch({
      workerId: WORKER_ID,
      limit: 100,
      leaseSeconds: 900,
    });
    if (!claim) return noStore({ outcome: "idle", target: target() });

    const students = stateRow(claim.state_rows, "students");
    const lpItems = stateRow(claim.state_rows, "lpItems");
    const rows = buildTencentTrialLedgerMirrorRows({
      students: students.payload,
      lpItems: lpItems.payload,
    });
    const payloadSha256 = sha256(rows);
    const responseRows = rows.map((row) => ({ ...row, payloadSha256: sha256(row) }));
    const secret = process.env.TENCENT_TRIAL_LEDGER_BRIDGE_TOKEN;
    if (!secret) throw new OpsStoreError("Tencent trial ledger bridge token is missing.", "missing_configuration");

    return noStore({
      outcome: "claimed",
      leaseToken: claim.lease_token,
      attempt: claim.attempt_count,
      events: claim.events,
      sourceVersions: claim.source_versions,
      payloadSha256,
      completionProof: completionProof({
        secret,
        leaseToken: claim.lease_token,
        payloadSha256,
        rows: responseRows,
      }),
      target: target(),
      rows: responseRows,
      mappings: claim.mappings,
    });
  } catch (error) {
    const missing = error instanceof OpsStoreError && (error.code === "PGRST202" || error.code === "42883");
    console.error("tencent_trial_ledger_bridge_claim_failed", {
      category: missing ? "contract_unavailable" : error instanceof OpsStoreError ? error.code ?? "ops_rpc" : "projection",
    });
    return noStore({
      error: missing ? "Tencent trial-ledger sync contract is not deployed." : "Tencent trial-ledger batch could not be claimed.",
      code: missing ? "contract_unavailable" : "claim_failed",
      ...(missing ? { requiredRpc: TENCENT_TRIAL_LEDGER_SYNC_CLAIM_RPC } : {}),
    }, missing ? 501 : 503);
  }
}

export async function POST(request: Request) {
  if (!hasBridgeToken(request)) return noStore({ error: "Not found" }, 404);
  const body = await request.json().catch(() => null);
  if (!record(body) || typeof body.action !== "string" || typeof body.leaseToken !== "string"
    || !UUID_V4.test(body.leaseToken.toLowerCase())) {
    return noStore({ error: "Invalid bridge receipt." }, 400);
  }

  try {
    if (body.action === "complete") {
      if (typeof body.payloadSha256 !== "string" || !SHA256.test(body.payloadSha256)
        || typeof body.completionProof !== "string" || !SHA256.test(body.completionProof)
        || !Array.isArray(body.mappings)) {
        return noStore({ error: "Invalid bridge completion receipt." }, 400);
      }
      if (body.mappings.some((mapping) => !record(mapping)
        || typeof mapping.lpItemId !== "string" || !LP_ITEM_ID.test(mapping.lpItemId)
        || typeof mapping.recordId !== "string" || !TENCENT_RECORD_ID.test(mapping.recordId)
        || typeof mapping.payloadSha256 !== "string" || !SHA256.test(mapping.payloadSha256))) {
        return noStore({ error: "Invalid bridge record mapping." }, 400);
      }
      const mappings = body.mappings.map((mapping) => {
        const value = mapping as Record<string, string>;
        return {
          lpItemId: value.lpItemId,
          recordId: value.recordId,
          payloadSha256: value.payloadSha256,
        };
      });
      const secret = process.env.TENCENT_TRIAL_LEDGER_BRIDGE_TOKEN;
      if (!secret || !sameSecretValue(body.completionProof, completionProof({
        secret,
        leaseToken: body.leaseToken,
        payloadSha256: body.payloadSha256,
        rows: mappings,
      }))) {
        return noStore({ error: "Bridge completion manifest does not match the claimed projection." }, 409);
      }
      const [result] = await completeTencentTrialLedgerSyncBatch({
        leaseToken: body.leaseToken,
        payloadSha256: body.payloadSha256,
        recordMappings: mappings,
        actor: ACTOR,
      });
      if (!result?.completed) throw new OpsStoreError("Tencent trial ledger completion receipt is missing.", "receipt_missing");
      return noStore({
        outcome: "completed",
        completedEventCount: result.completed_event_count,
        syncedRecordCount: result.synced_record_count,
      });
    }

    if (body.action === "fail") {
      const errorCode = typeof body.errorCode === "string" ? body.errorCode.trim().toLowerCase() : "";
      if (!ERROR_CODE.test(errorCode)) return noStore({ error: "Invalid bridge failure code." }, 400);
      const [result] = await failTencentTrialLedgerSyncBatch({
        leaseToken: body.leaseToken,
        errorCode,
        actor: ACTOR,
      });
      if (!result?.failed) throw new OpsStoreError("Tencent trial ledger failure receipt is missing.", "receipt_missing");
      return noStore({ outcome: result.dead ? "dead" : "retry_scheduled", retryAt: result.retry_at });
    }

    return noStore({ error: "Invalid bridge action." }, 400);
  } catch (error) {
    const conflict = error instanceof OpsStoreError
      && (error.code === "40001" || error.message.includes("lease_"));
    console.error("tencent_trial_ledger_bridge_receipt_failed", {
      category: conflict ? "lease_conflict" : error instanceof OpsStoreError ? error.code ?? "ops_rpc" : "invalid_receipt",
    });
    return noStore({
      error: conflict ? "Tencent trial-ledger lease is no longer active." : "Tencent trial-ledger receipt was not committed.",
      code: conflict ? "lease_conflict" : "receipt_failed",
    }, conflict ? 409 : 503);
  }
}
