import assert from "node:assert/strict";
import test from "node:test";
import { createJiaowubaoCompletedLessonReader } from "../lib/jiaowubao-completed-lesson-provider-node";
import { createJiaowubaoMcpCompletedLessonReader } from "../lib/jiaowubao-mcp-node";
import { JiaowubaoOpenApiError } from "../lib/jiaowubao-open-api-node";

const TOKEN = "SyntheticLessonToken-OnlyForLocalTests";
const QUERY = { start: "2026-10-01", end: "2026-10-31", mem_id: 17, sign: -1, page: 1, limit: 100 } as const;
type Args = Record<string, number | string>;
type ToolResult = { total: string; lists: Record<string, unknown>[] };
type HandlerResult = ToolResult | { text: string } | { error: true };

function row(index: number) {
  return { lesson_id: String(index + 1), mem_id: "17", over: "1" };
}

function toolReply(id: number, data: HandlerResult | { branch: { title: string; branch_id: string } }) {
  if ("error" in data) {
    return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "请求过于频繁，请稍后再试" } });
  }
  return Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "text" in data ? data.text : JSON.stringify(data) }] } });
}

function fixture(handler: (args: Args) => HandlerResult) {
  const calls: Args[] = [];
  const names: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://card.jwbpro.com/open/jwb/mcp");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${TOKEN}`);
    const message = JSON.parse(String(init?.body));
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/call") {
      names.push(message.params.name);
      if (message.params.name === "get_branch_detail") {
        return toolReply(message.id, { branch: { title: "Synthetic Institution", branch_id: "7" } });
      }
      calls.push(message.params.arguments);
      return toolReply(message.id, handler(message.params.arguments));
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
  };
  return { fetchImpl, calls, names };
}

function paged(total: number, args: Args): ToolResult {
  const offset = (Number(args.page) - 1) * Number(args.limit);
  return { total: String(total), lists: Array.from({ length: Math.max(0, Math.min(Number(args.limit), total - offset)) }, (_, i) => row(offset + i)) };
}

function provider(source: ReturnType<typeof fixture>, beforeRequest: () => Promise<void> = async () => undefined) {
  return createJiaowubaoCompletedLessonReader({
    env: {
      JIAOWUBAO_SCHEDULE_SOURCE: "mcp", INSIDERLEADS_JWB_MCP_TOKEN: TOKEN,
      JIAOWUBAO_MCP_EXPECTED_BRANCH_TITLE: "Synthetic Institution",
      JIAOWUBAO_MCP_EXPECTED_BRANCH_ID: "7",
    },
    fetchImpl: source.fetchImpl, beforeRequest, deadlineAt: Date.now() + 60_000,
  });
}

function errorCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof JiaowubaoOpenApiError);
    assert.equal(error.code, code);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(TOKEN), false);
    return true;
  };
}

test("lesson MCP pins the institution, forces completed member scope and accepts a true empty member", async () => {
  const source = fixture((args) => paged(0, args));
  const reader = provider(source);
  assert.deepEqual(await reader.readPage(QUERY), { list: [], total: 0 });
  assert.deepEqual(source.names, ["get_branch_detail", "query_lesson_list"]);
  assert.deepEqual(source.calls, [{ ...QUERY, limit: 10, over: 1, order: "asc" }]);
});

test("logical pages preserve the persisted hundred-row cursor and reserve every physical request", async () => {
  const source = fixture((args) => paged(113, args));
  let reservations = 0;
  const reader = provider(source, async () => { reservations += 1; });
  assert.deepEqual(await reader.readPage(QUERY), { list: Array.from({ length: 100 }, (_, i) => row(i)), total: 113 });
  assert.deepEqual(await reader.readPage({ ...QUERY, page: 2 }), { list: Array.from({ length: 13 }, (_, i) => row(100 + i)), total: 113 });
  assert.equal(reservations, 12);
  assert.deepEqual(source.calls.map(({ page }) => page), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(source.names.filter((name) => name === "get_branch_detail").length, 1);
});

test("a delayed MCP handshake cannot consume the interval before the first business request", async (context) => {
  let clock = Date.now();
  context.mock.method(Date, "now", () => clock);
  const starts: number[] = [];
  const source = fixture((args) => {
    starts.push(clock);
    return paged(20, args);
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    if (JSON.parse(String(init?.body)).method === "initialize") clock += 11_000;
    return source.fetchImpl(url, init);
  };
  let nextAllowed = clock;
  const reservations: number[] = [];
  await provider({ ...source, fetchImpl }, async () => {
    clock = Math.max(clock, nextAllowed);
    reservations.push(clock);
    nextAllowed = clock + 3_200;
  }).readPage(QUERY);
  assert.deepEqual(starts, reservations);
  assert.equal(starts[1]! - starts[0]!, 3_200);
});

test("truncated native content reduces page size at the absolute offset without dropping or repeating records", async () => {
  const source = fixture((args) => Number(args.limit) === 10 && Number(args.page) === 3
    ? { text: `{"truncated":"${"x".repeat(20_000)}` } : paged(113, args));
  let reservations = 0;
  const reader = provider(source, async () => { reservations += 1; });
  assert.deepEqual(await reader.readPage(QUERY), { list: Array.from({ length: 100 }, (_, i) => row(i)), total: 113 });
  assert.deepEqual(source.calls.slice(0, 4).map(({ page, limit }) => [page, limit]), [[1, 10], [2, 10], [3, 10], [5, 5]]);
  assert.equal(reservations, 19);
  await reader.readPage({ ...QUERY, page: 2 });
  assert.deepEqual(source.calls[19], { ...QUERY, page: 11, limit: 10, over: 1, order: "asc" });
});

test("the smallest supported native page still fits one worker and persistent truncation fails explicitly", async () => {
  const source = fixture((args) => Number(args.limit) === 10
    ? { text: `{"truncated":"${"x".repeat(20_000)}` } : paged(100, args));
  let reservations = 0;
  const result = await provider(source, async () => { assert.ok(++reservations <= 50); }).readPage(QUERY);
  assert.equal(result.list.length, 100);
  assert.equal(reservations, 21);
  const oversized = fixture(() => ({ text: `{"truncated":"${"x".repeat(20_000)}` }));
  await assert.rejects(provider(oversized).readPage(QUERY), errorCode("response_oversize"));
  assert.deepEqual(oversized.calls.map(({ limit }) => limit), [10, 5]);
});

test("budget interruption returns no partial page and a fresh worker retries the exact durable page", async () => {
  const source = fixture((args) => paged(100, args));
  const budgetError = new Error("synthetic worker budget");
  let reservations = 0;
  await assert.rejects(provider(source, async () => { if (++reservations > 3) throw budgetError; }).readPage(QUERY), (error) => error === budgetError);
  assert.equal(source.calls.length, 3);
  const result = await provider(source).readPage(QUERY);
  assert.deepEqual(result.list, Array.from({ length: 100 }, (_, i) => row(i)));
  assert.equal(source.calls[3].page, 1);
});

for (const [label, mutate] of [
  ["total drift", (data: ToolResult, args: Args) => ({ ...data, total: Number(args.page) > 1 ? "19" : "20" })],
  ["short page", (data: ToolResult) => ({ ...data, lists: data.lists.slice(0, -1) })],
  ["other member", (data: ToolResult) => ({ ...data, lists: data.lists.map((entry) => ({ ...entry, mem_id: "18" })) })],
  ["uncompleted lesson", (data: ToolResult) => ({ ...data, lists: data.lists.map((entry) => ({ ...entry, over: "0" })) })],
] as const) {
  test(`lesson MCP rejects ${label}`, async () => {
    const source = fixture((args) => mutate(paged(20, args), args));
    await assert.rejects(provider(source).readPage(QUERY), errorCode("invalid_response"));
  });
}

test("semantic supplier rate limiting stays retryable and never switches transport", async () => {
  const source = fixture(() => ({ error: true }));
  await assert.rejects(provider(source).readPage(QUERY), (error: unknown) => {
    assert.ok(error instanceof JiaowubaoOpenApiError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryAfterSeconds, 60);
    return true;
  });
  assert.equal(source.calls.length, 1);
});

test("valid native total drift before the first durable page is retryable without returning partial rows", async () => {
  let drift = true;
  const source = fixture((args) => paged(drift && Number(args.page) === 2 ? 21 : 20, args));
  const reader = provider(source);
  await assert.rejects(reader.readPage(QUERY), errorCode("upstream_unavailable"));
  assert.equal(source.calls.length, 2);
  drift = false;
  const result = await reader.readPage(QUERY);
  assert.equal(result.total, 20);
  assert.equal(result.list.length, 20);
  assert.equal(source.calls[2].page, 1);
});

test("valid native total drift on a later durable page stays a deterministic validation failure", async () => {
  const source = fixture((args) => paged(Number(args.page) === 12 ? 129 : 130, args));
  await assert.rejects(provider(source).readPage({ ...QUERY, page: 2 }), errorCode("invalid_response"));
  assert.deepEqual(source.calls.map(({ page }) => page), [11, 12]);
});

test("MCP configuration, deadline and native query constraints fail before business reads", async () => {
  assert.throws(() => createJiaowubaoCompletedLessonReader({
    env: { JIAOWUBAO_SCHEDULE_SOURCE: "mcp" }, beforeRequest: async () => undefined, deadlineAt: Date.now() + 1_000,
  }), errorCode("not_configured"));
  const source = fixture((args) => paged(0, args));
  const native = createJiaowubaoMcpCompletedLessonReader({ token: TOKEN, fetchImpl: source.fetchImpl });
  for (const query of [
    { ...QUERY, limit: 11 }, { ...QUERY, limit: 10, sign: 1 }, { ...QUERY, limit: 10, mem_id: 0 },
    { ...QUERY, limit: 10, start: "2026-10-00" }, { ...QUERY, limit: 10, end: "2026-11-01" },
    { ...QUERY, limit: 10, over: 0 },
  ]) await assert.rejects(native(query), errorCode("invalid_request"));
  await assert.rejects(native({ ...QUERY, limit: 10 }, { deadlineAt: Date.now() - 1 }), errorCode("request_timeout"));
  assert.equal(source.calls.length, 0);
});
