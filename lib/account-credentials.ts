import "server-only";

import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";

import type { DemoSessionRole } from "@/lib/demo-session-token";

export const ACCOUNT_PASSWORD_ALGORITHM = "scrypt-v1" as const;
export const ACCOUNT_PASSWORD_MIN_LENGTH = 12;
export const ACCOUNT_PASSWORD_MAX_LENGTH = 128;
export const ACCOUNT_COMMAND_KEY_PATTERN = /^account-[a-z0-9-]+:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createAccountCommandKey(action: string) {
  const normalizedAction = action.trim().toLocaleLowerCase("en-AU").replace(/[^a-z0-9-]/gu, "-");
  return `account-${normalizedAction}:${randomUUID()}`;
}

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

export type AccountCredentialHash = Readonly<{
  passwordAlgorithm: typeof ACCOUNT_PASSWORD_ALGORITHM;
  passwordHash: string;
  passwordSalt: string;
}>;

function normalized(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-AU");
}

export function accountIdentityKey(user: string, role: DemoSessionRole) {
  return createHash("sha256")
    .update(`yinling-account-v1\u0000${role}\u0000${normalized(user)}`)
    .digest("hex");
}

export function validateAccountPassword(password: unknown, accountName: string) {
  if (typeof password !== "string") return "请输入新密码。";
  const length = Array.from(password).length;
  if (length < ACCOUNT_PASSWORD_MIN_LENGTH) return `密码至少需要 ${ACCOUNT_PASSWORD_MIN_LENGTH} 个字符。`;
  if (length > ACCOUNT_PASSWORD_MAX_LENGTH) return `密码不能超过 ${ACCOUNT_PASSWORD_MAX_LENGTH} 个字符。`;
  if (/[\u0000-\u001f\u007f]/u.test(password)) return "密码不能包含控制字符。";
  if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) return "密码需要同时包含字母和数字。";
  if (normalized(password) === normalized(accountName)) return "密码不能与账号名称相同。";
  if (/^(.)\1+$/u.test(password)) return "密码不能全部使用同一个字符。";
  return null;
}

function derivePassword(password: string, saltHex: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(saltHex, "hex"), SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export function accountPasswordCommandSalt(commandKey: string, identityKey: string) {
  const configured = process.env.ACCOUNT_PASSWORD_COMMAND_SECRET?.trim();
  if (!configured || !/^[a-f0-9]{64}$/u.test(configured)) {
    throw new Error("账号凭据命令密钥尚未配置。");
  }
  return createHmac("sha256", Buffer.from(configured, "hex"))
    .update(`yinling-account-command-salt-v1\u0000${commandKey}\u0000${identityKey}`)
    .digest("hex")
    .slice(0, 32);
}

export async function hashAccountPassword(password: string, suppliedSalt?: string): Promise<AccountCredentialHash> {
  const passwordSalt = suppliedSalt ?? randomBytes(16).toString("hex");
  if (!/^[a-f0-9]{32}$/u.test(passwordSalt)) throw new Error("账号密码盐值无效。");
  const derived = await derivePassword(password, passwordSalt);
  return {
    passwordAlgorithm: ACCOUNT_PASSWORD_ALGORITHM,
    passwordHash: derived.toString("hex"),
    passwordSalt,
  };
}

export async function verifyAccountPassword(
  password: unknown,
  credential: Readonly<{ password_algorithm: string; password_hash: string; password_salt: string }>,
) {
  if (typeof password !== "string" || !password || credential.password_algorithm !== ACCOUNT_PASSWORD_ALGORITHM) return false;
  if (!/^[a-f0-9]{128}$/u.test(credential.password_hash) || !/^[a-f0-9]{32}$/u.test(credential.password_salt)) return false;
  const expected = Buffer.from(credential.password_hash, "hex");
  const actual = await derivePassword(password, credential.password_salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
