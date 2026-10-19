import React, { useEffect, useState } from "react";
import type { PluginApi } from "bigbluebutton-html-plugin-sdk";
import { boardFilename, captureBoard, downloadBoard, whiteBackgroundPng } from "./snapshot";
import { ToolDialog } from "./ToolDialog";

function useBoardSnapshot(api: PluginApi) {
  const [snapshot, setSnapshot] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    let url: string | undefined;
    void captureBoard(api).then(whiteBackgroundPng).then((blob) => {
      if (!mounted) return;
      url = URL.createObjectURL(blob);
      setSnapshot({ blob, url });
    }).catch((reason: unknown) => {
      if (mounted) setError(reason instanceof Error ? reason.message : "板书保存失败，请重试。");
    }).finally(() => { if (mounted) setBusy(false); });
    return () => { mounted = false; if (url) URL.revokeObjectURL(url); };
  }, [api]);
  return { snapshot, busy, error };
}

export function BoardExportDialog({ api, canCapture, close }: { api: PluginApi; canCapture: boolean; close: () => void }) {
  const [filename, setFilename] = useState(() => `课堂板书_${new Date().toISOString().slice(0, 10)}`);
  const { snapshot, busy, error } = useBoardSnapshot(api);
  const onFilenameChange = (event: React.ChangeEvent<HTMLInputElement>) => setFilename(event.currentTarget.value);
  const save = () => { if (snapshot && canCapture) { downloadBoard(snapshot.blob, boardFilename(filename)); close(); } };
  return <ToolDialog title="保存板书" close={close}>
    <label className="ilct-label" htmlFor="ilct-filename">文件名</label>
    <input id="ilct-filename" value={filename} maxLength={120} disabled={busy || !canCapture} onChange={onFilenameChange} />
    {snapshot && <img className="ilct-preview" src={snapshot.url} alt="当前页板书预览" />}
    {busy && <p className="ilct-status" role="status">正在读取当前页板书…</p>}
    <div className="ilct-filetype"><span className="ilct-filetype-mark" aria-hidden="true">✓</span> PNG 图片</div>
    {error && <p className="ilct-error" role="alert">{error}</p>}
    {!canCapture && <p className="ilct-error" role="status">当前账号或课堂不支持保存板书。</p>}
    <div className="ilct-footer"><button className="ilct-secondary" onClick={close}>取消</button>
      <button className="ilct-primary" disabled={!snapshot || busy || !canCapture} onClick={save}>保存当前页</button></div>
  </ToolDialog>;
}
