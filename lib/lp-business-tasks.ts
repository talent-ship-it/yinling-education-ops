import { expandLessonOccurrences, lessonOccurrenceSourceRangeForTargetRange } from "./lesson-occurrences";
import type { LpParentProgressBooking, LpParentProgressRecord } from "./lp-parent-progress-service";
import { DEFAULT_TEACHING_CONTROL_WATCHER, deterministicTaskId, formatTaskDeadline, isFrozenLegacyTask, statusForDueAt, upsertTaskByRule, type OpsTask } from "./ops-tasks";
import { scheduleDateInTimezone, scheduleOccurrenceInstant, shiftScheduleDate } from "./schedule-calendar";

const LP_MODIFICATION_REVIEW_RULE = "lp.modification-review";
const LP_FIRST_LESSON_TASK_RULES = ["lp.scheduling", "lp.first-lesson-finalize-n2", "lp.first-lesson-prep-n1"] as const;
export const LP_BUSINESS_CLOSED_RESULT = "LP 已结束，交接跟进任务自动关闭";
export const LP_BUSINESS_SCHEDULED_RESULT = "首次课已排课，排课跟进自动关闭";
const LP_BUSINESS_FINALIZED_RESULT = "LP 已发老师，定稿提醒自动关闭";
const LP_BUSINESS_PREPARED_RESULT = "备课已完成，备课提醒自动关闭";
const LP_BUSINESS_SCHEDULE_REMOVED_RESULT = "首次课排课已撤销，课前提醒自动关闭";
export const LP_MODIFICATION_REVIEW_ADVANCED_RESULT = "LP 修改复查周期已推进";
const ZONE = "Australia/Melbourne";
const CANCELLED = new Set(["cancelled", "canceled", "已取消", "取消", "leave"]);
const AUTOMATIC_RESULTS = new Set([LP_BUSINESS_CLOSED_RESULT, LP_BUSINESS_SCHEDULED_RESULT, LP_BUSINESS_SCHEDULE_REMOVED_RESULT, LP_BUSINESS_FINALIZED_RESULT, LP_BUSINESS_PREPARED_RESULT, LP_MODIFICATION_REVIEW_ADVANCED_RESULT]);

type Input = Readonly<{
  tasks: readonly OpsTask[];
  lp: LpParentProgressRecord;
  lps?: readonly LpParentProgressRecord[];
  bookings?: readonly LpParentProgressBooking[];
  teachers?: readonly Readonly<{ id: string; name: string }>[];
  now: Date | string;
}>;

function exactInstant(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf()) ? instant : undefined;
}

function requestInstant(lp: LpParentProgressRecord) {
  return exactInstant(lp.fields?.requestSentAt) ?? exactInstant(lp.requestedAt);
}

function ended(lp: LpParentProgressRecord) {
  return lp.closed === true || lp.stage === "完成" || ["已完成", "已取消"].includes(lp.resultStatus ?? "")
    || ["closed", "cancelled", "已关闭", "已取消"].includes(lp.status ?? "");
}

function related(task: OpsTask, lp: LpParentProgressRecord) {
  return task.studentId === lp.studentId && task.anchorBookingId === lp.id;
}

function managed(task: OpsTask) {
  return (LP_FIRST_LESSON_TASK_RULES as readonly string[]).includes(task.ruleKey ?? "")
    || /^lp\.modification-review(?:\.[1-9]\d*)?$/.test(task.ruleKey ?? "");
}

function close(tasks: readonly OpsTask[], lp: LpParentProgressRecord, now: Date, result: string, rules?: readonly string[]) {
  return tasks.map((task) => related(task, lp) && managed(task) && !isFrozenLegacyTask(task) && task.status !== "done"
    && (!rules || rules.includes(task.ruleKey ?? ""))
    ? { ...task, status: "done" as const, tone: "green" as const, result, closedAt: now.toISOString() }
    : task);
}

function deadline(base: Date, offset: number) {
  return scheduleOccurrenceInstant({ date: shiftScheduleDate(scheduleDateInTimezone(base, ZONE), offset), start: "18:00", timezone: ZONE });
}

function task(lp: LpParentProgressRecord, ruleKey: string, title: string, dueAt: Date, now: Date, trigger: string, category: "LP" | "排课" = "LP"): OpsTask {
  return {
    id: deterministicTaskId(lp.id, ruleKey), title, owner: lp.owner, assignees: [lp.owner],
    watchers: [DEFAULT_TEACHING_CONTROL_WATCHER], studentId: lp.studentId,
    due: formatTaskDeadline(dueAt.toISOString(), ZONE) ?? dueAt.toISOString(), dueAt: dueAt.toISOString(),
    status: statusForDueAt(dueAt, now, ZONE), tone: "red", category, trigger, ruleKey, anchorBookingId: lp.id,
  };
}

function upsert(tasks: readonly OpsTask[], incoming: OpsTask) {
  const existing = tasks.find((candidate) => candidate.ruleKey === incoming.ruleKey && candidate.anchorBookingId === incoming.anchorBookingId && candidate.studentId === incoming.studentId);
  if (existing && (isFrozenLegacyTask(existing) || existing.status === "done" && !AUTOMATIC_RESULTS.has(existing.result ?? ""))) return [...tasks];
  const source = incoming.status !== "done" && existing?.status === "done" && AUTOMATIC_RESULTS.has(existing.result ?? "")
    ? tasks.map((candidate) => candidate === existing ? { ...candidate, status: incoming.status, result: undefined, closedAt: undefined, completionOutcome: undefined } : candidate)
    : tasks;
  return upsertTaskByRule(source, existing ? { ...incoming, owner: existing.owner, assignees: existing.assignees ?? [existing.owner], watchers: [...new Set([...(existing.watchers ?? []), DEFAULT_TEACHING_CONTROL_WATCHER])] } : incoming);
}

function normalize(value: unknown) {
  return typeof value === "string" ? value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, "") : "";
}

function matches(lp: LpParentProgressRecord, booking: LpParentProgressBooking, teachers: Input["teachers"]) {
  if (lp.studentId !== booking.studentId || CANCELLED.has(booking.status ?? "") || CANCELLED.has(booking.occurrenceStatus ?? "")
    || !["试听", "常规课", "trial", "regular"].includes(booking.kind ?? "")) return false;
  const anchors = [booking.lpId, booking.anchorBookingId, booking.requestAnchorBookingId].filter(Boolean);
  if (anchors.length) return anchors.every((anchor) => anchor === lp.id);
  const teacher = normalize(lp.fields?.teacher);
  const subject = normalize(lp.fields?.subject);
  const teacherName = teachers?.find((candidate) => candidate.id === booking.teacherId)?.name ?? booking.sourceTeacherName;
  const teacherNames = [booking.teacherId, teacherName].map(normalize);
  return Boolean(teacher && subject && teacherNames.includes(teacher) && normalize(booking.course ?? booking.subject) === subject);
}

function firstLesson(input: Input, anchor: Date) {
  const activeLps = (input.lps ?? [input.lp]).filter((lp) => lp.workflowType === "老师新 LP" && !ended(lp));
  const candidates = (input.bookings ?? []).flatMap((booking) => {
    if (!matches(input.lp, booking, input.teachers)) return [];
    if (activeLps.filter((lp) => matches(lp, booking, input.teachers)).length !== 1) return [];
    if (!booking.date || !booking.start || !booking.timezone) return [];
    try {
      const rangeStart = scheduleDateInTimezone(anchor, booking.timezone);
      const rangeEnd = shiftScheduleDate(rangeStart, 365);
      const overrides = booking.occurrenceOverrides ?? [];
      const range = lessonOccurrenceSourceRangeForTargetRange(rangeStart, rangeEnd, overrides);
      return expandLessonOccurrences({ ...booking, date: booking.date, start: booking.start, duration: booking.duration ?? 1 }, { ...range, overrides })
        .filter((occurrence) => !CANCELLED.has(occurrence.status) && matches(input.lp, {
          ...booking, studentId: occurrence.studentId ?? "", teacherId: occurrence.teacherId, subject: occurrence.subjectId, course: occurrence.subjectId,
          sourceTeacherName: occurrence.teacherId === booking.teacherId ? booking.sourceTeacherName : undefined,
        }, input.teachers))
        .flatMap((occurrence) => {
          const startsAt = scheduleOccurrenceInstant({ ...occurrence, timezone: booking.timezone! });
          return startsAt >= anchor ? [{ startsAt, occurrenceId: occurrence.occurrenceId }] : [];
        });
    } catch { return []; }
  });
  return candidates.sort((left, right) => left.startsAt.valueOf() - right.startsAt.valueOf() || left.occurrenceId.localeCompare(right.occurrenceId))[0];
}

export function reconcileLpBusinessTasks(input: Input): OpsTask[] {
  const now = new Date(input.now);
  if (!Number.isFinite(now.valueOf())) throw new TypeError("now must be a valid timestamp");
  const lp = input.lp;
  if (!["老师新 LP", "老师 LP 修改"].includes(lp.workflowType ?? "")) return [...input.tasks];
  if (ended(lp)) return close(input.tasks, lp, now, LP_BUSINESS_CLOSED_RESULT);
  const anchor = requestInstant(lp);
  if (!anchor || !lp.id.trim() || !lp.studentId.trim() || !lp.owner.trim()) return [...input.tasks];
  if (lp.workflowType === "老师 LP 修改") {
    const elapsedDays = (now.valueOf() - anchor.valueOf()) / 86_400_000;
    const previous = input.tasks.filter((candidate) => related(candidate, lp) && candidate.status === "done" && !AUTOMATIC_RESULTS.has(candidate.result ?? ""))
      .map((candidate) => (candidate.ruleKey === LP_MODIFICATION_REVIEW_RULE ? 1 : Number(candidate.ruleKey?.match(/^lp\.modification-review\.([1-9]\d*)$/)?.[1] ?? 0)));
    const cycle = Math.max(1, Math.floor(elapsedDays / 7), ...previous.map((value) => value + 1));
    const ruleKey = cycle === 1 ? LP_MODIFICATION_REVIEW_RULE : `${LP_MODIFICATION_REVIEW_RULE}.${cycle}`;
    const obsolete = input.tasks.filter((candidate) => (candidate.ruleKey === LP_MODIFICATION_REVIEW_RULE || candidate.ruleKey?.startsWith(`${LP_MODIFICATION_REVIEW_RULE}.`)) && candidate.ruleKey !== ruleKey).map((candidate) => candidate.ruleKey!);
    const closed = close(input.tasks, lp, now, LP_MODIFICATION_REVIEW_ADVANCED_RESULT, obsolete);
    return upsert(closed, task(lp, ruleKey, "LP 修改：检查完成情况及截图", new Date(anchor.valueOf() + cycle * 7 * 86_400_000), now, `LP 修改交接后每周复查（第 ${cycle} 次）`));
  }

  const lesson = firstLesson(input, anchor);
  const scheduling = task(lp, LP_FIRST_LESSON_TASK_RULES[0], "老生新 LP：完成首次排课", new Date(anchor.valueOf() + 48 * 60 * 60 * 1_000), now, "老生新 LP 交接后最迟 N+2 完成首次排课", "排课");
  if (!lesson) return close(upsert(input.tasks, scheduling), lp, now, LP_BUSINESS_SCHEDULE_REMOVED_RESULT, LP_FIRST_LESSON_TASK_RULES.slice(1));
  let tasks = upsert(input.tasks, { ...scheduling, status: "done", tone: "green", result: LP_BUSINESS_SCHEDULED_RESULT, closedAt: now.toISOString() });
  const leadDays = (Date.parse(`${scheduleDateInTimezone(lesson.startsAt, ZONE)}T00:00:00Z`) - Date.parse(`${scheduleDateInTimezone(anchor, ZONE)}T00:00:00Z`)) / 86_400_000;
  const finalizeDue = leadDays <= 2 ? new Date(Math.min(lesson.startsAt.valueOf(), Math.max(anchor.valueOf(), deadline(anchor, 0).valueOf()))) : deadline(lesson.startsAt, -2);
  const prepDue = leadDays <= 1 ? finalizeDue : deadline(lesson.startsAt, -1);
  const finalized = task(lp, LP_FIRST_LESSON_TASK_RULES[1], "老生新 LP：首次课前定稿并发老师", finalizeDue, now, `首次课 N-2 定稿 · ${lesson.occurrenceId}`);
  tasks = upsert(tasks, ["已发老师", "待备课确认", "备课完成"].includes(lp.stage ?? "")
    ? { ...finalized, status: "done", tone: "green", result: LP_BUSINESS_FINALIZED_RESULT, closedAt: now.toISOString() }
    : finalized);
  if (lp.fields?.preparationFollowUp === "是") {
    const preparation = task(lp, LP_FIRST_LESSON_TASK_RULES[2], "老生新 LP：首次课备课内容及截图", prepDue, now, `首次课 N-1 跟进备课 · ${lesson.occurrenceId}`);
    tasks = upsert(tasks, lp.stage === "备课完成"
      ? { ...preparation, status: "done", tone: "green", result: LP_BUSINESS_PREPARED_RESULT, closedAt: now.toISOString() }
      : preparation);
  } else tasks = close(tasks, lp, now, LP_BUSINESS_SCHEDULE_REMOVED_RESULT, [LP_FIRST_LESSON_TASK_RULES[2]]);
  return tasks;
}
