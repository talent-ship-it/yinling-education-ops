import assert from "node:assert/strict";
import test from "node:test";

import {
  currentJiaowubaoPayrollExportEvidence,
  JIAOWUBAO_PAYROLL_SOURCE_VERSION_REVIEW_REASON,
  jiaowubaoPayrollStudentAggregationKey,
  jiaowubaoPayrollSourceVersionIsCurrent,
  overlayPersistedPayrollWithJiaowubaoEvidence,
  payrollLockSnapshotIsCurrent,
  reviewOnlyPersistedPayrollWithJiaowubaoEvidence,
} from "../lib/jiaowubao-completed-lesson-payroll-evidence";

test("export evidence never falls back to persisted source totals or student lines", () => {
  const absent = currentJiaowubaoPayrollExportEvidence<{ studentName: string }>(null);
  assert.equal(absent.sourceHours, null);
  assert.equal(absent.sourceLessonCount, null);
  assert.deepEqual(absent.lines, []);

  const source = {
    summary: { sourceHours: 4.5, sourceLessonCount: 3 },
    lines: [{ studentName: "Current JWB student" }],
  };
  const current = currentJiaowubaoPayrollExportEvidence(source);
  assert.equal(current.sourceHours, 4.5);
  assert.equal(current.sourceLessonCount, 3);
  assert.deepEqual(current.lines, source.lines);
  assert.notEqual(current.lines, source.lines);
  source.lines[0]!.studentName = "Mutated source";
  assert.equal(current.lines[0]?.studentName, "Current JWB student");
});

test("equal hours cannot preserve payment approval across a source or mapping revision change", () => {
  const currentSourceRevision = `sha256:${"b".repeat(64)}`;
  const currentProjectionRevision = `sha256:${"c".repeat(64)}`;
  assert.equal(jiaowubaoPayrollSourceVersionIsCurrent({
    persistedSourceRevision: currentSourceRevision,
    persistedProjectionRevision: currentProjectionRevision,
    currentSourceRevision,
    currentProjectionRevision,
  }), true);

  for (const versions of [
    { persistedSourceRevision: undefined, persistedProjectionRevision: currentProjectionRevision },
    { persistedSourceRevision: currentSourceRevision, persistedProjectionRevision: undefined },
    { persistedSourceRevision: `sha256:${"a".repeat(64)}`, persistedProjectionRevision: currentProjectionRevision },
    { persistedSourceRevision: currentSourceRevision, persistedProjectionRevision: `sha256:${"d".repeat(64)}` },
  ]) {
    assert.equal(jiaowubaoPayrollSourceVersionIsCurrent({
      ...versions,
      currentSourceRevision,
      currentProjectionRevision,
    }), false);
  }

  const persisted = {
    lessons: 4,
    trialLessons: 0,
    teacherTotalHours: 4,
    amount: 400,
    status: "已锁定",
    bankName: "Old bank",
    bankAccount: "9999",
    lockedBy: "Admin",
    lockedAt: "2026-09-01T00:00:00.000Z",
    sourceRevision: `sha256:${"a".repeat(64)}`,
    sourceProjectionRevision: currentProjectionRevision,
    lines: [{ studentName: "Old student", hours: 4 }],
  };
  const source = {
    sourceHours: 4,
    sourceLessonCount: 2,
    sourceNoShowHours: null,
    lines: [{ studentName: "Current student", hours: 4, evidenceOnly: true }],
  };
  const display = reviewOnlyPersistedPayrollWithJiaowubaoEvidence(persisted, source, {
    reviewReason: JIAOWUBAO_PAYROLL_SOURCE_VERSION_REVIEW_REASON,
  });
  assert.equal(display.teacherTotalHours, 0, "same factual hours do not bypass revision review");
  assert.equal(display.amount, 0);
  assert.equal(display.status, "需核对");
  assert.equal(display.bankName, undefined);
  assert.equal(display.lockedBy, undefined);
  assert.deepEqual(display.lines, source.lines);
  assert.match(display.paymentNote, /来源或姓名映射版本已更新/);
});

test("a complete month with no teacher source renders an empty review-only projection", () => {
  const display = reviewOnlyPersistedPayrollWithJiaowubaoEvidence({
    lessons: 3,
    trialLessons: 0,
    teacherTotalHours: 3,
    amount: 300,
    status: "已锁定",
    bankName: "Old bank",
    lines: [{ studentName: "Stale student", hours: 3 }],
  }, {
    sourceHours: null,
    sourceLessonCount: null,
    sourceNoShowHours: null,
    lines: [] as { studentName: string; hours: number }[],
  }, {
    reviewReason: "当前月份没有教务宝来源资料",
  });
  assert.equal(display.amount, 0);
  assert.equal(display.status, "需核对");
  assert.equal(display.bankName, undefined);
  assert.equal(display.sourceHours, null);
  assert.equal(display.sourceLessonCount, null);
  assert.deepEqual(display.lines, []);
});

test("payroll lock confirmation rejects any raw-row change, including same-id amount or revision drift", () => {
  const expected = {
    id: "PAY-1",
    month: "2026-08",
    status: "可审核",
    sourceRevision: `sha256:${"a".repeat(64)}`,
    sourceProjectionRevision: `sha256:${"b".repeat(64)}`,
    amount: 400,
    note: "Reviewed",
  };
  assert.equal(payrollLockSnapshotIsCurrent(expected, expected), true);
  assert.equal(payrollLockSnapshotIsCurrent(undefined, expected), false);
  for (const changed of [
    { ...expected, month: "2026-07" },
    { ...expected, status: "需核对" },
    { ...expected, sourceRevision: `sha256:${"c".repeat(64)}` },
    { ...expected, sourceProjectionRevision: `sha256:${"d".repeat(64)}` },
    { ...expected, amount: 401 },
    { ...expected, note: "Changed after confirmation" },
  ]) {
    assert.equal(payrollLockSnapshotIsCurrent(changed, expected), false);
  }
});

test("shared trial account students group by resolved real name, never the reused member id", () => {
  const base = {
    studentId: null,
    branchId: "branch-1",
    memberId: "trial-b",
  };
  const first = jiaowubaoPayrollStudentAggregationKey({
    ...base,
    displayStudentName: "Frank 徐梓程",
    sourceKey: "jwb-open-api:lesson:branch-1:cal-1:trial-b",
  });
  const second = jiaowubaoPayrollStudentAggregationKey({
    ...base,
    displayStudentName: "Fiona 周雨霏",
    sourceKey: "jwb-open-api:lesson:branch-1:cal-2:trial-b",
  });
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /trial-b/u);
  assert.doesNotMatch(second, /trial-b/u);

  const unresolvedFirst = jiaowubaoPayrollStudentAggregationKey({
    ...base,
    displayStudentName: null,
    sourceKey: "jwb-open-api:lesson:branch-1:cal-3:trial-b",
  });
  const unresolvedSecond = jiaowubaoPayrollStudentAggregationKey({
    ...base,
    displayStudentName: null,
    sourceKey: "jwb-open-api:lesson:branch-1:cal-4:trial-b",
  });
  assert.notEqual(unresolvedFirst, unresolvedSecond);
});

test("current JWB evidence replaces stale display lines without changing saved payroll controls", () => {
  const persisted = {
    lessons: 2,
    trialLessons: 0,
    teacherTotalHours: 2,
    amount: 180,
    rateRange: [90],
    bankName: "Test bank",
    bankAccount: "1234",
    status: "已锁定",
    lines: [{ studentName: "Old student", hours: 2 }],
    lineCount: 1,
  };
  const source = {
    sourceHours: 2,
    sourceLessonCount: 1,
    sourceNoShowHours: null,
    lines: [
      { studentName: "Fiona周雨霏", hours: 1, evidenceOnly: true },
      { studentName: "Rita Wu", hours: 1, evidenceOnly: true },
    ],
  };

  const display = overlayPersistedPayrollWithJiaowubaoEvidence(persisted, source);
  assert.deepEqual(display.lines.map((line) => line.studentName), ["Fiona周雨霏", "Rita Wu"]);
  assert.equal(display.lineCount, 2);
  assert.equal(display.sourceHours, 2);
  assert.equal(display.hourVariance, 0);
  assert.equal(display.amount, 180);
  assert.deepEqual(display.rateRange, [90]);
  assert.equal(display.bankName, "Test bank");
  assert.equal(display.status, "已锁定");

  source.lines[0]!.studentName = "Mutated source";
  assert.equal(display.lines[0]?.studentName, "Fiona周雨霏");
});

test("unresolved source hours remain null rather than becoming a false zero variance", () => {
  const display = overlayPersistedPayrollWithJiaowubaoEvidence(
    { lessons: 3, trialLessons: 0, teacherTotalHours: 3, lines: [] as { studentName: string }[] },
    { sourceHours: null, sourceLessonCount: 2, sourceNoShowHours: null, lines: [] as { studentName: string }[] },
  );
  assert.equal(display.sourceHours, null);
  assert.equal(display.hourVariance, null);
});

test("unsafe current evidence strips every saved payment instruction from the derived row", () => {
  const persisted = {
    id: "PAY-1",
    lessons: 8,
    trialLessons: 1,
    teacherTotalHours: 9,
    amount: 900,
    teacherTotalAmount: 900,
    lineAmount: 900,
    rateRange: [100],
    status: "已锁定",
    note: "Old approved payroll",
    paymentNote: "Pay immediately",
    bankName: "Saved bank",
    bankAccount: "9999",
    lockedBy: "Admin",
    lockedAt: "2026-09-01T00:00:00.000Z",
    lines: [{ studentName: "Old student", hours: 9 }],
    lineCount: 1,
  };
  const source = {
    sourceHours: 9,
    sourceLessonCount: 2,
    sourceNoShowHours: null,
    lines: [{ studentName: "试听学员 A（待匹配）", hours: 1, evidenceOnly: true }],
  };

  const display = reviewOnlyPersistedPayrollWithJiaowubaoEvidence(
    persisted,
    source,
    { reviewReason: "学生姓名待匹配" },
  );

  assert.equal(display.lessons, 0);
  assert.equal(display.trialLessons, 0);
  assert.equal(display.teacherTotalHours, 0);
  assert.equal(display.amount, 0);
  assert.equal(display.teacherTotalAmount, 0);
  assert.equal(display.lineAmount, undefined);
  assert.deepEqual(display.rateRange, []);
  assert.equal(display.status, "需核对");
  assert.equal(display.sourceHours, 9);
  assert.equal(display.sourceLessonCount, 2);
  assert.equal(display.hourVariance, null);
  assert.equal(display.bankName, undefined);
  assert.equal(display.bankAccount, undefined);
  assert.equal(display.lockedBy, undefined);
  assert.equal(display.lockedAt, undefined);
  assert.match(display.paymentNote, /学生姓名待匹配/);
  assert.match(display.paymentNote, /不会写入薪资或付款资料/);
  assert.deepEqual(display.lines, source.lines);
  assert.notEqual(display.lines, source.lines);

  assert.equal(persisted.amount, 900);
  assert.equal(persisted.bankAccount, "9999");
  assert.equal(persisted.status, "已锁定");
  assert.equal(persisted.lines[0]?.studentName, "Old student");
});
