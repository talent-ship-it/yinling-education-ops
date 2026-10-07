import { monthlyHourCoverage } from "@/lib/monthly-hour-period";
import { completeHoursSheets, completeHoursStylesXml } from "@/lib/payroll-complete-template";
import { createStoredOpenXmlZip, type OpenXmlPart } from "@/lib/openxml-xlsx";
import { jiaowubaoCompletedLessonBranchDisplay } from "@/lib/jiaowubao-completed-lesson-branch";
import type { JiaowubaoHourIssue } from "@/lib/jiaowubao-hour-evidence";
import { snapshotJiaowubaoHour, snapshotJiaowubaoOptionalHour } from "@/lib/jiaowubao-hour-evidence";
import { jiaowubaoCompletedLessonTeacherIdentityKey } from "@/lib/jiaowubao-completed-lesson-reconciliation";
import { isJiaowubaoSharedTrialAccountLabel } from "@/lib/trial-operations";

export const PAYROLL_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type PayrollExportLine = Readonly<{
  studentName: string;
  hours: number | null;
  hoursIssue?: JiaowubaoHourIssue | null;
  rate: number;
  subtotal: number;
  note?: string;
  isTrial?: boolean;
  evidenceOnly?: boolean;
  studentKey?: string;
  studentId?: string | null;
  sourceMemberId?: string | null;
  sourceKey?: string;
  studentMatch?: string;
}>;

export type PayrollExportTeacherLink = Readonly<{
  role: "primary" | "assistant" | "third";
  sourceTeacherId: string | null;
  sourceTeacherName: string | null;
  teacherId: string | null;
  teacherName: string | null;
  teacherMatch: string;
}>;

export type PayrollExportRow = Readonly<{
  teacherKey: string;
  teacherId?: string | null;
  sourceTeacherId?: string | null;
  teacherName: string;
  month: string;
  section: string;
  currency: "CNY" | "AUD";
  status: string;
  payrollHours: number;
  sourceHours?: number | null;
  sourceLessonCount?: number | null;
  amount: number;
  bankName?: string;
  bankAccount?: string;
  paymentNote?: string;
  lockedBy?: string;
  lockedAt?: string;
  paymentMode: "payable" | "review_only";
  lines: readonly PayrollExportLine[];
}>;

export type PayrollExportLessonEvidence = Readonly<{
  sourceKey: string;
  branchId: string;
  calendarId: string;
  memberId: string;
  memberName: string | null;
  displayStudentName: string | null;
  studentId: string | null;
  studentName: string | null;
  studentMatch: string;
  lessonDate: string;
  timeTitle: string | null;
  hours: number | null;
  hoursIssue?: JiaowubaoHourIssue | null;
  isTrial: boolean;
  attendanceCode: number | null;
  attendanceTitle: string | null;
  courseTitle: string | null;
  teamTitle: string | null;
  teachers: readonly PayrollExportTeacherLink[];
}>;

export type PayrollExportScheduleEvidence = Readonly<{
  sourceKey: string;
  calendarId: string;
  lessonDate: string;
  timeTitle: string | null;
  courseTitle: string | null;
  teamTitle: string | null;
  teachers: readonly (PayrollExportTeacherLink & Readonly<{ sourceTeacherHours: number | null; sourceTeacherHoursIssue?: JiaowubaoHourIssue | null }>)[];
}>;

export type PayrollExportEvidence = Readonly<{
  dataThrough?: string | null;
  provisional?: boolean;
  revision: string | null;
  projectionRevision: string | null;
  publishedAt: string | null;
  lessonRowCount: number;
  scheduleRowCount: number;
  /** Exact learner-evidence source keys expected on each exported teacher row. */
  teacherLessonSourceKeys: readonly Readonly<{
    teacherKey: string;
    sourceKeys: readonly string[];
  }>[];
  matchCounts: Readonly<{
    matchedStudents: number;
    unmatchedStudents: number;
    ambiguousStudents: number;
    matchedTeachers: number;
    unmatchedTeachers: number;
    ambiguousTeachers: number;
  }>;
  lessons: readonly PayrollExportLessonEvidence[];
  schedules: readonly PayrollExportScheduleEvidence[];
}>;

export type PayrollWorkbookExport = Readonly<{
  month: string;
  generatedAt: string;
  exportMode?: "hours_only" | "hours_complete";
  rows: readonly PayrollExportRow[];
  evidence?: PayrollExportEvidence;
}>;

type CellValue = string | number | null;
type Cell = Readonly<{ value: CellValue; style?: number }>;
type SheetRow = readonly Cell[];

type AggregatedStudent = {
  studentName: string;
  regularHours: number | null;
  trialHours: number | null;
  hours: number | null;
  rates: Set<number>;
  subtotal: number;
  lessonCount: number;
  hasExceptionalHours: boolean;
  evidenceOnly: boolean;
  studentIds: Set<string>;
  sourceMemberIds: Set<string>;
  sourceKeys: Set<string>;
  studentMatches: Set<string>;
  notes: Set<string>;
};

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const MAX_WORKSHEET_ROWS = 100_000;
const MAX_EXPORT_ROWS = 10_000;
const MAX_EVIDENCE_ROWS = 6_000;
const MAX_PAYROLL_DETAIL_ROWS = MAX_EVIDENCE_ROWS * 3;
const MAX_CELL_LENGTH = 32_767;
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/u;
function fail(message: string): never {
  throw new Error(message);
}

function safeText(value: string, label: string) {
  if (typeof value !== "string" || value.length > MAX_CELL_LENGTH || INVALID_XML.test(value)) {
    fail(`${label} 包含无效或过长的文字。`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${label} 包含无效字符。`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${label} 包含无效字符。`);
    }
  }
  return value;
}

function optionalText(value: string | null | undefined, label: string) {
  return value == null ? "" : safeText(value, label);
}

function number(value: number, label: string) {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) fail(`${label} 数值无效。`);
  return Object.is(value, -0) ? 0 : value;
}

function integer(value: number, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(`${label} 数值无效。`);
  return value;
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(column: number) {
  let value = column;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function cellXml(cell: Cell, row: number, column: number) {
  const reference = `${columnName(column)}${row}`;
  const style = cell.style === undefined ? "" : ` s="${cell.style}"`;
  if (cell.value === null) return `<c r="${reference}"${style}/>`;
  if (typeof cell.value === "number") {
    return `<c r="${reference}"${style}><v>${number(cell.value, reference)}</v></c>`;
  }
  const value = safeText(cell.value, reference);
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function worksheetXml(input: Readonly<{
  rows: readonly SheetRow[];
  widths: readonly number[];
  merges?: readonly string[];
  freezeRows?: number;
  landscape?: boolean;
  rowHeights?: ReadonlyMap<number, number>;
}>) {
  if (!input.rows.length || input.rows.length > MAX_WORKSHEET_ROWS) fail("XLSX 工作表行数无效。");
  const maxColumns = Math.max(...input.rows.map((row) => row.length), input.widths.length, 1);
  if (maxColumns > 16_384) fail("XLSX 工作表列数无效。");
  const rows = input.rows.map((cells, index) => {
    const rowNumber = index + 1;
    const height = input.rowHeights?.get(rowNumber);
    const heightAttributes = height ? ` ht="${number(height, "row height")}" customHeight="1"` : "";
    return `<row r="${rowNumber}"${heightAttributes}>${cells.map((cell, column) => cellXml(cell, rowNumber, column + 1)).join("")}</row>`;
  }).join("");
  const columns = input.widths.map((width, index) => (
    `<col min="${index + 1}" max="${index + 1}" width="${number(width, "column width")}" customWidth="1"/>`
  )).join("");
  const freeze = input.freezeRows
    ? `<pane ySplit="${input.freezeRows}" topLeftCell="A${input.freezeRows + 1}" activePane="bottomLeft" state="frozen"/>`
    : "";
  const merges = input.merges?.length
    ? `<mergeCells count="${input.merges.length}">${input.merges.map((reference) => `<mergeCell ref="${xml(reference)}"/>`).join("")}</mergeCells>`
    : "";
  const pageSetup = input.landscape
    ? '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
    : '<pageSetup orientation="portrait" fitToWidth="1" fitToHeight="0"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${columnName(maxColumns)}${input.rows.length}"/>
  <sheetViews><sheetView showGridLines="0" workbookViewId="0">${freeze}</sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="22"/>
  <cols>${columns}</cols>
  <sheetData>${rows}</sheetData>
  ${merges}
  <pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/>
  ${pageSetup}
</worksheet>`;
}

function stringCell(value: string | null | undefined, style = 4): Cell {
  return { value: value == null ? null : value, style };
}

function numberCell(value: number | null | undefined, style = 5): Cell {
  return { value: value == null ? null : number(value, "cell"), style };
}

function sourceHourCell(value: number | null | undefined): Cell {
  if (value == null) return stringCell("待核对");
  return Math.abs(value) > 1_000_000_000_000 ? stringCell(String(value)) : numberCell(value);
}

function safeSourceSum(total: number | null, value: number | null) {
  if (total === null || value === null || !Number.isFinite(value)) return null;
  const next = total + value;
  return Number.isFinite(next) && Math.abs(next) <= 1_000_000_000_000
    ? Number(next.toFixed(4)) : null;
}

function joined(values: ReadonlySet<string>) {
  return [...values].join("、");
}

function aggregationKey(line: PayrollExportLine) {
  const explicit = line.studentKey?.trim()
    || line.studentId?.trim()
    || line.sourceMemberId?.trim();
  if (explicit) return explicit;
  return safeText(line.studentName, "学生姓名").normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-AU");
}

function aggregateStudents(lines: readonly PayrollExportLine[]) {
  const result = new Map<string, AggregatedStudent>();
  for (const line of lines) {
    const studentName = safeText(line.studentName, "学生姓名");
    if (!studentName.trim()) fail("学生姓名不能为空。");
    const key = aggregationKey(line);
    if (!key) fail("学生身份不能为空。");
    const existing = result.get(key) ?? {
      studentName,
      regularHours: 0,
      trialHours: 0,
      hours: 0,
      rates: new Set<number>(),
      subtotal: 0,
      lessonCount: 0,
      hasExceptionalHours: false,
      evidenceOnly: true,
      studentIds: new Set<string>(),
      sourceMemberIds: new Set<string>(),
      sourceKeys: new Set<string>(),
      studentMatches: new Set<string>(),
      notes: new Set<string>(),
    };
    if (line.evidenceOnly) snapshotJiaowubaoHour(line.hours, line.hoursIssue ?? undefined);
    else if (line.hoursIssue || line.hours === null) fail("普通薪资明细不能包含异常课时。");
    const hours = line.hours === null || (line.evidenceOnly && Math.abs(line.hours) > 1_000_000_000_000)
      ? null : number(line.hours, "学生课时");
    if (line.hoursIssue || hours === null) {
      existing.hasExceptionalHours = true;
      existing.notes.add(hours === null ? "课时缺失或无法安全合计，待核对" : "来源课时越界，待核对");
    }
    if (hours === null) {
      existing.hours = null;
      if (line.isTrial) existing.trialHours = null;
      else existing.regularHours = null;
    } else {
      existing.hours = line.evidenceOnly ? safeSourceSum(existing.hours, hours)
        : number(existing.hours! + hours, "学生课时合计");
      if (line.isTrial) existing.trialHours = line.evidenceOnly ? safeSourceSum(existing.trialHours, hours)
        : number(existing.trialHours! + hours, "试听课时");
      else existing.regularHours = line.evidenceOnly ? safeSourceSum(existing.regularHours, hours)
        : number(existing.regularHours! + hours, "常规课时");
    }
    existing.rates.add(number(line.rate, "课时费率"));
    existing.subtotal = number(existing.subtotal + number(line.subtotal, "行小计"), "学生小计");
    existing.lessonCount += 1;
    existing.evidenceOnly &&= Boolean(line.evidenceOnly);
    if (line.studentId) existing.studentIds.add(safeText(line.studentId, "学生 ID"));
    if (line.sourceMemberId) existing.sourceMemberIds.add(safeText(line.sourceMemberId, "教务宝学员 ID"));
    if (line.sourceKey) existing.sourceKeys.add(safeText(line.sourceKey, "来源键"));
    if (line.studentMatch) existing.studentMatches.add(safeText(line.studentMatch, "学生匹配状态"));
    if (line.note) existing.notes.add(safeText(line.note, "学生明细说明"));
    result.set(key, existing);
  }
  return [...result.values()];
}

function assertWorkbook(input: PayrollWorkbookExport) {
  if (input.exportMode !== undefined && input.exportMode !== "hours_only" && input.exportMode !== "hours_complete") fail("导出模式无效。");
  if (input.exportMode !== undefined && !input.evidence) fail("课时核对表缺少完整双源快照。");
  const match = MONTH.exec(input.month);
  if (!match) fail("导出月份格式无效。");
  const generatedAt = new Date(input.generatedAt);
  if (Number.isNaN(generatedAt.valueOf()) || generatedAt.toISOString() !== input.generatedAt) fail("导出时间格式无效。");
  if (!Array.isArray(input.rows) || input.rows.length > MAX_EXPORT_ROWS) fail("薪资导出行数无效。");
  const evidenceBySourceKey = new Map<string, PayrollExportLessonEvidence>();
  const expectedSourceKeysByTeacher = new Map<string, ReadonlySet<string>>();
  if (input.evidence) {
    const coverage = monthlyHourCoverage(input.month, input.evidence.dataThrough, input.evidence.provisional);
    if ([...input.evidence.lessons, ...input.evidence.schedules].some((row) => row.lessonDate < coverage.start || row.lessonDate > coverage.end)) fail("课时明细超出截止日期。");
    if (coverage.provisional && input.exportMode === undefined) fail("月中课时资料不能导出付款表。");
    integer(input.evidence.lessonRowCount, "消课来源行数", MAX_EVIDENCE_ROWS);
    integer(input.evidence.scheduleRowCount, "排课来源行数", MAX_EVIDENCE_ROWS);
    if (input.evidence.lessonRowCount !== input.evidence.lessons.length
      || input.evidence.scheduleRowCount !== input.evidence.schedules.length) {
      fail("教务宝证据行数与来源统计不一致。");
    }
    for (const [label, value] of Object.entries(input.evidence.matchCounts)) {
      integer(value, label, MAX_EVIDENCE_ROWS * 3);
    }
    for (const lesson of input.evidence.lessons) {
      if (!lesson.sourceKey?.trim()) fail("教务宝消课证据缺少来源键。");
      safeText(lesson.sourceKey, "教务宝消课证据来源键");
      if (evidenceBySourceKey.has(lesson.sourceKey)) fail("教务宝消课证据包含重复来源键。");
      snapshotJiaowubaoHour(lesson.hours, lesson.hoursIssue ?? undefined);
      evidenceBySourceKey.set(lesson.sourceKey, lesson);
    }
    for (const schedule of input.evidence.schedules) {
      for (const teacher of schedule.teachers) {
        snapshotJiaowubaoOptionalHour(teacher.sourceTeacherHours, teacher.sourceTeacherHoursIssue ?? undefined);
      }
    }
    if (!Array.isArray(input.evidence.teacherLessonSourceKeys)
      || input.evidence.teacherLessonSourceKeys.length > MAX_EXPORT_ROWS) {
      fail("老师课次映射行数无效。");
    }
    const mappedSourceKeys = new Set<string>();
    for (const mapping of input.evidence.teacherLessonSourceKeys) {
      if (!mapping.teacherKey?.trim()) fail("老师课次映射缺少老师身份。");
      safeText(mapping.teacherKey, "老师课次映射身份");
      if (expectedSourceKeysByTeacher.has(mapping.teacherKey)) fail("老师课次映射包含重复老师身份。");
      if (!Array.isArray(mapping.sourceKeys) || mapping.sourceKeys.length > MAX_EVIDENCE_ROWS) {
        fail("老师课次映射来源键数无效。");
      }
      const sourceKeys = new Set<string>();
      for (const sourceKey of mapping.sourceKeys) {
        if (!sourceKey?.trim()) fail("老师课次映射缺少来源键。");
        safeText(sourceKey, "老师课次映射来源键");
        if (sourceKeys.has(sourceKey)) fail("同一老师课次映射包含重复来源键。");
        sourceKeys.add(sourceKey);
        mappedSourceKeys.add(sourceKey);
      }
      expectedSourceKeysByTeacher.set(mapping.teacherKey, sourceKeys);
    }
    if (mappedSourceKeys.size !== evidenceBySourceKey.size
      || [...mappedSourceKeys].some((sourceKey) => !evidenceBySourceKey.has(sourceKey))) {
      fail("老师课次映射与当前教务宝消课证据不完整或不一致。");
    }
  }
  let payrollDetailRows = 0;
  const teacherKeys = new Set<string>();
  for (const row of input.rows) {
    if (!row.teacherKey?.trim() || !row.teacherName?.trim()) fail("老师身份或姓名不能为空。");
    safeText(row.teacherKey, "老师身份");
    safeText(row.teacherName, "老师姓名");
    if (teacherKeys.has(row.teacherKey)) fail("同一月份包含重复老师身份，不能导出。");
    teacherKeys.add(row.teacherKey);
    if (row.month !== input.month || !MONTH.test(row.month)) fail("薪资行月份与导出月份不一致。");
    if (row.currency !== "CNY" && row.currency !== "AUD") fail("薪资币种无效。");
    if (row.paymentMode !== "payable" && row.paymentMode !== "review_only") fail("付款模式无效。");
    if (input.evidence && row.paymentMode === "payable" && row.sourceHours == null) {
      fail("缺失教务宝老师课时不能生成付款资料。");
    }
    number(row.payrollHours, "薪资课时");
    if (row.sourceHours != null) {
      if (input.exportMode !== undefined && row.paymentMode === "review_only") {
        if (!Number.isFinite(row.sourceHours)) fail("教务宝老师课时数值无效。");
      } else number(row.sourceHours, "教务宝老师课时");
    }
    if (row.sourceLessonCount != null) integer(row.sourceLessonCount, "教务宝课次数", MAX_EVIDENCE_ROWS);
    number(row.amount, "薪资金额");
    safeText(row.section, "教师类别");
    safeText(row.status, "薪资状态");
    optionalText(row.teacherId, "老师 ID");
    optionalText(row.sourceTeacherId, "教务宝老师 ID");
    optionalText(row.bankName, "银行名称");
    optionalText(row.bankAccount, "银行账户");
    optionalText(row.paymentNote, "付款说明");
    optionalText(row.lockedBy, "锁定人");
    optionalText(row.lockedAt, "锁定时间");
    if (!Array.isArray(row.lines) || row.lines.length > MAX_EVIDENCE_ROWS) fail("学生明细行数无效。");
    payrollDetailRows += row.lines.length;
    if (payrollDetailRows > MAX_PAYROLL_DETAIL_ROWS) fail("学生明细总行数无效。");
    aggregateStudents(row.lines);
    if (input.evidence) {
      if (row.paymentMode === "payable" && input.evidence.schedules.some((schedule) => schedule.teachers.some(
        (teacher) => teacher.teacherId === row.teacherId
          && (teacher.sourceTeacherHours === null || teacher.sourceTeacherHoursIssue),
      ))) fail("异常教务宝老师课时不能生成付款资料。");
      const expectedSourceKeys = expectedSourceKeysByTeacher.get(row.teacherKey);
      if (!expectedSourceKeys) fail("薪资行缺少当前教务宝老师课次映射。");
      const rowSourceKeys = new Set<string>();
      for (const line of row.lines) {
        if (!line.sourceKey?.trim()) fail("学生明细缺少当前教务宝来源键。");
        safeText(line.sourceKey, "学生明细来源键");
        if (rowSourceKeys.has(line.sourceKey)) fail("同一老师的学生明细包含重复教务宝来源键。");
        rowSourceKeys.add(line.sourceKey);
        const lesson = evidenceBySourceKey.get(line.sourceKey);
        if (!lesson) fail("学生明细来源键不属于当前教务宝消课证据。");
        if (lesson.hoursIssue && row.paymentMode === "payable") fail("异常教务宝课时不能生成付款资料。");
        const expectedStudentName = lesson.displayStudentName
          ?? `${lesson.memberName ?? lesson.memberId}（待核对姓名）`;
        if (line.studentName !== expectedStudentName
          || line.hours !== lesson.hours
          || (line.hoursIssue ?? null) !== (lesson.hoursIssue ?? null)
          || line.isTrial !== lesson.isTrial
          || line.sourceMemberId !== lesson.memberId
          || line.studentId !== lesson.studentId
          || line.studentMatch !== lesson.studentMatch
          || line.evidenceOnly !== true
          || line.rate !== 0
          || line.subtotal !== 0) {
          fail("学生明细与当前教务宝消课事实不一致。");
        }
      }
      if (rowSourceKeys.size !== expectedSourceKeys.size
        || [...rowSourceKeys].some((sourceKey) => !expectedSourceKeys.has(sourceKey))) {
        fail("该老师的学生明细与当前教务宝课次映射不完整或不一致。");
      }
    }
  }
  if (input.evidence) {
    for (const teacherKey of expectedSourceKeysByTeacher.keys()) {
      if (!teacherKeys.has(teacherKey)) fail("老师课次映射缺少对应薪资行。");
    }
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}

const TEMPLATE_MAIN_WIDTHS = [7.4375, 32.9375, 26.9375, 21.8125, 27.125, 32.25, 22.3125, 23.375, 31.3125, 40.5625, 34.625, 41.375, 112.5625];
const TEMPLATE_STUDENT_WIDTHS = TEMPLATE_MAIN_WIDTHS.slice(0, 9);
const TEMPLATE_SOURCE_LABEL = "教务宝已结课双源快照；学生课时与老师角色课时分别核对";

function roundedHours(value: number) {
  return number(Number(value.toFixed(4)), "课时合计");
}

function visualUnits(value: string) {
  return [...value].reduce((total, character) => total + (/[^\u0000-\u007f]/u.test(character) ? 2 : 1), 0);
}

function wrappedLineCount(value: string, width: number) {
  let lines = 0;
  for (const paragraph of value.split(/\r?\n/u)) {
    let used = 0;
    lines += 1;
    for (const token of paragraph.match(/\s+|\S+/gu) ?? []) {
      const units = visualUnits(token);
      if (/\S/u.test(token) && used && used + units > width) {
        lines += 1;
        used = 0;
      }
      const occupied = used + units;
      lines += Math.max(0, Math.ceil(occupied / width) - 1);
      used = occupied % width || width;
    }
  }
  return lines;
}

function fittedHeight(cells: readonly Readonly<{ value: string; width: number }>[]) {
  const lines = Math.max(1, ...cells.map(({ value, width }) => wrappedLineCount(value, width)));
  return Math.min(409.5, Math.max(31.5, lines * 19 + 4));
}

function lessonEvidenceBySourceKey(input: PayrollWorkbookExport) {
  return new Map((input.evidence?.lessons ?? []).map((lesson) => [lesson.sourceKey, lesson]));
}

function ownerForLesson(lesson: PayrollExportLessonEvidence, eligible: readonly string[]) {
  const primary = lesson.teachers.find((teacher) => teacher.role === "primary");
  const preferred = primary ? jiaowubaoCompletedLessonTeacherIdentityKey(primary) : null;
  if (preferred && eligible.includes(preferred)) return preferred;
  return eligible.length === 1 ? eligible[0]! : null;
}

function eligibleTeachersBySourceKey(rows: readonly PayrollExportRow[]) {
  const mapped = new Map<string, string[]>();
  for (const row of rows) {
    for (const line of row.lines) {
      if (!line.sourceKey) continue;
      mapped.set(line.sourceKey, [...mapped.get(line.sourceKey) ?? [], row.teacherKey]);
    }
  }
  return mapped;
}

function studentHoursOwnerBySourceKey(input: PayrollWorkbookExport) {
  const mapped = eligibleTeachersBySourceKey(input.rows);
  const owners = new Map<string, string>();
  for (const lesson of input.evidence?.lessons ?? []) {
    const owner = ownerForLesson(lesson, mapped.get(lesson.sourceKey) ?? []);
    if (owner) owners.set(lesson.sourceKey, owner);
  }
  return owners;
}

function displayedStudentHours(
  payroll: PayrollExportRow,
  sourceKeys: ReadonlySet<string>,
  fallback: number | null,
  owners: ReadonlyMap<string, string>,
  evidence: ReadonlyMap<string, PayrollExportLessonEvidence>,
): number | null {
  if (!evidence.size) return fallback === null ? null : roundedHours(fallback);
  let total: number | null = 0;
  for (const sourceKey of sourceKeys) {
    if (owners.get(sourceKey) !== payroll.teacherKey) continue;
    const lesson = evidence.get(sourceKey);
    if (!lesson || lesson.hours === null) return null;
    total = safeSourceSum(total, lesson.hours);
  }
  return total;
}

function attendanceSummary(sourceKeys: ReadonlySet<string>, evidence: ReadonlyMap<string, PayrollExportLessonEvidence>) {
  const counts = new Map<string, number>();
  for (const sourceKey of sourceKeys) {
    const lesson = evidence.get(sourceKey);
    if (!lesson) continue;
    const label = lesson.attendanceTitle?.trim() || (lesson.attendanceCode === null ? "出勤待核对" : `出勤代码 ${lesson.attendanceCode}`);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join("；");
}

function trialStudentLabel(lesson: PayrollExportLessonEvidence) {
  const sharedAccount = isJiaowubaoSharedTrialAccountLabel(lesson.memberName);
  if (!lesson.isTrial && !sharedAccount) return null;
  const name = sharedAccount ? lesson.displayStudentName : lesson.displayStudentName ?? lesson.memberName;
  if (!name || isJiaowubaoSharedTrialAccountLabel(name)) return null;
  return sharedAccount || lesson.studentMatch === "trial_course_title" ? `${name}（课程标题候选，待核对）` : name;
}

function trialStudents(sourceKeys: ReadonlySet<string>, evidence: ReadonlyMap<string, PayrollExportLessonEvidence>) {
  const names = new Set<string>();
  for (const sourceKey of sourceKeys) {
    const lesson = evidence.get(sourceKey);
    const name = lesson ? trialStudentLabel(lesson) : null;
    if (name) names.add(name);
  }
  return joined(names);
}

function mainSheet(input: PayrollWorkbookExport, year: number, month: number) {
  const rows: SheetRow[] = [
    [stringCell(`${year}年${month}月 教务宝课时表`, 1), ...Array.from({ length: 7 }, () => stringCell(null, 1))],
    [stringCell("教务宝教师课时（已消课 over=1）", 2), ...Array.from({ length: 7 }, () => stringCell(null, 2))],
    ["序号", "教师姓名", "学生姓名", "课时（小时）", "课时费单价（/小时）", "合计（待补费率）", "老师总课时（小时）", "老师总薪资"].map((value) => stringCell(value, 3)),
  ];
  const merges = ["A1:H1", "A2:H2"];
  const pastelStyles = [6, 7, 8, 9, 10, 11];
  input.rows.forEach((payroll, index) => {
    const students = aggregateStudents(payroll.lines);
    const visible = students.length ? students : [null];
    const firstRow = rows.length + 1;
    const lastRow = firstRow + visible.length - 1;
    const pastel = pastelStyles[index % pastelStyles.length]!;
    visible.forEach((student, studentIndex) => {
      const hasPayableLines = payroll.paymentMode === "payable" && Boolean(student && !student.evidenceOnly);
      const rates = student ? [...student.rates] : [];
      const rate: CellValue = !hasPayableLines ? null : rates.length === 1 ? rates[0]! : "多个费率";
      const moneyStyle = payroll.currency === "CNY" ? 12 : 13;
      rows.push([
        studentIndex === 0 ? numberCell(index + 1, pastel) : stringCell(null, pastel),
        studentIndex === 0 ? stringCell(payroll.teacherName, 4) : stringCell(null, 4),
        stringCell(student?.studentName ?? "（无学生明细）", pastel),
        numberCell(student?.hours ?? null, 5),
        typeof rate === "number" ? numberCell(rate, moneyStyle) : stringCell(rate, 4),
        hasPayableLines ? numberCell(student!.subtotal, moneyStyle) : stringCell(null, moneyStyle),
        studentIndex === 0
          ? numberCell(payroll.paymentMode === "review_only" ? payroll.sourceHours ?? null : payroll.sourceHours ?? payroll.payrollHours, 5)
          : stringCell(null, 5),
        studentIndex === 0
          ? payroll.paymentMode === "review_only"
            ? stringCell("待核对", 14)
            : numberCell(payroll.amount, moneyStyle)
          : stringCell(null, payroll.paymentMode === "review_only" ? 14 : moneyStyle),
      ]);
    });
    if (lastRow > firstRow) {
      for (const column of ["A", "B", "G", "H"]) merges.push(`${column}${firstRow}:${column}${lastRow}`);
    }
  });
  return worksheetXml({
    rows,
    widths: [7, 24, 27, 14, 20, 18, 18, 18],
    merges,
    freezeRows: 3,
    landscape: true,
    rowHeights: new Map([[1, 54], [2, 38], [3, 34]]),
  });
}

function studentDetailSheet(input: PayrollWorkbookExport) {
  const rows: SheetRow[] = [[
    "月份", "老师", "学生", "常规课时", "试听课时", "学生课时合计", "明细条数", "学生 ID", "教务宝学员 ID", "来源键", "匹配状态", "说明",
  ].map((value) => stringCell(value, 3))];
  for (const payroll of input.rows) {
    for (const student of aggregateStudents(payroll.lines)) {
      rows.push([
        stringCell(input.month), stringCell(payroll.teacherName), stringCell(student.studentName),
        numberCell(student.regularHours), numberCell(student.trialHours), numberCell(student.hours), numberCell(student.lessonCount),
        stringCell(joined(student.studentIds)), stringCell(joined(student.sourceMemberIds)), stringCell(joined(student.sourceKeys)),
        stringCell(joined(student.studentMatches)), stringCell(joined(student.notes)),
      ]);
    }
  }
  return worksheetXml({ rows, widths: [12, 22, 24, 12, 12, 14, 11, 20, 20, 34, 18, 42], freezeRows: 1, landscape: true });
}

function hoursOnlyTeacherDifference(payroll: PayrollExportRow, studentHours: number | null) {
  if (studentHours === null) return "学生课时待核对，合计不完整";
  if (payroll.sourceHours == null) return "老师课时待核对";
  return Math.abs(studentHours - payroll.sourceHours) > 0.0001
    ? `学生 ${studentHours} 小时；老师 ${payroll.sourceHours} 小时，按角色课时核对`
    : "";
}

function hoursOnlyMainStudentNote(
  payroll: PayrollExportRow,
  student: AggregatedStudent | null,
  hours: number | null,
  evidence: ReadonlyMap<string, PayrollExportLessonEvidence>,
) {
  const notes = student ? [attendanceSummary(student.sourceKeys, evidence)] : [];
  if (student && hours === 0 && student.hours !== 0 && evidence.size) notes.push("学生课时计于主讲或下方待核对");
  if (student?.hasExceptionalHours) notes.push(hours === null ? "课时缺失，合计不完整" : "来源课时越界，待核对");
  if (payroll.paymentMode === "review_only") notes.push("待核对");
  return notes.filter(Boolean).join("；");
}

function hoursOnlyMainTeacherCells(payroll: PayrollExportRow, teacherIndex: number, studentIndex: number) {
  if (studentIndex !== 0) return {
    leading: [stringCell(null, 19), stringCell(null, 18)],
    source: stringCell(null, 21),
  };
  return {
    leading: [numberCell(teacherIndex + 1, 19), stringCell(payroll.teacherName, 18)],
    source: { ...sourceHourCell(payroll.sourceHours), style: 21 },
  };
}

function hoursOnlyMainStudentCells(input: Readonly<{
  payroll: PayrollExportRow;
  student: AggregatedStudent | null;
  teacherIndex: number;
  studentIndex: number;
  teacherStudentHours: number | null;
  evidence: ReadonlyMap<string, PayrollExportLessonEvidence>;
  owners: ReadonlyMap<string, string>;
}>) {
  const { payroll, student, teacherIndex, studentIndex, teacherStudentHours, evidence, owners } = input;
  const hours = student ? displayedStudentHours(payroll, student.sourceKeys, student.hours, owners, evidence) : null;
  const note = hoursOnlyMainStudentNote(payroll, student, hours, evidence);
  const difference = studentIndex === 0 ? hoursOnlyTeacherDifference(payroll, teacherStudentHours) : "";
  const candidate = student ? trialStudents(student.sourceKeys, evidence) : "";
  const teacherCells = hoursOnlyMainTeacherCells(payroll, teacherIndex, studentIndex);
  const cells: SheetRow = [
    ...teacherCells.leading,
    stringCell(student?.studentName ?? "（无学生明细）", 19),
    numberCell(hours === 0 && student && student.hours !== 0 ? null : hours, 20),
    stringCell(null, 18), stringCell(null, 18),
    teacherCells.source,
    stringCell(null, 21), stringCell(note, 22), stringCell(difference, 22),
    stringCell(null, 18), stringCell(null, 18), stringCell(candidate, 22),
  ];
  return { cells, hours, height: fittedHeight([{ value: note, width: 29 }, { value: difference, width: 38 }, { value: candidate, width: 104 }]) };
}

function hoursOnlyUnallocatedSourceCells(lesson: PayrollExportLessonEvidence): SheetRow {
  return [
    stringCell(lesson.teachers.map((teacher) => teacher.sourceTeacherName ?? teacher.teacherName ?? "未命名老师").join("、"), 18),
    stringCell(lesson.displayStudentName ?? lesson.memberName ?? "待核对姓名", 19), { ...sourceHourCell(lesson.hours), style: 20 },
    stringCell(null, 18), stringCell(null, 18), stringCell(lesson.teamTitle, 18),
    stringCell(lesson.courseTitle, 22),
  ];
}

function appendHoursOnlyUnallocatedMainRows(
  rows: SheetRow[],
  heights: Map<number, number>,
  lessons: readonly PayrollExportLessonEvidence[],
  evidence: ReadonlyMap<string, PayrollExportLessonEvidence>,
) {
  let total: number | null = 0;
  for (const [index, lesson] of lessons.entries()) {
    total = safeSourceSum(total, lesson.hours);
    const candidate = trialStudents(new Set([lesson.sourceKey]), evidence);
    const note = lesson.hours === null || lesson.hoursIssue
      ? lesson.hours === null ? "多教师学生课时归属待核对；课时缺失，合计不完整" : "多教师学生课时归属待核对；来源课时越界，待核对"
      : "多教师学生课时归属待核对";
    const rowNumber = rows.length + 1;
    rows.push([
      numberCell(index + 1, 18), ...hoursOnlyUnallocatedSourceCells(lesson),
      stringCell(note, 22), stringCell(attendanceSummary(new Set([lesson.sourceKey]), evidence), 22),
      stringCell(null, 18), stringCell(null, 18), stringCell(candidate, 22),
    ]);
    heights.set(rowNumber, fittedHeight([{ value: lesson.courseTitle ?? "", width: 21 }, { value: note, width: 29 }, { value: candidate, width: 104 }]));
  }
  return total;
}

function appendHoursOnlyTeacherMainRows(input: Readonly<{
  payroll: PayrollExportRow;
  teacherIndex: number;
  rows: SheetRow[];
  heights: Map<number, number>;
  merges: string[];
  evidence: ReadonlyMap<string, PayrollExportLessonEvidence>;
  owners: ReadonlyMap<string, string>;
}>) {
  const { payroll, teacherIndex, rows, heights, merges, evidence, owners } = input;
  const students = aggregateStudents(payroll.lines);
  const firstRow = rows.length + 1;
  const lastRow = firstRow + Math.max(1, students.length) - 1;
  let teacherStudentHours: number | null = 0;
  for (const student of students) {
    const hours = displayedStudentHours(payroll, student.sourceKeys, student.hours, owners, evidence);
    teacherStudentHours = safeSourceSum(teacherStudentHours, hours);
  }
  let studentTotal: number | null = 0;
  for (const [studentIndex, student] of (students.length ? students : [null]).entries()) {
    const rendered = hoursOnlyMainStudentCells({ payroll, student, teacherIndex, studentIndex, teacherStudentHours, evidence, owners });
    if (student) studentTotal = safeSourceSum(studentTotal, rendered.hours);
    const rowNumber = rows.length + 1;
    rows.push(rendered.cells);
    heights.set(rowNumber, rendered.height);
  }
  if (lastRow > firstRow) {
    for (const column of ["A", "B", "G", "H", "K", "L"]) merges.push(`${column}${firstRow}:${column}${lastRow}`);
  }
  return studentTotal;
}

function hoursOnlyMainSheet(input: PayrollWorkbookExport, year: number, month: number) {
  const rows: SheetRow[] = [
    [stringCell(`${year}年${String(month).padStart(2, "0")}月教务宝课时表`, 15)],
    [stringCell(TEMPLATE_SOURCE_LABEL, 16)],
    ["序号", "教师姓名", "学生姓名", "课时（小时）", "课时费单价（小时）", "合计（待补费率）", "老师总课时（小时）", "老师总薪资（待补）", "老师薪资备注", "其他", "银行卡号", "开户行", "试听员名单"].map((value) => stringCell(value, 17)),
  ];
  const merges = ["A1:I1", "A2:I2"];
  const heights = new Map<number, number>([[1, 59.55], [2, 36.5], [3, 31.5]]);
  const evidence = lessonEvidenceBySourceKey(input);
  const owners = studentHoursOwnerBySourceKey(input);
  const scheduleCalendarIds = new Set(input.evidence?.schedules.map((schedule) => schedule.calendarId) ?? []);
  const missingSchedule = input.evidence?.lessons.some((lesson) => !scheduleCalendarIds.has(lesson.calendarId)) ?? false;
  const assignedExceptionalHours = input.evidence?.lessons.some((lesson) => owners.has(lesson.sourceKey) && lesson.hoursIssue) ?? false;
  let studentTotal: number | null = 0;
  let teacherTotal: number | null = missingSchedule ? null : 0;
  const exceptionalTeacherHours = missingSchedule || (input.evidence?.schedules.some((schedule) => !schedule.teachers.length
    || schedule.teachers.some((teacher) => teacher.sourceTeacherHoursIssue)) ?? false);
  for (const [index, payroll] of input.rows.entries()) {
    const teacherStudentHours = appendHoursOnlyTeacherMainRows({
      payroll, teacherIndex: index, rows, heights, merges, evidence, owners,
    });
    studentTotal = safeSourceSum(studentTotal, teacherStudentHours);
  }
  for (const schedule of input.evidence?.schedules ?? []) {
    if (!schedule.teachers.length) teacherTotal = null;
    for (const teacher of schedule.teachers) {
      teacherTotal = safeSourceSum(teacherTotal, teacher.sourceTeacherHours);
    }
  }
  rows.push([
    stringCell(null, 23), stringCell(null, 23), stringCell(null, 23), numberCell(studentTotal, 23),
    stringCell(null, 23), stringCell(null, 23), numberCell(teacherTotal, 23),
    stringCell(null, 23), stringCell(studentTotal === null ? "学生课时缺失，合计不完整" : assignedExceptionalHours ? "学生来源课时含越界值，待核对" : null, 23),
    stringCell(teacherTotal === null ? "老师课时缺失，合计不完整" : exceptionalTeacherHours ? "老师来源课时含越界值，待核对" : null, 23),
    ...Array.from({ length: 3 }, () => stringCell(null, 23)),
  ]);
  heights.set(rows.length, 31.5);
  rows.push(Array.from({ length: 13 }, () => stringCell(null, 18)));
  rows.push([stringCell("教务宝多教师记录（课时暂未拆分）", 24)]);
  merges.push(`A${rows.length}:I${rows.length}`);
  heights.set(rows.length, 36.5);
  rows.push(["序号", "教师姓名（教务宝原始）", "学生姓名", "课时（小时）", "课时费单价（小时）", "合计", "课程类型", "课程名称", "备注", "其他", "银行卡号", "开户行", "试听员名单"].map((value) => stringCell(value, 17)));
  heights.set(rows.length, 31.5);
  const unallocated = input.evidence?.lessons.filter((lesson) => !owners.has(lesson.sourceKey)) ?? [];
  const unallocatedHours = appendHoursOnlyUnallocatedMainRows(rows, heights, unallocated, evidence);
  rows.push([
    stringCell(null, 23), stringCell(null, 23), stringCell(null, 23), unallocated.length ? numberCell(unallocatedHours, 23) : stringCell(null, 23),
    stringCell(null, 23), stringCell(null, 23), stringCell(null, 23), stringCell(null, 23),
    stringCell(unallocated.length
      ? unallocatedHours === null ? "学生课时缺失，合计不完整；归属待核对"
        : unallocated.some((lesson) => lesson.hoursIssue) ? "来源课时含越界值，待核对；归属待核对" : "学生课时未分配，待核对"
      : "本月逐课次老师已明确，课时已在上表按老师归属", 23),
    ...Array.from({ length: 4 }, () => stringCell(null, 23)),
  ]);
  heights.set(rows.length, 31.5);
  return worksheetXml({ rows, widths: TEMPLATE_MAIN_WIDTHS, merges, freezeRows: 3, landscape: true, rowHeights: heights });
}

type HoursOnlyCourseGroup = {
  studentName: string;
  courseType: string;
  courseTitle: string;
  hours: number | null;
  ownedHours: number | null;
  trial: boolean;
  hasExceptionalHours: boolean;
  sourceKeys: Set<string>;
};

function hoursOnlyCourseIdentity(line: PayrollExportLine, evidence: ReadonlyMap<string, PayrollExportLessonEvidence>) {
  const lesson = line.sourceKey ? evidence.get(line.sourceKey) : undefined;
  const courseType = lesson?.teamTitle ?? (line.isTrial ? "试听" : "");
  const courseTitle = lesson?.courseTitle ?? "";
  return {
    courseType,
    courseTitle,
    key: JSON.stringify([aggregationKey(line), courseType, courseTitle, Boolean(line.isTrial)]),
  };
}

function isHoursOnlyStudentLineOwned(
  line: PayrollExportLine,
  teacherKey: string,
  evidence: ReadonlyMap<string, PayrollExportLessonEvidence>,
  owners: ReadonlyMap<string, string>,
) {
  return !evidence.size || Boolean(line.sourceKey && owners.get(line.sourceKey) === teacherKey);
}

function hoursOnlyCourseGroups(
  payroll: PayrollExportRow,
  evidence: ReadonlyMap<string, PayrollExportLessonEvidence>,
  owners: ReadonlyMap<string, string>,
) {
  const groups = new Map<string, HoursOnlyCourseGroup>();
  for (const line of payroll.lines) {
    const { courseType, courseTitle, key } = hoursOnlyCourseIdentity(line, evidence);
    const group = groups.get(key) ?? {
      studentName: line.studentName, courseType, courseTitle, hours: 0, ownedHours: 0,
      trial: false, hasExceptionalHours: false, sourceKeys: new Set<string>(),
    };
    group.hours = safeSourceSum(group.hours, line.hours);
    if (isHoursOnlyStudentLineOwned(line, payroll.teacherKey, evidence, owners)) {
      group.ownedHours = safeSourceSum(group.ownedHours, line.hours);
    }
    group.hasExceptionalHours ||= Boolean(line.hoursIssue || line.hours === null);
    group.trial ||= Boolean(line.isTrial);
    if (line.sourceKey) group.sourceKeys.add(line.sourceKey);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function hoursOnlyDetailCells(
  payroll: PayrollExportRow,
  group: HoursOnlyCourseGroup,
  rowNumber: number,
  evidence: ReadonlyMap<string, PayrollExportLessonEvidence>,
) {
  const note = [attendanceSummary(group.sourceKeys, evidence), group.trial ? "试听" : "",
    group.hasExceptionalHours ? group.hours === null || group.ownedHours === null
      ? "课时缺失，合计不完整" : "来源课时越界，待核对" : "",
    group.hours !== group.ownedHours ? "学生课时计于主讲或待核对区" : "",
    payroll.paymentMode === "review_only" ? "待核对" : ""].filter(Boolean).join("；");
  const cells: SheetRow = [
    numberCell(rowNumber - 3, 18), stringCell(payroll.teacherName, 18), stringCell(group.studentName, 19),
    numberCell(group.hours !== group.ownedHours && group.ownedHours === 0 ? null : group.ownedHours, 20),
    stringCell(null, 18), stringCell(null, 18), stringCell(group.courseType, 18),
    stringCell(group.courseTitle, 22), stringCell(note, 22),
  ];
  return { cells, height: fittedHeight([{ value: group.courseTitle, width: 21 }, { value: note, width: 29 }]) };
}

function hoursOnlyUnallocatedDetailCells(lesson: PayrollExportLessonEvidence, rowNumber: number) {
  const note = lesson.hours === null || lesson.hoursIssue
    ? lesson.hours === null ? "多教师学生课时归属待核对；课时缺失，合计不完整" : "多教师学生课时归属待核对；来源课时越界，待核对"
    : "多教师学生课时归属待核对";
  const cells: SheetRow = [
    numberCell(rowNumber - 3, 18), ...hoursOnlyUnallocatedSourceCells(lesson), stringCell(note, 22),
  ];
  return { cells, height: fittedHeight([{ value: lesson.courseTitle ?? "", width: 21 }, { value: note, width: 29 }]) };
}

function hoursOnlyStudentDetailSheet(input: PayrollWorkbookExport, year: number, month: number) {
  const rows: SheetRow[] = [
    [stringCell(`${year}年${String(month).padStart(2, "0")}月学生课时明细`, 15)],
    [stringCell(TEMPLATE_SOURCE_LABEL, 16)],
    ["序号", "教师姓名（教务宝原始）", "学生姓名", "课时（小时）", "课时费单价（小时）", "合计", "课程类型", "课程名称", "备注"].map((value) => stringCell(value, 17)),
  ];
  const heights = new Map<number, number>([[1, 59.55], [2, 36.5], [3, 31.5]]);
  const evidence = lessonEvidenceBySourceKey(input);
  const owners = studentHoursOwnerBySourceKey(input);
  for (const payroll of input.rows) {
    for (const group of hoursOnlyCourseGroups(payroll, evidence, owners)) {
      const rowNumber = rows.length + 1;
      const detail = hoursOnlyDetailCells(payroll, group, rowNumber, evidence);
      rows.push(detail.cells);
      heights.set(rowNumber, detail.height);
    }
  }
  for (const lesson of input.evidence?.lessons ?? []) {
    if (owners.has(lesson.sourceKey)) continue;
    const rowNumber = rows.length + 1;
    const detail = hoursOnlyUnallocatedDetailCells(lesson, rowNumber);
    rows.push(detail.cells);
    heights.set(rowNumber, detail.height);
  }
  return worksheetXml({ rows, widths: TEMPLATE_STUDENT_WIDTHS, merges: ["A1:I1", "A2:I2"], freezeRows: 3, landscape: true, rowHeights: heights });
}

const PAYROLL_REVIEW_HEADERS = [
  "月份", "老师", "教师类别", "币种", "状态", "薪资表课时", "教务宝老师课时", "课时差异", "建议金额", "银行", "账户", "付款说明", "锁定人", "锁定时间",
];
const PAYROLL_REVIEW_WIDTHS = [12, 22, 24, 9, 12, 14, 17, 12, 14, 18, 23, 40, 16, 24];

function payrollReviewHeader(): SheetRow {
  return PAYROLL_REVIEW_HEADERS.map((value) => stringCell(value, 3));
}

function hoursOnlyReviewSheet(input: PayrollWorkbookExport) {
  const rows: SheetRow[] = [payrollReviewHeader()];
  for (const payroll of input.rows) {
    rows.push([
      stringCell(input.month), stringCell(payroll.teacherName), stringCell(payroll.section),
      stringCell(null), stringCell("课时待核对"), stringCell(null), sourceHourCell(payroll.sourceHours),
      ...Array.from({ length: 7 }, () => stringCell(null)),
    ]);
  }
  return worksheetXml({ rows, widths: PAYROLL_REVIEW_WIDTHS, freezeRows: 1, landscape: true });
}

function payrollReviewSheet(input: PayrollWorkbookExport) {
  const rows: SheetRow[] = [payrollReviewHeader()];
  for (const payroll of input.rows) {
    const reviewOnly = payroll.paymentMode === "review_only";
    const sourceHours = payroll.sourceHours ?? null;
    const variance = sourceHours === null ? null : payroll.payrollHours - sourceHours;
    const moneyStyle = payroll.currency === "CNY" ? 12 : 13;
    rows.push([
      stringCell(input.month), stringCell(payroll.teacherName), stringCell(payroll.section), stringCell(payroll.currency), stringCell(reviewOnly ? "需核对" : payroll.status),
      numberCell(reviewOnly ? 0 : payroll.payrollHours), numberCell(sourceHours), numberCell(reviewOnly ? null : variance),
      reviewOnly ? stringCell(null, moneyStyle) : numberCell(payroll.amount, moneyStyle),
      stringCell(reviewOnly ? null : payroll.bankName), stringCell(reviewOnly ? null : payroll.bankAccount),
      stringCell(reviewOnly ? null : payroll.paymentNote), stringCell(reviewOnly ? null : payroll.lockedBy), stringCell(reviewOnly ? null : payroll.lockedAt),
    ]);
  }
  return worksheetXml({ rows, widths: PAYROLL_REVIEW_WIDTHS, freezeRows: 1, landscape: true });
}

function teacherDescription(teachers: readonly PayrollExportTeacherLink[]) {
  return teachers.map((teacher) => [
    teacher.role,
    teacher.sourceTeacherName ?? teacher.sourceTeacherId ?? "来源老师待补",
    teacher.teacherName ?? teacher.teacherId ?? "系统老师待匹配",
    teacher.teacherMatch,
  ].join(" / ")).join("；");
}

function lessonEvidenceSheet(input: PayrollWorkbookExport) {
  const rows: SheetRow[] = [[
    "来源键", "分校 ID", "排课 ID", "日期", "时间", "教务宝学员 ID", "教务宝账号名", "展示学生名", "系统学生 ID", "系统学生名", "匹配状态", "学生课时", "课时核对", "试听", "签到代码", "签到状态", "课程", "班级", "老师角色与匹配",
  ].map((value) => stringCell(value, 3))];
  for (const item of input.evidence?.lessons ?? []) {
    rows.push([
      stringCell(item.sourceKey), stringCell(jiaowubaoCompletedLessonBranchDisplay(item.branchId)), stringCell(item.calendarId), stringCell(item.lessonDate), stringCell(item.timeTitle),
      stringCell(item.memberId), stringCell(item.memberName), stringCell(item.displayStudentName), stringCell(item.studentId), stringCell(item.studentName),
      stringCell(item.studentMatch), sourceHourCell(item.hours), stringCell(item.hoursIssue ? "待核对" : "正常"), stringCell(item.isTrial ? "是" : "否"), numberCell(item.attendanceCode),
      stringCell(item.attendanceTitle), stringCell(item.courseTitle), stringCell(item.teamTitle), stringCell(teacherDescription(item.teachers)),
    ]);
  }
  return worksheetXml({ rows, widths: [38, 16, 18, 13, 16, 19, 23, 23, 19, 23, 18, 12, 13, 9, 11, 14, 28, 28, 48], freezeRows: 1, landscape: true });
}

function scheduleEvidenceSheet(input: PayrollWorkbookExport) {
  const rows: SheetRow[] = [[
    "来源键", "排课 ID", "日期", "时间", "课程", "班级", "老师角色", "教务宝老师 ID", "教务宝老师名", "系统老师 ID", "系统老师名", "匹配状态", "角色老师课时", "课时核对",
  ].map((value) => stringCell(value, 3))];
  for (const item of input.evidence?.schedules ?? []) {
    const teachers = item.teachers.length ? item.teachers : [null];
    for (const teacher of teachers) {
      rows.push([
        stringCell(item.sourceKey), stringCell(item.calendarId), stringCell(item.lessonDate), stringCell(item.timeTitle), stringCell(item.courseTitle), stringCell(item.teamTitle),
        stringCell(teacher?.role ?? "无老师角色"), stringCell(teacher?.sourceTeacherId), stringCell(teacher?.sourceTeacherName),
        stringCell(teacher?.teacherId), stringCell(teacher?.teacherName), stringCell(teacher?.teacherMatch), sourceHourCell(teacher?.sourceTeacherHours), stringCell(teacher?.sourceTeacherHoursIssue || teacher?.sourceTeacherHours == null ? "待核对" : "正常"),
      ]);
    }
  }
  return worksheetXml({ rows, widths: [38, 18, 13, 16, 28, 28, 13, 20, 22, 19, 22, 18, 15, 13], freezeRows: 1, landscape: true });
}

function sourceSheet(input: PayrollWorkbookExport) {
  const evidence = input.evidence;
  const scheduleCalendarIds = new Set(evidence?.schedules.map((schedule) => schedule.calendarId) ?? []);
  const missingScheduleCalendarIds = new Set(evidence?.lessons
    .filter((lesson) => !scheduleCalendarIds.has(lesson.calendarId))
    .map((lesson) => lesson.calendarId) ?? []);
  const missingStudentHours = evidence?.lessons.filter((lesson) => lesson.hours === null).length ?? 0;
  const exceptionalStudentHours = evidence?.lessons.filter((lesson) => lesson.hoursIssue).length ?? 0;
  const studentHoursTotal = evidence
    ? evidence.lessons.reduce<number | null>((total, lesson) => safeSourceSum(total, lesson.hours), 0)
    : 0;
  const studentHours = missingStudentHours > 0
    ? `不完整：${missingStudentHours} 条课时缺失`
    : studentHoursTotal === null ? "课时数值无法安全合计，待核对" : studentHoursTotal;
  const unresolvedTeacherHours = missingScheduleCalendarIds.size + (evidence?.schedules.reduce(
    (total, schedule) => total + (schedule.teachers.length
      ? schedule.teachers.filter((teacher) => teacher.sourceTeacherHours === null || teacher.sourceTeacherHoursIssue).length
      : 1), 0,
  ) ?? 0);
  const sourceRows: Array<readonly [string, CellValue]> = [
    ["导出月份", input.month],
    ["导出时间", input.generatedAt],
    ["来源状态", evidence ? "完整双源快照" : "未附教务宝双源快照"],
    ["来源发布时间", evidence?.publishedAt ?? ""],
    ["来源修订", evidence?.revision ?? ""],
    ["映射修订", evidence?.projectionRevision ?? ""],
    ["query_lesson_list 来源行数", evidence?.lessonRowCount ?? 0],
    ["query_schedule_list 来源事件数", evidence?.scheduleRowCount ?? 0],
    ["已匹配学生", evidence?.matchCounts.matchedStudents ?? 0],
    ["未匹配学生", evidence?.matchCounts.unmatchedStudents ?? 0],
    ["冲突学生", evidence?.matchCounts.ambiguousStudents ?? 0],
    ["已匹配老师", evidence?.matchCounts.matchedTeachers ?? 0],
    ["未匹配老师", evidence?.matchCounts.unmatchedTeachers ?? 0],
    ["冲突老师", evidence?.matchCounts.ambiguousTeachers ?? 0],
    ["学生与出勤来源", "query_lesson_list；over=1；按完整自然月、逐个教务宝学员 ID 分页读取；ID 清单合并当前名册、已确认/历史身份与当月已结课排课参与者"],
    ["完整性规则", "每页核对来源 total 并可跨任务续跑；冻结清单全部完成、排课修订复核一致后才原子发布；导出前重新完整读取并核对月份、来源修订、映射修订及双源行数，变化或异常时本次不下载；每位老师的学生明细来源键必须与当前快照双向一致，并逐行核对姓名、课时、试听分类和身份字段"],
    ["老师总课时来源", "query_schedule_list；over=1；只使用 teacher_hour / teacher_s_hour / teacher_t_hour 对应角色字段"],
    ["共享试听账号规则", "试听学员 A/B/C 保留原账号；展示姓名从已消课课程标题或唯一系统姓名安全解析"],
    ["核算边界", "学生消课课时用于学生明细；老师总课时来自排课角色字段。小组课不得按学生人数重复计算老师薪资。"],
    ["付款安全", "待匹配、冲突、来源缺失、异常课时、来源或映射修订变化、课时不一致的老师只导出待核对证据，不导出金额、银行、付款说明或锁定信息。"],
    ["学生实扣课时总计", evidence ? studentHours : "无来源"],
    ["异常学生来源课时数", exceptionalStudentHours],
    ["异常老师角色课时数", unresolvedTeacherHours],
  ];
  const rows: SheetRow[] = [[stringCell("项目", 3), stringCell("内容", 3)]];
  for (const [label, value] of sourceRows) {
    rows.push([stringCell(label), typeof value === "number" ? numberCell(value) : stringCell(value)]);
  }
  return worksheetXml({ rows, widths: [28, 110], freezeRows: 1, landscape: true });
}

function stylesXml() {
  const fills = ["FCE4D6", "DDEBF7", "E2F0D9", "FFF2CC", "E4DFEC", "F4CCCC"];
  const pastelXfs = fills.map((_, index) => `<xf numFmtId="0" fontId="0" fillId="${index + 4}" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="¥#,##0.00"/><numFmt numFmtId="165" formatCode="A$#,##0.00"/></numFmts>
  <fonts count="9">
    <font><sz val="12"/><name val="宋体"/><family val="3"/></font>
    <font><b/><sz val="28"/><name val="宋体"/><family val="3"/></font>
    <font><b/><sz val="18"/><name val="宋体"/><family val="3"/></font>
    <font><b/><sz val="12"/><name val="宋体"/><family val="3"/></font>
    <font><sz val="14"/><name val="宋体"/><family val="3"/></font>
    <font><b/><sz val="36"/><name val="宋体"/><family val="3"/></font>
    <font><b/><sz val="28"/><name val="宋体"/><family val="3"/></font>
    <font><sz val="14"/><color rgb="FFFF0000"/><name val="宋体"/><family val="3"/></font>
    <font><b/><sz val="14"/><name val="宋体"/><family val="3"/></font>
  </fonts>
  <fills count="11">
    <fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFD966"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill>
    ${fills.map((color) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`).join("")}
    <fill><patternFill patternType="solid"><fgColor rgb="FFFCD9FF"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2"><border/><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="25">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="2" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    ${pastelXfs}
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="5" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="6" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="8" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="10" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="2" fontId="4" fillId="0" borderId="1" applyFont="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="2" fontId="7" fillId="0" borderId="1" applyFont="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="2" fontId="8" fillId="3" borderId="1" applyFont="1" applyFill="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="6" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function contentTypesXml(sheetCount: number) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function workbookXml(sheetNames: readonly string[]) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews>
  <sheets>${sheetNames.map((name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>
  <calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`;
}

function workbookRelationshipsXml(sheetCount: number) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${Array.from({ length: sheetCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}
  <Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function packageParts(input: PayrollWorkbookExport, year: number, month: number): OpenXmlPart[] {
  const completeSheets = input.exportMode === "hours_complete" ? completeHoursSheets(input, year, month) : null;
  const sheetNames = completeSheets?.map((sheet) => sheet.name) ?? ["Sheet1", "学生明细", "薪资审核", "消课证据", "排课课时", "数据来源"];
  const hoursOnly = input.exportMode === "hours_only";
  const sheets = completeSheets?.map(worksheetXml) ?? [
    hoursOnly ? hoursOnlyMainSheet(input, year, month) : mainSheet(input, year, month),
    hoursOnly ? hoursOnlyStudentDetailSheet(input, year, month) : studentDetailSheet(input),
    hoursOnly ? hoursOnlyReviewSheet(input) : payrollReviewSheet(input),
    lessonEvidenceSheet(input),
    scheduleEvidenceSheet(input),
    sourceSheet(input),
  ];
  const timestamp = new Date(input.generatedAt).toISOString();
  return [
    { name: "[Content_Types].xml", xml: contentTypesXml(sheetNames.length) },
    { name: "_rels/.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: "docProps/core.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(`吟领教育 ${input.month} 教务宝课时表`)}</dc:title><dc:creator>Yinling Operations</dc:creator><cp:lastModifiedBy>Yinling Operations</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>` },
    { name: "docProps/app.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Yinling Operations</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheetNames.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${sheetNames.length}" baseType="lpstr">${sheetNames.map((name) => `<vt:lpstr>${xml(name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts><Company>吟领教育</Company><AppVersion>1.0</AppVersion></Properties>` },
    { name: "xl/workbook.xml", xml: workbookXml(sheetNames) },
    { name: "xl/_rels/workbook.xml.rels", xml: workbookRelationshipsXml(sheetNames.length) },
    { name: "xl/styles.xml", xml: completeSheets ? completeHoursStylesXml() : stylesXml() },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, xml: sheet })),
  ];
}

function hoursOnlySourceRows(input: PayrollWorkbookExport) {
  const lessons = lessonEvidenceBySourceKey(input);
  const totals = new Map<string, { hours: number | null; calendars: Set<string> }>();
  for (const schedule of input.evidence?.schedules ?? []) {
    for (const teacher of schedule.teachers) {
      const key = jiaowubaoCompletedLessonTeacherIdentityKey(teacher);
      const total = totals.get(key) ?? { hours: 0, calendars: new Set<string>() };
      total.hours = safeSourceSum(total.hours, teacher.sourceTeacherHours);
      total.calendars.add(schedule.calendarId);
      totals.set(key, total);
    }
  }
  return input.rows.map((row) => {
    if (row.sourceHours != null) return row;
    const total = totals.get(row.teacherKey);
    if (!total || row.lines.some((line) => {
      const lesson = line.sourceKey ? lessons.get(line.sourceKey) : undefined;
      return !lesson || !total.calendars.has(lesson.calendarId);
    })) return row;
    return { ...row, sourceHours: total.hours };
  });
}

export function buildPayrollXlsx(input: PayrollWorkbookExport) {
  const { year, month } = assertWorkbook(input);
  const displayed = input.exportMode === "hours_only" ? { ...input, rows: hoursOnlySourceRows(input) } : input;
  return createStoredOpenXmlZip(packageParts(displayed, year, month));
}

export function payrollXlsxFilename(month: string, exportMode?: PayrollWorkbookExport["exportMode"]) {
  if (!MONTH.test(month)) fail("导出月份格式无效。");
  if (exportMode === "hours_complete") return `${month.slice(0, 4)}年${month.slice(5)}月教务宝课时表_完整版.xlsx`;
  return `吟领教育-${month}-教务宝课时表.xlsx`;
}

export function downloadPayrollExcel(input: PayrollWorkbookExport) {
  const bytes = buildPayrollXlsx(input);
  const blob = new Blob([bytes], { type: PAYROLL_XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = payrollXlsxFilename(input.month, input.exportMode);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
