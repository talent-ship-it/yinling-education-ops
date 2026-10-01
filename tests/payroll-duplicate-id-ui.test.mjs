import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientPath = new URL("../app/operations-client.tsx", import.meta.url);

test("payroll rows use occurrence-safe display keys and source-indexed mutations", async () => {
  const source = await readFile(clientPath, "utf8");

  assert.match(source, /type PayrollDisplayRow = PayrollRow & \{[\s\S]*viewKey: string;[\s\S]*sourceIndex: number \| null;/);
  assert.match(source, /payrollDisplayKey\("persisted", row\.id, ordinal\)/);
  assert.match(source, /key=\{row\.viewKey\}/);
  assert.match(source, /setSelectedPayrollKey\(row\.viewKey\)/);
  assert.match(source, /setPayrollDraftSourceIndex\(selectedPayroll\.sourceIndex\)/);
  assert.match(source, /const draftSourceIndex = payrollDraftSourceIndex;/);
  assert.match(source, /index === targetIndex \? updated : row/);
  assert.doesNotMatch(source, /selectedPayrollId|setSelectedPayrollId/);
});

test("payroll export and locking fail closed on stale or missing current JWB evidence", async () => {
  const source = await readFile(clientPath, "utf8");

  assert.match(source, /const \[jiaowubaoCompletedLessonExporting, setJiaowubaoCompletedLessonExporting\] = useState\(false\)/);
  assert.match(source, /const exportCurrentPayroll = async \(\) => \{/);
  assert.match(source, /freshFeed = await loadAllJiaowubaoCompletedLessonPages\(\{ month \}\)/);
  assert.match(source, /jiaowubaoCompletedMonthEvidenceMatchesExportVersion\(\{[\s\S]*current: reviewedFeed,[\s\S]*fresh: freshFeed,[\s\S]*month,[\s\S]*\}\)/);
  assert.match(source, /setJiaowubaoCompletedLessonFeed\(freshFeed\);[\s\S]*return;/);
  assert.match(source, /const currentEvidence = currentJiaowubaoPayrollExportEvidence\(source\)/);
  assert.match(source, /const sourceVersionIsCurrent = jiaowubaoPayrollSourceVersionIsCurrent\(\{[\s\S]*persistedSourceRevision: row\.sourceRevision,[\s\S]*currentSourceRevision: freshFeed\.revision/);
  assert.match(source, /paymentMode = row\.paymentReviewOnly \|\| !source \|\| !sourceVersionIsCurrent[\s\S]*!jiaowubaoCompletedLessonCanGeneratePayroll\(source\.summary\) \|\| row\.status === "需核对"/);
  assert.match(source, /sourceHours: currentEvidence\.sourceHours,[\s\S]*sourceLessonCount: currentEvidence\.sourceLessonCount,[\s\S]*lines: currentEvidence\.lines/);
  assert.doesNotMatch(source, /source\?\.summary\.sourceHours \?\? row\.sourceHours/);
  assert.doesNotMatch(source, /lines: \(row\.lines \?\? \[\]\)\.map/);
  assert.match(source, /if \(!source\) \{[\s\S]*没有当前月份的教务宝来源资料，不能锁定或付款/);
  assert.match(source, /if \(!jiaowubaoPayrollSourceVersionIsCurrent\(\{[\s\S]*persistedSourceRevision: row\.sourceRevision,[\s\S]*currentSourceRevision: feed\.revision/);
  assert.match(source, /const sourceReviewReason = currentFeedForRow && sourceEvidence[\s\S]*!source[\s\S]*当前月份没有教务宝来源资料[\s\S]*!jiaowubaoPayrollSourceVersionIsCurrent[\s\S]*JIAOWUBAO_PAYROLL_SOURCE_VERSION_REVIEW_REASON/);
  assert.match(source, /currentFeedForRow \? \{[\s\S]*sourceHours: null,[\s\S]*sourceLessonCount: null,[\s\S]*lines: \[\] as PayrollLine\[\]/);
  assert.match(source, /const canExportCurrentPayroll = hasReadyJiaowubaoEvidenceForPayrollMonth[\s\S]*&& !jiaowubaoCompletedLessonExporting/);
  assert.match(source, /jiaowubaoCompletedLessonExporting \? "校验来源…" : "导出本月 Excel"/);
});

test("payroll export pins live payroll state and separates source-read from workbook failures", async () => {
  const source = await readFile(clientPath, "utf8");
  const exportPath = source.slice(
    source.indexOf("const exportCurrentPayroll = async () =>"),
    source.indexOf("return (", source.indexOf("const exportCurrentPayroll = async () =>")),
  );

  assert.match(exportPath, /const renderedPayrollPayload = JSON\.stringify\(payrollState\)/);
  assert.match(exportPath, /const payrollPayloadAtStart = JSON\.stringify\(getCurrentPayrollState\(\)\)/);
  assert.match(exportPath, /const payrollVersionAtStart = getCurrentPayrollVersion\(\)/);
  assert.match(exportPath, /if \(payrollPayloadAtStart !== renderedPayrollPayload\)[\s\S]*薪资资料已更新，请核对后重试/);
  assert.match(exportPath, /const payrollSnapshotStillCurrent = \(\) => \([\s\S]*getCurrentPayrollVersion\(\) === payrollVersionAtStart[\s\S]*JSON\.stringify\(getCurrentPayrollState\(\)\) === payrollPayloadAtStart/);
  assert.equal((exportPath.match(/if \(!payrollSnapshotStillCurrent\(\)\)/g) ?? []).length, 2);
  assert.match(exportPath, /freshFeed\.teacherEvidenceSourceKeys\.entries\(\)/);
  assert.match(exportPath, /if \(!teacherLessonSourceKeysByTeacher\.has\(row\.teacherKey\)\)[\s\S]*teacherLessonSourceKeysByTeacher\.set\(row\.teacherKey, \[\]\)/);
  assert.match(exportPath, /teacherLessonSourceKeys,[\s\S]*matchCounts:/);
  assert.match(exportPath, /try \{[\s\S]*freshFeed = await loadAllJiaowubaoCompletedLessonPages\(\{ month \}\);[\s\S]*\} catch \{[\s\S]*导出前无法读取最新教务宝双源资料/);
  assert.match(exportPath, /downloadPayrollExcel\([\s\S]*\} catch \{[\s\S]*薪资工作簿校验或下载准备失败/);
  assert.doesNotMatch(exportPath, /薪资工作簿校验或下载准备失败[，\s\S]*来源不可用/);
});

test("payroll locking revalidates fresh JWB and the exact raw row after confirmation", async () => {
  const source = await readFile(clientPath, "utf8");
  const lockPath = source.slice(
    source.indexOf("const revalidateJiaowubaoPayrollLock = async"),
    source.indexOf("const exportCurrentPayroll = async () =>"),
  );

  assert.match(lockPath, /freshFeed = await loadAllJiaowubaoCompletedLessonPages\(\{ month: activePayrollMonth \}\)/);
  assert.match(lockPath, /jiaowubaoCompletedMonthEvidenceMatchesExportVersion\(\{[\s\S]*current: reviewedFeed,[\s\S]*fresh: freshFeed/);
  assert.equal((lockPath.match(/await revalidateJiaowubaoPayrollLock\(/g) ?? []).length, 2);
  assert.equal((lockPath.match(/getCurrentPayrollState\(\)/g) ?? []).length, 2);
  assert.equal((lockPath.match(/payrollLockSnapshotIsCurrent\(/g) ?? []).length, 4);
  assert.equal((lockPath.match(/jiaowubaoPayrollSourceLockBlockReason\(currentRow, freshFeed\)/g) ?? []).length, 2);
  assert.match(lockPath, /onConfirm: async \(\) => \{[\s\S]*await revalidateJiaowubaoPayrollLock\(\[row\]\)[\s\S]*getCurrentPayrollState\(\)[\s\S]*mutatePayrollAndCommit/);
  assert.match(lockPath, /const expectedRows = readyTargets\.map[\s\S]*await revalidateJiaowubaoPayrollLock\(expectedRows\)[\s\S]*getCurrentPayrollState\(\)[\s\S]*mutatePayrollAndCommit/);
});

test("payroll mutation controls are disabled while a validated export is running", async () => {
  const source = await readFile(clientPath, "utf8");

  assert.match(source, /disabled=\{jiaowubaoCompletedLessonExporting\}[\s\S]*onClick=\{\(\) => setModal\("payrollNew"\)\}/);
  assert.match(source, /disabled=\{jiaowubaoCompletedLessonExporting \|\| !hasReadyJiaowubaoEvidenceForPayrollMonth[\s\S]*onClick=\{lockAllReadyPayroll\}/);
  assert.match(source, /className="secondary-button full"[\s\S]*disabled=\{jiaowubaoCompletedLessonExporting\}[\s\S]*setModal\("payrollEdit"\)/);
  assert.match(source, /disabled=\{jiaowubaoCompletedLessonExporting \|\| Boolean\(jiaowubaoPayrollLockBlockReason\(selectedPayroll\)\)\}/);
});
