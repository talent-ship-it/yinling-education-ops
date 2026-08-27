import {
  closeTrialEscalationTasks,
  DEFAULT_TEACHING_CONTROL_WATCHER,
  deterministicTaskId,
  formatTaskDeadline,
  isTrialEscalationTaskRule,
  OpsTask,
  TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT,
  TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT,
  statusForDueAt,
  upsertTaskByRule,
} from "./ops-tasks";

/** One day is measured as an instant, not as a Melbourne calendar date. */
export const LP_PARENT_PROGRESS_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const LP_PARENT_PROGRESS_SYNC_RULE = "trial.parent-progress-sync";
export const LP_PARENT_PROGRESS_AUTO_ADVANCED_RESULT = "家长进度同步周期已自动推进";
export const LP_PARENT_PROGRESS_CLOSED_RESULT = "试听已排课或 LP 已结束，家长进度同步自动关闭";

const TERMINAL_RESULT_STATUSES = new Set([
  "已完成",
  "已取消",
  "试听成功",
  "试听失败",
  "试听未进行",
  "在读试听成功",
  "在读试听失败",
  "家长取消",
  "家长不继续",
  "不继续",
]);
const TERMINAL_PARENT_SIGNALS = new Set([
  "cancelled",
  "canceled",
  "not_continuing",
  "no_longer_interested",
  "not-continuing",
  "家长取消",
  "家长已取消",
  "家长不继续",
  "家长不再继续",
]);
const CANCELLED_BOOKING_STATUSES = new Set([
  "cancelled",
  "canceled",
  "已取消",
  "取消",
  "leave",
]);

/**
 * This is intentionally a small server-owned projection of an LP. In
 * particular, `publishedDate` is not accepted: a date without a time is not
 * an exact instant and must never be turned into a fabricated requestedAt.
 */
export type LpParentProgressRecord = Readonly<{
  id: string;
  studentId: string;
  owner: string;
  workflowType?: string;
  stage?: string;
  resultStatus?: string;
  status?: string;
  closed?: boolean;
  requestAt?: Date | string;
  requestedAt?: Date | string;
  requestedAtExact?: Date | string;
  publishedAt?: Date | string;
  /** Alternate name used by some server projections. Still must be an ISO instant. */
  publishedAtExact?: Date | string;
  parentProgressStatus?: string;
  parentDecision?: string;
  parentCancelled?: boolean;
  parentNoLongerContinuing?: boolean;
}>;

/**
 * Only trial LP workflows participate in the recurring parent-progress rule.
 * Keep this guard in the server-usable service layer so a caller cannot pass
 * every lpItems row and accidentally create reminders for unrelated flows.
 */
export function eligibleLpParentProgressRecords(records: readonly unknown[]): LpParentProgressRecord[] {
  return records.filter((record): record is LpParentProgressRecord => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const workflowType = (record as Record<string, unknown>).workflowType;
    return workflowType === "试听 LP" || workflowType === "换老师试听";
  });
}

/**
 * The booking adapter may pass a richer Booking record, but reconciliation
 * only trusts these fields. `trusted: true` is reserved for a server-checked
 * schedule projection; it is not a client bypass when the booking is marked
 * cancelled.
 */
export type LpParentProgressBooking = Readonly<{
  id: string;
  studentId: string;
  /** Optional server-side association to the LP/request workflow anchor. */
  lpId?: string;
  anchorBookingId?: string;
  requestAnchorBookingId?: string;
  kind?: string;
  status?: string;
  occurrenceStatus?: string;
  trusted?: boolean;
  actual?: boolean;
  requestedAt?: Date | string;
  scheduledAt?: Date | string;
  date?: string;
  start?: string;
  timezone?: string;
}>;

export type ReconcileLpParentProgressInput = Readonly<{
  tasks: readonly OpsTask[];
  lp: LpParentProgressRecord;
  bookings?: readonly LpParentProgressBooking[];
  now: Date | string;
  timeZone?: string;
  /** Legacy compatibility only; reconciliation always uses deterministic IDs. */
  idFactory?: (ruleKey: string, anchorBookingId: string) => string;
}>;

function parseInstant(value: Date | string | undefined) {
  if (value === undefined) return undefined;
  const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(instant.getTime()) ? instant : undefined;
}

function parseExactInstant(value: Date | string | undefined) {
  if (value instanceof Date) return parseInstant(value);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim())) {
    return undefined;
  }
  return parseInstant(value);
}

function requiredText(value: string | undefined, field: string) {
  if (!value?.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function parentProgressCycle(ruleKey: string | undefined) {
  const match = ruleKey?.match(/^trial\.parent-progress-sync\.([1-9]\d*)$/);
  return match ? Number(match[1]) : undefined;
}

function terminalLp(lp: LpParentProgressRecord) {
  return lp.closed === true
    || lp.stage === "完成"
    || lp.status === "closed"
    || lp.status === "已关闭"
    || lp.status === "cancelled"
    || lp.status === "已取消"
    || (lp.resultStatus !== undefined && TERMINAL_RESULT_STATUSES.has(lp.resultStatus))
    || lp.parentCancelled === true
    || lp.parentNoLongerContinuing === true
    || (lp.parentProgressStatus !== undefined && TERMINAL_PARENT_SIGNALS.has(lp.parentProgressStatus))
    || (lp.parentDecision !== undefined && TERMINAL_PARENT_SIGNALS.has(lp.parentDecision));
}

function credibleBooking(lp: LpParentProgressRecord, booking: LpParentProgressBooking) {
  if (booking.studentId !== lp.studentId || !booking.id.trim()) return false;
  if (CANCELLED_BOOKING_STATUSES.has(booking.status ?? "")
    || CANCELLED_BOOKING_STATUSES.has(booking.occurrenceStatus ?? "")) return false;
  const explicitLpAnchors = [booking.lpId, booking.anchorBookingId, booking.requestAnchorBookingId]
    .filter((value): value is string => Boolean(value?.trim()));
  const hasCurrentLpAnchor = explicitLpAnchors.length > 0 && explicitLpAnchors.every((anchor) => anchor === lp.id);
  if (explicitLpAnchors.length > 0 && !hasCurrentLpAnchor) return false;

  // A trusted/actual flag describes the source projection; it does not bind a
  // same-student booking to this LP. An LP anchor or exact request join is
  // mandatory, and the booking must still identify itself as a trial.
  if (!new Set(["试听", "试课", "trial"]).has(booking.kind ?? "")) return false;

  // `requestedAt` is the persisted LP/booking join key. If the LP has an exact
  // request instant, an associated booking must carry the same exact instant;
  // an old booking cannot be revived by a future scheduledAt or `trusted` flag.
  const lpRequestedAt = parseExactInstant(lp.requestedAt);
  if (!lpRequestedAt) return false;
  const bookingRequestedAt = parseExactInstant(booking.requestedAt);
  const requestMatches = bookingRequestedAt?.getTime() === lpRequestedAt.getTime();
  if (booking.requestedAt !== undefined && !requestMatches) {
    return false;
  }
  if (!hasCurrentLpAnchor && !requestMatches) return false;

  // A server projection may omit a schedule timestamp, but it still needs an
  // exact LP anchor (or exact request join) and trial kind above.
  return true;
}

function anchorInstant(lp: LpParentProgressRecord) {
  // Only the persisted exact request instant may create a deadline. Legacy
  // aliases remain in the input type for readers, but never fabricate one.
  return parseExactInstant(lp.requestedAt);
}

function taskDefaults(
  lp: LpParentProgressRecord,
  dueAt: Date,
  now: Date,
  cycle: number,
  timeZone: string,
  template?: OpsTask,
): OpsTask {
  const ruleKey = `${LP_PARENT_PROGRESS_SYNC_RULE}.${cycle}`;
  const anchorBookingId = lp.id;
  const recipients = template
    ? {
        owner: template.owner,
        assignees: template.assignees?.length ? [...template.assignees] : [template.owner],
        // Keep explicit prior watchers and satisfy the canonical teaching
        // control watcher contract for newly written task rows.
        watchers: Array.from(new Set([...(template.watchers ?? []), DEFAULT_TEACHING_CONTROL_WATCHER])),
      }
    : {
        owner: lp.owner,
        assignees: [lp.owner],
        watchers: [DEFAULT_TEACHING_CONTROL_WATCHER],
      };
  return {
    id: deterministicTaskId(anchorBookingId, ruleKey),
    title: `向家长同步 LP 安排进度（第 ${cycle} 次）`,
    ...recipients,
    studentId: lp.studentId,
    due: formatTaskDeadline(dueAt.toISOString(), timeZone) ?? dueAt.toISOString(),
    dueAt: dueAt.toISOString(),
    status: statusForDueAt(dueAt, now, timeZone),
    tone: "red",
    category: template?.category ?? "试听",
    trigger: cycle === 1
      ? "LP 请求/发布后 24 小时向家长同步安排进度"
      : `每 24 小时继续向家长同步安排进度（第 ${cycle} 次）`,
    ruleKey,
    anchorBookingId,
  };
}

function deduplicateProgressTasks(tasks: readonly OpsTask[], lpId: string, studentId: string) {
  const result: OpsTask[] = [];
  const indexByRule = new Map<string, number>();
  for (const task of tasks) {
    const cycle = parentProgressCycle(task.ruleKey);
    if (task.studentId !== studentId || task.anchorBookingId !== lpId || cycle === undefined) {
      result.push(task);
      continue;
    }
    const existingIndex = indexByRule.get(task.ruleKey!);
    if (existingIndex === undefined) {
      indexByRule.set(task.ruleKey!, result.length);
      result.push(task);
      continue;
    }
    // A completed record is the durable evidence for a cycle. If both copies
    // have the same state, retain the first ID and discard the later duplicate.
    const existing = result[existingIndex];
    if (task.status === "done" && existing.status !== "done") result[existingIndex] = task;
  }
  return result;
}

/**
 * Reconcile the LP parent-progress projection at one captured instant.
 *
 * At most one *open* sync task is produced. The cycle is derived from the
 * exact persisted request instant, so a missed browser refresh cannot make a
 * chain depend on an operator completing the previous task. Historical tasks
 * completed by a person remain untouched; stale open cycles are closed as
 * automatically superseded before the next cycle is upserted.
 */
export function reconcileLpParentProgressTasks(input: ReconcileLpParentProgressInput): OpsTask[] {
  const lpId = requiredText(input.lp.id, "lp.id");
  const studentId = requiredText(input.lp.studentId, "lp.studentId");
  requiredText(input.lp.owner, "lp.owner");
  const now = parseInstant(input.now);
  if (!now) throw new TypeError("now must be a valid date or ISO timestamp");
  const anchor = anchorInstant(input.lp);
  const timeZone = input.timeZone ?? "Australia/Melbourne";
  const scopedTasks = deduplicateProgressTasks(
    input.tasks.map((task) => ({ ...task })),
    lpId,
    studentId,
  );
  const relatedTasks = scopedTasks.filter((task) =>
    task.studentId === studentId
    && task.anchorBookingId === lpId
    && isTrialEscalationTaskRule(task.ruleKey),
  );

  const hasSchedule = (input.bookings ?? []).some((booking) => credibleBooking(input.lp, booking));
  // A booking-link operation closes the request-anchor escalation tasks with
  // this exact result. Treat that durable task evidence as terminal even when
  // the current reconciliation snapshot does not include bookings.
  const hasScheduledClosureEvidence = scopedTasks.some((task) =>
    task.studentId === studentId
    && task.anchorBookingId === lpId
    && task.status === "done"
    && task.result === TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT,
  );
  const hasParentReplyClosureEvidence = scopedTasks.some((task) =>
    task.studentId === studentId
    && task.anchorBookingId === lpId
    && task.status === "done"
    && (task.result === TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT || task.result === "家长已回复"),
  );
  if (terminalLp(input.lp) || hasSchedule || hasScheduledClosureEvidence || hasParentReplyClosureEvidence || !anchor) {
    // No exact anchor means there is no safe way to create a deadline. It is
    // still safe to close already-managed tasks when a terminal signal exists.
    if (terminalLp(input.lp) || hasSchedule || hasScheduledClosureEvidence || hasParentReplyClosureEvidence) {
      return closeTrialEscalationTasks(scopedTasks, {
        anchorBookingId: lpId,
        studentId,
        closedAt: now,
        result: hasScheduledClosureEvidence
          ? TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT
          : hasParentReplyClosureEvidence
            ? TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT
            : hasSchedule ? "试听已完成排课，家长进度同步自动关闭" : LP_PARENT_PROGRESS_CLOSED_RESULT,
      });
    }
    return scopedTasks;
  }

  const elapsed = now.getTime() - anchor.getTime();
  const cycle = Math.max(1, Math.ceil(elapsed / LP_PARENT_PROGRESS_INTERVAL_MS));
  const dueAt = new Date(anchor.getTime() + cycle * LP_PARENT_PROGRESS_INTERVAL_MS);
  const existingCurrent = relatedTasks.find((task) => parentProgressCycle(task.ruleKey) === cycle);
  // Prefer a prior managed task as the recipient template. This keeps custom
  // owner/assignee/watcher edits stable across a recalculation.
  const template = existingCurrent ?? relatedTasks.find((task) => task.status !== "done") ?? relatedTasks.at(-1);
  let reconciled = scopedTasks.map((task) => {
    const taskCycle = parentProgressCycle(task.ruleKey);
    if (task.studentId !== studentId || task.anchorBookingId !== lpId || taskCycle === undefined) return task;
    if (taskCycle !== cycle && task.status !== "done") {
      return {
        ...task,
        status: "done" as const,
        tone: "green" as const,
        result: LP_PARENT_PROGRESS_AUTO_ADVANCED_RESULT,
        closedAt: now.toISOString(),
      };
    }
    return task;
  });
  const generated = taskDefaults(input.lp, dueAt, now, cycle, timeZone, template);
  // Keep the validated identifiers explicit in case a caller passed a
  // structurally compatible record whose fields were not narrowed by TS.
  generated.studentId = studentId;
  generated.anchorBookingId = lpId;
  reconciled = upsertTaskByRule(reconciled, generated);
  return reconciled;
}

/** Short alias for callers that reconcile one LP at a time. */
export const reconcileLpParentProgressTask = reconcileLpParentProgressTasks;

/** Reconcile every visible LP against one captured snapshot/clock value. */
export function reconcileAllLpParentProgressTasks(input: Readonly<{
  tasks: readonly OpsTask[];
  lps: readonly LpParentProgressRecord[];
  bookings?: readonly LpParentProgressBooking[];
  now: Date | string;
  timeZone?: string;
  /** Legacy compatibility only; reconciliation always uses deterministic IDs. */
  idFactory?: (ruleKey: string, anchorBookingId: string) => string;
}>): OpsTask[] {
  return input.lps.reduce(
    (tasks, lp) => reconcileLpParentProgressTasks({
      tasks,
      lp,
      bookings: input.bookings,
      now: input.now,
      timeZone: input.timeZone,
    }),
    input.tasks.map((task) => ({ ...task })),
  );
}

export function isCredibleLpActualBooking(lp: LpParentProgressRecord, booking: LpParentProgressBooking) {
  return credibleBooking(lp, booking);
}
