import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWecomReceiverHealth, WecomReceiverHealthError } from "../lib/wecom-receiver-health";
import { wecomReceiverHealthFailure } from "../lib/wecom-receiver-health-http";

const valid = {
  health: {
    state: "authenticated",
    connected: true,
    startedAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:01:00.000Z",
    authenticatedAt: "2026-09-22T00:00:01.000Z",
    lastMessageAt: null,
    receivedThisRun: 2,
    initialRepliesThisRun: 2,
    initialStreamRepliesThisRun: 0,
    initialStreamFailuresThisRun: 2,
    initialReplyFallbacksThisRun: 2,
    initialReplyFailuresThisRun: 0,
    acknowledgementsThisRun: 2,
    acknowledgementFailuresThisRun: 0,
    lastInitialReplyAt: "2026-09-22T00:00:30.000Z",
    lastInitialStreamError: "93000",
    lastInitialStreamErrorAt: "2026-09-22T00:00:29.000Z",
    lastInitialReplyError: null,
    lastInitialReplyErrorAt: null,
    lastAcknowledgementAt: "2026-09-22T00:00:40.000Z",
    lastAcknowledgementError: null,
  },
};

test("accepts only aggregate receiver health and canonicalizes no private content", () => {
  const health = normalizeWecomReceiverHealth(valid);
  assert.equal(health.initialReplyFallbacksThisRun, 2);
  assert.equal(health.lastInitialStreamError, "93000");
  assert.equal(JSON.stringify(health).includes("chat"), false);
});

test("rejects extra callback fields, unbounded codes and invalid counters", () => {
  assert.throws(() => normalizeWecomReceiverHealth({
    health: { ...valid.health, callback: { text: "private" } },
  }), /unsupported field/);
  assert.throws(() => normalizeWecomReceiverHealth({
    health: { ...valid.health, lastInitialStreamError: "provider detail with spaces" },
  }), /bounded provider code/);
  assert.throws(() => normalizeWecomReceiverHealth({
    health: { ...valid.health, receivedThisRun: -1 },
  }), /bounded non-negative integer/);
});

test("maps health request and persistence failures without exposing provider details", () => {
  assert.deepEqual(wecomReceiverHealthFailure(new RangeError("private oversized body")), {
    status: 413,
    payload: { error: "WeCom health request is too large.", code: "payload_too_large" },
    logCategory: null,
  });
  assert.deepEqual(wecomReceiverHealthFailure(new SyntaxError("private JSON body")), {
    status: 400,
    payload: { error: "WeCom health request is not valid JSON.", code: "invalid_json" },
    logCategory: null,
  });
  assert.deepEqual(wecomReceiverHealthFailure(new WecomReceiverHealthError("invalid_health", "bounded public error")), {
    status: 422,
    payload: { error: "bounded public error", code: "invalid_health" },
    logCategory: null,
  });
  assert.deepEqual(wecomReceiverHealthFailure(new Error("private database detail"), "PGRST202"), {
    status: 501,
    payload: { error: "WeCom receiver health contract is not deployed.", code: "contract_unavailable" },
    logCategory: "contract_unavailable",
  });
  assert.deepEqual(wecomReceiverHealthFailure(new Error("private database detail"), "57014"), {
    status: 503,
    payload: { error: "WeCom receiver health was not committed.", code: "health_commit_failed" },
    logCategory: "57014",
  });
  assert.deepEqual(wecomReceiverHealthFailure(new Error("private runtime detail")), {
    status: 503,
    payload: { error: "WeCom receiver health was not committed.", code: "health_commit_failed" },
    logCategory: "health",
  });
});
