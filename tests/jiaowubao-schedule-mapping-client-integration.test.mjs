import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(
  new URL("../app/operations-client.tsx", import.meta.url),
  "utf8",
);

function mappingEffect() {
  const marker = "void readJiaowubaoScheduleMappingReview(null, controller.signal)";
  const markerIndex = client.indexOf(marker);
  const start = client.lastIndexOf("  useEffect(() => {", markerIndex);
  const end = client.indexOf("\n\n  useEffect(() => {", markerIndex);
  assert.ok(markerIndex >= 0 && start >= 0 && end > markerIndex, "mapping reader must stay in one Sync effect");
  return client.slice(start, end);
}

test("mapping review is a high-tier Sync-only GET with a fail-closed parser", () => {
  const effect = mappingEffect();
  assert.match(client, /parseJiaowubaoScheduleMappingReview/);
  assert.match(client, /async function readJiaowubaoScheduleMappingReview\(cursor: string \| null = null, signal\?: AbortSignal\)/);
  assert.match(client, /new URLSearchParams\(\{ cursor \}\)/);
  assert.match(client, /\/api\/jiaowubao-direct-import\/schedule-mappings\$\{query\}/);
  assert.match(client, /method: "GET"/);
  assert.doesNotMatch(client.slice(client.indexOf("async function readJiaowubaoScheduleMappingReview"), client.indexOf("export default function OperationsApp")), /(?:limit|pageSize)\s*:/);
  assert.match(effect, /if \(!canUseAdminScope \|\| !isAdminView \|\| active !== "sync"\) return;/);
  assert.match(effect, /setJiaowubaoScheduleMappingReview\(null\)/);
  assert.match(effect, /setJiaowubaoScheduleMappingError\(true\)/);
  assert.doesNotMatch(effect, /method: "(?:POST|PUT|PATCH|DELETE)"/);
});

test("cursor pagination refuses a changed authority or import before merging candidates", () => {
  const start = client.indexOf("const loadMoreJiaowubaoScheduleMappings = async () => {");
  const end = client.indexOf("\n\n  const saveJiaowubaoScheduleMapping", start);
  const handler = client.slice(start, end);
  assert.ok(start >= 0 && end > start, "load-more handler must be present");
  assert.match(handler, /if \(!canUseAdminScope \|\| !isAdminView \|\| active !== "sync"/);
  assert.match(handler, /next\.runToken !== current\.runToken/);
  assert.match(handler, /next\.teachersVersion !== current\.teachersVersion/);
  assert.match(handler, /setJiaowubaoScheduleMappingReview\(null\);\s*\n\s*setJiaowubaoScheduleMappingError\(true\);/);
  assert.match(handler, /next\.candidates\.some\(\(candidate\) => current\.candidates\.some\(\(loaded\) => loaded\.mappingKey === candidate\.mappingKey\)\)/);
  assert.match(handler, /candidates: \[\.\.\.current\.candidates, \.\.\.next\.candidates\]/);
});

test("mapping writes retain the same command UUID through an uncertain refresh and reload both reviewed feeds on success", () => {
  const start = client.indexOf("const saveJiaowubaoScheduleMapping = async (");
  const end = client.indexOf("\n\n  const saveJiaowubaoScheduleMappingPriority", start);
  const handler = client.slice(start, end);
  assert.ok(start >= 0 && end > start, "mapping save handler must be present");
  assert.match(client, /const jiaowubaoScheduleMappingCommandKeysRef = useRef\(new Map<string, string>\(\)\);/);
  assert.match(handler, /const intent = JSON\.stringify\(\[\s*mappingKey,\s*action,\s*targetTeacherId,\s*targetSubjectId,\s*review\.teachersVersion,?\s*\]\)/s);
  assert.match(handler, /jiaowubaoScheduleMappingCommandKeysRef\.current\.get\(intent\) \?\? crypto\.randomUUID\(\)/);
  assert.match(handler, /jiaowubaoScheduleMappingCommandKeysRef\.current\.set\(intent, commandKey\)/);
  assert.match(handler, /method: "POST"/);
  assert.match(handler, /commandKey,/);
  assert.match(handler, /expectedTeachersVersion: review\.teachersVersion/);
  assert.match(handler, /await Promise\.all\(\[\s*refreshJiaowubaoScheduleMappingReview\(\),\s*refreshJiaowubaoScheduleMappingPriorityReview\(\)\s*\]\);/s);
  const refreshIndex = handler.indexOf("await Promise.all([");
  const clearIndex = handler.indexOf("jiaowubaoScheduleMappingCommandKeysRef.current.delete(intent)");
  assert.ok(refreshIndex >= 0 && clearIndex > refreshIndex, "command UUID must be cleared only after both reviewed feeds refresh");
  assert.doesNotMatch(handler, /(?:setBookings|setTasks|addAudit|setOperations|setPayroll)/);
});

test("mapping panels are rendered only in the administrator Sync workspace", () => {
  const syncView = client.slice(client.indexOf("const renderSync"), client.indexOf("const renderReports"));
  assert.match(syncView, /\{isAdminView && canUseAdminScope \? <>[\s\S]*?<JiaowubaoScheduleMappingPriorityReviewPanel[\s\S]*?<JiaowubaoScheduleMappingReviewPanel/s);
  const teacherDashboard = client.slice(client.indexOf("const renderTeacherDashboard"), client.indexOf("const renderDashboard"));
  const dashboard = client.slice(client.indexOf("const renderDashboard"), client.indexOf("const renderStudents"));
  assert.doesNotMatch(teacherDashboard, /JiaowubaoScheduleMappingReviewPanel/);
  assert.doesNotMatch(dashboard, /JiaowubaoScheduleMapping(?:Priority)?ReviewPanel/);
});
