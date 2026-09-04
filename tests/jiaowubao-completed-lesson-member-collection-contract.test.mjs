import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260904000200_resume_jiaowubao_completed_lesson_members.sql"),
  "utf8",
);
const cronMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260904000300_schedule_jiaowubao_completed_lesson_resume.sql"),
  "utf8",
);
const sync = fs.readFileSync(
  path.join(root, "lib/jiaowubao-completed-lesson-resumable-sync.ts"),
  "utf8",
);
const cronRoute = fs.readFileSync(
  path.join(root, "app/api/cron/jiaowubao-completed-lessons/route.ts"),
  "utf8",
);
const browserRoute = fs.readFileSync(
  path.join(root, "app/api/jiaowubao-open-api/completed-lessons/route.ts"),
  "utf8",
);
const operationsClient = fs.readFileSync(
  path.join(root, "app/operations-client.tsx"),
  "utf8",
);
const lessonSnapshot = fs.readFileSync(
  path.join(root, "lib/jiaowubao-completed-lessons.ts"),
  "utf8",
);
const monthEvidence = fs.readFileSync(
  path.join(root, "lib/jiaowubao-completed-month-evidence.ts"),
  "utf8",
);
const scheduleCronRoute = fs.readFileSync(
  path.join(root, "app/api/cron/jiaowubao-schedule/route.ts"),
  "utf8",
);
const legacySync = fs.readFileSync(
  path.join(root, "lib/jiaowubao-completed-lesson-sync.ts"),
  "utf8",
);

test("member collection accepts canonical run UUIDs and rejects a missing group separator", () => {
  const literal = sync.match(/const UUID = (\/\^[^\n]+\/iu);/u);
  assert.ok(literal);
  const runIdPattern = vm.runInNewContext(literal[1]);
  assert.equal(runIdPattern.test("123e4567-e89b-42d3-a456-426614174000"), true);
  assert.equal(runIdPattern.test("123e4567-e89b-42d3-a456426614174000"), false);
});

test("member crawl is private, lease-bound, immutable, and cannot mutate application state", () => {
  assert.match(migration, /create table if not exists internal\.jiaowubao_completed_lesson_member_runs/);
  assert.match(migration, /create table if not exists internal\.jiaowubao_completed_lesson_member_targets/);
  assert.match(migration, /create table if not exists internal\.jiaowubao_completed_lesson_member_pages/);
  assert.match(migration, /create table if not exists internal\.jiaowubao_completed_lesson_member_items/);
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /revoke all on table internal\.jiaowubao_completed_lesson_member_items from public, anon, authenticated/);
  assert.match(migration, /guard_jiaowubao_completed_lesson_member_immutable/);
  assert.match(migration, /internal\.assert_jiaowubao_completed_lesson_worker_lease/);
  assert.match(migration, /internal\.verify_ops_secret\(p_secret\)/);
  assert.doesNotMatch(migration, /\b(?:insert into|update|delete from)\s+(?:internal\.)?(?:ops_state|students|teachers|bookings|payroll)\b/i);
});

test("frozen member roster is the exact union of JWB import IDs and completed schedule IDs", () => {
  assert.match(migration, /jiaowubao_completed_lesson_member_catalog\(\)/);
  assert.match(migration, /jwb_source\.source_id/);
  assert.match(migration, /jwb_source\.revision/);
  assert.match(migration, /jwb_source\.rows_sha256/);
  assert.match(migration, /master_row\.value ->> 'jwbMemId'/);
  assert.match(migration, /link_row\.value ->> 'jwbSourceRow'/);
  assert.match(migration, /from public\.ops_state state_row where state_row\.entity = 'students'/);
  assert.match(migration, /historicalJwbSnapshot,currentAggregate,jwbSourceRow/);
  assert.match(migration, /historicalJwbSnapshot,retained,jwbSourceRow/);
  assert.match(migration, /opsStudentJwbMemberIdsSha256/);
  assert.match(migration, /select unnest\(schedule_ids\)/);
  assert.match(migration, /array_agg\(member_id order by member_id\)/);
  assert.match(migration, /member_set_sha256/);
  assert.match(migration, /schedule_member_set_conflict/);
  assert.match(migration, /member_count between 1 and 6000/);
  assert.match(migration, /catalog_revision_sha256/);
  assert.match(migration, /catalog ->> 'revisionSha256' is distinct from run_state\.catalog_revision_sha256/);
});

test("each lesson page is total-pinned, CAS-staged, globally unique, and rate limited across workers", () => {
  assert.match(migration, /next_page is distinct from p_page/);
  assert.match(migration, /version is distinct from p_expected_target_version/);
  assert.match(migration, /expected_total is distinct from p_source_total/);
  assert.match(migration, /row_count_value is distinct from expected_rows/);
  assert.match(migration, /unique \(run_id, source_key\)/);
  assert.match(migration, /wrapper -> 'record' ->> 'memberId' is distinct from p_member_id::text/);
  assert.match(migration, /for update;[\s\S]*interval '3\.2 seconds'/);
  assert.match(migration, /for update;[\s\S]*now_at := clock_timestamp\(\);[\s\S]*greatest\(now_at, saved\.next_allowed_at\)/);
  assert.match(sync, /MEMBER_SOURCE_CALL_BUDGET = 50/);
  assert.match(sync, /WORKER_TIME_BUDGET_MS = 220_000/);
  assert.match(sync, /collectJiaowubaoCompletedLessonMemberPage\(period, memberId, page, collection\.expectedTotal\)/);
});

test("the published lesson revision binds the non-PII frozen roster proof", () => {
  assert.match(lessonSnapshot, /jiaowubao-completed-lesson-member-collection\/v1/);
  assert.match(lessonSnapshot, /collection: JiaowubaoCompletedLessonCollectionProof \| null/);
  assert.match(lessonSnapshot, /catalogRevisionSha256/);
  assert.match(lessonSnapshot, /scheduleMemberSetSha256/);
  assert.match(lessonSnapshot, /collection: manifest\.collection/);
  assert.match(sync, /format: JIAOWUBAO_COMPLETED_LESSON_COLLECTION_FORMAT/);
});

test("publication waits for every member and rechecks the closed-month schedule snapshot", () => {
  assert.match(migration, /completed_member_count \+ 1 = run_state\.member_count/);
  assert.match(migration, /set state = 'ready'/);
  assert.match(migration, /current_revision is distinct from p_revision/);
  assert.match(sync, /collection\.state !== "ready"/);
  assert.match(sync, /readReadyLessonRecords/);
  assert.match(sync, /finalSchedule\.snapshot\.manifest\.revision !== collection\.scheduleRevision/);
  assert.match(sync, /finalSchedule\.memberSetSha256 !== collection\.scheduleMemberSetSha256/);
  assert.match(sync, /currentRevision !== collection\.expectedCurrentRevision/);
  assert.match(sync, /publishSnapshot\(snapshot, collection\.expectedCurrentRevision\)/);
  assert.match(sync, /prepareJiaowubaoCompletedLessonMemberPublication/);
  assert.match(sync, /completeJiaowubaoCompletedLessonMemberPublication/);
  assert.match(sync, /collection\.state === "ready" && sourcePageCount > 0[\s\S]*return progressResult/);
});

test("a legacy pointer is rebuilt once and only a matching published member run can no-op", () => {
  assert.match(migration, /select run_row\.id, run_row\.state, run_row\.abort_reason into run_id, run_state, run_reason[\s\S]*order by run_row\.started_at desc limit 1/);
  assert.match(migration, /run_state = 'aborted' and run_reason = 'source_conflict'[\s\S]*published_run\.state = 'published'[\s\S]*published_run\.final_revision = current_pointer\.revision/);
  assert.match(migration, /if run_id is null then[\s\S]*'state', 'absent'/);
  assert.match(sync, /collection\.state === "published"/);
  assert.match(sync, /!force && collection\.finalRevision && collection\.finalRevision === currentRevision/);
  assert.match(sync, /legacy pointer without this[\s\S]*rebuilt once/);
});

test("deterministic supplier rejection blocks automatic retries but manual refresh can rebuild", () => {
  assert.match(migration, /state in \('collecting', 'ready', 'published', 'aborted', 'blocked'\)/);
  assert.match(migration, /state = 'blocked'[\s\S]*abort_reason = 'caller_failure'/);
  assert.match(migration, /p_reason = 'caller_failure'[\s\S]*jiaowubao_completed_lesson_member_collection\.blocked/);
  assert.match(migration, /set state = case when p_reason = 'caller_failure' then 'blocked' else 'aborted' end/);
  assert.match(sync, /error\.code === "upstream_rejected"/);
  assert.match(sync, /collection\?\.state === "blocked" && !force[\s\S]*collection\?\.state === "blocked"[\s\S]*collection = null/);
  assert.match(migration, /p_force boolean/);
  assert.match(migration, /latest_state = 'blocked' and not p_force[\s\S]*member_status\(latest_id\)/);
  assert.match(migration, /run_state\.abort_reason is not distinct from p_reason[\s\S]*member_abort_conflict/);
  assert.match(migration, /abort_reason text check \(abort_reason is null or abort_reason in/);
  assert.match(sync, /force,/);
  assert.match(browserRoute, /syncJiaowubaoCompletedLessonMonth\(\{ month, force \}\)/);
  assert.match(browserRoute, /key !== "month" && key !== "force"/);
  assert.match(operationsClient, /JSON\.stringify\(\{ month, force: true \}\)/);
});

test("scheduler bearer force is checked against the blocked run after acquiring the same-month lease", () => {
  const lease = sync.indexOf("await claimJiaowubaoCompletedLessonSyncLease");
  const collection = sync.indexOf("await getJiaowubaoCompletedLessonMemberCollection", lease);
  const blockedOnly = sync.indexOf("forceIfBlockedOnly && collection?.state !== \"blocked\"", collection);
  const reset = sync.indexOf("if (collection?.state === \"blocked\")", blockedOnly);
  assert.ok(lease >= 0 && collection > lease && blockedOnly > collection && reset > blockedOnly);
  assert.match(sync, /forceIfBlockedOnly && !force[\s\S]*blocked_force_invalid/);
  assert.match(cronRoute, /forceIfBlockedOnly: operation\.force/);
});

test("both server routes use the resumable sync and expose progress without source records", () => {
  for (const route of [cronRoute, browserRoute]) {
    assert.match(route, /jiaowubao-completed-lesson-resumable-sync/);
    assert.match(route, /sync\.outcome === "in_progress"/);
    assert.doesNotMatch(route, /memberIds|nextMemberId|JIAOWUBAO_OPEN_API_SK/);
  }
  assert.match(browserRoute, /completedMemberCount/);
  assert.match(browserRoute, /sourcePageCount/);
  assert.match(cronRoute, /getJiaowubaoCompletedLessonPendingMonth/);
  assert.match(cronRoute, /pending\.month \?\? month/);
  assert.match(migration, /latest\.state = 'aborted'[\s\S]*latest\.abort_reason in \('schedule_changed', 'catalog_changed'\)[\s\S]*not exists[\s\S]*jiaowubao_completed_lesson_snapshot_current[\s\S]*published_run\.state = 'published'[\s\S]*published_run\.final_revision = current_pointer\.revision/);
  assert.match(migration, /latest\.period_month < date_trunc\('month', timezone\('Australia\/Melbourne', clock_timestamp\(\)\)\)::date/);
  assert.match(migration, /month_value >= date_trunc\('month', timezone\('Australia\/Melbourne', clock_timestamp\(\)\)\)::date[\s\S]*snapshot_month_not_closed/);
  assert.doesNotMatch(`${cronRoute}\n${browserRoute}`, /jiaowubao-completed-lesson-sync"/);
  assert.match(monthEvidence, /manifest\.collection === null[\s\S]*缺少逐学员完整性证明/);
  assert.match(legacySync, /buildJiaowubaoCompletedMonthEvidenceEnvelope/);
});

test("scheduled retries are GitHub-deployed server calls with one Vault secret", () => {
  assert.match(cronMigration, /cron\.unschedule/);
  assert.match(cronMigration, /'7,12,17,22,37,42,47,52 \* \* \* \*'/);
  assert.match(cronMigration, /jiaowubao_completed_lesson_sync_token/);
  assert.match(cronMigration, /having count\(\*\) = 1/);
  assert.match(cronMigration, /https:\/\/app\.insiderleadsedu\.com\/api\/cron\/jiaowubao-completed-lessons/);
  assert.doesNotMatch(cronMigration, /JIAOWUBAO_OPEN_API_SK/);
});

test("both scheduled schedule readers share the database-backed supplier gate", () => {
  assert.match(migration, /tool in \('query_lesson_list', 'query_schedule_list'\)/);
  assert.match(migration, /reserve_jiaowubao_open_api_schedule_request/);
  assert.match(sync, /reserveJiaowubaoOpenApiScheduleRequest/);
  assert.match(scheduleCronRoute, /queryScheduleWithGlobalRateGate/);
  assert.match(scheduleCronRoute, /reserveJiaowubaoOpenApiScheduleRequest/);
});
