import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(
  new URL("../app/operations-client.tsx", import.meta.url),
  "utf8",
);

function effectFor(marker) {
  const markerIndex = client.indexOf(marker);
  const start = client.lastIndexOf("  useEffect(() => {", markerIndex);
  const end = client.indexOf("\n\n  useEffect(() => {", markerIndex);
  assert.ok(markerIndex >= 0 && start >= 0 && end > markerIndex, `${marker} must stay inside one effect`);
  return client.slice(start, end);
}

function handlerFor(startMarker, endMarker) {
  const start = client.indexOf(startMarker);
  const end = client.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must stay self-contained`);
  return client.slice(start, end);
}

test("AVA completion is an administrator-dashboard-only, fail-closed reader and risk source", () => {
  const effect = effectFor('void fetch("/api/teacher-availability/completion", {');
  const dashboard = handlerFor("  const renderDashboard = () => {", "\n\n  const renderStudents = () => {");
  const teacherDashboard = client.slice(client.indexOf("const renderTeacherDashboard"), client.indexOf("const renderDashboard"));

  assert.match(effect, /if \(!canUseAdminScope \|\| !isAdminView \|\| active !== "dashboard"\) return;/);
  assert.match(effect, /method: "GET"/);
  assert.match(effect, /cache: "no-store"/);
  assert.match(effect, /parseTeacherAvailabilityCompletionInbox\(body\)/);
  assert.match(effect, /setTeacherAvailabilityCompletion\(null\);\s*\n\s*setTeacherAvailabilityCompletionError\(true\);/);
  assert.doesNotMatch(effect, /method: "(?:POST|PUT|PATCH|DELETE)"/);

  assert.match(dashboard, /<ToDoList tasks=\{visibleTasks\}/);
  assert.match(dashboard, /className="panel today-panel"/);
  assert.match(dashboard, /<h2>今日课程<\/h2>/);
  assert.match(dashboard, /className="panel risk-panel"/);
  assert.match(dashboard, /<h2>风险与缺口<\/h2>/);
  assert.doesNotMatch(dashboard, /TeacherAvailabilityCompletionPanel|JiaowubaoOperationsReadinessPanel|JiaowubaoScheduleMappingPriorityReviewPanel/);
  assert.match(dashboard, /const authoritativeAvaInbox = isAdminView && canUseAdminScope/);
  assert.match(dashboard, /const authoritativeAvaSummary = authoritativeAvaInbox\?\.summary \?\? null;/);
  assert.match(dashboard, /authoritativeAvaSummary\.missing \+ authoritativeAvaSummary\.invalid/);
  assert.doesNotMatch(dashboard, /availabilityWindows \?\? \[\]\)\.some\(/);
  assert.doesNotMatch(teacherDashboard, /TeacherAvailabilityCompletionPanel|teacher-availability\/completion/);
});

test("priority mapping uses one frozen 63-day window in Sync and refuses any partial cursor merge", () => {
  const effect = effectFor("void readJiaowubaoScheduleMappingPriorityReview(");
  const reader = handlerFor("async function readJiaowubaoScheduleMappingPriorityReview(", "\n\nexport default function OperationsApp");
  const pager = handlerFor("  const loadMoreJiaowubaoScheduleMappingPriority = async () => {", "\n\n  const loadMoreJiaowubaoScheduleMappings = async () => {");
  const dashboard = handlerFor("  const renderDashboard = () => {", "\n\n  const renderStudents = () => {");
  const teacherDashboard = client.slice(client.indexOf("const renderTeacherDashboard"), client.indexOf("const renderDashboard"));

  assert.match(client, /const jiaowubaoScheduleMappingPriorityWindow = useMemo/);
  assert.match(reader, /windowStart: window\.startsAt/);
  assert.match(reader, /windowEnd: window\.endsAt/);
  assert.match(reader, /\/api\/jiaowubao-direct-import\/schedule-mappings\/priority\?\$\{query\.toString\(\)\}/);
  assert.match(reader, /parseJiaowubaoScheduleMappingPriorityReview\(body\)/);
  assert.match(reader, /review\.window\.startsAt !== window\.startsAt \|\| review\.window\.endsAt !== window\.endsAt/);
  assert.match(effect, /if \(!canUseAdminScope \|\| !isAdminView \|\| active !== "sync"\) return;/);
  assert.match(effect, /jiaowubaoScheduleMappingPriorityWindow/);

  for (const guard of [
    /next\.runToken !== current\.runToken/,
    /next\.teachersVersion !== current\.teachersVersion/,
    /next\.window\.startsAt !== current\.window\.startsAt/,
    /next\.window\.endsAt !== current\.window\.endsAt/,
    /next\.candidates\.some\(\(candidate\) => current\.candidates\.some\(\(loaded\) => loaded\.mappingKey === candidate\.mappingKey\)\)/,
  ]) assert.match(pager, guard);
  assert.match(pager, /setJiaowubaoScheduleMappingPriorityReview\(null\);\s*\n\s*setJiaowubaoScheduleMappingPriorityError\(true\);/);
  assert.match(pager, /candidates: \[\.\.\.current\.candidates, \.\.\.next\.candidates\]/);
  assert.doesNotMatch(dashboard, /JiaowubaoScheduleMappingPriorityReviewPanel/);
  assert.doesNotMatch(teacherDashboard, /JiaowubaoScheduleMappingPriorityReviewPanel|schedule-mappings\/priority/);
});

test("a priority confirmation has its own idempotency intent, does not require history page one, and refreshes both queues", () => {
  const handler = handlerFor(
    "  const saveJiaowubaoScheduleMappingPriority = async (",
    "\n\n  const refreshTeacherAvailabilitySubmissions",
  );

  assert.match(client, /const jiaowubaoScheduleMappingPriorityCommandKeysRef = useRef\(new Map<string, string>\(\)\);/);
  assert.match(handler, /const review = jiaowubaoScheduleMappingPriorityReview;/);
  assert.match(handler, /!review\.candidates\.some\(\(candidate\) => candidate\.mappingKey === mappingKey\)/);
  assert.doesNotMatch(handler, /jiaowubaoScheduleMappingReview\.candidates/);
  assert.match(handler, /"priority",\s*review\.runToken,\s*review\.window\.startsAt,\s*review\.window\.endsAt,\s*mappingKey,/s);
  assert.match(handler, /jiaowubaoScheduleMappingPriorityCommandKeysRef\.current\.get\(intent\) \?\? crypto\.randomUUID\(\)/);
  assert.match(handler, /jiaowubaoScheduleMappingPriorityCommandKeysRef\.current\.set\(intent, commandKey\)/);
  assert.match(handler, /\/api\/jiaowubao-direct-import\/schedule-mappings/);
  assert.match(handler, /action: "confirm"/);
  assert.match(handler, /expectedTeachersVersion: review\.teachersVersion/);
  assert.match(handler, /await Promise\.all\(\[\s*refreshJiaowubaoScheduleMappingPriorityReview\(\),\s*refreshJiaowubaoScheduleMappingReview\(\)\s*,?\s*\]\);/s);
  const refreshIndex = handler.indexOf("await Promise.all([");
  const clearIndex = handler.indexOf("jiaowubaoScheduleMappingPriorityCommandKeysRef.current.delete(intent)");
  assert.ok(refreshIndex >= 0 && clearIndex > refreshIndex, "priority UUID must survive until both queues refresh");
  assert.match(handler, /setJiaowubaoScheduleMappingPriorityReview\(null\);[\s\S]*setJiaowubaoScheduleMappingReview\(null\);/);
  assert.doesNotMatch(handler, /(?:setBookings|setTasks|setOperations|setPayroll|targetTeacherId: candidate\.)/);
});
