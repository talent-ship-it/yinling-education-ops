import { useEffect, useMemo, useState } from "react";
import type { PluginApi } from "bigbluebutton-html-plugin-sdk";
import { NativeTimerController, TIMER_MUTATIONS, type TimerVariables, type TimerProgress } from "./timer";

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

export function useCountdown(api: PluginApi, moderator: boolean, unmount: boolean) {
  const timer = api.useTimer?.();
  const mutations = useNativeMutations(api);
  const [progress, setProgress] = useState<TimerProgress>({ busy: false, error: "" });
  const controller = useMemo(() => new NativeTimerController(() => {
    throw new Error("当前课堂不支持同步倒计时。");
  }, (next) => setProgress((old) => old.busy === next.busy && old.error === next.error ? old : next)), []);
  useEffect(() => {
    controller.setSender((action, variables) => {
      const trigger = mutations[action]?.[0];
      if (!trigger) throw new Error("当前课堂不支持同步倒计时。");
      trigger({ variables });
    });
  });
  useEffect(() => { if (timer?.data) controller.observe(timer.data); }, [controller, timer?.data]);
  const mutationError = Object.values(mutations).some((mutation) => (mutation?.[1] as { error?: unknown } | null)?.error);
  useEffect(() => { if (mutationError) controller.fail("课堂未接受计时操作，请检查权限或连接后重试。"); }, [controller, mutationError]);
  useEffect(() => { if (!moderator || unmount) controller.fail("当前账号不能控制课堂计时。"); }, [controller, moderator, unmount]);
  useEffect(() => () => controller.dispose(), [controller]);
  const ready = Boolean(timer?.data && !timer.loading && !timer.error && Object.values(mutations).every((mutation) => mutation?.[0]));
  const canControl = moderator && ready && !unmount;
  const run = (operation: () => void) => {
    if (!canControl || progress.busy) return;
    try { operation(); }
    catch (error) { setProgress({ busy: false, error: error instanceof Error ? error.message : "计时操作失败。" }); }
  };
  return { native: timer?.data, loading: timer?.loading, ready, canControl, progress, controller, run };
}
export type Countdown = ReturnType<typeof useCountdown>;
