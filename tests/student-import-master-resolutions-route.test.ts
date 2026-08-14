import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("master duplicate route validates an opaque current option, persists via RPC and returns 501 only when absent", async () => {
  const route = await readFile(
    new URL("../app/api/student-import/master-resolutions/route.ts", import.meta.url),
    "utf8",
  );
  const ui = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");

  assert.match(route, /hasStudentImportAdminAccess/);
  assert.match(route, /parseMasterDuplicateResolutionRequest/);
  assert.match(route, /getLatestStudentImportSourceRows/);
  assert.match(route, /buildMasterDuplicateResolutionCandidates/);
  assert.match(route, /resolveMasterDuplicateCandidate/);
  assert.match(route, /masterDuplicateDecisionForCandidate/);
  assert.match(route, /student_master_duplicate_resolution_contract_unavailable/);
  assert.match(route, /putStudentImportMasterDuplicateResolution/);
  assert.match(route, /requiredRpc: STUDENT_IMPORT_MASTER_DUPLICATE_RESOLUTION_PUT_RPC/);
  assert.match(route, /}, 501\)/);
  assert.doesNotMatch(route, /putOpsState|commitStudentImportPlanAtomic/);

  assert.match(ui, /\/api\/student-import\/master-resolutions/);
  assert.match(ui, /学生总表重复记录待确认/);
  assert.match(ui, /不接受手工填写/);
  assert.match(ui, /来源行/);
  assert.doesNotMatch(ui, /studentMasterResolution.*textarea/i);
});
