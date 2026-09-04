import assert from "node:assert/strict";
import test from "node:test";

import { createStoredOpenXmlZip } from "../lib/openxml-xlsx";
import {
  buildPayrollXlsx,
  PAYROLL_XLSX_MIME,
  payrollXlsxFilename,
  type PayrollWorkbookExport,
} from "../lib/payroll-export";
import { readXlsx, type XlsxWorksheet } from "../lib/xlsx-reader";

const primary = {
  role: "primary" as const,
  sourceTeacherId: "jwb-teacher-1",
  sourceTeacherName: "Kelly & Chen <Tutor>",
  teacherId: "teacher-1",
  teacherName: "Kelly & Chen <Tutor>",
  teacherMatch: "unique_name",
};

function sampleWorkbook(): PayrollWorkbookExport {
  return {
    month: "2026-08",
    generatedAt: "2026-09-04T00:00:00.000Z",
    rows: [{
      teacherKey: "internal:teacher-1",
      teacherId: "teacher-1",
      sourceTeacherId: "jwb-teacher-1",
      teacherName: "Kelly & Chen <Tutor>",
      month: "2026-08",
      section: "澳洲教师",
      currency: "AUD",
      status: "可审核",
      payrollHours: 3,
      sourceHours: 3,
      sourceLessonCount: 2,
      amount: 157.5,
      bankName: "Example Bank",
      bankAccount: "1234",
      paymentNote: "Year 11 & 12",
      lockedBy: "Admin",
      lockedAt: "2026-09-04T01:00:00.000Z",
      paymentMode: "payable",
      lines: [{
        studentName: "Olivia & Co",
        studentKey: "internal:student-1",
        studentId: "student-1",
        sourceMemberId: "member-1",
        sourceKey: "jwb-open-api:lesson:branch-1:cal-1:member-1",
        studentMatch: "unique_name",
        hours: 1,
        rate: 0,
        subtotal: 0,
        note: "Regular <lesson>",
        evidenceOnly: true,
      }, {
        studentName: "Olivia & Co",
        studentKey: "internal:student-1",
        studentId: "student-1",
        sourceMemberId: "member-1",
        sourceKey: "jwb-open-api:lesson:branch-1:cal-2:member-1",
        studentMatch: "unique_name",
        hours: 2,
        rate: 0,
        subtotal: 0,
        note: "Second lesson",
        evidenceOnly: true,
      }, {
        studentName: "=HYPERLINK(\"https://example.invalid\")",
        studentKey: "display:trial one",
        sourceMemberId: "trial-b",
        sourceKey: "jwb-open-api:lesson:branch-1:cal-3:trial-b",
        studentMatch: "trial_course_title",
        hours: 1,
        rate: 0,
        subtotal: 0,
        note: "Trial lesson",
        isTrial: true,
        evidenceOnly: true,
      }, {
        studentName: "Trial Two",
        studentKey: "display:trial two",
        sourceMemberId: "trial-b",
        sourceKey: "jwb-open-api:lesson:branch-1:cal-4:trial-b",
        studentMatch: "trial_course_title",
        hours: 0.5,
        rate: 0,
        subtotal: 0,
        note: "Second learner on shared B account",
        isTrial: true,
        evidenceOnly: true,
      }],
    }, {
      teacherKey: "source:unmatched-teacher",
      sourceTeacherId: "unmatched-teacher",
      teacherName: "待匹配老师",
      month: "2026-08",
      section: "教务宝来源 · 待匹配老师",
      currency: "CNY",
      status: "已锁定",
      payrollHours: 99,
      sourceHours: null,
      sourceLessonCount: 1,
      amount: 99999,
      bankName: "MUST NOT EXPORT BANK",
      bankAccount: "MUST NOT EXPORT ACCOUNT",
      paymentNote: "MUST NOT EXPORT PAYMENT NOTE",
      lockedBy: "MUST NOT EXPORT LOCK OWNER",
      lockedAt: "MUST NOT EXPORT LOCK TIME",
      paymentMode: "review_only",
      lines: [],
    }],
    evidence: {
      revision: `sha256:${"a".repeat(64)}`,
      projectionRevision: `sha256:${"b".repeat(64)}`,
      publishedAt: "2026-09-03T23:00:00.000Z",
      lessonRowCount: 2,
      scheduleRowCount: 1,
      matchCounts: {
        matchedStudents: 1,
        unmatchedStudents: 0,
        ambiguousStudents: 0,
        matchedTeachers: 1,
        unmatchedTeachers: 1,
        ambiguousTeachers: 0,
      },
      lessons: [{
        sourceKey: "jwb-open-api:lesson:branch-1:cal-1:trial-b",
        branchId: "branch-1",
        calendarId: "cal-1",
        memberId: "trial-b",
        memberName: "试听学员B",
        displayStudentName: "Zachary 张泽睿",
        studentId: "student-1",
        studentName: "Zachary 张泽睿",
        studentMatch: "trial_course_title",
        lessonDate: "2026-08-05",
        timeTitle: "19:00-20:00",
        hours: 1,
        isTrial: true,
        attendanceCode: 1,
        attendanceTitle: "已到达",
        courseTitle: "Zachary 张泽睿 - AES 试听",
        teamTitle: "试听",
        teachers: [primary],
      }, {
        sourceKey: "jwb-open-api:lesson:branch-1:cal-1:member-2",
        branchId: "branch-1",
        calendarId: "cal-1",
        memberId: "member-2",
        memberName: "Rita Wu",
        displayStudentName: "Rita Wu",
        studentId: "student-2",
        studentName: "Rita Wu",
        studentMatch: "unique_name",
        lessonDate: "2026-08-05",
        timeTitle: "19:00-20:00",
        hours: 1,
        isTrial: false,
        attendanceCode: 1,
        attendanceTitle: "已到达",
        courseTitle: "Y9 ICAS English",
        teamTitle: "一对一",
        teachers: [primary],
      }],
      schedules: [{
        sourceKey: "jwb-open-api:schedule:cal-1",
        calendarId: "cal-1",
        lessonDate: "2026-08-05",
        timeTitle: "19:00-20:00",
        courseTitle: "Y9 ICAS English",
        teamTitle: "一对一",
        teachers: [{ ...primary, sourceTeacherHours: 1 }, {
          role: "assistant",
          sourceTeacherId: "assistant-1",
          sourceTeacherName: "Assistant",
          teacherId: "teacher-2",
          teacherName: "Assistant",
          teacherMatch: "source_id",
          sourceTeacherHours: 0.5,
        }, {
          role: "third",
          sourceTeacherId: "third-1",
          sourceTeacherName: "Third teacher",
          teacherId: null,
          teacherName: null,
          teacherMatch: "unmatched",
          sourceTeacherHours: 0.25,
        }],
      }],
    },
  };
}

function cell(sheet: XlsxWorksheet, reference: string) {
  return sheet.rows.flatMap((row) => row.cells).find((entry) => entry.reference === reference)?.value ?? null;
}

function storedParts(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const parts = new Map<string, string>();
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    parts.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return parts;
}

test("builds a deterministic real XLSX with approved A:H layout and six evidence sheets", () => {
  const input = sampleWorkbook();
  const bytes = buildPayrollXlsx(input);
  assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual(bytes, buildPayrollXlsx(input));
  assert.equal(PAYROLL_XLSX_MIME, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(payrollXlsxFilename("2026-08"), "吟领教育-2026-08-教务宝课时表.xlsx");

  const workbook = readXlsx(bytes);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    "Sheet1", "学生明细", "薪资审核", "消课证据", "排课课时", "数据来源",
  ]);
  const [main, students, review, lessons, schedules, source] = workbook.worksheets;
  assert.equal(cell(main!, "A1"), "2026年8月 教务宝课时表");
  assert.equal(cell(main!, "A2"), "教务宝教师课时（已消课 over=1）");
  assert.equal(cell(main!, "A3"), "序号");
  assert.equal(cell(main!, "H3"), "老师总薪资");
  assert.equal(cell(main!, "B4"), "Kelly & Chen <Tutor>");
  assert.equal(cell(main!, "C4"), "Olivia & Co");
  assert.equal(cell(main!, "D4"), 3);
  assert.equal(cell(main!, "G4"), 3);
  assert.equal(cell(main!, "H4"), 157.5);
  assert.equal(cell(main!, "C5"), "=HYPERLINK(\"https://example.invalid\")");
  assert.equal(cell(main!, "C6"), "Trial Two", "two learners on shared B account stay separate");
  assert.equal(cell(main!, "B7"), "待匹配老师");
  assert.equal(cell(main!, "C7"), "（无学生明细）");
  assert.equal(cell(main!, "G7"), null, "unknown review-only teacher hours remain blank");
  assert.equal(cell(main!, "H7"), "待核对");

  assert.equal(cell(students!, "C2"), "Olivia & Co");
  assert.equal(cell(students!, "F2"), 3);
  assert.equal(cell(students!, "G2"), 2);
  for (const reference of ["I3", "J3", "K3", "L3", "M3", "N3"]) assert.equal(cell(review!, reference), null);
  assert.equal(cell(lessons!, "G2"), "试听学员B");
  assert.equal(cell(lessons!, "H2"), "Zachary 张泽睿");
  assert.equal(schedules!.rows.length, 4, "one schedule event expands to all three teacher roles");
  assert.equal(cell(schedules!, "G4"), "third");
  assert.equal(
    cell(source!, "B16"),
    "query_lesson_list；over=1；按完整自然月、逐个教务宝学员 ID 分页读取；ID 清单合并当前名册、已确认/历史身份与当月已结课排课参与者",
  );

  const parts = storedParts(bytes);
  assert.equal(parts.size, 13);
  assert.match(parts.get("[Content_Types].xml")!, /\/xl\/worksheets\/sheet6\.xml/);
  assert.match(parts.get("_rels/.rels")!, /officeDocument/);
  assert.match(parts.get("xl/_rels/workbook.xml.rels")!, /worksheets\/sheet6\.xml/);
  const mainXml = parts.get("xl/worksheets/sheet1.xml")!;
  for (const merge of ["A1:H1", "A2:H2", "A4:A6", "B4:B6", "G4:G6", "H4:H6"]) {
    assert.match(mainXml, new RegExp(`<mergeCell ref="${merge}"/>`));
  }
  assert.ok(mainXml.indexOf("<sheetData>") < mainXml.indexOf("<mergeCells"));
  const allXml = [...parts.values()].join("");
  assert.doesNotMatch(allXml, /<f(?:\s|>)/u);
  assert.doesNotMatch(allXml, /MUST NOT EXPORT/u);
});

test("fails closed for malformed workbook text, numbers, months and evidence counts", () => {
  const sample = sampleWorkbook();
  assert.throws(() => buildPayrollXlsx({ ...sample, month: "2026-13" }), /月份/);
  assert.throws(() => buildPayrollXlsx({ ...sample, rows: [{ ...sample.rows[0]!, amount: Number.NaN }] }), /金额/);
  assert.throws(() => buildPayrollXlsx({ ...sample, rows: [{ ...sample.rows[0]!, teacherName: "\ud800" }] }), /无效字符/);
  assert.throws(() => buildPayrollXlsx({ ...sample, rows: [{ ...sample.rows[0]!, teacherName: "x".repeat(32_768) }] }), /过长/);
  assert.throws(() => buildPayrollXlsx({ ...sample, evidence: { ...sample.evidence!, lessonRowCount: 1 } }), /行数/);
});

test("stored OOXML ZIP writer rejects unsafe, duplicate and aggregate-oversized parts", () => {
  assert.throws(() => createStoredOpenXmlZip([{ name: "../evil.xml", xml: "x" }]), /不安全/);
  assert.throws(() => createStoredOpenXmlZip([{ name: "a.xml", xml: "x" }, { name: "a.xml", xml: "y" }]), /重复/);
  const half = "x".repeat(16 * 1024 * 1024);
  assert.throws(() => createStoredOpenXmlZip([{ name: "a.xml", xml: half }, { name: "b.xml", xml: half }]), /大小上限/);
});
