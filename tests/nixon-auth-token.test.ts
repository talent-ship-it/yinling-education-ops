import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdminElevationToken,
  verifyAdminElevationToken,
} from "../lib/nixon-auth-token";

const secretHex = "a".repeat(64);
const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const otherSessionId = "123e4567-e89b-42d3-a456-426614174001";
const now = new Date("2026-09-02T00:00:00.000Z");

test("admin elevation tokens are random, expiring, secret-bound and session-bound", () => {
  const first = createAdminElevationToken({ secretHex, sessionId, now });
  const second = createAdminElevationToken({ secretHex, sessionId, now });
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second);
  assert.equal(first.includes(secretHex), false);
  assert.equal(verifyAdminElevationToken({ secretHex, token: first, expectedSessionId: sessionId, now }), true);
  assert.equal(verifyAdminElevationToken({ secretHex, token: first, expectedSessionId: otherSessionId, now }), false);
  assert.equal(verifyAdminElevationToken({ secretHex: "b".repeat(64), token: first, expectedSessionId: sessionId, now }), false);
  assert.equal(verifyAdminElevationToken({
    secretHex,
    token: first,
    expectedSessionId: sessionId,
    now: new Date("2026-10-02T00:00:01.000Z"),
  }), false);
});

test("admin elevation tokens reject malformed configuration and tampering", () => {
  assert.equal(createAdminElevationToken({ secretHex: "invalid", sessionId, now }), null);
  assert.equal(createAdminElevationToken({ secretHex, sessionId: "invalid", now }), null);
  const token = createAdminElevationToken({ secretHex, sessionId, now });
  assert.ok(token);
  const final = token.at(-1);
  const tampered = `${token.slice(0, -1)}${final === "A" ? "B" : "A"}`;
  assert.equal(verifyAdminElevationToken({ secretHex, token: tampered, expectedSessionId: sessionId, now }), false);
});
