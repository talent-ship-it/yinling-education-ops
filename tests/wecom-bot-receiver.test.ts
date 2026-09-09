import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeWecomBotBatch } from "../lib/wecom-bot-receiver";
import { enrichWecomBotRecords } from "../lib/wecom-bot-routing";

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
  const otherRecords = normalizeWecomBotBatch({
    records: [{
      messageId: "bot:" + "b".repeat(64),
      chatId: "room-1",
      senderId: "sender-1",
      sentAt: "2026-09-09T00:00:00.000Z",
      messageType: "other",
    }],
  });
  assert.equal("text" in (otherRecords[0] ?? {}), false);
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

test("uses the archive classifier for bot-delivered handover text", () => {
  const [record] = normalizeWecomBotBatch({
    records: [{
      messageId: "bot:" + "c".repeat(64),
      chatId: "room-1",
      senderId: "sender-1",
      sentAt: "2026-09-09T00:00:00.000Z",
      messageType: "text",
      text: "@Insider Leads [Rose]试听LP 信息交接[Rose]\n安排教师：Ethan Yang\n安排科目：Year 9 Science\n所在地：VIC\n姓名：\n家长微信名：",
    }],
  });
  const [enriched] = enrichWecomBotRecords([record!]);
  assert.equal(enriched?.classification, "handover");
  assert.equal("studentNameHint" in (enriched ?? {}), false);
  assert.equal("guardianWechatHint" in (enriched ?? {}), false);

  const [withHints] = enrichWecomBotRecords([normalizeWecomBotBatch({
    records: [{
      messageId: "bot:" + "d".repeat(64),
      chatId: "room-1",
      senderId: "sender-1",
      sentAt: "2026-09-09T00:00:00.000Z",
      messageType: "text",
      text: "信息交接表\n学生姓名：Mia Example\n家长微信名：SyntheticParent",
    }],
  })[0]!]);
  assert.equal(withHints?.classification, "handover");
  assert.equal(withHints?.studentNameHint, "Mia Example");
  assert.equal(withHints?.guardianWechatHint, "SyntheticParent");
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
  assert.equal(first.promoted, 0);
  assert.equal(first.failed, 0);
  assert.equal(second.skipped, 2);
  assert.equal(calls.length, 1);
  const records = (calls[0] as { records: Array<Record<string, unknown>> }).records;
  assert.equal(records.length, 2);
  const imageRecord = records.find((item) => item.messageType === "other");
  assert.equal("text" in (imageRecord ?? {}), false);
  assert.equal(imageRecord?.chatId, "bot:unknown-chat");
  assert.doesNotMatch(JSON.stringify(calls), /must-not-forward/);
});
