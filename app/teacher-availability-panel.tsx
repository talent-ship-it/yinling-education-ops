"use client";

import { splitAvailability, type CalendarOccupation } from "../lib/availability-occupancy";

import { useMemo, useState, type FormEvent } from "react";

import {
  expandTeacherAvailability,
  type AvailabilitySlotInput,
  type TeacherAvailabilityOccurrence,
  type TeacherAvailabilitySubmission,
  type TeacherAvailabilityWindow,
} from "../lib/teacher-availability";

export type AvailabilityActionScope = "date" | "week" | "all";

export type TeacherAvailabilityAction = Readonly<{
  teacherId: string;
  windowId: string;
  date: string;
  scope: AvailabilityActionScope;
}>;

export type TeacherAvailabilityEditAction = TeacherAvailabilityAction & Readonly<{
  start: string;
  end: string;
}>;

export type TeacherAvailabilitySubmissionReview = Readonly<{
  submission: TeacherAvailabilitySubmission;
  submittedAt?: string;
  teacherName?: string;
  currentCity?: string;
  additionalStudents?: number;
  notes?: string;
}>;

export type TeacherAvailabilityPanelProps = Readonly<{
  teacherId: string;
  teacherName: string;
  windows: readonly TeacherAvailabilityWindow[];
  occupations?: readonly CalendarOccupation[];
  legacySlots?: readonly AvailabilitySlotInput[];
  submissions?: readonly TeacherAvailabilitySubmissionReview[];
  reviewingSubmissionId?: string | null;
  reviewInboxBusy?: boolean;
  reviewError?: string;
  displayTimezone: string;
  timezoneOptions: readonly Readonly<{ value: string; label?: string }>[];
  referenceDate?: string;
  onDisplayTimezoneChange: (timezone: string) => void;
  onEdit: (action: TeacherAvailabilityEditAction) => void;
  onDelete: (action: TeacherAvailabilityAction) => void;
  onPromoteLegacy?: (month: string) => void;
  onApproveSubmission: (submission: TeacherAvailabilitySubmission) => void;
  onRejectSubmission: (submission: TeacherAvailabilitySubmission) => void;
  onRefreshSubmissions?: () => void;
}>;

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function monthRange(month: string): { from: string; to: string } {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

function shiftMonth(month: string, amount: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + amount, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function mondayOfWeek(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return shiftDate(date, -((day + 6) % 7));
}

function displayDate(value: string): string {
  return `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
}

function occurrenceDateLabel(occurrence: TeacherAvailabilityOccurrence): string {
  const weekday = new Date(`${occurrence.displayStartDate}T00:00:00.000Z`).getUTCDay();
  return `${displayDate(occurrence.displayStartDate)} ${WEEKDAY_LABELS[weekday]}`;
}

function occurrenceTimeLabel(occurrence: TeacherAvailabilityOccurrence): string {
  const endDate = occurrence.displayEndDate === occurrence.displayStartDate
    ? ""
    : `${displayDate(occurrence.displayEndDate)} `;
  return `${occurrence.displayStart}–${endDate}${occurrence.displayEnd}`;
}

function occurrenceSourceLabel(occurrence: TeacherAvailabilityOccurrence): string {
  const endDate = occurrence.sourceEndDate === occurrence.sourceDate
    ? ""
    : `${displayDate(occurrence.sourceEndDate)} `;
  return `${occurrence.sourceStart}–${endDate}${occurrence.sourceEnd}`;
}

function viewRange(
  view: "day" | "week" | "month",
  selectedMonth: string,
  referenceDate: string,
): { from: string; to: string } {
  if (view === "month") return monthRange(selectedMonth);
  if (view === "day") return { from: referenceDate, to: referenceDate };
  const reference = monthOf(referenceDate) === selectedMonth
    ? referenceDate
    : `${selectedMonth}-01`;
  const month = monthRange(selectedMonth);
  const monday = mondayOfWeek(reference);
  const sunday = shiftDate(monday, 6);
  return {
    from: monday < month.from ? month.from : monday,
    to: sunday > month.to ? month.to : sunday,
  };
}

function occurrenceMatchesMonth(
  window: TeacherAvailabilityWindow,
  selectedMonth: string,
): boolean {
  const range = monthRange(selectedMonth);
  return window.validFrom <= range.to && window.validTo >= range.from;
}

function ScopeSelect({
  value,
  onChange,
  label,
}: Readonly<{
  value: AvailabilityActionScope;
  onChange: (value: AvailabilityActionScope) => void;
  label: string;
}>) {
  return <select
    className="filter-select"
    aria-label={label}
    value={value}
    onChange={(event) => onChange(event.target.value as AvailabilityActionScope)}
  >
    <option value="date">仅此日期</option>
    <option value="week">本周</option>
    <option value="all">全部固定时段</option>
  </select>;
}

function EditForm({
  occurrence,
  onCancel,
  onEdit,
}: Readonly<{
  occurrence: TeacherAvailabilityOccurrence;
  onCancel: () => void;
  onEdit: (action: TeacherAvailabilityEditAction) => void;
}>) {
  const [scope, setScope] = useState<AvailabilityActionScope>("date");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const start = String(data.get("start") ?? "");
    const end = String(data.get("end") ?? "");
    onEdit({
      teacherId: occurrence.teacherId,
      windowId: occurrence.windowId,
      date: occurrence.sourceDate,
      scope,
      start,
      end,
    });
  };

  return <form className="form-grid" onSubmit={submit}>
    <label>开始时间
      <input name="start" type="time" defaultValue={occurrence.sourceStart} required />
    </label>
    <label>结束时间
      <input name="end" type="time" defaultValue={occurrence.sourceEnd} required />
    </label>
    <label className="span-2">修改范围
      <ScopeSelect value={scope} onChange={setScope} label="修改范围" />
    </label>
    <footer>
      <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
      <button className="primary-button" type="submit">保存</button>
    </footer>
  </form>;
}

function DeleteControls({
  occurrence,
  onDelete,
}: Readonly<{
  occurrence: TeacherAvailabilityOccurrence;
  onDelete: (action: TeacherAvailabilityAction) => void;
}>) {
  const [scope, setScope] = useState<AvailabilityActionScope>("date");
  return <div className="toolbar-actions">
    <ScopeSelect value={scope} onChange={setScope} label="删除范围" />
    <button
      className="secondary-button"
      type="button"
      onClick={() => onDelete({
        teacherId: occurrence.teacherId,
        windowId: occurrence.windowId,
        date: occurrence.sourceDate,
        scope,
      })}
    >删除</button>
  </div>;
}

export function TeacherAvailabilityPanel({
  teacherId,
  teacherName,
  windows,
  occupations = [],
  legacySlots = [],
  submissions = [],
  reviewingSubmissionId = null,
  reviewInboxBusy = false,
  reviewError,
  displayTimezone,
  timezoneOptions,
  referenceDate = new Date().toISOString().slice(0, 10),
  onDisplayTimezoneChange,
  onEdit,
  onDelete,
  onPromoteLegacy,
  onApproveSubmission,
  onRejectSubmission,
  onRefreshSubmissions,
}: TeacherAvailabilityPanelProps) {
  const currentMonth = monthOf(referenceDate);
  const nextMonth = shiftMonth(currentMonth, 1);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);
  const [view, setView] = useState<"day" | "week" | "month">("month");
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [anchor, setAnchor] = useState(referenceDate);
  const range = viewRange(view, selectedMonth, anchor);
  const teacherWindows = windows.filter((window) => window.teacherId === teacherId);
  const hasMonthlyRecord = teacherWindows.some((window) =>
    occurrenceMatchesMonth(window, selectedMonth),
  );
  const occurrences = useMemo(
    () => hasMonthlyRecord
      ? expandTeacherAvailability(teacherWindows, {
          from: range.from,
          to: range.to,
          displayTimezone,
        })
      : [],
    [displayTimezone, hasMonthlyRecord, range.from, range.to, teacherWindows],
  );
  const selectedOccurrence = occurrences.find(
    (occurrence) => occurrence.id === selectedOccurrenceId,
  ) ?? occurrences[0];
  const pendingSubmissions = submissions.filter(
    ({ submission }) => submission.teacherId === teacherId,
  );

  return <section className="collection-shell" aria-label={`${teacherName} 月度 AVA`}>
    <header className="panel-header">
      <h2>{teacherName} · 月度 AVA</h2>
      <div className="toolbar-actions">
        <div className="segmented" aria-label="月份">
          <button
            className={selectedMonth === currentMonth ? "active" : ""}
            type="button"
            aria-pressed={selectedMonth === currentMonth}
            onClick={() => { setSelectedMonth(currentMonth); setAnchor(referenceDate); }}
          >本月</button>
          <button
            className={selectedMonth === nextMonth ? "active" : ""}
            type="button"
            aria-pressed={selectedMonth === nextMonth}
            onClick={() => { setSelectedMonth(nextMonth); setAnchor(`${nextMonth}-01`); }}
          >下月</button>
        </div>
        <input type="date" aria-label="查看日期" value={anchor} onChange={(event) => { if (event.target.value) { setAnchor(event.target.value); setSelectedMonth(monthOf(event.target.value)); } }} />
        <div className="segmented" aria-label="显示范围">
          <button type="button" aria-pressed={view === "day"} className={view === "day" ? "active" : ""} onClick={() => setView("day")}>日</button>
          <button className={view === "week" ? "active" : ""} type="button" aria-pressed={view === "week"} onClick={() => setView("week")}>周</button>
          <button className={view === "month" ? "active" : ""} type="button" aria-pressed={view === "month"} onClick={() => setView("month")}>月</button>
        </div>
        <select
          className="filter-select"
          aria-label="显示时区"
          value={displayTimezone}
          onChange={(event) => onDisplayTimezoneChange(event.target.value)}
        >
          {timezoneOptions.map((option) => <option value={option.value} key={option.value}>
            {option.label ?? option.value}
          </option>)}
        </select>
      </div>
    </header>

    {hasMonthlyRecord && occurrences.length > 0 && <div className="availability-timeline" aria-label="AVA 空闲与课程占用">
      <p>绿色：AVA 时段 · 灰色：当前可见课程占用；排课仍需冲突校验（显示 {displayTimezone}）</p>
      {occurrences.map((occurrence) => {
        const total = Date.parse(occurrence.endsAt) - Date.parse(occurrence.startsAt);
        const formatTime = (instant: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: displayTimezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
        const segments = splitAvailability(occurrence, occupations);
        return <div className="availability-day" key={occurrence.id}><strong>{occurrenceDateLabel(occurrence)} · {occurrenceTimeLabel(occurrence)}</strong><div className="availability-track">{segments.map((segment) => <div key={segment.startsAt} className={segment.occupied ? "availability-busy" : "availability-free"} style={{ width: `${(Date.parse(segment.endsAt) - Date.parse(segment.startsAt)) / total * 100}%` }} title={`${formatTime(segment.startsAt)}–${formatTime(segment.endsAt)} ${segment.occupied ? segment.labels.join("、") : "可约"}`} />)}</div><ul className="availability-legend">{segments.map((segment) => <li key={segment.startsAt}>{formatTime(segment.startsAt)}–{formatTime(segment.endsAt)} · {segment.occupied ? segment.labels.join("、") : "可约"}</li>)}</ul></div>;
      })}
    </div>}
    {!hasMonthlyRecord ? <div className="collection-empty" role="status">
      <strong>{selectedMonth} 未收集</strong>
      {legacySlots.length && onPromoteLegacy ? <button
        className="secondary-button"
        type="button"
        onClick={() => onPromoteLegacy(selectedMonth)}
      >采用旧 AVA 到 {selectedMonth}</button> : null}
    </div> : occurrences.length === 0 ? <div className="collection-empty" role="status">
      <strong>暂无可约时段</strong>
    </div> : <div className="master-detail-layout">
      <div className="collection-main">
        <div className="collection-head" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          <span>日期</span><span>显示时区</span><span>老师当地时间</span>
        </div>
        <div className="collection-viewport">
          {occurrences.map((occurrence) => <button
            className={`collection-row ${selectedOccurrence?.id === occurrence.id ? "selected" : ""}`}
            style={{ gridTemplateColumns: "1fr 1fr 1fr" }}
            type="button"
            aria-pressed={selectedOccurrence?.id === occurrence.id}
            key={occurrence.id}
            onClick={() => { setSelectedOccurrenceId(occurrence.id); setEditing(false); }}
          >
            <strong>{occurrenceDateLabel(occurrence)}</strong>
            <span>{occurrenceTimeLabel(occurrence)}</span>
            <span>{occurrenceSourceLabel(occurrence)}</span>
          </button>)}
        </div>
      </div>
      {selectedOccurrence ? <aside className="record-preview">
        <div className="preview-header">
          <div><p className="eyebrow">{selectedOccurrence.sourceTimezone}</p><h2>{occurrenceDateLabel(selectedOccurrence)}</h2></div>
        </div>
        {editing ? <EditForm
          occurrence={selectedOccurrence}
          onCancel={() => setEditing(false)}
          onEdit={(action) => { onEdit(action); setEditing(false); }}
        /> : <>
          <div className="detail-section split">
            <div><span>显示时间</span><strong>{occurrenceTimeLabel(selectedOccurrence)}</strong></div>
            <div><span>当地时间</span><strong>{occurrenceSourceLabel(selectedOccurrence)}</strong></div>
          </div>
          <button className="primary-button full" type="button" onClick={() => setEditing(true)}>编辑时段</button>
          <DeleteControls occurrence={selectedOccurrence} onDelete={onDelete} />
        </>}
      </aside> : null}
    </div>}

    {pendingSubmissions.length ? <div className="detail-section">
      <div className="panel-header"><h2>待审核提交</h2>{onRefreshSubmissions ? <button className="secondary-button" type="button" disabled={reviewInboxBusy || Boolean(reviewingSubmissionId)} onClick={onRefreshSubmissions}>{reviewInboxBusy ? "读取中" : "刷新"}</button> : null}</div>
      <div className="record-list">
        {pendingSubmissions.map(({ submission, submittedAt, additionalStudents, notes }) => <div className="record-row" key={submission.id}>
          <span className="status-pill amber">待审核</span>
          <div><strong>{submission.month}</strong><small>{submission.slots.length} 个时段 · 可接 {additionalStudents ?? 0} 人 · {submittedAt?.slice(0, 10) ?? "待审核"}</small></div>
          <span>{submission.timezone}{notes ? ` · ${notes}` : ""}</span>
          <div className="toolbar-actions">
            <button className="secondary-button" type="button" disabled={Boolean(reviewingSubmissionId)} onClick={() => onRejectSubmission(submission)}>拒绝</button>
            <button className="primary-button" type="button" disabled={Boolean(reviewingSubmissionId)} onClick={() => onApproveSubmission(submission)}>{reviewingSubmissionId === submission.id ? "处理中" : "通过"}</button>
          </div>
        </div>)}
      </div>
      {reviewError ? <div className="collection-empty"><strong>{reviewError}</strong></div> : null}
    </div> : reviewError ? <div className="collection-empty"><strong>{reviewError}</strong>{onRefreshSubmissions ? <button className="secondary-button" type="button" disabled={reviewInboxBusy} onClick={onRefreshSubmissions}>{reviewInboxBusy ? "读取中" : "重新读取"}</button> : null}</div> : null}
  </section>;
}
