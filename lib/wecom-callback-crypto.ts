/*
 * Server-only by construction: this module depends on node:crypto and must not
 * be imported by a Client Component or browser bundle.
 *
 * This implements the standard Enterprise WeChat callback contract described
 * in the official "加解密方案说明":
 * https://developer.work.weixin.qq.com/document/path/90968
 *
 * Data & Intelligence (数据与智能专区) callbacks are a separate callback
 * surface with a different public-key/SDK protocol. They are intentionally not
 * handled here; do not apply this standard token/EncodingAESKey AES contract
 * to that surface or infer its payload format from this module.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as systemRandomBytes,
  timingSafeEqual,
} from "node:crypto";

const AES_ALGORITHM = "aes-256-cbc";
const AES_BLOCK_BYTES = 16;
const WECOM_PADDING_BLOCK_BYTES = 32;
const RANDOM_PREFIX_BYTES = 16;
const MESSAGE_LENGTH_BYTES = 4;
const FRAME_PREFIX_BYTES = RANDOM_PREFIX_BYTES + MESSAGE_LENGTH_BYTES;
const SHA1_HEX_LENGTH = 40;
const MAX_SIGNATURE_INPUT_LENGTH = 4_096;
const MAX_NONCE_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 16;
const MAX_RECEIVE_ID_BYTES = 128;
const MAX_CALLBACK_BYTES = 16 * 1024 * 1024;

export const DEFAULT_WECOM_CALLBACK_LIMITS = Object.freeze({
  maxCiphertextBytes: 4 * 1024 * 1024,
  maxPlaintextBytes: 4 * 1024 * 1024,
  maxTimestampSkewSeconds: 5 * 60,
});

const TOKEN_PATTERN = /^[\x21-\x7E]{3,32}$/u;
const IDENTIFIER_PATTERN = /^[\x21-\x7E]+$/u;
const NONCE_PATTERN = new RegExp(`^[\\x21-\\x7E]{1,${MAX_NONCE_LENGTH}}$`, "u");
const TIMESTAMP_PATTERN = /^[0-9]{1,16}$/u;
const SIGNATURE_PATTERN = /^[0-9a-f]{40}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type WeComCallbackCryptoErrorCode =
  | "invalid_config"
  | "invalid_request"
  | "invalid_timestamp"
  | "timestamp_skew"
  | "payload_too_large"
  | "invalid_ciphertext"
  | "signature_invalid"
  | "decryption_failed"
  | "invalid_padding"
  | "invalid_payload"
  | "receive_id_mismatch"
  | "message_too_large"
  | "encryption_failed";

export class WeComCallbackCryptoError extends Error {
  readonly code: WeComCallbackCryptoErrorCode;

  constructor(code: WeComCallbackCryptoErrorCode, message: string) {
    super(message);
    this.name = "WeComCallbackCryptoError";
    this.code = code;
  }
}

export class WeComCallbackConfigError extends WeComCallbackCryptoError {
  constructor(message: string) {
    super("invalid_config", message);
    this.name = "WeComCallbackConfigError";
  }
}

export type WeComCallbackRandomBytes = (size: number) => Uint8Array;

export type WeComCallbackConfigInput = Readonly<{
  token: string;
  encodingAESKey: string;
  /** For an ordinary enterprise app this is the corp ID. */
  receiveId: string;
  maxCiphertextBytes?: number;
  maxPlaintextBytes?: number;
  maxTimestampSkewSeconds?: number;
  /** Injectable only so tests can use deterministic synthetic ciphertext. */
  randomBytes?: WeComCallbackRandomBytes;
}>;

export type WeComCallbackConfig = Readonly<{
  token: string;
  encodingAESKey: string;
  receiveId: string;
  maxCiphertextBytes: number;
  maxPlaintextBytes: number;
  maxTimestampSkewSeconds: number;
}>;

export type WeComCallbackRequest = Readonly<{
  /** WeCom's msg_signature query/body field. */
  msgSignature: string;
  timestamp: string;
  nonce: string;
  /** The Encrypt XML field, or echostr during URL verification. */
  encrypted: string;
}>;

export type WeComCallbackSignatureInput = Readonly<{
  token: string;
  timestamp: string;
  nonce: string;
  encrypted: string;
}>;

export type WeComCallbackVerificationOptions = Readonly<{
  /** Unix seconds; omitted only when the caller wants the current server time. */
  nowSeconds?: number;
}>;

export type WeComDecryptedCallback = Readonly<{
  message: string;
  receiveId: string;
}>;

export type WeComEncryptedCallback = Readonly<{
  encrypted: string;
  msgSignature: string;
}>;

type NormalizedCallbackRequest = WeComCallbackRequest;

const defaultRandomBytes: WeComCallbackRandomBytes = (size) => systemRandomBytes(size);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configFail(message: string): never {
  throw new WeComCallbackConfigError(message);
}

function requestFail(code: Exclude<WeComCallbackCryptoErrorCode, "invalid_config">, message: string): never {
  throw new WeComCallbackCryptoError(code, message);
}

function validateToken(value: unknown, context: "config" | "request"): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    if (context === "config") configFail("token must contain 3-32 visible ASCII characters.");
    requestFail("invalid_request", "token is invalid.");
  }
  return value;
}

function validateReceiveId(value: unknown): string {
  if (typeof value !== "string"
      || !IDENTIFIER_PATTERN.test(value)
      || Buffer.byteLength(value, "utf8") > MAX_RECEIVE_ID_BYTES) {
    configFail("receiveId must be a visible ASCII identifier of at most 128 bytes.");
  }
  return value;
}

function validateTimestamp(value: unknown): string {
  if (typeof value !== "string"
      || value.length > MAX_TIMESTAMP_LENGTH
      || !TIMESTAMP_PATTERN.test(value)) {
    requestFail("invalid_timestamp", "timestamp must be an unsigned Unix timestamp in seconds.");
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    requestFail("invalid_timestamp", "timestamp is outside the safe integer range.");
  }
  return value;
}

function validateNonce(value: unknown): string {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) {
    requestFail("invalid_request", "nonce must be a bounded visible ASCII string.");
  }
  return value;
}

function validateIntegerLimit(
  value: unknown,
  name: string,
  defaultValue: number,
  minimum: number,
): number {
  const candidate = value === undefined ? defaultValue : value;
  if (typeof candidate !== "number"
      || !Number.isSafeInteger(candidate)
      || candidate < minimum
      || candidate > MAX_CALLBACK_BYTES) {
    configFail(`${name} must be an integer between ${minimum} and ${MAX_CALLBACK_BYTES}.`);
  }
  return candidate;
}

function validateSkewLimit(value: unknown): number {
  const candidate = value === undefined ? DEFAULT_WECOM_CALLBACK_LIMITS.maxTimestampSkewSeconds : value;
  if (typeof candidate !== "number"
      || !Number.isSafeInteger(candidate)
      || candidate < 0
      || candidate > 24 * 60 * 60) {
    configFail("maxTimestampSkewSeconds must be an integer between 0 and 86400.");
  }
  return candidate;
}

function decodeEncodingAESKey(value: string): Buffer {
  if (!/^[A-Za-z0-9]{43}$/u.test(value)) {
    configFail("encodingAESKey must be exactly 43 ASCII letters or digits.");
  }
  const padded = `${value}=`;
  const decoded = Buffer.from(padded, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== padded) {
    configFail("encodingAESKey must decode to exactly 32 bytes.");
  }
  return decoded;
}

/** Validate only explicit caller-supplied configuration; this function never reads ambient environment state. */
export function validateWeComCallbackConfig(input: unknown): WeComCallbackConfig {
  if (!isRecord(input)) configFail("callback crypto config must be an object.");

  const token = validateToken(input.token, "config");
  const encodingAESKey = typeof input.encodingAESKey === "string"
    ? input.encodingAESKey
    : configFail("encodingAESKey is required.");
  decodeEncodingAESKey(encodingAESKey);
  const receiveId = validateReceiveId(input.receiveId);
  const maxCiphertextBytes = validateIntegerLimit(
    input.maxCiphertextBytes,
    "maxCiphertextBytes",
    DEFAULT_WECOM_CALLBACK_LIMITS.maxCiphertextBytes,
    AES_BLOCK_BYTES,
  );
  const maxPlaintextBytes = validateIntegerLimit(
    input.maxPlaintextBytes,
    "maxPlaintextBytes",
    DEFAULT_WECOM_CALLBACK_LIMITS.maxPlaintextBytes,
    0,
  );
  const maxTimestampSkewSeconds = validateSkewLimit(input.maxTimestampSkewSeconds);

  return Object.freeze({
    token,
    encodingAESKey,
    receiveId,
    maxCiphertextBytes,
    maxPlaintextBytes,
    maxTimestampSkewSeconds,
  });
}

function assertTimestampFresh(
  timestamp: string,
  maxTimestampSkewSeconds: number,
  nowSeconds: number | undefined,
) {
  const currentSeconds = nowSeconds === undefined ? Math.floor(Date.now() / 1_000) : nowSeconds;
  if (!Number.isSafeInteger(currentSeconds) || currentSeconds < 0) {
    requestFail("invalid_timestamp", "nowSeconds must be a non-negative safe integer.");
  }
  const timestampSeconds = Number(timestamp);
  if (Math.abs(currentSeconds - timestampSeconds) > maxTimestampSkewSeconds) {
    requestFail("timestamp_skew", "callback timestamp is outside the configured skew window.");
  }
}

function assertRawCiphertextSize(encrypted: string, maxCiphertextBytes: number) {
  if (!encrypted) requestFail("invalid_ciphertext", "encrypted callback payload is empty.");
  const maxEncodedBytes = 4 * Math.ceil(maxCiphertextBytes / 3);
  if (Buffer.byteLength(encrypted, "utf8") > maxEncodedBytes) {
    requestFail("payload_too_large", "encrypted callback payload exceeds the configured limit.");
  }
}

function decodeCiphertext(encrypted: string, maxCiphertextBytes: number): Buffer {
  if (!BASE64_PATTERN.test(encrypted)) {
    requestFail("invalid_ciphertext", "encrypted callback payload is not canonical base64.");
  }
  const decoded = Buffer.from(encrypted, "base64");
  if (decoded.length === 0 || decoded.length % AES_BLOCK_BYTES !== 0) {
    requestFail("invalid_ciphertext", "encrypted callback payload is not a valid AES block sequence.");
  }
  if (decoded.length > maxCiphertextBytes) {
    requestFail("payload_too_large", "encrypted callback payload exceeds the configured limit.");
  }
  if (decoded.toString("base64") !== encrypted) {
    requestFail("invalid_ciphertext", "encrypted callback payload is not canonical base64.");
  }
  return decoded;
}

function normalizeRequest(input: unknown, maxCiphertextBytes: number): NormalizedCallbackRequest {
  if (!isRecord(input)) requestFail("invalid_request", "callback request must be an object.");
  if (typeof input.msgSignature !== "string" || input.msgSignature.length > MAX_SIGNATURE_INPUT_LENGTH) {
    requestFail("invalid_request", "msgSignature is invalid.");
  }
  const timestamp = validateTimestamp(input.timestamp);
  const nonce = validateNonce(input.nonce);
  if (typeof input.encrypted !== "string") {
    requestFail("invalid_ciphertext", "encrypted callback payload is invalid.");
  }
  assertRawCiphertextSize(input.encrypted, maxCiphertextBytes);
  return {
    msgSignature: input.msgSignature,
    timestamp,
    nonce,
    encrypted: input.encrypted,
  };
}

function computeSignatureUnchecked(input: WeComCallbackSignatureInput): string {
  return createHash("sha1")
    .update([input.token, input.timestamp, input.nonce, input.encrypted].sort().join(""), "utf8")
    .digest("hex");
}

/**
 * Compute WeCom's SHA-1 callback signature. The four values are sorted as
 * strings, concatenated, and hashed; the encrypted value is not decoded first.
 */
export function computeWeComCallbackSignature(input: WeComCallbackSignatureInput): string {
  const token = validateToken(input.token, "request");
  const timestamp = validateTimestamp(input.timestamp);
  const nonce = validateNonce(input.nonce);
  if (typeof input.encrypted !== "string") {
    requestFail("invalid_ciphertext", "encrypted callback payload is invalid.");
  }
  assertRawCiphertextSize(input.encrypted, DEFAULT_WECOM_CALLBACK_LIMITS.maxCiphertextBytes);
  return computeSignatureUnchecked({ token, timestamp, nonce, encrypted: input.encrypted });
}

function constantTimeSignatureMatches(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, "ascii");
  const suppliedBytes = Buffer.alloc(SHA1_HEX_LENGTH);
  const suppliedPrefix = Buffer.from(supplied.slice(0, SHA1_HEX_LENGTH), "ascii");
  suppliedPrefix.copy(suppliedBytes);
  const shapeIsValid = supplied.length === SHA1_HEX_LENGTH && SIGNATURE_PATTERN.test(supplied);
  const bytesMatch = timingSafeEqual(expectedBytes, suppliedBytes);
  return shapeIsValid && bytesMatch;
}

export type WeComCallbackSignatureVerificationInput = Readonly<{
  token: string;
  request: WeComCallbackRequest;
  maxCiphertextBytes?: number;
  maxTimestampSkewSeconds?: number;
  nowSeconds?: number;
}>;

/** Verify a standard callback signature and timestamp without attempting AES decryption. */
export function verifyWeComCallbackSignature(input: WeComCallbackSignatureVerificationInput): boolean {
  try {
    const token = validateToken(input.token, "request");
    const maxCiphertextBytes = validateIntegerLimit(
      input.maxCiphertextBytes,
      "maxCiphertextBytes",
      DEFAULT_WECOM_CALLBACK_LIMITS.maxCiphertextBytes,
      AES_BLOCK_BYTES,
    );
    const maxTimestampSkewSeconds = validateSkewLimit(input.maxTimestampSkewSeconds);
    const request = normalizeRequest(input.request, maxCiphertextBytes);
    assertTimestampFresh(request.timestamp, maxTimestampSkewSeconds, input.nowSeconds);
    const expected = computeSignatureUnchecked({ ...request, token });
    return constantTimeSignatureMatches(expected, request.msgSignature);
  } catch {
    return false;
  }
}

function removePKCS7Padding(padded: Buffer): Buffer {
  // WeCom's callback library pads to 32-byte boundaries, not merely AES's 16-byte block size.
  if (padded.length === 0 || padded.length % WECOM_PADDING_BLOCK_BYTES !== 0) {
    requestFail("invalid_padding", "decrypted callback padding has an invalid block length.");
  }
  const paddingLength = padded[padded.length - 1];
  const validLength = paddingLength >= 1
    && paddingLength <= WECOM_PADDING_BLOCK_BYTES
    && paddingLength <= padded.length;
  let mismatch = 0;
  for (let index = 1; index <= WECOM_PADDING_BLOCK_BYTES; index += 1) {
    const byte = padded[padded.length - index];
    const mask = index <= paddingLength ? 0xff : 0;
    mismatch |= (byte ^ paddingLength) & mask;
  }
  if (!validLength || mismatch !== 0) {
    requestFail("invalid_padding", "decrypted callback padding is invalid.");
  }
  return padded.subarray(0, padded.length - paddingLength);
}

function addPKCS7Padding(value: Buffer): Buffer {
  const paddingLength = WECOM_PADDING_BLOCK_BYTES - (value.length % WECOM_PADDING_BLOCK_BYTES);
  return Buffer.concat([value, Buffer.alloc(paddingLength, paddingLength)]);
}

function constantTimeReceiveIdMatches(actual: Buffer, expected: Buffer): boolean {
  const comparedActual = Buffer.alloc(expected.length);
  actual.subarray(0, expected.length).copy(comparedActual);
  const bytesMatch = timingSafeEqual(comparedActual, expected);
  return actual.length === expected.length && bytesMatch;
}

function decodeUtf8(value: Buffer, failureCode: "invalid_payload" | "encryption_failed"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    requestFail(failureCode, "callback message is not valid UTF-8.");
  }
}

export class WeComCallbackCrypto {
  readonly config: WeComCallbackConfig;

  private readonly key: Buffer;
  private readonly randomBytes: WeComCallbackRandomBytes;
  private readonly receiveIdBytes: Buffer;

  constructor(input: WeComCallbackConfigInput) {
    this.config = validateWeComCallbackConfig(input);
    this.key = decodeEncodingAESKey(this.config.encodingAESKey);
    this.receiveIdBytes = Buffer.from(this.config.receiveId, "utf8");

    const inputRecord = isRecord(input) ? input : null;
    const randomBytes = inputRecord?.randomBytes;
    if (randomBytes !== undefined && typeof randomBytes !== "function") {
      configFail("randomBytes must be a synchronous function when provided.");
    }
    this.randomBytes = randomBytes === undefined ? defaultRandomBytes : randomBytes as WeComCallbackRandomBytes;
  }

  computeSignature(timestamp: string, nonce: string, encrypted: string): string {
    return computeWeComCallbackSignature({
      token: this.config.token,
      timestamp,
      nonce,
      encrypted,
    });
  }

  verifySignature(
    input: WeComCallbackRequest,
    options: WeComCallbackVerificationOptions = {},
  ): boolean {
    try {
      const request = normalizeRequest(input, this.config.maxCiphertextBytes);
      assertTimestampFresh(
        request.timestamp,
        this.config.maxTimestampSkewSeconds,
        options.nowSeconds,
      );
      const expected = computeSignatureUnchecked({ ...request, token: this.config.token });
      return constantTimeSignatureMatches(expected, request.msgSignature);
    } catch {
      return false;
    }
  }

  decrypt(
    input: WeComCallbackRequest,
    options: WeComCallbackVerificationOptions = {},
  ): WeComDecryptedCallback {
    const request = normalizeRequest(input, this.config.maxCiphertextBytes);
    assertTimestampFresh(
      request.timestamp,
      this.config.maxTimestampSkewSeconds,
      options.nowSeconds,
    );
    const expected = computeSignatureUnchecked({ ...request, token: this.config.token });
    if (!constantTimeSignatureMatches(expected, request.msgSignature)) {
      requestFail("signature_invalid", "callback signature is invalid.");
    }

    const ciphertext = decodeCiphertext(request.encrypted, this.config.maxCiphertextBytes);
    let padded: Buffer;
    try {
      const decipher = createDecipheriv(AES_ALGORITHM, this.key, this.key.subarray(0, AES_BLOCK_BYTES));
      decipher.setAutoPadding(false);
      padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      requestFail("decryption_failed", "callback ciphertext could not be decrypted.");
    }

    const plaintext = removePKCS7Padding(padded);
    if (plaintext.length < FRAME_PREFIX_BYTES) {
      requestFail("invalid_payload", "decrypted callback frame is too short.");
    }

    const messageLength = plaintext.readUInt32BE(RANDOM_PREFIX_BYTES);
    if (messageLength > this.config.maxPlaintextBytes) {
      requestFail("message_too_large", "decrypted callback message exceeds the configured limit.");
    }
    const messageStart = FRAME_PREFIX_BYTES;
    const messageEnd = messageStart + messageLength;
    if (messageEnd > plaintext.length) {
      requestFail("invalid_payload", "decrypted callback message length is inconsistent.");
    }

    const messageBytes = plaintext.subarray(messageStart, messageEnd);
    const actualReceiveId = plaintext.subarray(messageEnd);
    if (!constantTimeReceiveIdMatches(actualReceiveId, this.receiveIdBytes)) {
      requestFail("receive_id_mismatch", "decrypted callback receive-id does not match configuration.");
    }

    return {
      message: decodeUtf8(messageBytes, "invalid_payload"),
      receiveId: this.config.receiveId,
    };
  }

  encrypt(input: Readonly<{
    message: string;
    timestamp: string;
    nonce: string;
  }>): WeComEncryptedCallback {
    if (!isRecord(input) || typeof input.message !== "string") {
      requestFail("invalid_request", "message must be a string.");
    }
    const timestamp = validateTimestamp(input.timestamp);
    const nonce = validateNonce(input.nonce);
    const messageByteLength = Buffer.byteLength(input.message, "utf8");
    if (messageByteLength > this.config.maxPlaintextBytes) {
      requestFail("message_too_large", "callback message exceeds the configured limit.");
    }
    const messageBytes = Buffer.from(input.message, "utf8");
    const frame = Buffer.alloc(FRAME_PREFIX_BYTES + messageBytes.length + this.receiveIdBytes.length);

    let randomPrefix: Uint8Array;
    try {
      randomPrefix = this.randomBytes(RANDOM_PREFIX_BYTES);
    } catch {
      requestFail("encryption_failed", "callback random prefix could not be generated.");
    }
    if (!(randomPrefix instanceof Uint8Array) || randomPrefix.byteLength !== RANDOM_PREFIX_BYTES) {
      requestFail("encryption_failed", "callback random prefix has an invalid length.");
    }

    Buffer.from(randomPrefix).copy(frame, 0);
    frame.writeUInt32BE(messageBytes.length, RANDOM_PREFIX_BYTES);
    messageBytes.copy(frame, FRAME_PREFIX_BYTES);
    this.receiveIdBytes.copy(frame, FRAME_PREFIX_BYTES + messageBytes.length);

    let encryptedBytes: Buffer;
    try {
      const cipher = createCipheriv(AES_ALGORITHM, this.key, this.key.subarray(0, AES_BLOCK_BYTES));
      cipher.setAutoPadding(false);
      const padded = addPKCS7Padding(frame);
      encryptedBytes = Buffer.concat([cipher.update(padded), cipher.final()]);
    } catch {
      requestFail("encryption_failed", "callback message could not be encrypted.");
    }

    if (encryptedBytes.length > this.config.maxCiphertextBytes) {
      requestFail("payload_too_large", "encrypted callback payload exceeds the configured limit.");
    }
    const encrypted = encryptedBytes.toString("base64");
    assertRawCiphertextSize(encrypted, this.config.maxCiphertextBytes);
    return {
      encrypted,
      msgSignature: computeSignatureUnchecked({
        token: this.config.token,
        timestamp,
        nonce,
        encrypted,
      }),
    };
  }
}

export function createWeComCallbackCrypto(input: WeComCallbackConfigInput): WeComCallbackCrypto {
  return new WeComCallbackCrypto(input);
}

export function encryptWeComCallback(
  config: WeComCallbackConfigInput,
  input: Readonly<{ message: string; timestamp: string; nonce: string }>,
): WeComEncryptedCallback {
  return new WeComCallbackCrypto(config).encrypt(input);
}

export function decryptWeComCallback(
  config: WeComCallbackConfigInput,
  input: WeComCallbackRequest,
  options: WeComCallbackVerificationOptions = {},
): WeComDecryptedCallback {
  return new WeComCallbackCrypto(config).decrypt(input, options);
}
