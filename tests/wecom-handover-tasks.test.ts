import assert from "node:assert/strict";
import test from "node:test";
import { handoverTaskGroups, HANDOVER_IDENTITY_RULE, type HandoverTaskInput, type HandoverTaskSource } from "../lib/wecom-handover-tasks";
import { createWecomHandoverTaskHandlers } from "../lib/wecom-handover-task-service";
import type { DemoSessionIdentity } from "../lib/demo-session-token";

const now = new Date("2026-10-28T06:00:00.000Z");
function source(id = "one", name = "Synthetic Child", options = "否"): HandoverTaskSource {
  return { id, caseId: `case-${id}`, sourceMessageId: id, sourceRevision: "a".repeat(64), wechatName: `Parent ${id}`, studentName: name,
    operationsOwner: "Erin", coursePlanner: "Eileen", status: "identified", createdAt: "2026-10-25T06:00:00.000Z", handoverAt: "2026-10-25T06:00:00.000Z", identityAt: "2026-10-25T06:01:00.000Z", confirmed: null,
    messages: [{ messageId: id, sentAt: "2026-10-25T06:00:00.000Z", studentNameHint: name,
      text: `试听LP 信息交接\n【安排教师】:Synthetic Teacher\n【安排科目】:Y8 English\n【是否“要指定内容”】:${options}\n【是否“要写作”】:否\n【是否“发试卷 收试卷”】:否\n【是否“跟进老师备课内容”】:是\n【教务老师】:Erin\n【课程规划老师】:Eileen\n【微信名】:Parent ${id}\n【学生姓名】:${name}` }] };
}
function input(sources = [source()]): HandoverTaskInput {
  return { snapshotRevision: `sha256:${"b".repeat(64)}`, inputRevision: "1", targetSourceMessageIds: [], states: [], sources,
    rows: ["students", "teachers", "lpItems"].map((entity) => ({ entity, payload: entity === "teachers" ? [{ id: "TEA-1", name: "Synthetic Teacher" }] : [], version: 1, updated_at: now.toISOString(), updated_by: "fixture" })),
    coverage: [{ startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z", historical: false }],
    events: [{ eventId: "event-one", sourceDate: "2026-10-30", startsAt: "2026-10-30T08:00:00.000Z", endsAt: "2026-10-30T09:00:00.000Z", courseName: "Year8 English - Synthetic Child试听",
      sourceTeacherId: "teacher-one", sourceTeacherLabel: "Synthetic Teacher", sourceParticipants: [{ memberId: "shared-b", label: "试听学员B2026" }], sourceStudentsTruncated: false, sourceRevision: `sha256:${"b".repeat(64)}`, sourceRunId: "run-one", historical: false }] };
}
test("identified handover needs no paid form or student record to close identity and create N-1 prep", () => {
  const data = input();
  const before = JSON.stringify(data);
  const [group] = handoverTaskGroups(data, now);
  assert.equal(group!.tasks.find((task) => task.ruleKey === HANDOVER_IDENTITY_RULE)?.status, "done");
  assert.equal(group!.tasks.find((task) => task.ruleKey === HANDOVER_IDENTITY_RULE)?.closedAt, source().identityAt);
  assert.equal(group!.tasks.find((task) => task.ruleKey === "trial.jiaowubao.prep-n1")?.dueAt, "2026-10-29T07:00:00.000Z");
  assert.equal(group!.tasks.find((task) => task.ruleKey === "trial.scheduling")?.status, "done");
  assert.ok(!group!.tasks.some((task) => task.ruleKey === "trial.jiaowubao.request-follow-up-n3"));
  assert.equal(JSON.stringify(data), before);
});
test("specified content generates action and N-3 follow-up; no invented writing or paper", () => {
  const [group] = handoverTaskGroups(input([source("one", "Synthetic Child", "是")]), now);
  assert.ok(group!.tasks.some((task) => task.ruleKey === "trial.manual-request.specified-content"));
  assert.ok(group!.tasks.some((task) => task.ruleKey === "trial.jiaowubao.request-follow-up-n3"));
  assert.ok(!group!.tasks.some((task) => /writing|paper/.test(task.ruleKey!)));
});
test("multiple events, wrong names, conflicts, and historical events never close scheduling", () => {
  const variants = [input(), input(), input(), input()];
  variants[0]!.events = [...variants[0]!.events, { ...variants[0]!.events[0]!, eventId: "event-two" }];
  variants[1]!.sources[0]!.studentName = "Another Child";
  variants[2]!.events = variants[2]!.events.map((event) => ({ ...event, historical: true }));
  variants[3]!.sources[0]!.status = "identity_conflict";
  for (const data of variants) for (const group of handoverTaskGroups(data, now)) {
    assert.equal(group.schedule, undefined);
    assert.notEqual(group.tasks.find((task) => task.ruleKey === "trial.scheduling")?.status, "done");
  }
});
function harness(session: DemoSessionIdentity = { user: "Erin", role: "staff", permissions: ["operations.read", "operations.write"], scopeMembers: [{ kind: "all", key: "*" }] }, fullAdmin = false) {
  let data = input([source("one", "Synthetic Child", "是")]);
  let writes = 0;
  const handlers = createWecomHandoverTaskHandlers({ identify: async () => ({ session, fullAdmin }), read: async () => structuredClone(data), now: () => now,
    save: async (command) => { writes++; data = { ...data, states: [{ sourceMessageId: command.sourceMessageId, version: command.expectedVersion + 1, tasks: [...command.tasks] }] }; return command.expectedVersion + 1; } });
  const post = (taskId: string, action: string, note?: string) => handlers.POST(new Request("https://example.test", { method: "POST", body: JSON.stringify({ taskId, action, ...(note === undefined ? {} : { note }) }) }));
  return { handlers, post, writes: () => writes };
}
test("complete, readback, reopen, cannot-do and note use durable history", async () => {
  const h = harness();
  let body = await (await h.handlers.GET()).json();
  const id = body.tasks.find((task: { ruleKey: string }) => task.ruleKey === "trial.manual-request.specified-content").id;
  assert.equal((await h.post(id, "complete")).status, 200);
  body = await (await h.handlers.GET()).json();
  assert.equal(body.tasks.find((task: { id: string }) => task.id === id).status, "done");
  assert.equal(body.tasks.find((task: { ruleKey: string }) => task.ruleKey === "trial.jiaowubao.request-follow-up-n3").status, "done");
  assert.equal((await h.post(id, "reopen")).status, 200);
  body = await (await h.handlers.GET()).json();
  assert.notEqual(body.tasks.find((task: { id: string }) => task.id === id).status, "done");
  assert.notEqual(body.tasks.find((task: { ruleKey: string }) => task.ruleKey === "trial.jiaowubao.request-follow-up-n3").status, "done");
  assert.equal((await h.post(id, "cannot", "Synthetic reason")).status, 200);
  body = await (await h.handlers.GET()).json();
  assert.equal(body.tasks.find((task: { id: string }) => task.id === id).completionOutcome, "cannot_do");
  assert.equal((await h.post(id, "note", "")).status, 400);
  assert.equal((await h.post(id, "note", "Updated reason")).status, 200);
});
test("other staff, teachers, restricted scope and read-only sessions cannot mutate", async () => {
  const data = input();
  const id = handoverTaskGroups(data, now)[0]!.tasks.find((task) => task.ruleKey === "trial.jiaowubao.prep-n1")!.id;
  for (const session of [{ user: "Ella", role: "staff" }, { user: "Erin", role: "teacher" },
    { user: "Erin", role: "staff", sessionId: "session", permissions: ["operations.read"], scopeMembers: [{ kind: "all", key: "*" }] },
    { user: "Erin", role: "staff", sessionId: "session", permissions: ["operations.write"], scopeMembers: [{ kind: "student", key: "one" }] }] as DemoSessionIdentity[]) {
    const h = harness(session);
    assert.equal((await h.post(id, "complete")).status, 403);
    assert.equal(h.writes(), 0);
  }
});
