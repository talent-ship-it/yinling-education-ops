"use client";

import { ChevronDown, CircleAlert, Link2, LockKeyhole, RefreshCw, ShieldCheck, Unlink2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

export type JiaowubaoScheduleMappingStatus = "unmapped" | "confirmed" | "revoked" | "authority_changed";

export type JiaowubaoScheduleMappingReview = Readonly<{
  state: "absent" | "complete";
  /** Opaque server value. It is never rendered or sent back as a source ID. */
  runToken: string | null;
  teachersVersion: number | null;
  teachers: readonly Readonly<{
    id: string;
    name: string;
    subjectIds: readonly string[];
  }>[];
  summary: Readonly<{
    total: number;
    unmapped: number;
    confirmed: number;
    revoked: number;
    authorityChanged: number;
  }>;
  candidates: readonly Readonly<{
    /** Opaque group-level source proof, not an event or source-row ID. */
    mappingKey: string;
    teacherLabel: string;
    courseLabel: string;
    eventCount: number;
    status: JiaowubaoScheduleMappingStatus;
    targetTeacherId: string | null;
    targetTeacherName: string | null;
    targetSubjectId: string | null;
    decidedAt: string | null;
  }>[];
  nextCursor: string | null;
}>;

export type JiaowubaoScheduleMappingReviewPanelProps = Readonly<{
  review: JiaowubaoScheduleMappingReview | null;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  isAdmin: boolean;
  busyMappingKey: string | null;
  onConfirm: (input: Readonly<{ mappingKey: string; teacherId: string; subjectId: string }>) => void;
  onRevoke: (mappingKey: string) => void;
  onLoadMore: () => void;
}>;

const MAX_TEACHERS = 512;
const MAX_SUBJECTS_PER_TEACHER = 120;
const MAX_CANDIDATES = 120;
const OPAQUE_KEY = /^sha256:[a-f0-9]{64}$/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const statuses = new Set<JiaowubaoScheduleMappingStatus>([
  "unmapped", "confirmed", "revoked", "authority_changed",
]);

function asRecord(value: unknown, label: string) {
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

function opaque(value: unknown, label: string, nullable = false) {
  const result = text(value, label, nullable, 80);
  if (result === null) return null;
  if (!OPAQUE_KEY.test(result)) throw new Error(`${label}格式无效。`);
  return result;
}

function instant(value: unknown, label: string) {
  const result = text(value, label, true, 40);
  if (result === null) return null;
  if (!CANONICAL_INSTANT.test(result) || new Date(result).toISOString() !== result) {
    throw new Error(`${label}格式无效。`);
  }
  return result;
}

/** Parses only the narrow admin DTO returned by the reviewed server route. */
export function parseJiaowubaoScheduleMappingReview(value: unknown): JiaowubaoScheduleMappingReview {
  const source = asRecord(value, "教务宝映射审核响应");
  if (source.state !== "absent" && source.state !== "complete") throw new Error("教务宝映射审核状态无效。");
  const state = source.state;
  const runToken = text(source.runToken, "教务宝映射批次", true, 128);
  const teachersVersion = source.teachersVersion === null ? null : nonNegativeInteger(source.teachersVersion, "老师资料版本");
  const teachersValue = source.teachers;
  const candidatesValue = source.candidates;
  if (!Array.isArray(teachersValue) || teachersValue.length > MAX_TEACHERS) throw new Error("老师映射目录格式无效。");
  if (!Array.isArray(candidatesValue) || candidatesValue.length > MAX_CANDIDATES) throw new Error("教务宝映射候选格式无效。");
  if ((state === "complete") !== Boolean(runToken) || (state === "complete") !== (teachersVersion !== null)) {
    throw new Error("教务宝映射审核批次无效。");
  }

  const teachers = teachersValue.map((value, index) => {
    const teacher = asRecord(value, `老师映射目录 ${index + 1}`);
    if (!Array.isArray(teacher.subjectIds) || teacher.subjectIds.length > MAX_SUBJECTS_PER_TEACHER) {
      throw new Error(`老师映射目录 ${index + 1}科目格式无效。`);
    }
    const subjectIds = teacher.subjectIds.map((subject, subjectIndex) => text(subject, `老师映射目录 ${index + 1}科目 ${subjectIndex + 1}`, false, 240)!);
    if (new Set(subjectIds).size !== subjectIds.length) throw new Error(`老师映射目录 ${index + 1}科目重复。`);
    return {
      id: text(teacher.id, `老师映射目录 ${index + 1}编号`, false, 240)!,
      name: text(teacher.name, `老师映射目录 ${index + 1}姓名`, false, 240)!,
      subjectIds,
    } as const;
  });
  if (new Set(teachers.map((teacher) => teacher.id)).size !== teachers.length) throw new Error("老师映射目录存在重复老师。\n");

  const summary = asRecord(source.summary, "教务宝映射汇总");
  const summaryValue = {
    total: nonNegativeInteger(summary.total, "教务宝映射总数"),
    unmapped: nonNegativeInteger(summary.unmapped, "待确认映射数"),
    confirmed: nonNegativeInteger(summary.confirmed, "已确认映射数"),
    revoked: nonNegativeInteger(summary.revoked, "已撤销映射数"),
    authorityChanged: nonNegativeInteger(summary.authorityChanged, "老师资料变更映射数"),
  } as const;
  if (summaryValue.total !== summaryValue.unmapped + summaryValue.confirmed + summaryValue.revoked + summaryValue.authorityChanged) {
    throw new Error("教务宝映射汇总不一致。\n");
  }

  const candidates = candidatesValue.map((value, index) => {
    const candidate = asRecord(value, `教务宝映射候选 ${index + 1}`);
    const status = candidate.status;
    if (typeof status !== "string" || !statuses.has(status as JiaowubaoScheduleMappingStatus)) {
      throw new Error(`教务宝映射候选 ${index + 1}状态无效。`);
    }
    const targetTeacherId = text(candidate.targetTeacherId, `教务宝映射候选 ${index + 1}目标老师`, true, 240);
    const targetTeacherName = text(candidate.targetTeacherName, `教务宝映射候选 ${index + 1}目标老师名称`, true, 240);
    const targetSubjectId = text(candidate.targetSubjectId, `教务宝映射候选 ${index + 1}目标科目`, true, 240);
    const decidedAt = instant(candidate.decidedAt, `教务宝映射候选 ${index + 1}确认时间`);
    const hasAssignedTarget = targetTeacherId !== null || targetTeacherName !== null || targetSubjectId !== null;
    if (status === "unmapped" && (hasAssignedTarget || decidedAt !== null)) {
      throw new Error(`教务宝映射候选 ${index + 1}目标状态不一致。`);
    }
    // A revoked decision intentionally retains its audit time but no target.
    if (status === "revoked" && hasAssignedTarget) throw new Error(`教务宝映射候选 ${index + 1}目标状态不一致。`);
    if (status === "confirmed" && (!targetTeacherId || !targetTeacherName || !targetSubjectId || !decidedAt)) {
      throw new Error(`教务宝映射候选 ${index + 1}缺少已确认目标。`);
    }
    if (status === "authority_changed" && (!targetTeacherId || !targetSubjectId || !decidedAt)) {
      throw new Error(`教务宝映射候选 ${index + 1}缺少已确认目标。`);
    }
    return {
      mappingKey: opaque(candidate.mappingKey, `教务宝映射候选 ${index + 1}令牌`)!,
      teacherLabel: text(candidate.teacherLabel, `教务宝映射候选 ${index + 1}来源老师`, false, 240)!,
      courseLabel: text(candidate.courseLabel, `教务宝映射候选 ${index + 1}来源课程`, false, 500)!,
      eventCount: nonNegativeInteger(candidate.eventCount, `教务宝映射候选 ${index + 1}关联课表数`),
      status: status as JiaowubaoScheduleMappingStatus,
      targetTeacherId,
      targetTeacherName,
      targetSubjectId,
      decidedAt,
    } as const;
  });
  if (new Set(candidates.map((candidate) => candidate.mappingKey)).size !== candidates.length) {
    throw new Error("教务宝映射候选重复。\n");
  }

  const nextCursor = opaque(source.nextCursor, "教务宝映射分页游标", true);
  if (state === "absent" && (teachers.length || candidates.length || nextCursor || summaryValue.total)) {
    throw new Error("不存在的教务宝映射审核不能包含候选。\n");
  }
  return { state, runToken, teachersVersion, teachers, summary: summaryValue, candidates, nextCursor };
}

function statusLabel(status: JiaowubaoScheduleMappingStatus) {
  return ({
    unmapped: "待确认",
    confirmed: "已确认",
    revoked: "已撤销",
    authority_changed: "老师资料已变更",
  } as const)[status];
}

function statusTone(status: JiaowubaoScheduleMappingStatus) {
  return status === "confirmed" ? "green" : status === "authority_changed" ? "red" : "amber";
}

function MappingCandidateRow({
  candidate,
  teachers,
  busy,
  onConfirm,
  onRevoke,
}: Readonly<{
  candidate: JiaowubaoScheduleMappingReview["candidates"][number];
  teachers: JiaowubaoScheduleMappingReview["teachers"];
  busy: boolean;
  onConfirm: JiaowubaoScheduleMappingReviewPanelProps["onConfirm"];
  onRevoke: JiaowubaoScheduleMappingReviewPanelProps["onRevoke"];
}>) {
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
      <span className={`jwb-mapping-status ${statusTone(candidate.status)}`}><strong>{statusLabel(candidate.status)}</strong></span>
      <ChevronDown size={16} aria-hidden="true" />
    </summary>
    {expanded ? <div className="jwb-mapping-candidate-body">
      {candidate.status === "confirmed" || candidate.status === "authority_changed" ? <div className="jwb-mapping-existing-target">
        <span><small>已确认老师</small><strong>{candidate.targetTeacherName ?? "原老师已不可用"}</strong></span>
        <span><small>已确认可教科目</small><strong>{candidate.targetSubjectId}</strong></span>
        {candidate.status === "authority_changed" ? <p><CircleAlert size={14} /> 当前老师资料已变更，请重新选择并确认。</p> : null}
      </div> : null}
      {candidate.status === "confirmed" ? <button
        className="text-button danger"
        type="button"
        disabled={busy}
        onClick={() => onRevoke(candidate.mappingKey)}
      ><Unlink2 size={15} />撤销这条映射</button> : <form className="jwb-mapping-form" onSubmit={onSubmit}>
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
        <button className="primary-button" type="submit" disabled={!canConfirm}><ShieldCheck size={15} />{busy ? "正在确认…" : "确认映射"}</button>
      </form>}
    </div> : null}
  </details>;
}

/**
 * Explicit human mapping surface. It does not expose source IDs and never
 * offers a conversion into native scheduling/AVA/booking operations.
 */
export function JiaowubaoScheduleMappingReviewPanel({
  review,
  loading,
  loadingMore,
  error,
  isAdmin,
  busyMappingKey,
  onConfirm,
  onRevoke,
  onLoadMore,
}: JiaowubaoScheduleMappingReviewPanelProps) {
  const showSummary = review?.state === "complete"
    && (review.summary.unmapped > 0 || review.summary.confirmed > 0 || review.summary.revoked > 0 || review.summary.authorityChanged > 0);

  return <section className="jiaowubao-schedule-mapping-review" aria-labelledby="jiaowubao-schedule-mapping-review-title">
    <header className="jiaowubao-schedule-mapping-review-header">
      <span className="jiaowubao-schedule-mapping-review-mark" aria-hidden="true"><Link2 size={18} /></span>
      <div>
        <h2 id="jiaowubao-schedule-mapping-review-title">老师与课程映射确认</h2>
      </div>
      <span className="jiaowubao-schedule-mapping-review-guard"><LockKeyhole size={13} /> 可撤销</span>
    </header>

    {!isAdmin ? <div className="jwb-mapping-empty">仅管理员可确认老师与课程映射。</div> : null}
    {isAdmin && loading ? <div className="jwb-mapping-empty" role="status" aria-live="polite">正在读取可确认的映射…</div> : null}
    {isAdmin && !loading && error ? <div className="jwb-mapping-empty" role="alert">映射候选暂时无法读取，请稍后重试。</div> : null}
    {isAdmin && !loading && !error && (!review || review.state === "absent") ? <div className="jwb-mapping-empty" role="status">当前没有可确认的映射。</div> : null}
    {isAdmin && !loading && !error && review?.state === "complete" ? <>
      {showSummary ? <div className="jwb-mapping-summary-grid" aria-label="映射汇总">
        {review.summary.unmapped > 0 ? <span className="amber"><strong>{review.summary.unmapped}</strong><small>待确认</small></span> : null}
        {review.summary.confirmed > 0 ? <span className="green"><strong>{review.summary.confirmed}</strong><small>已确认</small></span> : null}
        {review.summary.revoked > 0 ? <span className="amber"><strong>{review.summary.revoked}</strong><small>已撤销</small></span> : null}
        {review.summary.authorityChanged > 0 ? <span className="red"><strong>{review.summary.authorityChanged}</strong><small>资料已变更</small></span> : null}
      </div> : null}
      {!review.candidates.length ? <div className="jwb-mapping-empty">没有可确认的老师与课程。</div> : <div className="jwb-mapping-list" aria-label="老师与课程映射候选">
        {review.candidates.map((candidate) => <MappingCandidateRow
          key={candidate.mappingKey}
          candidate={candidate}
          teachers={review.teachers}
          busy={busyMappingKey === candidate.mappingKey}
          onConfirm={onConfirm}
          onRevoke={onRevoke}
        />)}
      </div>}
      {review.nextCursor ? <footer className="jwb-mapping-footer">
        <span>已载入 {review.candidates.length} / {review.summary.total} 条组合</span>
        <button className="secondary-button" type="button" disabled={loadingMore} onClick={onLoadMore}>
          <RefreshCw size={15} />{loadingMore ? "正在载入…" : "载入更多"}
        </button>
      </footer> : review.summary.total > review.candidates.length ? <div className="jwb-mapping-warning" role="status"><CircleAlert size={15} />候选列表已变化，请刷新后继续核对。</div> : null}
    </> : null}
  </section>;
}

export default JiaowubaoScheduleMappingReviewPanel;
