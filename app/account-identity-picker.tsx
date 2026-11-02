"use client";

import { useEffect, useState } from "react";
import { fetchJsonWithTimeout } from "@/lib/shared-state-recovery";

export async function switchAccountIdentity(accountId: string | null) {
  const { response, body } = await fetchJsonWithTimeout<{ error?: string }>(fetch, "/api/account/identity", {
    method: accountId === null ? "DELETE" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(accountId === null ? {} : { body: JSON.stringify({ accountId }) }),
  });
  if (!response.ok) throw new Error(body?.error ?? "切换账号失败，请重试。");
  // A full reload discards every previous identity's cached rows and pending requests.
  window.location.reload();
}

type IdentityOption = { id: string; user: string; role: string; status: string; isOriginal: boolean };

export function ReturnAdministratorButton({ className = "secondary-button" }: { className?: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <>
    <button className={className} type="button" disabled={busy} onClick={() => {
      setBusy(true);
      void switchAccountIdentity(null).catch((reason: unknown) => {
        setBusy(false);
        setError(reason instanceof Error ? reason.message : "返回管理员失败，请重试。");
      });
    }}>{busy ? "正在返回…" : "返回管理员"}</button>
    {error && <p role="alert">{error}</p>}
  </>;
}

export function AccountIdentityRecovery({ message }: { message: string }) {
  return <main className="login-shell"><section className="login-panel">
    <div className="brand-mark">吟</div><h1>账号切换已暂停</h1>
    <p role="alert">{message}</p>
    <ReturnAdministratorButton className="primary-button" />
  </section></main>;
}

export function AccountIdentityPicker({ user, role, onError }: {
  user: string; role: string; onError: (message: string) => void;
}) {
  const [accounts, setAccounts] = useState<IdentityOption[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetchJsonWithTimeout<{ accounts?: IdentityOption[]; error?: string }>(fetch, "/api/account/identity", { cache: "no-store", signal: controller.signal })
      .then(({ response, body }) => {
        if (controller.signal.aborted) return;
        if (!response.ok || !body?.accounts) throw new Error(body?.error ?? "账号列表读取失败。");
        setAccounts(body.accounts);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onError(error instanceof Error ? error.message : "账号列表读取失败。");
      });
    return () => controller.abort();
  }, [onError]);
  const current = accounts.find((account) => account.user === user && account.role === role);
  return <div className="form-grid">
    <label className="span-2">切换账号<select aria-label="切换账号" value={current?.id ?? ""} disabled={busy || !accounts.length} onChange={(event) => {
      setBusy(true);
      void switchAccountIdentity(event.target.value).catch((error: unknown) => {
        setBusy(false);
        onError(error instanceof Error ? error.message : "切换账号失败。");
      });
    }}>
      {!current && <option value="">{busy ? "正在切换…" : "请选择账号"}</option>}
      {accounts.map((account) => <option key={account.id} value={account.id} disabled={account.status !== "active"}>
        {account.isOriginal ? "Admin（原登录账号）" : `${account.user} · ${account.role === "teacher" ? "老师" : account.role === "staff" ? "教务" : "管理员"}`}{account.status !== "active" ? "（未启用）" : ""}
      </option>)}
    </select></label>
    <p className="inline-note span-2">{busy ? "正在切换并重新读取账号权限…" : "切换后按该账号的权限查看资料和执行操作。"}</p>
  </div>;
}
