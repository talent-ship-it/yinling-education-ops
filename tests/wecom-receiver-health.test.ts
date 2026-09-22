import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWecomReceiverHealth } from "../lib/wecom-receiver-health";

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
