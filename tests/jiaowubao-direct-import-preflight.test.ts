import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  JIAOWUBAO_DIRECT_STAGING_FORMAT,
  MAX_JIAOWUBAO_DIRECT_CHUNK_BYTES,
  prepareJiaowubaoDirectStaging,
} from "../lib/jiaowubao-direct-import-preflight.ts";
import type { JiaowubaoStaticParsedXlsxExports } from "../lib/jiaowubao-static-xlsx-parser.ts";

const sha256 = "a".repeat(64);

function source(workbook: string) {
  return { workbook, workbookName: `${workbook}.xlsx`, sha256, sheetName: "Sheet1" };
}

function tabular(workbook: string, row: number, fields: Record<string, string | number | null>) {
  return {
    sourceKey: `jwb-static-v1:${workbook}:r${row}`,
    sourceRefs: [{ workbook, row }],
    payload: {
      raw: { fields, cells: {} },
      identity: {
        ...(typeof fields.姓名 === "string" ? { name: fields.姓名 } : {}),
        ...(fields.手机号 !== null && fields.手机号 !== undefined ? { phone: String(fields.手机号) } : {}),
      },
    },
  };
}

function fixture(): JiaowubaoStaticParsedXlsxExports {
  const student = { 姓名: "Private Learner", 手机号: "0400111222", 学员类型: "在读" };
  return {
    format: "jiaowubao-static-excel-v1",
    quickList: { source: source("quick_list"), headerRow: 2, records: [tabular("quick_list", 3, student)] },
    students: { source: source("students"), headerRow: 2, records: [tabular("students", 3, student)] },
    contracts: { source: source("contracts"), headerRow: 2, records: [tabular("contracts", 3, { ...student, 课程: "Private Course" })] },
    hours: {
      source: source("hours"),
      headerRow: 2,
      records: [
        tabular("hours", 3, { ...student, 课程: "Private Course", 课时数: 10, 已消课时: 2, 剩余课时: 8 }),
        tabular("hours", 4, { ...student, 课程: "Private Course", 课时数: 10, 已消课时: 3, 剩余课时: 8 }),
        tabular("hours", 5, { ...student, 课程: "Private Course", 课时数: 10, 已消课时: 12, 剩余课时: -2 }),
        tabular("hours", 6, { ...student, 课程: "Private Course", 课时数: null, 已消课时: 3, 剩余课时: 8 }),
      ],
    },
    classMemberships: {
      source: source("class_members"),
      records: [{
        sourceKey: "jwb-static-v1:class_members:r1",
        sourceRefs: [{ workbook: "class_members", row: 1 }],
        payload: {
          raw: { cells: {}, values: { className: "Private Class", classType: "Group", studentName: "Private Learner", phone: "0400111222" } },
          className: "Private Class",
          classType: "Group",
          studentName: "Private Learner",
          identity: { name: "Private Learner", phone: "0400111222" },
        },
      }],
    },
    schedule: {
      source: source("schedule"),
      gridOriginDate: "2021-08-03",
      gridOriginColumn: 2,
      sourceTimezone: "Australia/Melbourne",
      sourceTimezoneBasis: "fixture timezone basis",
      summary: { cells: 3, parsed: 2, invalidTime: 1 },
      records: [
        {
          sourceKey: "jwb-static-v1:schedule:b2",
          sourceRefs: [{ workbook: "schedule", row: 2, cell: "B2" }],
          payload: {
            raw: { cell: { reference: "B2", type: "string", value: "private" }, cellRef: "B2", rawText: "private", rawLines: ["private"] },
            sourceDate: "2026-08-18",
            sourceTimezone: "Australia/Melbourne",
            sourceTimezoneBasis: "fixture timezone basis",
            parseStatus: { kind: "parsed", start: "09:00", end: "10:00" },
            start: "09:00",
            end: "10:00",
            className: "Private Class",
            course: "Private Course",
            teacher: "Private Teacher",
            assistants: [],
            studentDisplayNames: ["Private Learner"],
            identities: [{ name: "Private Learner" }],
            unmappedPositionalLines: [],
          },
        },
        {
          sourceKey: "jwb-static-v1:schedule:c2",
          sourceRefs: [{ workbook: "schedule", row: 2, cell: "C2" }],
          payload: {
            raw: { cell: { reference: "C2", type: "string", value: "private" }, cellRef: "C2", rawText: "private", rawLines: ["private"] },
            sourceDate: "2026-04-05",
            sourceTimezone: "Australia/Melbourne",
            sourceTimezoneBasis: "fixture timezone basis",
            parseStatus: { kind: "parsed", start: "02:30", end: "03:30" },
            start: "02:30",
            end: "03:30",
            assistants: [],
            studentDisplayNames: [],
            identities: [],
            unmappedPositionalLines: [],
          },
        },
        {
          sourceKey: "jwb-static-v1:schedule:d2",
          sourceRefs: [{ workbook: "schedule", row: 2, cell: "D2" }],
          payload: {
            raw: { cell: { reference: "D2", type: "string", value: "private" }, cellRef: "D2", rawText: "private", rawLines: ["private"] },
            sourceDate: "2026-08-20",
            sourceTimezone: "Australia/Melbourne",
            sourceTimezoneBasis: "fixture timezone basis",
            parseStatus: { kind: "invalid_time", reason: "non_positive_time_interval" },
            assistants: [],
            studentDisplayNames: [],
            identities: [],
            unmappedPositionalLines: [],
          },
        },
      ],
    },
    leaveMakeups: {
      source: source("leave_makeups"),
      headerRow: 3,
      records: [{
        sourceKey: "jwb-static-v1:leave_makeups:r4",
        sourceRefs: [{ workbook: "leave_makeups", row: 4 }],
        payload: {
          raw: { fields: { 姓名: "Private Learner", 上课日期: "2026-08-18" }, cells: {} },
          identity: { name: "Private Learner" },
          sourceDate: "2026-08-18",
        },
      }],
    },
  } as unknown as JiaowubaoStaticParsedXlsxExports;
}

test("prepares deterministic server-only staging chunks without creating or linking students", () => {
  const first = prepareJiaowubaoDirectStaging(fixture());
  const second = prepareJiaowubaoDirectStaging(fixture());

  assert.equal(first.manifest.format, JIAOWUBAO_DIRECT_STAGING_FORMAT);
  assert.equal(first.revision, second.revision);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first.recordCounts, {
    student_snapshot: 1,
    quick_list: 1,
    contract_history: 1,
    hour_balance: 4,
    class_membership: 1,
    schedule_event: 3,
    leave_makeup: 1,
  });

  const schedule = first.chunks.flatMap((chunk) => chunk.records).find((record) => record.sourceKey === "jwb-static-v1:schedule:b2");
  assert.ok(schedule);
  assert.deepEqual(schedule.sourceRefs, [{ workbook: "schedule", row: 2, cell: "B2" }]);
  assert.deepEqual(schedule.studentRelationship, {
    state: "pending_authoritative_tencent_match",
    automaticAttachment: "forbidden",
    sourceIdentity: "schedule_display_names",
  });
  assert.deepEqual((schedule.payload.staging as Record<string, unknown>).temporal, {
    state: "resolved",
    sourceDate: "2026-08-18",
    start: "09:00",
    end: "10:00",
    sourceTimezone: "Australia/Melbourne",
    sourceStartInstant: "2026-08-17T23:00:00.000Z",
    sourceEndInstant: "2026-08-18T00:00:00.000Z",
  });
  assert.equal((schedule.payload.staging as Record<string, unknown>).studentBookingExpansion, "forbidden");
  assert.equal(canonicalJson(first).includes("studentId"), false);
  assert.equal(canonicalJson(first).includes("newStudent"), false);
});

test("reports only aggregates while retaining audit detail inside chunks", () => {
  const prepared = prepareJiaowubaoDirectStaging(fixture());
  const report = canonicalJson(prepared.reconciliation);

  assert.equal(report.includes("Private Learner"), false);
  assert.equal(report.includes("0400111222"), false);
  assert.equal(report.includes("Private Course"), false);
  assert.deepEqual(prepared.reconciliation.hourBalances, {
    rows: 4,
    arithmeticallyConsistent: 2,
    arithmeticMismatch: 1,
    incompleteNumericFields: 1,
    invalidNumericFields: 0,
    negativeTotalHours: 0,
    negativeUsedHours: 0,
    negativeRemainingHours: 1,
  });
  assert.deepEqual(prepared.reconciliation.schedule, {
    sourceCells: 3,
    parsedTimeIntervals: 2,
    invalidTimeIntervals: 1,
    resolvedWallClocks: 1,
    invalidWallClocks: 0,
    ambiguousWallClocks: 1,
    nonPositiveIntervals: 0,
    missingClass: 2,
    missingCourse: 2,
    missingTeacher: 2,
  });
  for (const chunk of prepared.chunks) {
    assert.ok(Buffer.byteLength(canonicalJson(chunk), "utf8") <= MAX_JIAOWUBAO_DIRECT_CHUNK_BYTES);
  }
});
