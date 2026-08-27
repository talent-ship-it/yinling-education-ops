import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("ending a classroom checks lesson and provider lifecycle before the external write", async () => {
  const route = await read("../app/api/classroom/route.ts");
  const start = route.indexOf('if (body.action === "end")');
  const end = route.indexOf('return noStore({ error: "不支持的在线教室动作。"', start);
  assert.ok(start >= 0 && end > start, "missing classroom end branch");

  const branch = route.slice(start, end);
  for (const guard of [
    "if (unavailable)",
    "if (historical)",
    "classroom.meetingId !== meetingId",
    'classroom.status === "ended"',
    "await meetingStatus(meetingId)",
    "if (!runtime.running)",
  ]) assert.match(branch, new RegExp(guard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const providerWrite = branch.indexOf("await endMeeting(meetingId)");
  assert.ok(providerWrite > branch.indexOf("if (!runtime.running)"));
  assert.equal((branch.match(/endMeeting\(/g) ?? []).length, 1);
});
