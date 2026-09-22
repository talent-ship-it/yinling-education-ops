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

/** Undo only the exact successful lock, never a subsequently edited payment. */
export function undoPayrollLocks<Row extends LockablePayrollRow>(
  current: readonly Row[],
  receipts: readonly PayrollLockReceipt<Row>[],
): Row[] {
  const byId = new Map(receipts.map((receipt) => [receipt.after.id, receipt]));
  if (!receipts.length || byId.size !== receipts.length) throw new Error("薪资撤销记录无效，请刷新后重试");
  for (const { before, after } of receipts) {
    const matches = current.filter((row) => row.id === after.id);
    if (before.id !== after.id || matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(after)) {
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
