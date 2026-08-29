import "server-only";

import {
  AccountIssuedPasswordError,
  decryptAccountIssuedPasswordWithSecret,
  encryptAccountIssuedPasswordWithSecret,
} from "@/lib/account-issued-password-crypto";

export { AccountIssuedPasswordError };

function escrowSecret() {
  const secret = process.env.OPS_API_SECRET;
  if (!secret) throw new AccountIssuedPasswordError("账号发放密码加密配置尚未完成。");
  return secret;
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
  return decryptAccountIssuedPasswordWithSecret({ ...input, secret: escrowSecret() });
}
