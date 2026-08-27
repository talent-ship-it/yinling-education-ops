import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [mfa, route, login, migration, hardeningMigration] = await Promise.all([
  read("../lib/account-mfa.ts"),
  read("../app/api/account/mfa/route.ts"),
  read("../app/api/demo-login/route.ts"),
  read("../supabase/migrations/20260827000700_account_lifecycle.sql"),
  read("../supabase/migrations/20260827000900_account_lifecycle_security_hardening.sql"),
]);

test("MFA secrets use authenticated encryption and TOTP comparison is timing-safe", () => {
  assert.match(mfa, /import "server-only"/);
  assert.match(mfa, /aes-256-gcm/);
  assert.match(mfa, /MFA_ENCRYPTION_KEY/);
  assert.match(mfa, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(mfa, /randomBytes\(12\)/);
  assert.match(mfa, /getAuthTag/);
  assert.match(mfa, /setAuthTag/);
  assert.match(mfa, /createHmac\("sha1"/);
  assert.match(mfa, /timingSafeEqual/);
  assert.match(mfa, /\[-1, 0, 1\]/);
});

test("MFA setup reveals the secret only to its owner before confirmation", () => {
  assert.match(route, /resolveAccountRequestContext/);
  assert.match(route, /verifyAccountPassword\(currentPassword, credential\)/);
  assert.match(route, /action === "begin" \|\| action === "verify"/);
  assert.match(route, /independent_password_required/);
  assert.match(route, /admitAuthAttempt\(throttleKeys\)/);
  assert.doesNotMatch(route, /recordAuthAttempt\(throttleKeys, false\)/);
  assert.match(route, /accountId: session\.accountId/);
  assert.match(route, /session\.sessionId/);
  assert.match(route, /expectedCredentialVersion: session\.credentialVersion/);
  assert.match(route, /expectedAccessVersion: session\.accessVersion/);
  assert.equal(route.match(/\.\.\.securitySnapshot/g)?.length, 3);
  assert.match(route, /account_security_session_stale/);
  assert.match(route, /staleSecuritySession\(\)/);
  assert.match(route, /return noStore\(\{ ok: true, secret, otpauthUri/);
  assert.match(route, /expireAuthCookies/);
  assert.match(login, /decryptMfaSecret/);
  assert.match(login, /verifyTotpCode/);
  assert.match(login, /mfaRequired: true/);
  assert.match(migration, /revoke all on table internal\.app_account_mfa from public, anon, authenticated/);
  assert.match(migration, /where a\.identity_key = p_identity_key and a\.status = 'active'/);
  assert.match(migration, /'account\.mfa_setup_started'[\s\S]*jsonb_build_object\('mfaVersion', mfa\.mfa_version\)/);
  assert.doesNotMatch(migration, /jsonb_build_object\([^)]*secret_ciphertext/);
  assert.match(hardeningMigration, /create or replace function internal\.assert_account_security_session/);
  assert.match(hardeningMigration, /saved\.revoked_at is not null/);
  assert.match(hardeningMigration, /credential\.credential_version <> p_expected_credential_version/);
  assert.match(hardeningMigration, /saved\.access_version <> p_expected_access_version/);
  assert.match(hardeningMigration, /raise exception using errcode = '40001', message = 'account_security_session_stale'/);
  assert.match(hardeningMigration, /revoke all on function public\.confirm_account_mfa\(text, uuid, bigint, uuid\)/);
  assert.match(hardeningMigration, /grant execute on function public\.confirm_account_mfa\(text, uuid, bigint, uuid, uuid, bigint, bigint\)/);
});
