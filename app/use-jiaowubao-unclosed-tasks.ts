"use client";

import { useEffect, useState } from "react";
import { isCanonicalTaskDueAt, type OpsTask } from "@/lib/ops-tasks";
import { createSharedStatePoller, watchVisibleSharedStatePoller } from "@/lib/shared-state-poller";
import { fetchJsonWithTimeout } from "@/lib/shared-state-recovery";

function readTasks(value: unknown): OpsTask[] {
  if (!Array.isArray(value) || value.length > 7) throw new Error("invalid_unclosed_tasks");
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("invalid_unclosed_task");
    const task = candidate as OpsTask;
    if (task.ruleKey !== "jiaowubao.unclosed" || !isCanonicalTaskDueAt(task.dueAt)
      || ![task.id, task.owner, task.studentId, task.title].every((field) => typeof field === "string" && field.length <= 240)) throw new Error("invalid_unclosed_task");
    return task;
  });
}

export function useJiaowubaoUnclosedTasks(active: boolean, operator: string, allOwners: boolean) {
  const [feed, setFeed] = useState<{ operator: string; tasks: OpsTask[]; error: boolean }>({ operator: "", tasks: [], error: false });
  useEffect(() => {
    if (!active) return;
    const poller = createSharedStatePoller({
      canRun: () => !document.hidden,
      successDelayMs: 60_000,
      onError: () => setFeed((current) => ({ operator, tasks: current.operator === operator ? current.tasks : [], error: true })),
      run: async (signal) => {
        const { response, body } = await fetchJsonWithTimeout<{ tasks: unknown }>(fetch, "/api/jiaowubao-open-api/unclosed-tasks", { cache: "no-store", signal });
        if (!response.ok || !body) throw new Error("unclosed_tasks_unavailable");
        const tasks = readTasks(body.tasks);
        if (!signal.aborted) setFeed({ operator, tasks, error: false });
      },
    });
    return watchVisibleSharedStatePoller(poller, document, window);
  }, [active, operator]);
  const tasks = feed.operator === operator ? feed.tasks : [];
  return { tasks: allOwners ? tasks : tasks.filter((task) => task.owner === operator), error: feed.operator === operator && feed.error };
}
