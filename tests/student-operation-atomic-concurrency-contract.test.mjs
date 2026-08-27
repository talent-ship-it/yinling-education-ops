import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studentSql = await readFile(new URL("../supabase/migrations/20260821191021_student_creation_students_tasks_atomic.sql", import.meta.url), "utf8");
const legacySql = await readFile(new URL("../supabase/migrations/20260821191022_legacy_operation_task_atomic.sql", import.meta.url), "utf8");
const fixture = await readFile(new URL("./sql/student-operation-atomic-concurrency.sql", import.meta.url), "utf8");

for (const [name, sql] of [["student", studentSql], ["legacy", legacySql]]) {
  test(`${name} lock helper follows the 191019 materialized snapshot contract`, () => {
    assert.match(sql, /with desired\(entity, lock_order\) as/i);
    assert.match(sql, /ordered_locks as materialized/i);
    assert.match(sql, /stable_snapshot as materialized/i);
    assert.match(sql, /select array_agg\(state order by desired\.lock_order\) as rows/i);
    assert.match(sql, /for share of state/i);
  });
}

test("concurrency fixture includes EXPLAIN and three dblink sessions", () => {
  assert.match(fixture, /explain \(costs off\)/i);
  assert.match(fixture, /ordered_locks as materialized/i);
  assert.match(fixture, /stable_snapshot as materialized/i);
  assert.match(fixture, /student-op-a/);
  assert.match(fixture, /student-op-b/);
  assert.match(fixture, /student-op-replay/);
  assert.match(fixture, /dblink_send_query/);
});

test("writers do not SHARE-to-UPDATE upgrade and recheck the ledger after exclusive locks", () => {
  const studentMutator = studentSql.slice(studentSql.indexOf("create or replace function public.create_student_with_tasks_atomic"));
  assert.doesNotMatch(studentMutator, /internal\.lock_student_creation_state\(\)/);
  const studentStudentsLock = studentMutator.indexOf("where entity = 'students' for update");
  const studentTasksLock = studentMutator.indexOf("where entity = 'tasks' for update");
  const studentLedger = studentMutator.indexOf("select * into prior from internal.student_creation_commands as ledger where ledger.command_key = command_uuid");
  const studentOcc = studentMutator.indexOf("students_state.version <> (p_expected_versions ->> 'students')::bigint");
  assert.ok(studentStudentsLock >= 0 && studentTasksLock > studentStudentsLock && studentLedger > studentTasksLock && studentOcc > studentLedger);

  const legacyMutator = legacySql.slice(legacySql.indexOf("create or replace function public.mutate_legacy_operation_task_atomic"));
  assert.doesNotMatch(legacyMutator, /internal\.lock_legacy_operation_task_state\(\)/);
  const lockPositions = ["bookings", "operations", "students", "tasks", "teachers"].map((entity) =>
    legacyMutator.indexOf(`where entity = '${entity}' for update`));
  assert.ok(lockPositions.every((position) => position >= 0));
  assert.ok(lockPositions.every((position, index) => index === 0 || position > lockPositions[index - 1]));
  const legacyLedger = legacyMutator.indexOf("select * into prior from internal.legacy_operation_task_commands as ledger where ledger.command_key = command_uuid");
  const legacyOcc = legacyMutator.indexOf("b.version <> (p_expected_versions ->> 'bookings')::bigint");
  assert.ok(legacyLedger > lockPositions.at(-1) && legacyOcc > legacyLedger);
});

test("both replay getters re-read the ledger after the ordered lock", () => {
  const studentLock = studentSql.indexOf("select * into state_row from internal.lock_student_creation_state()");
  const studentLedger = studentSql.indexOf("select * into prior from internal.student_creation_commands as ledger where ledger.command_key", studentLock);
  assert.ok(studentLock >= 0 && studentLedger > studentLock);
  const legacyLock = legacySql.indexOf("select * into state_row from internal.lock_legacy_operation_task_state()");
  const legacyLedger = legacySql.indexOf("select * into prior from internal.legacy_operation_task_commands as ledger where ledger.command_key", legacyLock);
  assert.ok(legacyLock >= 0 && legacyLedger > legacyLock);
});
