import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as analytics from "../lib/bbb-analytics.ts";
import * as duration from "../lib/classroom-duration.ts";
import * as tools from "../lib/classroom-provider-tools.ts";

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL("../lib/bigbluebutton.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Execute the real provider adapter with only database/network I/O replaced.
function provider({ admitted = true, released = true, failCreate = false } = {}) {
  const calls = [];
  const exports = {};
  const store = {
    claimClassroomCreation: async (...args) => { calls.push({ action: "claim", args }); return admitted; },
    releaseClassroomCreation: async (...args) => { calls.push({ action: "release", args }); return released; },
  };
  vm.runInNewContext(source, {
    exports, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    process: { env: { BBB_API_URL: "https://bbb.invalid", BBB_API_SECRET: "synthetic-provider-secret", APP_ORIGIN: "https://app.invalid" } },
    fetch: async (url) => {
      const action = new URL(url).pathname.split("/").at(-1);
      calls.push({ action });
      if (action === "create" && failCreate) throw new Error("lost provider response");
      return new Response("<response><returncode>SUCCESS</returncode><meetingID>synthetic-meeting</meetingID></response>");
    },
    require: (id) => {
      if (id === "server-only") return {};
      if (id === "@/lib/ops-store") return store;
      if (id === "@/lib/bbb-analytics") return analytics;
      if (id.startsWith("./classroom-")) return { "./classroom-duration": duration, "./classroom-provider-tools": tools }[id];
      if (id.startsWith("node:") || id === "fast-xml-parser") return require(id);
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return { api: exports, calls };
}

const input = {
  meetingId: "synthetic-meeting", name: "Synthetic class", durationMinutes: 60,
  scheduledStartsAt: Date.now(), logoutUrl: "https://app.invalid", occurrenceId: "B1:2026-09-22",
  bookingId: "B1", studentId: "S1", teacherId: "T1",
};

test("an end barrier rejects provision before any provider call or join receipt", async () => {
  const { api, calls } = provider({ admitted: false });
  await assert.rejects(api.createMeeting(input), (error) => error.code === "classroom_closing" && error.status === 409);
  assert.deepEqual(calls.map(({ action }) => action), ["claim"]);
});

test("closure racing an in-flight provider create compensates and returns no meeting receipt", async () => {
  const { api, calls } = provider({ released: false });
  await assert.rejects(api.createMeeting(input), (error) => error.code === "classroom_closing");
  assert.deepEqual(calls.map(({ action }) => action), ["claim", "create", "release", "end"]);
});

test("an ambiguous create failure retains its lease for recovery instead of claiming the room is stopped", async () => {
  const { api, calls } = provider({ failCreate: true });
  await assert.rejects(api.createMeeting(input), (error) => error.code === "network_error");
  assert.deepEqual(calls.map(({ action }) => action), ["claim", "create"]);
});

test("normal creates release their lease and recorded temporary creates pass the server-owned claim", async () => {
  const { api, calls } = provider();
  const result = await api.createMeeting({ ...input, temporaryRequestIdentity: "verified-synthetic-claim" });
  assert.equal(result.meetingId, "synthetic-meeting");
  assert.deepEqual(calls.map(({ action }) => action), ["claim", "create", "release"]);
  assert.equal(calls[0].args[3], "verified-synthetic-claim");
  assert.equal(calls[0].args[2], calls[2].args[1]);
});
