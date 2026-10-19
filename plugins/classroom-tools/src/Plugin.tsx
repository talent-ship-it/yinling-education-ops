import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BbbPluginSdk, FloatingWindow, PresentationToolbarButton, type PluginApi } from "bigbluebutton-html-plugin-sdk";
import { BoardExportDialog } from "./BoardExportDialog";
import { CountdownPanel } from "./CountdownPanel";
import { useCountdown } from "./useCountdown";
import { FocusNotice, useClassroomFocus } from "./useClassroomFocus";
import { styles } from "./styles";

type Panel = "board" | "timer" | null;
type ToolbarOptions = { api: PluginApi; canCapture: boolean; unmount: boolean; fullscreen: boolean; openBoard: () => void; openTimer: () => void; toggleFullscreen: () => Promise<void> };
function useClassroomToolbar({ api, canCapture, unmount, fullscreen, openBoard, openTimer, toggleFullscreen }: ToolbarOptions) {
  useEffect(() => {
    if (unmount) { api.setPresentationToolbarItems([]); return; }
    const items = [
      new PresentationToolbarButton({ id: "insider-classroom-timer", label: "倒计时", tooltip: "课堂倒计时", dataTest: "insider-classroom-timer", onClick: openTimer }),
      new PresentationToolbarButton({ id: "insider-classroom-fullscreen", label: fullscreen ? "退出全屏" : "全屏课堂", tooltip: fullscreen ? "退出全屏" : "全屏课堂", dataTest: "insider-classroom-fullscreen", onClick: () => void toggleFullscreen() }),
    ];
    if (canCapture) items.unshift(new PresentationToolbarButton({ id: "insider-save-board", label: "保存板书", tooltip: "保存当前页板书为 PNG", dataTest: "insider-save-board", onClick: openBoard }));
    api.setPresentationToolbarItems(items);
    return () => { api.setPresentationToolbarItems([]); };
  }, [api, canCapture, unmount, fullscreen, openBoard, openTimer, toggleFullscreen]);
}

function useClassroomIdentity(api: PluginApi) {
  const current = api.useCurrentUser?.()?.data;
  const role = current?.role.toUpperCase();
  const moderator = role === "MODERATOR";
  const canCapture = Boolean((moderator || current?.presenter) && api.getUiData);
  return { role, moderator, canCapture };
}

function useToolPanels(active: boolean, stopwatch: boolean) {
  const [panel, setPanel] = useState<Panel>(null);
  const [boardRequest, setBoardRequest] = useState(0);
  const [timerHidden, setTimerHidden] = useState(false);
  const [previousActive, setPreviousActive] = useState(active);
  if (active !== previousActive) {
    setPreviousActive(active);
    if (active) setTimerHidden(false);
  }
  const openBoard = useCallback(() => { setBoardRequest((value) => value + 1); setPanel("board"); }, []);
  const openTimer = useCallback(() => { setPanel("timer"); setTimerHidden(false); }, []);
  const close = useCallback(() => { setPanel(null); setTimerHidden(true); }, []);
  const automaticTimer = active && !stopwatch && !timerHidden;
  return { boardRequest, openBoard, openTimer, close, shown: panel ?? (automaticTimer ? "timer" : null) };
}

export function ClassroomTools({ api }: { api: PluginApi }) {
  const { role, moderator, canCapture } = useClassroomIdentity(api);
  const unmount = api.useShouldUnmountPlugin?.() ?? false;
  const countdown = useCountdown(api, moderator, unmount);
  const focus = useClassroomFocus(api, role, unmount);
  const panels = useToolPanels(Boolean(countdown.native?.active), Boolean(countdown.native?.stopwatch));
  useClassroomToolbar({ api, canCapture, unmount, fullscreen: focus.fullscreen, openBoard: panels.openBoard, openTimer: panels.openTimer, toggleFullscreen: focus.toggle });
  if (unmount) return null;
  return <div className="ilct"><style>{styles}</style>
    {panels.shown === "board" && <BoardExportDialog key={panels.boardRequest} api={api} canCapture={canCapture} close={panels.close} />}
    <CountdownPanel countdown={countdown} moderator={moderator} visible={panels.shown === "timer"} close={panels.close} />
    <FocusNotice focus={focus} />
  </div>;
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
