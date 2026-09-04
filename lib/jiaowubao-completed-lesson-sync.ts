import {
  JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY,
  assertJiaowubaoCompletedLessonSnapshotPageBytes,
  validateJiaowubaoClosedCompletedLessonMonth,
} from "@/lib/jiaowubao-completed-lessons";
import {
  buildJiaowubaoCompletedMonthEvidenceEnvelope,
  collectJiaowubaoCompletedMonthEvidence,
} from "@/lib/jiaowubao-completed-month-evidence";
import {
  allJiaowubaoCompletedScheduleRecords,
  assertJiaowubaoCompletedScheduleSnapshotPageBytes,
} from "@/lib/jiaowubao-completed-schedule";
import {
  abortJiaowubaoCompletedLessonSnapshot,
  beginJiaowubaoCompletedLessonSnapshot,
  claimJiaowubaoCompletedLessonSyncLease,
  completeJiaowubaoCompletedLessonSnapshot,
  confirmJiaowubaoCompletedLessonSnapshotCurrent,
  getJiaowubaoCompletedLessonSnapshotPreflight,
  releaseJiaowubaoCompletedLessonSyncLease,
  stageJiaowubaoCompletedLessonSnapshotPage,
  stageJiaowubaoCompletedScheduleSnapshotPage,
} from "@/lib/ops-store";

const ACTOR = "Ops Admin" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/iu;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

export type JiaowubaoCompletedLessonSyncOutcome = "applied" | "no_change" | "already_running";

export type JiaowubaoCompletedLessonSyncResult = Readonly<{
  outcome: JiaowubaoCompletedLessonSyncOutcome;
  month: string;
  revision?: string;
  rowCount?: number;
  pageCount?: number;
  scheduleRowCount?: number;
  schedulePageCount?: number;
  retryAfterSeconds?: number;
}>;

function exactRevision(value: unknown) {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function exactRunId(value: unknown) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function validStageReceipt(value: Readonly<Record<string, unknown>>, runId: string, pageIndex: number, rowCount: number) {
  return value.runId === runId && value.pageIndex === pageIndex && value.rowCount === rowCount;
}

/**
 * Pulls, stages, and atomically publishes one complete calendar month. The
 * prior published month stays authoritative until every source page has been
 * checked and the database's period-specific pointer CAS succeeds.
 */
export async function syncJiaowubaoCompletedLessonMonth(input: Readonly<{
  month: string;
  now?: number;
}>): Promise<JiaowubaoCompletedLessonSyncResult> {
  const now = input.now ?? Date.now();
  const period = validateJiaowubaoClosedCompletedLessonMonth(input.month, new Date(now));
  const runKey = `jwb-completed-lessons-sync:${now}:${period.month}`;
  let acquired = false;
  let stagingRunId: string | null = null;
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

    const snapshot = await collectJiaowubaoCompletedMonthEvidence(period);
    const lessonRecords = snapshot.lessons.manifest.recordCount;
    const scheduleRecords = allJiaowubaoCompletedScheduleRecords(snapshot.schedules);
    const preflight = await getJiaowubaoCompletedLessonSnapshotPreflight({ month: period.month, actor: ACTOR });
    const currentRevision = preflight?.current === null ? null : exactRevision(preflight?.current?.revision);
    if (!preflight || preflight.apiSourceKey !== JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY
      || preflight.month !== period.month || (preflight.current !== null && currentRevision === null)) {
      throw new Error("jiaowubao_completed_lesson_preflight_invalid");
    }
    if (currentRevision === snapshot.manifest.revision) {
      const confirmation = await confirmJiaowubaoCompletedLessonSnapshotCurrent({
        month: period.month,
        revision: snapshot.manifest.revision,
        actor: ACTOR,
      });
      if (confirmation.confirmed !== true || confirmation.revision !== snapshot.manifest.revision
        || confirmation.rowCount !== lessonRecords
        || confirmation.scheduleRowCount !== snapshot.schedules.manifest.recordCount
        || typeof confirmation.publishedAt !== "string") {
        throw new Error("jiaowubao_completed_lesson_confirmation_invalid");
      }
      return Object.freeze({
        outcome: "no_change",
        month: period.month,
        revision: snapshot.manifest.revision,
        rowCount: lessonRecords,
        pageCount: snapshot.lessons.manifest.pageCount,
        scheduleRowCount: snapshot.schedules.manifest.recordCount,
        schedulePageCount: snapshot.schedules.manifest.pageCount,
      });
    }

    const envelope = buildJiaowubaoCompletedMonthEvidenceEnvelope(snapshot, currentRevision);
    const begin = await beginJiaowubaoCompletedLessonSnapshot({ envelope, actor: ACTOR });
    const runId = exactRunId(begin?.runId);
    if (!runId) throw new Error("jiaowubao_completed_lesson_begin_invalid");
    if (begin.state === "complete") {
      const confirmation = await confirmJiaowubaoCompletedLessonSnapshotCurrent({
        month: period.month,
        revision: snapshot.manifest.revision,
        actor: ACTOR,
      });
      if (confirmation.confirmed !== true || confirmation.revision !== snapshot.manifest.revision
        || confirmation.rowCount !== lessonRecords
        || confirmation.scheduleRowCount !== scheduleRecords.length
        || typeof confirmation.publishedAt !== "string") {
        throw new Error("jiaowubao_completed_lesson_confirmation_invalid");
      }
      return Object.freeze({
        outcome: begin.republished === true ? "applied" : "no_change",
        month: period.month,
        revision: snapshot.manifest.revision,
        rowCount: lessonRecords,
        pageCount: snapshot.lessons.manifest.pageCount,
        scheduleRowCount: snapshot.schedules.manifest.recordCount,
        schedulePageCount: snapshot.schedules.manifest.pageCount,
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
    if (completed.runId === runId
      && completed.state === "aborted"
      && completed.abortReason === "current_pointer_conflict") {
      // The database retired the losing CAS run in the same transaction. Do
      // not issue a second compensating abort for an already-terminal run.
      stagingRunId = null;
      throw new Error("jiaowubao_completed_lesson_current_pointer_conflict");
    }
    if (completed.runId !== runId || completed.state !== "complete" || completed.rowCount !== lessonRecords
      || completed.scheduleRowCount !== scheduleRecords.length
      || !exactRevision(completed.rowsSha256) || !exactRevision(completed.payloadSha256)) {
      throw new Error("jiaowubao_completed_lesson_completion_invalid");
    }
    return Object.freeze({
      outcome: completed.replayed ? "no_change" : "applied",
      month: period.month,
      revision: snapshot.manifest.revision,
      rowCount: lessonRecords,
      pageCount: snapshot.lessons.manifest.pageCount,
      scheduleRowCount: scheduleRecords.length,
      schedulePageCount: snapshot.schedules.manifest.pageCount,
    });
  } catch (error) {
    // Network/source failures get best-effort compensating cleanup. Pointer
    // CAS losers are retired transactionally by the database before return,
    // and a future begin can also replace any stale conflicting staging run.
    if (stagingRunId) {
      await abortJiaowubaoCompletedLessonSnapshot({ runId: stagingRunId, actor: ACTOR }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (acquired) {
      await releaseJiaowubaoCompletedLessonSyncLease({ month: period.month, runKey, actor: ACTOR }).catch(() => undefined);
    }
  }
}
