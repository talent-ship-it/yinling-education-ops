import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("ending a classroom persists a recovery intent before the external write", async () => {
  const [route, provider, cron, client] = await Promise.all([
    read("../app/api/classroom/route.ts"), read("../lib/bigbluebutton.ts"),
    read("../app/api/cron/classroom-provision/route.ts"), read("../app/operations-client.tsx"),
  ]);
  const start = route.indexOf('if (body.action === "end")');
  const end = route.indexOf('return noStore({ error: "不支持的在线教室动作。"', start);
  assert.ok(start >= 0 && end > start, "missing classroom end branch");

  const branch = route.slice(start, end);
  for (const guard of [
    "if (unavailable)",
    "if (historical)",
    "classroom.meetingId !== meetingId",
  ]) assert.match(branch, new RegExp(guard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.ok(branch.indexOf("await beginClassroomEnd(") < branch.indexOf("await reconcileStoredClassroomEnd("));
  assert.doesNotMatch(branch, /if \(!runtime\.running\)/);
  const create = provider.slice(provider.indexOf("export async function createMeeting("), provider.indexOf("export async function createTemporaryTestMeeting("));
  assert.ok(create.indexOf("await claimClassroomCreation(") < create.indexOf('await call("create"'));
  assert.ok(create.indexOf("await releaseClassroomCreation(") > create.indexOf('await call("create"'));
  assert.match(create, /await endMeeting\(meetingId\)/);
  assert.match(cron, /await recoverPendingClassroomEnds\(\)/);
  const endClient = client.slice(client.indexOf("const endClassroom ="), client.indexOf("const openLessonSettlement ="));
  assert.doesNotMatch(endClient, /persistClassroom\(/);
  assert.match(endClient, /result\.ended === true/);
});
