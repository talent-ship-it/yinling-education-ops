import { createHash } from "node:crypto";

import {
  queryJiaowubaoCompletedLessonList,
  type JiaowubaoCompletedLessonListQuery,
  type JiaowubaoCompletedLessonListResponse,
} from "@/lib/jiaowubao-open-api-node";
import {
  isJiaowubaoCompletedLessonUnknownBranchId,
  JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID,
} from "@/lib/jiaowubao-completed-lesson-branch";

/**
 * Immutable, curated evidence feed for the monthly payroll worksheet.
 *
 * This module deliberately does not know about contracts, remaining hours,
 * pay rates, payroll approval, or ops_state.  It only turns the documented
 * completed-lesson source (`over=1`) into a bounded, deterministic snapshot.
 */
export const JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_FORMAT = "jiaowubao-completed-lesson-participant-export/v4";
export const JIAOWUBAO_COMPLETED_LESSON_COLLECTION_FORMAT = "jiaowubao-completed-lesson-member-collection/v1";
export const JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY = "jwb-open-api-completed-lessons";
export const JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE = 100;
export const JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_PAGES = 60;
export const JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_RECORDS = 6_000;
export const JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_WINDOW_DAYS = 31;
const JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_RECORD_BYTES = 8_192;

type JsonRecord = Record<string, unknown>;
// These three components are joined with `:` into the immutable source key.
// Delimiters are deliberately excluded so two upstream IDs can never encode
// to the same key (for example `a:b,c,d` versus `a,b:c,d`).
const COMPLETED_LESSON_SOURCE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const COMPLETED_LESSON_SOURCE_KEY = /^jwb-open-api:lesson:(?:~|[A-Za-z0-9][A-Za-z0-9._-]{0,159}):[A-Za-z0-9][A-Za-z0-9._-]{0,159}:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;

export type JiaowubaoCompletedLessonTeacherRole = "primary" | "assistant" | "third";

/**
 * The lesson endpoint returns a student row, but teacher assignment is a
 * lesson-level fact.  Preserve every documented teacher slot independently
 * so a group lesson cannot silently erase an assistant or third teacher.
 * The lesson endpoint documents teacher identities, but its `hours` field is
 * the learner's deducted class hours—not a teacher-credit field. Role-specific
 * teacher hours are retained separately from `query_schedule_list`.
 */
export type JiaowubaoCompletedLessonSourceTeacher = Readonly<{
  role: JiaowubaoCompletedLessonTeacherRole;
  id: string | null;
  name: string | null;
}>;

export type JiaowubaoCompletedLessonRecord = Readonly<{
  kind: "lesson";
  sourceKey: string;
  /** Explicitly records the source-state proof, rather than trusting a name. */
  completed: true;
  branchId: string;
  calendarId: string;
  memberId: string;
  memberName: string | null;
  lessonDate: string;
  timeTitle: string | null;
  hours: number;
  lessonType: number | null;
  isTrial: boolean;
  attendanceCode: number | null;
  attendanceTitle: string | null;
  courseId: string | null;
  courseTitle: string | null;
  teamId: string | null;
  teamTitle: string | null;
  teachers: readonly JiaowubaoCompletedLessonSourceTeacher[];
  completedAt: string | null;
}>;

export type JiaowubaoCompletedLessonSnapshotPage = Readonly<{
  page: number;
  records: readonly JiaowubaoCompletedLessonRecord[];
  sha256: string;
  file: string;
}>;

export type JiaowubaoCompletedLessonSnapshotManifest = Readonly<{
  format: typeof JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_FORMAT;
  source: "jiaowubao-open-api";
  tool: "query_lesson_list";
  query: Readonly<{ start: string; end: string; sign: -1; over: 1; limit: number }>;
  collection: JiaowubaoCompletedLessonCollectionProof | null;
  pageCount: number;
  recordCount: number;
  recordsSha256: string;
  manifestSha256: string;
  revision: string;
  pages: readonly Readonly<{ page: number; recordCount: number; sha256: string; file: string }>[];
}>;

/** Non-PII proof of the exact frozen member universe used for this snapshot. */
export type JiaowubaoCompletedLessonCollectionProof = Readonly<{
  format: typeof JIAOWUBAO_COMPLETED_LESSON_COLLECTION_FORMAT;
  memberSetSha256: string;
  memberCount: number;
  catalogRevisionSha256: string;
  catalogMemberCount: number;
  scheduleRevision: string;
  scheduleMemberSetSha256: string;
  scheduleMemberCount: number;
}>;

export type JiaowubaoCompletedLessonSnapshot = Readonly<{
  manifest: JiaowubaoCompletedLessonSnapshotManifest;
  pages: readonly JiaowubaoCompletedLessonSnapshotPage[];
}>;

export type JiaowubaoCompletedLessonSnapshotRow = Readonly<{
  sourceKey: string;
  record: JiaowubaoCompletedLessonRecord;
}>;

export type JiaowubaoCompletedLessonMemberPage = Readonly<{
  memberId: number;
  page: number;
  total: number;
  complete: boolean;
  records: readonly JiaowubaoCompletedLessonRecord[];
}>;

type PageFetcher = (query: JiaowubaoCompletedLessonListQuery) => Promise<JiaowubaoCompletedLessonListResponse>;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactDate(value: unknown, field: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail(`${field} 必须使用 YYYY-MM-DD。`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${field} 无效。`);
  }
  return value;
}

function parseWindow(input: Readonly<{ start: string; end: string }>) {
  const start = exactDate(input.start, "start");
  const end = exactDate(input.end, "end");
  if (end < start) fail("end 必须不早于 start。");
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  const days = (endMs - startMs) / (24 * 60 * 60 * 1_000) + 1;
  if (days > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_WINDOW_DAYS) {
    fail(`日期范围最多 ${JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_WINDOW_DAYS} 天。`);
  }
  return Object.freeze({ start, end });
}

/** A payroll snapshot is intentionally exactly one calendar month. */
export function validateJiaowubaoCompletedLessonMonth(value: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/u.test(value)) fail("month 必须使用 YYYY-MM。");
  const start = `${value}-01`;
  exactDate(start, "month");
  const endDate = new Date(`${start}T00:00:00.000Z`);
  endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  endDate.setUTCDate(0);
  const end = endDate.toISOString().slice(0, 10);
  return Object.freeze({ month: value, start, end });
}

function currentMelbourneMonth(now: Date) {
  if (Number.isNaN(now.valueOf())) fail("now 无效。");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const month = `${values.year}-${values.month}`;
  if (!/^\d{4}-\d{2}$/u.test(month)) fail("墨尔本当前月份无效。");
  return month;
}

/** A published payroll source must be a fully closed Melbourne month. */
export function validateJiaowubaoClosedCompletedLessonMonth(value: string, now = new Date()) {
  const period = validateJiaowubaoCompletedLessonMonth(value);
  if (period.month >= currentMelbourneMonth(now)) {
    fail("只能同步已完整结束的墨尔本自然月。");
  }
  return period;
}

function sourceId(value: unknown, field: string, required = false) {
  const raw = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!raw && !required) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(raw)) {
    fail(`教务宝已消课记录的 ${field} 无效。`);
  }
  return raw;
}

function sourceTeacherId(value: unknown, field: string) {
  // JiaoWuBao represents an unassigned assistant/third role with 0. It is
  // not an actual source identity and must not create a phantom teacher that
  // makes the cross-feed reconciliation fail closed.
  if (value === 0 || value === "0" || value === null || value === undefined || value === "") return null;
  return sourceId(value, field);
}

function sourceComponentKind(value: unknown) {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "number-nonfinite";
    if (!Number.isSafeInteger(value)) return "number-noninteger";
    return value < 0 ? "number-negative" : "number-format";
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return "string-blank";
    if (raw.length > 160) return "string-overlong";
    if (/[\u0000-\u001f\u007f]/u.test(raw)) return "string-control";
    if (raw.includes(":")) return "string-delimiter";
    return "string-format";
  }
  if (typeof value === "boolean") return value ? "boolean-true" : "boolean-false";
  if (Array.isArray(value)) return value.length === 0 ? "array-empty" : "array-nonempty";
  if (isRecord(value)) return Object.keys(value).length === 0 ? "object-empty" : "object-nonempty";
  return typeof value;
}

function completedLessonSourceComponent(value: unknown, field: string) {
  const component = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!COMPLETED_LESSON_SOURCE_COMPONENT.test(component) || /^0+$/u.test(component)) {
    // Only this fixed structural category reaches the private scheduler log.
    // Never include the source value, object keys, member ID, or response row.
    fail(`教务宝已消课记录的 ${field} 无效（${sourceComponentKind(value)}）。`);
  }
  return component;
}

function missingCompletedLessonSourceBranch(value: unknown) {
  if (value === undefined || value === null || value === 0) return true;
  if (typeof value !== "string") return false;
  if (value.length > 160) return false;
  const trimmed = value.trim();
  return !trimmed || /^0+$/u.test(trimmed);
}

function completedLessonSourceBranchId(value: unknown) {
  if (missingCompletedLessonSourceBranch(value)) {
    return JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID;
  }
  if (value === JIAOWUBAO_COMPLETED_LESSON_UNKNOWN_BRANCH_ID) {
    fail("教务宝已消课记录的 branch_id 无效（string-reserved）。");
  }
  const branchId = completedLessonSourceComponent(value, "branch_id");
  return branchId;
}

function completedLessonSnapshotBranchId(value: unknown) {
  if (typeof value === "string" && isJiaowubaoCompletedLessonUnknownBranchId(value)) return value;
  return completedLessonSourceComponent(value, "branchId");
}

function completedLessonSourceKey(value: unknown, expected: string) {
  if (typeof value !== "string" || value !== expected || value.length > 512 || !COMPLETED_LESSON_SOURCE_KEY.test(value)) {
    fail("已消课快照 sourceKey 无效。");
  }
  return value;
}

function text(value: unknown, field: string, maximum = 240) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail(`教务宝已消课记录的 ${field} 无效。`);
  const trimmed = value.trim().normalize("NFKC");
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    fail(`教务宝已消课记录的 ${field} 无效。`);
  }
  return trimmed;
}

function optionalInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`教务宝已消课记录的 ${field} 无效。`);
  }
  return parsed;
}

function requiredDecimal(value: unknown, field: string, minimum: number, maximum: number) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    fail(`教务宝已消课记录的 ${field} 无效。`);
  }
  // Store a canonical decimal rather than the supplier's original spelling.
  return Number(parsed.toFixed(4));
}

function completed(value: unknown) {
  if (value === 1 || value === "1" || value === true) return true;
  fail("教务宝已消课记录不属于 over=1 完成状态。");
}

function clockText(value: unknown) {
  const integer = optionalInteger(value, "time", 0, 2_359);
  if (integer === null) return null;
  if (integer % 100 > 59) fail("教务宝已消课记录的 time 无效。");
  return `${String(Math.floor(integer / 100)).padStart(2, "0")}:${String(integer % 100).padStart(2, "0")}`;
}

function timeTitle(value: JsonRecord) {
  const supplied = text(value.time_title, "time_title", 80);
  if (supplied) return supplied;
  const start = clockText(value.time_start);
  const end = clockText(value.time_end);
  return start && end ? `${start}-${end}` : start ?? end;
}

function sourceDate(value: unknown, window: Readonly<{ start: string; end: string }>) {
  const date = exactDate(value, "dated");
  if (date < window.start || date > window.end) {
    fail("教务宝已消课记录不在请求的日期范围内。");
  }
  return date;
}

const SOURCE_TEACHER_SLOTS = [
  { role: "primary", id: "teacher_id", name: "teacher_title" },
  { role: "assistant", id: "teacher_s", name: "teacher_s_title" },
  { role: "third", id: "teacher_t", name: "teacher_t_title" },
] as const satisfies readonly Readonly<{
  role: JiaowubaoCompletedLessonTeacherRole;
  id: string;
  name: string;
}>[];

const SOURCE_TEACHER_ROLE_ORDER = new Map<JiaowubaoCompletedLessonTeacherRole, number>([
  ["primary", 0],
  ["assistant", 1],
  ["third", 2],
]);

function completedLessonTeachers(value: JsonRecord) {
  return Object.freeze(SOURCE_TEACHER_SLOTS.flatMap((slot) => {
    const sourceTeacher = Object.freeze({
      role: slot.role,
      id: sourceTeacherId(value[slot.id], slot.id),
      name: text(value[slot.name], slot.name),
    });
    return sourceTeacher.id || sourceTeacher.name ? [sourceTeacher] : [];
  }));
}

function readCompletedLessonTeachers(value: unknown) {
  if (!Array.isArray(value) || value.length > SOURCE_TEACHER_SLOTS.length) {
    fail("已消课快照老师资料无效。");
  }
  const roles = new Set<JiaowubaoCompletedLessonTeacherRole>();
  let previousOrder = -1;
  return Object.freeze(value.map((candidate) => {
    if (!isRecord(candidate)
      || Object.keys(candidate).length !== 3
      || !Object.hasOwn(candidate, "role")
      || !Object.hasOwn(candidate, "id")
      || !Object.hasOwn(candidate, "name")) {
      fail("已消课快照老师资料无效。");
    }
    const role = candidate.role;
    if (role !== "primary" && role !== "assistant" && role !== "third") {
      fail("已消课快照老师资料无效。");
    }
    const order = SOURCE_TEACHER_ROLE_ORDER.get(role)!;
    if (roles.has(role) || order <= previousOrder) fail("已消课快照老师资料无效。");
    roles.add(role);
    previousOrder = order;
    const sourceTeacher = Object.freeze({
      role,
      id: sourceTeacherId(candidate.id, `teachers.${role}.id`),
      name: text(candidate.name, `teachers.${role}.name`),
    });
    if (!sourceTeacher.id && !sourceTeacher.name) {
      fail("已消课快照老师资料无效。");
    }
    return sourceTeacher;
  }));
}

function sha256Tag(value: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readCollectionProof(value: JiaowubaoCompletedLessonCollectionProof) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.format !== JIAOWUBAO_COMPLETED_LESSON_COLLECTION_FORMAT
    || !/^sha256:[a-f0-9]{64}$/u.test(value.memberSetSha256)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.catalogRevisionSha256)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.scheduleRevision)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.scheduleMemberSetSha256)
    || !Number.isSafeInteger(value.memberCount) || value.memberCount < 1 || value.memberCount > 6_000
    || !Number.isSafeInteger(value.catalogMemberCount) || value.catalogMemberCount < 1 || value.catalogMemberCount > value.memberCount
    || !Number.isSafeInteger(value.scheduleMemberCount) || value.scheduleMemberCount < 0 || value.scheduleMemberCount > value.memberCount) {
    fail("教务宝已消课学员清单证明无效。");
  }
  return Object.freeze({
    format: value.format,
    memberSetSha256: value.memberSetSha256,
    memberCount: value.memberCount,
    catalogRevisionSha256: value.catalogRevisionSha256,
    catalogMemberCount: value.catalogMemberCount,
    scheduleRevision: value.scheduleRevision,
    scheduleMemberSetSha256: value.scheduleMemberSetSha256,
    scheduleMemberCount: value.scheduleMemberCount,
  });
}

function canonicalJson(value: unknown) {
  return JSON.stringify(value);
}

function freezeCompletedLessonRecord(record: JiaowubaoCompletedLessonRecord) {
  if (Buffer.byteLength(canonicalJson(record), "utf8") > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_RECORD_BYTES) {
    fail("教务宝已消课记录超过数据库安全上限。");
  }
  return Object.freeze(record) as JiaowubaoCompletedLessonRecord;
}

/**
 * Curates the supplier record to the small, documented field set needed to
 * reconcile a monthly worksheet.  Price/contact/avatar/notes/raw payloads
 * are never included in this immutable source snapshot.
 */
export function projectJiaowubaoCompletedLessonRecord(
  value: unknown,
  window: Readonly<{ start: string; end: string }>,
): JiaowubaoCompletedLessonRecord {
  if (!isRecord(value)) fail("教务宝已消课记录无效。");
  completed(value.over);
  const branchId = completedLessonSourceBranchId(value.branch_id);
  const calendarId = completedLessonSourceComponent(value.cal_id, "cal_id");
  const memberId = completedLessonSourceComponent(value.mem_id, "mem_id");
  const lessonDate = sourceDate(value.dated, window);
  const hours = requiredDecimal(value.hours, "hours", 0, 24);
  const lessonType = optionalInteger(value.type, "type", 1, 5);
  const attendanceCode = optionalInteger(value.sign, "sign", -1, 99);
  const sourceKey = `jwb-open-api:lesson:${branchId}:${calendarId}:${memberId}`;
  return freezeCompletedLessonRecord({
    kind: "lesson",
    sourceKey,
    completed: true,
    branchId,
    calendarId,
    memberId,
    memberName: text(value.mem_title, "mem_title"),
    lessonDate,
    timeTitle: timeTitle(value),
    hours,
    lessonType,
    isTrial: lessonType === 3,
    attendanceCode,
    attendanceTitle: text(value.sign_title, "sign_title", 80),
    courseId: sourceId(value.course_id, "course_id"),
    courseTitle: text(value.course_title, "course_title"),
    teamId: sourceId(value.team_id, "team_id"),
    teamTitle: text(value.team_title, "team_title"),
    teachers: completedLessonTeachers(value),
    completedAt: text(value.over_time, "over_time", 80),
  });
}

const COMPLETED_LESSON_RECORD_FIELDS = Object.freeze([
  "kind", "sourceKey", "completed", "branchId", "calendarId", "memberId", "memberName", "lessonDate", "timeTitle",
  "hours", "lessonType", "isTrial", "attendanceCode", "attendanceTitle", "courseId", "courseTitle", "teamId",
  "teamTitle", "teachers", "completedAt",
] as const);

/**
 * Re-validates the curated database DTO before an API route maps it into an
 * operational view.  A private SQL reader is not a reason to trust an
 * unexpected or widened payload in a payroll browser response.
 */
export function readJiaowubaoCompletedLessonSnapshotRecord(value: unknown): JiaowubaoCompletedLessonRecord {
  if (!isRecord(value)) fail("已消课快照记录无效。");
  const fields = Object.keys(value);
  if (fields.length !== COMPLETED_LESSON_RECORD_FIELDS.length
    || COMPLETED_LESSON_RECORD_FIELDS.some((field) => !Object.hasOwn(value, field))) {
    fail("已消课快照记录字段无效。");
  }
  if (value.kind !== "lesson" || value.completed !== true || typeof value.isTrial !== "boolean") fail("已消课快照记录状态无效。");
  const branchId = completedLessonSnapshotBranchId(value.branchId);
  const calendarId = completedLessonSourceComponent(value.calendarId, "calendarId");
  const memberId = completedLessonSourceComponent(value.memberId, "memberId");
  const lessonDate = exactDate(value.lessonDate, "lessonDate");
  const hours = requiredDecimal(value.hours, "hours", 0, 24);
  const lessonType = optionalInteger(value.lessonType, "lessonType", 1, 5);
  if (value.isTrial !== (lessonType === 3)) fail("已消课快照试听状态无效。");
  const attendanceCode = optionalInteger(value.attendanceCode, "attendanceCode", -1, 99);
  const expectedSourceKey = `jwb-open-api:lesson:${branchId}:${calendarId}:${memberId}`;
  const sourceKey = completedLessonSourceKey(value.sourceKey, expectedSourceKey);
  return freezeCompletedLessonRecord({
    kind: "lesson",
    sourceKey,
    completed: true,
    branchId,
    calendarId,
    memberId,
    memberName: text(value.memberName, "memberName"),
    lessonDate,
    timeTitle: text(value.timeTitle, "timeTitle", 80),
    hours,
    lessonType,
    isTrial: value.isTrial,
    attendanceCode,
    attendanceTitle: text(value.attendanceTitle, "attendanceTitle", 80),
    courseId: sourceId(value.courseId, "courseId"),
    courseTitle: text(value.courseTitle, "courseTitle"),
    teamId: sourceId(value.teamId, "teamId"),
    teamTitle: text(value.teamTitle, "teamTitle"),
    teachers: readCompletedLessonTeachers(value.teachers),
    completedAt: text(value.completedAt, "completedAt", 80),
  });
}

function pageRecords(response: JiaowubaoCompletedLessonListResponse) {
  if (!Array.isArray(response.list)) fail("教务宝已消课返回的 list 无效。");
  return response.list as readonly JsonRecord[];
}

/**
 * Reads one durable-crawl page for one exact JWB member ID. The supplier's
 * scoped `total` is pinned on page one and must remain identical on every
 * later page; a short page can therefore never be mistaken for completion.
 */
export async function collectJiaowubaoCompletedLessonMemberPage(
  rawWindow: Readonly<{ start: string; end: string }>,
  memberId: number,
  page: number,
  expectedTotal: number | null,
  fetchPage: PageFetcher = queryJiaowubaoCompletedLessonList,
): Promise<JiaowubaoCompletedLessonMemberPage> {
  const window = parseWindow(rawWindow);
  if (!Number.isSafeInteger(memberId) || memberId < 1) fail("教务宝已消课学员 ID 无效。");
  if (!Number.isSafeInteger(page) || page < 1 || page > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_PAGES) {
    fail("教务宝已消课学员分页无效。");
  }
  if (expectedTotal !== null && (!Number.isSafeInteger(expectedTotal) || expectedTotal < 0
    || expectedTotal > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_RECORDS)) {
    fail("教务宝已消课学员总数无效。");
  }
  const response = await fetchPage({
    start: window.start,
    end: window.end,
    mem_id: memberId,
    page,
    limit: JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE,
    sign: -1,
  });
  if (!Number.isSafeInteger(response.total) || response.total < 0
    || response.total > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_RECORDS) {
    fail("教务宝已消课学员总数无效。");
  }
  if (expectedTotal !== null && response.total !== expectedTotal) {
    fail("教务宝已消课学员总数在分页期间发生变化。");
  }
  const totalPages = Math.max(1, Math.ceil(response.total / JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE));
  if (page > totalPages) fail("教务宝已消课学员分页超过来源总数。");
  const rawRecords = pageRecords(response);
  const expectedRows = response.total === 0
    ? 0
    : Math.min(
      JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE,
      response.total - (page - 1) * JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE,
    );
  if (rawRecords.length !== expectedRows) fail("教务宝已消课学员分页行数与来源总数不一致。");
  const records = rawRecords.map((record) => projectJiaowubaoCompletedLessonRecord(record, window));
  const sourceKeys = new Set<string>();
  for (const record of records) {
    if (record.memberId !== String(memberId)) fail("教务宝已消课学员分页返回了其他学员资料。");
    if (sourceKeys.has(record.sourceKey)) fail("教务宝已消课学员分页包含重复来源键。");
    sourceKeys.add(record.sourceKey);
  }
  return Object.freeze({
    memberId,
    page,
    total: response.total,
    complete: page === totalPages,
    records: Object.freeze(records),
  });
}

export async function collectJiaowubaoCompletedLessonSnapshot(
  rawWindow: Readonly<{ start: string; end: string }>,
  fetchPage: PageFetcher = queryJiaowubaoCompletedLessonList,
): Promise<JiaowubaoCompletedLessonSnapshot> {
  const window = parseWindow(rawWindow);
  const pageManifests: Array<{ page: number; recordCount: number; sha256: string; file: string }> = [];
  const pages: JiaowubaoCompletedLessonSnapshotPage[] = [];
  const sourceKeys = new Set<string>();
  let recordCount = 0;
  let previousPageHash: string | undefined;

  // A source month may legitimately fill all 60 bounded data pages. Request
  // one additional probe page so completion is still proven by the supplier's
  // explicit empty response without allowing a 61st data page into the
  // snapshot.
  for (let page = 1; page <= JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_PAGES + 1; page += 1) {
    const response = await fetchPage({
      start: window.start,
      end: window.end,
      page,
      limit: JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE,
      sign: -1,
    });
    const rawRecords = pageRecords(response);
    if (rawRecords.length > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE) {
      fail("教务宝已消课单页数据超过安全上限。");
    }
    if (rawRecords.length === 0) break;
    if (page > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_PAGES) {
      fail("教务宝已消课导出超过最大页数，已停止导出。");
    }
    const records = rawRecords.map((record) => projectJiaowubaoCompletedLessonRecord(record, window));
    for (const record of records) {
      if (sourceKeys.has(record.sourceKey)) {
        fail("教务宝已消课导出包含重复课节学员记录，已停止导出。");
      }
      sourceKeys.add(record.sourceKey);
    }
    const serialized = canonicalJson(records);
    const pageHash = sha256Tag(serialized);
    if (pageHash === previousPageHash) fail("教务宝已消课返回了重复页面，已停止导出。");
    previousPageHash = pageHash;
    const file = `page-${String(page).padStart(4, "0")}.json`;
    pageManifests.push({ page, recordCount: records.length, sha256: pageHash, file });
    pages.push(Object.freeze({ page, records: Object.freeze(records), sha256: pageHash, file }));
    recordCount += records.length;
    if (recordCount > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_RECORDS) {
      fail("教务宝已消课导出记录超过安全上限。");
    }
    // The documented endpoint has no total/has-more contract.  A short page
    // therefore proves nothing: continue until the server explicitly returns
    // an empty page, otherwise a supplier page cap could publish a truncated
    // month as if it were complete.
  }

  const recordsSha256 = sha256Tag(canonicalJson(pageManifests.map(({ page, recordCount: count, sha256 }) => ({
    page,
    recordCount: count,
    sha256,
  }))));
  const manifestPayload = {
    format: JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_FORMAT as typeof JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_FORMAT,
    source: "jiaowubao-open-api" as const,
    tool: "query_lesson_list" as const,
    query: {
      start: window.start,
      end: window.end,
      sign: -1 as const,
      over: 1 as const,
      limit: JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE,
    },
    // This legacy injected-fetch collector is retained for fixture validation
    // only. Production publication requires a non-null frozen-member proof.
    collection: null,
    pageCount: pageManifests.length,
    recordCount,
    recordsSha256,
    pages: pageManifests,
  };
  const manifestSha256 = sha256Tag(canonicalJson(manifestPayload));
  return Object.freeze({
    manifest: Object.freeze({ ...manifestPayload, manifestSha256, revision: manifestSha256 }),
    pages: Object.freeze(pages),
  });
}

/** Builds the standard immutable snapshot after every frozen member is done. */
export function buildJiaowubaoCompletedLessonSnapshot(
  rawWindow: Readonly<{ start: string; end: string }>,
  sourceRecords: readonly JiaowubaoCompletedLessonRecord[],
  collectionProof: JiaowubaoCompletedLessonCollectionProof,
): JiaowubaoCompletedLessonSnapshot {
  const window = parseWindow(rawWindow);
  const collection = readCollectionProof(collectionProof);
  if (!Array.isArray(sourceRecords) || sourceRecords.length > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_MAX_RECORDS) {
    fail("教务宝已消课导出记录超过安全上限。");
  }
  const sourceKeys = new Set<string>();
  const records = sourceRecords.map((record) => {
    const checked = readJiaowubaoCompletedLessonSnapshotRecord(record);
    if (checked.lessonDate < window.start || checked.lessonDate > window.end) {
      fail("教务宝已消课记录不在请求的日期范围内。");
    }
    if (sourceKeys.has(checked.sourceKey)) fail("教务宝已消课导出包含重复课节学员记录，已停止导出。");
    sourceKeys.add(checked.sourceKey);
    return checked;
  }).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey, "en"));

  const pages: JiaowubaoCompletedLessonSnapshotPage[] = [];
  const pageManifests: Array<{ page: number; recordCount: number; sha256: string; file: string }> = [];
  for (let offset = 0; offset < records.length; offset += JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE) {
    const page = pages.length + 1;
    const pageRecordsValue = Object.freeze(records.slice(offset, offset + JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE));
    const sha256 = sha256Tag(canonicalJson(pageRecordsValue));
    const file = `page-${String(page).padStart(4, "0")}.json`;
    pageManifests.push({ page, recordCount: pageRecordsValue.length, sha256, file });
    pages.push(Object.freeze({ page, records: pageRecordsValue, sha256, file }));
  }
  const recordsSha256 = sha256Tag(canonicalJson(pageManifests.map(({ page, recordCount, sha256 }) => ({
    page,
    recordCount,
    sha256,
  }))));
  const manifestPayload = {
    format: JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_FORMAT as typeof JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_FORMAT,
    source: "jiaowubao-open-api" as const,
    tool: "query_lesson_list" as const,
    query: {
      start: window.start,
      end: window.end,
      sign: -1 as const,
      over: 1 as const,
      limit: JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE,
    },
    collection,
    pageCount: pageManifests.length,
    recordCount: records.length,
    recordsSha256,
    pages: pageManifests,
  };
  const manifestSha256 = sha256Tag(canonicalJson(manifestPayload));
  return Object.freeze({
    manifest: Object.freeze({ ...manifestPayload, manifestSha256, revision: manifestSha256 }),
    pages: Object.freeze(pages),
  });
}

export function jiaowubaoCompletedLessonSnapshotRows(snapshot: JiaowubaoCompletedLessonSnapshot) {
  return Object.freeze(snapshot.pages.flatMap((page) => page.records.map((record) => Object.freeze({
    sourceKey: record.sourceKey,
    record,
  }))));
}

/**
 * Re-hashes the frozen source pages immediately before a downstream caller
 * relies on their manifest. This binds the captured supplier-page hashes to
 * the exact curated records that will be staged, rather than treating the
 * metadata as an informational label.
 */
export function assertJiaowubaoCompletedLessonSnapshotIntegrity(snapshot: JiaowubaoCompletedLessonSnapshot) {
  const manifest = snapshot.manifest;
  if (manifest.format !== JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_FORMAT
    || manifest.source !== "jiaowubao-open-api"
    || manifest.tool !== "query_lesson_list"
    || manifest.query.sign !== -1 || manifest.query.over !== 1
    || manifest.query.limit !== JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE
    || manifest.pages.length !== snapshot.pages.length
    || manifest.pageCount !== snapshot.pages.length) {
    fail("教务宝已消课快照清单无效。");
  }
  if (manifest.collection !== null) readCollectionProof(manifest.collection);
  const sourceKeys = new Set<string>();
  const pages = snapshot.pages.map((page, index) => {
    if (page.page !== index + 1 || page.records.length < 1 || page.records.length > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE) {
      fail("教务宝已消课快照分页无效。");
    }
    for (const record of page.records) {
      // Re-parse before hashing so a caller cannot smuggle widened objects
      // through a forged in-memory snapshot type.
      const checked = readJiaowubaoCompletedLessonSnapshotRecord(record);
      if (sourceKeys.has(checked.sourceKey)) fail("教务宝已消课快照包含重复来源键。");
      sourceKeys.add(checked.sourceKey);
    }
    const sha256 = sha256Tag(canonicalJson(page.records));
    if (sha256 !== page.sha256) fail("教务宝已消课快照分页散列不一致。");
    const expected = manifest.pages[index];
    if (!expected || expected.page !== page.page || expected.recordCount !== page.records.length
      || expected.sha256 !== page.sha256 || expected.file !== page.file) {
      fail("教务宝已消课快照分页清单不一致。");
    }
    return { page: page.page, recordCount: page.records.length, sha256: page.sha256 };
  });
  if (manifest.recordCount !== sourceKeys.size) fail("教务宝已消课快照行数不一致。");
  const recordsSha256 = sha256Tag(canonicalJson(pages));
  if (recordsSha256 !== manifest.recordsSha256) fail("教务宝已消课快照记录散列不一致。");
  const manifestPayload = {
    format: manifest.format,
    source: manifest.source,
    tool: manifest.tool,
    query: manifest.query,
    collection: manifest.collection,
    pageCount: manifest.pageCount,
    recordCount: manifest.recordCount,
    recordsSha256: manifest.recordsSha256,
    pages: manifest.pages,
  };
  const manifestSha256 = sha256Tag(canonicalJson(manifestPayload));
  if (manifestSha256 !== manifest.manifestSha256 || manifest.revision !== manifestSha256) {
    fail("教务宝已消课快照清单散列不一致。");
  }
}

export function buildJiaowubaoCompletedLessonSnapshotEnvelope(
  snapshot: JiaowubaoCompletedLessonSnapshot,
  expectedCurrentRevision: string | null,
) {
  if (expectedCurrentRevision !== null && !/^sha256:[a-f0-9]{64}$/u.test(expectedCurrentRevision)) {
    fail("当前已消课快照 revision 无效。");
  }
  assertJiaowubaoCompletedLessonSnapshotIntegrity(snapshot);
  if (snapshot.manifest.collection === null) {
    fail("教务宝已消课发布缺少逐学员完整性证明。");
  }
  const month = snapshot.manifest.query.start.slice(0, 7);
  return Object.freeze({
    apiSourceKey: JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY,
    month,
    revision: snapshot.manifest.revision,
    query: snapshot.manifest.query,
    expectedPageCount: snapshot.manifest.pageCount,
    expectedRowCount: snapshot.manifest.recordCount,
    expectedCurrentRevision,
    externalManifestSha256: snapshot.manifest.manifestSha256,
    sourceMetadata: {
      exportFormat: snapshot.manifest.format,
      manifestSha256: snapshot.manifest.manifestSha256,
      recordsSha256: snapshot.manifest.recordsSha256,
    },
  });
}

export function assertJiaowubaoCompletedLessonSnapshotPageBytes(rows: readonly JiaowubaoCompletedLessonSnapshotRow[]) {
  if (rows.length < 1 || rows.length > JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_PAGE_SIZE
    || Buffer.byteLength(JSON.stringify(rows), "utf8") > 2 * 1024 * 1024) {
    fail("已消课快照页超过数据库安全上限。");
  }
}


export function allJiaowubaoCompletedLessonRecords(snapshot: JiaowubaoCompletedLessonSnapshot) {
  return Object.freeze(snapshot.pages.flatMap((page) => page.records));
}
