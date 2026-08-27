import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260819102000_trial_payment_reminders_authoritative.sql", import.meta.url);

test("trial payment reminders are a database-owned projection", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /trialPaymentMethod/);
  assert.match(sql, /付费试听（已付费）/);
  assert.match(sql, /trial\.payment-n2/);
  assert.match(sql, /trial\.payment-urgent/);
  assert.match(sql, /Australia\/Melbourne/);
  assert.match(sql, /if fee_required is not true then/);
  assert.match(sql, /requestAnchorBookingId' = candidate\.value ->> 'id'/);
  assert.match(sql, /where \(select count\(\*\) from explicit_booking_links\) = 1/);
  assert.match(sql, /trial_starts_at - p_now < interval '3 days'/);
  assert.match(sql, /规划账号未配置，收费提醒暂停/);
  assert.match(sql, /assignees/);
  assert.match(sql, /watchers/);
  assert.match(sql, /revoke all on function internal\.reconcile_trial_payment_tasks/);
  assert.doesNotMatch(sql, /create\s+(?:constraint\s+)?trigger/i);
  assert.doesNotMatch(sql, /before\s+insert\s+or\s+update\s+of\s+payload/i);
});

test("booking projection and scheduled reconciliation share locked authority", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /rebuild_booking_trial_tasks_base_191019/);
  assert.match(sql, /create or replace function internal\.rebuild_booking_trial_tasks\(/);
  assert.match(sql, /working := internal\.rebuild_booking_trial_tasks_base_191019\(/);
  assert.match(sql, /return internal\.reconcile_trial_payment_tasks_for_booking\(/);
  assert.match(sql, /mutate_booking_projection_atomic already holds this row FOR UPDATE/);

  for (const functionName of [
    "reconcile_trial_payment_tasks_authoritative",
    "complete_trial_payment_task_atomic",
  ]) {
    const start = sql.indexOf(`create or replace function public.${functionName}(`);
    assert.ok(start >= 0, `${functionName} must exist`);
    const end = sql.indexOf("$function$;", start);
    const body = sql.slice(start, end);
    const lockOffsets = ["bookings", "students", "lpItems", "tasks", "teachers"].map((entity) =>
      body.indexOf(`where entity = '${entity}' for update`));
    assert.ok(lockOffsets.every((offset) => offset >= 0), `${functionName} must lock all authority rows`);
    assert.deepEqual([...lockOffsets].sort((left, right) => left - right), lockOffsets,
      `${functionName} must use the global b→s→l→t→h lock order`);
  }
});

test("cron and planner completion RPCs are private, idempotent server commands", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table if not exists internal\.trial_payment_reconcile_runs/);
  assert.match(sql, /create table if not exists internal\.trial_payment_completion_commands/);
  assert.match(sql, /internal\.verify_ops_secret\(p_secret\)/);
  assert.match(sql, /p_actor is distinct from 'Trial Payment Scheduler'/);
  assert.match(sql, /clock_timestamp\(\)/);
  assert.match(sql, /已由规划老师确认试听付款/);
  assert.match(sql, /if p_actor_role <> 'staff' then/);
  assert.ok(
    sql.indexOf("where commands.command_key = p_command_key")
      < sql.indexOf("if p_actor_role <> 'staff' then"),
    "an exact command receipt must be checked before current role authority",
  );
  assert.match(sql, /grant execute on function public\.reconcile_trial_payment_tasks_authoritative[\s\S]+?to anon, authenticated/);
  assert.match(sql, /grant execute on function public\.complete_trial_payment_task_atomic[\s\S]+?to anon, authenticated/);
  assert.doesNotMatch(sql, /grant execute on function public\.(?:reconcile|complete)_trial_payment[\s\S]+?to service_role/);
});
