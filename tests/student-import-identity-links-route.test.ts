import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("student identity route accepts only opaque reviewed decisions, row tokens and CAS clearing", async () => {
  const [route, store, ui] = await Promise.all([
    readFile(new URL("../app/api/student-import/identity-links/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(route, /hasStudentImportAdminAccess/);
  assert.match(route, /MAX_REQUEST_BYTES/);
  assert.match(route, /export async function GET/);
  assert.match(route, /prepareStudentIdentityReview/);
  assert.match(route, /parseStudentIdentityReviewRequest/);
  assert.match(route, /parseStudentIdentityManualReviewRequest/);
  assert.match(route, /parseStudentIdentityReviewClearRequest/);
  assert.match(route, /resolveStudentIdentityReviewCandidate\(confirmation, review\.decisionCandidates\)/);
  assert.match(route, /getLatestStudentImportSourceRows\(\)/);
  assert.match(route, /getOpsState\(\["students"\]\)/);
  assert.match(route, /getStudentImportIdentityReviewContract\(\)/);
  assert.match(route, /contract\.contractVersion !== 2/);
  assert.match(route, /getStudentImportIdentityReviewTokenSecret\(\)/);
  assert.match(route, /clearKey: review\.clearKey/);
  assert.match(route, /manualReview: review\.manualReview/);
  assert.match(route, /clearStudentImportIdentityLinks\(\{/);
  assert.match(route, /putStudentImportIdentityReviewDecision\(\{/);
  assert.match(route, /putStudentImportIdentityReviewPair\(\{/);
  assert.match(route, /actor: access\.actor/);
  assert.doesNotMatch(route, /p_(?:master|jwb|student)|request[^\n]*(sourceRevision|sourceId|sourceRow|studentId|name|metadata)/i);
  assert.match(route, /target student ID/i);
  assert.doesNotMatch(store, /export function putStudentImportIdentityLinks/);
  assert.doesNotMatch(store, /STUDENT_IMPORT_IDENTITY_LINKS_PUT_RPC/);
  assert.match(store, /STUDENT_IMPORT_IDENTITY_CLEAR_RPC/);
  assert.match(store, /p_resolution_key: input\.resolutionKey/);
  assert.match(store, /STUDENT_IMPORT_IDENTITY_REVIEW_PUT_RPC/);
  assert.match(store, /p_resolution_key: input\.resolutionKey/);
  assert.match(store, /p_decision: input\.decision/);
  assert.doesNotMatch(store, /putStudentImportIdentityReviewDecision[\s\S]{0,800}p_(?:master|jwb|student)/i);
  assert.match(store, /STUDENT_IMPORT_IDENTITY_REVIEW_PAIR_RPC/);
  assert.match(store, /p_master_token: input\.masterToken/);
  assert.match(store, /p_jwb_token: input\.jwbToken/);
  assert.match(store, /p_existing_token: input\.existingToken \?\? null/);
  assert.match(store, /p_token_secret: getStudentImportIdentityReviewTokenSecret\(\)/);
  assert.match(store, /process\.env\.STUDENT_IMPORT_IDENTITY_REVIEW_TOKEN_SECRET/);
  assert.match(store, /\^\[a-f0-9\]\{64\}\$/);
  assert.doesNotMatch(store, /putStudentImportIdentityReviewPair[\s\S]{0,1000}(?:sourceRow|studentId)/i);
  assert.match(ui, /JSON\.stringify\(\{ resolutionKey: clearKey, decision: "clear" \}\)/);
  assert.match(ui, /JSON\.stringify\(\{ resolutionKey, decision \}\)/);
  assert.match(ui, /masterToken: studentIdentityManualMasterToken/);
  assert.match(ui, /jwbToken: studentIdentityManualJwbToken/);
  assert.match(ui, /existingToken: studentIdentityManualExistingToken/);
  assert.match(ui, /学生身份逐条人工确认/);
  assert.match(ui, /剩余学生手工配对/);
  assert.match(ui, /清空全部身份链接/);
  assert.match(ui, /学生总表来源行/);
  assert.match(ui, /教务宝来源行/);
  const candidateTypeStart = ui.indexOf("type StudentIdentityReviewCandidate =");
  const candidateType = ui.slice(candidateTypeStart, ui.indexOf("\n};", candidateTypeStart) + 3);
  assert.doesNotMatch(candidateType, /\b(?:normalized|reviewKey|studentId)\s*:/i);
  const manualTypeStart = ui.indexOf("type StudentIdentityManualReview =");
  const manualType = ui.slice(manualTypeStart, ui.indexOf("\n};", manualTypeStart) + 3);
  assert.doesNotMatch(manualType, /\bstudentId\s*:/i);
  assert.doesNotMatch(ui, /studentIdentityLinkFile|student-identity-links[^\n]*type="file"/i);
});

test("student identity route has explicit invalid, conflict and unavailable contracts", async () => {
  const route = await readFile(
    new URL("../app/api/student-import/identity-links/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /invalid_student_import_identity_review/);
  assert.match(route, /student_import_identity_review_conflict/);
  assert.match(route, /student_import_identity_review_contract_unavailable/);
  assert.match(route, /STUDENT_IMPORT_IDENTITY_CLEAR_RPC/);
  assert.match(route, /STUDENT_IMPORT_IDENTITY_REVIEW_PAIR_RPC/);
  assert.match(route, /STUDENT_IMPORT_IDENTITY_REVIEW_PUT_RPC/);
  assert.match(route, /}, 422\)/);
  assert.match(route, /}, 409\)/);
  assert.match(route, /}, 501\)/);
});
