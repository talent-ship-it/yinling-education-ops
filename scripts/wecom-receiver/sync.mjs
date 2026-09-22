import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acknowledgementFilePath } from "./core.mjs";

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
  // exists; never forward image AES keys or temporary URLs. Text callbacks
  // are classified by the server after upload and can be auto-linked there
  // only when the student identity is an exact unique match.
  const messageType = message.msgtype === "text" ? "text" : "other";
  const text = textContent(message);
  return {
    messageId: messageId(message),
    chatId,
    senderId,
    sentAt: iso(record.received_at),
    messageType,
    // The database contract treats JSON null as an invalid text value. Omit
    // the optional field when a callback has no textual content.
    ...(text ? { text } : {}),
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

async function writeAcknowledgement(directory, id) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicJson(acknowledgementFilePath(directory, id), {
    version: 1,
    messageId: id,
    acknowledgedAt: new Date().toISOString(),
  });
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

async function postBatch({ endpoint, token, records, fetchImpl, requestTimeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (controller.signal.aborted) throw new Error("archive_request_timeout");
    if (!response.ok || payload?.outcome !== "committed") {
      throw new Error(`archive_http_${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function healthEndpointFor(ingestUrl, explicit) {
  if (explicit) return explicit;
  const url = new URL(ingestUrl);
  if (!url.pathname.endsWith("/bot-inbox")) throw new Error("missing_wecom_receiver_health_url");
  url.pathname = `${url.pathname.slice(0, -"/bot-inbox".length)}/receiver-health`;
  return url.toString();
}

function optionalInstant(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value ? value : null;
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : 0;
}

function boundedCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/u.test(value) ? value : null;
}

async function readReceiverStatus(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function requiredReceiverHealth(status) {
  const startedAt = optionalInstant(status?.started_at);
  const updatedAt = optionalInstant(status?.updated_at);
  if (!startedAt) throw new Error("invalid_receiver_health");
  if (!updatedAt) throw new Error("invalid_receiver_health");
  if (typeof status?.state !== "string") throw new Error("invalid_receiver_health");
  return { state: status.state, startedAt, updatedAt };
}

function normalizeReceiverHealthStatus(status) {
  const required = requiredReceiverHealth(status);
  return {
    state: required.state,
    connected: status.connected === true,
    startedAt: required.startedAt,
    updatedAt: required.updatedAt,
    authenticatedAt: optionalInstant(status.authenticated_at),
    lastMessageAt: optionalInstant(status.last_message_at),
    receivedThisRun: boundedCount(status.received_this_run),
    initialRepliesThisRun: boundedCount(status.initial_replies_this_run),
    initialStreamRepliesThisRun: boundedCount(status.initial_stream_replies_this_run),
    initialStreamFailuresThisRun: boundedCount(status.initial_stream_failures_this_run),
    initialReplyFallbacksThisRun: boundedCount(status.initial_reply_fallbacks_this_run),
    initialReplyFailuresThisRun: boundedCount(status.initial_reply_failures_this_run),
    acknowledgementsThisRun: boundedCount(status.acknowledgements_this_run),
    acknowledgementFailuresThisRun: boundedCount(status.acknowledgement_failures_this_run),
    lastInitialReplyAt: optionalInstant(status.last_initial_reply_at),
    lastInitialStreamError: boundedCode(status.last_initial_stream_error),
    lastInitialStreamErrorAt: optionalInstant(status.last_initial_stream_error_at),
    lastInitialReplyError: boundedCode(status.last_initial_reply_error),
    lastInitialReplyErrorAt: optionalInstant(status.last_initial_reply_error_at),
    lastAcknowledgementAt: optionalInstant(status.last_acknowledgement_at),
    lastAcknowledgementError: boundedCode(status.last_acknowledgement_error),
  };
}

async function readReceiverHealth(dataDirectory) {
  const status = await readReceiverStatus(path.join(dataDirectory, "status.json"));
  return status === null ? null : normalizeReceiverHealthStatus(status);
}

async function postHealth({ endpoint, token, health, fetchImpl, requestTimeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ health }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (controller.signal.aborted) throw new Error("health_request_timeout");
    if (!response.ok || payload?.outcome !== "committed") throw new Error(`health_http_${response.status}`);
  } finally { clearTimeout(timeout); }
}

export async function syncReceiverMessages({
  dataDirectory = process.env.WECOM_RECEIVER_DATA || DEFAULT_DATA,
  endpoint = process.env.WECOM_BOT_INGEST_URL,
  healthEndpoint = process.env.WECOM_RECEIVER_HEALTH_URL,
  token = process.env.WECOM_ARCHIVE_BRIDGE_TOKEN,
  startedAt = process.env.WECOM_ARCHIVE_STARTED_AT,
  fetchImpl = fetch,
  requestTimeoutMs = 30_000,
} = {}) {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 60_000) {
    throw new Error("invalid_request_timeout");
  }
  const ingestUrl = required("WECOM_BOT_INGEST_URL", endpoint);
  const bridgeToken = required("WECOM_ARCHIVE_BRIDGE_TOKEN", token);
  const cutoffText = required("WECOM_ARCHIVE_STARTED_AT", startedAt);
  const cutoff = new Date(cutoffText);
  if (Number.isNaN(cutoff.getTime()) || cutoff.toISOString() !== cutoffText) {
    throw new Error("invalid_wecom_archive_started_at");
  }

  const messagesDirectory = path.join(dataDirectory, "messages");
  const acknowledgementsDirectory = path.join(dataDirectory, "acknowledgements");
  const stateFile = process.env.WECOM_SYNC_STATE_FILE || path.join(dataDirectory, "sync-state.json");
  const state = await readState(stateFile);
  const entries = state.entries;
  const names = (await fs.readdir(messagesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const summary = {
    scanned: names.length,
    skipped: 0,
    cutoffSkipped: 0,
    inserted: 0,
    promoted: 0,
    duplicates: 0,
    linked: 0,
    ambiguous: 0,
    pending: 0,
    projectedFiles: 0,
    acknowledged: 0,
    acknowledgementFailed: 0,
    healthReported: 0,
    healthFailed: 0,
    failed: 0,
  };

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
        metadata.push({ name, digest, size: stat.size, mtimeMs: stat.mtimeMs, messageId: parsed.messageId });
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
      const result = await postBatch({ endpoint: ingestUrl, token: bridgeToken, records: batch, fetchImpl, requestTimeoutMs });
      summary.inserted += Number(result.inserted) || 0;
      summary.promoted += Number(result.promoted) || 0;
      summary.duplicates += Number(result.duplicates) || 0;
      summary.linked += Number(result.linked) || 0;
      summary.ambiguous += Number(result.ambiguous) || 0;
      summary.pending += Number(result.pending) || 0;
      summary.projectedFiles += Number(result.projectedFiles) || 0;
      const acknowledgementState = new Map();
      let failedAcknowledgementsThisBatch = 0;
      for (const item of metadata) {
        try {
          await writeAcknowledgement(acknowledgementsDirectory, item.messageId);
          summary.acknowledged += 1;
          acknowledgementState.set(item.name, "committed");
        } catch (error) {
          summary.acknowledgementFailed += 1;
          failedAcknowledgementsThisBatch += 1;
          acknowledgementState.set(item.name, "ack_pending");
          console.error(`${item.name}: ${error instanceof Error ? error.message : "acknowledgement_write_failed"}`);
        }
      }
      for (const item of metadata) {
        entries[item.name] = { ...item, status: acknowledgementState.get(item.name) || "ack_pending" };
      }
      summary.failed += failedAcknowledgementsThisBatch;
      await atomicJson(stateFile, { version: 1, entries });
    } catch (error) {
      summary.failed += metadata.length;
      console.error(error instanceof Error ? error.message : "archive_upload_failed");
    }
  }

  try {
    const health = await readReceiverHealth(dataDirectory);
    if (health) {
      await postHealth({
        endpoint: healthEndpointFor(ingestUrl, healthEndpoint),
        token: bridgeToken,
        health,
        fetchImpl,
        requestTimeoutMs,
      });
      summary.healthReported = 1;
    }
  } catch {
    summary.healthFailed = 1;
    console.error("receiver_health_upload_failed");
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
