import { prepareWecomHandoverScheduleProjection } from "./wecom-handover-schedule-projection";
import type { WecomHandoverScheduleEvidence, WecomHandoverScheduleInput } from "./wecom-handover-schedule-types";

export type WecomHandoverScheduleReceipt = Readonly<{
  checkedCount: number;
  matchedCount: number;
  candidateCount: number;
}>;
type Dependencies = Readonly<{
  readInput: (snapshotRevision: string) => Promise<WecomHandoverScheduleInput>;
  save: (input: Readonly<{ snapshotRevision: string; inputRevision: string; evidence: readonly WecomHandoverScheduleEvidence[] }>) => Promise<WecomHandoverScheduleReceipt>;
  now: () => Date;
}>;
function retryable(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "40001");
}
function validInput(input: WecomHandoverScheduleInput, revision: string) {
  const targets = input?.targetSourceMessageIds;
  if (!input || !Array.isArray(targets)) return false;
  return [input.snapshotRevision === revision, /^[0-9]+$/u.test(input.inputRevision), targets.length <= 50,
    new Set(targets).size === targets.length, Array.isArray(input.sources), Array.isArray(input.rows),
    Array.isArray(input.events), Array.isArray(input.coverage)].every(Boolean);
}
function validReceipt(receipt: WecomHandoverScheduleReceipt, entries: readonly WecomHandoverScheduleEvidence[]) {
  return receipt?.checkedCount === entries.length
    && receipt.matchedCount === entries.filter((entry) => entry.status === "matched").length
    && receipt.candidateCount === entries.filter((entry) => entry.status === "candidate").length;
}
function completeProjection(evidence: readonly WecomHandoverScheduleEvidence[], input: WecomHandoverScheduleInput) {
  return [new Set(evidence.map((entry) => entry.sourceMessageId)).size === evidence.length,
    evidence.length === input.targetSourceMessageIds.length,
    evidence.every((entry) => input.targetSourceMessageIds.includes(entry.sourceMessageId))].every(Boolean);
}
async function reconcileOnce(snapshotRevision: string, dependencies: Dependencies) {
  const input = await dependencies.readInput(snapshotRevision);
  if (!validInput(input, snapshotRevision)) throw new Error("invalid_handover_schedule_input");
  if (!input.targetSourceMessageIds.length) return null;
  const evidence = prepareWecomHandoverScheduleProjection({ ...input, checkedAt: dependencies.now() });
  if (!completeProjection(evidence, input)) throw new Error("incomplete_handover_schedule_projection");
  const receipt = await dependencies.save({ snapshotRevision, inputRevision: input.inputRevision, evidence });
  if (!validReceipt(receipt, evidence)) throw new Error("invalid_handover_schedule_receipt");
  return { receipt, key: `${input.inputRevision}:${[...input.targetSourceMessageIds].sort().join(",")}` };
}
async function reconcileBatch(snapshotRevision: string, dependencies: Dependencies) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await reconcileOnce(snapshotRevision, dependencies); }
    catch (error) {
      if (attempt < 2 && retryable(error)) continue;
      throw error;
    }
  }
  throw new Error("handover_schedule_conflict");
}

export async function runWecomHandoverScheduleReconciliation(snapshotRevision: string, dependencies: Dependencies): Promise<WecomHandoverScheduleReceipt> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(snapshotRevision)) throw new Error("invalid_handover_schedule_revision");
  const total = { checkedCount: 0, matchedCount: 0, candidateCount: 0 };
  const completed = new Set<string>();
  for (let batch = 0; batch < 64; batch += 1) {
    const result = await reconcileBatch(snapshotRevision, dependencies);
    if (!result) return total;
    if (completed.has(result.key)) throw new Error("handover_schedule_batch_did_not_advance");
    completed.add(result.key);
    total.checkedCount += result.receipt.checkedCount;
    total.matchedCount += result.receipt.matchedCount;
    total.candidateCount += result.receipt.candidateCount;
  }
  throw new Error("handover_schedule_batch_limit");
}
