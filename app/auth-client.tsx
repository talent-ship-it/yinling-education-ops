"use client";

import dynamic from "next/dynamic";
import { FormEvent, useEffect, useRef, useState, type ReactNode } from "react";
import { AuthStatusScreen } from "@/app/auth-status-screen";
import type { DemoSessionRole } from "@/lib/demo-session-token";
import { fetchJsonWithTimeout, type SharedStateFetch } from "@/lib/shared-state-recovery";

export type InitialSession = Readonly<{
  user: string;
  role: DemoSessionRole | "";
  mustChangePassword: boolean;
}>;

const LOGOUT_RETRY_NOTICE_KEY = "yinling:logout-retry-notice";
const AUTH_SESSION_TIMEOUT_MS = 10_000;

export async function readInitialSession(
  fetchImpl: SharedStateFetch,
  signal: AbortSignal,
  timeoutMs = AUTH_SESSION_TIMEOUT_MS,
): Promise<InitialSession | null> {
  const { response, body } = await fetchJsonWithTimeout<{
    ok?: unknown;
    user?: unknown;
    role?: unknown;
    mustChangePassword?: unknown;
  }>(fetchImpl, "/api/demo-session", { cache: "no-store", signal }, timeoutMs);
  if (!response.ok || body?.ok !== true) return null;
  return {
    user: typeof body.user === "string" ? body.user : "",
    role: typeof body.role === "string" ? body.role as DemoSessionRole : "",
    mustChangePassword: body.mustChangePassword === true,
  };
}

const OperationsApp = dynamic(() => import("./operations-client"), {
  ssr: false,
  loading: () => <AuthStatusScreen title="正在加载工作台" detail="身份已确认，正在准备教务资料。" />,
});

function AuthLoginScreen({
  onSubmit,
  loading,
  error,
  mfaRequired,
}: {
  onSubmit: (credentials: { username: string; password: string; mfaCode: string }) => Promise<void>;
  loading: boolean;
  error: string;
  mfaRequired: boolean;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const usernameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (window.matchMedia("(min-width: 761px) and (pointer: fine)").matches) usernameInputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit({ username, password, mfaCode });
  };

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">吟</div>
        <h1>吟领教务</h1>
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="username">账号 / 姓名</label>
          <input ref={usernameInputRef} id="username" name="username" value={username} type="text" autoComplete="username" placeholder="例如 Nixon、Abby 教务或老师姓名" maxLength={160} onChange={(event) => setUsername(event.target.value)} />
          <label htmlFor="password">登录密码</label>
          <input id="password" name="password" value={password} type="password" autoComplete="current-password" maxLength={256} aria-invalid={Boolean(error)} aria-describedby={error ? "login-error" : undefined} onChange={(event) => setPassword(event.target.value)} required />
          {mfaRequired ? <>
            <label htmlFor="mfa-code">验证器验证码</label>
            <input id="mfa-code" name="mfaCode" value={mfaCode} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="6 位验证码" onChange={(event) => setMfaCode(event.target.value.replace(/\D/gu, "").slice(0, 6))} required />
          </> : null}
          {error ? <span className="login-error" id="login-error" role="alert">{error}</span> : null}
          <button type="submit" disabled={loading}>{loading ? "正在进入…" : "进入系统"}</button>
        </form>
      </section>
    </main>
  );
}

export default function AuthClient({ authenticatedContent }: { authenticatedContent?: ReactNode } = {}) {
  const [authLoading, setAuthLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loginMfaRequired, setLoginMfaRequired] = useState(false);
  const [session, setSession] = useState<InitialSession | null>(null);

  useEffect(() => {
    const pendingNotice = window.sessionStorage.getItem(LOGOUT_RETRY_NOTICE_KEY);
    let cancelled = false;
    let timer: number | undefined;
    const noticeTimer = pendingNotice
      ? window.setTimeout(() => {
        if (!cancelled) setLoginError(pendingNotice);
      }, 0)
      : undefined;
    const retry = async () => {
      try {
        const response = await fetch("/api/demo-logout", {
          method: "POST",
          headers: { "x-yinling-logout-retry": "1" },
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok && body.serverSessionRevoked === true) {
          window.sessionStorage.removeItem(LOGOUT_RETRY_NOTICE_KEY);
          if (!cancelled && pendingNotice) setLoginError("");
          return;
        }
        if (!cancelled && typeof body.error === "string") setLoginError(body.error);
      } catch {
        // Keep the browser signed out while the path-scoped proof retries revocation.
      }
      if (!cancelled) timer = window.setTimeout(() => void retry(), 5_000);
    };
    void retry();
    return () => {
      cancelled = true;
      if (noticeTimer !== undefined) window.clearTimeout(noticeTimer);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    readInitialSession(fetch, controller.signal)
      .then((nextSession) => {
        if (controller.signal.aborted) return;
        setSession(nextSession);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSession(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setAuthLoading(false);
      });
    return () => controller.abort();
  }, []);

  const submitPassword = async ({ username, password, mfaCode }: { username: string; password: string; mfaCode: string }) => {
    if (loginLoading) return;
    setLoginLoading(true);
    setLoginError("");
    try {
      const response = await fetch("/api/demo-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, ...(mfaCode ? { mfaCode } : {}) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setLoginMfaRequired(body.mfaRequired === true);
        setLoginError(body.error || "密码不正确。");
        return;
      }
      setLoginMfaRequired(false);
      setSession({
        user: typeof body.user === "string" ? body.user : "",
        role: typeof body.role === "string" ? body.role as DemoSessionRole : "",
        mustChangePassword: body.mustChangePassword === true,
      });
    } catch {
      setLoginError("网络暂时不可用，请稍后重试。");
    } finally {
      setLoginLoading(false);
    }
  };

  if (authLoading) return <AuthStatusScreen title="正在检查访问状态" detail="系统正在确认当前登录身份。" />;
  if (!session) return <AuthLoginScreen onSubmit={submitPassword} loading={loginLoading} error={loginError} mfaRequired={loginMfaRequired} />;
  if (!session.mustChangePassword && authenticatedContent) return authenticatedContent;
  return <OperationsApp initialSession={session} />;
}
