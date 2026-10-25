import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [client, stateRoute, snapshotRoute, toDoList] = await Promise.all([
  readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/app-state/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/app-snapshot/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/to-do-list.tsx", import.meta.url), "utf8"),
]);

test("the 15-second poll refreshes both authority rows and their one-snapshot projection", () => {
  const poll = client.slice(
    client.indexOf("const poller = createSharedStatePoller"),
    client.indexOf("const onKeyDown", client.indexOf("const poller = createSharedStatePoller")),
  );
  assert.match(poll, /MANAGED_EXAM_AUTHORITY_ENTITIES\.forEach\(\(entity\) => requestedEntities\.add\(entity\)\)/);
  assert.match(poll, /includeManagedExamSnapshot/);
  assert.match(poll, /parseManagedExamAuthorityVersions\(versionRows\)/);
  assert.match(poll, /parseManagedExamAuthorityVersions\(responseRows\)/);
  assert.match(poll, /parseManagedExamProjectionSnapshot\([\s\S]*stateBody\.managedExamSnapshot[\s\S]*authorityVersions/);
  assert.match(poll, /managedExamSnapshotIsCurrent\(nextManagedExamSnapshot, advertisedManagedExamVersions\)/);
  assert.match(poll, /managedExamSnapshotCanReplace\(nextManagedExamSnapshot, latestClientVersions\)/);
  assert.ok(
    poll.indexOf("parseManagedExamProjectionSnapshot") < poll.indexOf("responseRows.forEach"),
    "projection and authority versions must validate before any response row is applied",
  );
  assert.match(poll, /clearManagedExamProjection\(\)/);
  assert.match(poll, /cache: "no-store"/);
});

test("the state reader derives versions, scoped rows, and projection from one ops_state read", () => {
  const get = stateRoute.slice(stateRoute.indexOf("export async function GET"), stateRoute.indexOf("export async function PUT"));
  assert.doesNotMatch(get, /getOpsVersions/);
  assert.match(get, /const rows = await getOpsState\(\)/);
  assert.match(get, /managedExamStudentProjectionSnapshot\(rows, access\)/);
  assert.match(get, /includeManagedExamSnapshot[\s\S]*entities\?\.includes\("students"\)[\s\S]*entities\.includes\("tasks"\)/);
  assert.match(stateRoute, /"Cache-Control": "private, no-store"/);
  assert.match(snapshotRoute, /managedExamStudentProjectionSnapshot\(rows, access\)/);
  assert.match(snapshotRoute, /return noStore\(\{ error: resolved\.error \}, resolved\.status\)/);
});

test("cross-owner exam identity remains non-navigable in every refreshed reminder surface", () => {
  assert.match(client, /return examStudents\.filter\(\(student\) =>/);
  assert.match(client, /managedExamStudentIds\.has\(student\.id\) \? <span className="managed-exam-reminder"/);
  assert.match(client, /canOpen=\{\(task\) => task\.ruleKey !== "jiaowubao\.unclosed" && !managedExamStudentIds\.has\(task\.studentId\) && !managedTrialPaymentStudentIds\.has\(task\.studentId\)\}/);
  assert.match(client, /studentName=\{\(studentId\) => taskStudentNames\.get\(studentId\)\}/);
  assert.match(client, /action=\{managedExamStudentIds\.has\(nearestExam\.id\) \? undefined/);
  assert.match(toDoList, /canOpen\?\.\(task\) === false[\s\S]*task-copy-static/);
});
