type LockablePayrollRow = {
  id: string;
  status: string;
  note: string;
  lockedBy?: string;
  lockedAt?: string;
};

export type PayrollLockReceipt<Row extends LockablePayrollRow> = Readonly<{
  before: Row;
  after: Row;
}>;

// jsonb reorders object keys. Compare values rather than transport key order,
// including nested evidence lines returned by the server after the lock.
function snapshot(value: unknown) {
  return JSON.stringify(value, (_key, part) => part && typeof part === "object" && !Array.isArray(part)
    ? Object.fromEntries(Object.entries(part).sort(([left], [right]) => left.localeCompare(right))) : part);
}

/** Undo only the exact successful lock, never a subsequently edited payment. */
export function undoPayrollLocks<Row extends LockablePayrollRow>(
  current: readonly Row[],
  receipts: readonly PayrollLockReceipt<Row>[],
): Row[] {
  const byId = new Map(receipts.map((receipt) => [receipt.after.id, receipt]));
  if (!receipts.length || byId.size !== receipts.length) throw new Error("薪资撤销记录无效，请刷新后重试");
  for (const { before, after } of receipts) {
    const matches = current.filter((row) => row.id === after.id);
    if (before.id !== after.id || matches.length !== 1 || snapshot(matches[0]) !== snapshot(after)) {
      throw new Error("薪资资料已更新，不能撤销旧的锁定；请重新核对当前记录");
    }
  }
  return current.map((row) => {
    const receipt = byId.get(row.id);
    if (!receipt) return row;
    const result = { ...row, status: receipt.before.status, note: receipt.before.note };
    if (receipt.before.lockedBy === undefined) delete result.lockedBy;
    else result.lockedBy = receipt.before.lockedBy;
    if (receipt.before.lockedAt === undefined) delete result.lockedAt;
    else result.lockedAt = receipt.before.lockedAt;
    return result;
  });
}
