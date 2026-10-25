import test from "node:test";
import assert from "node:assert/strict";
import { planTencentLpFieldMerge, type TencentLpBaseline } from "../lib/tencent-lp-source-merge";
import { matchTencentLpSourceRecords, TENCENT_LP_SOURCE_HEADERS } from "../lib/tencent-lp-source";
const initial: TencentLpBaseline = { field: "planner", revision: 0, initialized: false, commonValue: null, pending: null };
const saved = { ...initial, revision: 4, initialized: true, commonValue: "Tara" };
for (const [description, source, system, baseline, action] of [
  ["first Tencent value wins", "Eileen", "Abby", initial, "import"],
  ["first missing Tencent value retains and exports local", null, "Abby", initial, "export"],
  ["both missing initialize without mutation", null, null, initial, "observe"],
  ["only Tencent changed", "Eileen", "Tara", saved, "import"],
  ["only system changed", "Tara", "Abby", saved, "export"],
  ["conflicting changes favor Tencent", "Eileen", "Abby", saved, "import"],
  ["identical concurrent edits converge", "Abby", "Abby", saved, "observe"],
  ["unchanged converged values stay stable", "Tara", "Tara", saved, "observe"],
  ["blank Tencent does not clear system", null, "Tara", saved, "skip"],
  ["null local does not clear Tencent", "Tara", null, saved, "skip"],
  ["false Tencent is an explicit value", false, true, { ...initial, field: "trialPaid" }, "import"],
  ["false local is exported", null, false, { ...initial, field: "trialPaid" }, "export"],
] as const) test(description, () => assert.equal(planTencentLpFieldMerge(source, system, baseline), action));
for (const [source, system, phase, action] of [
  ["Abby", "Eileen", "attempted", "recover"],
  ["Eileen", "Abby", "attempted", "import"],
  ["Tara", "Abby", "attempted", "uncertain"],
  [null, "Abby", "attempted", "uncertain"],
  ["Tara", "Abby", "planned", "cancel"],
] as const) test(`pending ${phase} ${String(source)} -> ${action}`, () => {
  assert.equal(planTencentLpFieldMerge(source, system, { ...saved, pending: { before: "Tara", target: "Abby", phase } }), action);
});
test("cycling local values are detected against the last converged value", () => {
  assert.equal(planTencentLpFieldMerge("Abby", "Tara", { ...saved, commonValue: "Abby" }), "export");
});
test("row reorder preserves strong identity material and distinct request clocks remain distinct", () => {
  const header = TENCENT_LP_SOURCE_HEADERS.map((string_value, col) => ({ row: 0, col, string_value, value_type: "STRING" }));
  const cells = Object.entries({ 0: "Synthetic Child", 1: "Parent", 3: "试听", 4: "2026-10-22T17:47:00+08:00", 9: "Tara龙" })
    .map(([col, string_value]) => ({ row: 1, col: Number(col), string_value, value_type: "STRING" }));
  const lp = { id: "LP-1", studentId: "S-1", workflowType: "试听 LP", trialIntake: { requestSentAt: "2026-10-22T09:47:00Z" } };
  const input = { lpItems: [lp], students: [{ id: "S-1", name: "Synthetic Child", guardianWechat: "Parent" }] };
  const first = matchTencentLpSourceRecords({ ...input, cells: [...header, ...cells] }).records[0]!;
  const moved = matchTencentLpSourceRecords({ ...input, cells: [...header, ...cells.map((cell) => ({ ...cell, row: 4 }))] }).records[0]!;
  assert.equal(first.identityKey, moved.identityKey); assert.equal(moved.sourceRow, 4);
  assert.equal(first.fields.find((field) => field.field === "planner")?.source, "Tara");
  assert.equal(matchTencentLpSourceRecords({ ...input, cells: [...header, ...cells, ...cells.map((cell) => ({ ...cell, row: 4 }))] }).records.length, 0);
});

const noteBaseline: TencentLpBaseline = { field: "trialLedgerNote", revision: 2, initialized: true, commonValue: "Common note", pending: null };
for (const [description, source, system, action] of [
  ["system note clear", "Common note", null, "export"],
  ["Tencent note clear", null, "Common note", "import"],
  ["Tencent clear beats conflicting local edit", null, "Local edit", "import"],
  ["Tencent edit beats conflicting local clear", "Tencent edit", null, "import"],
  ["both cleared notes converge", null, null, "observe"],
] as const) test(description, () => assert.equal(planTencentLpFieldMerge(source, system, noteBaseline), action));
for (const [description, source, system, action] of [
  ["first empty Tencent note preserves local text", null, "Local note", "export"],
  ["first empty system note preserves Tencent text", "Tencent note", null, "import"],
  ["first empty notes only establish a baseline", null, null, "observe"],
] as const) test(description, () => assert.equal(planTencentLpFieldMerge(source, system, { ...noteBaseline, initialized: false }), action));
for (const [description, source, system, target, action] of [
  ["confirmed pending clear preserves new system D", null, "New system D", null, "recover"],
  ["unknown unobserved clear is never replayed", "Common note", null, null, "uncertain"],
  ["new Tencent text after unknown clear wins", "New Tencent F", null, null, "import"],
  ["Tencent clear after unknown text export wins", null, "Local text", "Local text", "import"],
] as const) test(description, () => assert.equal(planTencentLpFieldMerge(source, system, { ...noteBaseline,
  pending: { before: "Common note", target, phase: "attempted" } }), action));
for (const field of ["planner", "resultStatus", "lpFinalized", "trialPaid"]) test(`${field} never gains blank-clearing semantics`, () => {
  const baseline = { ...noteBaseline, field, commonValue: "Existing" };
  assert.equal(planTencentLpFieldMerge(null, "Existing", baseline), "skip");
  assert.equal(planTencentLpFieldMerge("Existing", null, baseline), "skip");
});
