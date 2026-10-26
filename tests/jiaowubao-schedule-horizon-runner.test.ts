import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJiaowubaoScheduleHorizonFromCollectedPages,
  jiaowubaoScheduleSourcePageRows,
  type JiaowubaoScheduleHorizonCollectedPage,
} from "../lib/jiaowubao-open-api-schedule-snapshot";
import { runJiaowubaoScheduleHorizonCollection } from "../lib/jiaowubao-schedule-horizon-runner";
import type { JiaowubaoScheduleHorizonCollectionReceipt } from "../lib/ops-store";

type Cursor = JiaowubaoScheduleHorizonCollectionReceipt;
const OLD_RUN = "00000000-0000-4000-8000-000000000001";
const NEW_RUN = "00000000-0000-4000-8000-000000000002";
const WINDOW = { start: "2026-10-26", end: "2027-01-26" };

function cursor(overrides: Partial<Cursor> = {}): Cursor {
  return { runId: OLD_RUN, state: "collecting", passNumber: 0, windowIndex: 0,
    nextPage: 1, firstPassCount: 0, secondPassCount: 0, ...overrides };
}

function sourceRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    cal_id: `synthetic-${String(index).padStart(5, "0")}`,
    dated: WINDOW.start,
    teacher_title: "Synthetic Teacher",
  }));
}

function advanceFixtureCursor(position: Cursor, rowCount: number): Cursor {
  const saved = { ...position,
    firstPassCount: position.firstPassCount + (position.passNumber === 0 ? rowCount : 0),
    secondPassCount: position.secondPassCount + (position.passNumber === 1 ? rowCount : 0) };
  if (rowCount === 100) return { ...saved, nextPage: saved.nextPage + 1 };
  if (position.windowIndex < 2) return { ...saved, windowIndex: saved.windowIndex + 1, nextPage: 1 };
  if (position.passNumber === 0) return { ...saved, passNumber: 1, windowIndex: 0, nextPage: 1 };
  return { ...saved, state: "ready", windowIndex: 3, nextPage: 1 };
}

function sourceFixture(count: number) {
  let saved = cursor();
  let source = sourceRows(count);
  let sourceKeys = new Set<string>();
  let pages: JiaowubaoScheduleHorizonCollectedPage[] = [];
  const calls: string[] = [];
  let invocationCalls = 0;
  const dependencies = {
    begin: async () => { calls.push(`begin:${saved.runId}`); return saved; },
    abort: async (runId: string) => {
      calls.push(`abort:${runId}`);
      assert.equal(runId, saved.runId);
      pages = [];
      sourceKeys.clear();
      saved = cursor({ runId: NEW_RUN });
      return { runId, aborted: true };
    },
    stage: async (position: Cursor) => {
      assert.deepEqual(position, saved);
      calls.push(`stage:${position.passNumber}:${position.windowIndex}:${position.nextPage}`);
      invocationCalls += 1;
      const records = position.windowIndex === 0
        ? source.slice((position.nextPage - 1) * 100, position.nextPage * 100) : [];
      const rows = jiaowubaoScheduleSourcePageRows({ lists: records });
      for (const row of rows) {
        if (sourceKeys.has(row.sourceKey)) throw Object.assign(new Error("duplicate_source_key"), { code: "23505" });
      }
      for (const row of rows) sourceKeys.add(row.sourceKey);
      pages.push({ passNumber: position.passNumber, windowIndex: position.windowIndex,
        pageNumber: position.nextPage, rows });
      saved = advanceFixtureCursor(position, rows.length);
      if (saved.passNumber !== position.passNumber) sourceKeys = new Set();
      return saved;
    },
    canFetchNextPage: (requests: number) => requests < 66,
  };
  return {
    calls, dependencies,
    saved: () => saved,
    pages: () => pages,
    replaceSource: (records: ReturnType<typeof sourceRows>) => { source = records; },
    invoke: async (budget = 66) => {
      invocationCalls = 0;
      const result = await runJiaowubaoScheduleHorizonCollection({
        ...dependencies, canFetchNextPage: (requests) => requests < budget,
      });
      return { cursor: result, calls: invocationCalls };
    },
  };
}

test("a 4645-row confirmation starts at page one with its own invocation budget", async () => {
  const fixture = sourceFixture(4645);
  const first = await fixture.invoke();
  assert.equal(first.calls, 49);
  assert.deepEqual(first.cursor, cursor({ passNumber: 1, firstPassCount: 4645 }));
  assert.equal(fixture.calls.some((call) => call.startsWith("stage:1:")), false);

  fixture.replaceSource([{ cal_id: "synthetic-inserted", dated: WINDOW.start, teacher_title: "New Synthetic Teacher" },
    ...sourceRows(4645)]);
  const second = await fixture.invoke();
  assert.equal(second.calls, 49);
  assert.equal(second.cursor.state, "ready");
  assert.equal(second.cursor.secondPassCount, 4646);
  assert.equal(fixture.calls.find((call) => call.startsWith("stage:1:")), "stage:1:0:1");
  assert.equal(fixture.calls.some((call) => call.startsWith("abort:")), false);
  const snapshot = buildJiaowubaoScheduleHorizonFromCollectedPages(WINDOW, fixture.pages());
  assert.equal(snapshot.manifest.recordCount, 4646);
});

test("both complete 6000-row scans retain all three terminal windows within 63 calls each", async () => {
  const fixture = sourceFixture(6000);
  assert.equal((await fixture.invoke()).calls, 63);
  const confirmed = await fixture.invoke();
  assert.equal(confirmed.calls, 63);
  assert.equal(confirmed.cursor.state, "ready");
  assert.equal(fixture.pages().length, 126);
  assert.equal(buildJiaowubaoScheduleHorizonFromCollectedPages(WINDOW, fixture.pages()).manifest.recordCount, 6000);
});

test("a first pass interrupted by its budget resumes but stops before starting confirmation", async () => {
  const fixture = sourceFixture(4645);
  const partial = await fixture.invoke(7);
  assert.equal(partial.cursor.passNumber, 0);
  assert.equal(partial.cursor.nextPage, 8);
  const completed = await fixture.invoke();
  assert.equal(completed.calls, 42);
  assert.equal(completed.cursor.passNumber, 1);
  assert.equal(completed.cursor.nextPage, 1);
  assert.equal(fixture.calls.some((call) => call.startsWith("abort:")), false);
});

test("interrupted confirmation is discarded before shifted offsets can be requested", async () => {
  const fixture = sourceFixture(4645);
  await fixture.invoke();
  const partial = await fixture.invoke(17);
  assert.equal(partial.cursor.nextPage, 18);
  assert.equal(partial.cursor.secondPassCount, 1700);
  fixture.replaceSource([{ cal_id: "synthetic-inserted", dated: WINDOW.start, teacher_title: "New Synthetic Teacher" },
    ...sourceRows(4645)]);
  const restarted = await fixture.invoke();
  assert.equal(restarted.cursor.runId, NEW_RUN);
  assert.equal(restarted.cursor.passNumber, 1);
  assert.equal(restarted.cursor.nextPage, 1);
  const abortIndex = fixture.calls.indexOf(`abort:${OLD_RUN}`);
  assert.ok(abortIndex > 0);
  assert.equal(fixture.calls[abortIndex + 1], `begin:${NEW_RUN}`);
  assert.equal(fixture.calls[abortIndex + 2], "stage:0:0:1");
  assert.equal(fixture.calls.includes("stage:1:0:18"), false);
  const confirmed = await fixture.invoke();
  assert.equal(confirmed.cursor.state, "ready");
  assert.equal(buildJiaowubaoScheduleHorizonFromCollectedPages(WINDOW, fixture.pages()).manifest.recordCount, 4646);
});

test("confirmation with empty completed windows restarts even when its row count is zero", async () => {
  const calls: string[] = [];
  let begins = 0;
  const result = await runJiaowubaoScheduleHorizonCollection({
    begin: async () => {
      begins += 1;
      calls.push(`begin:${begins}`);
      return begins === 1 ? cursor({ passNumber: 1, windowIndex: 1 }) : cursor({ runId: NEW_RUN });
    },
    abort: async (runId) => { calls.push("abort"); return { runId, aborted: true }; },
    stage: async () => { throw new Error("must_not_fetch"); },
    canFetchNextPage: () => false,
  });
  assert.deepEqual(calls, ["begin:1", "abort", "begin:2"]);
  assert.equal(result.runId, NEW_RUN);
});

test("ready evidence and unstarted confirmation are retained", async () => {
  for (const saved of [cursor({ state: "ready", passNumber: 1, windowIndex: 3, secondPassCount: 200 }),
    cursor({ passNumber: 1, firstPassCount: 4645 })]) {
    const result = await runJiaowubaoScheduleHorizonCollection({
      begin: async () => saved,
      abort: async () => { throw new Error("must_not_abort"); },
      stage: async () => { throw new Error("must_not_fetch"); },
      canFetchNextPage: () => false,
    });
    assert.deepEqual(result, saved);
  }
});

test("an abort must confirm the exact run before a replacement can begin", async () => {
  for (const receipt of [null, {}, { runId: NEW_RUN, aborted: true }, { runId: OLD_RUN, aborted: false }]) {
    let begins = 0;
    await assert.rejects(runJiaowubaoScheduleHorizonCollection({
      begin: async () => { begins += 1; return cursor({ passNumber: 1, nextPage: 2, secondPassCount: 100 }); },
      abort: async () => receipt,
      stage: async () => { throw new Error("must_not_fetch"); },
      canFetchNextPage: () => true,
    }), /schedule_horizon_abort_invalid/);
    assert.equal(begins, 1);
  }
  let begins = 0;
  await assert.rejects(runJiaowubaoScheduleHorizonCollection({
    begin: async () => { begins += 1; return cursor({ passNumber: 1, nextPage: 2 }); },
    abort: async () => { throw new Error("abort_failed"); },
    stage: async () => { throw new Error("must_not_fetch"); },
    canFetchNextPage: () => true,
  }), /abort_failed/);
  assert.equal(begins, 1);
});

test("a restart rejects a reused run or a replacement with prior scan data", async () => {
  for (const replacement of [cursor(), cursor({ runId: NEW_RUN, firstPassCount: 1 }),
    cursor({ runId: NEW_RUN, passNumber: 1 }), cursor({ runId: NEW_RUN, windowIndex: 1 })]) {
    let begins = 0;
    await assert.rejects(runJiaowubaoScheduleHorizonCollection({
      begin: async () => ++begins === 1 ? cursor({ passNumber: 1, nextPage: 2 }) : replacement,
      abort: async (runId) => ({ runId, aborted: true }),
      stage: async () => { throw new Error("must_not_fetch"); },
      canFetchNextPage: () => true,
    }), /schedule_horizon_restart_invalid/);
  }
});

test("duplicate source keys with changed payloads still reject the scan", async () => {
  const fixture = sourceFixture(300);
  const records = sourceRows(300);
  records[100] = { ...records[0]!, teacher_title: "Conflicting Synthetic Teacher" };
  fixture.replaceSource(records);
  await assert.rejects(fixture.invoke(), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "23505");
  assert.equal(fixture.saved().state, "collecting");
  assert.equal(fixture.saved().firstPassCount, 100);
  assert.equal(fixture.pages().length, 1);
  assert.throws(() => buildJiaowubaoScheduleHorizonFromCollectedPages(WINDOW, fixture.pages()), /尚未覆盖完整/);
});
