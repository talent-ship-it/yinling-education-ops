"use client";

import React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { formatTaskDeadline, isExecutableOpenTask, OpsTask, sortTasksByDueAt } from "../lib/ops-tasks";

export const TO_DO_FILTERS = ["all", "today", "试听", "排课", "LP", "考试", "续课", "请假代课"] as const;
export type ToDoFilter = (typeof TO_DO_FILTERS)[number];

export interface ToDoListProps {
  tasks: OpsTask[];
  studentName: (studentId: string) => string | undefined;
  filter: ToDoFilter;
  onFilterChange: (filter: ToDoFilter) => void;
  onComplete: (taskId: string) => void;
  onParentReplied?: (task: OpsTask) => void;
  onOpen: (task: OpsTask) => void;
  canOpen?: (task: OpsTask) => boolean;
}

const FILTER_LABELS: Record<ToDoFilter, string> = {
  all: "全部",
  today: "今日",
  试听: "试听",
  排课: "排课",
  LP: "LP",
  考试: "考试",
  续课: "续课",
  请假代课: "请假代课",
};

function filterTasks(tasks: readonly OpsTask[], filter: ToDoFilter) {
  return tasks.filter((task) => isExecutableOpenTask(task)
    && (filter === "all" || (filter === "today" ? task.status === "today" : task.category === filter)));
}

function TaskRows({
  tasks,
  studentName,
  onComplete,
  onParentReplied,
  onOpen,
  canOpen,
}: Pick<ToDoListProps, "studentName" | "onComplete" | "onParentReplied" | "onOpen" | "canOpen"> & { tasks: OpsTask[] }) {
  return (
    <div className="task-list" role="list">
      {tasks.map((task) => (
        <div className={`task-row to-do-row ${task.status}`} role="listitem" key={task.id}>
          <span className={`task-dot ${task.tone}`} aria-hidden="true" />
          {canOpen?.(task) === false
            ? <span className="task-copy task-copy-static">
                <strong>{task.title}</strong>
                <span>{studentName(task.studentId) ?? "未关联学生"}</span>
              </span>
            : <button className="task-copy" type="button" onClick={() => onOpen(task)}>
                <strong>{task.title}</strong>
                <span>{studentName(task.studentId) ?? "未关联学生"}</span>
              </button>}
          {(() => {
            const deadline = formatTaskDeadline(task.dueAt);
            if (deadline && task.dueAt) return <time
              className={`due-label ${task.status}`}
              dateTime={task.dueAt}
              title={`截止：${deadline}（墨尔本时间）`}
            >截止 {deadline}</time>;
            return null;
          })()}
          <div className="task-row-actions">
            {onParentReplied && (task.ruleKey === "trial.parent-follow-up"
              || task.ruleKey === "trial.parent-no-reply-follow-up"
              || task.ruleKey === "trial.teaching-control-escalation"
              || task.ruleKey?.startsWith("trial.parent-progress-sync.")) ? <button
                className="compact-button reply-button"
                type="button"
                onClick={() => onParentReplied(task)}
              >家长已回</button> : null}
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
        </div>
      ))}
    </div>
  );
}

function TaskSection({
  title,
  className,
  ...props
}: Pick<ToDoListProps, "studentName" | "onComplete" | "onParentReplied" | "onOpen" | "canOpen"> & {
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

export function ToDoList({
  tasks,
  studentName,
  filter,
  onFilterChange,
  onComplete,
  onParentReplied,
  onOpen,
  canOpen,
}: ToDoListProps) {
  const [expanded, setExpanded] = React.useState(true);
  const filtered = filterTasks(tasks, filter);
  const today = sortTasksByDueAt(filtered.filter((task) => task.status === "today"));
  const overdue = sortTasksByDueAt(filtered.filter((task) => task.status === "overdue"));
  const remaining = sortTasksByDueAt(
    filtered.filter((task) => task.status !== "today" && task.status !== "overdue"),
  );
  const rowProps = { studentName, onComplete, onParentReplied, onOpen, canOpen };

  return (
    <section className="panel task-panel to-do-list" aria-labelledby="to-do-list-title">
      <header className="panel-header to-do-header">
        <h2 className="visually-hidden" id="to-do-list-title">待办任务</h2>
        <div className="to-do-header-actions">
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
          <button
            className="to-do-collapse-button"
            type="button"
            aria-expanded={expanded}
            aria-controls="to-do-list-content"
            onClick={() => setExpanded((current) => !current)}
          >
            <span>{expanded ? "收起" : "展开"}</span>
            {expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          </button>
        </div>
      </header>

      <div id="to-do-list-content" hidden={!expanded}>
        {today.length > 0 && <TaskSection title="今日到期" className="today" tasks={today} {...rowProps} />}
        {overdue.length > 0 && <TaskSection title="已逾期" className="overdue" tasks={overdue} {...rowProps} />}
        {remaining.length > 0 && <TaskSection title="其余任务" className="remaining" tasks={remaining} {...rowProps} />}
        {filtered.length === 0 && <div className="empty-inline" role="status" aria-live="polite">没有待处理事项</div>}
      </div>
    </section>
  );
}

export default ToDoList;
