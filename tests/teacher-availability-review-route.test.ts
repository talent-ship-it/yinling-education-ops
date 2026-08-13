import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("AVA review route is admin-only, server-computed and one atomic write", async () => {
  const source = await readFile(
    new URL("../app/api/teacher-availability/review/route.ts", import.meta.url),
    "utf8",
  );
  const service = await readFile(
    new URL("../lib/teacher-availability-review-service.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /hasTeacherAvailabilityReviewAdminAccess/);
  assert.match(source, /parseTeacherAvailabilityReviewRequest/);
  assert.match(source, /prepareTeacherAvailabilityReview/);
  assert.match(source, /reviewTeacherAvailabilitySubmissionAtomic\(prepared\)/);
  assert.doesNotMatch(source, /putOpsState\(/);
  assert.match(source, /Cache-Control": "private, no-store"/);
  assert.match(service, /REVIEW_REQUEST_FIELDS/);
  assert.doesNotMatch(service, /"availabilityWindows"\s*,/);
  assert.match(service, /approveTeacherAvailabilitySubmission\(/);
});

test("database review contract checks status and teacher version in one transaction", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/20260813013935_operational_atomic_contracts.sql", import.meta.url),
    "utf8",
  );
  const body = sql.slice(
    sql.indexOf("create or replace function public.review_teacher_availability_submission_atomic"),
    sql.indexOf("revoke all on function public.review_teacher_availability_submission_atomic"),
  );

  assert.match(body, /for update/);
  assert.match(body, /submission\.status <> p_expected_submission_status/);
  assert.match(body, /teacher_state\.version <> p_expected_teacher_version/);
  assert.match(body, /availability_windows_do_not_match_submission/);
  assert.match(body, /expected_retained_windows/);
  assert.match(body, /update public\.teacher_availability_submissions/);
  assert.match(body, /update public\.ops_state/);
  assert.match(body, /append_operational_contract_audit/);
});
