import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_RULES,
  FIXED_REMINDER_RULES,
  normalizeRules,
  OpsRulesValidationError,
  parseRulesWrite,
  RULE_OPTIONS,
} from "../lib/ops-rules";

test("keeps confirmed workflow deadlines outside editable rules", () => {
  assert.deepEqual(FIXED_REMINDER_RULES, {
    parentSpecifiedContentDaysAfterRequest: 0,
    lpReviewDaysBeforeTrial: 3,
    preparationDaysBeforeTrial: 2,
    minimumDaysBeforeTrial: 1,
    schedulingFeedbackHoursAfterRequest: 24,
    parentNoReplyFollowUpHoursAfterRequest: 4,
    teachingControlEscalationHoursAfterRequest: 8,
    parentProgressSyncHoursAfterRequest: 24,
    parentProgressSyncIntervalHours: 24,
  });
  assert.deepEqual(RULE_OPTIONS.lowHours, ["3", "5", "8", "10"]);
  assert.deepEqual(RULE_OPTIONS.examDays, ["7", "14", "30", "60"]);
  assert.equal(Object.isFrozen(FIXED_REMINDER_RULES), true);
  assert.equal(Object.isFrozen(RULE_OPTIONS.lowHours), true);
  assert.equal(Object.isFrozen(RULE_OPTIONS.examDays), true);
});

test("normalizes current and legacy shared payloads to two editable fields", () => {
  assert.deepEqual(normalizeRules({ lowHours: "8", examDays: "14" }), {
    lowHours: "8",
    examDays: "14",
  });
  assert.deepEqual(normalizeRules({
    lpDays: "N-3",
    feedbackHours: "48",
    renewalDays: "8",
    escalation: "逾期 4 小时后通知主管",
    lowHours: "10",
    examDays: "60",
  }), {
    lowHours: "10",
    examDays: "60",
  });
  assert.deepEqual(normalizeRules({ lowHours: 3, examDays: 7 }), {
    lowHours: "3",
    examDays: "7",
  });
});

test("read normalization safely falls back for missing or invalid legacy values", () => {
  assert.deepEqual(normalizeRules(null), DEFAULT_RULES);
  assert.deepEqual(normalizeRules([]), DEFAULT_RULES);
  assert.deepEqual(normalizeRules({ lowHours: "4", examDays: "forever" }), DEFAULT_RULES);
  assert.deepEqual(normalizeRules({ lowHours: "8" }), {
    lowHours: "8",
    examDays: DEFAULT_RULES.examDays,
  });
});

test("strict writes accept every published option combination", () => {
  for (const lowHours of RULE_OPTIONS.lowHours) {
    for (const examDays of RULE_OPTIONS.examDays) {
      assert.deepEqual(parseRulesWrite({ lowHours, examDays }), { lowHours, examDays });
    }
  }
});

test("strict writes reject free text, numeric values, missing fields and extra fields", () => {
  for (const payload of [
    null,
    [],
    { lowHours: "5" },
    { examDays: "30" },
    { lowHours: "4", examDays: "30" },
    { lowHours: "5", examDays: "31" },
    { lowHours: "5.5", examDays: "30" },
    { lowHours: 5, examDays: 30 },
    { lowHours: "5", examDays: "30", escalation: "never" },
  ]) {
    assert.throws(() => parseRulesWrite(payload), OpsRulesValidationError);
  }
});

test("the app-state API validates rules before shared-state persistence", async () => {
  const route = await readFile(new URL("../app/api/app-state/route.ts", import.meta.url), "utf8");
  const validationIndex = route.indexOf("parseRulesWrite(body.payload)");
  const persistenceIndex = route.indexOf("putOpsState({");

  assert.notEqual(validationIndex, -1);
  assert.notEqual(persistenceIndex, -1);
  assert.ok(validationIndex < persistenceIndex);
  assert.match(route, /error instanceof OpsRulesValidationError/);
  assert.match(route, /400/);
});
