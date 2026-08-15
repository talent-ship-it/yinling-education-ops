import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientUrl = new URL("../app/operations-client.tsx", import.meta.url);

test("renewal UI materializes and persists one stable row per package with depletion-subject evidence", async () => {
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
  assert.match(rows, /renewalDateNote: automaticRenewalDateNote \|\| existing\?\.renewalDateNote/);
  assert.match(rows, /renewalTaskAnchor\(renewal\.studentId, renewal\.packageId\)/);

  const submit = client.slice(client.indexOf("const submitRenewalFollowUp"), client.indexOf("const submitFile"));
  assert.doesNotMatch(submit, /renewalDraft\.subjectId \?\? ""/);
  assert.match(submit, /packageId: renewalDraft\.packageId,[\s\S]*subjectId: undefined/);
  assert.match(client, /课包 \/ 耗尽科目[\s\S]*renewalDraft\.renewalDateNote \?\? "耗尽科目待排课确认"/);
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

test("a server-returned managed exam task reaches its cross-owner staff recipient only in ToDo", async () => {
  const client = await readFile(clientUrl, "utf8");
  const taskScope = client.slice(
    client.indexOf("const scopedTasks ="),
    client.indexOf("const scopedBookings ="),
  );
  assert.match(taskScope, /initialRole === "staff"/);
  assert.match(taskScope, /currentOperator === sessionOperator/);
  assert.match(taskScope, /isManagedExamTaskRecipient\(task, currentOperator\)/);
  assert.match(taskScope, /!scopedStudentIds\.has\(task\.studentId\) && !addressedManagedExamTask/);

  const readableTaskScope = client.slice(
    client.indexOf("const readableScopedTasks ="),
    client.indexOf("const readableScopedBookings ="),
  );
  assert.doesNotMatch(readableTaskScope, /isManagedExamTaskRecipient/);
});
