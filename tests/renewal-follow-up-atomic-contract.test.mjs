import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const migrationUrl = new URL("../supabase/migrations/20260824000400_renewal_follow_up_atomic.sql", import.meta.url);

function sqlFunction(sql, signature) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  const end = sql.indexOf("revoke all on function", start);
  assert.ok(start >= 0 && end > start, `${signature} function body is missing`);
  return sql.slice(start, end);
}

test("renewal UI sends one atomic command and applies all authoritative rows", async () => {
  const [client, route, store, service] = await Promise.all([
    read("../app/operations-client.tsx"),
    read("../app/api/renewals/follow-up/route.ts"),
    read("../lib/ops-store.ts"),
    read("../lib/renewal-follow-up-service.ts"),
  ]);
  const submit = client.slice(client.indexOf("const submitRenewalFollowUp"), client.indexOf("const submitFile"));
  assert.match(client, /renewal-follow-up:\$\{crypto\.randomUUID\(\)\}/);
  assert.match(submit, /expectedVersions/);
  assert.match(submit, /fetch\("\/api\/renewals\/follow-up"/);
  assert.match(submit, /renewalsShared\.applyRemote\(body\.renewalsRow/);
  assert.match(submit, /studentsShared\.applyRemote\(body\.studentsRow/);
  assert.match(submit, /filesShared\.applyRemote\(body\.filesRow/);
  assert.match(submit, /tasksShared\.applyRemote\(body\.tasksRow/);
  assert.match(submit, /tasks: tasksShared\.version/);
  assert.doesNotMatch(submit, /renewalsShared\.mutateAndCommit/);
  assert.doesNotMatch(submit, /studentsShared\.mutateAndCommit/);
  assert.doesNotMatch(submit, /fetch\("\/api\/fu-attachments"/);
  assert.match(route, /parseRenewalFollowUpCommand/);
  assert.match(route, /getRenewalFollowUpCommandResult/);
  assert.match(route, /canOperateStudent\(access, command\.studentId\)/);
  assert.match(route, /prepareRenewalFollowUp/);
  assert.match(route, /putRenewalFollowUpAtomic/);
  assert.match(route, /\["renewals", "students", "files", "tasks", "teachers"\]/);
  assert.match(route, /tasksRow: committed\.tasksRow/);
  assert.match(route, /filterOpsStateRows/);
  assert.doesNotMatch(route, /putOpsState/);
  assert.match(service, /assertOnlyFields/);
  assert.match(service, /stale_expected_version/);
  assert.match(service, /renewal_identity_conflict/);
  assert.match(store, /RENEWAL_FOLLOW_UP_ATOMIC_RPC = "put_renewal_follow_up_atomic"/);
  assert.match(store, /RENEWAL_FOLLOW_UP_COMMAND_RESULT_RPC = "get_renewal_follow_up_command_result"/);
});

test("renewal SQL locks all affected entities, derives student history, and replays by actor intent", async () => {
  const sql = await read(migrationUrl);
  const body = sqlFunction(sql, "public.put_renewal_follow_up_atomic");
  const attachmentLock = body.indexOf("lock table internal.student_fu_attachments");
  const filesLock = body.indexOf("where s.entity = 'files' for update");
  const renewalsLock = body.indexOf("where s.entity = 'renewals' for update");
  const studentsLock = body.indexOf("where s.entity = 'students' for update");
  const tasksLock = body.indexOf("where s.entity = 'tasks' for update");
  const replay = body.indexOf("prior.command_key is not null");
  const version = body.indexOf("renewals_state.version is distinct from expected_renewals_version");
  assert.ok(attachmentLock >= 0 && filesLock > attachmentLock && renewalsLock > filesLock && studentsLock > renewalsLock && tasksLock > studentsLock);
  assert.ok(replay > studentsLock && version > replay);
  for (const marker of [
    "internal.verify_ops_secret",
    "internal.validate_renewal_follow_up_intent",
    "renewal_follow_up_idempotency_conflict",
    "renewal_follow_up_replay_index_mismatch",
    "attachment_content_type_mismatch",
    "attachment_hash_mismatch",
    "renewal_follow_up_identity_conflict",
    "renewal_follow_up_task_identity_conflict",
    "tasks_state.version is distinct from expected_tasks_version",
    "task_changed",
    "update public.ops_state",
    "where s.entity = 'tasks'",
    "followUpHistory",
    "append_operational_contract_audit",
    "insert into internal.renewal_follow_up_commands",
  ]) assert.match(body, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), marker);
  assert.match(sql, /alter table internal\.renewal_follow_up_commands enable row level security/);
  assert.match(sql, /revoke all on table internal\.renewal_follow_up_commands from public, anon, authenticated/);
  assert.match(sql, /create or replace function public\.get_renewal_follow_up_command_result/);
  assert.match(sql, /revoke all on function public\.put_renewal_follow_up_atomic[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.put_renewal_follow_up_atomic[\s\S]*to anon, authenticated/);
});
