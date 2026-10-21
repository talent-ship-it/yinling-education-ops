import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relative) => fs.readFileSync(path.resolve(import.meta.dirname, "..", relative), "utf8");
const route = read("app/api/cron/lp-parent-progress/route.ts");
const migration = read("supabase/migrations/20260819101700_lp_parent_progress_scheduler.sql");
const vercel = JSON.parse(read("vercel.json"));

test("LP scheduler is a secret-gated fixed-frequency server route", () => {
  assert.match(route, /import \{ hasReminderCronSecret \} from "@\/lib\/reminder-cron-auth"/);
  assert.match(route, /if \(!hasReminderCronSecret\(request\)\) return noStore\(\{ error: "Not found" \}, 404\)/);
  assert.match(route, /getOpsState\(\[\.\.\.ENTITIES\]\)/);
  assert.match(route, /reconcileAllLpParentProgressTasks/);
  assert.match(route, /eligibleLpParentProgressRecords\(lpItems\)/);
  assert.match(route, /lps: eligibleLpItems/);
  assert.match(route, /const ENTITIES = \["lpItems", "bookings", "tasks", "teachers"\]/);
  assert.match(route, /teachers: teachersRow\.version/);
  assert.match(route, /sourceDigest\(lpItemsRow\.payload, bookingsRow\.payload, teachersRow\.payload\)/);
  assert.match(route, /teachers: teachersRow\.payload/);
  assert.match(route, /recoverStaleLpParentProgressSchedulerRuns\(\)/);
  assert.match(route, /timeZone: "Australia\/Melbourne"/);
  assert.match(route, /putLpParentProgressSchedulerTasks\(/);
  assert.match(route, /MAX_OCC_RETRIES = 3/);
  assert.doesNotMatch(route, /request\.json\(\)/);
  assert.doesNotMatch(route, /publishedDate|requestAt|requestedAtExact/);
});

test("Vercel does not declare an automatic scheduler", () => {
  assert.deepEqual(vercel.crons, []);
});

test("scheduler migration has a private resumable audit ledger and OCC-safe RPCs", () => {
  assert.match(migration, /create table if not exists internal\.lp_parent_progress_scheduler_runs/i);
  assert.match(migration, /outcome in \('running', 'no_change', 'applied', 'failed'\)/i);
  assert.match(migration, /begin_lp_parent_progress_scheduler_run/i);
  assert.match(migration, /finish_lp_parent_progress_scheduler_run/i);
  assert.match(migration, /put_lp_parent_progress_scheduler_tasks/i);
  assert.match(migration, /recover_stale_lp_parent_progress_scheduler_runs/i);
  assert.match(migration, /where entity = 'bookings' for update[\s\S]*where entity = 'lpItems' for update[\s\S]*where entity = 'tasks' for update/i);
  assert.match(migration, /version_conflict/i);
  assert.match(migration, /verify_ops_secret/i);
  assert.match(migration, /append_operational_contract_audit/i);
  assert.match(migration, /revoke all on table internal\.lp_parent_progress_scheduler_runs from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function public\.begin_lp_parent_progress_scheduler_run[\s\S]*to anon, authenticated/i);

  const finish = migration.slice(
    migration.indexOf("create or replace function public.finish_lp_parent_progress_scheduler_run"),
    migration.indexOf("create or replace function public.put_lp_parent_progress_scheduler_tasks"),
  );
  assert.match(finish, /p_outcome not in \('no_change', 'failed'\)/);
  assert.doesNotMatch(finish, /p_outcome not in \([^)]*applied/);

  const commit = migration.slice(
    migration.indexOf("create or replace function public.put_lp_parent_progress_scheduler_tasks"),
    migration.indexOf("create or replace function public.recover_stale_lp_parent_progress_scheduler_runs"),
  );
  assert.match(commit, /update public\.ops_state[\s\S]*update internal\.lp_parent_progress_scheduler_runs(?:\s+\w+)? set[\s\S]*outcome = 'applied'/i);

  const recovery = migration.slice(migration.indexOf("create or replace function public.recover_stale_lp_parent_progress_scheduler_runs"));
  assert.match(recovery, /interval '30 minutes'/);
  assert.match(recovery, /recovered_outcome := 'no_change'/);
  assert.match(recovery, /recovered_outcome := 'failed'/);
  assert.doesNotMatch(recovery, /recovered_outcome := 'applied'/);
});
