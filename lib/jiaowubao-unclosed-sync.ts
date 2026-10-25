import { randomUUID } from "node:crypto";
import { abortJiaowubaoUnclosedSnapshot, beginJiaowubaoUnclosedSnapshot, completeJiaowubaoUnclosedSnapshot, readJiaowubaoUnclosedSnapshot, stageJiaowubaoUnclosedSnapshot } from "./ops-store";
import { collectUnclosedLessons, unclosedPageReader } from "./jiaowubao-unclosed-collector";

export async function syncJiaowubaoUnclosedLessons(now = new Date()) {
  const previous = await readJiaowubaoUnclosedSnapshot();
  const collected = await collectUnclosedLessons(previous.lessons, now, unclosedPageReader(Date.now() + 220_000), previous.checkedAt);
  const runId = randomUUID();
  await beginJiaowubaoUnclosedSnapshot({ runId, expectedRevision: previous.revision, checkedAt: now.toISOString(), rowCount: collected.lessons.length });
  try {
    for (let index = 0; index < collected.lessons.length; index += 100) {
      await stageJiaowubaoUnclosedSnapshot({ runId, pageIndex: index / 100, rows: collected.lessons.slice(index, index + 100) });
    }
    const receipt = await completeJiaowubaoUnclosedSnapshot(runId);
    validateReceipt(receipt, collected.lessons.length);
    return { rowCount: receipt.rowCount, calls: collected.calls };
  } catch (error) {
    await abortJiaowubaoUnclosedSnapshot(runId).catch(() => undefined);
    throw error;
  }
}

function validateReceipt(receipt: { revision: string; rowCount: number }, expectedCount: number) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(receipt.revision) || receipt.rowCount !== expectedCount) throw new Error("unclosed_publication_invalid");
}
