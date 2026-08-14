import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("student identity route, store and UI allow only clearing legacy links", async () => {
  const [route, store, ui] = await Promise.all([
    readFile(new URL("../app/api/student-import/identity-links/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(route, /hasStudentImportAdminAccess/);
  assert.match(route, /MAX_REQUEST_BYTES/);
  assert.match(route, /Object\.keys\(value\)\.length !== 1/);
  assert.match(route, /value\.links\.length !== 0/);
  assert.match(route, /当前只允许清除旧身份链接/);
  assert.match(route, /getLatestStudentImportSourceRows\(\)/);
  assert.match(route, /master: sourceSnapshot\.master\.revision/);
  assert.match(route, /jwb: sourceSnapshot\.jwb\.revision/);
  assert.match(route, /putStudentImportIdentityLinks\(\{/);
  assert.match(route, /actor: access\.actor/);
  assert.doesNotMatch(route, /masterSourceRow|jwbSourceRow|studentId/);
  assert.doesNotMatch(route, /request[^\n]*(sourceRevision|sourceId|name|metadata)/i);
  assert.doesNotMatch(route, /export async function GET/);
  assert.match(store, /if \(input\.links\.length !== 0\)/);
  assert.match(store, /"22023"/);
  assert.match(ui, /JSON\.stringify\(\{ links: \[\] \}\)/);
  assert.match(ui, /清除旧身份链接/);
  assert.doesNotMatch(ui, /studentIdentityLinkFile|student-identity-links[^\n]*type="file"/i);
});

test("student identity route has explicit invalid, conflict and unavailable contracts", async () => {
  const route = await readFile(
    new URL("../app/api/student-import/identity-links/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /invalid_student_import_identity_links/);
  assert.match(route, /student_import_identity_links_conflict/);
  assert.match(route, /student_import_identity_links_contract_unavailable/);
  assert.match(route, /STUDENT_IMPORT_IDENTITY_LINKS_PUT_RPC/);
  assert.match(route, /}, 422\)/);
  assert.match(route, /}, 409\)/);
  assert.match(route, /}, 501\)/);
});
