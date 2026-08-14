import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("teacher import dry-run and commit are admin-only and server-computed", async () => {
  const route = await readFile(new URL("../app/api/teacher-import/route.ts", import.meta.url), "utf8");
  assert.match(route, /hasTeacherImportAdminAccess/);
  assert.match(route, /getLatestTeacherImportSources/);
  assert.match(route, /getOpsState\(\["teachers"\]\)/);
  assert.match(route, /parseTeacherImportCommitRequest/);
  assert.match(route, /assertTeacherImportCommit/);
  assert.match(route, /teachers: prepared\.plan\.teachers/);
  assert.match(route, /applied: saved\[0\]\.applied/);
  assert.doesNotMatch(route, /request[^\n]*teachers/i);
});

test("teacher source route is bounded, admin-only and never fetches Tencent", async () => {
  const route = await readFile(new URL("../app/api/teacher-import/source/route.ts", import.meta.url), "utf8");
  const store = await readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8");
  assert.match(route, /hasTeacherImportAdminAccess/);
  assert.match(route, /MAX_REQUEST_BYTES/);
  assert.match(route, /parseTeacherImportSourceIngestRequest/);
  assert.match(route, /putTeacherImportSource\(\{ \.\.\.input, actor: access\.actor \}\)/);
  assert.doesNotMatch(route, /fetch\(/);
  assert.match(store, /TEACHER_IMPORT_SOURCE_INGEST_RPC = "put_teacher_import_source"/);
  assert.match(store, /p_sheet_names: input\.sheetNames/);
  assert.match(store, /p_roster_rows: input\.rosterRows/);
  assert.match(store, /p_subject_rows: input\.subjectRows/);
});

test("teacher identity confirmation sends only an opaque server-provided key", async () => {
  const route = await readFile(new URL("../app/api/teacher-import/identity-links/route.ts", import.meta.url), "utf8");
  assert.match(route, /hasTeacherImportAdminAccess/);
  assert.match(route, /parseTeacherIdentityResolutionRequest/);
  assert.match(route, /resolveTeacherIdentityCandidate/);
  assert.match(route, /putTeacherImportIdentityLink\(\{/);
  assert.match(route, /putTeacherImportHardResolution\(\{/);
  assert.match(route, /decision: confirmation\.decision/);
  assert.doesNotMatch(route, /teacherId:/);
  assert.doesNotMatch(route, /sourceRefs:/);
  assert.match(route, /teacher_hard_resolution_contract_unavailable/);
  assert.doesNotMatch(route, /persistenceContract !== "teacher_identity_link_v1"/);
});
