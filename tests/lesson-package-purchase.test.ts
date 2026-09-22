import assert from "node:assert/strict";
import test from "node:test";
import { hasAppendedLessonPackagePurchase, parseLessonPackagePurchaseCommand } from "../lib/lesson-package-purchase-command";
import { commitLessonPackagePurchase, prepareLessonPackagePurchase } from "../lib/lesson-package-purchase-service";
import { getLessonPackageBalance, type StudentLessonPackage } from "../lib/student-records";
import type { OpsStateRow } from "../lib/ops-store";
import { buildStudentImportPlan } from "../lib/student-import";

const command = parseLessonPackagePurchaseCommand({ commandKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", studentId: "s1", purchasedAt: "2026-09-22T00:00:00.000Z", packageMode: "new", newPackageName: "English", subjectIds: ["English"], purchasedHours: 10, bonusHours: 2 });
const initial = [{ id: "s1", name: "Student", owner: "Abby", lessonPackages: [] as StudentLessonPackage[] }];
function fixture() {
  let row: OpsStateRow = { entity: "students", version: 1, payload: structuredClone(initial), updated_at: command.purchasedAt, updated_by: "Nixon" };
  let writes = 0;
  let loseNextResponse = false;
  const store = {
    read: async () => [structuredClone(row)],
    write: async (input: { payload: unknown; expectedVersion: number }) => {
      if (input.expectedVersion !== row.version) throw Object.assign(new Error("version_conflict"), { code: "40001" });
      row = { ...row, payload: structuredClone(input.payload), version: row.version + 1 };
      writes += 1;
      if (loseNextResponse) { loseNextResponse = false; throw new Error("response lost after commit"); }
      return [structuredClone(row)];
    },
  };
  return {
    store, get row() { return row; }, get writes() { return writes; },
    loseResponse() { loseNextResponse = true; },
    run: (next = command) => commitLessonPackagePurchase({ command: next, actor: "Nixon", fullAdmin: true, identity: "admin", store }),
  };
}
const packages = (payload: unknown) => (payload as typeof initial)[0].lessonPackages;

test("simultaneous identical purchase requests credit hours once under compare-and-swap", async () => {
  const db = fixture();
  const results = await Promise.all([db.run(), db.run(), db.run()]);
  assert.equal(db.writes, 1);
  assert.deepEqual(results.map((result) => result.applied).sort(), [false, false, true]);
  assert.equal(getLessonPackageBalance(packages(db.row.payload)[0]).totalHours, 12);
});

test("reload and retry after a lost success response returns the same durable receipt", async () => {
  const db = fixture();
  db.loseResponse();
  await assert.rejects(db.run(), /response lost/);
  const restored = parseLessonPackagePurchaseCommand(JSON.parse(JSON.stringify(command)));
  assert.equal((await db.run(restored)).applied, false);
  assert.equal(db.writes, 1);
  assert.equal(packages(db.row.payload)[0].purchaseRecords.length, 1);
});

test("distinct simultaneous top-ups merge fresh state without losing either purchase", async () => {
  const db = fixture();
  await db.run();
  const topup = { ...command, packageMode: "existing", packageId: `PKG-${command.commandKey}`, purchasedHours: 5, bonusHours: 0 };
  await Promise.all([
    db.run(parseLessonPackagePurchaseCommand({ ...topup, commandKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })),
    db.run(parseLessonPackagePurchaseCommand({ ...topup, commandKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })),
  ]);
  assert.equal(getLessonPackageBalance(packages(db.row.payload)[0]).totalHours, 22);
  assert.equal(packages(db.row.payload)[0].purchaseRecords.length, 3);
});

test("a used command cannot be changed to another amount, student, subject, or actor", async () => {
  const db = fixture();
  await db.run();
  for (const change of [{ purchasedHours: 20 }, { studentId: "another" }, { subjectIds: ["Maths"] }]) {
    assert.throws(() => prepareLessonPackagePurchase(db.row.payload, parseLessonPackagePurchaseCommand({ ...command, ...change }), "Nixon"), /不同内容/);
  }
  assert.throws(() => prepareLessonPackagePurchase(db.row.payload, command, "Abby"), /不同内容/);
  assert.equal(db.writes, 1);
});

test("replay never reapplies later subject changes and generic writes cannot add purchases", async () => {
  const db = fixture();
  await db.run();
  const later = structuredClone(db.row.payload) as typeof initial;
  later[0].lessonPackages[0].subjectIds = ["Another subject"];
  assert.deepEqual(prepareLessonPackagePurchase(later, command, "Nixon").payload, later);
  assert.equal(hasAppendedLessonPackagePurchase(initial, db.row.payload), true);
  assert.equal(hasAppendedLessonPackagePurchase(db.row.payload, later), false);
});

test("receipt stays within the deployed import purchase shape and microhour precision", () => {
  const decimal = parseLessonPackagePurchaseCommand({ ...command, purchasedHours: 0.1, bonusHours: 0.2 });
  const purchase = packages(prepareLessonPackagePurchase(initial, decimal, "Nixon").payload)[0].purchaseRecords[0];
  assert.deepEqual(Object.keys(purchase).sort(), ["bonusHours", "hours", "id", "note", "purchasedAt", "purchasedHours"]);
  assert.ok(purchase.id.length <= 240);
  assert.equal(purchase.hours, 0.3);
  assert.throws(() => parseLessonPackagePurchaseCommand({ ...command, bonusHours: 0.0000001 }), /六位/);
  assert.throws(() => parseLessonPackagePurchaseCommand({ ...command, purchaseNote: "n".repeat(1001) }), /1000/);
});

test("teacher and out-of-scope accounts cannot credit hours; scope drift replay returns receipt only", async () => {
  const db = fixture();
  for (const identity of ["teacher", "staff"] as const) {
    await assert.rejects(commitLessonPackagePurchase({ command, actor: "Someone else", fullAdmin: false, identity, store: db.store }), /不能/);
  }
  assert.equal(db.writes, 0);
  await db.run();
  const replay = await commitLessonPackagePurchase({ command, actor: "Nixon", fullAdmin: false, identity: "teacher", store: db.store });
  assert.equal(replay.applied, false);
  assert.equal(replay.studentRow, undefined);
});

test("source-owned packages and parallel manual replacements cannot receive a local top-up", () => {
  const managed = [{ ...initial[0], lessonPackages: [{ id: "PKG-JWB-source", name: "JWB English", subjectIds: ["English"], purchaseRecords: [], consumedHours: 0 }] }];
  for (const next of [command, parseLessonPackagePurchaseCommand({ ...command, packageMode: "existing", packageId: "PKG-JWB-source" })]) {
    assert.throws(() => prepareLessonPackagePurchase(managed, next, "Nixon"), /请在教务宝充值后同步/);
  }
});

test("JWB refresh preserves a manual purchase receipt so response-loss replay cannot recharge it", () => {
  const masterRows = [{ sourceRow: 1, name: "Student", status: "在读" }];
  const first = buildStudentImportPlan({ masterRows, jwbRows: [] });
  const purchaseCommand = parseLessonPackagePurchaseCommand({ ...command, studentId: first.students[0].id });
  const purchased = prepareLessonPackagePurchase(first.students, purchaseCommand, "Nixon");
  const refreshed = buildStudentImportPlan({ masterRows, existingStudents: purchased.payload as unknown as typeof first.students, jwbRows: [{
    sourceRow: 1, name: "Student", remainingHours: 5, contractHours: 5,
    packageCoverage: "complete", lessonPackages: [{ sourcePackageId: "maths", name: "Maths", subjectIds: ["Maths"], purchaseRecords: [{ sourcePurchaseId: "jwb-1", purchasedAt: "2026-09-21", hours: 5 }], consumedHours: 0 }],
  }] });
  const replay = prepareLessonPackagePurchase(refreshed.students, purchaseCommand, "Nixon");
  assert.equal(replay.applied, false);
  assert.deepEqual(refreshed.students[0].lessonPackages?.find((pkg) => pkg.id === `PKG-${command.commandKey}`), packages(purchased.payload)[0]);
});
