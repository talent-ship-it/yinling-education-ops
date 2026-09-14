"use client";

import React from "react";
import { Pencil, RotateCcw, X } from "lucide-react";

import { formatCompactTaskDeadline, isExecutableOpenTask, OpsTask, sortTasksByDueAt, statusForDueAt, taskTitlePresentation } from "../lib/ops-tasks";

export const TO_DO_FILTERS = ["all", "today", "试听", "排课", "LP", "考试", "续课", "请假代课"] as const;
export type ToDoFilter = (typeof TO_DO_FILTERS)[number];
export type TaskListView = "todo" | "done" | "cannot";
export type TaskDeadlineTimeZone = string;
export type TaskDeadlineTimeFormat = "24h" | "12h";

export interface ToDoListProps {
  tasks: OpsTask[];
  deadlineTimeZone: TaskDeadlineTimeZone;
  deadlineTimeZoneLabel: string;
  deadlineTimeFormat?: TaskDeadlineTimeFormat;
  taskTitle?: (task: OpsTask) => string;
  studentName: (studentId: string) => string | undefined;
  filter: ToDoFilter;
  onFilterChange: (filter: ToDoFilter) => void;
  onComplete: (taskId: string) => void;
  onCannotDo: (taskId: string, reason: string) => void;
  onReopen: (taskId: string) => void;
  onUpdateNote: (taskId: string, note: string) => void;
  onRepairDeadline?: (task: OpsTask) => void;
  canRepairDeadline?: (task: OpsTask) => boolean;
  onParentReplied?: (task: OpsTask) => void;
  onTeacherReplied?: (task: OpsTask) => void;
  onOpen: (task: OpsTask) => void;
  canOpen?: (task: OpsTask) => boolean;
  canReopen?: (task: OpsTask) => boolean;
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

const VIEW_LABELS: Record<TaskListView, string> = {
  todo: "To Do",
  done: "All Done",
  cannot: "Can’t Do",
};

function happenedToday(value: string | undefined, timeZone: TaskDeadlineTimeZone) {
  if (!value) return false;
  try {
    return statusForDueAt(value, new Date(), timeZone) === "today";
  } catch {
    return false;
  }
}

function filterTasks(tasks: readonly OpsTask[], filter: ToDoFilter, view: TaskListView, timeZone: TaskDeadlineTimeZone) {
  return tasks.filter((task) => {
    const inView = view === "todo"
      ? task.status !== "done"
      : view === "cannot"
        ? task.status === "done" && task.completionOutcome === "cannot_do"
        : task.status === "done" && task.completionOutcome !== "cannot_do";
    if (!inView) return false;
    return filter === "all"
      || (filter === "today"
        ? view === "todo" ? isExecutableOpenTask(task) && task.status === "today" : happenedToday(task.closedAt, timeZone)
        : task.category === filter);
  });
}

type Editor = Readonly<{ taskId: string; mode: "note" | "cannot"; value: string }>;

function TaskRows({
  tasks,
  view,
  studentName,
  onComplete,
  onCannotDo,
  onReopen,
  onUpdateNote,
  onRepairDeadline,
  canRepairDeadline,
  onParentReplied,
  onTeacherReplied,
  onOpen,
  canOpen,
  canReopen,
  deadlineTimeZone,
  deadlineTimeZoneLabel,
  taskTitle,
}: Pick<ToDoListProps, "studentName" | "onComplete" | "onCannotDo" | "onReopen" | "onUpdateNote" | "onRepairDeadline" | "canRepairDeadline" | "onParentReplied" | "onTeacherReplied" | "onOpen" | "canOpen" | "canReopen" | "deadlineTimeZone" | "deadlineTimeZoneLabel" | "taskTitle"> & { tasks: OpsTask[]; view: TaskListView }) {
  const [editor, setEditor] = React.useState<Editor | null>(null);

  const submitEditor = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor) return;
    const note = editor.value.trim();
    if (editor.mode === "cannot" && !note) return;
    if (editor.mode === "cannot") onCannotDo(editor.taskId, note);
    else onUpdateNote(editor.taskId, note);
    setEditor(null);
  };

  return (
    <div className="task-list" role="list">
      {tasks.map((task) => {
        const editing = editor?.taskId === task.id ? editor : null;
        const executable = isExecutableOpenTask(task);
        const displayTitle = taskTitle?.(task) ?? task.title;
        const title = taskTitlePresentation(displayTitle, task.ruleKey);
        const supportingCopy = title.details.length === 0 || task.completionNote
          ? `${title.details.length === 0 ? studentName(task.studentId) ?? "未关联学生" : ""}${task.completionNote ? `${title.details.length === 0 ? " · " : ""}${task.completionNote}` : ""}`
          : "";
        const copy = <>
          <strong>{title.primary}</strong>
          {title.details.length > 0 ? <small className="task-title-details">{title.details.join(" · ")}</small> : null}
          {supportingCopy ? <span>{supportingCopy}</span> : null}
        </>;
        return <div className={`task-row to-do-row ${task.status} ${task.completionOutcome ?? ""}`} role="listitem" key={task.id}>
          <span className={`task-dot ${task.tone}`} aria-hidden="true" />
          {canOpen?.(task) === false
            ? <span className="task-copy task-copy-static">
                {copy}
              </span>
            : <button className="task-copy" type="button" onClick={() => onOpen(task)}>
                {copy}
              </button>}
          <div className="task-row-actions">
            {view === "todo" && executable && onParentReplied && (task.ruleKey === "trial.parent-follow-up"
              || task.ruleKey === "trial.parent-no-reply-follow-up"
              || task.ruleKey === "trial.teaching-control-escalation"
              || task.ruleKey?.startsWith("trial.parent-progress-sync.")) ? <button
                className="compact-button reply-button"
                type="button"
                aria-label={`家长已回：${title.primary}`}
                onClick={() => onParentReplied(task)}
              >家长已回</button> : null}
            {view === "todo" && onTeacherReplied
              && (task.ruleKey === "trial.jiaowubao.teacher-reply-4h"
                || task.ruleKey === "trial.jiaowubao.teacher-reply-8h") ? <button
                className="compact-button reply-button"
                type="button"
                onClick={() => onTeacherReplied(task)}
              >老师已回</button> : null}
            <div className="task-action-icons">
            <button
              className="task-note-button"
              type="button"
              title="编辑任务备注"
              aria-label={`编辑备注：${title.primary}`}
              onClick={() => setEditor({ taskId: task.id, mode: "note", value: task.completionNote ?? "" })}
            ><Pencil size={14} /></button>
            {view === "todo" && executable ? <>
              <button
                className="cannot-do-button"
                type="button"
                title="无法完成"
                aria-label={`无法完成：${title.primary}`}
                onClick={() => setEditor({ taskId: task.id, mode: "cannot", value: "" })}
              ><X size={15} /></button>
              {task.ruleKey !== "trial.scheduling" ? <button
                className="complete-button"
                type="button"
                title="标记完成"
                aria-label={`完成：${title.primary}`}
                onClick={() => onComplete(task.id)}
              ><span aria-hidden="true">✓</span></button> : null}
            </> : view === "todo" ? onRepairDeadline && canRepairDeadline?.(task) !== false ? <button
              className="deadline-edit-button"
              type="button"
              onClick={() => onRepairDeadline(task)}
            >补时间</button> : null : canReopen?.(task) !== false ? <button
              className="reopen-task-button"
              type="button"
              title="恢复到 To Do"
              aria-label={`恢复到待办：${title.primary}`}
              onClick={() => onReopen(task.id)}
            ><RotateCcw size={14} /><span>恢复</span></button> : null}
            </div>
            {(() => {
              const deadline = formatCompactTaskDeadline(task.dueAt, deadlineTimeZone);
              if (deadline && task.dueAt) return <time
                className={`due-label ${task.status}`}
                dateTime={task.dueAt}
                aria-label={`截止 ${deadline}`}
                title={`截止：${deadline} · ${deadlineTimeZoneLabel}`}
              >{deadline}</time>;
              if (view === "todo" && !executable) return <span
                className="due-label pending"
                title="需要管理员补充准确截止时间后才可执行"
              >待补时间</span>;
              return null;
            })()}
          </div>
          {editing ? <form className="task-inline-editor" onSubmit={submitEditor}>
            <label>{editing.mode === "cannot" ? "无法完成原因（必填）" : "任务备注"}
              <textarea
                autoFocus
                maxLength={1000}
                rows={2}
                required={editing.mode === "cannot"}
                value={editing.value}
                onChange={(event) => setEditor({ ...editing, value: event.target.value })}
              />
            </label>
            <div><button className="secondary-button" type="button" onClick={() => setEditor(null)}>取消</button><button className="primary-button" type="submit">保存</button></div>
          </form> : null}
        </div>;
      })}
    </div>
  );
}

function TaskSection({
  title,
  className,
  ...props
}: Pick<ToDoListProps, "studentName" | "onComplete" | "onCannotDo" | "onReopen" | "onUpdateNote" | "onRepairDeadline" | "canRepairDeadline" | "onParentReplied" | "onTeacherReplied" | "onOpen" | "canOpen" | "canReopen" | "deadlineTimeZone" | "deadlineTimeZoneLabel" | "taskTitle"> & {
  title: string;
  className: string;
  tasks: OpsTask[];
  view: TaskListView;
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
  onCannotDo,
  onReopen,
  onUpdateNote,
  onRepairDeadline,
  canRepairDeadline,
  onParentReplied,
  onTeacherReplied,
  onOpen,
  canOpen,
  canReopen,
  deadlineTimeZone,
  deadlineTimeZoneLabel,
  taskTitle,
}: ToDoListProps) {
  const [view, setView] = React.useState<TaskListView>("todo");
  const filtered = filterTasks(tasks, filter, view, deadlineTimeZone);
  const pendingDeadline = sortTasksByDueAt(filtered.filter((task) => view === "todo" && !isExecutableOpenTask(task)));
  const actionable = view === "todo" ? filtered.filter(isExecutableOpenTask) : filtered;
  const today = sortTasksByDueAt(actionable.filter((task) => view !== "todo" || task.status === "today"));
  const overdue = sortTasksByDueAt(actionable.filter((task) => view === "todo" && task.status === "overdue"));
  const remaining = sortTasksByDueAt(actionable.filter((task) => view === "todo" && task.status !== "today" && task.status !== "overdue"));
  const rowProps = { studentName, onComplete, onCannotDo, onReopen, onUpdateNote, onRepairDeadline, canRepairDeadline, onParentReplied, onTeacherReplied, onOpen, canOpen, canReopen, deadlineTimeZone, deadlineTimeZoneLabel, taskTitle, view };

  return (
    <section className="panel task-panel to-do-list" aria-labelledby="to-do-list-title">
      <header className="panel-header to-do-header">
        <h2 className="visually-hidden" id="to-do-list-title">任务清单</h2>
        <div className="to-do-header-actions">
          <div className="segmented task-state-tabs" role="group" aria-label="任务状态">
            {(Object.keys(VIEW_LABELS) as TaskListView[]).map((value) => <button
              className={view === value ? "active" : ""}
              type="button"
              aria-pressed={view === value}
              key={value}
              onClick={() => setView(value)}
            >{VIEW_LABELS[value]} <strong>{filterTasks(tasks, "all", value, deadlineTimeZone).length}</strong></button>)}
          </div>
          <div className="segmented to-do-filters" role="group" aria-label="任务类别">
            {TO_DO_FILTERS.map((value) => (
              <button
                className={filter === value ? "active" : ""}
                type="button"
                aria-pressed={filter === value}
                key={value}
                onClick={() => onFilterChange(value)}
              >{FILTER_LABELS[value]}</button>
            ))}
          </div>
        </div>
      </header>

      <div id="to-do-list-content">
        {view === "todo" ? <>
          {today.length > 0 && <TaskSection title="今日到期" className="today" tasks={today} {...rowProps} />}
          {overdue.length > 0 && <TaskSection title="已逾期" className="overdue" tasks={overdue} {...rowProps} />}
          {remaining.length > 0 && <TaskSection title="其余任务" className="remaining" tasks={remaining} {...rowProps} />}
          {pendingDeadline.length > 0 && <TaskSection title="待补截止时间" className="pending-deadline" tasks={pendingDeadline} {...rowProps} />}
        </> : today.length > 0 ? <TaskSection title={view === "done" ? "已完成" : "无法完成"} className={view} tasks={today} {...rowProps} /> : null}
        {filtered.length === 0 && <div className="empty-inline" role="status" aria-live="polite">{view === "todo" ? "没有待处理事项" : view === "done" ? "还没有已完成任务" : "没有无法完成的任务"}</div>}
      </div>
    </section>
  );
}

export default ToDoList;
