import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [migration, route, store, client] = await Promise.all([
  read("../supabase/migrations/20260823000100_student_file_link_atomic.sql"),
  read("../app/api/files/route.ts"),
  read("../lib/ops-store.ts"),
  read("../app/operations-client.tsx"),
]);

test("file-center route is a scoped server-only atomic command", () => {
  assert.match(route, /COMMAND_KEY_PATTERN/);
  assert.match(route, /session\.role === "teacher"/);
  assert.match(route, /canOperateStudent\(access, studentId\)/);
  assert.match(route, /expectedVersions\(body\?\.expectedVersions\)/);
  assert.match(route, /putStudentFileLinkAtomic/);
  assert.match(route, /cleanHttpsSource/);
  assert.match(route, /parsed\.protocol !== "https:"/);
  assert.match(route, /const committedRows = allRows\.map/);
  assert.match(route, /filterOpsStateRows\(committedRows, committedAccess\)/);
  assert.match(route, /filesRow: visibleFilesRow/);
  assert.match(route, /studentsRow: visibleStudentsRow/);
  assert.doesNotMatch(route, /putOpsState/);
});

test("file-center browser waits for both authoritative rows and reuses the command key", () => {
  assert.match(client, /fileLinkCommandKeysRef = useRef\(new Map/);
  const start = client.indexOf("const submitFile");
  const end = client.indexOf("const submitTemplate", start);
  assert.ok(start >= 0 && end > start);
  const body = client.slice(start, end);
  assert.match(body, /commandKeyForFileLink/);
  assert.match(body, /expectedVersions/);
  assert.match(body, /await fetch\("\/api\/files"/);
  assert.match(body, /await fetch\("\/api\/fu-attachments"/);
  assert.match(body, /fileStorageMode === "upload"/);
  assert.match(body, /parsedSource\.protocol !== "https:"/);
  assert.match(body, /body\.committed !== true/);
  assert.match(body, /filesShared\.applyRemote\(body\.filesRow/);
  assert.match(body, /studentsShared\.applyRemote\(body\.studentsRow/);
  assert.doesNotMatch(body, /filesShared\.mutateAndCommit/);
  assert.doesNotMatch(body, /studentsShared\.mutateAndCommit/);
});

test("database contract locks files before students, checks OCC, and replays exactly", () => {
  const start = migration.indexOf("create or replace function public.put_student_file_link_atomic");
  const end = migration.indexOf("revoke all on function public.put_student_file_link_atomic", start);
  assert.ok(start >= 0 && end > start);
  const body = migration.slice(start, end);
  assert.match(migration, /create table if not exists internal\.student_file_link_commands/);
  assert.match(migration, /revoke all on table internal\.student_file_link_commands from public, anon, authenticated/);
  assert.match(body, /if not internal\.verify_ops_secret\(p_secret\)/);
  assert.match(body, /where s\.entity = 'files' for update/);
  assert.match(body, /where s\.entity = 'students' for update/);
  assert.ok(body.indexOf("entity = 'files' for update") < body.indexOf("entity = 'students' for update"));
  assert.match(body, /importArchived' = 'true'/);
  assert.match(body, /if prior\.command_key is not null then/);
  assert.match(body, /student_file_link_idempotency_conflict/);
  assert.match(body, /student_file_link_replay_index_mismatch/);
  assert.match(body, /files_state\.version is distinct from expected_files_version/);
  assert.match(body, /students_state\.version is distinct from expected_students_version/);
  assert.match(body, /update public\.ops_state s[\s\S]*where s\.entity = 'files'/);
  assert.match(body, /update public\.ops_state s[\s\S]*where s\.entity = 'students'/);
  assert.match(body, /insert into internal\.student_file_link_commands/);
  assert.match(body, /append_operational_contract_audit/);
  assert.match(migration, /revoke all on function public\.put_student_file_link_atomic[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.put_student_file_link_atomic[\s\S]*to anon, authenticated/);
});

test("server store calls the dedicated RPC with client OCC versions", () => {
  assert.match(store, /STUDENT_FILE_LINK_ATOMIC_PUT_RPC = "put_student_file_link_atomic"/);
  const start = store.indexOf("export function putStudentFileLinkAtomic");
  const end = store.indexOf("export function putStudentFuAttachmentAtomic", start);
  assert.ok(start >= 0 && end > start);
  const body = store.slice(start, end);
  for (const field of ["p_command_key", "p_student_id", "p_file_title", "p_file_type", "p_source", "p_expected_versions", "p_actor"]) {
    assert.match(body, new RegExp(`${field}: input\\.`));
  }
});
