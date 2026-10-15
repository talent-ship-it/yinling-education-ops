import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSIGNABLE_DEMO_STAFF_USERS,
  matchesOperationsOwnerFilter,
  operationsOwnerFilterOptions,
  operationsOwnerFormOptions,
  resolveAssignableOperationsOwner,
} from "../lib/demo-users";
import { TRIAL_OPERATIONS } from "../lib/lp-workflows";

const staff = ["Abby", "Ella", "Erin", "Molly", "Thea", "Tiffany"];

test("current assignment and trial validation share the six operations staff", () => {
  assert.deepEqual([...ASSIGNABLE_DEMO_STAFF_USERS].sort(), staff);
  assert.equal(TRIAL_OPERATIONS, ASSIGNABLE_DEMO_STAFF_USERS);
  for (const owner of ["Nixon", "Ops Admin", "Tara", "Eileen", "思佳", "", "Unknown"]) {
    assert.equal(resolveAssignableOperationsOwner(owner), null);
  }
});

test("operations filters include staff without records and retain historical ownership", () => {
  assert.deepEqual(operationsOwnerFilterOptions([]), staff);
  assert.deepEqual(operationsOwnerFilterOptions(["Abby", " ELLA ", "Ella 教务", "Nixon", "思佳", " "]), [
    ...staff, "Nixon", "思佳",
  ].sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true })));
  assert.equal(matchesOperationsOwnerFilter("Ella", " ＥＬＬＡ 教务 "), true);
  assert.equal(matchesOperationsOwnerFilter("all", "思佳"), true);
  assert.equal(matchesOperationsOwnerFilter("Nixon", "Nixon"), true);
  assert.equal(matchesOperationsOwnerFilter("Ella", "Nixon"), false);
});

test("new assignments use the six staff while existing planner self-service stays usable", () => {
  assert.deepEqual(operationsOwnerFormOptions(), staff);
  for (const actor of ["Tara", "Eileen", "Ops Admin", "Nixon", "思佳", "Historical Owner"]) {
    assert.deepEqual(operationsOwnerFormOptions(actor), [...staff, actor].sort());
  }
  assert.deepEqual(operationsOwnerFormOptions(" "), staff);
  assert.ok(operationsOwnerFormOptions("ELLA 教务").includes("ELLA 教务"));
});
