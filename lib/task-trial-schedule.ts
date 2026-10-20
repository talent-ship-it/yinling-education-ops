import { isCanonicalTaskDueAt, type OpsTask } from "./ops-tasks";

export type TaskTrialSchedule = Readonly<{ startsAt: string; endsAt?: string }>;

type TrialLp = Readonly<{
  id: string;
  studentId: string;
  workflowType?: string;
  stage?: string;
  resultStatus?: string;
  trialSchedule?: Readonly<{ source: string; eventId: string; startsAt: string; endsAt: string }>;
}>;

type TrialBooking = Readonly<{
  id: string;
  studentId: string;
  kind: string;
  date: string;
  start: string;
  timezone?: string;
  duration?: number;
  status?: string;
  recurring?: boolean;
  occurrenceOverrides?: readonly unknown[];
}>;

type TaskIdentity = Pick<OpsTask, "studentId" | "ruleKey" | "anchorBookingId" | "requestAnchorBookingId">;
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "已取消", "取消", "leave"]);

function matchingTrialLp(task: TaskIdentity, lpItems: readonly TrialLp[]) {
  const lp = lpItems.find((item) => item.id === task.requestAnchorBookingId);
  if (!lp || lp.studentId !== task.studentId || lp.stage === "完成" || lp.resultStatus === "已取消"
    || !["试听 LP", "换老师试听"].includes(lp.workflowType ?? "")) return null;
  return lp;
}

function matchingJiaowubaoLink(task: TaskIdentity, schedule: TrialLp["trialSchedule"]): schedule is NonNullable<TrialLp["trialSchedule"]> {
  return Boolean(schedule && schedule.source === "jiaowubao-open-api" && schedule.eventId
    && task.anchorBookingId === `JWB:${schedule.eventId}`
    && isCanonicalTaskDueAt(schedule.startsAt) && isCanonicalTaskDueAt(schedule.endsAt)
    && schedule.endsAt > schedule.startsAt);
}

function jiaowubaoSchedule(task: TaskIdentity, lpItems: readonly TrialLp[]): TaskTrialSchedule | null {
  const schedule = matchingTrialLp(task, lpItems)?.trialSchedule;
  return matchingJiaowubaoLink(task, schedule) ? { startsAt: schedule.startsAt, endsAt: schedule.endsAt } : null;
}

function matchesBookingClock(booking: TrialBooking, startsAt: string) {
  if (!booking.timezone?.trim() || !isCanonicalTaskDueAt(startsAt)) return false;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: booking.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(startsAt));
  const local = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}` === `${booking.date}T${booking.start}`;
}

function matchingLocalBooking<T extends TrialBooking>(task: TaskIdentity, bookings: readonly T[]) {
  const booking = bookings.find((item) => item.id === task.anchorBookingId);
  if (!booking || booking.studentId !== task.studentId || booking.kind !== "试听"
    || CANCELLED_STATUSES.has(booking.status ?? "") || booking.recurring || booking.occurrenceOverrides?.length) return null;
  return booking;
}

function localBookingSchedule<T extends TrialBooking>(task: TaskIdentity, bookings: readonly T[], bookingStartsAt: (booking: T) => string): TaskTrialSchedule | null {
  const booking = matchingLocalBooking(task, bookings);
  if (!booking) return null;
  try {
    const startsAt = bookingStartsAt(booking);
    if (!matchesBookingClock(booking, startsAt)) return null;
    const duration = booking.duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return { startsAt };
    return { startsAt, endsAt: new Date(Date.parse(startsAt) + duration * 60_000).toISOString() };
  } catch { return null; }
}

export function resolveTaskTrialSchedule<T extends TrialBooking>(task: TaskIdentity, input: Readonly<{
  lpItems: readonly TrialLp[];
  bookings: readonly T[];
  bookingStartsAt: (booking: T) => string;
}>): TaskTrialSchedule | null {
  if (!task.ruleKey?.startsWith("trial.")) return null;
  return task.ruleKey.startsWith("trial.jiaowubao.")
    ? jiaowubaoSchedule(task, input.lpItems)
    : localBookingSchedule(task, input.bookings, input.bookingStartsAt);
}
