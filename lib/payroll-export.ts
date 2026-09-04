import { createStoredOpenXmlZip, type OpenXmlPart } from "@/lib/openxml-xlsx";
import { jiaowubaoCompletedLessonBranchDisplay } from "@/lib/jiaowubao-completed-lesson-branch";

export const PAYROLL_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type PayrollExportLine = Readonly<{
  studentName: string;
  hours: number;
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
  hours: number;
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
  teachers: readonly (PayrollExportTeacherLink & Readonly<{ sourceTeacherHours: number | null }>)[];
}>;

export type PayrollExportEvidence = Readonly<{
  revision: string | null;
  projectionRevision: string | null;
  publishedAt: string | null;
  lessonRowCount: number;
  scheduleRowCount: number;
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
  rows: readonly PayrollExportRow[];
  evidence?: PayrollExportEvidence;
}>;

type CellValue = string | number | null;
type Cell = Readonly<{ value: CellValue; style?: number }>;
type SheetRow = readonly Cell[];

type AggregatedStudent = {
  studentName: string;
  regularHours: number;
  trialHours: number;
  hours: number;
  rates: Set<number>;
  subtotal: number;
  lessonCount: number;
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
      evidenceOnly: true,
      studentIds: new Set<string>(),
      sourceMemberIds: new Set<string>(),
      sourceKeys: new Set<string>(),
      studentMatches: new Set<string>(),
      notes: new Set<string>(),
    };
    const hours = number(line.hours, "学生课时");
    existing.hours = number(existing.hours + hours, "学生课时合计");
    if (line.isTrial) existing.trialHours = number(existing.trialHours + hours, "试听课时");
    else existing.regularHours = number(existing.regularHours + hours, "常规课时");
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
  const match = MONTH.exec(input.month);
  if (!match) fail("导出月份格式无效。");
  const generatedAt = new Date(input.generatedAt);
  if (Number.isNaN(generatedAt.valueOf()) || generatedAt.toISOString() !== input.generatedAt) fail("导出时间格式无效。");
  if (!Array.isArray(input.rows) || input.rows.length > MAX_EXPORT_ROWS) fail("薪资导出行数无效。");
  let payrollDetailRows = 0;
  for (const row of input.rows) {
    if (!row.teacherKey?.trim() || !row.teacherName?.trim()) fail("老师身份或姓名不能为空。");
    safeText(row.teacherKey, "老师身份");
    safeText(row.teacherName, "老师姓名");
    if (row.month !== input.month || !MONTH.test(row.month)) fail("薪资行月份与导出月份不一致。");
    if (row.currency !== "CNY" && row.currency !== "AUD") fail("薪资币种无效。");
    if (row.paymentMode !== "payable" && row.paymentMode !== "review_only") fail("付款模式无效。");
    number(row.payrollHours, "薪资课时");
    if (row.sourceHours != null) number(row.sourceHours, "教务宝老师课时");
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
  }
  if (input.evidence) {
    integer(input.evidence.lessonRowCount, "消课来源行数", MAX_EVIDENCE_ROWS);
    integer(input.evidence.scheduleRowCount, "排课来源行数", MAX_EVIDENCE_ROWS);
    if (input.evidence.lessonRowCount !== input.evidence.lessons.length
      || input.evidence.scheduleRowCount !== input.evidence.schedules.length) {
      fail("教务宝证据行数与来源统计不一致。");
    }
    for (const [label, value] of Object.entries(input.evidence.matchCounts)) {
      integer(value, label, MAX_EVIDENCE_ROWS * 3);
    }
  }
  return { year: Number(match[1]), month: Number(match[2]) };
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
      const hasPayableLines = Boolean(student && !student.evidenceOnly);
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

function payrollReviewSheet(input: PayrollWorkbookExport) {
  const rows: SheetRow[] = [[
    "月份", "老师", "教师类别", "币种", "状态", "薪资表课时", "教务宝老师课时", "课时差异", "建议金额", "银行", "账户", "付款说明", "锁定人", "锁定时间",
  ].map((value) => stringCell(value, 3))];
  for (const payroll of input.rows) {
    const reviewOnly = payroll.paymentMode === "review_only";
    const sourceHours = payroll.sourceHours ?? null;
    const variance = sourceHours === null ? null : payroll.payrollHours - sourceHours;
    const moneyStyle = payroll.currency === "CNY" ? 12 : 13;
    rows.push([
      stringCell(input.month), stringCell(payroll.teacherName), stringCell(payroll.section), stringCell(payroll.currency), stringCell(payroll.status),
      numberCell(payroll.payrollHours), numberCell(sourceHours), numberCell(variance),
      reviewOnly ? stringCell(null, moneyStyle) : numberCell(payroll.amount, moneyStyle),
      stringCell(reviewOnly ? null : payroll.bankName), stringCell(reviewOnly ? null : payroll.bankAccount),
      stringCell(reviewOnly ? null : payroll.paymentNote), stringCell(reviewOnly ? null : payroll.lockedBy), stringCell(reviewOnly ? null : payroll.lockedAt),
    ]);
  }
  return worksheetXml({ rows, widths: [12, 22, 24, 9, 12, 14, 17, 12, 14, 18, 23, 40, 16, 24], freezeRows: 1, landscape: true });
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
    "来源键", "分校 ID", "排课 ID", "日期", "时间", "教务宝学员 ID", "教务宝账号名", "展示学生名", "系统学生 ID", "系统学生名", "匹配状态", "学生课时", "试听", "签到代码", "签到状态", "课程", "班级", "老师角色与匹配",
  ].map((value) => stringCell(value, 3))];
  for (const item of input.evidence?.lessons ?? []) {
    rows.push([
      stringCell(item.sourceKey), stringCell(jiaowubaoCompletedLessonBranchDisplay(item.branchId)), stringCell(item.calendarId), stringCell(item.lessonDate), stringCell(item.timeTitle),
      stringCell(item.memberId), stringCell(item.memberName), stringCell(item.displayStudentName), stringCell(item.studentId), stringCell(item.studentName),
      stringCell(item.studentMatch), numberCell(item.hours), stringCell(item.isTrial ? "是" : "否"), numberCell(item.attendanceCode),
      stringCell(item.attendanceTitle), stringCell(item.courseTitle), stringCell(item.teamTitle), stringCell(teacherDescription(item.teachers)),
    ]);
  }
  return worksheetXml({ rows, widths: [38, 16, 18, 13, 16, 19, 23, 23, 19, 23, 18, 12, 9, 11, 14, 28, 28, 48], freezeRows: 1, landscape: true });
}

function scheduleEvidenceSheet(input: PayrollWorkbookExport) {
  const rows: SheetRow[] = [[
    "来源键", "排课 ID", "日期", "时间", "课程", "班级", "老师角色", "教务宝老师 ID", "教务宝老师名", "系统老师 ID", "系统老师名", "匹配状态", "角色老师课时",
  ].map((value) => stringCell(value, 3))];
  for (const item of input.evidence?.schedules ?? []) {
    const teachers = item.teachers.length ? item.teachers : [null];
    for (const teacher of teachers) {
      rows.push([
        stringCell(item.sourceKey), stringCell(item.calendarId), stringCell(item.lessonDate), stringCell(item.timeTitle), stringCell(item.courseTitle), stringCell(item.teamTitle),
        stringCell(teacher?.role ?? "无老师角色"), stringCell(teacher?.sourceTeacherId), stringCell(teacher?.sourceTeacherName),
        stringCell(teacher?.teacherId), stringCell(teacher?.teacherName), stringCell(teacher?.teacherMatch), numberCell(teacher?.sourceTeacherHours),
      ]);
    }
  }
  return worksheetXml({ rows, widths: [38, 18, 13, 16, 28, 28, 13, 20, 22, 19, 22, 18, 15], freezeRows: 1, landscape: true });
}

function sourceSheet(input: PayrollWorkbookExport) {
  const evidence = input.evidence;
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
    ["完整性规则", "每页核对来源 total 并可跨任务续跑；冻结清单全部完成、排课修订复核一致后才原子发布，半成品不会进入薪资表"],
    ["老师总课时来源", "query_schedule_list；over=1；只使用 teacher_hour / teacher_s_hour / teacher_t_hour 对应角色字段"],
    ["共享试听账号规则", "试听学员 A/B/C 保留原账号；展示姓名从已消课课程标题或唯一系统姓名安全解析"],
    ["核算边界", "学生消课课时用于学生明细；老师总课时来自排课角色字段。小组课不得按学生人数重复计算老师薪资。"],
    ["付款安全", "待匹配、冲突、来源缺失或课时不一致的老师只导出待核对证据，不导出金额、银行、付款说明或锁定信息。"],
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
  <fonts count="4">
    <font><sz val="12"/><name val="宋体"/><family val="3"/></font>
    <font><b/><sz val="28"/><name val="宋体"/><family val="3"/></font>
    <font><b/><sz val="18"/><name val="宋体"/><family val="3"/></font>
    <font><b/><sz val="12"/><name val="宋体"/><family val="3"/></font>
  </fonts>
  <fills count="10">
    <fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFD966"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill>
    ${fills.map((color) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`).join("")}
  </fills>
  <borders count="2"><border/><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="15">
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
  const sheetNames = ["Sheet1", "学生明细", "薪资审核", "消课证据", "排课课时", "数据来源"] as const;
  const sheets = [
    mainSheet(input, year, month),
    studentDetailSheet(input),
    payrollReviewSheet(input),
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
    { name: "xl/styles.xml", xml: stylesXml() },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, xml: sheet })),
  ];
}

export function buildPayrollXlsx(input: PayrollWorkbookExport) {
  const { year, month } = assertWorkbook(input);
  return createStoredOpenXmlZip(packageParts(input, year, month));
}

export function payrollXlsxFilename(month: string) {
  if (!MONTH.test(month)) fail("导出月份格式无效。");
  return `吟领教育-${month}-教务宝课时表.xlsx`;
}

export function downloadPayrollExcel(input: PayrollWorkbookExport) {
  const bytes = buildPayrollXlsx(input);
  const blob = new Blob([bytes], { type: PAYROLL_XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = payrollXlsxFilename(input.month);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
