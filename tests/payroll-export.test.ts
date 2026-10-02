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
        isTrial: false,
        evidenceOnly: true,
      }, {
        studentName: "Olivia & Co",
        studentKey: "internal:student-1",
        studentId: "student-1",
        sourceMemberId: "member-1",
        sourceKey: "jwb-open-api:lesson:~:cal-2:member-1",
        studentMatch: "unique_name",
        hours: 2,
        rate: 0,
        subtotal: 0,
        note: "Second lesson",
        isTrial: false,
        evidenceOnly: true,
      }, {
        studentName: "=HYPERLINK(\"https://example.invalid\")",
        studentKey: "display:trial one",
        studentId: "student-3",
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
        studentId: "student-4",
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
      sourceHours: 9,
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
      lessonRowCount: 4,
      scheduleRowCount: 1,
      teacherLessonSourceKeys: [{
        teacherKey: "internal:teacher-1",
        sourceKeys: [
          "jwb-open-api:lesson:branch-1:cal-1:member-1",
          "jwb-open-api:lesson:~:cal-2:member-1",
          "jwb-open-api:lesson:branch-1:cal-3:trial-b",
          "jwb-open-api:lesson:branch-1:cal-4:trial-b",
        ].sort(),
      }, {
        teacherKey: "source:unmatched-teacher",
        sourceKeys: [],
      }],
      matchCounts: {
        matchedStudents: 4,
        unmatchedStudents: 0,
        ambiguousStudents: 0,
        matchedTeachers: 1,
        unmatchedTeachers: 1,
        ambiguousTeachers: 0,
      },
      lessons: [{
        sourceKey: "jwb-open-api:lesson:branch-1:cal-1:member-1",
        branchId: "branch-1",
        calendarId: "cal-1",
        memberId: "member-1",
        memberName: "Olivia & Co",
        displayStudentName: "Olivia & Co",
        studentId: "student-1",
        studentName: "Olivia & Co",
        studentMatch: "unique_name",
        lessonDate: "2026-08-05",
        timeTitle: "19:00-20:00",
        hours: 1,
        isTrial: false,
        attendanceCode: 1,
        attendanceTitle: "已到达",
        courseTitle: "Year 11 English",
        teamTitle: "一对一",
        teachers: [primary],
      }, {
        sourceKey: "jwb-open-api:lesson:~:cal-2:member-1",
        branchId: "~",
        calendarId: "cal-2",
        memberId: "member-1",
        memberName: "Olivia & Co",
        displayStudentName: "Olivia & Co",
        studentId: "student-1",
        studentName: "Olivia & Co",
        studentMatch: "unique_name",
        lessonDate: "2026-08-06",
        timeTitle: "17:00-19:00",
        hours: 2,
        isTrial: false,
        attendanceCode: 1,
        attendanceTitle: "已到达",
        courseTitle: "Year 12 English",
        teamTitle: "一对一",
        teachers: [primary],
      }, {
        sourceKey: "jwb-open-api:lesson:branch-1:cal-3:trial-b",
        branchId: "branch-1",
        calendarId: "cal-3",
        memberId: "trial-b",
        memberName: "试听学员B",
        displayStudentName: "=HYPERLINK(\"https://example.invalid\")",
        studentId: "student-3",
        studentName: "=HYPERLINK(\"https://example.invalid\")",
        studentMatch: "trial_course_title",
        lessonDate: "2026-08-07",
        timeTitle: "19:00-20:00",
        hours: 1,
        isTrial: true,
        attendanceCode: 1,
        attendanceTitle: "已到达",
        courseTitle: "Trial One",
        teamTitle: "试听",
        teachers: [primary],
      }, {
        sourceKey: "jwb-open-api:lesson:branch-1:cal-4:trial-b",
        branchId: "branch-1",
        calendarId: "cal-4",
        memberId: "trial-b",
        memberName: "试听学员B",
        displayStudentName: "Trial Two",
        studentId: "student-4",
        studentName: "Trial Two",
        studentMatch: "trial_course_title",
        lessonDate: "2026-08-08",
        timeTitle: "19:00-19:30",
        hours: 0.5,
        isTrial: true,
        attendanceCode: 1,
        attendanceTitle: "已到达",
        courseTitle: "Trial Two",
        teamTitle: "试听",
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
  assert.equal(cell(main!, "G7"), 9, "review-only keeps the current factual JWB total");
  assert.equal(cell(main!, "H7"), "待核对");

  assert.equal(cell(students!, "C2"), "Olivia & Co");
  assert.equal(cell(students!, "F2"), 3);
  assert.equal(cell(students!, "G2"), 2);
  assert.equal(cell(review!, "E3"), "需核对");
  assert.equal(cell(review!, "F3"), 0);
  assert.equal(cell(review!, "G3"), 9);
  assert.equal(cell(review!, "H3"), null);
  for (const reference of ["I3", "J3", "K3", "L3", "M3", "N3"]) assert.equal(cell(review!, reference), null);
  assert.equal(cell(lessons!, "G4"), "试听学员B");
  assert.equal(cell(lessons!, "H4"), "=HYPERLINK(\"https://example.invalid\")");
  assert.equal(cell(lessons!, "B3"), "未知（历史来源未提供）");
  assert.equal(schedules!.rows.length, 4, "one schedule event expands to all three teacher roles");
  assert.equal(cell(schedules!, "G4"), "third");
  assert.equal(
    cell(source!, "B16"),
    "query_lesson_list；over=1；按完整自然月、逐个教务宝学员 ID 分页读取；ID 清单合并当前名册、已确认/历史身份与当月已结课排课参与者",
  );
  assert.match(String(cell(source!, "B17")), /导出前重新完整读取.*来源修订.*映射修订.*双源行数.*本次不下载/u);
  assert.match(String(cell(source!, "B17")), /每位老师.*双向一致.*姓名.*课时.*试听分类.*身份字段/u);

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

test("hours-only export follows the 13/9-column template and excludes every payment field", () => {
  const input = { ...sampleWorkbook(), exportMode: "hours_only" as const };
  const bytes = buildPayrollXlsx(input);
  const workbook = readXlsx(bytes);
  const [main, students, review, lessons, schedules, source] = workbook.worksheets;
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    "Sheet1", "学生明细", "薪资审核", "消课证据", "排课课时", "数据来源",
  ]);
  assert.equal(cell(main!, "A1"), "2026年08月教务宝课时表");
  assert.equal(cell(main!, "M3"), "试听员名单");
  assert.equal(cell(main!, "D4"), 3);
  assert.equal(cell(main!, "G4"), 3);
  assert.equal(cell(main!, "I4"), "已到达 2");
  assert.equal(cell(main!, "H4"), null);
  assert.equal(cell(main!, "E4"), null);
  assert.equal(cell(main!, "F4"), null);
  assert.equal(cell(main!, "K4"), null);
  assert.equal(cell(main!, "L4"), null);
  assert.match(String(cell(main!, "M5")), /课程标题候选，待核对/u);
  assert.equal(cell(main!, "G7"), 9);
  assert.equal(cell(main!, "D8"), 4.5);
  assert.equal(cell(main!, "G8"), null, "missing completed schedules keep the teacher control total unknown");
  assert.equal(cell(main!, "A10"), "教务宝多教师记录（课时暂未拆分）");
  assert.equal(cell(main!, "I12"), "本月逐课次老师已明确，课时已在上表按老师归属");
  assert.equal(cell(students!, "I3"), "备注");
  assert.equal(cell(students!, "C4"), "Olivia & Co");
  assert.equal(cell(students!, "H4"), "Year 11 English");
  assert.equal(cell(students!, "D4"), 1);
  assert.equal(cell(students!, "C5"), "Olivia & Co");
  assert.equal(cell(students!, "H5"), "Year 12 English");
  assert.equal(cell(students!, "D5"), 2);
  assert.equal(cell(students!, "E4"), null);
  assert.equal(cell(students!, "F4"), null);
  assert.equal(cell(review!, "F2"), null);
  assert.equal(cell(review!, "G2"), 3);
  for (const reference of ["H2", "I2", "J2", "K2", "L2", "M2", "N2"]) assert.equal(cell(review!, reference), null);
  assert.equal(cell(lessons!, "L2"), 1);
  assert.equal(cell(schedules!, "M2"), 1);
  assert.equal(cell(source!, "B3"), input.generatedAt);

  const parts = storedParts(bytes);
  const mainXml = parts.get("xl/worksheets/sheet1.xml")!;
  const detailXml = parts.get("xl/worksheets/sheet2.xml")!;
  assert.match(mainXml, /<dimension ref="A1:M12"\/>/u);
  assert.match(detailXml, /<dimension ref="A1:I7"\/>/u);
  for (const merge of ["A1:I1", "A2:I2", "A4:A6", "B4:B6", "G4:G6", "H4:H6", "K4:K6", "L4:L6", "A10:I10"]) {
    assert.ok(mainXml.includes(`<mergeCell ref="${merge}"/>`), merge);
  }
  assert.match(mainXml, /<col min="13" max="13" width="112\.5625" customWidth="1"\/>/u);
  assert.match(detailXml, /<col min="9" max="9" width="31\.3125" customWidth="1"\/>/u);
  const allXml = [...parts.values()].join("");
  assert.doesNotMatch(allXml, /MUST NOT EXPORT|Example Bank|1234|157\.5|99999|<f(?:\s|>)/u);
  assert.match(allXml, /=HYPERLINK\(/u);
  assert.match(allXml, /&lt;Tutor&gt;/u);
});

test("hours-only export keeps role hours separate, leaves missing role hours unknown, and never doubles student hours", () => {
  const sample = sampleWorkbook();
  const assistant = sample.evidence!.schedules[0]!.teachers[1]!;
  const assistantRow = {
    ...sample.rows[1]!,
    teacherKey: "internal:teacher-2",
    teacherId: "teacher-2",
    sourceTeacherId: "assistant-1",
    teacherName: "Assistant",
    sourceHours: 0.5,
    lines: [sample.rows[0]!.lines[0]!],
  };
  const input: PayrollWorkbookExport = {
    ...sample,
    exportMode: "hours_only",
    rows: [sample.rows[0]!, assistantRow, { ...sample.rows[1]!, sourceHours: null }],
    evidence: {
      ...sample.evidence!,
      teacherLessonSourceKeys: [...sample.evidence!.teacherLessonSourceKeys, {
        teacherKey: assistantRow.teacherKey,
        sourceKeys: [sample.rows[0]!.lines[0]!.sourceKey!],
      }],
      lessons: sample.evidence!.lessons.map((lesson, index) => index === 0
        ? { ...lesson, teachers: [primary, assistant] }
        : lesson),
    },
  };
  const [main, detail] = readXlsx(buildPayrollXlsx(input)).worksheets;
  assert.equal(cell(main!, "D7"), null);
  assert.equal(cell(main!, "G7"), 0.5);
  assert.equal(cell(main!, "D9"), 4.5);
  assert.equal(cell(main!, "G9"), null, "missing completed schedules keep the teacher control total unknown");
  assert.equal(cell(main!, "J8"), "老师课时待核对");
  assert.equal(cell(detail!, "D8"), null);
});

test("hours-only export retains finite source outliers and marks truly unknown totals", () => {
  for (const [hours, issue, expectedDetail, expectedTotal] of [
    [58.53, "out_of_range", 60.53, 62.03],
    [null, "non_numeric", null, null],
    [1e13, "out_of_range", null, null],
  ] as const) {
    const sample = sampleWorkbook();
    const first = sample.rows[0]!;
    const line = first.lines[0]!;
    const firstLesson = sample.evidence!.lessons[0]!;
    const input: PayrollWorkbookExport = {
      ...sample,
      exportMode: "hours_only",
      rows: [{ ...first, paymentMode: "review_only", amount: 0, lines: [
        { ...line, hours, hoursIssue: issue }, ...first.lines.slice(1),
      ] }, sample.rows[1]!],
      evidence: { ...sample.evidence!, lessons: [
        { ...firstLesson, hours, hoursIssue: issue }, ...sample.evidence!.lessons.slice(1),
      ] },
    };
    const [main, detail, , sourceLessons, , source] = readXlsx(buildPayrollXlsx(input)).worksheets;
    assert.equal(cell(main!, "D4"), expectedDetail);
    assert.equal(cell(main!, "D8"), expectedTotal);
    assert.equal(cell(sourceLessons!, "L2"), hours === null ? "待核对" : hours === 1e13 ? String(hours) : hours);
    const sourceTotal = source!.rows.find((row) => row.cells[0]?.value === "学生实扣课时总计")?.cells[1]?.value;
    if (hours === 58.53) assert.equal(sourceTotal, 62.03);
    else assert.match(String(sourceTotal), hours === null ? /不完整/u : /无法安全合计/u);
    assert.match(String(cell(detail!, "I4")), /待核对|合计不完整/u);
  }
});

test("hours-only review keeps an oversized teacher role as text without enabling payment", () => {
  const sample = sampleWorkbook();
  const first = sample.rows[0]!;
  const schedule = sample.evidence!.schedules[0]!;
  const input: PayrollWorkbookExport = {
    ...sample,
    exportMode: "hours_only",
    rows: [{ ...first, paymentMode: "review_only", amount: 0, sourceHours: 1e13 }, sample.rows[1]!],
    evidence: { ...sample.evidence!, schedules: [{ ...schedule, teachers: [
      { ...schedule.teachers[0]!, sourceTeacherHours: 1e13, sourceTeacherHoursIssue: "out_of_range" },
      ...schedule.teachers.slice(1),
    ] }] },
  };
  const [main, , , , sourceSchedules] = readXlsx(buildPayrollXlsx(input)).worksheets;
  assert.equal(cell(main!, "G4"), String(1e13));
  assert.equal(cell(main!, "G8"), null);
  assert.match(String(cell(main!, "J8")), /不完整/u);
  assert.equal(cell(sourceSchedules!, "M2"), String(1e13));
  assert.throws(() => buildPayrollXlsx({ ...input, rows: [
    { ...input.rows[0]!, paymentMode: "payable" }, input.rows[1]!,
  ] }), /异常教务宝老师课时|教务宝老师课时/u);
});

test("hours-only teacher control total stays unknown when a completed lesson lacks its schedule role", () => {
  for (const missingRole of [true, false]) {
    const sample = sampleWorkbook();
    const first = sample.rows[0]!;
    const sourceKey = first.lines[0]!.sourceKey!;
    const schedule = sample.evidence!.schedules[0]!;
    const rows = [{ ...first, paymentMode: "review_only" as const, amount: 0,
      sourceHours: null, lines: [first.lines[0]!] }, sample.rows[1]!];
    const input: PayrollWorkbookExport = {
      ...sample, exportMode: "hours_only", rows,
      evidence: { ...sample.evidence!, lessonRowCount: 1, scheduleRowCount: missingRole ? 1 : 0,
        lessons: [sample.evidence!.lessons[0]!],
        schedules: missingRole ? [{ ...schedule, teachers: [] }] : [],
        teacherLessonSourceKeys: [{ teacherKey: first.teacherKey, sourceKeys: [sourceKey] },
          { teacherKey: sample.rows[1]!.teacherKey, sourceKeys: [] }],
      },
    };
    const [main, , , , , source] = readXlsx(buildPayrollXlsx(input)).worksheets;
    assert.equal(main!.rows[3 + rows.length]!.cells[6]!.value, null);
    assert.equal(source!.rows.find((row) => row.cells[0]?.value === "异常老师角色课时数")?.cells[1]?.value, 1);
  }
});

test("hours-only export retains ambiguous multi-teacher student hours once in both template sheets", () => {
  const sample = sampleWorkbook();
  const sourceLine = sample.rows[0]!.lines[0]!;
  const assistant = sample.evidence!.schedules[0]!.teachers[1]!;
  const third = sample.evidence!.schedules[0]!.teachers[2]!;
  const input: PayrollWorkbookExport = {
    ...sample,
    exportMode: "hours_only",
    rows: [
      { ...sample.rows[0]!, lines: sample.rows[0]!.lines.slice(1) },
      { ...sample.rows[1]!, teacherKey: "internal:teacher-2", teacherName: "Assistant", sourceHours: 0.5, lines: [sourceLine] },
      { ...sample.rows[1]!, teacherKey: "source:third-1", teacherName: "Third teacher", sourceHours: 0.25, lines: [sourceLine] },
      sample.rows[1]!,
    ],
    evidence: {
      ...sample.evidence!,
      teacherLessonSourceKeys: [
        { ...sample.evidence!.teacherLessonSourceKeys[0]!, sourceKeys: sample.evidence!.teacherLessonSourceKeys[0]!.sourceKeys.filter((key) => key !== sourceLine.sourceKey) },
        { teacherKey: "internal:teacher-2", sourceKeys: [sourceLine.sourceKey!] },
        { teacherKey: "source:third-1", sourceKeys: [sourceLine.sourceKey!] },
        sample.evidence!.teacherLessonSourceKeys[1]!,
      ],
      lessons: sample.evidence!.lessons.map((lesson, index) => index === 0
        ? { ...lesson, teachers: [assistant, third] }
        : lesson),
    },
  };
  const [main, detail] = readXlsx(buildPayrollXlsx(input)).worksheets;
  assert.equal(cell(main!, "D7"), null);
  assert.equal(cell(main!, "G7"), 0.5);
  assert.equal(cell(main!, "D8"), null);
  assert.equal(cell(main!, "G8"), 0.25);
  assert.equal(cell(main!, "D10"), 3.5);
  assert.equal(cell(main!, "D14"), 1);
  assert.equal(cell(main!, "D15"), 1);
  assert.equal(cell(detail!, "D7"), null);
  assert.equal(cell(detail!, "D8"), null);
  assert.equal(cell(detail!, "D9"), 1);
  const detailHours = detail!.rows.flatMap((row) => row.cells)
    .filter((entry) => /^D[4-9]$/u.test(entry.reference) && typeof entry.value === "number")
    .reduce((total, entry) => total + Number(entry.value), 0);
  assert.equal(detailHours, 4.5);
});

test("fails closed for malformed workbook text, numbers, months and evidence counts", () => {
  const sample = sampleWorkbook();
  assert.throws(() => buildPayrollXlsx({ ...sample, month: "2026-13" }), /月份/);
  assert.throws(() => buildPayrollXlsx({ ...sample, rows: [{ ...sample.rows[0]!, amount: Number.NaN }] }), /金额/);
  assert.throws(() => buildPayrollXlsx({ ...sample, rows: [{ ...sample.rows[0]!, teacherName: "\ud800" }] }), /无效字符/);
  assert.throws(() => buildPayrollXlsx({ ...sample, rows: [{ ...sample.rows[0]!, teacherName: "x".repeat(32_768) }] }), /过长/);
  assert.throws(() => buildPayrollXlsx({ ...sample, evidence: { ...sample.evidence!, lessonRowCount: 1 } }), /行数/);
  assert.throws(() => buildPayrollXlsx({ ...sample, exportMode: "hours_only", evidence: undefined }), /双源快照/);
  assert.throws(() => buildPayrollXlsx({ ...sample, exportMode: "payable" as "hours_only" }), /模式/);
});

test("review-only output cannot expose stale rates, subtotals, approval state, variance or payment details", () => {
  const sample = sampleWorkbook();
  const staleReviewRow = {
    ...sample.rows[1]!,
    lines: [{
      studentName: "Old persisted student",
      hours: 2,
      rate: 123,
      subtotal: 246,
    }],
  };
  const workbook = readXlsx(buildPayrollXlsx({
    ...sample,
    rows: [staleReviewRow],
    evidence: undefined,
  }));
  const [main, , review] = workbook.worksheets;
  assert.equal(cell(main!, "E4"), null);
  assert.equal(cell(main!, "F4"), null);
  assert.equal(cell(review!, "E2"), "需核对");
  assert.equal(cell(review!, "F2"), 0);
  assert.equal(cell(review!, "G2"), 9);
  assert.equal(cell(review!, "H2"), null);
  for (const reference of ["I2", "J2", "K2", "L2", "M2", "N2"]) assert.equal(cell(review!, reference), null);
});

test("rejects duplicate teacher identities and any incomplete, foreign or duplicate JWB lesson-key projection", () => {
  const sample = sampleWorkbook();
  assert.throws(() => buildPayrollXlsx({
    ...sample,
    rows: [...sample.rows, { ...sample.rows[0]!, teacherName: "Duplicate teacher row" }],
  }), /重复老师身份/);

  const sourceRow = sample.rows[0]!;
  assert.throws(() => buildPayrollXlsx({
    ...sample,
    rows: [{ ...sourceRow, lines: sourceRow.lines.slice(0, -1) }, sample.rows[1]!],
  }), /不完整或不一致/);
  assert.throws(() => buildPayrollXlsx({
    ...sample,
    rows: [{
      ...sourceRow,
      lines: sourceRow.lines.map((line, index) => index === 0
        ? { ...line, sourceKey: "jwb-open-api:lesson:branch-1:foreign:member-1" }
        : line),
    }, sample.rows[1]!],
  }), /不属于当前教务宝消课证据/);
  assert.throws(() => buildPayrollXlsx({
    ...sample,
    rows: [{
      ...sourceRow,
      lines: sourceRow.lines.map((line, index) => index === 1
        ? { ...line, sourceKey: sourceRow.lines[0]!.sourceKey }
        : line),
    }, sample.rows[1]!],
  }), /重复教务宝来源键/);
  assert.throws(() => buildPayrollXlsx({
    ...sample,
    rows: [{
      ...sourceRow,
      lines: sourceRow.lines.map((line, index) => index === 0 ? { ...line, sourceKey: undefined } : line),
    }, sample.rows[1]!],
  }), /缺少当前教务宝来源键/);
  assert.throws(() => buildPayrollXlsx({
    ...sample,
    evidence: {
      ...sample.evidence!,
      lessons: sample.evidence!.lessons.map((lesson, index) => index === 1
        ? { ...lesson, sourceKey: sample.evidence!.lessons[0]!.sourceKey }
        : lesson),
    },
  }), /证据包含重复来源键/);
});

test("rejects student evidence moved to another teacher or a missing multi-teacher row", () => {
  const sample = sampleWorkbook();
  const firstRow = sample.rows[0]!;
  const secondRow = sample.rows[1]!;
  const movedLine = firstRow.lines[0]!;
  assert.throws(() => buildPayrollXlsx({
    ...sample,
    rows: [{ ...firstRow, lines: firstRow.lines.slice(1) }, { ...secondRow, lines: [movedLine] }],
  }), /该老师的学生明细.*课次映射不完整或不一致/);

  assert.throws(() => buildPayrollXlsx({
    ...sample,
    evidence: {
      ...sample.evidence!,
      teacherLessonSourceKeys: [...sample.evidence!.teacherLessonSourceKeys, {
        teacherKey: "internal:teacher-2",
        sourceKeys: [movedLine.sourceKey!],
      }],
    },
  }), /老师课次映射缺少对应薪资行/);
});

test("rejects any student fact changed after the current JWB evidence was loaded", () => {
  const sample = sampleWorkbook();
  const row = sample.rows[0]!;
  const line = row.lines[0]!;
  for (const changedLine of [
    { ...line, studentName: "Wrong student" },
    { ...line, hours: line.hours + 0.5 },
    { ...line, isTrial: !line.isTrial },
    { ...line, sourceMemberId: "wrong-member" },
    { ...line, studentId: "wrong-student" },
    { ...line, studentMatch: "unmatched" },
    { ...line, evidenceOnly: false },
    { ...line, rate: 1 },
    { ...line, subtotal: 1 },
  ]) {
    assert.throws(() => buildPayrollXlsx({
      ...sample,
      rows: [{ ...row, lines: [changedLine, ...row.lines.slice(1)] }, sample.rows[1]!],
    }), /学生明细与当前教务宝消课事实不一致/);
  }
});

test("stored OOXML ZIP writer rejects unsafe, duplicate and aggregate-oversized parts", () => {
  assert.throws(() => createStoredOpenXmlZip([{ name: "../evil.xml", xml: "x" }]), /不安全/);
  assert.throws(() => createStoredOpenXmlZip([{ name: "a.xml", xml: "x" }, { name: "a.xml", xml: "y" }]), /重复/);
  const half = "x".repeat(16 * 1024 * 1024);
  assert.throws(() => createStoredOpenXmlZip([{ name: "a.xml", xml: half }, { name: "b.xml", xml: half }]), /大小上限/);
});


test("hours-only review displays complete raw role totals when historical branch evidence is unresolved", () => {
  for (const [hours, issue, expected] of [
    [2.5, undefined, 2.5],
    [0, undefined, 0],
    [58.53, "out_of_range", 58.53],
    [null, "missing", "待核对"],
    [1e13, "out_of_range", "待核对"],
  ] as const) {
    const sample = sampleWorkbook();
    const lesson = sample.evidence!.lessons[1]!;
    const row = { ...sample.rows[0]!, paymentMode: "review_only" as const,
      sourceHours: null, lines: [sample.rows[0]!.lines[1]!] };
    const input: PayrollWorkbookExport = {
      ...sample, exportMode: "hours_only", rows: [row],
      evidence: { ...sample.evidence!, lessonRowCount: 1, scheduleRowCount: 1,
        lessons: [lesson], teacherLessonSourceKeys: [{ teacherKey: row.teacherKey, sourceKeys: [lesson.sourceKey] }],
        schedules: [{ ...sample.evidence!.schedules[0]!, calendarId: lesson.calendarId,
          teachers: [{ ...primary, sourceTeacherHours: hours, sourceTeacherHoursIssue: issue }] }],
      },
    };
    const [main, , review] = readXlsx(buildPayrollXlsx(input)).worksheets;
    assert.equal(cell(main!, "G4"), expected);
    assert.equal(cell(review!, "G2"), expected);
    assert.equal(cell(review!, "E2"), "课时待核对");
    assert.match(String(cell(main!, "I4")), /待核对/u);
    for (const reference of ["E4", "F4", "H4", "K4", "L4"]) assert.equal(cell(main!, reference), null);
    assert.equal(row.sourceHours, null, "display totals must not change payroll authority");
    assert.throws(() => buildPayrollXlsx({ ...input, rows: [{ ...row, paymentMode: "payable" }] }), /缺失教务宝老师课时/u);
  }
});

test("hours-only raw role totals remain unknown when a teacher lesson has no matching schedule role", () => {
  for (const missing of ["schedule", "role", "hours", "identity"] as const) {
    const sample = sampleWorkbook();
    const lesson = sample.evidence!.lessons[1]!;
    const row = { ...sample.rows[0]!, paymentMode: "review_only" as const,
      sourceHours: null, lines: [sample.rows[0]!.lines[1]!] };
    const schedule = { ...sample.evidence!.schedules[0]!,
      calendarId: missing === "schedule" ? "other-calendar" : lesson.calendarId,
      teachers: missing === "role" ? [] : [{ ...primary,
        teacherId: missing === "identity" ? "other-teacher" : primary.teacherId,
        sourceTeacherHours: missing === "hours" ? null : 2.5 }],
    };
    const input: PayrollWorkbookExport = {
      ...sample, exportMode: "hours_only", rows: [row],
      evidence: { ...sample.evidence!, lessonRowCount: 1, scheduleRowCount: 1,
        lessons: [lesson], schedules: [schedule],
        teacherLessonSourceKeys: [{ teacherKey: row.teacherKey, sourceKeys: [lesson.sourceKey] }],
      },
    };
    const [main] = readXlsx(buildPayrollXlsx(input)).worksheets;
    assert.equal(cell(main!, "G4"), "待核对");
  }
});
