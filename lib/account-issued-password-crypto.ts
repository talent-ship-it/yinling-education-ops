import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";

const ENVELOPE_PATTERN = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,900})$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMAND_KEY_PATTERN = /^account-password(?:-escrow)?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUTH_TAG_LENGTH = 16;

export class AccountIssuedPasswordError extends Error {}

function escrowKey(secret: string) {
  if (!secret) throw new AccountIssuedPasswordError("账号发放密码加密配置尚未完成。");
  return createHmac("sha256", secret)
    .update("yinling-account-issued-password-key-v1", "utf8")
    .digest();
}

function validateBinding(accountId: string, credentialVersion: number) {
  if (!UUID_PATTERN.test(accountId)
      || !Number.isSafeInteger(credentialVersion)
      || credentialVersion < 1) {
    throw new AccountIssuedPasswordError("账号发放密码绑定信息无效。");
  }
}

function associatedData(accountId: string, credentialVersion: number) {
  return Buffer.from(`yinling-account-issued-password-v1\u0000${accountId.toLowerCase()}\u0000${credentialVersion}`, "utf8");
}

function deterministicIv(key: Buffer, commandKey: string, accountId: string, credentialVersion: number) {
  if (!COMMAND_KEY_PATTERN.test(commandKey)) {
    throw new AccountIssuedPasswordError("账号发放密码命令无效。");
  }
  return createHmac("sha256", key)
    .update("yinling-account-issued-password-iv-v1\u0000", "utf8")
    .update(commandKey.toLowerCase(), "utf8")
    .update("\u0000", "utf8")
    .update(accountId.toLowerCase(), "utf8")
    .update("\u0000", "utf8")
    .update(String(credentialVersion), "utf8")
    .digest()
    .subarray(0, 12);
}

export function encryptAccountIssuedPasswordWithSecret(input: Readonly<{
  password: string;
  accountId: string;
  credentialVersion: number;
  commandKey: string;
  secret: string;
}>) {
  validateBinding(input.accountId, input.credentialVersion);
  if (!input.password || Array.from(input.password).length > 128) {
    throw new AccountIssuedPasswordError("账号发放密码内容无效。");
  }
  const key = escrowKey(input.secret);
  const iv = deterministicIv(key, input.commandKey, input.accountId, input.credentialVersion);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData(input.accountId, input.credentialVersion));
  const encrypted = Buffer.concat([cipher.update(input.password, "utf8"), cipher.final()]);
  const payload = Buffer.concat([encrypted, cipher.getAuthTag()]);
  const envelope = `v1.${iv.toString("base64url")}.${payload.toString("base64url")}`;
  if (!ENVELOPE_PATTERN.test(envelope)) {
    throw new AccountIssuedPasswordError("账号发放密码加密结果无效。");
  }
  return envelope;
}

export function decryptAccountIssuedPasswordWithSecret(input: Readonly<{
  ciphertext: string;
  accountId: string;
  credentialVersion: number;
  secret: string;
}>) {
  validateBinding(input.accountId, input.credentialVersion);
  const match = ENVELOPE_PATTERN.exec(input.ciphertext);
  if (!match) throw new AccountIssuedPasswordError("账号发放密码密文无效。");
  try {
    const iv = Buffer.from(match[1], "base64url");
    const payload = Buffer.from(match[2], "base64url");
    if (iv.length !== 12 || payload.length <= AUTH_TAG_LENGTH) throw new Error("invalid-envelope");
    const encrypted = payload.subarray(0, payload.length - AUTH_TAG_LENGTH);
    const authTag = payload.subarray(payload.length - AUTH_TAG_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", escrowKey(input.secret), iv);
    decipher.setAAD(associatedData(input.accountId, input.credentialVersion));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    throw new AccountIssuedPasswordError("账号发放密码密文无法验证。");
  }
}
