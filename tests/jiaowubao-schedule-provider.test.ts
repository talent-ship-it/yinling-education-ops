import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createJiaowubaoScheduleReader } from "../lib/jiaowubao-schedule-provider-node";
import { JiaowubaoOpenApiError } from "../lib/jiaowubao-open-api-node";
import { jiaowubaoScheduleSourcePageRows } from "../lib/jiaowubao-open-api-schedule-snapshot";

const TOKEN = "SyntheticMCPtoken-ProviderTests";
const QUERY = { start: "2026-10-15", end: "2026-10-16", page: 1, limit: 100, order: "asc" } as const;
const ROW = { cal_id: "22345678", teacher_id: "42", teacher_title: "Synthetic Teacher", dated: "2026-10-15", time_start: "09:00", time_end: "10:00", type: "1", appoint: "0", try_arrive: "0", stu_list: [{ mem_id: "31", name: "Synthetic Student", type: "1" }] };

async function providers(failMcp = false) {
  let restCalls = 0;
  let mcpCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.sk) {
      restCalls++;
      assert.equal(message.sk, "SyntheticRestSecret");
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ret: "1", data: { lists: [ROW] } }));
      return;
    }
    mcpCalls++;
    if (failMcp) {
      response.writeHead(503, { "Content-Type": "text/plain" }).end(TOKEN);
      return;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
      : { content: [{ type: "text", text: JSON.stringify({ total: "1", is_more: "0", lists: [ROW] }) }] };
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const nativeFetch = globalThis.fetch;
  const fetchImpl: typeof fetch = (url, init) => {
    const target = String(url);
    assert.ok(["https://cardi.jwbpro.com/open/jwb/gateway", "https://card.jwbpro.com/open/jwb/mcp"].includes(target));
    assert.equal(init?.redirect, target.endsWith("mcp") ? "manual" : "error");
    return nativeFetch(`http://127.0.0.1:${address.port}/synthetic`, init);
  };
  return { fetchImpl, counts: () => ({ restCalls, mcpCalls }), close: () => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve());
  }) };
}

test("schedule provider defaults to REST and missing MCP token leaves the existing REST path working", async () => {
  const fixture = await providers();
  const nativeFetch = globalThis.fetch;
  assert.equal(process.env.JIAOWUBAO_OPEN_API_SK, undefined);
  process.env.JIAOWUBAO_OPEN_API_SK = "SyntheticRestSecret";
  globalThis.fetch = fixture.fetchImpl;
  try {
    for (const env of [{}, { INSIDERLEADS_JWB_MCP_TOKEN: TOKEN }, { JIAOWUBAO_SCHEDULE_SOURCE: "rest", INSIDERLEADS_JWB_MCP_TOKEN: TOKEN }, { JIAOWUBAO_SCHEDULE_SOURCE: "mcp" }]) {
      assert.equal(createJiaowubaoScheduleReader({ env, fetchImpl: fixture.fetchImpl }).source, "rest");
    }
    const reader = createJiaowubaoScheduleReader({ env: { JIAOWUBAO_SCHEDULE_SOURCE: "mcp" }, fetchImpl: fixture.fetchImpl });
    assert.deepEqual(await reader.readPage(QUERY), { lists: [ROW] });
    assert.deepEqual(fixture.counts(), { restCalls: 1, mcpCalls: 0 });
  } finally {
    delete process.env.JIAOWUBAO_OPEN_API_SK;
    globalThis.fetch = nativeFetch;
    await fixture.close();
  }
});

test("REST and MCP readers produce exactly identical staging inputs for the same synthetic data", async () => {
  const fixture = await providers();
  const nativeFetch = globalThis.fetch;
  process.env.JIAOWUBAO_OPEN_API_SK = "SyntheticRestSecret";
  globalThis.fetch = fixture.fetchImpl;
  try {
    const rest = createJiaowubaoScheduleReader({ env: { JIAOWUBAO_SCHEDULE_SOURCE: "rest" } });
    const env = { JIAOWUBAO_SCHEDULE_SOURCE: "mcp", INSIDERLEADS_JWB_MCP_TOKEN: TOKEN };
    const mcp = createJiaowubaoScheduleReader({ env, fetchImpl: fixture.fetchImpl });
    env.JIAOWUBAO_SCHEDULE_SOURCE = "rest";
    env.INSIDERLEADS_JWB_MCP_TOKEN = "changed-synthetic-token";
    assert.equal(mcp.source, "mcp");
    const restRows = jiaowubaoScheduleSourcePageRows(await rest.readPage(QUERY));
    const mcpRows = jiaowubaoScheduleSourcePageRows(await mcp.readPage(QUERY));
    assert.deepEqual(mcpRows, restRows);
    assert.equal(mcpRows[0]?.sourceKey, "jwb-open-api:schedule:22345678");
    assert.deepEqual(fixture.counts(), { restCalls: 1, mcpCalls: 3 });
  } finally {
    delete process.env.JIAOWUBAO_OPEN_API_SK;
    globalThis.fetch = nativeFetch;
    await fixture.close();
  }
});

test("configured MCP failures never switch the active run back to REST or emit token-bearing logs", async () => {
  const fixture = await providers(true);
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args); };
  try {
    const reader = createJiaowubaoScheduleReader({ env: { JIAOWUBAO_SCHEDULE_SOURCE: "mcp", INSIDERLEADS_JWB_MCP_TOKEN: TOKEN }, fetchImpl: fixture.fetchImpl });
    await assert.rejects(reader.readPage(QUERY), (error: unknown) => error instanceof JiaowubaoOpenApiError && error.code === "upstream_unavailable" && !String(error).includes(TOKEN));
    assert.deepEqual(fixture.counts(), { restCalls: 0, mcpCalls: 1 });
    assert.deepEqual(logs, []);
  } finally {
    console.error = originalError;
    await fixture.close();
  }
});

test("cron wires one server-only provider into the existing rate gate and horizon staging", async () => {
  const route = await readFile(new URL("../app/api/cron/jiaowubao-schedule/route.ts", import.meta.url), "utf8");
  const wrapper = await readFile(new URL("../lib/jiaowubao-schedule-provider.ts", import.meta.url), "utf8");
  assert.match(wrapper, /import "server-only"/);
  assert.match(route, /const sourceReader = createJiaowubaoScheduleReader\(\)/);
  assert.match(route, /sourceReader\.readPage\(query/);
  assert.match(route, /collectResumableHorizon\(window, currentRevision, deadlineAt, runKey, sourceReader\)/);
  assert.match(route, /reserveJiaowubaoOpenApiScheduleRequest/);
  assert.match(route, /jiaowubaoScheduleSourcePageRows\(response\)/);
  assert.doesNotMatch(route, /queryJiaowubaoScheduleList/);
});

test("provider forwards optional institution environment pins", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = request.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
      : { content: [{ type: "text", text: JSON.stringify({ branch: { title: "Wrong Synthetic Institution", branch_id: "wrong" } }) }] };
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
  const reader = createJiaowubaoScheduleReader({ env: { JIAOWUBAO_SCHEDULE_SOURCE: "mcp", INSIDERLEADS_JWB_MCP_TOKEN: TOKEN, JIAOWUBAO_MCP_EXPECTED_BRANCH_TITLE: "Synthetic Institution", JIAOWUBAO_MCP_EXPECTED_BRANCH_ID: "17" }, fetchImpl });
  await assert.rejects(reader.readPage(QUERY), (error: unknown) => error instanceof JiaowubaoOpenApiError && error.code === "upstream_rejected");
  assert.equal(calls, 3);
});

