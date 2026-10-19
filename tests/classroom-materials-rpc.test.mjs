import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

import * as validators from "../lib/classroom-materials.ts";

const source = ts.transpileModule(readFileSync(new URL("../lib/classroom-materials-store.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const environment = {
  NEXT_PUBLIC_SUPABASE_URL: `https://${validators.MATERIALS_PROJECT_REF}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "synthetic-public-key", OPS_API_SECRET: "synthetic-ops-secret",
};
function database(payload, status = 200) {
  const requests = [];
  const exports = {};
  vm.runInNewContext(source, {
    exports, process: { env: environment }, AbortSignal,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (payload instanceof Error) throw payload;
      return new Response(JSON.stringify(payload), { status });
    },
    require: (id) => {
      if (id === "server-only" || id === "@/lib/classroom-materials-storage") return {};
      if (id === "@/lib/classroom-materials") return validators;
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return { api: exports, requests };
}

test("materials RPC sends the server-owned account and secret without caching", async () => {
  const { api, requests } = database({ folders: [] });
  const result = await api.materialRpc("synthetic-account", "list", { limit: 100 });
  assert.equal(Array.isArray(result.folders), true);
  assert.equal(requests[0].url, `${environment.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/classroom_materials_request`);
  assert.deepEqual(JSON.parse(requests[0].init.body), { p_secret: environment.OPS_API_SECRET, p_account_id: "synthetic-account", p_operation: "list", p_payload: { limit: 100 } });
  assert.equal(requests[0].init.cache, "no-store");
});

test("materials RPC exposes only known authorization errors and fails closed on provider failures", async () => {
  for (const [code, status] of [["materials_forbidden", 403], ["materials_not_found", 404], ["materials_conflict", 409], ["materials_invalid_input", 400]]) {
    const { api } = database({ message: code, details: "synthetic-private-detail" }, 400);
    await assert.rejects(api.materialRpc("synthetic-account", "list"), (error) => error.code === code && error.status === status && !error.message.includes("private-detail"));
  }
  for (const message of ["unknown-private-provider-message", "constructor", "__proto__", null]) {
    const { api } = database({ message }, 500);
    await assert.rejects(api.materialRpc("synthetic-account", "list"), (error) => error.code === "materials_contract_unavailable" && error.status === 503);
  }
  await assert.rejects(database(new Error("synthetic network failure")).api.materialRpc("synthetic-account", "list"), (error) => error.code === "materials_unavailable" && error.status === 503);
});
