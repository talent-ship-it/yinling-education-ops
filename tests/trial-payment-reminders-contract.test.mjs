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
  assert.match(route, /import \{ hasReminderCronSecret \} from "@\/lib\/reminder-cron-auth"/);
  assert.match(route, /if \(!hasReminderCronSecret\(request\)\) return noStore\(\{ error: "Not found" \}, 404\)/);
  assert.match(route, /getOpsState\(\[\.\.\.ENTITIES\]\)/);
  assert.match(route, /reconcileTrialPaymentTasksAuthoritative\(/);
  assert.match(route, /MAX_OCC_RETRIES = 3/);
  assert.match(route, /changedCount: saved\[0\]\.changed_count/);
  assert.doesNotMatch(route, /request\.json\(\)/);
  assert.doesNotMatch(route, /tasks\s*:/);
  assert.doesNotMatch(route, /new Date\(/);
  assert.deepEqual(vercel.crons, []);
});

test("payment complete/reopen is replay-first and atomically owns the task plus LP paid flag", async () => {
  const [route, service, store, migration, hardening, legacyRevoke, jiaowubaoCompletion, lifecycle] = await Promise.all([
    read("app/api/tasks/trial-payment/route.ts"),
    read("lib/trial-payment-task-service.ts"),
    read("lib/ops-store.ts"),
    read("supabase/migrations/20260819102000_trial_payment_reminders_authoritative.sql"),
    read("supabase/migrations/20260827000900_account_lifecycle_security_hardening.sql"),
    read("supabase/migrations/20260827000910_revoke_legacy_trial_payment_atomic.sql"),
    read("supabase/migrations/20260828000510_jiaowubao_trial_payment_completion.sql"),
    read("supabase/migrations/20260829000300_trial_payment_paid_lifecycle.sql"),
  ]);
  assert.match(route, /parseTrialPaymentLifecycleCommand\(body\)/);
  assert.match(route, /getTrialPaymentLifecycleCommandResult\(/);
  assert.match(route, /getTrialPaymentCompletionCommandResult\(/);
  assert.ok(
    route.indexOf("getTrialPaymentLifecycleCommandResult({")
      < route.indexOf("getOpsState([\"bookings\", \"students\", \"lpItems\", \"tasks\", \"teachers\"]"),
    "immutable receipt lookup must precede current task authorization",
  );
  assert.match(route, /const lateReplay = await readCommandReceipt\(\)/);
  assert.match(route, /if \(lateReplay\) return receiptOnly\(lateReplay\)/);
  assert.match(route, /getOpsState\(\["bookings", "students", "lpItems", "tasks", "teachers"\]\)/);
  assert.match(route, /canWriteOpsTransaction\(authorization, "tasks", \["tasks", "lpItems"\]\)/);
  assert.match(route, /taskVisible/);
  assert.match(route, /const fullAdmin = hasFullAdminAccess\(resolved\.session,/);
  assert.equal((route.match(/buildOpsAccessContext\([^;]+fullAdmin/g) ?? []).length, 2);
  assert.ok(
    route.indexOf("canWriteOpsTransaction(authorization, \"tasks\", [\"tasks\", \"lpItems\"])")
      < route.indexOf("const saved = await mutateTrialPaymentTaskLifecycleAtomic"),
    "current lifecycle permission and task scope must be checked before the atomic command",
  );
  assert.match(route, /mutateTrialPaymentTaskLifecycleAtomic/);
  assert.match(route, /managedTrialPaymentTaskKind/);
  assert.match(route, /paymentStateFromResult/);
  assert.doesNotMatch(route, /paymentState:\s*(null|paymentState)/);
  assert.match(route, /actorRole: fullAdmin[\s\S]*\? "admin"[\s\S]*resolved\.session\.role === "admin" \? "limited-admin"/);
  assert.match(route, /receiptOnly: true/);
  assert.match(route, /taskRow: null/);
  assert.match(route, /managedTrialPaymentStudentProjectionSnapshot\(/);
  assert.doesNotMatch(route, /putOpsState|mergeScopedPayload/);
  assert.match(service, /trial-payment-\(complete\|reopen\)/);
  assert.match(service, /\["action", "commandKey", "taskId", "expectedVersions"\]/);
  assert.match(service, /input\.role !== "staff"/);
  assert.match(service, /isManagedTrialPaymentTaskRecipient\(task, input\.actor\)/);
  assert.match(service, /student\.planner !== input\.actor/);
  assert.match(service, /trialSchedule/);
  assert.match(store, /p_command_intent: input\.commandIntent/);
  assert.match(store, /p_action: input\.action/);
  assert.match(store, /p_task_id: input\.taskId/);
  assert.match(store, /p_actor_role: input\.actorRole/);
  assert.match(store, /TRIAL_PAYMENT_LIFECYCLE_COMMAND_RESULT_RPC/);
  assert.match(store, /export function getTrialPaymentLifecycleCommandResult/);
  assert.doesNotMatch(store.slice(
    store.indexOf("export function mutateTrialPaymentTaskLifecycleAtomic"),
    store.indexOf("/**", store.indexOf("export function mutateTrialPaymentTaskLifecycleAtomic") + 10),
  ), /p_tasks|payload/);

  assert.match(lifecycle, /create table if not exists internal\.trial_payment_lifecycle_commands/);
  assert.match(lifecycle, /create or replace function public\.get_trial_payment_lifecycle_command_result/);
  assert.match(lifecycle, /create or replace function public\.mutate_trial_payment_task_lifecycle_tx/);
  const lifecycleMutation = lifecycle.slice(lifecycle.indexOf("create or replace function public.mutate_trial_payment_task_lifecycle_tx"));
  const lifecycleBookingLock = lifecycleMutation.indexOf("where entity = 'bookings' for update");
  const lifecycleStudentLock = lifecycleMutation.indexOf("where entity = 'students' for update");
  const lifecycleLpLock = lifecycleMutation.indexOf("where entity = 'lpItems' for update");
  const lifecycleTaskLock = lifecycleMutation.indexOf("where entity = 'tasks' for update");
  const lifecycleTeacherLock = lifecycleMutation.indexOf("where entity = 'teachers' for update");
  assert.ok(lifecycleBookingLock >= 0 && lifecycleBookingLock < lifecycleStudentLock
    && lifecycleStudentLock < lifecycleLpLock && lifecycleLpLock < lifecycleTaskLock
    && lifecycleTaskLock < lifecycleTeacherLock);
  assert.match(lifecycleMutation, /jsonb_build_object\('trialPaid', p_action = 'complete'\)/);
  assert.match(lifecycleMutation, /item\.value ->> 'id' = p_task_id[\s\S]*item\.value ->> 'status' in \('overdue', 'today', 'upcoming', 'waiting'\)/);
  assert.match(lifecycle, /item\.value ->> 'completionOutcome' is distinct from 'cannot_do'/);
  assert.match(lifecycleMutation, /item\.value - 'closedAt' - 'result' - 'completionOutcome'/);
  assert.match(lifecycleMutation, /values \('lpItems', saved_l\.version/);
  assert.match(lifecycleMutation, /values \('tasks', saved_t\.version/);
  assert.match(lifecycleMutation, /trial_payment_reopen/);
  assert.match(lifecycleMutation, /coalesce\(p_actor_role, ''\) not in \('staff', 'admin'\)/);
  assert.match(lifecycleMutation, /coalesce\(item\.value ->> 'dueAt', ''\) !~/);
  assert.match(lifecycle, /reconcile_trial_payment_tasks_for_booking_base_20260829000300/);
  assert.match(lifecycle, /lp_item -> 'trialPaid'/);
  assert.match(lifecycle, /if p_action <> 'delete'/);

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

  const hardenedStart = hardening.lastIndexOf("create or replace function public.complete_trial_payment_task_tx(");
  const hardenedEnd = hardening.indexOf("$function$;", hardenedStart);
  const hardened = hardening.slice(hardenedStart, hardenedEnd);
  assert.match(hardened, /if p_actor_role not in \('staff', 'admin'\) then/);
  assert.match(hardened, /p_actor_role <> 'admin'[\s\S]*trial_payment_planner_forbidden/);
  assert.match(hardened, /item\.value ->> 'id' = p_task_id/);
  assert.match(hardened, /p_actor_role = 'admin' or/);
  assert.doesNotMatch(hardening, /complete_trial_payment_task_atomic/);
  assert.match(legacyRevoke, /revoke all on function public\.complete_trial_payment_task_atomic/);
  assert.equal((legacyRevoke.match(/;/g) ?? []).length, 1);
  assert.match(store, /TRIAL_PAYMENT_COMPLETE_RPC = "complete_trial_payment_task_tx"/);
  assert.match(store, /JIAOWUBAO_TRIAL_PAYMENT_COMPLETE_RPC = "complete_jiaowubao_trial_payment_task_tx"/);
  assert.match(store, /export function completeJiaowubaoTrialPaymentTaskAtomic/);
  const receiptStart = hardening.indexOf("create or replace function public.get_trial_payment_completion_command_result(");
  const receiptEnd = hardening.indexOf("$$;", receiptStart);
  const receipt = hardening.slice(receiptStart, receiptEnd);
  assert.ok(receiptStart >= 0 && receiptEnd > receiptStart);
  assert.match(receipt, /prior\.actor is distinct from trim\(p_actor\)/);
  assert.match(receipt, /prior\.command_sha256 is distinct from command_hash/);
  assert.doesNotMatch(receipt, /public\.ops_state|bookings_row|students_row/);

  const jwbStart = jiaowubaoCompletion.indexOf("create or replace function public.complete_jiaowubao_trial_payment_task_tx(");
  const jwbEnd = jiaowubaoCompletion.indexOf("$function$;", jwbStart);
  const jwb = jiaowubaoCompletion.slice(jwbStart, jwbEnd);
  const jwbFirstLedger = jwb.indexOf("where commands.command_key = p_command_key");
  const jwbBookingsLock = jwb.indexOf("where entity = 'bookings' for update");
  const jwbStudentsLock = jwb.indexOf("where entity = 'students' for update");
  const jwbLpLock = jwb.indexOf("where entity = 'lpItems' for update");
  const jwbTasksLock = jwb.indexOf("where entity = 'tasks' for update");
  const jwbTeachersLock = jwb.indexOf("where entity = 'teachers' for update");
  const jwbSecondLedger = jwb.indexOf("where commands.command_key = p_command_key", jwbFirstLedger + 1);
  assert.ok(jwbFirstLedger >= 0 && jwbFirstLedger < jwbBookingsLock);
  assert.ok(jwbBookingsLock < jwbStudentsLock && jwbStudentsLock < jwbLpLock
    && jwbLpLock < jwbTasksLock && jwbTasksLock < jwbTeachersLock
    && jwbTeachersLock < jwbSecondLedger);
  assert.match(jwb, /trial\.jiaowubao\.payment-n2/);
  assert.match(jwb, /requestAnchorBookingId/);
  assert.match(jwb, /trialSchedule,eventId/);
  assert.match(jwb, /trialSchedule,source/);
  assert.match(jwb, /trialSchedule,sourceRevision/);
  assert.match(jwb, /trialIntake,planner/);
  assert.match(jwb, /when 'tara' then 'Tara'/);
  assert.match(jwb, /task_item ->> 'status' in \('overdue', 'today', 'upcoming', 'waiting'\)/);
  assert.match(jwb, /fields,trialPaymentMethod/);
  assert.match(jwb, /internal\.jiaowubao_open_api_schedule_snapshot_current/);
  assert.match(jwb, /internal\.jiaowubao_open_api_schedule_snapshot_ingest_items/);
  assert.match(jwb, /pointer\.revision is distinct from lp_item #>> '\{trialSchedule,sourceRevision\}'/);
  assert.match(jwb, /b\.version <> \(p_expected_versions ->> 'bookings'\)::bigint[\s\S]*l\.version <> \(p_expected_versions ->> 'lpItems'\)::bigint[\s\S]*t\.version <> \(p_expected_versions ->> 'tasks'\)::bigint/);
  assert.match(jiaowubaoCompletion, /revoke all on function public\.complete_jiaowubao_trial_payment_task_tx[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(jiaowubaoCompletion, /grant execute on function public\.complete_jiaowubao_trial_payment_task_tx[\s\S]*to anon, authenticated/);
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
  assert.match(stateRoute, /entities\.includes\("lpItems"\)/);
  assert.match(stateRoute, /entities\.includes\("tasks"\)/);
  const dtoStart = projection.indexOf("export type ManagedTrialPaymentStudentProjection");
  const dtoEnd = projection.indexOf("}>;", dtoStart);
  assert.ok(dtoStart >= 0 && dtoEnd > dtoStart);
  const dto = projection.slice(dtoStart, dtoEnd + 3);
  assert.match(dto, /id: string;\s+name: string;\s+initials: string;/);
  assert.doesNotMatch(dto, /owner|planner|guardian|wechat|phone|email/i);
  assert.match(projection, /versions\[entity\] !== parseVersion\(authorityVersions\[entity\], entity\)/);
});

test("client polls and mutates payment lifecycle without optimistic task writes", async () => {
  const [client, list, pending, projection] = await Promise.all([
    read("app/operations-client.tsx"),
    read("app/to-do-list.tsx"),
    read("lib/trial-payment-pending.ts"),
    read("lib/managed-trial-payment.ts"),
  ]);
  assert.match(client, /createSharedStatePoller/);
  assert.match(client, /includeManagedTrialPaymentSnapshot/);
  assert.match(client, /parseManagedTrialPaymentAuthorityVersions\(responseRows\)/);
  assert.match(client, /fetchJsonWithTimeout\(fetch, "\/api\/tasks\/trial-payment"/);
  assert.match(client, /trial-payment-\$\{action\}:\$\{crypto\.randomUUID\(\)\}/);
  assert.match(client, /readTrialPaymentPendingCommands\(browserSessionStorage\(\), sessionOperator\)/);
  assert.match(client, /receipt\.receiptOnly/);
  assert.match(client, /isAdminSession \? "admin" : "staff"/);
  assert.match(client, /const adminCanComplete = isAdminSession && isAdminView/);
  assert.match(client, /managedTrialPaymentStudentIds\.has\(task\.studentId\)/);
  assert.match(client, /mutateManagedTrialPayment\(task\.id, "reopen"\)/);
  assert.match(client, /canReopen=\{\(task\) => task\.ruleKey !== "wecom\.handover\.identity"[\s\S]*!isManagedTrialPaymentTask\(task\)[\s\S]*isManagedTrialPaymentConfirmationTask\(task\)\)\}/);
  assert.match(list, /canReopen\?\.\(task\) !== false \? <button/);
  const submitStart = client.indexOf("const mutateManagedTrialPayment = useCallback");
  const submitEnd = client.indexOf("const completeTask =", submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  assert.doesNotMatch(client.slice(submitStart, submitEnd), /setTasks\(/);
  assert.match(pending, /receiptOnly/);
  assert.match(projection, /parseManagedTrialPaymentLifecycleReceipt/);
});
