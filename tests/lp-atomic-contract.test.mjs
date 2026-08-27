import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../supabase/migrations/20260819101600_lp_create_revision_atomic.sql", import.meta.url), "utf8");
const attachmentMigration = await readFile(new URL("../supabase/migrations/20260813013935_operational_atomic_contracts.sql", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/operations/lp/route.ts", import.meta.url), "utf8");
const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");

test("LP migration provides replay-safe atomic create/revision contract", () => {
  assert.match(migration, /create table if not exists internal\.lp_atomic_commands/i);
  assert.match(migration, /create or replace function public\.get_lp_atomic_command_result/i);
  assert.match(migration, /create or replace function public\.mutate_lp_atomic/i);
  const lpStateLocks = [...migration.matchAll(/select \* into \w+ from public\.ops_state where entity = '([^']+)' for update;/g)].map((match) => match[1]);
  assert.deepEqual(lpStateLocks, [
    "files", "students", "lpItems", "tasks",
    "files", "students", "lpItems", "tasks",
    "files", "students", "lpItems", "tasks",
  ], "every LP writer/replay lock path must use the attachment-compatible global order");
  const attachmentStart = attachmentMigration.indexOf("create or replace function public.put_student_fu_attachment_atomic");
  const attachmentEnd = attachmentMigration.indexOf("revoke all on function public.put_student_fu_attachment_atomic", attachmentStart);
  const attachmentBody = attachmentMigration.slice(attachmentStart, attachmentEnd);
  assert.ok(attachmentBody.indexOf("entity = 'files' for update") < attachmentBody.indexOf("entity = 'students' for update"), "attachment transaction establishes files before students");
  assert.match(migration, /if prior\.command_uuid is not null/i);
  assert.match(migration, /insert into internal\.lp_atomic_commands/i);
  assert.match(migration, /insert into public\.ops_mutation_log/i);
  assert.match(migration, /STU-PROVISIONAL-[\s\S]*digest\(command_key \|\| chr\(31\) \|\| 'student'/i);
  assert.match(migration, /p_authorized_assignment[\s\S]*lp_assignment_forbidden/i);
  assert.match(migration, /'学生报名交接'[\s\S]*jsonb_build_array\(owner_value, planner_value\)/i);
  assert.match(migration, /trial\.parent-follow-up' then greatest\([\s\S]*date \+ time '18:00'[\s\S]*at time zone 'Australia\/Melbourne'/i);
  assert.match(migration, /revoke all on function public\.mutate_lp_atomic/i);
});

test("LP route and browser never fall back to partial local writes", () => {
  assert.match(route, /getLpAtomicCommandResult/);
  assert.match(route, /mutateLpAtomic/);
  assert.match(route, /direct_enrollment_required/);
  assert.doesNotMatch(route, /createLpWorkflow/);
  const ordinaryPath = client.slice(client.indexOf('const submitLp = async'), client.indexOf('const submitTeacherAvailability'));
  assert.match(ordinaryPath, /\/api\/operations\/lp/);
  assert.match(ordinaryPath, /studentsShared\.applyRemote/);
  assert.match(ordinaryPath, /lpShared\.applyRemote/);
  assert.match(ordinaryPath, /tasksShared\.applyRemote/);
  assert.match(ordinaryPath, /filesShared\.applyRemote/);
  assert.match(ordinaryPath, /provisionalIntake/);
  assert.doesNotMatch(ordinaryPath, /setStudents\(/);
  assert.doesNotMatch(ordinaryPath, /createLpWorkflow/);
});
