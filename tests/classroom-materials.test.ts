import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ClassroomMaterialsError, externalMaterialUrl, materialGrantsInput, materialId, materialMaxBytes,
  materialTitle, materialUploadInput, materialUsesExternalViewer, verifyMaterialObject,
} from "../lib/classroom-materials.ts";

const requestKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("online links only accept credential-free public HTTPS locations", () => {
  assert.equal(externalMaterialUrl("https://docs.google.com/document/d/example/edit"), "https://docs.google.com/document/d/example/edit");
  for (const url of ["http://example.com/a", "https://user:pass@example.com/a", "https://127.1/a", "https://0x7f000001/a", "https://10.0.0.1/a", "https://192.168.1.2/a", "https://169.254.169.254/a", "https://[::1]/a", "https://[::ffff:127.0.0.1]/a", "https://localhost/a", "https://internal.lan/a", "https://example.com:8443/a", "javascript:alert(1)"]) {
    assert.throws(() => externalMaterialUrl(url), ClassroomMaterialsError, url);
  }
});

test("uploads canonicalize formats and constrain size before reservation", () => {
  const upload = { requestKey, title: "教材", fileName: "Lesson.PDF", mimeType: "", byteSize: 12 };
  assert.deepEqual(materialUploadInput(upload, 100), { ...upload, folderId: null, mimeType: "application/pdf" });
  assert.equal(materialUploadInput({ ...upload, fileName: "audio.wav", mimeType: "audio/x-wav" }, 100).mimeType, "audio/wav");
  for (const patch of [{ byteSize: 0 }, { byteSize: 101 }, { byteSize: 1.5 }, { fileName: "script.html" }, { fileName: "../file.pdf" }, { mimeType: "text/html" }, { requestKey: "other-material" }]) {
    assert.throws(() => materialUploadInput({ ...upload, ...patch }, 100), ClassroomMaterialsError);
  }
  assert.equal(materialMaxBytes("1024"), 1024);
  assert.throws(() => materialMaxBytes("Infinity"), ClassroomMaterialsError);
  assert.throws(() => materialTitle("../folder"), ClassroomMaterialsError);
  assert.equal(materialId("root", true), null);
});

test("download permission is an explicit subset of teacher use grants", () => {
  const base = { targetType: "material", targetId: requestKey, teacherIds: ["a", "a", "b"] };
  assert.deepEqual(materialGrantsInput(base), { ...base, teacherIds: ["a", "b"], downloadTeacherIds: [] });
  assert.throws(() => materialGrantsInput({ ...base, downloadTeacherIds: ["c"] }), ClassroomMaterialsError);
  assert.throws(() => materialGrantsInput({ ...base, teacherIds: [""] }), ClassroomMaterialsError);
});

test("completion verifies authoritative object location and actual metadata", () => {
  const material = { objectPath: `materials/${requestKey}/source.pdf`, mimeType: "application/pdf", byteSize: 12 };
  const object = { bucket_id: "classroom-materials", name: material.objectPath, size: 12, content_type: "application/pdf" };
  verifyMaterialObject(object, material);
  verifyMaterialObject({ bucket_id: object.bucket_id, name: object.name, metadata: { size: 12, mimetype: "application/pdf" } }, material);
  for (const patch of [{ size: 13 }, { size: "12" }, { name: "another/path" }, { bucket_id: "public" }, { content_type: "text/html" }]) {
    assert.throws(() => verifyMaterialObject({ ...object, ...patch }, material), ClassroomMaterialsError);
  }
  assert.equal(materialUsesExternalViewer("audio/mpeg"), true);
  assert.equal(materialUsesExternalViewer("video/mp4"), true);
  assert.equal(materialUsesExternalViewer("application/pdf"), false);
});
