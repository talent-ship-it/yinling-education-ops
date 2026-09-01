import assert from "node:assert/strict";
import test from "node:test";

import {
  hasAcceptableWecomArchiveContentLength,
  hasWecomArchiveBridgeToken,
  WECOM_ARCHIVE_MAX_REQUEST_BYTES,
  wecomArchiveBridgeConfiguration,
} from "../lib/wecom-archive-bridge";

const validBridgeToken = "Q7vK2mN9rT4xP8cL6wD3sH5jF1zB0uYqA9eR7iO2";

test("keeps the bridge disabled until both token and exact ISO cutoff are configured", () => {
  assert.deepEqual(wecomArchiveBridgeConfiguration({}), {
    ready: false,
    missing: ["WECOM_ARCHIVE_BRIDGE_TOKEN", "WECOM_ARCHIVE_STARTED_AT"],
    token: null,
    startedAt: null,
  });
  assert.deepEqual(wecomArchiveBridgeConfiguration({
    WECOM_ARCHIVE_BRIDGE_TOKEN: validBridgeToken,
    WECOM_ARCHIVE_STARTED_AT: "2026-09-01T00:00:00.000Z",
  }), {
    ready: true,
    missing: [],
    token: validBridgeToken,
    startedAt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(wecomArchiveBridgeConfiguration({
    WECOM_ARCHIVE_BRIDGE_TOKEN: validBridgeToken,
    WECOM_ARCHIVE_STARTED_AT: "2026-09-01",
  }).ready, false);
  for (const weakToken of ["short", "synthetic-bridge-token", "a".repeat(64), "placeholder-token-that-is-long-enough-1234"]) {
    assert.equal(wecomArchiveBridgeConfiguration({
      WECOM_ARCHIVE_BRIDGE_TOKEN: weakToken,
      WECOM_ARCHIVE_STARTED_AT: "2026-09-01T00:00:00.000Z",
    }).ready, false);
  }
});

test("compares only a canonical bearer value and never enables a partial config", () => {
  const configuration = wecomArchiveBridgeConfiguration({
    WECOM_ARCHIVE_BRIDGE_TOKEN: validBridgeToken,
    WECOM_ARCHIVE_STARTED_AT: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(hasWecomArchiveBridgeToken(`Bearer ${validBridgeToken}`, configuration), true);
  assert.equal(hasWecomArchiveBridgeToken(`Bearer ${validBridgeToken.slice(0, -1)}N`, configuration), false);
  assert.equal(hasWecomArchiveBridgeToken(validBridgeToken, configuration), false);
  assert.equal(hasWecomArchiveBridgeToken(`Bearer ${validBridgeToken}-extra`, configuration), false);
  assert.equal(hasWecomArchiveBridgeToken(`Bearer ${validBridgeToken}`, wecomArchiveBridgeConfiguration({})), false);
});

test("bounds requests before parsing a base64 media body", () => {
  assert.equal(hasAcceptableWecomArchiveContentLength(null), true);
  assert.equal(hasAcceptableWecomArchiveContentLength("1"), true);
  assert.equal(hasAcceptableWecomArchiveContentLength(String(WECOM_ARCHIVE_MAX_REQUEST_BYTES)), true);
  assert.equal(hasAcceptableWecomArchiveContentLength("0"), false);
  assert.equal(hasAcceptableWecomArchiveContentLength(String(WECOM_ARCHIVE_MAX_REQUEST_BYTES + 1)), false);
  assert.equal(hasAcceptableWecomArchiveContentLength("8mb"), false);
});
