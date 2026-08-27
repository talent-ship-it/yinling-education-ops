import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_JIAOWUBAO_STATIC_CHUNK_BYTES,
  prepareJiaowubaoStaticExcelImport,
} from "../lib/jiaowubao-static-import-service.ts";
import type { JiaowubaoStaticParsedXlsxExports } from "../lib/jiaowubao-static-xlsx-parser.ts";

const sha256 = "a".repeat(64);

function raw(fields: Record<string, string | number | null>) {
  return { fields, cells: {} };
}

function source(workbook: string) {
  return { workbook, workbookName: `${workbook}.xlsx`, sha256, sheetName: "Sheet1" };
}

function tabular(workbook: string, row: number, fields: Record<string, string | number | null>) {
  return {
    sourceKey: `jwb-static-v1:${workbook}:r${row}`,
    sourceRefs: [{ workbook, row }],
    payload: {
      raw: raw(fields),
      identity: {
        ...(typeof fields.姓名 === "string" ? { name: fields.姓名 } : {}),
        ...(typeof fields.手机号 === "string" || typeof fields.手机号 === "number" ? { phone: String(fields.手机号) } : {}),
      },
    },
  };
}

function fixture(): JiaowubaoStaticParsedXlsxExports {
  const alice = { 姓名: "Alice Example", 手机号: "0400111222", 学员类型: "在读", 总课时数: 10, 已消课时: 2, 剩余课时: 8 };
  const anne = { 姓名: "Anne(VIC)", 手机号: "0400222333", 学员类型: "在读" };
  const excluded = { 姓名: "Excluded Learner", 手机号: "0400333444", 学员类型: "在读" };
  return {
    format: "jiaowubao-static-excel-v1",
    quickList: { source: source("quick_list"), headerRow: 2, records: [tabular("quick_list", 3, alice), tabular("quick_list", 4, anne), tabular("quick_list", 5, excluded)] },
    students: { source: source("students"), headerRow: 2, records: [tabular("students", 3, alice), tabular("students", 4, anne), tabular("students", 5, excluded)] },
    contracts: { source: source("contracts"), headerRow: 2, records: [tabular("contracts", 3, { ...alice, 课程: "English" })] },
    hours: { source: source("hours"), headerRow: 2, records: [tabular("hours", 3, { ...alice, 课程: "English", 课时数: 10, 已消课时: 2, 剩余课时: 8 })] },
    classMemberships: {
      source: source("class_members"),
      records: [{
        sourceKey: "jwb-static-v1:class_members:r1",
        sourceRefs: [{ workbook: "class_members", row: 1 }],
        payload: {
          raw: { cells: {}, values: { className: "Class A", classType: "Group", studentName: "Alice Example", phone: "0400111222" } },
          className: "Class A",
          classType: "Group",
          studentName: "Alice Example",
          identity: { name: "Alice Example", phone: "0400111222" },
        },
      }],
    },
    schedule: {
      source: source("schedule"),
      gridOriginDate: "2021-08-03",
      gridOriginColumn: 2,
      sourceTimezone: "Australia/Melbourne",
      sourceTimezoneBasis: "fixture timezone basis",
      summary: { cells: 1, parsed: 1, invalidTime: 0 },
      records: [{
        sourceKey: "jwb-static-v1:schedule:b2",
        sourceRefs: [{ workbook: "schedule", row: 2, cell: "B2" }],
        payload: {
          raw: { cell: { reference: "B2", type: "string", value: "fixture" }, cellRef: "B2", rawText: "fixture", rawLines: ["fixture"] },
          sourceDate: "2026-08-18",
          sourceTimezone: "Australia/Melbourne",
          sourceTimezoneBasis: "fixture timezone basis",
          parseStatus: { kind: "parsed", start: "09:00", end: "10:00" },
          start: "09:00",
          end: "10:00",
          className: "Class A",
          course: "English",
          teacher: "Teacher A",
          assistants: [],
          studentDisplayNames: ["Alice Example"],
          identities: [{ name: "Alice Example" }],
          unmappedPositionalLines: [],
        },
      }],
    },
    leaveMakeups: {
      source: source("leave_makeups"),
      headerRow: 3,
      records: [{
        sourceKey: "jwb-static-v1:leave_makeups:r4",
        sourceRefs: [{ workbook: "leave_makeups", row: 4 }],
        payload: { raw: raw({ 姓名: "Alice Example", 上课日期: "2026-08-18" }), identity: { name: "Alice Example" }, sourceDate: "2026-08-18", className: "Class A" },
      }],
    },
  } as unknown as JiaowubaoStaticParsedXlsxExports;
}

function masterSource(rows: readonly Readonly<{ sourceRow: number; name: string; status: string }>[] = []) {
  return {
    sourceId: "tencent-master",
    revision: "tencent-master-r1",
    rowsSha256: "b".repeat(64),
    rows,
  } as const;
}

test("prepares isolated evidence chunks: exact Tencent links only, review and exclusion stay quarantined", () => {
  const prepared = prepareJiaowubaoStaticExcelImport(fixture(), masterSource([
    { sourceRow: 1, name: "Alice Example", status: "在读" },
    { sourceRow: 2, name: "Anne", status: "在读" },
    { sourceRow: 3, name: "Excluded Learner", status: "不活跃 + 无课时" },
  ]));

  assert.deepEqual(prepared.recordCounts, {
    facts: 6,
    contracts: 1,
    hours: 1,
    classMembers: 1,
    schedule: 1,
    leaveMakeups: 1,
  });
  assert.equal(prepared.chunks.length, 1);
  const facts = prepared.chunks[0].facts;
  assert.deepEqual(facts.find((record) => record.sourceKey === "jwb-static-v1:students:r3")?.attachments, [
    { state: "attached", masterSourceRow: "1", evidenceName: "Alice Example", matchMode: "exact_name" },
  ]);
  assert.deepEqual(facts.find((record) => record.sourceKey === "jwb-static-v1:students:r4")?.attachments, [
    { state: "quarantined", reason: "review_required_annotation" },
  ]);
  assert.deepEqual(facts.find((record) => record.sourceKey === "jwb-static-v1:students:r5")?.attachments, [
    { state: "quarantined", reason: "excluded_master_status" },
  ]);
  const schedule = prepared.chunks[0].schedule[0];
  assert.deepEqual(schedule.sourceRefs, [{ workbook: "schedule", row: 2, cell: "B2" }]);
  assert.equal(schedule.payload.sourceStartInstant, "2026-08-17T23:00:00.000Z");
  assert.equal(schedule.payload.sourceEndInstant, "2026-08-18T00:00:00.000Z");
  assert.equal(schedule.attachments.some((attachment) => attachment.state === "attached" && attachment.masterSourceRow === "1"), true);
  assert.equal(schedule.attachments.some((attachment) => attachment.state === "quarantined" && attachment.reason === "non_operational_static_schedule"), true);
  assert.equal(prepared.chunks[0].leaveMakeups[0].attachments[0].state, "attached");
  assert.equal(JSON.stringify(prepared).includes("newStudent"), false);
  assert.deepEqual(prepared.chunks[0].masterSource, {
    sourceId: "tencent-master",
    revision: "tencent-master-r1",
    rowsSha256: "b".repeat(64),
  });
});

test("keeps chunks under the database transport limit", () => {
  const prepared = prepareJiaowubaoStaticExcelImport(fixture(), masterSource());
  for (const chunk of prepared.chunks) {
    assert.ok(Buffer.byteLength(JSON.stringify(chunk), "utf8") <= MAX_JIAOWUBAO_STATIC_CHUNK_BYTES);
    const records = chunk.facts.length + chunk.contracts.length + chunk.hours.length
      + chunk.classMembers.length + chunk.schedule.length + chunk.leaveMakeups.length;
    assert.ok(records > 0 && records <= 2_000);
  }
});

test("binds otherwise-identical static files to the Tencent snapshot used for attachments", () => {
  const rows = [{ sourceRow: 1, name: "Alice Example", status: "在读" }] as const;
  const first = prepareJiaowubaoStaticExcelImport(fixture(), masterSource(rows));
  const changedMaster = {
    ...masterSource(rows),
    revision: "tencent-master-r2",
    rowsSha256: "c".repeat(64),
  } as const;
  const second = prepareJiaowubaoStaticExcelImport(fixture(), changedMaster);
  assert.notEqual(first.revision, second.revision);
});
