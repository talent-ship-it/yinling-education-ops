import assert from "node:assert/strict";
import test from "node:test";
import { fixture, serverFixture, window } from "./ava-calendar-server-fixture";

for (const kind of ["human", "machine"] as const) {
  for (const slowRpc of ["get_jiaowubao_open_api_schedule_snapshot_window", "get_ops_sources"]) {
    test(`${kind} late ${slowRpc} cannot publish after the unchanged 45s route deadline`, async () => {
      const state = fixture();
      const server = serverFixture(state, (rpc) => { if (rpc === slowRpc) state.now += 45_001; });
      const response = await server.get(kind);
      assert.equal(response.status, 503, "late source success must not authorize a stale publication");
      assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_versions").length, 0);
      assert.doesNotMatch(await response.text(), /events|remainingAVA|Synthetic|students/);
    });
  }

  test(`${kind} an already cancelled request never dispatches a database read`, async () => {
    const controller = new AbortController();
    controller.abort();
    const server = serverFixture();
    const response = await server.get(kind, window, { signal: controller.signal });
    assert.equal(response.status, 503);
    assert.equal(server.calls.length, 0);
  });

  test(`${kind} cancellation reaches the current RPC and rejects an ignored late response`, async () => {
    const controller = new AbortController();
    let sourceSignal: AbortSignal | null | undefined;
    const server = serverFixture(fixture(), (rpc, _body, _env, init) => {
      if (rpc === "get_jiaowubao_open_api_schedule_snapshot_window") {
        sourceSignal = init?.signal;
        controller.abort();
        assert.equal(sourceSignal?.aborted, true);
      }
    });
    const response = await server.get(kind, window, { signal: controller.signal });
    assert.equal(response.status, 503);
    assert.equal(sourceSignal?.aborted, true);
    assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_sources").length, 0);
    assert.doesNotMatch(await response.text(), /events|remainingAVA|Synthetic/);
  });

  test(`${kind} a failed source cancels still-running sibling coordinator reads`, async () => {
    const inFlight: AbortSignal[] = [];
    let entered!: () => void;
    const accountsStarted = new Promise<void>((resolve) => { entered = resolve; });
    const server = serverFixture(fixture(), async (rpc, _body, _env, init) => {
      if (rpc === "read_account_by_identity") {
        const signal = init!.signal!;
        inFlight.push(signal);
        entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      if (rpc === "get_jiaowubao_open_api_schedule_snapshot_window") {
        await accountsStarted;
        return Response.json({ code: "57014", message: "private synthetic failure" }, { status: 500 });
      }
    });
    assert.equal((await server.get(kind)).status, 503);
    assert.equal(inFlight.length, 6);
    assert.ok(inFlight.every((signal) => signal.aborted));
  });
}

test("the real v5 session reader shares the route deadline rather than receiving a new budget", async () => {
  const state = fixture();
  const initialTime = state.now;
  const server = serverFixture(state, (rpc) => {
    if (rpc === "get_ops_sources") state.now += 44_999;
    if (rpc === "read_account_session" && state.now > initialTime) state.now += 2;
  }, true);
  const response = await server.get("human");
  assert.equal(response.status, 503);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "read_account_session").length, 3);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_versions").length, 0);
  assert.doesNotMatch(await response.text(), /events|Synthetic/);
});

test("the real v5 admin path has one full state read and keeps four fresh session fences", async () => {
  const server = serverFixture(fixture(), undefined, true);
  const response = await server.get("human");
  assert.equal(response.status, 200);
  assert.equal(server.calls.length, 20);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_state").length, 1);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "read_account_session").length, 4);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "read_account_by_identity").length, 12);
});

test("a real v5 teacher roster removal during a source read is not satisfied by cached rows", async () => {
  const state = fixture();
  state.session = { user: "Synthetic Teacher", role: "teacher", permissions: ["operations.read"] };
  state.fullAdmin = false;
  const server = serverFixture(state, (rpc) => { if (rpc === "get_jiaowubao_open_api_schedule_snapshot_window") state.rows[1]!.payload = []; }, true);
  assert.equal((await server.get("human")).status, 401);
  assert.equal(server.calls.filter(({ rpc, body }) => rpc === "get_ops_state" && JSON.stringify(body.p_entities) === '["teachers"]').length, 2);
  assert.equal(server.calls.filter(({ rpc }) => rpc === "get_ops_sources").length, 0);
});
