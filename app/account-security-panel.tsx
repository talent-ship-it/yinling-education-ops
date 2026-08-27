"use client";

import { useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Copy,
  KeyRound,
  LogOut,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from "lucide-react";

export type AccountSecuritySession = Readonly<{
  session_id: string;
  created_at: string;
  last_seen_at: string;
  absolute_expires_at: string;
  idle_expires_at: string;
  mfa_verified: boolean;
  current: boolean;
}>;

export type AccountMfaSetup = Readonly<{
  secret: string;
  otpauthUri: string;
  mfaVersion: number;
}>;

export type AccountSecurityPanelProps = Readonly<{
  accountLabel: string;
  mfaEnabled: boolean;
  mfaSetup?: AccountMfaSetup | null;
  sessions: readonly AccountSecuritySession[];
  loading?: boolean;
  busyAction?: "mfa-begin" | "mfa-verify" | "mfa-disable" | "sessions" | null;
  error?: string;
  notice?: string;
  onChangePassword: () => void;
  onBeginMfa: (currentPassword: string) => void;
  onVerifyMfa: (code: string, currentPassword: string) => void;
  onDisableMfa: (code: string) => void;
  onRevokeSessions: () => void;
}>;

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function AccountSecurityPanel({
  accountLabel,
  mfaEnabled,
  mfaSetup,
  sessions,
  loading = false,
  busyAction = null,
  error,
  notice,
  onChangePassword,
  onBeginMfa,
  onVerifyMfa,
  onDisableMfa,
  onRevokeSessions,
}: AccountSecurityPanelProps) {
  const [code, setCode] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [confirmSessionRevoke, setConfirmSessionRevoke] = useState(false);
  const validCode = /^\d{6}$/u.test(code);

  const submitMfa = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validCode) return;
    if (mfaEnabled) onDisableMfa(code);
    else if (currentPassword) onVerifyMfa(code, currentPassword);
  };

  return <section className="panel account-security-panel" aria-labelledby="account-security-heading">
    <div className="panel-header">
      <div>
        <span className="eyebrow">当前账号</span>
        <h2 id="account-security-heading">账号安全</h2>
        <p className="form-footnote">{accountLabel} · 密码、双重验证与登录会话</p>
      </div>
      <span className={`status-pill ${mfaEnabled ? "green" : "neutral"}`}>
        {mfaEnabled ? <ShieldCheck size={14} aria-hidden="true" /> : <ShieldOff size={14} aria-hidden="true" />}
        MFA {mfaEnabled ? "已启用" : "未启用"}
      </span>
    </div>

    {error ? <div className="form-error" role="alert">{error}</div> : null}
    {notice ? <div className="form-notice" role="status"><CheckCircle2 size={15} aria-hidden="true" />{notice}</div> : null}

    <div className="student-facts account-facts">
      <span><small>活动会话</small><strong>{loading ? "读取中…" : sessions.length}</strong></span>
      <span><small>当前会话</small><strong>{sessions.some((session) => session.current) ? "已识别" : "待刷新"}</strong></span>
      <span><small>最近活动</small><strong>{sessions[0] ? formatDate(sessions[0].last_seen_at) : "无"}</strong></span>
    </div>

    <div className="account-security-actions">
      <button className="secondary-button" type="button" onClick={onChangePassword}>
        <KeyRound size={16} aria-hidden="true" />修改密码
      </button>
      {!mfaEnabled ? <label style={{ minWidth: 220 }}>当前密码<input type="password" autoComplete="current-password" value={currentPassword} maxLength={256} onChange={(event) => setCurrentPassword(event.target.value)} /></label> : null}
      {!mfaEnabled && !mfaSetup ? <button className="secondary-button" type="button" disabled={Boolean(busyAction) || !currentPassword} onClick={() => onBeginMfa(currentPassword)}>
        <Smartphone size={16} aria-hidden="true" />{busyAction === "mfa-begin" ? "正在生成…" : "设置 MFA"}
      </button> : null}
    </div>
    {!mfaEnabled ? <p className="form-footnote">开始和确认 MFA 都会重新校验当前密码，防止他人利用已登录会话绑定验证器。</p> : null}

    {mfaSetup ? <div className="detail-section">
      <span>连接验证器</span>
      <p>在 Microsoft Authenticator、Google Authenticator 或 1Password 中添加一次性验证码，然后输入当前 6 位验证码确认。</p>
      <label>手工密钥
        <div className="copy-field"><input value={mfaSetup.secret} readOnly aria-label="MFA 手工密钥" /><button className="icon-button" type="button" aria-label="复制 MFA 手工密钥" onClick={() => void navigator.clipboard.writeText(mfaSetup.secret)}><Copy size={15} /></button></div>
      </label>
      <a className="secondary-button" href={mfaSetup.otpauthUri}><Smartphone size={15} aria-hidden="true" />在验证器中打开</a>
    </div> : null}

    {(mfaEnabled || mfaSetup) ? <form className="form-grid account-mfa-form" onSubmit={submitMfa}>
      <label className="span-2">验证器验证码<input value={code} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="6 位验证码" onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))} required /></label>
      <p className="form-footnote span-2">{mfaEnabled ? "验证后会停用 MFA，并撤销当前账号所有会话。" : "确认后会启用 MFA，并要求重新登录。"}</p>
      <footer><button className={mfaEnabled ? "danger-button" : "primary-button"} type="submit" disabled={!validCode || (!mfaEnabled && !currentPassword) || Boolean(busyAction)}>{mfaEnabled ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}{busyAction === "mfa-verify" || busyAction === "mfa-disable" ? "正在验证…" : mfaEnabled ? "验证并停用 MFA" : "验证并启用 MFA"}</button></footer>
    </form> : null}

    <div className="detail-section">
      <span>登录会话</span>
      {sessions.length ? <div className="permission-list">{sessions.slice(0, 6).map((session) => <p key={session.session_id}><CheckCircle2 size={15} /><span><strong>{session.current ? "当前会话" : "已登录设备"}</strong><small>最近活动 {formatDate(session.last_seen_at)}{session.mfa_verified ? " · 已通过 MFA" : ""}</small></span></p>)}</div> : <p>{loading ? "正在读取登录会话。" : "暂时没有活动会话记录。"}</p>}
      <button className="danger-button" type="button" disabled={Boolean(busyAction) || !sessions.length} onClick={() => {
        if (!confirmSessionRevoke) setConfirmSessionRevoke(true);
        else onRevokeSessions();
      }}><LogOut size={15} aria-hidden="true" />{busyAction === "sessions" ? "正在撤销…" : confirmSessionRevoke ? "再次确认并退出所有设备" : "退出所有设备"}</button>
    </div>
  </section>;
}

export default AccountSecurityPanel;
