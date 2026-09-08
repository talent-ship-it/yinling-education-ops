import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Next resolves this boundary marker during bundling. Execute the actual
// module in Node without that marker; no crypto behavior is mocked or copied.
const source = await readFile(new URL("../lib/account-mfa.ts", import.meta.url), "utf8");
const executable = ts.transpileModule(source.replace('import "server-only";', ""), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { decryptMfaSecret, encryptMfaSecret, matchTotpCounter } = await import(
  `data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`
);

const key = "01".repeat(32);
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
// Synthetic persisted envelope in the format already produced by the app.
const persisted = "mfa:v1:AgICAgICAgICAgIC:gs0_twWtNUB1dKd1dCQpAg:QJOTDQ0Zg6uUlY-cDeiI4-Xwi6us_88nmt7Trym0Pi4";

test("MFA setup and stored login envelopes decrypt for TOTP verification", () => {
  const first = encryptMfaSecret(secret, key);
  const second = encryptMfaSecret(secret, key);
  assert.notEqual(first, second);
  for (const envelope of [persisted, first, second]) {
    assert.match(envelope, /^mfa:v1:/u);
    const decrypted = decryptMfaSecret(envelope, key);
    assert.equal(decrypted, secret);
    // RFC 6238 SHA1 vector at 59 seconds, using this app's six digits.
    assert.equal(matchTotpCounter(decrypted, "287082", new Date(59_000)), 1);
    assert.equal(matchTotpCounter(decrypted, "000000", new Date(59_000)), null);
  }
});

test("MFA envelopes reject wrong keys, tampering, truncation and extra segments", () => {
  assert.throws(() => decryptMfaSecret(persisted, "02".repeat(32)), /ciphertext/u);
  const parts = persisted.split(":");
  for (const index of [2, 3, 4]) {
    const tampered = [...parts];
    tampered[index] = `${tampered[index][0] === "A" ? "B" : "A"}${tampered[index].slice(1)}`;
    assert.throws(() => decryptMfaSecret(tampered.join(":"), key), /ciphertext/u);
  }
  for (const malformed of [
    `${persisted}:extra`,
    parts.slice(0, -1).join(":"),
    persisted.replace("mfa:v1:", "mfa:v2:"),
    persisted.replace(parts[2], "short"),
    persisted.replace(parts[3], "short"),
    persisted.replace(parts[4], "%%%"),
  ]) assert.throws(() => decryptMfaSecret(malformed, key), /ciphertext/u);
});
