import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientUrl = new URL("../app/operations-client.tsx", import.meta.url);

test("renewal UI keeps automatic depletion evidence read-only and preserves manual notes", async () => {
  const client = await readFile(clientUrl, "utf8");
  const projection = client.slice(
    client.indexOf("const renewalTaskProjectionSnapshot"),
    client.indexOf("const renewalTaskProjections"),
  );
  assert.match(projection, /subjectId: renewal\.subjectId/);
  assert.match(projection, /renewalStatusForPackage\([\s\S]*packageId: estimate\.packageId,[\s\S]*packageCount: packages\.length/);
  assert.match(projection, /renewalProjectionStateForStudent\(recordedStatus, isActiveStudent\(student\)\)/);
  assert.match(projection, /depletionSubjectId: estimate\.subjectId/);
  assert.match(projection, /nextLessonAfterDepletion:[\s\S]*withinSevenDays/);
  assert.match(projection, /renewalDateNote: renewalDateNote \|\| undefined/);

  const rows = client.slice(client.indexOf("const renderRenewals"), client.indexOf("const renderPayroll"));
  assert.match(rows, /const packageExact = scopedRenewals\.find\([\s\S]*renewal\.packageId === lessonPackage\.id[\s\S]*!renewal\.subjectId/);
  assert.match(rows, /const anchor = renewalTaskAnchor\(student\.id, lessonPackage\.id\)/);
  assert.match(rows, /id: `REN-AUTO:\$\{anchor\}`/);
  assert.match(rows, /subjectId: undefined/);
  assert.match(rows, /subjectLabel: estimate\?\.subjectId \? `耗尽科目：\$\{estimate\.subjectId\}`/);
  assert.match(rows, /renewalDateNote: existing\?\.renewalDateNote/);
  assert.match(rows, /automaticRenewalDateNote: automaticRenewalDateNote \|\| undefined/);
  assert.match(rows, /自动提示：\{renewal\.automaticRenewalDateNote\}/);
  assert.match(rows, /人工备注：\{renewal\.renewalDateNote\}/);
  assert.match(rows, /renewalCycleTaskAnchor\(\{ studentId: renewal\.studentId, packageId: renewal\.packageId/);
  assert.match(rows, /还没有可跟进的活跃学生/);
  assert.match(rows, /先新建学生/);
  assert.match(rows, /去同步与导入/);
  assert.match(rows, /还没有可用于续课的课包/);
  assert.match(rows, /先录入课包/);
  assert.match(rows, /当前没有需要续课的课包/);
  assert.match(rows, /清除续课筛选/);

  const submit = client.slice(client.indexOf("const submitRenewalFollowUp"), client.indexOf("const submitFile"));
  assert.doesNotMatch(submit, /renewalDraft\.subjectId \?\? ""/);
  assert.match(submit, /fetch\("\/api\/renewals\/follow-up"/);
  assert.match(submit, /renewalsShared\.applyRemote\(body\.renewalsRow/);
  assert.match(submit, /studentsShared\.applyRemote\(body\.studentsRow/);
  assert.match(submit, /filesShared\.applyRemote\(body\.filesRow/);
  assert.match(submit, /tasksShared\.applyRemote\(body\.tasksRow/);
  assert.doesNotMatch(submit, /renewalsShared\.mutateAndCommit|studentsShared\.mutateAndCommit/);
  assert.match(client, /课包 \/ 耗尽科目[\s\S]*renewalDraft\.automaticRenewalDateNote \?\? "耗尽科目待排课确认"/);
  assert.match(client, /name="renewalDateNote" defaultValue=\{renewalDraft\.renewalDateNote \?\? ""\}/);
});

test("exam UI routes care to the owner and results to the recorded planner", async () => {
  const [client, examTasks, service] = await Promise.all([
    readFile(clientUrl, "utf8"),
    readFile(new URL("../lib/exam-tasks.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/exam-submission-service.ts", import.meta.url), "utf8"),
  ]);
  const routing = examTasks.slice(examTasks.indexOf("export const EXAM_ROLE_LABELS"), examTasks.indexOf("function sameRecipient"));
  for (const role of ["academic_coordinator", "course_planner"]) {
    assert.match(routing, new RegExp(`${role}:`));
  }
  assert.doesNotMatch(routing, /sales:|principal:|销售|校长/);
  assert.match(routing, /role === "academic_coordinator"[\s\S]*student\.owner/);
  assert.match(routing, /configuredExamRecipient\(student\.planner\)/);
  assert.doesNotMatch(routing, /角色待配置：/);
  assert.match(routing, /if \(unresolvedRoleLabels\.length\) return \{ routing: null, unresolvedRoleLabels \}/);
  assert.match(routing, /assignees: \[\.\.\.new Set\(recipients\)\]/);

  const submit = client.slice(client.indexOf("const submitExam"), client.indexOf("const submitTask"));
  assert.match(submit, /fetch\("\/api\/exams\/submit"/);
  assert.match(submit, /studentsShared\.applyRemote\(body\.studentRow/);
  assert.match(submit, /tasksShared\.applyRemote\(body\.taskRow/);
  assert.match(submit, /账号待配置，未生成对应任务/);
  assert.doesNotMatch(submit, /setStudents|setTasks|routeExamTaskRecipients|buildExamTaskDefinitions/);
  assert.match(service, /routeExamTaskRecipients\(definition\.assigneeRoles/);
  assert.match(service, /trigger: `\$\{exam\.subject\} 考试记录 · 收件：\$\{routing\.routing\.assignees\.join\("、"\)\}`/);
  assert.doesNotMatch(submit, /selectedStudent\.planner \?\? "Tara"/);
});

test("exam collection aggregates structured history with Melbourne month ordering and managed actions", async () => {
  const client = await readFile(clientUrl, "utf8");
  const rows = client.slice(client.indexOf("const renderRenewals"), client.indexOf("const renderPayroll"));
  assert.match(client, /function examRecordsForStudent\(student: Student\)/);
  assert.match(client, /if \(Array\.isArray\(student\.exams\)\) return student\.exams/);
  assert.match(rows, /examStudents\.flatMap\(\(student\) => examRecordsForStudent\(student\)/);
  assert.match(rows, /examMonthSelection === "all" \|\| row\.exam\.examMonth === examMonthSelection/);
  assert.match(rows, /const examRowsForMonth = examRows/);
  assert.match(rows, /const visibleExamRows = examRowsForMonth/);
  assert.match(rows, /const examStatusCount = \(filter:[\s\S]*?\) => examRowsForMonth\.filter/);
  assert.match(rows, /if \(task\) return task\.status === "done" \? "completed" : "pending";[\s\S]*return definitions\[kind\]/);
  assert.match(rows, /left\.exam\.examDate \? 1 : -1\) - \(right\.exam\.examDate \? 1 : -1/);
  assert.match(rows, /待关心 \/ 回忆/);
  assert.match(rows, /待出分关心/);
  assert.match(rows, /exam\.resultDateOverride/);
  assert.match(rows, /onClick=\{\(\) => completeTask\(pendingTask\.id\)\}/);
  assert.match(rows, /void undoManagedExamFollowUp\(completedTask\)/);
  assert.doesNotMatch(rows, /student\.examDate|student\.examSubject/);
  assert.match(client, /isoDateInTimezone\(new Date\(\), "Australia\/Melbourne"\)\.slice\(0, 7\)/);
  assert.match(client, /const today = isoDateInTimezone\(now, "Australia\/Melbourne"\);[\s\S]*daysBetweenIsoDates\(today, record\.examDate\)/);
});

test("renewal and To Do timestamps use the configured or Melbourne timezone", async () => {
  const client = await readFile(clientUrl, "utf8");
  assert.match(client, /dateTimeFormat\(localeFor\(displayPreferences\.language\), \{ year: "numeric", month: "long", day: "numeric", weekday: "long", timeZone: displayPreferences\.timezone \}\)/);
  assert.match(client, /attemptedAtInput = String\(data\.get\("attemptedAt"\) \?\? currentDateTimeValueInTimezone\(displayPreferences\.timezone\)\)/);
  assert.match(client, /zonedDateTimeToUtc\(attemptedAtParts\[1\], attemptedAtParts\[2\], displayPreferences\.timezone\)/);
  assert.match(client, /defaultValue=\{currentDateTimeValueInTimezone\(displayPreferences\.timezone\)\}/);
  assert.doesNotMatch(client, /function currentLocalDateTimeValue/);
});

test("a server-returned managed exam task reaches its cross-owner staff recipient only in ToDo", async () => {
  const client = await readFile(clientUrl, "utf8");
  const taskScope = client.slice(
    client.indexOf("const scopedTasks ="),
    client.indexOf("const scopedBookings ="),
  );
  assert.match(taskScope, /initialRole === "staff"/);
  assert.match(taskScope, /currentOperator === sessionOperator/);
  assert.match(taskScope, /isManagedExamTaskRecipient\(task, currentOperator\)/);
  assert.match(taskScope, /managedExamTaskIdentities\.has/);
  assert.match(taskScope, /!scopedStudentIds\.has\(task\.studentId\) && !authorizedCrossOwnerTask/);

  const readableTaskScope = client.slice(
    client.indexOf("const readableScopedTasks ="),
    client.indexOf("const readableScopedBookings ="),
  );
  assert.doesNotMatch(readableTaskScope, /isManagedExamTaskRecipient/);
});

test("staff exam rows use the narrow server projection without opening the cross-owner student record", async () => {
  const client = await readFile(clientUrl, "utf8");
  const scope = client.slice(client.indexOf("const managedExamStudents ="), client.indexOf("const scopedTasks ="));
  assert.match(scope, /managedExamProjectionSnapshot\.students/);
  assert.match(scope, /initialRole !== "staff"/);
  assert.match(scope, /files: 0/);
  assert.match(scope, /exams: \[\.\.\.student\.exams\]/);

  const rows = client.slice(client.indexOf("const renderRenewals"), client.indexOf("const renderPayroll"));
  assert.match(rows, /const examRows: ExamDisplayRow\[\] = examStudents\.flatMap/);
  assert.match(rows, /managedOnly: managedExamStudentIds\.has\(student\.id\)/);
  assert.match(rows, /row\.managedOnly\s*\?/);
  assert.match(rows, /anchorBookingId === `exam:\$\{exam\.id\}`/);
  assert.match(rows, /task\.ruleKey\?\.match\(\/\^exam:\[\^:\]\+:\(planning\|care\|recall\|results\)\$\//);
});
