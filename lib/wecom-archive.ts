import { createHash } from "node:crypto";

import { WECOM_ARCHIVE_MAX_RECORDS } from "./wecom-archive-bridge";

const MAX_TEXT_LENGTH = 12_000;
const MAX_CONTEXT_ITEMS = 20;
const MAX_CONTEXT_ITEM_LENGTH = 4_000;
const MAX_MEDIA_ITEMS = 10;
const MAX_MEDIA_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 7 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type WecomArchiveMessageType = "text" | "image" | "file" | "mixed" | "other";
export type WecomArchiveClassification = "handover" | "renewal_follow_up" | "trial_scheduling" | "other";

export type NormalizedWecomArchiveMedia = Readonly<{
  mediaKey: string;
  fileName: string;
  contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  contentBase64: string;
  sha256: string;
}>;

export type NormalizedWecomArchiveRecord = Readonly<{
  messageId: string;
  chatId: string;
  senderId: string;
  sentAt: string;
  messageType: WecomArchiveMessageType;
  text: string | null;
  classification: WecomArchiveClassification;
  studentNameHint: string | null;
  guardianWechatHint: string | null;
  operationsOwnerHint: string | null;
  coursePlannerHint: string | null;
  media: readonly NormalizedWecomArchiveMedia[];
}>;

export class WecomArchiveParseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WecomArchiveParseError";
  }
}

function fail(code: string, message: string): never {
  throw new WecomArchiveParseError(code, message);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string) {
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("unexpected_field", `${field} contains an unsupported field.`);
}

function cleanText(value: unknown, maxLength: number, field: string) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") fail("invalid_text", `${field} must be text.`);
  const result = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (result.length > maxLength) fail("text_too_long", `${field} is too long.`);
  return result;
}

function sourceText(value: Record<string, unknown>) {
  if (typeof value.text === "string" || value.text === null) return cleanText(value.text, MAX_TEXT_LENGTH, "record.text");
  if (record(value.text)) {
    exactKeys(value.text, new Set(["content"]), "record.text");
    return cleanText(value.text.content, MAX_TEXT_LENGTH, "record.text.content");
  }
  return "";
}

function canonicalInstant(value: unknown) {
  let milliseconds: number;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string" && /^\d{1,16}$/u.test(value)) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) fail("invalid_timestamp", "record timestamp is invalid.");
    milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  } else if (typeof value === "string") {
    milliseconds = new Date(value).valueOf();
  } else {
    fail("invalid_timestamp", "record timestamp is missing.");
  }
  if (!Number.isFinite(milliseconds)) fail("invalid_timestamp", "record timestamp is invalid.");
  return new Date(milliseconds).toISOString();
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function aliasedText(
  value: Record<string, unknown>,
  canonicalKey: string,
  aliasKey: string,
  maxLength: number,
  field: string,
) {
  const hasCanonical = hasOwn(value, canonicalKey);
  const hasAlias = hasOwn(value, aliasKey);
  const canonical = hasCanonical ? cleanText(value[canonicalKey], maxLength, `${field}.${canonicalKey}`) : "";
  const alias = hasAlias ? cleanText(value[aliasKey], maxLength, `${field}.${aliasKey}`) : "";
  if (hasCanonical && hasAlias && canonical !== alias) {
    fail("alias_conflict", `${field} contains conflicting ${canonicalKey}/${aliasKey} values.`);
  }
  return hasCanonical ? canonical : alias;
}

function aliasedInstant(value: Record<string, unknown>, field: string) {
  const hasCanonical = hasOwn(value, "sentAt");
  const hasAlias = hasOwn(value, "msgtime");
  const canonical = hasCanonical ? canonicalInstant(value.sentAt) : null;
  const alias = hasAlias ? canonicalInstant(value.msgtime) : null;
  if (canonical && alias && canonical !== alias) {
    fail("alias_conflict", `${field} contains conflicting sentAt/msgtime values.`);
  }
  return canonical ?? alias ?? canonicalInstant(undefined);
}

function contextText(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_ITEMS) {
    fail("invalid_context", "record.contextText must be a bounded text array.");
  }
  return value.map((item, index) => cleanText(item, MAX_CONTEXT_ITEM_LENGTH, `record.contextText[${index}]`))
    .filter(Boolean);
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function detectedContentType(bytes: Uint8Array) {
  const prefix = Buffer.from(bytes);
  if (prefix.length >= 3 && prefix.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg" as const;
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png" as const;
  if (prefix.length >= 12 && prefix.subarray(0, 4).toString("ascii") === "RIFF"
    && prefix.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp" as const;
  if (prefix.length >= 5 && prefix.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf" as const;
  return null;
}

function extensionFor(contentType: NormalizedWecomArchiveMedia["contentType"]) {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "pdf";
}

function safeFileName(value: unknown, fallback: string) {
  const source = cleanText(value, 500, "media.fileName") || fallback;
  const wellFormed = Array.from(source.replace(/[\\/]+/gu, "_").replace(/\s+/gu, " "), (point) => {
    const codePoint = point.codePointAt(0) ?? 0;
    return codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : point;
  }).join("");
  const fileName = Array.from(wellFormed).slice(0, 180).join("").trim();
  if (!fileName || fileName === "." || fileName === "..") fail("invalid_media", "media file name is invalid.");
  return fileName;
}

function normaliseMedia(value: unknown, recordIndex: number) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MEDIA_ITEMS) {
    fail("invalid_media", `record ${recordIndex} media must be a bounded array.`);
  }
  let totalBytes = 0;
  const media = value.map((item, mediaIndex): NormalizedWecomArchiveMedia => {
    if (!record(item)) fail("invalid_media", `record ${recordIndex} media ${mediaIndex} must be an object.`);
    exactKeys(item, new Set(["mediaKey", "fileName", "contentType", "contentBase64", "sha256"]), `media ${mediaIndex}`);
    const contentBase64 = cleanText(item.contentBase64, 4 * 1024 * 1024 + 16, `media ${mediaIndex}.contentBase64`);
    if (!contentBase64 || !BASE64.test(contentBase64)) fail("invalid_media_base64", `media ${mediaIndex} is not canonical base64.`);
    const bytes = Buffer.from(contentBase64, "base64");
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES || bytes.toString("base64") !== contentBase64) {
      fail("media_size_out_of_range", `media ${mediaIndex} is empty, oversized, or non-canonical.`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_MEDIA_BYTES) fail("media_batch_too_large", `record ${recordIndex} media is too large.`);
    const contentType = detectedContentType(bytes);
    if (!contentType || (item.contentType !== undefined && item.contentType !== contentType)) {
      fail("media_integrity_mismatch", `media ${mediaIndex} content does not match its type.`);
    }
    const digest = sha256(bytes);
    if (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !SHA256.test(item.sha256) || item.sha256 !== digest)) {
      fail("media_integrity_mismatch", `media ${mediaIndex} SHA-256 does not match.`);
    }
    const mediaKey = item.mediaKey === undefined || item.mediaKey === null || item.mediaKey === ""
      ? `sha256:${digest}`
      : cleanText(item.mediaKey, 240, `media ${mediaIndex}.mediaKey`);
    if (!SAFE_ID.test(mediaKey)) fail("invalid_media", `media ${mediaIndex} key is invalid.`);
    return Object.freeze({
      mediaKey,
      fileName: safeFileName(item.fileName, `wecom-${digest.slice(0, 12)}.${extensionFor(contentType)}`),
      contentType,
      contentBase64,
      sha256: digest,
    });
  });
  const keys = new Set<string>();
  for (const item of media) {
    if (keys.has(item.mediaKey)) fail("duplicate_media_key", `record ${recordIndex} repeats a media key.`);
    keys.add(item.mediaKey);
  }
  return media;
}

function messageType(value: unknown, media: readonly NormalizedWecomArchiveMedia[], text: string): WecomArchiveMessageType {
  const source = typeof value === "string" ? value.trim().toLocaleLowerCase("en-AU") : "";
  const mapped: WecomArchiveMessageType = ["text", "image", "file", "mixed"].includes(source)
    ? source as WecomArchiveMessageType
    : "other";
  if (text && media.length) return "mixed";
  if (media.length && mapped === "text") return media.every((item) => item.contentType.startsWith("image/")) ? "image" : "file";
  return mapped;
}

function labelCandidates(text: string, labels: readonly string[]) {
  const alternatives = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  // Keep the separator on the same line so an empty field cannot consume the
  // next label. Handover templates commonly wrap labels in `【】` or `[]`.
  const pattern = new RegExp(`(?:^|[\\n【\\[]|[ \\t])(?:${alternatives})[】\\]]?[ \\t]*[:：][ \\t]*([^\\n,，;；]{1,80})`, "gimu");
  return [...text.matchAll(pattern)].map((match) => match[1]?.trim() ?? "").filter(Boolean);
}

const STUDENT_NAME_LABELS = ["学生姓名", "学生名", "学生", "姓名(如提到)", "姓名（如提到）", "姓名"];
// `微信名` is deliberately accepted alongside the older `家长微信名` label.
// For a trial student, that name is the stable bridge until the family gives
// the English/Chinese student name; it is not an active-roster match hint by
// itself.
const GUARDIAN_WECHAT_LABELS = ["家长微信名", "家长微信", "微信名"];
const OPERATIONS_OWNER_LABELS = ["教务老师", "负责教务", "对接教务", "教务"];
const COURSE_PLANNER_LABELS = ["课程规划老师", "课程规划师", "课程规划"];

function conservativeHint(explicit: unknown, derived: readonly string[], field: string) {
  const direct = cleanText(explicit, 240, field);
  if (direct) return direct;
  const unique = [...new Set(derived.map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim()).filter(Boolean))];
  return unique.length === 1 ? unique[0]! : null;
}

function leadingRenewalStudent(text: string) {
  const matches = [...text.matchAll(/(?:^|\n)\s*[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\ufe0f\u200d\s]*([\p{Script=Latin}\p{M}'’.-]+(?:\s+[\p{Script=Latin}\p{M}'’.-]+){0,3}(?:\p{Script=Han}{1,8})?|\p{Script=Han}{2,8})\s*[,，]\s*续费前跟进/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  return [...new Set(matches)];
}

function classify(text: string, context: readonly string[], media: readonly NormalizedWecomArchiveMedia[]) {
  const evidence = [text, ...context, ...media.map((item) => item.fileName)].join("\n");
  // The sales templates use both “信息交接” and “信息交接表”.  Treat the
  // explicit phrase as handover evidence while keeping generic “交接” text
  // on the conservative structured-field path below.
  if (/信息交接(?:表|单)?/u.test(evidence)) return "handover" as const;
  // A later identity confirmation may contain only the shared WeChat name
  // and a now-known student name.  It belongs to the same conservative
  // handover pipeline even though it does not repeat the full template.
  if (labelCandidates(evidence, STUDENT_NAME_LABELS).length > 0
    && labelCandidates(evidence, GUARDIAN_WECHAT_LABELS).length > 0) return "handover" as const;
  const structuredHandoverLabels = ["微信名", "学生姓名", "科目", "所在地", "偏好时间", "对接对象"]
    .filter((label) => evidence.includes(label)).length;
  if (/试听/u.test(evidence) && structuredHandoverLabels >= 3) return "handover" as const;
  if (/续费前跟进/u.test(evidence) || /续(?:费|课)[^\n]{0,24}跟进/u.test(evidence)) return "renewal_follow_up" as const;
  if (/试听待排课/u.test(evidence) || /试听[^\n]{0,24}排课/u.test(evidence)) return "trial_scheduling" as const;
  return "other" as const;
}

const RECORD_KEYS = new Set([
  "messageId", "msgid", "chatId", "roomid", "senderId", "from", "sentAt", "msgtime",
  "messageType", "msgtype", "text", "classification", "studentNameHint", "guardianWechatHint",
  "operationsOwnerHint", "coursePlannerHint",
  "contextText", "media", "action", "tolist",
]);

function normaliseRecord(value: unknown, index: number): NormalizedWecomArchiveRecord {
  if (!record(value)) fail("invalid_record", `record ${index} must be an object.`);
  exactKeys(value, RECORD_KEYS, `record ${index}`);
  const messageId = aliasedText(value, "messageId", "msgid", 240, `record ${index}`);
  const chatId = aliasedText(value, "chatId", "roomid", 240, `record ${index}`);
  const senderId = aliasedText(value, "senderId", "from", 240, `record ${index}`);
  if (!SAFE_ID.test(messageId) || !chatId || !senderId) fail("invalid_record", `record ${index} identifiers are invalid.`);
  const text = sourceText(value);
  const context = contextText(value.contextText);
  const media = normaliseMedia(value.media, index);
  const rawMessageType = aliasedText(value, "messageType", "msgtype", 80, `record ${index}`)
    .toLocaleLowerCase("en-AU");
  const type = messageType(rawMessageType, media, text);
  if ((type === "image" || type === "file") && !media.length) {
    fail("media_missing", `record ${index} media bytes must be downloaded before ingestion.`);
  }
  const allText = [text, ...context].filter(Boolean).join("\n");
  const classification = classify(text, context, media);
  if (value.classification !== undefined && value.classification !== classification) {
    fail("classification_mismatch", `record ${index} classification does not match its evidence.`);
  }
  const studentNameHint = conservativeHint(
    value.studentNameHint,
    [
      // The live trial-handover template uses `【学生】` rather than
      // `【学生姓名】`; both are explicit identity fields, not fuzzy evidence.
      ...labelCandidates(allText, STUDENT_NAME_LABELS),
      ...leadingRenewalStudent(allText),
    ],
    `record ${index}.studentNameHint`,
  );
  const guardianWechatHint = conservativeHint(
    value.guardianWechatHint,
    labelCandidates(allText, GUARDIAN_WECHAT_LABELS),
    `record ${index}.guardianWechatHint`,
  );
  const operationsOwnerHint = conservativeHint(
    value.operationsOwnerHint,
    labelCandidates(allText, OPERATIONS_OWNER_LABELS),
    `record ${index}.operationsOwnerHint`,
  );
  const coursePlannerHint = conservativeHint(
    value.coursePlannerHint,
    labelCandidates(allText, COURSE_PLANNER_LABELS),
    `record ${index}.coursePlannerHint`,
  );
  return Object.freeze({
    messageId,
    chatId,
    senderId,
    sentAt: aliasedInstant(value, `record ${index}`),
    messageType: type,
    text: text || null,
    classification,
    studentNameHint,
    guardianWechatHint,
    operationsOwnerHint,
    coursePlannerHint,
    media: Object.freeze(media),
  });
}

/**
 * Normalise either `{ records: [...] }` or an array submitted by the trusted
 * archive worker. Chat text is treated solely as untrusted data.
 */
export function normalizeWecomArchiveBatch(input: unknown): readonly NormalizedWecomArchiveRecord[] {
  const source = Array.isArray(input) ? input : record(input) ? input.records : null;
  if (!Array.isArray(source) || source.length < 1 || source.length > WECOM_ARCHIVE_MAX_RECORDS) {
    fail("invalid_batch", `records must contain 1-${WECOM_ARCHIVE_MAX_RECORDS} items.`);
  }
  if (record(input)) exactKeys(input, new Set(["records"]), "batch");
  const records = source.map(normaliseRecord);
  const byId = new Map<string, NormalizedWecomArchiveRecord>();
  for (const item of records) {
    const prior = byId.get(item.messageId);
    if (!prior) byId.set(item.messageId, item);
    else if (JSON.stringify(prior) !== JSON.stringify(item)) {
      fail("idempotency_conflict", `message ${item.messageId} appears with different content.`);
    }
  }
  return Object.freeze([...byId.values()]);
}
