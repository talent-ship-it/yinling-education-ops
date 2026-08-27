"use client";

import React from "react";
import { ChevronDown, ChevronUp, Pencil, RotateCcw, X } from "lucide-react";

import { formatTaskDeadline, isExecutableOpenTask, OpsTask, sortTasksByDueAt } from "../lib/ops-tasks";

export const TO_DO_FILTERS = ["all", "today", "试听", "排课", "LP", "考试", "续课", "请假代课"] as const;
export type ToDoFilter = (typeof TO_DO_FILTERS)[number];
export type TaskListView = "todo" | "done" | "cannot";

export interface ToDoListProps {
  tasks: OpsTask[];
  studentName: (studentId: string) => string | undefined;
  filter: ToDoFilter;
  onFilterChange: (filter: ToDoFilter) => void;
  onComplete: (taskId: string) => void;
  onCannotDo: (taskId: string, reason: string) => void;
  onReopen: (taskId: string) => void;
  onUpdateNote: (taskId: string, note: string) => void;
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

const VIEW_LABELS: Record<TaskListView, string> = {
  todo: "To Do",
  done: "All Done",
  cannot: "Can’t Do",
};

function happenedToday(value: string | undefined) {
  if (!value) return false;
  const date = new Date(value);
  const today = new Date();
  return Number.isFinite(date.valueOf()) && date.toDateString() === today.toDateString();
}

function filterTasks(tasks: readonly OpsTask[], filter: ToDoFilter, view: TaskListView) {
  return tasks.filter((task) => {
    const inView = view === "todo"
      ? isExecutableOpenTask(task)
      : view === "cannot"
        ? task.status === "done" && task.completionOutcome === "cannot_do"
        : task.status === "done" && task.completionOutcome !== "cannot_do";
    if (!inView) return false;
    return filter === "all"
      || (filter === "today" ? view === "todo" ? task.status === "today" : happenedToday(task.closedAt) : task.category === filter);
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
  onParentReplied,
  onOpen,
  canOpen,
}: Pick<ToDoListProps, "studentName" | "onComplete" | "onCannotDo" | "onReopen" | "onUpdateNote" | "onParentReplied" | "onOpen" | "canOpen"> & { tasks: OpsTask[]; view: TaskListView }) {
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
        return <div className={`task-row to-do-row ${task.status} ${task.completionOutcome ?? ""}`} role="listitem" key={task.id}>
          <span className={`task-dot ${task.tone}`} aria-hidden="true" />
          {canOpen?.(task) === false
            ? <span className="task-copy task-copy-static">
                <strong>{task.title}</strong>
                <span>{studentName(task.studentId) ?? "未关联学生"}{task.completionNote ? ` · ${task.completionNote}` : ""}</span>
              </span>
            : <button className="task-copy" type="button" onClick={() => onOpen(task)}>
                <strong>{task.title}</strong>
                <span>{studentName(task.studentId) ?? "未关联学生"}{task.completionNote ? ` · ${task.completionNote}` : ""}</span>
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
            {view === "todo" && onParentReplied && (task.ruleKey === "trial.parent-follow-up"
              || task.ruleKey === "trial.parent-no-reply-follow-up"
              || task.ruleKey === "trial.teaching-control-escalation"
              || task.ruleKey?.startsWith("trial.parent-progress-sync.")) ? <button
                className="compact-button reply-button"
                type="button"
                onClick={() => onParentReplied(task)}
              >家长已回</button> : null}
            <button
              className="task-note-button"
              type="button"
              title="编辑任务备注"
              aria-label={`编辑备注：${task.title}`}
              onClick={() => setEditor({ taskId: task.id, mode: "note", value: task.completionNote ?? "" })}
            ><Pencil size={14} /></button>
            {view === "todo" ? <>
              <button
                className="cannot-do-button"
                type="button"
                title="无法完成"
                aria-label={`无法完成：${task.title}`}
                onClick={() => setEditor({ taskId: task.id, mode: "cannot", value: "" })}
              ><X size={15} /></button>
              <button
                className="complete-button"
                type="button"
                title="标记完成"
                aria-label={`完成：${task.title}`}
                onClick={() => onComplete(task.id)}
              ><span aria-hidden="true">✓</span></button>
            </> : <button
              className="reopen-task-button"
              type="button"
              title="恢复到 To Do"
              aria-label={`恢复到待办：${task.title}`}
              onClick={() => onReopen(task.id)}
            ><RotateCcw size={14} /><span>恢复</span></button>}
          </div>
          {editing ? <form className="task-inline-editor" onSubmit={submitEditor}>
            <label>{editing.mode === "cannot" ? "无法完成原因（必填）" : "任务备注"}
              <textarea
                autoFocus
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
}: Pick<ToDoListProps, "studentName" | "onComplete" | "onCannotDo" | "onReopen" | "onUpdateNote" | "onParentReplied" | "onOpen" | "canOpen"> & {
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
  onParentReplied,
  onOpen,
  canOpen,
}: ToDoListProps) {
  const [expanded, setExpanded] = React.useState(true);
  const [view, setView] = React.useState<TaskListView>("todo");
  const filtered = filterTasks(tasks, filter, view);
  const today = sortTasksByDueAt(filtered.filter((task) => view !== "todo" || task.status === "today"));
  const overdue = sortTasksByDueAt(filtered.filter((task) => view === "todo" && task.status === "overdue"));
  const remaining = sortTasksByDueAt(filtered.filter((task) => view === "todo" && task.status !== "today" && task.status !== "overdue"));
  const rowProps = { studentName, onComplete, onCannotDo, onReopen, onUpdateNote, onParentReplied, onOpen, canOpen, view };

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
            >{VIEW_LABELS[value]} <strong>{filterTasks(tasks, "all", value).length}</strong></button>)}
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
          <button
            className="to-do-collapse-button"
            type="button"
            aria-expanded={expanded}
            aria-controls="to-do-list-content"
            onClick={() => setExpanded((current) => !current)}
          ><span>{expanded ? "收起" : "展开"}</span>{expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}</button>
        </div>
      </header>

      <div id="to-do-list-content" hidden={!expanded}>
        {view === "todo" ? <>
          {today.length > 0 && <TaskSection title="今日到期" className="today" tasks={today} {...rowProps} />}
          {overdue.length > 0 && <TaskSection title="已逾期" className="overdue" tasks={overdue} {...rowProps} />}
          {remaining.length > 0 && <TaskSection title="其余任务" className="remaining" tasks={remaining} {...rowProps} />}
        </> : today.length > 0 ? <TaskSection title={view === "done" ? "已完成" : "无法完成"} className={view} tasks={today} {...rowProps} /> : null}
        {filtered.length === 0 && <div className="empty-inline" role="status" aria-live="polite">{view === "todo" ? "没有待处理事项" : view === "done" ? "还没有已完成任务" : "没有无法完成的任务"}</div>}
      </div>
    </section>
  );
}

export default ToDoList;
