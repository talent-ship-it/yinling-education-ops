"use client";

import {
  CalendarClock,
  ChevronDown,
  CircleAlert,
  History,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Unlink2,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

export type JiaowubaoScheduleMappingPriorityStatus = "unmapped" | "authority_changed";

/**
 * Narrow browser contract for the current/future, human-actionable mapping
 * queue.  It is intentionally separate from the all-history review DTO.
 */
export type JiaowubaoScheduleMappingPriorityReview = Readonly<{
  state: "absent" | "complete";
  /** Opaque server value. It is never displayed or constructed by the browser. */
  runToken: string | null;
  teachersVersion: number | null;
  teachers: readonly Readonly<{
    id: string;
    name: string;
    subjectIds: readonly string[];
  }>[];
  window: Readonly<{ startsAt: string; endsAt: string }>;
  summary: Readonly<{
    total: number;
    unmapped: number;
    authorityChanged: number;
    revokedInWindow: number;
  }>;
  candidates: readonly Readonly<{
    /** Opaque pair-level evidence token, not a source event or row ID. */
    mappingKey: string;
    teacherLabel: string;
    courseLabel: string;
    eventCount: number;
    status: JiaowubaoScheduleMappingPriorityStatus;
    targetTeacherId: string | null;
    targetTeacherName: string | null;
    targetSubjectId: string | null;
    decidedAt: string | null;
    /** Exact parsed source start in `window`, never a relative deadline. */
    nextStartsAt: string;
    windowEventCount: number;
  }>[];
  nextCursor: string | null;
}>;

export type JiaowubaoScheduleMappingPriorityReviewPanelProps = Readonly<{
  review: JiaowubaoScheduleMappingPriorityReview | null;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  isAdmin: boolean;
  /** Display-only timezone; it does not affect source-window semantics. */
  timezone?: string;
  busyMappingKey: string | null;
  onConfirm: (input: Readonly<{ mappingKey: string; teacherId: string; subjectId: string }>) => void;
  onDismiss: (mappingKey: string) => void;
  onLoadMore: () => void;
  /** Lets the host open the separate all-history reader without coupling routing here. */
  onViewHistory?: () => void;
}>;

const MAX_TEACHERS = 512;
const MAX_SUBJECTS_PER_TEACHER = 1024;
const MAX_CANDIDATES = 120;
const OPAQUE_KEY = /^sha256:[a-f0-9]{64}$/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PRIORITY_WINDOW_MS = 63 * 24 * 60 * 60 * 1_000;
const statuses = new Set<JiaowubaoScheduleMappingPriorityStatus>(["unmapped", "authority_changed"]);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效。`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, nullable = false, max = 500) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}格式无效。`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label}格式无效。`);
  return value as number;
}

function positiveInteger(value: unknown, label: string) {
  const result = nonNegativeInteger(value, label);
  if (result < 1) throw new Error(`${label}格式无效。`);
  return result;
}

function opaque(value: unknown, label: string, nullable = false) {
  const result = text(value, label, nullable, 80);
  if (result === null) return null;
  if (!OPAQUE_KEY.test(result)) throw new Error(`${label}格式无效。`);
  return result;
}

function instant(value: unknown, label: string, nullable = false) {
  const result = text(value, label, nullable, 40);
  if (result === null) return null;
  if (!CANONICAL_INSTANT.test(result) || new Date(result).toISOString() !== result) {
    throw new Error(`${label}格式无效。`);
  }
  return result;
}

function priorityOrder(candidate: JiaowubaoScheduleMappingPriorityReview["candidates"][number]) {
  return [
    candidate.status === "authority_changed" ? 0 : 1,
    new Date(candidate.nextStartsAt).getTime(),
    -candidate.windowEventCount,
    candidate.mappingKey,
  ] as const;
}

function isInPriorityOrder(
  left: JiaowubaoScheduleMappingPriorityReview["candidates"][number],
  right: JiaowubaoScheduleMappingPriorityReview["candidates"][number],
) {
  const leftOrder = priorityOrder(left);
  const rightOrder = priorityOrder(right);
  for (let index = 0; index < leftOrder.length; index += 1) {
    if (leftOrder[index]! === rightOrder[index]!) continue;
    return leftOrder[index]! < rightOrder[index]!;
  }
  return true;
}

/**
 * Fail closed if the server response is not the reviewed priority DTO.  In
 * particular, no target is silently preselected and every time is a canonical
 * absolute instant inside the fixed 63-day source-start window.
 */
export function parseJiaowubaoScheduleMappingPriorityReview(value: unknown): JiaowubaoScheduleMappingPriorityReview {
  const source = asRecord(value, "当前教务宝映射待核对响应");
  if (source.state !== "absent" && source.state !== "complete") throw new Error("当前教务宝映射待核对状态无效。");
  const state = source.state;
  const runToken = text(source.runToken, "当前教务宝映射待核对批次", true, 128);
  const teachersVersion = source.teachersVersion === null
    ? null
    : nonNegativeInteger(source.teachersVersion, "老师资料版本");
  const windowSource = asRecord(source.window, "当前教务宝映射待核对时间范围");
  const startsAt = instant(windowSource.startsAt, "当前教务宝映射待核对开始时间")!;
  const endsAt = instant(windowSource.endsAt, "当前教务宝映射待核对结束时间")!;
  if (new Date(endsAt).getTime() - new Date(startsAt).getTime() !== PRIORITY_WINDOW_MS
    || new Date(startsAt).getUTCHours() !== 0 || new Date(endsAt).getUTCHours() !== 0) {
    throw new Error("当前教务宝映射待核对时间范围无效。");
  }
  if ((state === "complete") !== Boolean(runToken) || (state === "complete") !== (teachersVersion !== null)) {
    throw new Error("当前教务宝映射待核对批次无效。");
  }

  if (!Array.isArray(source.teachers) || source.teachers.length > MAX_TEACHERS) {
    throw new Error("当前教务宝映射老师目录格式无效。");
  }
  const teachers = source.teachers.map((value, index) => {
    const teacher = asRecord(value, `当前教务宝映射老师 ${index + 1}`);
    if (!Array.isArray(teacher.subjectIds) || teacher.subjectIds.length > MAX_SUBJECTS_PER_TEACHER) {
      throw new Error(`当前教务宝映射老师 ${index + 1}科目格式无效。`);
    }
    const subjectIds = teacher.subjectIds.map((subject, subjectIndex) => (
      text(subject, `当前教务宝映射老师 ${index + 1}科目 ${subjectIndex + 1}`, false, 240)!
    ));
    if (new Set(subjectIds).size !== subjectIds.length) throw new Error(`当前教务宝映射老师 ${index + 1}科目重复。`);
    return {
      id: text(teacher.id, `当前教务宝映射老师 ${index + 1}编号`, false, 240)!,
      name: text(teacher.name, `当前教务宝映射老师 ${index + 1}姓名`, false, 240)!,
      subjectIds,
    } as const;
  });
  if (new Set(teachers.map((teacher) => teacher.id)).size !== teachers.length) {
    throw new Error("当前教务宝映射老师目录存在重复老师。");
  }

  const summarySource = asRecord(source.summary, "当前教务宝映射待核对汇总");
  const summary = {
    total: nonNegativeInteger(summarySource.total, "当前待核对总数"),
    unmapped: nonNegativeInteger(summarySource.unmapped, "当前待首次确认数"),
    authorityChanged: nonNegativeInteger(summarySource.authorityChanged, "当前老师资料已变更数"),
    revokedInWindow: nonNegativeInteger(summarySource.revokedInWindow, "当前已撤销数"),
  } as const;
  if (summary.total !== summary.unmapped + summary.authorityChanged) {
    throw new Error("当前教务宝映射待核对汇总不一致。");
  }

  if (!Array.isArray(source.candidates) || source.candidates.length > MAX_CANDIDATES) {
    throw new Error("当前教务宝映射待核对候选格式无效。");
  }
  const candidates = source.candidates.map((value, index) => {
    const candidate = asRecord(value, `当前教务宝映射待核对候选 ${index + 1}`);
    const status = candidate.status;
    if (typeof status !== "string" || !statuses.has(status as JiaowubaoScheduleMappingPriorityStatus)) {
      throw new Error(`当前教务宝映射待核对候选 ${index + 1}状态无效。`);
    }
    const targetTeacherId = text(candidate.targetTeacherId, `当前教务宝映射待核对候选 ${index + 1}目标老师`, true, 240);
    const targetTeacherName = text(candidate.targetTeacherName, `当前教务宝映射待核对候选 ${index + 1}目标老师名称`, true, 240);
    const targetSubjectId = text(candidate.targetSubjectId, `当前教务宝映射待核对候选 ${index + 1}目标科目`, true, 240);
    const decidedAt = instant(candidate.decidedAt, `当前教务宝映射待核对候选 ${index + 1}确认时间`, true);
    const nextStartsAt = instant(candidate.nextStartsAt, `当前教务宝映射待核对候选 ${index + 1}下次来源课表`)!;
    const eventCount = positiveInteger(candidate.eventCount, `当前教务宝映射待核对候选 ${index + 1}关联课表数`);
    const windowEventCount = positiveInteger(candidate.windowEventCount, `当前教务宝映射待核对候选 ${index + 1}当前课表数`);
    if (windowEventCount > eventCount
      || new Date(nextStartsAt).getTime() < new Date(startsAt).getTime()
      || new Date(nextStartsAt).getTime() >= new Date(endsAt).getTime()) {
      throw new Error(`当前教务宝映射待核对候选 ${index + 1}时间范围无效。`);
    }
    const hasAssignedTarget = targetTeacherId !== null || targetTeacherName !== null || targetSubjectId !== null;
    if (status === "unmapped" && (hasAssignedTarget || decidedAt !== null)) {
      throw new Error(`当前教务宝映射待核对候选 ${index + 1}目标状态不一致。`);
    }
    if (status === "authority_changed" && (!targetTeacherId || !targetSubjectId || !decidedAt)) {
      throw new Error(`当前教务宝映射待核对候选 ${index + 1}缺少旧映射目标。`);
    }
    return {
      mappingKey: opaque(candidate.mappingKey, `当前教务宝映射待核对候选 ${index + 1}令牌`)!,
      teacherLabel: text(candidate.teacherLabel, `当前教务宝映射待核对候选 ${index + 1}来源老师`, false, 240)!,
      courseLabel: text(candidate.courseLabel, `当前教务宝映射待核对候选 ${index + 1}来源课程`, false, 500)!,
      eventCount,
      status: status as JiaowubaoScheduleMappingPriorityStatus,
      targetTeacherId,
      targetTeacherName,
      targetSubjectId,
      decidedAt,
      nextStartsAt,
      windowEventCount,
    } as const;
  });
  if (new Set(candidates.map((candidate) => candidate.mappingKey)).size !== candidates.length) {
    throw new Error("当前教务宝映射待核对候选重复。");
  }
  if (candidates.some((candidate, index) => index > 0 && !isInPriorityOrder(candidates[index - 1]!, candidate))) {
    throw new Error("当前教务宝映射待核对排序无效。");
  }

  const nextCursor = opaque(source.nextCursor, "当前教务宝映射待核对分页游标", true);
  if (state === "absent" && (runToken || teachers.length || candidates.length || nextCursor || summary.total || summary.revokedInWindow)) {
    throw new Error("不存在的当前教务宝映射待核对不能包含候选。\n");
  }
  if (candidates.length > summary.total) throw new Error("当前教务宝映射待核对候选数量无效。");

  return {
    state,
    runToken,
    teachersVersion,
    teachers,
    window: { startsAt, endsAt },
    summary,
    candidates,
    nextCursor,
  };
}

function formatInstant(value: string, timezone: string) {
  const instantValue = new Date(value);
  if (Number.isNaN(instantValue.valueOf())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instantValue);
}

function statusLabel(status: JiaowubaoScheduleMappingPriorityStatus) {
  return status === "authority_changed" ? "老师资料已变更" : "待首次确认";
}

function statusTone(status: JiaowubaoScheduleMappingPriorityStatus) {
  return status === "authority_changed" ? "red" : "amber";
}

function PriorityCandidateRow({
  candidate,
  teachers,
  timezone,
  busy,
  onConfirm,
  onDismiss,
}: Readonly<{
  candidate: JiaowubaoScheduleMappingPriorityReview["candidates"][number];
  teachers: JiaowubaoScheduleMappingPriorityReview["teachers"];
  timezone: string;
  busy: boolean;
  onConfirm: JiaowubaoScheduleMappingPriorityReviewPanelProps["onConfirm"];
  onDismiss: JiaowubaoScheduleMappingPriorityReviewPanelProps["onDismiss"];
}>) {
  // Always begin blank: even an authority-changed historical target is shown
  // as evidence only and is never reused as a browser-side suggestion.
  const [expanded, setExpanded] = useState(false);
  const [teacherId, setTeacherId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const selectedTeacher = useMemo(() => teachers.find((teacher) => teacher.id === teacherId) ?? null, [teacherId, teachers]);
  const canConfirm = Boolean(teacherId && subjectId && !busy);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canConfirm) return;
    onConfirm({ mappingKey: candidate.mappingKey, teacherId, subjectId });
  };

  return <details
    className={`jwb-mapping-candidate ${candidate.status}`}
    onToggle={(event) => setExpanded(event.currentTarget.open)}
  >
    <summary>
      <span className="jwb-mapping-source"><strong>{candidate.teacherLabel}</strong><small>{candidate.courseLabel}</small></span>
      <span className={`jwb-mapping-status ${statusTone(candidate.status)}`}>
        <strong>{statusLabel(candidate.status)}</strong>
        <small>{formatInstant(candidate.nextStartsAt, timezone)}</small>
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </summary>
    {expanded ? <div className="jwb-mapping-candidate-body">
      {candidate.status === "authority_changed" ? <div className="jwb-mapping-existing-target">
        <p><CircleAlert size={14} />老师资料已变更，请重新选择后确认。</p>
      </div> : null}
      <form className="jwb-mapping-form" onSubmit={onSubmit}>
        <label>老师
          <select
            value={teacherId}
            disabled={busy}
            onChange={(event) => { setTeacherId(event.target.value); setSubjectId(""); }}
          >
            <option value="">请选择老师</option>
            {teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
          </select>
        </label>
        <label>可教科目
          <select
            value={subjectId}
            disabled={busy || !selectedTeacher}
            onChange={(event) => setSubjectId(event.target.value)}
          >
            <option value="">请选择科目</option>
            {selectedTeacher?.subjectIds.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
          </select>
        </label>
        <button className="primary-button" type="submit" disabled={!canConfirm}>
          <ShieldCheck size={15} />{busy ? "正在确认…" : "确认映射"}
        </button>
      </form>
      <button
        className="text-button danger"
        type="button"
        disabled={busy}
        onClick={() => onDismiss(candidate.mappingKey)}
      ><Unlink2 size={15} />此组合无需映射</button>
    </div> : null}
  </details>;
}

/**
 * Embeddable current/future action queue.  The host owns network loading and
 * navigation; this component only renders validated data and submits explicit
 * human selections.  It does not create bookings, AVA changes, tasks, or any
 * inferred operational action.
 */
export function JiaowubaoScheduleMappingPriorityReviewPanel({
  review,
  loading,
  loadingMore,
  error,
  isAdmin,
  timezone = "Australia/Melbourne",
  busyMappingKey,
  onConfirm,
  onDismiss,
  onLoadMore,
  onViewHistory,
}: JiaowubaoScheduleMappingPriorityReviewPanelProps) {
  const showSummary = review?.state === "complete"
    && (review.summary.unmapped > 0 || review.summary.authorityChanged > 0 || review.summary.revokedInWindow > 0);

  return <section className="jiaowubao-schedule-mapping-review jiaowubao-schedule-mapping-priority-review" aria-labelledby="jiaowubao-schedule-mapping-priority-review-title">
    <header className="jiaowubao-schedule-mapping-review-header">
      <span className="jiaowubao-schedule-mapping-review-mark" aria-hidden="true"><CalendarClock size={18} /></span>
      <div>
        <h2 id="jiaowubao-schedule-mapping-priority-review-title">当前 63 天待核对</h2>
      </div>
      <span className="jiaowubao-schedule-mapping-review-guard"><LockKeyhole size={13} /> 人工确认</span>
    </header>

    {!isAdmin ? <div className="jwb-mapping-empty">仅管理员可查看和确认当前待核对队列。</div> : null}
    {isAdmin && loading ? <div className="jwb-mapping-empty" role="status" aria-live="polite">正在读取待核对队列…</div> : null}
    {isAdmin && !loading && error ? <div className="jwb-mapping-empty" role="alert">待核对队列暂时无法读取，请稍后重试。</div> : null}
    {isAdmin && !loading && !error && (!review || review.state === "absent") ? <div className="jwb-mapping-empty" role="status">当前没有可核对的映射。</div> : null}
    {isAdmin && !loading && !error && review?.state === "complete" ? <>
      {showSummary ? <div className="jwb-mapping-summary-grid" aria-label="待核对汇总">
        {review.summary.unmapped > 0 ? <span className="amber"><strong>{review.summary.unmapped}</strong><small>待首次确认</small></span> : null}
        {review.summary.authorityChanged > 0 ? <span className="red"><strong>{review.summary.authorityChanged}</strong><small>老师资料已变更</small></span> : null}
        {review.summary.revokedInWindow > 0 ? <span><strong>{review.summary.revokedInWindow}</strong><small>已撤销</small></span> : null}
      </div> : null}
      {onViewHistory ? <div className="jwb-mapping-footer">
        <button className="secondary-button" type="button" onClick={onViewHistory}><History size={15} />查看全部历史组合</button>
      </div> : null}
      {!review.candidates.length ? <div className="jwb-mapping-empty">当前 63 天没有待核对的老师与课程。</div> : <div className="jwb-mapping-list" aria-label="当前老师与课程映射待核对候选">
        {review.candidates.map((candidate) => <PriorityCandidateRow
          key={candidate.mappingKey}
          candidate={candidate}
          teachers={review.teachers}
          timezone={timezone}
          busy={busyMappingKey === candidate.mappingKey}
          onConfirm={onConfirm}
          onDismiss={onDismiss}
        />)}
      </div>}
      {review.nextCursor ? <footer className="jwb-mapping-footer">
        <span>已载入 {review.candidates.length} / {review.summary.total} 条组合</span>
        <button className="secondary-button" type="button" disabled={loadingMore} onClick={onLoadMore}>
          <RefreshCw size={15} />{loadingMore ? "正在载入…" : "载入更多"}
        </button>
      </footer> : review.summary.total > review.candidates.length ? <div className="jwb-mapping-warning" role="status"><CircleAlert size={15} />待核对队列已变化，请刷新后继续核对。</div> : null}
    </> : null}
  </section>;
}

export default JiaowubaoScheduleMappingPriorityReviewPanel;
