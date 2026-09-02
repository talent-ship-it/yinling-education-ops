import { createHash, timingSafeEqual } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 20_480;
const deliveryIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const recipientRefPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function tokenMatches(expected, supplied) {
  if (!expected || !supplied) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function parseRecipients(raw) {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("WECOM_CLI_RECIPIENTS_JSON must be an object");

  const recipients = new Map();
  for (const [ref, value] of Object.entries(parsed)) {
    if (!recipientRefPattern.test(ref) || !isRecord(value) || typeof value.chatName !== "string" || !["single", "group"].includes(value.chatType)) {
      throw new Error("WECOM_CLI_RECIPIENTS_JSON contains an invalid recipient");
    }
    const chatName = value.chatName.trim();
    if (!chatName || chatName.length > 256) throw new Error("WECOM_CLI_RECIPIENTS_JSON contains an invalid chatName");
    recipients.set(ref, { chatName, chatType: value.chatType });
  }
  return recipients;
}

export function loadBridgeConfig(env = process.env) {
  const token = env.WECOM_CLI_BRIDGE_TOKEN || "";
  if (token.length < 32) throw new Error("WECOM_CLI_BRIDGE_TOKEN must have at least 32 characters");

  const port = Number(env.WECOM_CLI_PORT || "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WECOM_CLI_PORT must be a valid port");

  return {
    token,
    host: env.WECOM_CLI_HOST || "127.0.0.1",
    port,
    binary: env.WECOM_CLI_BINARY || "wecom-cli",
    dedupeFile: env.WECOM_CLI_DEDUP_FILE || ".wecom-cli-bridge-deliveries.json",
    recipients: parseRecipients(env.WECOM_CLI_RECIPIENTS_JSON || "{}"),
  };
}

export class DeliveryStore {
  constructor(file, deliveries = new Map()) {
    this.file = file;
    this.deliveries = deliveries;
    this.writeQueue = Promise.resolve();
  }

  static async open(file) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (!isRecord(parsed)) throw new Error("delivery store must be an object");
      const deliveries = new Map();
      for (const [deliveryId, value] of Object.entries(parsed)) {
        if (!deliveryIdPattern.test(deliveryId) || !isRecord(value) || typeof value.status !== "string") continue;
        if (!["in_flight", "sent", "failed"].includes(value.status)) continue;
        deliveries.set(deliveryId, { status: value.status, code: typeof value.code === "string" ? value.code : undefined });
      }
      return new DeliveryStore(file, deliveries);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return new DeliveryStore(file);
      throw error;
    }
  }

  get(deliveryId) {
    return this.deliveries.get(deliveryId);
  }

  async persist() {
    await mkdir(dirname(this.file), { recursive: true });
    const payload = Object.fromEntries(this.deliveries);
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(payload), { mode: 0o600 });
    await rename(temporary, this.file);
  }

  async set(deliveryId, value) {
    this.writeQueue = this.writeQueue.then(async () => {
      this.deliveries.set(deliveryId, value);
      await this.persist();
    });
    await this.writeQueue;
  }

  async claim(deliveryId) {
    let existing;
    this.writeQueue = this.writeQueue.then(async () => {
      existing = this.deliveries.get(deliveryId);
      if (existing) return;
      this.deliveries.set(deliveryId, { status: "in_flight" });
      await this.persist();
    });
    await this.writeQueue;
    return existing;
  }
}

export function validateSendPayload(value) {
  if (!isRecord(value) || Object.keys(value).length !== 4) return { ok: false, code: "invalid_request" };
  const { deliveryId, action, recipientRef, text } = value;
  if (typeof deliveryId !== "string" || !deliveryIdPattern.test(deliveryId)) return { ok: false, code: "invalid_delivery" };
  if (action !== "send_text") return { ok: false, code: "unsupported_action" };
  if (typeof recipientRef !== "string" || !recipientRefPattern.test(recipientRef)) return { ok: false, code: "invalid_recipient" };
  if (typeof text !== "string" || !text.trim() || bytes(text) > MAX_TEXT_BYTES) return { ok: false, code: "invalid_text" };
  return { ok: true, deliveryId, recipientRef, text: text.trim() };
}

class CliBridgeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export class DeliveryOutcomeUnknownError extends Error {
  constructor() {
    super("delivery_outcome_unknown");
  }
}

export function parseCurrentSessions(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliBridgeError("sessions_unavailable");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) throw new CliBridgeError("sessions_unavailable");

  return parsed.sessions.flatMap((value) => {
    if (!isRecord(value) || typeof value.chat_id !== "string" || typeof value.chat_name !== "string" || !["single", "group"].includes(value.chat_type)) return [];
    const chatId = value.chat_id.trim();
    const chatName = value.chat_name.trim();
    return chatId && chatName ? [{ chatId, chatName, chatType: value.chat_type }] : [];
  });
}

export function selectCurrentSession(sessions, recipient) {
  const matches = sessions.filter((session) => session.chatName === recipient.chatName && session.chatType === recipient.chatType);
  if (!matches.length) throw new CliBridgeError("recipient_not_current");
  if (matches.length > 1) throw new CliBridgeError("recipient_ambiguous");
  return matches[0].chatId;
}

export async function resolveWecomCliChatId(binary, recipient) {
  try {
    const { stdout } = await execFile(binary, ["message", "aibot", "sessions", "list"], {
      timeout: 20_000,
      maxBuffer: MAX_BODY_BYTES,
      windowsHide: true,
    });
    return selectCurrentSession(parseCurrentSessions(String(stdout)), recipient);
  } catch (error) {
    if (error instanceof CliBridgeError) throw error;
    throw new CliBridgeError("sessions_unavailable");
  }
}

export async function runWecomCli(binary, recipient, text) {
  // The official CLI only permits a non-authorizer target from this delivery's fresh sessions list.
  // `recipient` carries an exact name/type matching rule, never a durable chat_id.
  const chatId = await resolveWecomCliChatId(binary, recipient);
  const payload = JSON.stringify({
    chat_id: chatId,
    msg_type: "markdown",
    markdown: { content: text },
  });
  try {
    await execFile(binary, ["message", "aibot", "send", "--json", payload], {
      timeout: 20_000,
      maxBuffer: MAX_BODY_BYTES,
      windowsHide: true,
    });
  } catch {
    // A command timeout or transport failure can occur after the CLI accepted the send.
    // Leave the durable delivery in-flight so the website cannot mint an automatic retry.
    throw new DeliveryOutcomeUnknownError();
  }
}

export async function handleSend(payload, config, deliveries, run = runWecomCli) {
  const validated = validateSendPayload(payload);
  if (!validated.ok) return { status: 400, body: { ok: false, code: validated.code } };

  const recipient = config.recipients.get(validated.recipientRef);
  if (!recipient) return { status: 403, body: { ok: false, code: "unknown_recipient" } };

  const known = await deliveries.claim(validated.deliveryId);
  if (known?.status === "sent") return { status: 200, body: { ok: true, deliveryId: validated.deliveryId } };
  if (known?.status === "failed") return { status: 422, body: { ok: false, code: known.code || "cli_rejected", deliveryId: validated.deliveryId } };
  if (known?.status === "in_flight") return { status: 202, body: { ok: false, code: "delivery_in_progress", deliveryId: validated.deliveryId } };

  try {
    await run(config.binary, recipient, validated.text);
    await deliveries.set(validated.deliveryId, { status: "sent" });
    return { status: 200, body: { ok: true, deliveryId: validated.deliveryId } };
  } catch (error) {
    if (error instanceof DeliveryOutcomeUnknownError) {
      return { status: 503, body: { ok: false, code: "delivery_outcome_unknown", deliveryId: validated.deliveryId } };
    }
    // Keep a durable result for this delivery ID. The website will not mint a second ID to retry it.
    const code = error instanceof CliBridgeError ? error.code : "cli_rejected";
    await deliveries.set(validated.deliveryId, { status: "failed", code });
    return { status: 422, body: { ok: false, code, deliveryId: validated.deliveryId } };
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createBridgeServer({ config, deliveries, run }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://bridge.local");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    const suppliedToken = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
    if (!tokenMatches(config.token, suppliedToken)) {
      sendJson(response, 401, { ok: false, code: "unauthorized" });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/messages/send") {
      sendJson(response, 404, { ok: false, code: "not_found" });
      return;
    }

    try {
      const result = await handleSend(await readJson(request), config, deliveries, run);
      sendJson(response, result.status, result.body);
    } catch (error) {
      const code = error instanceof Error && error.message === "body_too_large" ? "body_too_large" : "invalid_request";
      sendJson(response, 400, { ok: false, code });
    }
  });
}
