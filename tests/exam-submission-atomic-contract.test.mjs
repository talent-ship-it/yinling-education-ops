import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260815040000_exam_submission_atomic.sql", import.meta.url);

function sqlFunction(sql, signature) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  const end = sql.indexOf("revoke all on function", start);
  assert.ok(start >= 0 && end > start, `${signature} function body is missing`);
  return sql.slice(start, end);
}

test("exam route performs one scoped replayable students+tasks transaction", async () => {
  const [route, store, client, service] = await Promise.all([
    readFile(new URL("../app/api/exams/submit/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/exam-submission-service.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /parseExamSubmissionCommand/);
  assert.match(route, /getOpsState\(\["students", "tasks"\]\)/);
  assert.match(route, /canOperateStudent\(access, command\.studentId\)/);
  assert.ok(route.indexOf("canOperateStudent(access") < route.indexOf("getExamSubmissionCommandResult({"));
  assert.ok(route.indexOf("getExamSubmissionCommandResult({") < route.indexOf("prepareExamSubmission({"));
  const replay = route.slice(route.indexOf("if (replay[0])"), route.indexOf("const prepared ="));
  assert.match(replay, /await getOpsState\(\["students", "tasks"\]\)/);
  assert.match(replay, /canOperateStudent\(replayAccess, replay\[0\]\.student_id\)/);
  assert.match(route, /submitExamAtomic\(\{ \.\.\.prepared, actor \}\)/);
  assert.doesNotMatch(route, /putOpsState/);
  assert.match(route, /Cache-Control": "private, no-store"/);

  assert.match(store, /EXAM_SUBMISSION_ATOMIC_RPC = "submit_exam_atomic"/);
  assert.match(store, /EXAM_SUBMISSION_COMMAND_RESULT_RPC = "get_exam_submission_command_result"/);
  const wrapper = store.slice(store.indexOf("export function submitExamAtomic"), store.indexOf("export function putOpsState"));
  for (const field of ["p_command_key", "p_command_intent", "p_expected_versions", "p_students", "p_tasks", "p_prepared_at"]) {
    assert.match(wrapper, new RegExp(field));
  }

  assert.match(service, /buildExamTaskDefinitions/);
  assert.match(service, /routeExamTaskRecipients/);
  assert.match(service, /reconcileExamTasks/);
  assert.match(service, /buildOpsAccessContext/);
  assert.match(service, /canOperateStudent/);
  assert.doesNotMatch(service, /followUpState: input\.command/);

  const submit = client.slice(client.indexOf("const submitExam"), client.indexOf("const submitTask"));
  assert.match(submit, /fetch\("\/api\/exams\/submit"/);
  assert.match(submit, /expectedVersions:[\s\S]*students: studentsShared\.version,[\s\S]*tasks: tasksShared\.version/);
  assert.match(submit, /studentsShared\.applyRemote\(body\.studentRow/);
  assert.match(submit, /tasksShared\.applyRemote\(body\.taskRow/);
  assert.doesNotMatch(submit, /setStudents|setTasks|buildExamTaskDefinitions|routeExamTaskRecipients|reconcileExamTasks/);
  assert.match(client, /commandKey: `exam-submit:\$\{crypto\.randomUUID\(\)\}`/);
});

test("lost-response reconciliation is read-only, actor-bound and freshly authorized", async () => {
  const [route, client] = await Promise.all([
    readFile(new URL("../app/api/exams/submit/reconcile/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /parseExamSubmissionRecoveryCommand/);
  assert.match(route, /getExamSubmissionCommandResult/);
  assert.match(route, /commandIntent,[\s\S]*actor/);
  assert.match(route, /await getOpsState\(\["students", "tasks"\]\)/);
  assert.match(route, /canOperateStudent\(access, command\.studentId\)/);
  assert.match(route, /canOperateStudent\(replayAccess, replay\[0\]\.student_id\)/);
  assert.doesNotMatch(route, /submitExamAtomic|putOpsState|mutate/);

  const submit = client.slice(client.indexOf("const submitExam"), client.indexOf("const submitTask"));
  const mismatch = submit.indexOf("if (recovered && !recoveredMatchesDraft)");
  const newKey = submit.indexOf("commandKey: `exam-submit:${crypto.randomUUID()}`");
  const persisted = submit.indexOf("writePendingExamSubmission(sessionOperator");
  assert.ok(mismatch >= 0 && mismatch < newKey && mismatch < persisted,
    "a different student/draft must reconcile before any new key can overwrite pending storage");
  assert.match(submit, /await reconcilePendingExamSubmission\(recovered\)/);
  assert.match(submit, /if \(reconciled\.committed\)[\s\S]*return;/);
  assert.match(submit, /setSelectedStudentId\(reconciled\.recovery\.studentId\)/);
  assert.match(submit, /setExamDraft\(reconciled\.recovery\.exam as StudentExamRecord\)/);
  assert.match(submit, /setExamFormResetToken\(\(current\) => current \+ 1\)/);
  assert.match(client, /<ExamForm key=\{`\$\{studentModalTargetStudent\.id\}:\$\{examDraft\?\.id \?\? "new"\}:\$\{examFormResetToken\}`\}/,
    "same-student same-exam recovery must remount uncontrolled form state");
});

test("exam SQL locks students then tasks, replays before OCC, and verifies exact closed projections", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const body = sqlFunction(sql, "public.submit_exam_atomic");
  const studentLock = body.indexOf("where s.entity = 'students' for update");
  const taskLock = body.indexOf("where s.entity = 'tasks' for update");
  const replay = body.indexOf("prior.command_key is not null");
  const version = body.indexOf("student_state.version is distinct from expected_student_version");
  assert.ok(studentLock >= 0 && taskLock > studentLock, "lock order must be students -> tasks");
  assert.ok(replay > taskLock && version > replay, "replay must be recognized under locks before OCC");
  assert.match(body, /internal\.validate_exam_submission_intent/);
  assert.match(body, /internal\.exam_submission_expected_students/);
  assert.match(body, /internal\.exam_submission_incoming_tasks/);
  assert.match(body, /internal\.exam_submission_reconcile_tasks/);
  assert.match(body, /p_students is distinct from expected_students/);
  assert.match(body, /p_tasks is distinct from expected_tasks/);
  assert.match(sql, /exam_submission_task_identity_conflict/);
  assert.match(body, /update public\.ops_state set[\s\S]*where entity = 'students'/);
  assert.match(body, /update public\.ops_state set[\s\S]*where entity = 'tasks'/);
  assert.match(body, /insert into public\.ops_mutation_log/);
  assert.match(body, /append_operational_contract_audit\(\s*'exam_submission\.committed',\s*left\(trim\(p_actor\), 120\),\s*'student',\s*p_student_id,/);
  assert.match(body, /'commandKey', p_command_key/);
  assert.match(body, /insert into internal\.exam_submission_commands/);
  assert.doesNotMatch(body, /statement_timeout/);

  const lookup = sqlFunction(sql, "public.get_exam_submission_command_result");
  assert.match(lookup, /internal\.verify_ops_secret/);
  assert.match(lookup, /prior\.actor <> trim\(p_actor\)/);
  assert.match(lookup, /prior\.command_intent is distinct from p_command_intent/);
  assert.match(sql, /alter table internal\.exam_submission_commands enable row level security/);
  assert.match(sql, /command_key ~ '\^exam-submit:/);
  assert.doesNotMatch(sql, /~\*\s*'\^exam-submit:/);
  assert.match(sql, /revoke all on table internal\.exam_submission_commands from public, anon, authenticated, service_role/);
  assert.match(sql, /revoke all on function public\.submit_exam_atomic\([\s\S]*from public, anon, authenticated, service_role/);
  assert.match(sql, /grant execute on function public\.submit_exam_atomic\([\s\S]*to anon, authenticated/);
});

test("exam SQL fixture covers result date, owner/planner routing, watcher and stable ids", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const fixture = sql.slice(sql.indexOf("do $exam_submission_contract_fixture$"));
  assert.match(fixture, /2026-10-01/);
  assert.match(fixture, /projected_students #>> '\{0,exams,0,id\}' <> 'EXM-FIXTURE'[\s\S]*projected_students #>> '\{0,exams,1,id\}' <> 'EXM_FIXTURE'/);
  assert.match(fixture, /incoming #>> '\{0,owner\}' <> 'Abby'/);
  assert.match(fixture, /incoming #>> '\{2,owner\}' <> 'Tara'/);
  assert.match(fixture, /Ops Admin/);
  assert.match(fixture, /TSK-EXAM-f0c09a89b51b2bf60e44a7bc/);
  assert.match(fixture, /reconciled #>> '\{3,id\}' <> 'TSK-MANUAL'/);
});

test("canonical bootstrap carries the byte-equivalent exam submission suffix", async () => {
  const [forward, canonical] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(new URL("../supabase/migrations/20260813013935_operational_atomic_contracts.sql", import.meta.url), "utf8"),
  ]);
  const startMarker = "-- BEGIN EXAM SUBMISSION ATOMIC SUFFIX\n";
  const endMarker = "\n-- END EXAM SUBMISSION ATOMIC SUFFIX";
  const start = canonical.indexOf(startMarker);
  const end = canonical.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "canonical exam suffix markers are missing");
  assert.equal(canonical.slice(start + startMarker.length, end), forward.trimEnd());
});
