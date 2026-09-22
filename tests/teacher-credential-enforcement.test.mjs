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
// Execute the actual server modules with only their external I/O substituted.
// No production credentials, database connection, or customer fixtures are used.
function load(relative, dependencies) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const executable = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(executable, {
    exports, Buffer, process: { env: { DEMO_SESSION_SECRET: "01".repeat(32) } },
    require: (id) => {
      if (id === "server-only") return {};
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (id.startsWith("node:") || id === "next/server") return require(id);
      throw new Error(`Unmocked server dependency: ${id}`);
    },
  });
  return exports;
}

const credentials = load("../lib/account-credentials.ts", {});
const teachers = [{ id: "SYNTHETIC-TEACHER", name: "Synthetic Teacher" }];
const identity = { user: "Synthetic Teacher", role: "teacher" };
const identityKey = credentials.accountIdentityKey(identity.user, identity.role);
const directory = {
  account_id: "synthetic-account", identity_key: identityKey, account_name: identity.user,
  account_role: identity.role, status: "active", legacy_session_allowed: true, access_version: 1,
};

function authModule(store) {
  return load("../lib/demo-auth.ts", {
    "@/lib/nixon-auth": {}, "@/lib/demo-users": users,
    "@/lib/demo-session-token": tokens, "@/lib/demo-teacher-login": teacherLogin,
    "@/lib/account-credentials": credentials, "@/lib/ops-store": store,
  });
}

function loginModule(credential) {
  const calls = { directory: 0, sessions: 0 };
  const route = load("../app/api/demo-login/route.ts", {
    "@/lib/demo-auth": { ...users, DEMO_COOKIE_NAME: "auth", resolveDemoIdentity: async () => null },
    "@/lib/account-credentials": credentials,
    "@/lib/account-rate-limit": {
      accountAuthThrottleKeys: () => ["synthetic"], checkAuthThrottle: async () => ({ blocked: false }),
      admitAuthAttempt: async () => ({ blocked: false }), settleSuccessfulAuthAttempt: async () => {},
    },
    "@/lib/account-mfa": {}, "@/lib/demo-session-token": tokens,
    "@/lib/nixon-auth": { NIXON_COOKIE_NAME: "admin" },
    "@/lib/demo-teacher-login": teacherLogin,
    "@/lib/ops-store": {
      getOpsState: async () => [{ entity: "teachers", payload: teachers }],
      getAppAccountCredential: async () => credential,
      ensureAccountDirectory: async () => { calls.directory++; return directory; },
      getAccountMfaForLogin: async () => null,
      createAccountSession: async (input) => { calls.sessions++; return { session_id: input.sessionId }; },
    },
  });
  return { calls, post: (body) => route.POST(new Request("http://localhost/api/demo-login", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  })) };
}

test("new, imported, or renamed teachers cannot authenticate with their roster name", async () => {
  for (const body of [{ password: identity.user }, { username: identity.user, password: identity.user }]) {
    const { post, calls } = loginModule(null);
    const response = await post(body);
    assert.equal(response.status, 401);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(calls.directory, 0);
    assert.equal(calls.sessions, 0);
  }
});

test("teachers with independent credentials still sign in and wrong passwords remain rejected", async () => {
  const password = "synthetic-independent-password";
  const material = await credentials.hashAccountPassword(password);
  const credential = { password_hash: material.passwordHash, password_salt: material.passwordSalt,
    password_algorithm: material.passwordAlgorithm, identity_key: identityKey, account_name: identity.user,
    account_role: "teacher", credential_version: 1, enabled: true, must_change_password: false };
  const { post, calls } = loginModule(credential);
  assert.equal((await post({ username: identity.user, password: identity.user })).status, 401);
  assert.equal((await post({ username: identity.user, password })).status, 200);
  assert.equal(calls.sessions, 1);
});

test("old signed teacher cookies without an independent credential cannot access protected routes", async () => {
  const auth = authModule({ getAccountByIdentity: async () => { throw new Error("must not read directory"); } });
  const result = await auth.getCurrentDemoSession(auth.demoSessionToken(identity));
  assert.equal(result.status, 401);
});

test("existing server sessions from name-only login are rejected even while their ledger is active", async () => {
  const token = tokens.createServerSessionToken();
  const auth = authModule({ getAccountSession: async () => ({
    session_id: token.sessionId, account_name: identity.user, account_role: "teacher",
    account_id: directory.account_id, credential_version: null, must_change_password: false,
  }), getOpsState: async () => { throw new Error("must not load teacher data"); } });
  assert.equal((await auth.getCurrentDemoSession(token.token)).status, 401);
});

test("independent-password server sessions retain roster and password-change validation", async () => {
  const token = tokens.createServerSessionToken();
  const base = {
    session_id: token.sessionId, account_name: identity.user, account_role: "teacher",
    account_id: directory.account_id, credential_version: 2, must_change_password: false,
  };
  for (const [record, roster, expected] of [
    [base, teachers, "session"],
    [base, [], 401],
    [null, teachers, 401],
    [{ ...base, must_change_password: true }, teachers, 403],
  ]) {
    const auth = authModule({ getAccountSession: async () => record,
      getOpsState: async () => [{ entity: "teachers", payload: roster }] });
    const result = await auth.getCurrentDemoSession(token.token);
    assert.equal(expected === "session" ? Boolean(result.session) : result.status, expected === "session" ? true : expected);
  }
});
