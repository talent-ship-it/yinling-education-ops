import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const client = fs.readFileSync(
  path.resolve(import.meta.dirname, "../app/operations-client.tsx"),
  "utf8",
);

test("LP form student selection is an observable draft and remounts student-derived defaults", () => {
  const dialogStart = client.indexOf('{modal === "lp" &&');
  const dialogEnd = client.indexOf('{modal === "lpRevision"', dialogStart);
  assert.ok(dialogStart >= 0 && dialogEnd > dialogStart);
  const dialog = client.slice(dialogStart, dialogEnd);

  assert.match(dialog, /name="studentId"[^>]*value=\{lpDraftStudentId\}/);
  assert.match(dialog, /onChange=\{\(event\) => setLpDraftStudentId/);
  assert.match(dialog, /key=\{lpDraftStudentId\}/);
  assert.match(dialog, /responsibleOperations: lpDraftOwner/);
  assert.match(client, /const lpDraftOwner = isFullAdminSession && isAdminView \? resolveAssignableOperationsOwner\(lpDraftStudent\?\.owner\) \?\? "" : lpDraftStudent\?\.owner \?\? ""/);
  assert.match(dialog, /lpDraftStudent\?\.planner/);
  assert.match(dialog, /lpDraftStudent\?\.lessonPackages/);
  assert.match(dialog, /studentId: lpDraftStudentId/);
  assert.match(dialog, /name="provisionalPlanner"/);
  assert.match(dialog, /planner: lpDraftStudent\?\.planner === "Tara" \|\| lpDraftStudent\?\.planner === "Eileen" \|\| lpDraftStudent\?\.planner === "Abby" \? lpDraftStudent\.planner : "Tara"/);
  assert.doesNotMatch(dialog, /name="planner"/);
  assert.doesNotMatch(dialog, /initialValues=\{\{[^}]*selectedStudent\./);
});

test("LP submit derives owner and planner from the submitted student id", () => {
  const submitStart = client.indexOf("const submitLp = async");
  const submitEnd = client.indexOf("const submitLpRevision", submitStart);
  const submit = client.slice(submitStart, submitEnd);
  assert.match(submit, /const existingStudent = studentById\(studentId\)/);
  assert.match(submit, /existingStudent\?\.owner/);
  assert.match(submit, /existingStudent\?\.planner/);
  assert.match(submit, /data\.get\("provisionalPlanner"\)/);
  assert.doesNotMatch(submit, /data\.get\("planner"\)/);
});
