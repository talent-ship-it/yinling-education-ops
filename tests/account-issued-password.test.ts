import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountIssuedPasswordError,
  decryptAccountIssuedPasswordWithSecret,
  decryptAccountIssuedPasswordWithSecretFallback,
  encryptAccountIssuedPasswordWithSecret,
} from "../lib/account-issued-password-crypto";

const binding = {
  accountId: "123e4567-e89b-42d3-a456-426614174000",
  credentialVersion: 3,
  commandKey: "account-password:123e4567-e89b-42d3-a456-426614174000",
  secret: "unit-test-only-issued-password-secret",
} as const;

test("issued passwords use unique AES-GCM nonces and round-trip", () => {
  const password = "ExampleSecure123";
  const first = encryptAccountIssuedPasswordWithSecret({ ...binding, password });
  const retry = encryptAccountIssuedPasswordWithSecret({ ...binding, password });
  assert.notEqual(first, retry);
  assert.ok(!first.includes(password));
  assert.equal(decryptAccountIssuedPasswordWithSecret({
    ciphertext: first,
    accountId: binding.accountId,
    credentialVersion: binding.credentialVersion,
    secret: binding.secret,
  }), password);
  assert.equal(decryptAccountIssuedPasswordWithSecret({
    ciphertext: retry,
    accountId: binding.accountId,
    credentialVersion: binding.credentialVersion,
    secret: binding.secret,
  }), password);
});

test("issued password ciphertext is bound to the account, version and secret", () => {
  const ciphertext = encryptAccountIssuedPasswordWithSecret({ ...binding, password: "ExampleSecure123" });
  const changedBindings: Array<Partial<{ accountId: string; credentialVersion: number; secret: string }>> = [
    { accountId: "123e4567-e89b-42d3-a456-426614174001" },
    { credentialVersion: binding.credentialVersion + 1 },
    { secret: `${binding.secret}-wrong` },
  ];
  for (const changed of changedBindings) {
    assert.throws(() => decryptAccountIssuedPasswordWithSecret({
      ciphertext,
      accountId: changed.accountId ?? binding.accountId,
      credentialVersion: changed.credentialVersion ?? binding.credentialVersion,
      secret: changed.secret ?? binding.secret,
    }), AccountIssuedPasswordError);
  }
});

test("issued password ciphertext rejects tampering", () => {
  const ciphertext = encryptAccountIssuedPasswordWithSecret({ ...binding, password: "ExampleSecure123" });
  const [version, iv, payload] = ciphertext.split(".");
  const first = payload.at(0);
  // Mutate a significant payload sextet. Changing the final unpadded
  // Base64URL character can alter only unused pad bits and occasionally
  // decode to the exact same authenticated bytes.
  const tampered = `${version}.${iv}.${first === "A" ? "B" : "A"}${payload.slice(1)}`;
  assert.throws(() => decryptAccountIssuedPasswordWithSecret({
    ciphertext: tampered,
    accountId: binding.accountId,
    credentialVersion: binding.credentialVersion,
    secret: binding.secret,
  }), AccountIssuedPasswordError);
});

test("legacy issued passwords are marked for one-time rewrap", () => {
  const password = "ExampleSecure123";
  const currentSecret = "current-issued-password-secret";
  const legacySecret = "legacy-ops-secret";
  const currentCiphertext = encryptAccountIssuedPasswordWithSecret({
    ...binding,
    password,
    secret: currentSecret,
  });
  const legacyCiphertext = encryptAccountIssuedPasswordWithSecret({
    ...binding,
    password,
    secret: legacySecret,
  });

  assert.deepEqual(decryptAccountIssuedPasswordWithSecretFallback({
    ciphertext: currentCiphertext,
    accountId: binding.accountId,
    credentialVersion: binding.credentialVersion,
    currentSecret,
    legacySecret,
  }), { password, requiresRewrap: false });
  assert.deepEqual(decryptAccountIssuedPasswordWithSecretFallback({
    ciphertext: legacyCiphertext,
    accountId: binding.accountId,
    credentialVersion: binding.credentialVersion,
    currentSecret,
    legacySecret,
  }), { password, requiresRewrap: true });
  assert.throws(() => decryptAccountIssuedPasswordWithSecretFallback({
    ciphertext: legacyCiphertext,
    accountId: binding.accountId,
    credentialVersion: binding.credentialVersion,
    currentSecret,
    legacySecret: null,
  }), AccountIssuedPasswordError);
});
