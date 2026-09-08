import { createHash } from "node:crypto";

import { WECOM_ARCHIVE_MAX_RECORDS } from "./wecom-archive-bridge";

const MAX_TEXT_LENGTH = 12_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$/u;
const MESSAGE_TYPES = new Set(["text", "image", "file", "mixed", "other"]);

export type NormalizedWecomBotRecord = Readonly<{
  messageId: string;
  chatId: string;
  senderId: string;
  sentAt: string;
  messageType: "text" | "image" | "file" | "mixed" | "other";
  text: string | null;
}>;

export class WecomBotRecordError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WecomBotRecordError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new WecomBotRecordError(code, message);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail("unexpected_field", `${field} contains an unsupported field.`);
  }
}

function cleanText(value: unknown, field: string) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") fail("invalid_text", `${field} must be text.`);
  const result = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (result.length > MAX_TEXT_LENGTH) fail("text_too_long", `${field} is too long.`);
  return result;
}

function canonicalInstant(value: unknown) {
  const milliseconds = typeof value === "string" && /^\d{1,16}$/u.test(value)
    ? Number(value) < 10_000_000_000 ? Number(value) * 1_000 : Number(value)
    : typeof value === "number" && Number.isSafeInteger(value)
      ? value < 10_000_000_000 ? value * 1_000 : value
      : typeof value === "string" ? new Date(value).valueOf() : Number.NaN;
  if (!Number.isFinite(milliseconds)) fail("invalid_timestamp", "record timestamp is invalid.");
  return new Date(milliseconds).toISOString();
}

/** Hash the bot callback identity so the admin inbox does not expose it as a primary key. */
export function botMessageId(aibotId: string, msgid: string) {
  return `bot:${createHash("sha256").update(`${aibotId}\0${msgid}`).digest("hex")}`;
}

function normaliseRecord(value: unknown, index: number): NormalizedWecomBotRecord {
  if (!record(value)) fail("invalid_record", `record ${index} must be an object.`);
  exactKeys(value, new Set(["messageId", "chatId", "senderId", "sentAt", "messageType", "text"]), `record ${index}`);

  const messageId = cleanText(value.messageId, `record ${index}.messageId`);
  const chatId = cleanText(value.chatId, `record ${index}.chatId`);
  const senderId = cleanText(value.senderId, `record ${index}.senderId`);
  const messageType = cleanText(value.messageType, `record ${index}.messageType`).toLowerCase();
  const text = cleanText(value.text, `record ${index}.text`);

  if (!SAFE_ID.test(messageId) || !messageId.startsWith("bot:")) fail("invalid_record", `record ${index}.messageId is invalid.`);
  if (!SAFE_ID.test(chatId) || !SAFE_ID.test(senderId)) fail("invalid_record", `record ${index} identifiers are invalid.`);
  if (!MESSAGE_TYPES.has(messageType)) fail("invalid_record", `record ${index}.messageType is invalid.`);

  return Object.freeze({
    messageId,
    chatId,
    senderId,
    sentAt: canonicalInstant(value.sentAt),
    messageType: messageType as NormalizedWecomBotRecord["messageType"],
    text: text || null,
  });
}

export function normalizeWecomBotBatch(input: unknown): readonly NormalizedWecomBotRecord[] {
  if (!record(input) || Object.keys(input).some((key) => key !== "records") || !Array.isArray(input.records)) {
    fail("invalid_batch", "records must be an array.");
  }
  if (input.records.length < 1 || input.records.length > WECOM_ARCHIVE_MAX_RECORDS) {
    fail("invalid_batch", `records must contain 1-${WECOM_ARCHIVE_MAX_RECORDS} items.`);
  }

  const byId = new Map<string, NormalizedWecomBotRecord>();
  for (const [index, value] of input.records.entries()) {
    const item = normaliseRecord(value, index);
    const prior = byId.get(item.messageId);
    if (!prior) byId.set(item.messageId, item);
    else if (JSON.stringify(prior) !== JSON.stringify(item)) fail("idempotency_conflict", `record ${index} conflicts with an earlier message.`);
  }
  return Object.freeze([...byId.values()]);
}
