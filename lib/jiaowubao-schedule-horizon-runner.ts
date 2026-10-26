import type { JiaowubaoScheduleHorizonCollectionReceipt } from "./ops-store";

type Cursor = JiaowubaoScheduleHorizonCollectionReceipt;

type CollectionDependencies = Readonly<{
  begin: () => Promise<Cursor>;
  abort: (runId: string) => Promise<unknown>;
  stage: (cursor: Cursor) => Promise<Cursor>;
  canFetchNextPage: (requests: number) => boolean;
}>;

function interruptedConfirmation(cursor: Cursor) {
  return cursor.state === "collecting" && cursor.passNumber === 1
    && (cursor.windowIndex !== 0 || cursor.nextPage !== 1 || cursor.secondPassCount !== 0);
}

function validAbort(value: unknown, runId: string) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Readonly<Record<string, unknown>>;
  return receipt.runId === runId && receipt.aborted === true;
}

function freshCollection(cursor: Cursor, previousRunId: string) {
  return cursor.runId !== previousRunId && cursor.state === "collecting" && cursor.passNumber === 0
    && cursor.windowIndex === 0 && cursor.nextPage === 1
    && cursor.firstPassCount === 0 && cursor.secondPassCount === 0;
}

export async function runJiaowubaoScheduleHorizonCollection(dependencies: CollectionDependencies) {
  let cursor = await dependencies.begin();
  if (interruptedConfirmation(cursor)) {
    const previousRunId = cursor.runId;
    const aborted = await dependencies.abort(previousRunId);
    if (!validAbort(aborted, previousRunId)) throw new Error("schedule_horizon_abort_invalid");
    cursor = await dependencies.begin();
    if (!freshCollection(cursor, previousRunId)) throw new Error("schedule_horizon_restart_invalid");
  }

  const passNumber = cursor.passNumber;
  let requests = 0;
  while (cursor.state === "collecting" && cursor.passNumber === passNumber) {
    if (!dependencies.canFetchNextPage(requests)) return cursor;
    cursor = await dependencies.stage(cursor);
    requests += 1;
  }
  return cursor;
}
