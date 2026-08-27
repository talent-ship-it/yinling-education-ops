import {
  readXlsx,
  type XlsxCell,
  type XlsxCellType,
  type XlsxRow,
  type XlsxWorkbook,
} from "./xlsx-reader";

/**
 * Parser for the seven point-in-time Jiaowubao spreadsheet exports supplied
 * for the August 2026 migration.  This module is intentionally a parser, not
 * an importer: it has no Tencent lookup, writes no data, and never creates or
 * attaches a student.  The later static-import service owns those decisions.
 */

export const JIAOWUBAO_STATIC_XLSX_FORMAT = "jiaowubao-static-excel-v1" as const;
export const JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE = "Australia/Melbourne" as const;
export const JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE_BASIS =
  "The Jiaowubao static schedule export has no timezone column; the migration source wall-clock timezone is the business-approved Australia/Melbourne IANA timezone." as const;

/** The source workbook is a daily grid whose B column is known to be 2021-08-03. */
export const JIAOWUBAO_STATIC_SCHEDULE_GRID_ORIGIN_DATE = "2021-08-03" as const;
export const JIAOWUBAO_STATIC_SCHEDULE_GRID_ORIGIN_COLUMN = 2 as const;

export type JiaowubaoStaticWorkbookKey =
  | "quick_list"
  | "students"
  | "contracts"
  | "hours"
  | "class_members"
  | "schedule"
  | "leave_makeups";

export type JiaowubaoStaticHeaderWorkbookKey = Extract<
  JiaowubaoStaticWorkbookKey,
  "quick_list" | "students" | "contracts" | "hours"
>;

export type JiaowubaoStaticSourceRef = Readonly<{
  /** A stable workbook role, not a user supplied file name. */
  workbook: JiaowubaoStaticWorkbookKey;
  /** One-based worksheet row from the original export. */
  row: number;
  /** Exact A1 coordinate for a grid-backed source record such as a schedule cell. */
  cell?: string;
}>;

export type JiaowubaoStaticSourceInput = Readonly<{
  /** Original uploaded file name, retained for batch audit only. */
  workbookName: string;
  /** SHA-256 of the uploaded workbook, supplied by the upload boundary. */
  sha256: string;
  bytes: Uint8Array;
}>;

export type JiaowubaoStaticSourceDescriptor = Readonly<{
  workbookName: string;
  sha256: string;
}>;

export type JiaowubaoStaticWorkbookSource = Readonly<{
  workbook: JiaowubaoStaticWorkbookKey;
  workbookName: string;
  sha256: string;
  /** The parser requires one sheet because the storage source ref has no sheet field. */
  sheetName: string;
}>;

export type JiaowubaoStaticScalar = string | number | boolean | null;

/**
 * This mirrors an input cell without evaluating its formula.  `value` is the
 * cached source value supplied by Excel; `formula` is retained separately so
 * consumers never mistake a parser calculation for source data.
 */
export type JiaowubaoStaticRawCell = Readonly<{
  reference: string;
  type: XlsxCellType;
  value: JiaowubaoStaticScalar;
  rawValue?: string;
  formula?: string;
}>;

export type JiaowubaoStaticIdentityHint = Readonly<{
  name?: string;
  phone?: string;
  externalStudentNumber?: string;
}>;

export type JiaowubaoStaticParsedRecord<Payload> = Readonly<{
  /** Deterministic inside a revision: workbook role plus normalised source coordinate. */
  sourceKey: string;
  /** The database source-reference contract deliberately stores only workbook + row. */
  sourceRefs: readonly [JiaowubaoStaticSourceRef];
  /** Raw and positional facts only.  No Tencent attachment appears in this parser output. */
  payload: Readonly<Payload>;
}>;

export type JiaowubaoStaticTabularRaw = Readonly<{
  /** Header-value mapping, retaining all declared columns (including null cells). */
  fields: Readonly<Record<string, JiaowubaoStaticScalar>>;
  /** Per-header cell provenance, including cached formula information when supplied. */
  cells: Readonly<Record<string, JiaowubaoStaticRawCell>>;
}>;

export type JiaowubaoStaticTabularPayload = Readonly<{
  raw: JiaowubaoStaticTabularRaw;
  identity: JiaowubaoStaticIdentityHint;
}>;

export type JiaowubaoStaticTabularRecord = JiaowubaoStaticParsedRecord<JiaowubaoStaticTabularPayload>;

export type JiaowubaoStaticParsedHeaderWorkbook = Readonly<{
  source: JiaowubaoStaticWorkbookSource;
  headerRow: number;
  records: readonly JiaowubaoStaticTabularRecord[];
}>;

export type JiaowubaoStaticLeaveMakeupPayload = Readonly<{
  raw: JiaowubaoStaticTabularRaw;
  identity: JiaowubaoStaticIdentityHint;
  sourceDate?: string;
  sourceTime?: string;
  className?: string;
  course?: string;
  teacher?: string;
  status?: string;
}>;

export type JiaowubaoStaticLeaveMakeupRecord = JiaowubaoStaticParsedRecord<JiaowubaoStaticLeaveMakeupPayload>;

export type JiaowubaoStaticParsedLeaveMakeupWorkbook = Readonly<{
  source: JiaowubaoStaticWorkbookSource;
  headerRow: 3;
  records: readonly JiaowubaoStaticLeaveMakeupRecord[];
}>;

export type JiaowubaoStaticClassMembershipRaw = Readonly<{
  cells: Readonly<{
    A?: JiaowubaoStaticRawCell;
    B?: JiaowubaoStaticRawCell;
    C?: JiaowubaoStaticRawCell;
    D?: JiaowubaoStaticRawCell;
  }>;
  values: Readonly<{
    className: JiaowubaoStaticScalar;
    classType: JiaowubaoStaticScalar;
    studentName: JiaowubaoStaticScalar;
    phone: JiaowubaoStaticScalar;
  }>;
}>;

export type JiaowubaoStaticClassMembershipPayload = Readonly<{
  raw: JiaowubaoStaticClassMembershipRaw;
  className?: string;
  classType?: string;
  studentName?: string;
  identity: JiaowubaoStaticIdentityHint;
}>;

export type JiaowubaoStaticClassMembershipRecord = JiaowubaoStaticParsedRecord<JiaowubaoStaticClassMembershipPayload>;

export type JiaowubaoStaticParsedClassMembershipWorkbook = Readonly<{
  source: JiaowubaoStaticWorkbookSource;
  /** The source is positional A:D.  A present display header is skipped, not required. */
  records: readonly JiaowubaoStaticClassMembershipRecord[];
}>;

export type JiaowubaoStaticScheduleTimeParseReason =
  | "missing_time_interval"
  | "invalid_time_interval"
  | "non_positive_time_interval";

export type JiaowubaoStaticScheduleParseStatus =
  | Readonly<{ kind: "parsed"; start: string; end: string }>
  | Readonly<{ kind: "invalid_time"; reason: JiaowubaoStaticScheduleTimeParseReason }>;

export type JiaowubaoStaticScheduleRaw = Readonly<{
  cell: JiaowubaoStaticRawCell;
  /** Exact grid location; stored here because the source-ref database type is row-only. */
  cellRef: string;
  /** Raw schedule-header cell (for example the Chinese weekday/month/day display label). */
  dateHeader?: JiaowubaoStaticRawCell;
  rawText: string;
  rawLines: readonly string[];
}>;

export type JiaowubaoStaticSchedulePayload = Readonly<{
  raw: JiaowubaoStaticScheduleRaw;
  sourceDate: string;
  sourceTimezone: typeof JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE;
  sourceTimezoneBasis: typeof JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE_BASIS;
  parseStatus: JiaowubaoStaticScheduleParseStatus;
  /** Present only when the strict interval parser succeeds. */
  start?: string;
  end?: string;
  className?: string;
  course?: string;
  teacher?: string;
  assistants: readonly string[];
  declaredCount?: number;
  declaredCountRaw?: string;
  studentDisplayNames: readonly string[];
  /** Identity hints lack phone numbers in the schedule export and must not auto-attach. */
  identities: readonly JiaowubaoStaticIdentityHint[];
  /** Non-semantic positional fields are kept verbatim for future audited mapping. */
  unmappedPositionalLines: readonly Readonly<{ index: number; value: string }>[];
}>;

export type JiaowubaoStaticScheduleRecord = JiaowubaoStaticParsedRecord<JiaowubaoStaticSchedulePayload>;

export type JiaowubaoStaticParsedScheduleWorkbook = Readonly<{
  source: JiaowubaoStaticWorkbookSource;
  gridOriginDate: typeof JIAOWUBAO_STATIC_SCHEDULE_GRID_ORIGIN_DATE;
  gridOriginColumn: typeof JIAOWUBAO_STATIC_SCHEDULE_GRID_ORIGIN_COLUMN;
  sourceTimezone: typeof JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE;
  sourceTimezoneBasis: typeof JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE_BASIS;
  records: readonly JiaowubaoStaticScheduleRecord[];
  summary: Readonly<{
    cells: number;
    parsed: number;
    invalidTime: number;
  }>;
}>;

export type JiaowubaoStaticXlsxExportInput = Readonly<{
  quickList: JiaowubaoStaticSourceInput;
  students: JiaowubaoStaticSourceInput;
  contracts: JiaowubaoStaticSourceInput;
  hours: JiaowubaoStaticSourceInput;
  classMemberships: JiaowubaoStaticSourceInput;
  schedule: JiaowubaoStaticSourceInput;
  leaveMakeups: JiaowubaoStaticSourceInput;
}>;

export type JiaowubaoStaticParsedXlsxExports = Readonly<{
  format: typeof JIAOWUBAO_STATIC_XLSX_FORMAT;
  quickList: JiaowubaoStaticParsedHeaderWorkbook;
  students: JiaowubaoStaticParsedHeaderWorkbook;
  contracts: JiaowubaoStaticParsedHeaderWorkbook;
  hours: JiaowubaoStaticParsedHeaderWorkbook;
  classMemberships: JiaowubaoStaticParsedClassMembershipWorkbook;
  schedule: JiaowubaoStaticParsedScheduleWorkbook;
  leaveMakeups: JiaowubaoStaticParsedLeaveMakeupWorkbook;
}>;

export type JiaowubaoStaticXlsxParseErrorCode =
  | "invalid_source_metadata"
  | "multiple_worksheets"
  | "missing_header_row"
  | "invalid_header"
  | "duplicate_header"
  | "missing_required_column";

export class JiaowubaoStaticXlsxParseError extends Error {
  constructor(
    readonly code: JiaowubaoStaticXlsxParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JiaowubaoStaticXlsxParseError";
  }
}

const HEADER_REQUIRED_COLUMNS: Readonly<Record<JiaowubaoStaticHeaderWorkbookKey, readonly string[]>> = {
  quick_list: ["姓名", "手机号", "学员类型"],
  students: ["姓名", "手机号", "学员类型"],
  hours: ["姓名", "手机号", "课程", "课时数", "已消课时", "剩余课时"],
  contracts: ["姓名", "手机号", "课程"],
};

const LEAVE_REQUIRED_COLUMNS = ["姓名", "上课日期", "上课时间", "班级", "课程", "上课老师"] as const;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/gu;
const TIME_INTERVAL = /^\s*(\d{1,2})(?::|：)([0-5]\d)\s*(?:-|~|—|–|至|到)\s*(\d{1,2})(?::|：)([0-5]\d)\s*$/u;
const DECLARED_COUNT = /^(\d+)\s*人$/u;
const NO_STAFF_VALUES = new Set(["无", "无(助教)", "无（助教）", "无(助教2)", "无（助教2）", "-", "n/a", "na"]);

function fail(code: JiaowubaoStaticXlsxParseErrorCode, message: string): never {
  throw new JiaowubaoStaticXlsxParseError(code, message);
}

function cleanText(value: JiaowubaoStaticScalar | undefined) {
  if (value === undefined || value === null) return "";
  return String(value).normalize("NFKC").replace(INVISIBLE, "").trim();
}

function asRawCell(cell: XlsxCell): JiaowubaoStaticRawCell {
  return Object.freeze({
    reference: cell.reference,
    type: cell.type,
    value: cell.value,
    ...(cell.rawValue !== undefined ? { rawValue: cell.rawValue } : {}),
    ...(cell.formula !== undefined ? { formula: cell.formula } : {}),
  });
}

function rowCell(row: XlsxRow | undefined, column: number) {
  return row?.cells.find((cell) => cell.column === column);
}

function nonEmptyCell(cell: XlsxCell) {
  return cell.value !== null && !(typeof cell.value === "string" && cell.value.trim() === "");
}

function sourceKey(workbook: JiaowubaoStaticWorkbookKey, coordinate: string) {
  const normalizedCoordinate = coordinate.normalize("NFKC").trim().toLowerCase();
  return `jwb-static-v1:${workbook}:${normalizedCoordinate}`;
}

function sourceRef(workbook: JiaowubaoStaticWorkbookKey, row: number, cell?: string): readonly [JiaowubaoStaticSourceRef] {
  return Object.freeze([Object.freeze({ workbook, row, ...(cell ? { cell } : {}) })]) as readonly [JiaowubaoStaticSourceRef];
}

function dateAtScheduleColumn(column: number) {
  const date = new Date(`${JIAOWUBAO_STATIC_SCHEDULE_GRID_ORIGIN_DATE}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + column - JIAOWUBAO_STATIC_SCHEDULE_GRID_ORIGIN_COLUMN);
  return date.toISOString().slice(0, 10);
}

function descriptorFor(
  key: JiaowubaoStaticWorkbookKey,
  descriptor: JiaowubaoStaticSourceDescriptor,
  workbook: XlsxWorkbook,
) {
  const workbookName = descriptor.workbookName.trim();
  const sha256 = descriptor.sha256.trim().toLowerCase();
  if (!workbookName || !/^[a-f0-9]{64}$/u.test(sha256)) {
    fail("invalid_source_metadata", "Static Jiaowubao workbook metadata must contain a file name and SHA-256.");
  }
  if (workbook.worksheets.length !== 1) {
    fail("multiple_worksheets", "Each supplied Jiaowubao static workbook must have exactly one worksheet.");
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet.name.trim()) {
    fail("invalid_source_metadata", "Static Jiaowubao worksheet name is blank.");
  }
  return {
    source: Object.freeze({ workbook: key, workbookName, sha256, sheetName: worksheet.name }),
    worksheet,
  };
}

function headerCells(
  worksheet: XlsxWorkbook["worksheets"][number],
  headerRow: number,
  requiredColumns: readonly string[],
) {
  const row = worksheet.rows.find((candidate) => candidate.index === headerRow);
  if (!row) fail("missing_header_row", `Required header row ${headerRow} is missing.`);
  const headers = new Map<number, string>();
  const seen = new Set<string>();
  for (const cell of row.cells) {
    const header = cleanText(cell.value);
    if (!header) continue;
    if (seen.has(header)) fail("duplicate_header", `Header ${header} appears more than once.`);
    seen.add(header);
    headers.set(cell.column, header);
  }
  if (!headers.size) fail("invalid_header", `Header row ${headerRow} has no usable column names.`);
  for (const required of requiredColumns) {
    if (!seen.has(required)) fail("missing_required_column", `Required Jiaowubao column ${required} is absent.`);
  }
  return headers;
}

function tabularRaw(row: XlsxRow, headers: ReadonlyMap<number, string>) {
  const fields: Record<string, JiaowubaoStaticScalar> = {};
  const cells: Record<string, JiaowubaoStaticRawCell> = {};
  for (const [column, header] of headers) {
    const cell = rowCell(row, column);
    fields[header] = cell?.value ?? null;
    if (cell) cells[header] = asRawCell(cell);
  }
  return Object.freeze({
    fields: Object.freeze(fields),
    cells: Object.freeze(cells),
  }) as JiaowubaoStaticTabularRaw;
}

function isMeaningfulTabularRow(raw: JiaowubaoStaticTabularRaw) {
  return Object.values(raw.fields).some((value) => value !== null && (typeof value !== "string" || value.trim() !== ""));
}

function identityHint(fields: Readonly<Record<string, JiaowubaoStaticScalar>>): JiaowubaoStaticIdentityHint {
  const name = cleanText(fields.姓名 ?? fields.学员名) || undefined;
  const phone = cleanText(fields.手机号 ?? fields.学员手机号) || undefined;
  const externalStudentNumber = cleanText(fields.学员编号) || undefined;
  return Object.freeze({
    ...(name ? { name } : {}),
    ...(phone ? { phone } : {}),
    ...(externalStudentNumber ? { externalStudentNumber } : {}),
  });
}

function textField(fields: Readonly<Record<string, JiaowubaoStaticScalar>>, field: string) {
  return cleanText(fields[field]) || undefined;
}

function parseTabularWorkbook(
  key: JiaowubaoStaticWorkbookKey,
  descriptor: JiaowubaoStaticSourceDescriptor,
  workbook: XlsxWorkbook,
  headerRow: number,
  requiredColumns: readonly string[],
) {
  const { source, worksheet } = descriptorFor(key, descriptor, workbook);
  const headers = headerCells(worksheet, headerRow, requiredColumns);
  const records: JiaowubaoStaticTabularRecord[] = [];
  for (const row of worksheet.rows) {
    if (row.index <= headerRow) continue;
    const raw = tabularRaw(row, headers);
    if (!isMeaningfulTabularRow(raw)) continue;
    records.push(Object.freeze({
      sourceKey: sourceKey(key, `r${row.index}`),
      sourceRefs: sourceRef(key, row.index),
      payload: Object.freeze({ raw, identity: identityHint(raw.fields) }),
    }));
  }
  return Object.freeze({ source, headerRow, records: Object.freeze(records) });
}

/** Parse one of the four exports whose visible column names are in row 2. */
export function parseJiaowubaoStaticHeaderWorkbook(
  key: JiaowubaoStaticHeaderWorkbookKey,
  descriptor: JiaowubaoStaticSourceDescriptor,
  workbook: XlsxWorkbook,
): JiaowubaoStaticParsedHeaderWorkbook {
  return parseTabularWorkbook(key, descriptor, workbook, 2, HEADER_REQUIRED_COLUMNS[key]);
}

/** Parse the leave/makeup export whose visible column names are in row 3. */
export function parseJiaowubaoStaticLeaveMakeupWorkbook(
  descriptor: JiaowubaoStaticSourceDescriptor,
  workbook: XlsxWorkbook,
): JiaowubaoStaticParsedLeaveMakeupWorkbook {
  const parsed = parseTabularWorkbook("leave_makeups", descriptor, workbook, 3, LEAVE_REQUIRED_COLUMNS);
  const records = parsed.records.map((record): JiaowubaoStaticLeaveMakeupRecord => Object.freeze({
    sourceKey: record.sourceKey,
    sourceRefs: record.sourceRefs,
    payload: Object.freeze({
      raw: record.payload.raw,
      identity: record.payload.identity,
      ...(textField(record.payload.raw.fields, "上课日期") ? { sourceDate: textField(record.payload.raw.fields, "上课日期") } : {}),
      ...(textField(record.payload.raw.fields, "上课时间") ? { sourceTime: textField(record.payload.raw.fields, "上课时间") } : {}),
      ...(textField(record.payload.raw.fields, "班级") ? { className: textField(record.payload.raw.fields, "班级") } : {}),
      ...(textField(record.payload.raw.fields, "课程") ? { course: textField(record.payload.raw.fields, "课程") } : {}),
      ...(textField(record.payload.raw.fields, "上课老师") ? { teacher: textField(record.payload.raw.fields, "上课老师") } : {}),
      ...(textField(record.payload.raw.fields, "处理状态") ? { status: textField(record.payload.raw.fields, "处理状态") } : {}),
    }),
  }));
  return Object.freeze({ source: parsed.source, headerRow: 3, records: Object.freeze(records) });
}

function positionalCell(row: XlsxRow, column: number) {
  const cell = rowCell(row, column);
  return cell ? asRawCell(cell) : undefined;
}

function positionalValue(row: XlsxRow, column: number): JiaowubaoStaticScalar {
  return rowCell(row, column)?.value ?? null;
}

function isClassMembershipDisplayHeader(values: Readonly<{ className: JiaowubaoStaticScalar; classType: JiaowubaoStaticScalar; studentName: JiaowubaoStaticScalar; phone: JiaowubaoStaticScalar }>) {
  return cleanText(values.className) === "班级名"
    && cleanText(values.classType) === "班级类型"
    && cleanText(values.studentName) === "学员名"
    && cleanText(values.phone) === "学员手机号";
}

/**
 * The class-member export is parsed positionally from A:D.  It works whether
 * the export contains a cosmetic first-row header or not, but never infers a
 * different column layout from display text.
 */
export function parseJiaowubaoStaticClassMembershipWorkbook(
  descriptor: JiaowubaoStaticSourceDescriptor,
  workbook: XlsxWorkbook,
): JiaowubaoStaticParsedClassMembershipWorkbook {
  const { source, worksheet } = descriptorFor("class_members", descriptor, workbook);
  const records: JiaowubaoStaticClassMembershipRecord[] = [];
  for (const row of worksheet.rows) {
    const values = Object.freeze({
      className: positionalValue(row, 1),
      classType: positionalValue(row, 2),
      studentName: positionalValue(row, 3),
      phone: positionalValue(row, 4),
    });
    if (Object.values(values).every((value) => value === null || (typeof value === "string" && value.trim() === ""))) continue;
    if (isClassMembershipDisplayHeader(values)) continue;
    const raw = Object.freeze({
      cells: Object.freeze({
        ...(positionalCell(row, 1) ? { A: positionalCell(row, 1) } : {}),
        ...(positionalCell(row, 2) ? { B: positionalCell(row, 2) } : {}),
        ...(positionalCell(row, 3) ? { C: positionalCell(row, 3) } : {}),
        ...(positionalCell(row, 4) ? { D: positionalCell(row, 4) } : {}),
      }),
      values,
    }) as JiaowubaoStaticClassMembershipRaw;
    const className = cleanText(values.className) || undefined;
    const classType = cleanText(values.classType) || undefined;
    const studentName = cleanText(values.studentName) || undefined;
    const phone = cleanText(values.phone) || undefined;
    records.push(Object.freeze({
      sourceKey: sourceKey("class_members", `r${row.index}`),
      sourceRefs: sourceRef("class_members", row.index),
      payload: Object.freeze({
        raw,
        ...(className ? { className } : {}),
        ...(classType ? { classType } : {}),
        ...(studentName ? { studentName } : {}),
        identity: Object.freeze({
          ...(studentName ? { name: studentName } : {}),
          ...(phone ? { phone } : {}),
        }),
      }),
    }));
  }
  return Object.freeze({ source, records: Object.freeze(records) });
}

function parseTimeInterval(value: string): JiaowubaoStaticScheduleParseStatus {
  const match = TIME_INTERVAL.exec(value);
  if (!match) {
    return Object.freeze({
      kind: "invalid_time",
      reason: value.trim() ? "invalid_time_interval" : "missing_time_interval",
    });
  }
  const startHour = Number(match[1]);
  const endHour = Number(match[3]);
  if (startHour > 23 || endHour > 23) {
    return Object.freeze({ kind: "invalid_time", reason: "invalid_time_interval" });
  }
  const start = `${String(startHour).padStart(2, "0")}:${match[2]}`;
  const end = `${String(endHour).padStart(2, "0")}:${match[4]}`;
  const startMinutes = startHour * 60 + Number(match[2]);
  const endMinutes = endHour * 60 + Number(match[4]);
  if (endMinutes <= startMinutes) {
    return Object.freeze({ kind: "invalid_time", reason: "non_positive_time_interval" });
  }
  return Object.freeze({ kind: "parsed", start, end });
}

function optionalStaff(value: string | undefined) {
  if (!value || NO_STAFF_VALUES.has(value.normalize("NFKC").toLowerCase())) return undefined;
  return value;
}

function studentNames(value: string | undefined) {
  if (!value) return Object.freeze([]) as readonly string[];
  return Object.freeze(value.split(/[、，,]/u).map((part) => part.trim()).filter(Boolean));
}

function declaredCount(value: string | undefined) {
  if (!value) return undefined;
  const match = DECLARED_COUNT.exec(value);
  if (!match) return undefined;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : undefined;
}

function scheduleCellText(cell: XlsxCell) {
  return typeof cell.value === "string" ? cell.value : cell.value === null ? "" : String(cell.value);
}

/**
 * Parses every non-empty grid cell at/after B2.  A bad time is returned as an
 * invalid record (with its raw cell text and coordinate), never a batch error.
 */
export function parseJiaowubaoStaticScheduleWorkbook(
  descriptor: JiaowubaoStaticSourceDescriptor,
  workbook: XlsxWorkbook,
): JiaowubaoStaticParsedScheduleWorkbook {
  const { source, worksheet } = descriptorFor("schedule", descriptor, workbook);
  const headerRow = worksheet.rows.find((row) => row.index === 1);
  const records: JiaowubaoStaticScheduleRecord[] = [];
  let parsed = 0;
  let invalidTime = 0;

  for (const row of worksheet.rows) {
    if (row.index <= 1) continue;
    for (const cell of row.cells) {
      if (cell.column < JIAOWUBAO_STATIC_SCHEDULE_GRID_ORIGIN_COLUMN || !nonEmptyCell(cell)) continue;
      const rawText = scheduleCellText(cell);
      const rawLines = Object.freeze(rawText.split(/\r\n|\n|\r/u));
      const lines = rawLines.map((line) => line.trim());
      const parseStatus = parseTimeInterval(lines[0] ?? "");
      const className = lines[1] || undefined;
      const course = lines[2] || undefined;
      const teacherRaw = lines[4] || undefined;
      const assistantOne = optionalStaff(lines[5] || undefined);
      const assistantTwo = optionalStaff(lines[6] || undefined);
      const assistants = Object.freeze([assistantOne, assistantTwo].filter((value): value is string => Boolean(value)));
      const declaredCountRaw = lines[7] || undefined;
      const parsedDeclaredCount = declaredCount(declaredCountRaw);
      const studentDisplayNames = studentNames(lines[8] || undefined);
      const unmappedPositionalLines = Object.freeze([
        ...(lines[3] ? [{ index: 3, value: lines[3] }] : []),
        ...lines.slice(9).map((value, offset) => ({ index: offset + 9, value })).filter((line) => Boolean(line.value)),
      ].map((line) => Object.freeze(line)));
      const dateHeaderCell = rowCell(headerRow, cell.column);
      const payload: JiaowubaoStaticSchedulePayload = Object.freeze({
        raw: Object.freeze({
          cell: asRawCell(cell),
          cellRef: cell.reference,
          ...(dateHeaderCell ? { dateHeader: asRawCell(dateHeaderCell) } : {}),
          rawText,
          rawLines,
        }),
        sourceDate: dateAtScheduleColumn(cell.column),
        sourceTimezone: JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE,
        sourceTimezoneBasis: JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE_BASIS,
        parseStatus,
        ...(parseStatus.kind === "parsed" ? { start: parseStatus.start, end: parseStatus.end } : {}),
        ...(className ? { className } : {}),
        ...(course ? { course } : {}),
        ...(optionalStaff(teacherRaw) ? { teacher: optionalStaff(teacherRaw) } : {}),
        assistants,
        ...(parsedDeclaredCount !== undefined ? { declaredCount: parsedDeclaredCount } : {}),
        ...(declaredCountRaw ? { declaredCountRaw } : {}),
        studentDisplayNames,
        identities: Object.freeze(studentDisplayNames.map((name) => Object.freeze({ name }))),
        unmappedPositionalLines,
      });
      if (parseStatus.kind === "parsed") parsed += 1;
      else invalidTime += 1;
      records.push(Object.freeze({
        sourceKey: sourceKey("schedule", cell.reference),
        sourceRefs: sourceRef("schedule", row.index, cell.reference),
        payload,
      }));
    }
  }

  return Object.freeze({
    source,
    gridOriginDate: JIAOWUBAO_STATIC_SCHEDULE_GRID_ORIGIN_DATE,
    gridOriginColumn: JIAOWUBAO_STATIC_SCHEDULE_GRID_ORIGIN_COLUMN,
    sourceTimezone: JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE,
    sourceTimezoneBasis: JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE_BASIS,
    records: Object.freeze(records),
    summary: Object.freeze({ cells: records.length, parsed, invalidTime }),
  });
}

function descriptorFromInput(input: JiaowubaoStaticSourceInput): JiaowubaoStaticSourceDescriptor {
  return Object.freeze({ workbookName: input.workbookName, sha256: input.sha256 });
}

/**
 * Read and parse all seven supplied workbooks.  The only spreadsheet decoder
 * is the local, bounded XLSX reader; this function performs no network or
 * database work.
 */
export function parseJiaowubaoStaticXlsxExports(input: JiaowubaoStaticXlsxExportInput): JiaowubaoStaticParsedXlsxExports {
  return Object.freeze({
    format: JIAOWUBAO_STATIC_XLSX_FORMAT,
    quickList: parseJiaowubaoStaticHeaderWorkbook("quick_list", descriptorFromInput(input.quickList), readXlsx(input.quickList.bytes)),
    students: parseJiaowubaoStaticHeaderWorkbook("students", descriptorFromInput(input.students), readXlsx(input.students.bytes)),
    contracts: parseJiaowubaoStaticHeaderWorkbook("contracts", descriptorFromInput(input.contracts), readXlsx(input.contracts.bytes)),
    hours: parseJiaowubaoStaticHeaderWorkbook("hours", descriptorFromInput(input.hours), readXlsx(input.hours.bytes)),
    classMemberships: parseJiaowubaoStaticClassMembershipWorkbook(descriptorFromInput(input.classMemberships), readXlsx(input.classMemberships.bytes)),
    schedule: parseJiaowubaoStaticScheduleWorkbook(descriptorFromInput(input.schedule), readXlsx(input.schedule.bytes)),
    leaveMakeups: parseJiaowubaoStaticLeaveMakeupWorkbook(descriptorFromInput(input.leaveMakeups), readXlsx(input.leaveMakeups.bytes)),
  });
}
