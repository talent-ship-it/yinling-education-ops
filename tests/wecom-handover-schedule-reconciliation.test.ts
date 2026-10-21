import assert from "node:assert/strict";
import test from "node:test";
import { runWecomHandoverScheduleReconciliation, type WecomHandoverScheduleReceipt } from "../lib/wecom-handover-schedule-reconciliation";
import type { WecomHandoverScheduleEvidence, WecomHandoverScheduleInput } from "../lib/wecom-handover-schedule-types";

const revision = `sha256:${"a".repeat(64)}`;
const now = new Date("2026-10-21T02:00:00.000Z");
function input(id: string, epoch = "1"): WecomHandoverScheduleInput {
  return { snapshotRevision: revision, inputRevision: epoch, targetSourceMessageIds: [id], coverage: [], events: [],
    rows: ["students", "teachers", "lpItems"].map((entity) => ({ entity, payload: [], version: 1, updated_at: now.toISOString(), updated_by: "synthetic" })),
    sources: [{ id, sourceMessageId: id, caseId: "d6385b25-691c-424f-a81b-5de3835ea703", sourceRevision: "b".repeat(64), wechatName: "Synthetic Parent", studentName: null, operationsOwner: "Ella", coursePlanner: "Eileen", status: "awaiting_student_name", createdAt: now.toISOString(), messages: [], confirmed: null }],
  };
}
const empty = { ...input("empty"), targetSourceMessageIds: [], sources: [] };
function receipt(entries: readonly WecomHandoverScheduleEvidence[]): WecomHandoverScheduleReceipt {
  return { checkedCount: entries.length, matchedCount: entries.filter((entry) => entry.status === "matched").length, candidateCount: entries.filter((entry) => entry.status === "candidate").length };
}

test("one cron drains multiple cohorts and stores only evidence without changing source or roster", async () => {
  const inputs = [input("source-one"), input("source-two"), empty];
  const before = JSON.stringify(inputs);
  const saved: WecomHandoverScheduleEvidence[][] = [];
  let reads = 0;
  const result = await runWecomHandoverScheduleReconciliation(revision, {
    readInput: async () => inputs[reads++], now: () => now,
    save: async ({ evidence }) => { saved.push([...evidence]); return receipt(evidence); },
  });
  assert.deepEqual(result, { checkedCount: 2, matchedCount: 0, candidateCount: 0 });
  assert.deepEqual(saved.flat().map((entry) => [entry.sourceMessageId, entry.status, entry.checkedAt]), [["source-one", "outside_window", now.toISOString()], ["source-two", "outside_window", now.toISOString()]]);
  assert.equal(JSON.stringify(inputs), before);
  assert.equal(reads, 3);
});

test("a stale epoch rereads all evidence and retries atomically, then drains normally", async () => {
  let reads = 0;
  const epochs: string[] = [];
  const result = await runWecomHandoverScheduleReconciliation(revision, {
    readInput: async () => ++reads <= 2 ? input("source-one", String(reads)) : empty, now: () => now,
    save: async ({ inputRevision, evidence }) => { epochs.push(inputRevision); if (epochs.length === 1) throw Object.assign(new Error("changed"), { code: "40001" }); return receipt(evidence); },
  });
  assert.equal(result.checkedCount, 1);
  assert.deepEqual(epochs, ["1", "2"]);
});

test("authorization failures do not retry or report a completed batch", async () => {
  let reads = 0;
  await assert.rejects(runWecomHandoverScheduleReconciliation(revision, {
    readInput: async () => { reads++; return input("source-one"); }, now: () => now,
    save: async () => { throw Object.assign(new Error("forbidden"), { code: "42501" }); },
  }), /forbidden/u);
  assert.equal(reads, 1);
});

test("invalid snapshots, receipts and nonadvancing batches fail visibly for the next cron retry", async () => {
  const dependencies = { readInput: async () => input("source-one"), now: () => now, save: async ({ evidence }: { evidence: readonly WecomHandoverScheduleEvidence[] }) => receipt(evidence) };
  await assert.rejects(runWecomHandoverScheduleReconciliation("wrong", dependencies), /invalid_handover_schedule_revision/u);
  await assert.rejects(runWecomHandoverScheduleReconciliation(revision, { ...dependencies, readInput: async () => ({ ...input("one"), snapshotRevision: "wrong" }) }), /invalid_handover_schedule_input/u);
  await assert.rejects(runWecomHandoverScheduleReconciliation(revision, { ...dependencies, save: async () => ({ checkedCount: 0, matchedCount: 0, candidateCount: 0 }) }), /invalid_handover_schedule_receipt/u);
  await assert.rejects(runWecomHandoverScheduleReconciliation(revision, dependencies), /handover_schedule_batch_did_not_advance/u);
});
