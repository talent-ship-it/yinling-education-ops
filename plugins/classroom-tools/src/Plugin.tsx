import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BbbPluginSdk, FloatingWindow, PresentationToolbarButton, type PluginApi } from "bigbluebutton-html-plugin-sdk";
import { NativeTimerController, TIMER_MUTATIONS, changeTimerDigit, secondsFromDigits, timerDigits, type TimerAction, type TimerVariables, type TimerProgress } from "./timer";
import { boardFilename, captureBoard, downloadBoard, whiteBackgroundPng } from "./snapshot";
import { styles } from "./styles";

type Panel = "board" | "timer" | null;
function useNativeMutations(api: PluginApi) {
  const activate = api.useCustomMutation?.<TimerVariables>(TIMER_MUTATIONS.activate);
  const stop = api.useCustomMutation?.(TIMER_MUTATIONS.stop);
  const mode = api.useCustomMutation?.<TimerVariables>(TIMER_MUTATIONS.mode);
  const time = api.useCustomMutation?.<TimerVariables>(TIMER_MUTATIONS.time);
  const reset = api.useCustomMutation?.(TIMER_MUTATIONS.reset);
  const start = api.useCustomMutation?.(TIMER_MUTATIONS.start);
  const deactivate = api.useCustomMutation?.(TIMER_MUTATIONS.deactivate);
  return { activate, stop, mode, time, reset, start, deactivate };
}

export function ClassroomTools({ api }: { api: PluginApi }) {
  const currentUser = api.useCurrentUser?.();
  const timer = api.useTimer?.();
  const unmount = api.useShouldUnmountPlugin?.() ?? false;
  const mutations = useNativeMutations(api);
  const [panel, setPanel] = useState<Panel>(null);
  const [timerHidden, setTimerHidden] = useState(false);
  const [digits, setDigits] = useState("0500");
  const [configurationChanged, setConfigurationChanged] = useState(false);
  const [filename, setFilename] = useState(() => `课堂板书_${new Date().toISOString().slice(0, 10)}`);
  const [snapshot, setSnapshot] = useState<{ blob: Blob; url: string } | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [boardError, setBoardError] = useState("");
  const [progress, setProgress] = useState<TimerProgress>({ busy: false, error: "" });
  const panelRef = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const moderator = currentUser?.data?.role.toUpperCase() === "MODERATOR";
  const presenter = currentUser?.data?.presenter === true;
  const canCapture = (moderator || presenter) && Boolean(api.getUiData);
  const timerReady = Boolean(timer?.data && !timer.loading && !timer.error && Object.values(mutations).every((mutation) => mutation?.[0]));
  const canControl = moderator && timerReady && !unmount;
  const controller = useMemo(() => new NativeTimerController(() => {
    throw new Error("当前课堂不支持同步倒计时。");
  }, (next) => setProgress((old) => old.busy === next.busy && old.error === next.error ? old : next)), []);
  const native = timer?.data;
  const [previousActive, setPreviousActive] = useState(Boolean(native?.active));
  if (Boolean(native?.active) !== previousActive) {
    setPreviousActive(Boolean(native?.active));
    if (native?.active) setTimerHidden(false);
  }
  useEffect(() => {
    controller.setSender((action: TimerAction, variables: TimerVariables) => {
      const trigger = mutations[action]?.[0];
      if (!trigger) throw new Error("当前课堂不支持同步倒计时。");
      trigger({ variables });
    });
  });
  useEffect(() => {
    if (native) controller.observe(native);
  }, [controller, native]);
  const mutationError = Object.values(mutations).some((mutation) => (mutation?.[1] as { error?: unknown } | null)?.error);
  useEffect(() => { if (mutationError) controller.fail("课堂未接受计时操作，请检查权限或连接后重试。"); }, [controller, mutationError]);
  useEffect(() => { if (!moderator || unmount) controller.fail("当前账号不能控制课堂计时。"); }, [controller, moderator, unmount]);
  useEffect(() => () => { mounted.current = false; sequence.current += 1; controller.dispose(); }, [controller]);
  useEffect(() => () => { if (snapshot) URL.revokeObjectURL(snapshot.url); }, [snapshot]);
  const openBoard = useCallback(async () => {
    const request = ++sequence.current;
    setPanel("board"); setBoardError(""); setSnapshot(null); setCaptureBusy(true);
    try {
      const source = await captureBoard(api);
      const blob = await whiteBackgroundPng(source);
      if (!mounted.current || sequence.current !== request) return;
      setSnapshot({ blob, url: URL.createObjectURL(blob) });
    } catch (error) {
      if (mounted.current && sequence.current === request) setBoardError(error instanceof Error ? error.message : "板书保存失败，请重试。");
    } finally {
      if (mounted.current && sequence.current === request) setCaptureBusy(false);
    }
  }, [api]);
  const openTimer = useCallback(() => { setPanel("timer"); setTimerHidden(false); }, []);
  useEffect(() => {
    if (unmount) { api.setPresentationToolbarItems([]); return; }
    api.setPresentationToolbarItems([
      ...(moderator || presenter ? [new PresentationToolbarButton({ id: "insider-save-board", label: "保存板书", tooltip: "保存当前页板书为 PNG", dataTest: "insider-save-board", onClick: () => void openBoard() })] : []),
      new PresentationToolbarButton({ id: "insider-classroom-timer", label: "倒计时", tooltip: "课堂倒计时", dataTest: "insider-classroom-timer", onClick: openTimer }),
    ]);
    return () => { api.setPresentationToolbarItems([]); };
  }, [api, moderator, presenter, unmount, openBoard, openTimer]);
  const shownPanel: Panel = panel ?? (native?.active && !native.stopwatch && !timerHidden ? "timer" : null);
  const close = useCallback(() => { sequence.current += 1; setPanel(null); setTimerHidden(true); setCaptureBusy(false); }, []);
  useEffect(() => {
    if (!shownPanel) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("input,button:not(:disabled)")?.focus());
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus(); };
  }, [shownPanel]);
  const runTimer = (operation: () => void) => {
    if (!canControl || progress.busy) return;
    try { operation(); }
    catch (error) { setProgress({ busy: false, error: error instanceof Error ? error.message : "计时操作失败。" }); }
  };
  const configuredDigits = !configurationChanged && native?.active && !native.stopwatch ? timerDigits(native.time) : digits;
  const startOrPause = () => {
    if (native?.running) runTimer(() => controller.pause());
    else if (native?.active && !native.stopwatch && !native.elapsed && native.accumulated > 0 && !configurationChanged) runTimer(() => controller.resume());
    else runTimer(() => { controller.startCountdown(secondsFromDigits(configuredDigits)); setConfigurationChanged(false); });
  };
  const shownDigits = native?.active && !native.stopwatch && (native.running || !configurationChanged && (native.accumulated > 0 || native.elapsed)) ? timerDigits(native.timePassed) : configuredDigits;
  const disabled = !canControl || progress.busy || Boolean(native?.running);
  if (unmount) return null;
  return <div className="ilct"><style>{styles}</style>{shownPanel && <div ref={panelRef} className="ilct-panel" role="dialog" aria-label={shownPanel === "board" ? "保存板书" : "倒计时"}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)") ?? []);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="ilct-header"><span>{shownPanel === "board" ? "保存板书" : "倒计时"}</span><button className="ilct-close" aria-label="关闭面板" onClick={close}>×</button></div>
    <div className="ilct-body">{shownPanel === "board" ? <>
      <label className="ilct-label" htmlFor="ilct-filename">文件名</label><input id="ilct-filename" value={filename} maxLength={120} disabled={captureBusy || !canCapture} onChange={(event) => setFilename(event.target.value)} />
      {snapshot && <img className="ilct-preview" src={snapshot.url} alt="当前页板书预览" />}
      {captureBusy && <p className="ilct-status" role="status">正在读取当前页板书…</p>}
      <div className="ilct-filetype"><span className="ilct-filetype-mark" aria-hidden="true">✓</span> PNG 图片</div>
      {boardError && <p className="ilct-error" role="alert">{boardError}</p>}{!canCapture && <p className="ilct-error" role="status">当前账号或课堂不支持保存板书。</p>}
      <div className="ilct-footer"><button className="ilct-secondary" onClick={close}>取消</button><button className="ilct-primary" disabled={!snapshot || captureBusy || !canCapture} onClick={() => { if (snapshot) { downloadBoard(snapshot.blob, boardFilename(filename)); close(); } }}>保存当前页</button></div>
    </> : <>
      {moderator ? <div className="ilct-digits" aria-label="倒计时时长">{shownDigits.split("").map((digit, index) => <React.Fragment key={index}>
        {index === 2 && <span className="ilct-colon" aria-hidden="true">:</span>}<div className="ilct-digit">
          <button className="ilct-arrow" aria-label={`增加${index < 2 ? "分钟" : "秒"}${index % 2 === 0 ? "十位" : "个位"}`} disabled={disabled} onClick={() => { setDigits(changeTimerDigit(shownDigits, index, 1)); setConfigurationChanged(true); }}>▲</button><output aria-live="off">{digit}</output>
          <button className="ilct-arrow" aria-label={`减少${index < 2 ? "分钟" : "秒"}${index % 2 === 0 ? "十位" : "个位"}`} disabled={disabled} onClick={() => { setDigits(changeTimerDigit(shownDigits, index, -1)); setConfigurationChanged(true); }}>▼</button>
        </div></React.Fragment>)}</div> : <div className="ilct-readonly" aria-label="课堂剩余时间">{shownDigits.slice(0, 2)}:{shownDigits.slice(2)}</div>}
      {!moderator && <p className="ilct-caption">由老师控制</p>}{native?.elapsed && <p className="ilct-caption" role="status">时间到</p>}
      {!timerReady && <p className="ilct-error" role="status">{timer?.loading ? "正在读取课堂计时状态…" : "当前课堂不支持同步倒计时。"}</p>}{progress.error && <p className="ilct-error" role="alert">{progress.error}</p>}
      {moderator && <><div className="ilct-timer-actions"><button className="ilct-primary" disabled={!canControl || progress.busy || (!native?.running && secondsFromDigits(configuredDigits) === 0)} onClick={startOrPause}>{progress.busy ? "正在同步…" : native?.running ? "暂停" : native?.accumulated && !native?.elapsed && !configurationChanged ? "继续" : "开始"}</button><button className="ilct-secondary" disabled={!canControl || progress.busy || !native?.active} onClick={() => runTimer(() => { controller.reset(); setConfigurationChanged(false); })}>重置</button></div>{native?.active && <button className="ilct-off" disabled={!canControl || progress.busy} onClick={() => runTimer(() => controller.deactivate())}>关闭计时器</button>}</>}
    </>}</div>
  </div>}</div>;
}

export default function Plugin({ uuid }: { uuid: string }) {
  const api = BbbPluginSdk.getPluginApi(uuid);
  BbbPluginSdk.initialize(uuid);
  useEffect(() => {
    api.setFloatingWindows([new FloatingWindow({ id: "insider-classroom-tools", top: 76, left: 20, movable: true, backgroundColor: "transparent", boxShadow: "none", zIndex: 100,
      contentFunction: (element) => { const root = createRoot(element); root.render(<ClassroomTools api={api} />); return root; },
    })]);
    return () => api.setFloatingWindows([]);
  }, [api]);
  return null;
}
