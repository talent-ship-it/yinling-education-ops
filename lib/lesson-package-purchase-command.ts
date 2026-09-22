type PurchaseFields = {
  subjectIds: string[];
  purchasedHours: number;
  bonusHours: number;
  purchaseNote: string;
};
export type LessonPackagePurchaseCommand = PurchaseFields & {
  commandKey: string;
  studentId: string;
  purchasedAt: string;
} & ({ packageMode: "existing"; packageId: string } | { packageMode: "new"; newPackageName: string });

export class LessonPackageCommandError extends Error {
  constructor(message: string, readonly code = "invalid_command") { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new LessonPackageCommandError(`${label}无效`);
  return value.trim();
}

export function parseLessonPackagePurchaseCommand(value: unknown): LessonPackagePurchaseCommand {
  if (!record(value)) throw new LessonPackageCommandError("购买命令无效");
  const commandKey = text(value.commandKey, "购买编号");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandKey)) throw new LessonPackageCommandError("购买编号无效");
  const purchasedAt = text(value.purchasedAt, "购买时间");
  if (!Number.isFinite(Date.parse(purchasedAt)) || new Date(purchasedAt).toISOString() !== purchasedAt) throw new LessonPackageCommandError("购买时间无效");
  const hours = (value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new LessonPackageCommandError("购买和赠送课时必须是非负数字");
    if (Number(value.toFixed(6)) !== value) throw new LessonPackageCommandError("课时最多支持六位小数");
    return value;
  };
  const purchasedHours = hours(value.purchasedHours);
  const bonusHours = hours(value.bonusHours);
  if (!Number.isFinite(purchasedHours + bonusHours) || purchasedHours + bonusHours <= 0) throw new LessonPackageCommandError("合计课时必须大于 0");
  if (!Array.isArray(value.subjectIds) || value.subjectIds.length > 100) throw new LessonPackageCommandError("请选择科目");
  const subjectIds = [...new Set(value.subjectIds.map((subject) => text(subject, "科目")))].sort();
  if (!subjectIds.length) throw new LessonPackageCommandError("请选择科目");
  if (value.purchaseNote !== undefined && typeof value.purchaseNote !== "string") throw new LessonPackageCommandError("购买备注无效");
  const purchaseNote = typeof value.purchaseNote === "string" ? value.purchaseNote.trim() : "";
  if (purchaseNote.length > 1000) throw new LessonPackageCommandError("购买备注不能超过 1000 字");
  const common = { commandKey: commandKey.toLowerCase(), studentId: text(value.studentId, "学生编号"), purchasedAt, subjectIds, purchasedHours, bonusHours, purchaseNote };
  if (value.packageMode === "new") return { ...common, packageMode: "new", newPackageName: text(value.newPackageName, "课包名称") };
  if (value.packageMode === "existing") return { ...common, packageMode: "existing", packageId: text(value.packageId, "课包编号") };
  throw new LessonPackageCommandError("请选择课包方式");
}

/** Old browser tabs may still PUT a new random purchase; force them onto the command route. */
export function hasAppendedLessonPackagePurchase(current: unknown, next: unknown) {
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  const keys = (payload: unknown[]) => payload.flatMap((student) => record(student) && Array.isArray(student.lessonPackages)
    ? student.lessonPackages.flatMap((pkg) => record(pkg) && Array.isArray(pkg.purchaseRecords)
      ? pkg.purchaseRecords.filter(record).map((purchase) => JSON.stringify([student.id, pkg.id, purchase.id])) : []) : []);
  const existing = new Set(keys(current));
  return keys(next).some((key) => !existing.has(key));
}

export function lessonPackagePendingKey(actor: string, studentId: string) {
  return `yinling:lesson-package-purchase:v1:${encodeURIComponent(actor)}:${encodeURIComponent(studentId)}`;
}

export const SOURCE_OWNED_PACKAGE_NOTICE = "该课包余额由教务宝同步，请在教务宝充值后同步";

export function assertManualLessonPackageTarget(
  packages: readonly { id: string; subjectIds: readonly string[] }[],
  command: LessonPackagePurchaseCommand,
) {
  const managed = packages.filter((pkg) => pkg.id.startsWith("PKG-JWB-"));
  if (managed.some((pkg) => (command.packageMode === "existing" && command.packageId === pkg.id)
    || pkg.subjectIds.some((subject) => command.subjectIds.includes(subject)))) {
    throw new LessonPackageCommandError(SOURCE_OWNED_PACKAGE_NOTICE, "source_owned_package");
  }
}
