import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeWecomBotBatch } from "../lib/wecom-bot-receiver";

const { syncReceiverMessages } = await import("../scripts/wecom-receiver/sync.mjs");

test("normalizes bot records without accepting extra fields", () => {
  const records = normalizeWecomBotBatch({
    records: [{
      messageId: "bot:" + "a".repeat(64),
      chatId: "room-1",
      senderId: "sender-1",
      sentAt: "2026-09-09T00:00:00.000Z",
      messageType: "text",
      text: "test message",
    }],
  });
  assert.equal(records[0]?.messageType, "text");
  assert.equal(records[0]?.text, "test message");
  assert.throws(() => normalizeWecomBotBatch({
    records: [{
      messageId: "bot:" + "a".repeat(64),
      chatId: "room-1",
      senderId: "sender-1",
      sentAt: "2026-09-09T00:00:00.000Z",
      messageType: "text",
      text: "test message",
      raw: "must-not-pass",
    }],
  }), /unsupported field/);
});

test("syncs callback files once and treats non-text callbacks as pending other records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-bot-sync-"));
  const messages = path.join(root, "messages");
  await fs.mkdir(messages);
  await fs.writeFile(path.join(messages, "text.json"), JSON.stringify({
    received_at: "2026-09-09T00:01:00.000Z",
    message: {
      aibotid: "bot",
      msgid: "text-1",
      msgtype: "text",
      chatid: "room-1",
      from: { userid: "sender-1" },
      text: { content: "信息交接表 test" },
    },
  }));
  await fs.writeFile(path.join(messages, "image.json"), JSON.stringify({
    received_at: "2026-09-09T00:02:00.000Z",
    message: {
      aibotid: "bot",
      msgid: "image-1",
      msgtype: "image",
      chatid: "room-1",
      from: { userid: "sender-1" },
      image: { url: "temporary", aeskey: "must-not-forward" },
    },
  }));

  const calls: unknown[] = [];
  const fetchImpl = async (_url: string, options: RequestInit) => {
    calls.push(JSON.parse(String(options.body)));
    return new Response(JSON.stringify({ outcome: "committed", inserted: 2, duplicates: 0 }), { status: 200 });
  };

  const config = {
    dataDirectory: root,
    endpoint: "https://example.test/api/integrations/wecom/bot-inbox",
    token: "secure-bridge-token",
    startedAt: "2026-09-08T00:00:00.000Z",
    fetchImpl,
  };
  const first = await syncReceiverMessages(config);
  const second = await syncReceiverMessages(config);

  assert.equal(first.inserted, 2);
  assert.equal(first.failed, 0);
  assert.equal(second.skipped, 2);
  assert.equal(calls.length, 1);
  const records = (calls[0] as { records: Array<Record<string, unknown>> }).records;
  assert.equal(records.length, 2);
  assert.equal(records.find((item) => item.messageType === "other")?.text, null);
  assert.doesNotMatch(JSON.stringify(calls), /must-not-forward/);
});
