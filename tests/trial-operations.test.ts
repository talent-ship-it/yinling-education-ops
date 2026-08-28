import assert from "node:assert/strict";
import test from "node:test";

import {
  TRIAL_JWB_RULE_PREFIX,
  TRIAL_MANUAL_REQUEST_RULE_PREFIX,
  completeTrialSchedulingReminderTasks,
  generateJiaowubaoTrialTasks,
  generateTrialManualRequestTasks,
  matchTrialScheduleEvents,
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

test("normalizes the complete manual trial intake for atomic persistence", () => {
  const intake = trialIntakeFromFields(extendedFields);
  assert.equal(intake.planner, "Tara");
  assert.equal(intake.trialDurationMinutes, 60);
  assert.equal(intake.contactParents, true);
  assert.equal(intake.contactStudent, true);
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
    guardianWechat: "Daisy",
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
  assert.deepEqual(tasks.map((task) => task.title), [
    "《教务+教统》【要指定内容】<Heather孙晓琳> <Daisy>",
    "《教务+教统》【要写作】<Heather孙晓琳> <Daisy>",
    "《教务+教统》【发试卷】<Heather孙晓琳> <Daisy>",
    "《教务+教统》【收试卷】<Heather孙晓琳> <Daisy>",
    "《教务+教统》【向家长交待排课进度】<Heather孙晓琳> <Daisy>",
    "《教务+教统》【试听排课进度反常】<Heather孙晓琳> <Daisy>",
    "《教务+教统》【二次向家长交待排课进度】<Heather孙晓琳> <Daisy>",
  ]);
  assert.ok(tasks.every((task) => task.watchers?.includes("Ops Admin")));
});

test("closes all 24h, 36h and 48h scheduling reminders after one real 教务宝 match", () => {
  const manualTasks = generateTrialManualRequestTasks({
    lpItemId: "LP-1",
    studentId: "STU-1",
    studentName: "QA Trial Student",
    guardianWechat: "QA Guardian",
    owner: "Ella",
    specifiedContentStatus: "需教务跟进",
    intake: trialIntakeFromFields(extendedFields),
    now: "2026-08-28T02:00:00.000Z",
  });
  const alreadyDone = {
    ...manualTasks.find((task) => task.ruleKey?.endsWith("parent-progress-24h"))!,
    id: "TASK-ALREADY-DONE",
    status: "done" as const,
    result: "人工确认已完成",
  };
  const frozen = {
    ...manualTasks.find((task) => task.ruleKey?.endsWith("parent-progress-48h"))!,
    id: "TASK-FROZEN",
    legacyEvidence: {
      state: "frozen" as const,
      reason: "missing_canonical_due_at" as const,
      frozenAt: "2026-08-28T02:30:00.000Z",
    },
  };
  const foreign = {
    ...manualTasks.find((task) => task.ruleKey?.endsWith("scheduling-alert-36h"))!,
    id: "TASK-FOREIGN",
    anchorBookingId: "LP-2",
  };
  const current = manualTasks.concat(alreadyDone, frozen, foreign);

  const completed = completeTrialSchedulingReminderTasks(current, {
    lpItemId: "LP-1",
    eventId: "evt-qa-1",
    completedAt: "2026-08-28T04:00:00.000Z",
  });
  const reminderIds = new Set(manualTasks.filter((task) => task.anchorBookingId === "LP-1"
    && ["parent-progress-24h", "scheduling-alert-36h", "parent-progress-48h"]
      .some((suffix) => task.ruleKey?.endsWith(suffix))).map((task) => task.id));
  const scheduling = completed.filter((task) => reminderIds.has(task.id));

  assert.equal(scheduling.length, 3);
  assert.ok(scheduling.every((task) => task.status === "done"
    && task.tone === "green"
    && task.result === "教务宝真实排课已匹配：evt-qa-1"
    && task.closedAt === "2026-08-28T04:00:00.000Z"));
  assert.equal(completed.find((task) => task.id === alreadyDone.id)?.result, "人工确认已完成");
  assert.equal(completed.find((task) => task.id === frozen.id)?.status, frozen.status);
  assert.deepEqual(completed.find((task) => task.id === frozen.id)?.legacyEvidence, frozen.legacyEvidence);
  assert.notEqual(completed.find((task) => task.ruleKey?.endsWith("paper-receive"))?.status, "done");
  assert.equal(completed.find((task) => task.id === foreign.id)?.status, foreign.status);
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
  assert.equal(tasks.find((task) => task.ruleKey?.endsWith("lp-materials-n2"))?.title,
    "《教务+教统》【LP发给老师 + 资料对接】<Heather孙晓琳 · Grace Lin>");
  assert.equal(tasks.find((task) => task.ruleKey?.endsWith("prep-n1"))?.title,
    "《教务+教统》【跟进老师备课内容】<Heather孙晓琳 · Grace Lin>");
  assert.equal(tasks.find((task) => task.ruleKey?.endsWith("today"))?.title,
    "《教务+教统》【今日试听】<Heather孙晓琳 · Grace Lin · 墨尔本 19:00 结束>");
  assert.ok(tasks.some((task) => task.title.includes("收取试听费") && task.owner === "Tara"));
});

test("omits the N-1 teacher-preparation task when the handover explicitly says no", () => {
  const fields = { ...extendedFields, preparationFollowUp: "否" as const };
  const match = matchTrialScheduleEvents({
    lpItems: [{
      id: "LP-NO-PREP",
      studentId: "STU-1",
      workflowType: "试听 LP",
      fields,
      trialIntake: trialIntakeFromFields(fields),
    }],
    students: [{ id: "STU-1", name: "Heather孙晓琳", owner: "Ella", planner: "Tara" }],
    teachers: [{ id: "TEA-1", name: "Grace Lin" }],
    events: [{
      eventId: "evt-no-prep",
      startsAt: "2026-09-03T08:00:00.000Z",
      endsAt: "2026-09-03T09:00:00.000Z",
      courseName: "Heather孙晓琳",
      teacherId: "TEA-1",
      visibleStudentIds: [],
      trialPlannerHint: "Tara",
    }],
    matchedAt: "2026-08-28T03:00:00.000Z",
  })[0]!;

  const tasks = generateJiaowubaoTrialTasks({ ...match, now: "2026-08-28T03:00:00.000Z" });
  assert.equal(match.preparationFollowUp, false);
  assert.equal(tasks.length, 3);
  assert.ok(!tasks.some((task) => task.ruleKey?.endsWith("prep-n1")));
});
