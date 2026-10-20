"use client";

import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import type { WecomLpDraftSource } from "@/lib/wecom-lp-intake";

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

type WecomLpDraftsPanelProps = Readonly<{
  onSelect: (source: WecomLpDraftSource) => void;
  refreshKey: number;
}>;

async function readDrafts(signal: AbortSignal, cursor?: string | null): Promise<DraftPage> {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  const response = await fetch(`/api/operations/wecom-lp-drafts${query}`, { cache: "no-store", signal });
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
    case "awaiting_student_name": return { label: "待补学生姓名", tone: "amber", blocked: false };
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

function useDraftPages(refreshKey: number) {
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<DraftPanelState>({ key: "", drafts: [], nextCursor: null, error: "", loadingMore: false });
  const controllerRef = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  const loadKey = `${refreshKey}:${refreshVersion}`;
  const current = state.key === loadKey;

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    loadingMoreRef.current = false;
    void readDrafts(controller.signal).then((page) => {
      if (!controller.signal.aborted) setState({ ...page, key: loadKey, error: "", loadingMore: false });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ key: loadKey, drafts: [], nextCursor: null, error: messageOf(error, "读取机器人交接草稿失败"), loadingMore: false });
    });
    return () => controller.abort();
  }, [loadKey]);

  async function loadMore() {
    const request = nextPageRequest(state, current, controllerRef.current, loadingMoreRef.current);
    if (!request) return;
    const { controller, cursor } = request;
    loadingMoreRef.current = true;
    setState((value) => ({ ...value, error: "", loadingMore: true }));
    try {
      const page = await readDrafts(controller.signal, cursor);
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

function DraftRow({ source, onSelect }: Pick<WecomLpDraftsPanelProps, "onSelect"> & { source: WecomLpDraftSource }) {
  const status = draftStatus(source);
  const name = source.studentName || source.wechatName || "待确认学生";
  const details = [fieldText(source.draft.fields.subject), fieldText(source.draft.fields.assignedTeacher)].filter(Boolean);
  const ownership = [source.operationsOwner ? `教务：${source.operationsOwner}` : "", source.coursePlanner ? `课程规划：${source.coursePlanner}` : ""].filter(Boolean);
  return <div className="collection-row" style={{ display: "flex", flexWrap: "wrap", gap: 12, minWidth: 0, cursor: "default", justifyContent: "space-between" }}>
    <div style={{ display: "grid", gap: 6, minWidth: 0, flex: "1 1 240px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}><strong style={{ overflowWrap: "anywhere" }}>{name}</strong><span className={`status-pill ${status.tone}`}>{status.label}</span></div>
      <span style={{ color: "var(--muted)", overflowWrap: "anywhere" }}>{details.join(" · ") || "科目、老师待核对"}</span>
      {ownership.length > 0 && <small style={{ overflowWrap: "anywhere" }}>{ownership.join(" · ")}</small>}
    </div>
    <button className="primary-button" type="button" disabled={status.blocked} aria-label={`${name} ${source.confirmed ? "已创建 LP" : "核对并创建 LP"}`} onClick={() => onSelect(source)}>{draftActionLabel(source, status.blocked)}</button>
  </div>;
}

function DraftPanelBody({ loading, drafts, error, onSelect }: Pick<WecomLpDraftsPanelProps, "onSelect"> & { loading: boolean; drafts: WecomLpDraftSource[]; error: string }) {
  if (loading) return <div className="collection-empty" role="status"><strong>正在读取机器人交接草稿…</strong></div>;
  if (drafts.length) return <div>{drafts.map((source) => <DraftRow key={source.id} source={source} onSelect={onSelect} />)}</div>;
  if (error) return null;
  return <div className="collection-empty" role="status"><strong>暂无待核对的机器人交接草稿</strong></div>;
}

function DraftPanelFooter({ cursor, loading, loadMore }: { cursor: string | null; loading: boolean; loadMore: () => Promise<void> }) {
  if (!cursor) return null;
  return <footer style={{ display: "flex", justifyContent: "center", padding: 16 }}><button className="secondary-button" type="button" disabled={loading} onClick={() => { void loadMore(); }}>{loading ? "读取中…" : "加载更多"}</button></footer>;
}

export function WecomLpDraftsPanel({ onSelect, refreshKey }: WecomLpDraftsPanelProps) {
  const headingId = useId();
  const { view, refresh, loadMore } = useDraftPages(refreshKey);

  return <section className="panel collection-shell" aria-labelledby={headingId} aria-busy={view.busy}>
    <header className="panel-header" style={{ gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 id={headingId}>机器人交接草稿</h2>
        {view.count !== null && <span className="status-pill neutral">{view.count} 条</span>}
      </div>
      <button className="secondary-button" type="button" disabled={view.busy} onClick={refresh}><RefreshCw size={16} aria-hidden="true" />刷新</button>
    </header>
    {view.error && <p className="form-error" role="alert" style={{ margin: 16 }}>{view.error}</p>}
    <DraftPanelBody loading={view.loading} drafts={view.drafts} error={view.error} onSelect={onSelect} />
    <DraftPanelFooter cursor={view.nextCursor} loading={view.loadingMore} loadMore={loadMore} />
  </section>;
}
