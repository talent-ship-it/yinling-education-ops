import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getOpsState, tencentLpSourceSyncAction } from "./ops-store";
import { matchTencentLpSourceRecords, type TencentLpSourceRecord } from "./tencent-lp-source";
import { planTencentLpFieldMerge, type TencentLpBaseline } from "./tencent-lp-source-merge";
import { readTencentLpSource, readTencentLpSourceRow, writeTencentLpSourceCell } from "./tencent-lp-source-io";
import { normalizeTrialLedgerFieldValue, type TrialLedgerField, type TrialLedgerFieldValue } from "./trial-ledger";

type JsonRecord = Record<string, unknown>;
type Field = TencentLpSourceRecord["fields"][number];
type SyncRows = Awaited<ReturnType<typeof getOpsState>>;
type Counts = { appliedCount: number; exportedCount: number; matchedCount: number; unmatchedCount: number; ambiguousCount: number; invalidFieldCount: number; uncertainCount: number };
type Run = { token: string; lease: string; deadline: number; rows: SyncRows; version: number; counts: Counts };
type Context = { run: Run; record: TencentLpSourceRecord; field: Field; baseline: TencentLpBaseline; identityHash: string };
function requiredRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tencent_lp_source_state_invalid");
  return value as JsonRecord;
}
function scalar(field: string, value: unknown) {
  if (value === null) return null;
  const normalized = normalizeTrialLedgerFieldValue(field as TrialLedgerField, value);
  if (normalized === undefined) throw new Error("tencent_lp_source_baseline_invalid");
  return normalized;
}
function pendingValue(value: unknown, field: string): TencentLpBaseline["pending"] {
  if (value === null) return null;
  const pending = requiredRecord(value);
  if (!["planned", "attempted"].includes(String(pending.phase))) throw new Error("tencent_lp_source_baseline_invalid");
  const target = scalar(field, pending.target);
  if (target === null) throw new Error("tencent_lp_source_baseline_invalid");
  return { before: scalar(field, pending.before), target, phase: pending.phase as "planned" | "attempted" };
}
function validField(value: unknown): value is string {
  return ["planner", "resultStatus", "lpFinalized", "trialPaid", "trialLedgerNote"].includes(String(value));
}
function validRevision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function baselineValue(value: unknown): TencentLpBaseline {
  const row = requiredRecord(value);
  if (!validField(row.field) || !validRevision(row.revision)) throw new Error("tencent_lp_source_baseline_invalid");
  if (typeof row.initialized !== "boolean") throw new Error("tencent_lp_source_baseline_invalid");
  return { field: row.field, revision: row.revision as number, initialized: row.initialized,
    commonValue: scalar(row.field, row.commonValue), pending: pendingValue(row.pending, row.field) };
}
function entityPayload(rows: SyncRows, name: string) {
  const row = rows.find((candidate) => candidate.entity === name);
  if (!row || !Array.isArray(row.payload)) throw new Error("tencent_lp_source_state_unavailable");
  return row.payload as unknown[];
}
function matchingInput(run: Run, cells: Parameters<typeof matchTencentLpSourceRecords>[0]["cells"]) {
  return { cells, lpItems: entityPayload(run.rows, "lpItems"), students: entityPayload(run.rows, "students") };
}
function requiredVersion(version: unknown) {
  if (!Number.isSafeInteger(version) || (version as number) < 1) throw new Error("tencent_lp_source_state_unavailable");
  return version as number;
}
function sourceVersion(rows: SyncRows) { return requiredVersion(rows.find((row) => row.entity === "lpItems")?.version); }
async function currentRecord(context: Context) {
  const cells = await readTencentLpSourceRow(context.run.token, context.record.sourceRow, context.run.deadline);
  const found = matchTencentLpSourceRecords(matchingInput(context.run, cells)).records;
  const row = found.find((candidate) => candidate.lpItemId === context.record.lpItemId);
  if (!row || row.identityKey !== context.record.identityKey) throw new Error("tencent_lp_source_identity_drift");
  return row;
}
async function assertCurrent(context: Context) {
  const row = await currentRecord(context);
  if (row.proof !== context.record.proof) throw new Error("tencent_lp_source_changed_before_write");
  return row;
}
async function readBaselines(run: Run, record: TencentLpSourceRecord, identityHash: string) {
  const result = await tencentLpSourceSyncAction({ token: run.lease, action: "read", args: { lpItemId: record.lpItemId, identityHash } });
  if (!Array.isArray(result.fields) || result.fields.length > 5) throw new Error("tencent_lp_source_baseline_invalid");
  const entries = result.fields.map(baselineValue);
  if (new Set(entries.map((row) => row.field)).size !== entries.length) throw new Error("tencent_lp_source_baseline_invalid");
  return new Map(entries.map((row) => [row.field, row]));
}
async function command(context: Context, action: "observe" | "import" | "stage" | "attempt" | "complete" | "cancel", value: TrialLedgerFieldValue | null) {
  const result = await tencentLpSourceSyncAction({ token: context.run.lease, action, args: {
    lpItemId: context.record.lpItemId, identityHash: context.identityHash, field: context.field.field,
    revision: context.baseline.revision, expectedSystem: context.field.system, value,
    before: context.field.source, commandId: randomUUID(), expectedLpVersion: context.run.version,
  } });
  const baseline = baselineValue(result);
  if (baseline.field !== context.field.field) throw new Error("tencent_lp_source_receipt_invalid");
  context.baseline = baseline;
  if (["observe", "import", "stage", "attempt"].includes(action)) context.run.version = requiredVersion(result.lpVersion);
}
function exportValue(field: string, value: TrialLedgerFieldValue) {
  if (field === "planner") return ({ Tara: "Tara龙", Eileen: "Eileen校长号", Abby: "Abby校长号" } as Record<string, string>)[String(value)]!;
  return field === "resultStatus" && value === "被家长取消" ? "取消不安排" : value;
}
async function importField(context: Context) {
  await assertCurrent(context);
  await command(context, "import", context.field.source);
  context.run.counts.appliedCount += 1;
}
async function observeField(context: Context) {
  if (context.baseline.initialized && context.baseline.commonValue === context.field.source) return;
  await assertCurrent(context);
  await command(context, "observe", context.field.source);
}
async function recoverField(context: Context) {
  await assertCurrent(context);
  await command(context, "complete", context.baseline.pending!.target);
}
async function cancelField(context: Context) { await command(context, "cancel", null); }
async function uncertainField(context: Context) { context.run.counts.uncertainCount += 1; }
async function skipField() {}
function expectedWriteProof(context: Context) {
  const fields = JSON.parse(context.record.proof) as [string, unknown][];
  return JSON.stringify(fields.map(([field, value]) => [field, field === context.field.field ? context.baseline.pending!.target : value]));
}
async function confirmWrite(context: Context) {
  const row = await currentRecord(context);
  const field = row.fields.find((candidate) => candidate.field === context.field.field)!;
  if (field.source !== context.baseline.pending!.target) { context.run.counts.uncertainCount += 1; return; }
  const expectedProof = expectedWriteProof(context);
  await command(context, "complete", context.baseline.pending!.target);
  if (row.proof !== expectedProof) throw new Error("tencent_lp_source_changed_after_write");
  context.record = row;
  context.run.counts.exportedCount += 1;
}
async function attemptWrite(context: Context) {
  await assertCurrent(context);
  await command(context, "attempt", context.field.system);
  const value = exportValue(context.field.field, context.field.system!);
  await writeTencentLpSourceCell(context.run.token, context.record.sourceRow, context.field.column, value, context.run.deadline).catch(() => undefined);
  await confirmWrite(context);
}
async function exportField(context: Context) {
  await assertCurrent(context);
  await command(context, "stage", context.field.system);
  await attemptWrite(context);
}
const handlers = { skip: skipField, observe: observeField, import: importField, export: exportField,
  recover: recoverField, cancel: cancelField, uncertain: uncertainField };
function emptyBaseline(field: string): TencentLpBaseline {
  return { field, revision: 0, initialized: false, commonValue: null, pending: null };
}
async function syncRecord(run: Run, record: TencentLpSourceRecord) {
  const identityHash = createHash("sha256").update(record.identityKey).digest("hex");
  const baselines = await readBaselines(run, record, identityHash);
  let current = record;
  for (const field of record.fields) {
    if (!field.valid) { run.counts.invalidFieldCount += 1; continue; }
    const context = { run, record: current, field, identityHash, baseline: baselines.get(field.field) ?? emptyBaseline(field.field) };
    await handlers[planTencentLpFieldMerge(field.source, field.system, context.baseline)](context);
    current = context.record;
  }
}
async function syncClaimed(run: Run) {
  const cells = await readTencentLpSource(run.token, run.deadline);
  const checked = await readTencentLpSource(run.token, run.deadline);
  if (JSON.stringify(cells) !== JSON.stringify(checked)) throw new Error("tencent_lp_source_changed_during_read");
  run.rows = await getOpsState(["lpItems", "students"]);
  run.version = sourceVersion(run.rows);
  const plan = matchTencentLpSourceRecords(matchingInput(run, cells));
  Object.assign(run.counts, { matchedCount: plan.records.length, unmatchedCount: plan.unmatchedCount, ambiguousCount: plan.ambiguousCount });
  for (const record of plan.records) await syncRecord(run, record);
}
export async function runTencentLpSourceSync(token: string) {
  const counts: Counts = { appliedCount: 0, exportedCount: 0, matchedCount: 0, unmatchedCount: 0, ambiguousCount: 0, invalidFieldCount: 0, uncertainCount: 0 };
  const run: Run = { token, lease: randomUUID(), deadline: Date.now() + 220_000, rows: [], version: 0, counts };
  const claim = await tencentLpSourceSyncAction({ token: run.lease, action: "claim" });
  if (typeof claim.claimed !== "boolean") throw new Error("tencent_lp_source_lease_receipt_invalid");
  if (!claim.claimed) return counts;
  try { await syncClaimed(run); }
  finally { await tencentLpSourceSyncAction({ token: run.lease, action: "release" }).catch(() => undefined); }
  return counts;
}
