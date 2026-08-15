import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../supabase/migrations/20260815024000_backfill_task_teaching_control_watcher.sql",
    import.meta.url,
  ),
  "utf8",
);

test("task watcher backfill locks and validates only the tasks projection", () => {
  assert.match(
    migration,
    /from public\.ops_state state_row[\s\S]*where state_row\.entity = 'tasks'[\s\S]*for update/i,
  );
  assert.equal(
    [...migration.matchAll(/for update/gi)].length,
    1,
    "the migration must lock exactly one ops_state projection",
  );
  assert.match(migration, /jsonb_typeof\(current_state\.payload\) is distinct from 'array'/i);
  assert.match(migration, /jsonb_typeof\(task\.value\) is distinct from 'object'/i);
  assert.match(migration, /jsonb_typeof\(task\.value -> 'id'\) is distinct from 'string'/i);
  assert.match(migration, /count\(distinct task\.value ->> 'id'\)/i);
  assert.match(migration, /message = 'duplicate_task_id'/i);
  assert.doesNotMatch(migration, /where state_row\.entity\s+(?:=|in)\s*'?(?:students|teachers|bookings|operations)'?/i);
});

test("task watcher backfill preserves task order and changes only watchers", () => {
  assert.match(migration, /jsonb_array_elements\(current_state\.payload\) with ordinality/i);
  assert.match(migration, /order by task\.ordinal/i);
  assert.match(migration, /jsonb_set\(task_item, '\{watchers\}', normalized_watchers, true\)/i);
  assert.match(migration, /jsonb_typeof\(watcher_element\.value\) = 'string'/i);
  assert.match(migration, /select btrim\(watcher_element\.value #>> '\{\}'\) as watcher/i);
  assert.match(migration, /nullif\(extracted\.watcher, ''\) is not null/i);
  assert.match(migration, /octet_length\(extracted\.watcher\) <= 120/i);
  assert.match(migration, /group by lower\(extracted\.watcher\)/i);
  assert.match(migration, /lower\(extracted\.watcher\) <> lower\(teaching_control_watcher\)/i);
  assert.match(migration, /min\(watcher_element\.ordinal\) as first_ordinal/i);
  assert.match(migration, /jsonb_build_array\(teaching_control_watcher\)/i);
  assert.match(migration, /teaching_control_watcher constant text := 'Ops Admin'/i);
  assert.doesNotMatch(migration, /jsonb_set\(task_item, '\{(?:owner|assignees|status|id)\}'/i);
});

test("task watcher backfill is idempotent and records both required audits", () => {
  const noOpGuard = migration.indexOf("if next_payload is not distinct from current_state.payload then");
  const stateUpdate = migration.indexOf("update public.ops_state state_row", noOpGuard);
  const mutationLog = migration.indexOf("insert into public.ops_mutation_log", stateUpdate);
  const operationalAudit = migration.indexOf("internal.append_operational_contract_audit", mutationLog);

  assert.ok(noOpGuard >= 0);
  assert.ok(stateUpdate > noOpGuard);
  assert.ok(mutationLog > stateUpdate);
  assert.ok(operationalAudit > mutationLog);
  assert.match(migration, /version = state_row\.version \+ 1/i);
  assert.match(migration, /values \('tasks', current_state\.version, current_state\.updated_by\)/i);
  assert.match(migration, /'tasks\.teaching_control_watcher_backfilled'/i);
  assert.match(migration, /'changedTaskIds', changed_task_ids/i);
  assert.match(migration, /'beforeVersion', prior_version/i);
  assert.match(migration, /'afterVersion', current_state\.version/i);
});

test("new automatic task paths retain the canonical teaching-control watcher", async () => {
  const [tasks, renewalTasks, client] = await Promise.all([
    readFile(new URL("../lib/ops-tasks.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/renewal-tasks.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(tasks, /DEFAULT_TEACHING_CONTROL_WATCHER = DEMO_LIMITED_ADMIN_USER/);
  assert.match(tasks, /watchers: \[DEFAULT_TEACHING_CONTROL_WATCHER\]/);
  assert.match(renewalTasks, /watchers: \[DEFAULT_TEACHING_CONTROL_WATCHER\]/);
  assert.match(client, /watchers: \[DEFAULT_TEACHING_CONTROL_WATCHER\]/);
});

test("generic task writes cannot remove or duplicate the canonical watcher", async () => {
  const transition = await readFile(new URL("../lib/ops-state-transition.ts", import.meta.url), "utf8");
  const guard = transition.slice(
    transition.indexOf("function assertTaskWatchers"),
    transition.indexOf("function assertTeachersTransition"),
  );
  assert.match(guard, /Array\.isArray\(task\.watchers\)/);
  assert.match(guard, /new Set\(normalized\)\.size !== normalized\.length/);
  assert.match(guard, /watchers\.includes\(DEFAULT_TEACHING_CONTROL_WATCHER\)/);
  assert.match(transition, /case "tasks":[\s\S]*assertTasksTransition/);
  assert.match(guard, /existing && same\(existing, task\)/, "unchanged pre-backfill fixtures remain deploy-order compatible");
});
