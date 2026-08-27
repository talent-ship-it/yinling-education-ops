import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

function sqlFunction(sql, signature) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  const end = sql.indexOf("revoke all on function", start);
  assert.ok(start >= 0 && end > start, `${signature} function body is missing`);
  return sql.slice(start, end);
}

test("create-if-missing uses a separate RPC and keeps the legacy route compatible", async () => {
  const [route, service, store, migration] = await Promise.all([
    read("../app/api/renewals/follow-up/route.ts"),
    read("../lib/renewal-follow-up-service.ts"),
    read("../lib/ops-store.ts"),
    read("../supabase/migrations/20260824000600_renewal_follow_up_create_if_missing_atomic.sql"),
  ]);
  assert.match(service, /isCreateIfMissingRenewal/);
  assert.match(service, /renewalTaskAnchor/);
  assert.match(route, /putRenewalFollowUpCreateIfMissingAtomic/);
  assert.match(route, /RENEWAL_FOLLOW_UP_CREATE_IF_MISSING_ATOMIC_RPC/);
  assert.match(route, /isCreateIfMissingRenewal\(command\)/);
  assert.match(route, /requiredRpc = createIfMissing/);
  assert.doesNotMatch(route, /useSharedState/);
  assert.doesNotMatch(route, /putOpsState/);
  assert.match(store, /RENEWAL_FOLLOW_UP_CREATE_IF_MISSING_ATOMIC_RPC = "put_renewal_follow_up_create_if_missing_atomic"/);
  const wrapper = store.slice(store.indexOf("export function putRenewalFollowUpCreateIfMissingAtomic"), store.indexOf("export function getRenewalFollowUpCommandResult"));
  for (const field of ["p_command_key", "p_command_intent", "p_renewal_id", "p_student_id", "p_package_id", "p_expected_versions", "p_actor"]) {
    assert.match(wrapper, new RegExp(field), field);
  }
  assert.doesNotMatch(wrapper, /p_owner|p_package_name|p_remaining/);
  assert.match(migration, /create or replace function public\.put_renewal_follow_up_create_if_missing_atomic/);
  assert.match(migration, /public\.put_renewal_follow_up_atomic/);
  assert.match(migration, /grant execute on function public\.put_renewal_follow_up_create_if_missing_atomic/);
});
test("create-if-missing locks state in the shared order and derives package truth server-side", async () => {
  const sql = await read("../supabase/migrations/20260824000600_renewal_follow_up_create_if_missing_atomic.sql");
  const body = sqlFunction(sql, "public.put_renewal_follow_up_create_if_missing_atomic");
  const filesLock = body.indexOf("where s.entity = 'files' for update");
  const renewalsLock = body.indexOf("where s.entity = 'renewals' for update");
  const studentsLock = body.indexOf("where s.entity = 'students' for update");
  const tasksLock = body.indexOf("where s.entity = 'tasks' for update");
  const replay = body.indexOf("prior.command_key is not null");
  const occ = body.indexOf("renewals_state.version is distinct from expected_renewals_version");
  assert.ok(filesLock >= 0 && renewalsLock > filesLock && studentsLock > renewalsLock && tasksLock > studentsLock);
  assert.ok(replay > tasksLock && occ > replay);
  for (const marker of [
    "internal.verify_ops_secret",
    "internal.validate_renewal_follow_up_intent",
    "lessonPackages",
    "purchaseRecords",
    "package_remaining",
    "inactive_student_renewal_follow_up_forbidden",
    "renewal_follow_up_create_if_missing_package_unassociated",
    "renewal_follow_up_create_if_missing_identity_conflict",
    "adjusted_expected_versions",
    "jsonb_build_object",
  ]) assert.match(body, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")), marker);
  assert.doesNotMatch(body, /p_owner|p_package_name|p_remaining/);
  assert.match(sql, /revoke all on function public\.put_renewal_follow_up_create_if_missing_atomic[\s\S]*service_role/);
});
