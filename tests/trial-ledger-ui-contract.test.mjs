import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");

test("shows the handbook's 14 review columns with Melbourne date and time separated", () => {
  const header = client.match(/<table className="trial-ledger-table">[\s\S]*?<thead><tr>([\s\S]*?)<\/tr><\/thead>/)?.[1] ?? "";
  const labels = [...header.matchAll(/<th(?:\s[^>]*)?>([^<]+)<\/th>/g)].map((match) => match[1]);

  assert.deepEqual(labels, [
    "学生姓名",
    "家长微信名",
    "LP 类型",
    "上课月份",
    "请求日期/时间",
    "上课日期",
    "上课时间（墨尔本）",
    "教务",
    "课程规划老师",
    "科目",
    "老师",
    "试听状态",
    "是否付费",
    "备注",
  ]);
});

test("keeps all 13 persisted ledger fields editable through the dedicated atomic route", () => {
  for (const field of [
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
    "trialLedgerNote",
  ]) {
    assert.match(client, new RegExp(`(?:field: "${field}"|saveTrialLedgerFieldAtomic\\((?:item|input\\.item), "${field}")`));
  }
  assert.match(client, /\/api\/operations\/trial-ledger/);
  assert.match(client, /ledgerSchedulePartCell/);
  assert.match(client, /part: "date"/);
  assert.match(client, /part: "time"/);
  assert.match(client, /zonedDateTimeToUtc\(date, time, "Australia\/Melbourne"\)/);
  assert.match(client, /恢复自动/);
  assert.match(client, /field-level|字段级|trialLedgerStoredValue/);
  assert.doesNotMatch(client, /const saveTrialLedgerField = .*lpShared\.mutateAndCommit/s);
});
