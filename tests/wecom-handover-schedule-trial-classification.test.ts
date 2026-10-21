import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { trialAccountLetter } from "../lib/trial-account-label.ts";

test("SQL reader account cases retain every shared account recognized by the matcher", () => {
  const runtime = readFileSync(new URL("./sql/wecom-handover-schedule-history-cache-runtime.sql", import.meta.url), "utf8");
  const cases = JSON.parse(runtime.split("$trial_accounts$")[1]) as { label: string; letter: string | null; include: boolean }[];
  for (const { label, letter, include } of cases) {
    assert.equal(trialAccountLetter(label), letter, label);
    if (letter) assert.equal(include, true, label);
  }
});
