import { createHash } from "node:crypto";

import {
  queryJiaowubaoScheduleList,
  type JiaowubaoScheduleListQuery,
  type JiaowubaoScheduleListResponse,
} from "@/lib/jiaowubao-open-api-node";

/**
 * Immutable, curated teacher-credit evidence for a completed reporting month.
 *
 * `query_lesson_list` is the authoritative participant roster, while the
 * gateway documentation explicitly assigns role-specific teacher hours to
 * `query_schedule_list`. Keeping the two feeds separate prevents a group
 * lesson's student rows from being mistaken for teacher payroll credits.
 */
export const JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_FORMAT = "jiaowubao-completed-schedule-evidence/v1";
export const JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_PAGE_SIZE = 100;
export const JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_MAX_PAGES = 60;
export const JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_MAX_RECORDS = 6_000;
export const JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_WINDOW_DAYS = 31;
const JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_MAX_RECORD_BYTES = 8_192;

type JsonRecord = Record<string, unknown>;

const SOURCE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SOURCE_KEY = /^jwb-open-api:schedule:[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;

export type JiaowubaoCompletedScheduleTeacherRole = "primary" | "assistant" | "third";

export type JiaowubaoCompletedScheduleTeacher = Readonly<{
  role: JiaowubaoCompletedScheduleTeacherRole;
  id: string | null;
  name: string | null;
  hours: number | null;
}>;

export type JiaowubaoCompletedScheduleRecord = Readonly<{
  kind: "schedule";
  sourceKey: string;
  completed: true;
  calendarId: string;
  lessonDate: string;
  timeTitle: string | null;
  courseId: string | null;
  courseTitle: string | null;
  teamId: string | null;
  teamTitle: string | null;
  teachers: readonly JiaowubaoCompletedScheduleTeacher[];
  completedAt: string | null;
}>;

export type JiaowubaoCompletedScheduleSnapshotPage = Readonly<{
  page: number;
  records: readonly JiaowubaoCompletedScheduleRecord[];
  sha256: string;
  file: string;
}>;

export type JiaowubaoCompletedScheduleSnapshotManifest = Readonly<{
  format: typeof JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_FORMAT;
  source: "jiaowubao-open-api";
  tool: "query_schedule_list";
  query: Readonly<{ start: string; end: string; over: 1; limit: number; order: "asc" }>;
  pageCount: number;
  recordCount: number;
  recordsSha256: string;
  manifestSha256: string;
  revision: string;
  pages: readonly Readonly<{ page: number; recordCount: number; sha256: string; file: string }>[];
}>;

export type JiaowubaoCompletedScheduleSnapshot = Readonly<{
  manifest: JiaowubaoCompletedScheduleSnapshotManifest;
  pages: readonly JiaowubaoCompletedScheduleSnapshotPage[];
}>;

/** Server-only capture metadata used to freeze the lesson-query roster. */
export type JiaowubaoCompletedScheduleSnapshotWithMemberIds = Readonly<{
  snapshot: JiaowubaoCompletedScheduleSnapshot;
  memberIds: readonly number[];
  memberSetSha256: string;
}>;

type PageFetcher = (query: JiaowubaoScheduleListQuery) => Promise<JiaowubaoScheduleListResponse>;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactDate(value: unknown, field: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${field} 必须使用 YYYY-MM-DD。`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(`${field} 无效。`);
  return value;
}

function parseWindow(input: Readonly<{ start: string; end: string }>) {
  const start = exactDate(input.start, "start");
  const end = exactDate(input.end, "end");
  if (end < start) fail("end 必须不早于 start。");
  const days = (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (days > JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_WINDOW_DAYS) {
    fail(`日期范围最多 ${JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_WINDOW_DAYS} 天。`);
  }
  return Object.freeze({ start, end });
}

function sourceId(value: unknown, field: string, required = false) {
  const raw = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!raw && !required) return null;
  if (!SOURCE_ID.test(raw)) fail(`教务宝已结课排课的 ${field} 无效。`);
  return raw;
}

function sourceComponent(value: unknown, field: string) {
  const parsed = sourceId(value, field, true)!;
  if (!SOURCE_COMPONENT.test(parsed)) fail(`教务宝已结课排课的 ${field} 无效。`);
  return parsed;
}

function sourceTeacherId(value: unknown, field: string) {
  // The vendor represents an absent secondary/third teacher as 0. It is not
  // an identity and must never become an accidental teacher link.
  if (value === 0 || value === "0" || value === null || value === undefined || value === "") return null;
  return sourceId(value, field);
}

function text(value: unknown, field: string, maximum = 240) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail(`教务宝已结课排课的 ${field} 无效。`);
  const parsed = value.trim().normalize("NFKC");
  if (!parsed || parsed.length > maximum || /[\u0000-\u001f\u007f]/u.test(parsed)) {
    fail(`教务宝已结课排课的 ${field} 无效。`);
  }
  return parsed;
}

function sourceTeamTitleKind(value: unknown) {
  if (typeof value === "number") return value === 0 ? "number-zero" : "number-nonzero";
  if (typeof value === "boolean") return value ? "boolean-true" : "boolean-false";
  if (Array.isArray(value)) return value.length === 0 ? "array-empty" : "array-nonempty";
  if (isRecord(value)) return Object.keys(value).length === 0 ? "object-empty" : "object-nonempty";
  return typeof value;
}

function sourceTeamTitle(value: unknown) {
  // This field has used legacy sentinel shapes. Until a shape is explicitly
  // confirmed, fail closed while exposing only a fixed structural category in
  // the private scheduler log—never the source value, object keys, or row.
  if (value === 0) return null;
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const parsed = value.trim().normalize("NFKC");
    // Optional team titles in older one-to-one rows can be whitespace-only.
    // Treat that exactly like the already-supported empty-string sentinel.
    if (!parsed) return null;
    if (parsed.length > 240) fail("教务宝已结课排课的 team_title 无效（string-overlong）。");
    if (/[\u0000-\u001f\u007f]/u.test(parsed)) {
      fail("教务宝已结课排课的 team_title 无效（string-control）。");
    }
    return parsed;
  }
  fail(`教务宝已结课排课的 team_title 无效（${sourceTeamTitleKind(value)}）。`);
}

function optionalDecimal(value: unknown, field: string, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    fail(`教务宝已结课排课的 ${field} 无效。`);
  }
  return Number(parsed.toFixed(4));
}

function optionalInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`教务宝已结课排课的 ${field} 无效。`);
  }
  return parsed;
}

function clockText(value: unknown) {
  const integer = optionalInteger(value, "time", 0, 2_359);
  if (integer === null) return null;
  if (integer % 100 > 59) fail("教务宝已结课排课的 time 无效。");
  return `${String(Math.floor(integer / 100)).padStart(2, "0")}:${String(integer % 100).padStart(2, "0")}`;
}

function timeTitle(value: JsonRecord) {
  const supplied = text(value.time_title, "time_title", 80);
  if (supplied) return supplied;
  const start = clockText(value.time_start);
  const end = clockText(value.time_end);
  return start && end ? `${start}-${end}` : start ?? end;
}

function completed(value: unknown) {
  if (value === 1 || value === "1" || value === true) return true;
  fail("教务宝排课记录不属于 over=1 完成状态。");
}

const TEACHER_SLOTS = [
  { role: "primary", id: "teacher_id", name: "teacher_title", hours: "teacher_hour" },
  { role: "assistant", id: "teacher_s", name: "teacher_s_title", hours: "teacher_s_hour" },
  { role: "third", id: "teacher_t", name: "teacher_t_title", hours: "teacher_t_hour" },
] as const satisfies readonly Readonly<{
  role: JiaowubaoCompletedScheduleTeacherRole;
  id: string;
  name: string;
  hours: string;
}>[];

const ROLE_ORDER = new Map<JiaowubaoCompletedScheduleTeacherRole, number>([
  ["primary", 0],
  ["assistant", 1],
  ["third", 2],
]);

function scheduleTeachers(value: JsonRecord) {
  return Object.freeze(TEACHER_SLOTS.flatMap((slot) => {
    const teacher = Object.freeze({
      role: slot.role,
      id: sourceTeacherId(value[slot.id], slot.id),
      name: text(value[slot.name], slot.name),
      hours: optionalDecimal(value[slot.hours], slot.hours, 0, 24),
    });
    // The supplier emits 0/blank/0 for an unused assistant or third slot.
    // Keep positive hours without an identity as unresolved evidence, but do
    // not let a fully empty zero-hour sentinel create a phantom teacher role.
    return teacher.id || teacher.name || (teacher.hours !== null && teacher.hours !== 0) ? [teacher] : [];
  }));
}

function sha256Tag(value: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(value);
}

function freezeCompletedScheduleRecord(record: JiaowubaoCompletedScheduleRecord) {
  if (Buffer.byteLength(canonicalJson(record), "utf8") > JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_MAX_RECORD_BYTES) {
    fail("教务宝已结课排课记录超过数据库安全上限。");
  }
  return Object.freeze(record) as JiaowubaoCompletedScheduleRecord;
}

/** Retains only the documented fields required to evidence a teacher credit. */
export function projectJiaowubaoCompletedScheduleRecord(
  value: unknown,
  window: Readonly<{ start: string; end: string }>,
): JiaowubaoCompletedScheduleRecord {
  if (!isRecord(value)) fail("教务宝已结课排课记录无效。");
  completed(value.over);
  const calendarId = sourceComponent(value.cal_id, "cal_id");
  const lessonDate = exactDate(value.dated, "dated");
  if (lessonDate < window.start || lessonDate > window.end) fail("教务宝已结课排课不在请求日期范围内。");
  return freezeCompletedScheduleRecord({
    kind: "schedule",
    sourceKey: `jwb-open-api:schedule:${calendarId}`,
    completed: true,
    calendarId,
    lessonDate,
    timeTitle: timeTitle(value),
    courseId: sourceId(value.course_id, "course_id"),
    courseTitle: text(value.course_title, "course_title"),
    teamId: sourceId(value.team_id, "team_id"),
    // Older one-to-one rows use numeric 0 or a blank string as the supplier's
    // no-team-title sentinel. Normalize only those raw boundary sentinels;
    // persisted DTOs remain strictly validated and every nonblank invalid
    // source shape still fails closed.
    teamTitle: sourceTeamTitle(value.team_title),
    teachers: scheduleTeachers(value),
    completedAt: text(value.over_time, "over_time", 80),
  });
}

const RECORD_FIELDS = Object.freeze([
  "kind", "sourceKey", "completed", "calendarId", "lessonDate", "timeTitle", "courseId", "courseTitle",
  "teamId", "teamTitle", "teachers", "completedAt",
] as const);

function readScheduleTeachers(value: unknown) {
  if (!Array.isArray(value) || value.length > TEACHER_SLOTS.length) fail("已结课排课快照老师资料无效。");
  const roles = new Set<JiaowubaoCompletedScheduleTeacherRole>();
  let previousOrder = -1;
  return Object.freeze(value.map((candidate) => {
    if (!isRecord(candidate) || Object.keys(candidate).length !== 4
      || !Object.hasOwn(candidate, "role") || !Object.hasOwn(candidate, "id")
      || !Object.hasOwn(candidate, "name") || !Object.hasOwn(candidate, "hours")) {
      fail("已结课排课快照老师资料无效。");
    }
    const role = candidate.role;
    if (role !== "primary" && role !== "assistant" && role !== "third") fail("已结课排课快照老师资料无效。");
    const order = ROLE_ORDER.get(role)!;
    if (roles.has(role) || order <= previousOrder) fail("已结课排课快照老师资料无效。");
    roles.add(role);
    previousOrder = order;
    const teacher = Object.freeze({
      role,
      id: sourceTeacherId(candidate.id, `teachers.${role}.id`),
      name: text(candidate.name, `teachers.${role}.name`),
      hours: optionalDecimal(candidate.hours, `teachers.${role}.hours`, 0, 24),
    });
    if (!teacher.id && !teacher.name && teacher.hours === null) fail("已结课排课快照老师资料无效。");
    return teacher;
  }));
}

/** Re-validates a private database DTO before it reaches a route projection. */
export function readJiaowubaoCompletedScheduleSnapshotRecord(value: unknown): JiaowubaoCompletedScheduleRecord {
  if (!isRecord(value) || Object.keys(value).length !== RECORD_FIELDS.length
    || RECORD_FIELDS.some((field) => !Object.hasOwn(value, field))) {
    fail("已结课排课快照记录字段无效。");
  }
  if (value.kind !== "schedule" || value.completed !== true) fail("已结课排课快照记录状态无效。");
  const calendarId = sourceComponent(value.calendarId, "calendarId");
  const sourceKey = typeof value.sourceKey === "string" ? value.sourceKey : "";
  if (sourceKey !== `jwb-open-api:schedule:${calendarId}` || !SOURCE_KEY.test(sourceKey)) {
    fail("已结课排课快照 sourceKey 无效。");
  }
  return freezeCompletedScheduleRecord({
    kind: "schedule",
    sourceKey,
    completed: true,
    calendarId,
    lessonDate: exactDate(value.lessonDate, "lessonDate"),
    timeTitle: text(value.timeTitle, "timeTitle", 80),
    courseId: sourceId(value.courseId, "courseId"),
    courseTitle: text(value.courseTitle, "courseTitle"),
    teamId: sourceId(value.teamId, "teamId"),
    teamTitle: text(value.teamTitle, "teamTitle"),
    teachers: readScheduleTeachers(value.teachers),
    completedAt: text(value.completedAt, "completedAt", 80),
  });
}

function pageRecords(response: JiaowubaoScheduleListResponse) {
  if (!Array.isArray(response.lists)) fail("教务宝已结课排课返回的 lists 无效。");
  return response.lists as readonly JsonRecord[];
}

function completedScheduleMemberIds(value: JsonRecord) {
  if (!Array.isArray(value.stu_list)) fail("教务宝已结课排课的 stu_list 无效。");
  return value.stu_list.map((candidate) => {
    if (!isRecord(candidate)) fail("教务宝已结课排课的 stu_list 无效。");
    const raw = typeof candidate.mem_id === "number"
      ? candidate.mem_id
      : typeof candidate.mem_id === "string" && /^[1-9]\d*$/u.test(candidate.mem_id.trim())
        ? Number(candidate.mem_id)
        : Number.NaN;
    if (!Number.isSafeInteger(raw) || raw < 1) fail("教务宝已结课排课的 mem_id 无效。");
    return raw;
  });
}

async function collectJiaowubaoCompletedScheduleSnapshotInternal(
  rawWindow: Readonly<{ start: string; end: string }>,
  fetchPage: PageFetcher,
  captureMemberIds: boolean,
): Promise<JiaowubaoCompletedScheduleSnapshotWithMemberIds> {
  const window = parseWindow(rawWindow);
  const pages: JiaowubaoCompletedScheduleSnapshotPage[] = [];
  const manifests: Array<{ page: number; recordCount: number; sha256: string; file: string }> = [];
  const sourceKeys = new Set<string>();
  const sourceMemberIds = new Set<number>();
  let previousPageHash: string | undefined;
  let recordCount = 0;

  // A source month may legitimately fill all 60 bounded data pages. Request
  // one additional probe page so completion is still proven by the supplier's
  // explicit empty response without allowing a 61st data page into the
  // snapshot.
  for (let page = 1; page <= JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_MAX_PAGES + 1; page += 1) {
    const response = await fetchPage({ start: window.start, end: window.end, over: 1, order: "asc", page, limit: JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_PAGE_SIZE });
    const rawRecords = pageRecords(response);
    if (rawRecords.length > JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_PAGE_SIZE) fail("教务宝已结课排课单页数据超过安全上限。");
    if (rawRecords.length === 0) break;
    if (page > JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_MAX_PAGES) fail("教务宝已结课排课导出超过最大页数，已停止导出。");
    if (captureMemberIds) {
      for (const rawRecord of rawRecords) {
        for (const memberId of completedScheduleMemberIds(rawRecord)) sourceMemberIds.add(memberId);
      }
    }
    const records = rawRecords.map((record) => projectJiaowubaoCompletedScheduleRecord(record, window));
    for (const record of records) {
      if (sourceKeys.has(record.sourceKey)) fail("教务宝已结课排课导出包含重复课节，已停止导出。");
      sourceKeys.add(record.sourceKey);
    }
    const pageHash = sha256Tag(canonicalJson(records));
    if (pageHash === previousPageHash) fail("教务宝已结课排课返回了重复页面，已停止导出。");
    previousPageHash = pageHash;
    const file = `page-${String(page).padStart(4, "0")}.json`;
    manifests.push({ page, recordCount: records.length, sha256: pageHash, file });
    pages.push(Object.freeze({ page, records: Object.freeze(records), sha256: pageHash, file }));
    recordCount += records.length;
    if (recordCount > JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_MAX_RECORDS) fail("教务宝已结课排课导出记录超过安全上限。");
    // The published gateway contract has no has-more/total field. A short
    // page does not prove completion; only an explicit empty page does.
  }

  const recordsSha256 = sha256Tag(canonicalJson(manifests.map(({ page, recordCount: count, sha256 }) => ({ page, recordCount: count, sha256 }))));
  const payload = {
    format: JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_FORMAT as typeof JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_FORMAT,
    source: "jiaowubao-open-api" as const,
    tool: "query_schedule_list" as const,
    query: { start: window.start, end: window.end, over: 1 as const, limit: JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_PAGE_SIZE, order: "asc" as const },
    pageCount: manifests.length,
    recordCount,
    recordsSha256,
    pages: manifests,
  };
  const manifestSha256 = sha256Tag(canonicalJson(payload));
  const snapshot = Object.freeze({
    manifest: Object.freeze({ ...payload, manifestSha256, revision: manifestSha256 }),
    pages: Object.freeze(pages),
  });
  const memberIds = Object.freeze([...sourceMemberIds].sort((left, right) => left - right));
  return Object.freeze({
    snapshot,
    memberIds,
    // SQL independently recomputes this ID-only digest before freezing the
    // crawl. A newline-delimited decimal encoding is unambiguous and shared
    // byte-for-byte by Node and PostgreSQL.
    memberSetSha256: sha256Tag(memberIds.join("\n")),
  });
}

export async function collectJiaowubaoCompletedScheduleSnapshot(
  rawWindow: Readonly<{ start: string; end: string }>,
  fetchPage: PageFetcher = queryJiaowubaoScheduleList,
): Promise<JiaowubaoCompletedScheduleSnapshot> {
  return (await collectJiaowubaoCompletedScheduleSnapshotInternal(rawWindow, fetchPage, false)).snapshot;
}

/**
 * Captures the raw schedule participant IDs only long enough to freeze the
 * private, per-member lesson crawl. Names and the supplier `stu_list` never
 * enter the published schedule snapshot or a browser response.
 */
export async function collectJiaowubaoCompletedScheduleSnapshotWithMemberIds(
  rawWindow: Readonly<{ start: string; end: string }>,
  fetchPage: PageFetcher = queryJiaowubaoScheduleList,
): Promise<JiaowubaoCompletedScheduleSnapshotWithMemberIds> {
  return collectJiaowubaoCompletedScheduleSnapshotInternal(rawWindow, fetchPage, true);
}

export function allJiaowubaoCompletedScheduleRecords(snapshot: JiaowubaoCompletedScheduleSnapshot) {
  return Object.freeze(snapshot.pages.flatMap((page) => page.records));
}

/** Re-hashes the curated schedule source before its manifest is trusted. */
export function assertJiaowubaoCompletedScheduleSnapshotIntegrity(snapshot: JiaowubaoCompletedScheduleSnapshot) {
  const manifest = snapshot.manifest;
  if (manifest.format !== JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_FORMAT
    || manifest.source !== "jiaowubao-open-api"
    || manifest.tool !== "query_schedule_list"
    || manifest.query.over !== 1 || manifest.query.limit !== JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_PAGE_SIZE
    || manifest.query.order !== "asc"
    || manifest.pages.length !== snapshot.pages.length
    || manifest.pageCount !== snapshot.pages.length) {
    fail("教务宝已结课排课快照清单无效。");
  }
  const sourceKeys = new Set<string>();
  const pages = snapshot.pages.map((page, index) => {
    if (page.page !== index + 1 || page.records.length < 1 || page.records.length > JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_PAGE_SIZE) {
      fail("教务宝已结课排课快照分页无效。");
    }
    for (const record of page.records) {
      const checked = readJiaowubaoCompletedScheduleSnapshotRecord(record);
      if (sourceKeys.has(checked.sourceKey)) fail("教务宝已结课排课快照包含重复来源键。");
      sourceKeys.add(checked.sourceKey);
    }
    const sha256 = sha256Tag(canonicalJson(page.records));
    if (sha256 !== page.sha256) fail("教务宝已结课排课快照分页散列不一致。");
    const expected = manifest.pages[index];
    if (!expected || expected.page !== page.page || expected.recordCount !== page.records.length
      || expected.sha256 !== page.sha256 || expected.file !== page.file) {
      fail("教务宝已结课排课快照分页清单不一致。");
    }
    return { page: page.page, recordCount: page.records.length, sha256: page.sha256 };
  });
  if (manifest.recordCount !== sourceKeys.size) fail("教务宝已结课排课快照行数不一致。");
  const recordsSha256 = sha256Tag(canonicalJson(pages));
  if (recordsSha256 !== manifest.recordsSha256) fail("教务宝已结课排课记录散列不一致。");
  const manifestPayload = {
    format: manifest.format,
    source: manifest.source,
    tool: manifest.tool,
    query: manifest.query,
    pageCount: manifest.pageCount,
    recordCount: manifest.recordCount,
    recordsSha256: manifest.recordsSha256,
    pages: manifest.pages,
  };
  const manifestSha256 = sha256Tag(canonicalJson(manifestPayload));
  if (manifestSha256 !== manifest.manifestSha256 || manifest.revision !== manifestSha256) {
    fail("教务宝已结课排课快照清单散列不一致。");
  }
}

export function assertJiaowubaoCompletedScheduleSnapshotPageBytes(rows: readonly Readonly<{
  sourceKey: string;
  record: JiaowubaoCompletedScheduleRecord;
}>[]) {
  if (rows.length < 1 || rows.length > JIAOWUBAO_COMPLETED_SCHEDULE_SNAPSHOT_PAGE_SIZE
    || Buffer.byteLength(JSON.stringify(rows), "utf8") > 2 * 1024 * 1024) {
    fail("已结课排课快照页超过数据库安全上限。");
  }
}
