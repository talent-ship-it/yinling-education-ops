import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260815020000_teacher_availability_self_submit.sql",
  import.meta.url,
);

test("teacher self-submit route derives identity and delegates one pending-only RPC", async () => {
  const [route, service, store, client] = await Promise.all([
    readFile(new URL("../app/api/teacher-availability/submit/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/teacher-availability-submission-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ops-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /session\.role !== "teacher"/);
  assert.ok(route.indexOf('session.role !== "teacher"') < route.indexOf('getOpsState(["teachers"])'));
  assert.match(route, /parseTeacherAvailabilitySubmitRequest/);
  assert.match(route, /prepareTeacherAvailabilitySubmission/);
  assert.match(route, /submitTeacherAvailabilityAtomic\(prepared\)/);
  assert.match(route, /unchanged: !saved\[0\]\.applied/);
  assert.doesNotMatch(route, /putOpsState/);
  assert.match(route, /Cache-Control": "private, no-store"/);
  assert.match(service, /REQUEST_FIELDS/);
  assert.match(service, /SLOT_FIELDS/);
  assert.doesNotMatch(service, /"teacherId"[\s\S]*REQUEST_FIELDS/);
  assert.doesNotMatch(service, /availabilitySourceText|capacitySourceText/);
  assert.match(service, /assertValidAvailabilitySlots\(slots\)/);
  assert.match(store, /TEACHER_AVAILABILITY_ATOMIC_SUBMIT_RPC = "submit_teacher_availability_atomic"/);
  assert.match(store, /p_expected_teacher_version: input\.expectedTeacherVersion/);
  assert.match(store, /p_teacher_id: input\.teacherId/);
  assert.match(client, /const teacherAvailabilitySubmissionKey = useRef<string \| null>\(null\)/);
  assert.match(client, /submissionKey: teacherAvailabilitySubmissionKey\.current \?\?= crypto\.randomUUID\(\)/);
  assert.match(client, /teacherAvailabilitySubmissionKey\.current = null;[\s\S]*setModal\(null\)/);
  assert.doesNotMatch(client, /submissionKey: `teacher-availability-submit:/);
  assert.match(client, /body\.unchanged/);
});

test("database self-submit is secret-only, identity-bound, idempotent and never edits teachers", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const start = sql.indexOf("create or replace function public.submit_teacher_availability_atomic");
  const end = sql.indexOf("revoke all on function public.submit_teacher_availability_atomic", start);
  assert.ok(start >= 0 && end > start);
  const body = sql.slice(start, end);
  assert.match(body, /internal\.verify_ops_secret\(p_secret\)/);
  assert.match(body, /where s\.entity = 'teachers'[\s\S]*for update/);
  assert.match(body, /lower\(trim\(teacher ->> 'name'\)\) = lower\(trim\(p_actor\)\)/);
  assert.match(body, /current_teacher ->> 'id' is distinct from p_teacher_id/);
  assert.match(body, /teacher_state\.version <> p_expected_teacher_version/);
  assert.match(body, /internal\.teacher_availability_submission_commands/);
  assert.match(body, /prior\.command_hash <> payload_hash/);
  assert.ok(body.indexOf("prior.submission_key is not null") < body.indexOf("teacher_state.version <> p_expected_teacher_version"));
  assert.match(body, /overlapping_teacher_availability_submission_slots/);
  assert.match(body, /p_slots is null/);
  assert.match(body, /jsonb_typeof\(slot -> 'day'\) is distinct from 'number'/);
  assert.match(body, /slot ->> 'start' >= slot ->> 'end'/);
  assert.match(body, /pg_catalog\.pg_timezone_names/);
  assert.match(body, /teacher_availability_pending_submission_exists/);
  assert.match(body, /insert into public\.teacher_availability_submissions/);
  assert.match(body, /'pending'/);
  assert.match(body, /append_operational_contract_audit/);
  assert.doesNotMatch(body, /update public\.ops_state|availabilityWindows|newStudentCapacity/);
  assert.match(sql, /alter table public\.teacher_availability_submissions enable row level security/);
  assert.match(sql, /revoke all on table public\.teacher_availability_submissions from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public\.submit_teacher_availability_atomic\([\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.submit_teacher_availability_atomic\([\s\S]*to anon, authenticated/);
});
