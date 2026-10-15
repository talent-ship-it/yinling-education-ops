import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import {
  createTemporaryClassroomPending,
  normalizeTemporaryClassroomIntent,
  TEMPORARY_CLASSROOM_REQUEST_MAX_ENTRIES,
} from "../lib/temporary-classroom-request.ts";

const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");
const start = client.indexOf("  const submitTemporaryClassroom = async");
const end = client.indexOf("  const endClassroom", start);
assert.ok(start >= 0 && end > start);
const executable = ts.transpileModule(client.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(recordLesson = false) {
  const fields = {
    studentId: "STU-FIXTURE", teacherId: "TEA-FIXTURE", teacherSubjectId: "Year7 English",
    subjectId: "Year7 English", packageId: "PKG-FIXTURE", duration: "60",
  };
  const requests = [], notices = [], navigations = [], busy = [];
  const pending = { current: [] };
  let failRequest = false;
  let requestKeys = 0;
  const noOp = () => {};
  const deps = {
    temporaryClassroomRecordLesson: recordLesson,
    FormData: class { get(key) { return fields[key] ?? null; } },
    isTeacherView: false,
    scopedActiveStudentIds: new Set(["STU-FIXTURE"]),
    studentById: () => ({ lessonPackages: [{ id: "PKG-FIXTURE", subjectIds: ["Year7 English"] }] }),
    teacherById: () => ({ name: "Synthetic Teacher", subjects: [" Year7 English "] }),
    notify: (value) => notices.push(value),
    scheduleTimezone: "Australia/Melbourne",
    scheduleConflict: () => false,
    zonedParts: () => ({ year: "2099", month: "01", day: "10", hour: "10", minute: "00" }),
    temporaryClassroomPendingRef: pending,
    temporaryClassroomRequestKeyRef: { current: null },
    temporaryClassroomRequestIntentRef: { current: null },
    sessionOperator: "Synthetic Admin",
    normalizeTemporaryClassroomIntent,
    createTemporaryClassroomPending,
    TEMPORARY_CLASSROOM_REQUEST_MAX_ENTRIES,
    newTemporaryClassroomRequestKey: () => `11111111-1111-4111-8111-${String(++requestKeys).padStart(12, "0")}`,
    writeTemporaryClassroomPending: () => true,
    clearTemporaryClassroomPending: noOp,
    setClassroomBusy: (value) => busy.push(value),
    setTemporaryClassroomLink: noOp,
    setTemporaryTestClassroom: noOp,
    window: {
      open: () => ({
        opener: null,
        document: { title: "", documentElement: { lang: "" }, body: { innerHTML: "" } },
        location: { replace: (value) => navigations.push(value) },
        close: noOp,
      }),
      location: { assign: (value) => navigations.push(value) },
    },
    temporaryClassroomRequest: async (body) => {
      requests.push(body);
      if (failRequest) throw new Error("Synthetic network failure");
      return { meetingId: "synthetic-room", moderatorUrl: "https://example.invalid/moderator", viewerUrl: "https://example.invalid/participant" };
    },
  };
  const submit = new Function(...Object.keys(deps), `${executable}; return submitTemporaryClassroom;`)(...Object.values(deps));
  return { fields, requests, notices, navigations, busy, pending, fail: (value) => { failRequest = value; }, submit: () => submit({ preventDefault() {}, currentTarget: {} }) };
}

test("direct opening ignores retained business selections and only submits a retry identity", async () => {
  const run = fixture();
  run.fields.studentId = "STU-OUTSIDE-SCOPE";
  await run.submit();
  assert.deepEqual(run.requests, [{ requestKey: "11111111-1111-4111-8111-000000000001" }]);
  assert.deepEqual(run.navigations, ["https://example.invalid/moderator"]);
  assert.deepEqual(run.busy, [true, false]);
  assert.equal(run.pending.current.length, 0);
});

test("direct opening keeps the same request identity after an uncertain response", async () => {
  const run = fixture();
  run.fail(true);
  await run.submit();
  assert.equal(run.pending.current.length, 1);
  run.fail(false);
  await run.submit();
  assert.equal(run.requests.length, 2);
  assert.equal(run.requests[0].requestKey, run.requests[1].requestKey);
  assert.equal(run.pending.current.length, 0);
});

test("lesson registration still blocks an unmatched teacher subject or missing package before requesting a classroom", async () => {
  const wrongSubject = fixture(true);
  wrongSubject.fields.teacherSubjectId = "Local English";
  await wrongSubject.submit();
  assert.equal(wrongSubject.requests.length, 0);
  assert.match(wrongSubject.notices.at(-1), /可教的老师科目/);
  const missingPackage = fixture(true);
  missingPackage.fields.packageId = "";
  await missingPackage.submit();
  assert.equal(missingPackage.requests.length, 0);
  assert.match(missingPackage.notices.at(-1), /对应的课包/);
});
