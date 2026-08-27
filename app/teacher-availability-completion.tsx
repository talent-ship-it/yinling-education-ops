"use client";

import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  LockKeyhole,
  UserRound,
} from "lucide-react";

export type TeacherAvailabilityCompletionIssue = "missing" | "invalid";

export type TeacherAvailabilityCompletionInbox = Readonly<{
  month: string;
  teacherVersion: number;
  summary: Readonly<{
    teachers: number;
    currentStructured: number;
    missing: number;
    invalid: number;
    pendingReview: number;
  }>;
  items: readonly Readonly<{
    /** Opaque to this panel; it is supplied only to a host-owned navigation callback. */
    teacherId: string;
    teacherName: string;
    issue: TeacherAvailabilityCompletionIssue;
    pendingSubmission: boolean;
  }>[];
}>;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_ITEMS = 1_000;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效。`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label}格式无效。`);
  return value as number;
}

function text(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label}格式无效。`);
  return value.trim();
}

function bool(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label}格式无效。`);
  return value;
}

/** Parses only the narrow, read-only completion DTO sent by the server. */
export function parseTeacherAvailabilityCompletionInbox(value: unknown): TeacherAvailabilityCompletionInbox {
  const source = asRecord(value, "老师 AVA 完整度响应");
  const month = text(source.month, "月份", 7);
  if (!MONTH.test(month)) throw new Error("月份格式无效。");
  const teacherVersion = integer(source.teacherVersion, "老师目录版本");
  if (teacherVersion < 1) throw new Error("老师目录版本格式无效。");
  const summarySource = asRecord(source.summary, "AVA 完整度汇总");
  const summary = {
    teachers: integer(summarySource.teachers, "老师总数"),
    currentStructured: integer(summarySource.currentStructured, "本月结构化 AVA 数"),
    missing: integer(summarySource.missing, "缺少 AVA 数"),
    invalid: integer(summarySource.invalid, "无效 AVA 数"),
    pendingReview: integer(summarySource.pendingReview, "待审核 AVA 数"),
  };
  if (summary.currentStructured + summary.missing + summary.invalid !== summary.teachers
    || summary.pendingReview > summary.missing + summary.invalid) {
    throw new Error("AVA 完整度汇总不一致。");
  }
  if (!Array.isArray(source.items) || source.items.length > MAX_ITEMS) {
    throw new Error("AVA 完整度老师列表格式无效。");
  }
  const teacherIds = new Set<string>();
  const items = source.items.map((value, index) => {
    const row = asRecord(value, `AVA 完整度老师 ${index + 1}`);
    const teacherId = text(row.teacherId, `AVA 完整度老师 ${index + 1}编号`, 240);
    const teacherName = text(row.teacherName, `AVA 完整度老师 ${index + 1}姓名`, 240);
    if (teacherIds.has(teacherId)) throw new Error("AVA 完整度老师列表包含重复老师。\n");
    teacherIds.add(teacherId);
    if (row.issue !== "missing" && row.issue !== "invalid") throw new Error(`AVA 完整度老师 ${index + 1}状态无效。`);
    return {
      teacherId,
      teacherName,
      issue: row.issue,
      pendingSubmission: bool(row.pendingSubmission, `AVA 完整度老师 ${index + 1}待审核状态`),
    } as const;
  });
  if (items.length !== summary.missing + summary.invalid
    || items.filter((item) => item.pendingSubmission).length !== summary.pendingReview) {
    throw new Error("AVA 完整度老师列表与汇总不一致。");
  }
  return { month, teacherVersion, summary, items };
}

export type TeacherAvailabilityCompletionPanelProps = Readonly<{
  inbox: TeacherAvailabilityCompletionInbox | null;
  loading: boolean;
  error: boolean;
  /** UI protection only; the endpoint separately rejects non-admin accounts. */
  isAdmin: boolean;
  /** Host-owned navigation only. This panel never writes or notifies a teacher. */
  onOpenTeacher?: (teacherId: string) => void;
}>;

function Summary({ label, value, tone }: Readonly<{
  label: string;
  value: number;
  tone: "green" | "blue" | "amber" | "red";
}>) {
  return <div className={`report-card ${tone}`}>
    <strong>{value}</strong>
    <span>{label}</span>
  </div>;
}

function rowDescription(item: TeacherAvailabilityCompletionInbox["items"][number]) {
  if (item.pendingSubmission) {
    return {
      title: "老师已提交，等待教务审核",
      tone: "amber" as const,
      icon: <Clock3 size={17} aria-hidden="true" />,
      action: "打开审核资料",
    };
  }
  if (item.issue === "invalid") {
    return {
      title: "AVA 需要修正",
      tone: "red" as const,
      icon: <CircleAlert size={17} aria-hidden="true" />,
      action: "查看老师资料",
    };
  }
  return {
    title: "请老师提交本月 AVA",
    tone: "amber" as const,
    icon: <UserRound size={17} aria-hidden="true" />,
    action: "查看老师资料",
  };
}

/**
 * Embeddable administrator surface. Its only optional action is navigation
 * back into the host's teacher record; it sends no messages and cannot change
 * availability, schedules, capacity, tasks, or any Jiaowubao evidence.
 */
export function TeacherAvailabilityCompletionPanel({
  inbox,
  loading,
  error,
  isAdmin,
  onOpenTeacher,
}: TeacherAvailabilityCompletionPanelProps) {
  return <section className="panel collection-shell" aria-labelledby="teacher-availability-completion-title">
    <header className="panel-header">
      <h2 id="teacher-availability-completion-title">月度 AVA 完整度</h2>
    </header>

    {!isAdmin ? <div className="collection-empty" role="status"><LockKeyhole size={20} aria-hidden="true" /><strong>仅管理员可查看老师 AVA 完整度。</strong></div> : null}
    {isAdmin && loading ? <div className="collection-empty" role="status"><Clock3 size={20} aria-hidden="true" /><strong>正在读取老师 AVA 完整度…</strong></div> : null}
    {isAdmin && !loading && error ? <div className="collection-empty" role="status"><CircleAlert size={20} aria-hidden="true" /><strong>老师 AVA 完整度暂时无法读取。</strong></div> : null}
    {isAdmin && !loading && !error && !inbox ? <div className="collection-empty" role="status"><CircleAlert size={20} aria-hidden="true" /><strong>没有可用的老师 AVA 完整度资料。</strong></div> : null}
    {isAdmin && !loading && !error && inbox ? <>
      {inbox.summary.currentStructured || inbox.summary.missing || inbox.summary.invalid || inbox.summary.pendingReview ? <div className="report-grid" aria-label={`${inbox.month} 月度 AVA 完整度汇总`}>
        {inbox.summary.currentStructured > 0 ? <Summary label="已覆盖本月" value={inbox.summary.currentStructured} tone="green" /> : null}
        {inbox.summary.missing > 0 ? <Summary label="待老师提交" value={inbox.summary.missing} tone="amber" /> : null}
        {inbox.summary.invalid > 0 ? <Summary label="数据需修正" value={inbox.summary.invalid} tone="red" /> : null}
        {inbox.summary.pendingReview > 0 ? <Summary label="已提交待审核" value={inbox.summary.pendingReview} tone="blue" /> : null}
      </div> : null}
      {!inbox.items.length ? <div className="collection-empty" role="status"><CheckCircle2 size={20} aria-hidden="true" /><strong>{inbox.month} AVA 已齐全。</strong></div> : <div className="record-list" role="list" aria-label="待补齐老师 AVA">
        {inbox.items.map((item) => {
          const description = rowDescription(item);
          return <article className="record-row" key={item.teacherId} role="listitem">
            <span className={`record-icon ${description.tone}`}>{description.icon}</span>
            <div><strong>{item.teacherName}</strong></div>
            <span className={`status-pill ${description.tone}`}>{description.title}</span>
            {onOpenTeacher ? <button className="secondary-button" type="button" onClick={() => onOpenTeacher(item.teacherId)}>{description.action}</button> : null}
          </article>;
        })}
      </div>}
    </> : null}
  </section>;
}

export default TeacherAvailabilityCompletionPanel;
