import assert from "node:assert/strict";
import test from "node:test";

import { LP_WORKFLOW_TYPES } from "../lib/lp-workflows";

import {
  defaultTrialLedgerViewState,
  filterAndSortTrialLedgerRows,
  parseTrialLedgerViewState,
  trialLedgerViewFilterOptions,
  trialLedgerViewHasFilters,
  trialLedgerViewStats,
  trialLedgerViewStorageKey,
  trialLedgerRequestTime,
  trialFollowUpStatus,
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

test("reads explicit handover fields before the legacy request timestamp and preserves missing dates", () => {
  const fields = { requestSentAt: "2026-10-24T02:00:00.000Z" };
  assert.equal(trialLedgerRequestTime({ fields, requestedAt: "2026-10-27T02:00:00.000Z" }), fields.requestSentAt);
  assert.equal(trialLedgerRequestTime({ fields, trialIntake: { requestSentAt: "2026-10-24T01:00:00.000Z" } }), "2026-10-24T01:00:00.000Z");
  assert.equal(trialLedgerRequestTime({ requestedAt: "2026-10-24T03:00:00.000Z" }), "2026-10-24T03:00:00.000Z");
  assert.equal(trialLedgerRequestTime({ fields: { requestSentAt: "invalid" } }), "");
  assert.equal(trialLedgerRequestTime({}), "");
});

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

test("restores and filters cancelled and NIL statuses without changing resolved trial rates", () => {
  const added = ["被家长取消", "NIL"].map((resultStatus, index) => ({
    ...rows[0]!, id: `LP-NEW-${index}`, resultStatus,
  }));
  const source = [...rows, ...added];
  for (const row of added) {
    const state = parseTrialLedgerViewState(JSON.stringify({
      ...defaultTrialLedgerViewState(), resultStatus: row.resultStatus,
    }));
    assert.equal(state.resultStatus, row.resultStatus);
    assert.deepEqual(filterAndSortTrialLedgerRows(source, state), [row]);
  }
  const stats = trialLedgerViewStats(source);
  assert.equal(stats.total, 5);
  assert.equal(stats.byStatus["被家长取消"], 1);
  assert.equal(stats.byStatus.NIL, 1);
  assert.equal(stats.resolved, 2);
  assert.equal(stats.successRate, 50);
});

test("filters every handover workflow type and restores non-trial business outcomes", () => {
  const source = LP_WORKFLOW_TYPES.map((workflowType, index) => ({
    ...rows[0]!, id: `LP-TYPE-${index}`, workflowType,
    resultStatus: workflowType === "试听 LP" || workflowType === "换老师试听" ? "试听成功" : "已完成",
  }));
  for (const row of source) {
    const state = parseTrialLedgerViewState(JSON.stringify({ ...defaultTrialLedgerViewState(), workflowType: row.workflowType }));
    assert.deepEqual(filterAndSortTrialLedgerRows(source, state), [row]);
  }
  for (const resultStatus of ["已完成", "已取消"]) {
    assert.equal(parseTrialLedgerViewState({ resultStatus }).resultStatus, resultStatus);
  }
  const completed = filterAndSortTrialLedgerRows(source, { ...defaultTrialLedgerViewState(), resultStatus: "已完成" });
  assert.equal(completed.length, 5);
  assert.ok(completed.every((row) => row.resultStatus === "已完成"));
});

test("non-trial handovers never count as unpaid trials or affect trial success rates", () => {
  const handovers = [
    { ...rows[0]!, id: "LP-NEW", workflowType: "老师新 LP", resultStatus: "已完成", paid: false },
    { ...rows[0]!, id: "LP-LEGACY", workflowType: "代课 LP", resultStatus: "试听成功", paid: false },
  ];
  const source = [...rows, ...handovers];
  assert.deepEqual(filterAndSortTrialLedgerRows(source, { ...defaultTrialLedgerViewState(), paid: "unpaid" }).map((row) => row.id), ["LP-3", "LP-2"]);
  const stats = trialLedgerViewStats(source);
  assert.equal(stats.total, 5);
  assert.equal(stats.byStatus["已完成"], 1);
  assert.equal(stats.successful, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.successRate, 50);
  assert.equal(trialLedgerViewStats(handovers).successRate, null);
});


test("filters authoritative schedule matches independently of manually entered times", () => {
  const source = [
    { ...rows[0]!, scheduleMatched: false },
    { ...rows[1]!, scheduleMatched: true },
    { ...rows[2]!, scheduleMatched: false },
  ];
  const state = defaultTrialLedgerViewState();
  assert.deepEqual(filterAndSortTrialLedgerRows(source, { ...state, scheduleMatch: "matched" }).map((row) => row.id), ["LP-2"]);
  assert.deepEqual(filterAndSortTrialLedgerRows(source, { ...state, scheduleMatch: "unmatched" }).map((row) => row.id), ["LP-3", "LP-1"]);
});

test("filters exact Beijing request minutes, including the selected ending minute", () => {
  const source = [
    { ...rows[0]!, id: "before", requestedAt: "2026-10-24T01:59:59.999Z" },
    { ...rows[0]!, id: "inside", requestedAt: "2026-10-24T02:00:00.000Z" },
    { ...rows[0]!, id: "last", requestedAt: "2026-10-24T02:30:59.999Z" },
    { ...rows[0]!, id: "after", requestedAt: "2026-10-24T02:31:00.000Z" },
    { ...rows[0]!, id: "missing", requestedAt: "" },
  ];
  assert.deepEqual(filterAndSortTrialLedgerRows(source, {
    ...defaultTrialLedgerViewState(), requestedFrom: "2026-10-24T10:00", requestedTo: "2026-10-24T10:30",
  }).map((row) => row.id), ["last", "inside"]);
  assert.equal(parseTrialLedgerViewState({ requestedFrom: "2026-02-30T10:00" }).requestedFrom, "");
});

test("combines handover text and follow-up states without misclassifying missing intake", () => {
  const source = [
    { ...rows[0]!, parentFollowUp: "required" as const, preparationFollowUp: "completed" as const, handoverText: "Synthetic algebra confidence" },
    { ...rows[1]!, parentFollowUp: "not_required" as const, preparationFollowUp: "not_required" as const },
    { ...rows[2]!, parentFollowUp: "unknown" as const, preparationFollowUp: "unknown" as const },
  ];
  assert.deepEqual(filterAndSortTrialLedgerRows(source, {
    ...defaultTrialLedgerViewState(), query: "algebra", parentFollowUp: "required", preparationFollowUp: "completed",
  }).map((row) => row.id), ["LP-1"]);
  assert.deepEqual(filterAndSortTrialLedgerRows(source, { ...defaultTrialLedgerViewState(), parentFollowUp: "not_required" }).map((row) => row.id), ["LP-2"]);
});

test("derives follow-up completion from every required action on the same request", () => {
  const task = (id: string, ruleKey: string, status = "done", anchorBookingId = "LP-1") => ({
    id, title: id, ruleKey, status, anchorBookingId, owner: "Ella", studentId: "STU-1", due: "", tone: "blue", category: "LP", trigger: "",
  } as import("../lib/ops-tasks").OpsTask);
  const input = { lpItemId: "LP-1", required: true, ruleKeys: ["send", "receive"] };
  assert.equal(trialFollowUpStatus({ ...input, tasks: [task("send", "send")] }), "required");
  assert.equal(trialFollowUpStatus({ ...input, tasks: [task("send", "send"), task("other", "receive", "done", "LP-2")] }), "required");
  const tasks = [task("send", "send"), task("receive", "receive")];
  assert.equal(trialFollowUpStatus({ ...input, tasks }), "completed");
  assert.equal(trialFollowUpStatus({ ...input, tasks: [tasks[0]!, { ...tasks[1]!, completionOutcome: "cannot_do" }] }), "required");
  assert.equal(trialFollowUpStatus({ ...input, tasks: [tasks[0]!, { ...tasks[1]!, status: "today" }] }), "required");
  assert.equal(trialFollowUpStatus({ ...input, required: false, tasks: [] }), "not_required");
  assert.equal(trialFollowUpStatus({ ...input, required: undefined, tasks: [] }), "unknown");
  assert.equal(trialFollowUpStatus({ ...input, tasks: tasks.map((task) => ({ ...task, anchorBookingId: "JWB:event", requestAnchorBookingId: "LP-1" })) }), "completed");
});
