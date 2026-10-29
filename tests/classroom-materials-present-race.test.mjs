import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

import * as validators from "../lib/classroom-materials.ts";
import { materialsPreviewResult, resolveMaterialsViewer } from "../lib/classroom-materials-preview.ts";

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
      "@/lib/account-credentials": { accountIdentityKey: () => assert.fail("normal listing must not impersonate") },
      "@/lib/classroom-materials-preview": { materialsPreviewResult, resolveMaterialsViewer },
      "@/lib/ops-store": { getAccountByIdentity: async () => assert.fail("normal listing needs no preview account") },
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

const uploadMaterial = {
  id: material.id, kind: "file", status: "uploading", mimeType: "application/pdf", fileName: "lesson.pdf", byteSize: 12,
  bucketId: "classroom-materials", objectPath: `materials/${material.id}/source.pdf`,
};
const uploadedObject = { bucket_id: uploadMaterial.bucketId, name: uploadMaterial.objectPath, size: 12, content_type: "application/pdf" };
function uploadRecovery({ value = uploadMaterial, object = uploadedObject, failure } = {}) {
  const events = [];
  const api = route("../app/api/classroom/materials/upload/route.ts", {
    "@/lib/classroom-materials": validators,
    "@/lib/classroom-materials-server": {
      materialsSession: async () => ({ accountId: "synthetic-admin", role: "admin" }),
      materialsBody: async () => ({ fileName: value.fileName, mimeType: value.mimeType, byteSize: value.byteSize, requestKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      publicMaterial: (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !["bucketId", "objectPath"].includes(key))),
      materialsResponse: (body, status = 200) => ({ body, status }),
      materialsErrorResponse: (error) => ({ status: error.status ?? 500, code: error.code }),
    },
    "@/lib/classroom-materials-store": {
      materialsStorageConfigured: () => true,
      materialRpc: async (accountId, operation, payload) => {
        assert.equal(accountId, "synthetic-admin");
        events.push(operation);
        if (operation === "upload-start") return { material: value };
        assert.equal(operation, "upload-complete");
        assert.equal(payload.id, value.id);
        return { material: { ...value, status: "ready" } };
      },
      materialObjectInfo: async (target, options) => {
        events.push("object-info");
        assert.equal(target, value);
        assert.equal(options.allowMissing, true);
        if (failure) throw failure;
        return object;
      },
      materialUploadDescriptor: async () => { events.push("sign-upload"); return { token: "synthetic-upload-only" }; },
    },
  });
  return { api, events };
}

test("retry after a lost final upload response verifies the reserved object before returning ready", async () => {
  const { api, events } = uploadRecovery();
  const response = await api.POST({});
  assert.equal(response.status, 200);
  assert.equal(response.body.material.status, "ready");
  assert.equal(response.body.material.bucketId, undefined);
  assert.equal(response.body.material.objectPath, undefined);
  assert.equal(response.body.upload, null);
  assert.deepEqual(events, ["upload-start", "object-info", "upload-complete"]);
});

test("upload recovery signs an absent object but does not sign or promote mismatched objects", async () => {
  const missing = uploadRecovery({ object: null });
  const response = await missing.api.POST({});
  assert.equal(response.status, 201);
  assert.equal(response.body.upload.token, "synthetic-upload-only");
  assert.deepEqual(missing.events, ["upload-start", "object-info", "sign-upload"]);
  for (const patch of [{ bucket_id: "other" }, { name: "materials/other/source.pdf" }, { size: 11 }, { content_type: "image/png" }]) {
    const mismatch = uploadRecovery({ object: { ...uploadedObject, ...patch } });
    const rejected = await mismatch.api.POST({});
    assert.equal(rejected.status, 409);
    assert.equal(rejected.code, "materials_object_mismatch");
    assert.deepEqual(mismatch.events, ["upload-start", "object-info"]);
  }
});

test("upload recovery fails closed on storage failures and skips provider calls for an already ready reservation", async () => {
  const unavailable = uploadRecovery({ failure: new validators.ClassroomMaterialsError("synthetic storage failure", "materials_storage_unavailable", 503) });
  assert.equal((await unavailable.api.POST({})).status, 503);
  assert.deepEqual(unavailable.events, ["upload-start", "object-info"]);
  const ready = uploadRecovery({ value: { ...uploadMaterial, status: "ready" } });
  assert.equal((await ready.api.POST({})).body.upload, null);
  assert.deepEqual(ready.events, ["upload-start"]);
});
