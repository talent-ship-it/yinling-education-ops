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

test("locks Nixon profile and payroll behind a second server session", async () => {
  const [client, snapshotRoute, stateRoute, nixonAuth, nixonLogin] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/api/app-snapshot/route.ts"),
    read("../app/api/app-state/route.ts"),
    read("../lib/nixon-auth.ts"),
    read("../app/api/nixon-login/route.ts"),
  ]);

  assert.match(client, /initialNixonUnlocked/);
  assert.match(client, /Nixon（需密码）/);
  assert.match(client, /NixonAccessDialog/);
  assert.match(client, /\/api\/nixon-login/);
  assert.match(client, /defaults\.defaultStudents\.find\(\(student\) => student\.owner && student\.owner !== "Nixon"\)/);
  assert.match(snapshotRoute, /row\.entity !== "payroll"/);
  assert.match(snapshotRoute, /syncSources: nixonSession \? syncSources : \[\]/);
  assert.match(stateRoute, /需要 Nixon 权限密码才能读取薪资资料/);
  assert.match(stateRoute, /需要 Nixon 权限密码才能修改薪资资料/);
  assert.match(stateRoute, /versions\.filter\(\(row\) => row\.entity !== "payroll"\)/);
  assert.match(nixonAuth, /process\.env\.NIXON_PASSWORD_HASH/);
  assert.match(nixonAuth, /createHash\("sha256"\)/);
  assert.doesNotMatch(nixonAuth, /YL-GHPwF_97qvRB/);
  assert.match(nixonLogin, /httpOnly: true/);
  assert.doesNotMatch(nixonLogin, /maxAge/);
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
  assert.match(client, /function availabilitySummary/);
  assert.match(client, /const teacherPageSize = 8/);
  assert.match(client, /原始 AVA · 详情查看/);
  assert.match(client, /function formatMoney/);
  assert.match(client, /payrollCurrency/);
  assert.match(client, /payrollPage/);
  assert.match(client, /Pagination page=\{safePayrollPage\}/);
  assert.match(client, /学生明细/);
  assert.doesNotMatch(client, /模拟导入教务宝数据/);
  assert.match(css, /\.payroll-layout/);
  assert.match(css, /\.payroll-line-list/);
  assert.match(css, /@media \(max-width:1210px\)/);
  assert.match(css, /@media \(min-width:1211px\) and \(max-width:1360px\)/);
  assert.match(css, /collection-shell > \.master-detail-layout/);
  assert.match(css, /Desktop workspaces use a fixed right rail/);
  assert.match(css, /\.teacher-availability\.raw strong/);
  assert.match(css, /\.availability-value\.raw/);
  assert.match(css, /grid-template-columns:minmax\(0,1\.45fr\)/);
  assert.match(css, /\.master-detail-layout \.collection-row\.selected/);
  assert.match(css, /\.master-detail-layout \.collection-viewport/);
  assert.match(css, /\.master-detail-layout > \.student-detail/);
  assert.match(css, /border-left:1px solid #dbe5df/);
  assert.match(css, /\.topbar\s*\{\s*background:#fff/);
  assert.doesNotMatch(client, /panel student-detail/);
  assert.match(css, /sync-workspace/);
  assert.match(css, /\.mobile-bottom-nav/);
  assert.match(css, /\.live-sync/);
  assert.match(css, /@media \(max-width:760px\)/);
  assert.doesNotMatch(css, /transition:\s*all/i);
  assert.equal(packageJson.scripts.dev, "node scripts/dev-fixed-port.mjs");
  assert.match(devServer, /const PORT = 3001/);
});

test("keeps Jiaowubao imports read-only and exposes real operations data", async () => {
  const [client, css] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
  ]);

  assert.match(client, /const \[courses, , coursesShared\] = useSharedState\("courses"/);
  assert.match(client, /const renderCourses = \(\) =>/);
  assert.match(client, /case "courses": return renderCourses\(\)/);
  assert.match(client, /contractHours\?: number/);
  assert.match(client, /contractEffectiveDate\?: string/);
  assert.match(client, /jwbSyncStatus\?: string/);
  assert.match(client, /教务宝只读同步/);
  assert.match(client, /课时与合约数据来自只读镜像；本系统不会回写教务宝/);
  assert.match(client, /useState<"week" \| "agenda">\("agenda"\)/);
  assert.match(client, /useState<"compact" \| "comfortable">\("comfortable"\)/);
  assert.match(client, /Array\.from\(\{ length: 7 \}/);
  assert.match(client, /const schedulePageSize = 10/);
  assert.match(client, /Pagination page=\{safeSchedulePage\}/);
  assert.match(client, /const renewalPageSize = 10/);
  assert.match(client, /Pagination page=\{safeRenewalPage\}/);
  assert.match(client, /const payrollPageSize = 10/);
  assert.match(client, /学生课时、课程目录与本周排课已只读镜像；不会回写教务宝/);
  assert.match(css, /\.course-layout/);
  assert.match(css, /\.course-grid-row/);
  assert.match(css, /\.week-board \{/);
  assert.match(css, /\.week-event\.selected/);
  assert.match(css, /\.renewal-collection > \.collection-main/);
  assert.match(css, /\.pagination strong/);
});
