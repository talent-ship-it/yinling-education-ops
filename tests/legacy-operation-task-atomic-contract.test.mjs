import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase/migrations/20260821191022_legacy_operation_task_atomic.sql", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/operations/legacy/create/route.ts", import.meta.url), "utf8");
const service = await readFile(new URL("../lib/legacy-operation-task-service.ts", import.meta.url), "utf8");

test("legacy leave and replacement use one operations/tasks command", () => {
  assert.match(service, /学生请假/);
  assert.match(service, /停课/);
  assert.match(service, /换老师/);
  assert.match(sql, /create or replace function public\.mutate_legacy_operation_task_atomic\(/i);
  assert.doesNotMatch(sql, /p_operations_to_add|p_tasks_to_add/);
  assert.match(sql, /legacy_operation_task_projection/i);
  assert.match(sql, /jsonb_array_length\(projection -> 'operations'\)/i);
  assert.match(sql, /bookings.*operations.*students.*tasks.*teachers/s);
  assert.match(sql, /recommendedTeacherIds/i);
  assert.match(sql, /assignee_ids[\s\S]*planner[\s\S]*待分配/i);
  assert.match(sql, /'watchers', jsonb_build_array\('Ops Admin'\)/i);
  assert.match(route, /mutateLegacyOperationTaskAtomic/);
  const handler = route.slice(route.indexOf("export async function POST"));
  const sessionAt = handler.indexOf("const resolved = await getCurrentDemoSession");
  const replayAt = handler.indexOf("const replay = await getLegacyOperationTaskCommandResult");
  assert.ok(sessionAt >= 0 && sessionAt < replayAt);
  assert.ok(handler.indexOf('session.role === "teacher"') > replayAt);
  assert.doesNotMatch(route, /\bgetDemoSession\(/);
  assert.match(route, /receiptOnly: true/);
  const receiptStart = route.indexOf("function receiptOnly");
  const receiptEnd = route.indexOf("function record", receiptStart);
  assert.ok(receiptStart >= 0 && receiptEnd > receiptStart);
  const receiptBody = route.slice(receiptStart, receiptEnd);
  assert.doesNotMatch(receiptBody, /operationIds|affectedStudentIds|operationRow|taskRow/);
  assert.match(route, /不会降级为分散写入/);
});

test("legacy command is OCC/idempotent/audited and replay is actor-bound", () => {
  assert.match(sql, /b\.version <> \(p_expected_versions ->> 'bookings'\)::bigint/i);
  assert.match(sql, /o\.version <> \(p_expected_versions ->> 'operations'\)::bigint/i);
  assert.match(sql, /s\.version <> \(p_expected_versions ->> 'students'\)::bigint/i);
  assert.match(sql, /t\.version <> \(p_expected_versions ->> 'tasks'\)::bigint/i);
  assert.match(sql, /h\.version <> \(p_expected_versions ->> 'teachers'\)::bigint/i);
  assert.match(sql, /internal\.append_operational_contract_audit\('operation\.legacy_operation_task_create'/i);
  assert.match(sql, /prior\.command_intent is distinct from p_command_intent or prior\.actor <> actor_value/i);
  assert.match(sql, /revoke all on function public\.mutate_legacy_operation_task_atomic\(text, text, jsonb, text, text, text, text, text, text, text, jsonb, text\)/i);
  assert.match(sql, /grant execute on function public\.mutate_legacy_operation_task_atomic\(text, text, jsonb, text, text, text, text, text, text, text, jsonb, text\) to anon, authenticated/i);
  assert.match(sql, /language plpgsql volatile security definer/i);
});
