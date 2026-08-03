import assert from "node:assert/strict";
import test from "node:test";

import { buildPayrollExcelXml } from "../lib/payroll-export";

test("builds an Excel workbook with teacher summaries and student details", () => {
  const xml = buildPayrollExcelXml("2026-07", [{
    teacherName: "Kelly & Chen <Tutor>",
    month: "2026-07",
    section: "澳洲教师",
    currency: "AUD",
    status: "需核对",
    payrollHours: 3.5,
    sourceHours: 3,
    amount: 157.5,
    bankName: "Example Bank",
    bankAccount: "1234",
    paymentNote: "Year 11 & 12",
    lines: [{
      studentName: "Olivia & Co",
      hours: 3.5,
      rate: 45,
      subtotal: 157.5,
      note: "Regular <lesson>",
    }, {
      studentName: "Trial Student",
      hours: 1,
      rate: 50,
      subtotal: 50,
      note: "Trial lesson",
      isTrial: true,
    }],
  }]);

  assert.match(xml, /<Worksheet ss:Name="老师汇总">/);
  assert.match(xml, /<Worksheet ss:Name="学生明细">/);
  assert.match(xml, /Kelly &amp; Chen &lt;Tutor&gt;/);
  assert.match(xml, /↳ Olivia &amp; Co/);
  assert.match(xml, /↳ Trial Student/);
  assert.match(xml, /学生明细/);
  assert.match(xml, /试听/);
  assert.match(xml, /常规课/);
  assert.match(xml, /ss:StyleID="StudentName"/);
  assert.match(xml, /ss:StyleID="AudStudentMoney"/);
  assert.match(xml, /Olivia &amp; Co/);
  assert.match(xml, /ss:Type="Number">157\.5/);
  assert.match(xml, /A\$#,##0\.00/);
  assert.doesNotMatch(xml, /Kelly & Chen <Tutor>/);
});
