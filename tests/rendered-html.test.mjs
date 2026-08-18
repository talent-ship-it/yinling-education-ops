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
  assert.match(auth, /role: "staff"/);
  assert.doesNotMatch(auth, /DEMO_ACCOUNT_PASSWORD_HASHES/);
  assert.doesNotMatch(auth, /process\.env\.NODE_ENV !== "production"/);
  assert.doesNotMatch(auth, /DEMO_PASSWORD/);
  assert.doesNotMatch(auth, /candidate[^\n]*===\s*["']admin["']/i);
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
  assert.match(client, /new Set\(\[task\.owner, \.\.\.\(task\.assignees \?\? \[\]\), \.\.\.\(task\.watchers \?\? \[\]\)\]\)\.has\(currentOperator\)/);
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
  assert.match(client, /\.\.\.recordTeachers\.map\(\(teacher\) => teacher\.name\)/);
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
  assert.match(demoLogin, /resolveDemoIdentity/);
  assert.match(demoLogin, /identity\.user === DEMO_ADMIN_USER/);
  assert.match(demoLogin, /maxAge: 0/);
  assert.match(demoLogin, /resolveTeacherIdentity/);
  assert.match(demoLogin, /pinned && pinned\.role !== "staff"/);
  assert.match(demoLogin, /resolveTeacherIdentity\(candidate, teacherRow\.payload\)/);
  assert.match(demoSession, /getCurrentDemoSession/);
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
  assert.match(nixonLogin, /getCurrentDemoSession/);
  assert.doesNotMatch(nixonLogin, /maxAge/);
  assert.doesNotMatch(client, /Admin Lite/);
});

test("revalidates roster-backed teacher sessions on every protected API", async () => {
  const routes = [
    "../app/api/app-snapshot/route.ts",
    "../app/api/app-state/route.ts",
    "../app/api/audit/route.ts",
    "../app/api/bookings/mutate/route.ts",
    "../app/api/classroom/route.ts",
    "../app/api/fu-attachments/route.ts",
    "../app/api/fu-attachments/[id]/route.ts",
    "../app/api/lesson-occurrences/complete/route.ts",
    "../app/api/nixon-login/route.ts",
    "../app/api/nixon-session/route.ts",
    "../app/api/operations/confirm/route.ts",
    "../app/api/student-import/route.ts",
    "../app/api/student-import/source-rows/route.ts",
    "../app/api/teacher-availability/review/route.ts",
  ];
  const sources = await Promise.all(routes.map(read));
  for (const source of sources) {
    assert.match(source, /getCurrentDemoSession/);
    assert.doesNotMatch(source, /\bgetDemoSession\(/);
  }

  const [auth, login] = await Promise.all([
    read("../lib/demo-auth.ts"),
    read("../app/api/demo-login/route.ts"),
  ]);
  assert.match(auth, /getOpsState\(\["teachers"\]\)/);
  assert.match(auth, /validateTeacherSession/);
  assert.match(login, /getOpsState\(\["teachers"\]\)/);
  assert.match(login, /pinned && pinned\.role !== "staff"/);
});

test("retains core operations workflows and responsive UI", async () => {
  const [client, css, packageJson, devServer, tasks, toDoList] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
    read("../package.json").then(JSON.parse),
    read("../scripts/dev-fixed-port.mjs"),
    read("../lib/ops-tasks.ts"),
    read("../app/to-do-list.tsx"),
  ]);

  for (const contract of [
    "scheduleConflict",
    "createLpWorkflow",
    "generateTrialEscalationTasks",
    "generateTrialRequestTasks",
    "linkTrialRequestTasksToBooking",
    "reconcileTrialBookingTasks",
    "closeTasksForBooking",
    "ToDoList",
    "renderOperations",
    "renderRenewals",
    "renderPayroll",
    "renderFiles",
    "renderReports",
    "renderSettings",
    "renderAudit",
    "TeacherAvailabilityPanel",
    "bookingHasDstRisk",
    "examReminderStudents",
  ]) assert.match(client, new RegExp(contract));

  for (const field of ["ruleKey", "dueAt", "anchorBookingId"]) {
    assert.match(tasks, new RegExp(`${field}\\?: string`));
  }
  for (const ruleKey of [
    "trial.parent-follow-up",
    "trial.scheduling",
    "trial.lp-review",
    "trial.prep",
    "trial.minimum",
  ]) assert.match(tasks, new RegExp(ruleKey.replace(".", "\\.")));
  assert.match(tasks, /FIXED_REMINDER_RULES\.parentSpecifiedContentDaysAfterRequest/);
  assert.match(tasks, /FIXED_REMINDER_RULES\.schedulingFeedbackHoursAfterRequest \* TASK_SPACING_MS/);
  assert.match(tasks, /-FIXED_REMINDER_RULES\.lpReviewDaysBeforeTrial/);
  assert.match(tasks, /-FIXED_REMINDER_RULES\.preparationDaysBeforeTrial/);
  assert.match(tasks, /-FIXED_REMINDER_RULES\.minimumDaysBeforeTrial/);
  assert.match(tasks, /export function statusForDueAt/);
  assert.match(tasks, /export function sortTasksByDueAt/);
  assert.match(tasks, /export function upsertTaskByRule/);
  assert.match(tasks, /id: existing\.id/);
  assert.match(tasks, /export function linkTrialRequestTasksToBooking/);
  assert.match(tasks, /TRIAL_SCHEDULED_ESCALATION_CLOSED_RESULT/);
  assert.match(client, /parentProgressSyncCount: 1/);
  assert.match(client, /trial\\\.parent-progress-sync/);
  assert.match(tasks, /id: canonicalRequest\.id/);
  assert.match(tasks, /export function closeTasksForBooking/);
  assert.match(tasks, /export function restoreTrialRequestTasksToWorkflow/);
  assert.match(client, /setTasks\(\(current\) => sortTasksByDueAt\(upsertTasksByRule\(current, generated\)\)\)/);
  assert.match(client, /if \(isTeacherView\) \{\s*notify\("老师账号不能删除排课，请联系负责教务处理"\)/);
  assert.match(client, /onConfirm: async \(\) => \{\s*await writeBookingCapacityMutation\(\{ action: "delete", bookingId: booking\.id \}\)/);
  assert.match(client, /kind !== "代课" && firstTeacherStudentBooking/);
  assert.match(client, /<ToDoList tasks=\{visibleTasks\}/);
  assert.match(toDoList, /TO_DO_FILTERS = \["all", "LP", "考试", "续课", "请假代课"\]/);
  assert.match(toDoList, /title="今日到期"/);
  assert.match(toDoList, /title="已逾期"/);
  assert.match(toDoList, /sortTasksByDueAt/);
  assert.match(toDoList, /\{task\.due\}/);

  assert.match(css, /--brand:#75C9C2/);
  assert.match(client, /teacherTotalHours/);
  assert.match(client, /function availabilitySummary/);
  assert.match(client, /teacher-source-evidence/);
  assert.match(client, /腾讯表原始记录（仅供人工结构化）/);
  assert.match(client, /const teacherPageSize = 8/);
  assert.match(client, /本月未收集/);
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
  assert.match(css, /\.account-admin-layout \.collection-head,[\s\S]*?min-width:0/);
  assert.match(css, /@media \(min-width:761px\) and \(max-width:1399px\)[\s\S]*?\.student-collection \.master-detail-layout/);
  assert.match(css, /@media \(max-width:760px\)[\s\S]*?\.fixed-rule-grid,[\s\S]*?\.kanban-board/);
  assert.match(client, /RULE_OPTIONS\.lowHours\.map/);
  assert.match(client, /RULE_OPTIONS\.examDays\.map/);
  assert.match(client, /disabled=\{!rulesDraftTouched \|\| rulesDraftStale\}/);
  assert.match(client, /writeRulesVersion\(displayedRules, rulesDraftBaseVersion\)/);
  assert.match(client, /writeRulesVersion\(previousRules, saved\.version\)/);
  assert.match(client, /response\.status === 409 && body\.current/);
  assert.doesNotMatch(client, /displayedRules\.(?:lpDays|feedbackHours|renewalDays|escalation)/);
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
  assert.match(client, /教务宝同步/);
  assert.match(client, /教务宝剩余 \/ 当前总课时/);
  assert.match(client, /disabled=\{bookingFormKind !== "试听" && balance <= 0\}/);
  assert.match(client, /disabled=\{balance <= 0\}/);
  assert.doesNotMatch(client, /课时与合约数据来自只读镜像；本系统不会回写教务宝/);
  assert.match(client, /useState<"month" \| "week" \| "agenda">\("month"\)/);
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
  assert.match(client, /已关联网上教室/);
  assert.match(client, /writeBookingCapacityMutation\(\{ action: "upsert", bookingId, booking \}\)/);
  assert.match(client, /name="packageId" required/);
  const temporarySubmit = client.slice(client.indexOf("const submitTemporaryClassroom"), client.indexOf("const endClassroom"));
  assert.doesNotMatch(temporarySubmit, /setBookings\(/);
  assert.match(client, /endClassroom/);
  assert.match(client, /occurrenceId: occurrence\.occurrenceKey/);
  assert.match(client, /occurrenceId: booking\.occurrenceKey/);
  assert.doesNotMatch(client, /meetingId: `yinling-\$\{bookingId\}`/);
  assert.match(client, /window\.setInterval\(poll, 15000\)/);
  assert.match(client, /BiggerBlueButton 托管课堂/);
  assert.match(client, /自动录播/);
  assert.match(client, /正在连接网上教室/);
  assert.match(client, /通常需要 10–30 秒/);
  assert.match(client, /首次进入请允许浏览器使用麦克风和摄像头/);
  assert.match(client, /window\.location\.assign\(result\.url\)/);
  assert.doesNotMatch(client, /进入 Demo 教室/);
  assert.doesNotMatch(client, /Demo 网上教室/);
  assert.match(route, /getCurrentDemoSession/);
  assert.match(route, /getOpsState\(\["students", "teachers", "bookings"\]\)/);
  assert.match(route, /filterOpsStateRows/);
  assert.match(route, /meetingIdForOccurrence\(occurrenceId\)/);
  assert.match(route, /role: "MODERATOR", userId: teacherId/);
  assert.match(route, /body\.action === "teacher-join"/);
  assert.match(route, /body\.action === "student-link"/);
  assert.doesNotMatch(route, /body\.meetingId/);
  assert.match(bbb, /import "server-only"/);
  assert.match(bbb, /createHash\("sha1"\)/);
  assert.match(bbb, /XMLParser/);
  assert.match(bbb, /autoStartRecording: true/);
  assert.match(bbb, /meetingIdForOccurrence/);
  assert.match(css, /\.classroom-recording-pending/);
  assert.match(css, /\.classroom-share-link/);
  assert.match(legacyPage, /redirect\("\/"\)/);
  assert.equal(packageJson.dependencies["fast-xml-parser"], "^5.10.1");
});

test("settles a concrete ended lesson occurrence only through the server contract", async () => {
  const client = await read("../app/operations-client.tsx");

  assert.match(client, /modal === "lessonSettlement"/);
  assert.match(client, /occurrenceId: lessonSettlementDraft\.occurrenceKey/);
  assert.match(client, /expectedVersion: bookingsShared\.version/);
  assert.match(client, /overrideReason/);
  assert.match(client, /fetch\("\/api\/lesson-occurrences\/complete"/);
  assert.match(client, /window\.location\.reload\(\)/);
  assert.doesNotMatch(client, /setBookings\([^;]*lessonSettlementDraft/s);
});

test("records renewal outcomes, preserves prior contact time and archives FU screenshots securely", async () => {
  const [client, store, uploadRoute, downloadRoute, migration, pdfMigration, css] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../lib/ops-store.ts"),
    read("../app/api/fu-attachments/route.ts"),
    read("../app/api/fu-attachments/[id]/route.ts"),
    read("../supabase/migrations/20260728_add_student_fu_attachments.sql"),
    read("../supabase/migrations/20260812220509_allow_pdf_student_fu_attachments.sql"),
    read("../app/globals.css"),
  ]);

  assert.match(client, /type RenewalStatus = .*"本次未跟进"/);
  assert.match(client, /lastAttemptAt\?: string/);
  assert.match(client, /lastContactedAt\?: string/);
  assert.match(client, /renewal\.status === "本次未跟进"/);
  assert.match(client, /lastContactedAt: contacted \? attemptedAt : renewalDraft\.lastContactedAt/);
  assert.match(client, /renewalStatusForPackage\(renewalStatusRecords/);
  assert.match(client, /scopeStudentIds\.push\(student\.id\)/);
  assert.match(client, /mapLessonPackageDepletionEstimates\(packages, projectedOccurrences/);
  assert.match(client, /normalizeRenewalBusinessStatus\(renewal\.status\)/);
  assert.match(client, /getLatestStudentFollowUp\(student\?\.followUpHistory \?\? \[\]\)/);
  assert.match(client, /appendStudentFollowUp\(item\.followUpHistory \?\? \[\], followUp\)/);
  assert.match(client, /addAudit\(\s*"记录续课跟进"/);
  assert.match(client, /fetch\("\/api\/fu-attachments"/);
  assert.match(client, /upload\.set\("fileType", "续课 FU"\)/);
  assert.match(client, /聊天记录截图（可选）/);
  assert.match(store, /putStudentFuAttachmentAtomic/);
  assert.match(store, /getStudentFuAttachment/);
  assert.match(uploadRoute, /getCurrentDemoSession/);
  assert.match(uploadRoute, /MAX_STUDENT_ATTACHMENT_BYTES/);
  assert.match(uploadRoute, /isStudentAttachmentContentType/);
  assert.match(uploadRoute, /hasStudentAttachmentMagicBytes/);
  assert.match(uploadRoute, /application\/pdf|studentAttachmentKind/);
  assert.match(downloadRoute, /getCurrentDemoSession/);
  assert.match(downloadRoute, /canAccessStudent/);
  assert.match(downloadRoute, /Cache-Control": "private, no-store"/);
  assert.match(migration, /student_fu_attachments enable row level security/);
  assert.match(migration, /if not internal\.verify_ops_secret\(p_secret\) then/);
  assert.doesNotMatch(migration, /perform internal\.verify_ops_secret\(p_secret\)/);
  assert.match(migration, /revoke all on table internal\.student_fu_attachments from anon, authenticated/);
  assert.match(pdfMigration, /application\/pdf/);
  assert.match(pdfMigration, /octet_length\(decoded\) > 4194304/);
  assert.match(pdfMigration, /if not internal\.verify_ops_secret\(p_secret\) then/);
  assert.doesNotMatch(pdfMigration, /perform internal\.verify_ops_secret\(p_secret\)/);
  assert.match(css, /\.renewal-status-cell/);
  assert.match(css, /\.upload-field/);
});

test("covers current scheduling, LP, AVA and student record changes", async () => {
  const [client, css, lpWorkflows, lpFields] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/globals.css"),
    read("../lib/lp-workflows.ts"),
    read("../app/lp-workflow-fields.tsx"),
  ]);

  assert.match(client, /repeatCount\?: number/);
  assert.match(client, /expandLessonOccurrences\(booking/);
  assert.match(client, /const validationCount = recurring \? \(repeatCount \?\? 104\) : 1/);
  assert.match(client, /const proposedDates = Array\.from\(\{ length: validationCount \}/);
  assert.match(client, /const weekOccurrences = scopedBookings/);
  assert.match(client, /bookingOccurrencesWithinRange\(booking, shiftIsoDate\(weekDays\[0\]\.date, -1\)/);
  assert.match(client, /isoDateInTimezone\(bookingInstant\(booking\), "Australia\/Melbourne"\) === todayDate/);
  assert.match(client, /const displayedBooking = currentScheduleScope\.find/);
  assert.match(client, /bookingHasDstRisk\(displayedBookingSeries/);
  assert.match(client, /const conflictDate = proposedDates\.find/);
  assert.match(client, /const unavailableDate = proposedDates\.find/);
  assert.match(client, /!teacherAvailableAt\(/);
  assert.match(client, /availabilityWindows\?: TeacherAvailabilityWindow\[\]/);
  assert.match(client, /expandTeacherAvailability\(teacher\.availabilityWindows/);
  assert.doesNotMatch(client, /function TeacherAvaBoard/);
  assert.match(client, /本轮排课节数/);
  assert.match(client, /学生请假/);
  assert.match(client, /老师请假/);
  assert.match(client, /启动代课/);
  assert.match(client, /sourceBookingId: booking\.id/);
  assert.match(client, /!substitution \|\| booking\.studentId === studentId/);
  assert.match(client, /\{!isTeacherView && <>/);
  assert.match(client, /选择可代课老师/);
  for (const workflowType of [
    "试听 LP",
    "老师新 LP",
    "老师 LP 修改",
    "换老师试听",
    "代课 LP",
    "学生直报（无试听）",
    "学生报名交接",
  ]) assert.match(lpWorkflows, new RegExp(workflowType));
  assert.match(lpWorkflows, /LP_STAGES = \["待资料", "写作中", "待审核", "需修改", "已发老师", "待备课确认", "完成"\]/);
  assert.match(lpWorkflows, /export function reviseLpWorkflow/);
  assert.match(lpWorkflows, /export function changeLpStage/);
  assert.match(lpFields, /export function parseLpWorkflowFormData/);
  assert.match(lpFields, /export function LpWorkflowFields/);
  assert.match(lpFields, /export function LpWorkflowDetails/);
  assert.match(lpFields, /export function LpRevisionHistory/);
  assert.match(client, /<LpWorkflowFields/);
  assert.match(client, /<LpWorkflowDetails/);
  assert.match(client, /<details className="span-2" open>/);
  assert.match(client, /parsedLp\.fields as unknown as LpFieldValues/);
  assert.match(client, /const revised = reviseLpWorkflow/);
  assert.match(client, /const changed = changeLpStage/);
  assert.match(client, /lpFilter === "revision" \? item\.stage === "需修改"/);
  assert.match(client, /<LpRevisionHistory/);
  assert.match(client, /name="guardianWechat"/);
  assert.match(client, /name="provisionalGuardianWechat"/);
  assert.doesNotMatch(client, /name="provisionalName"/);
  assert.doesNotMatch(client, /name="guardian"/);
  assert.match(client, /canAdd=\{!isTeacherView && selectedStudent\.importArchived !== true\}/);
  assert.match(client, /isTeacherView \|\| selectedStudent\?\.importArchived/);
  assert.match(client, /id: "archived", label: .*"历史归档"/);
  assert.match(client, /历史归档只读/);
  assert.match(client, /历史业务记录/);
  assert.match(client, /readableScopedOperations/);
  assert.match(client, /readableScopedRenewals/);
  assert.match(client, /bookingOccurrencesWithinRange\([\s\S]*true/);
  assert.match(client, /readOnly=\{visibleSelectedStudent\.importArchived === true\}/);
  assert.match(client, /student\.importArchived \? "历史归档" : "学生"/);
  assert.match(client, /openStudentRecord\(visibleSelectedStudent\.id, section\)/);
  assert.match(client, /直报录入课时/);
  assert.match(client, /暂未有学生姓名，先按科目创建临时档案/);
  assert.match(client, /if \(!isAdminView\) \{\s*notify\("无姓名临时建档需要管理员处理/);
  assert.match(client, /\{isAdminView && <>/);
  assert.match(client, /姓名待补/);
  assert.match(client, /规划老师/);
  assert.match(client, /负责教务/);
  assert.match(client, /上传沟通或家长反馈/);
  assert.match(client, /"课堂反馈"/);
  assert.match(client, /TeacherAvailabilityPanel/);
  assert.match(client, /normalizeLegacyAvailability/);
  assert.match(client, /promoteLegacyAvailabilityForMonth/);
  assert.match(client, /legacySlots=\{visibleSelectedTeacher\.availabilitySlots \?\? \[\]\}/);
  assert.match(client, /onPromoteLegacy=\{\(month\) => promoteLegacyTeacherAvailability/);
  assert.match(client, /本月/);
  assert.match(client, /下月/);
  assert.match(client, /editTeacherAvailability/);
  assert.match(client, /deleteTeacherAvailability/);
  assert.doesNotMatch(client, /浅绿色为可约，灰色为已排课/);
  assert.match(css, /\.agenda-select-grid/);
  assert.match(css, /\.booking-action-grid/);
  assert.match(css, /\.lp-card-actions/);
  assert.match(css, /\.ava-month-grid/);
  assert.match(css, /\.ava-booked/);
  assert.match(client, /历史课程不能重新开课/);
  assert.match(client, /title="当前筛选下没有排课"[\s\S]*新建约课/);
  assert.match(client, /title="课程关联资料不完整"[\s\S]*新建约课/);
  assert.match(client, /requestConfirmation/);
  assert.match(client, /<form onSubmit=\{\(event\) => \{ event\.preventDefault\(\); void confirmRequestedAction\(\); \}\}>/);
  assert.match(client, /type="submit" disabled=\{confirmBusy\}>\{confirmBusy/);
  assert.match(client, /actionLabel: undo \? translateInterfaceText\("撤销", displayPreferences\.language\)/);
  assert.match(client, /current\?\.id === toastId/);
});

test("wires controlled raw JWB and two-workbook teacher imports into the sync workspace", async () => {
  const [client, studentSourceRoute, teacherRoute, teacherSourceRoute, teacherIdentityRoute, studentService, teacherService] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/api/student-import/source-rows/route.ts"),
    read("../app/api/teacher-import/route.ts"),
    read("../app/api/teacher-import/source/route.ts"),
    read("../app/api/teacher-import/identity-links/route.ts"),
    read("../lib/student-import-service.ts"),
    read("../lib/teacher-import-service.ts"),
  ]);

  assert.doesNotMatch(client, /studentJwbSourceFormat/);
  assert.match(client, /jiaowubao-api-v2/);
  assert.doesNotMatch(client, /系统标准 rows/);
  assert.match(client, /逐课程余额/);
  assert.match(client, /studentJwbNegativePolicy/);
  assert.match(client, /仅保留净余额，不创建该生课包/);
  assert.match(client, /fetch\("\/api\/student-import\/source-rows"/);
  assert.match(client, /fetch\("\/api\/student-import\/source-rows", \{ cache: "no-store" \}\)/);
  assert.match(client, /body\.ready !== true/);
  assert.match(client, /setStudentImportSourceStatus\(nextStatus\)/);
  assert.match(client, /fetch\("\/api\/student-import\/identity-links"/);
  assert.match(client, /JSON\.stringify\(\{ resolutionKey: clearKey, decision: "clear" \}\)/);
  assert.match(client, /masterToken: studentIdentityManualMasterToken/);
  assert.match(client, /jwbToken: studentIdentityManualJwbToken/);
  assert.doesNotMatch(client, /JSON\.stringify\(\{ links:/);
  assert.match(client, /fetch\("\/api\/teacher-import\/source"/);
  assert.match(client, /fetch\("\/api\/teacher-import"/);
  assert.match(client, /同表重名都必须逐项选择合并或分开/);
  assert.match(client, /科目行归属待确认/);
  assert.match(client, /请选择 roster 归属或明确忽略/);
  assert.doesNotMatch(client, /name="(?:teacherSubjectResolution|subjectOwner)"[^>]*<input/);
  assert.match(client, /预检两份教师来源/);
  assert.match(client, /option.label/);
  assert.match(client, /JSON\.stringify\(\{ resolutionKey, decision \}\)/);
  assert.match(client, /保留原文，不生成月度时段/);
  assert.match(client, /保留原文，不猜可接人数/);
  assert.match(studentSourceRoute, /putStudentImportSourceRows/);
  assert.match(studentService, /adaptJiaowubaoImportRows/);
  assert.match(studentService, /negativeAdjustmentPolicy/);
  assert.match(teacherSourceRoute, /putTeacherImportSource/);
  assert.match(teacherRoute, /commitTeacherImportPlanAtomic/);
  assert.match(teacherIdentityRoute, /resolveTeacherIdentityCandidate/);
  assert.match(teacherIdentityRoute, /putTeacherImportIdentityLink/);
  assert.match(teacherService, /prepareTeacherImport/);
});

test("presents master-authoritative students without JWB separately from unresolved JWB ledgers", async () => {
  const [client, recordsPanel] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/student-records-panel.tsx"),
  ]);

  assert.match(client, /jwbMatchStatus\?: "matched" \| "unmatched" \| "ambiguous"/);
  assert.match(client, /腾讯总表已建档；课时和课包暂为空/);
  assert.match(client, /腾讯总表有效档案 · 未关联教务宝资料/);
  assert.match(client, /腾讯总表有效档案 · 多个教务宝候选待核对/);
  assert.match(client, /historicalJwbSnapshot\?: StudentHistoricalJwbSnapshot/);
  assert.match(client, /仅作为只读历史证据，不能用于排课或扣课/);
  assert.match(client, /hasActiveLessonPackages/);
  assert.match(client, /现有可用课包已单独保留，仍可用于排课或扣课/);
  assert.match(client, /hasVerifiedActiveJwbPackages/);
  assert.match(client, /当前可核对课包仍可使用；历史快照仅独立保留供核验/);
  assert.match(client, /学号日期：系统建档日期/);
  assert.match(client, /腾讯学生总表是唯一学生档案来源/);
  assert.match(client, /formalImportDate: string/);
  assert.match(client, /学号使用正式导入日期/);
  assert.match(client, /仅在教务宝、未出现在总表的旧账号不会自动建档/);
  assert.match(recordsPanel, /腾讯总表已建档，暂未关联教务宝资料；课时和课包暂为空/);
  assert.match(recordsPanel, /腾讯总表已建档，教务宝有多个候选待核对；当前不采用任何候选，课时和课包暂为空/);
  assert.match(recordsPanel, /历史待核验 · 不可用于排课或扣课/);
  assert.match(recordsPanel, /studentHistoricalJwbSnapshotEvidence/);
  assert.match(recordsPanel, /hasHistoricalJwbFacts/);
  assert.match(recordsPanel, /教务宝当前余额已保留，但缺少可核对的逐课程购买历史，尚未建立课包/);
  assert.match(recordsPanel, /当前仅显示有购买历史可核对的课包；其余课程余额仍保留在教务宝汇总中/);
});
