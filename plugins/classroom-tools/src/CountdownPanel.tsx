import React, { useState } from "react";
import { changeTimerDigit, secondsFromDigits, timerDigits } from "./timer";
import type { Countdown } from "./useCountdown";
import { ToolDialog } from "./ToolDialog";

function countdownDigits(countdown: Countdown, digits: string, changed: boolean) {
  const { native } = countdown;
  if (!native || !native.active || native.stopwatch) return { configured: digits, shown: digits };
  const configured = changed ? digits : timerDigits(native.time);
  const showRemaining = native.running || !changed && (native.accumulated > 0 || native.elapsed);
  return { configured, shown: showRemaining ? timerDigits(native.timePassed) : configured };
}

function timerButtonsDisabled(countdown: Countdown, configured: string) {
  const unavailable = !countdown.canControl || countdown.progress.busy;
  const start = unavailable || !countdown.native?.running && secondsFromDigits(configured) === 0;
  return { unavailable, start, reset: unavailable || !countdown.native?.active };
}

function startLabel(countdown: Countdown, changed: boolean) {
  if (countdown.progress.busy) return "正在同步…";
  if (countdown.native?.running) return "暂停";
  if (countdown.native?.accumulated && !countdown.native.elapsed && !changed) return "继续";
  return "开始";
}

function TimerDigits({ digits, disabled, change }: { digits: string; disabled: boolean; change: (next: string) => void }) {
  return <div className="ilct-digits" aria-label="倒计时时长">{digits.split("").map((digit, index) => {
    const label = `${index < 2 ? "分钟" : "秒"}${index % 2 === 0 ? "十位" : "个位"}`;
    return <React.Fragment key={index}>{index === 2 && <span className="ilct-colon" aria-hidden="true">:</span>}
      <div className="ilct-digit"><button className="ilct-arrow" aria-label={`增加${label}`} disabled={disabled} onClick={() => change(changeTimerDigit(digits, index, 1))}>▲</button>
        <output aria-live="off">{digit}</output><button className="ilct-arrow" aria-label={`减少${label}`} disabled={disabled} onClick={() => change(changeTimerDigit(digits, index, -1))}>▼</button></div>
    </React.Fragment>;
  })}</div>;
}

function TimerActions({ countdown, changed, configured, onReset }: { countdown: Countdown; changed: boolean; configured: string; onReset: () => void }) {
  const { native, run, controller } = countdown;
  const disabled = timerButtonsDisabled(countdown, configured);
  const startOrPause = () => {
    if (native?.running) run(() => controller.pause());
    else if (native?.active && !native.stopwatch && !native.elapsed && native.accumulated > 0 && !changed) run(() => controller.resume());
    else run(() => { controller.startCountdown(secondsFromDigits(configured)); onReset(); });
  };
  return <><div className="ilct-timer-actions"><button className="ilct-primary" disabled={disabled.start} onClick={startOrPause}>{startLabel(countdown, changed)}</button>
    <button className="ilct-secondary" disabled={disabled.reset} onClick={() => run(() => { controller.reset(); onReset(); })}>重置</button></div>
    {native?.active && <button className="ilct-off" disabled={disabled.unavailable} onClick={() => run(() => controller.deactivate())}>关闭计时器</button>}</>;
}

export function CountdownPanel({ countdown, moderator, visible, close }: { countdown: Countdown; moderator: boolean; visible: boolean; close: () => void }) {
  const [digits, setDigits] = useState("0500");
  const [changed, setChanged] = useState(false);
  const { native, ready, canControl, progress, loading } = countdown;
  const { configured, shown } = countdownDigits(countdown, digits, changed);
  if (!visible) return null;
  return <ToolDialog title="倒计时" close={close}>
    {moderator ? <TimerDigits digits={shown} disabled={!canControl || progress.busy || Boolean(native?.running)} change={(next) => { setDigits(next); setChanged(true); }} />
      : <div className="ilct-readonly" aria-label="课堂剩余时间">{shown.slice(0, 2)}:{shown.slice(2)}</div>}
    {!moderator && <p className="ilct-caption">由老师控制</p>}{native?.elapsed && <p className="ilct-caption" role="status">时间到</p>}
    {!ready && <p className="ilct-error" role="status">{loading ? "正在读取课堂计时状态…" : "当前课堂不支持同步倒计时。"}</p>}
    {progress.error && <p className="ilct-error" role="alert">{progress.error}</p>}
    {moderator && <TimerActions countdown={countdown} changed={changed} configured={configured} onReset={() => setChanged(false)} />}
  </ToolDialog>;
}
