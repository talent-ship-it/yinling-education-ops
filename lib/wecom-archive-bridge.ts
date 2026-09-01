import { timingSafeEqual } from "node:crypto";

export const WECOM_ARCHIVE_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const WECOM_ARCHIVE_MAX_RECORDS = 50;

const MIN_BRIDGE_TOKEN_LENGTH = 32;
const MAX_BRIDGE_TOKEN_LENGTH = 512;
const WEAK_BRIDGE_TOKEN = /(?:change.?me|placeholder|synthetic|example|test.?token)/iu;

export type WecomArchiveBridgeConfiguration = Readonly<{
  ready: boolean;
  missing: readonly ("WECOM_ARCHIVE_BRIDGE_TOKEN" | "WECOM_ARCHIVE_STARTED_AT")[];
  token: string | null;
  startedAt: string | null;
}>;

function canonicalStartedAt(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== trimmed) return null;
  return parsed.toISOString();
}

function canonicalBridgeToken(value: string | undefined) {
  const token = value?.trim() ?? "";
  if (token.length < MIN_BRIDGE_TOKEN_LENGTH || token.length > MAX_BRIDGE_TOKEN_LENGTH
    || !/^[\x21-\x7e]+$/u.test(token)
    || WEAK_BRIDGE_TOKEN.test(token)
    || new Set(token).size < 10) return null;
  return token;
}

/**
 * The integration deliberately fails closed.  Its token and post-join cutoff
 * are both mandatory, so deploying the code alone cannot import old chats.
 */
export function wecomArchiveBridgeConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WecomArchiveBridgeConfiguration {
  const token = canonicalBridgeToken(env.WECOM_ARCHIVE_BRIDGE_TOKEN);
  const startedAt = canonicalStartedAt(env.WECOM_ARCHIVE_STARTED_AT);
  const missing: WecomArchiveBridgeConfiguration["missing"][number][] = [];
  if (!token) missing.push("WECOM_ARCHIVE_BRIDGE_TOKEN");
  if (!startedAt) missing.push("WECOM_ARCHIVE_STARTED_AT");
  return Object.freeze({ ready: missing.length === 0, missing: Object.freeze(missing), token, startedAt });
}

export function hasWecomArchiveBridgeToken(
  authorization: string | null,
  configuration = wecomArchiveBridgeConfiguration(),
) {
  const supplied = authorization?.match(/^Bearer ([^\s]+)$/iu)?.[1] ?? "";
  if (!configuration.ready || !configuration.token || !supplied) return false;
  const expectedBytes = Buffer.from(configuration.token);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export function hasAcceptableWecomArchiveContentLength(value: string | null) {
  if (value === null) return true;
  if (!/^\d+$/u.test(value)) return false;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= WECOM_ARCHIVE_MAX_REQUEST_BYTES;
}

/** Bounded stream reader for chunked requests that do not provide Content-Length. */
export async function readBoundedWecomArchiveJson(request: Request): Promise<unknown> {
  if (!hasAcceptableWecomArchiveContentLength(request.headers.get("content-length"))) {
    throw new RangeError("wecom_archive_request_too_large");
  }
  if (!request.body) throw new SyntaxError("wecom_archive_body_missing");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > WECOM_ARCHIVE_MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RangeError("wecom_archive_request_too_large");
    }
    chunks.push(part.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new SyntaxError("wecom_archive_body_invalid_utf8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyntaxError("wecom_archive_body_invalid_json");
  }
}
