/** Bounded actor-scoped recovery envelope for ordinary LP commands. */
export const LP_ATOMIC_PENDING_NAMESPACE = "insider-leads:lp-atomic" as const;
export const LP_ATOMIC_PENDING_SCHEMA = 1 as const;
export const LP_ATOMIC_PENDING_LIMIT = 8;
const MAX_TEXT = 64_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type LpAtomicPendingEntry = Readonly<{ intent: string; commandIntent: string; commandKey: string; expectedVersions: Readonly<Record<"students" | "lpItems" | "tasks" | "files", number>> }>;
export type LpAtomicPendingStorage = Readonly<{ getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void }>;

function key(actor: string) { return `${LP_ATOMIC_PENDING_NAMESPACE}:v${LP_ATOMIC_PENDING_SCHEMA}:${encodeURIComponent(actor.trim().toLowerCase())}`; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, expected: readonly string[]) { const actual = Object.keys(value).sort(); const wanted = [...expected].sort(); return actual.length === wanted.length && actual.every((item, i) => item === wanted[i]); }
function validVersions(value: unknown): boolean { return record(value) && exact(value, ["students", "lpItems", "tasks", "files"]) && (["students", "lpItems", "tasks", "files"] as const).every((k) => Number.isSafeInteger(value[k]) && Number(value[k]) >= 1); }
function parseEntry(value: unknown): LpAtomicPendingEntry | null {
  if (!record(value) || !exact(value, ["intent", "commandIntent", "commandKey", "expectedVersions"]) || typeof value.intent !== "string" || typeof value.commandIntent !== "string" || value.intent.length < 1 || value.intent.length > MAX_TEXT || value.commandIntent.length < 1 || value.commandIntent.length > MAX_TEXT || typeof value.commandKey !== "string" || !UUID_V4.test(value.commandKey) || !validVersions(value.expectedVersions)) return null;
  try {
    const intent = JSON.parse(value.intent) as unknown;
    const commandIntent = JSON.parse(value.commandIntent) as unknown;
    if (!record(intent) || !record(commandIntent)
      || (!exact(commandIntent, ["operation", "studentId", "fields", "expectedVersions"])
        && !exact(commandIntent, ["operation", "studentId", "workflowType", "fields", "expectedVersions"])
        && !exact(commandIntent, ["operation", "provisionalIntake", "workflowType", "fields", "expectedVersions"])
        && !exact(commandIntent, ["operation", "studentId", "lpItemId", "fields", "expectedVersions"])
        && !exact(commandIntent, ["operation", "studentId", "lpItemId", "fields", "revisionNote", "expectedVersions"]))) return null;
    if (JSON.stringify(commandIntent.expectedVersions) !== JSON.stringify(value.expectedVersions)) return null;
    const draft = { ...commandIntent };
    delete draft.expectedVersions;
    if (JSON.stringify(draft) !== value.intent) return null;
  } catch { return null; }
  return { intent: value.intent, commandIntent: value.commandIntent, commandKey: value.commandKey, expectedVersions: value.expectedVersions as LpAtomicPendingEntry["expectedVersions"] };
}
function bounded(entries: Iterable<LpAtomicPendingEntry>) { const map = new Map<string, LpAtomicPendingEntry>(); for (const item of entries) { map.delete(item.intent); map.set(item.intent, item); } while (map.size > LP_ATOMIC_PENDING_LIMIT) map.delete(map.keys().next().value as string); return map; }
export function readLpAtomicPendingCommands(storage: LpAtomicPendingStorage | undefined, actor: string) { const result = new Map<string, LpAtomicPendingEntry>(); if (!storage || !actor.trim()) return result; try { const raw = storage.getItem(key(actor)); if (!raw) return result; if (raw.length > MAX_TEXT * LP_ATOMIC_PENDING_LIMIT) { storage.removeItem(key(actor)); return result; } const parsed = JSON.parse(raw) as unknown; if (!record(parsed) || parsed.namespace !== LP_ATOMIC_PENDING_NAMESPACE || parsed.schema !== LP_ATOMIC_PENDING_SCHEMA || !Array.isArray(parsed.entries) || parsed.entries.length > LP_ATOMIC_PENDING_LIMIT) { storage.removeItem(key(actor)); return result; } const entries = parsed.entries.map(parseEntry); if (entries.some((entry) => !entry) || new Set((entries as LpAtomicPendingEntry[]).map((entry) => entry.intent)).size !== entries.length || new Set((entries as LpAtomicPendingEntry[]).map((entry) => entry.commandKey)).size !== entries.length) { storage.removeItem(key(actor)); return result; } return bounded(entries as LpAtomicPendingEntry[]); } catch { return result; } }
export function persistLpAtomicPendingCommands(storage: LpAtomicPendingStorage | undefined, actor: string, entries: Iterable<LpAtomicPendingEntry>) { if (!storage || !actor.trim()) return; const boundedEntries = bounded(entries); const payload = JSON.stringify({ namespace: LP_ATOMIC_PENDING_NAMESPACE, schema: LP_ATOMIC_PENDING_SCHEMA, entries: [...boundedEntries.values()] }); if (payload.length > MAX_TEXT * LP_ATOMIC_PENDING_LIMIT) return; try { storage.setItem(key(actor), payload); } catch { /* in-memory retry remains authoritative for this page */ } }
export function upsertLpAtomicPendingCommand(entries: Iterable<LpAtomicPendingEntry>, entry: LpAtomicPendingEntry) { return bounded([...entries, entry]); }
export function removeLpAtomicPendingCommand(entries: Iterable<LpAtomicPendingEntry>, intent: string) { return bounded([...entries].filter((entry) => entry.intent !== intent)); }
export function clearLpAtomicPendingCommands(storage: LpAtomicPendingStorage | undefined, actor: string) { if (!storage || !actor.trim()) return; try { storage.removeItem(key(actor)); } catch { /* fail closed */ } }
