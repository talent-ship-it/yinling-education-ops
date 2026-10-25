import assert from "node:assert/strict";
import test from "node:test";
import {
  completeTrialTaskWithHandbookFollowUps,
  generateJiaowubaoTrialTasks,
  generateTrialManualRequestTasks,
  matchTrialScheduleEvents,
  reopenTrialTaskWithHandbookFollowUps,
  replaceRuleTasks,
  TRIAL_JWB_REQUEST_FOLLOW_UP_RULE,
  TRIAL_JWB_SCHEDULE_RULE_KEYS,
  type TrialIntake,
} from "../lib/trial-operations";
import type { OpsTask } from "../lib/ops-tasks";
import { prepareJiaowubaoTrialSyncProjection } from "../lib/jiaowubao-trial-sync-projection";
import type { OpsStateRow } from "../lib/ops-store";

const intake: TrialIntake = {
  planner: "Tara", requestSentAt: "2026-10-20T02:15:00.000Z", contactParents: true,
  contactStudent: false, writingRequired: true, paperRequired: true,
  studentName: "Synthetic Child", trialDurationMinutes: 60,
};
const fields = { specifiedContentStatus: "需要跟进", writingRequired: true, paperRequired: true, preparationFollowUp: "是", trialPaymentMethod: "免费试听" };
const lp = { id: "LP-FOLLOW", studentId: "S-FOLLOW", workflowType: "试听 LP", stage: "待跟进", requestedAt: intake.requestSentAt, trialIntake: intake, fields };
const student = { id: lp.studentId, name: "Synthetic Child", owner: "Ella", planner: "Tara" };
const event = { eventId: "evt-follow", startsAt: "2026-10-28T04:00:00.000Z", endsAt: "2026-10-28T05:00:00.000Z", courseName: "Synthetic Child试听", teacherId: null, teacherName: "Synthetic Teacher", visibleStudentIds: [student.id], trialPlannerHint: "Tara" as const };
const now = "2026-10-26T02:00:00.000Z";
const actions = () => generateTrialManualRequestTasks({ lpItemId: lp.id, studentId: student.id, studentName: student.name, guardianWechat: "Synthetic Parent", owner: student.owner, specifiedContentStatus: fields.specifiedContentStatus, intake, now });
const match = () => matchTrialScheduleEvents({ lpItems: [lp], students: [student], teachers: [], events: [event], matchedAt: now })[0]!;
const generated = (currentTasks: readonly OpsTask[] = actions()) => generateJiaowubaoTrialTasks({ ...match(), currentTasks, now });
const review = (tasks: readonly OpsTask[]) => tasks.find((task) => task.ruleKey === TRIAL_JWB_REQUEST_FOLLOW_UP_RULE);
const finalize = (tasks: readonly OpsTask[]) => tasks.filter((task) => /lp-finalize-tomorrow-n3|lp-materials-n2/.test(task.ruleKey ?? ""));

function rows(tasks: readonly OpsTask[], source = lp): OpsStateRow[] {
  return [ ["students", [student]], ["teachers", []], ["bookings", []], ["lpItems", [source]], ["tasks", tasks] ].map(([entity, payload]) => ({ entity: entity as string, payload, version: 1, updated_at: now, updated_by: "fixture" }));
}

function project(tasks: readonly OpsTask[], source = lp, sourceEvent = event) {
  return prepareJiaowubaoTrialSyncProjection({ rows: rows(tasks, source), rawEvents: [{ ...sourceEvent, sourceDate: "2026-10-28", sourceTeacherId: null, sourceTeacherLabel: event.teacherName, sourceParticipants: [{ memberId: null, label: student.name }, { memberId: null, label: "试听学员A" }], sourceStudentsTruncated: false }], snapshotRevision: `sha256:${"a".repeat(64)}`, matchedAt: now });
}

test("N-3 follow-up retains an expired Melbourne deadline and the exact original request instant", () => {
  const task = review(generated())!;
  assert.equal(task.title, "《教务+教统》【跟进二要一发】<Synthetic Child> <Synthetic Teacher>");
  assert.equal(task.dueAt, "2026-10-25T07:00:00.000Z");
  assert.equal(task.status, "overdue");
  assert.equal(match().requestSentAt, intake.requestSentAt);
  assert.equal(actions().find((task) => task.ruleKey === "trial.scheduling")?.dueAt, "2026-10-21T02:15:00.000Z");
});

test("explicit no-follow-up fields suppress N-3 even if an obsolete source action remains open", () => {
  const source = { ...lp, fields: { ...fields, specifiedContentStatus: "不需要跟进", writingRequired: false, paperRequired: false } };
  const matched = matchTrialScheduleEvents({ lpItems: [source], students: [student], teachers: [], events: [event], matchedAt: now })[0]!;
  assert.equal(review(generateJiaowubaoTrialTasks({ ...matched, currentTasks: actions(), now })), undefined);
});

test("all required actions completed suppress review while cannot-do and another LP cannot satisfy it", () => {
  const done = actions().map((task) => ({ ...task, status: "done" as const }));
  assert.equal(review(generated(done)), undefined);
  assert.ok(review(generated(done.map((task) => ({ ...task, anchorBookingId: "LP-OTHER" })))));
  assert.ok(review(generated(done.map((task) => task.ruleKey?.endsWith("writing") ? { ...task, completionOutcome: "cannot_do" as const } : task))));
});

test("finishing the last requested action closes review without mutating prior state; undo reopens it", () => {
  let current = actions().concat(generated());
  const sourceActions = current.filter((task) => /specified-content|writing|paper-send/.test(task.ruleKey ?? ""));
  const original = current;
  const initial = JSON.stringify(original);
  for (const task of sourceActions) current = completeTrialTaskWithHandbookFollowUps(current, { taskId: task.id, completedAt: now });
  assert.equal(review(current)?.status, "done");
  assert.equal(JSON.stringify(original), initial);
  const source = sourceActions.find((task) => task.ruleKey?.endsWith("paper-send"))!;
  const reopened = reopenTrialTaskWithHandbookFollowUps(current, { taskId: source.id, reopenedAt: now, timeZone: "Asia/Shanghai" });
  assert.equal(review(reopened)?.id, review(current)?.id);
  assert.equal(review(reopened)?.status, "overdue");
  assert.equal(reopened.some((task) => task.ruleKey?.endsWith("paper-receive")), false);
});

test("an operator-completed review remains completed when a source action is undone", () => {
  const done = actions().map((task) => ({ ...task, status: "done" as const }));
  const manualReview = { ...review(generated())!, status: "done" as const, result: "人工确认完成" };
  const reopened = reopenTrialTaskWithHandbookFollowUps(done.concat(manualReview), { taskId: done[0]!.id, reopenedAt: now, timeZone: "Asia/Shanghai" });
  assert.equal(review(reopened)?.result, "人工确认完成");
  assert.equal(review(reopened)?.status, "done");
});

for (const startsAt of ["2026-10-20T04:00:00.000Z", "2026-10-21T04:00:00.000Z", "2026-10-22T04:00:00.000Z"]) {
  test(`short-notice review compresses onto intake day for ${startsAt}`, () => {
    const task = review(generateJiaowubaoTrialTasks({ ...match(), link: { ...match().link, startsAt }, currentTasks: actions(), now }))!;
    assert.equal(task.dueAt, startsAt.startsWith("2026-10-20") ? startsAt : "2026-10-20T07:00:00.000Z");
  });
}

test("repeat projections remain deterministic and changed lesson time moves the review once", () => {
  const first = project(actions());
  const again = project(first.nextTasks);
  assert.deepEqual(again.nextTasks, first.nextTasks);
  const moved = project(first.nextTasks, lp, { ...event, startsAt: "2026-10-29T04:00:00.000Z", endsAt: "2026-10-29T05:00:00.000Z" });
  assert.equal(review(moved.nextTasks)?.id, review(first.nextTasks)?.id);
  assert.equal(review(moved.nextTasks)?.dueAt, "2026-10-26T07:00:00.000Z");
  assert.equal(moved.nextTasks.filter((task) => task.ruleKey === TRIAL_JWB_REQUEST_FOLLOW_UP_RULE).length, 1);
});

test("LP finalized closes both applicable reminders; uncheck preserves manual completion and notes", () => {
  const open = generated();
  const closed = generateJiaowubaoTrialTasks({ ...match(), trialLpFinalized: true, now });
  const saved = replaceRuleTasks(open, closed, { anchor: "JWB:evt-follow", ruleKeys: TRIAL_JWB_SCHEDULE_RULE_KEYS });
  assert.equal(finalize(saved).length, 2);
  assert.ok(finalize(saved).every((task) => task.status === "done"));
  const withManual = saved.map((task) => task.ruleKey?.endsWith("lp-materials-n2") ? { ...task, result: "人工确认完成" } : { ...task, completionNote: "保留备注" });
  const reopened = replaceRuleTasks(withManual, open, { anchor: "JWB:evt-follow", ruleKeys: TRIAL_JWB_SCHEDULE_RULE_KEYS });
  assert.equal(finalize(reopened).find((task) => task.ruleKey?.endsWith("lp-materials-n2"))?.result, "人工确认完成");
  const automatic = finalize(reopened).find((task) => task.ruleKey?.endsWith("lp-finalize-tomorrow-n3"))!;
  assert.notEqual(automatic.status, "done");
  assert.equal(automatic.completionNote, "保留备注");
  assert.equal(automatic.id, finalize(saved)[0]!.id);
  const frozen = { ...finalize(saved)[0]!, legacyEvidence: { state: "frozen" as const, reason: "missing_canonical_due_at" as const, frozenAt: now } };
  assert.equal(replaceRuleTasks([frozen], open, { anchor: "JWB:evt-follow", ruleKeys: TRIAL_JWB_SCHEDULE_RULE_KEYS }).find((task) => task.id === frozen.id)?.status, "done");
});

test("a valid ledger planner override wins over intake and roster without resetting the request clock", () => {
  const result = matchTrialScheduleEvents({ lpItems: [{ ...lp, trialLedgerOverrides: { planner: "Eileen" } }], students: [student], teachers: [], events: [{ ...event, visibleStudentIds: [], trialPlannerHint: "Eileen" }], matchedAt: now });
  assert.equal(result[0]?.planner, "Eileen");
  assert.equal(result[0]?.requestSentAt, intake.requestSentAt);
});

test("terminal trial results do not match or materialize new source reminders", () => {
  for (const resultStatus of ["已取消", "被家长取消"]) {
    const source = { ...lp, resultStatus };
    assert.deepEqual(matchTrialScheduleEvents({ lpItems: [source], students: [student], teachers: [], events: [event], matchedAt: now }), []);
    assert.deepEqual(project(actions(), source).references, []);
    const closed = { ...actions()[0]!, status: "done" as const, result: "关联试听已取消" };
    assert.deepEqual(reopenTrialTaskWithHandbookFollowUps([closed], { taskId: closed.id, reopenedAt: now, timeZone: "Asia/Shanghai" }), [closed]);
  }
});

test("missing required action evidence cannot prematurely close the N-3 review", () => {
  const onlyWriting = actions().filter((task) => task.ruleKey?.endsWith("writing"));
  const current = onlyWriting.concat(generated(onlyWriting));
  const next = completeTrialTaskWithHandbookFollowUps(current, { taskId: onlyWriting[0]!.id, completedAt: now });
  assert.equal(review(next)?.status, "overdue");
  assert.deepEqual(review(next)?.trialRequestFollowUpRules, match().requestFollowUpRules);
});


test("NIL and delayed trial results retain scheduling rather than implying cancellation", () => {
  for (const resultStatus of ["NIL", "延迟待安排"]) {
    const source = { ...lp, resultStatus };
    const matched = matchTrialScheduleEvents({ lpItems: [source], students: [student], teachers: [], events: [event], matchedAt: now });
    assert.equal(matched.length, 1);
    assert.equal(matched[0]?.requestSentAt, intake.requestSentAt);
    assert.equal(project(actions(), source).references.length, 1);
  }
});


test("restored automatic LP reminders follow a changed date and teacher while preserving notes and identities", () => {
  const saved = generateJiaowubaoTrialTasks({ ...match(), trialLpFinalized: true, currentTasks: actions(), now })
    .map((task) => ({ ...task, completionNote: "保留手写备注", completionNoteUpdatedAt: now }));
  const moved = { ...match(), link: { ...match().link, startsAt: "2026-10-29T04:00:00.000Z", endsAt: "2026-10-29T05:00:00.000Z", teacherName: "Synthetic Restored Teacher" } };
  const next = replaceRuleTasks(saved, generateJiaowubaoTrialTasks({ ...moved, trialLpFinalized: false, currentTasks: actions(), now }), { anchor: "JWB:evt-follow", ruleKeys: TRIAL_JWB_SCHEDULE_RULE_KEYS });
  assert.deepEqual(finalize(next).map((task) => task.id), finalize(saved).map((task) => task.id));
  assert.deepEqual(finalize(next).map((task) => task.dueAt), ["2026-10-26T07:00:00.000Z", "2026-10-27T07:00:00.000Z"]);
  for (const task of finalize(next)) {
    assert.notEqual(task.status, "done");
    assert.match(task.title, /Synthetic Restored Teacher/u);
    assert.equal(task.completionNote, "保留手写备注");
    assert.equal(task.completionNoteUpdatedAt, now);
    assert.equal(task.result, undefined);
    assert.equal(task.closedAt, undefined);
  }
});
