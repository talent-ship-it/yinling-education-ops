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
  const wake = async () => {
    if (stopped || pending || !input.canRun()) return;
    if (timer !== undefined) { cancel(timer); timer = undefined; }
    pending = true;
    controller = new AbortController();
    let delay = input.successDelayMs ?? 15_000;
    try {
      await input.run(controller.signal);
    } catch (error) {
      delay = input.errorDelayMs ?? 60_000;
      if (!stopped) input.onError(error);
    } finally {
      pending = false;
      controller = undefined;
      if (!stopped && input.canRun()) timer = schedule(() => { timer = undefined; void wake(); }, delay);
    }
  };
  return {
    wake,
    stop() {
      stopped = true;
      if (timer !== undefined) cancel(timer);
      controller?.abort();
    },
  };
}
