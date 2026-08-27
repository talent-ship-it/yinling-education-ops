import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("FU upload route sends one narrow atomic command and returns canonical shared rows", async () => {
  const [route, store] = await Promise.all([
    read("../app/api/fu-attachments/route.ts"),
    read("../lib/ops-store.ts"),
  ]);
  assert.match(route, /COMMAND_KEY_PATTERN/);
  assert.match(route, /canOperateStudent\(access, studentId\)/);
  assert.match(route, /expectedVersions: \{ files: filesRow\.version, students: studentsRow\.version \}/);
  assert.match(route, /putStudentFuAttachmentAtomic/);
  assert.match(route, /const committedRows = allRows\.map/);
  assert.match(route, /buildOpsAccessContext\(committedRows, actor, fullAdmin, session\)/);
  assert.match(route, /filterOpsStateRows\(committedRows, committedAccess\)/);
  assert.match(route, /filesRow: visibleFilesRow/);
  assert.match(route, /studentsRow: visibleStudentsRow/);
  assert.doesNotMatch(route, /filesRow: result\.files_row/);
  assert.doesNotMatch(route, /studentsRow: result\.students_row/);
  assert.doesNotMatch(route, /putOpsState/);
  assert.match(store, /STUDENT_FU_ATTACHMENT_ATOMIC_PUT_RPC = "put_student_fu_attachment_atomic"/);
  assert.match(store, /p_command_key: input\.commandKey/);
  assert.match(store, /p_expected_versions: input\.expectedVersions/);
});

test("FU upload UI applies the two rows returned by the transaction without local index writes", async () => {
  const client = await read("../app/operations-client.tsx");
  assert.match(client, /attachmentCommandKeysRef = useRef\(new Map/);
  assert.match(client, /existing\?\.intent === intent/);
  assert.match(client, /commandKeyForAttachment\("evidence"/);
  assert.match(client, /commandKeyForAttachment\("report"/);
  assert.match(client, /commandKeyForAttachment\("renewal"/);
  assert.match(client, /clearAttachmentCommandKey\("evidence"/);
  assert.match(client, /clearAttachmentCommandKey\("report"/);
  assert.match(client, /clearAttachmentCommandKey\("renewal"/);
  for (const [startName, endName] of [
    ["const submitStudentEvidence", "const submitStudentReport"],
    ["const submitStudentReport", "const submitStudentFollowUp"],
    ["const submitRenewalFollowUp", "const submitFile"],
  ]) {
    const start = client.indexOf(startName);
    const end = client.indexOf(endName, start + startName.length);
    assert.ok(start >= 0 && end > start, `${startName} section exists`);
    const body = client.slice(start, end);
    assert.match(body, /commandKey/);
    assert.match(body, /filesShared\.applyRemote\(body\.filesRow/);
    assert.match(body, /studentsShared\.applyRemote\(body\.studentsRow/);
    assert.doesNotMatch(body, /setFiles\(/);
    assert.doesNotMatch(body, /files: (?:student|item)\.files \+ 1/);
  }
});

test("database stores attachment plus file/student indexes in one secret-only idempotent transaction", async () => {
  const sql = await read("../supabase/migrations/20260813013935_operational_atomic_contracts.sql");
  const start = sql.indexOf("create or replace function public.put_student_fu_attachment_atomic");
  const end = sql.indexOf("revoke all on function public.put_student_fu_attachment_atomic", start);
  assert.ok(start >= 0 && end > start);
  const body = sql.slice(start, end);
  assert.match(sql, /create table if not exists internal\.student_fu_attachment_commands/);
  assert.match(body, /if not internal\.verify_ops_secret\(p_secret\)/);
  assert.match(body, /where s\.entity = 'students' for update/);
  assert.match(body, /where s\.entity = 'files' for update/);
  assert.match(body, /importArchived' = 'true'/);
  assert.match(body, /attachment_content_type_mismatch/);
  assert.match(body, /p_expected_versions - 'files' - 'students' <> '\{\}'::jsonb/);
  assert.match(body, /expected_files_version is null or expected_files_version < 1/);
  assert.match(body, /expected_students_version is null or expected_students_version < 1/);
  assert.match(body, /files_state\.version is distinct from expected_files_version/);
  assert.match(body, /students_state\.version is distinct from expected_students_version/);
  assert.ok(body.indexOf("importArchived") < body.indexOf("if prior.command_key is not null then"));
  assert.match(body, /saved_attachment\.student_id is distinct from prior\.student_id/);
  assert.match(body, /item ->> 'id' = prior\.file_id/);
  assert.match(body, /item ->> 'source' = '\/api\/fu-attachments\/' \|\| prior\.attachment_id::text/);
  assert.match(body, /fu_attachment_replay_index_mismatch/);
  assert.match(body, /insert into internal\.student_fu_attachments/);
  assert.match(body, /update public\.ops_state s[\s\S]*where s\.entity = 'files'/);
  assert.match(body, /update public\.ops_state s[\s\S]*where s\.entity = 'students'/);
  assert.match(body, /insert into internal\.student_fu_attachment_commands/);
  assert.match(body, /append_operational_contract_audit/);
  assert.match(body, /'\/api\/fu-attachments\/'/);
  assert.match(sql, /revoke all on table internal\.student_fu_attachment_commands from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public\.put_student_fu_attachment_atomic[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.put_student_fu_attachment_atomic[\s\S]*to anon, authenticated/);
});
