import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");

test("preserves the handbook review columns and adds readonly Jiaowubao schedule metadata", () => {
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
    "业务结果",
    "是否付费",
    "备注",
    "教务宝小课表",
    "LP 已定稿",
  ]);
});

test("keeps persisted ledger fields editable through the dedicated atomic route", () => {
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
    "lpFinalized",
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

test("offers actor-scoped filters, sortable numeric dates, continuous rows and live review statistics", () => {
  const panelStart = client.indexOf('<section className="panel trial-ledger-panel"');
  const panelEnd = client.indexOf('<section className="panel collection-shell"', panelStart);
  const panel = client.slice(panelStart, panelEnd);

  assert.match(client, /trialLedgerViewStorageKey\(sessionOperator\)/);
  assert.match(client, /parseTrialLedgerViewState/);
  assert.match(client, /filterAndSortTrialLedgerRows/);
  assert.match(panel, /上课日期从/);
  assert.match(panel, /上课日期至/);
  assert.match(panel, /全部教务/);
  assert.match(panel, /全部规划老师/);
  assert.match(panel, /全部科目/);
  assert.match(panel, /全部老师/);
  assert.match(panel, /排序字段/);
  assert.match(panel, /visibleTrialLedgerEntries\.map/);
  assert.doesNotMatch(panel, /\.slice\(/);
  assert.match(panel, /trialLedgerStats\.byStatus/);
  assert.match(panel, /成功率只计算已明确为成功或失败的试听/);
  assert.match(panel, /筛选只保存在当前登录账号，不影响其他人/);
});
