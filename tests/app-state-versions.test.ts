import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as access from "../lib/ops-access";
import type { DemoSessionIdentity } from "../lib/demo-session-token";

const source = readFileSync(new URL("../app/api/app-state/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const versions = ["students", "teachers", "bookings", "tasks", "audit", "payroll", "rules", "dataSnapshot"].map((entity) => ({
  entity, version: 4, updated_at: "2026-11-24T00:00:00Z", updated_by: "Synthetic Operator",
}));
function reader(identity: DemoSessionIdentity | null, fullAdmin = false, unavailable = false) {
  let versionReads = 0;
  let payloadReads = 0;
  const exports: { GET?: (request: unknown) => Promise<Response> } = {};
  runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (name === "next/headers") return { cookies: async () => ({ get: () => undefined }) };
      if (name === "next/server") return { NextResponse: { json: Response.json } };
      if (name === "@/lib/demo-auth") return { getCurrentDemoSession: async () => identity ? { session: identity } : { error: "unauthorized", status: 401 } };
      if (name === "@/lib/ops-access") return access;
      if (name === "@/lib/nixon-auth") return { hasFullAdminAccess: () => fullAdmin };
      if (name === "@/lib/ops-store") return {
        getOpsVersions: async () => { versionReads += 1; if (unavailable) throw new Error("unavailable"); return versions; },
        getOpsState: async () => { payloadReads += 1; throw new Error("version probes must not read payloads"); },
      };
      return {};
    },
  });
  return { get: () => exports.GET!({ nextUrl: new URL("https://synthetic.invalid/api/app-state?mode=versions") }), counts: () => ({ versionReads, payloadReads }) };
}

test("version probes return metadata without reading any state payload", async () => {
  const api = reader({ user: "Admin", role: "admin", permissions: ["*"] }, true);
  const response = await api.get();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).versions, versions);
  assert.deepEqual(api.counts(), { versionReads: 1, payloadReads: 0 });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("metadata probes preserve current role, permission and entity-scope restrictions", async () => {
  const cases: Array<{ identity: DemoSessionIdentity; allowed: string[] }> = [
    { identity: { user: "Abby", role: "staff", permissions: ["operations.read"] }, allowed: ["students", "teachers", "bookings", "tasks"] },
    { identity: { user: "Synthetic Teacher", role: "teacher", permissions: ["bookings.read.assigned"] }, allowed: ["teachers", "bookings"] },
    { identity: { user: "Admin", role: "admin", permissions: [] }, allowed: [] },
    { identity: { user: "Ops Admin", role: "limited-admin", permissions: ["operations.read"], scopeMembers: [{ kind: "student", key: "SYNTHETIC" }] }, allowed: ["students", "teachers", "bookings", "tasks", "rules", "dataSnapshot"] },
    { identity: { user: "Abby", role: "staff", permissions: ["operations.read"], scopeMembers: [{ kind: "entity", key: "tasks" }] }, allowed: ["tasks"] },
  ];
  for (const { identity, allowed } of cases) {
    const api = reader(identity);
    const response = await api.get();
    assert.equal(response.status, 200, identity.role);
    assert.deepEqual((await response.json()).versions.map((row: { entity: string }) => row.entity), allowed);
    assert.deepEqual(api.counts(), { versionReads: 1, payloadReads: 0 });
  }
});

test("version probes reject expired sessions before reading metadata", async () => {
  const api = reader(null);
  assert.equal((await api.get()).status, 401);
  assert.deepEqual(api.counts(), { versionReads: 0, payloadReads: 0 });
});

test("failed metadata reads return unavailable rather than stale versions", async () => {
  const api = reader({ user: "Abby", role: "staff", permissions: ["operations.read"] }, false, true);
  assert.equal((await api.get()).status, 503);
  assert.deepEqual(api.counts(), { versionReads: 1, payloadReads: 0 });
});
