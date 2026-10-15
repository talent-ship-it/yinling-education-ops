import { operationsOwnerFilterOptions, resolveAssignableOperationsOwner } from "./demo-users";

export interface OperationsReportTaskLike {
  owner: string;
  status: string;
}

export interface OperationsReportWorkloadRow {
  owner: string;
  count: number;
  widthPercent: number;
}

export function operationsReportOwnerOptions(
  baseOwners: readonly string[],
  tasks: readonly Pick<OperationsReportTaskLike, "owner">[],
) {
  return operationsOwnerFilterOptions([...baseOwners, ...tasks.map((task) => task.owner)]);
}

export function pendingOperationsTaskWorkload(
  tasks: readonly OperationsReportTaskLike[],
): OperationsReportWorkloadRow[] {
  const counts = new Map<string, number>();
  tasks.forEach((task) => {
    const owner = resolveAssignableOperationsOwner(task.owner) ?? task.owner.trim();
    if (!owner || task.status === "done") return;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  });

  const maximum = Math.max(0, ...counts.values());
  if (maximum === 0) return [];

  return Array.from(counts, ([owner, count]) => ({
    owner,
    count,
    widthPercent: Math.round((count / maximum) * 10_000) / 100,
  })).sort((left, right) => left.owner.localeCompare(right.owner));
}
