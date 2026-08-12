"use client";

import React from "react";

import { OpsTask, sortTasksByDueAt } from "../lib/ops-tasks";

export const TO_DO_FILTERS = ["all", "LP", "考试", "续课", "请假代课"] as const;
export type ToDoFilter = (typeof TO_DO_FILTERS)[number];

export interface ToDoListProps {
  tasks: OpsTask[];
  studentName: (studentId: string) => string | undefined;
  filter: ToDoFilter;
  onFilterChange: (filter: ToDoFilter) => void;
  onComplete: (taskId: string) => void;
  onOpen: (task: OpsTask) => void;
}

const FILTER_LABELS: Record<ToDoFilter, string> = {
  all: "全部",
  LP: "LP",
  考试: "考试",
  续课: "续课",
  请假代课: "请假代课",
};

function filterTasks(tasks: readonly OpsTask[], filter: ToDoFilter) {
  return tasks.filter((task) => task.status !== "done" && (filter === "all" || task.category === filter));
}

function TaskRows({
  tasks,
  studentName,
  onComplete,
  onOpen,
}: Pick<ToDoListProps, "studentName" | "onComplete" | "onOpen"> & { tasks: OpsTask[] }) {
  return (
    <div className="task-list">
      {tasks.map((task) => (
        <div className={`task-row to-do-row ${task.status}`} key={task.id}>
          <span className={`task-dot ${task.tone}`} aria-hidden="true" />
          <button className="task-copy" type="button" onClick={() => onOpen(task)}>
            <strong>{task.title}</strong>
            <span>
              {studentName(task.studentId) ?? "未关联学生"} · {task.owner}
            </span>
          </button>
          <span className={`due-label ${task.status}`}>{task.due}</span>
          <button
            className="complete-button"
            type="button"
            title="标记完成"
            aria-label={`完成：${task.title}`}
            onClick={() => onComplete(task.id)}
          >
            <span aria-hidden="true">✓</span>
          </button>
        </div>
      ))}
    </div>
  );
}

function TaskSection({
  title,
  className,
  ...props
}: Pick<ToDoListProps, "studentName" | "onComplete" | "onOpen"> & {
  title: string;
  className: string;
  tasks: OpsTask[];
}) {
  return (
    <section className={`to-do-section ${className}`} aria-labelledby={`to-do-${className}`}>
      <header className="panel-header to-do-section-header">
        <h2 id={`to-do-${className}`}>{title}</h2>
        <strong>{props.tasks.length}</strong>
      </header>
      <TaskRows {...props} />
    </section>
  );
}

export function ToDoList({ tasks, studentName, filter, onFilterChange, onComplete, onOpen }: ToDoListProps) {
  const filtered = filterTasks(tasks, filter);
  const today = sortTasksByDueAt(filtered.filter((task) => task.status === "today"));
  const overdue = sortTasksByDueAt(filtered.filter((task) => task.status === "overdue"));
  const remaining = sortTasksByDueAt(
    filtered.filter((task) => task.status !== "today" && task.status !== "overdue"),
  );
  const rowProps = { studentName, onComplete, onOpen };

  return (
    <section className="panel task-panel to-do-list" aria-label="To Do List">
      <header className="panel-header to-do-header">
        <h2>To Do List</h2>
        <div className="segmented to-do-filters" role="group" aria-label="任务类别">
          {TO_DO_FILTERS.map((value) => (
            <button
              className={filter === value ? "active" : ""}
              type="button"
              aria-pressed={filter === value}
              key={value}
              onClick={() => onFilterChange(value)}
            >
              {FILTER_LABELS[value]}
            </button>
          ))}
        </div>
      </header>

      {today.length > 0 && <TaskSection title="今日到期" className="today" tasks={today} {...rowProps} />}
      {overdue.length > 0 && <TaskSection title="已逾期" className="overdue" tasks={overdue} {...rowProps} />}
      {remaining.length > 0 && <TaskSection title="其余任务" className="remaining" tasks={remaining} {...rowProps} />}
      {filtered.length === 0 && <div className="empty-inline">没有待处理事项</div>}
    </section>
  );
}

export default ToDoList;
