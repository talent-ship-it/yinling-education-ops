import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("BBB create binds one meeting per occurrence to the signed analytics callback", async () => {
  const [bbb, route, callback] = await Promise.all([
    read("../lib/bigbluebutton.ts"),
    read("../app/api/classroom/route.ts"),
    read("../app/api/classroom/analytics/route.ts"),
  ]);
  assert.match(bbb, /meetingIdForOccurrence/);
  assert.match(bbb, /"meta_analytics-callback-url"/);
  assert.match(bbb, /"meta_occurrence-id"/);
  assert.match(bbb, /bbbCallbackNonce/);
  assert.match(bbb, /bbbCallbackSignature/);
  assert.doesNotMatch(route, /meetingIdForBooking\(bookingId\)/);
  assert.match(route, /meetingIdForOccurrence\(occurrenceId\)/);
  assert.match(route, /recurrenceIntervalDays/);
  assert.match(route, /recurrenceEndDate/);
  assert.match(route, /sourceDate/);
  assert.match(route, /role: "MODERATOR", userId: teacherId/);
  assert.match(route, /authorizedBooking\(bookingId, occurrenceId, sourceDate\)/);
  assert.match(callback, /verifyBbbCallbackSignature/);
  assert.match(callback, /processBbbAnalyticsCallback/);
  assert.doesNotMatch(callback, /cookies\(/);
  assert.doesNotMatch(callback, /DEMO_COOKIE_NAME/);
});

test("only the assigned signed teacher can request a teacher attendance identity", async () => {
  const [route, client] = await Promise.all([
    read("../app/api/classroom/route.ts"),
    read("../app/operations-client.tsx"),
  ]);
  assert.match(route, /context\.sessionRole !== "teacher"/);
  assert.match(route, /!context\.teacherIds\.has\(teacherId\)/);
  assert.match(route, /只有本节课的授课老师可以使用老师身份进入教室/);
  assert.match(client, /const canJoinTeacherClassroom = initialRole === "teacher" && isTeacherView/);
  assert.match(client, /disabled=\{classroomBusy \|\| !canJoinTeacherClassroom\}/);
  assert.match(client, /等待授课老师进入/);
  assert.match(client, /const selectedClassroomOccurrence/);
  assert.match(client, /const selectedClassroomOccurrenceKey/);
  assert.match(client, /selectedBookingSourceDate/);
  assert.match(client, /bookingOccurrenceByStableKey/);
  assert.match(client, /sourceDate=\$\{encodeURIComponent\(selectedClassroomSourceDate\)\}/);
  assert.doesNotMatch(client, /visibleClassrooms\.find\(\(booking\) => booking\.id === selectedBookingId && booking\.date === selectedBookingDate\)/);
  assert.match(client, /const occurrenceKey = selectedClassroomOccurrenceKey/);
  assert.doesNotMatch(client.slice(client.indexOf("const selectedClassroomOccurrence"), client.indexOf("const renderTeacherDashboard")), /selectedBookingDate \?\? selectedBooking\.date/);
});

test("provider callback persists evidence then uses the same atomic settlement contract", async () => {
  const [service, store, sql] = await Promise.all([
    read("../lib/bbb-analytics-service.ts"),
    read("../lib/ops-store.ts"),
    read("../supabase/migrations/20260813013935_operational_atomic_contracts.sql"),
  ]);
  assert.match(service, /putLessonAttendanceEvidence/);
  assert.match(service, /prepareLessonOccurrenceSettlement/);
  assert.match(service, /completeLessonOccurrenceAtomic/);
  assert.match(service, /trustedProvider: "bbb"/);
  assert.match(service, /BBB_SETTLEMENT_MAX_ATTEMPTS = 3/);
  assert.match(service, /isRetryableSettlementConflict/);
  assert.match(service, /if \(attempt > 0\) current = await prepareCurrent\(\)/);
  assert.match(store, /p_callback_nonce_sha256/);
  assert.match(sql, /lesson\.attendance_abnormal/);
  assert.match(sql, /abnormal_settlement_mutates_financial_state/);
  assert.match(sql, /jsonb_set\(b, '\{occurrenceOverrides\}'/);
  assert.match(sql, /where s\.entity = 'bookings'/);
  assert.doesNotMatch(
    sql.slice(
      sql.indexOf("create or replace function public.complete_lesson_occurrence_atomic"),
      sql.indexOf("revoke all on function public.complete_lesson_occurrence_atomic"),
    ),
    /where entity = 'lessonOccurrences'/,
  );
});
