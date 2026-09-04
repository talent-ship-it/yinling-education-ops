import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260903000100_jiaowubao_completed_lesson_snapshot.sql"),
  "utf8",
);
const cronMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260903000200_schedule_jiaowubao_completed_lesson_sync_daily.sql"),
  "utf8",
);
const dualSourceMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260903000300_upgrade_jiaowubao_completed_month_evidence.sql"),
  "utf8",
);
const recoveryMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260904000100_harden_jiaowubao_completed_snapshot_recovery.sql"),
  "utf8",
);
const route = fs.readFileSync(
  path.join(root, "app/api/jiaowubao-open-api/completed-lessons/route.ts"),
  "utf8",
);
const cronRoute = fs.readFileSync(
  path.join(root, "app/api/cron/jiaowubao-completed-lessons/route.ts"),
  "utf8",
);
const sync = fs.readFileSync(
  path.join(root, "lib/jiaowubao-completed-lesson-sync.ts"),
  "utf8",
);

test("completed-lesson evidence has a private, immutable, period-scoped database boundary", () => {
  assert.match(snapshotMigration, /create table if not exists internal\.jiaowubao_completed_lesson_snapshot_runs/);
  assert.match(snapshotMigration, /create table if not exists internal\.jiaowubao_completed_lesson_snapshot_current/);
  assert.match(snapshotMigration, /primary key \(api_source_key, period_month\)/);
  assert.match(snapshotMigration, /enable row level security/);
  assert.match(snapshotMigration, /revoke all on table internal\.jiaowubao_completed_lesson_snapshot_runs/);
  assert.match(snapshotMigration, /guard_jiaowubao_completed_lesson_snapshot_run/);
  assert.doesNotMatch(snapshotMigration, /\b(?:insert into|update|delete from)\s+(?:internal\.)?(?:ops_state|students|teachers|bookings|payroll)\b/i);
});

test("snapshot RPCs reject null guards, cannot release another sync run's lease, and safely retire failed staging", () => {
  assert.match(snapshotMigration, /p_actor is distinct from 'Ops Admin'/);
  assert.match(snapshotMigration, /coalesce\(p_month, ''\) !~ '\^\\d\{4\}-\\d\{2\}\$'/);
  assert.match(snapshotMigration, /coalesce\(p_run_key, ''\) !~ '\^jwb-completed-lessons-sync/);
  assert.match(snapshotMigration, /p_page_index is null or p_page_index not between 0 and 59/);
  assert.match(snapshotMigration, /p_page_index >= run_state\.expected_page_count/);
  assert.match(snapshotMigration, /saved\.run_key is distinct from p_run_key/);
  assert.match(snapshotMigration, /jsonb_typeof\(p_envelope -> 'apiSourceKey'\) is distinct from 'string'/);
  assert.match(snapshotMigration, /source_key text not null check \(source_key ~ '\^jwb-open-api:lesson:/);
  assert.match(snapshotMigration, /state in \('staging', 'complete', 'aborted'\)/);
  assert.match(snapshotMigration, /abort_jiaowubao_completed_lesson_snapshot_ingest/);
  assert.match(snapshotMigration, /jiaowubao_completed_lesson_snapshot_abort_run_id/);
  assert.match(snapshotMigration, /saved\.expected_current_revision is distinct from p_envelope ->> 'expectedCurrentRevision'/);
  assert.match(snapshotMigration, /\[A-Za-z0-9\._-\]\{0,159\}:\[A-Za-z0-9\]\[A-Za-z0-9\._-\]/);
  assert.match(sync, /abortJiaowubaoCompletedLessonSnapshot/);
  assert.match(sync, /if \(stagingRunId\)/);
  assert.match(snapshotMigration, /get_jiaowubao_completed_lesson_snapshot_page/);
  assert.match(snapshotMigration, /offset p_page_index \* 250/);
  assert.match(snapshotMigration, /p_page_index > 0 and p_expected_revision is null/);
  assert.match(snapshotMigration, /p_expected_revision is not null and current_row\.revision is distinct from p_expected_revision/);
});

test("dual-source upgrade keeps schedule role credits atomic, bounded, and deadlock-safe", () => {
  assert.match(dualSourceMigration, /expected_schedule_page_count/);
  assert.match(dualSourceMigration, /jiaowubao_completed_lesson_snapshot_schedule_pages/);
  assert.match(dualSourceMigration, /jiaowubao_completed_lesson_snapshot_schedule_events/);
  assert.match(dualSourceMigration, /query_schedule_list/);
  assert.match(dualSourceMigration, /schedule-cal-id-v1/);
  assert.match(dualSourceMigration, /schedule_row_count/);
  assert.match(
    dualSourceMigration,
    /delete from internal\.jiaowubao_completed_lesson_snapshot_current current_pointer[\s\S]*source_run\.source_metadata ->> 'exportFormat'[\s\S]*is distinct from 'jiaowubao-completed-month-evidence\/v1'/,
  );
  assert.match(dualSourceMigration, /assert_jiaowubao_completed_lesson_snapshot_schedule_page/);
  assert.match(dualSourceMigration, /revoke all on function internal\.assert_jiaowubao_completed_lesson_snapshot_schedule_page\(jsonb,date\)/);
  assert.match(dualSourceMigration, /period_month_value date/);
  assert.match(dualSourceMigration, /pg_advisory_xact_lock[\s\S]{0,500}for update/);
  assert.match(dualSourceMigration, /expected_page_count := \(p_envelope ->> 'expectedPageCount'\)::integer/);
  assert.doesNotMatch(dualSourceMigration, /\(p_envelope ->> 'expectedPageCount'\)::integer not between/);
  assert.match(dualSourceMigration, /\(wrapper -> 'record' ->> 'hours'\)::numeric not between 0 and 24/);
  assert.match(dualSourceMigration, /teacher ->> 'hours'\)::numeric not between 0 and 24/);
  assert.match(dualSourceMigration, /update internal\.jiaowubao_completed_lesson_snapshot_current set audit_id=confirmation_audit_id/);
  assert.doesNotMatch(dualSourceMigration, /set published_at=confirmed_at/);
});

test("snapshot recovery retires losing runs, is idempotent, and can republish an exact historical revision", () => {
  assert.match(recoveryMigration, /internal\.abort_jiaowubao_completed_lesson_snapshot_run/);
  assert.match(recoveryMigration, /if run_state\.state = 'aborted'[\s\S]*'replayed', true/);
  assert.match(recoveryMigration, /'current_pointer_conflict'/);
  assert.match(recoveryMigration, /return internal\.abort_jiaowubao_completed_lesson_snapshot_run\([\s\S]*'current_pointer_conflict'/);
  assert.doesNotMatch(
    recoveryMigration,
    /observed_current_revision is distinct from run_state\.expected_current_revision then\s+raise exception/,
  );
  assert.match(recoveryMigration, /'staging_envelope_conflict'/);
  assert.match(recoveryMigration, /'superseded_current_pointer'/);
  assert.match(recoveryMigration, /delete from internal\.jiaowubao_completed_lesson_snapshot_schedule_events/);
  assert.match(recoveryMigration, /delete from internal\.jiaowubao_completed_lesson_snapshot_schedule_pages/);
  assert.match(recoveryMigration, /delete from internal\.jiaowubao_completed_lesson_snapshot_items/);
  assert.match(recoveryMigration, /delete from internal\.jiaowubao_completed_lesson_snapshot_pages/);
  assert.match(recoveryMigration, /'stagedLessonPageCount'/);
  assert.match(recoveryMigration, /'observedCurrentRevision'/);
  assert.match(recoveryMigration, /'jiaowubao_completed_lesson_snapshot\.republished'/);
  assert.match(recoveryMigration, /'source_revision_reappeared'/);
  assert.match(recoveryMigration, /current_matches_saved := saved\.state = 'complete'/);
  assert.match(recoveryMigration, /current_row\.rows_sha256 is not distinct from saved\.canonical_rows_sha256/);
  assert.match(recoveryMigration, /if same_snapshot and current_matches_saved then/);
  assert.match(sync, /outcome: begin\.republished === true \? "applied" : "no_change"/);
  assert.match(sync, /completed\.runId === runId[\s\S]*completed\.abortReason === "current_pointer_conflict"/);
  assert.match(sync, /stagingRunId = null/);
});

test("only `over=1` completed evidence reaches the browser route and scheduled job", () => {
  assert.match(route, /requireFullAdmin/);
  assert.match(route, /projectJiaowubaoCompletedLessonRecords/);
  assert.match(route, /syncJiaowubaoCompletedLessonMonth/);
  assert.match(route, /getJiaowubaoCompletedLessonSnapshotPage/);
  assert.match(route, /projectionRevision/);
  assert.match(route, /expectedProjectionRevision/);
  assert.match(route, /projection\.state === "reset" \? 409 : 200/);
  assert.match(route, /console\.error\("jiaowubao_completed_lesson_sync_failed"/);
  assert.doesNotMatch(route, /JIAOWUBAO_OPEN_API_SK|process\.env\.JIAOWUBAO/);
  assert.match(cronMigration, /jiaowubao_completed_lesson_sync_token/);
  assert.match(cronMigration, /'17 18 \* \* \*'/);
  assert.match(cronMigration, /https:\/\/app\.insiderleadsedu\.com\/api\/cron\/jiaowubao-completed-lessons/);
  assert.match(cronMigration, /Bearer ' \|\|/);
  assert.match(cronMigration, /having count\(\*\) = 1/);
  assert.doesNotMatch(cronMigration, /jiaowubao_completed_lesson_sync_vault_token_missing/);
  assert.match(cronRoute, /error instanceof JiaowubaoOpenApiError/);
  assert.match(cronRoute, /error\.tool === "query_lesson_list"/);
  assert.match(cronRoute, /error\.tool === "query_schedule_list"/);
  assert.match(cronRoute, /\? "lessons"/);
  assert.match(cronRoute, /\? "schedules"/);
  assert.match(cronRoute, /kind: "source_validation"/);
  assert.match(cronRoute, /failure: safeSyncFailure\(error\)/);
  assert.doesNotMatch(cronRoute, /failure:\s*error\b|console\.error\([^\n]*,\s*error\b/);
});
