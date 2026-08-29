import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountIssuedPasswordError,
  decryptAccountIssuedPasswordWithSecret,
  encryptAccountIssuedPasswordWithSecret,
} from "../lib/account-issued-password-crypto";

const binding = {
  accountId: "123e4567-e89b-42d3-a456-426614174000",
  credentialVersion: 3,
  commandKey: "account-password:123e4567-e89b-42d3-a456-426614174000",
  secret: "unit-test-only-issued-password-secret",
} as const;

test("issued passwords round-trip deterministically for exact command retries", () => {
  const password = "ExampleSecure123";
  const first = encryptAccountIssuedPasswordWithSecret({ ...binding, password });
  const retry = encryptAccountIssuedPasswordWithSecret({ ...binding, password });
  assert.equal(first, retry);
  assert.ok(!first.includes(password));
  assert.equal(decryptAccountIssuedPasswordWithSecret({
    ciphertext: first,
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
  const last = ciphertext.at(-1);
  const tampered = `${ciphertext.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  assert.throws(() => decryptAccountIssuedPasswordWithSecret({
    ciphertext: tampered,
    accountId: binding.accountId,
    credentialVersion: binding.credentialVersion,
    secret: binding.secret,
  }), AccountIssuedPasswordError);
});
