import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL(
  "../app/api/jiaowubao-open-api/schedule-preview/route.ts",
  import.meta.url,
), "utf8");

test("JWB schedule preview is an admin-only no-store GET", () => {
  assert.match(route, /getCurrentDemoSession/);
  assert.match(route, /hasFullAdminAccess/);
  assert.match(route, /buildOpsAccessContext/);
  assert.match(route, /DEMO_LIMITED_ADMIN_USER/);
  assert.match(route, /limitedAdminSession/);
  assert.match(route, /!access\.fullAdmin && !access\.limitedAdmin/);
  assert.match(route, /export async function GET/);
  assert.match(route, /Cache-Control": "private, no-store"/);
  assert.doesNotMatch(route, /request\.json/);
});

test("JWB schedule preview rejects non-admin sessions before loading operational state", () => {
  const cheapGate = route.indexOf("const limitedAdminSession");
  const operationalRead = route.indexOf('getOpsState(["bookings", "students", "teachers"])');
  assert.ok(cheapGate >= 0);
  assert.ok(operationalRead >= 0);
  assert.ok(cheapGate < operationalRead);
});

test("JWB schedule preview bounds date, page, and limit inputs", () => {
  assert.match(route, /MAX_WINDOW_DAYS = 31/);
  assert.match(route, /MAX_PAGE = 500/);
  assert.match(route, /MAX_LIMIT = 100/);
  assert.match(route, /const start = dateParameter/);
  assert.match(route, /const end = dateParameter/);
  assert.match(route, /boundedIntegerParameter\(url\.searchParams\.get\("page"\)/);
  assert.match(route, /boundedIntegerParameter\(url\.searchParams\.get\("limit"\)/);
  assert.match(route, /optionalEnumFilter\(url\.searchParams, "cal_type", \[1, 3\]\)/);
  assert.match(route, /optionalEnumFilter\(url\.searchParams, "hidden_leave", \[-1, 1\]\)/);
});

test("JWB schedule preview projects a minimal DTO and never forwards sensitive lesson details", () => {
  assert.match(route, /queryJiaowubaoScheduleList/);
  assert.match(route, /projectSchedule/);
  assert.match(route, /source\.cal_id/);
  assert.match(route, /source\.teacher_id/);
  assert.match(route, /source\.course_id/);
  assert.doesNotMatch(route, /studentName|student_name|source\.name/);
  assert.doesNotMatch(route, /source\.logo|source\.price|source\.cont/);
  assert.doesNotMatch(route, /\.\.\.source/);
  assert.match(route, /sourceLists\.map\(projectSchedule\)/);
});

test("JWB schedule preview hides upstream errors and does not accept a browser secret", () => {
  assert.match(route, /jiaowubao_open_api_unavailable/);
  assert.match(route, /jiaowubao_open_api_rate_limited/);
  assert.match(route, /jiaowubao_open_api_preview_rate_limited/);
  assert.match(route, /JiaowubaoOpenApiError/);
  assert.match(route, /Do not reflect the upstream err_msg/);
  assert.doesNotMatch(route, /searchParams\.get\("sk"\)/);
  assert.doesNotMatch(route, /process\.env\.[A-Z0-9_]+.*searchParams/);
});

test("JWB schedule preview bounds an authenticated actor's local review burst", () => {
  assert.match(route, /MAX_PREVIEW_REQUESTS_PER_WINDOW = 8/);
  assert.match(route, /previewRequestsByActor/);
  assert.match(route, /consumePreviewRequest\(session\.user\)/);
  assert.match(route, /in-memory map cannot be a cross-instance quota authority/);
});
