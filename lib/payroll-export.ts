export type PayrollExportLine = {
  studentName: string;
  hours: number;
  rate: number;
  subtotal: number;
  note?: string;
  isTrial?: boolean;
};

export type PayrollExportRow = {
  teacherName: string;
  month: string;
  section: string;
  currency: "CNY" | "AUD";
  status: string;
  payrollHours: number;
  sourceHours?: number | null;
  amount: number;
  bankName?: string;
  bankAccount?: string;
  paymentNote?: string;
  lockedBy?: string;
  lockedAt?: string;
  lines: PayrollExportLine[];
};

type CellValue = string | number | null | undefined;

function escapeXml(value: CellValue) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cell(value: CellValue, type: "String" | "Number" = "String", style?: string) {
  const styleAttribute = style ? ` ss:StyleID="${style}"` : "";
  return `<Cell${styleAttribute}><Data ss:Type="${type}">${escapeXml(value)}</Data></Cell>`;
}

function row(values: Array<{ value: CellValue; type?: "String" | "Number"; style?: string }>) {
  return `<Row>${values.map((entry) => cell(entry.value, entry.type, entry.style)).join("")}</Row>`;
}

function worksheet(name: string, rows: string[]) {
  return `<Worksheet ss:Name="${escapeXml(name)}"><Table>${rows.join("")}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions></Worksheet>`;
}

export function buildPayrollExcelXml(month: string, payroll: PayrollExportRow[]) {
  const header = (labels: string[]) => row(labels.map((value) => ({ value, style: "Header" })));
  const summaryRows = [
    header(["月份", "老师", "教师类别", "币种", "状态", "薪资表课时", "教务宝课时", "课时差异", "建议金额", "银行", "账户", "付款说明", "锁定人", "锁定时间"]),
    ...payroll.flatMap((entry) => {
      const sourceHours = entry.sourceHours ?? null;
      const variance = sourceHours === null ? null : entry.payrollHours - sourceHours;
      const teacherRow = row([
        { value: entry.month, style: "TeacherSummary" },
        { value: entry.teacherName, style: "TeacherSummary" },
        { value: entry.section, style: "TeacherSummary" },
        { value: entry.currency, style: "TeacherSummary" },
        { value: entry.status, style: "TeacherSummary" },
        { value: entry.payrollHours, type: "Number", style: "TeacherSummaryNumber" },
        { value: sourceHours, type: sourceHours === null ? "String" : "Number", style: "TeacherSummaryNumber" },
        { value: variance, type: variance === null ? "String" : "Number", style: "TeacherSummaryNumber" },
        { value: entry.amount, type: "Number", style: entry.currency === "AUD" ? "AudTeacherMoney" : "CnyTeacherMoney" },
        { value: entry.bankName, style: "TeacherSummary" },
        { value: entry.bankAccount, style: "TeacherSummary" },
        { value: entry.paymentNote, style: "TeacherSummary" },
        { value: entry.lockedBy, style: "TeacherSummary" },
        { value: entry.lockedAt, style: "TeacherSummary" },
      ]);
      const studentRows = entry.lines.map((line) => row([
        { value: "", style: "StudentDetail" },
        { value: `↳ ${line.studentName}`, style: "StudentName" },
        { value: line.isTrial ? "试听" : "常规课", style: "StudentDetail" },
        { value: entry.currency, style: "StudentDetail" },
        { value: "学生明细", style: "StudentDetail" },
        { value: line.hours, type: "Number", style: "StudentNumber" },
        { value: line.rate, type: "Number", style: entry.currency === "AUD" ? "AudStudentMoney" : "CnyStudentMoney" },
        { value: "", style: "StudentDetail" },
        { value: line.subtotal, type: "Number", style: entry.currency === "AUD" ? "AudStudentMoney" : "CnyStudentMoney" },
        { value: "", style: "StudentDetail" },
        { value: "", style: "StudentDetail" },
        { value: line.note, style: "StudentDetail" },
        { value: "", style: "StudentDetail" },
        { value: "", style: "StudentDetail" },
      ]));
      return [teacherRow, ...studentRows];
    }),
  ];

  const detailRows = [
    header(["月份", "老师", "学生", "课程类型", "课时", "费率", "小计", "币种", "说明"]),
    ...payroll.flatMap((entry) => entry.lines.map((line) => row([
      { value: entry.month },
      { value: entry.teacherName },
      { value: line.studentName },
      { value: line.isTrial ? "试听" : "常规课" },
      { value: line.hours, type: "Number" },
      { value: line.rate, type: "Number", style: entry.currency === "AUD" ? "AudMoney" : "CnyMoney" },
      { value: line.subtotal, type: "Number", style: entry.currency === "AUD" ? "AudMoney" : "CnyMoney" },
      { value: entry.currency },
      { value: line.note },
    ]))),
  ];

  const cnyTotal = payroll.filter((entry) => entry.currency === "CNY").reduce((total, entry) => total + entry.amount, 0);
  const audTotal = payroll.filter((entry) => entry.currency === "AUD").reduce((total, entry) => total + entry.amount, 0);
  summaryRows.push(
    row([{ value: "人民币合计", style: "Total" }, { value: cnyTotal, type: "Number", style: "CnyMoney" }]),
    row([{ value: "澳币合计", style: "Total" }, { value: audTotal, type: "Number", style: "AudMoney" }]),
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Title>吟领教育 ${escapeXml(month)} 薪资</Title><Author>Yinling Operations</Author></DocumentProperties>
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="10"/></Style>
    <Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#176B63" ss:Pattern="Solid"/></Style>
    <Style ss:ID="Total"><Font ss:Bold="1"/><Interior ss:Color="#DDF4F1" ss:Pattern="Solid"/></Style>
    <Style ss:ID="CnyMoney"><NumberFormat ss:Format="¥#,##0.00"/></Style>
    <Style ss:ID="AudMoney"><NumberFormat ss:Format="A$#,##0.00"/></Style>
    <Style ss:ID="TeacherSummary"><Font ss:Bold="1"/><Interior ss:Color="#DDF4F1" ss:Pattern="Solid"/></Style>
    <Style ss:ID="TeacherSummaryNumber"><Font ss:Bold="1"/><Interior ss:Color="#DDF4F1" ss:Pattern="Solid"/><NumberFormat ss:Format="0.00"/></Style>
    <Style ss:ID="CnyTeacherMoney"><Font ss:Bold="1"/><Interior ss:Color="#DDF4F1" ss:Pattern="Solid"/><NumberFormat ss:Format="¥#,##0.00"/></Style>
    <Style ss:ID="AudTeacherMoney"><Font ss:Bold="1"/><Interior ss:Color="#DDF4F1" ss:Pattern="Solid"/><NumberFormat ss:Format="A$#,##0.00"/></Style>
    <Style ss:ID="StudentDetail"><Font ss:Color="#4F625F"/><Interior ss:Color="#F4FAF9" ss:Pattern="Solid"/></Style>
    <Style ss:ID="StudentName"><Alignment ss:Indent="1"/><Font ss:Color="#2E504B"/><Interior ss:Color="#F4FAF9" ss:Pattern="Solid"/></Style>
    <Style ss:ID="StudentNumber"><Font ss:Color="#4F625F"/><Interior ss:Color="#F4FAF9" ss:Pattern="Solid"/><NumberFormat ss:Format="0.00"/></Style>
    <Style ss:ID="CnyStudentMoney"><Font ss:Color="#4F625F"/><Interior ss:Color="#F4FAF9" ss:Pattern="Solid"/><NumberFormat ss:Format="¥#,##0.00"/></Style>
    <Style ss:ID="AudStudentMoney"><Font ss:Color="#4F625F"/><Interior ss:Color="#F4FAF9" ss:Pattern="Solid"/><NumberFormat ss:Format="A$#,##0.00"/></Style>
  </Styles>
  ${worksheet("老师汇总", summaryRows)}
  ${worksheet("学生明细", detailRows)}
</Workbook>`;
}

export function downloadPayrollExcel(month: string, payroll: PayrollExportRow[]) {
  const xml = buildPayrollExcelXml(month, payroll);
  const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `Yinling-Payroll-${month || "unconfirmed"}.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
