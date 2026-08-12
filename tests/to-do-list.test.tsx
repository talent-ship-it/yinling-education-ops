import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToDoList, ToDoFilter } from "../app/to-do-list";
import { OpsTask, TaskCategory, TaskStatus } from "../lib/ops-tasks";

function task(
  id: string,
  category: TaskCategory,
  status: TaskStatus,
  due: string,
  dueAt?: string,
): OpsTask {
  return {
    id,
    title: `任务 ${id}`,
    owner: "Abby",
    studentId: `STU-${id}`,
    due,
    dueAt,
    status,
    tone: status === "overdue" ? "red" : status === "today" ? "amber" : "blue",
    category,
    trigger: "不应渲染的解释文字",
  };
}

function render(tasks: OpsTask[], filter: ToDoFilter = "all") {
  return renderToStaticMarkup(
    <ToDoList
      tasks={tasks}
      studentName={(studentId) => `学生 ${studentId}`}
      filter={filter}
      onFilterChange={() => undefined}
      onComplete={() => undefined}
      onOpen={() => undefined}
    />,
  );
}

test("renders the five compact category tabs and marks the controlled filter", () => {
  const html = render([], "考试");
  for (const label of ["全部", "LP", "考试", "续课", "请假代课"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, /aria-label="任务类别"/);
  assert.match(html, /class="active" type="button" aria-pressed="true">考试</);
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
    "任务 legacy",
  ].map((text) => html.indexOf(text));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

test("shows the real due field and omits trigger/explanatory copy", () => {
  const html = render([task("due", "LP", "today", "试听前 N-3 · 18:00", "2026-08-12T08:00:00.000Z")]);
  assert.match(html, />试听前 N-3 · 18:00</);
  assert.doesNotMatch(html, /不应渲染的解释文字/);
  assert.doesNotMatch(html, /<small/);
  assert.match(html, /学生 STU-due · Abby/);
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

test("renders a concise empty state without explanatory copy", () => {
  const html = render([], "all");
  assert.match(html, /没有待处理事项/);
  assert.doesNotMatch(html, /调整|筛选下|请调整/);
});
