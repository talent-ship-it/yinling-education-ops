import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { monthlyHourCollectionPeriod, monthlyHourCoverage, monthlyHourRefreshDue } from "../lib/monthly-hour-period.ts";
import {
  JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY,
  JIAOWUBAO_COMPLETED_LESSON_COLLECTION_FORMAT,
  assertJiaowubaoCompletedLessonSnapshotPageBytes,
  buildJiaowubaoCompletedLessonSnapshot,
  collectJiaowubaoCompletedLessonMemberPage,
  readJiaowubaoCompletedLessonSnapshotRecord,
} from "../lib/jiaowubao-completed-lessons.ts";
import {
  allJiaowubaoCompletedScheduleRecords,
  assertJiaowubaoCompletedScheduleSnapshotPageBytes,
  collectJiaowubaoCompletedScheduleSnapshotWithMemberIds,
} from "../lib/jiaowubao-completed-schedule.ts";
import {
  buildJiaowubaoCompletedMonthEvidenceEnvelope,
  buildJiaowubaoCompletedMonthEvidenceSnapshot,
} from "../lib/jiaowubao-completed-month-evidence.ts";
import { createJiaowubaoCompletedLessonReader } from "../lib/jiaowubao-completed-lesson-provider-node.ts";
import { JiaowubaoOpenApiError } from "../lib/jiaowubao-open-api-node.ts";

const MONTH = "2026-10";
const NOW = Date.parse("2026-11-02T02:00:00.000Z");
const SOURCE = JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY;
const PUBLICATION = "71000000-0000-4000-8000-000000000099";
const source = ts.transpileModule(
  readFileSync(new URL("../lib/jiaowubao-completed-lesson-resumable-sync.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function toolReply(id, data) {
  return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } });
}

function controlReply(message) {
  const replies = {
    initialize: () => Response.json({
      jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
    }),
    "notifications/initialized": () => new Response(null, { status: 202 }),
    get_branch_detail: () => toolReply(message.id, { branch: { branch_id: "7", title: "Synthetic Institution" } }),
  };
  return replies[message.method === "tools/call" ? message.params.name : message.method]?.() ?? null;
}

function fixture(totals = [1]) {
  const memberIds = totals.map((_, index) => index + 17);
  const raw = new Map(memberIds.map((memberId, index) => [memberId, Array.from({ length: totals[index] }, (_, calendar) => ({
    branch_id: 7, cal_id: calendar + 1, mem_id: memberId, over: 1,
    dated: "2026-10-15", hours: 1, teacher_id: 90, teacher_title: "Synthetic Teacher",
  }))]));
  const f = {
    collection: null, current: null, envelope: null, scheduleError: null,
    lessonReply: null, loseStageReceiptAt: null, catalogChanged: false,
    sourceReads: [], staged: [], lessonPages: [], schedulePages: [],
    scheduleQueries: [], aborts: [], releases: [], reservations: [], confirmations: [],
    scheduleRows: Array.from({ length: Math.max(1, ...totals) }, (_, index) => ({
      cal_id: index + 1, dated: "2026-10-15", over: 1,
      teacher_id: 90, teacher_title: "Synthetic Teacher", teacher_hour: 1,
      stu_list: memberIds.map((mem_id) => ({ mem_id })),
    })),
  };
  let runNumber = 0;
  let lessonCredits = 0;
  const items = new Map();
  const cursor = () => ({ nextMemberId: null, nextPage: null, expectedTotal: null, targetVersion: null });
  const collection = () => clone(f.collection);
  const advanceMember = (saved, input) => {
    if (input.page * 100 < input.sourceTotal) {
      Object.assign(saved, { nextPage: input.page + 1, expectedTotal: input.sourceTotal, targetVersion: input.targetVersion + 1 });
      return;
    }
    saved.completedMemberCount += 1;
    Object.assign(saved, saved.completedMemberCount === memberIds.length
      ? { state: "ready", ...cursor() }
      : { nextMemberId: memberIds[saved.completedMemberCount], nextPage: 1, expectedTotal: null, targetVersion: 0 });
  };
  const stageMember = async (input) => {
    const saved = f.collection;
    assert.equal(saved.state, "collecting");
    assert.equal(input.runId, saved.runId);
    assert.equal(input.memberId, saved.nextMemberId);
    assert.equal(input.page, saved.nextPage);
    assert.equal(input.targetVersion, saved.targetVersion);
    assert.equal(input.rows.length, Math.min(100, input.sourceTotal - (input.page - 1) * 100));
    for (const row of input.rows) {
      assert.equal(items.has(row.sourceKey), false);
      items.set(row.sourceKey, clone(row));
    }
    f.staged.push(clone(input));
    saved.rowCount = items.size;
    advanceMember(saved, input);
    if (f.loseStageReceiptAt === f.staged.length) throw new Error("Synthetic lost receipt");
    return collection();
  };
  const abortMember = async ({ reason }) => {
    f.aborts.push(reason);
    Object.assign(f.collection, { state: reason === "caller_failure" ? "blocked" : "aborted", abortReason: reason, ...cursor() });
    return collection();
  };
  const store = {
    OpsStoreError: class extends Error {},
    claimJiaowubaoCompletedLessonSyncLease: async ({ runKey }) => ({ acquired: true, runKey, retryAfterSeconds: 0 }),
    releaseJiaowubaoCompletedLessonSyncLease: async (input) => { f.releases.push(input); },
    reserveJiaowubaoCompletedLessonApiRequest: async () => {
      f.reservations.push("query_lesson_list");
      lessonCredits += 1;
      return { tool: "query_lesson_list", notBefore: new Date(Date.now() - 1).toISOString() };
    },
    reserveJiaowubaoOpenApiScheduleRequest: async () => ({ tool: "query_schedule_list", notBefore: new Date(Date.now() - 1).toISOString() }),
    getJiaowubaoCompletedLessonMemberCollection: async () => !f.collection || f.collection.state === "aborted"
      ? { state: "absent", month: MONTH } : collection(),
    getJiaowubaoCompletedLessonSnapshotPreflight: async () => ({ apiSourceKey: SOURCE, month: MONTH, current: clone(f.current) }),
    beginJiaowubaoCompletedLessonMemberCollection: async (input) => {
      items.clear();
      f.collection = {
        state: "collecting", month: MONTH, runId: `71000000-0000-4000-8000-${String(++runNumber).padStart(12, "0")}`,
        dataThrough: input.dataThrough, publishedAt: null,
        scheduleRevision: input.scheduleRevision, scheduleMemberSetSha256: input.scheduleMemberSetSha256,
        scheduleMemberCount: input.scheduleMemberIds.length, catalogRevisionSha256: hash("synthetic-catalog"),
        catalogMemberCount: memberIds.length, memberSetSha256: hash(memberIds.join("\n")), memberCount: memberIds.length,
        completedMemberCount: 0, rowCount: 0, expectedCurrentRevision: input.expectedCurrentRevision,
        finalRevision: null, abortReason: null, nextMemberId: memberIds[0], nextPage: 1, expectedTotal: null, targetVersion: 0,
      };
      return collection();
    },
    stageJiaowubaoCompletedLessonMemberPage: stageMember,
    abortJiaowubaoCompletedLessonMemberCollection: abortMember,
    getJiaowubaoCompletedLessonMemberItemsPage: async ({ pageIndex }) => ({
      state: "ready", runId: f.collection.runId, month: MONTH, rowCount: items.size,
      pageIndex, pageCount: Math.ceil(items.size / 100), items: [...items.values()].slice(pageIndex * 100, (pageIndex + 1) * 100),
    }),
    prepareJiaowubaoCompletedLessonMemberPublication: async ({ revision }) => {
      if (f.catalogChanged) return abortMember({ reason: "catalog_changed" });
      f.collection.finalRevision = revision;
      return collection();
    },
    beginJiaowubaoCompletedLessonSnapshot: async ({ envelope }) => {
      f.envelope = clone(envelope);
      f.lessonPages = [];
      f.schedulePages = [];
      return { state: "staging", runId: PUBLICATION };
    },
    stageJiaowubaoCompletedLessonSnapshotPage: async ({ runId, pageIndex, rows }) => {
      f.lessonPages.push(clone(rows));
      return { runId, pageIndex, rowCount: rows.length };
    },
    stageJiaowubaoCompletedScheduleSnapshotPage: async ({ runId, pageIndex, rows }) => {
      f.schedulePages.push(clone(rows));
      return { runId, pageIndex, rowCount: rows.length };
    },
    completeJiaowubaoCompletedLessonSnapshot: async () => {
      assert.equal(f.lessonPages.flat().length, f.envelope.expectedRowCount);
      assert.equal(f.schedulePages.flat().length, f.envelope.expectedScheduleRowCount);
      assert.deepEqual(f.lessonPages.flat().map((row) => row.sourceKey).sort(), [...items.keys()].sort());
      f.current = {
        revision: f.envelope.revision, rowCount: f.envelope.expectedRowCount,
        scheduleRowCount: f.envelope.expectedScheduleRowCount, publishedAt: new Date(NOW).toISOString(),
      };
      return { runId: PUBLICATION, state: "complete", ...f.current, rowsSha256: hash("synthetic-rows"), payloadSha256: hash("synthetic-payload") };
    },
    abortJiaowubaoCompletedLessonSnapshot: async () => { assert.fail("Unexpected publication abort"); },
    completeJiaowubaoCompletedLessonMemberPublication: async ({ revision }) => {
      assert.equal(revision, f.current.revision);
      Object.assign(f.collection, { state: "published", publishedAt: f.current.publishedAt });
      return collection();
    },
    confirmJiaowubaoCompletedLessonSnapshotCurrent: async ({ revision }) => {
      assert.equal(revision, f.current.revision);
      f.confirmations.push(revision);
      return { confirmed: true, ...f.current };
    },
  };
  f.pageReply = (args, id, total = raw.get(args.mem_id).length) => {
    const records = raw.get(args.mem_id);
    const offset = (args.page - 1) * args.limit;
    return toolReply(id, { total: String(total), lists: records.slice(offset, offset + args.limit) });
  };
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), "https://card.jwbpro.com/open/jwb/mcp");
    const message = JSON.parse(init.body);
    const control = controlReply(message);
    if (control) return control;
    assert.equal(message.params.name, "query_lesson_list");
    assert.equal(lessonCredits--, 1);
    const args = message.params.arguments;
    f.sourceReads.push(clone(args));
    const overridden = f.lessonReply?.(args, message.id);
    if (overridden) return overridden;
    return f.pageReply(args, message.id);
  };
  const dependencies = {
    "@/lib/monthly-hour-period": { monthlyHourCollectionPeriod, monthlyHourCoverage, monthlyHourRefreshDue },
    "@/lib/jiaowubao-completed-lessons": {
      JIAOWUBAO_COMPLETED_LESSON_SNAPSHOT_SOURCE_KEY, JIAOWUBAO_COMPLETED_LESSON_COLLECTION_FORMAT,
      assertJiaowubaoCompletedLessonSnapshotPageBytes, buildJiaowubaoCompletedLessonSnapshot,
      collectJiaowubaoCompletedLessonMemberPage, readJiaowubaoCompletedLessonSnapshotRecord,
    },
    "@/lib/jiaowubao-completed-schedule": {
      allJiaowubaoCompletedScheduleRecords, assertJiaowubaoCompletedScheduleSnapshotPageBytes,
      collectJiaowubaoCompletedScheduleSnapshotWithMemberIds,
    },
    "@/lib/jiaowubao-completed-month-evidence": {
      buildJiaowubaoCompletedMonthEvidenceEnvelope, buildJiaowubaoCompletedMonthEvidenceSnapshot,
    },
    "@/lib/ops-store": store,
    "@/lib/jiaowubao-completed-lesson-provider-node": {
      createJiaowubaoCompletedLessonReader: (config) => createJiaowubaoCompletedLessonReader({
        ...config, fetchImpl, env: {
          JIAOWUBAO_SCHEDULE_SOURCE: "mcp", INSIDERLEADS_JWB_MCP_TOKEN: "Synthetic-Worker-Token",
          JIAOWUBAO_MCP_EXPECTED_BRANCH_ID: "7", JIAOWUBAO_MCP_EXPECTED_BRANCH_TITLE: "Synthetic Institution",
        },
      }),
    },
    "@/lib/jiaowubao-open-api-node": {
      JiaowubaoOpenApiError,
      queryJiaowubaoScheduleList: async (query) => {
        f.scheduleQueries.push(clone(query));
        if (f.scheduleError) throw f.scheduleError;
        return { lists: f.scheduleRows.slice((query.page - 1) * 100, query.page * 100) };
      },
    },
  };
  const exports = {};
  runInNewContext(source, {
    exports, Buffer, Date, Error, setTimeout, clearTimeout,
    require: (name) => { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; },
  });
  f.run = (input = {}) => exports.syncJiaowubaoCompletedLessonMonth({ month: MONTH, now: NOW, ...input });
  return f;
}

test("monthly worker begins, resumes after fifty physical calls and publishes complete evidence in a fresh invocation", async () => {
  const f = fixture(Array.from({ length: 51 }, () => 1));
  assert.equal((await f.run()).outcome, "in_progress");
  assert.equal(f.sourceReads.length, 0);
  const first = await f.run();
  assert.equal(first.completedMemberCount, 50);
  assert.equal(first.sourcePageCount, 50);
  assert.equal(f.current, null);
  const next = await f.run();
  assert.equal(next.completedMemberCount, 51);
  assert.equal(next.sourcePageCount, 1);
  assert.equal(f.collection.state, "ready");
  assert.equal(f.current, null);
  const published = await f.run();
  assert.equal(published.outcome, "applied");
  assert.equal(published.rowCount, 51);
  assert.equal(published.scheduleRowCount, 1);
  assert.equal(f.collection.state, "published");
  assert.equal(f.confirmations.length, 2);
  assert.equal((await f.run()).outcome, "no_change");
  assert.equal(new Set(f.sourceReads.map((query) => query.mem_id)).size, 51);
  assert.equal(f.reservations.length, 51);
  assert.equal(f.releases.length, 5);
  assert.deepEqual(f.aborts, []);
});

test("physical-call exhaustion inside a logical page preserves the exact durable member cursor", async () => {
  const f = fixture([450, 100]);
  await f.run();
  const result = await f.run();
  assert.equal(result.sourcePageCount, 50);
  assert.equal(result.rowCount, 450);
  assert.equal(result.completedMemberCount, 1);
  assert.equal(f.staged.length, 5);
  assert.equal(f.collection.nextMemberId, 18);
  assert.equal(f.collection.nextPage, 1);
  assert.equal(f.collection.targetVersion, 0);
  assert.equal(f.sourceReads.at(-1).page, 5);
  await f.run();
  assert.equal(f.sourceReads[50].page, 1);
  assert.equal(f.collection.state, "ready");
  assert.equal(f.collection.rowCount, 550);
  assert.equal((await f.run()).outcome, "applied");
  assert.deepEqual(f.aborts, []);
});

for (const [label, reply, retry] of [
  ["semantic rate limit", (id) => Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5" } }), 60],
  ["unavailable source", () => new Response(null, { status: 503 }), 300],
]) {
  test(`${label} on a later page resumes the saved total, page and version`, async () => {
    const f = fixture([113]);
    f.lessonReply = (query, id) => query.page === 11 ? reply(id) : null;
    await f.run();
    const interrupted = await f.run();
    assert.equal(interrupted.outcome, "in_progress");
    assert.equal(interrupted.retryAfterSeconds, retry);
    assert.equal(interrupted.rowCount, 100);
    assert.equal(f.collection.nextPage, 2);
    assert.equal(f.collection.expectedTotal, 113);
    assert.equal(f.collection.targetVersion, 1);
    assert.equal(f.current, null);
    f.lessonReply = null;
    await f.run();
    assert.equal(f.sourceReads[11].page, 11);
    assert.equal(f.collection.rowCount, 113);
    assert.equal(f.collection.state, "ready");
    assert.equal((await f.run()).outcome, "applied");
    assert.deepEqual(f.staged.map(({ page }) => page), [1, 2]);
    assert.deepEqual(f.aborts, []);
  });
}

test("a retryable final schedule timeout keeps a ready collection for the next worker", async () => {
  const f = fixture();
  await f.run();
  await f.run();
  f.scheduleError = new JiaowubaoOpenApiError("request_timeout", "Synthetic timeout");
  const result = await f.run();
  assert.equal(result.outcome, "in_progress");
  assert.equal(f.collection.state, "ready");
  assert.equal(f.current, null);
  assert.deepEqual(f.aborts, []);
  f.scheduleError = null;
  assert.equal((await f.run()).outcome, "applied");
  assert.equal(f.sourceReads.length, 1);
});

test("valid total drift inside the unsaved first page retries the same untouched cursor", async () => {
  const f = fixture([20]);
  f.lessonReply = (query, id) => query.page === 2 ? f.pageReply(query, id, 21) : null;
  await f.run();
  const result = await f.run();
  assert.equal(result.outcome, "in_progress");
  assert.equal(result.sourcePageCount, 2);
  assert.equal(f.collection.rowCount, 0);
  assert.equal(f.collection.nextPage, 1);
  assert.equal(f.collection.expectedTotal, null);
  assert.equal(f.collection.targetVersion, 0);
  assert.equal(f.staged.length, 0);
  assert.deepEqual(f.aborts, []);
  f.lessonReply = null;
  await f.run();
  assert.equal(f.sourceReads[2].page, 1);
  assert.equal(f.collection.rowCount, 20);
  assert.equal((await f.run()).outcome, "applied");
});

test("valid native total drift after a durable page still blocks the month", async () => {
  const f = fixture([130]);
  f.lessonReply = (query, id) => query.page === 12 ? f.pageReply(query, id, 129) : null;
  await f.run();
  await assert.rejects(f.run(), (error) => error instanceof JiaowubaoOpenApiError && error.code === "invalid_response");
  assert.equal(f.collection.state, "blocked");
  assert.equal(f.collection.rowCount, 100);
  assert.equal(f.staged.length, 1);
  assert.equal(f.current, null);
  assert.deepEqual(f.aborts, ["caller_failure"]);
});

test("a lost stage receipt observes the advanced database cursor without repeating or aborting evidence", async () => {
  const f = fixture([113]);
  f.loseStageReceiptAt = 1;
  await f.run();
  await f.run();
  assert.equal(f.collection.state, "ready");
  assert.deepEqual(f.staged.map(({ page }) => page), [1, 2]);
  assert.equal((await f.run()).outcome, "applied");
  assert.deepEqual(f.aborts, []);
});

test("authorization and deterministic protocol failures remain failures with no partial publication", async () => {
  for (const [reply, code, aborted] of [
    [() => new Response(null, { status: 403 }), "not_authorized", false],
    [(id) => Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "Synthetic supplier rejection" } }), "upstream_rejected", true],
    [(id) => toolReply(id, { total: "1", lists: [] }), "invalid_response", true],
  ]) {
    const f = fixture();
    f.lessonReply = (_query, id) => reply(id);
    await f.run();
    await assert.rejects(f.run(), (error) => error instanceof JiaowubaoOpenApiError && error.code === code);
    assert.equal(f.current, null);
    assert.equal(f.collection.state, aborted ? "blocked" : "collecting");
    assert.deepEqual(f.aborts, aborted ? ["caller_failure"] : []);
    assert.equal(f.releases.length, 2);
  }
});

test("rollover retires an untouched old-cutoff run only when the frozen schedule actually changes", async () => {
  const f = fixture();
  await f.run({ now: Date.parse("2026-10-21T02:00:00.000Z") });
  const oldRun = f.collection.runId;
  assert.equal(f.collection.dataThrough, "2026-10-20");
  f.scheduleRows[0].teacher_hour = 2;
  assert.equal((await f.run()).outcome, "in_progress");
  assert.deepEqual(f.aborts, ["schedule_changed"]);
  assert.equal(f.sourceReads.length, 0);
  assert.equal(f.current, null);
  await f.run();
  assert.notEqual(f.collection.runId, oldRun);
  assert.equal(f.collection.dataThrough, "2026-10-31");
  await f.run();
  assert.equal((await f.run()).outcome, "applied");
  assert.equal(f.envelope.query.lessons.end, "2026-10-31");
});

test("rollover preserves an unchanged frozen period and automatically begins its full-month successor", async () => {
  const f = fixture();
  await f.run({ now: Date.parse("2026-10-21T02:00:00.000Z") });
  await f.run();
  assert.deepEqual(f.aborts, []);
  assert.equal((await f.run()).outcome, "applied");
  assert.equal(f.envelope.query.lessons.end, "2026-10-20");
  assert.equal((await f.run()).outcome, "in_progress");
  assert.equal(f.collection.dataThrough, "2026-10-31");
  assert.equal(f.collection.completedMemberCount, 0);
  await f.run();
  assert.equal((await f.run()).outcome, "applied");
  assert.equal(f.envelope.query.lessons.end, "2026-10-31");
});

test("schedule and catalog publication fences retain their abort behavior", async () => {
  for (const reason of ["schedule_changed", "catalog_changed"]) {
    const f = fixture();
    await f.run();
    await f.run();
    if (reason === "schedule_changed") f.scheduleRows[0].teacher_hour = 2;
    else f.catalogChanged = true;
    assert.equal((await f.run()).outcome, "in_progress");
    assert.deepEqual(f.aborts, [reason]);
    assert.equal(f.current, null);
    assert.equal(f.envelope, null);
  }
});
