import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverClient = await readFile(new URL(
  "../lib/jiaowubao-open-api.ts",
  import.meta.url,
), "utf8");
const client = await readFile(new URL(
  "../lib/jiaowubao-open-api-node.ts",
  import.meta.url,
), "utf8");

test("JWB Open API client has a server-only Next wrapper and a Node-only core", () => {
  assert.match(serverClient, /import "server-only"/);
  assert.match(serverClient, /jiaowubao-open-api-node/);
  assert.match(client, /node:crypto/);
  assert.match(client, /https:\/\/cardi\.jwbpro\.com\/open\/jwb\/gateway/);
  assert.doesNotMatch(client, /http:\/\/cardi\.jwbpro\.com/);
  assert.doesNotMatch(client, /JIAOWUBAO_OPEN_API_URL/);
  assert.match(client, /process\.env\[JIAOWUBAO_OPEN_API_SECRET_ENV\]/);
  assert.doesNotMatch(client, /NEXT_PUBLIC_JIAOWUBAO/);
});

test("JWB Open API client restricts calls to three documented, fixed tool contracts", () => {
  assert.match(client, /requestGatewayList\("query_schedule_list"/);
  assert.match(client, /requestGatewayList\("query_lesson_list"/);
  assert.match(client, /requestGatewayList\("query_member_simple_list"/);
  assert.match(client, /queryJiaowubaoCompletedLessonList/);
  assert.match(client, /queryJiaowubaoMemberSimpleList/);
  assert.match(client, /MAX_PAGE_SIZE = 100/);
  assert.match(client, /MAX_PAGE = 500/);
  assert.match(client, /MAX_QUERY_WINDOW_DAYS = 31/);
  assert.match(client, /cal_type/);
  assert.match(client, /hidden_leave/);
  assert.match(client, /time_start/);
  assert.match(client, /time_end/);
  assert.match(client, /appoint/);
  assert.match(client, /week/);
  assert.match(client, /over/);
  assert.match(client, /order/);
  assert.match(client, /over: 1 as const/);
  assert.match(client, /input\.sign === undefined \? -1/);
});

test("JWB Open API client bounds transport and avoids unsafe response parsing", () => {
  assert.match(client, /AbortController/);
  assert.match(client, /REQUEST_TIMEOUT_MS/);
  assert.match(client, /MAX_RESPONSE_BYTES/);
  assert.match(client, /redirect: "error"/);
  assert.match(client, /content-length/);
  assert.match(client, /getReader\(\)/);
  assert.match(client, /reader\.cancel\(\)/);
  assert.doesNotMatch(client, /response\.json\(\)/);
  assert.doesNotMatch(client, /response\.text\(\)/);
});

test("JWB Open API client coalesces requests and handles the supplier limit without leaking response data", () => {
  assert.match(client, /MIN_REQUEST_INTERVAL_MS = 3_200/);
  assert.match(client, /inFlightListRequests/);
  assert.match(client, /response\.status === 429/);
  assert.match(client, /"rate_limited"/);
  assert.doesNotMatch(client, /err_msg/);
  assert.doesNotMatch(client, /response\.url/);
});
