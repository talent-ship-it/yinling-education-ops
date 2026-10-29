import assert from "node:assert/strict";
import { test } from "node:test";
import { materialsPreviewResult, resolveMaterialsViewer } from "../lib/classroom-materials-preview.ts";

const teacher = { account_id: "teacher-a", account_role: "teacher", status: "active" };
const findTeacher = async () => teacher;

test("normal teacher listing stays bound to the signed actor", async () => {
  assert.deepEqual(await resolveMaterialsViewer({ accountId: "self", role: "teacher" }, null, async () => assert.fail("unexpected lookup")), { accountId: "self", preview: false });
});

test("admin previews resolve an active teacher account and remain read-only", async () => {
  for (const role of ["admin", "limited-admin"]) {
    assert.deepEqual(await resolveMaterialsViewer({ accountId: "admin", role, permissions: ["classroom.materials.read"] }, "Synthetic Teacher", findTeacher), { accountId: teacher.account_id, preview: true });
  }
});

test("teacher and staff cannot request another teacher's resource list", async () => {
  for (const role of ["teacher", "staff"]) {
    await assert.rejects(resolveMaterialsViewer({ accountId: "self", role }, "Synthetic Teacher", async () => assert.fail("must reject before lookup")), { code: "materials_forbidden", status: 403 });
  }
});

test("preview rejects disabled, missing, and non-teacher accounts", async () => {
  const session = { accountId: "admin", role: "admin", permissions: ["*"] };
  for (const account of [null, { ...teacher, status: "disabled" }, { ...teacher, status: "invited" }, { ...teacher, account_role: "admin" }]) {
    await assert.rejects(resolveMaterialsViewer(session, "Synthetic Teacher", async () => account), { code: "materials_not_found", status: 404 });
  }
  for (const name of [" Synthetic Teacher", "x".repeat(181), "Teacher\nOther"]) {
    await assert.rejects(resolveMaterialsViewer(session, name, async () => assert.fail("invalid name must not be looked up")), { code: "materials_invalid_input" });
  }
});

test("an admin role without material read permission cannot borrow teacher grants", async () => {
  for (const permissions of [undefined, [], ["accounts.read"]]) {
    await assert.rejects(resolveMaterialsViewer({ accountId: "admin", role: "admin", permissions }, "Synthetic Teacher", async () => assert.fail("permission must be checked first")), { code: "materials_forbidden", status: 403 });
  }
});

test("preview hides management and downloads without changing the underlying teacher grants", () => {
  const result = { canManage: true, materials: [{ id: "material-a", title: "Synthetic", canDownload: true }] };
  assert.equal(materialsPreviewResult(result, false), result);
  assert.deepEqual(materialsPreviewResult(result, true), { canManage: false, materials: [{ id: "material-a", title: "Synthetic", canDownload: false }] });
  assert.equal(result.materials[0].canDownload, true);
});
