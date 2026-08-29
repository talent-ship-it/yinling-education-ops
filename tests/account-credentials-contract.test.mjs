import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [
  credentialMigration,
  lifecycleMigration,
  lifecycleHardeningMigration,
  authSettlementHotfix,
  passwordPolicyMigration,
  issuedPasswordMigration,
  issuedPasswordValidationHotfix,
  credentials,
  issuedPasswordCrypto,
  issuedPasswordCryptoCore,
  accountDirectory,
  sessionToken,
  auth,
  store,
  loginRoute,
  sessionRoute,
  changeRoute,
  resetRoute,
  issuedPasswordRoute,
  accountsRoute,
  accessRoute,
  statusRoute,
  sessionsRoute,
  mfaRoute,
  mfaResetRoute,
  workspace,
  adminLifecycle,
  securityPanel,
  rateLimiter,
  logoutRoute,
  operationsClient,
] = await Promise.all([
  read("../supabase/migrations/20260827000400_app_account_credentials.sql"),
  read("../supabase/migrations/20260827000700_account_lifecycle.sql"),
  read("../supabase/migrations/20260827000900_account_lifecycle_security_hardening.sql"),
  read("../supabase/migrations/20260829000400_fix_account_auth_success_settlement.sql"),
  read("../supabase/migrations/20260829000500_disable_forced_first_login_password_change.sql"),
  read("../supabase/migrations/20260829000600_admin_issued_password_escrow.sql"),
  read("../supabase/migrations/20260829000700_fix_issued_password_escrow_validation.sql"),
  read("../lib/account-credentials.ts"),
  read("../lib/account-issued-password.ts"),
  read("../lib/account-issued-password-crypto.ts"),
  read("../lib/account-directory.ts"),
  read("../lib/demo-session-token.ts"),
  read("../lib/demo-auth.ts"),
  read("../lib/ops-store.ts"),
  read("../app/api/demo-login/route.ts"),
  read("../app/api/demo-session/route.ts"),
  read("../app/api/account/password/route.ts"),
  read("../app/api/accounts/password-reset/route.ts"),
  read("../app/api/accounts/issued-password/route.ts"),
  read("../app/api/accounts/route.ts"),
  read("../app/api/accounts/access/route.ts"),
  read("../app/api/accounts/status/route.ts"),
  read("../app/api/account/sessions/route.ts"),
  read("../app/api/account/mfa/route.ts"),
  read("../app/api/accounts/mfa-reset/route.ts"),
  read("../app/account-lifecycle-workspace.tsx"),
  read("../app/account-admin-lifecycle.tsx"),
  read("../app/account-security-panel.tsx"),
  read("../lib/account-rate-limit.ts"),
  read("../app/api/demo-logout/route.ts"),
  read("../app/operations-client.tsx"),
]);

test("account passwords and browser sessions use server-owned security material", () => {
  assert.match(credentials, /import "server-only"/);
  assert.match(credentials, /scrypt\(/);
  assert.match(credentials, /N: 32_768/);
  assert.match(credentials, /timingSafeEqual/);
  assert.match(credentials, /ACCOUNT_PASSWORD_MIN_LENGTH = 12/);
  assert.match(credentials, /accountPasswordCommandSalt/);
  assert.match(issuedPasswordCrypto, /import "server-only"/);
  assert.match(issuedPasswordCryptoCore, /aes-256-gcm/);
  assert.match(issuedPasswordCryptoCore, /createHmac\("sha256", secret\)/);
  assert.match(issuedPasswordCryptoCore, /cipher\.setAAD\(associatedData/);
  assert.match(issuedPasswordCryptoCore, /decipher\.setAuthTag/);
  assert.doesNotMatch(`${issuedPasswordCrypto}\n${issuedPasswordCryptoCore}`, /console\./);
  assert.match(sessionToken, /const SESSION_VERSION = 4/);
  assert.match(sessionToken, /export const SERVER_SESSION_VERSION = 5/);
  assert.match(sessionToken, /randomBytes\(32\)/);
  assert.match(sessionToken, /hashServerSessionToken/);
  assert.match(sessionToken, /parseServerSessionToken/);
  assert.match(auth, /getAccountSession\(envelope\.tokenHash\)/);
  assert.match(auth, /never downgraded to a legacy identity/);
});

test("credential and lifecycle tables stay private while secret-gated RPCs own mutations", () => {
  assert.match(credentialMigration, /create table if not exists internal\.app_account_credentials/);
  assert.match(credentialMigration, /put_app_account_credential_atomic/);
  assert.match(lifecycleMigration, /create table if not exists internal\.app_accounts/);
  assert.match(lifecycleMigration, /create table if not exists internal\.app_account_sessions/);
  assert.match(lifecycleMigration, /create table if not exists internal\.app_account_mfa/);
  assert.match(lifecycleMigration, /create table if not exists internal\.app_account_permission_overrides/);
  assert.match(lifecycleMigration, /create table if not exists internal\.app_account_scope_members/);
  assert.doesNotMatch(lifecycleMigration, /app_account_auth_throttles/);
  assert.match(lifecycleHardeningMigration, /create table if not exists internal\.app_account_auth_throttles/);
  assert.match(issuedPasswordMigration, /create table if not exists internal\.app_account_issued_passwords/);
  assert.match(issuedPasswordMigration, /alter table internal\.app_account_issued_passwords enable row level security/);
  assert.match(issuedPasswordMigration, /revoke all on table internal\.app_account_issued_passwords from public, anon, authenticated, service_role/);
  assert.match(issuedPasswordMigration, /create or replace function public\.rotate_account_password_tx_v3/);
  assert.match(issuedPasswordMigration, /create or replace function public\.read_account_issued_password_escrow/);
  assert.match(issuedPasswordMigration, /account\.issued_password_viewed/);
  assert.match(issuedPasswordMigration, /case when visible_state = 'available' then escrow\.ciphertext else null end/);
  assert.match(issuedPasswordValidationHotfix, /drop constraint if exists app_account_issued_passwords_check/);
  assert.match(issuedPasswordValidationHotfix, /char_length\(ciphertext\) <= 920/);
  assert.match(issuedPasswordValidationHotfix, /\{22,\}\$/);
  assert.doesNotMatch(issuedPasswordValidationHotfix, /\{22,900\}/);
  assert.doesNotMatch(issuedPasswordMigration, /password_plaintext/);
  assert.match(passwordPolicyMigration, /set must_change_password = false/);
  assert.match(lifecycleHardeningMigration, /app_account_auth_throttles_updated_idx[\s\S]*updated_at/);
  assert.match(lifecycleHardeningMigration, /add column if not exists result_snapshot jsonb/);
  assert.match(lifecycleMigration, /create table if not exists internal\.app_account_commands/);
  assert.doesNotMatch(lifecycleMigration, /chr\(0\)/);
  assert.match(lifecycleMigration, /convert_to\('yinling-account-v1', 'UTF8'\) \|\| decode\('00', 'hex'\)/);
  assert.match(lifecycleMigration, /revoke all on table internal\.app_accounts from public, anon, authenticated/);
  assert.match(lifecycleMigration, /revoke all on table internal\.app_account_sessions from public, anon, authenticated/);
  assert.match(lifecycleMigration, /revoke all on table internal\.app_account_mfa from public, anon, authenticated/);
  assert.match(lifecycleMigration, /rotate_account_password_tx/);
  assert.match(lifecycleMigration, /set_account_status/);
  assert.match(lifecycleMigration, /update_account_access/);
  assert.match(lifecycleMigration, /create_account_session/);
  assert.match(lifecycleMigration, /revoke_account_sessions/);
  assert.match(lifecycleMigration, /confirm_account_mfa/);
  assert.match(lifecycleMigration, /reset_account_mfa/);
  assert.match(lifecycleHardeningMigration, /check_account_auth_throttle/);
  assert.match(lifecycleHardeningMigration, /admit_account_auth_attempt/);
  assert.match(lifecycleHardeningMigration, /record_account_auth_attempt/);
  assert.match(lifecycleHardeningMigration, /create or replace function public\.create_account_session\([\s\S]*p_expected_credential_version bigint,[\s\S]*p_expected_access_version bigint/);
  assert.match(lifecycleHardeningMigration, /credential\.credential_version <> p_expected_credential_version/);
  assert.match(lifecycleHardeningMigration, /target\.access_version <> p_expected_access_version/);
  assert.match(lifecycleHardeningMigration, /message = 'account_login_state_stale'/);
  assert.match(lifecycleHardeningMigration, /revoke all on function public\.create_account_session\(text, uuid, text, uuid, boolean, text\)/);
  assert.match(lifecycleMigration, /if not internal\.verify_ops_secret\(p_secret\) then/);
  assert.doesNotMatch(lifecycleMigration, /\bpassword_plaintext\b/);
});

test("routes enforce full-admin boundaries and use atomic account operations", () => {
  assert.match(store, /ACCOUNT_PASSWORD_ROTATE_RPC = "rotate_account_password_tx_v3"/);
  assert.match(store, /ACCOUNT_ISSUED_PASSWORD_READ_RPC = "read_account_issued_password_escrow"/);
  assert.match(store, /ACCOUNT_SESSION_CREATE_RPC = "create_account_session"/);
  assert.match(store, /ACCOUNT_MFA_CONFIRM_RPC = "confirm_account_mfa"/);
  assert.match(loginRoute, /ensureAccountDirectory/);
  assert.match(loginRoute, /getAccountMfaForLogin/);
  assert.match(loginRoute, /verifyTotpCode/);
  assert.match(loginRoute, /mfaRequired: true/);
  assert.match(loginRoute, /createAccountSession/);
  assert.match(loginRoute, /expectedCredentialVersion: identity\.credentialVersion \?\? 0/);
  assert.match(loginRoute, /expectedAccessVersion: directory\.access_version/);
  assert.match(loginRoute, /account_login_state_stale/);
  assert.match(loginRoute, /legacyAuthentication: true/);
  assert.match(loginRoute, /resolved\.legacyAuthentication && directory\.legacy_session_allowed !== true/);
  assert.match(sessionRoute, /mustChangePassword/);

  assert.match(changeRoute, /allowPasswordChangeRequired: true/);
  assert.match(changeRoute, /verifyAccountPassword\(currentPassword/);
  assert.match(changeRoute, /rotateAccountPasswordAtomic/);
  assert.match(changeRoute, /createAccountSession/);
  assert.match(changeRoute, /getAccountByIdentity\(identityKey\)/);
  assert.match(changeRoute, /expectedCredentialVersion: result\.credential_version/);
  assert.match(changeRoute, /expectedAccessVersion: currentDirectory\.access_version/);
  assert.match(changeRoute, /issuedPasswordCiphertext: null/);
  assert.doesNotMatch(changeRoute, /newPassword[^]*NextResponse\.json/);

  assert.match(resetRoute, /hasValidNixonSession/);
  assert.match(resetRoute, /getAccountDirectory/);
  assert.match(resetRoute, /accountId/);
  assert.match(resetRoute, /mustChangePassword: false/);
  assert.match(resetRoute, /action: "admin_reset"/);
  assert.match(resetRoute, /encryptAccountIssuedPassword/);
  assert.match(resetRoute, /issuedPasswordCiphertext/);
  assert.match(resetRoute, /const expectedCredentialVersion = body\?\.expectedCredentialVersion/);
  assert.match(resetRoute, /expectedCredentialVersion: expectedCredentialVersion as number/);
  assert.doesNotMatch(resetRoute, /expectedCredentialVersion: existing\?\.credential_version \?\? 0/);
  assert.match(resetRoute, /result\.current_credential_version !== result\.credential_version/);
  assert.match(resetRoute, /password_reset_superseded/);
  assert.match(issuedPasswordRoute, /resolveAccountRequestContext/);
  assert.match(issuedPasswordRoute, /context\.fullAdmin/);
  assert.match(issuedPasswordRoute, /decryptAccountIssuedPassword/);
  assert.match(issuedPasswordRoute, /verifyAccountPassword\(password, credential\)/);
  assert.match(issuedPasswordRoute, /"Cache-Control": "private, no-store, max-age=0"/);
  assert.doesNotMatch(issuedPasswordRoute, /console\./);
  assert.match(operationsClient, /expectedCredentialVersion: account\.credential_version \?\? 0/);
  assert.match(operationsClient, /accountPasswordResetTarget\.expectedCredentialVersion/);
  const passwordRotationV2 = lifecycleHardeningMigration.slice(
    lifecycleHardeningMigration.indexOf("create or replace function public.rotate_account_password_tx_v2"),
    lifecycleHardeningMigration.indexOf("-- Materialize current built-in staff"),
  );
  assert.match(passwordRotationV2, /prior\.result_snapshot ->> 'identityKey'/);
  assert.match(passwordRotationV2, /current_credential\.credential_version/);
  assert.match(passwordRotationV2, /set result_snapshot = immutable_result/);
  assert.match(passwordRotationV2, /message = 'account_password_result_snapshot_missing'/);
  assert.match(passwordRotationV2, /revoke all on function public\.rotate_account_password_tx\(/);

  for (const route of [accountsRoute, accessRoute, statusRoute, mfaResetRoute]) {
    assert.match(route, /resolveAccountRequestContext/);
    assert.match(route, /fullAdmin/);
  }
  assert.match(accountsRoute, /getOpsState\(\["teachers"\]\)/);
  assert.match(accountsRoute, /materializeManagedAccountDirectory\(teachers\.payload, accounts\)/);
  assert.match(accountsRoute, /if \(materialized > 0\) accounts = await readManagedAccounts/);
  assert.match(accountDirectory, /DEMO_STAFF_USERS\.map/);
  assert.match(accountDirectory, /counts\.get\(normaliseDemoIdentity\(name\)\) === 1/);
  assert.match(accountDirectory, /ensureAccountDirectory\(/);
  assert.match(accountDirectory, /existingIdentityKeys/);
  assert.match(accessRoute, /role_change_unsupported/);
  assert.match(accessRoute, /validateScopeMembers/);
  assert.match(accessRoute, /getOpsState/);
  assert.match(accessRoute, /invalid_scope_member/);
  assert.match(accessRoute, /record\.kind === "all" && key === "\*"/);
  assert.doesNotMatch(workspace, /accounts\.(?:read|manage|sessions\.revoke|mfa\.reset)/);
  assert.doesNotMatch(accessRoute, /"accounts\.(?:read|manage|sessions\.revoke|mfa\.reset)"/);
  assert.doesNotMatch(workspace, /payroll\.read/);
  assert.doesNotMatch(accessRoute, /"payroll\.read"/);
  assert.match(lifecycleHardeningMigration, /when 'admin' then array\[\s*'operations\.read', 'operations\.write'/);
  assert.match(lifecycleHardeningMigration, /where permission in \([\s\S]*'accounts\.read'[\s\S]*'payroll\.read'[\s\S]*\);/);
  const statusFunction = lifecycleHardeningMigration.slice(
    lifecycleHardeningMigration.indexOf("create or replace function public.set_account_status"),
    lifecycleHardeningMigration.indexOf("create or replace function public.update_account_access"),
  );
  const statusReplay = statusFunction.slice(statusFunction.indexOf("if prior.command_key is not null"), statusFunction.indexOf("if target.access_version"));
  assert.match(statusReplay, /prior\.account_id, p_status, prior\.result_version/);
  assert.doesNotMatch(statusReplay, /target\.status|target\.access_version/);
  assert.match(statusFunction, /result_snapshot := jsonb_build_object/);
  assert.match(statusFunction, /result_version, result_snapshot, audit_id/);
  const accessFunction = lifecycleHardeningMigration.slice(
    lifecycleHardeningMigration.indexOf("create or replace function public.update_account_access"),
    lifecycleHardeningMigration.indexOf("create or replace function public.read_account_session"),
  );
  const accessReplay = accessFunction.slice(accessFunction.indexOf("if prior.command_key is not null"), accessFunction.indexOf("if target.role_version"));
  assert.match(accessReplay, /prior\.result_snapshot ->> 'status'/);
  assert.match(accessReplay, /jsonb_array_elements_text\(prior\.result_snapshot -> 'permissions'\)/);
  assert.doesNotMatch(accessReplay, /app_account_effective_permissions\(target/);
  assert.match(accessFunction, /'scopeMembers', result_scope/);
  assert.match(accessRoute, /unrestricted && parsed\.length > 0/);
  assert.match(accessRoute, /empty stored scope is its canonical form/);
  assert.match(accessRoute, /target\.credential_version === null/);
  assert.match(accessRoute, /independent_password_required/);
  assert.match(lifecycleHardeningMigration, /account_role_change_unsupported/);
  assert.doesNotMatch(lifecycleHardeningMigration, /set\s+account_role\s*=\s*p_account_role/);
  assert.match(sessionsRoute, /targetAccountId !== context\.session\.accountId && !context\.fullAdmin/);
  assert.match(mfaRoute, /encryptMfaSecret/);
  assert.match(mfaRoute, /verifyTotpCode/);
  assert.match(mfaRoute, /expireAuthCookies/);
});

test("authentication attempts are HMAC-keyed, database-throttled and logout reports ledger failures", () => {
  assert.match(rateLimiter, /createHmac\("sha256"/);
  assert.match(rateLimiter, /OPS_API_SECRET/);
  assert.match(rateLimiter, /checkAccountAuthThrottle/);
  assert.match(rateLimiter, /admitAccountAuthAttempt/);
  assert.match(rateLimiter, /recordAccountAuthAttempt/);
  assert.match(rateLimiter, /settleSuccessfulAuthAttempt/);
  assert.match(rateLimiter, /accountAuthThrottleIdentityKey/);
  assert.match(rateLimiter, /x-vercel-forwarded-for/);
  assert.doesNotMatch(rateLimiter, /request\.headers\.get\("x-forwarded-for"\)/);
  assert.doesNotMatch(rateLimiter, /cf-connecting-ip/);
  assert.match(rateLimiter, /return `\$\{dimension === "network" \? "n" : "i"\}:\$\{digest\}`/);
  assert.match(lifecycleHardeningMigration, /throttle_key ~ '\^\[ni\]:\[a-f0-9\]\{64\}\$'/);
  assert.match(lifecycleHardeningMigration, /throttle_key_value like 'n:%'[\s\S]*next_attempts >= 500[\s\S]*interval '5 minutes'/);
  assert.match(lifecycleHardeningMigration, /throttle_key_value like 'i:%'[\s\S]*next_attempts >= 10[\s\S]*interval '1 hour'/);
  assert.doesNotMatch(lifecycleHardeningMigration, /set enabled = p_status = 'active'/);
  assert.match(lifecycleHardeningMigration, /Account status and credential status are independent/);
  assert.doesNotMatch(lifecycleHardeningMigration, /update internal\.app_account_credentials c[\s\S]{0,240}where c\.account_id = target\.account_id/);
  assert.doesNotMatch(rateLimiter, /console\./);
  assert.match(loginRoute, /admitAuthAttempt\(throttleKeys\)/);
  assert.ok(loginRoute.indexOf("resolveNamedIdentity(username, teachersPayload)") < loginRoute.indexOf("admitAuthAttempt(throttleKeys)"));
  assert.ok(loginRoute.indexOf("admitAuthAttempt(throttleKeys)") < loginRoute.indexOf("resolveLoginIdentity(username, password, teachersPayload, requested)"));
  assert.match(loginRoute, /checkAuthThrottle\(networkThrottleKeys\)/);
  assert.match(loginRoute, /account:\$\{accountIdentityKey\(requested\.identity\.user, requested\.identity\.role\)\}/);
  assert.match(loginRoute, /\$\{hasUsername \? "unknown" : "legacy"\}:\$\{networkThrottleKeys\[0\]\}/);
  assert.doesNotMatch(loginRoute, /recordAuthAttempt\([^\n]*false\)/);
  assert.match(loginRoute, /settleSuccessfulAuthAttempt\(throttleKeys\)/);
  const mfaChallenge = loginRoute.slice(
    loginRoute.indexOf("if (mfaCode === undefined)"),
    loginRoute.indexOf("if (typeof mfaCode", loginRoute.indexOf("if (mfaCode === undefined)")),
  );
  assert.match(mfaChallenge, /settleSuccessfulAuthAttempt\(throttleKeys\)/);
  assert.match(mfaChallenge, /mfaRequired: true/);
  assert.match(mfaRoute, /settleSuccessfulAuthAttempt\(throttleKeys\)/);
  assert.match(changeRoute, /settleSuccessfulAuthAttempt\(throttleKeys\)/);
  assert.match(loginRoute, /Retry-After/);
  assert.match(mfaRoute, /accountAuthThrottleKeys\(request, "mfa"/);
  assert.match(mfaRoute, /admitAuthAttempt\(throttleKeys\)/);
  assert.match(changeRoute, /admitAuthAttempt\(throttleKeys\)/);
  assert.doesNotMatch(mfaRoute, /recordAuthAttempt\([^\n]*false\)/);
  assert.doesNotMatch(changeRoute, /recordAuthAttempt\([^\n]*false\)/);
  assert.match(lifecycleHardeningMigration, /create or replace function public\.admit_account_auth_attempt/);
  assert.match(lifecycleHardeningMigration, /order by case when key like 'n:%' then 0 else 1 end, key/);
  assert.match(lifecycleHardeningMigration, /where t\.throttle_key = throttle_key_value\s+for update/);
  const admissionFunction = lifecycleHardeningMigration.slice(
    lifecycleHardeningMigration.indexOf("create or replace function public.admit_account_auth_attempt"),
    lifecycleHardeningMigration.indexOf("create or replace function public.check_account_auth_throttle"),
  );
  assert.match(admissionFunction, /cardinality\(p_throttle_keys\) not between 1 and 2/);
  assert.match(admissionFunction, /throttle\.blocked_until > admitted_at[\s\S]*return query select true[\s\S]*return;/);
  assert.ok(admissionFunction.indexOf("key like 'n:%' then 0") < admissionFunction.indexOf("insert into internal.app_account_auth_throttles"));
  const firstAdmissionLoop = admissionFunction.indexOf("for throttle_key_value in");
  const blockedCheck = admissionFunction.indexOf("if throttle.blocked_until > admitted_at", firstAdmissionLoop);
  const secondAdmissionLoop = admissionFunction.indexOf("for throttle_key_value in", firstAdmissionLoop + 1);
  const firstIncrement = admissionFunction.indexOf("next_attempts :=", secondAdmissionLoop);
  assert.ok(firstAdmissionLoop >= 0 && firstAdmissionLoop < blockedCheck
    && blockedCheck < secondAdmissionLoop && secondAdmissionLoop < firstIncrement);
  const recordFunction = lifecycleHardeningMigration.slice(
    lifecycleHardeningMigration.indexOf("create or replace function public.record_account_auth_attempt"),
    lifecycleHardeningMigration.indexOf("revoke all on function public.admit_account_auth_attempt"),
  );
  const successSettlement = recordFunction.slice(
    recordFunction.indexOf("if p_succeeded then"),
    recordFunction.indexOf("return query select false, 0;"),
  );
  assert.match(successSettlement, /throttle\.failed_attempts - 1/);
  assert.match(successSettlement, /network-first order/);
  assert.doesNotMatch(successSettlement, /where t\.throttle_key = any\(p_throttle_keys\)/);
  assert.match(authSettlementHotfix, /select distinct supplied\.key[\s\S]*\) keys[\s\S]*order by case when keys\.key like 'n:%'/);
  assert.doesNotMatch(authSettlementHotfix, /select distinct key from unnest\(p_throttle_keys\) key\s+order by case/);
  assert.match(logoutRoute, /serverSessionRevoked/);
  assert.match(logoutRoute, /revokeCurrentAccountSession/);
  assert.match(logoutRoute, /sessionId: envelope\.sessionId/);
  assert.match(logoutRoute, /tokenHash: envelope\.tokenHash/);
  assert.doesNotMatch(logoutRoute, /getCurrentDemoSession/);
  assert.match(store, /ACCOUNT_CURRENT_SESSION_REVOKE_RPC = "revoke_current_account_session"/);
  assert.match(lifecycleHardeningMigration, /create or replace function public\.revoke_current_account_session/);
  assert.match(lifecycleHardeningMigration, /s\.session_id = p_session_id and s\.token_hash = p_token_hash/);
  assert.match(lifecycleHardeningMigration, /revoke_reason = 'explicit_logout'/);
  assert.match(logoutRoute, /localLogout: true/);
  assert.match(logoutRoute, /status: serverSessionRevoked \? 200 : 503/);
  assert.match(logoutRoute, /LOGOUT_RETRY_COOKIE_NAME/);
  assert.match(logoutRoute, /maxAge: SERVER_SESSION_MAX_AGE_SECONDS/);
  assert.match(logoutRoute, /path: "\/api\/demo-logout"/);
  assert.match(logoutRoute, /if \(!retryRequested\) \{[\s\S]*response\.cookies\.set\(DEMO_COOKIE_NAME/);
  assert.match(logoutRoute, /retryRequested[\s\S]*\? pendingRetryTokens[\s\S]*:\s*\[\.\.\.retryTokens\(primaryCookieValue\), \.\.\.pendingRetryTokens\]/);
  assert.match(logoutRoute, /Promise\.all\(candidateTokens\.map\(\(token\) => revokeServerSession\(token\)\)\)/);
  assert.match(logoutRoute, /const unresolvedTokens = candidateTokens\.filter/);
  assert.match(logoutRoute, /serialiseRetryTokens\(unresolvedTokens\)/);
  assert.match(logoutRoute, /if \(serverSessionRevoked\) \{[\s\S]*maxAge: 0[\s\S]*\} else \{[\s\S]*unresolvedTokens/);
});

test("account UI wires real password, MFA, session and authorization actions without fake delivery", () => {
  assert.match(workspace, /fetch\("\/api\/account\/mfa"/);
  assert.match(workspace, /fetch\("\/api\/account\/sessions"/);
  assert.match(workspace, /fetch\("\/api\/accounts\/access"/);
  assert.match(workspace, /fetch\("\/api\/accounts\/status"/);
  assert.match(workspace, /fetch\("\/api\/accounts\/mfa-reset"/);
  assert.match(workspace, /fetch\("\/api\/accounts\/issued-password"/);
  assert.match(workspace, /邀请投递尚未配置/);
  assert.doesNotMatch(workspace, /onResendInvite=/);
  assert.match(adminLifecycle, /重置登录密码/);
  assert.match(adminLifecycle, /查看密码/);
  assert.match(adminLifecycle, /本人自行修改后不可查看/);
  assert.match(adminLifecycle, /account\.credential_version/);
  assert.match(adminLifecycle, /撤销此账号会话/);
  assert.match(adminLifecycle, /重置 MFA/);
  assert.match(adminLifecycle, /账号角色（与登录身份绑定）/);
  assert.match(adminLifecycle, /accountAuthorizationLoaded/);
  assert.match(adminLifecycle, /independentPasswordMissing/);
  assert.match(adminLifecycle, /请先建立独立密码/);
  assert.match(adminLifecycle, /学生\/老师请填系统 ID/);
  assert.match(adminLifecycle, /key=\{accountEditorStateKey\(selected\)\}/);
  assert.match(adminLifecycle, /disabled=\{!authorizationLoaded \|\| independentPasswordMissing \|\| isBusy\("access"\)\}/);
  assert.match(securityPanel, /修改密码/);
  assert.match(securityPanel, /设置 MFA/);
  assert.match(securityPanel, /退出所有设备/);
  assert.match(securityPanel, /accountLogin: string/);
  assert.match(securityPanel, /<PasswordUsernameContext login=\{accountLogin\} \/>/);
  assert.match(workspace, /accountLogin=\{currentUser\}/);
  assert.match(operationsClient, /function PasswordUsernameContext\(\{ login \}: \{ login: string \}\)/);
  assert.match(operationsClient, /name="username"[\s\S]*autoComplete="username"|autoComplete="username"[\s\S]*name="username"/);
  assert.match(operationsClient, /accountLogin=\{user\}/);
  assert.match(operationsClient, /accountLogin=\{sessionOperator\}/);
  assert.match(operationsClient, /<PasswordUsernameContext login=\{accountPasswordResetTarget\.login\} \/>/);
  assert.doesNotMatch(`${workspace}\n${adminLifecycle}\n${securityPanel}`, /临时密码[:：]\s*\{/);
});
