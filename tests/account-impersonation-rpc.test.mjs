import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as budget from "../lib/ops-rpc-budget.ts";

const source = ts.transpileModule(readFileSync(new URL("../lib/ops-store.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const input = { actorAccountId: "actor", actorSessionId: "actor-session", targetAccountId: "target", sessionId: "target-session", tokenHash: "a".repeat(64), expectedCredentialVersion: 1, expectedAccessVersion: 2 };
function fixture(codes) {
  const requests = [];
  const exports = {};
  vm.runInNewContext(source, { exports, Buffer, AbortController, setTimeout, clearTimeout,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://offline.synthetic.test", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-public", OPS_API_SECRET: "synthetic-ops" } },
    fetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      const code = codes[requests.length - 1];
      return code ? Response.json({ code, message: "synthetic_failure" }, { status: 500 }) : Response.json([{ session_id: input.sessionId, account_id: input.targetAccountId }]);
    },
    require: (id) => {
      if (id === "server-only") return {};
      if (id === "@/lib/ops-rpc-budget") return budget;
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return { api: exports, requests };
}

test("switch retries rolled-back lock failures with the exact same session token", async () => {
  const f = fixture(["55P03", "40P01"]);
  const result = await f.api.createAccountImpersonationSession(input);
  assert.equal(result.session_id, input.sessionId);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[1], f.requests[0]);
  assert.deepEqual(f.requests[2], f.requests[0]);
});

test("switch stops after bounded contention and never retries authorization, stale state or unknown failures", async () => {
  const busy = fixture(Array(4).fill("55P03"));
  await assert.rejects(busy.api.createAccountImpersonationSession(input), (error) => error.code === "55P03");
  assert.equal(busy.requests.length, 4);
  for (const code of ["42501", "40001", "timeout", "unknown"]) {
    const f = fixture([code]);
    await assert.rejects(f.api.createAccountImpersonationSession(input), (error) => error.code === code);
    assert.equal(f.requests.length, 1);
  }
});
