import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { readJiaowubaoCompletedLessonSnapshotRecord } from "@/lib/jiaowubao-completed-lessons";
import { readJiaowubaoCompletedScheduleSnapshotRecord } from "@/lib/jiaowubao-completed-schedule";
import { projectJiaowubaoCompletedLessonRecords } from "@/lib/jiaowubao-completed-lesson-projection";
import {
  JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES,
  JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE,
} from "@/lib/jiaowubao-completed-lesson-pagination";
import {
  type JiaowubaoCompletedLessonSnapshotPage,
  type OpsStateRow,
} from "@/lib/ops-store";

type JsonRecord = Record<string, unknown>;

export class JiaowubaoPayrollAuthorityError extends Error {}

function fail(): never {
  throw new JiaowubaoPayrollAuthorityError("jiaowubao_payroll_source_unverified");
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function projectionRevision(rows: readonly OpsStateRow[]) {
  const entries = ["students", "teachers"].map((entity) => {
    const matches = rows.filter((row) => row.entity === entity);
    const row = matches[0];
    const date = row && typeof row.updated_at === "string" ? new Date(row.updated_at) : null;
    if (matches.length !== 1 || !row || !Number.isSafeInteger(row.version) || row.version < 0
      || !date || !Number.isFinite(date.valueOf())) fail();
    return { entity, version: row.version, updatedAt: date.toISOString() };
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

function changedSummaries(currentPayload: unknown, nextPayload: unknown) {
  if (!Array.isArray(currentPayload) || !Array.isArray(nextPayload)) fail();
  const current = new Map(currentPayload.map((value) => {
    const row = record(value);
    return [row?.id, row] as const;
  }));
  return nextPayload.map(record).filter((row): row is JsonRecord => Boolean(row && row.source === "jiaowubao-completed-lessons"
    && !isDeepStrictEqual(row, current.get(row.id))));
}

function assertPage(page: JiaowubaoCompletedLessonSnapshotPage, month: string, revision: string, index: number,
  expected: Readonly<{ rowCount: number; pageCount: number }> | null) {
  if (page.state !== "complete" || page.month !== month || page.revision !== revision
    || page.pageIndex !== index || !Number.isSafeInteger(page.rowCount) || page.rowCount < 0 || page.rowCount > 6_000
    || page.pageCount !== Math.ceil(page.rowCount / JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE)
    || page.pageCount > JIAOWUBAO_COMPLETED_LESSON_BROWSER_MAX_PAGES
    || (expected && (page.rowCount !== expected.rowCount || page.pageCount !== expected.pageCount))
    || page.items.length !== Math.min(JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE,
      Math.max(0, page.rowCount - index * JIAOWUBAO_COMPLETED_LESSON_BROWSER_PAGE_SIZE))) fail();
  return { rowCount: page.rowCount, pageCount: page.pageCount };
}

async function readSource(month: string, revision: string, source: "lessons" | "schedules") {
  const { getJiaowubaoCompletedLessonSnapshotPage, getJiaowubaoCompletedScheduleSnapshotPage } = await import("@/lib/ops-store");
  const read = source === "lessons" ? getJiaowubaoCompletedLessonSnapshotPage : getJiaowubaoCompletedScheduleSnapshotPage;
  const first = await read({ month, pageIndex: 0, revision, actor: "Ops Admin" });
  const metadata = assertPage(first, month, revision, 0, null);
  const pages = [first];
  for (let start = 1; start < metadata.pageCount; start += 4) {
    const indexes = Array.from({ length: Math.min(4, metadata.pageCount - start) }, (_, offset) => start + offset);
    const batch = await Promise.all(indexes.map((pageIndex) => read({ month, pageIndex, revision, actor: "Ops Admin" })));
    batch.forEach((page, offset) => assertPage(page, month, revision, indexes[offset]!, metadata));
    pages.push(...batch);
  }
  const keys = new Set<string>();
  const wrappers = pages.flatMap((page) => page.items.map((wrapper) => {
    if (!wrapper || typeof wrapper.sourceKey !== "string" || !record(wrapper.record)
      || keys.has(wrapper.sourceKey)) fail();
    keys.add(wrapper.sourceKey);
    return wrapper;
  }));
  if (wrappers.length !== metadata.rowCount) fail();
  return wrappers;
}

export function assertJiaowubaoPayrollProjectedSummary(
  row: JsonRecord,
  projection: ReturnType<typeof projectJiaowubaoCompletedLessonRecords>,
) {
  const summaries = projection.teachers.filter((summary) => summary.teacherId === row.teacherId);
  if (summaries.length !== 1) fail();
  const summary = summaries[0]!;
  if (summary.teacherMatch === "ambiguous" || !summary.teacherId
    || summary.sourceHours === null || summary.trialSourceHours === null
    || summary.unresolvedLessonCount !== 0 || summary.unresolvedTrialLessonCount !== 0
    || summary.missingStudentDisplayNameCount !== 0) fail();
  const sourceKeys = projection.teacherEvidenceSourceKeys.get(summary.identityKey);
  if (!sourceKeys || !Array.isArray(row.lines) || row.lines.length !== sourceKeys.size) fail();
  const items = new Map(projection.items.map((item) => [item.sourceKey, item]));
  const seen = new Set<string>();
  for (const rawLine of row.lines) {
    const line = record(rawLine);
    const item = line && typeof line.sourceKey === "string" ? items.get(line.sourceKey) : null;
    if (!line || !item || !sourceKeys.has(item.sourceKey) || seen.has(item.sourceKey)) fail();
    seen.add(item.sourceKey);
    if (item.hours === null || item.hoursIssue || line.hours !== item.hours
      || (line.hoursIssue ?? null) !== (item.hoursIssue ?? null)
      || line.isTrial !== item.isTrial || line.sourceMemberId !== item.memberId
      || (line.studentId ?? null) !== item.studentId || line.studentMatch !== item.studentMatch
      || line.studentName !== (item.displayStudentName ?? `${item.memberName ?? item.memberId}（待核对姓名）`)
      || line.evidenceOnly !== true || line.rate !== 0 || line.subtotal !== 0) fail();
  }
  if (row.sourceHours !== summary.sourceHours || row.sourceLessonCount !== summary.sourceLessonCount
    || row.trialLessons !== summary.trialSourceHours) fail();
}

export async function assertJiaowubaoPayrollAuthority(input: Readonly<{
  currentPayload: unknown;
  nextPayload: unknown;
  stateRows: readonly OpsStateRow[];
}>) {
  const changed = changedSummaries(input.currentPayload, input.nextPayload);
  if (!changed.length) return;
  const mappingRevision = projectionRevision(input.stateRows);
  const months = new Map<string, JsonRecord[]>();
  for (const row of changed) {
    const month = row.month;
    if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)
      || typeof row.sourceRevision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(row.sourceRevision)
      || row.sourceProjectionRevision !== mappingRevision) fail();
    months.set(month, [...months.get(month) ?? [], row]);
  }
  for (const [month, rows] of months) {
    const revision = rows[0]!.sourceRevision as string;
    if (rows.some((row) => row.sourceRevision !== revision)) fail();
    const [lessonWrappers, scheduleWrappers] = await Promise.all([
      readSource(month, revision, "lessons"),
      readSource(month, revision, "schedules"),
    ]);
    const records = lessonWrappers.map((wrapper) => {
      const parsed = readJiaowubaoCompletedLessonSnapshotRecord(wrapper.record);
      if (parsed.sourceKey !== wrapper.sourceKey) fail();
      return parsed;
    });
    const scheduleRecords = scheduleWrappers.map((wrapper) => {
      const parsed = readJiaowubaoCompletedScheduleSnapshotRecord(wrapper.record);
      if (parsed.sourceKey !== wrapper.sourceKey) fail();
      return parsed;
    });
    const projection = projectJiaowubaoCompletedLessonRecords({ records, scheduleRecords, stateRows: input.stateRows });
    rows.forEach((row) => assertJiaowubaoPayrollProjectedSummary(row, projection));
  }
}
