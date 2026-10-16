import type { AvaCalendarLiveData, AvaCalendarLiveWindow } from "@/lib/ava-calendar-live-client";
import { DateTime } from "luxon";

type Interval = { teacherId: string | null; startsAt: string; endsAt: string };
function currentActivity(items: Interval[], range: AvaCalendarLiveWindow | null) {
  if (!range) return [];
  const start = Date.parse(range.start), end = Date.parse(range.end);
  return items.filter((item) => Date.parse(item.startsAt) < end && Date.parse(item.endsAt) > start);
}
function firstActivity(activity: Interval[], range: AvaCalendarLiveWindow | null) {
  const first = new Map<string | null, number>();
  for (const item of activity) first.set(item.teacherId, Math.min(first.get(item.teacherId) ?? Infinity, Math.max(Date.parse(range!.start), Date.parse(item.startsAt))));
  return first;
}
export function calendarTeacherColumns(data: AvaCalendarLiveData | null, range: AvaCalendarLiveWindow | null, activeOnly: boolean, selfId = "") {
  const lessons = firstActivity(currentActivity(data?.events ?? [], range), range);
  const first = new Map([...firstActivity(currentActivity(data?.remainingAVA ?? [], range), range), ...lessons]);
  return (data?.teachers ?? []).filter((teacher) => !activeOnly || first.has(teacher.id) || teacher.id === selfId)
    .toSorted((a, b) => Number(!lessons.has(a.id)) - Number(!lessons.has(b.id)) || (first.get(a.id) ?? Infinity) - (first.get(b.id) ?? Infinity));
}

function activityTime(item: Interval, range: AvaCalendarLiveWindow, zone: string) {
  const start = DateTime.fromMillis(Math.max(Date.parse(item.startsAt), Date.parse(range.start)), { zone });
  const end = DateTime.fromMillis(Math.min(Date.parse(item.endsAt), Date.parse(range.end)) - 1, { zone });
  return start.toISODate() === end.toISODate() ? start.hour * 3600 + start.minute * 60 + start.second : 0;
}
export function calendarInitialScrollTime(data: AvaCalendarLiveData | null, range: AvaCalendarLiveWindow | null, zone: string, teacher: string) {
  const teachers = new Set(data?.teachers.map(({ id }) => id));
  const scoped = (items: Interval[]) => currentActivity(items, range).filter((item) => item.teacherId && teachers.has(item.teacherId) && (!teacher || teacher === item.teacherId));
  const lessons = scoped(data?.events ?? []);
  const activity = lessons.length ? lessons : scoped(data?.remainingAVA ?? []);
  if (!activity.length) return "09:00:00";
  const seconds = Math.min(...activity.map((item) => activityTime(item, range!, zone)));
  return DateTime.fromObject({ hour: 0 }, { zone: "UTC" }).plus({ seconds }).toFormat("HH:mm:ss");
}

export type CalendarColumnPosition = { key: string; columns: string[]; width: number };
export function calendarColumnScrollLeft(prior: CalendarColumnPosition | null, next: CalendarColumnPosition, left: number) {
  if (prior?.width === 0 && next.width === 0) return left;
  if (!prior || prior.key !== next.key) return 0;
  const index = Math.floor(left / Math.max(1, prior.width));
  const target = next.columns.indexOf(prior.columns[index]);
  return target < 0 ? 0 : target * next.width + Math.min(left % Math.max(1, prior.width), Math.max(0, next.width - 1));
}
