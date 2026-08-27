import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("../app/api/operations/permanent-replacement/route.ts", import.meta.url);
const storeUrl = new URL("../lib/ops-store.ts", import.meta.url);

test("permanent replacement route uses one replayable four-entity atomic command", async () => {
  const [route, store] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(storeUrl, "utf8"),
  ]);
  assert.match(route, /parsePermanentTeacherReplacementCommand/);
  assert.match(route, /getOpsState\(\["bookings", "operations", "students", "teachers"\]\)/);
  assert.match(route, /canOperateStudent/);
  assert.match(route, /getPermanentTeacherReplacementCommandResult/);
  assert.ok(
    route.indexOf("canOperateStudent") < route.indexOf("getPermanentTeacherReplacementCommandResult({"),
    "scope must be checked before replay is returned",
  );
  assert.ok(
    route.indexOf("getPermanentTeacherReplacementCommandResult({")
      < route.indexOf("preparePermanentTeacherReplacement({"),
    "stable-intent replay must be checked before stale OCC versions",
  );
  const replayBranch = route.slice(route.indexOf("if (replay[0])"), route.indexOf("const prepared ="));
  assert.match(replayBranch, /await getOpsState\(\["bookings", "operations", "students", "teachers"\]\)/);
  assert.match(replayBranch, /buildOpsAccessContext\(replayRows, actor, fullAdmin, session\)/);
  assert.match(replayBranch, /filterOpsStateRows\(replayRows, replayAccess\)/);
  assert.match(replayBranch, /canOperateStudent\(replayAccess, replayOperation\.studentId\)/);
  assert.doesNotMatch(replayBranch, /Object\.fromEntries\(visibleRows/);
  assert.match(route, /confirmPermanentTeacherReplacementAtomic\(\{ \.\.\.prepared, actor \}\)/);
  assert.doesNotMatch(route, /putOpsState/);
  for (const row of ["bookings_row", "operations_row", "teachers_row", "students_row"]) {
    assert.match(route, new RegExp(row));
  }
  assert.match(route, /permanent_teacher_replacement_contract_unavailable/);

  assert.match(store, /PERMANENT_TEACHER_REPLACEMENT_ATOMIC_RPC = "confirm_permanent_teacher_replacement_atomic"/);
  assert.match(store, /PERMANENT_TEACHER_REPLACEMENT_COMMAND_RESULT_RPC = "get_permanent_teacher_replacement_command_result"/);
  const wrapper = store.slice(store.indexOf("export function confirmPermanentTeacherReplacementAtomic"));
  for (const field of [
    "p_expected_versions",
    "p_bookings",
    "p_operations",
    "p_teachers",
    "p_students",
    "p_affected_occurrence_ids",
    "p_changed_teacher_ids",
  ]) {
    assert.match(wrapper, new RegExp(field));
  }
});
