import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260815042000_exam_follow_up_atomic.sql", import.meta.url);

function sqlFunction(sql, signature) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  const end = sql.indexOf("revoke all on function", start);
  assert.ok(start >= 0 && end > start, `${signature} function body is missing`);
  return sql.slice(start, end);
}

test("follow-up route uses one closed server-derived command and fresh replay authorization", async () => {
  const [route, service, store, client] = await Promise.all([
    readFile(new URL("../app/api/exams/follow-up/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/exam-follow-up-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(route, /parseExamFollowUpCommand/);
  assert.match(route, /getOpsState\(\["students", "tasks"\]\)/);
  assert.ok(route.indexOf("authorizeExamFollowUpCommand({ command, rows") < route.indexOf("getExamFollowUpCommandResult({"));
  const replay = route.slice(route.indexOf("if (replay[0])"), route.indexOf("const completionContext"));
  assert.match(replay, /await getOpsState\(\["students", "tasks"\]\)/);
  assert.match(replay, /authorizeExamFollowUpCommand/);
  assert.match(route, /saved\[0\]\.applied[\s\S]*await getOpsState\(\["students", "tasks"\]\)/);
  assert.match(route, /mutateExamFollowUpAtomic\(\{ \.\.\.prepared, actor \}\)/);
  assert.doesNotMatch(route, /putOpsState/);
  assert.match(route, /Cache-Control": "private, no-store"/);

  assert.match(service, /COMMAND_FIELDS = new Set\(\[[\s\S]*"commandKey"[\s\S]*"action"[\s\S]*"taskId"[\s\S]*"expectedVersions"[\s\S]*"completionCommandKey"/);
  assert.doesNotMatch(service.slice(service.indexOf("export type ExamFollowUpCommand"), service.indexOf("export type ExamFollowUpIntent")), /\n  (?:studentId|examId|followUpKind|preparedAt|students|tasks):/);
  assert.match(service, /task\.ruleKey\.match\(\/\^exam:\(\[\^:\]\+\):\(care\|recall\|results\)\$\//);
  assert.match(service, /assignees\.length !== 1/);
  assert.match(service, /watchers\.length !== 1/);
  assert.match(service, /context\.prior_task/);
  assert.match(service, /context\.committed_task/);
  assert.match(service, /context\.committed_follow_up_state/);

  for (const constant of [
    'EXAM_FOLLOW_UP_ATOMIC_RPC = "mutate_exam_follow_up_atomic"',
    'EXAM_FOLLOW_UP_COMMAND_RESULT_RPC = "get_exam_follow_up_command_result"',
    'EXAM_FOLLOW_UP_COMPLETION_CONTEXT_RPC = "get_exam_follow_up_completion_context"',
  ]) assert.match(store, new RegExp(constant));
  const wrapper = store.slice(store.indexOf("export function mutateExamFollowUpAtomic"), store.indexOf("export function putOpsState"));
  for (const field of ["p_command_key", "p_command_intent", "p_action", "p_expected_versions", "p_students", "p_tasks", "p_prepared_at", "p_actor"]) {
    assert.match(wrapper, new RegExp(field));
  }

  const handler = client.slice(client.indexOf("const mutateManagedExamFollowUp"), client.indexOf("const completeTask"));
  assert.match(handler, /fetch\("\/api\/exams\/follow-up"/);
  assert.match(handler, /studentsShared\.applyRemote\(body\.studentRow/);
  assert.match(handler, /tasksShared\.applyRemote\(body\.taskRow/);
  assert.doesNotMatch(handler, /setExamFollowUpStepState|setStudents\(|setTasks\(/);
  assert.match(handler, /completionCommandKey/);
  assert.match(handler, /action: "complete" \| "undo"/);
  const completeTask = client.slice(client.indexOf("const completeTask"), client.indexOf("const recordTrialParentReply"));
  const managedExamCompletion = completeTask.indexOf("void completeManagedExamFollowUp(task)");
  const genericTaskCommit = completeTask.indexOf("void tasksShared.mutateAndCommit");
  assert.ok(managedExamCompletion >= 0 && genericTaskCommit > managedExamCompletion, "managed exam completion must return before the generic task commit");
  assert.match(completeTask, /void completeManagedExamFollowUp\(task\);[\s\S]*return;/);
  assert.doesNotMatch(completeTask, /setTasks\(/);
  assert.match(client, /readPendingExamFollowUp/);
  assert.match(client, /writePendingExamFollowUp/);
  assert.match(client, /clearPendingExamFollowUp/);
});

test("follow-up SQL locks students then tasks, replays before OCC and restores only an exact completion snapshot", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const body = sqlFunction(sql, "public.mutate_exam_follow_up_atomic");
  const studentLock = body.indexOf("where s.entity = 'students' for update");
  const taskLock = body.indexOf("where s.entity = 'tasks' for update");
  const replay = body.indexOf("prior.command_key is not null");
  const version = body.indexOf("student_state.version is distinct from expected_student_version");
  assert.ok(studentLock >= 0 && taskLock > studentLock, "lock order must be students -> tasks");
  assert.ok(replay > taskLock && version > replay, "ledger replay must precede OCC under both locks");
  assert.ok(body.indexOf("clock_timestamp() - interval '15 minutes'") > replay, "freshness must not reject an old replay");
  assert.match(body, /internal\.exam_follow_up_identity/);
  assert.match(body, /internal\.exam_follow_up_replace/);
  assert.match(body, /current_task is distinct from completion\.committed_task/);
  assert.match(body, /current_follow_up_state is distinct from completion\.committed_follow_up_state/);
  assert.match(body, /committed_task_value := completion\.prior_task/);
  assert.match(body, /committed_follow_up_state_value := completion\.prior_follow_up_state/);
  assert.match(body, /p_students is distinct from projection -> 'students'/);
  assert.match(body, /p_tasks is distinct from projection -> 'tasks'/);
  assert.match(body, /update public\.ops_state set[\s\S]*where entity = 'students'/);
  assert.match(body, /update public\.ops_state set[\s\S]*where entity = 'tasks'/);
  assert.match(body, /insert into public\.ops_mutation_log/);
  assert.match(body, /append_operational_contract_audit/);
  assert.match(body, /insert into internal\.exam_follow_up_commands/);
  assert.doesNotMatch(body, /statement_timeout/);

  const getter = sqlFunction(sql, "public.get_exam_follow_up_command_result");
  assert.match(getter, /prior\.actor <> trim\(p_actor\)/);
  assert.match(getter, /prior\.command_intent is distinct from p_command_intent/);
  const context = sqlFunction(sql, "public.get_exam_follow_up_completion_context");
  assert.match(context, /completion\.action <> 'complete'/);
  assert.match(context, /completion\.actor <> trim\(p_actor\)/);
  assert.match(sql, /alter table internal\.exam_follow_up_commands enable row level security/);
  assert.match(sql, /revoke all on table internal\.exam_follow_up_commands from public, anon, authenticated, service_role/);
  assert.match(sql, /command_key ~ '\^exam-follow-up:/);
  assert.doesNotMatch(sql, /~\*\s*'\^exam-follow-up:/);
});

test("follow-up SQL fixture pins identity, recipient and complete projection", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const fixture = sql.slice(sql.indexOf("do $exam_follow_up_contract_fixture$"));
  assert.match(fixture, /'exam_recall'/);
  assert.match(fixture, /Ops Admin/);
  assert.match(fixture, /'已由当前操作员确认完成'/);
  assert.match(fixture, /exam_follow_up_projection_fixture_failed/);
});

test("exam modal and idempotency key survive unknown transport outcomes", async () => {
  const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");
  const submit = client.slice(client.indexOf("const submitExam"), client.indexOf("const submitTask"));
  assert.match(submit, /const target = requireStudentModalTarget\(true\);/);
  assert.match(submit, /readPendingExamSubmission\(sessionOperator\)/);
  assert.match(submit, /pendingExamMatchesDraft\([\s\S]*recovered,[\s\S]*target\.id,[\s\S]*examDraftWithoutId/);
  assert.match(submit, /writePendingExamSubmission\(sessionOperator/);
  assert.ok(submit.indexOf("clearPendingExamSubmission(sessionOperator)") > submit.indexOf("if (!response.ok"));
  assert.equal((submit.match(/clearPendingExamSubmission/g) ?? []).length, 1, "only a confirmed success may clear the key");
  const modal = client.slice(client.indexOf('{modal === "exam"'), client.indexOf('{modal === "task"'));
  assert.match(modal, /onClose=\{\(\) => \{ if \(examSubmissionBusy\) return;/);
  assert.match(modal, /disabled=\{examSubmissionBusy\}/);
  const escape = client.slice(client.indexOf("const onKeyDown"), client.indexOf('window.addEventListener("keydown"'));
  assert.match(escape, /if \(modal\) \{\s*if \(\(modal === "exam" && examSubmissionBusy\) \|\| \(modal === "legacyTaskDeadline" && legacyTaskDeadlineBusy\)\) return;\s*setModal\(null\);/);
});

test("canonical bootstrap carries the byte-equivalent follow-up suffix", async () => {
  const [forward, canonical] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(new URL("../supabase/migrations/20260813013935_operational_atomic_contracts.sql", import.meta.url), "utf8"),
  ]);
  const startMarker = "-- BEGIN EXAM FOLLOW UP ATOMIC SUFFIX\n";
  const endMarker = "\n-- END EXAM FOLLOW UP ATOMIC SUFFIX";
  const start = canonical.indexOf(startMarker);
  const end = canonical.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "canonical follow-up suffix markers are missing");
  assert.equal(canonical.slice(start + startMarker.length, end), forward.trimEnd());
});
