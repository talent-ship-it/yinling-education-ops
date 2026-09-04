import assert from "node:assert/strict";
import test from "node:test";

const {
  JiaowubaoOpenApiError,
  queryJiaowubaoCompletedLessonList,
  queryJiaowubaoScheduleList,
} = await import("../lib/jiaowubao-open-api-node.ts");

test("completed lesson client pins over=1 and returns the documented list field", async () => {
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.JIAOWUBAO_OPEN_API_SK;
  const calls = [];
  process.env.JIAOWUBAO_OPEN_API_SK = "test-only-jwb-secret";
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      ret: 1,
      data: { list: [{ cal_id: 7001, mem_id: 12, over: 1 }] },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await queryJiaowubaoCompletedLessonList({
      start: "2026-08-01",
      end: "2026-08-31",
      // Runtime callers cannot change the source-state contract even if an
      // untyped boundary attempts to include a legacy field.
      over: 0,
    });
    assert.deepEqual(response.list, [{ cal_id: 7001, mem_id: 12, over: 1 }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "query_lesson_list");
    assert.equal(calls[0].params.over, 1);
    assert.equal(calls[0].params.sign, -1);
    assert.equal(calls[0].params.start, "2026-08-01");
    assert.equal(calls[0].params.end, "2026-08-31");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret === undefined) delete process.env.JIAOWUBAO_OPEN_API_SK;
    else process.env.JIAOWUBAO_OPEN_API_SK = previousSecret;
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
        run: () => queryJiaowubaoCompletedLessonList({ start: "2026-07-01", end: "2026-07-01" }),
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
