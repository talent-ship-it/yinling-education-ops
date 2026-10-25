import { createJiaowubaoScheduleReader } from "./jiaowubao-schedule-provider-node";
import { reserveJiaowubaoOpenApiScheduleRequest } from "./ops-store";
import { reconcileUnclosedLessons, unclosedCollectionWindows, unclosedTargetDate, type UnclosedLesson } from "./jiaowubao-unclosed-lessons";
import type { JiaowubaoScheduleListQuery, JiaowubaoScheduleListResponse } from "./jiaowubao-open-api-node";

type SourceRow = Record<string, unknown>;
type FetchPage = (query: JiaowubaoScheduleListQuery) => Promise<JiaowubaoScheduleListResponse>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const COMPLETION_STATES = new Set<unknown>([0, 1, "0", "1"]);

function stringId(value: unknown) {
  const text = String(value ?? "");
  if (!ID.test(text) || /^0+$/u.test(text)) throw new Error("unclosed_source_id_invalid");
  return text;
}

function optionalText(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 240) || null : null;
}

function sourceDate(value: unknown) {
  const date = typeof value === "string" ? value.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("unclosed_source_date_invalid");
  return date;
}

function participant(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unclosed_participant_invalid");
  const row = value as SourceRow;
  return { memberId: stringId(row.mem_id), name: optionalText(row.name) };
}

function sourceLesson(row: SourceRow, now: Date): UnclosedLesson {
  if (!Array.isArray(row.stu_list) || row.stu_list.length > 1000) throw new Error("unclosed_participants_invalid");
  return {
    eventId: `jwb-open-api:schedule:${stringId(row.cal_id)}`, date: sourceDate(row.dated), courseName: optionalText(row.course_title),
    participants: row.stu_list.map(participant), firstDetectedAt: now.toISOString(), lastSeenAt: now.toISOString(),
  };
}

function addSourceRow(collected: Map<string, SourceRow>, row: SourceRow, window: Readonly<{ start: string; end: string }>) {
  const id = stringId(row.cal_id);
  if (collected.has(id)) throw new Error("unclosed_duplicate_source");
  if (!COMPLETION_STATES.has(row.over)) throw new Error("unclosed_status_invalid");
  const date = sourceDate(row.dated);
  if (date < window.start || date > window.end) throw new Error("unclosed_window_invalid");
  collected.set(id, row);
}

async function collectWindow(window: Readonly<{ start: string; end: string }>, fetchPage: FetchPage, remaining: { calls: number }) {
  const collected = new Map<string, SourceRow>();
  for (let page = 1; page <= 60; page++) {
    if (++remaining.calls > 50) throw new Error("unclosed_request_limit");
    const result = await fetchPage({ ...window, page, limit: 100, order: "asc" });
    if (!Array.isArray(result.lists) || result.lists.length > 100) throw new Error("unclosed_page_invalid");
    for (const row of result.lists) addSourceRow(collected, row, window);
    if (collected.size > 6000) throw new Error("unclosed_row_limit");
    if (result.lists.length < 100) return [...collected.values()];
  }
  throw new Error("unclosed_page_limit");
}

export async function collectUnclosedLessons(previous: readonly UnclosedLesson[], now: Date, fetchPage: FetchPage, previousCheckedAt?: string | null) {
  const open: UnclosedLesson[] = [];
  const completed = new Set<string>();
  const remaining = { calls: 0 };
  for (const window of unclosedCollectionWindows(previous, now, previousCheckedAt)) {
    const rows = await collectWindow(window, fetchPage, remaining);
    const pending = rows.filter((row) => row.over === 0 || row.over === "0");
    open.push(...pending.map((row) => sourceLesson(row, now)).filter((lesson) => lesson.date <= unclosedTargetDate(now)));
    const closed = rows.filter((row) => row.over === 1 || row.over === "1");
    closed.forEach((row) => completed.add(`jwb-open-api:schedule:${stringId(row.cal_id)}`));
  }
  const lessons = reconcileUnclosedLessons(previous, open, completed);
  if (lessons.length > 6000) throw new Error("unclosed_row_limit");
  return { lessons, calls: remaining.calls };
}

export function unclosedPageReader(deadlineAt: number): FetchPage {
  const reader = createJiaowubaoScheduleReader();
  return async (query) => {
    if (Date.now() >= deadlineAt) throw new Error("unclosed_deadline");
    const reservation = await reserveJiaowubaoOpenApiScheduleRequest({ actor: "Ops Admin" }, { deadlineAt });
    const delay = Date.parse(reservation.notBefore) - Date.now();
    if (!Number.isFinite(delay) || Date.now() + Math.max(0, delay) >= deadlineAt) throw new Error("unclosed_deadline");
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return reader.readPage(query);
  };
}
