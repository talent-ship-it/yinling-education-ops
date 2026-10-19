import assert from "node:assert/strict";
import test from "node:test";
import { generateJiaowubaoTrialTasks } from "../lib/trial-operations";

type TaskInput = Parameters<typeof generateJiaowubaoTrialTasks>[0];

function trial(input: Pick<TaskInput, "requestSentAt" | "now"> & Pick<TaskInput["link"], "startsAt" | "endsAt">) {
  return generateJiaowubaoTrialTasks({
    lpItemId: "LP-SHORT-NOTICE",
    studentId: "STU-SYNTHETIC",
    studentName: "Synthetic Student",
    owner: "Ella",
    planner: "Tara",
    preparationFollowUp: true,
    trialPaymentMethod: "付费试听（未付费）",
    requestSentAt: input.requestSentAt,
    now: input.now,
    link: {
      source: "jiaowubao-open-api",
      eventId: "EVT-SHORT-NOTICE",
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      courseName: "Synthetic Student trial",
      teacherId: "TEA-SYNTHETIC",
      teacherName: "Synthetic Teacher",
      plannerHint: "Tara",
      matchedAt: new Date(input.now).toISOString(),
    },
  });
}

const preTrialRules = ["lp-materials-n2", "prep-n1", "payment-n2"];

for (const example of [
  {
    name: "a winter morning trial",
    requestSentAt: "2026-08-20T22:00:00.000Z",
    startsAt: "2026-08-21T00:00:00.000Z",
    endsAt: "2026-08-21T01:00:00.000Z",
    now: "2026-08-20T22:30:00.000Z",
  },
  {
    name: "a summer morning trial",
    requestSentAt: "2026-12-20T21:00:00.000Z",
    startsAt: "2026-12-20T23:00:00.000Z",
    endsAt: "2026-12-21T00:00:00.000Z",
    now: "2026-12-20T21:30:00.000Z",
  },
  {
    name: "the first morning after Melbourne starts daylight saving",
    requestSentAt: "2026-10-03T15:30:00.000Z",
    startsAt: "2026-10-03T23:00:00.000Z",
    endsAt: "2026-10-04T00:00:00.000Z",
    now: "2026-10-03T16:00:00.000Z",
  },
  {
    name: "the repeated hour when Melbourne ends daylight saving",
    requestSentAt: "2026-04-04T15:30:00.000Z",
    startsAt: "2026-04-04T16:30:00.000Z",
    endsAt: "2026-04-04T17:30:00.000Z",
    now: "2026-04-04T16:00:00.000Z",
  },
]) {
  test(`same-day pre-trial reminders never outlive ${example.name}`, () => {
    const tasks = trial(example);
    assert.equal(tasks.some((task) => task.ruleKey?.endsWith("lp-finalize-tomorrow-n3")), false);
    for (const rule of preTrialRules) {
      assert.equal(tasks.find((task) => task.ruleKey?.endsWith(rule))?.dueAt, example.startsAt, rule);
    }
    assert.ok(tasks.every((task) => task.dueAt! <= example.startsAt));
  });
}

test("a same-day evening trial keeps the intake-day 18:00 deadline", () => {
  const tasks = trial({
    requestSentAt: "2026-12-20T21:00:00.000Z",
    startsAt: "2026-12-21T09:00:00.000Z",
    endsAt: "2026-12-21T10:00:00.000Z",
    now: "2026-12-21T08:00:00.000Z",
  });
  for (const rule of preTrialRules) {
    const task = tasks.find((task) => task.ruleKey?.endsWith(rule));
    assert.equal(task?.dueAt, "2026-12-21T07:00:00.000Z");
    assert.ok(task?.dueAt && task.dueAt < "2026-12-21T08:00:00.000Z");
  }
});

test("late discovery of an already-started or finished same-day trial retains expired deadlines", () => {
  const input = {
    requestSentAt: "2026-08-20T22:00:00.000Z",
    startsAt: "2026-08-21T00:00:00.000Z",
    endsAt: "2026-08-21T01:00:00.000Z",
  };
  for (const now of ["2026-08-21T00:30:00.000Z", "2026-08-21T02:00:00.000Z", "2026-08-22T02:00:00.000Z"]) {
    const tasks = trial({ ...input, now });
    assert.ok(tasks.every((task) => task.dueAt === input.startsAt && task.dueAt < now));
  }
});

test("next-day intake after midnight in Melbourne compresses onto the intake civil day", () => {
  const tasks = trial({
    requestSentAt: "2026-10-03T14:30:00.000Z",
    startsAt: "2026-10-04T23:00:00.000Z",
    endsAt: "2026-10-05T00:00:00.000Z",
    now: "2026-10-03T15:00:00.000Z",
  });
  for (const rule of preTrialRules) {
    assert.equal(tasks.find((task) => task.ruleKey?.endsWith(rule))?.dueAt, "2026-10-04T07:00:00.000Z");
  }
  assert.equal(tasks.some((task) => task.ruleKey?.endsWith("lp-finalize-tomorrow-n3")), false);
});

for (const example of [
  {
    name: "spring daylight-saving change",
    requestSentAt: "2026-10-02T01:00:00.000Z",
    startsAt: "2026-10-05T00:00:00.000Z",
    endsAt: "2026-10-05T01:00:00.000Z",
    deadlines: ["2026-10-02T08:00:00.000Z", "2026-10-03T08:00:00.000Z", "2026-10-04T07:00:00.000Z"],
  },
  {
    name: "autumn daylight-saving change",
    requestSentAt: "2026-04-03T01:00:00.000Z",
    startsAt: "2026-04-06T00:00:00.000Z",
    endsAt: "2026-04-06T01:00:00.000Z",
    deadlines: ["2026-04-03T07:00:00.000Z", "2026-04-04T07:00:00.000Z", "2026-04-05T08:00:00.000Z"],
  },
]) {
  test(`normal N-3, N-2 and N-1 reminders retain Melbourne civil deadlines across the ${example.name}`, () => {
    const tasks = trial({ ...example, now: example.requestSentAt });
    for (const [index, rule] of ["lp-finalize-tomorrow-n3", "lp-materials-n2", "prep-n1"].entries()) {
      assert.equal(tasks.find((task) => task.ruleKey?.endsWith(rule))?.dueAt, example.deadlines[index], rule);
    }
    assert.equal(tasks.find((task) => task.ruleKey?.endsWith("payment-n2"))?.dueAt, example.deadlines[1]);
  });
}
