import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { createJiaowubaoMcpScheduleReader } from "../lib/jiaowubao-mcp-node";
import { JiaowubaoOpenApiError } from "../lib/jiaowubao-open-api-node";
import { jiaowubaoScheduleSourcePageRows } from "../lib/jiaowubao-open-api-schedule-snapshot";

const TOKEN = "SyntheticMCPtoken-OnlyForLocalTests";
const MCP_URL = "https://card.jwbpro.com/open/jwb/mcp";
const QUERY = { start: "2026-10-15", end: "2026-10-16", page: 1, limit: 100, order: "asc" } as const;
const ROW = {
  cal_id: "12345678", type: "1", appoint: "0", teacher_id: "17", teacher_title: "Synthetic Teacher",
  teacher_s: "0", teacher_s_title: "", teacher_t: "0", teacher_t_title: "",
  dated: "2026-10-15", time_start: "09:00", time_end: "10:00", mem_num: "1", over: "0",
  stu_list: [{ lesson_id: "9001", mem_id: "8001", type: "1", name: "Synthetic Student" }],
};
type Message = { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> };
type Handler = (message: Message, response: ServerResponse, request: IncomingMessage) => void;

function reply(message: Message, response: ServerResponse, result?: unknown, sse = false) {
  if (message.method === "notifications/initialized") {
    response.writeHead(202).end();
    return;
  }
  const payload = { jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
    ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } } : result };
  response.writeHead(200, { "Content-Type": sse ? "text/event-stream" : "application/json", "Mcp-Session-Id": "synthetic-session" });
  response.end(sse ? `: heartbeat\r\nid: discarded\r\nretry: 1\r\nevent: message\r\n${JSON.stringify(payload, null, 2).split("\n").map((line) => `data: ${line}\r\n`).join("")}\r\n` : JSON.stringify(payload));
}

async function loopback(handler?: Handler) {
  const messages: Message[] = [];
  const headers: IncomingMessage["headers"][] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as Message;
    messages.push(message);
    headers.push(request.headers);
    if (handler) return handler(message, response, request);
    reply(message, response, { content: [{ type: "text", text: JSON.stringify({ total: "1", is_more: "0", lists: [ROW] }) }] });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const nativeFetch = globalThis.fetch;
  const fetchImpl: typeof fetch = (url, init) => {
    assert.equal(String(url), MCP_URL);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.method, "POST");
    return nativeFetch(`http://127.0.0.1:${address.port}/mcp`, init);
  };
  return {
    fetchImpl, messages, headers,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

test("MCP JSON handshake returns unchanged schedule records from content text", async () => {
  const fixture = await loopback();
  try {
    const reader = createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl });
    assert.deepEqual(await reader(QUERY), { lists: [ROW] });
    assert.deepEqual(fixture.messages.map(({ method }) => method), ["initialize", "notifications/initialized", "tools/call"]);
    assert.deepEqual(fixture.messages[2]!.params, { name: "query_schedule_list", arguments: { ...QUERY, detail: 1 } });
    assert.equal(fixture.headers[0]!.authorization, `Bearer ${TOKEN}`);
    assert.equal(fixture.headers[1]!["mcp-session-id"], "synthetic-session");
    assert.equal(fixture.headers[2]!["mcp-session-id"], "synthetic-session");
  } finally {
    await fixture.close();
  }
});

test("MCP accepts one SSE message with comments, CRLF and multiline data", async () => {
  const fixture = await loopback((message, response) => reply(message, response, {
    content: [{ type: "text", text: JSON.stringify({ total: "1", is_more: "0", lists: [ROW] }) }],
  }, true));
  try {
    assert.deepEqual(await createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl })(QUERY), { lists: [ROW] });
  } finally {
    await fixture.close();
  }
});

async function expectFailure(handler: Handler, code: string, options = {}) {
  const fixture = await loopback(handler);
  try {
    const reader = createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl });
    await assert.rejects(reader(QUERY, options), (error: unknown) => {
      assert.ok(error instanceof JiaowubaoOpenApiError);
      assert.equal(error.code, code);
      assert.equal(String(error).includes(TOKEN), false);
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      assert.equal(error.stack?.includes(TOKEN), false);
      return true;
    });
    return fixture.messages.length;
  } finally {
    await fixture.close();
  }
}

for (const [status, code] of [[302, "upstream_rejected"], [503, "upstream_unavailable"], [401, "not_authorized"], [429, "rate_limited"]] as const) {
  test(`MCP refuses HTTP ${status} without redirect or retry`, async () => {
    const count = await expectFailure((message, response) => {
      response.writeHead(status, { "Content-Type": "application/json", Location: "http://127.0.0.1:1/forbidden", "Retry-After": "30" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } }, tokenEcho: TOKEN }));
    }, code);
    assert.equal(count, 1);
  });
}

test("MCP sanitizes malformed JSON even when it echoes the token", async () => {
  assert.equal(await expectFailure((_message, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end(TOKEN);
  }, "invalid_response"), 1);
});

test("MCP rejects JSON-RPC errors without publishing their messages", async () => {
  assert.equal(await expectFailure((message, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: TOKEN } }));
  }, "upstream_rejected"), 1);
});

test("MCP rejects tool error envelopes instead of treating them as an empty page", async () => {
  assert.equal(await expectFailure((message, response) => reply(message, response, { isError: true, content: [{ type: "text", text: TOKEN }] }), "upstream_rejected"), 3);
});

test("MCP timeout includes the whole handshake and body read budget", async () => {
  const count = await expectFailure((message, response) => {
    setTimeout(() => reply(message, response, { content: [{ type: "text", text: JSON.stringify({ total: "1", is_more: "0", lists: [ROW] }) }] }), 150);
  }, "request_timeout", { deadlineAt: Date.now() + 50 });
  assert.equal(count, 1);
});

test("MCP caps response bytes before JSON decoding", async () => {
  assert.equal(await expectFailure((message, response) => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, padding: "x".repeat(1_048_576) } });
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }).end(payload);
  }, "response_oversize"), 1);
});

function businessResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

test("MCP keeps one session across is_more pages and passes the same canonical staging rows", async () => {
  const rows = [ROW, { ...ROW, cal_id: "12345679" }];
  const fixture = await loopback((message, response) => {
    const page = (message.params?.arguments as { page?: number } | undefined)?.page ?? 1;
    reply(message, response, businessResult({ total: "2", is_more: page === 1 ? "1" : "0", lists: page <= 2 ? [rows[page - 1]] : [] }));
  });
  try {
    const reader = createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl });
    for (const page of [1, 2, 3]) {
      const result = await reader({ ...QUERY, page, limit: 1 });
      assert.deepEqual(jiaowubaoScheduleSourcePageRows(result), jiaowubaoScheduleSourcePageRows({ lists: page <= 2 ? [rows[page - 1]!] : [] }));
    }
    assert.deepEqual(fixture.messages.map(({ method }) => method), ["initialize", "notifications/initialized", "tools/call", "tools/call", "tools/call"]);
  } finally {
    await fixture.close();
  }
});

for (const [label, data] of [
  ["short nonterminal page", { total: "2", is_more: "1", lists: [ROW] }],
  ["false terminal flag", { total: "2", is_more: "0", lists: [ROW] }],
  ["missing pagination", { lists: [ROW] }],
  ["ambiguous flag", { total: "1", is_more: "true", lists: [ROW] }],
  ["negative total", { total: "-1", is_more: "0", lists: [] }],
  ["business failure", { ret: "0", total: "0", is_more: "0", lists: [] }],
  ["malformed cal_id", { total: "1", is_more: "0", lists: [{ ...ROW, cal_id: " 12345678 " }] }],
  ["credential echo in records", { total: "1", is_more: "0", lists: [{ ...ROW, future_field: TOKEN }] }],
] as const) {
  test(`MCP fails closed on ${label}`, async () => {
    const count = await expectFailure((message, response) => reply(message, response, businessResult(data)), label === "business failure" ? "upstream_rejected" : "invalid_response");
    assert.equal(count, 3);
  });
}

test("MCP validates only bounded unfiltered schedule arguments before any request", async () => {
  const fixture = await loopback();
  try {
    const reader = createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl });
    for (const query of [
      { ...QUERY, start: "2026-02-30" }, { ...QUERY, end: "2026-11-16" },
      { ...QUERY, page: 0 }, { ...QUERY, limit: 101 }, { ...QUERY, order: "bad" },
      { ...QUERY, teacher_id: 17 }, { ...QUERY, detail: 0 }, { ...QUERY, tool: "set_teacher_leave" },
    ]) {
      await assert.rejects(reader(query as typeof QUERY), (error: unknown) => error instanceof JiaowubaoOpenApiError && error.code === "invalid_request");
    }
    assert.equal(fixture.messages.length, 0);
  } finally {
    await fixture.close();
  }
});

test("MCP rejects session replacement rather than reinitializing", async () => {
  assert.equal(await expectFailure((message, response) => {
    if (message.method !== "tools/call") return reply(message, response);
    response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "changed-session" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: businessResult({ total: "1", is_more: "0", lists: [ROW] }) }));
  }, "invalid_response"), 3);
});

test("MCP optionally verifies the institution once before reading schedule pages", async () => {
  const fixture = await loopback((message, response) => reply(message, response, message.params?.name === "get_branch_detail"
    ? businessResult({ branch: { title: "Synthetic Institution", branch_id: "17" } })
    : businessResult({ total: "1", is_more: "0", lists: [ROW] })));
  try {
    const reader = createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl, expectedBranchTitle: "Synthetic Institution", expectedBranchId: "17" });
    await reader(QUERY);
    await reader(QUERY);
    assert.deepEqual(fixture.messages.filter(({ method }) => method === "tools/call").map(({ params }) => params?.name), ["get_branch_detail", "query_schedule_list", "query_schedule_list"]);
  } finally {
    await fixture.close();
  }
});

test("MCP institution mismatch fails before any business read", async () => {
  const fixture = await loopback((message, response) => reply(message, response, businessResult({ branch: { title: "Other Synthetic Institution", branch_id: "18" } })));
  try {
    const reader = createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl, expectedBranchTitle: "Synthetic Institution", expectedBranchId: "17" });
    await assert.rejects(reader(QUERY), (error: unknown) => error instanceof JiaowubaoOpenApiError && error.code === "upstream_rejected");
    assert.deepEqual(fixture.messages.filter(({ method }) => method === "tools/call").map(({ params }) => params?.name), ["get_branch_detail"]);
  } finally {
    await fixture.close();
  }
});

for (const protocolVersion of ["2025-03-26", "unsupported-version"]) {
  test(`MCP negotiates only supported protocol version ${protocolVersion}`, async () => {
    const fixture = await loopback((message, response) => {
      if (message.method !== "initialize") return reply(message, response, businessResult({ total: "1", is_more: "0", lists: [ROW] }));
      response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "synthetic-session" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion, capabilities: { tools: {} } } }));
    });
    try {
      const reader = createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl });
      if (protocolVersion === "unsupported-version") {
        await assert.rejects(reader(QUERY), (error: unknown) => error instanceof JiaowubaoOpenApiError && error.code === "invalid_response");
        assert.equal(fixture.messages.length, 1);
      } else {
        await reader(QUERY);
        assert.equal(fixture.headers[2]?.["mcp-protocol-version"], protocolVersion);
      }
    } finally {
      await fixture.close();
    }
  });
}

test("MCP rejects invalid Bearer tokens before sending", async () => {
  const fixture = await loopback();
  try {
    for (const token of ["", "synthetic\r\nheader", " leading-space", "x".repeat(4097)]) {
      assert.throws(() => createJiaowubaoMcpScheduleReader({ token, fetchImpl: fixture.fetchImpl }), (error: unknown) => error instanceof JiaowubaoOpenApiError && error.code === "not_configured");
    }
    assert.equal(fixture.messages.length, 0);
  } finally {
    await fixture.close();
  }
});

test("MCP rejects nonempty initialized notification acknowledgements", async () => {
  assert.equal(await expectFailure((message, response) => {
    if (message.method !== "notifications/initialized") return reply(message, response, businessResult({ total: "1", is_more: "0", lists: [ROW] }));
    response.writeHead(202, { "Transfer-Encoding": "chunked" }).end("not-empty");
  }, "invalid_response"), 2);
});

test("MCP rejects compressed responses instead of inheriting decompression", async () => {
  assert.equal(await expectFailure((message, response) => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
    response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" }).end(gzipSync(payload));
  }, "invalid_response"), 1);
});

test("MCP accepts a completed SSE message without waiting for stream EOF", async () => {
  const fixture = await loopback((message, response) => {
    if (message.method !== "tools/call") return reply(message, response);
    const result = businessResult({ total: "1", is_more: "0", lists: [ROW] });
    response.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "synthetic-session" });
    response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  });
  try {
    const reader = createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl });
    assert.deepEqual(await reader(QUERY, { deadlineAt: Date.now() + 500 }), { lists: [ROW] });
    assert.equal(fixture.messages.length, 3);
  } finally {
    await fixture.close();
  }
});

test("MCP body stalls are bounded by the original read deadline", async () => {
  assert.equal(await expectFailure((message, response) => {
    if (message.method !== "tools/call") return reply(message, response);
    response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "synthetic-session" });
    response.write("{");
  }, "request_timeout", { deadlineAt: Date.now() + 100 }), 3);
});

test("MCP rejects oversized chunked bodies with no declared length", async () => {
  assert.equal(await expectFailure((message, response) => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, padding: "x".repeat(1_048_576) } });
    response.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }).end(payload);
  }, "response_oversize"), 1);
});

test("MCP does not send when the read deadline already expired", async () => {
  const fixture = await loopback();
  try {
    const reader = createJiaowubaoMcpScheduleReader({ token: TOKEN, fetchImpl: fixture.fetchImpl });
    await assert.rejects(reader(QUERY, { deadlineAt: Date.now() - 1 }), (error: unknown) => error instanceof JiaowubaoOpenApiError && error.code === "request_timeout");
    assert.equal(fixture.messages.length, 0);
  } finally {
    await fixture.close();
  }
});




