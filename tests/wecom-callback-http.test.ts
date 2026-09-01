import assert from "node:assert/strict";
import test from "node:test";

import {
  encryptedWecomXmlField,
  WECOM_CALLBACK_MAX_BODY_BYTES,
  wecomCallbackHttpConfiguration,
} from "../lib/wecom-callback-http";

const encodingAESKey = Buffer.alloc(32, 0x42).toString("base64").slice(0, -1);

test("keeps the standard callback disabled until all three secrets are valid", () => {
  const missing = wecomCallbackHttpConfiguration({});
  assert.equal(missing.ready, false);
  assert.equal(missing.invalid, false);
  assert.deepEqual(missing.missing, [
    "WECOM_CALLBACK_TOKEN",
    "WECOM_CALLBACK_ENCODING_AES_KEY",
    "WECOM_CORP_ID",
  ]);

  const ready = wecomCallbackHttpConfiguration({
    WECOM_CALLBACK_TOKEN: "syntheticToken42",
    WECOM_CALLBACK_ENCODING_AES_KEY: encodingAESKey,
    WECOM_CORP_ID: "wwsyntheticcorp42",
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.invalid, false);
  assert.ok(ready.crypto);

  const invalid = wecomCallbackHttpConfiguration({
    WECOM_CALLBACK_TOKEN: "bad token",
    WECOM_CALLBACK_ENCODING_AES_KEY: encodingAESKey,
    WECOM_CORP_ID: "wwsyntheticcorp42",
  });
  assert.equal(invalid.ready, false);
  assert.equal(invalid.invalid, true);
});

test("extracts exactly one bounded Encrypt element without parsing decrypted XML", () => {
  assert.equal(encryptedWecomXmlField("<xml><Encrypt><![CDATA[YWJjZA==]]></Encrypt></xml>"), "YWJjZA==");
  assert.equal(encryptedWecomXmlField("<xml><Encrypt>YWJjZA==</Encrypt></xml>"), "YWJjZA==");
  assert.equal(encryptedWecomXmlField("<xml />"), null);
  assert.equal(encryptedWecomXmlField("<Encrypt>a</Encrypt><Encrypt>b</Encrypt>"), null);
  assert.equal(encryptedWecomXmlField("x".repeat(WECOM_CALLBACK_MAX_BODY_BYTES + 1)), null);
});
