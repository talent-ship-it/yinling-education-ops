import assert from "node:assert/strict";
import test from "node:test";
import { fixture, serverFixture } from "./ava-calendar-server-fixture";

const upstream = "89a1bd45-69f9-400f-aef8-135f8df7c08e";
const edge = "syd1::iad1::zpspk-1792154382291-578e3df9253b";
for (const kind of ["human", "machine"] as const) {
  for (const [rpc, phase] of [["get_ops_state", "rows"], ["get_jiaowubao_open_api_schedule_snapshot_window", "snapshot"], ["read_account_by_identity", "accounts"]]) {
    test(`${kind} ${phase} SQL timeout keeps the public error private and joins safe RPC diagnostics`, async () => {
      const server = serverFixture(fixture(), (name) => name === rpc ? Response.json({ code: "57014", message: "private-token Synthetic Student", details: "private payload" }, { status: 500, headers: { "sb-request-id": upstream, "x-private-token": "never-log-me" } }) : undefined);
      const response = await server.get(kind, undefined, { headers: { "x-vercel-id": edge, "x-request-id": "Synthetic Student private-token" } });
      assert.equal(response.status, 503);
      assert.deepEqual(Object.keys(await response.json()), ["error"]);
      const requestId = response.headers.get("x-request-id");
      assert.match(requestId ?? "", /^[a-f0-9-]{36}$/);
      const events = server.warnings.map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.requestId === requestId && event.edgeId === edge && event.phase === phase && event.rpc === rpc && event.code === "57014" && event.httpStatus === 500 && event.upstreamRequestId === upstream));
      assert.doesNotMatch(server.warnings.join("\n"), /Synthetic|private-token|never-log-me|private payload|p_secret|p_token_hash|sourceParticipants/);
      for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["code", "edgeId", "elapsedMs", "event", "httpStatus", "phase", "requestId", "rpc", "upstreamRequestId"]);
    });
  }
}

for (const kind of ["human", "machine"] as const) {
  test(`${kind} failed diagnostic-only metadata keeps authorized lessons and records the actual failure`, async () => {
    const server = serverFixture(fixture(), (rpc) => rpc === "get_ops_sources" ? Response.json({ code: "57014", message: "private Synthetic Student" }, { status: 500, headers: { "x-request-id": upstream } }) : undefined);
    const response = await server.get(kind);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).events.length, 1);
    assert.ok(server.warnings.map((line) => JSON.parse(line)).some((event) => event.phase === "metadata" && event.code === "57014" && event.upstreamRequestId === upstream));
  });

  test(`${kind} invalid upstream IDs and arbitrary error codes are not loggable payload`, async () => {
    const server = serverFixture(fixture(), (rpc) => rpc === "get_ops_state" ? Response.json({ code: "ALICE", message: "Synthetic Student secret-value" }, { status: 500, headers: { "x-request-id": "Synthetic Student secret-value" } }) : undefined);
    const response = await server.get(kind, undefined, { headers: { "x-vercel-id": "Synthetic Student secret-value" } });
    assert.equal(response.status, 503);
    const events = server.warnings.map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.rpc === "get_ops_state"));
    assert.ok(events.every((event) => event.edgeId === null && event.upstreamRequestId === null && event.code === "source_unavailable"));
    assert.doesNotMatch(server.warnings.join("\n"), /Synthetic|ALICE|secret-value/);
  });
}

test("an initial nonthrowing v5 session 503 retains its actual SQLSTATE and request correlation", async () => {
  const server = serverFixture(fixture(), (rpc) => rpc === "read_account_session" ? Response.json({ code: "57014", message: "private synthetic session" }, { status: 500, headers: { "sb-request-id": upstream } }) : undefined, true);
  const response = await server.get("human");
  assert.equal(response.status, 503);
  assert.equal(server.calls.length, 1);
  assert.ok(server.warnings.map((line) => JSON.parse(line)).some((event) => event.requestId === response.headers.get("x-request-id") && event.phase === "session" && event.rpc === "read_account_session" && event.code === "57014" && event.upstreamRequestId === upstream));
  assert.doesNotMatch(server.warnings.join("\n"), /private|synthetic|p_token|tokenHash|v5\./);
});

test("transport failures and per-RPC timeout have distinct bounded diagnostic codes", async () => {
  for (const timedOut of [false, true]) {
    const state = fixture();
    const server = serverFixture(state, (rpc) => {
      if (rpc === "get_ops_state") {
        if (timedOut) state.now += 15_001;
        else throw new Error("private synthetic transport payload");
      }
    });
    assert.equal((await server.get("human")).status, 503);
    assert.ok(server.warnings.map((line) => JSON.parse(line)).some((event) => event.phase === "rows" && event.rpc === "get_ops_state" && event.code === (timedOut ? "timeout" : "transport")));
    assert.doesNotMatch(server.warnings.join("\n"), /private|synthetic|payload/);
  }
});
