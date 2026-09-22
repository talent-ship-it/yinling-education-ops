import { createHash } from "node:crypto";
import { buildOpsAccessContext, canOperateStudent, canWriteOpsEntity, filterOpsStateRows, getAccessScopeVersions } from "./ops-access";
import { assertOpsStateTransition } from "./ops-state-transition";
import type { OpsStateRow } from "./ops-store";
import { assertManualLessonPackageTarget, LessonPackageCommandError, type LessonPackagePurchaseCommand } from "./lesson-package-purchase-command";
import { addLessonPackageHours, bindSubjectToLessonPackage, createStudentLessonPackage, type StudentLessonPackage } from "./student-records";

function purchaseIdentity(command: LessonPackagePurchaseCommand, actor: string) {
  const purchasePrefix = `PUR-${command.commandKey}:`;
  const purchaseId = purchasePrefix + createHash("sha256").update(JSON.stringify({ actor, ...command })).digest("hex");
  return { purchasePrefix, purchaseId };
}

function purchaseReceipt(payload: unknown, command: LessonPackagePurchaseCommand, actor: string) {
  const { purchasePrefix, purchaseId } = purchaseIdentity(command, actor);
  const receipts = (Array.isArray(payload) ? payload : []).flatMap((student) => Array.isArray(student?.lessonPackages)
    ? student.lessonPackages.flatMap((pkg: StudentLessonPackage) => (Array.isArray(pkg?.purchaseRecords) ? pkg.purchaseRecords : [])
      .filter((purchase) => typeof purchase?.id === "string" && purchase.id.startsWith(purchasePrefix))) : []);
  if (receipts.length) {
    return receipts.length === 1 && receipts[0].id === purchaseId ? "match" : "conflict";
  }
  return "missing";
}

/** Keep the deployed purchase shape: the immutable ID carries UUID + SHA-256 intent. */
export function prepareLessonPackagePurchase(payload: unknown, command: LessonPackagePurchaseCommand, actor: string) {
  if (!Array.isArray(payload) || payload.some((student) => !student || typeof student !== "object" || Array.isArray(student))) throw new LessonPackageCommandError("学生资料尚未就绪");
  const students = payload as Record<string, unknown>[];
  const receipt = purchaseReceipt(payload, command, actor);
  if (receipt === "match") return { payload: students, applied: false };
  if (receipt === "conflict") throw new LessonPackageCommandError("此购买编号已用于不同内容，请核对原购买记录", "idempotency_conflict");
  const { purchaseId } = purchaseIdentity(command, actor);
  const matches = students.filter((student) => student.id === command.studentId);
  if (matches.length !== 1) throw new LessonPackageCommandError("学生资料已变化，请刷新后重试", "invalid_target");
  const target = matches[0];
  let packages = [...((target.lessonPackages ?? []) as StudentLessonPackage[])];
  assertManualLessonPackageTarget(packages, command);
  const packageId = command.packageMode === "new" ? `PKG-${command.commandKey}` : command.packageId;
  const purchase = { id: purchaseId, purchasedAt: command.purchasedAt, hours: Number((command.purchasedHours + command.bonusHours).toFixed(6)), purchasedHours: command.purchasedHours, bonusHours: command.bonusHours, note: command.purchaseNote };
  if (command.packageMode === "new") {
    if (packages.some((pkg) => pkg.id === packageId)) throw new LessonPackageCommandError("课包编号已存在", "idempotency_conflict");
    packages.push(createStudentLessonPackage({ id: packageId, name: command.newPackageName, subjectIds: command.subjectIds, initialPurchase: purchase }));
  } else {
    if (packages.filter((pkg) => pkg.id === packageId).length !== 1) throw new LessonPackageCommandError("所选课包不存在，请刷新后重试", "invalid_target");
    packages = packages.map((pkg) => pkg.id === packageId ? addLessonPackageHours(pkg, purchase) : pkg);
  }
  for (const subjectId of command.subjectIds) packages = bindSubjectToLessonPackage(packages, packageId, subjectId);
  return { payload: students.map((student) => student === target ? { ...student, lessonPackages: packages } : student), applied: true };
}

type PurchaseStore = {
  read: () => Promise<OpsStateRow[]>;
  write: (input: { entity: string; payload: unknown; expectedVersion: number; actor: string; scopeVersions: Record<string, number> | null }) => Promise<OpsStateRow[]>;
};

export async function commitLessonPackagePurchase(input: {
  command: LessonPackagePurchaseCommand;
  actor: string;
  fullAdmin: boolean;
  identity: Parameters<typeof buildOpsAccessContext>[3];
  store: PurchaseStore;
}) {
  const { command, actor, fullAdmin, identity, store } = input;
  for (let attempt = 0; ; attempt += 1) {
    const rows = await store.read();
    const current = rows.find((row) => row.entity === "students");
    if (!current) throw new Error("学生资料尚未就绪");
    const access = buildOpsAccessContext(rows, actor, fullAdmin, identity);
    const mayWrite = !access.teacher && canWriteOpsEntity(access, "students") && canOperateStudent(access, command.studentId);
    if (!mayWrite) {
      // Only an exact actor-owned receipt is readable after scope drift. Do
      // not inspect target/package validity or reveal another student's data.
      if (purchaseReceipt(current.payload, command, actor) === "match") return {
        committed: true, applied: false, commandKey: command.commandKey, studentRow: undefined,
      };
      throw new LessonPackageCommandError("当前账号不能为该学生录入课包购买", "scope_forbidden");
    }
    let prepared: ReturnType<typeof prepareLessonPackagePurchase>;
    try {
      prepared = prepareLessonPackagePurchase(current.payload, command, actor);
    } catch (error) {
      if (error instanceof LessonPackageCommandError) throw error;
      // Domain validation (for example rebinding a package with remaining
      // credit) runs before the store is called and can safely return to edit.
      throw new LessonPackageCommandError(error instanceof Error ? error.message : "课包资料无效");
    }
    // The immutable receipt can acknowledge an old success after scope drift,
    // while returning no historic state to an actor who lost that permission.
    if (!prepared.applied) return {
      committed: true, applied: false, commandKey: command.commandKey,
      studentRow: filterOpsStateRows([current], access)[0],
    };
    assertOpsStateTransition({ entity: "students", currentPayload: current.payload, nextPayload: prepared.payload, rows, context: access });
    try {
      const saved = await store.write({ entity: "students", payload: prepared.payload, expectedVersion: current.version, actor, scopeVersions: getAccessScopeVersions(rows, access) });
      if (!saved[0]) throw new Error("购买没有返回完整的保存结果");
      return { committed: true, applied: true, commandKey: command.commandKey, studentRow: filterOpsStateRows(saved, access)[0] };
    } catch (error) {
      // A rival request may already have committed this exact command. Retry
      // from authoritative state rather than replaying a stale payload.
      if (error && typeof error === "object" && "code" in error && error.code === "40001" && attempt < 2) continue;
      throw error;
    }
  }
}
