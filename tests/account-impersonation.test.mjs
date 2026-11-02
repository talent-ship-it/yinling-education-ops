import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as tokens from "../lib/demo-session-token.ts";
import * as teacherLogin from "../lib/demo-teacher-login.ts";
import * as users from "../lib/demo-users.ts";


const require = createRequire(import.meta.url);
function load(relative, dependencies) {
  const executable = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(executable, { exports, Buffer, URL, process: { env: { DEMO_SESSION_SECRET: "01".repeat(32) } },
    require: (id) => {
      if (id === "server-only") return {};
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (/^(?:node:|next\/server$)/u.test(id)) return require(id);
      throw new Error(`Unmocked server dependency: ${id}`);
    },
  });
  return exports;
}
const credentials = load("../lib/account-credentials.ts", {});
const actorToken = tokens.createServerSessionToken();
const targetToken = tokens.createServerSessionToken();
const actor = { user: users.DEMO_ADMIN_USER, role: "admin", accountId: "10000000-0000-4000-8000-000000000001", sessionId: actorToken.sessionId, permissions: ["*"], scopeMembers: [{ kind: "all", key: "*" }] };
const target = { session_id: targetToken.sessionId, account_id: "20000000-0000-4000-8000-000000000002", account_name: "Synthetic Teacher", account_role: "teacher", credential_version: 2, access_version: 3, role_version: 1, scope_version: 2, mfa_verified: true, must_change_password: false, permissions: ["operations.read", "classroom.join"], scope_members: [{ kind: "teacher", key: "T1" }] };
function fixture(overrides = {}) {
  const calls = [];
  const store = { getAccountSession: async (hash) => { calls.push(hash); return target; }, getOpsState: async () => [{ entity: "teachers", payload: [{ id: "T1", name: target.account_name }] }], revokeCurrentAccountSession: async (envelope) => { calls.push(envelope); return { revoked_session_count: 1 }; }, ...overrides };
  const impersonation = load("../lib/account-impersonation.ts", {
    "@/lib/account-credentials": credentials, "@/lib/demo-session-token": tokens,
    "@/lib/demo-teacher-login": teacherLogin, "@/lib/ops-store": store,
    "@/lib/nixon-auth": { hasFullAdminAccess: (identity, elevation) => identity.user === actor.user && identity.permissions.includes("*") && elevation === "elevated" },
  });
  const token = impersonation.createImpersonationToken({ actorAccountId: actor.accountId, actorSessionId: actor.sessionId, targetAccountId: target.account_id, identityKey: credentials.accountIdentityKey(target.account_name, target.account_role), targetSessionToken: targetToken.token });
  return { module: impersonation, token, calls };
}
test("switched identity uses target ledger, permissions, scope and session", async () => {
  const f = fixture();
  const result = await f.module.resolveImpersonatedSession({ actor, token: f.token, elevationCookie: "elevated" });
  assert.equal(result.session.user, target.account_name);
  assert.equal(result.session.accountId, target.account_id);
  assert.equal(result.session.sessionId, targetToken.sessionId);
  assert.deepEqual(Array.from(result.session.permissions), target.permissions);
  assert.equal(result.session.scopeMembers[0].key, "T1");
  assert.equal(result.session.permissions.includes("*"), false);
  assert.equal(result.session.impersonator.accountId, actor.accountId);
  assert.equal(f.calls[0], targetToken.tokenHash);
});
test("switch claim rejects tampering, expiry, other administrator session and missing elevation", async () => {
  const f = fixture();
  assert.equal(f.module.parseImpersonationToken(`${f.token}x`), null);
  assert.equal(f.module.parseImpersonationToken(f.token, Date.now() + 3_600_001), null);
  for (const input of [{ actor: { ...actor, sessionId: "other" }, elevationCookie: "elevated" }, { actor, elevationCookie: "missing" }, { actor: { ...actor, permissions: [] }, elevationCookie: "elevated" }]) {
    assert.equal((await f.module.resolveImpersonatedSession({ ...input, token: f.token })).status, 403);
  }
  assert.equal(f.calls.length, 0);
});
test("revoked target sessions, account mismatch and roster loss deny the switched request", async () => {
  for (const overrides of [{ getAccountSession: async () => null }, { getAccountSession: async () => ({ ...target, account_id: actor.accountId }) }, { getOpsState: async () => [{ entity: "teachers", payload: [] }] }]) {
    const f = fixture(overrides);
    assert.equal((await f.module.resolveImpersonatedSession({ actor, token: f.token, elevationCookie: "elevated" })).status, 403);
  }
  const f = fixture({ getAccountSession: async () => { throw new Error("offline"); } });
  assert.equal((await f.module.resolveImpersonatedSession({ actor, token: f.token, elevationCookie: "elevated" })).status, 503);
});
test("returning from a switched account revokes only the target ledger session", async () => {
  const f = fixture();
  await f.module.revokeImpersonationSession(f.token);
  assert.equal(f.calls[0].sessionId, targetToken.sessionId);
  assert.notEqual(f.calls[0].sessionId, actorToken.sessionId);
});
test("identity route enforces administrator, active target and same origin and sets no original cookie", async () => {
  const f = fixture();
  let allowed = true;
  let active = true;
  const created = [];
  const jar = new Map([["auth", actorToken.token], ["elevation", "elevated"]]);
  const route = load("../app/api/account/identity/route.ts", {
    "next/headers": { cookies: async () => ({ get: (name) => jar.has(name) ? { value: jar.get(name) } : undefined }) },
    "@/lib/account-impersonation": { ...f.module, resolveImpersonatedSession: async () => ({ session: { ...actor, user: target.account_name, role: "teacher" } }) },
    "@/lib/demo-auth": { DEMO_COOKIE_NAME: "auth", getCurrentDemoSession: async (_cookie, options) => { assert.equal(options.ignoreImpersonation, true); return { session: actor }; } },
    "@/lib/nixon-auth": { hasFullAdminAccess: () => allowed, NIXON_COOKIE_NAME: "elevation" },
    "@/lib/demo-session-token": tokens,
    "@/lib/ops-store": { getAccountDirectory: async () => [{ account_id: target.account_id, account_name: target.account_name, account_role: "teacher", identity_key: credentials.accountIdentityKey(target.account_name, "teacher"), status: active ? "active" : "disabled", access_version: 3, credential_version: 2 }], createAccountImpersonationSession: async (input) => { created.push(input); return { session_id: input.sessionId, account_id: input.targetAccountId }; } },
  });
  const request = (origin = "https://fixture.test") => new Request("https://fixture.test/api/account/identity", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify({ accountId: target.account_id }) });
  assert.equal((await route.POST(request("https://other.test"))).status, 403);
  allowed = false; assert.equal((await route.POST(request())).status, 403);
  allowed = true; active = false; assert.equal((await route.POST(request())).status, 403);
  active = true;
  const response = await route.POST(request());
  assert.equal(response.status, 200);
  assert.equal(created.length, 1);
  assert.equal(created[0].actorAccountId, actor.accountId);
  assert.equal(created[0].targetAccountId, target.account_id);
  assert.match(response.headers.get("set-cookie"), /yinling_account_identity=.*HttpOnly.*SameSite=strict/i);
  assert.equal(response.cookies.get("auth"), undefined);
  const restored = await route.DELETE(new Request("https://fixture.test/api/account/identity", { method: "DELETE", headers: { origin: "https://fixture.test" } }));
  assert.equal(restored.status, 200);
  assert.equal(restored.cookies.get("yinling_account_identity").value, "");
});
