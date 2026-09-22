import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
  assertJiaowubaoScheduleSnapshotPageBytes,
  buildJiaowubaoScheduleSnapshotEnvelope,
  collectJiaowubaoScheduleHorizon,
  jiaowubaoScheduleCollectionWindows,
  JIAOWUBAO_SCHEDULE_HORIZON_DAYS,
  jiaowubaoScheduleSnapshotRows,
} from "@/lib/jiaowubao-open-api-schedule-snapshot";
import { queryJiaowubaoScheduleList } from "@/lib/jiaowubao-open-api-node";
import {
  jiaowubaoTrialProjectionWindow,
  runJiaowubaoTrialAutoSync,
} from "@/lib/jiaowubao-trial-auto-sync";
import {
  beginJiaowubaoOpenApiScheduleSnapshot,
  claimJiaowubaoOpenApiScheduleSyncLease,
  completeJiaowubaoOpenApiScheduleSnapshot,
  confirmJiaowubaoOpenApiScheduleSnapshotCurrent,
  getJiaowubaoOpenApiScheduleSnapshotPreflight,
  OpsStoreError,
  projectJiaowubaoOpenApiAuthority,
  releaseJiaowubaoOpenApiScheduleSyncLease,
  reserveJiaowubaoOpenApiScheduleRequest,
  stageJiaowubaoOpenApiScheduleSnapshotPage,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const ACTOR = "Ops Admin" as const;
const TIME_ZONE = "Australia/Melbourne";
const DAYS = JIAOWUBAO_SCHEDULE_HORIZON_DAYS;
const RUN_INTERVAL_MS = 30 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function queryScheduleWithGlobalRateGate(query: Parameters<typeof queryJiaowubaoScheduleList>[0]) {
  const reservation = await reserveJiaowubaoOpenApiScheduleRequest({ actor: ACTOR });
  const notBefore = typeof reservation?.notBefore === "string" ? Date.parse(reservation.notBefore) : Number.NaN;
  if (reservation?.tool !== "query_schedule_list" || !Number.isFinite(notBefore)) {
    throw new Error("schedule_rate_reservation_invalid");
  }
  const wait = Math.max(0, notBefore - Date.now());
  if (wait > 30_000) throw new Error("schedule_rate_reservation_oversize");
  if (wait > 0) await sleep(wait);
  return queryJiaowubaoScheduleList(query);
}

function hasCronSecret(request: Request) {
  // This has its own token so a database scheduler cannot reuse the secret
  // that authorises unrelated operational cron routes.
  const expected = process.env.JIAOWUBAO_SCHEDULE_SYNC_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function dateInTimeZone(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const date = `${value.year}-${value.month}-${value.day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("clock_invalid");
  return date;
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function fixedWindow(now = new Date()) {
  const start = dateInTimeZone(now);
  return Object.freeze({ start, end: addDays(start, DAYS - 1) });
}

function scheduledRunKey(now = Date.now()) {
  return `jwb-open-api-schedule-sync:${Math.floor(now / RUN_INTERVAL_MS) * RUN_INTERVAL_MS}`;
}

function exactRevision(value: unknown) {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function exactRunId(value: unknown) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function validConfirmation(
  value: Readonly<Record<string, unknown>>,
  revision: string,
  rowCount: number,
) {
  const publishedAt = typeof value.publishedAt === "string" ? new Date(value.publishedAt) : null;
  return value.confirmed === true
    && value.revision === revision
    && value.rowCount === rowCount
    && publishedAt !== null
    && Number.isFinite(publishedAt.valueOf());
}

function receiptMatchesPage(value: Readonly<Record<string, unknown>>, runId: string, pageIndex: number, rowCount: number) {
  // The page RPC deliberately returns only the page receipt; the run state is
  // verified by the database before staging and again by the final publisher.
  return value.runId === runId && value.pageIndex === pageIndex && value.rowCount === rowCount;
}

async function projectAuthority(revision: string, rowCount: number) {
  const receipt = await projectJiaowubaoOpenApiAuthority({ revision, actor: ACTOR });
  const coverage = receipt?.coverage;
  const checkedAt = typeof receipt?.checkedAt === "string" ? new Date(receipt.checkedAt) : null;
  if (receipt?.schemaVersion !== 1
      || receipt?.authorityMode !== "one_of_multiple"
      || receipt?.tool !== "query_schedule_list"
      || receipt?.snapshotRevision !== revision
      || !UUID.test(receipt?.projectionRunId ?? "")
      || receipt?.cadenceMinutes !== 30
      || !coverage
      || coverage.snapshotRows !== rowCount
      || !Number.isSafeInteger(coverage.normalizedEntityRows) || coverage.normalizedEntityRows < rowCount
      || !Number.isSafeInteger(coverage.matchedEntityRows) || coverage.matchedEntityRows < 0
      || !Number.isSafeInteger(coverage.sourceOnlyEntityRows) || coverage.sourceOnlyEntityRows < 0
      || coverage.matchedEntityRows + coverage.sourceOnlyEntityRows !== coverage.normalizedEntityRows
      || checkedAt === null || !Number.isFinite(checkedAt.valueOf())) {
    throw new Error("authority_projection_receipt_invalid");
  }
  return receipt;
}

async function projectTrialHorizon(snapshotRevision: string, window: { start: string; end: string }) {
  const results = [];
  for (const part of jiaowubaoScheduleCollectionWindows(window)) {
    results.push(await runJiaowubaoTrialAutoSync({ snapshotRevision, window: jiaowubaoTrialProjectionWindow(part) }));
  }
  return {
    outcome: results.some((result) => result.outcome === "applied") ? "applied"
      : results.some((result) => result.outcome === "no_change") ? "no_change" : "no_match",
    matchedCount: results.reduce((sum, result) => sum + result.matchedCount, 0),
    appliedCount: results.reduce((sum, result) => sum + result.appliedCount, 0),
    batchCount: results.reduce((sum, result) => sum + result.batchCount, 0),
  };
}

/**
 * Supabase pg_cron invokes this Vercel route every 30 minutes. It only replaces
 * the completed, immutable JWB source snapshot after every upstream page has
 * been staged and PostgreSQL verifies the expected current pointer. It then
 * projects every source entity and safe native match, then applies the narrow
 * trial LP/task automation from the same immutable revision.
 */
export async function GET(request: Request) {
  if (!hasCronSecret(request)) return noStore({ error: "Not found" }, 404);

  const runKey = scheduledRunKey();
  let acquired = false;
  let phase = "claim_lease";
  try {
    const lease = await claimJiaowubaoOpenApiScheduleSyncLease({
      apiSourceKey: JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
      runKey,
      actor: ACTOR,
    });
    if (!lease || typeof lease.acquired !== "boolean" || typeof lease.runKey !== "string"
      || !Number.isSafeInteger(lease.retryAfterSeconds) || lease.retryAfterSeconds < 0) {
      throw new Error("lease_receipt_invalid");
    }
    if (!lease.acquired) return noStore({ outcome: "already_running" }, 202);
    acquired = true;

    phase = "collect_source";
    const window = fixedWindow();
    const snapshot = await collectJiaowubaoScheduleHorizon(window, queryScheduleWithGlobalRateGate);
    phase = "read_preflight";
    const preflight = await getJiaowubaoOpenApiScheduleSnapshotPreflight({
      apiSourceKey: JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
      actor: ACTOR,
    });
    const currentRevision = preflight?.current === null ? null : exactRevision(preflight?.current?.revision);
    if (preflight?.current !== null && currentRevision === null) throw new Error("preflight_receipt_invalid");
    if (currentRevision === snapshot.manifest.revision) {
      phase = "confirm_current";
      const confirmation = await confirmJiaowubaoOpenApiScheduleSnapshotCurrent({
        apiSourceKey: JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
        revision: snapshot.manifest.revision,
        actor: ACTOR,
      });
      if (!validConfirmation(
        confirmation as Readonly<Record<string, unknown>>,
        snapshot.manifest.revision,
        snapshot.manifest.recordCount,
      )) throw new Error("confirmation_receipt_invalid");
      phase = "project_authority";
      const authorityProjection = await projectAuthority(snapshot.manifest.revision, snapshot.manifest.recordCount);
      phase = "project_trials";
      const trialProjection = await projectTrialHorizon(snapshot.manifest.revision, window);
      return noStore({ outcome: "no_change", window, pageCount: snapshot.manifest.pageCount, rowCount: snapshot.manifest.recordCount, authorityProjection, trialProjection });
    }

    const envelope = buildJiaowubaoScheduleSnapshotEnvelope(snapshot, currentRevision);
    phase = "begin_snapshot";
    const begin = await beginJiaowubaoOpenApiScheduleSnapshot({ envelope, actor: ACTOR });
    const runId = exactRunId(begin?.runId);
    if (!runId) throw new Error("begin_receipt_invalid");
    if (begin.state === "complete") {
      phase = "project_authority";
      const authorityProjection = await projectAuthority(snapshot.manifest.revision, snapshot.manifest.recordCount);
      phase = "project_trials";
      const trialProjection = await projectTrialHorizon(snapshot.manifest.revision, window);
      return noStore({ outcome: "no_change", window, pageCount: snapshot.manifest.pageCount, rowCount: snapshot.manifest.recordCount, authorityProjection, trialProjection });
    }
    if (begin.state !== "staging") throw new Error("begin_receipt_invalid");

    const rows = jiaowubaoScheduleSnapshotRows(snapshot);
    for (let pageIndex = 0, start = 0; start < rows.length; pageIndex += 1, start += 100) {
      phase = "stage_page";
      const pageRows = rows.slice(start, start + 100);
      assertJiaowubaoScheduleSnapshotPageBytes(pageRows);
      const staged = await stageJiaowubaoOpenApiScheduleSnapshotPage({
        runId,
        pageIndex,
        rows: pageRows,
        actor: ACTOR,
      });
      if (!receiptMatchesPage(staged as Readonly<Record<string, unknown>>, runId, pageIndex, pageRows.length)) {
        throw new Error("stage_receipt_invalid");
      }
    }
    phase = "complete_snapshot";
    const completed = await completeJiaowubaoOpenApiScheduleSnapshot({ runId, actor: ACTOR });
    if (completed.runId !== runId || completed.state !== "complete"
      || completed.rowCount !== snapshot.manifest.recordCount
      || !exactRevision(completed.rowsSha256) || !exactRevision(completed.payloadSha256)) {
      throw new Error("complete_receipt_invalid");
    }
    phase = "project_authority";
    const authorityProjection = await projectAuthority(snapshot.manifest.revision, snapshot.manifest.recordCount);
    phase = "project_trials";
    const trialProjection = await projectTrialHorizon(snapshot.manifest.revision, window);
    return noStore({
      outcome: completed.replayed ? "no_change" : "applied",
      window,
      pageCount: snapshot.manifest.pageCount,
      rowCount: snapshot.manifest.recordCount,
      revision: snapshot.manifest.revision,
      authorityProjection,
      trialProjection,
    });
  } catch (error) {
    // Never log an upstream body, URL, header, snapshot row, or secret. This
    // is only enough information to diagnose a failed scheduled run.
    console.error("jiaowubao_schedule_sync_failed", {
      phase,
      category: error instanceof OpsStoreError ? error.code ?? "ops_rpc" : "source_or_contract",
    });
    // The route is bearer-protected. Returning the fixed phase lets the
    // trusted scheduler surface an actionable aggregate failure without ever
    // returning source rows, response data, URLs, headers, or credentials.
    return noStore({ error: "教务宝课表或试听任务同步未完成；系统会在下一次计划任务重试。", phase }, 503);
  } finally {
    if (acquired) {
      await releaseJiaowubaoOpenApiScheduleSyncLease({
        apiSourceKey: JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
        runKey,
        actor: ACTOR,
      }).catch(() => undefined);
    }
  }
}
