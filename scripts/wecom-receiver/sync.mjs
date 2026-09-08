import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_DATA = "/home/codex/.local/share/wecom-receiver";
const MAX_BATCH = 50;

function required(name, value) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`missing_${name.toLowerCase()}`);
  return result;
}

function iso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_received_at");
  return date.toISOString();
}

function messageId(message) {
  if (typeof message?.aibotid !== "string" || !message.aibotid
    || typeof message?.msgid !== "string" || !message.msgid) throw new Error("missing_message_identity");
  return `bot:${crypto.createHash("sha256").update(`${message.aibotid}\0${message.msgid}`).digest("hex")}`;
}

function textContent(message) {
  return typeof message?.text?.content === "string" && message.text.content.trim()
    ? message.text.content.trim()
    : null;
}

function canonicalRecord(record) {
  const message = record?.message;
  // Some WeCom image callbacks omit chatid even though they include the
  // sender. Keep those callbacks in the review queue with an explicit
  // placeholder rather than dropping the source evidence.
  const chatId = typeof message?.chatid === "string" && message.chatid.trim()
    ? message.chatid.trim()
    : message?.msgtype === "text" ? "" : "bot:unknown-chat";
  const senderId = typeof message?.from?.userid === "string" ? message.from.userid.trim() : "";
  if (!chatId || !senderId) throw new Error("missing_chat_or_sender");

  // The receiver deliberately does not download expiring media URLs. Store
  // non-text callbacks as pending `other` records until a reviewed media path
  // exists; never forward image AES keys or temporary URLs.
  const messageType = message.msgtype === "text" ? "text" : "other";
  return {
    messageId: messageId(message),
    chatId,
    senderId,
    sentAt: iso(record.received_at),
    messageType,
    text: textContent(message),
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function atomicJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temp, file);
}

async function readState(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) {
      throw new Error("invalid_sync_state");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, entries: {} };
    throw error;
  }
}

async function postBatch({ endpoint, token, records, fetchImpl }) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.outcome !== "committed") {
    throw new Error(`archive_http_${response.status}`);
  }
  return payload;
}

export async function syncReceiverMessages({
  dataDirectory = process.env.WECOM_RECEIVER_DATA || DEFAULT_DATA,
  endpoint = process.env.WECOM_BOT_INGEST_URL,
  token = process.env.WECOM_ARCHIVE_BRIDGE_TOKEN,
  startedAt = process.env.WECOM_ARCHIVE_STARTED_AT,
  fetchImpl = fetch,
} = {}) {
  const ingestUrl = required("WECOM_BOT_INGEST_URL", endpoint);
  const bridgeToken = required("WECOM_ARCHIVE_BRIDGE_TOKEN", token);
  const cutoffText = required("WECOM_ARCHIVE_STARTED_AT", startedAt);
  const cutoff = new Date(cutoffText);
  if (Number.isNaN(cutoff.getTime()) || cutoff.toISOString() !== cutoffText) {
    throw new Error("invalid_wecom_archive_started_at");
  }

  const messagesDirectory = path.join(dataDirectory, "messages");
  const stateFile = process.env.WECOM_SYNC_STATE_FILE || path.join(dataDirectory, "sync-state.json");
  const state = await readState(stateFile);
  const entries = state.entries;
  const names = (await fs.readdir(messagesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const summary = { scanned: names.length, skipped: 0, cutoffSkipped: 0, inserted: 0, duplicates: 0, failed: 0 };

  for (let offset = 0; offset < names.length; offset += MAX_BATCH) {
    const batch = [];
    const metadata = [];
    for (const name of names.slice(offset, offset + MAX_BATCH)) {
      const file = path.join(messagesDirectory, name);
      const stat = await fs.stat(file);
      const prior = entries[name];
      if (prior && (prior.status === "committed" || prior.status === "before_cutoff")
        && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) {
        summary.skipped += 1;
        continue;
      }

      try {
        const raw = await fs.readFile(file, "utf8");
        const record = JSON.parse(raw);
        const parsed = canonicalRecord(record);
        const sentAt = new Date(parsed.sentAt);
        const digest = sha256(raw);
        if (sentAt < cutoff) {
          entries[name] = { digest, size: stat.size, mtimeMs: stat.mtimeMs, status: "before_cutoff" };
          summary.cutoffSkipped += 1;
          continue;
        }
        batch.push(parsed);
        metadata.push({ name, digest, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (error) {
        summary.failed += 1;
        console.error(`${name}: ${error instanceof Error ? error.message : "invalid_message"}`);
      }
    }

    if (!batch.length) {
      await atomicJson(stateFile, { version: 1, entries });
      continue;
    }

    try {
      const result = await postBatch({ endpoint: ingestUrl, token: bridgeToken, records: batch, fetchImpl });
      summary.inserted += Number(result.inserted) || 0;
      summary.duplicates += Number(result.duplicates) || 0;
      for (const item of metadata) {
        entries[item.name] = { ...item, status: "committed" };
      }
      await atomicJson(stateFile, { version: 1, entries });
    } catch (error) {
      summary.failed += metadata.length;
      console.error(error instanceof Error ? error.message : "archive_upload_failed");
    }
  }

  await atomicJson(stateFile, { version: 1, entries });
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  syncReceiverMessages()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "sync_failed");
      process.exitCode = 1;
    });
}
