import { normaliseDemoUserName, resolveDemoStaffAlias } from "./demo-users";
import { TRIAL_OPERATIONS } from "./lp-workflows";
import type { OpsTask } from "./ops-tasks";

export interface TaskOwnerGroup {
  key: string;
  owner: string;
  mark: string;
  tasks: OpsTask[];
}

function ownerMark(owner: string) {
  const words = owner.split(/\s+/);
  return (words.length > 1
    ? words.map((word) => Array.from(word)[0]).join("")
    : Array.from(owner).slice(0, 2).join("")).toLocaleUpperCase("en-AU");
}

export function groupTasksByOwner(tasks: readonly OpsTask[]): TaskOwnerGroup[] {
  const groups = new Map<string, TaskOwnerGroup>();
  for (const owner of TRIAL_OPERATIONS) {
    const key = normaliseDemoUserName(owner);
    groups.set(key, { key, owner, mark: ownerMark(owner), tasks: [] });
  }

  for (const task of tasks) {
    const rawOwner = typeof task.owner === "string" ? task.owner : "";
    const alias = resolveDemoStaffAlias(rawOwner);
    const normalizedOwner = normaliseDemoUserName(alias ?? rawOwner);
    const owner = TRIAL_OPERATIONS.find((candidate) => normaliseDemoUserName(candidate) === normalizedOwner) ?? "待分配";
    const key = normaliseDemoUserName(owner);
    const group = groups.get(key);
    if (group) group.tasks.push(task);
    else groups.set(key, { key, owner, mark: ownerMark(owner), tasks: [task] });
  }
  const result = [...groups.values()].sort((left, right) => left.owner.localeCompare(right.owner, "zh-CN"));
  const markCounts = new Map<string, number>();
  for (const group of result) markCounts.set(group.mark, (markCounts.get(group.mark) ?? 0) + 1);
  return result.map((group) => (markCounts.get(group.mark) ?? 0) > 1 ? { ...group, mark: group.owner } : group);
}
