import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

import * as validators from "../lib/classroom-materials.ts";

const require = createRequire(import.meta.url);
function route(path, dependencies) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: (id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id.startsWith("node:")) return require(id);
    throw new Error(`Unexpected dependency: ${id}`);
  } });
  return exports;
}

const material = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "file", mimeType: "application/pdf", fileName: "lesson.pdf" };
const session = { accountId: "synthetic-account", role: "teacher" };
const input = { bookingId: "B1", occurrenceId: "B1:2026-10-19" };
function presentation({ ending = false, value = material } = {}) {
  const events = [];
  const api = route("../app/api/classroom/materials/[id]/present/route.ts", {
    "@/lib/classroom-materials": validators,
    "@/lib/classroom-materials-server": {
      materialsSession: async () => session,
      materialsBody: async () => input,
      authorizedMaterialsMeeting: async () => { events.push("meeting-authorized"); return "synthetic-meeting"; },
      materialsResponse: (body, status = 200) => ({ body, status }),
      materialsErrorResponse: (error) => ({ status: error.status ?? 500, code: error.code }),
    },
    "@/lib/classroom-materials-store": {
      materialRpc: async () => { events.push("material-authorized"); return { material: value }; },
      materialReadUrl: async () => { events.push("signed-url"); return "https://storage.invalid/signed-only"; },
    },
    "@/lib/ops-store": { readClassroomEndRequests: async (occurrenceId) => {
      events.push("end-barrier");
      assert.equal(occurrenceId, input.occurrenceId);
      return ending ? [{ status: "pending" }] : [];
    } },
    "@/lib/bigbluebutton": { insertMeetingDocument: async () => { events.push("insert-document"); } },
  });
  return { api, events };
}

test("a classroom ending while a material URL is signed blocks presentation and external viewers", async () => {
  for (const value of [material, { ...material, mimeType: "audio/mpeg" }, { ...material, kind: "link", sourceUrl: "https://example.com/lesson" }]) {
    const { api, events } = presentation({ ending: true, value });
    const response = await api.POST({}, { params: Promise.resolve({ id: material.id }) });
    assert.equal(response.status, 409);
    assert.equal(response.code, "materials_classroom_unavailable");
    assert.equal(response.body, undefined);
    assert.equal(events.includes("insert-document"), false);
    assert.equal(events.at(-1), "end-barrier");
    if (value.kind === "file") assert.equal(events.at(-2), "signed-url");
  }
});

test("active classroom inserts only after the final end barrier", async () => {
  const { api, events } = presentation();
  const response = await api.POST({}, { params: Promise.resolve({ id: material.id }) });
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, "presentation");
  assert.deepEqual(events, ["meeting-authorized", "material-authorized", "signed-url", "end-barrier", "insert-document"]);
});

test("library exposes classroom use capability only for the teacher role", async () => {
  for (const role of ["teacher", "admin", "limited-admin"]) {
    const api = route("../app/api/classroom/materials/route.ts", {
      "@/lib/classroom-materials": validators,
      "@/lib/classroom-materials-server": {
        materialsSession: async () => ({ ...session, role }),
        materialsResponse: (body) => body,
        materialsErrorResponse: (error) => { throw error; },
      },
      "@/lib/classroom-materials-store": {
        materialRpc: async () => ({ folders: [], materials: [], canPresent: true }),
        materialsStorageConfigured: () => true,
      },
    });
    const response = await api.GET({ nextUrl: new URL("https://app.invalid/api/classroom/materials") });
    assert.equal(response.canPresent, role === "teacher");
  }
});
