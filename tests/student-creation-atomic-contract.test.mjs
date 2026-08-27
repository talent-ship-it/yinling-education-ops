import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase/migrations/20260821191021_student_creation_students_tasks_atomic.sql", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/operations/students/create/route.ts", import.meta.url), "utf8");

test("student creation is server-owned and has no client payload arrays", () => {
  assert.match(sql, /create table if not exists internal\.student_creation_commands/i);
  assert.match(sql, /create or replace function public\.create_student_with_tasks_atomic\(/i);
  assert.match(sql, /internal\.validate_student_creation_fields\(p_student_fields\)/i);
  assert.match(sql, /student_id_value := 'STU-'[\s\S]*extensions\.digest/i);
  assert.match(sql, /next_students := jsonb_build_array\(student_item\) \|\| students_state\.payload/i);
  assert.match(sql, /next_tasks := next_tasks \|\| tasks_state\.payload/i);
  assert.match(sql, /assignee_ids[\s\S]*planner[\s\S]*待分配/i);
  assert.match(sql, /'watchers', jsonb_build_array\('Ops Admin'\)/i);
  assert.doesNotMatch(sql, /p_students\s+jsonb|p_tasks\s+jsonb/i);
  assert.match(route, /getStudentCreationCommandResult/);
  assert.match(route, /createStudentWithTasksAtomic/);
  const handler = route.slice(route.indexOf("export async function POST"));
  const sessionAt = handler.indexOf("const resolved = await getCurrentDemoSession");
  const replayAt = handler.indexOf("const replay = await getStudentCreationCommandResult");
  assert.ok(sessionAt >= 0 && sessionAt < replayAt);
  assert.ok(handler.indexOf('session.role === "teacher"') > replayAt);
  assert.doesNotMatch(route, /\bgetDemoSession\(/);
  assert.match(route, /canonicalizeStudentCreationCommand/);
  assert.match(route, /authorizeStudentCreationCommand/);
  assert.match(route, /receiptOnly: true/);
  const receiptStart = route.indexOf("function receiptOnly");
  const receiptEnd = route.indexOf("function record", receiptStart);
  assert.ok(receiptStart >= 0 && receiptEnd > receiptStart);
  const receiptBody = route.slice(receiptStart, receiptEnd);
  assert.doesNotMatch(receiptBody, /studentId|taskIds|studentsRow|tasksRow/);
  assert.match(route, /不会降级为分散写入/);
});

test("student creation locks, versions, audits, and grants are explicit", () => {
  assert.match(sql, /lock_student_creation_state/i);
  assert.match(sql, /'students'::text, 1[\s\S]*'tasks'::text, 2/i);
  assert.match(sql, /students_state\.version <> \(p_expected_versions ->> 'students'\)::bigint/i);
  assert.match(sql, /tasks_state\.version <> \(p_expected_versions ->> 'tasks'\)::bigint/i);
  assert.match(sql, /internal\.append_operational_contract_audit\('student\.create_with_tasks'/i);
  assert.match(sql, /revoke all on function public\.create_student_with_tasks_atomic\(text, text, jsonb, jsonb, jsonb, text\)/i);
  assert.match(sql, /grant execute on function public\.create_student_with_tasks_atomic\(text, text, jsonb, jsonb, jsonb, text\) to anon, authenticated/i);
  assert.match(sql, /prior\.command_intent is distinct from p_command_intent or prior\.actor <> btrim\(p_actor\)/i);
});
