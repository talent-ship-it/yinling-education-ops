import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("implements shared Supabase state with conflict protection", async () => {
  const [client, route, store, auth] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/api/app-state/route.ts"),
    read("../lib/ops-store.ts"),
    read("../lib/demo-auth.ts"),
  ]);

  assert.match(client, /function useSharedState/);
  assert.match(client, /\/api\/app-state\?mode=versions/);
  assert.match(client, /window\.setInterval\(poll, 2500\)/);
  assert.match(client, /onSync\("conflict"/);
  assert.doesNotMatch(client, /window\.localStorage/);
  assert.match(route, /current: current\[0\] \}, 409/);
  assert.match(route, /expectedVersion/);
  assert.match(store, /OPS_API_SECRET/);
  assert.match(store, /get_ops_state/);
  assert.match(store, /put_ops_state/);
  assert.match(auth, /process\.env\.DEMO_PASSWORD \|\| "admin"/);
  assert.match(auth, /new Set\(\[expected, "admin"\]\)/);
  assert.match(auth, /function safeEquals/);
});

test("limits staff views and keeps Tencent Docs read-only", async () => {
  const client = await read("../app/operations-client.tsx");

  assert.match(client, /const staffSectionIds/);
  assert.match(client, /const visibleNavigation/);
  assert.match(client, /const scopedStudents/);
  assert.match(client, /const scopedTasks/);
  assert.match(client, /const scopedBookings/);
  assert.match(client, /const scopedMessages/);
  assert.match(client, /if \(!isAdminView && !staffSectionIds\.has\(active\)\) return renderDashboard/);
  assert.match(client, /超级管理员/);
  assert.match(client, /教务个人权限/);
  assert.match(client, /actor: currentOperator/);
  assert.match(client, /task\.owner === currentOperator \|\| scopedStudentIds\.has\(task\.studentId\)/);
  assert.match(client, /const teamOwnerOptions/);
  assert.match(client, /teamOwnerOptions\.map/);
  assert.match(client, /腾讯文档当前只读取和留存镜像/);
  assert.match(client, /不会从本系统回写或删除原文档内容/);
  assert.doesNotMatch(client, /采用腾讯值：Tiffany/);
  assert.doesNotMatch(client, /actor: "当前操作员"/);
});

test("retains core operations workflows and responsive UI", async () => {
  const [client, css, packageJson, devServer] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
    read("../package.json").then(JSON.parse),
    read("../scripts/dev-fixed-port.mjs"),
  ]);

  for (const contract of [
    "scheduleConflict",
    "createWorkflowTasks",
    "renderOperations",
    "renderRenewals",
    "renderPayroll",
    "renderFiles",
    "renderReports",
    "renderSettings",
    "renderAudit",
    "TeacherAvaBoard",
    "bookingHasDstRisk",
    "examReminderStudents",
  ]) assert.match(client, new RegExp(contract));

  assert.match(css, /--brand:#75C9C2/);
  assert.match(client, /teacherTotalHours/);
  assert.match(client, /function formatMoney/);
  assert.match(client, /payrollCurrency/);
  assert.match(client, /学生明细/);
  assert.doesNotMatch(client, /模拟导入教务宝数据/);
  assert.match(css, /\.payroll-layout/);
  assert.match(css, /\.payroll-line-list/);
  assert.match(css, /@media \(max-width:1210px\)/);
  assert.match(css, /@media \(min-width:1211px\) and \(max-width:1360px\)/);
  assert.match(css, /\.mobile-bottom-nav/);
  assert.match(css, /\.live-sync/);
  assert.match(css, /@media \(max-width:760px\)/);
  assert.doesNotMatch(css, /transition:\s*all/i);
  assert.equal(packageJson.scripts.dev, "node scripts/dev-fixed-port.mjs");
  assert.match(devServer, /const PORT = 3001/);
});
