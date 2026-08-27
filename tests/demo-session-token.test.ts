import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  createDemoSessionToken,
  createServerSessionToken,
  hashServerSessionToken,
  parseDemoSessionToken,
  parseServerSessionToken,
} from "../lib/demo-session-token";

const SECRET = "test-only-session-secret";
const NOW = new Date("2026-08-13T08:00:00.000Z");

function legacyV3Token(user: string, role: "admin" | "limited-admin" | "staff" | "teacher") {
  const payload = Buffer.from(JSON.stringify({
    v: 3,
    user,
    role,
    exp: Math.floor(NOW.getTime() / 1000) + 60 * 60 * 24 * 7,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET)
    .update(`yinling-demo-session-v3:${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

test("signed session restores a teacher outside the seeded demo list", () => {
  const token = createDemoSessionToken({ user: "Derek Jiang", role: "teacher" }, SECRET, NOW);
  assert.ok(token);
  assert.deepEqual(parseDemoSessionToken(token, SECRET, NOW), { user: "Derek Jiang", role: "teacher" });
});

test("tampering with either the teacher name or role invalidates the cookie", () => {
  const token = createDemoSessionToken({ user: "Derek Jiang", role: "teacher" }, SECRET, NOW);
  assert.ok(token);
  const [encoded, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const alteredName = Buffer.from(JSON.stringify({ ...payload, user: "Other Teacher" }), "utf8").toString("base64url");
  const alteredRole = Buffer.from(JSON.stringify({ ...payload, role: "admin" }), "utf8").toString("base64url");

  assert.equal(parseDemoSessionToken(`${alteredName}.${signature}`, SECRET, NOW), null);
  assert.equal(parseDemoSessionToken(`${alteredRole}.${signature}`, SECRET, NOW), null);
  assert.equal(parseDemoSessionToken(token, "wrong-secret", NOW), null);
});

test("a teacher cannot claim an admin identity while a colliding staff name stays role-separated", () => {
  assert.equal(createDemoSessionToken({ user: "Nixon", role: "teacher" }, SECRET, NOW), null);
  assert.equal(createDemoSessionToken({ user: "Derek Jiang", role: "admin" }, SECRET, NOW), null);
  const teacherToken = createDemoSessionToken({ user: "Abby", role: "teacher" }, SECRET, NOW);
  const staffToken = createDemoSessionToken({ user: "Abby", role: "staff" }, SECRET, NOW);
  assert.ok(teacherToken);
  assert.ok(staffToken);
  assert.deepEqual(parseDemoSessionToken(teacherToken, SECRET, NOW), { user: "Abby", role: "teacher" });
  assert.deepEqual(parseDemoSessionToken(staffToken, SECRET, NOW), { user: "Abby", role: "staff" });
});

test("expired session cookies are rejected", () => {
  const token = createDemoSessionToken({ user: "Derek Jiang", role: "teacher" }, SECRET, NOW);
  assert.ok(token);
  assert.equal(parseDemoSessionToken(token, SECRET, new Date("2026-08-21T08:00:01.000Z")), null);
});

test("credential version is signed into migrated account sessions", () => {
  const token = createDemoSessionToken(
    { user: "Derek Jiang", role: "teacher", credentialVersion: 7 },
    SECRET,
    NOW,
  );
  assert.ok(token);
  assert.deepEqual(parseDemoSessionToken(token, SECRET, NOW), {
    user: "Derek Jiang",
    role: "teacher",
    credentialVersion: 7,
  });
  assert.equal(createDemoSessionToken(
    { user: "Derek Jiang", role: "teacher", credentialVersion: 0 },
    SECRET,
    NOW,
  ), null);
});

test("valid version 3 sessions remain usable until the account adopts a credential version", () => {
  const token = legacyV3Token("Nixon", "admin");
  assert.deepEqual(parseDemoSessionToken(token, SECRET, NOW), {
    user: "Nixon",
    role: "admin",
  });
  assert.equal(parseDemoSessionToken(token, "wrong-secret", NOW), null);
});

test("version 5 sessions keep only an opaque token in the cookie and a digest in storage", () => {
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const created = createServerSessionToken(sessionId);
  assert.ok(created);
  assert.match(created.token, /^v5\.123e4567-e89b-42d3-a456-426614174000\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(created.sessionId, sessionId);
  assert.equal(created.tokenHash, hashServerSessionToken(created.token));
  assert.match(created.tokenHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(parseServerSessionToken(created.token), {
    sessionId,
    tokenHash: created.tokenHash,
  });
  assert.equal(parseServerSessionToken(`${created.token}x`), null);
  assert.equal(parseServerSessionToken("v5.not-a-session.not-a-secret"), null);
});
