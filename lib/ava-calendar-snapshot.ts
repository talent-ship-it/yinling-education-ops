import type { JiaowubaoOpenApiScheduleSnapshotWindow } from "./ops-store";
import { assertAvaCalendarReadAuthority } from "./ava-calendar-read-authority";

export type AvaCalendarWindow = { start: string; end: string };
export type AvaCalendarSnapshot = {
  events: JiaowubaoOpenApiScheduleSnapshotWindow["events"][number][];
  revision: string;
  publishedAt: string;
  freshness: "fresh" | "stale";
  coverage: "complete" | "partial";
};
export type AvaCalendarPageFetcher = (input: { cursor: JiaowubaoOpenApiScheduleSnapshotWindow["nextCursor"]; revision: string | null; limit: number }) => Promise<JiaowubaoOpenApiScheduleSnapshotWindow>;

export class AvaCalendarReadError extends Error {
  constructor(readonly code: "invalid_window" | "source_unavailable" | "source_changed") {
    super(code);
  }
}

function instant(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value) || !dateOnly(value.slice(0, 10))) return NaN;
  const date = new Date(value);
  return date.valueOf();
}

function dateOnly(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function validateAvaCalendarWindow(window: AvaCalendarWindow) {
  const start = instant(window.start);
  const end = instant(window.end);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(window.start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(window.end)
    || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 10 * 86400000) throw new AvaCalendarReadError("invalid_window");
  return { start, end };
}

type SnapshotEvent = JiaowubaoOpenApiScheduleSnapshotWindow["events"][number];
type SnapshotCursor = JiaowubaoOpenApiScheduleSnapshotWindow["nextCursor"];

function validatePageReceipt(page: JiaowubaoOpenApiScheduleSnapshotWindow) {
  if (!page || !["complete", "stale"].includes(page.state) || !/^sha256:[a-f0-9]{64}$/.test(page.revision ?? "")
    || !Number.isFinite(instant(page.publishedAt))) throw new AvaCalendarReadError("source_unavailable");
}

function validateSourceWindow(window: JiaowubaoOpenApiScheduleSnapshotWindow["sourceWindow"]) {
  if (!window || !dateOnly(window.start) || !dateOnly(window.end) || window.end < window.start) throw new AvaCalendarReadError("source_unavailable");
}

function validatePageCompleteness(page: JiaowubaoOpenApiScheduleSnapshotWindow) {
  if (page.invalidTimeEventCount !== 0 || (page.state === "complete" ? page.freshness !== "fresh" : page.freshness !== "stale")
    || !Array.isArray(page.events) || page.events.length > 250 || typeof page.hasMore !== "boolean"
    || page.empty !== (page.events.length === 0 && !page.hasMore)) throw new AvaCalendarReadError("source_unavailable");
}

function nullableText(value: unknown) {
  return value === null || typeof value === "string" && value.trim().length > 0 && value.length <= 240;
}

function validateEventDetails(event: SnapshotEvent) {
  if (!event || typeof event.eventId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(event.eventId) || !dateOnly(event.sourceDate)
    || !nullableText(event.courseName) || !nullableText(event.sourceTeacherId) || !nullableText(event.sourceTeacherLabel)) throw new AvaCalendarReadError("source_unavailable");
}

function validateEventTimes(event: SnapshotEvent, range: { start: number; end: number }) {
  if (!Number.isFinite(instant(event.startsAt)) || !Number.isFinite(instant(event.endsAt)) || instant(event.endsAt) <= instant(event.startsAt)
    || instant(event.startsAt) >= range.end || instant(event.endsAt) <= range.start) throw new AvaCalendarReadError("source_unavailable");
}

function validMemberId(value: unknown) {
  return value === null || typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function validParticipantLabel(value: unknown) {
  return value === null || typeof value === "string" && value.length > 0 && value.length <= 240;
}

function validParticipant(participant: SnapshotEvent["sourceParticipants"][number]) {
  return participant && validMemberId(participant.memberId) && validParticipantLabel(participant.label)
    && (participant.memberId !== null || participant.label !== null);
}

function validateEventParticipants(event: SnapshotEvent) {
  if (!Array.isArray(event.sourceParticipants) || event.sourceParticipants.length > 128 || typeof event.sourceStudentsTruncated !== "boolean"
    || !event.sourceParticipants.every(validParticipant)) throw new AvaCalendarReadError("source_unavailable");
}

function validatePage(page: JiaowubaoOpenApiScheduleSnapshotWindow, window: AvaCalendarWindow) {
  validatePageReceipt(page);
  validateSourceWindow(page.sourceWindow);
  validatePageCompleteness(page);
  const range = validateAvaCalendarWindow(window);
  for (const event of page.events) {
    validateEventDetails(event);
    validateEventTimes(event, range);
    validateEventParticipants(event);
  }
}

function validateSnapshotRevision(page: JiaowubaoOpenApiScheduleSnapshotWindow, first: JiaowubaoOpenApiScheduleSnapshotWindow) {
  if (page.revision !== first.revision || page.publishedAt !== first.publishedAt || page.freshness !== first.freshness
    || JSON.stringify(page.sourceWindow) !== JSON.stringify(first.sourceWindow)) throw new AvaCalendarReadError("source_changed");
}

function validateEventOrder(event: SnapshotEvent, previous: SnapshotCursor, seen: Set<string>) {
  if (seen.has(event.eventId) || previous && (instant(event.startsAt) < instant(previous.startsAt)
    || instant(event.startsAt) === instant(previous.startsAt) && event.eventId <= previous.eventId)) throw new AvaCalendarReadError("source_unavailable");
}

function appendPageEvents(page: JiaowubaoOpenApiScheduleSnapshotWindow, cursor: SnapshotCursor, seen: Set<string>, events: AvaCalendarSnapshot["events"]) {
  let previous = cursor;
  for (const event of page.events) {
    validateEventOrder(event, previous, seen);
    seen.add(event.eventId);
    events.push({ ...event, startsAt: new Date(instant(event.startsAt)).toISOString(), endsAt: new Date(instant(event.endsAt)).toISOString() });
    previous = { startsAt: event.startsAt, eventId: event.eventId };
  }
  return previous;
}

function canonicalInstant(value: string) {
  const timestamp = instant(value);
  if (!Number.isFinite(timestamp)) return null;
  const fraction = value.match(/\.(\d{1,6})/)?.[1] ?? "";
  return `${new Date(timestamp).toISOString().slice(0, -4)}${fraction.padEnd(6, "0")}Z`;
}

function validateNextCursor(page: JiaowubaoOpenApiScheduleSnapshotWindow, previous: SnapshotCursor) {
  const startsAt = page.nextCursor ? canonicalInstant(page.nextCursor.startsAt) : null;
  if (page.events.length !== 250 || !page.nextCursor || page.nextCursor.eventId !== previous?.eventId
    || startsAt === null || startsAt !== canonicalInstant(previous.startsAt)) throw new AvaCalendarReadError("source_unavailable");
}

function completeSnapshot(first: JiaowubaoOpenApiScheduleSnapshotWindow, window: AvaCalendarWindow, events: AvaCalendarSnapshot["events"]): AvaCalendarSnapshot {
  return {
    events, revision: first.revision!, publishedAt: new Date(instant(first.publishedAt)).toISOString(), freshness: first.freshness as "fresh" | "stale",
    coverage: window.start.slice(0, 10) >= first.sourceWindow!.start && window.end.slice(0, 10) < first.sourceWindow!.end ? "complete" : "partial",
  };
}

export async function readAvaCalendarSnapshot(window: AvaCalendarWindow, fetchPage: AvaCalendarPageFetcher): Promise<AvaCalendarSnapshot> {
  validateAvaCalendarWindow(window);
  let cursor: SnapshotCursor = null;
  let first: JiaowubaoOpenApiScheduleSnapshotWindow | null = null;
  const events: AvaCalendarSnapshot["events"] = [];
  const seen = new Set<string>();
  for (let pageIndex = 0; pageIndex < 40; pageIndex += 1) {
    assertAvaCalendarReadAuthority();
    const page = await fetchPage({ cursor, revision: first?.revision ?? null, limit: 250 });
    validatePage(page, window);
    first ??= page;
    validateSnapshotRevision(page, first);
    const previous = appendPageEvents(page, cursor, seen, events);
    if (!page.hasMore) {
      if (page.nextCursor !== null) throw new AvaCalendarReadError("source_unavailable");
      return completeSnapshot(first, window, events);
    }
    validateNextCursor(page, previous);
    cursor = page.nextCursor;
  }
  throw new AvaCalendarReadError("source_unavailable");
}
