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
const retirementMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260905000100_resume_blocked_jiaowubao_completed_lesson_members.sql"),
  "utf8",
);
const retirementManagement = fs.readFileSync(
  path.join(root, "scripts/jiaowubao-completed-lesson-retirement-management.ts"),
  "utf8",
);
const openApiDoc = fs.readFileSync(
  path.join(root, "docs/jiaowubao-open-api.md"),
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
const opsStore = fs.readFileSync(
  path.join(root, "lib/ops-store.ts"),
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
  assert.match(sync, /!force && !monthlyHourRefreshDue\([\s\S]*collection\.finalRevision && collection\.finalRevision === currentRevision/);
  assert.match(sync, /legacy pointer without this[\s\S]*rebuilt once/);
});

test("deterministic supplier rejection remains blocked even when an application caller uses force", () => {
  assert.match(migration, /state in \('collecting', 'ready', 'published', 'aborted', 'blocked'\)/);
  assert.match(migration, /state = 'blocked'[\s\S]*abort_reason = 'caller_failure'/);
  assert.match(migration, /p_reason = 'caller_failure'[\s\S]*jiaowubao_completed_lesson_member_collection\.blocked/);
  assert.match(migration, /set state = case when p_reason = 'caller_failure' then 'blocked' else 'aborted' end/);
  assert.match(sync, /error\.code === "upstream_rejected"/);
  assert.match(sync, /if \(collection\?\.state === "blocked"\) return blockedResult\(collection\)/);
  assert.doesNotMatch(sync, /resumeJiaowubaoCompletedLessonMemberCollection|retirement_management/);
  assert.doesNotMatch(opsStore, /resume_jiaowubao_completed_lesson_member_collection|retirement_management/);
  assert.doesNotMatch(`${browserRoute}\n${cronRoute}\n${operationsClient}`, /jiaowubao_completed_lesson_retirement_management/);
  assert.match(migration, /run_state\.abort_reason is not distinct from p_reason[\s\S]*member_abort_conflict/);
  assert.match(migration, /abort_reason text check \(abort_reason is null or abort_reason in/);
  assert.match(browserRoute, /syncJiaowubaoCompletedLessonMonth\(\{ month, force \}\)/);
  assert.match(browserRoute, /key !== "month" && key !== "force"/);
  assert.match(operationsClient, /JSON\.stringify\(\{ month, force: true \}\)/);
});

test("management retirement is postgres-only, opaque, and leaves no public recovery surface", () => {
  assert.match(retirementMigration, /security invoker/g);
  assert.match(retirementMigration, /session_user <> 'postgres' or current_user <> 'postgres'/);
  assert.match(retirementMigration, /revoke all on function internal\.jiaowubao_completed_lesson_retirement_management_(?:preview|commit)[\s\S]*from public, anon, authenticated, service_role/g);
  assert.match(retirementMigration, /enable row level security/g);
  assert.match(retirementMigration, /guard_jiaowubao_completed_lesson_member_immutable/);
  assert.doesNotMatch(retirementMigration, /grant execute|security definer|verify_ops_secret/);
  assert.doesNotMatch(`${sync}\n${opsStore}\n${browserRoute}\n${cronRoute}\n${operationsClient}`, /jiaowubao_completed_lesson_retirement_management/);
  assert.match(retirementManagement, /COMPANY_PROFILE = "insiderlead"/);
  assert.match(retirementManagement, /CREDENTIAL_HELPER = "\/Users\/nixon\/Documents\/Codex\/bin\/codex-project-credential"/);
  assert.match(retirementManagement, /SUPABASE_WORKDIR = "\/Users\/nixon\/Projects\/Insiderleadsedu\/supabase"/);
  assert.match(retirementManagement, /assertCompletedLessonRetirementCredentialEnvironment/);
  assert.match(retirementManagement, /key === "SUPABASE_ACCESS_TOKEN" \|\| key === "CODEX_COMPANY_PROFILE"/);
  assert.match(retirementManagement, /supabase@2\.115\.0[\s\S]*"db", "query"[\s\S]*"--workdir", SUPABASE_WORKDIR[\s\S]*"--linked"[\s\S]*"--project-ref", PROJECT_REF[\s\S]*"--agent", "yes"[\s\S]*"--output-format", "json"[\s\S]*"--file", sqlPath/);
  assert.doesNotMatch(retirementManagement, /--profile|INSIDER_LEADS_SUPABASE_PROFILE|options\.profile/);
  assert.match(retirementManagement, /delete childEnvironment\[key\]/);
  assert.match(retirementManagement, /confirmationKey[\s\S]*commandId/);
  assert.match(retirementMigration, /comment on table internal\.jiaowubao_completed_lesson_member_runs[\s\S]*manual force cannot recover[\s\S]*postgres-owner retirement[\s\S]*fresh full rebuild/);
  assert.match(openApiDoc, /CODEX_COMPANY_PROFILE=insiderlead[\s\S]*codex-project-credential exec supabase --[\s\S]*jiaowubao-completed-lesson-retirement-management\.ts/);
});

test("only a deterministic latest caller_failure blocks a successor, then schedule_changed permits cron rebuild", () => {
  const guardStart = retirementMigration.indexOf("guard_jiaowubao_completed_lesson_blocked_successor");
  const guardEnd = retirementMigration.indexOf("$blocked_successor$;", guardStart);
  const guard = retirementMigration.slice(guardStart, guardEnd);
  assert.match(guard, /where run_row\.period_month = new\.period_month[\s\S]*order by run_row\.started_at desc, run_row\.id desc[\s\S]*limit 1/);
  assert.match(guard, /latest_state = 'blocked' and latest_reason = 'caller_failure'/);
  assert.doesNotMatch(guard, /where[^;]+state = 'blocked'/s);
  assert.match(retirementMigration, /before insert on internal\.jiaowubao_completed_lesson_member_runs/);
  assert.match(migration, /latest\.state = 'aborted'[\s\S]*latest\.abort_reason in \('schedule_changed', 'catalog_changed'\)/);
  assert.match(migration, /if run_id is null then[\s\S]*'state', 'absent'/);
  assert.match(sync, /if \(!collection\)[\s\S]*beginJiaowubaoCompletedLessonMemberCollection/);
});

test("retirement preview binds the exact blocked generation, audits, counters, and full pointer tuple", () => {
  assert.match(retirementMigration, /jiaowubao_completed_lesson_retirement_evidence/);
  assert.match(retirementMigration, /saved\.state <> 'blocked' or saved\.abort_reason <> 'caller_failure'/);
  assert.match(retirementMigration, /begin_audit\.metadata <> jsonb_build_object\([\s\S]*'scheduleRevision'[\s\S]*'catalogRevisionSha256'/);
  assert.match(retirementMigration, /blocked_audit\.metadata <> jsonb_build_object\([\s\S]*'reason', 'caller_failure'[\s\S]*'rowCount'/);
  assert.match(retirementMigration, /target_count <> saved\.member_count[\s\S]*complete_target_count <> saved\.completed_member_count/);
  for (const field of [
    "apiSourceKey", "month", "runId", "revision", "rowCount", "scheduleRowCount",
    "rowsSha256", "payloadSha256", "publishedAtEpochMicros", "auditId",
  ]) assert.match(retirementMigration, new RegExp(`'${field}'`));
  assert.match(retirementMigration, /evidenceSha256[\s\S]*operation', 'retire-for-fresh-rebuild'/);
  assert.match(retirementMigration, /confirmation_key text primary key/);
  assert.doesNotMatch(retirementMigration, /memberIds|sourceKey|canonical_json/);
});

test("preview and commit share the safe lock order and reject a live worker with a fresh clock", () => {
  for (const marker of ["$retirement_preview$", "$retirement_commit$"]) {
    const start = retirementMigration.indexOf(`as ${marker}`);
    const end = retirementMigration.indexOf(marker + ";", start);
    const body = retirementMigration.slice(start, end);
    const member = body.indexOf("'jiaowubao-completed-lesson-members:'");
    const snapshot = body.indexOf("'jiaowubao-completed-lessons:'", member);
    const run = body.indexOf("jiaowubao_completed_lesson_member_runs", snapshot);
    const syncLease = body.indexOf("'jiaowubao-completed-lessons-sync:'", run);
    const leaseRow = body.indexOf("jiaowubao_completed_lesson_sync_leases", syncLease);
    const freshNow = body.indexOf("now_at := clock_timestamp()", leaseRow);
    const active = body.indexOf("lease.lease_expires_at > now_at", freshNow);
    const latest = body.indexOf("order by run_row.started_at desc, run_row.id desc", active);
    const pointer = body.indexOf("jiaowubao_completed_lesson_snapshot_current", latest);
    assert.ok(member >= 0 && snapshot > member && run > snapshot && syncLease > run
      && leaseRow > syncLease && freshNow > leaseRow && active > freshNow
      && latest > active && pointer > latest);
  }
  assert.match(retirementMigration, /delete from internal\.jiaowubao_completed_lesson_sync_leases[\s\S]*lease_expires_at <= now_at/);
});

test("commit is generation-bound, replay-safe, atomic, and preserves partial evidence", () => {
  assert.match(retirementMigration, /command_id uuid primary key/);
  assert.match(retirementMigration, /confirmation_key text not null unique/);
  assert.match(retirementMigration, /receipt\.confirmation_key is distinct from p_confirmation_key[\s\S]*receipt\.period_month is distinct from month_value[\s\S]*receipt\.committed_by is distinct from p_actor/);
  assert.match(retirementMigration, /return receipt\.result \|\| jsonb_build_object\('replayed', true\)/);
  assert.match(retirementMigration, /expected_key is distinct from p_confirmation_key[\s\S]*preview\.blocked_audit_id is distinct from saved\.abort_audit_id[\s\S]*preview\.blocked_at is distinct from saved\.aborted_at/);
  const audit = retirementMigration.indexOf("jiaowubao_completed_lesson_member_collection.retired_for_rebuild");
  const update = retirementMigration.indexOf("set state = 'aborted'", audit);
  const receipt = retirementMigration.indexOf("insert into internal.jiaowubao_completed_lesson_retirement_receipts", update);
  assert.ok(audit >= 0 && update > audit && receipt > update);
  assert.match(retirementMigration, /set state = 'aborted',[\s\S]*abort_reason = 'schedule_changed'/);
  assert.match(retirementMigration, /where run_row\.id = preview\.run_id[\s\S]*run_row\.state = 'blocked'[\s\S]*run_row\.abort_reason = 'caller_failure'[\s\S]*run_row\.abort_audit_id = preview\.blocked_audit_id[\s\S]*run_row\.aborted_at = preview\.blocked_at/);
  assert.doesNotMatch(
    retirementMigration,
    /(?:insert into|update|delete from)\s+internal\.jiaowubao_completed_lesson_member_(?:targets|pages|items)/i,
  );
  assert.doesNotMatch(retirementMigration, /insert into\s+internal\.jiaowubao_completed_lesson_member_runs/i);
  assert.doesNotMatch(retirementMigration, /set state = 'collecting'/);
});

test("scheduler bearer force is checked after lease acquisition but can never resume a blocked run", () => {
  const lease = sync.indexOf("await claimJiaowubaoCompletedLessonSyncLease");
  const collection = sync.indexOf("await getJiaowubaoCompletedLessonMemberCollection", lease);
  const blockedOnly = sync.indexOf("forceIfBlockedOnly && collection?.state !== \"blocked\"", collection);
  const blockedReturn = sync.indexOf("if (collection?.state === \"blocked\")", blockedOnly);
  assert.ok(lease >= 0 && collection > lease && blockedOnly > collection && blockedReturn > blockedOnly);
  assert.match(sync, /forceIfBlockedOnly && !force[\s\S]*blocked_force_invalid/);
  assert.match(cronRoute, /forceIfBlockedOnly: operation\.force/);
});

test("terminal paths reconfirm the current pointer and publication keeps schedule and catalog fences", () => {
  assert.match(sync, /async function confirmPublishedSnapshot/);
  assert.match(sync, /confirmJiaowubaoCompletedLessonSnapshotCurrent/);
  assert.match(sync, /confirmation\.revision !== input\.revision[\s\S]*confirmation\.rowCount !== input\.rowCount[\s\S]*confirmation\.scheduleRowCount !== input\.scheduleRowCount/);
  assert.ok((sync.match(/await confirmPublishedSnapshot\(/g) ?? []).length >= 5);
  assert.match(sync, /finalSchedule\.snapshot\.manifest\.revision !== collection\.scheduleRevision[\s\S]*finalSchedule\.memberSetSha256 !== collection\.scheduleMemberSetSha256[\s\S]*finalSchedule\.memberIds\.length !== collection\.scheduleMemberCount/);
  assert.match(migration, /catalog ->> 'revisionSha256' is distinct from run_state\.catalog_revision_sha256[\s\S]*catalog ->> 'memberCount'\)::integer is distinct from run_state\.catalog_member_count/);
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
  assert.match(cronRoute, /pending\.month === null[\s\S]*outcome: "no_change"[\s\S]*month = pending\.month/);
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
