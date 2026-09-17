import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end >= 0, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("administrator system pages keep visible controls connected to their boundaries", async () => {
  const client = await read("../app/operations-client.tsx");
  const accountWorkspace = await read("../app/account-lifecycle-workspace.tsx");
  const accountLifecycle = await read("../app/account-admin-lifecycle.tsx");
  const sync = section(client, "  const renderSync = () =>", "  const renderReports = () =>");
  const reports = section(client, "  const renderReports = () =>", "  const renderSettings = () =>");
  const settings = section(client, "  const renderSettings = () =>", "  const renderAudit = () =>");
  const audit = section(client, "  const renderAudit = () =>", "  const renderClassroom = () =>");
  const accounts = section(client, "  const renderAccounts = () =>", "  const renderView = () =>");
  const reportExport = section(client, "  const exportReport = () =>", "  const classroomRequest =");

  assert.match(sync, /canUseAdminScope/);
  for (const handler of [
    "refreshSourceStatus",
    "previewStudentImport",
    "commitStudentImport",
    "submitStudentImportSource",
    "refreshStudentIdentityReview",
    "refreshStudentIdentityAnnotationReview",
    "confirmStudentIdentityReview",
    "confirmStudentIdentityManualPair",
    "confirmStudentMasterResolution",
    "previewTeacherImport",
    "commitTeacherImport",
    "submitTeacherImportSource",
    "confirmTeacherIdentityResolution",
  ]) assert.match(sync, new RegExp(handler));
  assert.match(sync, /EmptyState title="尚未预检"/);
  assert.match(sync, /sourceKind === "jwb" \? <div className="form-notice"/);
  assert.match(client, /if \(rawJwb\) \{\s*throw new Error\("教务宝原始快照必须通过分块 staging 导入/);
  assert.match(client, /fetch\("\/api\/student-import\/source-rows"/);
  assert.match(client, /fetch\("\/api\/teacher-import\/source"/);

  assert.match(reports, /onChange=\{\(event\) => setReportOwner/);
  assert.match(reports, /onClick=\{exportReport\}/);
  assert.doesNotMatch(reports, /onClick=\{exportDemo\}/);
  assert.match(client, /const exportReport = \(\) =>/);
  assert.match(client, /buildOperationsReportExport/);
  assert.match(client, /operationsReportFilename/);
  assert.match(reportExport, /if \(!canUseAdminScope \|\| !isAdminView\) return/);
  assert.doesNotMatch(reportExport, /payroll|payrollState|rules|audit/);
  assert.match(reports, /pendingReportTasks/);
  assert.match(reports, /pendingOperationsTaskWorkload/);
  assert.match(reports, /operationsReportOwnerOptions/);
  assert.doesNotMatch(reports, /Math\.max\(12/);
  assert.match(reports, /当前筛选下没有待处理任务/);
  assert.match(reports, /value=\{`\$\{activeTeachers\}\/\$\{recordTeachers\.length\}`\}/);

  assert.match(settings, /onChange=\{setSettingsTab\}/);
  assert.match(settings, /writeRulesVersion\(displayedRules, rulesDraftBaseVersion\)/);
  assert.match(settings, /onClick=\{resetDemo\}/);
  assert.match(settings, /onClick=\{exportDemo\}/);
  assert.match(client, /fetch\("\/api\/app-state"/);

  assert.match(accounts, /<AccountLifecycleWorkspace/);
  assert.match(client, /staffSectionIds = new Set<Section>\(\[[^\]]*"accounts"\]\)/);
  assert.match(client, /teacherSectionIds = new Set<Section>\(\[[^\]]*"accounts"\]\)/);
  assert.match(accounts, /canManageAccounts=\{isAdminSession\}/);
  assert.match(accounts, /refreshVersion=\{accountLifecycleRefreshVersion\}/);
  assert.match(accounts, /onResetPassword=\{\(account: AccountDirectoryRecord\) =>/);
  assert.match(accounts, /onViewAccount=\{\(account: AccountDirectoryRecord\) => switchOperator\(account\.account_name, account\.account_role\)\}/);
  assert.match(accountWorkspace, /onUpdateAccess=\{\(change\) => void updateAccess\(change\)\}/);
  assert.match(accountWorkspace, /onSetStatus=\{\(change\) => void updateStatus\(change\)\}/);
  assert.match(accountWorkspace, /onRevokeSessions=\{\(account\) => void revokeSelectedSessions\(account\)\}/);
  assert.match(accountWorkspace, /onResetMfa=\{\(account\) => void resetSelectedMfa\(account\)\}/);
  assert.match(accountWorkspace, /handledRefreshVersionRef\.current === refreshVersion/);
  assert.match(accountWorkspace, /const accountId = await loadDirectory\(selectedAccountId\);/);
  assert.match(accountWorkspace, /if \(accountId\) await loadSelectedAccount\(accountId\);/);
  assert.ok(accountWorkspace.indexOf("await loadDirectory(selectedAccountId)") < accountWorkspace.indexOf("await loadSelectedAccount(accountId)"));
  assert.match(client, /setAccountLifecycleRefreshVersion\(\(current\) => current \+ 1\)/);
  assert.match(accountLifecycle, /onClick=\{\(\) => \{ setInternalSelectedId\(account\.account_id\); onSelectAccount\?\.\(account\.account_id\); \}\}/);
  assert.match(accountLifecycle, /onClick=\{\(\) => onViewAccount\(account\)\}/);

  assert.match(audit, /onChange=\{\(value\) => \{/);
  assert.match(audit, /onQuery=\{\(value\) => \{/);
  assert.match(audit, /onClick=\{\(\) => exportAudit\(filteredAudit\)\}/);
  assert.doesNotMatch(audit, /onClick=\{exportDemo\}/);
  assert.match(audit, /buildAuditView\(audit, auditQuery, auditFilter, auditPage, operatorLabel\)/);
  assert.match(client, /fetch\("\/api\/audit", \{ cache: "no-store" \}\)/);
  assert.match(client, /setAudit\(body\.entries as AuditEntry\[\]\)/);
  assert.doesNotMatch(client, /JSON\.stringify\(\{ action, detail: auditDetail, tone \}\)/);
  assert.match(audit, /EmptyState[\s\S]*没有审计记录/);

  const auditExport = section(client, "  const exportAudit = (entries: readonly AuditEntry[]) =>", "  const exportReport = () =>");
  assert.match(auditExport, /audit: entries/);
  assert.match(auditExport, /filter: auditFilter/);
  assert.match(auditExport, /query: auditQuery\.trim\(\)/);
  assert.match(auditExport, /yinling-education-ops-audit-/);
  assert.doesNotMatch(auditExport, /students|teachers|payrollState|messages|files|rules/);
});

test("administrator-only pages stay behind the client and server role boundaries", async () => {
  const [client, stateRoute, snapshotRoute, auditRoute, access] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/api/app-state/route.ts"),
    read("../app/api/app-snapshot/route.ts"),
    read("../app/api/audit/route.ts"),
    read("../lib/ops-access.ts"),
  ]);

  assert.match(client, /const canUseAdminScope = isFullAdminSession \|\| isLimitedAdminSession/);
  assert.match(client, /const visibleNavigation = useMemo\(\(\) => isAdminView/);
  assert.match(client, /!isAdminView[\s\S]*return renderDashboard\(\)/);
  assert.match(stateRoute, /getCurrentDemoSession/);
  assert.match(stateRoute, /if \(body\.entity === "audit"\) return noStore\(\{ error: "操作审计由服务器自动记录，不能直接修改。" \}, 403\)/);
  assert.match(snapshotRoute, /getCurrentDemoSession/);
  assert.match(snapshotRoute, /sourceAccess = canReadUnrestrictedOpsData\(access\)/);
  assert.match(stateRoute, /!canReadUnrestrictedOpsData\(access\)/);
  assert.match(auditRoute, /getCurrentDemoSession/);
  assert.match(access, /if \(entity === "payroll"\) return context\.fullAdmin/);
  assert.match(access, /if \(entity === "audit"\) return false/);
});
