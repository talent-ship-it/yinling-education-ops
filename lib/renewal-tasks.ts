import {
  DEFAULT_TEACHING_CONTROL_WATCHER,
  MELBOURNE_TIME_ZONE,
  type OpsTask,
  type RuleBoundTask,
  sortTasksByDueAt,
  statusForDueAt,
  taskRuleIdentity,
  upsertTaskByRule,
} from "./ops-tasks";

export const RENEWAL_TASK_RULE_KEY = "renewal.package-depletion" as const;
export const RENEWAL_COMPLETED_RESULT = "课包已续课，续课任务自动关闭";
export const RENEWAL_INACTIVE_RESULT = "课包已失效，续课任务自动关闭";
export const RENEWAL_NOT_DUE_RESULT = "课包已不再进入续课提醒，任务自动关闭";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type RenewalProjectionStatus =
  | "active"
  | "renewed"
  | "inactive"
  | "not_renewed_active"
  | "not_renewed_inactive"
  | "not_renewed_exam_finished"
  | "已续课"
  | "未续课-活跃"
  | "未续课-不活跃"
  | "未续课-不活跃（已考完）";

export interface RenewalPackageProjection {
  studentId: string;
  packageId: string;
  packageName?: string;
  /** Human-readable evidence explaining which lesson consumes the shared package. */
  renewalDateNote?: string;
  owner: string;
  /** Projected instant at which this package is exhausted. */
  depletionAt: Date | string;
  status?: RenewalProjectionStatus;
}

export interface RenewalTaskOptions {
  now: Date | string;
  /** Defaults to zero because no earlier lead time is currently approved. */
  leadDaysBeforeDepletion?: number;
  timeZone?: string;
  idFactory?: (ruleKey: typeof RENEWAL_TASK_RULE_KEY, anchorBookingId: string) => string;
  /** Students whose complete package projection set is present in this call. */
  scopeStudentIds?: readonly string[];
}

export interface RenewalRuleTask extends RuleBoundTask {
  ruleKey: typeof RENEWAL_TASK_RULE_KEY;
}

type ProjectionState = "active" | "renewed" | "inactive";

function asDate(value: Date | string, field: string) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be a valid date or ISO timestamp`);
  return date;
}

function requireIdentifier(value: string, field: string) {
  if (!value.trim()) throw new TypeError(`${field} is required`);
}

function projectionState(status: RenewalProjectionStatus | undefined): ProjectionState {
  if (status === undefined || status === "active" || status === "not_renewed_active" || status === "未续课-活跃") {
    return "active";
  }
  if (status === "renewed" || status === "已续课") return "renewed";
  if (
    status === "inactive"
    || status === "not_renewed_inactive"
    || status === "not_renewed_exam_finished"
    || status === "未续课-不活跃"
    || status === "未续课-不活跃（已考完）"
  ) return "inactive";
  throw new TypeError("status must be an active, renewed, or inactive renewal status");
}

/**
 * Student activity is authoritative for automatic task lifecycle. A renewed
 * package remains terminal; every other package closes while the student is
 * inactive and becomes eligible for the same stable task again on reactivation.
 */
export function renewalProjectionStateForStudent(
  status: RenewalProjectionStatus | undefined,
  studentActive: boolean,
): ProjectionState {
  if (typeof studentActive !== "boolean") throw new TypeError("studentActive must be boolean");
  return projectionState(status) === "renewed"
    ? "renewed"
    : studentActive
      ? "active"
      : "inactive";
}

export type RenewalStatusRecord = Readonly<{
  studentId: string;
  packageId?: string;
  /** Legacy subject-level rows are display/history evidence, never package state. */
  subjectId?: string;
  status?: RenewalProjectionStatus;
}>;

/**
 * Resolve business state for one package. A legacy student-only record is safe
 * only while that student has exactly one package; otherwise it must not be
 * allowed to close every package task.
 */
export function renewalStatusForPackage(
  records: readonly RenewalStatusRecord[],
  input: Readonly<{ studentId: string; packageId: string; packageCount: number }>,
) {
  requireIdentifier(input.studentId, "studentId");
  requireIdentifier(input.packageId, "packageId");
  if (!Number.isSafeInteger(input.packageCount) || input.packageCount < 1) {
    throw new RangeError("packageCount must be a positive integer");
  }
  const exact = records.find((record) => record.studentId === input.studentId
    && record.packageId === input.packageId
    && !record.subjectId);
  if (exact) {
    projectionState(exact.status);
    return exact.status;
  }
  if (input.packageCount !== 1) return undefined;
  const legacy = records.find((record) => record.studentId === input.studentId
    && !record.packageId
    && !record.subjectId);
  if (legacy) projectionState(legacy.status);
  return legacy?.status;
}

/** Stable task anchor for one student's package. Shared-package subjects never fork the task. */
export function renewalTaskAnchor(studentId: string, packageId: string) {
  requireIdentifier(studentId, "studentId");
  requireIdentifier(packageId, "packageId");
  return `renewal:${encodeURIComponent(studentId.trim())}:${encodeURIComponent(packageId.trim())}`;
}

export type RenewalDateNoteInput = Readonly<{
  depletionSubjectId?: string | null;
  remainingHours?: number;
  depletionLessonHours?: number;
  nextScheduledLesson?: Readonly<{ subjectId: string; date: string; start: string; hours: number }> | null;
  nextLessonAfterDepletion?: Readonly<{ subjectId: string; date: string; start: string; withinSevenDays: boolean }> | null;
}>;

function compactHours(value: number) {
  return Number(value.toFixed(6)).toString();
}

/** Builds the approved automatic note without inventing subject-level package balances. */
export function buildRenewalDateNote(input: RenewalDateNoteInput) {
  const notes: string[] = [];
  const depletionSubject = input.depletionSubjectId?.trim();
  if (depletionSubject) notes.push(`预计由 ${depletionSubject} 课耗尽`);
  const remaining = input.remainingHours;
  const depletionHours = input.depletionLessonHours;
  if (Number.isFinite(remaining) && Number.isFinite(depletionHours)
    && remaining! >= 0 && depletionHours! > 0 && remaining! < depletionHours!) {
    notes.push(`当前余额 ${compactHours(remaining!)} 小时，不足耗尽课次 ${compactHours(depletionHours!)} 小时`);
  } else if (input.nextScheduledLesson
    && Number.isFinite(remaining)
    && Number.isFinite(input.nextScheduledLesson.hours)
    && remaining! >= 0
    && input.nextScheduledLesson.hours > 0
    && remaining! < input.nextScheduledLesson.hours) {
    notes.push(`当前余额 ${compactHours(remaining!)} 小时，不足下一节 ${input.nextScheduledLesson.subjectId} 课 ${compactHours(input.nextScheduledLesson.hours)} 小时`);
  }
  const next = input.nextLessonAfterDepletion;
  if (next?.withinSevenDays) {
    notes.push(`耗尽后下一节 ${next.subjectId} 课：${next.date} ${next.start}（不足 7 天）`);
  }
  return notes.join("；");
}

/**
 * Calculate the approved deadline. Without a configured lead time the package
 * exhaustion instant itself is used; a stale deadline becomes immediately due.
 */
export function calculateRenewalTaskDueAt(
  depletionAt: Date | string,
  now: Date | string,
  leadDaysBeforeDepletion = 0,
) {
  if (!Number.isSafeInteger(leadDaysBeforeDepletion) || leadDaysBeforeDepletion < 0) {
    throw new RangeError("leadDaysBeforeDepletion must be a non-negative integer");
  }
  const depletion = asDate(depletionAt, "depletionAt");
  const current = asDate(now, "now");
  const idealTime = depletion.getTime() - leadDaysBeforeDepletion * DAY_MS;
  return new Date(Math.max(idealTime, current.getTime() + 1));
}

function formatDue(instant: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function validateProjection(projection: RenewalPackageProjection) {
  requireIdentifier(projection.studentId, "studentId");
  requireIdentifier(projection.packageId, "packageId");
  requireIdentifier(projection.owner, "owner");
  if (projection.renewalDateNote !== undefined && !projection.renewalDateNote.trim()) {
    throw new TypeError("renewalDateNote must not be empty");
  }
  asDate(projection.depletionAt, "depletionAt");
  return projectionState(projection.status);
}

/** Generates an active renewal task; terminal projections intentionally create no historical task. */
export function generateRenewalTask(
  projection: RenewalPackageProjection,
  options: RenewalTaskOptions,
): RenewalRuleTask | null {
  if (validateProjection(projection) !== "active") return null;
  const now = asDate(options.now, "now");
  const timeZone = options.timeZone ?? MELBOURNE_TIME_ZONE;
  const dueAt = calculateRenewalTaskDueAt(
    projection.depletionAt,
    now,
    options.leadDaysBeforeDepletion,
  );
  const anchorBookingId = renewalTaskAnchor(projection.studentId, projection.packageId);
  const idFactory = options.idFactory
    ?? ((ruleKey: typeof RENEWAL_TASK_RULE_KEY, anchor: string) => `TSK:${anchor}:${ruleKey}`);
  const packageLabel = projection.packageName?.trim() || projection.packageId.trim();

  return {
    id: idFactory(RENEWAL_TASK_RULE_KEY, anchorBookingId),
    title: `课包续课跟进 · ${packageLabel}`,
    owner: projection.owner,
    assignees: [projection.owner],
    watchers: [DEFAULT_TEACHING_CONTROL_WATCHER],
    studentId: projection.studentId,
    due: formatDue(dueAt, timeZone),
    dueAt: dueAt.toISOString(),
    status: statusForDueAt(dueAt, now, timeZone),
    tone: "amber",
    category: "续课",
    trigger: projection.renewalDateNote?.trim() || "课包预计耗尽",
    ruleKey: RENEWAL_TASK_RULE_KEY,
    anchorBookingId,
  };
}

function isAutomaticRenewalClosure(task: OpsTask) {
  return task.status === "done"
    && (
      task.result === RENEWAL_COMPLETED_RESULT
      || task.result === RENEWAL_INACTIVE_RESULT
      || task.result === RENEWAL_NOT_DUE_RESULT
    );
}

function closeMissingRenewalTasks(
  tasks: readonly OpsTask[],
  seenAnchors: ReadonlySet<string>,
  scopeStudentIds: readonly string[] | undefined,
  now: Date,
) {
  if (!scopeStudentIds) return tasks.map((task) => ({ ...task }));
  const scope = new Set(scopeStudentIds.map((studentId) => {
    requireIdentifier(studentId, "scopeStudentId");
    return studentId;
  }));
  return tasks.map((task) => {
    if (
      task.ruleKey !== RENEWAL_TASK_RULE_KEY
      || !task.anchorBookingId
      || !scope.has(task.studentId)
      || seenAnchors.has(task.anchorBookingId)
      || task.status === "done"
    ) return { ...task };
    return {
      ...task,
      status: "done" as const,
      tone: "green" as const,
      result: RENEWAL_NOT_DUE_RESULT,
      closedAt: now.toISOString(),
    };
  });
}

function closeRenewalTask(
  tasks: readonly OpsTask[],
  projection: RenewalPackageProjection,
  state: Exclude<ProjectionState, "active">,
  now: Date,
) {
  const identity = `${RENEWAL_TASK_RULE_KEY}\u0000${renewalTaskAnchor(projection.studentId, projection.packageId)}`;
  const matching = tasks.filter((task) => taskRuleIdentity(task) === identity);
  if (!matching.length) return [...tasks];
  const existing = matching.find((task) => task.status === "done" && !isAutomaticRenewalClosure(task))
    ?? matching.find((task) => task.status === "done")
    ?? matching[0];
  if (existing.status === "done" && !isAutomaticRenewalClosure(existing)) {
    return upsertTaskByRule(tasks, {
      ...existing,
      owner: projection.owner,
      assignees: [projection.owner],
      watchers: [DEFAULT_TEACHING_CONTROL_WATCHER],
    });
  }
  const incoming: OpsTask = {
    ...existing,
    owner: projection.owner,
    assignees: [projection.owner],
    watchers: [DEFAULT_TEACHING_CONTROL_WATCHER],
    status: "done",
    tone: "green",
    result: state === "renewed" ? RENEWAL_COMPLETED_RESULT : RENEWAL_INACTIVE_RESULT,
    closedAt: now.toISOString(),
  };
  return upsertTaskByRule(tasks, incoming);
}

/**
 * Reconcile one stable task per student/package. When `scopeStudentIds` is
 * supplied, projections are the complete set for that scope and a missing
 * package closes only its unfinished automatic task.
 */
export function reconcileRenewalTasks<T extends OpsTask>(
  tasks: readonly T[],
  projections: readonly RenewalPackageProjection[],
  options: RenewalTaskOptions,
): OpsTask[] {
  const now = asDate(options.now, "now");
  const seenAnchors = new Set<string>();
  for (const projection of projections) {
    validateProjection(projection);
    const anchor = renewalTaskAnchor(projection.studentId, projection.packageId);
    if (seenAnchors.has(anchor)) throw new TypeError(`duplicate renewal projection for ${anchor}`);
    seenAnchors.add(anchor);
  }

  const initial = closeMissingRenewalTasks(tasks, seenAnchors, options.scopeStudentIds, now);
  const reconciled = projections.reduce<OpsTask[]>((current, projection) => {
    const state = projectionState(projection.status);
    if (state !== "active") return closeRenewalTask(current, projection, state, now);

    const incoming = generateRenewalTask(projection, options)!;
    const identity = taskRuleIdentity(incoming);
    const prepared = current.map((task) => taskRuleIdentity(task) === identity && isAutomaticRenewalClosure(task)
      ? { ...task, status: "waiting" as const, result: undefined, closedAt: undefined }
      : { ...task });
    return upsertTaskByRule(prepared, incoming);
  }, initial);

  return sortTasksByDueAt(reconciled);
}
