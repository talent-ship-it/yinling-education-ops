"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AccountAdminLifecycle,
  type AccountAccessChange,
  type AccountDirectoryRecord,
  type AccountStatusChange,
} from "@/app/account-admin-lifecycle";
import {
  AccountSecurityPanel,
  type AccountMfaSetup,
  type AccountSecuritySession,
} from "@/app/account-security-panel";
import type { DemoSessionRole } from "@/lib/demo-session-token";

type AccountLifecycleWorkspaceProps = Readonly<{
  currentUser: string;
  currentRole: DemoSessionRole;
  canManageAccounts: boolean;
  refreshVersion: number;
  onChangePassword: () => void;
  onResetPassword: (account: AccountDirectoryRecord) => void;
  onViewAccount: (account: AccountDirectoryRecord) => void;
}>;

const PERMISSION_OPTIONS = [
  { key: "operations.read", label: "查看运营资料" },
  { key: "operations.write", label: "更新运营资料" },
  { key: "students.read.assigned", label: "查看分配学生" },
  { key: "bookings.read.assigned", label: "查看分配排课" },
  { key: "bookings.write.assigned", label: "更新分配排课" },
  { key: "messages.write.assigned", label: "发送分配学生消息" },
  { key: "availability.write.self", label: "提交本人可用时间" },
] as const;

function normalize(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-AU");
}

async function responseBody(response: Response) {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export function AccountLifecycleWorkspace({
  currentUser,
  currentRole,
  canManageAccounts,
  refreshVersion,
  onChangePassword,
  onResetPassword,
  onViewAccount,
}: AccountLifecycleWorkspaceProps) {
  const [accounts, setAccounts] = useState<AccountDirectoryRecord[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(canManageAccounts);
  const [directoryBusy, setDirectoryBusy] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState("");
  const [directoryNotice, setDirectoryNotice] = useState("");
  const [securityLoading, setSecurityLoading] = useState(false);
  const [securityBusy, setSecurityBusy] = useState<"mfa-begin" | "mfa-verify" | "mfa-disable" | "sessions" | null>(null);
  const [securityError, setSecurityError] = useState("");
  const [securityNotice, setSecurityNotice] = useState("");
  const [selfSessions, setSelfSessions] = useState<AccountSecuritySession[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<AccountSecuritySession[]>([]);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaSetup, setMfaSetup] = useState<AccountMfaSetup | null>(null);
  const selectedAccountRequestRef = useRef(0);
  const handledRefreshVersionRef = useRef(refreshVersion);

  const currentAccount = useMemo(() => accounts.find((account) => (
    account.account_role === currentRole && normalize(account.account_name) === normalize(currentUser)
  )), [accounts, currentRole, currentUser]);

  const loadDirectory = useCallback(async (preferredAccountId?: string | null) => {
    if (!canManageAccounts) return;
    setDirectoryLoading(true);
    setDirectoryError("");
    try {
      const response = await fetch("/api/accounts", { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok || !Array.isArray(body.accounts)) throw new Error(typeof body.error === "string" ? body.error : "账号目录读取失败。");
      const next = body.accounts as AccountDirectoryRecord[];
      const requested = preferredAccountId ?? null;
      const nextSelectedAccountId = next.some((account) => account.account_id === requested)
        ? requested
        : next.find((account) => account.super_admin)?.account_id ?? next[0]?.account_id ?? null;
      setAccounts(next);
      setSelectedAccountId(nextSelectedAccountId);
      return nextSelectedAccountId;
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "账号目录读取失败。");
      return null;
    } finally {
      setDirectoryLoading(false);
    }
  }, [canManageAccounts]);

  const loadSelectedAccount = useCallback(async (accountId: string) => {
    if (!canManageAccounts) return;
    const requestId = selectedAccountRequestRef.current + 1;
    selectedAccountRequestRef.current = requestId;
    setSelectedSessions([]);
    try {
      const response = await fetch(`/api/accounts?accountId=${encodeURIComponent(accountId)}`, { cache: "no-store" });
      const body = await responseBody(response);
      if (!response.ok || !body.account || typeof body.account !== "object") {
        throw new Error(typeof body.error === "string" ? body.error : "账号详情读取失败。");
      }
      if (selectedAccountRequestRef.current !== requestId) return;
      const account = body.account as AccountDirectoryRecord;
      setAccounts((current) => current.map((item) => item.account_id === account.account_id ? account : item));
      setSelectedSessions(Array.isArray(body.sessions) ? body.sessions as AccountSecuritySession[] : []);
    } catch (error) {
      if (selectedAccountRequestRef.current !== requestId) return;
      setDirectoryError(error instanceof Error ? error.message : "账号详情读取失败。");
    }
  }, [canManageAccounts]);

  const loadSecurity = useCallback(async () => {
    setSecurityLoading(true);
    setSecurityError("");
    try {
      const [mfaResponse, sessionsResponse] = await Promise.all([
        fetch("/api/account/mfa", { cache: "no-store" }),
        fetch("/api/account/sessions", { cache: "no-store" }),
      ]);
      const [mfaBody, sessionsBody] = await Promise.all([responseBody(mfaResponse), responseBody(sessionsResponse)]);
      if (!mfaResponse.ok) throw new Error(typeof mfaBody.error === "string" ? mfaBody.error : "MFA 状态读取失败。");
      if (!sessionsResponse.ok) throw new Error(typeof sessionsBody.error === "string" ? sessionsBody.error : "登录会话读取失败。");
      setMfaEnabled(mfaBody.enabled === true);
      if (!mfaBody.setupPending) setMfaSetup(null);
      setSelfSessions(Array.isArray(sessionsBody.sessions) ? sessionsBody.sessions as AccountSecuritySession[] : []);
    } catch (error) {
      setSecurityError(error instanceof Error ? error.message : "账号安全状态读取失败。");
    } finally {
      setSecurityLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Starts authenticated server reads when the account workspace mounts; state updates occur after the responses settle.
    void loadSecurity();
    void loadDirectory();
  }, [loadDirectory, loadSecurity]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Loads server-owned authorization and session detail for the selected directory row.
    if (selectedAccountId) void loadSelectedAccount(selectedAccountId);
  }, [loadSelectedAccount, selectedAccountId]);

  useEffect(() => {
    if (handledRefreshVersionRef.current === refreshVersion) return;
    handledRefreshVersionRef.current = refreshVersion;
    void (async () => {
      const accountId = await loadDirectory(selectedAccountId);
      if (accountId) await loadSelectedAccount(accountId);
    })();
  }, [loadDirectory, loadSelectedAccount, refreshVersion, selectedAccountId]);

  const updateAccess = async (change: AccountAccessChange) => {
    if (directoryBusy) return;
    setDirectoryBusy("access");
    setDirectoryError("");
    setDirectoryNotice("");
    try {
      const response = await fetch("/api/accounts/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...change, commandKey: `account-access:${crypto.randomUUID()}` }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "账号权限保存失败。");
      setDirectoryNotice("权限和数据范围已保存；该账号原有会话已撤销。");
      await loadDirectory(change.accountId);
      await loadSelectedAccount(change.accountId);
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "账号权限保存失败。");
    } finally {
      setDirectoryBusy(null);
    }
  };

  const updateStatus = async (change: AccountStatusChange) => {
    if (directoryBusy) return;
    setDirectoryBusy("status");
    setDirectoryError("");
    setDirectoryNotice("");
    try {
      const response = await fetch("/api/accounts/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...change, commandKey: `account-status:${crypto.randomUUID()}` }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "账号状态保存失败。");
      setDirectoryNotice(change.status === "disabled" ? "账号已停用，活动会话已撤销。" : "账号已恢复；如该账号尚无独立密码，请立即重置临时密码后再通知本人登录。");
      await loadDirectory(change.accountId);
      await loadSelectedAccount(change.accountId);
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "账号状态保存失败。");
    } finally {
      setDirectoryBusy(null);
    }
  };

  const revokeSelectedSessions = async (account: AccountDirectoryRecord) => {
    if (directoryBusy) return;
    setDirectoryBusy("sessions");
    setDirectoryError("");
    try {
      const response = await fetch("/api/account/sessions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.account_id, revokeAll: true }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "会话撤销失败。");
      if (body.reauthRequired === true) window.location.reload();
      setDirectoryNotice(`${account.account_name} 的活动会话已撤销。`);
      await loadSelectedAccount(account.account_id);
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "会话撤销失败。");
    } finally {
      setDirectoryBusy(null);
    }
  };

  const resetSelectedMfa = async (account: AccountDirectoryRecord) => {
    if (directoryBusy) return;
    setDirectoryBusy("mfa");
    setDirectoryError("");
    try {
      const response = await fetch("/api/accounts/mfa-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.account_id }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "MFA 重置失败。");
      setDirectoryNotice(`${account.account_name} 的 MFA 已重置，活动会话已撤销。`);
      await loadDirectory(account.account_id);
      await loadSelectedAccount(account.account_id);
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : "MFA 重置失败。");
    } finally {
      setDirectoryBusy(null);
    }
  };

  const beginMfa = async (currentPassword: string) => {
    if (securityBusy) return;
    setSecurityBusy("mfa-begin");
    setSecurityError("");
    setSecurityNotice("");
    try {
      const response = await fetch("/api/account/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "begin", currentPassword }),
      });
      const body = await responseBody(response);
      if (!response.ok || typeof body.secret !== "string" || typeof body.otpauthUri !== "string" || typeof body.mfaVersion !== "number") {
        throw new Error(typeof body.error === "string" ? body.error : "MFA 设置初始化失败。");
      }
      setMfaSetup({ secret: body.secret, otpauthUri: body.otpauthUri, mfaVersion: body.mfaVersion });
      setSecurityNotice("验证器密钥已生成；输入当前验证码后才会正式启用。");
    } catch (error) {
      setSecurityError(error instanceof Error ? error.message : "MFA 设置初始化失败。");
    } finally {
      setSecurityBusy(null);
    }
  };

  const mutateMfa = async (action: "verify" | "disable", code: string, currentPassword?: string) => {
    if (securityBusy) return;
    setSecurityBusy(action === "verify" ? "mfa-verify" : "mfa-disable");
    setSecurityError("");
    try {
      const response = await fetch("/api/account/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, code, ...(currentPassword ? { currentPassword } : {}) }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "MFA 操作失败。");
      window.location.reload();
    } catch (error) {
      setSecurityError(error instanceof Error ? error.message : "MFA 操作失败。");
      setSecurityBusy(null);
    }
  };

  const revokeSelfSessions = async () => {
    if (securityBusy) return;
    setSecurityBusy("sessions");
    setSecurityError("");
    try {
      const response = await fetch("/api/account/sessions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revokeAll: true }),
      });
      const body = await responseBody(response);
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "会话撤销失败。");
      window.location.reload();
    } catch (error) {
      setSecurityError(error instanceof Error ? error.message : "会话撤销失败。");
      setSecurityBusy(null);
    }
  };

  return <div className="account-lifecycle-stack">
    <AccountSecurityPanel
      accountLabel={currentUser === "Nixon" ? "Admin" : currentUser}
      accountLogin={currentUser}
      mfaEnabled={mfaEnabled}
      mfaSetup={mfaSetup}
      sessions={selfSessions}
      loading={securityLoading}
      busyAction={securityBusy}
      error={securityError}
      notice={securityNotice}
      onChangePassword={onChangePassword}
      onBeginMfa={(currentPassword) => void beginMfa(currentPassword)}
      onVerifyMfa={(code, currentPassword) => void mutateMfa("verify", code, currentPassword)}
      onDisableMfa={(code) => void mutateMfa("disable", code)}
      onRevokeSessions={() => void revokeSelfSessions()}
    />

    {canManageAccounts ? <AccountAdminLifecycle
      accounts={accounts}
      selectedAccountId={selectedAccountId}
      currentAccountId={currentAccount?.account_id ?? null}
      permissionOptions={PERMISSION_OPTIONS}
      loading={directoryLoading}
      busyAction={directoryBusy ?? (directoryLoading ? "all" : null)}
      error={directoryError}
      notice={directoryNotice}
      subtitle="角色保持与登录身份绑定；可调整最小权限和数据范围、停用账号、重置临时密码、撤销会话与 MFA。邀请投递尚未配置，因此不会显示虚假的“已发送”操作。"
      onSelectAccount={setSelectedAccountId}
      onUpdateAccess={(change) => void updateAccess(change)}
      onSetStatus={(change) => void updateStatus(change)}
      onResetPassword={onResetPassword}
      onRevokeSessions={(account) => void revokeSelectedSessions(account)}
      onResetMfa={(account) => void resetSelectedMfa(account)}
      onViewAccount={onViewAccount}
    /> : <section className="panel"><div className="form-notice">当前角色只能管理自己的密码、MFA 与登录会话；账号目录由超级管理员维护。</div></section>}
    {selectedSessions.length > 0 && canManageAccounts ? <p className="form-footnote account-selected-session-summary">所选账号当前有 {selectedSessions.length} 个活动会话。</p> : null}
  </div>;
}

export default AccountLifecycleWorkspace;
