import assert from "node:assert/strict";
import test from "node:test";
import { undoPayrollLocks } from "../lib/payroll-lock-undo";

const before = { id: "payroll-a", status: "可审核", note: "reviewed", amount: 100, rate: 50 };
const after = { ...before, status: "已锁定", note: "reviewed；已锁定", lockedBy: "Admin", lockedAt: "2026-09-22T00:00:00.000Z" };
const receipt = { before, after };

test("undo follows a stable row ID after reordering and preserves unrelated rows", () => {
  const unrelated = { ...before, id: "payroll-b", amount: 250 };
  assert.deepEqual(undoPayrollLocks([unrelated, after], [receipt]), [unrelated, before]);
});

test("a stale undo cannot overwrite financial or review changes", () => {
  for (const change of [{ amount: 200 }, { rate: 100 }, { note: "new review" }, { lockedBy: "Another admin" }]) {
    const current = [{ ...after, ...change }];
    assert.throws(() => undoPayrollLocks(current, [receipt]), /已更新/);
    assert.deepEqual(current[0], { ...after, ...change });
  }
});

test("batch undo is all-or-nothing when any row changed, vanished, or has duplicate IDs", () => {
  const second = { before: { ...before, id: "payroll-b" }, after: { ...after, id: "payroll-b" } };
  for (const current of [[after], [after, { ...second.after, amount: 500 }], [after, after, second.after]]) {
    assert.throws(() => undoPayrollLocks(current, [receipt, second]), /已更新/);
    assert.equal(current[0]?.status, "已锁定");
  }
});
