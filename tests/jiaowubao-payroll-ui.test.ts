import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const client = readFileSync(new URL("../app/operations-client.tsx", import.meta.url), "utf8");
const dashboardAuth = readFileSync(new URL("../lib/jiaowubao/monthly-payroll-auth.ts", import.meta.url), "utf8");
const memberRoute = readFileSync(new URL("../app/api/jiaowubao/members/sync/route.ts", import.meta.url), "utf8");
const memberClient = readFileSync(new URL("../lib/jiaowubao/member-client.ts", import.meta.url), "utf8");
const scheduleRoute = readFileSync(new URL("../app/api/jiaowubao/schedule/sync/route.ts", import.meta.url), "utf8");
const scheduleClient = readFileSync(new URL("../lib/jiaowubao/schedule-client.ts", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/jiaowubao-monthly-payroll.yml", import.meta.url), "utf8");

test("keeps the JiaoWuBao workbook workflow separate from shared payroll state", () => {
  assert.match(client, /\/api\/jiaowubao\/monthly-payroll\/sync/);
  assert.match(client, /\/api\/jiaowubao\/monthly-payroll\/export/);
  assert.match(client, /method: "POST"/);
  assert.match(client, /setJiaowubaoSync\(sync\)/);
  assert.match(client, /绝不会覆盖人工费率、薪资或锁定记录/);
  assert.doesNotMatch(client, /setPayroll\(body\.payroll/);
});

test("requires the same full-admin session as the payroll workspace", () => {
  assert.match(dashboardAuth, /actor === DEMO_ADMIN_USER && hasValidNixonSession/);
  assert.match(dashboardAuth, /JIAOWUBAO_MONTHLY_PAYROLL_CRON_SECRET/);
  assert.match(dashboardAuth, /expected\.length < 32/);
  assert.match(dashboardAuth, /timingSafeEqual/);
});

test("keeps member-directory queries narrow, local, and read-only", () => {
  assert.match(client, /\/api\/jiaowubao\/members\/sync/);
  assert.match(client, /系统不会全量下载学员目录/);
  assert.match(client, /结果仅用于当前浏览器核对/);
  assert.match(memberRoute, /hasMonthlyPayrollDashboardAccess/);
  assert.match(memberRoute, /fetchJiaowubaoMembers\(query, \{ maxPages: 2 \}\)/);
  assert.match(memberRoute, /saved: false/);
  assert.match(memberClient, /JIAOWUBAO_MEMBER_QUERY_MAX_PAGES = 2/);
  assert.match(memberClient, /Object\.keys\(filters\)\.length/);
  assert.match(memberClient, /documentedGatewayMemberRequest/);
  assert.match(memberClient, /Number\.isSafeInteger/);
});

test("exposes the schedule gateway only as a separate read-only aggregate overview", () => {
  assert.match(client, /\/api\/jiaowubao\/schedule\/sync/);
  assert.match(client, /renderJiaowubaoSchedulePanel\(\)/);
  assert.match(client, /不会同步到系统排课、学生、老师或薪资/);
  assert.match(client, /studentDetailPolicy === "aggregate-only"/);
  assert.match(scheduleRoute, /hasMonthlyPayrollDashboardAccess/);
  assert.match(scheduleRoute, /fetchJiaowubaoSchedule/);
  assert.match(scheduleRoute, /saved: false/);
  assert.match(scheduleClient, /data\?\.lists/);
  assert.match(scheduleClient, /documentedGatewayScheduleRequest/);
  assert.match(scheduleClient, /MAX_INTERACTIVE_SCHEDULE_PAGES = 2/);
  assert.doesNotMatch(scheduleClient, /record\.stu_list/);
  assert.match(workflow, /environment: jiaowubao-payroll/);
  assert.match(workflow, /JIAOWUBAO_GATEWAY_RETRY_429: "true"/);
  assert.match(workflow, /retention-days: 30/);
  assert.doesNotMatch(workflow, /curl /);
});
