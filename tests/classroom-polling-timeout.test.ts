import assert from "node:assert/strict";
import test from "node:test";
import { createSharedStatePoller } from "@/lib/shared-state-poller";
import { fetchJsonWithTimeout, type SharedStateFetch } from "@/lib/shared-state-recovery";

for (const stall of ["headers", "body"] as const) {
  test(`classroom polling recovers after a stalled ${stall} response`, async () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    let calls = 0;
    let recovered: (() => void) | undefined;
    const recovery = new Promise<void>((resolve) => { recovered = resolve; });
    const fetchImpl: SharedStateFetch = (_input, init) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(new Response(JSON.stringify({ status: { running: true }, recordings: [] })));
      if (stall === "headers") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("headers timed out", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":'));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("body timed out", "AbortError")), { once: true });
        },
      })));
    };
    const poller = createSharedStatePoller({
      canRun: () => true,
      errorDelayMs: 15_000,
      onError: () => {},
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => {},
      run: async (parentSignal) => {
        const { body } = await fetchJsonWithTimeout(fetchImpl, "/api/classroom", { signal: parentSignal }, 5);
        if (body && typeof body === "object" && "status" in body) recovered?.();
      },
    });

    await poller.wake();
    assert.equal(calls, 1);
    assert.equal(scheduled[0]?.delay, 15_000);
    scheduled[0]?.callback();
    await recovery;
    assert.equal(calls, 2);
    poller.stop();
  });
}
