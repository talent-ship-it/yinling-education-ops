import assert from "node:assert/strict";
import test from "node:test";

import {
  JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE,
  parseJiaowubaoStaticClassMembershipWorkbook,
  parseJiaowubaoStaticHeaderWorkbook,
  parseJiaowubaoStaticLeaveMakeupWorkbook,
  parseJiaowubaoStaticScheduleWorkbook,
} from "../lib/jiaowubao-static-xlsx-parser.ts";
import type { XlsxCell, XlsxRow, XlsxWorkbook } from "../lib/xlsx-reader.ts";

const descriptor = Object.freeze({
  workbookName: "fixture.xlsx",
  sha256: "a".repeat(64),
});

function columnNumber(reference: string) {
  const letters = reference.match(/^[A-Z]+/u)?.[0];
  if (!letters) throw new Error(`Invalid fixture reference ${reference}`);
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function rowNumber(reference: string) {
  const value = Number(reference.match(/\d+$/u)?.[0]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid fixture reference ${reference}`);
  return value;
}

function cell(reference: string, value: string | number | boolean | null): XlsxCell {
  return Object.freeze({
    reference,
    row: rowNumber(reference),
    column: columnNumber(reference),
    type: value === null ? "blank" : typeof value === "string" ? "string" : typeof value === "number" ? "number" : "boolean",
    value,
  });
}

function row(index: number, cells: readonly XlsxCell[]): XlsxRow {
  return Object.freeze({ index, cells: Object.freeze([...cells]) });
}

function workbook(rows: readonly XlsxRow[]): XlsxWorkbook {
  return Object.freeze({
    worksheets: Object.freeze([Object.freeze({ name: "Sheet1", rows: Object.freeze([...rows]) })]),
  });
}

test("maps row-2 JWB headers to source-safe fields and leaves attachment decisions absent", () => {
  const parsed = parseJiaowubaoStaticHeaderWorkbook("students", descriptor, workbook([
    row(1, [cell("A1", "Export title")]),
    row(2, [cell("A2", "姓名"), cell("B2", "手机号"), cell("C2", "学员类型"), cell("D2", "年级")]),
    row(3, [cell("A3", "Learner A"), cell("B3", 61123456789), cell("C3", "在读"), cell("D3", "Year 10")]),
    row(4, [cell("A4", null), cell("B4", null), cell("C4", null), cell("D4", null)]),
  ]));

  assert.equal(parsed.headerRow, 2);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].sourceKey, "jwb-static-v1:students:r3");
  assert.deepEqual(parsed.records[0].sourceRefs, [{ workbook: "students", row: 3 }]);
  assert.deepEqual(parsed.records[0].payload.raw.fields, {
    姓名: "Learner A",
    手机号: 61123456789,
    学员类型: "在读",
    年级: "Year 10",
  });
  assert.deepEqual(parsed.records[0].payload.identity, { name: "Learner A", phone: "61123456789" });
  assert.equal("attachment" in parsed.records[0].payload, false);
});

test("maps the leave workbook's row-3 header and preserves its no-phone identity hint", () => {
  const parsed = parseJiaowubaoStaticLeaveMakeupWorkbook(descriptor, workbook([
    row(1, [cell("A1", "Leave title")]),
    row(2, [cell("A2", "Summary")]),
    row(3, [
      cell("A3", "姓名"), cell("B3", "上课日期"), cell("C3", "上课时间"), cell("D3", "班级"),
      cell("E3", "课程"), cell("F3", "上课老师"), cell("G3", "处理状态"),
    ]),
    row(4, [
      cell("A4", "Learner B"), cell("B4", "2026-08-18"), cell("C4", "09:00-10:00"), cell("D4", "Class B"),
      cell("E4", "Course B"), cell("F4", "Teacher B"), cell("G4", "待补课"),
    ]),
  ]));

  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.records[0].sourceRefs, [{ workbook: "leave_makeups", row: 4 }]);
  assert.deepEqual(parsed.records[0].payload.identity, { name: "Learner B" });
  assert.equal(parsed.records[0].payload.sourceDate, "2026-08-18");
  assert.equal(parsed.records[0].payload.sourceTime, "09:00-10:00");
  assert.equal(parsed.records[0].payload.status, "待补课");
});

test("maps a no-header class-membership export positionally from A:D", () => {
  const parsed = parseJiaowubaoStaticClassMembershipWorkbook(descriptor, workbook([
    row(1, [cell("A1", "Class C"), cell("B1", "One-to-one"), cell("C1", "Learner C"), cell("D1", 61123456780)]),
  ]));

  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].sourceKey, "jwb-static-v1:class_members:r1");
  assert.deepEqual(parsed.records[0].payload.raw.values, {
    className: "Class C",
    classType: "One-to-one",
    studentName: "Learner C",
    phone: 61123456780,
  });
  assert.deepEqual(parsed.records[0].payload.identity, { name: "Learner C", phone: "61123456780" });
});

test("skips a cosmetic class-member header but does not depend on it", () => {
  const parsed = parseJiaowubaoStaticClassMembershipWorkbook(descriptor, workbook([
    row(1, [cell("A1", "班级名"), cell("B1", "班级类型"), cell("C1", "学员名"), cell("D1", "学员手机号")]),
    row(2, [cell("A2", "Class D"), cell("B2", "Group"), cell("C2", "Learner D"), cell("D2", "61123456781")]),
  ]));

  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.records[0].sourceRefs, [{ workbook: "class_members", row: 2 }]);
});

test("parses schedule grid cells from B=2021-08-03 and quarantines bad time intervals as data", () => {
  const parsed = parseJiaowubaoStaticScheduleWorkbook(descriptor, workbook([
    row(1, [cell("B1", "周二(08月03日)"), cell("C1", "周三(08月04日)")]),
    row(2, [
      cell("B2", "9:00~10:30\nClass E\nCourse E\n\nTeacher E\n无(助教)\n无(助教2)\n2人\nLearner E、Learner F"),
      cell("C2", "10:00-09:30\nClass F\nCourse F\n\nTeacher F\n无(助教)\n无(助教2)\n1人\nLearner G"),
    ]),
  ]));

  assert.deepEqual(parsed.summary, { cells: 2, parsed: 1, invalidTime: 1 });
  const valid = parsed.records[0];
  assert.equal(valid.sourceKey, "jwb-static-v1:schedule:b2");
  assert.deepEqual(valid.sourceRefs, [{ workbook: "schedule", row: 2, cell: "B2" }]);
  assert.equal(valid.payload.raw.cellRef, "B2");
  assert.equal(valid.payload.sourceDate, "2021-08-03");
  assert.equal(valid.payload.sourceTimezone, JIAOWUBAO_STATIC_SCHEDULE_TIMEZONE);
  assert.deepEqual(valid.payload.parseStatus, { kind: "parsed", start: "09:00", end: "10:30" });
  assert.equal(valid.payload.className, "Class E");
  assert.equal(valid.payload.course, "Course E");
  assert.equal(valid.payload.teacher, "Teacher E");
  assert.deepEqual(valid.payload.assistants, []);
  assert.equal(valid.payload.declaredCount, 2);
  assert.deepEqual(valid.payload.studentDisplayNames, ["Learner E", "Learner F"]);
  assert.deepEqual(valid.payload.identities, [{ name: "Learner E" }, { name: "Learner F" }]);

  const invalid = parsed.records[1];
  assert.equal(invalid.payload.sourceDate, "2021-08-04");
  assert.deepEqual(invalid.payload.parseStatus, { kind: "invalid_time", reason: "non_positive_time_interval" });
  assert.equal(invalid.payload.start, undefined);
  assert.equal(invalid.payload.end, undefined);
  assert.match(invalid.payload.raw.rawText, /^10:00-09:30/u);
});
