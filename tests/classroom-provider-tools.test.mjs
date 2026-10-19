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

function provider({ pluginEnabled = false, response = "<response><returncode>SUCCESS</returncode><meetingID>synthetic-room</meetingID></response>" } = {}) {
  const calls = [];
  const exports = {};
  vm.runInNewContext(source, {
    exports, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    process: { env: { BBB_API_URL: "https://provider.invalid", BBB_API_SECRET: "synthetic-secret", APP_ORIGIN: "https://app.invalid", BBB_CLASSROOM_TOOLS_ENABLED: String(pluginEnabled) } },
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      return new Response(response);
    },
    require: (id) => {
      const dependencies = { "server-only": {}, "@/lib/ops-store": { claimClassroomCreation: async () => true, releaseClassroomCreation: async () => true },
        "@/lib/bbb-analytics": analytics, "./classroom-duration": duration, "./classroom-provider-tools": tools,
        "node:crypto": require("node:crypto"), "fast-xml-parser": require("fast-xml-parser") };
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected import ${id}`);
      return dependencies[id];
    },
  });
  return { api: exports, calls };
}

const input = { meetingId: "synthetic-room", name: "Synthetic class", durationMinutes: 60, scheduledStartsAt: Date.now(), logoutUrl: "https://app.invalid", occurrenceId: "B1:2026-10-19", bookingId: "B1", studentId: "S1", teacherId: "T1" };

test("recorded rooms expose native teaching tools and point textbook selection to the exact occurrence", async () => {
  const { api, calls } = provider();
  await api.createMeeting(input);
  const query = calls[0].url.searchParams;
  assert.deepEqual(query.get("disabledFeaturesExclude").split(","), ["presentation", "snapshotOfCurrentSlide", "timer", "sharedNotes", "screenshare", "layouts", "learningDashboard"]);
  assert.equal(query.has("disabledFeatures"), false);
  assert.equal(query.get("lockSettingsDisableMic"), "true");
  assert.equal(query.get("lockSettingsDisableCam"), "true");
  assert.equal(query.get("lockSettingsLockOnJoin"), "false");
  assert.equal(query.has("pluginManifests"), false);
  assert.equal(query.get("record"), "true");
  const picker = new URL(query.get("presentationUploadExternalUrl"));
  assert.equal(picker.pathname, "/classroom/materials");
  assert.equal(picker.searchParams.get("occurrenceId"), input.occurrenceId);
  assert.equal(picker.searchParams.get("bookingId"), input.bookingId);
});

test("custom tools are opt-in and test rooms retain their no-recording boundary", async () => {
  const { api, calls } = provider({ pluginEnabled: true });
  await api.createTemporaryTestMeeting({ meetingId: "synthetic-test-room", logoutUrl: "https://app.invalid" });
  const query = calls[0].url.searchParams;
  assert.equal(query.get("record"), "false");
  assert.equal(query.has("meta_booking-id"), false);
  assert.equal(query.has("presentationUploadExternalUrl"), false);
  assert.deepEqual(JSON.parse(query.get("pluginManifests")), [{ url: "https://app.invalid/classroom-tools/manifest.json" }]);
});

test("textbooks use signed provider POST and escaped XML with student downloads disabled", async () => {
  const { api, calls } = provider();
  await api.insertMeetingDocument({ meetingId: "synthetic-room", name: 'Lesson "1" & <2>.pdf', url: "https://storage.invalid/signed?token=synthetic&expires=60" });
  assert.equal(calls[0].url.pathname.endsWith("/insertDocument"), true);
  assert.equal(calls[0].url.searchParams.get("meetingID"), "synthetic-room");
  assert.ok(calls[0].url.searchParams.get("checksum"));
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].init.body, /downloadable="false"/);
  assert.match(calls[0].init.body, /Lesson &quot;1&quot; &amp; &lt;2&gt;\.pdf/);
  assert.match(calls[0].init.body, /&amp;expires=60/);
});

test("invalid textbook URLs and provider rejection cannot produce a success receipt", async () => {
  const rejected = provider({ response: "<response><returncode>FAILED</returncode><messageKey>notFound</messageKey><message>Meeting unavailable</message></response>" });
  await assert.rejects(rejected.api.insertMeetingDocument({ meetingId: "synthetic-room", name: "Lesson.pdf", url: "https://storage.invalid/signed" }), (error) => error.code === "notFound");
  const { api, calls } = provider();
  for (const url of ["file:///etc/passwd", "https://user:secret@storage.invalid/file", "http://storage.invalid/file"]) {
    await assert.rejects(api.insertMeetingDocument({ meetingId: "synthetic-room", name: "Lesson.pdf", url }), (error) => error.code === "invalid_document_url");
  }
  assert.equal(calls.length, 0);
});
