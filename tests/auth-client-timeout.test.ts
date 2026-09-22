import assert from "node:assert/strict";
import test from "node:test";
import { readInitialSession } from "@/app/auth-client";
import type { SharedStateFetch } from "@/lib/shared-state-recovery";

test("initial session headers timeout aborts instead of leaving authentication pending", async () => {
  let aborted = false;
  const fetchImpl: SharedStateFetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("session headers timed out", "AbortError"));
    }, { once: true });
  });

  await assert.rejects(readInitialSession(fetchImpl, new AbortController().signal, 5), { name: "AbortError" });
  assert.equal(aborted, true);
});

test("initial session body timeout aborts and a later check can recover", async () => {
  let calls = 0;
  const fetchImpl: SharedStateFetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("session body timed out", "AbortError")), { once: true });
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, user: "Synthetic Teacher", role: "teacher", mustChangePassword: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await assert.rejects(readInitialSession(fetchImpl, new AbortController().signal, 5), { name: "AbortError" });
  assert.deepEqual(await readInitialSession(fetchImpl, new AbortController().signal, 50), {
    user: "Synthetic Teacher",
    role: "teacher",
    mustChangePassword: false,
  });
});
