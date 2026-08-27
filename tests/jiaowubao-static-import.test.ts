import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJiaowubaoStaticExportPlan,
  JiaowubaoStaticImportError,
  matchJiaowubaoStaticFactsToMaster,
  staticWallClockToInstant,
  type JiaowubaoStaticWorkbook,
} from "../lib/jiaowubao-static-import.ts";

const sha256 = "a".repeat(64);

function workbook(
  workbookName: string,
  rows: readonly Readonly<Record<string, string | number | null>>[],
): JiaowubaoStaticWorkbook {
  return { workbookName, workbookSha256: sha256, rows };
}

function exportInput(overrides: Partial<Parameters<typeof buildJiaowubaoStaticExportPlan>[0]> = {}) {
  return {
    quickList: workbook("quick.xlsx", [{
      姓名: "Alice Example",
      手机号: "0400 111 222",
      备用手机号: "0400 333 444",
      年级: "Year 10",
      学员类型: "在读",
      所在班级: "Quick Class",
    }, {
      姓名: "Expired Person",
      手机号: "0400 555 666",
      学员类型: "过期",
    }]),
    students: workbook("students.xlsx", [{
      姓名: "Alice Example",
      手机号: "0400111222",
      学员类型: "在读",
      总课时数: 10,
      已消课时: 2,
      剩余课时: 8,
      学员所在班级: "Student Class",
    }]),
    hours: workbook("hours.xlsx", [{
      姓名: "Alice Example",
      手机号: "0400111222",
      课程: "English",
      课时数: 6,
      已消课时: 1,
      剩余课时: 5,
      截止日期: "2026-12-31",
    }, {
      姓名: "Alice Example",
      手机号: "0400111222",
      课程: "Maths",
      课时数: 4,
      已消课时: 1,
      剩余课时: 3,
    }]),
    contracts: workbook("contracts.xlsx", [{
      姓名: "Alice Example",
      手机号: "0400111222",
      课程: "English",
      合约类型: "新签",
      总课时数: 6,
      已消课时: 1,
      剩余课时: 5,
      合约生效日期: "2026-07-01",
    }]),
    ...overrides,
  };
}

test("builds non-billable, active JWB facts and uses the quick list only as a supplement", () => {
  const plan = buildJiaowubaoStaticExportPlan(exportInput());

  assert.equal(plan.summary.activeStudentRows, 1);
  assert.equal(plan.summary.studentFacts, 1);
  assert.equal(plan.summary.verifiedAggregates, 1);
  assert.equal(plan.summary.unlinkedRows, 0);
  assert.equal(plan.students[0].identity.name, "Alice Example");
  assert.equal(plan.students[0].identity.externalStudentNumber, undefined);
  assert.deepEqual(plan.students[0].classes, ["Quick Class", "Student Class"]);
  assert.equal(plan.students[0].alternatePhone, "0400333444");
  assert.deepEqual(plan.students[0].aggregate, {
    totalHours: 10,
    usedHours: 2,
    remainingHours: 8,
    consistency: "verified",
  });
  assert.equal(plan.students[0].hours.length, 2);
  assert.equal(plan.students[0].contracts.length, 1);
});

test("keeps a quick-list row outside the active student snapshot in the review queue", () => {
  const input = exportInput({
    quickList: workbook("quick.xlsx", [{
      姓名: "Not In Student Snapshot",
      手机号: "0400999000",
      学员类型: "在读",
    }]),
  });
  const plan = buildJiaowubaoStaticExportPlan(input);

  assert.equal(plan.students.length, 1);
  assert.deepEqual(plan.unlinked.map((issue) => issue.reason), ["not_in_active_student_snapshot"]);
});

test("does not treat conflicting sparse external IDs as a safe identity merge", () => {
  const input = exportInput({
    contracts: workbook("contracts.xlsx", [{
      姓名: "Alice Example",
      手机号: "0400111222",
      学员编号: "EXT-1",
      课程: "English",
    }]),
    students: workbook("students.xlsx", [{
      姓名: "Alice Example",
      手机号: "0400111222",
      学员编号: "EXT-2",
      学员类型: "在读",
    }]),
  });
  const plan = buildJiaowubaoStaticExportPlan(input);

  assert.deepEqual(plan.unlinked.map((issue) => issue.reason), ["conflicting_external_student_number"]);
  assert.equal(plan.students[0].contracts.length, 0);
});

test("normalises harmless Excel binary-decimal noise but rejects meaningful over-precision", () => {
  const safe = buildJiaowubaoStaticExportPlan(exportInput({
    hours: workbook("hours.xlsx", [{
      姓名: "Alice Example",
      手机号: "0400111222",
      课程: "English",
      课时数: 20,
      已消课时: 14.999999999999996,
      剩余课时: 5,
    }]),
  }));
  assert.equal(safe.students[0].hours[0].usedHours, 15);

  assert.throws(
    () => buildJiaowubaoStaticExportPlan(exportInput({
      hours: workbook("hours.xlsx", [{
        姓名: "Alice Example",
        手机号: "0400111222",
        课程: "English",
        课时数: 20,
        已消课时: 1.0000001,
        剩余课时: 5,
      }]),
    })),
    (error: unknown) => error instanceof JiaowubaoStaticImportError && error.code === "invalid_number",
  );
});

test("only exact names are automatically attachable; parenthetical names remain review candidates", () => {
  const facts = buildJiaowubaoStaticExportPlan(exportInput({
    students: workbook("students.xlsx", [{
      姓名: "Alice Example",
      手机号: "0400111222",
      学员类型: "在读",
    }, {
      姓名: "Anne(VIC)",
      手机号: "0400222333",
      学员类型: "在读",
    }, {
      姓名: "Excluded Learner",
      手机号: "0400444555",
      学员类型: "在读",
    }]),
    quickList: workbook("quick.xlsx", [{
      姓名: "Alice Example", 手机号: "0400111222", 学员类型: "在读",
    }, {
      姓名: "Anne(VIC)", 手机号: "0400222333", 学员类型: "在读",
    }, {
      姓名: "Excluded Learner", 手机号: "0400444555", 学员类型: "在读",
    }]),
  }));
  const result = matchJiaowubaoStaticFactsToMaster([
    { sourceRow: 1, name: "Alice Example", status: "在读" },
    { sourceRow: 2, name: "Anne", status: "在读" },
    { sourceRow: 3, name: "Excluded Learner", status: "不活跃 + 无课时" },
  ], facts.students);

  assert.deepEqual(result.matches.map((entry) => ({ masterSourceRow: entry.masterSourceRow, mode: entry.mode })), [
    { masterSourceRow: 1, mode: "exact_name" },
  ]);
  assert.deepEqual(result.reviewCandidates.map((entry) => ({ masterSourceRow: entry.masterSourceRow, mode: entry.mode })), [
    { masterSourceRow: 2, mode: "reviewed_latin_parenthetical_annotation_v1" },
  ]);
  assert.equal(result.unmatchedMasterSourceRows.length, 0);
  assert.equal(result.unmatchedJwbSourceRows.length, 1);
});

test("uses strict IANA wall-clock conversion and rejects Melbourne DST gaps and repeats", () => {
  assert.equal(
    staticWallClockToInstant("2026-08-18", "09:00", "Australia/Melbourne"),
    "2026-08-17T23:00:00.000Z",
  );
  assert.throws(
    () => staticWallClockToInstant("2026-10-04", "02:30", "Australia/Melbourne"),
    (error: unknown) => error instanceof JiaowubaoStaticImportError && error.code === "invalid_wall_clock",
  );
  assert.throws(
    () => staticWallClockToInstant("2026-04-05", "02:30", "Australia/Melbourne"),
    (error: unknown) => error instanceof JiaowubaoStaticImportError && error.code === "ambiguous_wall_clock",
  );
});
