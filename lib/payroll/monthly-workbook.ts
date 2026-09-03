import type { MonthlyPayrollReport } from "../jiaowubao/monthly-payroll";

/**
 * A deliberately small Open XML writer for the monthly export.
 *
 * It writes only the spreadsheet features this report needs (styled cells,
 * merged headings, frozen panes, filters and sheets). Keeping this here avoids
 * introducing a server-only XLSX package and keeps the export portable.
 */

type CellValue = string | number | null | undefined;

type SheetRow = {
  cells: Array<{ value: CellValue; style: number }>;
  height?: number;
};

type WorkbookSheet = {
  name: string;
  columns: number[];
  rows: SheetRow[];
  frozenRows: number;
  merges?: string[];
  filter?: string;
};

const encoder = new TextEncoder();
const normalStyle = 0;
const titleStyle = 1;
const subtitleStyle = 2;
const headerStyle = 3;
const groupStyles = [4, 5, 6, 7, 8, 9];
const warningStyle = 10;
const boldWarningStyle = 11;
const noteLabelStyle = 12;
const noteStyle = 13;

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function cellReference(columnIndex: number, rowIndex: number): string {
  return `${columnName(columnIndex)}${rowIndex}`;
}

function row(values: CellValue[], style = normalStyle, height?: number): SheetRow {
  return { cells: values.map((value) => ({ value, style })), height };
}

function setCell(target: SheetRow, index: number, value: CellValue, style = target.cells[index]?.style ?? normalStyle) {
  target.cells[index] = { value, style };
}

function periodTitle(period: string): string {
  const [year, month] = period.split("-");
  return `${year}年${Number(month)}月教务宝课时表`;
}

function teacherNames(lesson: MonthlyPayrollReport["lessons"][number]) {
  return lesson.teachers.map((teacher) => `${teacher.name}（${teacher.role}）`).join("；");
}

function studentNameSourceLabel(source: MonthlyPayrollReport["lessons"][number]["studentNameSource"]): string {
  if (source === "trial_team_title_prefix") return "试听班级名称前缀（待核对）";
  if (source === "trial_course_title_prefix") return "试听课程名称前缀（待核对）";
  if (source === "trial_name_conflict") return "试听班级/课程名称冲突，保留 B 账号";
  if (source === "trial_account_unresolved") return "试听 B 账号，未解析真实姓名";
  return "教务宝学员名称";
}

function studentNameNote(detail: MonthlyPayrollReport["teachers"][number]["studentDetails"][number]): string {
  if (detail.nameSource === "trial_team_title_prefix") return `真实姓名取自班级名称前缀（待核对；原账号：${detail.sourceStudentName}）`;
  if (detail.nameSource === "trial_course_title_prefix") return `真实姓名取自课程名称前缀（待核对；原账号：${detail.sourceStudentName}）`;
  if (detail.nameSource === "trial_name_conflict") return `试听班级名称和课程名称疑似不同学生，保留 B 账号（账号：${detail.sourceStudentName}）`;
  if (detail.nameSource === "trial_account_unresolved") return `试听 B 账号未解析真实姓名（账号：${detail.sourceStudentName}）`;
  return "";
}

function createSummarySheet(report: MonthlyPayrollReport): WorkbookSheet {
  // Keep the approved payroll worksheet layout. Values that cannot be proven
  // from query_lesson_list stay visibly pending instead of being inferred from
  // course price or a deduplicated lesson calculation.
  const columns = [8, 25, 25, 14, 19, 20, 21, 20, 34, 22, 20, 22];
  const rows: SheetRow[] = [];
  rows.push(row([periodTitle(report.period.value), "", "", "", "", "", "", "", "", "", "", ""], titleStyle, 52));
  rows.push(row(["教务宝教师课时（试听学员 B 账号） · 已结课 over=1 · 薪资待权威月度总课时", "", "", "", "", "", "", "", "", "", "", ""], subtitleStyle, 34));
  rows.push(row([
    "序号", "教师姓名", "学生姓名", "课时（小时）", "课时费单价（小时）", "合计（待补费率）",
    "老师总课时（小时）", "老师总薪资（待补）", "老师薪资备注", "其他", "银行卡号", "开户行",
  ], headerStyle, 33));

  const merges = ["A1:L1", "A2:L2"];
  let teacherIndex = 1;
  for (const teacher of report.teachers) {
    const start = rows.length + 1;
    const fill = groupStyles[(teacherIndex - 1) % groupStyles.length] ?? normalStyle;
    const details = teacher.studentDetails.length ? teacher.studentDetails : [null];

    for (const detail of details) {
      rows.push(row([
        "", "", detail ? detail.name : "未读取到学生明细", detail ? detail.lessons : "", "", "待补费率", "", "", "",
        detail ? `${detail.kind} · ${detail.attendance} · ${detail.course} · ${detail.className}${studentNameNote(detail) ? ` · ${studentNameNote(detail)}` : ""}` : "待补齐", "", "",
      ], fill, 26));
    }

    const end = rows.length;
    const head = rows[start - 1];
    setCell(head, 0, teacherIndex, fill);
    setCell(head, 1, `${teacher.teacherName}（${teacher.role}）`, fill);
    setCell(head, 6, "待老师月度汇总", fill);
    setCell(head, 7, "待补", fill);
    setCell(head, 8, teacher.notes.join(" "), fill);
    if (end > start) {
      for (const column of ["A", "B", "G", "H", "I"]) merges.push(`${column}${start}:${column}${end}`);
    }
    teacherIndex += 1;
  }

  if (report.unassignedStudentDetails.length) {
    const start = rows.length + 1;
    for (const detail of report.unassignedStudentDetails) {
      rows.push(row([
        "", "", detail.name, detail.lessons, "", "待补费率", "", "", "",
        `${detail.kind} · ${detail.attendance} · ${detail.course} · ${detail.className}${studentNameNote(detail) ? ` · ${studentNameNote(detail)}` : ""}`, "", "",
      ], warningStyle, 26));
    }
    const end = rows.length;
    const head = rows[start - 1];
    setCell(head, 0, teacherIndex, warningStyle);
    setCell(head, 1, "未分配教师（教务宝未返回教师 ID）", warningStyle);
    setCell(head, 6, "不计薪", warningStyle);
    setCell(head, 7, "不计算", warningStyle);
    setCell(head, 8, "这些已结课学生已完整保留，但接口没有教师 ID，不能关联薪资。", warningStyle);
    if (end > start) {
      for (const column of ["A", "B", "G", "H", "I"]) merges.push(`${column}${start}:${column}${end}`);
    }
  }

  const total = row([
    "", "合计（只作来源课时核对，不作薪资）", "", report.summary.sourceStudentHours, "", "待补费率",
    "待老师月度汇总", "待补", "当前接口没有老师月度总课时和薪资费率。", `已结课 ${report.summary.sourceRows} 条来源行`, "", "",
  ], boldWarningStyle, 28);
  rows.push(total);
  const totalRow = rows.length;
  merges.push(`B${totalRow}:C${totalRow}`);

  return {
    name: "Sheet1",
    columns,
    rows,
    frozenRows: 3,
    merges,
    filter: `A3:L${Math.max(3, totalRow - 1)}`,
  };
}

function createStudentDetailSheet(report: MonthlyPayrollReport): WorkbookSheet {
  const columns = [8, 28, 26, 14, 19, 20, 16, 28, 46];
  const [year, month] = report.period.value.split("-");
  const rows = [
    row([`${year}年${Number(month)}月学生课时明细`, "", "", "", "", "", "", "", ""], titleStyle, 52),
    row(["教务宝已结课学生明细（试听学员 B 账号） · 课时费率和薪资不自动计算", "", "", "", "", "", "", "", ""], subtitleStyle, 34),
    row(["序号", "教师姓名（教务宝原始）", "学生姓名", "课时（小时）", "课时费单价（小时）", "合计", "课程类型", "课程名称", "备注"], headerStyle, 33),
  ];
  let index = 1;

  for (const teacher of report.teachers) {
    for (const detail of teacher.studentDetails) {
      rows.push(row([
        index,
        `${teacher.teacherName}（${teacher.role}，ID ${teacher.sourceTeacherId}）`,
        detail.name,
        detail.lessons,
        "",
        "不自动计算",
        detail.kind,
        detail.course,
        `${detail.className} · ${detail.dated} ${detail.time} · ${detail.attendance}${detail.matched ? "" : " · 待核对角色/多人分配"}${studentNameNote(detail) ? ` · ${studentNameNote(detail)}` : ""}`,
      ], detail.matched ? normalStyle : warningStyle, 26));
      index += 1;
    }
  }

  for (const detail of report.unassignedStudentDetails) {
    rows.push(row([
      index,
      "未分配教师（教务宝未返回教师 ID）",
      detail.name,
      detail.lessons,
      "",
      "不自动计算",
      detail.kind,
      detail.course,
      `${detail.className} · ${detail.dated} ${detail.time} · ${detail.attendance} · 不能关联薪资${studentNameNote(detail) ? ` · ${studentNameNote(detail)}` : ""}`,
    ], warningStyle, 26));
    index += 1;
  }

  return {
    name: "学生明细",
    columns,
    rows,
    frozenRows: 3,
    merges: ["A1:I1", "A2:I2"],
    filter: `A3:I${Math.max(3, rows.length)}`,
  };
}

function createRawLessonSheet(report: MonthlyPayrollReport): WorkbookSheet {
  const columns = [14, 14, 17, 15, 14, 16, 22, 22, 12, 12, 15, 15, 14, 16, 36, 28, 18, 24];
  const rows = [row(["机构 ID", "课节 ID", "学生 ID", "学生姓名（原始账号）", "上课日期", "上课时段", "课程", "班级", "课时", "课时类型", "出勤状态", "结课状态", "结课时间", "请假原因", "教师", "来源筛选", "显示学生姓名", "姓名来源"], headerStyle, 33)];

  for (const lesson of report.lessons) {
    rows.push(row([
      lesson.branchId,
      lesson.calId,
      lesson.memberId,
      lesson.memberName,
      lesson.dated,
      lesson.timeTitle,
      lesson.courseTitle,
      lesson.teamTitle,
      lesson.hours,
      lesson.typeTitle || (lesson.typeId === null ? "" : String(lesson.typeId)),
      lesson.signTitle,
      "已结课",
      lesson.overTime,
      lesson.leaveReason,
      teacherNames(lesson),
      "query_lesson_list · over=1",
      lesson.displayStudentName,
      studentNameSourceLabel(lesson.studentNameSource),
    ], lesson.kind === "待分类" ? warningStyle : normalStyle, 26));
  }

  return { name: "课节原始明细", columns, rows, frozenRows: 1, filter: `A1:R${Math.max(1, rows.length)}` };
}

function createNotesSheet(report: MonthlyPayrollReport): WorkbookSheet {
  const columns = [26, 98];
  const rows = [row(["项目", "说明"], headerStyle, 33)];
  const entries: Array<[string, string, boolean]> = [
    ["报表月份", report.period.value, false],
    ["数据来源", "教务宝 query_lesson_list；查询时强制使用 over=1，仅保留已结课记录。", false],
    ["原始记录", `${report.summary.sourceRows} 条来源行；${report.summary.uniqueLessons} 个唯一课节。`, false],
    ["老师月度总课时", "当前工具文档未提供老师月度汇总或角色分配课时。工作簿保留全部学生/课节明细，但不以推导课时自动计算薪资或锁定。", true],
    ["试听分类", report.source.trialMemberIds.length ? `仅以下教务宝试听账号 ID 被明确配置为试听：${report.source.trialMemberIds.join(", ")}。` : "未配置试听账号 ID 映射；课节保留为“待分类”，不会按名称或课型猜测。", report.source.trialMemberIds.length === 0],
    ["试听真实姓名", "对已确认的试听 B 账号，班级/课程名称开头精确匹配“英文名+中文名”时才作为显示学生姓名；班级名称另支持“Rita Wu (NZL)”这类英文名加地区后缀。原始账号始终保留在原始明细。两者冲突或未匹配时保持 B 账号并标记待核对。", true],
    ["多人课程", "同一课节出现多个学生或多个老师时，系统不会把同一小时数重复算进每位老师或学生。需教务宝提供角色课时分配后才可完成薪资核对。", true],
    ["薪资费率", "接口中的 price 是课程价格，不作为老师课时费率；本工作簿不自动填写薪资。", true],
    ["生成时间", report.generatedAt, false],
    ...report.warnings.map((warning, index): [string, string, boolean] => [`核对提示 ${index + 1}`, warning, true]),
  ];

  for (const [label, note, warning] of entries) {
    const entry = row([label, note], warning ? warningStyle : noteStyle, 38);
    setCell(entry, 0, label, warning ? boldWarningStyle : noteLabelStyle);
    rows.push(entry);
  }

  return { name: "数据说明", columns, rows, frozenRows: 1 };
}

function cellXml(columnIndex: number, rowIndex: number, cell: SheetRow["cells"][number]): string {
  const reference = cellReference(columnIndex, rowIndex);
  const style = ` s="${cell.style}"`;
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) {
    return `<c r="${reference}"${style}><v>${cell.value}</v></c>`;
  }
  const text = cell.value === null || cell.value === undefined ? "" : String(cell.value);
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function worksheetXml(sheet: WorkbookSheet): string {
  const cols = sheet.columns.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const rows = sheet.rows.map((sheetRow, rowIndex) => {
    const height = sheetRow.height ? ` ht="${sheetRow.height}" customHeight="1"` : "";
    const cells = sheetRow.cells.map((cell, columnIndex) => cellXml(columnIndex, rowIndex + 1, cell)).join("");
    return `<row r="${rowIndex + 1}"${height}>${cells}</row>`;
  }).join("");
  const pane = sheet.frozenRows > 0
    ? `<pane ySplit="${sheet.frozenRows}" topLeftCell="A${sheet.frozenRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sheet.frozenRows + 1}" sqref="A${sheet.frozenRows + 1}"/>`
    : "";
  const filter = sheet.filter ? `<autoFilter ref="${sheet.filter}"/>` : "";
  const merges = sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((merge) => `<mergeCell ref="${merge}"/>`).join("")}</mergeCells>` : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="22"/>
  <cols>${cols}</cols>
  <sheetData>${rows}</sheetData>
  ${filter}
  ${merges}
  <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>`;
}

function stylesXml(): string {
  const fill = (rgb: string) => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const xf = (fontId: number, fillId: number, borderId: number, alignment: string) => `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment ${alignment}/></xf>`;
  const centered = 'horizontal="center" vertical="center" wrapText="1"';
  const leftTop = 'horizontal="left" vertical="top" wrapText="1"';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="10"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="24"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="14"/><name val="Microsoft YaHei"/></font>
    <font><b/><sz val="11"/><name val="Microsoft YaHei"/></font>
  </fonts>
  <fills count="11">
    <fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
    ${fill("FFFFD966")}${fill("FFD9EAD3")}${fill("FFF4CCCC")}${fill("FFD9EAF7")}${fill("FFD9EAD3")}${fill("FFEADCF8")}${fill("FFFCE5CD")}${fill("FFD0E0E3")}${fill("FFFFF2CC")}
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FF8C8C8C"/></left><right style="thin"><color rgb="FF8C8C8C"/></right><top style="thin"><color rgb="FF8C8C8C"/></top><bottom style="thin"><color rgb="FF8C8C8C"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="14">
    ${xf(0, 0, 1, centered)}
    ${xf(1, 2, 1, centered)}
    ${xf(2, 3, 1, centered)}
    ${xf(3, 3, 1, centered)}
    ${xf(0, 4, 1, centered)}${xf(0, 5, 1, centered)}${xf(0, 6, 1, centered)}${xf(0, 7, 1, centered)}${xf(0, 8, 1, centered)}${xf(0, 9, 1, centered)}
    ${xf(0, 10, 1, centered)}
    ${xf(3, 10, 1, centered)}
    ${xf(3, 0, 1, leftTop)}
    ${xf(0, 0, 1, leftTop)}
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function contentTypesXml(sheetCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets}
</Types>`;
}

function workbookXml(sheets: WorkbookSheet[]): string {
  const entries = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><bookViews><workbookView/></bookViews><sheets>${entries}</sheets></workbook>`;
}

function workbookRelationshipsXml(sheets: WorkbookSheet[]): string {
  const entries = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

const rootRelationshipsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

function corePropertiesXml(createdAt: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Insider Leads 教务运营平台</dc:creator><cp:lastModifiedBy>Insider Leads 教务运营平台</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(createdAt)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(createdAt)}</dcterms:modified></cp:coreProperties>`;
}

const appPropertiesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Insider Leads 教务运营平台</Application></Properties>`;

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: Array<{ name: string; content: string }>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const content = encoder.encode(file.content);
    const checksum = crc32(content);
    const local = joinBytes([
      uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(content.length), uint32(content.length), uint16(name.length), uint16(0), name, content,
    ]);
    const central = joinBytes([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(0),
      uint32(checksum), uint32(content.length), uint32(content.length), uint16(name.length), uint16(0), uint16(0), uint16(0), uint16(0), uint32(0), uint32(offset), name,
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }

  const central = joinBytes(centralParts);
  const end = joinBytes([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length), uint32(central.length), uint32(offset), uint16(0),
  ]);
  return joinBytes([...localParts, central, end]);
}

export async function createMonthlyPayrollWorkbook(report: MonthlyPayrollReport): Promise<Uint8Array> {
  const sheets = [
    createSummarySheet(report),
    createStudentDetailSheet(report),
    createRawLessonSheet(report),
    createNotesSheet(report),
  ];
  const generatedAt = report.generatedAt || new Date().toISOString();
  const files = [
    { name: "[Content_Types].xml", content: contentTypesXml(sheets.length) },
    { name: "_rels/.rels", content: rootRelationshipsXml },
    { name: "docProps/core.xml", content: corePropertiesXml(generatedAt) },
    { name: "docProps/app.xml", content: appPropertiesXml },
    { name: "xl/workbook.xml", content: workbookXml(sheets) },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRelationshipsXml(sheets) },
    { name: "xl/styles.xml", content: stylesXml() },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, content: worksheetXml(sheet) })),
  ];
  return zip(files);
}

export function monthlyPayrollFilename(period: string) {
  const [year, month] = period.split("-");
  return `${year}年${month}月教务宝课时表_完整版.xlsx`;
}
