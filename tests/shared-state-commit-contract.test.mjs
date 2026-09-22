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
    ["const submitStudentFollowUp", "const reconcilePendingExamSubmission", /await studentsShared\.mutateAndCommit/],
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

test("package purchase success waits for its matching authoritative command receipt", async () => {
  const [form, service, route, genericRoute] = await Promise.all([
    readFile(new URL("../app/lesson-package-purchase-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/lesson-package-purchase-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/students/lesson-package/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app-state/route.ts", import.meta.url), "utf8"),
  ]);
  const requestIndex = form.indexOf('const response = await fetch("/api/students/lesson-package"');
  const receiptIndex = form.indexOf("if (!response.ok || body?.committed !== true || body.commandKey !== command.commandKey)");
  const savedIndex = form.indexOf("onSaved(body.studentRow)");
  const catchIndex = form.indexOf("} catch (reason)", savedIndex);
  assert.ok(requestIndex >= 0 && receiptIndex > requestIndex && savedIndex > receiptIndex && catchIndex > savedIndex);
  assert.match(form.slice(receiptIndex, savedIndex), /throw new Error\(body\?\.error/);
  assert.doesNotMatch(form.slice(catchIndex), /onSaved\(/);
  assert.match(form, /if \(inFlight\.current \|\| !ready\) return/);
  const pendingIndex = form.indexOf("window.localStorage.setItem(storageKey, serialized)");
  assert.ok(pendingIndex >= 0 && pendingIndex < requestIndex, "persist the exact retry intent before sending");
  assert.match(route, /return reply\(await commitLessonPackagePurchase\(/);
  assert.match(service, /const saved = await store\.write\(\{[^\n]*expectedVersion: current\.version[^\n]*scopeVersions: getAccessScopeVersions\(rows, access\)/);
  assert.match(service, /if \(!saved\[0\]\) throw new Error/);
  assert.match(service, /committed: true, applied: true, commandKey: command\.commandKey, studentRow: filterOpsStateRows\(saved, access\)\[0\]/);
  const dialog = sliceFrom('{modal === "lessonPackage"', '{modal === "exam"');
  assert.match(dialog, /onBusyChange=\{setLessonPackageBusy\}/);
  assert.match(dialog, /onClose=\{\(\) => \{ if \(!lessonPackageBusy\) setModal\(null\); \}\}/);
  assert.match(dialog, /onSaved=\{\(studentRow\) => \{ if \(studentRow\) studentsShared\.applyRemote\(studentRow as RemoteStateRow<Student\[\]>\); setModal\(null\); notify\("课包与购买记录已确认保存"\)/);
  assert.match(genericRoute, /hasAppendedLessonPackagePurchase/);
  assert.match(genericRoute, /purchase_command_required/);
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
