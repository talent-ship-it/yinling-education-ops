import React, { useCallback, useEffect, useRef, useState } from "react";
import { DataChannelTypes, DataChannelPushEntryFunctionUserRole, type DataChannelEntryResponseType, type PluginApi, type UsersBasicInfoData } from "bigbluebutton-html-plugin-sdk";
import { FOCUS_CHANNEL, VisibilityReporter, isVisibilityReport, toggleClassroomFullscreen, type VisibilityReport } from "./focus";

function latestFocusNotice(entries: DataChannelEntryResponseType<VisibilityReport>[], users: UsersBasicInfoData[]) {
  const ordered = [...entries].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  for (const entry of ordered) {
    if (!isVisibilityReport(entry.payloadJson)) continue;
    const user = users.find((candidate) => candidate.userId === entry.createdBy && !candidate.isModerator);
    if (user) return { id: entry.entryId, message: `${user.name}${entry.payloadJson.state === "hidden" ? "切换出了课堂页面" : "已返回课堂页面"}` };
  }
  return null;
}

function useStudentVisibility(api: PluginApi, enabled: boolean, returned: () => void, failed: () => void) {
  const channel = api.useDataChannel?.<VisibilityReport>(FOCUS_CHANNEL, DataChannelTypes.NEW_ITEMS);
  const channelRef = useRef(channel);
  useEffect(() => { channelRef.current = channel; }, [channel]);
  useEffect(() => {
    if (!enabled) return;
    const reporter = new VisibilityReporter((report) => {
      const current = channelRef.current;
      if (!current?.pushEntry || current.data.error) { failed(); return; }
      try { current.pushEntry(report, { receivers: [{ role: DataChannelPushEntryFunctionUserRole.MODERATOR }] }); }
      catch { failed(); }
    }, returned);
    const changed = () => reporter.observe(document.hidden || !document.hasFocus(), Date.now());
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("blur", changed);
    window.addEventListener("focus", changed);
    changed();
    return () => {
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("blur", changed);
      window.removeEventListener("focus", changed);
    };
  }, [enabled, returned, failed]);
  return channel;
}

function useFullscreen() {
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [error, setError] = useState("");
  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const toggle = useCallback(async () => {
    setError("");
    try { await toggleClassroomFullscreen(document); }
    catch (reason) { setError(reason instanceof Error && reason.message.includes("不支持") ? reason.message : "未能进入或退出全屏，请允许浏览器全屏后重试。"); }
  }, []);
  return { fullscreen, error, setError, toggle };
}

export function useClassroomFocus(api: PluginApi, role: string | undefined, unmount: boolean) {
  const fullscreen = useFullscreen();
  const [message, setMessage] = useState("");
  const returned = useCallback(() => setMessage("已返回课堂，请继续专注上课。"), []);
  const { setError } = fullscreen;
  const failed = useCallback(() => setError("切屏提醒未能同步给老师。"), [setError]);
  const channel = useStudentVisibility(api, role === "VIEWER" && !unmount, returned, failed);
  const users = api.useUsersBasicInfo?.();
  const lastEntry = useRef("");
  useEffect(() => {
    if (role !== "MODERATOR" || unmount || !channel?.data.data || !users?.data) return;
    const notice = latestFocusNotice(channel.data.data, users.data.user);
    if (notice && notice.id !== lastEntry.current) { lastEntry.current = notice.id; setMessage(notice.message); }
  }, [role, unmount, channel?.data.data, users?.data]);
  const dismiss = () => { setMessage(""); fullscreen.setError(""); };
  return { ...fullscreen, message, dismiss };
}

export function FocusNotice({ focus }: { focus: ReturnType<typeof useClassroomFocus> }) {
  if (!focus.message && !focus.error) return null;
  return <div className="ilct-focus-notice" role={focus.error ? "alert" : "status"}>
    <button className="ilct-close" aria-label="关闭提醒" onClick={focus.dismiss}>×</button>
    <p>{focus.error || focus.message}</p>
    {!focus.fullscreen && <button className="ilct-primary" onClick={() => void focus.toggle()}>全屏课堂</button>}
  </div>;
}
