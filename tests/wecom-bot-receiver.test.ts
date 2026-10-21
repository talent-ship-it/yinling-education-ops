import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeWecomBotBatch } from "../lib/wecom-bot-receiver";
import { enrichWecomBotRecords } from "../lib/wecom-bot-routing";

const { syncReceiverMessages } = await import("../scripts/wecom-receiver/sync.mjs");

for (const phase of ["headers", "body"]) {
  test(`sync releases a stalled ${phase} request and leaves records retryable`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-timeout-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "messages"));
    await fs.writeFile(path.join(root, "messages", "text.json"), JSON.stringify({
      received_at: "2026-09-09T00:01:00.000Z",
      message: { aibotid: "bot", msgid: "timeout-1", msgtype: "text", chatid: "room", from: { userid: "sender" }, text: { content: "synthetic" } },
    }));
    let aborted = false;
    const config = {
      dataDirectory: root,
      endpoint: "https://example.test/ingest",
      token: "synthetic-token",
      startedAt: "2026-09-08T00:00:00.000Z",
      requestTimeoutMs: 5,
    };
    const first = await syncReceiverMessages({ ...config, fetchImpl: async (_url: string, init: RequestInit) => {
      const stalled = () => new Promise<never>((_resolve, reject) => init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("timeout", "AbortError"));
      }, { once: true }));
      return phase === "headers" ? stalled() : { ok: true, status: 200, json: stalled } as Response;
    } });
    assert.equal(aborted, true);
    assert.equal(first.failed, 1);
    assert.equal(first.acknowledged, 0);
    const second = await syncReceiverMessages({ ...config, fetchImpl: async () => new Response('{"outcome":"committed","inserted":1}') });
    assert.equal(second.inserted, 1);
    assert.equal(second.acknowledged, 1);
    assert.equal(second.skipped, 0);
  });
}

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

test("extracts the filled name variants used by handover templates", () => {
  const [record] = normalizeWecomBotBatch({
    records: [{
      messageId: "bot:" + "e".repeat(64),
      chatId: "room-1",
      senderId: "sender-1",
      sentAt: "2026-09-09T00:00:00.000Z",
      messageType: "text",
      text: "信息交接表\n【姓名(如提到)】: Mia Example\n【家长微信名】：SyntheticParent",
    }],
  });
  const [enriched] = enrichWecomBotRecords([record!]);
  assert.equal(enriched?.studentNameHint, "Mia Example");
  assert.equal(enriched?.guardianWechatHint, "SyntheticParent");
});

test("extracts the current 【学生】 field used by trial handovers", () => {
  const [record] = normalizeWecomBotBatch({
    records: [{
      messageId: "bot:" + "f".repeat(64),
      chatId: "room-1",
      senderId: "sender-1",
      sentAt: "2026-09-15T00:00:00.000Z",
      messageType: "text",
      text: "[Rose]试听LP 信息交接[Rose]\n【学生】：Synthetic Student\n【安排教师】：Teacher Example",
    }],
  });
  const [enriched] = enrichWecomBotRecords([record!]);
  assert.equal(enriched?.classification, "handover");
  assert.equal(enriched?.studentNameHint, "Synthetic Student");
});

test("forwards the trial WeChat identity and the two required staff fields", () => {
  const [record] = normalizeWecomBotBatch({
    records: [{
      messageId: "bot:" + "g".repeat(64),
      chatId: "room-identity-1",
      senderId: "sender-1",
      sentAt: "2026-09-15T00:00:00.000Z",
      messageType: "text",
      text: "[Rose]试听LP 信息交接[Rose]\n【微信名】：Parent Synthetic\n【教务】：Thea\n【课程规划老师】：Elaine@Insider Leads",
    }],
  });
  const [enriched] = enrichWecomBotRecords([record!]);
  assert.equal(enriched?.classification, "handover");
  assert.equal(enriched?.guardianWechatHint, "Parent Synthetic");
  assert.equal(enriched?.operationsOwnerHint, "Thea");
  assert.equal(enriched?.coursePlannerHint, "Elaine@Insider Leads");
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
    return new Response(JSON.stringify({
      outcome: "committed",
      inserted: 2,
      duplicates: 0,
      linked: 1,
      ambiguous: 1,
      pending: 0,
      projectedFiles: 0,
    }), { status: 200 });
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
  assert.equal(first.acknowledged, 2);
  assert.equal(first.linked, 1);
  assert.equal(first.ambiguous, 1);
  assert.equal(first.pending, 0);
  assert.equal(first.acknowledgementFailed, 0);
  assert.equal(first.failed, 0);
  assert.equal(second.skipped, 2);
  assert.equal(calls.length, 1);
  const acknowledgements = await fs.readdir(path.join(root, "acknowledgements"));
  assert.equal(acknowledgements.length, 2);
  const acknowledgementBodies = await Promise.all(acknowledgements.map((name) => fs.readFile(
    path.join(root, "acknowledgements", name),
    "utf8",
  )));
  assert.ok(acknowledgementBodies.every((body) => /"messageId":"bot:[a-f0-9]{64}"/.test(body)));
  assert.doesNotMatch(acknowledgementBodies.join(""), /temporary|must-not-forward/);
  const records = (calls[0] as { records: Array<Record<string, unknown>> }).records;
  assert.equal(records.length, 2);
  const imageRecord = records.find((item) => item.messageType === "other");
  assert.equal("text" in (imageRecord ?? {}), false);
  assert.equal(imageRecord?.chatId, "bot:unknown-chat");
  assert.doesNotMatch(JSON.stringify(calls), /must-not-forward/);
});

test("sync reports only sanitized receiver health to the derived private endpoint", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-health-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "messages"));
  await fs.writeFile(path.join(root, "status.json"), JSON.stringify({
    state: "authenticated",
    connected: true,
    started_at: "2026-09-22T00:00:00.000Z",
    updated_at: "2026-09-22T00:01:00.000Z",
    received_this_run: 2,
    initial_replies_this_run: 2,
    initial_stream_failures_this_run: 2,
    initial_reply_fallbacks_this_run: 2,
    initial_reply_failures_this_run: 0,
    acknowledgements_this_run: 2,
    acknowledgement_failures_this_run: 0,
    last_initial_stream_error: "93000",
    private_provider_message: "must-not-forward",
  }));
  const calls: Array<{ url: string; body: unknown }> = [];
  const result = await syncReceiverMessages({
    dataDirectory: root,
    endpoint: "https://example.test/api/integrations/wecom/bot-inbox",
    token: "secure-bridge-token",
    startedAt: "2026-09-08T00:00:00.000Z",
    fetchImpl: async (url: string, options: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(options.body)) });
      return new Response('{"outcome":"committed"}');
    },
  });
  assert.equal(result.healthReported, 1);
  assert.equal(result.healthFailed, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://example.test/api/integrations/wecom/receiver-health");
  assert.equal((calls[0]?.body as { health: { initialReplyFallbacksThisRun: number } }).health.initialReplyFallbacksThisRun, 2);
  assert.doesNotMatch(JSON.stringify(calls), /must-not-forward|private_provider_message/);
});

test("sync rejects malformed receiver status without publishing partial health", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wecom-health-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "messages"));
  await fs.writeFile(path.join(root, "status.json"), JSON.stringify({
    state: "authenticated",
    started_at: "not-an-instant",
    updated_at: "2026-09-22T00:01:00.000Z",
    private_provider_message: "must-not-forward",
  }));
  let requests = 0;
  t.mock.method(console, "error", () => {});
  const result = await syncReceiverMessages({
    dataDirectory: root,
    endpoint: "https://example.test/api/integrations/wecom/bot-inbox",
    token: "secure-bridge-token",
    startedAt: "2026-09-08T00:00:00.000Z",
    fetchImpl: async () => {
      requests += 1;
      return new Response('{"outcome":"committed"}');
    },
  });
  assert.equal(result.healthReported, 0);
  assert.equal(result.healthFailed, 1);
  assert.equal(requests, 0);
});


test("bot type-label templates enter the handover pipeline without invented guardian hints", () => {
  const [record] = normalizeWecomBotBatch({ records: [{
    messageId: "bot:" + "a".repeat(64), chatId: "synthetic-business-room", senderId: "synthetic-sender",
    sentAt: "2026-10-21T01:00:00.000Z", messageType: "text",
    text: "业务类型：老师LP修改\n学生：Synthetic Student\n涉及科目：English\n变动内容：Adjust goal",
  }] });
  const [enriched] = enrichWecomBotRecords([record]);
  assert.equal(enriched.classification, "handover");
  assert.equal(enriched.studentNameHint, "Synthetic Student");
  assert.equal("guardianWechatHint" in enriched, false);
});
