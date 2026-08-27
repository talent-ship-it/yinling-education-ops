import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [
  migration,
  credentials,
  sessionToken,
  auth,
  store,
  loginRoute,
  sessionRoute,
  changeRoute,
  resetRoute,
  client,
] = await Promise.all([
  read("../supabase/migrations/20260827000400_app_account_credentials.sql"),
  read("../lib/account-credentials.ts"),
  read("../lib/demo-session-token.ts"),
  read("../lib/demo-auth.ts"),
  read("../lib/ops-store.ts"),
  read("../app/api/demo-login/route.ts"),
  read("../app/api/demo-session/route.ts"),
  read("../app/api/account/password/route.ts"),
  read("../app/api/accounts/password-reset/route.ts"),
  read("../app/operations-client.tsx"),
]);

test("account passwords use a slow server-only hash and a signed credential version", () => {
  assert.match(credentials, /import "server-only"/);
  assert.match(credentials, /scrypt\(/);
  assert.match(credentials, /N: 32_768/);
  assert.match(credentials, /timingSafeEqual/);
  assert.match(credentials, /ACCOUNT_PASSWORD_MIN_LENGTH = 12/);
  assert.match(credentials, /accountPasswordCommandSalt/);
  assert.match(sessionToken, /const SESSION_VERSION = 4/);
  assert.match(sessionToken, /credentialVersion\?: number/);
  assert.match(sessionToken, /cv: identity\.credentialVersion/);
});

test("credential database tables are private and password rotation is atomic and audited", () => {
  assert.match(migration, /create table if not exists internal\.app_account_credentials/);
  assert.match(migration, /password_algorithm text not null/);
  assert.match(migration, /password_hash text not null/);
  assert.match(migration, /password_salt text not null/);
  assert.doesNotMatch(migration, /\bpassword_plaintext\b|\bcurrent_password\b|\bnew_password\b/);
  assert.match(migration, /revoke all on table internal\.app_account_credentials from public, anon, authenticated/);
  assert.match(migration, /create table if not exists internal\.app_account_credential_commands/);
  assert.match(migration, /put_app_account_credential_atomic/);
  assert.match(migration, /for update/);
  assert.match(migration, /account_credential_version_conflict/);
  assert.match(migration, /account_credential_idempotency_conflict/);
  assert.match(migration, /account\.password_reset/);
  assert.match(migration, /account\.password_changed/);
  assert.match(migration, /append_operational_contract_audit/);

  const authStateStart = migration.indexOf("create or replace function public.read_app_account_auth_state");
  const credentialReadStart = migration.indexOf("create or replace function public.read_app_account_credential");
  assert.ok(authStateStart >= 0 && credentialReadStart > authStateStart);
  const authStateReader = migration.slice(authStateStart, credentialReadStart);
  assert.doesNotMatch(authStateReader, /password_hash|password_salt/);
  assert.match(authStateReader, /verify_ops_secret/);
});

test("store and protected routes expose only narrow account credential operations", () => {
  assert.match(store, /APP_ACCOUNT_AUTH_STATE_RPC = "read_app_account_auth_state"/);
  assert.match(store, /APP_ACCOUNT_CREDENTIAL_RPC = "read_app_account_credential"/);
  assert.match(store, /APP_ACCOUNT_CREDENTIAL_PUT_RPC = "put_app_account_credential_atomic"/);
  assert.match(auth, /getAppAccountAuthState/);
  assert.match(auth, /session\.credentialVersion !== authState\.credential_version/);
  assert.match(auth, /mustChangePassword && !options\.allowPasswordChangeRequired/);
  assert.doesNotMatch(auth, /accountContractUnavailable/);
  assert.match(auth, /never treat an unavailable credential reader as "no credential"/);

  assert.match(loginRoute, /body\?\.username/);
  assert.match(loginRoute, /Array\.from\(password\)\.length > 256/);
  assert.match(loginRoute, /Array\.from\(username\)\.length > 160/);
  assert.match(loginRoute, /getAppAccountCredential/);
  assert.match(loginRoute, /verifyAccountPassword/);
  assert.match(loginRoute, /credentialVersion: credential\.credential_version/);
  assert.match(loginRoute, /该账号已启用独立密码/);
  assert.doesNotMatch(loginRoute, /accountContractUnavailable/);
  assert.match(sessionRoute, /mustChangePassword/);

  assert.match(changeRoute, /getCurrentDemoSession/);
  assert.match(changeRoute, /allowPasswordChangeRequired: true/);
  assert.match(changeRoute, /verifyAccountPassword\(currentPassword/);
  assert.match(changeRoute, /legacyPasswordMatchesIdentity/);
  assert.match(changeRoute, /action: "self_change"/);
  assert.match(changeRoute, /response\.cookies\.set\(DEMO_COOKIE_NAME/);
  assert.doesNotMatch(changeRoute, /newPassword[^]*NextResponse\.json/);

  assert.match(resetRoute, /hasValidNixonSession/);
  assert.match(resetRoute, /session\.role === "admin"/);
  assert.match(resetRoute, /resolveAccountDirectoryIdentity/);
  assert.match(resetRoute, /mustChangePassword: true/);
  assert.match(resetRoute, /action: "admin_reset"/);
});

test("account UI supports named login, self-service change, and admin reset without displaying passwords", () => {
  assert.match(client, /name="username"/);
  assert.match(client, /\/api\/accounts\/password-reset/);
  assert.match(client, /重置此账号密码/);
  assert.match(client, /系统不会显示或发送密码/);
  assert.match(client, /\/api\/account\/password/);
  assert.match(client, /sessionMustChangePassword/);
  assert.match(client, /modal === "accountPasswordChange"/);
  assert.match(client, /管理员已重置此账号密码/);
  assert.doesNotMatch(client, /临时密码[:：]\s*\{/);
});
