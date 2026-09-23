import assert from "node:assert/strict";
import test from "node:test";

const {
  JiaowubaoOpenApiError,
  queryJiaowubaoCompletedLessonList,
  queryJiaowubaoScheduleList,
} = await import("../lib/jiaowubao-open-api-node.ts");

test("completed lesson client requires a selector, pins over=1, and parses lists plus total", async () => {
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.JIAOWUBAO_OPEN_API_SK;
  const calls = [];
  process.env.JIAOWUBAO_OPEN_API_SK = "test-only-jwb-secret";
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      ret: 1,
      data: { lists: [{ cal_id: 7001, mem_id: 12, over: 1 }], total: "1" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await queryJiaowubaoCompletedLessonList({
      start: "2026-08-01",
      end: "2026-08-31",
      mem_id: 12,
      // Runtime callers cannot change the source-state contract even if an
      // untyped boundary attempts to include a legacy field.
      over: 0,
    });
    assert.deepEqual(response.list, [{ cal_id: 7001, mem_id: 12, over: 1 }]);
    assert.equal(response.total, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "query_lesson_list");
    assert.equal(calls[0].params.over, 1);
    assert.equal(calls[0].params.sign, -1);
    assert.equal(calls[0].params.start, "2026-08-01");
    assert.equal(calls[0].params.end, "2026-08-31");
    assert.equal(calls[0].params.mem_id, 12);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.JIAOWUBAO_OPEN_API_SK;
    else process.env.JIAOWUBAO_OPEN_API_SK = previousSecret;
  }
});

test("completed lesson client rejects an unscoped whole-month request before fetch", async () => {
  const previousFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("unexpected_fetch");
  };
  try {
    await assert.rejects(
      queryJiaowubaoCompletedLessonList({ start: "2026-08-01", end: "2026-08-31" }),
      (error) => error instanceof JiaowubaoOpenApiError && error.code === "invalid_request",
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("gateway rejections expose only the fixed tool discriminator", async () => {
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.JIAOWUBAO_OPEN_API_SK;
  const upstreamCanary = "upstream-private-canary";
  process.env.JIAOWUBAO_OPEN_API_SK = "test-only-jwb-secret";
  globalThis.fetch = async () => new Response(JSON.stringify({
    ret: 0,
    err_msg: upstreamCanary,
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const cases = [
      {
        tool: "query_schedule_list",
        run: () => queryJiaowubaoScheduleList({ start: "2026-07-01", end: "2026-07-01" }),
      },
      {
        tool: "query_lesson_list",
        run: () => queryJiaowubaoCompletedLessonList({ start: "2026-07-01", end: "2026-07-01", mem_id: 12 }),
      },
    ];
    for (const { tool, run } of cases) {
      await assert.rejects(run, (error) => {
        assert.ok(error instanceof JiaowubaoOpenApiError);
        assert.equal(error.code, "upstream_rejected");
        assert.equal(error.tool, tool);
        assert.doesNotMatch(JSON.stringify({
          code: error.code,
          tool: error.tool,
          message: error.message,
        }), new RegExp(upstreamCanary));
        return true;
      });
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.JIAOWUBAO_OPEN_API_SK;
    else process.env.JIAOWUBAO_OPEN_API_SK = previousSecret;
  }
});

test("database-gated schedule reads are bounded by the route deadline", async () => {
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.JIAOWUBAO_OPEN_API_SK;
  let fetchCount = 0;
  process.env.JIAOWUBAO_OPEN_API_SK = "test-only-jwb-secret";
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ ret: 1, data: { lists: [] } }), { status: 200 });
  };
  try {
    await assert.rejects(
      queryJiaowubaoScheduleList(
        { start: "2026-07-02", end: "2026-07-02" },
        { rateGate: "database", deadlineAt: Date.now() - 1 },
      ),
      (error) => error instanceof JiaowubaoOpenApiError && error.code === "request_timeout",
    );
    assert.equal(fetchCount, 0);

    const result = await queryJiaowubaoScheduleList(
      { start: "2026-07-03", end: "2026-07-03" },
      { rateGate: "database", deadlineAt: Date.now() + 1_000 },
    );
    assert.deepEqual(result.lists, []);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.JIAOWUBAO_OPEN_API_SK;
    else process.env.JIAOWUBAO_OPEN_API_SK = previousSecret;
  }
});

test("database and interactive schedule reads share the per-process start queue", async () => {
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.JIAOWUBAO_OPEN_API_SK;
  const starts = [];
  process.env.JIAOWUBAO_OPEN_API_SK = "test-only-jwb-secret";
  globalThis.fetch = async () => {
    starts.push(Date.now());
    return new Response(JSON.stringify({ ret: 1, data: { lists: [] } }), { status: 200 });
  };
  try {
    await Promise.all([
      queryJiaowubaoScheduleList({ start: "2026-07-04", end: "2026-07-04" }),
      queryJiaowubaoScheduleList(
        { start: "2026-07-05", end: "2026-07-05" },
        { rateGate: "database", deadlineAt: Date.now() + 10_000 },
      ),
    ]);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 3_000, `request starts were only ${starts[1] - starts[0]}ms apart`);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.JIAOWUBAO_OPEN_API_SK;
    else process.env.JIAOWUBAO_OPEN_API_SK = previousSecret;
  }
});
