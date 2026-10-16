import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultTrialLedgerViewState,
  filterAndSortTrialLedgerRows,
  parseTrialLedgerViewState,
  trialLedgerViewFilterOptions,
  trialLedgerViewHasFilters,
  trialLedgerViewStats,
  trialLedgerViewStorageKey,
  type TrialLedgerViewRow,
} from "../lib/trial-ledger-view";

const rows: TrialLedgerViewRow[] = [{
  id: "LP-1",
  studentName: "Alice陈一",
  guardianWechat: "Parent One",
  workflowType: "试听 LP",
  lessonMonth: "2026-08",
  requestedAt: "2026-08-01T00:00:00.000Z",
  scheduledAt: "2026-08-05T01:00:00.000Z",
  scheduledDate: "2026-08-05",
  operationsOwner: "Ella",
  planner: "Eileen",
  subject: "English",
  teacher: "Grace Lin",
  resultStatus: "试听成功",
  paid: true,
  note: "priority",
}, {
  id: "LP-2",
  studentName: "Bella王二",
  guardianWechat: "Parent Two",
  workflowType: "换老师试听",
  lessonMonth: "2026-07",
  requestedAt: "2026-07-01T00:00:00.000Z",
  scheduledAt: "2026-07-07T02:00:00.000Z",
  scheduledDate: "2026-07-07",
  operationsOwner: "Tiffany",
  planner: "Tara",
  subject: "Mathematics",
  teacher: "Zara Baker",
  resultStatus: "试听失败",
  paid: false,
  note: "follow up",
}, {
  id: "LP-3",
  studentName: "Cara赵三",
  guardianWechat: "Parent Three",
  workflowType: "试听 LP",
  lessonMonth: "",
  requestedAt: "2026-08-03T00:00:00.000Z",
  scheduledAt: "",
  scheduledDate: "",
  operationsOwner: "Ella",
  planner: "Eileen",
  subject: "English",
  teacher: "",
  resultStatus: "有希望报名",
  paid: false,
  note: "waiting schedule",
}];

test("keeps trial ledger browser filters actor-scoped and rejects malformed storage", () => {
  assert.notEqual(trialLedgerViewStorageKey("Ella"), trialLedgerViewStorageKey("Tiffany"));
  assert.equal(trialLedgerViewStorageKey(" ELLA "), trialLedgerViewStorageKey("ella"));
  assert.deepEqual(parseTrialLedgerViewState("not-json"), defaultTrialLedgerViewState());
  assert.equal(parseTrialLedgerViewState({ query: "alice " }).query, "alice ");
  assert.deepEqual(parseTrialLedgerViewState({
    ...defaultTrialLedgerViewState(),
    scheduledFrom: "2026-02-30",
    lessonMonth: "2026-13",
    sortKey: "unsafe",
  }), defaultTrialLedgerViewState());
});

test("combines text, ownership, planner, month, status, paid and date-range filters", () => {
  const filtered = filterAndSortTrialLedgerRows(rows, {
    ...defaultTrialLedgerViewState(),
    query: "alice priority",
    workflowType: "试听 LP",
    lessonMonth: "2026-08",
    scheduledFrom: "2026-08-01",
    scheduledTo: "2026-08-31",
    operationsOwner: "Ella",
    planner: "Eileen",
    subject: "English",
    teacher: "Grace Lin",
    resultStatus: "试听成功",
    paid: "paid",
  });
  assert.deepEqual(filtered.map((row) => row.id), ["LP-1"]);
  assert.equal(trialLedgerViewHasFilters({ ...defaultTrialLedgerViewState(), planner: "Eileen" }), true);
  assert.equal(trialLedgerViewHasFilters({ ...defaultTrialLedgerViewState(), query: "   " }), false);
  assert.equal(trialLedgerViewHasFilters({ ...defaultTrialLedgerViewState(), sortDirection: "asc" }), false);
});

test("sorts dates and names deterministically while leaving unscheduled rows last", () => {
  assert.deepEqual(filterAndSortTrialLedgerRows(rows, {
    ...defaultTrialLedgerViewState(),
    sortKey: "scheduledAt",
    sortDirection: "asc",
  }).map((row) => row.id), ["LP-2", "LP-1", "LP-3"]);
  assert.deepEqual(filterAndSortTrialLedgerRows(rows, {
    ...defaultTrialLedgerViewState(),
    sortKey: "studentName",
    sortDirection: "desc",
  }).map((row) => row.id), ["LP-3", "LP-2", "LP-1"]);
});

test("reports every filtered status and calculates success rate only from resolved trials", () => {
  const stats = trialLedgerViewStats([...rows, { ...rows[0]!, id: "LP-4", resultStatus: "在读试听成功" }]);
  assert.equal(stats.total, 4);
  assert.equal(stats.successful, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.resolved, 3);
  assert.equal(stats.successRate, 66.7);
  assert.equal(stats.byStatus["有希望报名"], 1);
  assert.equal(stats.byStatus["试听未进行"], 0);
});

test("trial operations filters remain complete with no or partial ledger records", () => {
  const state = defaultTrialLedgerViewState();
  const staff = ["Abby", "Ella", "Erin", "Molly", "Thea", "Tiffany"];
  assert.deepEqual(trialLedgerViewFilterOptions([], state, "operationsOwner"), staff);
  const savedAlias = parseTrialLedgerViewState({ ...state, operationsOwner: "ELLA 教务" });
  assert.equal(savedAlias.operationsOwner, "Ella");
  assert.ok(trialLedgerViewFilterOptions([], savedAlias, "operationsOwner").includes(savedAlias.operationsOwner));
  assert.deepEqual(trialLedgerViewFilterOptions(rows, state, "operationsOwner"), staff);
  assert.deepEqual(trialLedgerViewFilterOptions([], state, "planner"), ["Abby", "Eileen", "Tara龙"]);
  assert.deepEqual(trialLedgerViewFilterOptions(rows, state, "planner"), ["Abby", "Eileen", "Tara龙"]);
  assert.ok(trialLedgerViewFilterOptions([], { ...state, operationsOwner: "Nixon" }, "operationsOwner").includes("Nixon"));
  assert.equal(filterAndSortTrialLedgerRows(rows, { ...state, operationsOwner: "Molly" }).length, 0);
  const alias = { ...rows[0]!, operationsOwner: "ELLA 教务" };
  const historic = { ...rows[0]!, id: "LP-OLD", operationsOwner: "Nixon" };
  assert.deepEqual(filterAndSortTrialLedgerRows([alias, historic], { ...state, operationsOwner: "Ella" }), [alias]);
  assert.deepEqual(filterAndSortTrialLedgerRows([alias, historic], { ...state, operationsOwner: "Nixon" }), [historic]);
});

test("removes the duplicate Tara option while retaining Tara龙 and both names’ records", () => {
  const state = defaultTrialLedgerViewState();
  const canonical = { ...rows[0]!, id: "LP-TARA", planner: "Tara" };
  const legacy = { ...rows[0]!, id: "LP-TARA-OLD", planner: " Tara龙 " };
  const other = { ...rows[0]!, id: "LP-OTHER", planner: "Other Planner" };
  const source = [canonical, legacy, other];
  const original = structuredClone(source);
  assert.deepEqual(trialLedgerViewFilterOptions(source, state, "planner"), ["Abby", "Eileen", "Other Planner", "Tara龙"]);
  for (const planner of ["Tara", "Tara龙"]) {
    const filtered = filterAndSortTrialLedgerRows(source, { ...state, planner });
    assert.equal(filtered.length, 2);
    assert.ok(filtered.includes(canonical));
    assert.ok(filtered.includes(legacy));
    assert.ok(!filtered.includes(other));
    const restored = parseTrialLedgerViewState(JSON.stringify({ ...state, planner }));
    assert.equal(restored.planner, "Tara龙");
    assert.deepEqual(trialLedgerViewFilterOptions([], restored, "planner"), ["Abby", "Eileen", "Tara龙"]);
    assert.deepEqual(trialLedgerViewFilterOptions([legacy], { ...state, planner }, "planner"), ["Abby", "Eileen", "Tara龙"]);
  }
  assert.deepEqual(filterAndSortTrialLedgerRows(source, { ...state, planner: "Other Planner" }), [other]);
  assert.equal(filterAndSortTrialLedgerRows(source, state).length, source.length);
  assert.deepEqual(source, original);
});
