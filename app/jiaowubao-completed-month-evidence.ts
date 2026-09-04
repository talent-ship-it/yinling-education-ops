"use client";

import {
  reconcileJiaowubaoCompletedLessonEvidence,
  type JiaowubaoCompletedLessonMatch,
  type JiaowubaoCompletedLessonStudentEvidence,
  type JiaowubaoCompletedLessonTeacherLink,
  type JiaowubaoCompletedLessonTeacherSummary,
  type JiaowubaoCompletedScheduleEventEvidence,
  type JiaowubaoCompletedScheduleTeacherEvidence,
} from "@/lib/jiaowubao-completed-lesson-reconciliation";
import {
  JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES,
  JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE,
} from "@/lib/jiaowubao-completed-lesson-pagination";
import { JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID } from "@/lib/jiaowubao-completed-lesson-branch";

export type JiaowubaoCompletedLessonFeedItem = JiaowubaoCompletedLessonStudentEvidence;
export type JiaowubaoCompletedScheduleFeedEvent = JiaowubaoCompletedScheduleEventEvidence;
export type { JiaowubaoCompletedLessonMatch, JiaowubaoCompletedLessonTeacherSummary };

type Source = "lessons" | "schedules";

type PageMetadata = Readonly<{
  state: "absent" | "complete" | "reset";
  source: Source;
  month: string;
  revision: string | null;
  rowCount: number;
  pageIndex: number;
  pageCount: number;
  publishedAt: string | null;
  /** Hash of the student/teacher mapping state used for this projection. */
  projectionRevision: string | null;
}>;

export type JiaowubaoCompletedLessonPage = PageMetadata & Readonly<{
  source: "lessons";
  items: readonly JiaowubaoCompletedLessonFeedItem[];
}>;

export type JiaowubaoCompletedSchedulePage = PageMetadata & Readonly<{
  source: "schedules";
  items: readonly JiaowubaoCompletedScheduleFeedEvent[];
}>;

export type JiaowubaoCompletedMonthEvidencePage = JiaowubaoCompletedLessonPage | JiaowubaoCompletedSchedulePage;

export type JiaowubaoCompletedLessonFeed = Readonly<{
  state: "absent" | "complete";
  month: string;
  revision: string | null;
  rowCount: number;
  scheduleRowCount: number;
  publishedAt: string | null;
  /** Source revision and this mapping revision must both match across pages. */
  projectionRevision: string | null;
  items: readonly JiaowubaoCompletedLessonFeedItem[];
  scheduleEvents: readonly JiaowubaoCompletedScheduleFeedEvent[];
  teachers: readonly JiaowubaoCompletedLessonTeacherSummary[];
  teacherEvidenceSourceKeys: ReadonlyMap<string, ReadonlySet<string>>;
  matchedStudentCount: number;
  unmatchedStudentCount: number;
  ambiguousStudentCount: number;
  matchedTeacherCount: number;
  unmatchedTeacherCount: number;
  ambiguousTeacherCount: number;
}>;

/** A payroll lock requires a fully read, current dual-source month. */
export function jiaowubaoCompletedMonthEvidenceReadyForPayrollLock(input: Readonly<{
  feed: JiaowubaoCompletedLessonFeed | null;
  month: string;
  loading: boolean;
  error: boolean;
  syncing: boolean;
}>) {
  return !input.loading
    && !input.error
    && !input.syncing
    && input.feed?.state === "complete"
    && input.feed.month === input.month;
}

const PAGE_FIELDS = new Set([
  "state", "source", "month", "revision", "rowCount", "pageIndex", "pageCount", "publishedAt", "projectionRevision", "items",
]);
const LESSON_FIELDS = new Set([
  "sourceKey", "branchId", "calendarId", "memberId", "memberName", "lessonDate", "timeTitle", "hours", "isTrial",
  "attendanceCode", "attendanceTitle", "courseTitle", "teamTitle", "studentId", "studentName", "displayStudentName", "studentMatch", "teachers",
]);
const SCHEDULE_FIELDS = new Set([
  "sourceKey", "calendarId", "lessonDate", "timeTitle", "courseTitle", "teamTitle", "teachers",
]);
const TEACHER_FIELDS = new Set([
  "role", "sourceTeacherId", "sourceTeacherName", "teacherId", "teacherName", "teacherMatch",
]);
const SCHEDULE_TEACHER_FIELDS = new Set([...TEACHER_FIELDS, "sourceTeacherHours"]);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SOURCE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const LESSON_KEY = /^jwb-open-api:lesson:(?:~|[A-Za-z0-9][A-Za-z0-9._-]{0,159}):[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const SCHEDULE_KEY = /^jwb-open-api:schedule:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const MATCHES = new Set<JiaowubaoCompletedLessonMatch>([
  "source_id", "unique_name", "trial_course_title", "unmatched", "ambiguous",
]);
const FORBIDDEN_FIELDS = new Set([
  "sk", "secret", "token", "authorization", "password", "raw", "record", "payload",
  "price", "price_mem", "priceMember", "price_member", "phone", "mobile", "wechat", "avatar",
]);

function object(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertAllowedFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string) {
  if (Object.keys(value).some((field) => FORBIDDEN_FIELDS.has(field.toLowerCase()))) {
    throw new Error(`${label} 包含禁止字段。`);
  }
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new Error(`${label} 包含未允许字段。`);
  }
}

function exactDate(value: unknown, label: string) {
  if (typeof value !== "string" || !DATE.test(value)) throw new Error(`${label} 格式无效。`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${label} 格式无效。`);
  return value;
}

function id(value: unknown, label: string, required = false) {
  if (value === null && !required) return null;
  if (typeof value !== "string" || !SOURCE_ID.test(value)) throw new Error(`${label} 格式无效。`);
  return value;
}

function sourceComponent(value: unknown, label: string) {
  const parsed = id(value, label, true)!;
  if (!SOURCE_COMPONENT.test(parsed) || /^0+$/u.test(parsed)) throw new Error(`${label} 格式无效。`);
  return parsed;
}

function sourceBranchComponent(value: unknown) {
  if (value === JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID) return value;
  return sourceComponent(value, "branchId");
}

function text(value: unknown, label: string, maximum = 240) {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} 格式无效。`);
  }
  return value;
}

function number(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 格式无效。`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 格式无效。`);
  }
  return value;
}

function nullableInteger(value: unknown, label: string, minimum: number, maximum: number) {
  return value === null ? null : integer(value, label, minimum, maximum);
}

function match(value: unknown, label: string): JiaowubaoCompletedLessonMatch {
  if (typeof value !== "string" || !MATCHES.has(value as JiaowubaoCompletedLessonMatch)) throw new Error(`${label} 格式无效。`);
  return value as JiaowubaoCompletedLessonMatch;
}

function role(value: unknown) {
  if (value !== "primary" && value !== "assistant" && value !== "third") throw new Error("teacher role 格式无效。");
  return value;
}

function parsedTeacher(value: unknown, schedule: boolean): JiaowubaoCompletedLessonTeacherLink | JiaowubaoCompletedScheduleTeacherEvidence {
  const teacher = object(value);
  if (!teacher) throw new Error("老师来源资料格式无效。");
  assertAllowedFields(teacher, schedule ? SCHEDULE_TEACHER_FIELDS : TEACHER_FIELDS, "老师来源资料");
  const parsed = {
    role: role(teacher.role),
    sourceTeacherId: id(teacher.sourceTeacherId, "sourceTeacherId"),
    sourceTeacherName: text(teacher.sourceTeacherName, "sourceTeacherName"),
    teacherId: id(teacher.teacherId, "teacherId"),
    teacherName: text(teacher.teacherName, "teacherName"),
    teacherMatch: match(teacher.teacherMatch, "teacherMatch"),
    ...(schedule ? { sourceTeacherHours: teacher.sourceTeacherHours === null ? null : number(teacher.sourceTeacherHours, "sourceTeacherHours", 0, 24) } : {}),
  };
  if ((parsed.teacherId === null) !== (parsed.teacherName === null)) throw new Error("老师匹配资料不一致。");
  if (parsed.teacherId !== null && (parsed.teacherMatch === "unmatched" || parsed.teacherMatch === "ambiguous" || parsed.teacherMatch === "trial_course_title")) {
    throw new Error("老师匹配状态不一致。");
  }
  if (parsed.teacherId === null && !["unmatched", "ambiguous"].includes(parsed.teacherMatch)) throw new Error("老师匹配状态不一致。");
  return Object.freeze(parsed) as JiaowubaoCompletedLessonTeacherLink | JiaowubaoCompletedScheduleTeacherEvidence;
}

function teacherArray(value: unknown, schedule: false): readonly JiaowubaoCompletedLessonTeacherLink[];
function teacherArray(value: unknown, schedule: true): readonly JiaowubaoCompletedScheduleTeacherEvidence[];
function teacherArray(value: unknown, schedule: boolean) {
  if (!Array.isArray(value) || value.length > 3) throw new Error("老师来源资料格式无效。");
  const parsed = value.map((teacher) => parsedTeacher(teacher, schedule));
  const order = new Map([["primary", 0], ["assistant", 1], ["third", 2]]);
  let previous = -1;
  const roles = new Set<string>();
  for (const teacher of parsed) {
    const item = teacher as JiaowubaoCompletedLessonTeacherLink;
    const next = order.get(item.role)!;
    if (roles.has(item.role) || next <= previous) throw new Error("老师来源资料角色重复或顺序无效。");
    roles.add(item.role);
    previous = next;
  }
  return Object.freeze(parsed);
}

function lessonItem(value: unknown): JiaowubaoCompletedLessonFeedItem {
  const item = object(value);
  if (!item) throw new Error("教务宝已消课明细格式无效。");
  assertAllowedFields(item, LESSON_FIELDS, "教务宝已消课明细");
  if (typeof item.isTrial !== "boolean") throw new Error("isTrial 格式无效。");
  const sourceKey = typeof item.sourceKey === "string" && LESSON_KEY.test(item.sourceKey) ? item.sourceKey : null;
  const parsed = {
    sourceKey,
    branchId: sourceBranchComponent(item.branchId),
    calendarId: sourceComponent(item.calendarId, "calendarId"),
    memberId: sourceComponent(item.memberId, "memberId"),
    memberName: text(item.memberName, "memberName"),
    lessonDate: exactDate(item.lessonDate, "lessonDate"),
    timeTitle: text(item.timeTitle, "timeTitle", 80),
    hours: number(item.hours, "hours", 0, 24),
    isTrial: item.isTrial,
    attendanceCode: nullableInteger(item.attendanceCode, "attendanceCode", -1, 99),
    attendanceTitle: text(item.attendanceTitle, "attendanceTitle", 80),
    courseTitle: text(item.courseTitle, "courseTitle"),
    teamTitle: text(item.teamTitle, "teamTitle"),
    studentId: id(item.studentId, "studentId"),
    studentName: text(item.studentName, "studentName"),
    displayStudentName: text(item.displayStudentName, "displayStudentName"),
    studentMatch: match(item.studentMatch, "studentMatch"),
    teachers: teacherArray(item.teachers, false),
  };
  if (!sourceKey || sourceKey !== `jwb-open-api:lesson:${parsed.branchId}:${parsed.calendarId}:${parsed.memberId}`) throw new Error("sourceKey 格式无效。");
  if ((parsed.studentId === null) !== (parsed.studentName === null)) throw new Error("学生匹配资料不一致。");
  if (parsed.studentId !== null && (parsed.studentMatch === "unmatched" || parsed.studentMatch === "ambiguous")) throw new Error("学生匹配状态不一致。");
  if (parsed.studentId === null && !["unmatched", "ambiguous"].includes(parsed.studentMatch)) throw new Error("学生匹配状态不一致。");
  return Object.freeze({ ...parsed, sourceKey });
}

function scheduleItem(value: unknown): JiaowubaoCompletedScheduleFeedEvent {
  const item = object(value);
  if (!item) throw new Error("教务宝已结课排课资料格式无效。");
  assertAllowedFields(item, SCHEDULE_FIELDS, "教务宝已结课排课资料");
  const sourceKey = typeof item.sourceKey === "string" && SCHEDULE_KEY.test(item.sourceKey) ? item.sourceKey : null;
  const parsed = {
    sourceKey,
    calendarId: sourceComponent(item.calendarId, "calendarId"),
    lessonDate: exactDate(item.lessonDate, "lessonDate"),
    timeTitle: text(item.timeTitle, "timeTitle", 80),
    courseTitle: text(item.courseTitle, "courseTitle"),
    teamTitle: text(item.teamTitle, "teamTitle"),
    teachers: teacherArray(item.teachers, true),
  };
  if (!sourceKey || sourceKey !== `jwb-open-api:schedule:${parsed.calendarId}`) throw new Error("schedule sourceKey 格式无效。");
  return Object.freeze({ ...parsed, sourceKey });
}

function expectedPageCount(rowCount: number) {
  return rowCount === 0 ? 0 : Math.ceil(rowCount / JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE);
}

function expectedPageItems(rowCount: number, pageIndex: number, pageCount: number) {
  if (pageCount !== expectedPageCount(rowCount) || pageCount > JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES
    || (rowCount === 0 && pageIndex !== 0)
    || (rowCount > 0 && (pageIndex < 0 || pageIndex >= pageCount))) return null;
  return rowCount === 0 ? 0 : Math.min(JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE, rowCount - pageIndex * JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE);
}

/** Parses one bounded, revision-pinned participant or schedule-evidence page. */
export function parseJiaowubaoCompletedMonthEvidencePage(value: unknown): JiaowubaoCompletedMonthEvidencePage {
  const page = object(value);
  if (!page) throw new Error("教务宝完成月度分页响应格式无效。");
  assertAllowedFields(page, PAGE_FIELDS, "教务宝完成月度分页响应");
  if ((page.state !== "absent" && page.state !== "complete" && page.state !== "reset")
    || (page.source !== "lessons" && page.source !== "schedules")
    || typeof page.month !== "string" || !MONTH.test(page.month) || !Array.isArray(page.items)) {
    throw new Error("教务宝完成月度分页资料无效。");
  }
  const source = page.source;
  const rowCount = integer(page.rowCount, "rowCount", 0, 6_000);
  const pageIndex = integer(page.pageIndex, "pageIndex", 0, JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES - 1);
  const pageCount = integer(page.pageCount, "pageCount", 0, JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES);
  const items = source === "lessons" ? page.items.map(lessonItem) : page.items.map(scheduleItem);
  if (new Set(items.map((item) => item.sourceKey)).size !== items.length) throw new Error("教务宝完成月度分页包含重复来源键。");
  if (page.state === "absent") {
    if (page.revision !== null || page.publishedAt !== null || page.projectionRevision !== null
      || rowCount !== 0 || pageIndex !== 0 || pageCount !== 0 || items.length) {
      throw new Error("教务宝完成月度空快照分页不一致。");
    }
    return Object.freeze({ state: "absent", source, month: page.month, revision: null, rowCount: 0, pageIndex: 0, pageCount: 0, publishedAt: null, projectionRevision: null, items: [] }) as JiaowubaoCompletedMonthEvidencePage;
  }
  if (typeof page.revision !== "string" || !SHA256.test(page.revision)
    || typeof page.publishedAt !== "string" || !Number.isFinite(new Date(page.publishedAt).valueOf())
    || pageCount !== expectedPageCount(rowCount)) throw new Error("教务宝完成月度快照分页元资料无效。");
  const publishedAt = new Date(page.publishedAt).toISOString();
  const projectionRevision = page.projectionRevision === null
    ? null
    : typeof page.projectionRevision === "string" && SHA256.test(page.projectionRevision)
      ? page.projectionRevision
      : (() => { throw new Error("教务宝完成月度映射版本无效。"); })();
  if (page.state === "reset") {
    if (items.length || projectionRevision !== null) throw new Error("教务宝完成月度重置分页不应含有明细。");
    return Object.freeze({ state: "reset", source, month: page.month, revision: page.revision, rowCount, pageIndex, pageCount, publishedAt, projectionRevision: null, items: [] }) as JiaowubaoCompletedMonthEvidencePage;
  }
  if (!projectionRevision) throw new Error("教务宝完成月度映射版本无效。");
  const expectedItems = expectedPageItems(rowCount, pageIndex, pageCount);
  if (expectedItems === null || items.length !== expectedItems) throw new Error("教务宝完成月度分页行数不一致。");
  return Object.freeze({ state: "complete", source, month: page.month, revision: page.revision, rowCount, pageIndex, pageCount, publishedAt, projectionRevision, items: Object.freeze(items) }) as JiaowubaoCompletedMonthEvidencePage;
}

function completeSourcePages<T extends JiaowubaoCompletedMonthEvidencePage>(pages: readonly T[], source: Source) {
  if (!pages.length) throw new Error("教务宝完成月度没有返回分页结果。");
  const first = pages[0]!;
  if (first.source !== source || first.state === "reset") throw new Error("教务宝完成月度快照已更新，请重新读取。");
  if (first.state === "absent") {
    if (pages.length !== 1 || first.items.length || first.rowCount !== 0 || first.pageIndex !== 0 || first.pageCount !== 0) {
      throw new Error("教务宝完成月度空快照分页不完整。");
    }
    return Object.freeze({ state: "absent" as const, month: first.month, revision: null, rowCount: 0, publishedAt: null, projectionRevision: null, items: [] as readonly T["items"][number][] });
  }
  const byIndex = new Map<number, T>();
  const sourceKeys = new Set<string>();
  for (const page of pages) {
    if (page.source !== source || page.state !== "complete" || page.month !== first.month || page.revision !== first.revision
      || page.rowCount !== first.rowCount || page.pageCount !== first.pageCount || page.projectionRevision !== first.projectionRevision || byIndex.has(page.pageIndex)
      || expectedPageItems(page.rowCount, page.pageIndex, page.pageCount) !== page.items.length) {
      throw new Error("教务宝完成月度分页不是同一份完整快照。");
    }
    byIndex.set(page.pageIndex, page);
    for (const item of page.items) {
      if (sourceKeys.has(item.sourceKey)) throw new Error("教务宝完成月度分页包含重复来源键。");
      sourceKeys.add(item.sourceKey);
    }
  }
  const expectedEntries = first.pageCount === 0 ? 1 : first.pageCount;
  if (pages.length !== expectedEntries || byIndex.size !== expectedEntries || sourceKeys.size !== first.rowCount) {
    throw new Error("教务宝完成月度分页尚未读取完成。");
  }
  const items: T["items"][number][] = [];
  for (let index = 0; index < first.pageCount; index += 1) {
    const page = byIndex.get(index);
    if (!page) throw new Error("教务宝完成月度分页缺失。");
    items.push(...page.items);
  }
  return Object.freeze({ state: "complete" as const, month: first.month, revision: first.revision, rowCount: first.rowCount, publishedAt: first.publishedAt, projectionRevision: first.projectionRevision, items: Object.freeze(items) });
}

/** Fails closed unless both source feeds are complete for the exact same revision. */
export function completeJiaowubaoCompletedMonthEvidencePages(input: Readonly<{
  lessonPages: readonly JiaowubaoCompletedLessonPage[];
  schedulePages: readonly JiaowubaoCompletedSchedulePage[];
}>): JiaowubaoCompletedLessonFeed {
  const lessons = completeSourcePages(input.lessonPages, "lessons");
  const schedules = completeSourcePages(input.schedulePages, "schedules");
  if (lessons.state === "absent" || schedules.state === "absent") {
    if (lessons.state !== "absent" || schedules.state !== "absent" || lessons.month !== schedules.month) {
      throw new Error("教务宝完成月度来源状态不一致。");
    }
    return Object.freeze({ state: "absent", month: lessons.month, revision: null, rowCount: 0, scheduleRowCount: 0, publishedAt: null, projectionRevision: null, items: [], scheduleEvents: [], teachers: [], teacherEvidenceSourceKeys: new Map(), matchedStudentCount: 0, unmatchedStudentCount: 0, ambiguousStudentCount: 0, matchedTeacherCount: 0, unmatchedTeacherCount: 0, ambiguousTeacherCount: 0 });
  }
  if (lessons.month !== schedules.month || lessons.revision !== schedules.revision || lessons.projectionRevision !== schedules.projectionRevision) {
    throw new Error("教务宝完成月度来源版本不一致。");
  }
  const items = lessons.items as readonly JiaowubaoCompletedLessonFeedItem[];
  const scheduleEvents = schedules.items as readonly JiaowubaoCompletedScheduleFeedEvent[];
  const reconciliation = reconcileJiaowubaoCompletedLessonEvidence(items, scheduleEvents);
  const countStudents = (value: JiaowubaoCompletedLessonMatch) => items.filter((item) => item.studentMatch === value).length;
  return Object.freeze({
    state: "complete",
    month: lessons.month,
    revision: lessons.revision,
    rowCount: lessons.rowCount,
    scheduleRowCount: schedules.rowCount,
    publishedAt: lessons.publishedAt,
    projectionRevision: lessons.projectionRevision,
    items,
    scheduleEvents,
    teachers: reconciliation.teachers,
    teacherEvidenceSourceKeys: reconciliation.teacherStudentSourceKeys,
    matchedStudentCount: countStudents("source_id") + countStudents("unique_name") + countStudents("trial_course_title"),
    unmatchedStudentCount: countStudents("unmatched"),
    ambiguousStudentCount: countStudents("ambiguous"),
    matchedTeacherCount: reconciliation.matchedTeacherCount,
    unmatchedTeacherCount: reconciliation.unmatchedTeacherCount,
    ambiguousTeacherCount: reconciliation.ambiguousTeacherCount,
  });
}
