import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [route, service] = await Promise.all([
  readFile(new URL("../app/api/operations/departure/create/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/teacher-departure-creation-service.ts", import.meta.url), "utf8"),
]);

test("departure preview is an explicit no-store read-only branch", () => {
  assert.match(route, /preview === true/);
  assert.match(route, /if \(isPreview\)/);
  assert.match(route, /prepareTeacherDepartureCreation\(\{[\s\S]*role: session\.role/);
  assert.match(route, /affectedGroups: preparedPreview\.affectedGroups\.map/);
  assert.match(route, /subjects/);
  assert.match(route, /firstAffectedAt/);
  assert.match(route, /affectedOccurrenceCount: affectedOccurrenceIds\.length/);
  assert.match(route, /Cache-Control": "private, no-store"/);
  const previewBranch = route.slice(route.indexOf("if (isPreview)"), route.indexOf("const replay ="));
  assert.doesNotMatch(previewBranch, /getTeacherDepartureCreationCommandResult/);
  assert.doesNotMatch(previewBranch, /createTeacherDepartureAtomic/);
});

test("preview:false is not silently treated as a preview envelope", () => {
  assert.match(route, /const commandBody = isPreview[\s\S]*: rawBody;/);
  assert.match(route, /parseTeacherDepartureCreationCommand\(commandBody\)/);
});

test("departure preparation derives exact first occurrence metadata", () => {
  assert.match(service, /subjects: readonly string\[\]/);
  assert.match(service, /firstAffectedAt: string/);
  assert.match(service, /occurrenceInstant\(firstAffected\.occurrence, firstAffected\.booking\)\.toISOString\(\)/);
  assert.match(service, /affectedOccurrenceIds\.length/);
});

test("departure replay reports the persisted managed task count instead of assuming five per student", () => {
  assert.match(route, /function generatedDepartureTaskCount/);
  assert.match(route, /task\.ruleKey\.startsWith\("teacher-departure:"\)/);
  assert.match(route, /generatedTaskCount: generatedDepartureTaskCount\(taskRow, replay\[0\]\.operation_ids\)/);
  assert.doesNotMatch(route, /generatedTaskCount: replay\[0\]\.operation_ids\.length \* 5/);
});
