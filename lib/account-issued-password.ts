import "server-only";

import {
  AccountIssuedPasswordError,
  decryptAccountIssuedPasswordWithSecretFallback,
  encryptAccountIssuedPasswordWithSecret,
  type AccountIssuedPasswordDecryption,
} from "@/lib/account-issued-password-crypto";

export { AccountIssuedPasswordError };

function escrowSecret() {
  const secret = process.env.ACCOUNT_ISSUED_PASSWORD_SECRET?.trim();
  if (!secret || !/^[a-f0-9]{64}$/u.test(secret)) {
    throw new AccountIssuedPasswordError("账号发放密码加密配置尚未完成。");
  }
  return secret;
}

function legacyEscrowSecret(currentSecret: string) {
  // Passwords issued before ACCOUNT_ISSUED_PASSWORD_SECRET was introduced
  // were encrypted with OPS_API_SECRET. Keep that key decrypt-only while the
  // read path atomically rewraps each legacy envelope under the dedicated key.
  const secret = process.env.OPS_API_SECRET?.trim();
  return secret && secret !== currentSecret ? secret : null;
}

export function encryptAccountIssuedPassword(input: Readonly<{
  password: string;
  accountId: string;
  credentialVersion: number;
  commandKey: string;
}>) {
  return encryptAccountIssuedPasswordWithSecret({ ...input, secret: escrowSecret() });
}

export function decryptAccountIssuedPassword(input: Readonly<{
  ciphertext: string;
  accountId: string;
  credentialVersion: number;
}>) {
  return decryptAccountIssuedPasswordForMigration(input).password;
}

export function decryptAccountIssuedPasswordForMigration(input: Readonly<{
  ciphertext: string;
  accountId: string;
  credentialVersion: number;
}>): AccountIssuedPasswordDecryption {
  const currentSecret = escrowSecret();
  return decryptAccountIssuedPasswordWithSecretFallback({
    ...input,
    currentSecret,
    legacySecret: legacyEscrowSecret(currentSecret),
  });
}
