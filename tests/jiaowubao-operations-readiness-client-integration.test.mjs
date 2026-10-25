import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(
  new URL("../app/operations-client.tsx", import.meta.url),
  "utf8",
);

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end >= 0, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("admin dashboard keeps tasks and schedule retains lesson and risk panels", () => {
  const dashboard = section(
    client,
    "  const renderDashboard = () => {",
    "\n\n  const renderStudents = () => {",
  );

  assert.match(dashboard, /<ToDoList tasks=\{visibleTasks\}/);
  const overview = section(client, "  const renderScheduleOverview = () => {", "\n\n  const renderDashboard = () => {");
  assert.doesNotMatch(dashboard, /today-panel|risk-panel/);
  assert.match(overview, /className="panel today-panel"/);
  assert.match(overview, /<h2>今日课程<\/h2>/);
  assert.match(overview, /className="panel risk-panel"/);
  assert.match(overview, /<h2>风险与缺口<\/h2>/);
  assert.doesNotMatch(
    dashboard,
    /TeacherAvailabilityCompletionPanel|JiaowubaoOperationsReadinessPanel|JiaowubaoScheduleMappingPriorityReviewPanel/,
  );
});

test("legacy dashboard readiness panels are not rendered for teacher workspaces", () => {
  const teacherDashboard = section(
    client,
    "  const renderTeacherDashboard = () => {",
    "\n\n  const renderScheduleOverview = () => {",
  );

  assert.doesNotMatch(
    teacherDashboard,
    /TeacherAvailabilityCompletionPanel|JiaowubaoOperationsReadinessPanel|JiaowubaoScheduleMappingPriorityReviewPanel/,
  );
});
