import assert from "node:assert/strict";
import test from "node:test";

import {
  TRIAL_LEDGER_FIELDS,
  TrialLedgerError,
  effectiveTrialResultStatus,
  normalizeTrialLedgerFieldValue,
  parseTrialLedgerCommand,
  trialLedgerCommandIntent,
  trialLedgerStoredValue,
} from "../lib/trial-ledger";

const commandKey = "123e4567-e89b-42d3-a456-426614174000";

test("the trial ledger exposes the handbook columns and LP finalized status as atomic fields", () => {
  assert.deepEqual(TRIAL_LEDGER_FIELDS, [
    "studentName",
    "guardianWechat",
    "workflowType",
    "lessonMonth",
    "requestedAt",
    "scheduledAt",
    "operationsOwner",
    "planner",
    "subject",
    "teacher",
    "resultStatus",
    "trialPaid",
    "lpFinalized",
    "trialLedgerNote",
  ]);
});

test("parses one canonical field-level command and keeps nullable reset values", () => {
  const parsed = parseTrialLedgerCommand({
    commandKey,
    lpItemId: "LP-TRIAL-1",
    field: "scheduledAt",
    expectedValue: null,
    value: "2026-09-03T08:00:00+00:00",
  });
  assert.deepEqual(parsed, {
    commandKey,
    lpItemId: "LP-TRIAL-1",
    field: "scheduledAt",
    value: "2026-09-03T08:00:00.000Z",
  });
  assert.deepEqual(trialLedgerCommandIntent(parsed), {
    lpItemId: "LP-TRIAL-1",
    field: "scheduledAt",
    expectedValue: null,
    value: "2026-09-03T08:00:00.000Z",
  });

  const reset = parseTrialLedgerCommand({
    commandKey,
    lpItemId: "LP-TRIAL-1",
    field: "trialPaid",
    expectedValue: false,
    value: null,
  });
  assert.equal(reset.expectedValue, false);
  assert.equal(reset.value, undefined);
});

test("validates handbook choices, dates, booleans and text limits", () => {
  assert.equal(normalizeTrialLedgerFieldValue("operationsOwner", " Ella "), "Ella");
  assert.equal(normalizeTrialLedgerFieldValue("planner", "Abby"), "Abby");
  assert.equal(normalizeTrialLedgerFieldValue("workflowType", "换老师试听"), "换老师试听");
  assert.equal(normalizeTrialLedgerFieldValue("lessonMonth", "2026-09"), "2026-09");
  assert.equal(normalizeTrialLedgerFieldValue("resultStatus", "在读试听失败"), "在读试听失败");
  assert.equal(normalizeTrialLedgerFieldValue("trialPaid", false), false);
  assert.equal(normalizeTrialLedgerFieldValue("trialLedgerNote", " 复盘备注 "), "复盘备注");

  for (const [field, value] of [
    ["operationsOwner", "Nixon"],
    ["planner", "Molly"],
    ["workflowType", "老师新 LP"],
    ["lessonMonth", "2026-13"],
    ["resultStatus", "已完成"],
    ["trialPaid", "yes"],
  ] as const) {
    assert.throws(
      () => normalizeTrialLedgerFieldValue(field, value),
      (error: unknown) => error instanceof TrialLedgerError && error.code === "invalid_command",
    );
  }
});

test("rejects extra command properties and reports stored manual values only", () => {
  assert.throws(() => parseTrialLedgerCommand({
    commandKey,
    lpItemId: "LP-TRIAL-1",
    field: "teacher",
    expectedValue: null,
    value: "Zara Baker",
    actor: "forged",
  }), TrialLedgerError);

  const item = {
    id: "LP-TRIAL-1",
    workflowType: "试听 LP",
    resultStatus: "试听成功" as const,
    trialLedgerOverrides: { teacher: "Zara Baker", lessonMonth: "2026-09" },
    trialPaid: false,
    trialLedgerNote: "Sales follow-up",
  };
  assert.equal(trialLedgerStoredValue(item, "teacher"), "Zara Baker");
  assert.equal(trialLedgerStoredValue(item, "lessonMonth"), "2026-09");
  assert.equal(trialLedgerStoredValue(item, "studentName"), undefined);
  assert.equal(trialLedgerStoredValue(item, "resultStatus"), "试听成功");
  assert.equal(trialLedgerStoredValue(item, "trialPaid"), false);
  assert.equal(trialLedgerStoredValue(item, "trialLedgerNote"), "Sales follow-up");
});

test("accepts cancelled and NIL trial results through field-level commands", () => {
  for (const resultStatus of ["被家长取消", "NIL"] as const) {
    const command = parseTrialLedgerCommand({
      commandKey,
      lpItemId: "LP-TRIAL-1",
      field: "resultStatus",
      expectedValue: resultStatus,
      value: resultStatus,
    });
    assert.equal(command.expectedValue, resultStatus);
    assert.equal(command.value, resultStatus);
    for (const workflowType of ["试听 LP", "换老师试听"]) {
      assert.equal(effectiveTrialResultStatus({ workflowType, resultStatus }), resultStatus);
    }
  }
});

test("LP finalized uses a nullable boolean command and its dedicated stored property", () => {
  for (const value of [true, false, null]) {
    const command = parseTrialLedgerCommand({ commandKey, lpItemId: "LP-TRIAL-1", field: "lpFinalized", expectedValue: null, value });
    assert.equal(command.value, value ?? undefined);
  }
  assert.equal(trialLedgerStoredValue({ id: "LP-1", trialLpFinalized: true }, "lpFinalized"), true);
  assert.equal(trialLedgerStoredValue({ id: "LP-1", trialLpFinalized: false }, "lpFinalized"), false);
  assert.equal(trialLedgerStoredValue({ id: "LP-1" }, "lpFinalized"), undefined);
  assert.throws(() => normalizeTrialLedgerFieldValue("lpFinalized", "true"), TrialLedgerError);
});


test("the original Tencent delayed-arrangement result remains a distinct editable trial status", () => {
  const command = parseTrialLedgerCommand({ commandKey, lpItemId: "LP-TRIAL-1", field: "resultStatus", expectedValue: null, value: "延迟待安排" });
  assert.equal(command.value, "延迟待安排");
  assert.equal(effectiveTrialResultStatus({ workflowType: "试听 LP", resultStatus: "延迟待安排" }), "延迟待安排");
});
