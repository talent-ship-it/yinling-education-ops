import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as rpcBudget from "../lib/ops-rpc-budget";
import type { UnclosedLesson } from "../lib/jiaowubao-unclosed-lessons";

type Store = typeof import("../lib/ops-store");
type Reply = { status: number; body?: unknown };
const runId = "71000000-0000-4000-8000-000000000001";
const checkedAt = "2026-10-26T02:00:00.000Z";
const lesson: UnclosedLesson = { eventId: "jwb-open-api:schedule:1", date: "2026-10-24", courseName: null, participants: [], firstDetectedAt: checkedAt, lastSeenAt: checkedAt };
const revision = `sha256:${"a".repeat(64)}`;
const voidNames = ["begin_jiaowubao_unclosed_snapshot", "stage_jiaowubao_unclosed_snapshot", "abort_jiaowubao_unclosed_snapshot"];

function moduleSource(path: string) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}

function offlineModule<T>(path: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const exports = {};
  runInNewContext(moduleSource(path), { exports, require: (name: string) => {
    assert.ok(name in dependencies, `Unexpected offline dependency: ${name}`);
    return dependencies[name];
  }, Buffer, Date, AbortController, setTimeout, clearTimeout, ...globals });
  return exports as T;
}

async function fixture(overrides: Record<string, Reply> = {}) {
  const calls: string[] = [];
  const responses: { status: number; noBody: boolean }[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { void _chunk; }
    const name = new URL(request.url!, "http://localhost").pathname.split("/").at(-1)!;
    calls.push(name);
    const defaults: Reply = voidNames.includes(name) ? { status: 204 } : { status: 200, body: name === "read_jiaowubao_unclosed_snapshot" ? { revision: null, checkedAt: null, lessons: [] } : { revision, rowCount: 1 } };
    const reply = overrides[name] ?? defaults;
    response.writeHead(reply.status, reply.body === undefined ? {} : { "Content-Type": "application/json" });
    response.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const nativeFetch = globalThis.fetch;
  const fixtureFetch: typeof fetch = async (url, options) => {
    assert.equal(new URL(String(url)).origin, `http://127.0.0.1:${address.port}`);
    const response = await nativeFetch(url, options);
    responses.push({ status: response.status, noBody: response.body === null });
    return response;
  };
  const store = offlineModule<Store>("../lib/ops-store.ts", { "server-only": {}, "@/lib/ops-rpc-budget": rpcBudget }, {
    fetch: fixtureFetch,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${address.port}`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable-key", OPS_API_SECRET: "synthetic-ops-secret" } },
  });
  return { store, calls, responses, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

const voidCalls: Record<string, (store: Store) => Promise<void>> = {
  begin_jiaowubao_unclosed_snapshot: (store) => store.beginJiaowubaoUnclosedSnapshot({ runId, expectedRevision: null, checkedAt, rowCount: 1 }),
  stage_jiaowubao_unclosed_snapshot: (store) => store.stageJiaowubaoUnclosedSnapshot({ runId, pageIndex: 0, rows: [lesson] }),
  abort_jiaowubao_unclosed_snapshot: (store) => store.abortJiaowubaoUnclosedSnapshot(runId),
};
for (const [name, call] of Object.entries(voidCalls)) {
  test(`${name} accepts a real fetch HTTP 204 response without JSON`, async () => {
    const f = await fixture();
    try {
      assert.equal(await call(f.store), undefined);
      assert.deepEqual(f.calls, [name]);
      assert.deepEqual(f.responses, [{ status: 204, noBody: true }]);
    } finally { await f.close(); }
  });
}

const structuredCalls: Record<string, (store: Store) => Promise<unknown>> = {
  read_jiaowubao_unclosed_snapshot: (store) => store.readJiaowubaoUnclosedSnapshot(),
  complete_jiaowubao_unclosed_snapshot: (store) => store.completeJiaowubaoUnclosedSnapshot(runId),
  get_ops_state: (store) => store.getOpsState(["tasks"]),
};
for (const [name, call] of Object.entries(structuredCalls)) {
  test(`${name} continues rejecting an empty HTTP 204 receipt`, async () => {
    const f = await fixture({ [name]: { status: 204 } });
    try {
      await assert.rejects(call(f.store), (error: unknown) => error instanceof f.store.OpsStoreError && error.code === "invalid_response");
    } finally { await f.close(); }
  });
}

test("void RPCs still reject empty HTTP 200 and preserve structured failures", async () => {
  for (const reply of [{ status: 200 }, { status: 409, body: { code: "40001", message: "synthetic_stage_conflict" } }]) {
    const f = await fixture({ begin_jiaowubao_unclosed_snapshot: reply });
    try {
      await assert.rejects(voidCalls.begin_jiaowubao_unclosed_snapshot!(f.store), (error: unknown) => error instanceof f.store.OpsStoreError && error.code === (reply.status === 200 ? "invalid_response" : "40001"));
    } finally { await f.close(); }
  }
});

function sync(store: Store) {
  return offlineModule<typeof import("../lib/jiaowubao-unclosed-sync")>("../lib/jiaowubao-unclosed-sync.ts", {
    "node:crypto": { randomUUID }, "./ops-store": store,
    "./jiaowubao-unclosed-collector": { unclosedPageReader: () => null, collectUnclosedLessons: async () => ({ lessons: [lesson], calls: 1 }) },
  }).syncJiaowubaoUnclosedLessons(new Date(checkedAt));
}

test("the sync reaches publication through real empty begin and stage acknowledgements", async () => {
  const f = await fixture();
  try {
    const result = await sync(f.store);
    assert.equal(result.rowCount, 1);
    assert.equal(result.calls, 1);
    assert.deepEqual(f.calls, ["read_jiaowubao_unclosed_snapshot", "begin_jiaowubao_unclosed_snapshot", "stage_jiaowubao_unclosed_snapshot", "complete_jiaowubao_unclosed_snapshot"]);
  } finally { await f.close(); }
});

test("a failed HTTP stage calls the real empty abort RPC and never publishes", async () => {
  const f = await fixture({ stage_jiaowubao_unclosed_snapshot: { status: 409, body: { code: "40001", message: "synthetic_stage_conflict" } } });
  try {
    await assert.rejects(sync(f.store), (error: unknown) => error instanceof f.store.OpsStoreError && error.code === "40001");
    assert.deepEqual(f.calls, ["read_jiaowubao_unclosed_snapshot", "begin_jiaowubao_unclosed_snapshot", "stage_jiaowubao_unclosed_snapshot", "abort_jiaowubao_unclosed_snapshot"]);
    assert.deepEqual(f.responses.at(-1), { status: 204, noBody: true });
  } finally { await f.close(); }
});
