import assert from "node:assert/strict";
import test from "node:test";
import { createSharedStatePoller } from "@/lib/shared-state-poller";
import { fetchJsonWithTimeout, type SharedStateFetch } from "@/lib/shared-state-recovery";

test("a stalled JSON body releases the poller and the scheduled retry refreshes state", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let calls = 0;
  let errors = 0;
  let refreshed = false;
  const fetchImpl: SharedStateFetch = async (_url, init) => {
    calls += 1;
    if (calls > 1) return new Response('{"versions":[]}');
    return new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("timeout", "AbortError")), { once: true });
      },
    }));
  };
  const poller = createSharedStatePoller({
    canRun: () => true,
    onError: () => { errors += 1; },
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return 1 as unknown as ReturnType<typeof setTimeout>; },
    cancel: () => {},
    run: async (signal) => {
      const { body } = await fetchJsonWithTimeout(fetchImpl, "/versions", { signal }, 5);
      refreshed = Array.isArray(body.versions);
    },
  });
  await poller.wake();
  assert.equal(errors, 1);
  assert.equal(scheduled[0].delay, 60_000);
  await poller.wake();
  assert.equal(calls, 2);
  assert.equal(refreshed, true);
  assert.equal(scheduled[1].delay, 15_000);
  poller.stop();
});

test("stop aborts an in-flight read and prevents retries or error notifications", async () => {
  let signal: AbortSignal | undefined;
  let scheduled = 0;
  let errors = 0;
  const poller = createSharedStatePoller({
    canRun: () => true,
    onError: () => { errors += 1; },
    schedule: () => { scheduled += 1; return 1 as unknown as ReturnType<typeof setTimeout>; },
    run: async (parentSignal) => {
      await fetchJsonWithTimeout(async (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      }, "/versions", { signal: parentSignal }, 10_000);
    },
  });
  const running = poller.wake();
  await poller.wake();
  poller.stop();
  await running;
  assert.equal(signal?.aborted, true);
  assert.equal(errors, 0);
  assert.equal(scheduled, 0);
});
