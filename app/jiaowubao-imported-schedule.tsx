"use client";

import { CalendarClock, LockKeyhole } from "lucide-react";

import type { InterfaceLanguage } from "@/lib/display-preferences";
import type { JiaowubaoTrialPlannerHint } from "@/lib/trial-operations";

/**
 * This is deliberately separate from `Booking`: a 教务宝 schedule event is
 * imported source evidence, not an editable booking, lesson package entry,
 * classroom, or settlement record.
 */
export type JiaowubaoImportedScheduleEvent = Readonly<{
  eventId: string;
  sourceDate: string;
  startsAt: string;
  endsAt: string;
  courseName: string | null;
  teacherId: string | null;
  trialPlannerHint: JiaowubaoTrialPlannerHint;
  availabilityEffect: "display_only" | "blocks_teacher_ava";
  visibleStudentIds: readonly string[];
  visibleStudentsTruncated: boolean;
}>;

export type JiaowubaoImportedSchedulePage = Readonly<{
  state: "absent" | "complete" | "stale" | "reset";
  events: readonly JiaowubaoImportedScheduleEvent[];
  invalidTimeEventCount: number;
  hasMore: boolean;
  nextCursor: Readonly<{
    /** Opaque, server-signed continuation token. Never inspect or construct it in the browser. */
    token: string;
  }> | null;
  freshness?: "absent" | "fresh" | "stale";
  empty?: boolean;
}>;

/**
 * The browser only exposes a feed after it has collected every page for one
 * immutable direct-import run. Partial pages must never influence AVA.
 */
export type JiaowubaoImportedScheduleFeed = Readonly<{
  state: "absent" | "complete" | "stale";
  events: readonly JiaowubaoImportedScheduleEvent[];
  invalidTimeEventCount: number;
  paginationComplete: true;
}>;

export type JiaowubaoImportedScheduleReadError = "session" | "reader_unavailable" | "unavailable";

const FORBIDDEN_SCHEDULE_FIELDS = new Set([
  "price", "price_mem", "priceMember", "price_member", "sk", "secret", "token",
  "stu_list", "sourceStudentMemberIds", "sourceStudentLabels", "sourceStudentNameKeys", "sourceParticipants",
  "sourceStudentsTruncated", "sourceTeacherId", "sourceTeacherLabel", "memberId", "studentMemberId", "nameKey",
  "name", "studentName", "studentLabel", "label", "logo", "comment", "raw", "record",
]);
const SOURCE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SOURCE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PAGE_FIELDS = new Set(["state", "events", "invalidTimeEventCount", "hasMore", "nextCursor", "freshness", "empty"]);
const EVENT_FIELDS = new Set(["eventId", "sourceDate", "startsAt", "endsAt", "courseName", "teacherId", "trialPlannerHint", "availabilityEffect", "visibleStudentIds", "visibleStudentsTruncated"]);
const CURSOR_FIELDS = new Set(["token"]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function canonicalDate(value: unknown) {
  if (typeof value !== "string" || !SOURCE_DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function canonicalInstant(value: unknown) {
  if (typeof value !== "string" || !SOURCE_INSTANT.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value ? null : value;
}

function assertNoForbiddenFields(value: Record<string, unknown>, fields: readonly string[] = Object.keys(value)) {
  if (fields.some((field) => FORBIDDEN_SCHEDULE_FIELDS.has(field))) throw new Error("教务宝同步课表响应包含禁止字段。");
}

function assertAllowedFields(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  if (Object.keys(value).some((field) => !allowed.has(field))) throw new Error("教务宝同步课表响应包含未允许字段。");
}

/** Parses and allow-lists the browser DTO emitted by the snapshot route. */
export function parseJiaowubaoImportedSchedulePage(value: unknown): JiaowubaoImportedSchedulePage {
  const source = objectValue(value);
  if (!source) throw new Error("教务宝同步课表响应格式无效。");
  assertNoForbiddenFields(source);
  assertAllowedFields(source, PAGE_FIELDS);
  if (source.state !== "absent" && source.state !== "complete" && source.state !== "stale" && source.state !== "reset") throw new Error("教务宝同步课表状态无效。");
  if (!Array.isArray(source.events)) throw new Error("教务宝同步课表事件格式无效。");

  const events: JiaowubaoImportedScheduleEvent[] = source.events.map((item) => {
    const event = objectValue(item);
    if (!event) throw new Error("教务宝同步课表包含无效事件。");
    assertNoForbiddenFields(event);
    assertAllowedFields(event, EVENT_FIELDS);
    if (typeof event.eventId !== "string" || !SOURCE_EVENT_ID.test(event.eventId)
      || typeof event.sourceDate !== "string" || !canonicalDate(event.sourceDate)
      || typeof event.startsAt !== "string" || !canonicalInstant(event.startsAt)
      || typeof event.endsAt !== "string" || !canonicalInstant(event.endsAt)
      || new Date(event.endsAt).getTime() <= new Date(event.startsAt).getTime()) {
      throw new Error("教务宝同步课表事件缺少有效时间资料。");
    }
    if (event.courseName !== null && typeof event.courseName !== "string") throw new Error("教务宝同步课表课程格式无效。");
    if (event.teacherId !== null && typeof event.teacherId !== "string") throw new Error("教务宝同步课表老师格式无效。");
    const trialPlannerHint = event.trialPlannerHint ?? null;
    if (trialPlannerHint !== null && !["Tara", "Eileen", "Abby"].includes(String(trialPlannerHint))) {
      throw new Error("教务宝同步课表试听账号映射无效。");
    }
    if (event.availabilityEffect !== "display_only" && event.availabilityEffect !== "blocks_teacher_ava") throw new Error("教务宝同步课表 AVA 状态无效。");
    if (!Array.isArray(event.visibleStudentIds)
      || event.visibleStudentIds.length > 100
      || !event.visibleStudentIds.every((studentId) => typeof studentId === "string" && studentId.length > 0 && studentId.length <= 240)) {
      throw new Error("教务宝同步课表学员范围无效。");
    }
    if (typeof event.visibleStudentsTruncated !== "boolean") throw new Error("教务宝同步课表学员范围状态无效。");
    return {
      eventId: event.eventId,
      sourceDate: event.sourceDate,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      courseName: event.courseName,
      teacherId: event.teacherId,
      trialPlannerHint: trialPlannerHint as JiaowubaoTrialPlannerHint,
      availabilityEffect: event.availabilityEffect,
      visibleStudentIds: event.visibleStudentIds,
      visibleStudentsTruncated: event.visibleStudentsTruncated,
    };
  });

  const invalidTimeEventCount = Number(source.invalidTimeEventCount ?? 0);
  if (!Number.isSafeInteger(invalidTimeEventCount) || invalidTimeEventCount < 0) throw new Error("教务宝同步课表异常时间计数无效。");
  if (typeof source.hasMore !== "boolean") throw new Error("教务宝同步课表分页状态无效。");
  const nextCursor = source.nextCursor;
  if (nextCursor !== null && !objectValue(nextCursor)) throw new Error("教务宝同步课表分页游标无效。");
  const parsedNextCursor = nextCursor === null ? null : objectValue(nextCursor)!;
  if (parsedNextCursor) {
    // The only allowed cursor field is the opaque signed continuation token;
    // `token` is intentionally exempt from the response-wide secret-field
    // deny-list here and is still validated by the strict cursor regex below.
    assertAllowedFields(parsedNextCursor, CURSOR_FIELDS);
  }
  if (source.hasMore !== Boolean(parsedNextCursor)) throw new Error("教务宝同步课表分页游标不一致。");
  if (parsedNextCursor && (typeof parsedNextCursor.token !== "string" || !/^[A-Za-z0-9_-]{32,2048}\.[A-Za-z0-9_-]{32,128}$/.test(parsedNextCursor.token))) {
    throw new Error("教务宝同步课表分页游标无效。");
  }
  if (source.freshness !== undefined
    && source.freshness !== "absent" && source.freshness !== "fresh" && source.freshness !== "stale") {
    throw new Error("教务宝同步课表新鲜度无效。");
  }
  if (source.empty !== undefined && typeof source.empty !== "boolean") throw new Error("教务宝同步课表空结果状态无效。");
  if (source.freshness !== undefined
    && ((source.state === "absent" && source.freshness !== "absent")
      || (source.state === "complete" && source.freshness !== "fresh")
      || (source.state === "stale" && source.freshness !== "stale")
      || (source.state === "reset" && source.freshness !== "stale"))) {
    throw new Error("教务宝同步课表状态与新鲜度不一致。");
  }
  if (source.empty !== undefined && source.empty !== (events.length === 0 && !source.hasMore)) {
    throw new Error("教务宝同步课表空结果状态不一致。");
  }
  if (source.state !== "complete" && source.state !== "stale" && source.hasMore) throw new Error("教务宝同步课表状态不应继续分页。");
  return {
    state: source.state,
    events,
    invalidTimeEventCount,
    hasMore: source.hasMore,
    nextCursor: parsedNextCursor ? { token: parsedNextCursor.token as string } : null,
    ...(source.freshness !== undefined ? { freshness: source.freshness } : {}),
    ...(source.empty !== undefined ? { empty: source.empty } : {}),
  };
}

/**
 * Converts a complete sequence of server pages into the only feed shape that
 * the schedule and AVA UI are allowed to consume. A reset, repeated opaque
 * cursor, duplicate event, or unfinished last page fails closed instead of
 * displaying a partial availability picture.
 */
export function completeJiaowubaoImportedSchedulePages(
  pages: readonly JiaowubaoImportedSchedulePage[],
): JiaowubaoImportedScheduleFeed {
  if (!pages.length) throw new Error("教务宝同步课表没有返回分页结果。");
  const first = pages[0]!;
  if (first.state === "reset") throw new Error("教务宝同步课表分页已重置。");
  if (first.state === "absent") {
    if (pages.length !== 1 || first.hasMore || first.nextCursor || first.events.length) {
      throw new Error("教务宝同步课表空结果分页无效。");
    }
    return {
      state: "absent",
      events: [],
      invalidTimeEventCount: first.invalidTimeEventCount,
      paginationComplete: true,
    };
  }
  if (first.state !== "complete" && first.state !== "stale") {
    throw new Error("教务宝同步课表分页状态无效。");
  }

  const eventIds = new Set<string>();
  const continuationTokens = new Set<string>();
  const events: JiaowubaoImportedScheduleEvent[] = [];
  for (const [index, page] of pages.entries()) {
    if (page.state !== first.state) {
      throw new Error("教务宝同步课表分页已重置或不是同一同步批次。");
    }
    // The database computes this source-wide diagnostic on the first page
    // only; continuation pages deliberately return zero to avoid repeated
    // aggregation work. A nonzero continuation count would be ambiguous.
    if (index > 0 && page.invalidTimeEventCount !== 0) {
      throw new Error("教务宝同步课表分页异常时间计数不一致。");
    }
    if (index < pages.length - 1 && (!page.hasMore || !page.nextCursor)) {
      throw new Error("教务宝同步课表分页过早结束。");
    }
    if (index === pages.length - 1 && (page.hasMore || page.nextCursor)) {
      throw new Error("教务宝同步课表分页尚未读取完成。");
    }
    if (page.nextCursor) {
      if (!page.nextCursor.token || continuationTokens.has(page.nextCursor.token)) {
        throw new Error("教务宝同步课表分页游标重复或无效。");
      }
      continuationTokens.add(page.nextCursor.token);
    }
    for (const event of page.events) {
      if (eventIds.has(event.eventId)) throw new Error("教务宝同步课表分页包含重复事件。");
      eventIds.add(event.eventId);
      events.push(event);
    }
  }

  return {
    state: first.state,
    events,
    invalidTimeEventCount: first.invalidTimeEventCount,
    paginationComplete: true,
  };
}

/** A direct input for AVA subtraction, never a Booking or lesson occurrence. */
export type JiaowubaoImportedAvailabilityBlock = Readonly<{
  id: string;
  startsAt: string;
  endsAt: string;
}>;

/**
 * Only a fully imported, valid operational schedule event for the exact
 * selected teacher can consume their AVA. Display-only events remain visible
 * source history and intentionally have no scheduling effect.
 */
export function jiaowubaoImportedAvailabilityBlocksForTeacher(
  feed: JiaowubaoImportedScheduleFeed | null,
  teacherId: string | undefined,
): JiaowubaoImportedAvailabilityBlock[] {
  if (!teacherId || feed?.state !== "complete" || feed.paginationComplete !== true) return [];
  return feed.events.flatMap((event) => (
    event.availabilityEffect === "blocks_teacher_ava" && event.teacherId === teacherId
      ? [{ id: event.eventId, startsAt: event.startsAt, endsAt: event.endsAt }]
      : []
  ));
}

type JiaowubaoImportedSchedulePanelProps = Readonly<{
  feed: JiaowubaoImportedScheduleFeed | null;
  loading: boolean;
  error: boolean | JiaowubaoImportedScheduleReadError;
  timezone: string;
  language: InterfaceLanguage;
  studentNameForId: (studentId: string) => string | undefined;
  teacherNameForId: (teacherId: string) => string | undefined;
}>;

function eventTime(value: string, timezone: string, language: InterfaceLanguage) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "—";
  return new Intl.DateTimeFormat(language === "en-AU" ? "en-AU" : "zh-CN", {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

function eventSortTime(event: JiaowubaoImportedScheduleEvent) {
  const timestamp = new Date(event.startsAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

/**
 * Read-only source schedule panel. Its event rows intentionally have no
 * interactive controls, no event identifiers in the visible UI, and no path
 * into booking, classroom, cancellation, settlement, or package workflows.
 */
export function JiaowubaoImportedSchedulePanel({
  feed,
  loading,
  error,
  timezone,
  language,
  studentNameForId,
  teacherNameForId,
}: JiaowubaoImportedSchedulePanelProps) {
  const english = language === "en-AU";
  const events = [...(feed?.events ?? [])].sort((left, right) => eventSortTime(left) - eventSortTime(right));

  return (
    <section className="jiaowubao-imported-schedule" aria-labelledby="jiaowubao-imported-schedule-title">
      <header className="jiaowubao-imported-schedule-header">
        <span className="jiaowubao-imported-schedule-mark" aria-hidden="true"><CalendarClock size={17} /></span>
        <div>
          <h2 id="jiaowubao-imported-schedule-title">{english ? "Synced schedule" : "同步课表"}</h2>
        </div>
        <span className="jiaowubao-imported-schedule-readonly"><LockKeyhole size={13} /> {english ? "Read only" : "只读"}</span>
      </header>

      {loading ? <div className="jiaowubao-imported-schedule-empty" role="status" aria-live="polite">{english ? "Reading schedule…" : "正在读取课表…"}</div> : null}
      {!loading && error ? <div className="jiaowubao-imported-schedule-empty" role="alert">{typeof error === "string"
        ? error === "session"
          ? (english ? "Your session has expired. Sign in again to read the schedule." : "登录状态已失效，请重新登录后读取课表。")
          : error === "reader_unavailable"
            ? (english ? "The schedule reader is not available yet." : "课表读取功能尚未部署。")
            : (english ? "The schedule is temporarily unavailable." : "课表暂时无法读取。")
        : (english ? "The synced schedule is temporarily unavailable." : "同步课表暂时无法读取。")}</div> : null}
      {!loading && !error && feed?.state === "absent" ? <div className="jiaowubao-imported-schedule-empty" role="status">{english ? "No completed schedule is available yet." : "当前还没有已同步的课表。"}</div> : null}
      {!loading && !error && (feed?.state === "complete" || feed?.state === "stale") && events.length === 0 ? <div className="jiaowubao-imported-schedule-empty" role="status">{english ? "No classes fall within this calendar window." : "当前日期范围内没有课程。"}</div> : null}

      {!loading && !error && events.length > 0 ? (
        <div className="jiaowubao-imported-schedule-list">
          {events.map((event) => {
            const studentNames = event.visibleStudentIds
              .map((studentId) => studentNameForId(studentId))
              .filter((name): name is string => Boolean(name));
            const teacherName = event.teacherId ? teacherNameForId(event.teacherId) : undefined;
            const blocksAvailability = event.availabilityEffect === "blocks_teacher_ava";
            // Availability-only readers deliberately receive no course or
            // participant details. Describe that limited record truthfully
            // instead of making it look like data failed to be matched.
            const availabilityOnly = blocksAvailability
              && event.courseName === null
              && !event.visibleStudentIds.length
              && !event.visibleStudentsTruncated;
            const studentLabel = english ? "Students" : "学员";
            const truncatedLabel = english ? "Showing the first 100 authorised students" : "仅显示前 100 位有权限查看的学员";

            return (
              <article className="jiaowubao-imported-schedule-row" key={event.eventId}>
                <time dateTime={event.startsAt}>
                  <strong>{eventTime(event.startsAt, timezone, language)}</strong>
                  <small>{eventTime(event.endsAt, timezone, language)}</small>
                </time>
                <span className="jiaowubao-imported-schedule-course">
                  <strong>{event.courseName || (availabilityOnly
                    ? (english ? "Occupied time" : "已占用时段")
                    : (english ? "Course not labelled" : "课程待标注"))}</strong>
                  {studentNames.length ? <small>{studentLabel}：{studentNames.join("、")}{event.visibleStudentsTruncated ? ` · ${truncatedLabel}` : ""}</small> : null}
                  {!studentNames.length && event.visibleStudentsTruncated ? <small>{truncatedLabel}</small> : null}
                </span>
                <span className="jiaowubao-imported-schedule-teacher">
                  <strong>{teacherName || (availabilityOnly
                    ? (english ? "Teacher AVA occupied" : "老师 AVA 已占用")
                    : (english ? "Teacher not matched" : "老师待匹配"))}</strong>
                  <small>{blocksAvailability ? (english ? "Blocks teacher AVA" : "占用老师 AVA") : (english ? "Display only" : "仅供查看")}</small>
                </span>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
