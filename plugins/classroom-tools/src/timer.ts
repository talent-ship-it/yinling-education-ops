export type NativeTimerState = {
  active: boolean;
  running: boolean;
  stopwatch: boolean;
  time: number;
  accumulated: number;
  elapsed: boolean;
  timePassed: number;
};

export const TIMER_MUTATIONS = {
  activate: "mutation ClassroomTimerActivate($stopwatch: Boolean!, $running: Boolean!, $time: Int!) { timerActivate(stopwatch: $stopwatch, running: $running, time: $time) }",
  stop: "mutation ClassroomTimerStop { timerStop }",
  mode: "mutation ClassroomTimerMode($stopwatch: Boolean!) { timerSwitchMode(stopwatch: $stopwatch) }",
  time: "mutation ClassroomTimerSetTime($time: Int!) { timerSetTime(time: $time) }",
  reset: "mutation ClassroomTimerReset { timerReset }",
  start: "mutation ClassroomTimerStart { timerStart }",
  deactivate: "mutation ClassroomTimerDeactivate { timerDeactivate }",
} as const;

export type TimerAction = keyof typeof TIMER_MUTATIONS;
export type TimerVariables = { stopwatch?: boolean; running?: boolean; time?: number };
export type TimerProgress = { busy: boolean; error: string };
type Step = { action: TimerAction; variables: TimerVariables; confirmed: (state: NativeTimerState) => boolean };

export class NativeTimerController {
  private state?: NativeTimerState;
  private steps: Step[] = [];
  private pending?: Step;
  private timeout?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private send: (action: TimerAction, variables: TimerVariables) => void,
    private readonly onProgress: (progress: TimerProgress) => void,
    private readonly timeoutMs = 10_000,
  ) {}

  setSender(send: (action: TimerAction, variables: TimerVariables) => void) { this.send = send; }

  observe(state: NativeTimerState) {
    this.state = state;
    if (this.busy) this.advance();
  }

  get busy() { return this.pending !== undefined || this.steps.length > 0; }

  startCountdown(seconds: number) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 5999) {
      throw new Error("倒计时须在 00:01 至 99:59 之间。");
    }
    const time = seconds * 1000;
    this.begin([
      { action: "activate", variables: { stopwatch: false, running: false, time }, confirmed: (state) => state.active },
      { action: "stop", variables: {}, confirmed: (state) => !state.running },
      { action: "mode", variables: { stopwatch: false }, confirmed: (state) => !state.stopwatch },
      { action: "time", variables: { time }, confirmed: (state) => state.time === time },
      { action: "reset", variables: {}, confirmed: (state) => !state.running && state.accumulated === 0 },
      { action: "start", variables: {}, confirmed: (state) => state.running && !state.elapsed && !state.stopwatch && state.time === time },
    ]);
  }

  pause() {
    this.begin([{ action: "stop", variables: {}, confirmed: (state) => !state.running }]);
  }

  resume() {
    this.begin([{ action: "start", variables: {}, confirmed: (state) => state.running }]);
  }

  reset() {
    this.begin([
      { action: "stop", variables: {}, confirmed: (state) => !state.running },
      { action: "reset", variables: {}, confirmed: (state) => !state.running && state.accumulated === 0 },
    ]);
  }

  deactivate() {
    this.begin([{ action: "deactivate", variables: {}, confirmed: (state) => !state.active }]);
  }

  fail(error = "课堂未确认计时操作，请检查连接后重试。") {
    if (!this.busy || this.disposed) return;
    this.clearPending();
    this.steps = [];
    this.onProgress({ busy: false, error });
  }

  dispose() {
    this.disposed = true;
    this.clearPending();
    this.steps = [];
  }

  private begin(steps: Step[]) {
    if (this.disposed || this.busy) return;
    if (!this.state) throw new Error("正在读取课堂计时状态。");
    this.steps = steps;
    this.onProgress({ busy: true, error: "" });
    this.advance();
  }

  private clearPending() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    this.pending = undefined;
  }

  private advance() {
    if (!this.state || this.disposed) return;
    if (this.pending) {
      if (!this.pending.confirmed(this.state)) return;
      this.clearPending();
    }
    while (this.steps.length) {
      const next = this.steps.shift()!;
      if (next.confirmed(this.state)) continue;
      this.pending = next;
      this.timeout = setTimeout(() => this.fail(), this.timeoutMs);
      try { this.send(next.action, next.variables); }
      catch { this.fail(); }
      return;
    }
    this.onProgress({ busy: false, error: "" });
  }
}

export function timerDigits(milliseconds: number) {
  const seconds = Math.min(5999, Math.max(0, Math.ceil(milliseconds / 1000)));
  return `${Math.floor(seconds / 60)}`.padStart(2, "0") + `${seconds % 60}`.padStart(2, "0");
}

export function changeTimerDigit(digits: string, index: number, delta: number) {
  if (!/^\d{4}$/.test(digits) || !Number.isInteger(index) || index < 0 || index > 3) return digits;
  const values = digits.split("");
  const limit = index === 2 ? 6 : 10;
  values[index] = String((Number(values[index]) + delta + limit) % limit);
  return values.join("");
}

export function secondsFromDigits(digits: string) {
  if (!/^\d{2}[0-5]\d$/.test(digits)) return 0;
  return Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
}
