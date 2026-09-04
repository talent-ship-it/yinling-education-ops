import {
  JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY,
  JIAOWUBAO_COMPLETED_LESSON_COLLECTION_FORMAT,
  assertJiaowubaoCompletedLessonSnapshotPageBytes,
  buildJiaowubaoCompletedLessonSnapshot,
  collectJiaowubaoCompletedLessonMemberPage,
  readJiaowubaoCompletedLessonSnapshotRecord,
  validateJiaowubaoClosedCompletedLessonMonth,
  type JiaowubaoCompletedLessonRecord,
} from "@/lib/jiaowubao-completed-lessons";
import {
  JiaowubaoOpenApiError,
  queryJiaowubaoScheduleList,
} from "@/lib/jiaowubao-open-api-node";
import {
  buildJiaowubaoCompletedMonthEvidenceEnvelope,
  buildJiaowubaoCompletedMonthEvidenceSnapshot,
  type JiaowubaoCompletedMonthEvidenceSnapshot,
} from "@/lib/jiaowubao-completed-month-evidence";
import {
  allJiaowubaoCompletedScheduleRecords,
  assertJiaowubaoCompletedScheduleSnapshotPageBytes,
  collectJiaowubaoCompletedScheduleSnapshotWithMemberIds,
} from "@/lib/jiaowubao-completed-schedule";
import {
  abortJiaowubaoCompletedLessonMemberCollection,
  abortJiaowubaoCompletedLessonSnapshot,
  beginJiaowubaoCompletedLessonMemberCollection,
  beginJiaowubaoCompletedLessonSnapshot,
  claimJiaowubaoCompletedLessonSyncLease,
  completeJiaowubaoCompletedLessonMemberPublication,
  completeJiaowubaoCompletedLessonSnapshot,
  confirmJiaowubaoCompletedLessonSnapshotCurrent,
  getJiaowubaoCompletedLessonMemberCollection,
  getJiaowubaoCompletedLessonMemberItemsPage,
  getJiaowubaoCompletedLessonSnapshotPreflight,
  OpsStoreError,
  prepareJiaowubaoCompletedLessonMemberPublication,
  releaseJiaowubaoCompletedLessonSyncLease,
  reserveJiaowubaoCompletedLessonApiRequest,
  reserveJiaowubaoOpenApiScheduleRequest,
  stageJiaowubaoCompletedLessonMemberPage,
  stageJiaowubaoCompletedLessonSnapshotPage,
  stageJiaowubaoCompletedScheduleSnapshotPage,
  type JiaowubaoCompletedLessonMemberCollection,
} from "@/lib/ops-store";

const ACTOR = "Ops Admin" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MEMBER_SOURCE_CALL_BUDGET = 50;
const WORKER_TIME_BUDGET_MS = 220_000;

export type JiaowubaoCompletedLessonSyncOutcome = "applied" | "no_change" | "already_running" | "in_progress" | "blocked";

export type JiaowubaoCompletedLessonSyncResult = Readonly<{
  outcome: JiaowubaoCompletedLessonSyncOutcome;
  month: string;
  revision?: string;
  rowCount?: number;
  pageCount?: number;
  scheduleRowCount?: number;
  schedulePageCount?: number;
  memberCount?: number;
  completedMemberCount?: number;
  sourcePageCount?: number;
  retryAfterSeconds?: number;
}>;

type ActiveMemberCollection = Readonly<{
  state: "collecting" | "ready" | "published" | "aborted" | "blocked";
  month: string;
  runId: string;
  scheduleRevision: string;
  scheduleMemberSetSha256: string;
  scheduleMemberCount: number;
  catalogRevisionSha256: string;
  catalogMemberCount: number;
  memberSetSha256: string;
  memberCount: number;
  completedMemberCount: number;
  rowCount: number;
  expectedCurrentRevision: string | null;
  finalRevision: string | null;
  abortReason: "schedule_changed" | "source_conflict" | "caller_failure" | "catalog_changed" | null;
  nextMemberId: number | null;
  nextPage: number | null;
  expectedTotal: number | null;
  targetVersion: number | null;
}>;

function exactRevision(value: unknown) {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function isJiaowubaoCompletedLessonRunId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function exactRunId(value: unknown) {
  return isJiaowubaoCompletedLessonRunId(value) ? value : null;
}

function exactInteger(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function readCollection(value: JiaowubaoCompletedLessonMemberCollection, month: string): ActiveMemberCollection | null {
  if (!value || value.month !== month) throw new Error("jiaowubao_completed_lesson_member_collection_invalid");
  if (value.state === "absent") return null;
  const runId = exactRunId(value.runId);
  const scheduleRevision = exactRevision(value.scheduleRevision);
  const scheduleMemberSetSha256 = exactRevision(value.scheduleMemberSetSha256);
  const memberSetSha256 = exactRevision(value.memberSetSha256);
  const scheduleMemberCount = exactInteger(value.scheduleMemberCount, 0, 6_000);
  const catalogRevisionSha256 = exactRevision(value.catalogRevisionSha256);
  const catalogMemberCount = exactInteger(value.catalogMemberCount, 1, 6_000);
  const memberCount = exactInteger(value.memberCount, 1, 6_000);
  const completedMemberCount = exactInteger(value.completedMemberCount, 0, 6_000);
  const rowCount = exactInteger(value.rowCount, 0, 6_000);
  const expectedCurrentRevision = value.expectedCurrentRevision === null ? null : exactRevision(value.expectedCurrentRevision);
  const finalRevision = value.finalRevision === null ? null : exactRevision(value.finalRevision);
  const abortReason = value.abortReason === null
    ? null
    : ["schedule_changed", "source_conflict", "caller_failure", "catalog_changed"].includes(value.abortReason ?? "")
      ? value.abortReason as ActiveMemberCollection["abortReason"]
      : null;
  if (!runId || !scheduleRevision || !scheduleMemberSetSha256 || !memberSetSha256
    || scheduleMemberCount === null || !catalogRevisionSha256 || catalogMemberCount === null
    || memberCount === null || completedMemberCount === null || rowCount === null
    || catalogMemberCount > memberCount || scheduleMemberCount > memberCount
    || completedMemberCount > memberCount
    || (value.expectedCurrentRevision !== null && !expectedCurrentRevision)
    || (value.finalRevision !== null && !finalRevision)
    || (value.abortReason !== null && !abortReason)
    || (value.state === "blocked" && abortReason !== "caller_failure")
    || (value.state === "aborted" && !abortReason)
    || (!["blocked", "aborted"].includes(value.state) && abortReason !== null)) {
    throw new Error("jiaowubao_completed_lesson_member_collection_invalid");
  }
  const isCollecting = value.state === "collecting";
  const nextMemberId = value.nextMemberId === null ? null : exactInteger(value.nextMemberId, 1, Number.MAX_SAFE_INTEGER);
  const nextPage = value.nextPage === null ? null : exactInteger(value.nextPage, 1, 60);
  const expectedTotal = value.expectedTotal === null ? null : exactInteger(value.expectedTotal, 0, 6_000);
  const targetVersion = value.targetVersion === null ? null : exactInteger(value.targetVersion, 0, 60);
  if (isCollecting !== Boolean(nextMemberId && nextPage && targetVersion !== null)
    || (value.nextMemberId !== null && nextMemberId === null)
    || (value.nextPage !== null && nextPage === null)
    || (value.expectedTotal !== null && expectedTotal === null)
    || (value.targetVersion !== null && targetVersion === null)) {
    throw new Error("jiaowubao_completed_lesson_member_cursor_invalid");
  }
  return Object.freeze({
    state: value.state,
    month,
    runId,
    scheduleRevision,
    scheduleMemberSetSha256,
    scheduleMemberCount,
    catalogRevisionSha256,
    catalogMemberCount,
    memberSetSha256,
    memberCount,
    completedMemberCount,
    rowCount,
    expectedCurrentRevision,
    finalRevision,
    abortReason,
    nextMemberId,
    nextPage,
    expectedTotal,
    targetVersion,
  });
}

function validStageReceipt(value: Readonly<Record<string, unknown>>, runId: string, pageIndex: number, rowCount: number) {
  return value.runId === runId && value.pageIndex === pageIndex && value.rowCount === rowCount;
}

function progressResult(collection: ActiveMemberCollection, sourcePageCount = 0): JiaowubaoCompletedLessonSyncResult {
  return Object.freeze({
    outcome: "in_progress",
    month: collection.month,
    rowCount: collection.rowCount,
    memberCount: collection.memberCount,
    completedMemberCount: collection.completedMemberCount,
    sourcePageCount,
    retryAfterSeconds: 300,
  });
}

function blockedResult(collection: ActiveMemberCollection): JiaowubaoCompletedLessonSyncResult {
  return Object.freeze({
    outcome: "blocked",
    month: collection.month,
    rowCount: collection.rowCount,
    memberCount: collection.memberCount,
    completedMemberCount: collection.completedMemberCount,
  });
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function deterministicMemberSourceFailure(error: unknown) {
  if (error instanceof JiaowubaoOpenApiError) {
    return error.code === "invalid_request" || error.code === "invalid_response"
      || error.code === "response_oversize" || error.code === "upstream_rejected";
  }
  return error instanceof Error && /^教务宝已消课(?:学员|记录|导出)/u.test(error.message);
}

async function reserveSourceRequest(month: string, runKey: string) {
  const reservation = await reserveJiaowubaoCompletedLessonApiRequest({ month, runKey, actor: ACTOR });
  const notBefore = typeof reservation?.notBefore === "string" ? Date.parse(reservation.notBefore) : Number.NaN;
  if (reservation?.tool !== "query_lesson_list" || !Number.isFinite(notBefore)) {
    throw new Error("jiaowubao_completed_lesson_rate_reservation_invalid");
  }
  const wait = Math.max(0, notBefore - Date.now());
  if (wait > 30_000) throw new Error("jiaowubao_completed_lesson_rate_reservation_oversize");
  if (wait > 0) await sleep(wait);
}

async function reserveScheduleRequest() {
  const reservation = await reserveJiaowubaoOpenApiScheduleRequest({ actor: ACTOR });
  const notBefore = typeof reservation?.notBefore === "string" ? Date.parse(reservation.notBefore) : Number.NaN;
  if (reservation?.tool !== "query_schedule_list" || !Number.isFinite(notBefore)) {
    throw new Error("jiaowubao_completed_schedule_rate_reservation_invalid");
  }
  const wait = Math.max(0, notBefore - Date.now());
  if (wait > 30_000) throw new Error("jiaowubao_completed_schedule_rate_reservation_oversize");
  if (wait > 0) await sleep(wait);
}

async function collectCompletedScheduleWithMemberIds(period: Readonly<{ start: string; end: string }>) {
  return collectJiaowubaoCompletedScheduleSnapshotWithMemberIds(period, async (query) => {
    await reserveScheduleRequest();
    return queryJiaowubaoScheduleList(query);
  });
}

async function readReadyLessonRecords(collection: ActiveMemberCollection, runKey: string) {
  const records: JiaowubaoCompletedLessonRecord[] = [];
  const expectedPageCount = collection.rowCount === 0 ? 0 : Math.ceil(collection.rowCount / 100);
  const pagesToRead = Math.max(1, expectedPageCount);
  for (let pageIndex = 0; pageIndex < pagesToRead; pageIndex += 1) {
    const page = await getJiaowubaoCompletedLessonMemberItemsPage({ runId: collection.runId, runKey, pageIndex, actor: ACTOR });
    if (!page || page.runId !== collection.runId || page.month !== collection.month
      || page.state !== "ready" || page.rowCount !== collection.rowCount
      || page.pageIndex !== pageIndex || page.pageCount !== expectedPageCount || !Array.isArray(page.items)) {
      throw new Error("jiaowubao_completed_lesson_member_items_invalid");
    }
    const expectedRows = collection.rowCount === 0 ? 0 : Math.min(100, collection.rowCount - pageIndex * 100);
    if (page.items.length !== expectedRows) throw new Error("jiaowubao_completed_lesson_member_items_invalid");
    for (const item of page.items) {
      if (!item || typeof item !== "object" || typeof item.sourceKey !== "string") {
        throw new Error("jiaowubao_completed_lesson_member_item_invalid");
      }
      const record = readJiaowubaoCompletedLessonSnapshotRecord(item.record);
      if (record.sourceKey !== item.sourceKey) throw new Error("jiaowubao_completed_lesson_member_item_invalid");
      records.push(record);
    }
  }
  if (records.length !== collection.rowCount || new Set(records.map((record) => record.sourceKey)).size !== records.length) {
    throw new Error("jiaowubao_completed_lesson_member_items_incomplete");
  }
  return Object.freeze(records);
}

async function publishSnapshot(
  snapshot: JiaowubaoCompletedMonthEvidenceSnapshot,
  currentRevision: string | null,
): Promise<JiaowubaoCompletedLessonSyncResult> {
  const month = snapshot.manifest.period.start.slice(0, 7);
  const lessonRecords = snapshot.lessons.manifest.recordCount;
  const scheduleRecords = allJiaowubaoCompletedScheduleRecords(snapshot.schedules);
  if (currentRevision === snapshot.manifest.revision) {
    const confirmation = await confirmJiaowubaoCompletedLessonSnapshotCurrent({ month, revision: snapshot.manifest.revision, actor: ACTOR });
    if (confirmation.confirmed !== true || confirmation.revision !== snapshot.manifest.revision
      || confirmation.rowCount !== lessonRecords || confirmation.scheduleRowCount !== scheduleRecords.length
      || typeof confirmation.publishedAt !== "string") {
      throw new Error("jiaowubao_completed_lesson_confirmation_invalid");
    }
    return Object.freeze({
      outcome: "no_change", month, revision: snapshot.manifest.revision,
      rowCount: lessonRecords, pageCount: snapshot.lessons.manifest.pageCount,
      scheduleRowCount: scheduleRecords.length, schedulePageCount: snapshot.schedules.manifest.pageCount,
    });
  }

  let stagingRunId: string | null = null;
  try {
    const envelope = buildJiaowubaoCompletedMonthEvidenceEnvelope(snapshot, currentRevision);
    const begin = await beginJiaowubaoCompletedLessonSnapshot({ envelope, actor: ACTOR });
    const runId = exactRunId(begin?.runId);
    if (!runId) throw new Error("jiaowubao_completed_lesson_begin_invalid");
    if (begin.state === "complete") {
      const confirmation = await confirmJiaowubaoCompletedLessonSnapshotCurrent({ month, revision: snapshot.manifest.revision, actor: ACTOR });
      if (confirmation.confirmed !== true || confirmation.revision !== snapshot.manifest.revision
        || confirmation.rowCount !== lessonRecords || confirmation.scheduleRowCount !== scheduleRecords.length
        || typeof confirmation.publishedAt !== "string") {
        throw new Error("jiaowubao_completed_lesson_confirmation_invalid");
      }
      return Object.freeze({
        outcome: begin.republished === true ? "applied" : "no_change", month, revision: snapshot.manifest.revision,
        rowCount: lessonRecords, pageCount: snapshot.lessons.manifest.pageCount,
        scheduleRowCount: scheduleRecords.length, schedulePageCount: snapshot.schedules.manifest.pageCount,
      });
    }
    if (begin.state !== "staging") throw new Error("jiaowubao_completed_lesson_begin_invalid");
    stagingRunId = runId;

    for (let pageIndex = 0; pageIndex < snapshot.lessons.pages.length; pageIndex += 1) {
      const page = snapshot.lessons.pages[pageIndex]!;
      const rows = page.records.map((record) => Object.freeze({ sourceKey: record.sourceKey, record }));
      assertJiaowubaoCompletedLessonSnapshotPageBytes(rows);
      const staged = await stageJiaowubaoCompletedLessonSnapshotPage({ runId, pageIndex, rows, actor: ACTOR });
      if (!validStageReceipt(staged as Readonly<Record<string, unknown>>, runId, pageIndex, rows.length)) {
        throw new Error("jiaowubao_completed_lesson_stage_invalid");
      }
    }
    for (let pageIndex = 0; pageIndex < snapshot.schedules.pages.length; pageIndex += 1) {
      const page = snapshot.schedules.pages[pageIndex]!;
      const rows = page.records.map((record) => Object.freeze({ sourceKey: record.sourceKey, record }));
      assertJiaowubaoCompletedScheduleSnapshotPageBytes(rows);
      const staged = await stageJiaowubaoCompletedScheduleSnapshotPage({ runId, pageIndex, rows, actor: ACTOR });
      if (!validStageReceipt(staged as Readonly<Record<string, unknown>>, runId, pageIndex, rows.length)) {
        throw new Error("jiaowubao_completed_schedule_stage_invalid");
      }
    }
    const completed = await completeJiaowubaoCompletedLessonSnapshot({ runId, actor: ACTOR });
    if (completed.runId === runId && completed.state === "aborted" && completed.abortReason === "current_pointer_conflict") {
      stagingRunId = null;
      throw new Error("jiaowubao_completed_lesson_current_pointer_conflict");
    }
    if (completed.runId !== runId || completed.state !== "complete" || completed.rowCount !== lessonRecords
      || completed.scheduleRowCount !== scheduleRecords.length
      || !exactRevision(completed.rowsSha256) || !exactRevision(completed.payloadSha256)) {
      throw new Error("jiaowubao_completed_lesson_completion_invalid");
    }
    stagingRunId = null;
    return Object.freeze({
      outcome: completed.replayed ? "no_change" : "applied", month, revision: snapshot.manifest.revision,
      rowCount: lessonRecords, pageCount: snapshot.lessons.manifest.pageCount,
      scheduleRowCount: scheduleRecords.length, schedulePageCount: snapshot.schedules.manifest.pageCount,
    });
  } catch (error) {
    if (stagingRunId) {
      await abortJiaowubaoCompletedLessonSnapshot({ runId: stagingRunId, actor: ACTOR }).catch(() => undefined);
    }
    throw error;
  }
}

export async function syncJiaowubaoCompletedLessonMonth(input: Readonly<{
  month: string;
  now?: number;
  force?: boolean;
  forceIfBlockedOnly?: boolean;
}>): Promise<JiaowubaoCompletedLessonSyncResult> {
  const now = input.now ?? Date.now();
  const force = input.force === true;
  const forceIfBlockedOnly = input.forceIfBlockedOnly === true;
  if (forceIfBlockedOnly && !force) {
    throw new Error("jiaowubao_completed_lesson_blocked_force_invalid");
  }
  const period = validateJiaowubaoClosedCompletedLessonMonth(input.month, new Date(now));
  const runKey = `jwb-completed-lessons-sync:${now}:${period.month}`;
  const workerStartedAt = Date.now();
  let acquired = false;
  try {
    const lease = await claimJiaowubaoCompletedLessonSyncLease({ month: period.month, runKey, actor: ACTOR });
    if (!lease || typeof lease.acquired !== "boolean" || typeof lease.runKey !== "string"
      || !Number.isSafeInteger(lease.retryAfterSeconds) || lease.retryAfterSeconds < 0) {
      throw new Error("jiaowubao_completed_lesson_lease_receipt_invalid");
    }
    if (!lease.acquired) {
      return Object.freeze({ outcome: "already_running", month: period.month, retryAfterSeconds: lease.retryAfterSeconds });
    }
    acquired = true;

    let collection = readCollection(
      await getJiaowubaoCompletedLessonMemberCollection({ month: period.month, runKey, actor: ACTOR }),
      period.month,
    );
    // This check runs only after the same-month lease is acquired. A delayed
    // bearer replay therefore cannot force a second rebuild after another
    // recovery has already advanced the month beyond its blocked run.
    if (forceIfBlockedOnly && collection?.state !== "blocked") {
      throw new Error("jiaowubao_completed_lesson_blocked_force_unavailable");
    }
    if (collection?.state === "blocked" && !force) return blockedResult(collection);

    const preflight = await getJiaowubaoCompletedLessonSnapshotPreflight({ month: period.month, actor: ACTOR });
    const currentRevision = preflight?.current === null ? null : exactRevision(preflight?.current?.revision);
    const currentRowCount = preflight?.current === null ? null : exactInteger(preflight?.current?.rowCount, 0, 6_000);
    const currentScheduleRowCount = preflight?.current === null
      ? null
      : exactInteger(preflight?.current?.scheduleRowCount, 0, 6_000);
    if (!preflight || preflight.apiSourceKey !== JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY
      || preflight.month !== period.month
      || (preflight.current !== null
        && (currentRevision === null || currentRowCount === null || currentScheduleRowCount === null))) {
      throw new Error("jiaowubao_completed_lesson_preflight_invalid");
    }

    if (collection?.state === "blocked") {
      collection = null;
    }

    if (!collection) {
      const capture = await collectCompletedScheduleWithMemberIds(period);
      collection = readCollection(await beginJiaowubaoCompletedLessonMemberCollection({
        month: period.month,
        runKey,
        scheduleRevision: capture.snapshot.manifest.revision,
        scheduleMemberIds: capture.memberIds,
        scheduleMemberSetSha256: capture.memberSetSha256,
        expectedCurrentRevision: currentRevision,
        force,
        actor: ACTOR,
      }), period.month);
      if (!collection) throw new Error("jiaowubao_completed_lesson_member_begin_invalid");
      return progressResult(collection);
    }

    // A pointer is considered current for this collector only when a completed
    // member-run proves that exact revision. A legacy pointer without this
    // proof is rebuilt once instead of permanently short-circuiting the fix.
    if (collection.state === "published") {
      if (!force && collection.finalRevision && collection.finalRevision === currentRevision && preflight.current) {
        return Object.freeze({
          outcome: "no_change", month: period.month, revision: currentRevision!,
          rowCount: currentRowCount!, scheduleRowCount: currentScheduleRowCount!,
          memberCount: collection.memberCount,
          completedMemberCount: collection.completedMemberCount,
        });
      }
      const capture = await collectCompletedScheduleWithMemberIds(period);
      collection = readCollection(await beginJiaowubaoCompletedLessonMemberCollection({
        month: period.month,
        runKey,
        scheduleRevision: capture.snapshot.manifest.revision,
        scheduleMemberIds: capture.memberIds,
        scheduleMemberSetSha256: capture.memberSetSha256,
        expectedCurrentRevision: currentRevision,
        force,
        actor: ACTOR,
      }), period.month);
      if (!collection || collection.state !== "collecting") {
        throw new Error("jiaowubao_completed_lesson_member_begin_invalid");
      }
      return progressResult(collection);
    }

    if (collection.state === "collecting") {
      if (currentRevision !== collection.expectedCurrentRevision) {
        await abortJiaowubaoCompletedLessonMemberCollection({ runId: collection.runId, runKey, reason: "source_conflict", actor: ACTOR });
        if (preflight.current) {
          return Object.freeze({
            outcome: "no_change", month: period.month, revision: currentRevision!,
            rowCount: currentRowCount!, scheduleRowCount: currentScheduleRowCount!,
          });
        }
        throw new Error("jiaowubao_completed_lesson_member_current_pointer_conflict");
      }
      let sourcePageCount = 0;
      while (collection.state === "collecting"
        && sourcePageCount < MEMBER_SOURCE_CALL_BUDGET
        && Date.now() - workerStartedAt < WORKER_TIME_BUDGET_MS) {
        const memberId = collection.nextMemberId!;
        const page = collection.nextPage!;
        const targetVersion = collection.targetVersion!;
        await reserveSourceRequest(period.month, runKey);
        let sourcePage;
        try {
          sourcePage = await collectJiaowubaoCompletedLessonMemberPage(period, memberId, page, collection.expectedTotal);
        } catch (error) {
          if (deterministicMemberSourceFailure(error)) {
            await abortJiaowubaoCompletedLessonMemberCollection({
              runId: collection.runId, runKey, reason: "caller_failure", actor: ACTOR,
            }).catch(() => undefined);
          }
          throw error;
        }
        const rows = sourcePage.records.map((record) => Object.freeze({ sourceKey: record.sourceKey, record }));
        const collectionRunId = collection.runId;
        try {
          collection = readCollection(await stageJiaowubaoCompletedLessonMemberPage({
            runId: collectionRunId,
            runKey,
            memberId,
            page,
            targetVersion,
            sourceTotal: sourcePage.total,
            rows,
            actor: ACTOR,
          }), period.month);
        } catch (error) {
          // If the database committed but the HTTP receipt was lost, observe
          // the advanced CAS cursor instead of aborting valid evidence.
          const recovered = await getJiaowubaoCompletedLessonMemberCollection({
            month: period.month, runKey, actor: ACTOR,
          }).then((value) => readCollection(value, period.month)).catch(() => null);
          const advanced = recovered && (recovered.state !== "collecting"
            || recovered.nextMemberId !== memberId
            || recovered.nextPage !== page
            || recovered.targetVersion !== targetVersion);
          if (advanced) {
            collection = recovered;
          } else {
            if (error instanceof OpsStoreError && ["22023", "23505", "55000"].includes(error.code ?? "")) {
              await abortJiaowubaoCompletedLessonMemberCollection({
                runId: collectionRunId, runKey, reason: "caller_failure", actor: ACTOR,
              }).catch(() => undefined);
            }
            throw error;
          }
        }
        if (!collection) throw new Error("jiaowubao_completed_lesson_member_stage_invalid");
        sourcePageCount += 1;
      }
      // Completing the final member can happen near the end of this worker's
      // source-call budget. Start the ready/publication phase in a fresh
      // invocation so its schedule recheck and atomic publisher get the full
      // route duration instead of inheriting an almost-expired request.
      if (collection.state === "ready" && sourcePageCount > 0) {
        return progressResult(collection, sourcePageCount);
      }
      return progressResult(collection, sourcePageCount);
    }

    if (collection.state !== "ready") throw new Error("jiaowubao_completed_lesson_member_state_invalid");
    // Recover an ambiguous network result after the immutable publisher moved
    // the pointer but before this private crawl was marked published.
    if (collection.finalRevision && currentRevision === collection.finalRevision) {
      const completedCollection = readCollection(await completeJiaowubaoCompletedLessonMemberPublication({
        runId: collection.runId, runKey, revision: collection.finalRevision, actor: ACTOR,
      }), period.month);
      if (!completedCollection || completedCollection.state !== "published") {
        throw new Error("jiaowubao_completed_lesson_member_publish_invalid");
      }
      return Object.freeze({
        outcome: "no_change", month: period.month, revision: currentRevision,
        rowCount: currentRowCount!, scheduleRowCount: currentScheduleRowCount!,
        memberCount: completedCollection.memberCount,
        completedMemberCount: completedCollection.completedMemberCount,
      });
    }
    // A ready crawl is still fenced by the exact current pointer observed when
    // it began. Never let an older, slow crawl overwrite another publisher.
    if (currentRevision !== collection.expectedCurrentRevision) {
      await abortJiaowubaoCompletedLessonMemberCollection({
        runId: collection.runId, runKey, reason: "source_conflict", actor: ACTOR,
      });
      if (preflight.current) {
        return Object.freeze({
          outcome: "no_change", month: period.month, revision: currentRevision!,
          rowCount: currentRowCount!, scheduleRowCount: currentScheduleRowCount!,
        });
      }
      throw new Error("jiaowubao_completed_lesson_member_current_pointer_conflict");
    }
    const lessonRecords = await readReadyLessonRecords(collection, runKey);
    const lessons = buildJiaowubaoCompletedLessonSnapshot(period, lessonRecords, {
      format: JIAOWUBAO_COMPLETED_LESSON_COLLECTION_FORMAT,
      memberSetSha256: collection.memberSetSha256,
      memberCount: collection.memberCount,
      catalogRevisionSha256: collection.catalogRevisionSha256,
      catalogMemberCount: collection.catalogMemberCount,
      scheduleRevision: collection.scheduleRevision,
      scheduleMemberSetSha256: collection.scheduleMemberSetSha256,
      scheduleMemberCount: collection.scheduleMemberCount,
    });
    const finalSchedule = await collectCompletedScheduleWithMemberIds(period);
    if (finalSchedule.snapshot.manifest.revision !== collection.scheduleRevision
      || finalSchedule.memberSetSha256 !== collection.scheduleMemberSetSha256
      || finalSchedule.memberIds.length !== collection.scheduleMemberCount) {
      await abortJiaowubaoCompletedLessonMemberCollection({ runId: collection.runId, runKey, reason: "schedule_changed", actor: ACTOR });
      return Object.freeze({
        outcome: "in_progress", month: period.month, rowCount: 0,
        memberCount: collection.memberCount, completedMemberCount: 0, retryAfterSeconds: 300,
      });
    }
    const snapshot = buildJiaowubaoCompletedMonthEvidenceSnapshot(lessons, finalSchedule.snapshot);
    const prepared = readCollection(await prepareJiaowubaoCompletedLessonMemberPublication({
      runId: collection.runId, runKey, revision: snapshot.manifest.revision, actor: ACTOR,
    }), period.month);
    if (prepared?.state === "aborted") return progressResult(prepared);
    if (!prepared || prepared.state !== "ready" || prepared.finalRevision !== snapshot.manifest.revision) {
      throw new Error("jiaowubao_completed_lesson_member_prepare_invalid");
    }
    const published = await publishSnapshot(snapshot, collection.expectedCurrentRevision);
    const completedCollection = readCollection(await completeJiaowubaoCompletedLessonMemberPublication({
      runId: collection.runId, runKey, revision: snapshot.manifest.revision, actor: ACTOR,
    }), period.month);
    if (!completedCollection || completedCollection.state !== "published") {
      throw new Error("jiaowubao_completed_lesson_member_publish_invalid");
    }
    return Object.freeze({
      ...published,
      memberCount: completedCollection.memberCount,
      completedMemberCount: completedCollection.completedMemberCount,
    });
  } finally {
    if (acquired) {
      await releaseJiaowubaoCompletedLessonSyncLease({ month: period.month, runKey, actor: ACTOR }).catch(() => undefined);
    }
  }
}
