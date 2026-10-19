import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ClassroomMaterialsError, externalMaterialUrl, materialGrantsInput, materialId, materialListInput, materialMaxBytes,
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

test("online IPv4 links reject private range boundaries and preserve public addresses", () => {
  for (const host of ["0.0.0.0", "10.255.255.255", "127.255.255.255", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.1.1", "192.168.255.255", "100.64.0.1", "100.127.255.255", "198.18.0.1", "198.19.255.255", "224.0.0.1", "255.255.255.255"]) {
    assert.throws(() => externalMaterialUrl(`https://${host}/lesson`), ClassroomMaterialsError);
  }
  for (const host of ["8.8.8.8", "172.15.1.1", "172.32.1.1", "192.1.1.1", "100.63.1.1", "100.128.1.1", "198.17.1.1", "198.20.1.1", "223.255.255.255"]) {
    assert.equal(externalMaterialUrl(`https://${host}/lesson`), `https://${host}/lesson`);
  }
});

test("material list queries retain pagination bounds and validate search parameters", () => {
  assert.deepEqual(materialListInput(new URLSearchParams()), { folderId: null, q: "", offset: 0, limit: 100 });
  assert.deepEqual(materialListInput(new URLSearchParams({ folderId: requestKey, offset: "200", limit: "200", q: "  lesson  " })), { folderId: requestKey, q: "lesson", offset: 200, limit: 200 });
  for (const query of [{ offset: "-1" }, { offset: "1000001" }, { offset: "1.5" }, { limit: "0" }, { limit: "201" }, { limit: "NaN" }, { q: "a".repeat(161) }, { folderId: "bad" }]) {
    assert.throws(() => materialListInput(new URLSearchParams(query)), ClassroomMaterialsError);
  }
});
