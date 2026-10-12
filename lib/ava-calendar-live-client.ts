import type { AvaCalendarEvent, AvaCalendarProjection } from "./ava-calendar-projection";
import { TRIAL_OPERATIONS } from "./lp-workflows";

export type AvaCalendarLiveWindow = { start: string; end: string };
export type AvaCalendarRemaining = { id: string; teacherId: string; startsAt: string; endsAt: string };
export type AvaCalendarLiveData = AvaCalendarProjection & { remainingAVA: AvaCalendarRemaining[] };
type CalendarSlice = AvaCalendarProjection & { remainingAVA?: AvaCalendarRemaining[]; availabilityStatus?: { teacherId: string; reason: string }[]; nativeVersions?: Record<string, number>; consistencyKey?: string; source?: { revision: string; publishedAt: string; freshness: string; coverage: string; window?: AvaCalendarLiveWindow } };

class CalendarReadError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? "登录已失效，请重新登录。" : status === 403 ? "当前账号无权查看日历。" : status === 409 ? "课表或身份已更新，请刷新。" : "课表暂时无法读取。");
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240;
}

function identifier(value: unknown): value is string {
  return text(value) && value.length > 0 && value === value.trim();
}

function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}

function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!fields || Number(fields[4]) > 23 || Number(fields[5]) > 59 || Number(fields[6]) > 59 || !Number.isFinite(Date.parse(value))) return false;
  const day = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return day.getUTCFullYear() === Number(fields[1]) && day.getUTCMonth() + 1 === Number(fields[2]) && day.getUTCDate() === Number(fields[3]);
}

function recognizedOwner(item: Record<string, unknown>) {
  const index = TRIAL_OPERATIONS.findIndex((owner) => owner === item.owner);
  return Boolean(item.studentName && item.owner && item.ownerId && index >= 0 && item.color === `owner-${index + 1}`);
}

function decodeStudent(value: unknown): AvaCalendarEvent["students"][number] {
  const item = object(value);
  if (!item || !identifier(item.studentId) || !text(item.studentName) || !nullableText(item.owner) || !nullableText(item.ownerId)) throw new CalendarReadError(503);
  const assigned = recognizedOwner(item);
  return { studentId: item.studentId, studentName: item.studentName, owner: assigned ? item.owner : null, ownerId: assigned ? item.ownerId : null, color: assigned ? item.color as string : "owner-unassigned" };
}

function eventInterval(item: Record<string, unknown>) {
  return instant(item.startsAt) && instant(item.endsAt) && Date.parse(item.endsAt) > Date.parse(item.startsAt);
}

function eventIdentity(item: Record<string, unknown>) {
  return nullableText(item.teacherId) && nullableText(item.teacherName) && typeof item.trial === "boolean" && typeof item.identityPending === "boolean";
}

function eventFields(item: Record<string, unknown>): item is Record<string, unknown> & Omit<AvaCalendarEvent, "students"> & { students: unknown[] } {
  return identifier(item.eventId) && eventInterval(item) && eventIdentity(item) && Array.isArray(item.students) && item.students.length <= 200;
}

function decodeEvent(value: unknown): AvaCalendarEvent {
  const item = object(value);
  if (!item || !eventFields(item)) throw new CalendarReadError(503);
  const students = item.students.map(decodeStudent);
  if (new Set(students.map((student) => student.studentId)).size !== students.length) throw new CalendarReadError(503);
  return { eventId: item.eventId, startsAt: item.startsAt, endsAt: item.endsAt, teacherId: item.teacherId, teacherName: item.teacherName, trial: item.trial, identityPending: item.identityPending, students };
}

function decodeSlice(value: unknown): CalendarSlice {
  const item = object(value);
  if (!item || !Array.isArray(item.events) || item.events.length > 50000 || !Array.isArray(item.teachers) || item.teachers.length > 5000) throw new CalendarReadError(503);
  const teachers = item.teachers.map((value) => {
    const teacher = object(value);
    if (!teacher || !identifier(teacher.id) || !text(teacher.name)) throw new CalendarReadError(503);
    return { id: teacher.id, name: teacher.name };
  });
  if (new Set(teachers.map((teacher) => teacher.id)).size !== teachers.length) throw new CalendarReadError(503);
  return { ...item, teachers, events: item.events.map(decodeEvent) } as CalendarSlice;
}

function validSource(source: CalendarSlice["source"]) {
  if (!source) return false;
  return typeof source.revision === "string" && /^sha256:[a-f0-9]{64}$/.test(source.revision) && instant(source.publishedAt) && source.freshness === "fresh" && source.coverage === "complete";
}

function validSourceWindow(window: AvaCalendarLiveWindow | undefined, slice: AvaCalendarLiveWindow) {
  if (window === undefined) return true;
  return Boolean(object(window) && instant(window!.start) && instant(window!.end) && Date.parse(window!.start) <= Date.parse(slice.start) && Date.parse(window!.end) >= Date.parse(slice.end));
}

function validVersions(versions: CalendarSlice["nativeVersions"]) {
  return ["students", "teachers", "bookings", "lpItems"].every((key) => Number.isSafeInteger(versions?.[key]) && versions![key]! >= 0);
}

function validKey(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validStatuses(value: CalendarSlice["availabilityStatus"]) {
  return value === undefined || Array.isArray(value) && value.every((item) => item && typeof item.teacherId === "string" && typeof item.reason === "string");
}

function validRemaining(item: AvaCalendarRemaining, teachers: Set<string>, slice: AvaCalendarLiveWindow) {
  return Boolean(item && identifier(item.id) && teachers.has(item.teacherId) && instant(item.startsAt) && instant(item.endsAt)
    && Date.parse(item.endsAt) > Date.parse(item.startsAt) && Date.parse(item.startsAt) >= Date.parse(slice.start) && Date.parse(item.endsAt) <= Date.parse(slice.end));
}

function approvedRemaining(body: CalendarSlice, slice: AvaCalendarLiveWindow): AvaCalendarRemaining[] | null {
  if (!validSource(body.source) || !validSourceWindow(body.source?.window, slice) || !validVersions(body.nativeVersions) || !validKey(body.consistencyKey) || !validStatuses(body.availabilityStatus) || !Array.isArray(body.remainingAVA)) return null;
  const teachers = new Set(body.teachers.map((teacher) => teacher.id));
  return body.remainingAVA.every((item) => validRemaining(item, teachers, slice)) ? body.remainingAVA : null;
}

function authority(body: CalendarSlice) {
  return JSON.stringify([body.source?.revision, body.source?.publishedAt, body.source?.window?.start, body.source?.window?.end,
    ...["students", "teachers", "bookings", "lpItems"].map((key) => body.nativeVersions?.[key]), body.consistencyKey,
    [...body.teachers].sort((a, b) => a.id.localeCompare(b.id))]);
}

async function readSlice(slice: AvaCalendarLiveWindow, signal: AbortSignal, fetchImpl: typeof fetch) {
  signal.throwIfAborted();
  const response = await fetchImpl(`/api/ava-calendar?${new URLSearchParams(slice)}`, { method: "GET", cache: "no-store", credentials: "same-origin", signal });
  if (!response.ok) throw new CalendarReadError(response.status);
  return decodeSlice(await response.json().catch(() => { signal.throwIfAborted(); throw new CalendarReadError(503); }));
}

function mergeLessons(events: Map<string, AvaCalendarEvent>, values: AvaCalendarEvent[]) {
  for (const event of values) {
    const prior = events.get(event.eventId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new CalendarReadError(409);
    events.set(event.eventId, event);
  }
}

function unavailableTeachers(body: CalendarSlice) {
  const statuses = Array.isArray(body.availabilityStatus) ? body.availabilityStatus : [];
  return [...statuses.filter((status) => !["ready", "no_current_availability", "no_remaining_availability"].includes(status.reason)).map((status) => status.teacherId),
    ...body.events.filter((event) => event.identityPending || !event.students.length).map((event) => event.teacherId)];
}

function safeRemaining(values: AvaCalendarRemaining[], lessons: AvaCalendarEvent[], unavailable: Set<string | null>) {
  if (unavailable.has(null)) return [];
  const available = values.filter((item) => !unavailable.has(item.teacherId) && !lessons.some((event) => event.teacherId === item.teacherId && Date.parse(event.startsAt) < Date.parse(item.endsAt) && Date.parse(event.endsAt) > Date.parse(item.startsAt)));
  const distinct = new Map(available.map(({ id, teacherId, startsAt, endsAt }) => [`${id}:${startsAt}:${endsAt}`, { id, teacherId, startsAt, endsAt }]));
  return [...distinct.values()];
}

function mergeSlices(bodies: CalendarSlice[], windows: AvaCalendarLiveWindow[], events: Map<string, AvaCalendarEvent>): AvaCalendarLiveData {
  const approved = bodies.map((body, index) => approvedRemaining(body, windows[index]!));
  const lessons = [...events.values()];
  const remaining = approved.every((values) => values !== null) ? safeRemaining(approved.flatMap((values) => values!), lessons, new Set(bodies.flatMap(unavailableTeachers))) : [];
  return { events: lessons, teachers: bodies[0]!.teachers, remainingAVA: remaining };
}

async function readGroup(window: AvaCalendarLiveWindow, signal: AbortSignal, fetchImpl: typeof fetch): Promise<AvaCalendarLiveData> {
  const windows = splitAvaCalendarWindow(window);
  const bodies: CalendarSlice[] = [];
  const events = new Map<string, AvaCalendarEvent>();
  let key: string | undefined;
  for (const slice of windows) {
    const body = await readSlice(slice, signal, fetchImpl);
    const nextKey = authority(body);
    if (key !== undefined && key !== nextKey) throw new CalendarReadError(409);
    key = nextKey;
    mergeLessons(events, body.events);
    bodies.push(body);
  }
  signal.throwIfAborted();
  return mergeSlices(bodies, windows, events);
}

export async function fetchAvaCalendarWindow(window: AvaCalendarLiveWindow, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<AvaCalendarLiveData> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readGroup(window, signal, fetchImpl);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof CalendarReadError) || error.status !== 409 || attempt >= 1) throw error;
    }
  }
}

export function splitAvaCalendarWindow(window: AvaCalendarLiveWindow): AvaCalendarLiveWindow[] {
  if (!instant(window.start) || !instant(window.end)) throw new Error("请选择有效的日期范围。");
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 62 * 86400000) throw new Error("请选择有效的日期范围。");
  const slices: AvaCalendarLiveWindow[] = [];
  for (let point = start; point < end; point += 10 * 86400000) {
    slices.push({ start: new Date(point).toISOString(), end: new Date(Math.min(point + 10 * 86400000, end)).toISOString() });
  }
  return slices;
}
