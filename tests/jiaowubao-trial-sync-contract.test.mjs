import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const route = fs.readFileSync(path.join(root, "app/api/operations/jiaowubao-trial-sync/route.ts"), "utf8");
const client = fs.readFileSync(path.join(root, "app/operations-client.tsx"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260828000500_jiaowubao_trial_sync_atomic.sql"), "utf8");

test("trial sync replays first and re-reads the complete immutable source window on the server", () => {
  const post = route.slice(route.indexOf("export async function POST"));
  const replay = post.indexOf("const replay = await getJiaowubaoTrialSyncCommandResult");
  const sourceRead = post.indexOf("readSourceWindow(command.snapshotRevision, command.window)");
  const projection = post.indexOf("prepareJiaowubaoTrialSyncProjection");
  const commit = post.indexOf("const saved = await syncJiaowubaoTrialMatchesAtomic");
  assert.ok(replay >= 0 && sourceRead > replay && projection > sourceRead && commit > projection);
  assert.match(route, /scope: "all"/);
  assert.match(route, /page\.revision !== snapshotRevision/);
  assert.match(route, /page\.hasMore/);
  assert.doesNotMatch(route, /mutateAndCommit/);
});

test("browser persists one narrow retry command and no longer performs split LP/task writes", () => {
  const start = client.indexOf("const syncTrialSchedulesFromJiaowubao");
  const end = client.indexOf("const refreshJiaowubaoScheduleMappingReview", start);
  const syncBlock = client.slice(start, end);
  assert.match(syncBlock, /\/api\/operations\/jiaowubao-trial-sync/);
  assert.match(syncBlock, /readJiaowubaoTrialSyncPendingCommands/);
  assert.match(syncBlock, /persistJiaowubaoTrialSyncPendingCommands/);
  assert.match(syncBlock, /snapshotRevision: currentJiaowubaoImportedSchedule\.revision/);
  assert.doesNotMatch(syncBlock, /\.mutateAndCommit/);
  assert.match(syncBlock, /trialPaymentMethod: match\.trialPaymentMethod/);
  assert.match(syncBlock, /teacherName: match\.link\.teacherName/);
});

test("database contract locks both state rows, CAS-checks the source pointer, and records idempotent audit evidence", () => {
  assert.match(migration, /create table if not exists internal\.jiaowubao_trial_sync_commands/);
  assert.match(migration, /create or replace function public\.get_jiaowubao_trial_sync_command_result/);
  assert.match(migration, /create or replace function public\.sync_jiaowubao_trial_matches_atomic/);
  const lpLock = migration.indexOf("where entity = 'lpItems' for update");
  const taskLock = migration.indexOf("where entity = 'tasks' for update");
  const ledgerRead = migration.indexOf("from internal.jiaowubao_trial_sync_commands ledger", lpLock);
  assert.ok(lpLock >= 0 && taskLock > lpLock && ledgerRead > taskLock);
  assert.match(migration, /current_pointer\.api_source_key = 'jwb-open-api-schedule'[\s\S]*for share/);
  assert.match(migration, /pointer\.revision is distinct from p_snapshot_revision/);
  assert.match(migration, /trialSchedule' ->> 'sourceRevision' <> p_snapshot_revision/);
  assert.match(migration, /before_lp - 'trialSchedule'/);
  assert.match(migration, /jiaowubao_trial_sync_task_projection_invalid/);
  assert.match(migration, /trial\.jiaowubao\.sync_atomic/);
  assert.match(migration, /insert into public\.ops_mutation_log/);
});
