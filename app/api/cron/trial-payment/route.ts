import { randomUUID, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  getOpsState,
  OpsStoreError,
  reconcileTrialPaymentTasksAuthoritative,
  type OpsStateRow,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_OCC_RETRIES = 3;
const ENTITIES = ["bookings", "students", "lpItems", "tasks", "teachers"] as const;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function hasCronSecret(request: Request) {
  const expected = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function rowFor(rows: readonly OpsStateRow[], entity: (typeof ENTITIES)[number]) {
  const matches = rows.filter((row) => row.entity === entity);
  if (matches.length !== 1 || !Array.isArray(matches[0].payload)
    || !Number.isSafeInteger(matches[0].version) || matches[0].version < 1) {
    throw new OpsStoreError(`Trial payment state row is unavailable: ${entity}`, "trial_payment_state_missing");
  }
  return matches[0];
}

function retryable(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "40001" || error.code === "version_conflict" || error.message === "version_conflict");
}

/** Production-only Vercel Cron entrypoint; PostgreSQL owns the clock and projection. */
export async function GET(request: Request) {
  if (!hasCronSecret(request)) return noStore({ error: "Not found" }, 404);
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_OCC_RETRIES; attempt += 1) {
    try {
      const rows = await getOpsState([...ENTITIES]);
      const expectedVersions = Object.fromEntries(ENTITIES.map((entity) => [
        entity,
        rowFor(rows, entity).version,
      ])) as Record<(typeof ENTITIES)[number], number>;
      const runKey = `trial-payment-reconcile:${randomUUID()}`;
      const saved = await reconcileTrialPaymentTasksAuthoritative({ runKey, expectedVersions });
      if (saved.length !== 1 || !Number.isSafeInteger(saved[0].changed_count)) {
        throw new OpsStoreError("Trial payment reconcile receipt is incomplete.", "trial_payment_receipt_missing");
      }
      return noStore({
        outcome: saved[0].applied ? "applied" : "no_change",
        changedCount: saved[0].changed_count,
      });
    } catch (error) {
      lastError = error;
      if (retryable(error) && attempt + 1 < MAX_OCC_RETRIES) continue;
      break;
    }
  }
  const missing = lastError instanceof OpsStoreError && lastError.code === "missing_configuration";
  return noStore({
    error: missing
      ? "Trial payment scheduler configuration is unavailable."
      : "Trial payment scheduler did not commit; the next cron tick will retry.",
  }, 503);
}
