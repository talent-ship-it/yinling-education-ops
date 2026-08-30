import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToDoList, type TaskDeadlineTimeZone, type ToDoFilter } from "../app/to-do-list";
import { timezoneLabelFor } from "../lib/display-preferences";
import { OpsTask, TaskCategory, TaskStatus } from "../lib/ops-tasks";

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
) {
  return renderToStaticMarkup(
    <ToDoList
      tasks={tasks}
      deadlineTimeZone={deadlineTimeZone}
      deadlineTimeZoneLabel={timezoneLabelFor(deadlineTimeZone, "zh-CN")}
      deadlineTimeFormat={deadlineTimeFormat}
      studentName={(studentId) => `学生 ${studentId}`}
      filter={filter}
      onFilterChange={() => undefined}
      onComplete={() => undefined}
      onCannotDo={() => undefined}
      onReopen={() => undefined}
      onUpdateNote={() => undefined}
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

test("renders the today and category tabs, marks the controlled filter, and exposes the collapse control", () => {
  const html = render([], "考试");
  for (const label of ["全部", "今日", "LP", "考试", "续课", "请假代课"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /aria-label="任务类别"/);
  for (const label of ["To Do", "All Done", "Can’t Do"]) assert.match(html, new RegExp(label));
  assert.match(html, /aria-label="任务状态"/);
  assert.match(html, /class="active" type="button" aria-pressed="true">考试</);
  assert.match(html, /aria-expanded="true" aria-controls="to-do-list-content">/);
  assert.match(html, />收起</);
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
    "已逾期",
    "任务 overdue-earlier",
    "任务 overdue-later",
    "其余任务",
    "任务 remaining-earlier",
    "任务 remaining-later",
  ].map((text) => html.indexOf(text));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

test("shows the canonical deadline as an exact date and time, not legacy workflow copy", () => {
  const html = render([task("due", "LP", "today", "试听前 N-3 · 18:00", "2026-08-12T08:00:00.000Z")]);
  assert.match(html, />截止 2026年8月12日 18:00</);
  assert.match(html, /<time[^>]+dateTime="2026-08-12T08:00:00\.000Z"/);
  assert.match(html, /title="截止：2026年8月12日 18:00 · 墨尔本"/);
  assert.doesNotMatch(html, /试听前 N-3/);
  assert.doesNotMatch(html, /不应渲染的解释文字/);
  assert.doesNotMatch(html, /<small/);
  assert.match(html, /学生 STU-due/);
  assert.doesNotMatch(html, /Abby/);
});

test("renders the same deadline instant in Beijing for operations and Melbourne for teaching control", () => {
  const deadline = "2026-08-12T14:30:00.000Z";
  const operations = render([task("beijing", "试听", "today", "legacy", deadline)], "all", "Asia/Shanghai");
  const teachingControl = render([task("melbourne", "试听", "today", "legacy", deadline)], "all", "Australia/Melbourne");

  assert.match(operations, />截止 2026年8月12日 22:30</);
  assert.match(operations, /title="截止：2026年8月12日 22:30 · 北京时间（中国）"/);
  assert.match(teachingControl, />截止 2026年8月13日 00:30</);
  assert.match(teachingControl, /title="截止：2026年8月13日 00:30 · 墨尔本"/);
  const twelveHour = render([task("twelve-hour", "试听", "today", "legacy", deadline)], "all", "Asia/Shanghai", "12h");
  assert.match(twelveHour, />截止 2026年8月12日 下午10:30</);
});

test("does not present a descriptive legacy due string as an exact deadline", () => {
  const html = render([task("unknown", "LP", "today", "发布后立即")]);
  assert.match(html, /没有待处理事项/);
  assert.doesNotMatch(html, /发布后立即/);
});

test("does not expose manual deadline repair controls in To Do List", () => {
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
  assert.doesNotMatch(html, /补时间/);
  assert.doesNotMatch(html, /补充截止时间/);
  assert.doesNotMatch(html, /调整截止时间/);
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
  assert.match(html, /<span class="task-copy task-copy-static"><strong>任务 managed-exam<\/strong>/);
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
