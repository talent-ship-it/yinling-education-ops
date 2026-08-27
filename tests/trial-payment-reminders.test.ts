import assert from "node:assert/strict";
import test from "node:test";

import { generateTrialPaymentTasks } from "@/lib/ops-tasks";

test("paid trial payment reminders use Melbourne N-2 and a deterministic urgent rule", () => {
  const tasks = generateTrialPaymentTasks({
    anchorBookingId: "BOOK-PAY-1",
    studentId: "STU-PAY-1",
    planner: "Tara",
    trialStartsAt: "2026-08-20T00:00:00.000Z", // 10:00 Melbourne in winter
    trialPaymentMethod: "付费试听（未付费）",
    now: "2026-08-19T01:00:00.000Z",
  });
  assert.deepEqual(tasks.map((task) => task.ruleKey), ["trial.payment-n2", "trial.payment-urgent"]);
  assert.equal(tasks[0].dueAt, "2026-08-18T08:00:00.000Z");
  assert.equal(tasks[1].dueAt, "2026-08-19T00:00:00.000Z");
  assert.equal(tasks[1].tone, "red");
  assert.equal(tasks[0].owner, "Tara");
  assert.deepEqual(tasks[0].assignees, ["Tara"]);
  assert.deepEqual(tasks[0].watchers, ["Ops Admin"]);
  assert.notEqual(tasks[0].id, tasks[1].id);
  assert.equal(tasks[0].id, generateTrialPaymentTasks({
    anchorBookingId: "BOOK-PAY-1",
    studentId: "STU-PAY-1",
    planner: "Tara",
    trialStartsAt: "2026-08-20T00:00:00.000Z",
    trialPaymentMethod: "付费试听（未付费）",
    now: "2026-08-19T01:00:00.000Z",
  })[0].id);
});

test("free, unknown and already-paid signals never create an open unpaid reminder", () => {
  const common = {
    anchorBookingId: "BOOK-PAY-2",
    studentId: "STU-PAY-2",
    planner: "Tara",
    trialStartsAt: "2026-08-20T00:00:00.000Z",
    now: "2026-08-19T01:00:00.000Z",
  } as const;
  assert.deepEqual(generateTrialPaymentTasks({ ...common, trialPaymentMethod: "免费试听" }), []);
  assert.deepEqual(generateTrialPaymentTasks({ ...common, trialPaymentMethod: "待确认" }), []);
  assert.deepEqual(generateTrialPaymentTasks(common), []);
  assert.deepEqual(generateTrialPaymentTasks({ ...common, trialPaymentMethod: null }), []);
  const paid = generateTrialPaymentTasks({ ...common, trialPaymentMethod: "付费试听（已付费）" });
  assert.deepEqual(paid.map((task) => task.ruleKey), ["trial.payment-n2"]);
  assert.equal(paid[0].status, "done");
  assert.equal(paid[0].result, "试听已付费，收费提醒自动关闭");
});

test("N-2 uses Melbourne civil time across daylight saving", () => {
  const tasks = generateTrialPaymentTasks({
    anchorBookingId: "BOOK-SUMMER",
    studentId: "STU-SUMMER",
    planner: "Tara",
    trialStartsAt: "2026-12-20T23:00:00.000Z", // 21 Dec 10:00 AEDT
    trialPaymentMethod: "付费试听（未付费）",
    now: "2026-12-18T00:00:00.000Z",
  });
  assert.equal(tasks[0].dueAt, "2026-12-19T07:00:00.000Z"); // 19 Dec 18:00 AEDT
  assert.equal(tasks.some((task) => task.ruleKey === "trial.payment-urgent"), false);
});

test("N-2 enters only inside the strict N-3 window", () => {
  const common = {
    anchorBookingId: "BOOK-WINDOW",
    studentId: "STU-WINDOW",
    planner: "Tara",
    trialStartsAt: "2026-08-23T00:00:00.000Z",
    trialPaymentMethod: "付费试听（未付费）",
  } as const;
  assert.deepEqual(generateTrialPaymentTasks({
    ...common,
    now: "2026-08-20T00:00:00.000Z", // exactly 72 hours
  }), []);
  assert.deepEqual(generateTrialPaymentTasks({
    ...common,
    now: "2026-08-19T23:59:59.999Z", // still outside
  }), []);
  assert.deepEqual(generateTrialPaymentTasks({
    ...common,
    now: "2026-08-20T00:00:00.001Z", // 72 hours minus 1 ms
  }).map((task) => task.ruleKey), ["trial.payment-n2"]);
});
