import "server-only";

import { accountIdentityKey } from "@/lib/account-credentials";
import { resolveDemoIdentity } from "@/lib/demo-auth";
import {
  lookupTeacherRosterIdentity,
  resolveTeacherIdentity,
} from "@/lib/demo-teacher-login";
import { normaliseDemoIdentity, type DemoSessionIdentity, type DemoSessionRole } from "@/lib/demo-session-token";
import {
  DEMO_ADMIN_USER,
  DEMO_LIMITED_ADMIN_USER,
  DEMO_STAFF_USERS,
  resolveDemoStaffName,
} from "@/lib/demo-users";
import {
  getAccountAuthorization,
  getAccountByIdentity,
  getAccountDirectory,
  ensureAccountDirectory,
  type AccountAuthorization,
  type AccountDirectoryRow,
  type AccountRole,
  type AccountStatus,
} from "@/lib/ops-store";

export type AccountDirectoryResolution =
  | { identity: DemoSessionIdentity }
  | { error: string; status: 400 | 404 | 409 | 503 };

export type AccountDirectoryDto = Readonly<Pick<AccountDirectoryRow,
  | "account_id"
  | "account_name"
  | "account_role"
  | "status"
  | "super_admin"
  | "access_version"
  | "role_version"
  | "scope_version"
  | "credential_version"
  | "must_change_password"
  | "mfa_enabled"
  | "created_at"
  | "updated_at"
>>;

export function isAccountRole(value: unknown): value is AccountRole {
  return value === "admin" || value === "limited-admin" || value === "staff" || value === "teacher";
}

export function isAccountStatus(value: unknown): value is AccountStatus {
  return value === "invited" || value === "active" || value === "disabled";
}

/** Convert a server-owned row to the safe account-management DTO. */
export function accountDirectoryDto(row: AccountDirectoryRow): AccountDirectoryDto {
  return {
    account_id: row.account_id,
    account_name: row.account_name,
    account_role: row.account_role,
    status: row.status,
    super_admin: row.super_admin,
    access_version: row.access_version,
    role_version: row.role_version,
    scope_version: row.scope_version,
    credential_version: row.credential_version,
    must_change_password: row.must_change_password,
    mfa_enabled: row.mfa_enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function readManagedAccounts(actorAccountId: string) {
  return (await getAccountDirectory(actorAccountId)).map(accountDirectoryDto);
}

/**
 * Materialize every unambiguous server-owned login identity before showing
 * the administration directory. This bridges roster additions that have not
 * logged in yet without accepting any client-supplied account or role.
 */
export async function materializeManagedAccountDirectory(
  teachersPayload: unknown,
  existingAccounts: readonly Pick<AccountDirectoryDto, "account_name" | "account_role">[],
) {
  if (!Array.isArray(teachersPayload)) throw new Error("老师名册暂时无法核对。");
  const rosterNames: string[] = [];
  for (const value of teachersPayload) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("老师名册暂时无法核对。");
    }
    const teacher = value as { id?: unknown; name?: unknown };
    if (typeof teacher.id !== "string" || !teacher.id.trim()
        || typeof teacher.name !== "string" || !teacher.name.trim()) {
      throw new Error("老师名册暂时无法核对。");
    }
    rosterNames.push(teacher.name.normalize("NFKC").trim());
  }

  const counts = new Map<string, number>();
  for (const name of rosterNames) {
    const key = normaliseDemoIdentity(name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const privilegedNames = new Set(
    [DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER].map(normaliseDemoIdentity),
  );
  const existingIdentityKeys = new Set(existingAccounts.map((account) =>
    accountIdentityKey(account.account_name, account.account_role)));
  const candidateIdentities: DemoSessionIdentity[] = [
    { user: DEMO_ADMIN_USER, role: "admin" },
    { user: DEMO_LIMITED_ADMIN_USER, role: "limited-admin" },
    ...DEMO_STAFF_USERS.map((user) => ({ user, role: "staff" as const })),
    ...rosterNames
      .filter((name) => counts.get(normaliseDemoIdentity(name)) === 1)
      .filter((name) => !privilegedNames.has(normaliseDemoIdentity(name)))
      .map((user) => ({ user, role: "teacher" as const })),
  ];
  const identities = candidateIdentities
    .filter((identity) => !existingIdentityKeys.has(accountIdentityKey(identity.user, identity.role)));

  // Keep outbound RPC concurrency bounded for large imported rosters.
  for (let offset = 0; offset < identities.length; offset += 8) {
    const batch = identities.slice(offset, offset + 8);
    const saved = await Promise.all(batch.map((identity) => ensureAccountDirectory({
      identityKey: accountIdentityKey(identity.user, identity.role),
      accountName: identity.user,
      accountRole: identity.role,
    })));
    if (saved.some((row, index) => !row
      || row.identity_key !== accountIdentityKey(batch[index].user, batch[index].role)
      || row.account_role !== batch[index].role)) {
      throw new Error("账号目录同步没有返回有效结果。");
    }
  }
  return identities.length;
}

export async function readManagedAccount(identityKey: string) {
  const row = await getAccountByIdentity(identityKey);
  return row ? accountDirectoryDto(row) : null;
}

export async function readAccountAuthorization(accountId: string, actorAccountId = accountId): Promise<AccountAuthorization | null> {
  return getAccountAuthorization(accountId, actorAccountId);
}

export function sameAccountIdentity(left: DemoSessionIdentity, right: DemoSessionIdentity) {
  return left.role === right.role
    && normaliseDemoIdentity(left.user) === normaliseDemoIdentity(right.user);
}

export function resolveAccountDirectoryIdentity(
  user: unknown,
  role: unknown,
  teachersPayload: unknown,
): AccountDirectoryResolution {
  if (typeof user !== "string" || !user.trim() || Array.from(user).length > 160
      || (role !== "admin" && role !== "limited-admin" && role !== "staff" && role !== "teacher")) {
    return { error: "账号信息不完整。", status: 400 };
  }
  const requestedRole = role as DemoSessionRole;
  const normalized = normaliseDemoIdentity(user);
  if (requestedRole === "admin") {
    return normalized === normaliseDemoIdentity(DEMO_ADMIN_USER)
      ? { identity: { user: DEMO_ADMIN_USER, role: "admin" } }
      : { error: "未找到该管理员账号。", status: 404 };
  }
  if (requestedRole === "limited-admin") {
    return normalized === normaliseDemoIdentity(DEMO_LIMITED_ADMIN_USER)
      ? { identity: { user: DEMO_LIMITED_ADMIN_USER, role: "limited-admin" } }
      : { error: "未找到该管理员账号。", status: 404 };
  }
  if (requestedRole === "staff") {
    const staff = resolveDemoStaffName(user);
    return staff
      ? { identity: { user: staff, role: "staff" } }
      : { error: "未找到该教务账号。", status: 404 };
  }

  const lookup = lookupTeacherRosterIdentity(user, teachersPayload);
  if ("error" in lookup) return lookup;
  if (lookup.matches.length > 1) {
    return { error: "老师姓名重复，暂时不能管理该账号。", status: 409 };
  }
  if (lookup.matches.length !== 1) return { error: "未找到该老师账号。", status: 404 };
  if ([DEMO_ADMIN_USER, DEMO_LIMITED_ADMIN_USER]
    .some((name) => normaliseDemoIdentity(name) === normaliseDemoIdentity(lookup.matches[0]))) {
    return { error: "该姓名与系统管理账号冲突，请先调整老师名册。", status: 409 };
  }
  return { identity: { user: lookup.matches[0], role: "teacher" } };
}

/** Verifies only the pre-migration review credential for one exact identity. */
export function legacyPasswordMatchesIdentity(
  password: unknown,
  target: DemoSessionIdentity,
  teachersPayload: unknown,
) {
  const pinned = resolveDemoIdentity(password);
  const resolved = pinned && pinned.role !== "staff"
    ? { identity: pinned }
    : resolveTeacherIdentity(password, teachersPayload);
  return "identity" in resolved && sameAccountIdentity(resolved.identity, target);
}
