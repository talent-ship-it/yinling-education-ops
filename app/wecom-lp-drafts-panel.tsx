"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type Dispatch, type SetStateAction, type RefObject } from "react";
import { RefreshCw } from "lucide-react";

import type { WecomLpDraftSource } from "@/lib/wecom-lp-intake";
import { createSharedStatePoller } from "@/lib/shared-state-poller";
import { TrialScheduleDetails } from "./trial-schedule-details";

type DraftPage = Readonly<{
  drafts: WecomLpDraftSource[];
  nextCursor: string | null;
  total?: number;
}>;

type DraftPanelState = DraftPage & Readonly<{
  key: string;
  error: string;
  loadingMore: boolean;
}>;

export type HandoverTimeDisplay = Readonly<{
  timezone: string;
  label: string;
  formatTime: (value: string) => string;
}>;

export type DraftRange = Readonly<{ from: string; to: string }>;

type WecomLpDraftsPanelProps = Readonly<{
  timeDisplay: HandoverTimeDisplay;
  onSelect: (source: WecomLpDraftSource) => void;
  refreshKey: number;
  range: DraftRange;
  onRangeChange: (range: DraftRange) => void;
}>;

async function readDrafts(signal: AbortSignal, range: DraftRange, timezone: string, cursor?: string | null): Promise<DraftPage> {
  const query = new URLSearchParams({ timezone });
  if (range.from) query.set("from", range.from);
  if (range.to) query.set("to", range.to);
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`/api/operations/wecom-lp-drafts?${query}`, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "读取机器人交接草稿失败");
  if (!Array.isArray(result.drafts)) throw new Error("机器人交接草稿返回格式异常");
  return {
    drafts: result.drafts,
    nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
    total: typeof result.total === "number" ? result.total : undefined,
  };
}

function draftStatus(source: WecomLpDraftSource) {
  if (source.confirmed) return { label: "已创建 LP", tone: "green", blocked: true };
  switch (source.status) {
    case "identity_conflict": return { label: "学生身份冲突", tone: "red", blocked: true };
    case "identity_ambiguous": return { label: "学生匹配不唯一", tone: "amber", blocked: true };
    case "awaiting_student_name": return source.resolvedStudentName ? { label: "待核对", tone: "blue", blocked: false } : { label: "待补学生姓名", tone: "amber", blocked: false };
    default: return { label: "待核对", tone: "blue", blocked: false };
  }
}

function fieldText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function appendDraftPage(value: DraftPanelState, page: DraftPage, key: string): DraftPanelState {
  if (value.key !== key) return value;
  const sources = new Map(value.drafts.map((source) => [source.id, source]));
  for (const source of page.drafts) sources.set(source.id, source);
  return { ...page, total: page.total ?? value.total, key, drafts: [...sources.values()], error: "", loadingMore: false };
}

function nextPageRequest(state: DraftPanelState, current: boolean, controller: AbortController | null, busy: boolean) {
  if (!current || !state.nextCursor || state.loadingMore || busy || !controller || controller.signal.aborted) return null;
  return { controller, cursor: state.nextCursor };
}

function withPageError(value: DraftPanelState, key: string, error: unknown): DraftPanelState {
  return value.key === key ? { ...value, error: messageOf(error, "读取更多草稿失败"), loadingMore: false } : value;
}

function visibleDraftPage(state: DraftPanelState, key: string) {
  if (state.key !== key) return { loading: true, busy: true, drafts: [], error: "", count: null, nextCursor: null, loadingMore: false };
  return { loading: false, busy: state.loadingMore, drafts: state.drafts, error: state.error, count: state.error ? null : state.total ?? state.drafts.length, nextCursor: state.nextCursor, loadingMore: state.loadingMore };
}

async function readLoadedDrafts(signal: AbortSignal, range: DraftRange, timezone: string, count: number) {
  let page = await readDrafts(signal, range, timezone);
  const drafts = new Map(page.drafts.map((source) => [source.id, source]));
  const cursors = new Set<string>();
  while (page.nextCursor && drafts.size < count && !cursors.has(page.nextCursor)) {
    cursors.add(page.nextCursor);
    page = await readDrafts(signal, range, timezone, page.nextCursor);
    for (const source of page.drafts) drafts.set(source.id, source);
  }
  return { ...page, drafts: [...drafts.values()] };
}

function useDraftBackgroundRefresh(count: number | null, range: DraftRange, timezone: string, key: string,
  setState: Dispatch<SetStateAction<DraftPanelState>>, loadingMore: RefObject<boolean>, controllerRef: RefObject<AbortController | null>) {
  const { from, to } = range;
  useEffect(() => {
    if (count === null) return;
    const poller = createSharedStatePoller({
      canRun: () => document.visibilityState !== "hidden",
      successDelayMs: 60_000,
      errorDelayMs: 60_000,
      onError: (error) => setState((value) => withPageError(value, key, error)),
      run: async (signal) => {
        if (loadingMore.current || controllerRef.current) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        try {
          const page = await readLoadedDrafts(AbortSignal.any([signal, controller.signal]), { from, to }, timezone, count);
          if (!controller.signal.aborted && !signal.aborted) setState((value) => value.key === key && !value.loadingMore ? { ...page, key, error: "", loadingMore: false } : value);
        } catch (error: unknown) {
          if (!controller.signal.aborted) throw error;
        } finally {
          if (controllerRef.current === controller) controllerRef.current = null;
        }
      },
    });
    const run = () => { void poller.wake(); };
    const timer = window.setTimeout(run, 60_000);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
      poller.stop();
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [count, from, to, timezone, key, setState, loadingMore, controllerRef]);
}

function useDraftPages(refreshKey: number, range: DraftRange, timezone: string) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<DraftPanelState>({ key: "", drafts: [], nextCursor: null, error: "", loadingMore: false });
  const controllerRef = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  const backgroundControllerRef = useRef<AbortController | null>(null);
  const { from, to } = range;
  const loadKey = `${refreshKey}:${refreshVersion}:${timezone}:${from}:${to}`;
  const current = state.key === loadKey;
  useDraftBackgroundRefresh(current ? state.drafts.length : null, range, timezone, loadKey, setState, loadingMoreRef, backgroundControllerRef);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    loadingMoreRef.current = false;
    void readDrafts(controller.signal, { from, to }, timezone).then((page) => {
      if (!controller.signal.aborted) setState({ ...page, key: loadKey, error: "", loadingMore: false });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ key: loadKey, drafts: [], nextCursor: null, error: messageOf(error, "读取机器人交接草稿失败"), loadingMore: false });
    });
    return () => controller.abort();
  }, [loadKey, from, to, timezone]);

  async function loadMore() {
    const request = nextPageRequest(state, current, controllerRef.current, loadingMoreRef.current);
    if (!request) return;
    backgroundControllerRef.current?.abort();
    backgroundControllerRef.current = null;
    const { controller, cursor } = request;
    loadingMoreRef.current = true;
    setState((value) => ({ ...value, error: "", loadingMore: true }));
    try {
      const page = await readDrafts(controller.signal, range, timezone, cursor);
      if (!controller.signal.aborted) setState((value) => appendDraftPage(value, page, loadKey));
    } catch (error: unknown) {
      if (!controller.signal.aborted) setState((value) => withPageError(value, loadKey, error));
    } finally {
      if (controllerRef.current === controller) loadingMoreRef.current = false;
    }
  }

  return { view: visibleDraftPage(state, loadKey), refresh: () => setRefreshVersion((value) => value + 1), loadMore };
}

function draftActionLabel(source: WecomLpDraftSource, blocked: boolean) {
  if (source.confirmed) return "已创建 LP";
  return blocked ? "暂不可创建" : "核对并创建 LP";
}

function handoverTime(source: WecomLpDraftSource) {
  const timestamp = source.handoverAt ?? source.messages.find((message) => message.messageId === source.sourceMessageId)?.sentAt;
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function draftName(source: WecomLpDraftSource) {
  return source.studentName || source.resolvedStudentName || source.wechatName || "待确认学生";
}

function DraftSchedule({ source }: { source: WecomLpDraftSource }) {
  if (source.trialSchedule) return <TrialScheduleDetails schedule={source.trialSchedule} />;
  const evidence = source.scheduleEvidence;
  if (evidence?.candidates.length) return <div style={{ display: "grid", gap: 8 }}>
    <small className="inline-meta">{evidence.status === "ambiguous" ? "课表匹配不唯一，待核对学生" : "候选课表，待核对学生"}</small>
    {evidence.candidates.map((candidate) => <div key={`${candidate.studentId}:${candidate.schedule.eventId}`}>
      <strong>{candidate.studentName}</strong>
      <TrialScheduleDetails schedule={candidate.schedule} />
    </div>)}
  </div>;
  return <TrialScheduleDetails pendingLabel={source.scheduleEvidenceUnavailable ? "上课时间：课表暂不可用" : "上课时间：待核对教务宝课表"} />;
}

function draftDetails(source: WecomLpDraftSource) {
  const fields = source.draft.fields;
  return [source.draft.workflowType, fieldText(fields.subject), fieldText(fields.assignedTeacher ?? fields.teacher ?? fields.newTeacher)].filter(Boolean).join(" · ") || "科目、老师待核对";
}

function DraftRow({ source, onSelect, timeDisplay }: Pick<WecomLpDraftsPanelProps, "onSelect" | "timeDisplay"> & { source: WecomLpDraftSource }) {
  const status = draftStatus(source);
  const sentAt = handoverTime(source);
  const name = draftName(source);
  const ownership = [source.operationsOwner ? `教务：${source.operationsOwner}` : "", source.coursePlanner ? `课程规划：${source.coursePlanner}` : ""].filter(Boolean);
  return <div className="collection-row" style={{ display: "flex", flexWrap: "wrap", gap: 12, minWidth: 0, cursor: "default", justifyContent: "space-between" }}>
    <div style={{ display: "grid", gap: 6, minWidth: 0, flex: "1 1 240px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}><strong style={{ overflowWrap: "anywhere" }}>{name}</strong><span className={`status-pill ${status.tone}`}>{status.label}</span></div>
      <span style={{ color: "var(--muted)", overflowWrap: "anywhere" }}>{draftDetails(source)}</span>
      {ownership.length > 0 && <small style={{ overflowWrap: "anywhere" }}>{ownership.join(" · ")}</small>}
      {(source.draft.workflowType === "试听 LP" || source.draft.workflowType === "换老师试听") && <DraftSchedule source={source} />}
      <small style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>交接时间：{sentAt ? <time dateTime={sentAt}>{timeDisplay.formatTime(sentAt)}</time> : "未记录"}</small>
    </div>
    <button className="primary-button" type="button" disabled={status.blocked} aria-label={`${name} ${source.confirmed ? "已创建 LP" : "核对并创建 LP"}`} onClick={() => onSelect(source)}>{draftActionLabel(source, status.blocked)}</button>
  </div>;
}

function DraftPanelBody({ loading, drafts, error, onSelect, timeDisplay }: Pick<WecomLpDraftsPanelProps, "onSelect" | "timeDisplay"> & { loading: boolean; drafts: WecomLpDraftSource[]; error: string }) {
  if (loading) return <div className="collection-empty" role="status"><strong>正在读取机器人交接草稿…</strong></div>;
  if (drafts.length) return <div>{drafts.map((source) => <DraftRow key={source.id} source={source} onSelect={onSelect} timeDisplay={timeDisplay} />)}</div>;
  if (error) return null;
  return <div className="collection-empty" role="status"><strong>暂无符合条件的机器人交接记录</strong></div>;
}

function DraftPanelFooter({ cursor, loading, loadMore }: { cursor: string | null; loading: boolean; loadMore: () => Promise<void> }) {
  if (!cursor) return null;
  return <footer style={{ display: "flex", justifyContent: "center", padding: 16 }}><button className="secondary-button" type="button" disabled={loading} onClick={() => { void loadMore(); }}>{loading ? "读取中…" : "加载更多"}</button></footer>;
}

function DraftRangeFilter({ range, onApply, timeDisplay }: { range: DraftRange; onApply: (range: DraftRange) => void; timeDisplay: HandoverTimeDisplay }) {
  const [dates, setDates] = useState(range);
  const [error, setError] = useState("");
  const errorId = useId();
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (dates.from && dates.to && dates.from > dates.to) { setError("开始日期不能晚于结束日期"); return; }
    setError("");
    onApply(dates);
  }
  function clear() {
    const empty = { from: "", to: "" };
    setDates(empty);
    setError("");
    onApply(empty);
  }
  return <form className="form-grid" aria-label="交接时间筛选" onSubmit={apply} style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 12, margin: 16, paddingTop: 0 }}>
    <label style={{ flex: "1 1 160px" }}>开始日期<input type="datetime-local" value={dates.from} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} onChange={(event) => { setDates((value) => ({ ...value, from: event.target.value })); setError(""); }} /></label>
    <label style={{ flex: "1 1 160px" }}>结束日期<input type="datetime-local" value={dates.to} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} onChange={(event) => { setDates((value) => ({ ...value, to: event.target.value })); setError(""); }} /></label>
    <button className="primary-button" type="submit">筛选</button>
    <button className="secondary-button" type="button" onClick={clear}>清除</button>
    <small style={{ color: "var(--muted)", flexBasis: "100%" }}>时区：{timeDisplay.label}（{timeDisplay.timezone}）</small>
    {error && <p className="form-error" role="alert" id={errorId} style={{ margin: 0, flexBasis: "100%" }}>{error}</p>}
  </form>;
}

export function WecomLpDraftsPanel({ onSelect, refreshKey, timeDisplay, range, onRangeChange }: WecomLpDraftsPanelProps) {
  const headingId = useId();
  const { view, refresh, loadMore } = useDraftPages(refreshKey, range, timeDisplay.timezone);

  return <section className="panel collection-shell" aria-labelledby={headingId} aria-busy={view.busy}>
    <header className="panel-header" style={{ gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 id={headingId}>机器人交接草稿</h2>
        {view.count !== null && <span className="status-pill neutral">{view.count} 条</span>}
      </div>
      <button className="secondary-button" type="button" disabled={view.busy} onClick={refresh}><RefreshCw size={16} aria-hidden="true" />刷新</button>
    </header>
    <DraftRangeFilter key={`${range.from}:${range.to}`} range={range} timeDisplay={timeDisplay} onApply={(value) => { onRangeChange(value); refresh(); }} />
    {view.error && <p className="form-error" role="alert" style={{ margin: 16 }}>{view.error}</p>}
    <DraftPanelBody loading={view.loading} drafts={view.drafts} error={view.error} onSelect={onSelect} timeDisplay={timeDisplay} />
    <DraftPanelFooter cursor={view.nextCursor} loading={view.loadingMore} loadMore={loadMore} />
  </section>;
}
