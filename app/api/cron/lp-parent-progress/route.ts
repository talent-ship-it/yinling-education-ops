import { createHash, randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import {
  beginLpParentProgressSchedulerRun,
  finishLpParentProgressSchedulerRun,
  getOpsState,
  OpsStoreError,
  putLpParentProgressSchedulerTasks,
  recoverStaleLpParentProgressSchedulerRuns,
  type OpsStateRow,
} from "@/lib/ops-store";
import {
  eligibleLpParentProgressRecords,
  reconcileAllLpParentProgressTasks,
} from "@/lib/lp-parent-progress-service";
import type { OpsTask } from "@/lib/ops-tasks";
import { hasReminderCronSecret } from "@/lib/reminder-cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_OCC_RETRIES = 3;
const ENTITIES = ["lpItems", "bookings", "tasks", "teachers"] as const;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function rowFor(rows: readonly OpsStateRow[], entity: string) {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row || !Array.isArray(row.payload) || !Number.isSafeInteger(row.version) || row.version < 1) {
    throw new OpsStoreError(`LP scheduler state row is unavailable: ${entity}`, "lp_scheduler_state_missing");
  }
  return row;
}

function sourceDigest(lpItems: unknown, bookings: unknown, teachers: unknown) {
  return createHash("sha256")
    .update(JSON.stringify({ lpItems, bookings, teachers }))
    .digest("hex");
}

function changedTaskCount(before: readonly OpsTask[], after: readonly OpsTask[]) {
  const beforeById = new Map(before.map((task) => [task.id, JSON.stringify(task)]));
  const afterById = new Map(after.map((task) => [task.id, JSON.stringify(task)]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  return [...ids].filter((id) => beforeById.get(id) !== afterById.get(id)).length;
}

function retryableOcc(error: unknown) {
  return error instanceof OpsStoreError
    && (error.code === "40001" || error.message === "version_conflict" || error.code === "version_conflict");
}

/**
 * An authenticated scheduler invokes this route on a fixed schedule. It is
 * secret-gated and never accepts a client-provided clock or
 * source payload. The route re-reads all authoritative inputs on every OCC
 * attempt, so a timeout/unknown response is safe to retry on the next tick.
 */
export async function GET(request: Request) {
  if (!hasReminderCronSecret(request)) return noStore({ error: "Not found" }, 404);
  try {
    await recoverStaleLpParentProgressSchedulerRuns();
  } catch {
    return noStore({ error: "LP scheduler recovery is unavailable; no new run was started." }, 503);
  }
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_OCC_RETRIES; attempt += 1) {
    const runKey = `lp-parent-progress:${randomUUID()}`;
    let started = false;
    try {
      const rows = await getOpsState([...ENTITIES]);
      const lpItemsRow = rowFor(rows, "lpItems");
      const bookingsRow = rowFor(rows, "bookings");
      const tasksRow = rowFor(rows, "tasks");
      const teachersRow = rowFor(rows, "teachers");
      const sourceVersions = {
        lpItems: lpItemsRow.version,
        bookings: bookingsRow.version,
        tasks: tasksRow.version,
        teachers: teachersRow.version,
      };
      const digest = sourceDigest(lpItemsRow.payload, bookingsRow.payload, teachersRow.payload);
      const now = new Date();
      const lpItems = lpItemsRow.payload as Array<Record<string, unknown>>;
      const bookings = bookingsRow.payload as Array<Record<string, unknown>>;
      const tasks = tasksRow.payload as OpsTask[];
      const eligibleLpItems = eligibleLpParentProgressRecords(lpItems);
      const lpCount = eligibleLpItems.length;
      const reconciled = reconcileAllLpParentProgressTasks({
        tasks,
        lps: eligibleLpItems,
        bookings: bookings as never,
        teachers: teachersRow.payload as Array<{ id: string; name: string }>,
        now,
        timeZone: "Australia/Melbourne",
      });
      const changedCount = changedTaskCount(tasks, reconciled);
      const targetTasks = reconciled as unknown as readonly Record<string, unknown>[];
      await beginLpParentProgressSchedulerRun({
        runKey,
        sourceDigest: digest,
        sourceVersions,
        taskVersionBefore: tasksRow.version,
        targetTasks,
        processedCount: lpCount,
        changedCount,
      });
      started = true;

      if (changedCount === 0) {
        await finishLpParentProgressSchedulerRun({
          runKey,
          outcome: "no_change",
        });
        return noStore({ outcome: "no_change", processedCount: lpCount, changedCount: 0 });
      }

      const saved = await putLpParentProgressSchedulerTasks({
        runKey,
        tasks: targetTasks,
      });
      const savedTaskRow = saved.find((row) => row.entity === "tasks") ?? saved[0];
      if (!savedTaskRow || !Number.isSafeInteger(savedTaskRow.version)) {
        throw new OpsStoreError("LP scheduler task write receipt is incomplete.", "lp_scheduler_commit_receipt_missing");
      }
      return noStore({ outcome: "applied", processedCount: lpCount, changedCount });
    } catch (error) {
      lastError = error;
      if (started) {
        await finishLpParentProgressSchedulerRun({
          runKey,
          outcome: "failed",
          errorCode: error instanceof OpsStoreError ? error.code ?? error.message : "scheduler_error",
        }).catch(() => undefined);
      }
      if (retryableOcc(error) && attempt + 1 < MAX_OCC_RETRIES) continue;
      break;
    }
  }

  const message = lastError instanceof OpsStoreError && lastError.code === "missing_configuration"
    ? "LP scheduler configuration is unavailable."
    : "LP scheduler did not commit; the next cron tick will retry.";
  return noStore({ error: message }, 503);
}
