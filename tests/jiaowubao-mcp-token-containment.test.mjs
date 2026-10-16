import assert from "node:assert/strict";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import { createJiaowubaoMcpScheduleReader } from "../lib/jiaowubao-mcp-node.ts";
import { createJiaowubaoScheduleReader } from "../lib/jiaowubao-schedule-provider-node.ts";
import {
  JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
  assertJiaowubaoScheduleSnapshotPageBytes,
  buildJiaowubaoScheduleSnapshotEnvelope,
  buildJiaowubaoScheduleHorizonFromCollectedPages,
  jiaowubaoScheduleCollectionWindows,
  JIAOWUBAO_SCHEDULE_HORIZON_DAYS,
  JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_RECORDS,
  JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE,
  jiaowubaoScheduleSourcePageRows,
  jiaowubaoScheduleSnapshotRows,
} from "../lib/jiaowubao-open-api-schedule-snapshot.ts";
import {
  JIAOWUBAO_SCHEDULE_COLLECTION_RESERVE_MS,
  JIAOWUBAO_SCHEDULE_AUTHORITY_TIMEOUT_MS,
  JIAOWUBAO_SCHEDULE_RELEASE_TIMEOUT_MS,
  JIAOWUBAO_SCHEDULE_UPSTREAM_REQUEST_MS,
  assertJiaowubaoScheduleTime,
  hasJiaowubaoScheduleTime,
  jiaowubaoScheduleRpcOptions,
  jiaowubaoScheduleWorkDeadline,
} from "../lib/jiaowubao-schedule-runtime-budget.ts";

const TOKEN = "Synthetic/Review+MCP~20261016=";
const CRON_SECRET = "SyntheticCronOnly";
const QUERY = { start: "2026-10-15", end: "2026-10-16", page: 1, limit: 100, order: "asc" };
const ROW = { cal_id: "12345678", teacher_id: "71", teacher_s: "0", teacher_t: "0", teacher_hour: "1.0", dated: "2026-10-15", time_start: "09:00", time_end: "10:00", type: "1", appoint: "0", over: "0", stu_list: [{ lesson_id: "100001", mem_id: "200001", name: "Synthetic Student", type: "1" }] };
const RPC_ID = "70000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "70000000-0000-4000-8000-000000000002";
const DIGEST = `sha256:${"b".repeat(64)}`;
const slashScalar = (text) => JSON.stringify(text).replaceAll("/", "\\/");
const unicodeScalar = (text) => `"${Array.from(text, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;

function responseRows(query, cont) {
  const start = query?.start;
  return [{ ...ROW, cal_id: start ? `echo-${start}` : ROW.cal_id, dated: start ?? ROW.dated, cont }];
}

function responseResult(message, cont) {
  if (message.method === "initialize") return { protocolVersion: "2025-11-25", capabilities: { tools: {} } };
  return { content: [{ type: "text", text: JSON.stringify({ total: "1", is_more: "0", lists: responseRows(message.params.arguments, cont) }) }] };
}

async function loopback(cont, transform = (_message, result) => result) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push(message);
    if (message.method === "notifications/initialized") return response.writeHead(202).end();
    const result = responseResult(message, cont);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: transform(message, result) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const nativeFetch = globalThis.fetch;
  const fetchImpl = (url, init) => {
    assert.equal(String(url), "https://card.jwbpro.com/open/jwb/mcp");
    assert.equal(init.redirect, "manual");
    assert.equal(init.method, "POST");
    return nativeFetch(`http://127.0.0.1:${address.port}/mcp`, init);
  };
  return { fetchImpl, calls, close: async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  } };
}

function routeHarness(fetchImpl) {
  const state = { staged: [], snapshotStaged: 0, published: 0, confirmations: 0, released: 0, logs: [], envelope: null };
  let active = { revision: `sha256:${"a".repeat(64)}`, publishedAt: new Date(Date.now() - 91 * 60_000).toISOString(), rowCount: 1 };
  const originalActive = JSON.stringify(active);
  let window;
  let cursor = { runId: RPC_ID, state: "collecting", passNumber: 0, windowIndex: 0, nextPage: 1, firstPassCount: 0, secondPassCount: 0 };
  class OpsStoreError extends Error {}
  const ops = {
    OpsStoreError,
    claimJiaowubaoOpenApiScheduleSyncLease: async (input) => ({ acquired: true, runKey: input.runKey, retryAfterSeconds: 0 }),
    releaseJiaowubaoOpenApiScheduleSyncLease: async () => { state.released++; },
    getJiaowubaoOpenApiScheduleProjectionTarget: async () => ({ ...active, state: "ready", projectionState: "complete", window }),
    beginJiaowubaoScheduleHorizonCollection: async (input) => { window = input.window; return cursor; },
    reserveJiaowubaoOpenApiScheduleRequest: async () => ({ tool: "query_schedule_list", notBefore: new Date(Date.now() - 1000).toISOString() }),
    stageJiaowubaoScheduleHorizonPage: async (input) => {
      state.staged.push({ passNumber: input.passNumber, windowIndex: input.windowIndex, pageNumber: input.pageNumber, rows: input.rows });
      cursor = { ...cursor, firstPassCount: cursor.firstPassCount + input.rows.length, nextPage: input.pageNumber + 1 };
      if (input.rows.length < 100) { cursor.windowIndex++; cursor.nextPage = 1; }
      if (cursor.windowIndex === 3) cursor.state = "ready";
      return cursor;
    },
    readJiaowubaoScheduleHorizonPages: async () => ({ runId: RPC_ID, state: "ready", pageCount: state.staged.length, pages: state.staged, hasMore: false }),
    abortJiaowubaoScheduleHorizonCollection: async () => {},
    closeJiaowubaoScheduleHorizonCollection: async () => {},
    beginJiaowubaoOpenApiScheduleSnapshot: async (input) => {
      state.envelope = input.envelope;
      return { runId: SNAPSHOT_ID, revision: input.envelope.revision, expectedPageCount: input.envelope.expectedPageCount, expectedRowCount: input.envelope.expectedRowCount, state: "staging", replayed: false };
    },
    stageJiaowubaoOpenApiScheduleSnapshotPage: async (input) => {
      state.snapshotStaged++;
      return { runId: SNAPSHOT_ID, pageIndex: input.pageIndex, rowCount: input.rows.length, pageSha256: DIGEST, replayed: false };
    },
    completeJiaowubaoOpenApiScheduleSnapshot: async () => {
      state.published++;
      active = { revision: state.envelope.revision, rowCount: state.envelope.expectedRowCount, publishedAt: new Date().toISOString() };
      return { runId: SNAPSHOT_ID, state: "complete", rowCount: active.rowCount, revision: active.revision, pageCount: state.envelope.expectedPageCount, rowsSha256: DIGEST, payloadSha256: DIGEST, replayed: false };
    },
    confirmJiaowubaoOpenApiScheduleSnapshotCurrent: async () => { state.confirmations++; throw new Error("unexpected_confirmation"); },
  };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  window = { start: today, end: new Date(Date.parse(`${today}T00:00:00Z`) + 92 * 86_400_000).toISOString().slice(0, 10) };
  const modules = {
    "node:crypto": { randomUUID, timingSafeEqual },
    "next/server": { NextResponse: { json: (payload, options) => Response.json(payload, options) } },
    "@/lib/jiaowubao-open-api-schedule-snapshot": {
      JIAOWUBAO_SCHEDULE_SNAPSHOT_SOURCE_KEY,
      assertJiaowubaoScheduleSnapshotPageBytes,
      buildJiaowubaoScheduleSnapshotEnvelope,
      buildJiaowubaoScheduleHorizonFromCollectedPages,
      jiaowubaoScheduleCollectionWindows,
      JIAOWUBAO_SCHEDULE_HORIZON_DAYS,
      JIAOWUBAO_SCHEDULE_SNAPSHOT_MAX_RECORDS,
      JIAOWUBAO_SCHEDULE_SNAPSHOT_PAGE_SIZE,
      jiaowubaoScheduleSourcePageRows,
      jiaowubaoScheduleSnapshotRows,
    },
    "@/lib/jiaowubao-schedule-runtime-budget": {
      JIAOWUBAO_SCHEDULE_COLLECTION_RESERVE_MS,
      JIAOWUBAO_SCHEDULE_AUTHORITY_TIMEOUT_MS,
      JIAOWUBAO_SCHEDULE_RELEASE_TIMEOUT_MS,
      JIAOWUBAO_SCHEDULE_UPSTREAM_REQUEST_MS,
      assertJiaowubaoScheduleTime,
      hasJiaowubaoScheduleTime,
      jiaowubaoScheduleRpcOptions,
      jiaowubaoScheduleWorkDeadline,
    },
    "@/lib/jiaowubao-schedule-projection-runner": { runOrQueueJiaowubaoScheduleProjectionTarget: async () => ({ projectionState: "complete" }) },
    "@/lib/jiaowubao-trial-auto-sync": {},
    "@/lib/jiaowubao-schedule-provider": { createJiaowubaoScheduleReader: () => createJiaowubaoScheduleReader({ env: { JIAOWUBAO_SCHEDULE_SOURCE: "mcp", INSIDERLEADS_JWB_MCP_TOKEN: TOKEN }, fetchImpl }) },
    "@/lib/ops-store": ops,
  };
  const source = readFileSync(new URL("../app/api/cron/jiaowubao-schedule/route.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: (id) => {
    assert.ok(id in modules, `undeclared import ${id}`);
    return modules[id];
  }, process: { env: { JIAOWUBAO_SCHEDULE_SYNC_TOKEN: CRON_SECRET } }, console: { error: (...args) => state.logs.push(args) }, Buffer, Date, Intl, setTimeout, clearTimeout, URL, Response, Request, AbortController });
  return { state, unchanged: () => JSON.stringify(active) === originalActive, get: () => exports.GET(new Request("http://127.0.0.1/cron", { headers: { authorization: `Bearer ${CRON_SECRET}` } })) };
}

function assertSafe(value, encoded) {
  const text = JSON.stringify(value);
  for (const secret of [TOKEN, encoded, encodeURIComponent(TOKEN), Buffer.from(TOKEN).toString("base64")]) {
    assert.equal(text.includes(secret), false, "error output must not contain a recoverable credential");
  }
}

async function replay(cont, transform) {
  const fixture = await loopback(cont, transform);
  try {
    const harness = routeHarness(fixture.fetchImpl);
    const response = await harness.get();
    return { ...harness, status: response.status, body: await response.json(), calls: fixture.calls };
  } finally { await fixture.close(); }
}

test("review B1 reader: escaped JSON scalar cannot reach canonical staging", async () => {
  const encoded = slashScalar(TOKEN);
  assert.equal(JSON.parse(encoded), TOKEN);
  assert.equal(encoded.includes(TOKEN), false);
  const fixture = await loopback(encoded);
  try {
    let returned;
    await assert.rejects(async () => { returned = await createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl })(QUERY); }, (error) => {
      assert.equal(error.code, "invalid_response");
      assertSafe({ message: error.message, stack: error.stack, error }, encoded);
      return true;
    });
    assert.equal(returned, undefined);
    assert.deepEqual(returned ? jiaowubaoScheduleSourcePageRows(returned) : [], []);
  } finally { await fixture.close(); }
});

for (const [label, encoded] of [["escaped slash", slashScalar(TOKEN)], ["Unicode scalar", unicodeScalar(TOKEN)]]) {
  test(`review B1 actual cron: ${label} cannot reach stage or complete`, async () => {
    assert.equal(JSON.parse(encoded), TOKEN);
    const result = await replay(encoded);
    const exposed = result.state.staged.flatMap((page) => page.rows).filter((row) => JSON.parse(row.record.cont) === TOKEN);
    assert.equal(exposed.length, 0, "actual route handed credential-bearing rows to staging");
    assert.equal(result.state.staged.length, 0);
    assert.equal(result.state.snapshotStaged, 0);
    assert.equal(result.state.published, 0);
    assert.equal(result.state.confirmations, 0);
    assert.equal(result.status, 503);
    assert.equal(result.body.phase, "collect_source");
    assert.equal(result.unchanged(), true);
    assert.equal(result.state.released, 1);
    assertSafe({ body: result.body, logs: result.state.logs }, encoded);
    assert.equal(result.calls.filter(({ method }) => method === "tools/call").length, 1);
  });
}

test("B1 positive: ordinary nested JSON business note is unchanged and still publishes", async () => {
  const cont = slashScalar("safe/note");
  const result = await replay(cont);
  assert.equal(result.status, 200);
  assert.equal(result.state.published, 1);
  assert.equal(result.state.staged.length, 3);
  assert.ok(result.state.staged.every((page) => page.rows[0].record.cont === cont && JSON.parse(page.rows[0].record.cont) === "safe/note"));
  assert.deepEqual(result.state.logs, []);
});

function assertRejectedSync(result, encoded) {
  assert.equal(result.status, 503);
  assert.equal(result.state.staged.length, 0);
  assert.equal(result.state.snapshotStaged, 0);
  assert.equal(result.state.published, 0);
  assert.equal(result.state.confirmations, 0);
  assert.equal(result.state.released, 1);
  assert.equal(result.unchanged(), true);
  assert.deepEqual(result.body, { error: "教务宝课表或试听任务同步未完成；系统会在下一次计划任务重试。", phase: "collect_source" });
  assert.deepEqual(JSON.parse(JSON.stringify(result.state.logs)), [["jiaowubao_schedule_sync_failed", { phase: "collect_source", category: "source_or_contract" }]]);
  assertSafe({ body: result.body, logs: result.state.logs }, encoded);
}

const encodedVariants = [
  ["URL component", encodeURIComponent(TOKEN)],
  ["lowercase percent bytes", Array.from(TOKEN, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")],
  ["double URL encoding", encodeURIComponent(encodeURIComponent(TOKEN))],
  ["URL form encoding", new URLSearchParams({ note: TOKEN }).toString()],
  ["URL bytes next to invalid escapes", `%ZZ%ff${encodeURIComponent(TOKEN)}%ZZ`],
  ["base64 padded", Buffer.from(TOKEN).toString("base64")],
  ["base64 unpadded", Buffer.from(TOKEN).toString("base64").replace(/=+$/u, "")],
  ["base64url unpadded", Buffer.from(TOKEN).toString("base64url")],
  ["base64 prefix glued to an encoded token", `metadata${Buffer.from(TOKEN).toString("base64")}tail`],
  ["base64 of a containing string", `data:text/plain;base64,${Buffer.from(`prefix:${TOKEN}:suffix`).toString("base64")}`],
  ["base64url containing a token", Buffer.from(`prefix:${TOKEN}:suffix`).toString("base64url")],
  ["URL over base64 over JSON scalar", encodeURIComponent(Buffer.from(unicodeScalar(TOKEN)).toString("base64"))],
  ["raw Unicode escapes", `note:${unicodeScalar(TOKEN).slice(1, -1)}`],
  ["raw hex escapes", `note:${Array.from(TOKEN, (c) => `\\x${c.charCodeAt(0).toString(16)}`).join("")}`],
  ["unquoted escaped slash", `note:${TOKEN.replaceAll("/", "\\/")}`],
  ["multiply nested JSON strings", JSON.stringify(JSON.stringify(unicodeScalar(TOKEN)))],
  ["nested JSON object key", `{${unicodeScalar(TOKEN)}:"safe"}`],
  ["encoded object key", { nested: [{ [encodeURIComponent(TOKEN)]: "safe" }] }],
  ["nested arrays and unknown values", [{ unknown: [null, { future: encodeURIComponent(TOKEN) }] }]],
];

for (const [label, encoded] of encodedVariants) {
  test(`MCP containment actual cron: ${label} rejects the entire response before writes`, async () => {
    assertRejectedSync(await replay(encoded), typeof encoded === "string" ? encoded : JSON.stringify(encoded));
  });
}

test("MCP containment rejects a tainted later row before staging an earlier clean row", async () => {
  const result = await replay("safe", (message, result) => {
    if (message.method !== "tools/call") return result;
    const data = JSON.parse(result.content[0].text);
    data.total = "2";
    data.lists.push({ ...data.lists[0], cal_id: "second-row", future: encodeURIComponent(TOKEN) });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });
  assertRejectedSync(result, encodeURIComponent(TOKEN));
});

const hiddenMetadata = [
  ["initialize", (message, result) => message.method === "initialize" ? { ...result, future: slashScalar(TOKEN) } : result],
  ["tool-envelope", (message, result) => message.method === "tools/call" ? { ...result, [encodeURIComponent(TOKEN)]: "safe" } : result],
  ["business-metadata", (message, result) => {
    if (message.method !== "tools/call") return result;
    const data = JSON.parse(result.content[0].text);
    return { ...result, content: [{ type: "text", text: JSON.stringify({ ...data, future: unicodeScalar(TOKEN) }) }] };
  }],
];

for (const [phase, transform] of hiddenMetadata) {
  test(`MCP containment also covers ignored strings in ${phase}`, async () => {
    const result = await replay("safe", transform);
    assertRejectedSync(result, slashScalar(TOKEN));
    assert.equal(result.calls.length, phase === "initialize" ? 1 : 3);
  });
}

async function expectControlledRejection(cont, transform, config = {}) {
  const fixture = await loopback(cont, transform);
  try {
    await assert.rejects(createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl, ...config })(QUERY), (error) => {
      assert.equal(error.code, "invalid_response");
      assert.equal(error.message, "教务宝 MCP 返回无效内容。");
      assertSafe({ message: error.message, stack: error.stack, error }, slashScalar(TOKEN));
      return true;
    });
    return fixture.calls;
  } finally { await fixture.close(); }
}

test("MCP containment checks institution metadata before any schedule read", async () => {
  const calls = await expectControlledRejection("safe", (message, result) => message.params?.name === "get_branch_detail"
    ? { content: [{ type: "text", text: JSON.stringify({ branch: { title: "Synthetic Institution" }, future: unicodeScalar(TOKEN) }) }] }
    : result, { expectedBranchTitle: "Synthetic Institution" });
  assert.deepEqual(calls.filter(({ method }) => method === "tools/call").map(({ params }) => params.name), ["get_branch_detail"]);
});

test("MCP containment fails closed on excessive object depth", async () => {
  let nested = "safe";
  for (let index = 0; index < 70; index++) nested = [nested];
  await expectControlledRejection(nested);
});

test("MCP containment fails closed on excessive decoding depth", async () => {
  let nested = TOKEN;
  for (let index = 0; index < 70; index++) nested = encodeURIComponent(nested);
  await expectControlledRejection(nested);
});

test("MCP containment fails closed on excessive traversal nodes", async () => {
  await expectControlledRejection(Array.from({ length: 200_001 }, () => 0));
});

test("MCP containment fails closed on cumulative decoded string bytes", async () => {
  let nested = "safe%20note";
  for (let index = 0; index < 55; index++) nested = encodeURIComponent(nested);
  await expectControlledRejection("x".repeat(700_000) + nested);
});

test("MCP containment preserves benign JSON, encodings, duplicate values and malformed notes byte for byte", async () => {
  const cont = { json: slashScalar("safe/note"), object: JSON.stringify({ nested: ["text", "0", null] }), unicode: "\\u4f60\\u597d", url: "safe%2Fnote%ZZ", base64: Buffer.from("safe/note").toString("base64"), duplicates: ["same", "same"], malformed: "{broken JSON", scalars: ["0", "false", "null", "\"safe\""] };
  const result = await replay(cont);
  assert.equal(result.status, 200);
  assert.equal(result.state.published, 1);
  assert.ok(result.state.staged.every((page) => JSON.stringify(page.rows[0].record.cont) === JSON.stringify(cont)));
  assert.deepEqual(result.state.logs, []);
});
