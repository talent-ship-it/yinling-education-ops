import type {
  getJiaowubaoCompletedLessonSnapshotPage,
  JiaowubaoCompletedLessonSnapshotPage,
  OpsStateRow,
} from "./ops-store";
import { readJiaowubaoCompletedLessonSnapshotRecord, validateJiaowubaoClosedCompletedLessonMonth } from "./jiaowubao-completed-lessons";
import { readJiaowubaoCompletedScheduleSnapshotRecord } from "./jiaowubao-completed-schedule";
import { projectJiaowubaoCompletedLessonRecords } from "./jiaowubao-completed-lesson-projection";
import { monthlyHourCoverage, melbourneHourDate } from "./monthly-hour-period";
import { JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES, JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE } from "./jiaowubao-completed-lesson-pagination";
import { buildOpsAccessContext, canReadOpsEntity } from "./ops-access";
import type { DemoSessionIdentity } from "./demo-session-token";
import { monthlyHourDiscrepancies, type MonthlyHourDiscrepancy, type MonthlyHourDiscrepancyScope } from "./jiaowubao-monthly-hour-discrepancies";

const STATE_ENTITIES = ["students", "teachers", "bookings", "lpItems"];
type Page = JiaowubaoCompletedLessonSnapshotPage;
type PageReader = typeof getJiaowubaoCompletedLessonSnapshotPage;
type Metadata = Readonly<{ revision: string; rowCount: number; pageCount: number; publishedAt: string; end: string }>;
export type MonthlyHourDiscrepancyReport = Readonly<{
  month: string;
  defaultMonth: string;
  revision: string;
  publishedAt: string;
  rows: readonly MonthlyHourDiscrepancy[];
  operationsOwners: readonly string[];
}>;

export class MonthlyHourDiscrepancyError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

function unavailable(): never {
  throw new MonthlyHourDiscrepancyError("snapshot_unavailable", 503, "该月份尚无完整的月度课时记录。");
}

function changed(): never {
  throw new MonthlyHourDiscrepancyError("snapshot_changed", 409, "月度课时记录已更新，请重新查询。");
}

function defaultMonth(now: Date) {
  const date = new Date(`${melbourneHourDate(now).slice(0, 7)}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

function periodFor(month: string | undefined, now: Date) {
  try { return validateJiaowubaoClosedCompletedLessonMonth(month ?? defaultMonth(now), now); }
  catch { throw new MonthlyHourDiscrepancyError("invalid_month", 400, "请选择已完整结束的墨尔本自然月。"); }
}

function accessScope(rows: readonly OpsStateRow[], session: DemoSessionIdentity, fullAdmin: boolean): MonthlyHourDiscrepancyScope {
  const access = buildOpsAccessContext([...rows], session.user, fullAdmin, session);
  if (session.role === "teacher" || !canReadOpsEntity(access, "students") || !canReadOpsEntity(access, "bookings")) {
    throw new MonthlyHourDiscrepancyError("forbidden", 403, "当前账号不能查看月度课时核查。");
  }
  return { studentIds: access.studentIds, includeUnmatched: (access.fullAdmin || access.limitedAdmin) && !access.restrictedStudentScope };
}

function stateRevision(rows: readonly OpsStateRow[]) {
  return JSON.stringify(STATE_ENTITIES.map((entity) => {
    const matches = rows.filter((row) => row.entity === entity);
    const row = matches[0];
    if (matches.length !== 1 || !row || !Array.isArray(row.payload) || !Number.isSafeInteger(row.version) || row.version < 1 || !Number.isFinite(Date.parse(row.updated_at))) unavailable();
    return { entity, version: row.version, updatedAt: row.updated_at };
  }));
}

function completePage(page: Page, month: string, index: number) {
  if (page.state === "reset") changed();
  if (page.state !== "complete" || page.month !== month || page.pageIndex !== index || !Array.isArray(page.items)) unavailable();
}

function publishedPage(page: Page) {
  if (!page.revision || !/^sha256:[a-f0-9]{64}$/u.test(page.revision) || !page.publishedAt || !Number.isFinite(Date.parse(page.publishedAt))) unavailable();
  return { revision: page.revision, publishedAt: new Date(page.publishedAt).toISOString() };
}

function pageCountFor(rowCount: number) {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > 6_000) unavailable();
  return Math.ceil(rowCount / JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE);
}

function boundedPage(page: Page, index: number) {
  const count = pageCountFor(page.rowCount);
  if (page.pageCount !== count || count > JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES || (count > 0 && index >= count)) unavailable();
  const expectedRows = Math.min(JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE, Math.max(0, page.rowCount - index * JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE));
  if (page.items.length !== expectedRows) unavailable();
}

function metadata(page: Page, month: string, index: number): Metadata {
  completePage(page, month, index);
  const publication = publishedPage(page);
  boundedPage(page, index);
  let coverage;
  try { coverage = monthlyHourCoverage(month, page.dataThrough, page.provisional); } catch { unavailable(); }
  if (coverage.provisional) unavailable();
  return { ...publication, rowCount: page.rowCount, pageCount: page.pageCount, end: coverage.end };
}

function wrapperKey(wrapper: Page["items"][number]) {
  if (!wrapper || Object.keys(wrapper).length !== 2 || typeof wrapper.sourceKey !== "string"
    || !wrapper.record || typeof wrapper.record !== "object" || Array.isArray(wrapper.record)) unavailable();
  return wrapper.sourceKey;
}

function pinnedPage(page: Page, month: string, index: number, expected: Metadata) {
  const actual = metadata(page, month, index);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) changed();
}

async function completeSource(read: PageReader, month: string, first: Page) {
  const expected = metadata(first, month, 0);
  const pages = [first];
  for (let start = 1; start < expected.pageCount; start += 4) {
    const indexes = Array.from({ length: Math.min(4, expected.pageCount - start) }, (_, offset) => start + offset);
    const batch = await Promise.all(indexes.map((pageIndex) => read({ month, pageIndex, revision: expected.revision, actor: "Ops Admin" })));
    batch.forEach((page, offset) => pinnedPage(page, month, indexes[offset]!, expected));
    pages.push(...batch);
  }
  const wrappers = pages.flatMap((page) => page.items);
  if (new Set(wrappers.map(wrapperKey)).size !== wrappers.length) unavailable();
  return { wrappers, metadata: expected };
}

function validRecords<T extends Readonly<{ sourceKey: string; lessonDate: string }>>(
  wrappers: Page["items"], parse: (value: unknown) => T, period: Readonly<{ start: string; end: string }>,
): T[] {
  try {
    return wrappers.map((wrapper) => {
      const item = parse(wrapper.record);
      if (item.sourceKey !== wrapper.sourceKey || item.lessonDate < period.start || item.lessonDate > period.end) unavailable();
      return item;
    });
  } catch { unavailable(); }
}

export async function getMonthlyHourDiscrepancyReport(
  input: Readonly<{ month?: string; owner?: string; now?: Date; session: DemoSessionIdentity; fullAdmin: boolean }>,
  dependencies: Readonly<{ readLessons?: PageReader; readSchedules?: PageReader; readState?: () => Promise<OpsStateRow[]> }> = {},
): Promise<MonthlyHourDiscrepancyReport> {
  const now = input.now ?? new Date();
  const period = periodFor(input.month, now);
  const readState = dependencies.readState ?? (async () => (await import("./ops-store")).getOpsState(STATE_ENTITIES));
  const stateRows = await readState();
  const scope = accessScope(stateRows, input.session, input.fullAdmin);
  const stateVersion = stateRevision(stateRows);
  const readLessons: PageReader = dependencies.readLessons ?? (async (query) => (await import("./ops-store")).getJiaowubaoCompletedLessonSnapshotPage(query));
  const readSchedules: PageReader = dependencies.readSchedules ?? (async (query) => (await import("./ops-store")).getJiaowubaoCompletedScheduleSnapshotPage(query));
  const lessonFirst = await readLessons({ month: period.month, pageIndex: 0, revision: null, actor: "Ops Admin" });
  const lessonMetadata = metadata(lessonFirst, period.month, 0);
  const scheduleFirst = await readSchedules({ month: period.month, pageIndex: 0, revision: lessonMetadata.revision, actor: "Ops Admin" });
  const [lessons, schedules] = await Promise.all([completeSource(readLessons, period.month, lessonFirst), completeSource(readSchedules, period.month, scheduleFirst)]);
  if (lessons.metadata.revision !== schedules.metadata.revision || lessons.metadata.end !== schedules.metadata.end || lessons.metadata.publishedAt !== schedules.metadata.publishedAt) changed();
  const records = validRecords(lessons.wrappers, readJiaowubaoCompletedLessonSnapshotRecord, period);
  const scheduleRecords = validRecords(schedules.wrappers, readJiaowubaoCompletedScheduleSnapshotRecord, period);
  const projection = projectJiaowubaoCompletedLessonRecords({ records, scheduleRecords, stateRows });
  const [lastLessons, lastSchedules, freshState] = await Promise.all([
    readLessons({ month: period.month, pageIndex: 0, revision: lessonMetadata.revision, actor: "Ops Admin" }),
    readSchedules({ month: period.month, pageIndex: 0, revision: lessonMetadata.revision, actor: "Ops Admin" }),
    readState(),
  ]);
  pinnedPage(lastLessons, period.month, 0, lessons.metadata);
  pinnedPage(lastSchedules, period.month, 0, schedules.metadata);
  if (stateRevision(freshState) !== stateVersion) changed();
  return { month: period.month, defaultMonth: defaultMonth(now), revision: lessonMetadata.revision, publishedAt: lessonMetadata.publishedAt, ...monthlyHourDiscrepancies({ projection, stateRows, scope, owner: input.owner }) };
}
