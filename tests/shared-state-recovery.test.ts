import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchJsonWithTimeout,
  fetchWithTimeout,
  recoverSharedStateAfterUnknownWrite,
  type SharedStateFetch,
  type SharedStateRow,
} from "@/lib/shared-state-recovery";

type Item = { id: string; label: string };

const baseline: SharedStateRow<Item[]> = {
  entity: "tasks",
  payload: [{ id: "TSK-1", label: "committed" }],
  version: 7,
  updated_at: "2026-08-21T00:00:00.000Z",
  updated_by: "server",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("generic PUT timeout aborts the request instead of leaving an optimistic write pending", async () => {
  let aborted = false;
  const fetchImpl: SharedStateFetch = (_input, init) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("write timeout"));
    }, { once: true });
  });

  await assert.rejects(
    fetchWithTimeout(fetchImpl, "/api/app-state", { method: "PUT" }, 5),
    /write timeout/,
  );
  assert.equal(aborted, true);
});

test("JSON timeout remains active after response headers arrive", async () => {
  let aborted = false;
  const fetchImpl: SharedStateFetch = async (_input, init) => ({
    json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("body timeout"));
      }, { once: true });
    }),
  }) as Response;

  await assert.rejects(fetchJsonWithTimeout(fetchImpl, "/api/tasks/trial-payment", { method: "POST" }, 5), /body timeout/);
  assert.equal(aborted, true);
});

test("JSON response deadline rejects a stalled body after successful headers", async () => {
  const fetchImpl: SharedStateFetch = async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"rows":'));
      init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Body timed out", "AbortError")), { once: true });
    },
  }), { status: 200 });
  await assert.rejects(fetchJsonWithTimeout(fetchImpl, "/api/app-state", { method: "PUT" }, 5), { name: "AbortError" });
  const recovered = await recoverSharedStateAfterUnknownWrite({ entity: "tasks", committedBaseline: baseline, fetchImpl, timeoutMs: 5 });
  assert.equal(recovered.outcome, "baseline");
  assert.deepEqual(recovered.row, baseline);
});

test("JSON response preserves status, headers and the body for callers", async () => {
  const original = response({ rows: [baseline] }, 409);
  const { response: received, body } = await fetchJsonWithTimeout(async () => original, "/api/app-state", {}, 50);
  assert.equal(received, original);
  assert.equal(received.status, 409);
  assert.equal(received.headers.get("content-type"), "application/json");
  assert.deepEqual(body, { rows: [baseline] });
});

test("network timeout returns the committed baseline without retrying the PUT", async () => {
  let calls = 0;
  let aborted = false;
  const fetchImpl: SharedStateFetch = (_input, init) => {
    calls += 1;
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("network timeout"));
      }, { once: true });
    });
  };

  const result = await recoverSharedStateAfterUnknownWrite({
    entity: "tasks",
    committedBaseline: baseline,
    fetchImpl,
    timeoutMs: 5,
  });

  assert.equal(calls, 1, "recovery performs one GET and never re-submits the PUT");
  assert.equal(aborted, true);
  assert.equal(result.outcome, "baseline");
  assert.deepEqual(result.row, baseline);
});

test("a committed PUT with a lost response adopts the complete authoritative entity", async () => {
  const authoritative: SharedStateRow<Item[]> = {
    ...baseline,
    payload: [{ id: "TSK-1", label: "server committed" }],
    version: 8,
    updated_by: "Nixon",
  };
  const fetchImpl: SharedStateFetch = async () => response({ rows: [authoritative] });

  const result = await recoverSharedStateAfterUnknownWrite({
    entity: "tasks",
    committedBaseline: baseline,
    fetchImpl,
    timeoutMs: 50,
  });

  assert.equal(result.outcome, "authoritative");
  assert.deepEqual(result.row.payload, authoritative.payload);
  assert.equal(result.row.version, authoritative.version);
  assert.equal(result.row.updated_by, authoritative.updated_by);
});

test("a failed GET rolls the UI back to the sent baseline instead of re-merging local delta", async () => {
  const localUnconfirmed: Item[] = [{ id: "TSK-1", label: "unconfirmed local edit" }];
  const fetchImpl: SharedStateFetch = async () => response({ error: "temporary outage" }, 503);

  const result = await recoverSharedStateAfterUnknownWrite({
    entity: "tasks",
    committedBaseline: baseline,
    fetchImpl,
    timeoutMs: 50,
  });

  assert.equal(result.outcome, "baseline");
  assert.deepEqual(result.row.payload, baseline.payload);
  assert.notDeepEqual(result.row.payload, localUnconfirmed);
});
