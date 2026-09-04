import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  readJiaowubaoCompletedLessonSnapshotRecord,
  validateJiaowubaoClosedCompletedLessonMonth,
  validateJiaowubaoCompletedLessonMonth,
} from "@/lib/jiaowubao-completed-lessons";
import { readJiaowubaoCompletedScheduleSnapshotRecord } from "@/lib/jiaowubao-completed-schedule";
import { projectJiaowubaoCompletedLessonRecords } from "@/lib/jiaowubao-completed-lesson-projection";
import {
  JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES,
  JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE,
} from "@/lib/jiaowubao-completed-lesson-pagination";
import { syncJiaowubaoCompletedLessonMonth } from "@/lib/jiaowubao-completed-lesson-resumable-sync";
import { JiaowubaoOpenApiError } from "@/lib/jiaowubao-open-api-node";
import { DEMO_COOKIE_NAME, getCurrentDemoSession } from "@/lib/demo-auth";
import { hasFullAdminAccess, NIXON_COOKIE_NAME } from "@/lib/nixon-auth";
import {
  getJiaowubaoCompletedLessonSnapshotPage,
  getJiaowubaoCompletedScheduleSnapshotPage,
  getOpsState,
  type OpsStateRow,
} from "@/lib/ops-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const MONTH = /^\d{4}-\d{2}$/u;
const PAGE = /^(0|[1-9]\d{0,1})$/u;
const SOURCE = new Set(["lessons", "schedules"] as const);
const MAX_MANUAL_SYNCS_PER_WINDOW = 2;
const MANUAL_SYNC_WINDOW_MS = 10 * 60 * 1_000;
const manualSyncsByActor = new Map<string, number[]>();

class CompletedLessonSnapshotResponseError extends Error {}

function noStore(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function safeSyncFailure(error: unknown) {
  if (error instanceof JiaowubaoOpenApiError) {
    const source = error.tool === "query_lesson_list"
      ? "lessons"
      : error.tool === "query_schedule_list" ? "schedules" : undefined;
    return Object.freeze({
      kind: "open_api",
      code: error.code,
      ...(source ? { source } : {}),
    });
  }
  if (error instanceof Error
    && error.message.length <= 240
    && /^教务宝(?:已消课|已结课排课|排课|完成月度)/u.test(error.message)
    && !/[\u0000-\u001f\u007f<>]/u.test(error.message)) {
    return Object.freeze({ kind: "source_validation", message: error.message });
  }
  return Object.freeze({ kind: "internal" });
}

function object(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactMonth(value: unknown) {
  if (typeof value !== "string" || !MONTH.test(value)) return null;
  try {
    return validateJiaowubaoCompletedLessonMonth(value).month;
  } catch {
    return null;
  }
}

function validRevision(value: unknown) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : null;
}

/**
 * A completed-month source revision freezes the JiaoWuBao rows, but the
 * browser projection also depends on the current students/teachers mapping.
 * Pin the two state-row versions across every page so a name/ID change cannot
 * turn a single month read into a mixed mapping view.
 */
function projectionRevision(rows: readonly OpsStateRow[]) {
  const entries = ["students", "teachers"].map((entity) => {
    const matches = rows.filter((row) => row.entity === entity);
    const row = matches[0];
    const updatedAt = row && typeof row.updated_at === "string" && Number.isFinite(new Date(row.updated_at).valueOf())
      ? new Date(row.updated_at).toISOString()
      : null;
    if (matches.length !== 1 || !row || !Number.isSafeInteger(row.version) || row.version < 0 || !updatedAt) {
      throw new CompletedLessonSnapshotResponseError("invalid_projection_state_revision");
    }
    return { entity, version: row.version, updatedAt };
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

function exactPageIndex(value: string | null) {
  if (value === null || !PAGE.test(value)) return null;
  const pageIndex = Number(value);
  return Number.isSafeInteger(pageIndex) && pageIndex >= 0 && pageIndex < JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES
    ? pageIndex
    : null;
}

function exactSource(value: string | null): "lessons" | "schedules" | null {
  return value !== null && SOURCE.has(value as "lessons" | "schedules")
    ? value as "lessons" | "schedules"
    : null;
}

function pageRowCount(rowCount: number, pageIndex: number, pageCount: number) {
  const expectedPageCount = rowCount === 0
    ? 0
    : Math.ceil(rowCount / JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE);
  if (pageCount !== expectedPageCount
    || pageCount > JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES
    || (rowCount === 0 && pageIndex !== 0)
    || (rowCount > 0 && (pageIndex < 0 || pageIndex >= pageCount))) {
    return null;
  }
  return rowCount === 0
    ? 0
    : Math.min(JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE, rowCount - pageIndex * JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE);
}

function consumeManualSync(actor: string) {
  const now = Date.now();
  const cutoff = now - MANUAL_SYNC_WINDOW_MS;
  const current = (manualSyncsByActor.get(actor) ?? []).filter((timestamp) => timestamp > cutoff);
  if (current.length >= MAX_MANUAL_SYNCS_PER_WINDOW) return false;
  current.push(now);
  manualSyncsByActor.set(actor, current);
  return true;
}

async function requireFullAdmin() {
  const cookieStore = await cookies();
  const resolved = await getCurrentDemoSession(cookieStore.get(DEMO_COOKIE_NAME)?.value);
  if (!("session" in resolved)) return { response: noStore({ error: resolved.error }, resolved.status) } as const;
  if (!hasFullAdminAccess(resolved.session, cookieStore.get(NIXON_COOKIE_NAME)?.value)) {
    return { response: noStore({ error: "只有超级管理员可以读取或同步教务宝已消课。" }, 403) } as const;
  }
  return { actor: resolved.session.user } as const;
}

async function currentProjectionPage(input: Readonly<{
  month: string;
  pageIndex: number;
  expectedRevision: string | null;
  expectedProjectionRevision: string | null;
  source: "lessons" | "schedules";
}>) {
  const snapshot = await (input.source === "lessons"
    ? getJiaowubaoCompletedLessonSnapshotPage({
      month: input.month,
      pageIndex: input.pageIndex,
      revision: input.expectedRevision,
      actor: "Ops Admin",
    })
    : getJiaowubaoCompletedScheduleSnapshotPage({
      month: input.month,
      pageIndex: input.pageIndex,
      revision: input.expectedRevision,
      actor: "Ops Admin",
    }));
  if (!snapshot || snapshot.month !== input.month
    || !["absent", "complete", "reset"].includes(snapshot.state)
    || !Array.isArray(snapshot.items)) {
    throw new CompletedLessonSnapshotResponseError("invalid_snapshot_envelope");
  }
  if (snapshot.state === "absent") {
    if (snapshot.revision !== null || snapshot.rowCount !== 0 || snapshot.pageIndex !== 0 || snapshot.pageCount !== 0
      || snapshot.publishedAt !== null || snapshot.items.length !== 0) {
      throw new CompletedLessonSnapshotResponseError("absent_snapshot_invalid");
    }
    return Object.freeze({ state: "absent" as const, source: input.source, month: input.month, items: [], revision: null, rowCount: 0, pageIndex: 0, pageCount: 0, publishedAt: null, projectionRevision: null });
  }
  const revision = validRevision(snapshot.revision);
  const rowCount = typeof snapshot.rowCount === "number" ? snapshot.rowCount : null;
  const pageIndex = typeof snapshot.pageIndex === "number" ? snapshot.pageIndex : null;
  const pageCount = typeof snapshot.pageCount === "number" ? snapshot.pageCount : null;
  const publishedAt = typeof snapshot.publishedAt === "string" && Number.isFinite(new Date(snapshot.publishedAt).valueOf())
    ? new Date(snapshot.publishedAt).toISOString()
    : null;
  const expectedPageCount = rowCount === null ? null : rowCount === 0
    ? 0
    : Math.ceil(rowCount / JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE);
  if (!revision || rowCount === null || !Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > 6_000
    || pageIndex === null || !Number.isSafeInteger(pageIndex) || pageCount === null || !Number.isSafeInteger(pageCount)
    || !publishedAt || pageIndex !== input.pageIndex || pageIndex < 0 || pageIndex >= JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES
    || pageCount !== expectedPageCount || pageCount > JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES) {
    throw new CompletedLessonSnapshotResponseError("invalid_snapshot_metadata");
  }
  if (snapshot.state === "reset") {
    if (snapshot.items.length !== 0) throw new CompletedLessonSnapshotResponseError("reset_snapshot_has_items");
    return Object.freeze({
      state: "reset" as const,
      source: input.source,
      month: input.month,
      revision,
      rowCount,
      pageIndex,
      pageCount,
      publishedAt,
      projectionRevision: null,
      items: [],
    });
  }
  const expectedRows = pageRowCount(rowCount, pageIndex, pageCount);
  if (snapshot.items.length !== expectedRows) {
    throw new CompletedLessonSnapshotResponseError("snapshot_page_row_count_invalid");
  }
  const stateRows = await getOpsState(["students", "teachers"]);
  const currentProjectionRevision = projectionRevision(stateRows);
  if (input.expectedProjectionRevision && input.expectedProjectionRevision !== currentProjectionRevision) {
    // `reset` is deliberately returned instead of remapping one continuation
    // page with newer identities. The browser restarts both feeds together.
    return Object.freeze({
      state: "reset" as const,
      source: input.source,
      month: input.month,
      revision,
      rowCount,
      pageIndex,
      pageCount,
      publishedAt,
      projectionRevision: null,
      items: [],
    });
  }
  if (input.source === "lessons") {
    const records = snapshot.items.map((item) => {
      const wrapper = object(item);
      if (!wrapper || Object.keys(wrapper).length !== 2 || typeof wrapper.sourceKey !== "string" || !object(wrapper.record)) {
        throw new CompletedLessonSnapshotResponseError("invalid_snapshot_item");
      }
      const record = readJiaowubaoCompletedLessonSnapshotRecord(wrapper.record);
      if (record.sourceKey !== wrapper.sourceKey) throw new CompletedLessonSnapshotResponseError("snapshot_source_key_mismatch");
      return record;
    });
    const projection = projectJiaowubaoCompletedLessonRecords({ records, stateRows });
    return Object.freeze({
      state: "complete" as const,
      source: input.source,
      month: input.month,
      revision,
      rowCount,
      pageIndex,
      pageCount,
      publishedAt,
      projectionRevision: currentProjectionRevision,
      items: projection.items,
    });
  }
  const records = snapshot.items.map((item) => {
    const wrapper = object(item);
    if (!wrapper || Object.keys(wrapper).length !== 2 || typeof wrapper.sourceKey !== "string" || !object(wrapper.record)) {
      throw new CompletedLessonSnapshotResponseError("invalid_snapshot_item");
    }
    const record = readJiaowubaoCompletedScheduleSnapshotRecord(wrapper.record);
    if (record.sourceKey !== wrapper.sourceKey) throw new CompletedLessonSnapshotResponseError("snapshot_source_key_mismatch");
    return record;
  });
  const projection = projectJiaowubaoCompletedLessonRecords({ records: [], scheduleRecords: records, stateRows });
  return Object.freeze({
    state: "complete" as const,
    source: input.source,
    month: input.month,
    revision,
    rowCount,
    pageIndex,
    pageCount,
    publishedAt,
    projectionRevision: currentProjectionRevision,
    items: projection.scheduleEvents,
  });
}

export async function GET(request: Request) {
  const access = await requireFullAdmin();
  if ("response" in access) return access.response;
  const url = new URL(request.url);
  const month = exactMonth(url.searchParams.get("month"));
  if (!month) return noStore({ error: "month 必须使用 YYYY-MM。" }, 400);
  const source = exactSource(url.searchParams.get("source") ?? "lessons");
  if (!source) return noStore({ error: "source 必须为 lessons 或 schedules。" }, 400);
  const pageIndex = exactPageIndex(url.searchParams.get("page"));
  if (pageIndex === null) return noStore({ error: "page 必须使用受支持的页码。" }, 400);
  const requestedRevision = url.searchParams.get("revision");
  const expectedRevision = requestedRevision === null ? null : validRevision(requestedRevision);
  if (requestedRevision !== null && !expectedRevision) return noStore({ error: "revision 格式无效。" }, 400);
  const requestedProjectionRevision = url.searchParams.get("projectionRevision");
  const expectedProjectionRevision = requestedProjectionRevision === null ? null : validRevision(requestedProjectionRevision);
  if (requestedProjectionRevision !== null && !expectedProjectionRevision) return noStore({ error: "projectionRevision 格式无效。" }, 400);
  if (pageIndex > 0 && (!expectedRevision || !expectedProjectionRevision)) {
    return noStore({ error: "续页必须使用首个快照及映射版本。" }, 400);
  }
  if (expectedProjectionRevision && !expectedRevision) return noStore({ error: "projectionRevision 必须同时指定 revision。" }, 400);
  try {
    const projection = await currentProjectionPage({ month, pageIndex, expectedRevision, expectedProjectionRevision, source });
    return noStore(projection, projection.state === "reset" ? 409 : 200);
  } catch {
    return noStore({ error: "教务宝已消课快照暂时不可用。", code: "jiaowubao_completed_lesson_unavailable" }, 503);
  }
}

export async function POST(request: Request) {
  const access = await requireFullAdmin();
  if ("response" in access) return access.response;
  let payload: Record<string, unknown> | null;
  try {
    payload = object(await request.json());
  } catch {
    return noStore({ error: "请求内容无效。" }, 400);
  }
  const keys = payload ? Object.keys(payload) : [];
  if (!payload || !keys.includes("month") || keys.some((key) => key !== "month" && key !== "force")) {
    return noStore({ error: "请求内容无效。" }, 400);
  }
  const month = exactMonth(payload.month);
  if (!month) return noStore({ error: "month 必须使用 YYYY-MM。" }, 400);
  const force = payload.force === undefined ? false : payload.force === true;
  if (payload.force !== undefined && !force) return noStore({ error: "force 必须为 true。" }, 400);
  try {
    validateJiaowubaoClosedCompletedLessonMonth(month);
  } catch {
    return noStore({ error: "只能同步已完整结束的墨尔本自然月。" }, 400);
  }
  if (!consumeManualSync(access.actor)) {
    return noStore({ error: "已消课同步请求过于频繁，请稍后再试。", code: "jiaowubao_completed_lesson_rate_limited" }, 429);
  }
  try {
    const sync = await syncJiaowubaoCompletedLessonMonth({ month, force });
    if (sync.outcome === "already_running" || sync.outcome === "in_progress") {
      return noStore({
        outcome: sync.outcome,
        month,
        retryAfterSeconds: sync.retryAfterSeconds ?? 0,
        ...(sync.outcome === "in_progress" ? {
          memberCount: sync.memberCount ?? 0,
          completedMemberCount: sync.completedMemberCount ?? 0,
          rowCount: sync.rowCount ?? 0,
          sourcePageCount: sync.sourcePageCount ?? 0,
        } : {}),
      }, 202);
    }
    return noStore({ sync });
  } catch (error) {
    // Do not reflect JWB response bodies, credentials, database details, or
    // source rows. The previous immutable month pointer remains in place.
    console.error("jiaowubao_completed_lesson_sync_failed", { month, failure: safeSyncFailure(error) });
    return noStore({ error: "教务宝已消课同步未完成；当前已发布快照未被覆盖。", code: "jiaowubao_completed_lesson_sync_failed" }, 503);
  }
}
