type AuditRecord = { actor: string; action: string; detail: string; tone: string };

/** Keep tab counts global while filtering the export and visible page together. */
export function buildAuditView<T extends AuditRecord>(
  entries: readonly T[], query: string, filter: string, page: number,
  actorLabel: (actor: string) => string,
) {
  const needle = query.trim().toLowerCase();
  const counts = { all: entries.length, manual: 0, system: 0, amber: 0 };
  const filtered: T[] = [];
  for (const entry of entries) {
    const system = entry.actor === "系统";
    const attention = entry.tone === "amber" || entry.tone === "red";
    counts[system ? "system" : "manual"]++;
    if (attention) counts.amber++;
    const matchesFilter = filter === "all" || (filter === "system" ? system
      : filter === "manual" ? !system : filter === "amber" ? attention : entry.tone === filter);
    if (matchesFilter && `${actorLabel(entry.actor)} ${entry.actor} ${entry.action} ${entry.detail}`.toLowerCase().includes(needle)) {
      filtered.push(entry);
    }
  }
  const pageSize = 8;
  const safePage = Math.max(1, Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize))));
  return { counts, filtered, pageSize, safePage, paged: filtered.slice((safePage - 1) * pageSize, safePage * pageSize) };
}
