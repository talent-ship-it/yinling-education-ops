import { FIXED_REMINDER_RULES } from "./ops-rules";
import { DEMO_LIMITED_ADMIN_USER } from "./demo-users";

export const MELBOURNE_TIME_ZONE = "Australia/Melbourne";
export const TASK_SPACING_MS = 60 * 60 * 1_000;
export const TRIAL_SHORT_NOTICE_THRESHOLD_HOURS = 72;
/** Stable recipient used by automatic teaching-operations tasks. */
export const DEFAULT_TEACHING_CONTROL_WATCHER = DEMO_LIMITED_ADMIN_USER;

export type TaskStatus = "overdue" | "today" | "upcoming" | "waiting" | "done";
export type TaskTone = "neutral" | "blue" | "green" | "amber" | "red" | "purple";
/** Includes every legacy UI category plus feedback-driven exam and cover workflows. */
export type TaskCategory =
  | "试听"
  | "LP"
  | "排课"
  | "课后"
  | "续课"
  | "薪资"
  | "资料"
  | "考试"
  | "请假代课";

/** The optional automation fields keep this type compatible with legacy/manual tasks. */
export interface OpsTask {
  id: string;
  title: string;
  owner: string;
  /** Explicit recipients; optional so persisted single-owner tasks remain readable. */
  assignees?: string[];
  watchers?: string[];
  studentId: string;
  due: string;
  status: TaskStatus;
  tone: TaskTone;
  category: TaskCategory;
  trigger: string;
  result?: string;
  /** `cannot_do` remains a closed task but is shown separately from completed work. */
  completionOutcome?: "done" | "cannot_do";
  /** Operator note; required when completionOutcome is `cannot_do`. */
  completionNote?: string;
  ruleKey?: string;
  dueAt?: string;
  /**
   * Historical evidence retained when an imported task had no verifiable
   * deadline. Frozen evidence is deliberately not an executable task.
   */
  legacyEvidence?: {
    state: "frozen";
    reason: "missing_canonical_due_at";
    sourceDue?: string;
    sourceDueAt?: string;
    frozenAt: string;
  };
  anchorBookingId?: string;
  /** Trial-request identity retained after an authoritative booking takes over. */
  requestAnchorBookingId?: string;
  closedAt?: string;
}

export type Task = OpsTask;

const CANONICAL_DUE_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A deadline is canonical only when it round-trips to the exact ISO value. */
export function isCanonicalTaskDueAt(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_DUE_AT.test(value)) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

export function isFrozenLegacyTask(task: { legacyEvidence?: unknown; dueAt?: unknown }) {
  // UI/executable filtering is deliberately fail-closed. The database owns
  // marker validity and its private ledger; any persisted marker presence must
  // remain hidden until an authorized transaction removes the field entirely.
  return task.legacyEvidence !== undefined;
}

/** Only these rows are allowed into the executable To Do queue. */
export function isExecutableOpenTask(task: Pick<OpsTask, "status" | "dueAt" | "legacyEvidence">) {
  return task.status !== "done" && !isFrozenLegacyTask(task) && isCanonicalTaskDueAt(task.dueAt);
}

export interface RuleBoundTask extends OpsTask {
  ruleKey: string;
  dueAt: string;
  anchorBookingId: string;
}

/** Legacy name retained for the five rules used by a standard-notice trial. */
export const TRIAL_TASK_RULES = [
  "trial.parent-follow-up",
  "trial.scheduling",
  "trial.lp-review",
  "trial.prep",
  "trial.minimum",
] as const;

export const TRIAL_STANDARD_TASK_RULES = TRIAL_TASK_RULES;

export const TRIAL_SHORT_NOTICE_TASK_RULES = [
  "trial.parent-follow-up",
  "trial.scheduling",
  "trial.lp-review",
  "trial.prep",
] as const;

/** Payment reminders are reconciled from the locked LP/student/booking rows. */
export const TRIAL_PAYMENT_TASK_RULES = [
  "trial.payment-n2",
  "trial.payment-urgent",
] as const;

export type TrialPaymentTaskRuleKey = (typeof TRIAL_PAYMENT_TASK_RULES)[number];

/** Every trial rule managed by reconciliation, including mutually exclusive rules. */
export const TRIAL_MANAGED_TASK_RULES = [
  ...TRIAL_TASK_RULES,
  "trial.short-notice-prep",
] as const;

export type TrialTaskRuleKey = (typeof TRIAL_MANAGED_TASK_RULES)[number];

export const TRIAL_REQUEST_TASK_RULES = [
  "trial.parent-follow-up",
  "trial.scheduling",
] as const satisfies readonly TrialTaskRuleKey[];

export type TrialRequestTaskRuleKey = (typeof TRIAL_REQUEST_TASK_RULES)[number];

export const TRIAL_ESCALATION_TASK_RULES = [
  "trial.parent-no-reply-follow-up",
  "trial.teaching-control-escalation",
] as const;

export const TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT = "试听已完成排课，升级任务自动关闭";
export const TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT = "家长已回复，升级任务自动关闭";

export type TrialEscalationTaskRuleKey =
  | (typeof TRIAL_ESCALATION_TASK_RULES)[number]
  | `trial.parent-progress-sync.${number}`;

function taskSeedHash(seed: string, initial: number) {
  let hash = initial >>> 0;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").toUpperCase();
}

/** Stable, ASCII-safe identity for generated LP/trial escalation tasks. */
export function deterministicTaskId(anchorBookingId: string, ruleKey: string) {
  const anchor = anchorBookingId.trim();
  const rule = ruleKey.trim();
  if (!anchor) throw new TypeError("anchorBookingId is required");
  if (!rule) throw new TypeError("ruleKey is required");
  const seed = `${anchor}\u001f${rule}`;
  return `TSK-LP-${taskSeedHash(seed, 0x811c9dc5)}-${taskSeedHash(`${seed}\u001fLP`, 0x9e3779b9)}`;
}

export function isTrialEscalationTaskRule(ruleKey: string | undefined): ruleKey is TrialEscalationTaskRuleKey {
  return Boolean(
    ruleKey
      && (
        (TRIAL_ESCALATION_TASK_RULES as readonly string[]).includes(ruleKey)
        || /^trial\.parent-progress-sync\.[1-9]\d*$/.test(ruleKey)
      ),
  );
}

/** Close every still-open no-reply escalation after a terminal workflow signal. */
export function closeTrialEscalationTasks<T extends OpsTask>(
  tasks: readonly T[],
  input: Readonly<{
    anchorBookingId: string;
    closedAt: Date | string;
    studentId?: string;
    result?: string;
  }>,
): T[] {
  if (!input.anchorBookingId.trim()) throw new TypeError("anchorBookingId is required");
  if (input.studentId !== undefined && !input.studentId.trim()) throw new TypeError("studentId must not be empty");
  const closedAt = asDate(input.closedAt, "closedAt").toISOString();
  const result = input.result?.trim() || TRIAL_PARENT_REPLIED_ESCALATION_CLOSED_RESULT;
  return tasks.map((task) => task.anchorBookingId === input.anchorBookingId
    && (!input.studentId || task.studentId === input.studentId)
    && isTrialEscalationTaskRule(task.ruleKey)
    && task.status !== "done"
    ? { ...task, status: "done", tone: "green", result, closedAt }
    : { ...task });
}

export const TRIAL_RULE_NO_LONGER_APPLICABLE_RESULT = "试听时距规则已切换，任务自动关闭";

export interface TrialRequestTaskInput {
  /** A workflow/request id is valid until a real booking id exists. */
  anchorBookingId: string;
  studentId: string;
  owner: string;
  requestedAt: Date | string;
  now: Date | string;
  timeZone?: string;
  sameDayHour?: number;
  idFactory?: (ruleKey: TrialRequestTaskRuleKey, anchorBookingId: string) => string;
}

export interface TrialBookingTaskInput {
  anchorBookingId: string;
  studentId: string;
  owner: string;
  /** Instant at which the parent/trial scheduling request entered the workflow. */
  requestedAt: Date | string;
  /** Absolute trial start instant. */
  trialStartsAt: Date | string;
  /** Explicit clock input keeps generation deterministic and easy to test. */
  now: Date | string;
  timeZone?: string;
  sameDayHour?: number;
  idFactory?: (ruleKey: TrialTaskRuleKey, anchorBookingId: string) => string;
}

export interface TrialPaymentTaskInput {
  anchorBookingId: string;
  studentId: string;
  planner: string;
  trialStartsAt: Date | string;
  /** Missing/null is unknown authority and must never be treated as chargeable. */
  trialPaymentMethod?: string | null;
  now: Date | string;
  timeZone?: string;
  idFactory?: (ruleKey: TrialPaymentTaskRuleKey, anchorBookingId: string) => string;
}

export interface TrialEscalationTaskInput {
  anchorBookingId: string;
  studentId: string;
  owner: string;
  requestedAt: Date | string;
  now: Date | string;
  timeZone?: string;
  /** Number of 24-hour parent progress-sync tasks to materialize. */
  parentProgressSyncCount?: number;
  idFactory?: (ruleKey: TrialEscalationTaskRuleKey, anchorBookingId: string) => string;
}

export interface LinkTrialRequestTasksInput extends TrialBookingTaskInput {
  /** Temporary workflow/request anchor used before the booking was created. */
  requestAnchorBookingId: string;
}

type LocalDate = { year: number; month: number; day: number };

const localDateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function asDate(value: Date | string, field: string) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be a valid date or ISO timestamp`);
  return date;
}

function localDateFormatter(timeZone: string) {
  const cached = localDateFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  localDateFormatterCache.set(timeZone, formatter);
  return formatter;
}

function localParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    localDateFormatter(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function localDateKey(date: Date, timeZone: string) {
  const { year, month, day } = localParts(date, timeZone);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Convert a wall-clock time to an instant. Workflow times use unambiguous 18:00. */
function localDateTimeToInstant(date: LocalDate, hour: number, minute: number, timeZone: string) {
  const wallClockAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let candidate = wallClockAsUtc;

  // Re-evaluate the offset because it can change across Melbourne DST boundaries.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = localParts(new Date(candidate), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const adjustment = wallClockAsUtc - actualAsUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }

  return new Date(candidate);
}

function atLocalHour(instant: Date, days: number, hour: number, timeZone: string) {
  const parts = localParts(instant, timeZone);
  return localDateTimeToInstant(addLocalDays(parts, days), hour, 0, timeZone);
}

function formatDue(instant: Date, timeZone: string) {
  const { year, month, day, hour, minute } = localParts(instant, timeZone);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")} ${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

/**
 * Format the canonical deadline instant that drives a task.  `due` is kept on
 * legacy records as descriptive copy, so it must never be used as a source of
 * truth for an operator-facing deadline.  Task workflows are calculated in
 * Melbourne time unless an explicit business timezone is supplied.
 */
export function formatTaskDeadline(
  dueAt: string | undefined,
  timeZone = MELBOURNE_TIME_ZONE,
  timeFormat: "24h" | "12h" = "24h",
) {
  if (!isCanonicalTaskDueAt(dueAt)) return undefined;
  const instant = new Date(dueAt);
  if (!Number.isFinite(instant.getTime())) return undefined;
  const { year, month, day, hour, minute } = localParts(instant, timeZone);
  const minuteLabel = minute.toString().padStart(2, "0");
  const timeLabel = timeFormat === "12h"
    ? `${hour < 12 ? "上午" : "下午"}${(hour % 12 || 12).toString().padStart(2, "0")}:${minuteLabel}`
    : `${hour.toString().padStart(2, "0")}:${minuteLabel}`;
  return `${year}年${month}月${day}日 ${timeLabel}`;
}

/** Compact operator-facing deadline; the canonical instant remains in dateTime. */
export function formatCompactTaskDeadline(
  dueAt: string | undefined,
  timeZone = MELBOURNE_TIME_ZONE,
) {
  if (!isCanonicalTaskDueAt(dueAt)) return undefined;
  const instant = new Date(dueAt);
  if (!Number.isFinite(instant.getTime())) return undefined;
  const { month, day } = localParts(instant, timeZone);
  return `${month}月${day}日`;
}

export type TaskTitlePresentation = Readonly<{
  primary: string;
  details: readonly string[];
}>;

/**
 * Handbook task titles use 【】 for the action and <> for context. Keep the
 * exact persisted title for audit/history, but present only that action as the
 * visual headline and demote names/times to supporting text.
 */
export function taskTitlePresentation(value: string): TaskTitlePresentation {
  const title = value.trim();
  const primaryMatch = title.match(/【([^【】]+)】/u);
  if (!primaryMatch) return { primary: title, details: [] };
  const details = [...title.matchAll(/<([^<>]+)>/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  return {
    primary: `【${primaryMatch[1]?.trim() ?? ""}】`,
    details,
  };
}

export function statusForDueAt(
  dueAt: Date | string,
  now: Date | string,
  timeZone = MELBOURNE_TIME_ZONE,
): Exclude<TaskStatus, "waiting" | "done"> {
  const due = asDate(dueAt, "dueAt");
  const current = asDate(now, "now");
  const dueDay = localDateKey(due, timeZone);
  const currentDay = localDateKey(current, timeZone);
  return dueDay < currentDay ? "overdue" : dueDay === currentDay ? "today" : "upcoming";
}

export function refreshTaskStatus<T extends OpsTask>(
  task: T,
  now: Date | string,
  timeZone = MELBOURNE_TIME_ZONE,
): T {
  if (!task.dueAt || task.status === "done") return { ...task };
  return { ...task, status: statusForDueAt(task.dueAt, now, timeZone) };
}

export function sortTasksByDueAt<T extends OpsTask>(tasks: readonly T[]): T[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const leftTime = left.task.dueAt ? Date.parse(left.task.dueAt) : Number.POSITIVE_INFINITY;
      const rightTime = right.task.dueAt ? Date.parse(right.task.dueAt) : Number.POSITIVE_INFINITY;
      const safeLeft = Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY;
      const safeRight = Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY;
      return safeLeft - safeRight || left.index - right.index;
    })
    .map(({ task }) => task);
}

export function taskRuleIdentity(task: Pick<OpsTask, "ruleKey" | "anchorBookingId">) {
  return task.ruleKey && task.anchorBookingId ? `${task.ruleKey}\u0000${task.anchorBookingId}` : undefined;
}

/**
 * Replace the task for a rule/booking pair, remove stale duplicates, and retain
 * the original id. A task already completed by a person is never reopened.
 */
export function upsertTaskByRule<T extends OpsTask>(tasks: readonly T[], incoming: T): T[] {
  const identity = taskRuleIdentity(incoming);
  if (!identity) throw new TypeError("incoming task requires ruleKey and anchorBookingId");
  const matching = tasks.filter((task) => taskRuleIdentity(task) === identity);
  const firstIndex = tasks.findIndex((task) => taskRuleIdentity(task) === identity);
  const existing = matching.find((task) => task.status === "done") ?? matching[0];
  const merged = existing
    ? ({
        ...incoming,
        id: existing.id,
        ...(existing.status === "done"
          ? { status: existing.status, tone: existing.tone, result: existing.result, closedAt: existing.closedAt }
          : {}),
      } as T)
    : incoming;

  if (firstIndex < 0) return [...tasks, merged];

  const result: T[] = [];
  tasks.forEach((task, index) => {
    if (taskRuleIdentity(task) !== identity) result.push(task);
    else if (index === firstIndex) result.push(merged);
  });
  return result;
}

export function upsertTasksByRule<T extends OpsTask>(tasks: readonly T[], incoming: readonly T[]): T[] {
  return incoming.reduce<T[]>((current, task) => upsertTaskByRule(current, task), [...tasks]);
}

const trialRuleDetails: Record<
  TrialTaskRuleKey,
  Pick<RuleBoundTask, "title" | "tone" | "category" | "trigger">
> = {
  "trial.parent-follow-up": {
    title: "发送家长试听跟进请求",
    tone: "blue",
    category: "试听",
    trigger: "试听需求进入后当天跟进家长",
  },
  "trial.scheduling": {
    title: "完成试听排课",
    tone: "red",
    category: "排课",
    trigger: "试听需求进入后 24 小时内完成排课",
  },
  "trial.lp-review": {
    title: "审核试听 LP",
    tone: "blue",
    category: "LP",
    trigger: "试听前 N-3 审核 LP",
  },
  "trial.prep": {
    title: "确认老师备课内容与资料",
    tone: "amber",
    category: "LP",
    trigger: "试听前 N-2 完成备课交接",
  },
  "trial.minimum": {
    title: "完成试听前最低检查",
    tone: "red",
    category: "试听",
    trigger: "试听前 N-1 最低检查",
  },
  "trial.short-notice-prep": {
    title: "短通知备课确认",
    tone: "red",
    category: "LP",
    trigger: "试听距开课不足 72 小时，立即确认老师备课与试听资料",
  },
};

const shortNoticeRuleDetails: Partial<Record<
  TrialTaskRuleKey,
  Pick<RuleBoundTask, "title" | "tone" | "category" | "trigger">
>> = {
  "trial.lp-review": {
    title: "紧急审核试听 LP",
    tone: "red",
    category: "LP",
    trigger: "试听距开课不足 72 小时，按 N-1 最低时效立即审核 LP",
  },
  "trial.prep": {
    title: "紧急确认老师备课内容与资料",
    tone: "red",
    category: "LP",
    trigger: "试听距开课不足 72 小时，按 N-1 最低时效立即确认备课",
  },
};

function automaticTaskRecipients(owner: string) {
  return {
    assignees: [owner],
    watchers: [DEFAULT_TEACHING_CONTROL_WATCHER],
  };
}

/**
 * Materialize the no-reply escalation schedule without reading external state.
 * Callers choose how many recurring 24-hour parent syncs to create; each cycle
 * has its own stable rule key so reconciliation remains idempotent.
 */
export function generateTrialEscalationTasks(input: TrialEscalationTaskInput): RuleBoundTask[] {
  const timeZone = input.timeZone ?? MELBOURNE_TIME_ZONE;
  const requestedAt = asDate(input.requestedAt, "requestedAt");
  const now = asDate(input.now, "now");
  const syncCount = input.parentProgressSyncCount ?? 1;
  if (!Number.isSafeInteger(syncCount) || syncCount < 0 || syncCount > 365) {
    throw new RangeError("parentProgressSyncCount must be an integer from 0 to 365");
  }
  if (!input.anchorBookingId.trim()) throw new TypeError("anchorBookingId is required");
  if (!input.studentId.trim()) throw new TypeError("studentId is required");
  if (!input.owner.trim()) throw new TypeError("owner is required");

  const definitions: Array<{
    ruleKey: TrialEscalationTaskRuleKey;
    hoursAfterRequest: number;
    title: string;
    tone: TaskTone;
    trigger: string;
  }> = [
    {
      ruleKey: "trial.parent-no-reply-follow-up",
      hoursAfterRequest: FIXED_REMINDER_RULES.parentNoReplyFollowUpHoursAfterRequest,
      title: "家长未回复：再次跟进",
      tone: "amber",
      trigger: "试听需求进入 4 小时后仍未回复，提醒教务再次跟进",
    },
    {
      ruleKey: "trial.teaching-control-escalation",
      hoursAfterRequest: FIXED_REMINDER_RULES.teachingControlEscalationHoursAfterRequest,
      title: "家长未回复：向负责人汇报",
      tone: "red",
      trigger: "试听需求进入 8 小时后仍未回复，向负责人汇报",
    },
    ...Array.from({ length: syncCount }, (_, index) => {
      const cycle = index + 1;
      const hoursAfterRequest = FIXED_REMINDER_RULES.parentProgressSyncHoursAfterRequest
        + index * FIXED_REMINDER_RULES.parentProgressSyncIntervalHours;
      return {
        ruleKey: `trial.parent-progress-sync.${cycle}` as const,
        hoursAfterRequest,
        title: `向家长同步试听安排进度（第 ${cycle} 次）`,
        tone: "red" as const,
        trigger: cycle === 1
          ? "试听需求进入 24 小时后向家长同步进度"
          : `首次同步后每 24 小时继续向家长同步进度（第 ${cycle} 次）`,
      };
    }),
  ];
  const idFactory = input.idFactory ?? deterministicTaskId;

  return definitions.map((definition) => {
    const dueAt = new Date(requestedAt.getTime() + definition.hoursAfterRequest * TASK_SPACING_MS);
    return {
      // Parent-progress IDs must not depend on a browser-generated random id;
      // two clients reconciling the same LP/cycle need the same identity.
      id: definition.ruleKey.startsWith("trial.parent-progress-sync.")
        ? deterministicTaskId(input.anchorBookingId, definition.ruleKey)
        : idFactory(definition.ruleKey, input.anchorBookingId),
      title: definition.title,
      owner: input.owner,
      ...automaticTaskRecipients(input.owner),
      studentId: input.studentId,
      due: formatDue(dueAt, timeZone),
      dueAt: dueAt.toISOString(),
      status: statusForDueAt(dueAt, now, timeZone),
      tone: definition.tone,
      category: "试听",
      trigger: definition.trigger,
      ruleKey: definition.ruleKey,
      anchorBookingId: input.anchorBookingId,
    };
  });
}

/**
 * Keep an already-due request deadline as history. A future request deadline
 * that no longer fits before the lesson becomes due at the real reconciliation
 * instant. Multiple immediate tasks may share that timestamp; uniqueness is
 * carried by their rule keys, never by fabricated millisecond offsets.
 */
function requestDeadlinesForBooking(
  idealTimes: readonly Date[],
  now: Date,
  trialStartsAt: Date,
) {
  const nowTime = now.getTime();
  const trialTime = trialStartsAt.getTime();
  if (trialTime <= nowTime) throw new RangeError("trialStartsAt must be after now");

  return idealTimes.map((ideal) => {
    const idealTime = ideal.getTime();
    if (idealTime <= nowTime || idealTime < trialTime) return new Date(ideal);
    return new Date(now);
  });
}

/**
 * Create the two request-stage tasks before a lesson has been booked. Ideal
 * deadlines are retained unless already stale, in which case the newly-created
 * tasks are due at the exact creation instant.
 */
export function generateTrialRequestTasks(input: TrialRequestTaskInput): RuleBoundTask[] {
  const timeZone = input.timeZone ?? MELBOURNE_TIME_ZONE;
  const requestedAt = asDate(input.requestedAt, "requestedAt");
  const now = asDate(input.now, "now");
  const sameDayHour = input.sameDayHour ?? 18;
  if (!Number.isInteger(sameDayHour) || sameDayHour < 0 || sameDayHour > 23) {
    throw new RangeError("sameDayHour must be an integer from 0 to 23");
  }
  if (!input.anchorBookingId.trim()) throw new TypeError("anchorBookingId is required");
  if (!input.studentId.trim()) throw new TypeError("studentId is required");
  if (!input.owner.trim()) throw new TypeError("owner is required");

  const idealTimes = [
    atLocalHour(requestedAt, FIXED_REMINDER_RULES.parentSpecifiedContentDaysAfterRequest, sameDayHour, timeZone),
    new Date(requestedAt.getTime() + FIXED_REMINDER_RULES.schedulingFeedbackHoursAfterRequest * TASK_SPACING_MS),
  ];
  const scheduledTimes = idealTimes.map((ideal) =>
    new Date(Math.max(ideal.getTime(), now.getTime())),
  );
  const idFactory = input.idFactory ?? ((ruleKey, anchorBookingId) => `TSK:${anchorBookingId}:${ruleKey}`);

  return TRIAL_REQUEST_TASK_RULES.map((ruleKey, index) => {
    const dueAt = scheduledTimes[index];
    return {
      id: idFactory(ruleKey, input.anchorBookingId),
      ...trialRuleDetails[ruleKey],
      owner: input.owner,
      ...automaticTaskRecipients(input.owner),
      studentId: input.studentId,
      due: formatDue(dueAt, timeZone),
      dueAt: dueAt.toISOString(),
      status: statusForDueAt(dueAt, now, timeZone),
      ruleKey,
      anchorBookingId: input.anchorBookingId,
    };
  });
}

const FEE_REQUIRED_TRIAL_PAYMENT_METHODS = new Set([
  "后置付费试听",
  "付费试听（已付费）",
  "付费试听（未付费）",
  "在读学生付费试听",
]);

/**
 * Generate the server-parity payment reminders for one scheduled trial. The
 * LP value is the only payment authority: an unknown or missing value emits no
 * reminder, while only the explicit 已付费 value is considered paid.
 */
export function generateTrialPaymentTasks(input: TrialPaymentTaskInput): RuleBoundTask[] {
  const timeZone = input.timeZone ?? MELBOURNE_TIME_ZONE;
  const now = asDate(input.now, "now");
  const trialStartsAt = asDate(input.trialStartsAt, "trialStartsAt");
  if (!input.anchorBookingId.trim()) throw new TypeError("anchorBookingId is required");
  if (!input.studentId.trim()) throw new TypeError("studentId is required");
  if (!input.planner.trim()) throw new TypeError("planner is required");
  if (typeof input.trialPaymentMethod !== "string"
      || !FEE_REQUIRED_TRIAL_PAYMENT_METHODS.has(input.trialPaymentMethod)) return [];

  const paid = input.trialPaymentMethod === "付费试听（已付费）";
  const n2DueAt = atLocalHour(trialStartsAt, -2, 18, timeZone);
  const leadTime = trialStartsAt.getTime() - now.getTime();
  const rules: TrialPaymentTaskRuleKey[] = [];
  if (leadTime > 0 && leadTime < 72 * TASK_SPACING_MS) {
    rules.push("trial.payment-n2");
  }
  if (!paid && trialStartsAt.getTime() > now.getTime()
      && leadTime < 24 * TASK_SPACING_MS) {
    rules.push("trial.payment-urgent");
  }
  const idFactory = input.idFactory ?? deterministicTaskId;
  return rules.map((ruleKey) => {
    const dueAt = ruleKey === "trial.payment-n2" ? n2DueAt : new Date(trialStartsAt.getTime() - 24 * TASK_SPACING_MS);
    const done = paid;
    return {
      id: idFactory(ruleKey, input.anchorBookingId),
      title: ruleKey === "trial.payment-n2" ? "确认试听收费" : "试听不足 24 小时仍未付款",
      owner: input.planner,
      assignees: [input.planner],
      watchers: [DEFAULT_TEACHING_CONTROL_WATCHER],
      studentId: input.studentId,
      due: formatDue(dueAt, timeZone),
      dueAt: dueAt.toISOString(),
      status: done ? "done" : statusForDueAt(dueAt, now, timeZone),
      tone: done ? "green" : ruleKey === "trial.payment-urgent" ? "red" : "amber",
      category: "试听",
      trigger: ruleKey === "trial.payment-n2"
        ? "试听前 N-2 确认收费状态"
        : "试听距开课不足 24 小时且仍未付款",
      ...(done ? { result: "试听已付费，收费提醒自动关闭" } : {}),
      ruleKey,
      anchorBookingId: input.anchorBookingId,
    };
  });
}

export function generateTrialBookingTasks(input: TrialBookingTaskInput): RuleBoundTask[] {
  const timeZone = input.timeZone ?? MELBOURNE_TIME_ZONE;
  const requestedAt = asDate(input.requestedAt, "requestedAt");
  const trialStartsAt = asDate(input.trialStartsAt, "trialStartsAt");
  const now = asDate(input.now, "now");
  const sameDayHour = input.sameDayHour ?? 18;
  if (!Number.isInteger(sameDayHour) || sameDayHour < 0 || sameDayHour > 23) {
    throw new RangeError("sameDayHour must be an integer from 0 to 23");
  }
  if (!input.anchorBookingId.trim()) throw new TypeError("anchorBookingId is required");
  if (!input.studentId.trim()) throw new TypeError("studentId is required");
  if (!input.owner.trim()) throw new TypeError("owner is required");

  const trialLeadTime = trialStartsAt.getTime() - now.getTime();
  if (trialLeadTime <= 0) throw new RangeError("trialStartsAt must be after now");
  const shortNotice = trialLeadTime < TRIAL_SHORT_NOTICE_THRESHOLD_HOURS * TASK_SPACING_MS;
  const requestIdealTimes = [
    atLocalHour(requestedAt, FIXED_REMINDER_RULES.parentSpecifiedContentDaysAfterRequest, sameDayHour, timeZone),
    new Date(requestedAt.getTime() + FIXED_REMINDER_RULES.schedulingFeedbackHoursAfterRequest * TASK_SPACING_MS),
  ];
  const requestTimes = requestDeadlinesForBooking(
    requestIdealTimes,
    now,
    trialStartsAt,
  );
  const activeRules: readonly TrialTaskRuleKey[] = shortNotice
    ? TRIAL_SHORT_NOTICE_TASK_RULES
    : TRIAL_STANDARD_TASK_RULES;
  const scheduledTimes = shortNotice
    ? [...requestTimes, new Date(now), new Date(now)]
    : [
        ...requestTimes,
        atLocalHour(trialStartsAt, -FIXED_REMINDER_RULES.lpReviewDaysBeforeTrial, 18, timeZone),
        atLocalHour(trialStartsAt, -FIXED_REMINDER_RULES.preparationDaysBeforeTrial, 18, timeZone),
        atLocalHour(trialStartsAt, -FIXED_REMINDER_RULES.minimumDaysBeforeTrial, 18, timeZone),
      ];
  const idFactory = input.idFactory ?? ((ruleKey, anchorBookingId) => `TSK:${anchorBookingId}:${ruleKey}`);

  return activeRules.map((ruleKey, index) => {
    const dueAt = scheduledTimes[index];
    return {
      id: idFactory(ruleKey, input.anchorBookingId),
      ...(shortNotice ? shortNoticeRuleDetails[ruleKey] ?? trialRuleDetails[ruleKey] : trialRuleDetails[ruleKey]),
      owner: input.owner,
      ...automaticTaskRecipients(input.owner),
      studentId: input.studentId,
      due: formatDue(dueAt, timeZone),
      dueAt: dueAt.toISOString(),
      status: statusForDueAt(dueAt, now, timeZone),
      ruleKey,
      anchorBookingId: input.anchorBookingId,
    };
  });
}

/** Generate/recalculate trial tasks and preserve ids for the same booking rules. */
function isAutomaticallyClosedTrialRule(task: OpsTask) {
  return task.status === "done" && task.result === TRIAL_RULE_NO_LONGER_APPLICABLE_RESULT;
}

function reconcileGeneratedTrialTasks<T extends OpsTask>(
  tasks: readonly T[],
  incoming: readonly RuleBoundTask[],
  input: Pick<TrialBookingTaskInput, "anchorBookingId" | "studentId" | "now">,
) {
  const activeRules = new Set(incoming.map((task) => task.ruleKey));
  const managedRules = new Set<string>(TRIAL_MANAGED_TASK_RULES);
  const closedAt = asDate(input.now, "now").toISOString();
  const prepared: OpsTask[] = [];

  for (const task of tasks) {
    const managedForBooking = task.studentId === input.studentId
      && task.anchorBookingId === input.anchorBookingId
      && Boolean(task.ruleKey && managedRules.has(task.ruleKey));
    if (!managedForBooking) {
      prepared.push({ ...task });
      continue;
    }

    const active = activeRules.has(task.ruleKey!);
    // An automatic rule-switch closure is made reopenable with the same id
    // when that rule applies again. A task completed by a person remains done.
    if (active && isAutomaticallyClosedTrialRule(task)) {
      prepared.push({ ...task, status: "waiting", result: undefined, closedAt: undefined });
      continue;
    }

    const next = !active && task.status !== "done"
      ? {
          ...task,
          status: "done" as const,
          tone: "green" as const,
          result: TRIAL_RULE_NO_LONGER_APPLICABLE_RESULT,
          closedAt,
        }
      : { ...task };
    const identity = taskRuleIdentity(next);
    const duplicateIndex = prepared.findIndex((candidate) => taskRuleIdentity(candidate) === identity);
    if (duplicateIndex < 0) {
      prepared.push(next);
      continue;
    }

    const existing = prepared[duplicateIndex];
    const existingManuallyCompleted = existing.status === "done" && !isAutomaticallyClosedTrialRule(existing);
    const nextManuallyCompleted = next.status === "done" && !isAutomaticallyClosedTrialRule(next);
    if (nextManuallyCompleted && !existingManuallyCompleted) prepared[duplicateIndex] = next;
  }

  return sortTasksByDueAt(upsertTasksByRule<OpsTask>(prepared, incoming));
}

export function reconcileTrialBookingTasks<T extends OpsTask>(
  tasks: readonly T[],
  input: TrialBookingTaskInput,
): OpsTask[] {
  return reconcileGeneratedTrialTasks(tasks, generateTrialBookingTasks(input), input);
}

/**
 * Move the two request-stage tasks from a temporary workflow anchor to the real
 * booking, then reconcile the applicable booking rules. Request task ids (and
 * any completion state) win over duplicate booking-stage copies.
 */
export function linkTrialRequestTasksToBooking<T extends OpsTask>(
  tasks: readonly T[],
  input: LinkTrialRequestTasksInput,
): OpsTask[] {
  if (!input.requestAnchorBookingId.trim()) throw new TypeError("requestAnchorBookingId is required");

  const fullTasks = generateTrialBookingTasks(input);
  const requestRuleSet = new Set<string>(TRIAL_REQUEST_TASK_RULES);
  const overrides = new Map<TrialRequestTaskRuleKey, RuleBoundTask>();
  const linkedAt = asDate(input.now, "now").toISOString();
  let base: OpsTask[] = closeTrialEscalationTasks(tasks, {
    anchorBookingId: input.requestAnchorBookingId,
    studentId: input.studentId,
    closedAt: linkedAt,
    result: TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT,
  });
  const nowTime = asDate(input.now, "now").getTime();
  let previousOpenDueTime = nowTime;

  for (const [ruleIndex, ruleKey] of TRIAL_REQUEST_TASK_RULES.entries()) {
    const generated = fullTasks[ruleIndex];
    const requestMatches = tasks.filter(
      (task) =>
        task.studentId === input.studentId &&
        task.anchorBookingId === input.requestAnchorBookingId &&
        task.ruleKey === ruleKey,
    );
    if (!requestMatches.length) {
      previousOpenDueTime = Date.parse(generated.dueAt);
      continue;
    }

    const canonicalRequest = requestMatches.find((task) => task.status === "done") ?? requestMatches[0];
    const bookingMatches = tasks.filter(
      (task) =>
        task.studentId === input.studentId &&
        task.anchorBookingId === input.anchorBookingId &&
        task.ruleKey === ruleKey,
    );
    const completed = [...requestMatches, ...bookingMatches].find((task) => task.status === "done");
    const canonicalDueTime = canonicalRequest.dueAt ? Date.parse(canonicalRequest.dueAt) : Number.NaN;
    const generatedDueTime = Date.parse(generated.dueAt);
    const hasCanonicalDueTime = Number.isFinite(canonicalDueTime);
    const isActuallyOverdue = hasCanonicalDueTime && canonicalDueTime <= nowTime;
    const futureDueFitsBookingSchedule = hasCanonicalDueTime
      && canonicalDueTime > previousOpenDueTime
      && canonicalDueTime <= generatedDueTime;
    // Completion state is preserved independently below. A completed task with
    // a still-future deadline after the lesson must still have that deadline
    // clamped; only genuine overdue history keeps an out-of-window timestamp.
    const preserveRequestTiming = isActuallyOverdue || futureDueFitsBookingSchedule;
    const timingSource = preserveRequestTiming && hasCanonicalDueTime ? canonicalRequest : generated;
    overrides.set(ruleKey, {
      ...generated,
      id: canonicalRequest.id,
      due: timingSource.due,
      dueAt: timingSource.dueAt ?? generated.dueAt,
      status: timingSource.status,
      tone: timingSource.tone,
      ...(completed
        ? {
            status: "done",
            tone: completed.tone,
            result: completed.result,
            closedAt: completed.closedAt,
          }
        : {}),
    });
    if (!completed && !isActuallyOverdue) {
      previousOpenDueTime = preserveRequestTiming ? canonicalDueTime : generatedDueTime;
    }

    // Remove every temporary/request duplicate and any already-created real
    // copy for this student. The canonical request id is inserted below.
    base = base.filter(
      (task) =>
        !(
          task.studentId === input.studentId &&
          task.ruleKey === ruleKey &&
          (task.anchorBookingId === input.requestAnchorBookingId || task.anchorBookingId === input.anchorBookingId)
        ),
    );
  }

  const incoming = fullTasks.map((task) => {
    if (!requestRuleSet.has(task.ruleKey)) return task;
    return overrides.get(task.ruleKey as TrialRequestTaskRuleKey) ?? task;
  });
  return reconcileGeneratedTrialTasks(base, incoming, input);
}

/** Restore request-stage tasks to their workflow anchor when a booking link is undone. */
export function restoreTrialRequestTasksToWorkflow<T extends OpsTask>(
  tasks: readonly T[],
  input: { bookingAnchorBookingId: string; requestAnchorBookingId: string; studentId: string },
): OpsTask[] {
  const requestRuleSet = new Set<string>(TRIAL_REQUEST_TASK_RULES);
  const restored = tasks.map((task) =>
    task.studentId === input.studentId
      && task.anchorBookingId === input.bookingAnchorBookingId
      && task.ruleKey
      && requestRuleSet.has(task.ruleKey)
      ? { ...task, anchorBookingId: input.requestAnchorBookingId }
      : { ...task },
  );
  return sortTasksByDueAt(restored);
}

export function closeTasksForBooking<T extends OpsTask>(
  tasks: readonly T[],
  anchorBookingId: string,
  closedAt: Date | string,
  result = "关联试听已取消",
): T[] {
  const closed = asDate(closedAt, "closedAt").toISOString();
  return tasks.map((task) => {
    if (task.anchorBookingId !== anchorBookingId || task.status === "done") return { ...task };
    return { ...task, status: "done", tone: "green", result, closedAt: closed };
  });
}

// LP parent-progress reconciliation lives in a server-usable service module,
// but is re-exported here so existing task workflow callers can adopt it
// without importing a second task API surface.
export {
  LP_PARENT_PROGRESS_AUTO_ADVANCED_RESULT,
  LP_PARENT_PROGRESS_CLOSED_RESULT,
  LP_PARENT_PROGRESS_INTERVAL_MS,
  LP_PARENT_PROGRESS_SYNC_RULE,
  isCredibleLpActualBooking,
  reconcileAllLpParentProgressTasks,
  reconcileLpParentProgressTask,
  reconcileLpParentProgressTasks,
} from "./lp-parent-progress-service";

/**
 * Workflow types that can satisfy the first student handover task.  Teacher
 * maintenance, substitution, and change-of-teacher workflows are deliberately
 * excluded: they are follow-up workflows and must not close onboarding work
 * before an actual first handover/trial has been recorded.
 */
export const INITIAL_HANDOVER_WORKFLOW_TYPES = [
  "试听 LP",
  "学生直报（无试听）",
  "学生报名交接",
] as const;

export type InitialHandoverWorkflowType = (typeof INITIAL_HANDOVER_WORKFLOW_TYPES)[number];

export interface CloseStudentLpLifecycleTasksInput {
  studentId: string;
  workflowType: string;
  /** Must be true only when this is the student's first persisted LP workflow. */
  isFirstWorkflow: boolean;
  closedAt: Date | string;
  result?: string;
}

/**
 * Close the onboarding tasks satisfied by a successfully persisted LP.
 *
 * Matching intentionally uses only studentId + ruleKey.  This handles legacy
 * anchors and duplicate open copies safely, while preserving completed history,
 * other students, and every unrelated rule.  The caller supplies the audited
 * `isFirstWorkflow` flag so a later LP cannot prematurely close initial
 * handover work.
 */
export function closeStudentLpLifecycleTasks<T extends OpsTask>(
  tasks: readonly T[],
  input: CloseStudentLpLifecycleTasksInput,
): T[] {
  if (!input.studentId.trim()) throw new TypeError("studentId is required");
  if (!input.workflowType.trim()) throw new TypeError("workflowType is required");
  const closedAt = asDate(input.closedAt, "closedAt").toISOString();
  const closesInitialHandover = input.isFirstWorkflow
    && (INITIAL_HANDOVER_WORKFLOW_TYPES as readonly string[]).includes(input.workflowType);
  const result = input.result?.trim() || "LP 工作流已创建，任务自动关闭";

  return tasks.map((task) => {
    const closesCreateLp = task.ruleKey === "student.create-lp";
    const closesInitial = closesInitialHandover && task.ruleKey === "student.initial-handover";
    if (
      task.studentId !== input.studentId
      || task.status === "done"
      || (!closesCreateLp && !closesInitial)
    ) return { ...task };
    return {
      ...task,
      status: "done",
      tone: "green",
      result,
      closedAt,
    };
  });
}
