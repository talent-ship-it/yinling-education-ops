import assert from "node:assert/strict";
import test from "node:test";

import { TENCENT_TRIAL_LEDGER_FIELDS, type TencentTrialLedgerField } from "../lib/tencent-trial-ledger-mirror";
import {
  assertTencentTrialLedgerReadback,
  planTencentTrialLedgerWrites,
  tencentTrialLedgerFieldWrites,
  type TencentTrialLedgerSyncRow,
  type TencentTrialLedgerTargetRecord,
} from "../lib/tencent-trial-ledger-sync-plan";

const HASH = "a".repeat(64);

function row(id: string, overrides: Partial<Record<TencentTrialLedgerField, string>> = {}): TencentTrialLedgerSyncRow {
  const values = Object.fromEntries(TENCENT_TRIAL_LEDGER_FIELDS.map((field) => [field, ""])) as Record<TencentTrialLedgerField, string>;
  return {
    lpItemId: id,
    payloadSha256: HASH,
    values: {
      ...values,
      学生姓名: `Student ${id}`,
      "LP 类型": "试听 LP",
      "请求日期/时间": "2026-08-29T01:02:03.000Z",
      是否付费: "否",
      ...overrides,
    },
  };
}

function target(recordId: string, source: TencentTrialLedgerSyncRow): TencentTrialLedgerTargetRecord {
  return {
    record_id: recordId,
    field_values: tencentTrialLedgerFieldWrites(source).map((value) => ({
      ...value,
      ...(value.string_value ? { string_value: String(Date.parse(source.values[value.field])) } : {}),
    })),
  };
}

test("keeps immutable mappings, updates drift and adopts only unreserved exact records", () => {
  const first = row("LP-1");
  const second = row("LP-2");
  const historical = row("LP-HISTORICAL", { 学生姓名: second.values.学生姓名 });
  const drifted = target("rec_1", first);
  drifted.field_values.find((value) => (value as { field?: string }).field === "学生姓名")!.text_value = {
    items: [{ text: "Old", type: "text" }],
  };
  const exactReserved = target("rec_reserved", historical);
  const exactAvailable = target("rec_available", second);
  const plan = planTencentTrialLedgerWrites({
    rows: [first, second],
    mappings: [
      { lpItemId: first.lpItemId, recordId: "rec_1", payloadSha256: HASH },
      { lpItemId: historical.lpItemId, recordId: "rec_reserved", payloadSha256: HASH },
    ],
    records: [drifted, exactReserved, exactAvailable],
  });

  assert.deepEqual(plan.assignments.map(({ row: source, recordId, source: kind }) => [source.lpItemId, recordId, kind]), [
    ["LP-1", "rec_1", "mapped"],
    ["LP-2", "rec_available", "adopted"],
  ]);
  assert.deepEqual(plan.updates.map((update) => update.recordId), ["rec_1"]);
  assert.equal(plan.creates.length, 0);
});

test("creates an unmapped row, serializes dates as milliseconds and omits blank add values", () => {
  const source = row("LP-NEW");
  const plan = planTencentTrialLedgerWrites({ rows: [source], mappings: [], records: [] });
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.updates.length, 0);
  const fields = plan.creates[0]!.fieldValues;
  assert.equal(fields.find((value) => value.field === "请求日期/时间")?.string_value, String(Date.parse(source.values["请求日期/时间"])));
  assert.equal(fields.some((value) => value.field === "备注"), false);
});

test("fails closed when an immutable mapped Tencent record is missing", () => {
  const source = row("LP-1");
  assert.throws(() => planTencentTrialLedgerWrites({
    rows: [source],
    mappings: [{ lpItemId: source.lpItemId, recordId: "rec_missing", payloadSha256: HASH }],
    records: [],
  }), /mapped_record_missing/);
});

test("recovers an uncertain add from the pinned claim before applying a changed payment state", () => {
  const original = row("LP-1", { 是否付费: "否" });
  const newer = row("LP-1", { 是否付费: "是" });
  // The v2 database claim returns this original snapshot until completion;
  // tests/sql/tencent-trial-ledger-recovery-runtime.sql executes that contract.
  const acceptedWithoutReceipt = target("rec_original", original);
  const retry = planTencentTrialLedgerWrites({
    rows: [original], mappings: [], records: [acceptedWithoutReceipt],
  });
  assert.equal(retry.creates.length, 0);
  assert.equal(retry.assignments[0]?.source, "adopted");
  assert.equal(retry.assignments[0]?.recordId, "rec_original");

  const afterCompletion = planTencentTrialLedgerWrites({
    rows: [newer],
    mappings: [{ lpItemId: original.lpItemId, recordId: "rec_original", payloadSha256: HASH }],
    records: [acceptedWithoutReceipt],
  });
  assert.equal(afterCompletion.creates.length, 0);
  assert.equal(afterCompletion.updates.length, 1);
  assert.equal(afterCompletion.updates[0]?.recordId, "rec_original");
  assert.deepEqual(afterCompletion.updates[0]?.fieldValues.find((field) => field.field === "是否付费")?.option_value,
    { items: [{ text: "是" }] });
});

test("requires an exact readback for every current source row", () => {
  const source = row("LP-1");
  assert.doesNotThrow(() => assertTencentTrialLedgerReadback({
    assignments: [{ row: source, recordId: "rec_1" }],
    records: [target("rec_1", source)],
  }));
  assert.throws(() => assertTencentTrialLedgerReadback({
    assignments: [{ row: source, recordId: "rec_1" }],
    records: [],
  }), /readback_incomplete/);
  assert.throws(() => assertTencentTrialLedgerReadback({
    assignments: [{ row: source, recordId: "rec_1" }],
    records: [target("rec_1", row("LP-OTHER"))],
  }), /readback_mismatch/);
});
