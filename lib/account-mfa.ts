import "server-only";

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MFA_ENCRYPTION_ALGORITHM = "aes-256-gcm";
const MFA_CIPHERTEXT_VERSION = "mfa:v1";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export class MfaConfigurationError extends Error {
  constructor(message = "MFA 加密密钥尚未配置。") {
    super(message);
    this.name = "MfaConfigurationError";
  }
}

function encryptionKey(configured = process.env.MFA_ENCRYPTION_KEY) {
  if (typeof configured !== "string" || !/^[a-f0-9]{64}$/u.test(configured)) {
    throw new MfaConfigurationError();
  }
  return Buffer.from(configured, "hex");
}

function normaliseSecret(secret: unknown) {
  if (typeof secret !== "string") return null;
  const normalized = secret.replace(/[\s-]/gu, "").toUpperCase();
  return /^[A-Z2-7]{16,128}={0,6}$/u.test(normalized) ? normalized : null;
}

function decodeBase32(secret: string) {
  const normalized = secret.replace(/=+$/u, "");
  let bits = "";
  for (const character of normalized) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value < 0) throw new Error("MFA secret 无效。");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  return bytes;
}

export function encryptMfaSecret(secret: string, configuredKey = process.env.MFA_ENCRYPTION_KEY) {
  const normalized = normaliseSecret(secret);
  if (!normalized) throw new Error("MFA secret 无效。");
  const iv = randomBytes(12);
  const cipher = createCipheriv(MFA_ENCRYPTION_ALGORITHM, encryptionKey(configuredKey), iv);
  const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    MFA_CIPHERTEXT_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptMfaSecret(value: unknown, configuredKey = process.env.MFA_ENCRYPTION_KEY) {
  if (typeof value !== "string") throw new Error("MFA secret ciphertext 无效。");
  const [version, ivText, tagText, ciphertextText] = value.split(":");
  if (version !== MFA_CIPHERTEXT_VERSION || !ivText || !tagText || !ciphertextText) {
    throw new Error("MFA secret ciphertext 无效。");
  }
  try {
    const decipher = createDecipheriv(
      MFA_ENCRYPTION_ALGORITHM,
      encryptionKey(configuredKey),
      Buffer.from(ivText, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const secret = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const normalized = normaliseSecret(secret);
    if (!normalized) throw new Error("MFA secret ciphertext 无效。");
    return normalized;
  } catch {
    throw new Error("MFA secret ciphertext 无效。");
  }
}

function totpValue(secret: string, counter: number) {
  const key = decodeBase32(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function matchTotpCounter(secret: string, code: unknown, now = new Date()) {
  const normalizedSecret = normaliseSecret(secret);
  if (!normalizedSecret || typeof code !== "string" || !/^\d{6}$/u.test(code)) return null;
  const currentCounter = Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
  const supplied = Buffer.from(code, "ascii");
  let matchedCounter: number | null = null;
  for (const offset of [-1, 0, 1]) {
    const candidateCounter = currentCounter + offset;
    const expected = Buffer.from(totpValue(normalizedSecret, candidateCounter), "ascii");
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
      // Check the complete tolerance window and retain the newest match. This
      // avoids rejecting a current code in the rare event that adjacent TOTP
      // counters produce the same six digits.
      matchedCounter = Math.max(matchedCounter ?? candidateCounter, candidateCounter);
    }
  }
  return matchedCounter;
}

export function verifyTotpCode(secret: string, code: unknown, now = new Date()) {
  return matchTotpCounter(secret, code, now) !== null;
}

/** Test/support helper; callers must deliver the secret out of band. */
export function generateTotpSecret() {
  const bytes = randomBytes(20);
  return Array.from(bytes, (byte) => BASE32_ALPHABET[byte % BASE32_ALPHABET.length]).join("");
}
