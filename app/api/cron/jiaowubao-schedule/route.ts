import { randomUUID, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
  assertJiaowubaoScheduleSnapshotPageBytes,
  buildJiaowubaoScheduleSnapshotEnvelope,
  collectJiaowubaoScheduleHorizon,
  jiaowubaoScheduleCollectionWindows,
  JIAOWUBAO_SCHEDULE_HORIZON_DAYS,
  JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_RECORDS,
  JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE,
  jiaowubaoScheduleSnapshotRows,
} from "@/lib/jiaowubao-open-api-schedule-snapshot";
import { queryJiaowubaoScheduleList } from "@/lib/jiaowubao-open-api-node";
import { readJiaowubaoScheduleSnapshotIdentities } from "@/lib/jiaowubao-open-api-schedule-identities";
import {
  JIAOWUBAO_SCHEDULE_COLLECTION_RESERVE_MS,
  JIAOWUBAO_SCHEDULE_AUTHORITY_TIMEOUT_MS,
  JIAOWUBAO_SCHEDULE_RELEASE_TIMEOUT_MS,
  JIAOWUBAO_SCHEDULE_UPSTREAM_REQUEST_MS,
  assertJiaowubaoScheduleTime,
  hasJiaowubaoScheduleTime,
  jiaowubaoScheduleRpcOptions,
  jiaowubaoScheduleWorkDeadline,
} from "@/lib/jiaowubao-schedule-runtime-budget";
import {
  runJiaowubaoScheduleProjectionTarget,
  runOrQueueJiaowubaoScheduleProjectionTarget,
  type JiaowubaoScheduleProjectionDependencies,
  type JiaowubaoScheduleProjectionPhase as ProjectionPhase,
  type JiaowubaoScheduleProjectionState as ProjectionState,
  type JiaowubaoScheduleProjectionTarget as ProjectionTarget,
} from "@/lib/jiaowubao-schedule-projection-runner";
import {
  jiaowubaoTrialProjectionWindow,
  runJiaowubaoTrialAutoSyncHorizon,
} from "@/lib/jiaowubao-trial-auto-sync";
import {
  advanceJiaowubaoOpenApiScheduleProjection,
  beginJiaowubaoOpenApiScheduleSnapshot,
  claimJiaowubaoOpenApiScheduleSyncLease,
  completeJiaowubaoOpenApiScheduleSnapshot,
  confirmJiaowubaoOpenApiScheduleSnapshotCurrent,
  getJiaowubaoOpenApiScheduleSnapshotIdentityPage,
  getJiaowubaoOpenApiScheduleProjectionTarget,
  OpsStoreError,
  projectJiaowubaoOpenApiAuthority,
  releaseJiaowubaoOpenApiScheduleSyncLease,
  reserveJiaowubaoOpenApiScheduleRequest,
  stageJiaowubaoOpenApiScheduleSnapshotPage,
  type JiaowubaoOpenApiScheduleProjectionTarget,
  type OpsRpcOptions,
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
const EXACT_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const PROJECTION_STATES = new Set<ProjectionState>(["pending", "authority_done", "complete"]);

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function scheduleReservationNotBefore(reservation: Readonly<{ tool: unknown; notBefore: unknown }>) {
  if (reservation.tool !== "query_schedule_list") {
    throw new Error("schedule_rate_reservation_invalid");
  }
  if (typeof reservation.notBefore !== "string") throw new Error("schedule_rate_reservation_invalid");
  const notBefore = Date.parse(reservation.notBefore);
  if (!Number.isFinite(notBefore)) throw new Error("schedule_rate_reservation_invalid");
  return notBefore;
}

function scheduleReservationWait(reservation: Readonly<{ tool: unknown; notBefore: unknown }>) {
  const notBefore = scheduleReservationNotBefore(reservation);
  const wait = Math.max(0, notBefore - Date.now());
  if (wait > 30_000) throw new Error("schedule_rate_reservation_oversize");
  return wait;
}

async function queryScheduleWithGlobalRateGate(
  query: Parameters<typeof queryJiaowubaoScheduleList>[0],
  deadlineAt: number,
) {
  assertJiaowubaoScheduleTime(
    deadlineAt,
    JIAOWUBAO_SCHEDULE_COLLECTION_RESERVE_MS,
    15_000 + JIAOWUBAO_SCHEDULE_UPSTREAM_REQUEST_MS,
  );
  const reservation = await reserveJiaowubaoOpenApiScheduleRequest(
    { actor: ACTOR },
    jiaowubaoScheduleRpcOptions(deadlineAt),
  );
  const wait = scheduleReservationWait(reservation);
  assertJiaowubaoScheduleTime(
    deadlineAt,
    JIAOWUBAO_SCHEDULE_COLLECTION_RESERVE_MS,
    wait + JIAOWUBAO_SCHEDULE_UPSTREAM_REQUEST_MS,
  );
  if (wait > 0) await sleep(wait);
  assertJiaowubaoScheduleTime(
    deadlineAt,
    JIAOWUBAO_SCHEDULE_COLLECTION_RESERVE_MS,
    JIAOWUBAO_SCHEDULE_UPSTREAM_REQUEST_MS,
  );
  return queryJiaowubaoScheduleList(query, {
    deadlineAt,
    rateGate: "database",
  });
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

function scheduledRunKey(now = Date.now(), attemptId = randomUUID()) {
  return `jwb-open-api-schedule-sync:${Math.floor(now / RUN_INTERVAL_MS) * RUN_INTERVAL_MS}:${attemptId}`;
}

function exactRevision(value: unknown) {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function exactRunId(value: unknown) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedIsoDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf())) return null;
  return parsed.toISOString().slice(0, 10);
}

function exactDate(value: unknown) {
  if (typeof value !== "string") return null;
  if (!EXACT_DATE.test(value)) return null;
  return normalizedIsoDate(value) === value ? value : null;
}

function projectionWindowDates(value: unknown) {
  if (!isRecord(value)) return null;
  const start = exactDate(value.start);
  const end = exactDate(value.end);
  return start === null || end === null ? null : Object.freeze({ start, end });
}

function exactProjectionWindow(value: unknown) {
  const window = projectionWindowDates(value);
  if (window === null) return null;
  const { start, end } = window;
  const days = (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000 + 1;
  return [Number.isSafeInteger(days), days >= 1, days <= DAYS].every(Boolean) ? window : null;
}

function exactProjectionRowCount(value: unknown) {
  return [Number.isSafeInteger(value), Number(value) >= 0, Number(value) <= JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_RECORDS]
    .every(Boolean)
    ? value as number
    : null;
}

function exactProjectionState(value: unknown) {
  return PROJECTION_STATES.has(value as ProjectionState) ? value as ProjectionState : null;
}

function exactPublishedAt(value: unknown) {
  if (typeof value !== "string") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function requiredProjectionValue<T>(value: T | null): T {
  if (value === null) throw new Error("projection_target_invalid");
  return value;
}

function projectionTarget(value: JiaowubaoOpenApiScheduleProjectionTarget): ProjectionTarget | null {
  if (!isRecord(value)) throw new Error("projection_target_invalid");
  if (value.state === "absent") return null;
  if (value.state !== "ready") throw new Error("projection_target_invalid");
  return Object.freeze({
    revision: requiredProjectionValue(exactRevision(value.revision)),
    rowCount: requiredProjectionValue(exactProjectionRowCount(value.rowCount)),
    projectionState: requiredProjectionValue(exactProjectionState(value.projectionState)),
    window: requiredProjectionValue(exactProjectionWindow(value.window)),
    publishedAt: requiredProjectionValue(exactPublishedAt(value.publishedAt)),
  });
}

function projectionIdentity(
  target: Readonly<{ revision: string; rowCount: number; window: Readonly<{ start: string; end: string }> }>,
) {
  return `${target.revision}\u0000${target.rowCount}\u0000${target.window.start}\u0000${target.window.end}`;
}

function assertProjectionMatches(
  target: ProjectionTarget | null,
  expected: Readonly<{ revision: string; rowCount: number; window: Readonly<{ start: string; end: string }> }>,
) {
  if (target === null || projectionIdentity(target) !== projectionIdentity(expected)) {
    throw new Error("projection_target_mismatch");
  }
  return target;
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
  const samePage = value.runId === runId && value.pageIndex === pageIndex;
  return [
    samePage,
    value.rowCount === rowCount,
    exactRevision(value.pageSha256) !== null,
    typeof value.replayed === "boolean",
  ].every(Boolean);
}

async function projectAuthority(revision: string, rowCount: number, options: OpsRpcOptions) {
  const receipt = await projectJiaowubaoOpenApiAuthority({ revision, actor: ACTOR }, options);
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

async function projectTrialHorizon(
  snapshotRevision: string,
  window: { start: string; end: string },
  options: () => OpsRpcOptions,
  allowStalePinnedRevision: boolean,
) {
  return runJiaowubaoTrialAutoSyncHorizon({
    snapshotRevision,
    windows: jiaowubaoScheduleCollectionWindows(window).map(jiaowubaoTrialProjectionWindow),
  }, options, allowStalePinnedRevision ? window : null);
}

type AuthorityProjectionReceipt = Awaited<ReturnType<typeof projectAuthority>>;
type TrialProjectionReceipt = Awaited<ReturnType<typeof projectTrialHorizon>>;

function projectionDependencies(deadlineAt: number) {
  return Object.freeze({
    canStartProjection: () => hasJiaowubaoScheduleTime(
      deadlineAt,
      15_000,
      JIAOWUBAO_SCHEDULE_AUTHORITY_TIMEOUT_MS,
    ),
    assertAuthorityTime: () => assertJiaowubaoScheduleTime(
      deadlineAt,
      15_000,
      JIAOWUBAO_SCHEDULE_AUTHORITY_TIMEOUT_MS,
    ),
    projectAuthority: (target: ProjectionTarget) => projectAuthority(
      target.revision,
      target.rowCount,
      jiaowubaoScheduleRpcOptions(deadlineAt, JIAOWUBAO_SCHEDULE_AUTHORITY_TIMEOUT_MS),
    ),
    projectTrials: (target: ProjectionTarget, allowStalePinnedRevision: boolean) => projectTrialHorizon(
      target.revision,
      target.window,
      () => jiaowubaoScheduleRpcOptions(deadlineAt),
      allowStalePinnedRevision,
    ),
    advance: (input) => advanceJiaowubaoOpenApiScheduleProjection({
      ...input,
      actor: ACTOR,
    }, jiaowubaoScheduleRpcOptions(deadlineAt)),
  }) satisfies JiaowubaoScheduleProjectionDependencies<AuthorityProjectionReceipt, TrialProjectionReceipt>;
}

async function readProjectionTarget(deadlineAt: number) {
  const value = await getJiaowubaoOpenApiScheduleProjectionTarget(
    { actor: ACTOR },
    jiaowubaoScheduleRpcOptions(deadlineAt),
  );
  return projectionTarget(value);
}

type UnchangedSnapshotResponseInput = Readonly<{
  target: ProjectionTarget | null;
  manifest: Readonly<{ revision: string; recordCount: number; pageCount: number }>;
  window: Readonly<{ start: string; end: string }>;
  deadlineAt: number;
  setProjectionPhase: (phase: ProjectionPhase) => void;
}>;

async function confirmedUnchangedSnapshotResponse(input: UnchangedSnapshotResponseInput) {
  const target = assertProjectionMatches(input.target, {
    revision: input.manifest.revision,
    rowCount: input.manifest.recordCount,
    window: input.window,
  });
  const confirmation = await confirmJiaowubaoOpenApiScheduleSnapshotCurrent({
    apiSourceKey: JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
    revision: input.manifest.revision,
    actor: ACTOR,
  }, jiaowubaoScheduleRpcOptions(input.deadlineAt));
  if (!validConfirmation(
    confirmation as Readonly<Record<string, unknown>>,
    input.manifest.revision,
    input.manifest.recordCount,
  )) throw new Error("confirmation_receipt_invalid");
  const projections = await runOrQueueJiaowubaoScheduleProjectionTarget(
    target,
    projectionDependencies(input.deadlineAt),
    input.setProjectionPhase,
  );
  return noStore({
    outcome: "no_change",
    window: input.window,
    pageCount: input.manifest.pageCount,
    rowCount: input.manifest.recordCount,
    ...projections,
  });
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

  const deadlineAt = jiaowubaoScheduleWorkDeadline();
  const runKey = scheduledRunKey();
  let acquired = false;
  let phase = "claim_lease";
  try {
    const lease = await claimJiaowubaoOpenApiScheduleSyncLease({
      apiSourceKey: JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
      runKey,
      actor: ACTOR,
    }, jiaowubaoScheduleRpcOptions(deadlineAt));
    if (!lease || typeof lease.acquired !== "boolean" || typeof lease.runKey !== "string"
      || (lease.acquired && lease.runKey !== runKey)
      || !Number.isSafeInteger(lease.retryAfterSeconds) || lease.retryAfterSeconds < 0) {
      throw new Error("lease_receipt_invalid");
    }
    if (!lease.acquired) return noStore({ outcome: "already_running" }, 202);
    acquired = true;

    phase = "read_projection_target";
    const currentTarget = await readProjectionTarget(deadlineAt);
    if (currentTarget !== null && currentTarget.projectionState !== "complete") {
      const recovered = await runJiaowubaoScheduleProjectionTarget(
        currentTarget,
        projectionDependencies(deadlineAt),
        (nextPhase) => { phase = nextPhase; },
      );
      return noStore({
        outcome: "projection_recovered",
        revision: currentTarget.revision,
        rowCount: currentTarget.rowCount,
        window: currentTarget.window,
        ...recovered,
      });
    }

    const window = fixedWindow();
    const currentRevision = currentTarget?.revision ?? null;
    phase = "read_current_identities";
    const currentIdentities = currentRevision === null
      ? null
      : await readJiaowubaoScheduleSnapshotIdentities(
        currentRevision,
        (input) => getJiaowubaoOpenApiScheduleSnapshotIdentityPage(
          input,
          jiaowubaoScheduleRpcOptions(deadlineAt),
        ),
      );
    phase = "collect_source";
    const snapshot = await collectJiaowubaoScheduleHorizon(
      window,
      (query) => queryScheduleWithGlobalRateGate(query, deadlineAt),
      currentIdentities,
    );
    const respondWithUnchangedSnapshot = (target: ProjectionTarget | null) => {
      phase = "confirm_current";
      return confirmedUnchangedSnapshotResponse({
        target,
        deadlineAt,
        manifest: snapshot.manifest,
        window,
        setProjectionPhase: (nextPhase) => { phase = nextPhase; },
      });
    };
    if (currentRevision === snapshot.manifest.revision) {
      return respondWithUnchangedSnapshot(currentTarget);
    }

    const envelope = buildJiaowubaoScheduleSnapshotEnvelope(snapshot, currentRevision);
    phase = "begin_snapshot";
    const begin = await beginJiaowubaoOpenApiScheduleSnapshot(
      { envelope, actor: ACTOR },
      jiaowubaoScheduleRpcOptions(deadlineAt),
    );
    const runId = exactRunId(begin?.runId);
    if (!runId || begin.revision !== snapshot.manifest.revision
      || begin.expectedPageCount !== snapshot.manifest.pageCount
      || begin.expectedRowCount !== snapshot.manifest.recordCount
      || typeof begin.replayed !== "boolean") throw new Error("begin_receipt_invalid");
    if (begin.state === "complete") {
      phase = "read_projection_target";
      return respondWithUnchangedSnapshot(await readProjectionTarget(deadlineAt));
    }
    if (begin.state !== "staging") throw new Error("begin_receipt_invalid");

    const rows = jiaowubaoScheduleSnapshotRows(snapshot);
    for (let pageIndex = 0, start = 0;
      start < rows.length;
      pageIndex += 1, start += JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE) {
      phase = "stage_page";
      const pageRows = rows.slice(start, start + JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE);
      assertJiaowubaoScheduleSnapshotPageBytes(pageRows);
      const staged = await stageJiaowubaoOpenApiScheduleSnapshotPage({
        runId,
        pageIndex,
        rows: pageRows,
        actor: ACTOR,
      }, jiaowubaoScheduleRpcOptions(deadlineAt));
      if (!receiptMatchesPage(staged as Readonly<Record<string, unknown>>, runId, pageIndex, pageRows.length)) {
        throw new Error("stage_receipt_invalid");
      }
    }
    phase = "complete_snapshot";
    const completed = await completeJiaowubaoOpenApiScheduleSnapshot(
      { runId, actor: ACTOR },
      jiaowubaoScheduleRpcOptions(deadlineAt),
    );
    if (completed.runId !== runId || completed.state !== "complete"
      || completed.rowCount !== snapshot.manifest.recordCount
      || completed.revision !== snapshot.manifest.revision
      || typeof completed.replayed !== "boolean"
      || completed.pageCount !== undefined && completed.pageCount !== snapshot.manifest.pageCount
      || !exactRevision(completed.rowsSha256) || !exactRevision(completed.payloadSha256)) {
      throw new Error("complete_receipt_invalid");
    }
    phase = "read_projection_target";
    const target = assertProjectionMatches(await readProjectionTarget(deadlineAt), {
      revision: snapshot.manifest.revision,
      rowCount: snapshot.manifest.recordCount,
      window,
    });
    const projections = await runOrQueueJiaowubaoScheduleProjectionTarget(
      target,
      projectionDependencies(deadlineAt),
      (nextPhase) => { phase = nextPhase; },
    );
    return noStore({
      outcome: completed.replayed ? "no_change" : "applied",
      window,
      pageCount: snapshot.manifest.pageCount,
      rowCount: snapshot.manifest.recordCount,
      revision: snapshot.manifest.revision,
      ...projections,
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
      }, { timeoutMs: JIAOWUBAO_SCHEDULE_RELEASE_TIMEOUT_MS }).catch(() => undefined);
    }
  }
}
