export const MELBOURNE_TIME_ZONE = "Australia/Melbourne";
export const TASK_SPACING_MS = 60 * 60 * 1_000;

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
  studentId: string;
  due: string;
  status: TaskStatus;
  tone: TaskTone;
  category: TaskCategory;
  trigger: string;
  result?: string;
  ruleKey?: string;
  dueAt?: string;
  anchorBookingId?: string;
  closedAt?: string;
}

export type Task = OpsTask;

export interface RuleBoundTask extends OpsTask {
  ruleKey: string;
  dueAt: string;
  anchorBookingId: string;
}

export const TRIAL_TASK_RULES = [
  "trial.parent-follow-up",
  "trial.scheduling",
  "trial.lp-review",
  "trial.prep",
  "trial.minimum",
] as const;

export type TrialTaskRuleKey = (typeof TRIAL_TASK_RULES)[number];

export const TRIAL_REQUEST_TASK_RULES = [
  "trial.parent-follow-up",
  "trial.scheduling",
] as const satisfies readonly TrialTaskRuleKey[];

export type TrialRequestTaskRuleKey = (typeof TRIAL_REQUEST_TASK_RULES)[number];

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
    trigger: "试听需求进入后 48 小时内完成排课",
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
};

function scheduleWithConstraints(idealTimes: readonly Date[], now: Date, trialStartsAt: Date) {
  const availableMs = trialStartsAt.getTime() - now.getTime();
  if (availableMs <= 0) throw new RangeError("trialStartsAt must be after now");

  // Retain the one-hour workflow spacing when there is room. For a last-minute
  // trial, divide the remaining open interval into N+1 slices so all N tasks
  // remain strictly ordered, after now, and before the lesson.
  const spacingMs = Math.min(TASK_SPACING_MS, Math.floor(availableMs / (idealTimes.length + 1)));
  if (spacingMs < 1) throw new RangeError("trialStartsAt is too close to now to represent unique task deadlines");
  const firstAllowed = now.getTime() + spacingMs;
  const lastAllowed = trialStartsAt.getTime() - spacingMs;

  let previous = firstAllowed - spacingMs;
  return idealTimes.map((ideal, index) => {
    const earliest = Math.max(firstAllowed, previous + spacingMs);
    const remaining = idealTimes.length - index - 1;
    const latest = lastAllowed - remaining * spacingMs;
    const scheduled = Math.min(Math.max(ideal.getTime(), earliest), latest);
    previous = scheduled;
    return new Date(scheduled);
  });
}

/**
 * Create the two request-stage tasks before a lesson has been booked. Ideal
 * deadlines are retained unless already stale, in which case they are moved to
 * the first representable instants after `now`.
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
    atLocalHour(requestedAt, 0, sameDayHour, timeZone),
    new Date(requestedAt.getTime() + 48 * TASK_SPACING_MS),
  ];
  let previous = now.getTime();
  const scheduledTimes = idealTimes.map((ideal) => {
    const scheduled = new Date(Math.max(ideal.getTime(), previous + 1));
    previous = scheduled.getTime();
    return scheduled;
  });
  const idFactory = input.idFactory ?? ((ruleKey, anchorBookingId) => `TSK:${anchorBookingId}:${ruleKey}`);

  return TRIAL_REQUEST_TASK_RULES.map((ruleKey, index) => {
    const dueAt = scheduledTimes[index];
    return {
      id: idFactory(ruleKey, input.anchorBookingId),
      ...trialRuleDetails[ruleKey],
      owner: input.owner,
      studentId: input.studentId,
      due: formatDue(dueAt, timeZone),
      dueAt: dueAt.toISOString(),
      status: statusForDueAt(dueAt, now, timeZone),
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

  const idealTimes = [
    atLocalHour(requestedAt, 0, sameDayHour, timeZone),
    new Date(requestedAt.getTime() + 48 * TASK_SPACING_MS),
    atLocalHour(trialStartsAt, -3, 18, timeZone),
    atLocalHour(trialStartsAt, -2, 18, timeZone),
    atLocalHour(trialStartsAt, -1, 18, timeZone),
  ];
  const scheduledTimes = scheduleWithConstraints(idealTimes, now, trialStartsAt);
  const idFactory = input.idFactory ?? ((ruleKey, anchorBookingId) => `TSK:${anchorBookingId}:${ruleKey}`);

  return TRIAL_TASK_RULES.map((ruleKey, index) => {
    const dueAt = scheduledTimes[index];
    return {
      id: idFactory(ruleKey, input.anchorBookingId),
      ...trialRuleDetails[ruleKey],
      owner: input.owner,
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
export function reconcileTrialBookingTasks<T extends OpsTask>(
  tasks: readonly T[],
  input: TrialBookingTaskInput,
): OpsTask[] {
  return sortTasksByDueAt(upsertTasksByRule<OpsTask>(tasks, generateTrialBookingTasks(input)));
}

/**
 * Move the two request-stage tasks from a temporary workflow anchor to the real
 * booking, then reconcile all five booking rules. Request task ids (and any
 * completion state) win over duplicate booking-stage copies.
 */
export function linkTrialRequestTasksToBooking<T extends OpsTask>(
  tasks: readonly T[],
  input: LinkTrialRequestTasksInput,
): OpsTask[] {
  if (!input.requestAnchorBookingId.trim()) throw new TypeError("requestAnchorBookingId is required");

  const fullTasks = generateTrialBookingTasks(input);
  const requestRuleSet = new Set<string>(TRIAL_REQUEST_TASK_RULES);
  const overrides = new Map<TrialRequestTaskRuleKey, RuleBoundTask>();
  let base: OpsTask[] = [...tasks];
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
    const preserveRequestTiming = Boolean(completed) || isActuallyOverdue || futureDueFitsBookingSchedule;
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
  return sortTasksByDueAt(upsertTasksByRule<OpsTask>(base, incoming));
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
