"use client";

import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  Ban,
  CheckCircle2,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldOff,
  UserPlus,
  Users,
  X,
} from "lucide-react";

export type AccountRole = "admin" | "limited-admin" | "staff" | "teacher";
export type AccountStatus = "invited" | "active" | "disabled";

export type AccountScopeMember = Readonly<{
  kind: string;
  key: string;
  label?: string;
}>;

export type AccountPermissionOption = string | Readonly<{
  key: string;
  label?: string;
  description?: string;
}>;

export type AccountScopeOption = string | Readonly<{
  value: string;
  label?: string;
}>;

/** Safe directory projection. It intentionally has no credential or token fields. */
export type AccountDirectoryRecord = Readonly<{
  account_id: string;
  account_name: string;
  account_role: AccountRole;
  status: AccountStatus;
  super_admin: boolean;
  access_version: number;
  role_version: number;
  scope_version: number;
  credential_version: number | null;
  must_change_password: boolean;
  mfa_enabled: boolean;
  legacy_session_allowed?: boolean;
  created_at: string;
  updated_at: string;
  permissions?: readonly string[];
  scope_members?: readonly AccountScopeMember[];
  authorization?: Readonly<{
    permissions: readonly string[];
    scope_members: readonly AccountScopeMember[];
  }>;
  invite_expires_at?: string | null;
  invite_delivery_status?: string | null;
  invite?: Readonly<{
    expires_at: string | null;
    delivery_status: string;
  }>;
  active_session_count?: number;
}>;

export type AccountInviteDraft = Readonly<{
  accountName: string;
  accountRole: AccountRole;
  permissionOverrides: Readonly<Record<string, boolean>>;
  scopeMembers: readonly AccountScopeMember[];
}>;

export type AccountAccessChange = Readonly<{
  accountId: string;
  accountRole: AccountRole;
  permissionOverrides: Readonly<Record<string, boolean>>;
  scopeMembers: readonly AccountScopeMember[];
  expectedRoleVersion: number;
  expectedScopeVersion: number;
}>;

export type AccountStatusChange = Readonly<{
  accountId: string;
  status: "active" | "disabled";
  expectedAccessVersion: number;
}>;

export type AccountIssuedPasswordResult = Readonly<{
  available: boolean;
  state: "available" | "self_changed" | "not_recorded" | "stale";
  password?: string;
  issuedAt?: string | null;
}>;

export type AccountAdminLifecycleProps = Readonly<{
  accounts: readonly AccountDirectoryRecord[];
  selectedAccountId?: string | null;
  currentAccountId?: string | null;
  permissionOptions?: readonly AccountPermissionOption[];
  scopeOptions?: readonly AccountScopeOption[];
  loading?: boolean;
  busyAction?: string | null;
  error?: string;
  notice?: string;
  title?: string;
  subtitle?: string;
  onSelectAccount?: (accountId: string) => void;
  onInvite?: (draft: AccountInviteDraft) => void;
  onUpdateAccess?: (change: AccountAccessChange) => void;
  onSetStatus?: (change: AccountStatusChange) => void;
  onResendInvite?: (account: AccountDirectoryRecord) => void;
  onIssueRecovery?: (account: AccountDirectoryRecord) => void;
  onResetPassword?: (account: AccountDirectoryRecord) => void;
  onRevealPassword?: (account: AccountDirectoryRecord) => Promise<AccountIssuedPasswordResult>;
  onRevokeSessions?: (account: AccountDirectoryRecord) => void;
  onResetMfa?: (account: AccountDirectoryRecord) => void;
  onViewAccount?: (account: AccountDirectoryRecord) => void;
}>;

const ROLE_LABELS: Record<AccountRole, string> = {
  admin: "管理员",
  "limited-admin": "受限管理员",
  staff: "教务",
  teacher: "老师",
};

const STATUS_LABELS: Record<AccountStatus, string> = {
  invited: "待接受邀请",
  active: "正常",
  disabled: "已禁用",
};

const DEFAULT_SCOPE_OPTIONS: readonly AccountScopeOption[] = [
  { value: "student", label: "学生" },
  { value: "teacher", label: "老师" },
  { value: "entity", label: "业务实体" },
];

const GRID_STYLE: CSSProperties = {
  gridTemplateColumns: "minmax(0, 1fr) minmax(112px, .55fr) minmax(100px, .45fr)",
};

function roleLabel(role: AccountRole): string {
  return ROLE_LABELS[role];
}

function accountLogin(account: AccountDirectoryRecord): string {
  return account.account_role === "staff" ? `${account.account_name} 教务` : account.account_name;
}

function statusLabel(status: AccountStatus): string {
  return STATUS_LABELS[status];
}

function statusTone(status: AccountStatus): string {
  return status === "active" ? "green" : status === "invited" ? "amber" : "red";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : name.slice(0, 2))
    .toUpperCase();
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "未设置";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "日期待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function permissionKey(option: AccountPermissionOption): string {
  return typeof option === "string" ? option : option.key;
}

function permissionLabel(option: AccountPermissionOption): string {
  return typeof option === "string" ? option : option.label ?? option.key;
}

function scopeValue(option: AccountScopeOption): string {
  return typeof option === "string" ? option : option.value;
}

function scopeLabel(option: AccountScopeOption): string {
  return typeof option === "string" ? option : option.label ?? option.value;
}

function accountPermissions(account: AccountDirectoryRecord): readonly string[] {
  return account.permissions ?? account.authorization?.permissions ?? [];
}

function accountScopeMembers(account: AccountDirectoryRecord): readonly AccountScopeMember[] {
  return account.scope_members ?? account.authorization?.scope_members ?? [];
}

function accountAuthorizationLoaded(account: AccountDirectoryRecord) {
  return account.authorization !== undefined
    || (account.permissions !== undefined && account.scope_members !== undefined);
}

function accountEditorStateKey(account: AccountDirectoryRecord) {
  if (!accountAuthorizationLoaded(account)) return `${account.account_id}:directory`;
  return JSON.stringify([
    account.account_id,
    account.credential_version,
    account.role_version,
    account.scope_version,
    accountPermissions(account),
    accountScopeMembers(account),
  ]);
}

function permissionItems(
  account: AccountDirectoryRecord | undefined,
  options: readonly AccountPermissionOption[],
): readonly AccountPermissionOption[] {
  const existing = account ? accountPermissions(account) : [];
  const seen = new Set(options.map(permissionKey));
  return [...options, ...existing.filter((permission) => !seen.has(permission))];
}

function deliveryLabel(value: string | null | undefined): string {
  if (!value || value === "delivery_unconfigured") return "投递服务尚未配置";
  if (value === "expired") return "已过期";
  return value;
}

type EditorProps = Readonly<{
  account: AccountDirectoryRecord;
  currentAccountId?: string | null;
  permissionOptions: readonly AccountPermissionOption[];
  scopeOptions: readonly AccountScopeOption[];
  busyAction?: string | null;
  onUpdateAccess?: (change: AccountAccessChange) => void;
  onSetStatus?: (change: AccountStatusChange) => void;
  onResendInvite?: (account: AccountDirectoryRecord) => void;
  onIssueRecovery?: (account: AccountDirectoryRecord) => void;
  onResetPassword?: (account: AccountDirectoryRecord) => void;
  onRevealPassword?: (account: AccountDirectoryRecord) => Promise<AccountIssuedPasswordResult>;
  onRevokeSessions?: (account: AccountDirectoryRecord) => void;
  onResetMfa?: (account: AccountDirectoryRecord) => void;
  onViewAccount?: (account: AccountDirectoryRecord) => void;
}>;

type PendingAction = "disable" | "restore" | "invite" | "recovery" | "sessions" | "mfa";

function AccountEditor({
  account,
  currentAccountId,
  permissionOptions,
  scopeOptions,
  busyAction,
  onUpdateAccess,
  onSetStatus,
  onResendInvite,
  onIssueRecovery,
  onResetPassword,
  onRevealPassword,
  onRevokeSessions,
  onResetMfa,
  onViewAccount,
}: EditorProps) {
  const items = permissionItems(account, permissionOptions);
  const [permissionDraft, setPermissionDraft] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(items.map((item) => [permissionKey(item), accountPermissions(account).includes(permissionKey(item))])),
  );
  const [scopeDraft, setScopeDraft] = useState<readonly AccountScopeMember[]>(() => accountScopeMembers(account));
  const [newScopeKind, setNewScopeKind] = useState(scopeValue(scopeOptions[0] ?? "entity"));
  const [newScopeKey, setNewScopeKey] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [issuedPassword, setIssuedPassword] = useState<AccountIssuedPasswordResult | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialMessage, setCredentialMessage] = useState("");

  const isBusy = (action: string) => busyAction === "all" || busyAction === action;
  const isSelf = Boolean(currentAccountId && currentAccountId === account.account_id);
  const authorizationLoaded = accountAuthorizationLoaded(account);
  const independentPasswordMissing = account.credential_version === null;
  const isReadOnly = account.super_admin || !onUpdateAccess || !authorizationLoaded || independentPasswordMissing;
  const inviteExpiresAt = account.invite_expires_at ?? account.invite?.expires_at;
  const inviteDeliveryStatus = account.invite_delivery_status ?? account.invite?.delivery_status;
  const login = accountLogin(account);

  const confirm = (action: PendingAction, callback: () => void) => {
    if (pending !== action) {
      setPending(action);
      return;
    }
    setPending(null);
    callback();
  };

  const submitAccess = () => {
    if (!onUpdateAccess || !authorizationLoaded) return;
    onUpdateAccess({
      accountId: account.account_id,
      accountRole: account.account_role,
      permissionOverrides: Object.fromEntries(items.map((item) => [permissionKey(item), Boolean(permissionDraft[permissionKey(item)])])),
      scopeMembers: scopeDraft,
      expectedRoleVersion: account.role_version,
      expectedScopeVersion: account.scope_version,
    });
  };

  const addScope = () => {
    const key = newScopeKey.trim();
    if (!key || scopeDraft.some((member) => member.kind === newScopeKind && member.key === key)) return;
    setScopeDraft([...scopeDraft, { kind: newScopeKind, key }]);
    setNewScopeKey("");
  };

  const copyCredential = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCredentialMessage(`${label}已复制。`);
    } catch {
      setCredentialMessage(`${label}复制失败，请手动选择后复制。`);
    }
  };

  const revealIssuedPassword = async () => {
    if (!onRevealPassword || credentialBusy) return;
    setCredentialBusy(true);
    setCredentialMessage("");
    try {
      const result = await onRevealPassword(account);
      setIssuedPassword(result);
      if (!result.available) {
        setCredentialMessage(result.state === "self_changed"
          ? "本人已自行修改密码；管理员无法查看其自设密码，可在下方重置。"
          : result.state === "stale"
            ? "记录对应旧密码版本；请在下方重置新密码。"
            : "该账号还没有可查看的管理员发放密码；可在下方重置。"
        );
      }
    } catch (error) {
      setCredentialMessage(error instanceof Error ? error.message : "发放密码暂时无法核对。");
    } finally {
      setCredentialBusy(false);
    }
  };

  const requestStatus = (status: "active" | "disabled") => {
    if (!onSetStatus || (status === "disabled" && (account.super_admin || isSelf))) return;
    confirm(status === "disabled" ? "disable" : "restore", () => onSetStatus({
      accountId: account.account_id,
      status,
      expectedAccessVersion: account.access_version,
    }));
  };

  return <aside className="account-preview" aria-label={`${account.account_name} 账号详情`}>
    <div className="preview-header" style={{ alignItems: "flex-start", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
        <span className="avatar green" aria-hidden="true">{initials(account.account_name)}</span>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ overflowWrap: "anywhere" }}>{account.account_name}</h2>
          <p>{account.super_admin ? "超级管理员" : roleLabel(account.account_role)}</p>
        </div>
      </div>
      <span className={`status-pill ${statusTone(account.status)}`}>{statusLabel(account.status)}</span>
    </div>

    <div className="student-facts account-facts" aria-label="账号概况">
      <span><small>角色</small><strong>{roleLabel(account.account_role)}</strong></span>
      <span><small>MFA</small><strong>{account.mfa_enabled ? "已启用" : "未启用"}</strong></span>
      <span><small>活动会话</small><strong>{account.active_session_count ?? "未读取"}</strong></span>
      <span><small>最近更新</small><strong>{formatDate(account.updated_at)}</strong></span>
    </div>

    {account.status === "invited" && <div className="form-notice" role="status">
      <Mail size={15} aria-hidden="true" />
      <span>邀请：{deliveryLabel(inviteDeliveryStatus)}；有效期至 {formatDate(inviteExpiresAt)}。界面不会显示邀请凭据。</span>
    </div>}
    {account.must_change_password && <div className="form-notice" role="status">
      <KeyRound size={15} aria-hidden="true" />
      <span>该账号下次登录需要更新密码。</span>
    </div>}

    <section className="detail-section account-credential-section" aria-labelledby={`${account.account_id}-credential-heading`}>
      <h3 id={`${account.account_id}-credential-heading`}>登录凭据</h3>
      <label className="account-credential-field">
        <span>登录账号</span>
        <div className="copy-field">
          <input value={login} readOnly aria-label={`${account.account_name} 的登录账号`} spellCheck={false} />
          <button className="icon-button" type="button" aria-label={`复制 ${account.account_name} 的登录账号`} onClick={() => void copyCredential(login, "登录账号")}>
            <Copy size={16} aria-hidden="true" />
          </button>
        </div>
      </label>
      <div className="account-credential-field">
        <span>当前发放密码</span>
        {account.credential_version === null ? <div className="account-credential-empty"><KeyRound size={15} aria-hidden="true" /><span>尚未建立独立密码</span></div>
          : issuedPassword?.available && issuedPassword.password ? <>
            <div className="copy-field account-password-copy-field">
              <input value={issuedPassword.password} readOnly aria-label={`${account.account_name} 的当前发放密码`} autoComplete="off" spellCheck={false} />
              <button className="icon-button" type="button" aria-label={`复制 ${account.account_name} 的当前发放密码`} onClick={() => void copyCredential(issuedPassword.password!, "发放密码")}>
                <Copy size={16} aria-hidden="true" />
              </button>
              <button className="icon-button" type="button" aria-label="隐藏发放密码" onClick={() => { setIssuedPassword(null); setCredentialMessage("发放密码已隐藏。"); }}>
                <EyeOff size={16} aria-hidden="true" />
              </button>
            </div>
            <small>发放于 {formatDate(issuedPassword.issuedAt)} · 查看操作已记录</small>
          </>
            : issuedPassword && !issuedPassword.available ? <div className="account-credential-empty"><ShieldCheck size={15} aria-hidden="true" /><span>{issuedPassword.state === "self_changed" ? "已自行修改" : "暂无可查看密码"}</span></div>
              : <div className="copy-field">
                <input value="••••••••••••" readOnly aria-label={`${account.account_name} 的发放密码已隐藏`} tabIndex={-1} />
                <button className="secondary-button account-reveal-password" type="button" disabled={!onRevealPassword || credentialBusy} onClick={() => void revealIssuedPassword()}>
                  <Eye size={16} aria-hidden="true" />{credentialBusy ? "正在核对…" : "查看密码"}
                </button>
              </div>}
        <small>只展示管理员发放且仍有效的密码；本人自行修改后不可查看。每次查看都会写入审计。</small>
      </div>
      {credentialMessage ? <p className="account-credential-message" role="status" aria-live="polite">{credentialMessage}</p> : null}
    </section>

    <section className="detail-section" aria-labelledby={`${account.account_id}-role-heading`}>
      <h3 id={`${account.account_id}-role-heading`} style={{ fontSize: 14, margin: 0 }}>角色与权限</h3>
      <label style={{ display: "grid", gap: 5, marginTop: 8 }}>
        <span style={{ color: "var(--muted)", fontSize: 12 }}>账号角色（与登录身份绑定）</span>
        <select
          className="filter-select"
          aria-label="账号角色"
          value={account.account_role}
          disabled
        >
          {Object.entries(ROLE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
      </label>
      {items.length ? <div className="permission-list" aria-label="权限列表">
        {items.map((item) => {
          const key = permissionKey(item);
          return <label key={key} style={{ alignItems: "flex-start", display: "flex", gap: 7, fontSize: 12, lineHeight: 1.45 }}>
            <input
              type="checkbox"
              checked={Boolean(permissionDraft[key])}
              disabled={isReadOnly || isBusy("access")}
              onChange={(event) => setPermissionDraft((current) => ({ ...current, [key]: event.target.checked }))}
            />
            <span><strong>{permissionLabel(item)}</strong>{typeof item !== "string" && item.description ? <small style={{ color: "var(--muted)", display: "block" }}>{item.description}</small> : null}</span>
          </label>;
        })}
      </div> : <div className="empty-inline">权限投影尚未提供</div>}
      {!authorizationLoaded && <div className="empty-inline" role="status"><RefreshCw size={14} aria-hidden="true" />正在读取服务端权限与范围…</div>}
      {independentPasswordMissing && !account.super_admin && <div className="form-notice" role="status"><KeyRound size={14} aria-hidden="true" />请先在下方设置登录密码，再编辑权限与数据范围。</div>}
      {account.super_admin && <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5, margin: "10px 0 0" }}>超级管理员权限由服务端判定，组件不在本地展开或覆盖。</p>}
      {onUpdateAccess && !account.super_admin && <button className="primary-button full" type="button" disabled={!authorizationLoaded || independentPasswordMissing || isBusy("access")} onClick={submitAccess} style={{ marginTop: 12 }}>
        <CheckCircle2 size={15} aria-hidden="true" />{!authorizationLoaded ? "正在读取权限…" : independentPasswordMissing ? "请先建立独立密码" : isBusy("access") ? "正在保存…" : "保存权限和范围"}
      </button>}
    </section>

    <section className="detail-section" aria-labelledby={`${account.account_id}-scope-heading`}>
      <h3 id={`${account.account_id}-scope-heading`} style={{ fontSize: 14, margin: 0 }}>数据范围</h3>
      {scopeDraft.length ? <div style={{ display: "grid", gap: 6, marginTop: 9 }} role="list" aria-label="数据范围成员">
        {scopeDraft.map((member) => <div key={`${member.kind}:${member.key}`} role="listitem" style={{ alignItems: "center", borderBottom: "1px solid #edf1ee", display: "flex", gap: 8, justifyContent: "space-between", padding: "6px 0" }}>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}><small style={{ color: "var(--muted)", display: "block", fontSize: 11 }}>{member.label ?? member.kind}</small><strong style={{ fontSize: 12 }}>{member.key}</strong></span>
          {!isReadOnly && <button className="icon-button" type="button" aria-label={`移除范围 ${member.label ?? member.kind} ${member.key}`} onClick={() => setScopeDraft((current) => current.filter((candidate) => candidate !== member))}>
            <X size={14} aria-hidden="true" />
          </button>}
        </div>)}
      </div> : <div className="empty-inline">未配置范围成员</div>}
      {!isReadOnly && <div style={{ display: "grid", gap: 7, gridTemplateColumns: "auto minmax(0,1fr) auto", marginTop: 10 }}>
        <label style={{ display: "grid", gap: 4 }}><span style={{ color: "var(--muted)", fontSize: 11 }}>类型</span><select className="filter-select" aria-label="范围类型" value={newScopeKind} onChange={(event) => setNewScopeKind(event.target.value)}>{scopeOptions.map((option) => <option value={scopeValue(option)} key={scopeValue(option)}>{scopeLabel(option)}</option>)}</select></label>
        <label style={{ display: "grid", gap: 4, minWidth: 0 }}><span style={{ color: "var(--muted)", fontSize: 11 }}>范围标识（学生/老师请填系统 ID）</span><input style={{ background: "#f8faf8", border: "1px solid #d8e2dc", borderRadius: 4, minWidth: 0, padding: "7px 8px" }} value={newScopeKey} aria-label="范围标识" onChange={(event) => setNewScopeKey(event.target.value)} /></label>
        <button className="compact-button" type="button" aria-label="添加范围成员" disabled={!newScopeKey.trim()} onClick={addScope} style={{ alignSelf: "end", marginTop: 0 }}>添加</button>
      </div>}
    </section>

    <section className="account-actions" aria-label="账号操作">
      <div className="toolbar-actions" style={{ justifyContent: "flex-start" }}>
        {account.status === "active" && onSetStatus && <button className="danger-button" type="button" disabled={account.super_admin || isSelf || isBusy("status")} onClick={() => requestStatus("disabled")}>
          <Ban size={15} aria-hidden="true" />{pending === "disable" ? "再次确认禁用" : "禁用账号"}
        </button>}
        {account.status === "disabled" && onSetStatus && <button className="secondary-button" type="button" disabled={isBusy("status")} onClick={() => requestStatus("active")}>
          <RotateCcw size={15} aria-hidden="true" />{pending === "restore" ? "再次确认恢复" : "恢复账号"}
        </button>}
        {account.status === "active" && isSelf && <span className="status-pill amber">当前账号不可自禁用</span>}
      </div>
      {account.status === "invited" && onResendInvite && <button className="secondary-button full" type="button" disabled={isBusy("invite")} onClick={() => confirm("invite", () => onResendInvite(account))}>
        <RefreshCw size={15} aria-hidden="true" />{pending === "invite" ? "再次确认重发邀请" : "重发邀请"}
      </button>}
      {onIssueRecovery && <button className="secondary-button full" type="button" disabled={isBusy("recovery")} onClick={() => confirm("recovery", () => onIssueRecovery(account))}>
        <KeyRound size={15} aria-hidden="true" />{pending === "recovery" ? "再次确认重发恢复" : "重发恢复"}
      </button>}
      {onResetPassword && !isSelf && account.status === "active" && <button className="secondary-button full" type="button" disabled={isBusy("password")} onClick={() => onResetPassword(account)}>
        <KeyRound size={15} aria-hidden="true" />重置登录密码
      </button>}
      {onRevokeSessions && <button className="secondary-button full" type="button" disabled={isBusy("sessions")} onClick={() => confirm("sessions", () => onRevokeSessions(account))}>
        <Users size={15} aria-hidden="true" />{pending === "sessions" ? "再次确认撤销会话" : "撤销此账号会话"}
      </button>}
      {onResetMfa && <button className="danger-button full" type="button" disabled={!account.mfa_enabled || isSelf || isBusy("mfa")} onClick={() => confirm("mfa", () => onResetMfa(account))}>
        {account.mfa_enabled ? <ShieldOff size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
        {account.mfa_enabled ? (pending === "mfa" ? "再次确认重置 MFA" : "重置 MFA") : "MFA 未启用"}
      </button>}
      {onViewAccount && account.status === "active" && <button className="primary-button full" type="button" onClick={() => onViewAccount(account)}>
        <Users size={15} aria-hidden="true" />查看此账号视图
      </button>}
      <p className="form-footnote" style={{ margin: 0 }}>所有状态变更只通过回调交给上层；组件不会发送网络请求。</p>
    </section>

    <div className="detail-section" style={{ marginTop: 0 }}>
      <span>版本与审计</span>
      <p>权限 v{account.access_version} · 角色 v{account.role_version} · 范围 v{account.scope_version} · 创建于 {formatDate(account.created_at)}</p>
    </div>
  </aside>;
}

export function AccountAdminLifecycle({
  accounts,
  selectedAccountId,
  currentAccountId,
  permissionOptions = [],
  scopeOptions = DEFAULT_SCOPE_OPTIONS,
  loading = false,
  busyAction,
  error,
  notice,
  title = "账号生命周期",
  subtitle = "管理账号状态、最小权限、数据范围与恢复入口。",
  onSelectAccount,
  onInvite,
  onUpdateAccess,
  onSetStatus,
  onResendInvite,
  onIssueRecovery,
  onResetPassword,
  onRevealPassword,
  onRevokeSessions,
  onResetMfa,
  onViewAccount,
}: AccountAdminLifecycleProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | AccountStatus>("all");
  const [page, setPage] = useState(1);
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(() => selectedAccountId ?? accounts[0]?.account_id ?? null);
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<AccountRole>("staff");
  const headingId = "account-lifecycle-heading";
  const searchId = "account-lifecycle-search";

  const activeSelectedId = selectedAccountId === undefined
    ? (accounts.some((account) => account.account_id === internalSelectedId) ? internalSelectedId : accounts[0]?.account_id ?? null)
    : selectedAccountId;
  const selected = accounts.find((account) => account.account_id === activeSelectedId);
  const filteredAccounts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return accounts.filter((account) => {
      if (statusFilter !== "all" && account.status !== statusFilter) return false;
      if (!normalized) return true;
      return [account.account_name, roleLabel(account.account_role), statusLabel(account.status), ...accountPermissions(account)]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [accounts, query, statusFilter]);
  const pageSize = 12;
  const pageCount = Math.max(1, Math.ceil(filteredAccounts.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedAccounts = filteredAccounts.slice((safePage - 1) * pageSize, safePage * pageSize);

  const submitInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const accountName = inviteName.trim();
    if (!accountName || !onInvite) return;
    onInvite({ accountName, accountRole: inviteRole, permissionOverrides: {}, scopeMembers: [] });
    setInviteName("");
    setInviteRole("staff");
  };

  return <section className="panel account-admin-shell" aria-labelledby={headingId}>
    <div className="panel-header" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 14 }}>
      <div>
        <span className="eyebrow">账号与权限</span>
        <h2 id={headingId}>{title}</h2>
        <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.5, margin: "5px 0 0" }}>{subtitle}</p>
      </div>
      {onInvite && <details style={{ marginLeft: "auto", minWidth: 260 }}>
        <summary className="secondary-button" style={{ listStyle: "none" }}><UserPlus size={15} aria-hidden="true" />邀请账号</summary>
        <form className="form-grid" onSubmit={submitInvite} style={{ background: "#f8faf8", border: "1px solid var(--line)", marginTop: 8, padding: 12 }}>
          <label>账号名称<input autoComplete="off" value={inviteName} onChange={(event) => setInviteName(event.target.value)} required /></label>
          <label>初始角色<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as AccountRole)}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <footer><button className="primary-button" type="submit" disabled={!inviteName.trim()}>创建邀请</button></footer>
        </form>
      </details>}
    </div>
    {error && <div className="form-error" role="alert" style={{ margin: "0 16px 12px" }}>{error}</div>}
    {notice && <div className="form-notice" role="status" style={{ margin: "0 16px 12px" }}><CheckCircle2 size={15} aria-hidden="true" />{notice}</div>}

    <div className="account-admin-layout">
      <article className="account-list" aria-label="账号目录">
        <div className="table-toolbar" style={{ flexWrap: "wrap", gap: 9 }}>
          <label className="search-field" htmlFor={searchId} style={{ flex: "1 1 220px", width: "auto" }}>
            <Search size={15} aria-hidden="true" /><input id={searchId} aria-label="搜索账号" placeholder="搜索账号、角色或权限" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
          </label>
          <div className="toolbar-actions">
            <label style={{ alignItems: "center", display: "flex", gap: 6 }}><span style={{ color: "var(--muted)", fontSize: 11 }}>状态</span><select className="filter-select" aria-label="账号状态筛选" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as "all" | AccountStatus); setPage(1); }}><option value="all">全部</option><option value="active">正常</option><option value="invited">待接受</option><option value="disabled">已禁用</option></select></label>
            <span aria-live="polite" style={{ color: "var(--muted)", fontSize: 12 }}>{loading ? "正在读取账号…" : `${filteredAccounts.length} 个账号`}</span>
          </div>
        </div>
        <div className="data-head account-grid-row" style={GRID_STYLE} role="row">
          <span>账号</span><span>状态</span><span>角色</span>
        </div>
        <div role="list" aria-label="账号列表">
          {pagedAccounts.length ? pagedAccounts.map((account) => <div key={account.account_id} role="listitem">
            <button className={`collection-row account-grid-row ${selected?.account_id === account.account_id ? "selected" : ""}`} type="button" style={GRID_STYLE} aria-pressed={selected?.account_id === account.account_id} onClick={() => { setInternalSelectedId(account.account_id); onSelectAccount?.(account.account_id); }}>
              <span className="table-person"><span className="avatar green" aria-hidden="true">{initials(account.account_name)}</span><span><strong>{account.account_name}</strong><small>{account.super_admin ? "超级管理员" : "账号目录"}</small></span></span>
              <span style={{ alignItems: "flex-start", display: "grid", gap: 4 }}><span className={`status-pill ${statusTone(account.status)}`}>{statusLabel(account.status)}</span><small>{account.mfa_enabled ? "MFA 已启用" : "MFA 未启用"}</small></span>
              <span style={{ display: "grid", gap: 3 }}><strong style={{ fontSize: 12 }}>{roleLabel(account.account_role)}</strong>{typeof account.active_session_count === "number" ? <small>{account.active_session_count} 个会话</small> : null}</span>
            </button>
          </div>) : <div className="empty-inline" role="status"><Clock3 size={15} aria-hidden="true" />{loading ? "正在读取账号目录…" : "没有匹配的账号"}</div>}
        </div>
        {filteredAccounts.length > pageSize ? <footer className="pagination"><div><button type="button" aria-label="上一页" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>上一页</button><strong>第 {safePage} / {pageCount} 页</strong><button type="button" aria-label="下一页" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>下一页</button></div></footer> : null}
      </article>
      {selected ? <AccountEditor
        key={accountEditorStateKey(selected)}
        account={selected}
        currentAccountId={currentAccountId}
        permissionOptions={permissionOptions}
        scopeOptions={scopeOptions}
        busyAction={busyAction}
        onUpdateAccess={onUpdateAccess}
        onSetStatus={onSetStatus}
        onResendInvite={onResendInvite}
        onIssueRecovery={onIssueRecovery}
        onResetPassword={onResetPassword}
        onRevealPassword={onRevealPassword}
        onRevokeSessions={onRevokeSessions}
        onResetMfa={onResetMfa}
        onViewAccount={onViewAccount}
      /> : <aside className="account-preview"><div className="empty-inline" role="status"><Users size={15} aria-hidden="true" />选择一个账号查看安全状态与权限。</div></aside>}
    </div>
  </section>;
}

export default AccountAdminLifecycle;
