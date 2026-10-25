import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as source from "../lib/tencent-lp-source.ts";
import * as merge from "../lib/tencent-lp-source-merge.ts";
import * as ledger from "../lib/trial-ledger.ts";
const require = createRequire(import.meta.url);
function load(file, dependencies) {
  const compiled = ts.transpileModule(readFileSync(new URL(`../lib/${file}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiledModule = { exports: {} };
  vm.runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports, Buffer, Date, require(name) {
    if (!dependencies.has(name)) throw new Error(`Unexpected import: ${name}`);
    return dependencies.get(name);
  } });
  return compiledModule.exports;
}
function initialCells() {
  const header = source.TENCENT_LP_SOURCE_HEADERS.map((string_value, col) => ({ row: 0, col, value_type: "STRING", string_value }));
  return [...header, ...Object.entries({ 0: "Alex Synthetic", 1: "Parent Synthetic", 3: "试听", 4: "10月22日17:47", 9: "Eileen校长号" })
    .map(([col, string_value]) => ({ row: 1, col: Number(col), value_type: "STRING", string_value }))];
}
function initialRows(version = 1) {
  return [{ entity: "students", version: 1, payload: [{ id: "S-1", name: "Alex Synthetic", guardianWechat: "Parent Synthetic" }] },
    { entity: "lpItems", version, payload: [{ id: "LP-1", studentId: "S-1", workflowType: "试听 LP",
      trialIntake: { requestSentAt: "2026-10-22T09:47:00Z", planner: "Tara", studentName: "Alex Synthetic" } }] }];
}
function setLocal(state, field, value) {
  const item = state.rows[1].payload[0];
  if (field === "planner") item.trialLedgerOverrides = { planner: value };
  else item[field === "lpFinalized" ? "trialLpFinalized" : field] = value;
  state.rows[1].version += 1;
}
function setSource(state, col, value, row = 1) {
  state.cells = state.cells.filter((cell) => cell.row !== row || cell.col !== col);
  state.cells.push({ row, col, value_type: typeof value === "boolean" ? "BOOL" : "STRING", bool_value: value, string_value: value });
}
function baseline(state, args) {
  return state.baselines.get(args.field) ?? { field: args.field, revision: 0, commonValue: null, initialized: false, pending: null };
}
function requireLocal(state, args) {
  if (state.options.conflict) throw new Error("trial_ledger_field_conflict");
  const value = ledger.trialLedgerStoredValue(state.rows[1].payload[0], args.field) ?? null;
  assert.equal(value, args.expectedSystem, "field OCC"); assert.equal(state.rows[1].version, args.expectedLpVersion, "identity/version OCC");
}
function saveBaseline(state, args, value) {
  const result = { ...value, revision: value.revision + 1, lpVersion: state.options.badVersion ? undefined : state.rows[1].version };
  state.baselines.set(args.field, result); return result;
}
function importValue(state, args, saved) {
  requireLocal(state, args); state.writes.push({ ...args, actor: "Tencent LP Source Worker" });
  if (state.options.badReceipt) return {};
  setLocal(state, args.field, args.value);
  return saveBaseline(state, args, { ...saved, initialized: true, commonValue: args.value, pending: null });
}
function observeValue(state, args, saved) {
  requireLocal(state, args);
  return saveBaseline(state, args, { ...saved, initialized: true, commonValue: args.value });
}
function stageValue(state, args, saved) {
  requireLocal(state, args);
  return saveBaseline(state, args, { ...saved, pending: { before: args.before, target: args.value, phase: "planned" } });
}
function attemptValue(state, args, saved) {
  requireLocal(state, args);
  return saveBaseline(state, args, { ...saved, pending: { ...saved.pending, phase: "attempted" } });
}
function completeValue(state, args, saved) {
  assert.equal(saved.pending.target, args.value);
  return saveBaseline(state, args, { ...saved, commonValue: saved.pending.target, initialized: true, pending: null });
}
const actions = { import: importValue, observe: observeValue, stage: stageValue, attempt: attemptValue,
  complete: completeValue, cancel: (state, args, saved) => saveBaseline(state, args, { ...saved, pending: null }) };
const controls = { claim: (state) => state.options.claimReceipt ?? ({ claimed: true }), release: () => ({ released: true }), read: (state) => ({ fields: [...state.baselines.values()] }) };
async function stateAction(state, input) {
  if (controls[input.action]) return controls[input.action](state);
  const args = input.args ?? {};
  const saved = baseline(state, args); assert.equal(saved.revision, args.revision, "baseline CAS");
  return actions[input.action](state, args, saved);
}
function changeRead(state, input) {
  const pass = state.calls.filter((call) => call.name === "sheet.get_sheet_info").length;
  if (state.options.changed && pass === 2) setSource(state, 9, "Abby校长号");
  state.beforeRead?.(input);
}
function readPage(state, input) {
  changeRead(state, input);
  const result = state.cells.filter((cell) => cell.row >= input.arguments.start_row && cell.row <= input.arguments.end_row).map((cell) => ({ ...cell }));
  if (state.options.badPage && input.arguments.start_row === 100) result.push({ row: 0, col: 0, value_type: "STRING", string_value: "bad" });
  return { cells: result };
}
function outboundValue(args) { return args.value_type === "BOOL" ? args.bool_value : args.string_value; }
async function writeCell(state, input) {
  state.externalWrites.push(input);
  if (state.options.unknownBefore) throw new Error("request_timeout");
  const args = input.arguments;
  setSource(state, args.col, outboundValue(args), args.row);
  state.afterWrite?.(input);
  if (state.options.unknownAfter) throw new Error("request_timeout");
  return {};
}
async function sourceTool(state, input) {
  state.calls.push(input);
  if (input.name === "sheet.get_sheet_info") return { sheets: [{ sheet_id: source.TENCENT_LP_SOURCE_SHEET_ID,
    sheet_type: state.options.badSheet ? "smartsheet" : "worksheet", row_count: 101 }] };
  if (input.name === "sheet.set_cell_value") return writeCell(state, input);
  return readPage(state, input);
}
function fixture(options = {}) {
  const state = { options, cells: initialCells(), rows: initialRows(options.version), baselines: new Map(), calls: [], writes: [], externalWrites: [] };
  const modules = new Map([["server-only", {}], ["node:crypto", require("node:crypto")], ["./tencent-lp-source", source],
    ["./tencent-lp-source-merge", merge], ["./trial-ledger", ledger],
    ["./tencent-docs-smartsheet", { callTencentDocsTool: (input) => sourceTool(state, input) }],
    ["./ops-store", { getOpsState: async () => structuredClone(state.rows), tencentLpSourceSyncAction: (input) => stateAction(state, input) }]]);
  modules.set("./tencent-lp-source-io", load("tencent-lp-source-io", modules));
  const service = load("tencent-lp-source-sync", modules);
  return { ...state, state, run: () => service.runTencentLpSourceSync("synthetic-token") };
}
function stored(state, field = "planner") { return ledger.trialLedgerStoredValue(state.rows[1].payload[0], field) ?? null; }

test("reads every page twice then imports original Tencent values with a scoped receipt", async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(f.calls.slice(0, 6).filter((call) => call.name === "sheet.get_sheet_info").length, 2);
  assert.equal(f.writes.length, 1); assert.equal(result.appliedCount, 1); assert.equal(result.matchedCount, 1);
  assert.equal(f.writes[0].field, "planner"); assert.equal(f.writes[0].value, "Eileen"); assert.equal(f.writes[0].actor, "Tencent LP Source Worker");
  assert.equal(f.externalWrites.length, 0); assert.equal(f.rows[1].payload[0].trialIntake.requestSentAt, "2026-10-22T09:47:00Z");
});
test("source changes during pagination and invalid pages fail before all writes", async () => {
  for (const options of [{ changed: true }, { badSheet: true }, { badPage: true }]) {
    const f = fixture(options); await assert.rejects(f.run(), /source_(?:changed|sheet|page)/u); assert.equal(f.writes.length, 0); assert.equal(f.externalWrites.length, 0);
  }
});
test("local edits cycle through fresh durable baselines without repeated imports", async () => {
  const f = fixture(); await f.run(); const firstRevision = f.baselines.get("planner").revision;
  setLocal(f.state, "planner", "Abby"); await f.run(); setLocal(f.state, "planner", "Eileen"); await f.run();
  assert.equal(f.writes.length, 1); assert.equal(f.externalWrites.length, 2);
  assert.equal(f.externalWrites[0].arguments.string_value, "Abby校长号"); assert.equal(f.externalWrites[1].arguments.string_value, "Eileen校长号");
  assert.ok(f.baselines.get("planner").revision > firstRevision);
});
test("field OCC conflicts and incomplete receipts are never reported as successful sync", async () => {
  for (const options of [{ conflict: true }, { badReceipt: true }, { badVersion: true }]) {
    const f = fixture(options); await assert.rejects(f.run(), /conflict|state_invalid|state_unavailable|baseline_invalid/u); assert.equal(f.externalWrites.length, 0);
  }
});
test("concurrent conflicting changes import Tencent and never overwrite it", async () => {
  const f = fixture(); await f.run(); setLocal(f.state, "planner", "Abby"); setSource(f.state, 9, "Tara龙");
  await f.run(); assert.equal(stored(f.state), "Tara"); assert.equal(f.externalWrites.length, 0);
});
test("a successful outbound C preserves newer system D and exports D next round", async () => {
  const f = fixture(); await f.run(); setLocal(f.state, "planner", "Abby");
  f.state.afterWrite = () => setLocal(f.state, "planner", "Tara"); await f.run();
  assert.equal(stored(f.state), "Tara"); assert.equal(f.baselines.get("planner").commonValue, "Abby");
  f.state.afterWrite = undefined; await f.run(); assert.equal(f.externalWrites.at(-1).arguments.string_value, "Tara龙");
});
test("Tencent F arriving during an outbound write wins on the next observed merge", async () => {
  const f = fixture(); await f.run(); setLocal(f.state, "planner", "Abby");
  f.state.afterWrite = () => setSource(f.state, 9, "Tara龙"); await f.run();
  f.state.afterWrite = undefined; await f.run(); assert.equal(stored(f.state), "Tara"); assert.equal(f.externalWrites.length, 1);
});
test("lost outbound response is reconciled by readback without repeating the write", async () => {
  const f = fixture(); await f.run(); setLocal(f.state, "planner", "Abby"); f.options.unknownAfter = true;
  await f.run(); await f.run(); assert.equal(f.externalWrites.length, 1); assert.equal(f.baselines.get("planner").pending, null);
});
test("an unknown unobserved write remains pending and never blindly replays", async () => {
  const f = fixture(); await f.run(); setLocal(f.state, "planner", "Abby"); f.options.unknownBefore = true;
  assert.equal((await f.run()).uncertainCount, 1); assert.equal((await f.run()).uncertainCount, 1); assert.equal(f.externalWrites.length, 1);
});
test("reordering rows between rounds follows identity rather than old row numbers", async () => {
  const f = fixture(); await f.run(); setLocal(f.state, "planner", "Abby");
  f.state.cells = f.state.cells.map((cell) => ({ ...cell, row: cell.row === 1 ? 4 : cell.row }));
  await f.run(); assert.equal(f.externalWrites[0].arguments.row, 4);
});
test("a moved row during the immediate precheck prevents external mutation", async () => {
  const f = fixture(); await f.run(); setLocal(f.state, "planner", "Abby");
  f.state.beforeRead = (input) => { if (input.arguments.end_row === 0) f.state.cells = f.state.cells.map((cell) => ({ ...cell, row: cell.row === 1 ? 4 : cell.row })); };
  await assert.rejects(f.run(), /identity_drift/u); assert.equal(f.externalWrites.length, 0);
});
test("duplicate source requests remain unmodified", async () => {
  const f = fixture(); f.state.cells.push(...f.cells.filter((cell) => cell.row === 1).map((cell) => ({ ...cell, row: 2 })));
  assert.equal((await f.run()).ambiguousCount, 2); assert.equal(f.writes.length, 0); assert.equal(f.externalWrites.length, 0);
});
test("false flags and nonblank notes round-trip through BOOL and STRING cells", async () => {
  const f = fixture(); setSource(f.state, 15, false); await f.run(); assert.equal(stored(f.state, "trialPaid"), false);
  setLocal(f.state, "trialPaid", true); setLocal(f.state, "trialLedgerNote", "Synthetic local note"); await f.run();
  assert.equal(f.externalWrites.find((write) => write.arguments.col === 15).arguments.value_type, "BOOL");
  assert.equal(f.externalWrites.find((write) => write.arguments.col === 16).arguments.string_value, "Synthetic local note");
});

test("a different child and ambiguous children under one guardian stay unmodified", async () => {
  const wrong = fixture(); setSource(wrong.state, 0, "Another Child");
  assert.equal((await wrong.run()).unmatchedCount, 1); assert.equal(wrong.writes.length, 0);
  const ambiguous = fixture(); setSource(ambiguous.state, 0, "");
  ambiguous.state.rows[0].payload.push({ id: "S-2", name: "Another Child", guardianWechat: "Parent Synthetic" });
  ambiguous.state.rows[1].payload.push({ ...structuredClone(ambiguous.state.rows[1].payload[0]), id: "LP-2", studentId: "S-2", trialIntake: { requestSentAt: "2026-10-22T09:47:00Z", studentName: "Another Child" } });
  assert.equal((await ambiguous.run()).ambiguousCount, 1); assert.equal(ambiguous.writes.length, 0); assert.equal(ambiguous.externalWrites.length, 0);
});
test("unknown source options cannot be replaced by local options", async () => {
  const f = fixture(); setSource(f.state, 9, "Unknown Planner"); setLocal(f.state, "planner", "Abby");
  assert.equal((await f.run()).invalidFieldCount, 1); assert.equal(f.writes.length, 0); assert.equal(f.externalWrites.length, 0);
});
test("cancellation writes the original source option and delayed/NIL results are preserved", async () => {
  const f = fixture(); await f.run(); setLocal(f.state, "resultStatus", "被家长取消"); await f.run();
  assert.equal(f.externalWrites.find((write) => write.arguments.col === 14).arguments.string_value, "取消不安排");
  setSource(f.state, 14, "延迟待安排"); await f.run(); assert.equal(stored(f.state, "resultStatus"), "延迟待安排");
  setSource(f.state, 14, "NIL"); await f.run(); assert.equal(stored(f.state, "resultStatus"), "NIL");
});

test("busy and malformed lease receipts cannot begin source reads", async () => {
  const busy = fixture({ claimReceipt: { claimed: false } }); assert.equal((await busy.run()).matchedCount, 0); assert.equal(busy.calls.length, 0);
  const bad = fixture({ claimReceipt: { claimed: "true" } }); await assert.rejects(bad.run(), /lease_receipt_invalid/u); assert.equal(bad.calls.length, 0);
});
