import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DeliveryStore,
  handleSend,
  loadBridgeConfig,
  parseCurrentSessions,
  selectCurrentSession,
  validateSendPayload,
} from "../services/wecom-cli-bridge/bridge.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const deliveryId = "2a7bf3b4-d8f8-4d29-8d66-84c8f2afc167";
const concurrentDeliveryId = "1b2bf3b4-d8f8-4d29-8d66-84c8f2afc167";
const rejectedDeliveryId = "3c3bf3b4-d8f8-4d29-8d66-84c8f2afc167";

test("CLI bridge accepts only a fixed send_text contract and is idempotent", async () => {
  assert.deepEqual(validateSendPayload({
    deliveryId,
    action: "send_text",
    recipientRef: "staff-tara",
    text: "请查看新的试听提醒。",
  }), {
    ok: true,
    deliveryId,
    recipientRef: "staff-tara",
    text: "请查看新的试听提醒。",
  });
  assert.equal(validateSendPayload({ deliveryId, action: "read_group", recipientRef: "staff-tara", text: "x" }).code, "unsupported_action");
  assert.equal(validateSendPayload({ deliveryId, action: "send_text", recipientRef: "staff-tara", text: "x", extra: true }).code, "invalid_request");

  const directory = await mkdtemp(join(tmpdir(), "yinling-wecom-bridge-"));
  try {
    const config = loadBridgeConfig({
      WECOM_CLI_BRIDGE_TOKEN: "a".repeat(32),
      WECOM_CLI_RECIPIENTS_JSON: JSON.stringify({ "staff-tara": { chatName: "Tara（内部提醒）", chatType: "single" } }),
      WECOM_CLI_DEDUP_FILE: join(directory, "deliveries.json"),
    });
    const deliveries = await DeliveryStore.open(config.dedupeFile);
    const invocations = [];
    const recipient = { chatName: "Tara（内部提醒）", chatType: "single" };
    const run = async (binary, target, text) => invocations.push({ binary, target, text });
    const payload = { deliveryId, action: "send_text", recipientRef: "staff-tara", text: "请查看新的试听提醒。" };

    const first = await handleSend(payload, config, deliveries, run);
    const second = await handleSend(payload, config, deliveries, run);
    assert.deepEqual(first, { status: 200, body: { ok: true, deliveryId } });
    assert.deepEqual(second, { status: 200, body: { ok: true, deliveryId } });
    assert.deepEqual(invocations, [{ binary: "wecom-cli", target: recipient, text: "请查看新的试听提醒。" }]);

    const freshSessions = parseCurrentSessions(JSON.stringify({
      sessions: [{ chat_id: "fresh-current-session", chat_name: "Tara（内部提醒）", chat_type: "single", last_msg_time: "2026-09-02 09:00:00" }],
      sessions_count: 1,
    }));
    assert.equal(selectCurrentSession(freshSessions, recipient), "fresh-current-session");
    assert.throws(() => selectCurrentSession([], recipient), /recipient_not_current/);
    assert.throws(() => selectCurrentSession([...freshSessions, ...freshSessions], recipient), /recipient_ambiguous/);

    const rejected = await handleSend({ ...payload, deliveryId: rejectedDeliveryId, recipientRef: "not-configured" }, config, deliveries, run);
    assert.deepEqual(rejected, { status: 403, body: { ok: false, code: "unknown_recipient" } });
    assert.equal(deliveries.get(rejectedDeliveryId), undefined);

    let release;
    const waitingRun = () => new Promise((resolve) => { release = resolve; });
    const concurrentPayload = { ...payload, deliveryId: concurrentDeliveryId };
    const firstConcurrent = handleSend(concurrentPayload, config, deliveries, waitingRun);
    const secondConcurrent = handleSend(concurrentPayload, config, deliveries, waitingRun);
    const duplicate = await secondConcurrent;
    assert.deepEqual(duplicate, { status: 202, body: { ok: false, code: "delivery_in_progress", deliveryId: concurrentDeliveryId } });
    release();
    assert.deepEqual(await firstConcurrent, { status: 200, body: { ok: true, deliveryId: concurrentDeliveryId } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("website dispatch keeps CLI execution and sensitive targets outside the Next route", async () => {
  const [dispatch, authorize, recipients, bridge, bridgeService, client, guide] = await Promise.all([
    read("../app/api/integrations/wecom/dispatch/route.ts"),
    read("../app/api/integrations/wecom/authorize/route.ts"),
    read("../app/api/integrations/wecom/recipients/route.ts"),
    read("../lib/wecom-cli-bridge.ts"),
    read("../services/wecom-cli-bridge/bridge.mjs"),
    read("../app/operations-client.tsx"),
    read("../services/wecom-cli-bridge/README.md"),
  ]);

  assert.match(dispatch, /messageId/);
  assert.match(dispatch, /expectedMessagesVersion/);
  assert.match(dispatch, /hasWecomDispatchAuthorization/);
  assert.match(dispatch, /isSameOriginRequest/);
  assert.match(dispatch, /getOpsState\(\["messages"\]\)/);
  assert.match(dispatch, /wecom-dispatch-system/);
  assert.doesNotMatch(dispatch, /child_process|execFile|spawn\s*\(/);
  assert.match(authorize, /WECOM_DISPATCH_SESSION_SECONDS/);
  assert.match(authorize, /maxAttempts = 5/);
  assert.match(recipients, /listWecomCliRecipients/);
  assert.match(bridge, /WECOM_CLI_BRIDGE_TOKEN/);
  assert.match(bridge, /action: "send_text"/);
  assert.match(bridgeService, /\["message", "aibot", "sessions", "list"\]/);
  assert.match(bridgeService, /recipient_not_current/);
  assert.doesNotMatch(bridgeService, /value\.chatId/);
  assert.match(client, /CLI 第一期只支持人工确认后的内部企业微信文字通知/);
  assert.match(client, /二次授权/);
  assert.doesNotMatch(client, /recordMessage/);
  assert.match(guide, /chatName/);
  assert.doesNotMatch(guide, /a-current-session-chat-id/);
  assert.match(guide, /does \*\*not\*\* satisfy the meeting's automatic/);
});
