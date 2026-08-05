import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("implements shared Supabase state with conflict protection", async () => {
  const [client, route, store, auth, localization] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/api/app-state/route.ts"),
    read("../lib/ops-store.ts"),
    read("../lib/demo-auth.ts"),
    read("../lib/interface-localization.ts"),
  ]);

  assert.match(client, /function useSharedState/);
  assert.match(client, /\/api\/app-state\?mode=versions/);
  assert.match(client, /const activeDelayMs = 15_000/);
  assert.match(client, /const errorDelayMs = 60_000/);
  assert.match(client, /window\.setTimeout/);
  assert.match(client, /window\.addEventListener\("focus", wake\)/);
  assert.match(client, /window\.addEventListener\("online", wake\)/);
  assert.doesNotMatch(client, /window\.setInterval\(poll, 2500\)/);
  assert.match(client, /onSync\("conflict"/);
  assert.match(client, /displayPreferencesStorageKey/);
  assert.match(client, /window\.localStorage\.setItem\(displayPreferencesStorageKey/);
  assert.match(client, /observeInterfaceLocalization/);
  assert.match(localization, /MutationObserver/);
  assert.match(localization, /data-preserve-language/);
  assert.match(localization, /Schedule and timezone checks/);
  assert.doesNotMatch(client, /localStorage\.setItem\(["'](?:students|teachers|tasks|bookings|payroll|files|audit)["']/);
  assert.match(route, /mergeScopedPayload/);
  assert.match(route, /filterOpsStateRows/);
  assert.match(route, /expectedVersion/);
  assert.match(store, /OPS_API_SECRET/);
  assert.match(store, /get_ops_state/);
  assert.match(store, /put_scoped_ops_state/);
  assert.match(auth, /DEMO_STAFF_USERS/);
  assert.match(auth, /resolveDemoUser/);
  assert.match(auth, /matchesNixonPassword/);
  assert.doesNotMatch(auth, /DEMO_PASSWORD/);
  assert.doesNotMatch(auth, /"admin"/);
  assert.match(auth, /function safeEquals/);
});

test("limits staff and teacher views and keeps Tencent Docs read-only", async () => {
  const [client, users] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../lib/demo-users.ts"),
  ]);

  assert.match(client, /const staffSectionIds/);
  assert.match(client, /const teacherSectionIds/);
  assert.match(client, /const visibleNavigation/);
  assert.match(client, /const scopedStudents/);
  assert.match(client, /const scopedTasks/);
  assert.match(client, /const scopedBookings/);
  assert.match(client, /const scopedMessages/);
  assert.match(client, /if \(\s*!isAdminView &&\s*!\(isTeacherView \? teacherSectionIds : staffSectionIds\)\.has\(active\)\s*\)\s*return renderDashboard/);
  assert.match(client, /超级管理员/);
  assert.match(client, /scope: "负责学生、排课和跟进"/);
  assert.match(client, /scope: "自己的学生、约课和网上课堂"/);
  assert.match(client, /renderTeacherDashboard/);
  assert.match(client, /renderClassroom/);
  assert.match(client, /renderAccounts/);
  assert.match(users, /"Helen Ceperkovic", "Shirley Li", "Anna Zhang", "Nixon（测试）"/);
  assert.match(client, /actor: operatorLabel\(sessionOperator\)/);
  assert.match(client, /task\.owner === currentOperator \|\| scopedStudentIds\.has\(task\.studentId\)/);
  assert.match(client, /const teamOwnerOptions/);
  assert.match(client, /teamOwnerOptions\.map/);
  assert.match(client, /腾讯文档当前只读取和留存镜像/);
  assert.match(client, /不会从本系统回写或删除原文档内容/);
  assert.doesNotMatch(client, /采用腾讯值：Tiffany/);
  assert.doesNotMatch(client, /actor: "当前操作员"/);
});

test("binds demo identities to profiles and protects Admin payroll access", async () => {
  const [client, accountMenu, demoLogin, demoSession, demoLogout, snapshotRoute, stateRoute, auditRoute, nixonAuth, nixonLogin] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/account-menu.tsx"),
    read("../app/api/demo-login/route.ts"),
    read("../app/api/demo-session/route.ts"),
    read("../app/api/demo-logout/route.ts"),
    read("../app/api/app-snapshot/route.ts"),
    read("../app/api/app-state/route.ts"),
    read("../app/api/audit/route.ts"),
    read("../lib/nixon-auth.ts"),
    read("../app/api/nixon-login/route.ts"),
  ]);

  assert.match(client, /initialNixonUnlocked/);
  assert.match(client, /initialOperator/);
  assert.match(client, /isAdminSession/);
  assert.match(client, /DEMO_LIMITED_ADMIN_USER/);
  assert.match(client, /canUseAdminScope \? Array\.from\(new Set\(\[sessionOperator, DEMO_LIMITED_ADMIN_USER, \.\.\.DEMO_STAFF_USERS/);
  assert.match(client, /\.\.\.DEMO_TEACHER_USERS/);
  assert.match(client, /!canUseAdminScope && operator !== sessionOperator/);
  assert.match(client, /operator === "Nixon" \? "Admin" : operator/);
  assert.match(client, /operatorLabel\(entry\.actor\)/);
  assert.match(client, /const canViewPayroll = isFullAdminSession && currentOperator === "Nixon"/);
  assert.match(client, /canViewPayroll \|\| noPayrollAdminSectionIds\.has/);
  assert.match(client, /\{canViewPayroll && <button type="button" onClick=\{\(\) => setActive\("payroll"\)\}/);
  assert.match(client, /if \(!canViewPayroll && active === "payroll"\) return renderDashboard/);
  assert.match(accountMenu, /\/api\/demo-logout/);
  assert.match(accountMenu, /打开账户菜单/);
  assert.match(accountMenu, /退出登录/);
  assert.match(accountMenu, /\.operator select/);
  assert.doesNotMatch(client, /NixonAccessDialog/);
  assert.match(demoLogin, /resolveDemoUser/);
  assert.match(demoLogin, /user === DEMO_ADMIN_USER/);
  assert.match(demoLogin, /maxAge: 0/);
  assert.match(demoLogin, /resolveDemoUser/);
  assert.match(demoSession, /getDemoSessionUser/);
  assert.match(demoLogout, /DEMO_COOKIE_NAME/);
  assert.match(demoLogout, /NIXON_COOKIE_NAME/);
  assert.match(demoLogout, /maxAge: 0/);
  assert.match(snapshotRoute, /buildOpsAccessContext/);
  assert.match(snapshotRoute, /filterOpsStateRows/);
  assert.match(snapshotRoute, /actor === DEMO_ADMIN_USER/);
  assert.match(snapshotRoute, /actor === DEMO_LIMITED_ADMIN_USER/);
  assert.match(stateRoute, /filterOpsVersions/);
  assert.match(stateRoute, /mergeScopedPayload/);
  assert.match(stateRoute, /getAccessScopeVersions/);
  assert.match(stateRoute, /access_scope_changed/);
  assert.match(stateRoute, /操作审计由服务器自动记录/);
  assert.match(stateRoute, /DEMO_LIMITED_ADMIN_USER/);
  assert.match(auditRoute, /getAccessScopeVersions/);
  assert.match(auditRoute, /scopeVersions/);
  assert.match(auditRoute, /actor: actor === DEMO_ADMIN_USER \? "Admin" : actor/);
  assert.match(nixonAuth, /process\.env\.NIXON_PASSWORD_HASH/);
  assert.match(nixonAuth, /process\.env\.OPS_API_SECRET/);
  assert.match(nixonAuth, /createHash\("sha256"\)/);
  assert.doesNotMatch(nixonAuth, /YL-[A-Za-z0-9_-]{8,}/);
  assert.match(nixonLogin, /httpOnly: true/);
  assert.match(nixonLogin, /getDemoSessionUser/);
  assert.doesNotMatch(nixonLogin, /maxAge/);
  assert.doesNotMatch(client, /Admin Lite/);
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
  assert.match(client, /payrollMonthSelection/);
  assert.match(client, /activePayrollMonth/);
  assert.match(client, /monthPayroll/);
  assert.match(client, /payrollPage/);
  assert.match(client, /downloadPayrollExcel/);
  assert.match(client, /submitNewPayroll/);
  assert.match(client, /submitPayrollEdit/);
  assert.match(client, /modal === "payrollNew"/);
  assert.match(client, /modal === "payrollEdit"/);
  assert.match(client, /type="month"/);
  assert.match(client, /导出本月 Excel/);
  assert.match(client, /编辑老师与费率/);
  assert.match(client, /<Pagination\s+page=\{safePayrollPage\}/);
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
  assert.match(devServer, /const HOST = "127\.0\.0\.1"/);
  assert.match(devServer, /"--hostname", HOST/);
});

test("keeps Jiaowubao imports read-only and exposes real operations data", async () => {
  const [client, css] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
  ]);

  assert.match(client, /const \[courses, , coursesShared\] = useSharedState\("courses"/);
  assert.match(client, /const renderCourses = \(\) =>/);
  assert.match(client, /case "courses":\s*return renderCourses\(\)/);
  assert.match(client, /contractHours\?: number/);
  assert.match(client, /contractEffectiveDate\?: string/);
  assert.match(client, /jwbSyncStatus\?: string/);
  assert.match(client, /教务宝只读同步/);
  assert.match(client, /课时与合约数据来自只读镜像；本系统不会回写教务宝/);
  assert.match(client, /useState<"week" \| "agenda">\("agenda"\)/);
  assert.match(client, /const scheduleDensity = displayPreferences\.density/);
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

test("connects scoped bookings to real BiggerBlueButton classrooms", async () => {
  const [client, route, bbb, css, legacyPage, packageJson] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/api/classroom/route.ts"),
    read("../lib/bigbluebutton.ts"),
    read("../app/globals.css"),
    read("../app/classroom/[roomId]/page.tsx"),
    read("../package.json").then(JSON.parse),
  ]);

  assert.match(client, /classroom\?: \{/);
  assert.match(client, /classroomRequest/);
  assert.match(client, /createClassroom/);
  assert.match(client, /joinTeacherClassroom/);
  assert.match(client, /copyStudentClassroomLink/);
  assert.match(client, /submitTemporaryClassroom/);
  assert.match(client, /prepareTemporaryClassroomLink/);
  assert.match(client, /立即开临时课堂/);
  assert.match(client, /排课已自动关联网上教室/);
  assert.match(client, /source: "临时课堂"/);
  assert.match(client, /endClassroom/);
  assert.match(client, /classroom:\s*\{\s*meetingId: `yinling-\$\{bookingId\}`/);
  assert.match(client, /window\.setInterval\(poll, 15000\)/);
  assert.match(client, /BiggerBlueButton 托管课堂/);
  assert.match(client, /自动录播/);
  assert.match(client, /正在连接网上教室/);
  assert.match(client, /通常需要 10–30 秒/);
  assert.match(client, /首次进入请允许浏览器使用麦克风和摄像头/);
  assert.match(client, /window\.location\.assign\(result\.url\)/);
  assert.doesNotMatch(client, /进入 Demo 教室/);
  assert.doesNotMatch(client, /Demo 网上教室/);
  assert.match(route, /getDemoSessionUser/);
  assert.match(route, /getOpsState\(\["students", "teachers", "bookings"\]\)/);
  assert.match(route, /filterOpsStateRows/);
  assert.match(route, /meetingIdForBooking\(bookingId\)/);
  assert.match(route, /body\.action === "teacher-join"/);
  assert.match(route, /body\.action === "student-link"/);
  assert.doesNotMatch(route, /body\.meetingId/);
  assert.match(bbb, /import "server-only"/);
  assert.match(bbb, /createHash\("sha1"\)/);
  assert.match(bbb, /XMLParser/);
  assert.match(bbb, /autoStartRecording: true/);
  assert.match(bbb, /meetingIdForBooking/);
  assert.match(css, /\.classroom-recording-pending/);
  assert.match(css, /\.classroom-share-link/);
  assert.match(legacyPage, /redirect\("\/"\)/);
  assert.equal(packageJson.dependencies["fast-xml-parser"], "^5.10.1");
});

test("records renewal outcomes, preserves prior contact time and archives FU screenshots securely", async () => {
  const [client, store, uploadRoute, downloadRoute, migration, css] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../lib/ops-store.ts"),
    read("../app/api/fu-attachments/route.ts"),
    read("../app/api/fu-attachments/[id]/route.ts"),
    read("../supabase/migrations/20260728_add_student_fu_attachments.sql"),
    read("../app/globals.css"),
  ]);

  assert.match(client, /type RenewalStatus = .*"本次未跟进"/);
  assert.match(client, /lastAttemptAt\?: string/);
  assert.match(client, /lastContactedAt\?: string/);
  assert.match(client, /renewal\.status === "本次未跟进"/);
  assert.match(client, /lastContactedAt: contacted \? attemptedAt : renewalDraft\.lastContactedAt/);
  assert.match(client, /student && isActiveStudent\(student\)/);
  assert.match(client, /addAudit\(\s*"记录续课跟进"/);
  assert.match(client, /fetch\("\/api\/fu-attachments"/);
  assert.match(client, /type: "续课 FU"/);
  assert.match(client, /聊天记录截图（可选）/);
  assert.match(store, /putStudentFuAttachment/);
  assert.match(store, /getStudentFuAttachment/);
  assert.match(uploadRoute, /getDemoSessionUser/);
  assert.match(uploadRoute, /MAX_IMAGE_BYTES = 4 \* 1024 \* 1024/);
  assert.match(uploadRoute, /ALLOWED_IMAGE_TYPES/);
  assert.match(downloadRoute, /getDemoSessionUser/);
  assert.match(downloadRoute, /canAccessStudent/);
  assert.match(downloadRoute, /Cache-Control": "private, no-store"/);
  assert.match(migration, /student_fu_attachments enable row level security/);
  assert.match(migration, /perform internal\.verify_ops_secret\(p_secret\)/);
  assert.match(migration, /revoke all on table internal\.student_fu_attachments from anon, authenticated/);
  assert.match(css, /\.renewal-status-cell/);
  assert.match(css, /\.upload-field/);
});

test("covers the July 28 and 29 scheduling, LP, AVA and student record changes", async () => {
  const [client, css] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
  ]);

  assert.match(client, /repeatCount\?: number/);
  assert.match(client, /booking\.repeatCount == null \? Number\.POSITIVE_INFINITY/);
  assert.match(client, /const validationCount = recurring \? \(repeatCount \?\? 104\) : 1/);
  assert.match(client, /const proposedDates = Array\.from\(\{ length: validationCount \}/);
  assert.match(client, /const scheduleOccurrences = scopedBookings/);
  assert.match(client, /bookingOccurrencesWithinRange\(booking, shiftIsoDate\(weekDays\[0\]\.date, -1\)/);
  assert.match(client, /isoDateInTimezone\(bookingInstant\(booking\), "Australia\/Melbourne"\) === todayDate/);
  assert.match(client, /const displayedBooking = currentScheduleScope\.find/);
  assert.match(client, /bookingHasDstRisk\(displayedBookingSeries/);
  assert.match(client, /周期课会整组更新/);
  assert.match(client, /const conflictDate = proposedDates\.find/);
  assert.match(client, /const unavailableDate = proposedDates\.find/);
  assert.match(client, /!teacherAvailableAt\(/);
  assert.match(client, /本轮排课节数/);
  assert.match(client, /批量更新课程/);
  assert.match(client, /设为已完成/);
  assert.match(client, /学生请假/);
  assert.match(client, /老师请假/);
  assert.match(client, /启动代课/);
  assert.match(client, /sourceBookingId: booking\.id/);
  assert.match(client, /!substitution \|\| booking\.studentId === studentId/);
  assert.match(client, /\{!isTeacherView && <>/);
  assert.match(client, /选择可代课老师/);
  assert.match(client, /setLpStage/);
  assert.match(client, /retreatLp/);
  assert.match(client, /试听、二次试听和直报可先不填姓名/);
  assert.match(client, /if \(!isAdminView\) \{\s*notify\("无姓名临时建档需要管理员处理/);
  assert.match(client, /\{isAdminView && <>/);
  assert.match(client, /姓名待补/);
  assert.match(client, /规划老师/);
  assert.match(client, /负责教务/);
  assert.match(client, /上传沟通或家长反馈/);
  assert.match(client, /type: "课堂反馈"/);
  assert.match(client, /本周/);
  assert.match(client, /本月/);
  assert.match(client, /下月/);
  assert.match(client, /修改固定可约时段/);
  assert.match(client, /删除固定可约时段/);
  assert.match(client, /浅绿色为可约，灰色为已排课/);
  assert.match(css, /\.agenda-select-grid/);
  assert.match(css, /\.booking-action-grid/);
  assert.match(css, /\.lp-card-actions/);
  assert.match(css, /\.ava-month-grid/);
  assert.match(css, /\.ava-booked/);
  assert.match(client, /历史课程不能重新开课/);
  assert.match(client, /当前筛选没有匹配课程[\s\S]*新建约课/);
  assert.match(client, /当前课程缺少有效关联[\s\S]*新建约课/);
  assert.match(client, /requestConfirmation/);
  assert.match(client, /<form onSubmit=\{\(event\) => \{ event\.preventDefault\(\); void confirmRequestedAction\(\); \}\}>/);
  assert.match(client, /type="submit" disabled=\{confirmBusy\}>\{confirmBusy/);
  assert.match(client, /actionLabel: undo \? translateInterfaceText\("撤销", displayPreferences\.language\)/);
  assert.match(client, /current\?\.id === toastId/);
});
