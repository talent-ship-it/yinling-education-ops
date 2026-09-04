import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");
const hook = client.slice(client.indexOf("function useSharedState"), client.indexOf("function nowLabel"));

function sliceFrom(start, end) {
  const startIndex = client.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = end ? client.indexOf(end, startIndex) : client.length;
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return client.slice(startIndex, endIndex);
}

test("shared state exposes an authoritative awaited commit and unload guard", () => {
  assert.match(hook, /const mutateAndCommit = useCallback\(/);
  assert.match(hook, /method: "PUT"/);
  assert.match(hook, /expectedVersion: baseline\.version/);
  assert.match(hook, /if \(!response\.ok \|\| !body\.row\)/);
  assert.match(hook, /return row;/);
  assert.match(hook, /beforeunload/);
  assert.match(hook, /event\.returnValue = ""/);
  assert.match(hook, /pagehide/);
  assert.match(hook, /Do not send a fake\s*\/\/\s*beacon/);
  assert.match(hook, /if \(payloadSerialized === committedRef\.current\)/);
  assert.match(hook, /const getCurrentValue = useCallback\(\(\) => valueRef\.current, \[\]\)/);
  assert.match(hook, /getCurrentVersion, getCurrentValue, mutateAndCommit/);
  assert.match(hook, /mutateAndCommit \}/);
});

test("an old PUT receipt cannot roll back a newer authoritative version", () => {
  const commit = hook.slice(hook.indexOf("const mutateAndCommit"), hook.indexOf("return [value"));
  assert.match(commit, /if \(row\.version <= versionRef\.current\)/);
  assert.match(commit, /currentCommittedPayload/);
  assert.match(commit, /JSON\.stringify\(currentCommittedPayload\) === payloadSerialized/);
  assert.match(commit, /version: versionRef\.current/);
  assert.match(commit, /sharedKnownConflict/);
  assert.match(commit, /当前权威版本未被覆盖/);
});

test("user-visible generic saves wait for the commit receipt", () => {
  const paths = [
    ["const completeTask", "const recordTrialParentReply", /tasksShared\.mutateAndCommit/],
    ["const recordTrialParentReply", "const visibleTasks", /tasksShared\.mutateAndCommit/],
    ["const submitStudentEdit", "const submitStudentFollowUp", /await studentsShared\.mutateAndCommit/],
    ["const submitStudentFollowUp", "const submitLessonPackage", /await studentsShared\.mutateAndCommit/],
    ["const submitLessonPackage", "const submitLp", /await studentsShared\.mutateAndCommit/],
    ["const toggleTeacherAvailability", "const submitTeacherCapacity", /await teachersShared\.mutateAndCommit/],
    ["const submitTeacherCapacity", "const setLpStage", /await teachersShared\.mutateAndCommit/],
    ["const setLpStage", "const setLpResult", /await lpShared\.mutateAndCommit/],
    ["const setLpResult", "const retreatLp", /lpShared\.mutateAndCommit/],
    ["const recordMessage", "const resetDemo", /await messagesShared\.mutateAndCommit/],
    ["const submitTask", "const submitNewPayroll", /await tasksShared\.mutateAndCommit/],
    ["const submitNewPayroll", "const submitPayrollEdit", /await mutatePayrollAndCommit/],
    ["const submitPayrollEdit", "const submitLp", /await mutatePayrollAndCommit/],
    ["const submitFile", "const submitTemplate", /await fetch\("\/api\/files"/],
    ["const submitTemplate", "const operationHasSourceBooking", /await messagesShared\.mutateAndCommit/],
  ];

  for (const [start, end, expected] of paths) {
    assert.match(sliceFrom(start, end), expected, `${start} must await its authoritative shared commit`);
  }
});

test("ordinary file registration uses one replay-safe atomic route", () => {
  const path = sliceFrom("const submitFile", "const submitTemplate");
  assert.match(client, /fileLinkCommandKeysRef = useRef\(new Map/);
  assert.match(path, /commandKeyForFileLink/);
  assert.match(path, /await fetch\("\/api\/files"/);
  assert.match(path, /expectedVersions/);
  assert.match(path, /filesShared\.applyRemote\(body\.filesRow/);
  assert.match(path, /studentsShared\.applyRemote\(body\.studentsRow/);
  assert.doesNotMatch(path, /filesShared\.mutateAndCommit/);
  assert.doesNotMatch(path, /studentsShared\.mutateAndCommit/);
  assert.match(path, /可安全重试/);
});
