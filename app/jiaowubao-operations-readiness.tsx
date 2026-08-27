"use client";

import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  FileCheck2,
  UserRoundCheck,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * Read-only contract for the admin-only operations-readiness reader.  It is
 * intentionally independent from editable bookings, operations, task, and
 * renewal state: source evidence can be reviewed here, but never acted on
 * from this panel.
 */
export type JiaowubaoOperationsReadinessResolution =
  | "exact_name"
  | "unresolved"
  | "ambiguous"
  | "not_found";

export type JiaowubaoOperationsReadiness = Readonly<{
  state: "absent" | "complete";
  /** Opaque server value; it must never be displayed or constructed in the browser. */
  runToken: string | null;
  window: Readonly<{ startsAt: string; endsAt: string }>;
  schedule: Readonly<{
    summary: Readonly<{
      windowEvents: number;
      needsTeacherMapping: number;
      needsCourseMapping: number;
      readyForAvaReview: number;
      invalidTime: number;
    }>;
    rows: readonly Readonly<{
      eventId: string;
      sourceDate: string;
      startsAt: string;
      endsAt: string;
      courseName: string | null;
      teacherId: string | null;
      teacherLabel: string | null;
      teacherResolution: JiaowubaoOperationsReadinessResolution;
      subjectResolution: JiaowubaoOperationsReadinessResolution;
      availabilityEffect: "display_only" | "blocks_teacher_ava";
      attachedParticipantCount: number;
      needsTeacherMapping: boolean;
      needsCourseMapping: boolean;
      readyForAvaReview: boolean;
    }>[];
    truncated: boolean;
  }>;
  leaveMakeups: Readonly<{
    summary: Readonly<{ attached: number; leave: number; makeup: number; unknown: number }>;
    rows: readonly Readonly<{
      incidentId: string;
      studentId: string;
      kind: "leave" | "makeup" | "unknown";
      sourceDate: string | null;
      timeText: string | null;
      courseName: string | null;
      className: string | null;
      teacherLabel: string | null;
    }>[];
    truncated: boolean;
  }>;
  renewalEvidence: Readonly<{
    summary: Readonly<{ candidates: number; withContract: number; withHourBalance: number }>;
    rows: readonly Readonly<{
      studentId: string;
      courseName: string | null;
      hasContractEvidence: boolean;
      hasHourBalanceEvidence: boolean;
      totalHours: string | null;
      usedHours: string | null;
      remainingHours: string | null;
    }>[];
    truncated: boolean;
  }>;
}>;

const MAX_QUEUE_ROWS = 500;
const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const resolutions = new Set<JiaowubaoOperationsReadinessResolution>([
  "exact_name",
  "unresolved",
  "ambiguous",
  "not_found",
]);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效。`);
  return value as Record<string, unknown>;
}

type TextOptions = Readonly<{ nullable?: boolean; max?: number }>;

function text(value: unknown, label: string, options: TextOptions & Readonly<{ nullable: true }>): string | null;
function text(value: unknown, label: string, options?: TextOptions): string;
function text(value: unknown, label: string, { nullable = false, max = 320 }: TextOptions = {}): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new Error(`${label}格式无效。`);
  return value;
}

function integer(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label}格式无效。`);
  return value as number;
}

function bool(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label}格式无效。`);
  return value;
}

function canonicalInstant(value: unknown, label: string) {
  const result = text(value, label, { max: 40 });
  if (!CANONICAL_UTC_INSTANT.test(result)) throw new Error(`${label}格式无效。`);
  const parsed = new Date(result);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== result) throw new Error(`${label}格式无效。`);
  return result;
}

function resolution(value: unknown, label: string): JiaowubaoOperationsReadinessResolution {
  if (typeof value !== "string" || !resolutions.has(value as JiaowubaoOperationsReadinessResolution)) {
    throw new Error(`${label}格式无效。`);
  }
  return value as JiaowubaoOperationsReadinessResolution;
}

function rows(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > MAX_QUEUE_ROWS) throw new Error(`${label}格式无效。`);
  return value;
}

/**
 * Parses only the reviewed server DTO. Any malformed source response throws so
 * callers can replace it with an unavailable state instead of showing partial
 * or inferred readiness data.
 */
export function parseJiaowubaoOperationsReadiness(value: unknown): JiaowubaoOperationsReadiness {
  const source = asRecord(value, "教务宝运营就绪队列响应");
  if (source.state !== "absent" && source.state !== "complete") throw new Error("教务宝运营就绪队列状态无效。");
  const state = source.state;
  const runToken = text(source.runToken, "导入批次", { nullable: true, max: 128 });
  if ((state === "complete") !== Boolean(runToken)) throw new Error("教务宝运营就绪队列批次无效。");

  const window = asRecord(source.window, "教务宝运营就绪队列时间范围");
  const scheduleSource = asRecord(source.schedule, "教务宝排课就绪资料");
  const leaveSource = asRecord(source.leaveMakeups, "教务宝请假代课资料");
  const renewalSource = asRecord(source.renewalEvidence, "教务宝续课资料");
  const scheduleSummary = asRecord(scheduleSource.summary, "教务宝排课就绪汇总");
  const leaveSummary = asRecord(leaveSource.summary, "教务宝请假代课汇总");
  const renewalSummary = asRecord(renewalSource.summary, "教务宝续课汇总");

  const scheduleRows = rows(scheduleSource.rows, "教务宝排课就绪行").map((value, index) => {
    const row = asRecord(value, `教务宝排课就绪行 ${index + 1}`);
    const availabilityEffect = row.availabilityEffect;
    if (availabilityEffect !== "display_only" && availabilityEffect !== "blocks_teacher_ava") {
      throw new Error(`教务宝排课就绪行 ${index + 1} AVA状态无效。`);
    }
    return {
      eventId: text(row.eventId, `教务宝排课就绪行 ${index + 1}编号`, { max: 240 }),
      sourceDate: text(row.sourceDate, `教务宝排课就绪行 ${index + 1}日期`, { max: 32 }),
      startsAt: canonicalInstant(row.startsAt, `教务宝排课就绪行 ${index + 1}开始时间`),
      endsAt: canonicalInstant(row.endsAt, `教务宝排课就绪行 ${index + 1}结束时间`),
      courseName: text(row.courseName, `教务宝排课就绪行 ${index + 1}课程`, { nullable: true, max: 500 }),
      teacherId: text(row.teacherId, `教务宝排课就绪行 ${index + 1}老师`, { nullable: true, max: 240 }),
      teacherLabel: text(row.teacherLabel, `教务宝排课就绪行 ${index + 1}老师显示`, { nullable: true, max: 500 }),
      teacherResolution: resolution(row.teacherResolution, `教务宝排课就绪行 ${index + 1}老师匹配`),
      subjectResolution: resolution(row.subjectResolution, `教务宝排课就绪行 ${index + 1}课程匹配`),
      availabilityEffect,
      attachedParticipantCount: integer(row.attachedParticipantCount, `教务宝排课就绪行 ${index + 1}参与者数`),
      needsTeacherMapping: bool(row.needsTeacherMapping, `教务宝排课就绪行 ${index + 1}老师待匹配状态`),
      needsCourseMapping: bool(row.needsCourseMapping, `教务宝排课就绪行 ${index + 1}课程待匹配状态`),
      readyForAvaReview: bool(row.readyForAvaReview, `教务宝排课就绪行 ${index + 1}AVA复核状态`),
    } as const;
  });
  const leaveRows = rows(leaveSource.rows, "教务宝请假代课行").map((value, index) => {
    const row = asRecord(value, `教务宝请假代课行 ${index + 1}`);
    if (row.kind !== "leave" && row.kind !== "makeup" && row.kind !== "unknown") throw new Error(`教务宝请假代课行 ${index + 1}类型无效。`);
    return {
      incidentId: text(row.incidentId, `教务宝请假代课行 ${index + 1}编号`, { max: 240 }),
      studentId: text(row.studentId, `教务宝请假代课行 ${index + 1}学员`, { max: 240 }),
      kind: row.kind,
      sourceDate: text(row.sourceDate, `教务宝请假代课行 ${index + 1}日期`, { nullable: true, max: 32 }),
      timeText: text(row.timeText, `教务宝请假代课行 ${index + 1}时间`, { nullable: true, max: 100 }),
      courseName: text(row.courseName, `教务宝请假代课行 ${index + 1}课程`, { nullable: true, max: 500 }),
      className: text(row.className, `教务宝请假代课行 ${index + 1}班级`, { nullable: true, max: 500 }),
      teacherLabel: text(row.teacherLabel, `教务宝请假代课行 ${index + 1}老师`, { nullable: true, max: 500 }),
    } as const;
  });
  const renewalRows = rows(renewalSource.rows, "教务宝续课证据行").map((value, index) => {
    const row = asRecord(value, `教务宝续课证据行 ${index + 1}`);
    return {
      studentId: text(row.studentId, `教务宝续课证据行 ${index + 1}学员`, { max: 240 }),
      courseName: text(row.courseName, `教务宝续课证据行 ${index + 1}课程`, { nullable: true, max: 500 }),
      hasContractEvidence: bool(row.hasContractEvidence, `教务宝续课证据行 ${index + 1}合同证据`),
      hasHourBalanceEvidence: bool(row.hasHourBalanceEvidence, `教务宝续课证据行 ${index + 1}课时证据`),
      totalHours: text(row.totalHours, `教务宝续课证据行 ${index + 1}总课时`, { nullable: true, max: 80 }),
      usedHours: text(row.usedHours, `教务宝续课证据行 ${index + 1}已消课时`, { nullable: true, max: 80 }),
      remainingHours: text(row.remainingHours, `教务宝续课证据行 ${index + 1}剩余课时`, { nullable: true, max: 80 }),
    } as const;
  });

  const result: JiaowubaoOperationsReadiness = {
    state,
    runToken,
    window: {
      startsAt: canonicalInstant(window.startsAt, "教务宝运营就绪队列开始时间"),
      endsAt: canonicalInstant(window.endsAt, "教务宝运营就绪队列结束时间"),
    },
    schedule: {
      summary: {
        windowEvents: integer(scheduleSummary.windowEvents, "时间范围课程数"),
        needsTeacherMapping: integer(scheduleSummary.needsTeacherMapping, "待匹配老师数"),
        needsCourseMapping: integer(scheduleSummary.needsCourseMapping, "待匹配课程数"),
        readyForAvaReview: integer(scheduleSummary.readyForAvaReview, "AVA待复核数"),
        invalidTime: integer(scheduleSummary.invalidTime, "异常时间数"),
      },
      rows: scheduleRows,
      truncated: bool(scheduleSource.truncated, "教务宝排课就绪截断状态"),
    },
    leaveMakeups: {
      summary: {
        attached: integer(leaveSummary.attached, "请假代课候选数"),
        leave: integer(leaveSummary.leave, "请假候选数"),
        makeup: integer(leaveSummary.makeup, "补课候选数"),
        unknown: integer(leaveSummary.unknown, "待确认请假代课数"),
      },
      rows: leaveRows,
      truncated: bool(leaveSource.truncated, "教务宝请假代课截断状态"),
    },
    renewalEvidence: {
      summary: {
        candidates: integer(renewalSummary.candidates, "续课候选数"),
        withContract: integer(renewalSummary.withContract, "合同证据数"),
        withHourBalance: integer(renewalSummary.withHourBalance, "课时证据数"),
      },
      rows: renewalRows,
      truncated: bool(renewalSource.truncated, "教务宝续课证据截断状态"),
    },
  };

  if (state === "absent" && (runToken || scheduleRows.length || leaveRows.length || renewalRows.length)) {
    throw new Error("不存在的教务宝运营就绪队列不能包含资料。\n");
  }
  return result;
}

export type JiaowubaoOperationsReadinessPanelProps = Readonly<{
  readiness: JiaowubaoOperationsReadiness | null;
  loading: boolean;
  error: boolean;
  timezone: string;
  /** UI protection only; the endpoint must separately enforce the admin scope. */
  isAdmin: boolean;
}>;

function formatInstant(value: string, timezone: string) {
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

function resolutionLabel(value: JiaowubaoOperationsReadinessResolution) {
  return ({
    exact_name: "已精确匹配",
    unresolved: "待匹配",
    ambiguous: "匹配有歧义",
    not_found: "未找到内部记录",
  } as const)[value];
}

function QueueSummary({ label, value, tone = "neutral" }: Readonly<{ label: string; value: number; tone?: "neutral" | "amber" | "green" | "red" }>) {
  if (value === 0) return null;
  return <span className={`jwb-readiness-summary ${tone}`}><strong>{value}</strong><small>{label}</small></span>;
}

function QueueEmpty({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="jwb-readiness-empty" role="status">{children}</div>;
}

function ScheduleQueue({ data, timezone }: Readonly<{ data: JiaowubaoOperationsReadiness["schedule"]; timezone: string }>) {
  const showSummary = data.summary.needsTeacherMapping > 0
    || data.summary.needsCourseMapping > 0
    || data.summary.readyForAvaReview > 0
    || data.summary.invalidTime > 0;

  return <section className="jwb-readiness-panel" aria-labelledby="jwb-readiness-schedule-title">
    <header>
      <span className="jwb-readiness-panel-mark schedule" aria-hidden="true"><CalendarClock size={17} /></span>
      <div><h2 id="jwb-readiness-schedule-title">排课映射与 AVA</h2><p>{data.summary.windowEvents} 节</p></div>
    </header>
    {showSummary ? <div className="jwb-readiness-summary-grid" aria-label="排课映射与 AVA 汇总">
      <QueueSummary label="老师待匹配" value={data.summary.needsTeacherMapping} tone={data.summary.needsTeacherMapping ? "amber" : "green"} />
      <QueueSummary label="课程待匹配" value={data.summary.needsCourseMapping} tone={data.summary.needsCourseMapping ? "amber" : "green"} />
      <QueueSummary label="可复核 AVA" value={data.summary.readyForAvaReview} tone="green" />
      <QueueSummary label="异常时间" value={data.summary.invalidTime} tone={data.summary.invalidTime ? "red" : "neutral"} />
    </div> : null}
    {!data.rows.length ? <QueueEmpty>当前时间范围没有可复核的课程。</QueueEmpty> : <div className="jwb-readiness-list" role="list" aria-label="课程映射">
      {data.rows.map((row) => <article className="jwb-readiness-row schedule" key={row.eventId} role="listitem">
        <time dateTime={row.startsAt}><strong>{formatInstant(row.startsAt, timezone)}</strong><small>至 {formatInstant(row.endsAt, timezone)}</small></time>
        <span><strong>{row.courseName ?? "课程待标注"}</strong>{row.needsCourseMapping ? <small>{resolutionLabel(row.subjectResolution)}</small> : null}</span>
        <span><strong>{row.teacherLabel ?? resolutionLabel(row.teacherResolution)}</strong>{row.needsTeacherMapping ? <small>{resolutionLabel(row.teacherResolution)}</small> : null}</span>
        <span className={row.readyForAvaReview ? "ready" : "pending"}><strong>{row.readyForAvaReview ? "可复核 AVA" : row.availabilityEffect === "blocks_teacher_ava" ? "等待映射后复核" : "仅来源展示"}</strong><small>{row.attachedParticipantCount} 位关联学员</small></span>
      </article>)}
    </div>}
    {data.truncated ? <div className="jwb-readiness-truncated" role="status"><CircleAlert size={15} />仅显示部分映射资料。</div> : null}
  </section>;
}

function LeaveMakeupQueue({ data }: Readonly<{ data: JiaowubaoOperationsReadiness["leaveMakeups"] }>) {
  const showSummary = data.summary.attached > 0
    || data.summary.leave > 0
    || data.summary.makeup > 0
    || data.summary.unknown > 0;

  return <section className="jwb-readiness-panel" aria-labelledby="jwb-readiness-leave-title">
    <header>
      <span className="jwb-readiness-panel-mark leave" aria-hidden="true"><UserRoundCheck size={17} /></span>
      <h2 id="jwb-readiness-leave-title">请假与补课核对</h2>
    </header>
    {showSummary ? <div className="jwb-readiness-summary-grid three" aria-label="请假与补课候选汇总">
      <QueueSummary label="已关联候选" value={data.summary.attached} tone="amber" />
      <QueueSummary label="请假" value={data.summary.leave} />
      <QueueSummary label="补课" value={data.summary.makeup} />
      <QueueSummary label="待确认类型" value={data.summary.unknown} tone={data.summary.unknown ? "amber" : "neutral"} />
    </div> : null}
    {!data.rows.length ? <QueueEmpty>没有待人工核对的请假或补课记录。</QueueEmpty> : <div className="jwb-readiness-list" role="list" aria-label="请假与补课候选">
      {data.rows.map((row) => <article className="jwb-readiness-row leave" key={row.incidentId} role="listitem">
        <span><strong>{row.sourceDate ?? "日期待确认"}</strong><small>{row.timeText ?? "时间待确认"}</small></span>
        <span><strong>{row.kind === "leave" ? "请假" : row.kind === "makeup" ? "补课" : "类型待确认"}</strong><small>{row.courseName ?? "课程待标注"}</small></span>
        <span><strong>{row.className ?? "班级待标注"}</strong><small>{row.teacherLabel ?? "老师待标注"}</small></span>
      </article>)}
    </div>}
    {data.truncated ? <div className="jwb-readiness-truncated" role="status"><CircleAlert size={15} />仅显示部分请假与补课候选。</div> : null}
  </section>;
}

function RenewalQueue({ data }: Readonly<{ data: JiaowubaoOperationsReadiness["renewalEvidence"] }>) {
  const showSummary = data.summary.candidates > 0
    || data.summary.withContract > 0
    || data.summary.withHourBalance > 0;

  return <section className="jwb-readiness-panel" aria-labelledby="jwb-readiness-renewal-title">
    <header>
      <span className="jwb-readiness-panel-mark renewal" aria-hidden="true"><FileCheck2 size={17} /></span>
      <h2 id="jwb-readiness-renewal-title">续课依据</h2>
    </header>
    {showSummary ? <div className="jwb-readiness-summary-grid three" aria-label="续课证据汇总">
      <QueueSummary label="候选" value={data.summary.candidates} />
      <QueueSummary label="有合同依据" value={data.summary.withContract} tone="green" />
      <QueueSummary label="有课时依据" value={data.summary.withHourBalance} tone="green" />
    </div> : null}
    {!data.rows.length ? <QueueEmpty>当前没有续课候选。</QueueEmpty> : <div className="jwb-readiness-list" role="list" aria-label="续课依据">
      {data.rows.map((row) => <article className="jwb-readiness-row renewal" key={`${row.studentId}:${row.courseName ?? ""}`} role="listitem">
        <span><strong>{row.courseName ?? "课程待标注"}</strong></span>
        <span><strong>{row.hasContractEvidence ? "合同依据已提供" : "缺少合同依据"}</strong><small>{row.hasHourBalanceEvidence ? "课时依据已提供" : "缺少课时依据"}</small></span>
        <span><strong>总 {row.totalHours ?? "—"} · 已消 {row.usedHours ?? "—"}</strong><small>剩余 {row.remainingHours ?? "—"} 课时</small></span>
      </article>)}
    </div>}
    {data.truncated ? <div className="jwb-readiness-truncated" role="status"><CircleAlert size={15} />仅显示部分续课依据。</div> : null}
  </section>;
}

/**
 * An admin review surface, deliberately without controls. It separates source
 * evidence from editable operations and makes the absence of an import
 * explicit rather than inferring a readiness state.
 */
export function JiaowubaoOperationsReadinessPanel({
  readiness,
  loading,
  error,
  timezone,
  isAdmin,
}: JiaowubaoOperationsReadinessPanelProps) {
  return <section className="jiaowubao-operations-readiness" aria-labelledby="jiaowubao-operations-readiness-title">
    <header className="jiaowubao-operations-readiness-header">
      <span className="jiaowubao-operations-readiness-mark" aria-hidden="true"><CheckCircle2 size={18} /></span>
      <div>
        <h2 id="jiaowubao-operations-readiness-title">运营核对</h2>
      </div>
    </header>

    {!isAdmin ? <QueueEmpty>仅管理员可查看运营核对资料。</QueueEmpty> : null}
    {isAdmin && loading ? <QueueEmpty>正在读取运营核对资料…</QueueEmpty> : null}
    {isAdmin && !loading && error ? <QueueEmpty>运营核对资料暂时无法读取，请稍后重试。</QueueEmpty> : null}
    {isAdmin && !loading && !error && (!readiness || readiness.state === "absent") ? <QueueEmpty>当前没有可用于运营核对的资料。</QueueEmpty> : null}
    {isAdmin && !loading && !error && readiness?.state === "complete" ? <div className="jiaowubao-operations-readiness-grid">
      <ScheduleQueue data={readiness.schedule} timezone={timezone} />
      <LeaveMakeupQueue data={readiness.leaveMakeups} />
      <RenewalQueue data={readiness.renewalEvidence} />
    </div> : null}
  </section>;
}

export default JiaowubaoOperationsReadinessPanel;
