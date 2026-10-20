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

export function WecomLpDraftsPanel({ onSelect, refreshKey }: WecomLpDraftsPanelProps) {
  const headingId = useId();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [state, setState] = useState<DraftPanelState>({ key: "", drafts: [], nextCursor: null, error: "", loadingMore: false });
  const controllerRef = useRef<AbortController | null>(null);
  const loadingMoreRef = useRef(false);
  const loadKey = `${refreshKey}:${refreshVersion}`;
  const current = state.key === loadKey;
  const loading = !current;
  const drafts = current ? state.drafts : [];
  const error = current ? state.error : "";

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    loadingMoreRef.current = false;
    void readDrafts(controller.signal).then((page) => {
      if (!controller.signal.aborted) setState({ ...page, key: loadKey, error: "", loadingMore: false });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ key: loadKey, drafts: [], nextCursor: null, error: error instanceof Error ? error.message : "读取机器人交接草稿失败", loadingMore: false });
    });
    return () => controller.abort();
  }, [loadKey]);

  async function loadMore() {
    const controller = controllerRef.current;
    if (!current || !state.nextCursor || state.loadingMore || loadingMoreRef.current || !controller || controller.signal.aborted) return;
    loadingMoreRef.current = true;
    setState((value) => ({ ...value, error: "", loadingMore: true }));
    try {
      const page = await readDrafts(controller.signal, state.nextCursor);
      if (!controller.signal.aborted) setState((value) => {
        if (value.key !== loadKey) return value;
        const sources = new Map(value.drafts.map((source) => [source.id, source]));
        for (const source of page.drafts) sources.set(source.id, source);
        return { ...page, total: page.total ?? value.total, key: loadKey, drafts: [...sources.values()], error: "", loadingMore: false };
      });
    } catch (error: unknown) {
      if (!controller.signal.aborted) setState((value) => value.key === loadKey ? { ...value, error: error instanceof Error ? error.message : "读取更多草稿失败", loadingMore: false } : value);
    } finally {
      if (controllerRef.current === controller) loadingMoreRef.current = false;
    }
  }

  return <section className="panel collection-shell" aria-labelledby={headingId} aria-busy={loading || (current && state.loadingMore)}>
    <header className="panel-header" style={{ gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 id={headingId}>机器人交接草稿</h2>
        {!loading && !error && <span className="status-pill neutral">{state.total ?? drafts.length} 条</span>}
      </div>
      <button className="secondary-button" type="button" disabled={loading || (current && state.loadingMore)} onClick={() => setRefreshVersion((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" />刷新</button>
    </header>
    {error && <p className="form-error" role="alert" style={{ margin: 16 }}>{error}</p>}
    {loading ? <div className="collection-empty" role="status"><strong>正在读取机器人交接草稿…</strong></div> : drafts.length ? <div>
      {drafts.map((source) => {
        const status = draftStatus(source);
        const name = source.studentName || source.wechatName || "待确认学生";
        const details = [fieldText(source.draft.fields.subject), fieldText(source.draft.fields.assignedTeacher)].filter(Boolean);
        const ownership = [source.operationsOwner ? `教务：${source.operationsOwner}` : "", source.coursePlanner ? `课程规划：${source.coursePlanner}` : ""].filter(Boolean);
        return <div className="collection-row" key={source.id} style={{ display: "flex", flexWrap: "wrap", gap: 12, minWidth: 0, cursor: "default", justifyContent: "space-between" }}>
          <div style={{ display: "grid", gap: 6, minWidth: 0, flex: "1 1 240px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}><strong style={{ overflowWrap: "anywhere" }}>{name}</strong><span className={`status-pill ${status.tone}`}>{status.label}</span></div>
            <span style={{ color: "var(--muted)", overflowWrap: "anywhere" }}>{details.join(" · ") || "科目、老师待核对"}</span>
            {ownership.length > 0 && <small style={{ overflowWrap: "anywhere" }}>{ownership.join(" · ")}</small>}
          </div>
          <button className="primary-button" type="button" disabled={status.blocked} aria-label={`${name} ${source.confirmed ? "已创建 LP" : "核对并创建 LP"}`} onClick={() => onSelect(source)}>{source.confirmed ? "已创建 LP" : status.blocked ? "暂不可创建" : "核对并创建 LP"}</button>
        </div>;
      })}
    </div> : !error ? <div className="collection-empty" role="status"><strong>暂无待核对的机器人交接草稿</strong></div> : null}
    {current && state.nextCursor && <footer style={{ display: "flex", justifyContent: "center", padding: 16 }}><button className="secondary-button" type="button" disabled={state.loadingMore} onClick={() => { void loadMore(); }}>{state.loadingMore ? "读取中…" : "加载更多"}</button></footer>}
  </section>;
}
