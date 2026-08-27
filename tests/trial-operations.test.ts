import assert from "node:assert/strict";
import test from "node:test";

import {
  TRIAL_JWB_RULE_PREFIX,
  TRIAL_MANUAL_REQUEST_RULE_PREFIX,
  generateJiaowubaoTrialTasks,
  generateTrialManualRequestTasks,
  matchTrialScheduleEvents,
  trialAtomicFields,
  trialIntakeFromFields,
  trialPlannerHintFromParticipants,
} from "../lib/trial-operations";
import type { LpFieldValues } from "../lib/lp-workflows";

const extendedFields = {
  responsibleOperations: "Ella",
  specifiedContentStatus: "需教务跟进",
  preparationFollowUp: "是",
  isUniversityStudent: false,
  assignedTeacher: "Grace Lin",
  subject: "English",
  oneSentenceDescription: "Year 9 writing trial",
  locationTimezone: "VIC",
  contactPerson: "家长",
  timeMentioned: false,
  studentNameKnown: true,
  trialPaymentMethod: "付费试听（未付费）",
  planner: "Tara",
  requestSentAt: "2026-08-28T02:00:00.000Z",
  contactParents: true,
  contactStudent: true,
  contactNote: "优先联系家长",
  writingRequired: true,
  writingNote: "短文",
  paperRequired: true,
  paperNote: "PDF",
  preparationNote: "检查课件",
  studentName: "Heather孙晓琳",
  trialDurationMinutes: 60,
  trialDurationNote: "标准试听",
} as const satisfies LpFieldValues;

test("separates the manual trial intake from the legacy atomic LP field contract", () => {
  const intake = trialIntakeFromFields(extendedFields);
  assert.equal(intake.planner, "Tara");
  assert.equal(intake.trialDurationMinutes, 60);
  assert.equal(intake.contactParents, true);
  assert.equal(intake.contactStudent, true);

  const atomic = trialAtomicFields(extendedFields);
  assert.equal(atomic.subject, "English");
  assert.equal(atomic.planner, undefined);
  assert.equal(atomic.requestSentAt, undefined);
  assert.equal(atomic.paperRequired, undefined);
});

test("maps only one unambiguous 教务宝 trial account to its planner", () => {
  assert.equal(trialPlannerHintFromParticipants([{ label: "试听学员A" }]), "Tara");
  assert.equal(trialPlannerHintFromParticipants([{ label: "trial student B" }]), "Eileen");
  assert.equal(trialPlannerHintFromParticipants([{ label: "试听账号C" }]), "Abby");
  assert.equal(trialPlannerHintFromParticipants([{ label: "试听学员A" }, { label: "试听学员B" }]), null);
  assert.equal(trialPlannerHintFromParticipants([{ label: "正式学员" }]), null);
});

test("matches a trial LP to real schedule evidence by full course-title name and planner hint", () => {
  const matches = matchTrialScheduleEvents({
    lpItems: [{ id: "LP-1", studentId: "STU-1", workflowType: "试听 LP", trialIntake: trialIntakeFromFields(extendedFields) }],
    students: [{ id: "STU-1", name: "Heather 孙晓琳", owner: "Ella", planner: "Tara" }],
    teachers: [{ id: "TEA-1", name: "Grace Lin" }],
    events: [{
      eventId: "evt-1",
      startsAt: "2026-08-30T03:00:00.000Z",
      endsAt: "2026-08-30T04:00:00.000Z",
      courseName: "English试听 Heather孙晓琳",
      teacherId: "TEA-1",
      visibleStudentIds: [],
      trialPlannerHint: "Tara",
    }],
    matchedAt: "2026-08-28T03:00:00.000Z",
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.link.teacherName, "Grace Lin");
  assert.equal(matches[0]?.link.plannerHint, "Tara");
  assert.equal(matches[0]?.link.source, "jiaowubao-open-api");
});

test("accepts the live browser Date used when matching a freshly loaded schedule", () => {
  const matchedAt = new Date("2026-08-28T03:00:00.000Z");
  const matches = matchTrialScheduleEvents({
    lpItems: [],
    students: [],
    teachers: [],
    events: [],
    matchedAt,
  });
  assert.deepEqual(matches, []);
});

test("materializes the handbook same-day, paper, 24h, 36h and 48h task chain", () => {
  const intake = trialIntakeFromFields(extendedFields);
  const tasks = generateTrialManualRequestTasks({
    lpItemId: "LP-1",
    studentId: "STU-1",
    studentName: "Heather孙晓琳",
    owner: "Ella",
    specifiedContentStatus: "需教务跟进",
    intake,
    now: "2026-08-28T02:00:00.000Z",
  });
  assert.equal(tasks.length, 7);
  assert.deepEqual(tasks.map((task) => task.ruleKey), [
    `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}specified-content`,
    `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}writing`,
    `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}paper-send`,
    `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}paper-receive`,
    `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}parent-progress-24h`,
    `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}scheduling-alert-36h`,
    `${TRIAL_MANUAL_REQUEST_RULE_PREFIX}parent-progress-48h`,
  ]);
  assert.equal(tasks.find((task) => task.ruleKey?.endsWith("paper-receive"))?.dueAt, "2026-08-29T02:00:00.000Z");
  assert.equal(tasks.find((task) => task.ruleKey?.endsWith("scheduling-alert-36h"))?.dueAt, "2026-08-29T14:00:00.000Z");
  assert.ok(tasks.every((task) => task.watchers?.includes("Ops Admin")));
});

test("materializes N-2, N-1, payment and same-day tasks from one real 教务宝 event", () => {
  const match = matchTrialScheduleEvents({
    lpItems: [{ id: "LP-1", studentId: "STU-1", workflowType: "试听 LP", trialIntake: trialIntakeFromFields(extendedFields) }],
    students: [{ id: "STU-1", name: "Heather孙晓琳", owner: "Ella", planner: "Tara" }],
    teachers: [{ id: "TEA-1", name: "Grace Lin" }],
    events: [{ eventId: "evt-1", startsAt: "2026-09-03T08:00:00.000Z", endsAt: "2026-09-03T09:00:00.000Z", courseName: "Heather孙晓琳", teacherId: "TEA-1", visibleStudentIds: [], trialPlannerHint: "Tara" }],
    matchedAt: "2026-08-28T03:00:00.000Z",
  })[0]!;
  const tasks = generateJiaowubaoTrialTasks({ ...match, now: "2026-08-28T03:00:00.000Z" });
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every((task) => task.ruleKey?.startsWith(TRIAL_JWB_RULE_PREFIX)));
  assert.ok(tasks.some((task) => task.title.includes("今日试听") && task.title.includes("Grace Lin")));
  assert.ok(tasks.some((task) => task.title.includes("收取试听费") && task.owner === "Tara"));
});
