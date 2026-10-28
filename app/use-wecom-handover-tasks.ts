"use client";

import { useEffect, useState } from "react";
import { isCanonicalTaskDueAt, type OpsTask } from "@/lib/ops-tasks";
import type { TaskTrialSchedule } from "@/lib/task-trial-schedule";

type Feed = { tasks: OpsTask[]; students: { id: string; name: string }[]; schedules: (TaskTrialSchedule & { taskId: string })[] };
const EMPTY: Feed = { tasks: [], students: [], schedules: [] };
function readFeed(body: Feed): Feed {
  if (!Array.isArray(body.tasks) || !Array.isArray(body.students) || !Array.isArray(body.schedules)
    || !body.tasks.every((task) => task.studentId?.startsWith("WECOM:") && isCanonicalTaskDueAt(task.dueAt))) throw new Error("invalid_handover_tasks");
  return body;
}
export function useWecomHandoverTasks(active: boolean, operator: string, allOwners: boolean) {
  const [state, setState] = useState<{ operator: string; feed: Feed; error: boolean }>({ operator: "", feed: EMPTY, error: false });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const response = await fetch("/api/operations/wecom-handover-tasks", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("handover_tasks_unavailable");
        const feed = readFeed(await response.json());
        if (!controller.signal.aborted) setState({ operator, feed, error: false });
      } catch {
        if (!controller.signal.aborted) setState((prior) => ({ operator, feed: prior.operator === operator ? prior.feed : EMPTY, error: true }));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void read(), 60_000);
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, operator]);
  const mutate = async (taskId: string, action: "complete" | "reopen" | "cannot" | "note", note?: string) => {
    const response = await fetch("/api/operations/wecom-handover-tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId, action, ...(note === undefined ? {} : { note }) }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "交接任务保存失败");
    setState({ operator, feed: readFeed(body), error: false });
  };
  const feed = state.operator === operator ? state.feed : EMPTY;
  return { ...feed, tasks: allOwners ? feed.tasks : feed.tasks.filter((task) => task.owner === operator),
    error: state.operator === operator && state.error, mutate };
}
