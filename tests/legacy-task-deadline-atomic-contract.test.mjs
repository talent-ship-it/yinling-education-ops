import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260819100800_manual_legacy_task_deadline_atomic.sql", import.meta.url);

function sqlFunction(sql, signature) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  const end = sql.indexOf("revoke all on function", start);
  assert.ok(start >= 0 && end > start, `${signature} function body is missing`);
  return sql.slice(start, end);
}

test("legacy deadline route reauthorizes before replay and gates clear before one atomic RPC", async () => {
  const [route, executor, service, store, client, toDoList, taskRules] = await Promise.all([
    readFile(new URL("../app/api/tasks/legacy-deadline/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/legacy-task-deadline-executor.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/legacy-task-deadline-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/to-do-list.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/ops-tasks.ts", import.meta.url), "utf8"),
  ]);

  assert.match(route, /const MAX_REQUEST_BYTES = 1_024/);
  assert.match(route, /parseLegacyTaskDeadlineCommand/);
  assert.match(route, /getOpsState\(\["students", "tasks"\]\)/);
  assert.match(route, /executeLegacyTaskDeadlineCommand\(\{/);
  assert.match(route, /getReplay: getLegacyTaskDeadlineCommandResult/);
  assert.match(route, /mutate: mutateLegacyTaskDeadlineAtomic/);
  const authorization = executor.indexOf("authorizeLegacyTaskDeadlineCommand(input)");
  const replayLookup = executor.indexOf("input.getReplay({", authorization);
  const clearWriteGate = executor.indexOf("assertLegacyTaskDeadlineSetCommand(input.command)", replayLookup);
  const prepare = executor.indexOf("prepareLegacyTaskDeadline({", clearWriteGate);
  const mutation = executor.indexOf("input.mutate({", prepare);
  assert.ok(authorization >= 0 && replayLookup > authorization, "fresh authorization must precede replay");
  assert.ok(replayLookup >= 0 && clearWriteGate > replayLookup, "historical clear receipts must replay before the write gate");
  assert.ok(prepare > clearWriteGate && mutation > prepare, "new clear commands must stop before preparation and mutation");
  assert.match(route, /legacyTaskDeadlineHttpError\(error\)/);
  assert.match(executor, /input\.mutate\(\{[\s\S]*commandKey: prepared\.commandKey[\s\S]*commandIntent: prepared\.commandIntent[\s\S]*expectedVersions: prepared\.expectedVersions[\s\S]*actor:/);
  assert.doesNotMatch(route, /putOpsState|addAudit|p_due_at|p_tasks|p_students/);
  assert.doesNotMatch(route, /const unchanged =|if \(unchanged\)/);
  assert.match(route, /Cache-Control": "private, no-store"/);

  assert.match(service, /COMMAND_FIELDS = new Set\(\[[\s\S]*"commandKey"[\s\S]*"action"[\s\S]*"taskId"[\s\S]*"melbourneDateTime"[\s\S]*"expectedVersions"/);
  assert.match(service, /Australia\/Melbourne/);
  assert.match(service, /melbourne_time_nonexistent/);
  assert.match(service, /melbourne_time_ambiguous/);
  assert.match(service, /clear_disabled/);
  assert.match(service, /if \(hasAutomaticTaskDeadline\(task\)\) \{\s*fail\("task_not_legacy"/);
  const automaticGuardStart = taskRules.indexOf("export function hasAutomaticTaskDeadline(");
  const automaticGuardEnd = taskRules.indexOf("export interface RuleBoundTask", automaticGuardStart);
  assert.ok(automaticGuardStart >= 0 && automaticGuardEnd > automaticGuardStart);
  const automaticGuard = taskRules.slice(automaticGuardStart, automaticGuardEnd);
  assert.match(automaticGuard, /Object\.hasOwn\(task, "ruleKey"\)/);
  assert.match(automaticGuard, /Object\.hasOwn\(task, "anchorBookingId"\)/);
  assert.match(service, /task\.status === "done"/);
  assert.match(service, /student\?\.importArchived === true/);

  for (const constant of [
    'LEGACY_TASK_DEADLINE_ATOMIC_RPC = "mutate_legacy_task_deadline_atomic"',
    'LEGACY_TASK_DEADLINE_COMMAND_RESULT_RPC = "get_legacy_task_deadline_command_result"',
  ]) assert.match(store, new RegExp(constant));
  const wrapper = store.slice(store.indexOf("export function mutateLegacyTaskDeadlineAtomic"), store.indexOf("export function putOpsState"));
  for (const field of ["p_secret", "p_command_key", "p_command_intent", "p_expected_versions", "p_actor"]) {
    assert.match(wrapper, new RegExp(field));
  }
  assert.doesNotMatch(wrapper, /p_tasks|p_students|p_due_at/);

  // Keep this slice anchored to the actual write handler.  The former
  // openLegacyTaskDeadlineEditor anchor no longer exists after the editor was
  // made state-driven, which made the end anchor precede the start and turned
  // this into an empty, ineffective contract check.
  const deadlineHandlerStart = client.indexOf("const saveLegacyTaskDeadline = async (");
  const deadlineHandlerEnd = client.indexOf("const mutateManagedExamFollowUp = async (", deadlineHandlerStart);
  assert.ok(deadlineHandlerStart >= 0, "legacy deadline save handler is missing");
  assert.ok(deadlineHandlerEnd > deadlineHandlerStart, "legacy deadline handler boundary is invalid");
  const deadlineHandler = client.slice(deadlineHandlerStart, deadlineHandlerEnd);
  assert.match(deadlineHandler, /fetch\("\/api\/tasks\/legacy-deadline"/);
  assert.match(deadlineHandler, /const action = "set" as const/);
  assert.doesNotMatch(deadlineHandler, /"clear"/);
  assert.match(deadlineHandler, /legacyTaskDeadlineCommandKeysRef/);
  assert.match(deadlineHandler, /students: studentsShared\.version/);
  assert.match(deadlineHandler, /tasks: tasksShared\.version/);
  assert.match(deadlineHandler, /tasksShared\.applyRemote\(body\.taskRow/);
  assert.doesNotMatch(deadlineHandler, /setTasks\(/);
  const deadlineModal = client.slice(client.indexOf('{modal === "legacyTaskDeadline"'), client.indexOf('{modal === "payrollNew"'));
  assert.doesNotMatch(deadlineModal, /发布后立即|N-1/);
  assert.match(deadlineModal, /Australia\/Melbourne/);
  assert.doesNotMatch(deadlineModal, /清除准确时间/);
  assert.match(deadlineModal, /保存截止时间/);
  assert.match(deadlineModal, /补充待办截止时间|调整待办截止时间/);
  assert.match(deadlineModal, /待办截止时间（墨尔本）/);
  assert.match(deadlineModal, /name="melbourneDateTime" type="datetime-local"[^>]*defaultValue=\{[^}]+: ""\} required/);
  assert.doesNotMatch(deadlineModal, /currentDateTimeValueInTimezone/);
  const openDeadlineRepair = toDoList.indexOf('view === "todo" ? !hasAutomaticTaskDeadline(task) && onRepairDeadline');
  const closedTaskReopen = toDoList.indexOf(': canReopen?.(task)', openDeadlineRepair);
  assert.ok(openDeadlineRepair >= 0, "manual frozen tasks must expose the deadline repair action");
  assert.ok(closedTaskReopen > openDeadlineRepair, "closed tasks must branch to reopen instead of deadline repair");
  assert.match(toDoList, /className="deadline-edit-button"/);
  assert.match(toDoList, /onClick=\{\(\) => onRepairDeadline\(task\)\}/);
  assert.match(toDoList, />补截止时间<\/button>/);
});

test("historical 191008 SQL locks students then tasks, replays before OCC, and changes only dueAt", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const body = sqlFunction(sql, "public.mutate_legacy_task_deadline_atomic");
  // This file pins the deployed 191008 migration itself. The later canonical
  // deadline invariant disables new clear writes while preserving old receipts.
  const studentLock = body.indexOf("where s.entity = 'students' for update");
  const taskLock = body.indexOf("where s.entity = 'tasks' for update");
  const replay = body.indexOf("prior.command_key is not null");
  const version = body.indexOf("student_state.version is distinct from expected_students_version");
  assert.ok(studentLock >= 0 && taskLock > studentLock, "lock order must be students -> tasks");
  assert.ok(replay > taskLock && version > replay, "ledger replay must precede OCC under both locks");
  assert.match(body, /internal\.legacy_task_deadline_identity/);
  assert.match(body, /internal\.legacy_task_deadline_replace/);
  assert.match(body, /current_task \|\| jsonb_build_object\('dueAt', due_at_value\)/);
  assert.match(body, /then current_task - 'dueAt'/);
  assert.match(body, /command_applied := current_task ->> 'dueAt' is distinct from due_at_value/);
  assert.match(body, /command_applied := current_task \? 'dueAt'/);
  assert.match(body, /when action_value = 'set' then 'legacy_task_deadline\.set_unchanged'/);
  assert.match(body, /else 'legacy_task_deadline\.clear_missing'/);
  assert.match(body, /'applied', command_applied/);
  assert.match(body, /update public\.ops_state set[\s\S]*where entity = 'tasks'/);
  assert.doesNotMatch(body, /where entity = 'students'/);
  assert.match(body, /insert into public\.ops_mutation_log/);
  assert.match(body, /internal\.append_operational_contract_audit/);
  assert.match(body, /insert into internal\.legacy_task_deadline_commands/);
  assert.doesNotMatch(body, /p_tasks|p_students|p_due_at|statement_timeout/);

  const getter = sqlFunction(sql, "public.get_legacy_task_deadline_command_result");
  assert.match(getter, /prior\.command_intent is distinct from p_command_intent/);
  assert.match(getter, /prior\.actor <> p_actor/);
  assert.match(getter, /prior\.applied/);
  const instant = sqlFunction(sql, "internal.legacy_task_deadline_melbourne_instant");
  assert.match(instant, /Australia\/Melbourne/);
  assert.match(instant, /legacy_task_deadline_melbourne_time_nonexistent/);
  assert.match(instant, /legacy_task_deadline_melbourne_time_ambiguous/);
  assert.match(sql, /alter table internal\.legacy_task_deadline_commands enable row level security/);
  assert.match(sql, /revoke all on table internal\.legacy_task_deadline_commands from public, anon, authenticated, service_role/);
  assert.match(sql, /command_key ~ '\^legacy-task-deadline:/);
  assert.match(sql, /applied boolean not null/);
});

test("legacy deadline SQL fixture pins an exact Melbourne instant without deriving from historical due copy", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const fixture = sql.slice(sql.indexOf("do $legacy_task_deadline_fixture$"));
  assert.match(fixture, /"due":"发布后立即"/);
  assert.match(fixture, /'2026-08-19T08:00:00\.000Z'/);
  assert.match(fixture, /projected_tasks #>> '\{0,due\}' <> '发布后立即'/);
  assert.match(fixture, /legacy_task_deadline_fixture_projection_failed/);
});
