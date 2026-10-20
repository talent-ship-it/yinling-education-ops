import assert from "node:assert/strict";
import test from "node:test";

import {
  JiaowubaoTrialSyncError,
  jiaowubaoTrialSyncPendingDisposition,
  jiaowubaoTrialSyncScope,
  parseJiaowubaoTrialSyncCommand,
  persistJiaowubaoTrialSyncPendingCommands,
  readJiaowubaoTrialSyncPendingCommands,
  upsertJiaowubaoTrialSyncPendingCommand,
} from "../lib/jiaowubao-trial-sync";
import { prepareJiaowubaoTrialSyncProjection } from "../lib/jiaowubao-trial-sync-projection";
import type { OpsStateRow } from "../lib/ops-store";

const revision = `sha256:${"a".repeat(64)}`;
const command = {
  commandKey: "0f849d3a-af99-48dc-a504-50539b24cdb1",
  snapshotRevision: revision,
  window: {
    startsAt: "2026-08-28T00:00:00.000Z",
    endsAt: "2026-09-29T00:00:00.000Z",
  },
  matches: [{ lpItemId: "LP-TRIAL-1", eventId: "evt-trial-1", startsAt: "2026-09-03T08:00:00.000Z" }],
  expectedVersions: { lpItems: 7, tasks: 11 },
} as const;

function row(entity: string, payload: unknown, version = 1): OpsStateRow {
  return { entity, payload, version, updated_at: "2026-08-28T00:00:00.000Z", updated_by: "fixture" };
}

function fixtureRows(extra: { bookings?: unknown[]; tasks?: unknown[]; schedule?: unknown; trialPaid?: boolean } = {}) {
  const intake = {
    planner: "Tara",
    requestSentAt: "2026-08-28T02:00:00.000Z",
    contactParents: true,
    contactStudent: false,
    writingRequired: true,
    paperRequired: true,
    studentName: "Heather孙晓琳",
    trialDurationMinutes: 60,
  };
  const lp = {
    id: "LP-TRIAL-1",
    studentId: "STU-TRIAL-1",
    title: "试听 LP",
    workflowType: "试听 LP",
    stage: "待跟进",
    owner: "Ella",
    due: "2026-08-29",
    requestedAt: intake.requestSentAt,
    fields: { preparationFollowUp: "是", trialPaymentMethod: "付费试听（未付费）" },
    trialIntake: intake,
    ...(typeof extra.trialPaid === "boolean" ? { trialPaid: extra.trialPaid } : {}),
    ...(extra.schedule ? { trialSchedule: extra.schedule } : {}),
  };
  const manualReminder = {
    id: "TASK-MANUAL-24H",
    title: "《教务+教统》【向家长交待排课进度】<Heather孙晓琳> <QA家长>",
    owner: "Ella",
    assignees: ["Ella", "Ops Admin"],
    watchers: ["Ops Admin"],
    studentId: "STU-TRIAL-1",
    due: "2026-08-29 12:00",
    dueAt: "2026-08-29T02:00:00.000Z",
    status: "upcoming",
    tone: "blue",
    category: "试听",
    trigger: "试听 LP 信息交接后按手册自动生成",
    ruleKey: "trial.manual-request.parent-progress-24h",
    anchorBookingId: "LP-TRIAL-1",
  };
  const pendingScheduling = {
    ...manualReminder,
    id: "TASK-PENDING-SCHEDULING",
    title: "《教务+教统》【试听待排课】<Heather孙晓琳> <QA家长>",
    tone: "red",
    category: "排课",
    ruleKey: "trial.scheduling",
  };
  return [
    row("students", [{
      id: "STU-TRIAL-1",
      name: "Heather孙晓琳",
      owner: "Ella",
      planner: "Tara",
      jwbSourceRow: "member-1",
    }]),
    row("teachers", [{ id: "TEA-1", name: "Zara Baker" }]),
    row("bookings", extra.bookings ?? []),
    row("lpItems", [lp], 7),
    row("tasks", [pendingScheduling, manualReminder, ...(extra.tasks ?? [])], 11),
  ];
}

function teacherChangeFixtureRows() {
  return [
    row("students", [{
      id: "STU-TRIAL-1",
      name: "Heather孙晓琳",
      owner: "Ella",
      planner: "Tara",
      teacher: "Grace Lin",
      jwbSourceRow: "member-1",
    }]),
    row("teachers", [
      { id: "TEA-1", name: "Grace Lin" },
      { id: "TEA-2", name: "Zara Baker" },
    ]),
    row("bookings", []),
    row("lpItems", [{
      id: "LP-TRIAL-1",
      studentId: "STU-TRIAL-1",
      title: "换老师试听",
      workflowType: "换老师试听",
      stage: "待跟进",
      owner: "Ella",
      due: "2026-08-29",
      requestedAt: "2026-08-28T02:00:00.000Z",
      fields: { newTeacher: "Zara Baker", preparationFollowUp: "是" },
    }], 7),
    row("tasks", [{
      id: "TASK-LEGACY-SCHEDULING",
      title: "完成试听排课",
      owner: "Ella",
      assignees: ["Ella"],
      watchers: ["Ops Admin"],
      studentId: "STU-TRIAL-1",
      due: "2026-08-29 12:00",
      dueAt: "2026-08-29T02:00:00.000Z",
      status: "upcoming",
      tone: "red",
      category: "排课",
      trigger: "试听 LP 创建后自动生成",
      ruleKey: "trial.scheduling",
      anchorBookingId: "LP-TRIAL-1",
    }], 11),
  ];
}

const rawEvent = {
  eventId: "evt-trial-1",
  sourceDate: "2026-09-03",
  startsAt: "2026-09-03T08:00:00.000Z",
  endsAt: "2026-09-03T09:00:00.000Z",
  courseName: "English试听 Heather 孙晓琳",
  sourceTeacherId: "source-teacher-9",
  sourceTeacherLabel: "Zara Baker",
  sourceParticipants: [
    { memberId: "member-1", label: "Heather孙晓琳" },
    { memberId: null, label: "试听学员A" },
  ],
  sourceStudentsTruncated: false,
} as const;

test("accepts only canonical bounded trial-sync commands", () => {
  assert.deepEqual(parseJiaowubaoTrialSyncCommand(command), command);
  assert.throws(() => parseJiaowubaoTrialSyncCommand({ ...command, extra: true }), JiaowubaoTrialSyncError);
  assert.throws(() => parseJiaowubaoTrialSyncCommand({
    ...command,
    matches: [...command.matches, { ...command.matches[0], eventId: "evt-2" }],
  }), /同一 LP/);
  assert.throws(() => parseJiaowubaoTrialSyncCommand({
    ...command,
    matches: [{ ...command.matches[0], startsAt: "2026-09-03T08:00:00Z" }],
  }), /身份或时间无效/);
  assert.throws(() => parseJiaowubaoTrialSyncCommand({
    ...command,
    window: { ...command.window, endsAt: "2026-12-01T00:00:00.000Z" },
  }), /超出允许范围/);
  assert.throws(() => parseJiaowubaoTrialSyncCommand({
    ...command,
    window: { startsAt: "2026-09-04T00:00:00.000Z", endsAt: "2026-09-05T00:00:00.000Z" },
  }), /不在固定课表窗口/);
});

test("keeps actor-scoped pending commands for unknown results and clears terminal outcomes", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const scope = jiaowubaoTrialSyncScope(command);
  const pending = { scope, ...command };
  const entries = upsertJiaowubaoTrialSyncPendingCommand([], pending);
  persistJiaowubaoTrialSyncPendingCommands(storage, "Ella", entries.values());
  assert.deepEqual(readJiaowubaoTrialSyncPendingCommands(storage, "Ella").get(scope), pending);
  assert.equal(readJiaowubaoTrialSyncPendingCommands(storage, "Tara").size, 0);
  assert.equal(jiaowubaoTrialSyncPendingDisposition({ status: 503, committed: false, hasAuthoritativeRows: false }), "retain");
  assert.equal(jiaowubaoTrialSyncPendingDisposition({ status: 409, committed: false, hasAuthoritativeRows: false }), "clear");
  assert.equal(jiaowubaoTrialSyncPendingDisposition({ status: 200, committed: true, hasAuthoritativeRows: true }), "clear");
});

test("derives linked LP evidence and the complete handbook task chain from raw JWB evidence", () => {
  const projection = prepareJiaowubaoTrialSyncProjection({
    rows: fixtureRows(),
    references: command.matches,
    rawEvents: [rawEvent],
    snapshotRevision: command.snapshotRevision,
    matchedAt: "2026-08-28T03:00:00.000Z",
  });
  const lp = projection.nextLpItems[0]!;
  assert.equal((lp.trialSchedule as Record<string, unknown>).eventId, "evt-trial-1");
  assert.equal((lp.trialSchedule as Record<string, unknown>).sourceRevision, command.snapshotRevision);
  assert.equal((lp.trialSchedule as Record<string, unknown>).studentName, "Heather孙晓琳");
  assert.equal((lp.trialSchedule as Record<string, unknown>).teacherName, "Zara Baker");
  assert.equal((lp.trialSchedule as Record<string, unknown>).durationMinutes, 60);
  assert.equal((lp.trialSchedule as Record<string, unknown>).sharedAccountLabel, "试听学员A");
  assert.equal((lp.trialSchedule as Record<string, unknown>).sharedAccountLetter, "a");
  assert.equal((lp.fields as Record<string, unknown>).assignedTeacher, "Zara Baker");
  assert.equal((lp.fields as Record<string, unknown>).trialDurationMinutes, 60);
  const jwbTasks = projection.nextTasks.filter((task) => task.ruleKey?.startsWith("trial.jiaowubao."));
  assert.deepEqual(jwbTasks.map((task) => task.ruleKey).sort(), [
    "trial.jiaowubao.lp-finalize-tomorrow-n3",
    "trial.jiaowubao.lp-materials-n2",
    "trial.jiaowubao.payment-n2",
    "trial.jiaowubao.prep-n1",
    "trial.jiaowubao.today",
  ]);
  assert.ok(jwbTasks.every((task) => task.requestAnchorBookingId === "LP-TRIAL-1"));
  assert.equal(jwbTasks.find((task) => task.ruleKey === "trial.jiaowubao.payment-n2")?.owner, "Tara");
  assert.equal(projection.nextTasks.find((task) => task.id === "TASK-MANUAL-24H")?.status, "done");
  assert.equal(projection.nextTasks.find((task) => task.id === "TASK-PENDING-SCHEDULING")?.status, "done");
  assert.deepEqual(projection.evidence, [{
    lpItemId: "LP-TRIAL-1",
    eventId: "evt-trial-1",
    studentId: "STU-TRIAL-1",
    paymentManagedByBooking: false,
  }]);
});

test("discovers the same unambiguous references without any browser-supplied pairs", () => {
  const projection = prepareJiaowubaoTrialSyncProjection({
    rows: fixtureRows(),
    rawEvents: [rawEvent],
    snapshotRevision: command.snapshotRevision,
    matchedAt: "2026-08-28T03:00:00.000Z",
  });
  assert.deepEqual(projection.references, command.matches);
});

test("archived students never enter a trial sync batch through title or screenshot evidence", () => {
  for (const importArchived of [true, "true"]) {
    for (const pinned of [false, true]) {
      const rows = fixtureRows();
      const students = rows.find((entry) => entry.entity === "students")!.payload as Record<string, unknown>[];
      students[0]!.importArchived = importArchived;
      const lp = (rows.find((entry) => entry.entity === "lpItems")!.payload as Record<string, unknown>[])[0]!;
      if (pinned) lp.trialScheduleReview = { source: "screenshot-review", eventId: rawEvent.eventId };
      const input = {
        rows,
        rawEvents: [rawEvent],
        snapshotRevision: command.snapshotRevision,
        matchedAt: "2026-08-28T03:00:00.000Z",
      };
      const projection = prepareJiaowubaoTrialSyncProjection(input);
      assert.deepEqual(projection.references, []);
      assert.deepEqual(projection.nextLpItems, [lp]);
      assert.deepEqual(projection.nextTasks, rows.find((entry) => entry.entity === "tasks")!.payload);
      assert.throws(() => prepareJiaowubaoTrialSyncProjection({ ...input, references: command.matches }), /不能再无歧义匹配/);
    }
  }
});

test("server projection uses the normal trial arranged teacher to disambiguate source lessons", () => {
  const rows = fixtureRows();
  const lp = (rows.find((entry) => entry.entity === "lpItems")!.payload as Record<string, unknown>[])[0]!;
  lp.fields = { ...(lp.fields as Record<string, unknown>), assignedTeacher: "Zara Baker" };
  const projection = prepareJiaowubaoTrialSyncProjection({
    rows, references: command.matches, snapshotRevision: revision, matchedAt: "2026-08-28T03:00:00.000Z",
    rawEvents: [rawEvent, { ...rawEvent, eventId: "evt-other-teacher", sourceTeacherLabel: "Grace Lin" }],
  });
  assert.deepEqual(projection.references, command.matches);
  assert.equal((projection.nextLpItems[0]!.fields as Record<string, unknown>).assignedTeacher, "Zara Baker");
});

test("server projection rejects both direct and title-only browser selections while their source lessons remain ambiguous", () => {
  const titleOnly = { ...rawEvent, eventId: "evt-title-only", sourceParticipants: [{ memberId: "shared-member", label: "试听学员A" }] };
  const input = { rows: fixtureRows(), rawEvents: [titleOnly, rawEvent], snapshotRevision: revision, matchedAt: "2026-08-28T03:00:00.000Z" };
  const projection = prepareJiaowubaoTrialSyncProjection(input);
  assert.deepEqual(projection.references, []);
  assert.throws(() => prepareJiaowubaoTrialSyncProjection({ ...input, references: command.matches }), /不能再无歧义匹配/);
  assert.throws(() => prepareJiaowubaoTrialSyncProjection({ ...input, references: [{ ...command.matches[0], eventId: titleOnly.eventId }] }), /不能再无歧义匹配/);
});

test("server projection disambiguates a shared-account trial without preferring the student's regular member lesson", () => {
  const rows = fixtureRows();
  const lp = (rows.find((entry) => entry.entity === "lpItems")!.payload as Record<string, unknown>[])[0]!;
  lp.fields = { ...(lp.fields as Record<string, unknown>), assignedTeacher: "Zara Baker" };
  const projection = prepareJiaowubaoTrialSyncProjection({
    rows, references: command.matches, snapshotRevision: revision, matchedAt: "2026-08-28T03:00:00.000Z",
    rawEvents: [
      { ...rawEvent, eventId: "evt-regular", courseName: "Year 9 English", sourceTeacherLabel: "Grace Lin" },
      { ...rawEvent, sourceParticipants: [{ memberId: "shared-member", label: "试听学员A" }] },
    ],
  });
  assert.deepEqual(projection.references, command.matches);
});

test("server projection retains original candidate competition after arranged-teacher narrowing", () => {
  const rows = fixtureRows();
  const students = rows.find((entry) => entry.entity === "students")!.payload as Record<string, unknown>[];
  students.push({ id: "STU-OTHER", name: "Casey李同学", owner: "Ella", planner: "Tara" });
  const lpItems = rows.find((entry) => entry.entity === "lpItems")!.payload as Record<string, unknown>[];
  lpItems[0]!.fields = { ...(lpItems[0]!.fields as Record<string, unknown>), assignedTeacher: "Zara Baker" };
  lpItems.push({ id: "LP-OTHER", studentId: "STU-OTHER", workflowType: "试听 LP", stage: "待跟进", fields: { assignedTeacher: "Grace Lin" } });
  const competing = { ...rawEvent, eventId: "evt-competing", courseName: "English - Casey李同学试听", sourceTeacherLabel: "Grace Lin" };
  const input = { rows, rawEvents: [rawEvent, competing], snapshotRevision: revision, matchedAt: "2026-08-28T03:00:00.000Z" };
  assert.deepEqual(prepareJiaowubaoTrialSyncProjection(input).references, command.matches);
  assert.throws(() => prepareJiaowubaoTrialSyncProjection({ ...input, references: [{ lpItemId: "LP-OTHER", eventId: competing.eventId, startsAt: competing.startsAt }] }), /不能再无歧义匹配/);
});

test("cancelled trial LPs are preserved and excluded from sync references", () => {
  const rows = fixtureRows();
  const lp = (rows.find((entry) => entry.entity === "lpItems")!.payload as Record<string, unknown>[])[0]!;
  lp.resultStatus = "已取消";
  lp.trialScheduleReview = { source: "screenshot-review", eventId: rawEvent.eventId };
  const input = { rows, rawEvents: [rawEvent], snapshotRevision: command.snapshotRevision, matchedAt: "2026-08-28T03:00:00.000Z" };
  const projection = prepareJiaowubaoTrialSyncProjection(input);
  assert.deepEqual(projection.references, []);
  assert.deepEqual(projection.nextLpItems, [lp]);
  assert.deepEqual(projection.nextTasks, rows.find((entry) => entry.entity === "tasks")!.payload);
  assert.throws(() => prepareJiaowubaoTrialSyncProjection({ ...input, references: command.matches }), /不能再无歧义匹配/);
});

test("an explicit LP paid flag keeps the Jiaowubao payment reminder closed", () => {
  const projection = prepareJiaowubaoTrialSyncProjection({
    rows: fixtureRows({ trialPaid: true }),
    references: command.matches,
    rawEvents: [rawEvent],
    snapshotRevision: command.snapshotRevision,
    matchedAt: "2026-08-28T03:00:00.000Z",
  });
  const payment = projection.nextTasks.find((task) => task.ruleKey === "trial.jiaowubao.payment-n2");
  assert.equal(payment?.status, "done");
  assert.equal(payment?.tone, "green");
  assert.equal(payment?.result, "试听台账已标记付费，收费提醒自动关闭");
});

test("schedule reconciliation removes retired open teacher-reply tasks but preserves completed evidence", () => {
  const teacherReply = {
    id: "TASK-TEACHER-REPLY",
    title: "《教务+教统》【跟进老师回复】<Heather孙晓琳 · Zara Baker>",
    owner: "Ella",
    assignees: ["Ella", "Ops Admin"],
    watchers: ["Ops Admin"],
    studentId: "STU-TRIAL-1",
    due: "2026-08-28 15:00",
    dueAt: "2026-08-28T05:00:00.000Z",
    status: "upcoming",
    tone: "blue",
    category: "LP",
    trigger: "资料对接完成后自动生成",
    ruleKey: "trial.jiaowubao.teacher-reply-4h",
    anchorBookingId: "JWB:evt-trial-1",
    requestAnchorBookingId: "LP-TRIAL-1",
  } as const;
  const completedTeacherReply = {
    ...teacherReply,
    id: "TASK-TEACHER-REPLY-DONE",
    status: "done",
    tone: "green",
    completionOutcome: "done",
    result: "老师已回复",
    closedAt: "2026-08-28T02:30:00.000Z",
  } as const;
  const projection = prepareJiaowubaoTrialSyncProjection({
    rows: fixtureRows({ tasks: [teacherReply, completedTeacherReply] }),
    references: command.matches,
    rawEvents: [rawEvent],
    snapshotRevision: command.snapshotRevision,
    matchedAt: "2026-08-28T03:00:00.000Z",
  });
  assert.equal(projection.nextTasks.find((task) => task.id === teacherReply.id), undefined);
  assert.deepEqual(projection.nextTasks.find((task) => task.id === completedTeacherReply.id), completedTeacherReply);
});

test("links a teacher-change trial only to its requested teacher and never creates a payment task", () => {
  const rows = teacherChangeFixtureRows();
  const projection = prepareJiaowubaoTrialSyncProjection({
    rows,
    references: command.matches,
    rawEvents: [rawEvent],
    snapshotRevision: command.snapshotRevision,
    matchedAt: "2026-08-28T03:00:00.000Z",
  });
  const lp = projection.nextLpItems[0]!;
  const student = (rows[0]!.payload as Record<string, unknown>[])[0]!;
  assert.equal((lp.trialSchedule as Record<string, unknown>).teacherName, "Zara Baker");
  assert.equal(lp.trialIntake, undefined);
  assert.equal((lp.fields as Record<string, unknown>).newTeacher, "Zara Baker");
  assert.equal(student.teacher, "Grace Lin");
  const jwbTasks = projection.nextTasks.filter((task) => task.ruleKey?.startsWith("trial.jiaowubao."));
  assert.deepEqual(jwbTasks.map((task) => task.ruleKey).sort(), [
    "trial.jiaowubao.lp-finalize-tomorrow-n3",
    "trial.jiaowubao.lp-materials-n2",
    "trial.jiaowubao.prep-n1",
    "trial.jiaowubao.today",
  ]);
  assert.equal(projection.nextTasks.find((task) => task.id === "TASK-LEGACY-SCHEDULING")?.status, "done");
  assert.ok(!projection.nextTasks.some((task) => task.ruleKey === "trial.jiaowubao.payment-n2"));
});

test("rejects a teacher-change trial when the Jiaowubao teacher differs from the requested new teacher", () => {
  assert.throws(() => prepareJiaowubaoTrialSyncProjection({
    rows: teacherChangeFixtureRows(),
    references: command.matches,
    rawEvents: [{ ...rawEvent, sourceTeacherLabel: "Grace Lin" }],
    snapshotRevision: command.snapshotRevision,
    matchedAt: "2026-08-28T03:00:00.000Z",
  }), /不能再无歧义匹配/);
});

test("rejects a browser reference when the complete source window makes the LP match ambiguous", () => {
  assert.throws(() => prepareJiaowubaoTrialSyncProjection({
    rows: fixtureRows(),
    references: command.matches,
    rawEvents: [rawEvent, {
      ...rawEvent,
      eventId: "evt-trial-2",
      startsAt: "2026-09-04T08:00:00.000Z",
      endsAt: "2026-09-04T09:00:00.000Z",
    }],
    snapshotRevision: command.snapshotRevision,
    matchedAt: "2026-08-28T03:00:00.000Z",
  }), /不能再无歧义匹配/);
});

test("rejects a browser-selected event that is not the server-recomputed source match", () => {
  const unrelated = {
    ...rawEvent,
    eventId: "evt-unrelated",
    startsAt: "2026-09-04T08:00:00.000Z",
    endsAt: "2026-09-04T09:00:00.000Z",
    courseName: "Year 8 Science",
    sourceParticipants: [{ memberId: "unknown-member", label: "试听学员B" }],
  } as const;
  assert.throws(() => prepareJiaowubaoTrialSyncProjection({
    rows: fixtureRows(),
    references: [{ lpItemId: "LP-TRIAL-1", eventId: unrelated.eventId, startsAt: unrelated.startsAt }],
    rawEvents: [rawEvent, unrelated],
    snapshotRevision: command.snapshotRevision,
    matchedAt: "2026-08-28T03:00:00.000Z",
  }), /不能再无歧义匹配/);
});

test("rejects a referenced source event whose participant evidence was truncated", () => {
  assert.throws(() => prepareJiaowubaoTrialSyncProjection({
    rows: fixtureRows(),
    references: command.matches,
    rawEvents: [{ ...rawEvent, sourceStudentsTruncated: true }],
    snapshotRevision: command.snapshotRevision,
    matchedAt: "2026-08-28T03:00:00.000Z",
  }), /不能再无歧义匹配/);
});

test("defers payment to a real linked trial booking and removes an obsolete open JWB reminder", () => {
  const existingSchedule = {
    source: "jiaowubao-open-api",
    sourceRevision: command.snapshotRevision,
    eventId: "evt-trial-1",
    startsAt: rawEvent.startsAt,
    endsAt: rawEvent.endsAt,
    courseName: rawEvent.courseName,
    teacherId: "TEA-1",
    teacherName: "Zara Baker",
    plannerHint: "Tara",
    matchedAt: "2026-08-27T03:00:00.000Z",
  };
  const bookingPayment = {
    id: "TASK-BOOKING-PAYMENT",
    title: "试听收费",
    owner: "Tara",
    studentId: "STU-TRIAL-1",
    due: "2026-09-01",
    dueAt: "2026-09-01T08:00:00.000Z",
    status: "upcoming",
    tone: "amber",
    category: "试听",
    trigger: "试听排课",
    ruleKey: "trial.payment-n2",
    anchorBookingId: "BOOKING-TRIAL-1",
    requestAnchorBookingId: "LP-TRIAL-1",
  };
  const obsoleteJwbPayment = {
    ...bookingPayment,
    id: "TASK-OLD-JWB-PAYMENT",
    ruleKey: "trial.jiaowubao.payment-n2",
    anchorBookingId: "JWB:evt-trial-1",
    requestAnchorBookingId: undefined,
  };
  const projection = prepareJiaowubaoTrialSyncProjection({
    rows: fixtureRows({
      schedule: existingSchedule,
      bookings: [{ id: "BOOKING-TRIAL-1", kind: "试听", studentId: "STU-TRIAL-1" }],
      tasks: [bookingPayment, obsoleteJwbPayment],
    }),
    references: command.matches,
    rawEvents: [rawEvent],
    snapshotRevision: command.snapshotRevision,
    matchedAt: "2026-08-28T03:00:00.000Z",
  });
  assert.equal(projection.evidence[0]?.paymentManagedByBooking, true);
  assert.ok(!projection.nextTasks.some((task) => task.ruleKey === "trial.jiaowubao.payment-n2"));
  assert.ok(projection.nextTasks.some((task) => task.id === "TASK-BOOKING-PAYMENT"));
  assert.equal((projection.nextLpItems[0]!.trialSchedule as Record<string, unknown>).matchedAt,
    "2026-08-27T03:00:00.000Z");
});
