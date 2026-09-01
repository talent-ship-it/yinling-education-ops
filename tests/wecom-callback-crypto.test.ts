import assert from "node:assert/strict";
import test from "node:test";

import {
  computeWeComCallbackSignature,
  createWeComCallbackCrypto,
  type WeComCallbackConfigInput,
  type WeComCallbackRequest,
  validateWeComCallbackConfig,
  verifyWeComCallbackSignature,
  WeComCallbackConfigError,
  WeComCallbackCryptoError,
} from "../lib/wecom-callback-crypto";

const NOW_SECONDS = 1_750_000_000;
const encodingAESKey = Buffer.alloc(32, 0x42).toString("base64").slice(0, -1);

function fixedRandomBytes(size: number) {
  return Buffer.alloc(size, 0xa5);
}

const config: WeComCallbackConfigInput = {
  token: "syntheticToken42",
  encodingAESKey,
  receiveId: "wwsyntheticcorp42",
  randomBytes: fixedRandomBytes,
};

function requestFrom(
  crypto: ReturnType<typeof createWeComCallbackCrypto>,
  encrypted: ReturnType<typeof crypto.encrypt>,
  timestamp = String(NOW_SECONDS),
  nonce = "syntheticNonce42",
): WeComCallbackRequest {
  return {
    msgSignature: encrypted.msgSignature,
    timestamp,
    nonce,
    encrypted: encrypted.encrypted,
  };
}

test("validates explicit config and performs a deterministic standard round trip", () => {
  const crypto = createWeComCallbackCrypto(config);
  const first = crypto.encrypt({
    message: "<xml><Content>synthetic callback 你好</Content></xml>",
    timestamp: String(NOW_SECONDS),
    nonce: "syntheticNonce42",
  });
  const second = crypto.encrypt({
    message: "<xml><Content>synthetic callback 你好</Content></xml>",
    timestamp: String(NOW_SECONDS),
    nonce: "syntheticNonce42",
  });

  assert.deepEqual(first, second);
  assert.deepEqual(crypto.decrypt(requestFrom(crypto, first), { nowSeconds: NOW_SECONDS }), {
    message: "<xml><Content>synthetic callback 你好</Content></xml>",
    receiveId: "wwsyntheticcorp42",
  });
  assert.equal(crypto.verifySignature(requestFrom(crypto, first), { nowSeconds: NOW_SECONDS }), true);
});

test("uses the documented sorted SHA-1 input and constant-time verifier result", () => {
  const input = {
    token: "syntheticToken42",
    timestamp: String(NOW_SECONDS),
    nonce: "syntheticNonce42",
    encrypted: "synthetic-encrypted-payload",
  } as const;
  const signature = computeWeComCallbackSignature(input);

  assert.equal(signature, "6ac21f80767f8d4778417ef85f8c3a9fd03e55b4");
  assert.equal(verifyWeComCallbackSignature({
    token: input.token,
    request: {
      msgSignature: signature,
      timestamp: input.timestamp,
      nonce: input.nonce,
      encrypted: input.encrypted,
    },
    nowSeconds: NOW_SECONDS,
  }), true);
});

test("rejects signature and ciphertext tampering before accepting a callback", () => {
  const crypto = createWeComCallbackCrypto(config);
  const encrypted = crypto.encrypt({
    message: "<xml><Content>tamper target</Content></xml>",
    timestamp: String(NOW_SECONDS),
    nonce: "tamperNonce42",
  });
  const validRequest = requestFrom(crypto, encrypted, String(NOW_SECONDS), "tamperNonce42");

  const changedSignature = { ...validRequest, msgSignature: `0${validRequest.msgSignature.slice(1)}` };
  assert.equal(crypto.verifySignature(changedSignature, { nowSeconds: NOW_SECONDS }), false);
  assert.throws(
    () => crypto.decrypt(changedSignature, { nowSeconds: NOW_SECONDS }),
    (error: unknown) => error instanceof WeComCallbackCryptoError && error.code === "signature_invalid",
  );

  const changedCiphertext = {
    ...validRequest,
    encrypted: `${validRequest.encrypted.slice(0, -2)}${validRequest.encrypted.slice(-2) === "AA" ? "AQ" : "AA"}`,
  };
  assert.equal(crypto.verifySignature(changedCiphertext, { nowSeconds: NOW_SECONDS }), false);
  assert.throws(
    () => crypto.decrypt(changedCiphertext, { nowSeconds: NOW_SECONDS }),
    (error: unknown) => error instanceof WeComCallbackCryptoError && error.code === "signature_invalid",
  );
});

test("validates receive-id and rejects stale callbacks", () => {
  const sender = createWeComCallbackCrypto(config);
  const receiver = createWeComCallbackCrypto({
    ...config,
    receiveId: "wwdifferentcorp42",
  });
  const encrypted = sender.encrypt({
    message: "<xml><Event>synthetic</Event></xml>",
    timestamp: String(NOW_SECONDS),
    nonce: "receiveIdNonce42",
  });
  const request = requestFrom(sender, encrypted, String(NOW_SECONDS), "receiveIdNonce42");

  assert.throws(
    () => receiver.decrypt(request, { nowSeconds: NOW_SECONDS }),
    (error: unknown) => error instanceof WeComCallbackCryptoError && error.code === "receive_id_mismatch",
  );
  assert.equal(sender.verifySignature(request, { nowSeconds: NOW_SECONDS + 301 }), false);
  assert.throws(
    () => sender.decrypt(request, { nowSeconds: NOW_SECONDS + 301 }),
    (error: unknown) => error instanceof WeComCallbackCryptoError && error.code === "timestamp_skew",
  );
});

test("rejects malformed EncodingAESKey, invalid PKCS#7, and oversized messages", () => {
  assert.throws(
    () => validateWeComCallbackConfig({ ...config, receiveId: "" }),
    WeComCallbackConfigError,
  );
  assert.throws(
    () => validateWeComCallbackConfig({ ...config, encodingAESKey: "not-a-43-character-key" }),
    WeComCallbackConfigError,
  );

  const crypto = createWeComCallbackCrypto(config);
  const encrypted = crypto.encrypt({
    message: "<xml><Content>padding target</Content></xml>",
    timestamp: String(NOW_SECONDS),
    nonce: "paddingNonce42",
  });
  const request = requestFrom(crypto, encrypted, String(NOW_SECONDS), "paddingNonce42");
  const signedInvalidPadding = {
    ...request,
    encrypted: encrypted.encrypted.slice(0, -4) + "AAAA",
  };
  signedInvalidPadding.msgSignature = crypto.computeSignature(
    signedInvalidPadding.timestamp,
    signedInvalidPadding.nonce,
    signedInvalidPadding.encrypted,
  );
  assert.throws(
    () => crypto.decrypt(signedInvalidPadding, { nowSeconds: NOW_SECONDS }),
    (error: unknown) => error instanceof WeComCallbackCryptoError
      && ["invalid_padding", "decryption_failed"].includes(error.code),
  );

  const bounded = createWeComCallbackCrypto({
    ...config,
    maxPlaintextBytes: 8,
  });
  assert.throws(
    () => bounded.encrypt({ message: "0123456789", timestamp: String(NOW_SECONDS), nonce: "sizeNonce42" }),
    (error: unknown) => error instanceof WeComCallbackCryptoError && error.code === "message_too_large",
  );
});
