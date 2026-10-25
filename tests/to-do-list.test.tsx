import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToDoList, type TaskDeadlineTimeZone, type ToDoFilter, type ToDoListProps } from "../app/to-do-list";
import { timezoneLabelFor } from "../lib/display-preferences";
import { OpsTask, TaskCategory, TaskStatus } from "../lib/ops-tasks";
import { groupTasksByOwner } from "../lib/task-owner-groups";

function task(
  id: string,
  category: TaskCategory,
  status: TaskStatus,
  due: string,
  dueAt?: string,
): OpsTask {
  const legacyCopy = /发布后立即|等待回复|规则文案/.test(due);
  return {
    id,
    title: `任务 ${id}`,
    owner: "Abby",
    studentId: `STU-${id}`,
    due,
    dueAt: dueAt ?? (legacyCopy ? undefined : "2026-08-12T08:00:00.000Z"),
    status,
    tone: status === "overdue" ? "red" : status === "today" ? "amber" : "blue",
    category,
    trigger: "不应渲染的解释文字",
  };
}

function render(
  tasks: OpsTask[],
  filter: ToDoFilter = "all",
  deadlineTimeZone: TaskDeadlineTimeZone = "Australia/Melbourne",
  deadlineTimeFormat: "24h" | "12h" = "24h",
  repairDeadlines = false,
  taskSchedule?: ToDoListProps["taskSchedule"],
) {
  return renderToStaticMarkup(
    <ToDoList
      tasks={tasks}
      deadlineTimeZone={deadlineTimeZone}
      deadlineTimeZoneLabel={timezoneLabelFor(deadlineTimeZone, "zh-CN")}
      deadlineTimeFormat={deadlineTimeFormat}
      studentName={(studentId) => `学生 ${studentId}`}
      taskSchedule={taskSchedule}
      filter={filter}
      onFilterChange={() => undefined}
      onComplete={() => undefined}
      onCannotDo={() => undefined}
      onReopen={() => undefined}
      onUpdateNote={() => undefined}
      onRepairDeadline={repairDeadlines ? () => undefined : undefined}
      canRepairDeadline={(candidate) => !Object.hasOwn(candidate, "ruleKey") && !Object.hasOwn(candidate, "anchorBookingId")}
      onParentReplied={() => undefined}
      onTeacherReplied={() => undefined}
      onOpen={() => undefined}
    />,
  );
}

function renderWithOpenPolicy(tasks: OpsTask[], canOpen: (task: OpsTask) => boolean) {
  return renderToStaticMarkup(
    <ToDoList
      tasks={tasks}
      deadlineTimeZone="Australia/Melbourne"
      deadlineTimeZoneLabel={timezoneLabelFor("Australia/Melbourne", "zh-CN")}
      studentName={(studentId) => `学生 ${studentId}`}
      filter="all"
      onFilterChange={() => undefined}
      onComplete={() => undefined}
      onCannotDo={() => undefined}
      onReopen={() => undefined}
      onUpdateNote={() => undefined}
      onOpen={() => undefined}
      canOpen={canOpen}
    />,
  );
}

test("renders the today and category tabs, marks the controlled filter, and keeps collapse removed", () => {
  const html = render([], "考试");
  for (const label of ["全部", "今日", "LP", "考试", "续课", "请假代课"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /aria-label="任务类别"/);
  assert.match(html, /截止日期<input type="date" aria-label="按截止日期筛选任务"/);
  for (const label of ["To Do", "All Done", "Can’t Do"]) assert.match(html, new RegExp(label));
  assert.match(html, /aria-label="任务状态"/);
  assert.match(html, /class="active" type="button" aria-pressed="true">考试</);
  assert.match(html, /id="to-do-list-content">/);
  for (const owner of ["Abby", "Thea", "Tiffany", "Erin", "Ella", "Molly"]) {
    assert.match(html, new RegExp(`<option value="${owner.toLocaleLowerCase()}">${owner}</option>`));
  }
  assert.doesNotMatch(html, /<option[^>]*>(?:Tara|Eileen|思佳|Ops Admin)<\/option>/);
  assert.doesNotMatch(html, /to-do-collapse-button|收起/);
});

test("renders today, overdue, then remaining sections and sorts each section by dueAt", () => {
  const html = render([
    task("remaining-later", "LP", "upcoming", "8月20日 18:00", "2026-08-20T08:00:00.000Z"),
    task("overdue-later", "考试", "overdue", "8月11日 18:00", "2026-08-11T08:00:00.000Z"),
    task("today-later", "续课", "today", "今天 18:00", "2026-08-12T08:00:00.000Z"),
    task("legacy", "资料", "waiting", "等待回复"),
    task("today-earlier", "请假代课", "today", "今天 10:00", "2026-08-12T00:00:00.000Z"),
    task("overdue-earlier", "排课", "overdue", "8月10日 18:00", "2026-08-10T08:00:00.000Z"),
    task("remaining-earlier", "课后", "upcoming", "8月19日 18:00", "2026-08-19T08:00:00.000Z"),
  ]);

  const positions = [
    "今日到期",
    "任务 today-earlier",
    "任务 today-later",
    ">已逾期</h4>",
    "任务 overdue-earlier",
    "任务 overdue-later",
    "其余任务",
    "任务 remaining-earlier",
    "任务 remaining-later",
  ].map((text) => html.indexOf(text));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

test("shows the canonical deadline as a compact date, not legacy workflow copy", () => {
  const html = render([task("due", "LP", "today", "试听前 N-3 · 18:00", "2026-08-12T08:00:00.000Z")]);
  assert.match(html, /aria-label="截止 2026年8月12日"[^>]*>2026年8月12日</);
  assert.doesNotMatch(html, />截止 2026年8月12日</);
  assert.match(html, /<time[^>]+dateTime="2026-08-12T08:00:00\.000Z"/);
  assert.match(html, /title="截止：2026年8月12日 · 墨尔本"/);
  assert.doesNotMatch(html, /试听前 N-3/);
  assert.doesNotMatch(html, /不应渲染的解释文字/);
  assert.doesNotMatch(html, /<small/);
  assert.match(html, /学生 STU-due/);
  assert.match(html, /<h3[^>]*>Abby<\/h3>/);
});

test("groups only the six current coordinators and retains historical or unassigned tasks", () => {
  const source = [
    { ...task("abby", "排课", "today", "今天"), owner: " Abby 教务 " },
    { ...task("abby-case", "LP", "today", "今天"), owner: "ＡＢＢＹ" },
    ...["Thea", "Tiffany", "Erin", "Ella", "Molly"].map((owner) => ({
      ...task(owner.toLocaleLowerCase(), "LP", "today", "今天"),
      owner,
    })),
    { ...task("planner", "考试", "today", "今天"), owner: "Ops Admin" },
    { ...task("historical", "排课", "overdue", "昨天"), owner: "思佳" },
    { ...task("unknown", "LP", "waiting", "等待回复"), owner: "新教务" },
    { ...task("unassigned", "LP", "today", "今天"), owner: " " },
  ];
  const groups = groupTasksByOwner(source);
  assert.deepEqual(groups.find((group) => group.owner === "Abby")?.tasks, source.slice(0, 2));
  for (const [index, owner] of ["Thea", "Tiffany", "Erin", "Ella", "Molly"].entries()) {
    assert.deepEqual(groups.find((group) => group.owner === owner)?.tasks, [source[index + 2]]);
  }
  assert.deepEqual(groups.find((group) => group.owner === "待分配")?.tasks, source.slice(7));
  for (const owner of ["Ops Admin", "思佳", "新教务"]) assert.ok(!groups.some((group) => group.owner === owner));
  const groupedTasks = groups.flatMap((group) => group.tasks);
  assert.equal(groupedTasks.length, source.length);
  assert.ok(source.every((candidate) => groupedTasks.includes(candidate)));
  assert.equal(source[0].owner, " Abby 教务 ");
});

test("keeps each owner's tasks together and preserves deadline ordering inside each group", () => {
  const html = render([
    { ...task("ella-today", "排课", "today", "今天"), owner: "Ella" },
    task("abby-later", "LP", "today", "今天", "2026-08-12T08:00:00.000Z"),
    { ...task("ella-overdue", "LP", "overdue", "昨天"), owner: "Ella" },
    task("abby-earlier", "排课", "today", "今天", "2026-08-12T00:00:00.000Z"),
    task("abby-pending", "LP", "waiting", "等待回复"),
  ]);
  assert.equal((html.match(/class="to-do-owner-group"/g) ?? []).length, 2);
  const abbyAt = html.indexOf(">Abby</h3>");
  const ellaAt = html.indexOf(">Ella</h3>");
  assert.ok(abbyAt >= 0 && ellaAt > abbyAt);
  const abbyGroup = html.slice(abbyAt, ellaAt);
  const ellaGroup = html.slice(ellaAt);
  assert.ok(abbyGroup.indexOf("任务 abby-earlier") < abbyGroup.indexOf("任务 abby-later"));
  assert.match(abbyGroup, /任务 abby-pending/);
  assert.doesNotMatch(abbyGroup, /任务 ella-/);
  assert.match(ellaGroup, /任务 ella-today/);
  assert.match(ellaGroup, /任务 ella-overdue/);
  assert.doesNotMatch(ellaGroup, /任务 abby-/);
});

test("renders legacy tasks with missing or invalid owners as unassigned", () => {
  const source = [undefined, null, 17].map((owner, index) => ({
    ...task(`missing-owner-${index}`, "LP", "today", "今天"),
    owner,
  })) as unknown as OpsTask[];
  const groups = groupTasksByOwner(source);
  assert.deepEqual(groups.filter((group) => group.tasks.length > 0).map((group) => group.owner), ["待分配"]);
  assert.deepEqual(groups.find((group) => group.owner === "待分配")?.tasks, source);
  const html = render(source);
  assert.match(html, /<h3[^>]*>待分配<\/h3>/);
  for (let index = 0; index < source.length; index++) assert.match(html, new RegExp(`任务 missing-owner-${index}`));
});

test("lists exactly the six current coordinators in the filter and uses unique accessible section labels", () => {
  const html = render([
    task("abby-today", "排课", "today", "今天"),
    task("abby-overdue", "LP", "overdue", "昨天"),
    { ...task("ella-today", "排课", "today", "今天"), owner: "Ella" },
    { ...task("ella-overdue", "LP", "overdue", "昨天"), owner: "Ella" },
  ]);
  assert.match(html, /aria-label="按负责人筛选任务"/);
  for (const owner of ["Abby", "Thea", "Tiffany", "Erin", "Ella", "Molly"]) {
    assert.match(html, new RegExp(`<option value="${owner.toLocaleLowerCase()}">${owner}</option>`));
  }
  assert.doesNotMatch(html, /<option[^>]*>(?:Tara|Eileen|思佳|Ops Admin)<\/option>/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, reference] of html.matchAll(/aria-labelledby="([^"]+)"/g)) assert.ok(ids.includes(reference));
});

test("keeps name marks distinct when responsible owners share initials", () => {
  const groups = groupTasksByOwner([
    { ...task("one", "LP", "today", "今天"), owner: "Alice Brown" },
    { ...task("two", "LP", "today", "今天"), owner: "Andrew Bell" },
    { ...task("three", "LP", "today", "今天"), owner: "Ella" },
  ]);
  assert.equal(new Set(groups.map((group) => group.mark)).size, groups.length);
  assert.equal(groups.find((group) => group.owner === "Ella")?.mark, "EL");
});

test("renders the deadline after the task action buttons", () => {
  const html = render([task("rightmost-date", "LP", "today", "今天", "2026-08-12T08:00:00.000Z")]);
  const actionsAt = html.indexOf('class="task-row-actions"');
  const completeAt = html.indexOf('aria-label="完成：任务 rightmost-date"');
  const deadlineAt = html.indexOf('class="due-label today"');
  assert.ok(actionsAt >= 0);
  assert.ok(completeAt > actionsAt);
  assert.ok(deadlineAt > completeAt);
});

test("renders the same deadline instant in Beijing for operations and Melbourne for teaching control", () => {
  const deadline = "2026-08-12T14:30:00.000Z";
  const operations = render([task("beijing", "试听", "today", "legacy", deadline)], "all", "Asia/Shanghai");
  const teachingControl = render([task("melbourne", "试听", "today", "legacy", deadline)], "all", "Australia/Melbourne");

  assert.match(operations, />2026年8月12日</);
  assert.match(operations, /title="截止：2026年8月12日 · 北京时间（中国）"/);
  assert.match(teachingControl, />2026年8月13日</);
  assert.match(teachingControl, /title="截止：2026年8月13日 · 墨尔本"/);
  const twelveHour = render([task("twelve-hour", "试听", "today", "legacy", deadline)], "all", "Asia/Shanghai", "12h");
  assert.match(twelveHour, />2026年8月12日</);
});

test("renders only the plain handbook action as the headline and demotes details", () => {
  const handbook = {
    ...task("handbook", "排课", "today", "今天", "2026-08-12T08:00:00.000Z"),
    title: "《教务+教统》【试听待排课】<Heather孙晓琳> <Daisy>",
  };
  const html = render([handbook]);
  assert.match(html, /<strong>试听待排课<\/strong>/);
  assert.doesNotMatch(html, /<strong>【/);
  assert.match(html, /<small class="task-title-details">Heather孙晓琳 · Daisy<\/small>/);
  assert.doesNotMatch(html, /教务\+教统/);
});

test("does not present a descriptive legacy due string as an exact deadline", () => {
  const html = render([task("unknown", "LP", "today", "发布后立即")]);
  assert.match(html, /待补截止时间/);
  assert.match(html, />待补截止时间</);
  assert.doesNotMatch(html, /发布后立即/);
});

test("legacy automatically generated trial tasks wait for their source instead of requesting a manual deadline", () => {
  const pending = [
    { title: "试听收费确认", trigger: "试听 LP 收费提醒" },
    { title: "试听当天课后跟进", trigger: "试听 LP 课后跟进" },
  ].map((source, index) => ({
    ...task(`automatic-legacy-${index}`, "试听", "waiting", "规则文案"),
    ...source,
    legacyEvidence: {
      state: "frozen" as const,
      reason: "missing_canonical_due_at" as const,
      frozenAt: "2026-08-20T00:00:00.000Z",
    },
  }));
  const before = JSON.stringify(pending);
  const html = render(pending, "all", "Australia/Melbourne", "24h", true);
  assert.match(html, /等待自动生成/);
  assert.equal((html.match(/>待自动生成<\/span>/g) ?? []).length, pending.length);
  assert.doesNotMatch(html, /补截止时间|class="deadline-edit-button"|class="complete-button"|class="cannot-do-button"|<time/);
  assert.equal(JSON.stringify(pending), before);
});

test("keeps legacy tasks visible but non-actionable without deadline-repair authority", () => {
  const legacy = task("legacy-repair", "LP", "waiting", "发布后立即");
  const managed = {
    ...task("managed", "LP", "waiting", "规则文案"),
    ruleKey: "trial.parent-follow-up",
  };
  const anchored = {
    ...task("anchored", "LP", "waiting", "规则文案"),
    anchorBookingId: "LES-1",
  };
  const html = render([legacy, managed, anchored]);
  assert.match(html, /待补截止时间/);
  assert.equal((html.match(/<span class="due-label pending"[^>]*>待补截止时间<\/span>/g) ?? []).length, 1);
  assert.equal((html.match(/<span class="due-label pending"[^>]*>待自动生成<\/span>/g) ?? []).length, 2);
  assert.doesNotMatch(html, /class="deadline-edit-button"/);
  assert.doesNotMatch(html, /class="complete-button"/);
  assert.doesNotMatch(html, /class="cannot-do-button"/);
});

test("offers exact deadline repair only for unbound legacy tasks when authorized", () => {
  const legacy = task("legacy-repair", "LP", "waiting", "发布后立即");
  const managed = { ...task("managed", "LP", "waiting", "规则文案"), ruleKey: "trial.parent-follow-up" };
  const anchored = { ...task("anchored", "LP", "waiting", "规则文案"), anchorBookingId: "LES-1" };
  const html = render([legacy, managed, anchored], "all", "Australia/Melbourne", "24h", true);
  assert.equal((html.match(/class="deadline-edit-button"/g) ?? []).length, 1);
  assert.match(html, /class="deadline-edit-button"[^>]*>补截止时间<\/button>/);
  assert.doesNotMatch(html, />补时间<|>待补时间</);
});

test("category filtering is exact and completed tasks stay hidden", () => {
  const html = render(
    [
      task("lp", "LP", "today", "今天"),
      task("exam", "考试", "today", "今天"),
      task("done-lp", "LP", "done", "已完成"),
    ],
    "LP",
  );
  assert.match(html, /任务 lp/);
  assert.doesNotMatch(html, /任务 exam/);
  assert.doesNotMatch(html, /任务 done-lp/);
});

test("today filter keeps only tasks due today", () => {
  const html = render(
    [
      task("today", "LP", "today", "今天 10:00"),
      task("overdue", "考试", "overdue", "昨天 10:00"),
      task("upcoming", "续课", "upcoming", "明天 10:00"),
    ],
    "today",
  );
  assert.match(html, /任务 today/);
  assert.doesNotMatch(html, /任务 overdue/);
  assert.doesNotMatch(html, /任务 upcoming/);
});

test("renders a concise empty state without explanatory copy", () => {
  const html = render([], "all");
  assert.match(html, /没有待处理事项/);
  assert.doesNotMatch(html, /调整|筛选下|请调整/);
});

test("renders a cross-owner managed exam task identity as non-navigable text", () => {
  const html = renderWithOpenPolicy([
    task("managed-exam", "考试", "today", "今天 18:00"),
  ], () => false);
  assert.match(html, /task-copy task-copy-static/);
  assert.match(html, /<div class="task-copy task-copy-static"><strong>任务 managed-exam<\/strong>/);
  assert.doesNotMatch(html, /<button class="task-copy"/);
  assert.match(html, /aria-label="完成：任务 managed-exam"/);
});

test("shows a manual teacher-reply close action only on the 4h/8h reply chain", () => {
  const teacherReply = {
    ...task("teacher-reply", "LP", "today", "今天 18:00"),
    ruleKey: "trial.jiaowubao.teacher-reply-4h",
    anchorBookingId: "JWB:evt-reply",
  };
  const html = render([teacherReply, task("ordinary", "LP", "today", "今天 19:00")]);
  assert.equal(html.match(/>老师已回</g)?.length, 1);
});

test("shows a parent-replied action only on executable parent follow-up chains", () => {
  const parentRules = [
    "trial.parent-follow-up",
    "trial.parent-no-reply-follow-up",
    "trial.teaching-control-escalation",
    "trial.parent-progress-sync.1",
  ];
  const parentTasks = parentRules.map((ruleKey, index) => ({
    ...task(`parent-${index}`, "试听", "today", "今天 18:00"),
    ruleKey,
    anchorBookingId: "LP-PARENT-REPLY",
  }));
  const frozenParentTask = {
    ...parentTasks[0]!,
    id: "parent-frozen",
    dueAt: undefined,
    legacyEvidence: {
      state: "frozen" as const,
      reason: "missing_canonical_due_at" as const,
      frozenAt: "2026-08-20T00:00:00.000Z",
    },
  };
  const html = render([...parentTasks, frozenParentTask, task("ordinary", "试听", "today", "今天 19:00")]);
  assert.equal(html.match(/>家长已回</g)?.length, 4);
  assert.doesNotMatch(html, /aria-label="家长已回：任务 parent-frozen"/);
  assert.match(html, /aria-label="家长已回：任务 parent-0"/);
});

test("keeps pending scheduling editable and cancellable without a manual completion button", () => {
  const pendingScheduling = {
    ...task("pending-scheduling", "排课", "today", "今天 18:00"),
    ruleKey: "trial.scheduling",
    anchorBookingId: "LP-PENDING-SCHEDULING",
  };
  const html = render([pendingScheduling]);

  assert.match(html, /aria-label="编辑备注：任务 pending-scheduling"/);
  assert.match(html, /aria-label="无法完成：任务 pending-scheduling"/);
  assert.doesNotMatch(html, /aria-label="完成：任务 pending-scheduling"/);
});

test("shows the note save date separately from the deadline, with the local year and time", () => {
  const saved = { ...task("noted", "LP", "today", "今天"), completionNote: "已联系家长", completionNoteUpdatedAt: "2026-12-31T14:30:00.000Z" };
  const html = render([saved]);
  assert.match(html, /class="task-note-date" dateTime="2026-12-31T14:30:00.000Z"/);
  assert.match(html, /备注于 2027年1月1日 01:30/);
  assert.match(html, />2026年8月12日<\/time>/);
  const twelveHour = render([saved], "all", "Asia/Shanghai", "12h");
  assert.match(twelveHour, /备注于 2026年12月31日 下午10:30/);
});

test("does not invent dates for legacy, cleared, or invalid task notes", () => {
  const base = task("legacy-note", "LP", "today", "今天");
  for (const note of [
    { completionNote: "历史备注" },
    { completionNote: undefined, completionNoteUpdatedAt: "2026-08-12T08:00:00.000Z" },
    { completionNote: "历史备注", completionNoteUpdatedAt: "not-a-date" },
  ]) assert.doesNotMatch(render([{ ...base, ...note }]), /task-note-date|备注于/);
});


test("shows the exact trial lesson instant separately from the task deadline in the selected timezone", () => {
  const trial = { ...task("lesson-clock", "试听", "upcoming", "", "2026-10-19T08:00:00.000Z"), ruleKey: "trial.prep", anchorBookingId: "SYNTH-BOOKING-1" };
  const schedule = () => ({ startsAt: "2026-10-20T13:30:00.000Z" });
  const melbourne = render([trial], "all", "Australia/Melbourne", "24h", false, schedule);
  assert.match(melbourne, /试听上课：<time dateTime="2026-10-20T13:30:00.000Z">2026年10月21日 00:30<\/time> · 墨尔本/);
  assert.match(melbourne, /class="due-label upcoming" dateTime="2026-10-19T08:00:00.000Z"/);
  const beijing = render([trial], "all", "Asia/Shanghai", "12h", false, schedule);
  assert.match(beijing, /试听上课：<time dateTime="2026-10-20T13:30:00.000Z">2026年10月20日 下午09:30<\/time> · 北京时间（中国）/);
});

test("does not show a trial lesson timestamp without a trusted schedule", () => {
  const trial = task("no-lesson", "试听", "upcoming", "今天");
  assert.doesNotMatch(render([trial]), /试听上课：/);
  assert.doesNotMatch(render([trial], "all", "Australia/Melbourne", "24h", false, () => null), /试听上课：/);
  assert.doesNotMatch(render([trial], "all", "Australia/Melbourne", "24h", false, () => ({ startsAt: "2026-10-21" })), /试听上课：/);
});


test("filters overdue, two-request-one-send and preparation actions separately", () => {
  const source = [
    { ...task("writing", "LP", "today", "今天"), ruleKey: "trial.manual-request.writing" },
    { ...task("check", "LP", "overdue", "昨天"), ruleKey: "trial.jiaowubao.request-follow-up-n3" },
    { ...task("prep", "LP", "today", "今天"), ruleKey: "trial.jiaowubao.prep-n1" },
    task("other", "LP", "overdue", "昨天"),
  ];
  const followUp = render(source, "parent-follow-up");
  assert.match(followUp, /任务 writing/);
  assert.match(followUp, /任务 check/);
  assert.doesNotMatch(followUp, /任务 prep|任务 other/);
  const preparation = render(source, "preparation");
  assert.match(preparation, /任务 prep/);
  assert.doesNotMatch(preparation, /任务 writing|任务 check|任务 other/);
  const overdue = render(source, "overdue");
  assert.match(overdue, /任务 check/);
  assert.match(overdue, /任务 other/);
  assert.doesNotMatch(overdue, /任务 writing|任务 prep/);
});


test("source-managed unclosed tasks expose lesson locators without manual lifecycle controls", () => {
  const item = { ...task("unclosed", "课后", "today", "", "2026-08-12T08:00:00.000Z"), ruleKey: "jiaowubao.unclosed", trigger: "2026-08-10 · 12345" };
  const html = render([item], "all");
  assert.match(html, /课节明细（日期 · 编号）/);
  assert.match(html, /2026-08-10 · 12345/);
  assert.doesNotMatch(html, /编辑备注：|无法完成：|aria-label="完成：|恢复到待办：|补截止时间/);
});
