export function createSharedStatePoller(input: {
  run: (signal: AbortSignal) => Promise<void>;
  canRun: () => boolean;
  onError: (error: unknown) => void;
  successDelayMs?: number;
  errorDelayMs?: number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const schedule = input.schedule ?? setTimeout;
  const cancel = input.cancel ?? clearTimeout;
  let stopped = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const canWake = () => !stopped && !pending && input.canRun();
  const clearScheduledWake = () => {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  };
  const runOnce = async (signal: AbortSignal) => {
    try {
      await input.run(signal);
      return input.successDelayMs ?? 15_000;
    } catch (error) {
      if (!stopped) input.onError(error);
      return input.errorDelayMs ?? 60_000;
    }
  };
  const scheduleNextWake = (delay: number) => {
    if (stopped || !input.canRun()) return;
    timer = schedule(() => {
      timer = undefined;
      void wake();
    }, delay);
  };
  const wake = async () => {
    if (!canWake()) return;
    clearScheduledWake();
    pending = true;
    const activeController = new AbortController();
    controller = activeController;
    let delay = input.errorDelayMs ?? 60_000;
    try {
      delay = await runOnce(activeController.signal);
    } finally {
      pending = false;
      if (controller === activeController) controller = undefined;
      scheduleNextWake(delay);
    }
  };
  return {
    wake,
    stop() {
      stopped = true;
      clearScheduledWake();
      controller?.abort();
    },
  };
}
