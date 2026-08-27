import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [route, service, panel] = await Promise.all([
  readFile(new URL("../app/api/teacher-availability/completion/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/teacher-availability-completion-service.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/teacher-availability-completion.tsx", import.meta.url), "utf8"),
]);

test("AVA completion is a current-month, admin-only, read-only server reader", () => {
  assert.match(route, /export async function GET\(\)/);
  assert.match(route, /hasTeacherAvailabilityReviewAdminAccess/);
  assert.match(route, /getOpsState\(\["teachers"\]\)/);
  assert.match(route, /getTeacherAvailabilityCompletionPendingTeacherIds/);
  assert.match(route, /MAX_COMPLETION_PENDING_TEACHERS/);
  assert.match(route, /currentMonthInMelbourne/);
  assert.match(route, /Cache-Control": "private, no-store"/);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(route, /putOpsState|submitTeacherAvailabilityAtomic|reviewTeacherAvailabilitySubmissionAtomic/);
  assert.doesNotMatch(route, /getTeacherAvailabilitySubmissions/);
  assert.doesNotMatch(route, /searchParams|request\.json/);
});

test("AVA completion uses only structured monthly windows and never infers from old or JWB data", () => {
  assert.match(service, /assertValidTeacherAvailability/);
  assert.match(service, /expandTeacherAvailability/);
  assert.match(service, /pending self-submission is shown only as a review state/i);
  assert.match(service, /parsePendingTeacherIds/);
  assert.doesNotMatch(service, /TeacherAvailabilitySubmissionRow|buildTeacherAvailabilityReviewInbox/);
  assert.doesNotMatch(service, /availabilitySourceText|availabilitySlots|schedule_event/i);
  assert.match(panel, /月度 AVA 完整度/);
  assert.match(panel, /查看老师资料|打开审核资料/);
  assert.doesNotMatch(panel, /不会从教务宝课表|旧 AVA 文本|不会自动发送提醒/);
  assert.match(panel, /onOpenTeacher/);
  assert.doesNotMatch(panel, /fetch\(|navigator\.clipboard|mailto:/);
});
