import { createHash } from "node:crypto";

import {
  queryJiaowubaoScheduleList,
  type JiaowubaoScheduleListQuery,
  type JiaowubaoScheduleListResponse,
} from "@/lib/jiaowubao-open-api-node";

export const JIAOWUBAO_SCHEDULE_SNAPSHOT_FORMAT = "jiaowubao-schedule-export/v2";
export const JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY = "jwb-open-api-schedule";
export const JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE = 100;
// The cron runs within Vercel's five-minute function budget while deliberately
// leaving the supplier's 20 calls/minute quota headroom. At 3.2 seconds per
// upstream page, 60 pages remains below that budget. A larger source fails
// closed and the prior complete snapshot stays current.
export const JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_PAGES = 60;
export const JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_RECORDS = 6_000;
export const JIAOWUBAO_SCHEDULE_SNAPSHOT_WINDOW_DAYS = 31;
export const JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_STUDENTS_PER_RECORD = 1_000;

type JsonRecord = Record<string, unknown>;

/**
 * This is the documented schedule record surface, minus every price field.
 * The source is private evidence only: no field here creates a student,
 * Booking, package, payroll record, attendance record, or AVA permission.
 */
export const JIAOWUBAO_SCHEDULE_SNAPSHOT_FIELDS = [
  "cal_id", "type", "appoint", "team_id", "team_title", "course_id", "course_title",
  "room_id", "room_title", "teacher_id", "teacher_title", "teacher_hour",
  "teacher_s", "teacher_s_title", "teacher_s_hour", "teacher_t", "teacher_t_title", "teacher_t_hour",
  "dated", "time_start", "time_end", "cal_length", "hours", "cont", "created", "color", "live",
  "max_num", "mem_max", "mem_num", "mem_num_sign", "mem_num_not_sign", "mem_num_leave",
  "mem_leave", "mem_arrive", "arrive_percent", "mem_not_comment", "all_leave", "over",
  "over_state", "over_time", "ks_num", "ks_mem", "ks_reception", "ks_not", "try_arrive", "stu_list",
] as const;

export const JIAOWUBAO_SCHEDULE_STUDENT_FIELDS = [
  "lesson_id", "mem_id", "type", "name", "logo", "sign", "sign_title", "arrive_title", "comment", "is_wx",
] as const;

export type JiaowubaoScheduleSnapshotRecord = JsonRecord;
export type JiaowubaoScheduleSnapshotPage = Readonly<{
  page: number;
  records: readonly JiaowubaoScheduleSnapshotRecord[];
  sha256: string;
  file: string;
}>;
export type JiaowubaoScheduleSnapshotManifest = Readonly<{
  format: typeof JIAOWUBAO_SCHEDULE_SNAPSHOT_FORMAT;
  source: "jiaowubao-open-api";
  tool: "query_schedule_list";
  query: Readonly<{ start: string; end: string; limit: number; order: "asc" }>;
  pageCount: number;
  recordCount: number;
  recordsSha256: string;
  manifestSha256: string;
  revision: string;
  pages: readonly Readonly<{ page: number; recordCount: number; sha256: string; file: string }>[];
}>;
export type JiaowubaoScheduleSnapshot = Readonly<{
  manifest: JiaowubaoScheduleSnapshotManifest;
  pages: readonly JiaowubaoScheduleSnapshotPage[];
}>;
export type JiaowubaoScheduleSnapshotRow = Readonly<{
  sourceKey: string;
  record: JiaowubaoScheduleSnapshotRecord;
}>;

type PageFetcher = (query: JiaowubaoScheduleListQuery) => Promise<JiaowubaoScheduleListResponse>;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown) {
  return JSON.stringify(value);
}

function sha256Tag(value: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail(`${field} 必须使用 YYYY-MM-DD。`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    fail(`${field} 无效。`);
  }
  return date;
}

export function validateJiaowubaoScheduleSnapshotWindow(input: Readonly<{ start: string; end: string }>) {
  const startDate = parseDate(input.start, "start");
  const endDate = parseDate(input.end, "end");
  if (endDate < startDate) fail("end 必须不早于 start。");
  const days = (endDate.valueOf() - startDate.valueOf()) / (24 * 60 * 60 * 1_000) + 1;
  if (days > JIAOWUBAO_SCHEDULE_SNAPSHOT_WINDOW_DAYS) {
    fail(`日期范围最多 ${JIAOWUBAO_SCHEDULE_SNAPSHOT_WINDOW_DAYS} 天。`);
  }
  return Object.freeze({ start: input.start, end: input.end });
}

function normalizedCalId(value: unknown) {
  const raw = typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(raw)) {
    fail("教务宝排课记录缺少有效 cal_id。");
  }
  return raw;
}

function projectStudentEvidence(value: unknown) {
  if (!isRecord(value)) fail("教务宝排课学员记录无效。");
  const projected: JsonRecord = {};
  for (const field of JIAOWUBAO_SCHEDULE_STUDENT_FIELDS) {
    if (value[field] !== undefined && value[field] !== null) projected[field] = value[field];
  }
  return Object.freeze(projected);
}

/** Preserves every documented non-price field, with a strict structural allowlist. */
export function projectJiaowubaoScheduleSnapshotRecord(value: unknown): JiaowubaoScheduleSnapshotRecord {
  if (!isRecord(value)) fail("教务宝返回的排课记录无效。");
  const projected: JsonRecord = { cal_id: normalizedCalId(value.cal_id) };
  for (const field of JIAOWUBAO_SCHEDULE_SNAPSHOT_FIELDS) {
    if (field === "cal_id" || field === "stu_list") continue;
    if (value[field] !== undefined && value[field] !== null) projected[field] = value[field];
  }
  if (value.stu_list !== undefined && value.stu_list !== null) {
    if (!Array.isArray(value.stu_list) || value.stu_list.length > JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_STUDENTS_PER_RECORD) {
      fail("教务宝排课学员明细无效。");
    }
    projected.stu_list = value.stu_list.map(projectStudentEvidence);
  }
  if (Buffer.byteLength(JSON.stringify(projected), "utf8") > 256 * 1024) {
    fail("教务宝单条排课记录超过安全上限。");
  }
  return Object.freeze(projected);
}

export function jiaowubaoScheduleSnapshotSourceKey(value: unknown) {
  return `jwb-open-api:schedule:${normalizedCalId(isRecord(value) ? value.cal_id : value)}`;
}

function pageRecords(response: JiaowubaoScheduleListResponse) {
  if (!Array.isArray(response.lists)) fail("教务宝返回的 lists 无效。");
  return response.lists as readonly JsonRecord[];
}

export async function collectJiaowubaoScheduleSnapshot(
  rawWindow: Readonly<{ start: string; end: string }>,
  fetchPage: PageFetcher = queryJiaowubaoScheduleList,
): Promise<JiaowubaoScheduleSnapshot> {
  const window = validateJiaowubaoScheduleSnapshotWindow(rawWindow);
  const pageManifests: Array<{ page: number; recordCount: number; sha256: string; file: string }> = [];
  const pages: JiaowubaoScheduleSnapshotPage[] = [];
  const sourceCalIds = new Set<string>();
  let recordCount = 0;
  let previousPageHash: string | undefined;

  for (let page = 1; page <= JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_PAGES; page += 1) {
    const response = await fetchPage({
      start: window.start,
      end: window.end,
      page,
      limit: JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE,
      order: "asc",
    });
    const rawRecords = pageRecords(response);
    if (rawRecords.length > JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE) {
      fail("教务宝返回的单页数据超过上限。");
    }
    if (rawRecords.length === 0) break;
    const records = rawRecords.map(projectJiaowubaoScheduleSnapshotRecord);
    for (const record of records) {
      const calId = String(record.cal_id);
      if (sourceCalIds.has(calId)) fail("教务宝排课导出包含重复 cal_id，已停止导出。");
      sourceCalIds.add(calId);
    }
    const serialized = canonicalJson(records);
    const pageHash = sha256Tag(serialized);
    if (pageHash === previousPageHash) fail("教务宝返回了重复页面，已停止导出。");
    previousPageHash = pageHash;
    const file = `page-${String(page).padStart(4, "0")}.json`;
    pageManifests.push({ page, recordCount: records.length, sha256: pageHash, file });
    pages.push(Object.freeze({ page, records: Object.freeze(records), sha256: pageHash, file }));
    recordCount += records.length;
    if (recordCount > JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_RECORDS) fail("教务宝导出记录超过安全上限。");
    if (records.length < JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE) break;
    if (page === JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_PAGES) fail("教务宝导出超过最大页数，已停止导出。");
  }

  const recordsSha256 = sha256Tag(canonicalJson(pageManifests.map(({ page, recordCount: count, sha256 }) => ({
    page,
    recordCount: count,
    sha256,
  }))));
  const manifestPayload = {
    format: JIAOWUBAO_SCHEDULE_SNAPSHOT_FORMAT as typeof JIAOWUBAO_SCHEDULE_SNAPSHOT_FORMAT,
    source: "jiaowubao-open-api" as const,
    tool: "query_schedule_list" as const,
    query: { start: window.start, end: window.end, limit: JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE, order: "asc" as const },
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

export function jiaowubaoScheduleSnapshotRows(snapshot: JiaowubaoScheduleSnapshot): readonly JiaowubaoScheduleSnapshotRow[] {
  return Object.freeze(snapshot.pages.flatMap((page) => page.records.map((record) => Object.freeze({
    sourceKey: jiaowubaoScheduleSnapshotSourceKey(record),
    record,
  }))));
}

export function buildJiaowubaoScheduleSnapshotEnvelope(
  snapshot: JiaowubaoScheduleSnapshot,
  expectedCurrentRevision: string | null,
) {
  if (expectedCurrentRevision !== null && !/^sha256:[a-f0-9]{64}$/u.test(expectedCurrentRevision)) {
    fail("当前快照 revision 无效。");
  }
  return Object.freeze({
    apiSourceKey: JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
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

export function assertJiaowubaoScheduleSnapshotPageBytes(rows: readonly JiaowubaoScheduleSnapshotRow[]) {
  if (rows.length < 1 || rows.length > JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE
    || Buffer.byteLength(JSON.stringify(rows), "utf8") > 2 * 1024 * 1024) {
    fail("排课快照页超过数据库安全上限。");
  }
}
