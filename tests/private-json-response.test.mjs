import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/private-json-response.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require, Buffer, Headers });
const { privateJsonResponse } = exports;
test("large private state is compressed without dropping any row", async () => {
  const payload = { rows: [{ entity: "messages", payload: "synthetic-state-".repeat(25000) }] };
  const response = privateJsonResponse(payload, new Request("http://localhost/", { headers: { "accept-encoding": "br, gzip" } }));
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Accept-Encoding");
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()), payload);
});
test("small bodies and clients declining gzip retain plain JSON", async () => {
  for (const [payload, encoding] of [[{ ok: true }, "gzip"], [{ rows: "x".repeat(150000) }, "gzip;q=0, br"], [{ rows: "x".repeat(150000) }, "br"]]) {
    const response = privateJsonResponse(payload, new Request("http://localhost/", { headers: { "accept-encoding": encoding } }));
    assert.equal(response.headers.get("content-encoding"), null);
    assert.deepEqual(await response.json(), payload);
  }
});
