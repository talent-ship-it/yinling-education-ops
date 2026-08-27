export type OpsSourceLifecycleRow = Readonly<{
  status: string;
  synced_at: string;
}>;

const ARCHIVED_SOURCE_STATUSES = new Set(["archived", "retired", "superseded"]);

/** Historical mirrors stay readable for audit, but never count as live syncs. */
export function opsSourceIsArchived(source: OpsSourceLifecycleRow) {
  return ARCHIVED_SOURCE_STATUSES.has(source.status.trim().toLowerCase());
}

export function opsSourceIsStale(source: OpsSourceLifecycleRow, now = Date.now()) {
  if (opsSourceIsArchived(source)) return false;
  const syncedAt = new Date(source.synced_at).getTime();
  return !Number.isFinite(syncedAt) || now - syncedAt > 36 * 60 * 60 * 1000;
}

export function partitionOpsSources<T extends OpsSourceLifecycleRow>(sources: readonly T[]) {
  const active: T[] = [];
  const archived: T[] = [];
  for (const source of sources) {
    (opsSourceIsArchived(source) ? archived : active).push(source);
  }
  return { active, archived } as const;
}
