import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_STUDENT_ATTACHMENT_BYTES,
  hasStudentAttachmentMagicBytes,
  isStudentAttachmentContentType,
  sanitiseStudentAttachmentName,
  studentAttachmentKind,
} from "../lib/student-attachment-validation";

test("accepts only the private attachment MIME allow-list and keeps a 4 MB ceiling", () => {
  assert.equal(MAX_STUDENT_ATTACHMENT_BYTES, 4 * 1024 * 1024);
  assert.equal(isStudentAttachmentContentType("application/pdf"), true);
  assert.equal(isStudentAttachmentContentType("image/png"), true);
  assert.equal(isStudentAttachmentContentType("text/html"), false);
  assert.equal(studentAttachmentKind("application/pdf"), "report");
  assert.equal(studentAttachmentKind("image/jpeg"), "image");
});

test("requires PDF and image magic bytes instead of trusting multipart MIME", () => {
  assert.equal(hasStudentAttachmentMagicBytes("application/pdf", Buffer.from("%PDF-1.7\n")), true);
  assert.equal(hasStudentAttachmentMagicBytes("application/pdf", Buffer.from("<html>")), false);
  assert.equal(hasStudentAttachmentMagicBytes("image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff])), true);
  assert.equal(hasStudentAttachmentMagicBytes("image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(hasStudentAttachmentMagicBytes("image/webp", Buffer.from("RIFF0000WEBP")), true);
  assert.equal(hasStudentAttachmentMagicBytes("image/png", Buffer.from("not-png")), false);
});

test("sanitises names before using them in download headers", () => {
  assert.equal(sanitiseStudentAttachmentName("../Report\r\n.pdf", "fallback.pdf"), "..-Report.pdf");
  assert.equal(sanitiseStudentAttachmentName("\u0000", "fallback.pdf"), "fallback.pdf");
  assert.equal(sanitiseStudentAttachmentName("a".repeat(200), "fallback.pdf").length, 180);
});
