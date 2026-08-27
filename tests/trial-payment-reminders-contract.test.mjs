import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("urgent reminders have a secret-gated fixed-frequency server reconciler", async () => {
  const [route, vercelText] = await Promise.all([
    read("app/api/cron/trial-payment/route.ts"),
    read("vercel.json"),
  ]);
  const vercel = JSON.parse(vercelText);
  assert.match(route, /CRON_SECRET/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /getOpsState\(\[\.\.\.ENTITIES\]\)/);
  assert.match(route, /reconcileTrialPaymentTasksAuthoritative\(/);
  assert.match(route, /MAX_OCC_RETRIES = 3/);
  assert.match(route, /changedCount: saved\[0\]\.changed_count/);
  assert.doesNotMatch(route, /request\.json\(\)/);
  assert.doesNotMatch(route, /tasks\s*:/);
  assert.doesNotMatch(route, /new Date\(/);
  assert.deepEqual(vercel.crons, []);
});

test("planner completion is a replay-first narrow command and never accepts a task replacement", async () => {
  const [route, service, store, migration, hardening] = await Promise.all([
    read("app/api/tasks/trial-payment/route.ts"),
    read("lib/trial-payment-task-service.ts"),
    read("lib/ops-store.ts"),
    read("supabase/migrations/20260819102000_trial_payment_reminders_authoritative.sql"),
    read("supabase/migrations/20260827000900_account_lifecycle_security_hardening.sql"),
  ]);
  assert.match(route, /parseTrialPaymentCompletionCommand\(body\)/);
  assert.match(route, /getTrialPaymentCompletionCommandResult\(/);
  assert.ok(
    route.indexOf("getTrialPaymentCompletionCommandResult({")
      < route.indexOf("getOpsState([\"bookings\", \"students\", \"lpItems\", \"tasks\", \"teachers\"]"),
    "immutable receipt lookup must precede current task authorization",
  );
  assert.match(route, /const lateReplay = await readCommandReceipt\(\)/);
  assert.match(route, /if \(lateReplay\[0\]\) return receiptOnly\(lateReplay\[0\]\)/);
  assert.doesNotMatch(route, /authorizeTrialPaymentTaskCompletion\(/);
  assert.match(route, /getOpsState\(\["bookings", "students", "lpItems", "tasks", "teachers"\]\)/);
  assert.match(route, /canWriteOpsEntity\(authorization, "tasks"\)/);
  assert.match(route, /taskVisible/);
  assert.match(route, /const fullAdmin = resolved\.session\.user === DEMO_ADMIN_USER/);
  assert.equal((route.match(/buildOpsAccessContext\([^;]+fullAdmin/g) ?? []).length, 2);
  assert.ok(
    route.indexOf("canWriteOpsEntity(authorization, \"tasks\")")
      < route.indexOf("completeTrialPaymentTaskAtomic({"),
    "current lifecycle permission and task scope must be checked before the atomic command",
  );
  assert.match(route, /completeTrialPaymentTaskAtomic\(/);
  assert.match(route, /actorRole: resolved\.session\.role/);
  assert.match(route, /receiptOnly: true/);
  assert.match(route, /taskRow: null/);
  assert.match(route, /managedTrialPaymentStudentProjectionSnapshot\(/);
  assert.doesNotMatch(route, /putOpsState|mergeScopedPayload/);
  assert.match(service, /Object\.keys\(value\)\.some\(\(key\) => !\["commandKey", "taskId", "expectedVersions"\]/);
  assert.match(service, /input\.role !== "staff"/);
  assert.match(service, /task\.owner !== input\.actor/);
  assert.match(service, /candidate\.planner === input\.actor/);
  assert.match(store, /p_command_intent: input\.commandIntent/);
  assert.match(store, /p_task_id: input\.taskId/);
  assert.match(store, /p_actor_role: input\.actorRole/);
  assert.match(store, /TRIAL_PAYMENT_COMPLETION_COMMAND_RESULT_RPC/);
  assert.match(store, /export function getTrialPaymentCompletionCommandResult/);
  assert.doesNotMatch(store.slice(
    store.indexOf("export function completeTrialPaymentTaskAtomic"),
    store.indexOf("/**", store.indexOf("export function completeTrialPaymentTaskAtomic") + 10),
  ), /p_tasks|payload/);

  const completionStart = migration.indexOf("create or replace function public.complete_trial_payment_task_atomic(");
  const completionEnd = migration.indexOf("$function$;", completionStart);
  const completion = migration.slice(completionStart, completionEnd);
  const firstLedger = completion.indexOf("where commands.command_key = p_command_key");
  const locks = completion.indexOf("where entity = 'bookings' for update");
  const secondLedger = completion.indexOf("where commands.command_key = p_command_key", firstLedger + 1);
  const roleGate = completion.indexOf("if p_actor_role <> 'staff' then");
  const taskAuthority = completion.indexOf("trial_payment_task_not_found");
  assert.ok(firstLedger >= 0 && firstLedger < locks);
  assert.ok(locks < secondLedger && secondLedger < roleGate && roleGate < taskAuthority);

  const hardenedStart = hardening.lastIndexOf("create or replace function public.complete_trial_payment_task_atomic(");
  const hardenedEnd = hardening.indexOf("$function$;", hardenedStart);
  const hardened = hardening.slice(hardenedStart, hardenedEnd);
  assert.match(hardened, /if p_actor_role not in \('staff', 'admin'\) then/);
  assert.match(hardened, /p_actor_role <> 'admin'[\s\S]*trial_payment_planner_forbidden/);
  assert.match(hardened, /item\.value ->> 'id' = p_task_id/);
  assert.match(hardened, /p_actor_role = 'admin' or/);
  const receiptStart = hardening.indexOf("create or replace function public.get_trial_payment_completion_command_result(");
  const receiptEnd = hardening.indexOf("$$;", receiptStart);
  const receipt = hardening.slice(receiptStart, receiptEnd);
  assert.ok(receiptStart >= 0 && receiptEnd > receiptStart);
  assert.match(receipt, /prior\.actor is distinct from trim\(p_actor\)/);
  assert.match(receipt, /prior\.command_sha256 is distinct from command_hash/);
  assert.doesNotMatch(receipt, /public\.ops_state|bookings_row|students_row/);
});

test("cross-owner payment snapshot is version-bound and separately requested", async () => {
  const [snapshotRoute, stateRoute, projection] = await Promise.all([
    read("app/api/app-snapshot/route.ts"),
    read("app/api/app-state/route.ts"),
    read("lib/managed-trial-payment.ts"),
  ]);
  assert.match(snapshotRoute, /managedTrialPaymentStudentProjectionSnapshot\(rows, access\)/);
  assert.match(stateRoute, /includeManagedTrialPaymentSnapshot/);
  assert.match(stateRoute, /entities\?\.includes\("bookings"\)/);
  assert.match(stateRoute, /entities\.includes\("students"\)/);
  assert.match(stateRoute, /entities\.includes\("tasks"\)/);
  const dtoStart = projection.indexOf("export type ManagedTrialPaymentStudentProjection");
  const dtoEnd = projection.indexOf("}>;", dtoStart);
  assert.ok(dtoStart >= 0 && dtoEnd > dtoStart);
  const dto = projection.slice(dtoStart, dtoEnd + 3);
  assert.match(dto, /id: string;\s+name: string;\s+initials: string;/);
  assert.doesNotMatch(dto, /owner|planner|guardian|wechat|phone|email/i);
  assert.match(projection, /versions\[entity\] !== parseVersion\(authorityVersions\[entity\], entity\)/);
});

test("client polls and completes payment reminders without optimistic task writes", async () => {
  const [client, pending, projection] = await Promise.all([
    read("app/operations-client.tsx"),
    read("lib/trial-payment-pending.ts"),
    read("lib/managed-trial-payment.ts"),
  ]);
  assert.match(client, /const activeDelayMs = 15_000/);
  assert.match(client, /includeManagedTrialPaymentSnapshot/);
  assert.match(client, /parseManagedTrialPaymentAuthorityVersions\(responseRows\)/);
  assert.match(client, /fetchWithTimeout\(fetch, "\/api\/tasks\/trial-payment"/);
  assert.match(client, /trial-payment-complete:\$\{crypto\.randomUUID\(\)\}/);
  assert.match(client, /readTrialPaymentPendingCommands\(browserSessionStorage\(\), sessionOperator\)/);
  assert.match(client, /receipt\.receiptOnly/);
  assert.match(client, /managedTrialPaymentStudentIds\.has\(task\.studentId\)/);
  const submitStart = client.indexOf("const completeManagedTrialPayment = useCallback");
  const submitEnd = client.indexOf("const completeTask =", submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  assert.doesNotMatch(client.slice(submitStart, submitEnd), /setTasks\(/);
  assert.match(pending, /receiptOnly/);
  assert.match(projection, /parseManagedTrialPaymentCompletionReceipt/);
});
