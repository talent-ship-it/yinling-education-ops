import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");
function handler(name, next, deps) {
  const start = client.indexOf(`  const ${name} = async`);
  const end = client.indexOf(`  const ${next}`, start);
  assert.ok(start > 0 && end > start);
  const source = ts.transpileModule(client.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const entries = Object.entries(deps).filter(([key]) => key !== name);
  return new Function(...entries.map(([key]) => key), `${source}; return ${name};`)(...entries.map(([, value]) => value));
}
const booking = { id: "B-1", occurrenceKey: "B-1:2099-01-01", sourceDate: "2099-01-01" };
function fixture() {
  const notices = [], requests = [], syncs = [], navigations = [], views = [];
  let runtime = null, verified = {}, closed = false;
  let result = { meeting: { meetingId: "room-one" } };
  let persist = async () => { throw new Error("排课保存失败。"); };
  const noOp = () => {};
  const deps = {
    classroomRequest: async (request) => { requests.push(request); return result; },
    classroomFetch: async () => ({ response: { ok: true }, body: result }),
    persistClassroom: (...args) => { syncs.push(args); return persist(...args); },
    setProvisionedClassrooms: (update) => { verified = update(verified); },
    setClassroomRuntime: (update) => { runtime = typeof update === "function" ? update(runtime) : update; },
    provisionedClassrooms: verified,
    reportSharedSync: (...args) => views.push(args),
    notify: (value) => notices.push(value),
    selectBookingRecord: (value) => views.push(["selected", value.occurrenceKey]),
    setActive: (value) => views.push(["active", value]),
    setMobilePreview: noOp,
    addAudit: noOp,
    studentById: () => ({ name: "Synthetic Student" }),
    canJoinTeacherClassroom: true,
    isPastBooking: () => false,
    setClassroomBusy: noOp,
    refreshClassroom: noOp,
    displayPreferences: { language: "zh-CN" },
    window: {
      open: () => ({ opener: null, document: { title: "", documentElement: { lang: "" }, body: { innerHTML: "" } }, location: { replace: (value) => navigations.push(value) }, close: () => { closed = true; } }),
      location: { assign: (value) => navigations.push(value) },
      setTimeout: noOp,
    },
  };
  return {
    deps, notices, requests, syncs, navigations, views,
    get runtime() { return runtime; }, get verified() { return verified; }, get closed() { return closed; },
    result: (value) => { result = value; }, persist: (value) => { persist = value; },
  };
}

test("a created classroom remains visible when its schedule binding fails", async () => {
  const run = fixture();
  const provision = handler("provisionClassroom", "createClassroom", run.deps);
  assert.equal(await provision(booking, true), "room-one");
  await Promise.resolve();
  assert.equal(run.verified[booking.occurrenceKey], "room-one");
  assert.equal(run.runtime.meetingId, "room-one");
  assert.deepEqual(run.runtime.recordings, []);
  assert.ok(run.views.some(([key, value]) => key === "active" && value === "classroom"));
  assert.match(run.notices.at(-1), /课堂已创建.*暂未同步/);
  assert.equal(booking.classroom, undefined);
});

test("a stalled binding does not keep classroom creation busy", async () => {
  const run = fixture();
  run.persist(() => new Promise(() => {}));
  assert.equal(await handler("provisionClassroom", "createClassroom", run.deps)(booking, false), "room-one");
  assert.equal(run.runtime.meetingId, "room-one");
});

test("authorized teacher navigation survives a failed schedule binding", async () => {
  const run = fixture();
  run.result({ meetingId: "room-one", url: "https://example.invalid/authorized-join" });
  await handler("joinTeacherClassroom", "copyStudentClassroomLink", run.deps)(booking);
  await Promise.resolve();
  assert.deepEqual(run.navigations, ["https://example.invalid/authorized-join"]);
  assert.equal(run.closed, false);
  assert.equal(run.verified[booking.occurrenceKey], "room-one");
});

test("failed provider creation cannot create a verified room or binding", async () => {
  const run = fixture();
  run.result({});
  await assert.rejects(handler("provisionClassroom", "createClassroom", run.deps)(booking, false), /没有返回会议 ID/);
  assert.deepEqual(run.verified, {});
  assert.equal(run.syncs.length, 0);
});

for (const ended of ["closing", "ended"]) {
  test(`${ended} classrooms retain runtime without writing a ready binding`, async () => {
    const run = fixture();
    run.result({ status: { meetingId: "room-one", running: false }, recordings: [], [ended]: true });
    const result = await handler("refreshClassroom", "provisionClassroom", run.deps)({ ...booking, classroom: { meetingId: "room-one", status: "ready" } }, true);
    assert.equal(result[ended], true);
    assert.equal(run.runtime[ended], true);
    assert.equal(run.syncs.length, 0);
  });
}

test("an idle status response cannot mark an uncreated room as created", async () => {
  const run = fixture();
  run.result({ status: { meetingId: "room-one", running: false }, recordings: [] });
  await handler("refreshClassroom", "provisionClassroom", run.deps)(booking, true);
  assert.equal(run.syncs.length, 0);
  assert.deepEqual(run.verified, {});
});

test("a successful refresh keeps runtime when its binding fails", async () => {
  const run = fixture();
  run.result({ status: { meetingId: "room-one", running: true, participantCount: 2 }, recordings: [] });
  const result = await handler("refreshClassroom", "provisionClassroom", run.deps)({ ...booking, classroom: { meetingId: "room-one", status: "ready" } }, true);
  await Promise.resolve();
  assert.equal(result.running, true);
  assert.equal(run.runtime.participantCount, 2);
  assert.ok(run.views.some(([state]) => state === "error"));
});
