import assert from "node:assert/strict";
import test from "node:test";
import { hasReminderCronSecret } from "../lib/reminder-cron-auth";

const request = (authorization?: string) => new Request("https://example.test/api/cron/trial-payment", {
  headers: authorization === undefined ? {} : { authorization },
});

test("reminder cron accepts a dedicated credential without requiring a Vercel credential", () => {
  assert.equal(hasReminderCronSecret(request("Bearer dedicated-test-token"), {
    OPS_REMINDER_CRON_SECRET: "dedicated-test-token",
  }), true);
});

test("adding a dedicated credential preserves the existing Vercel caller", () => {
  const environment = { OPS_REMINDER_CRON_SECRET: "dedicated-test-token", CRON_SECRET: "vercel-test-token" };
  for (const value of ["dedicated-test-token", "vercel-test-token"]) {
    assert.equal(hasReminderCronSecret(request(`Bearer ${value}`), environment), true);
  }
  assert.equal(hasReminderCronSecret(request("bearer vercel-test-token"), { CRON_SECRET: "vercel-test-token" }), true);
});

test("the default verifier reads server credentials at request time", () => {
  const previous = process.env.OPS_REMINDER_CRON_SECRET;
  try {
    process.env.OPS_REMINDER_CRON_SECRET = "runtime-test-token";
    assert.equal(hasReminderCronSecret(request("Bearer runtime-test-token")), true);
    process.env.OPS_REMINDER_CRON_SECRET = "replacement-test-token";
    assert.equal(hasReminderCronSecret(request("Bearer runtime-test-token")), false);
    assert.equal(hasReminderCronSecret(request("Bearer replacement-test-token")), true);
  } finally {
    if (previous === undefined) delete process.env.OPS_REMINDER_CRON_SECRET;
    else process.env.OPS_REMINDER_CRON_SECRET = previous;
  }
});

test("reminder cron fails closed without configured credentials or valid Bearer authentication", () => {
  assert.equal(hasReminderCronSecret(request("Bearer dedicated-test-token"), {}), false);
  const environment = { OPS_REMINDER_CRON_SECRET: "dedicated-test-token", CRON_SECRET: "" };
  for (const header of [undefined, "", "Bearer", "Basic dedicated-test-token", "dedicated-test-token", "Bearer incorrect-test-token", "Bearer x", "Bearer éééééé"]) {
    assert.equal(hasReminderCronSecret(request(header), environment), false);
  }
});
