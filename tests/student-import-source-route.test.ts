import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("source ingest route is admin-only, bounded and never fetches or infers a source", async () => {
  const route = await readFile(
    new URL("../app/api/student-import/source-rows/route.ts", import.meta.url),
    "utf8",
  );
  const store = await readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8");

  assert.match(route, /hasStudentImportAdminAccess/);
  assert.match(route, /parseStudentImportSourceIngestRequest/);
  assert.match(route, /MAX_REQUEST_BYTES/);
  assert.match(route, /putStudentImportSourceRows\(\{ \.\.\.input, actor: access\.actor \}\)/);
  assert.match(route, /error\.sourceErrorCode/);
  assert.match(route, /sourceCode: error\.sourceErrorCode/);
  assert.doesNotMatch(route, /fetch\(/);
  assert.match(store, /STUDENT_IMPORT_SOURCE_INGEST_RPC = "put_student_import_source_rows"/);
  assert.match(store, /p_source_kind: input\.sourceKind/);
  assert.match(store, /p_revision: input\.revision/);
  assert.match(store, /STUDENT_IMPORT_IDENTITY_LINKS_PUT_RPC = "put_student_import_identity_links"/);
  assert.match(store, /p_source_revisions: input\.sourceRevisions/);
  assert.match(store, /p_links: input\.links/);
});

test("formal import keeps internal reference evidence server-only while binding commit revisions", async () => {
  const route = await readFile(new URL("../app/api/student-import/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../lib/student-import-service.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8");

  assert.match(route, /getLatestStudentImportSourceRows\(\)/);
  assert.match(route, /return noStore\(prepared\.response\)/);
  assert.doesNotMatch(route, /fuAttachmentReferences|studentIds/);
  assert.match(service, /sources\.fuAttachmentReferences\.studentIds/);
  assert.match(service, /fuAttachments: sources\.fuAttachmentReferences\.fingerprint/);
  assert.match(service, /bookingsVersion/);
  assert.match(store, /bookingsVersion: number/);
  assert.match(store, /p_source_revisions: input\.sourceRevisions/);
  assert.match(route, /sourceRevisions: prepared\.sourceRevisions/);
  assert.match(route, /rows\.filter\(\(row\) => row\.entity !== "students"\)/);
  assert.match(route, /const stateEntities = \[[\s\S]*"students", "bookings"/);
  assert.doesNotMatch(route, /bookingsVersion/);
  assert.doesNotMatch(service, /projectionFingerprint/);
  assert.doesNotMatch(route, /projectionFingerprint/);
  assert.doesNotMatch(store, /p_projection_fingerprint/);
});

test("sync UI has separate master and JWB JSON controls before dry-run", async () => {
  const source = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");
  assert.match(source, /\(\["master", "jwb"\] as const\)\.map/);
  assert.match(source, /\/api\/student-import\/source-rows/);
  assert.match(source, /sourceId: meta\.sourceId\.trim\(\)/);
  assert.match(source, /revision: meta\.revision\.trim\(\)/);
  assert.match(source, /JSON 内容/);
  assert.match(source, /校验并保存粘贴内容/);
  assert.match(source, /选择 JSON 文件/);
  assert.match(source, /setStudentImportPreview\(null\)/);
  assert.match(source, /读取最新总表与教务宝/);
});
