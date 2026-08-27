export const TRIAL_PAYMENT_PENDING_NAMESPACE = "insider-leads:trial-payment" as const;
export const TRIAL_PAYMENT_PENDING_SCHEMA = 1 as const;
export const TRIAL_PAYMENT_PENDING_LIMIT = 16;

const MAX_STORAGE_LENGTH = 32_000;
const COMMAND_KEY = /^trial-payment-complete:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const VERSION_ENTITIES = ["bookings", "students", "lpItems", "tasks", "teachers"] as const;

export type TrialPaymentExpectedVersions = Readonly<Record<(typeof VERSION_ENTITIES)[number], number>>;

export type TrialPaymentPendingCommand = Readonly<{
  taskId: string;
  commandKey: string;
  expectedVersions: TrialPaymentExpectedVersions;
}>;

export type TrialPaymentPendingStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseEntry(value: unknown): TrialPaymentPendingCommand | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ["taskId", "commandKey", "expectedVersions"])
    || typeof value.taskId !== "string" || !TASK_ID.test(value.taskId)
    || typeof value.commandKey !== "string" || !COMMAND_KEY.test(value.commandKey)
    || !isRecord(value.expectedVersions)) return null;
  const expectedVersions = value.expectedVersions;
  if (!hasExactKeys(expectedVersions, VERSION_ENTITIES)
    || !VERSION_ENTITIES.every((entity) => Number.isSafeInteger(expectedVersions[entity])
      && (expectedVersions[entity] as number) >= 1)) return null;
  return {
    taskId: value.taskId,
    commandKey: value.commandKey,
    expectedVersions: Object.fromEntries(VERSION_ENTITIES.map((entity) => [
      entity,
      expectedVersions[entity] as number,
    ])) as TrialPaymentExpectedVersions,
  };
}

function storageKey(actor: string) {
  return `${TRIAL_PAYMENT_PENDING_NAMESPACE}:v${TRIAL_PAYMENT_PENDING_SCHEMA}:${encodeURIComponent(actor.trim().toLocaleLowerCase())}`;
}

function boundedMap(entries: Iterable<TrialPaymentPendingCommand>) {
  const result = new Map<string, TrialPaymentPendingCommand>();
  for (const entry of entries) {
    result.delete(entry.taskId);
    result.set(entry.taskId, entry);
  }
  while (result.size > TRIAL_PAYMENT_PENDING_LIMIT) {
    const oldest = result.keys().next().value;
    if (typeof oldest !== "string") break;
    result.delete(oldest);
  }
  return result;
}

export function readTrialPaymentPendingCommands(
  storage: TrialPaymentPendingStorage | undefined,
  actor: string,
) {
  const empty = new Map<string, TrialPaymentPendingCommand>();
  if (!storage || !actor.trim()) return empty;
  const key = storageKey(actor);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return empty;
    if (raw.length > MAX_STORAGE_LENGTH) {
      storage.removeItem(key);
      return empty;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)
      || !hasExactKeys(parsed, ["namespace", "schema", "entries"])
      || parsed.namespace !== TRIAL_PAYMENT_PENDING_NAMESPACE
      || parsed.schema !== TRIAL_PAYMENT_PENDING_SCHEMA
      || !Array.isArray(parsed.entries)
      || parsed.entries.length > TRIAL_PAYMENT_PENDING_LIMIT) {
      storage.removeItem(key);
      return empty;
    }
    const entries = parsed.entries.map(parseEntry);
    if (entries.some((entry) => entry === null)) {
      storage.removeItem(key);
      return empty;
    }
    const valid = entries as TrialPaymentPendingCommand[];
    if (new Set(valid.map((entry) => entry.taskId)).size !== valid.length
      || new Set(valid.map((entry) => entry.commandKey)).size !== valid.length) {
      storage.removeItem(key);
      return empty;
    }
    return boundedMap(valid);
  } catch {
    try { storage.removeItem(key); } catch { /* storage remains unusable */ }
    return empty;
  }
}

export function persistTrialPaymentPendingCommands(
  storage: TrialPaymentPendingStorage | undefined,
  actor: string,
  entries: Iterable<TrialPaymentPendingCommand>,
) {
  if (!storage || !actor.trim()) return;
  const valid = Array.from(entries);
  if (valid.some((entry) => parseEntry(entry) === null)) return;
  const bounded = boundedMap(valid);
  if (!bounded.size) {
    try { storage.removeItem(storageKey(actor)); } catch { /* no-op */ }
    return;
  }
  const payload = JSON.stringify({
    namespace: TRIAL_PAYMENT_PENDING_NAMESPACE,
    schema: TRIAL_PAYMENT_PENDING_SCHEMA,
    entries: Array.from(bounded.values()),
  });
  if (payload.length > MAX_STORAGE_LENGTH) return;
  try { storage.setItem(storageKey(actor), payload); } catch { /* in-memory map still retries */ }
}

export function upsertTrialPaymentPendingCommand(
  entries: Iterable<TrialPaymentPendingCommand>,
  entry: TrialPaymentPendingCommand,
) {
  if (parseEntry(entry) === null) return boundedMap(entries);
  return boundedMap([...entries, entry]);
}

export function removeTrialPaymentPendingCommand(
  entries: Iterable<TrialPaymentPendingCommand>,
  taskId: string,
) {
  return boundedMap(Array.from(entries).filter((entry) => entry.taskId !== taskId));
}

/**
 * A version conflict is retryable when this tab has since observed a newer
 * authority version. This is important when two actor-scoped pending commands
 * were captured at the same OCC version: the first may commit, while the
 * second must rebase its exact command key to the newer versions instead of
 * being discarded as an allegedly terminal 409.
 *
 * Only a known terminal rejection (idempotency conflict, invalid completion,
 * or authorization/not-found) clears a command. Unknown, 5xx and incomplete
 * outcomes retain the original command unchanged.
 */
export function trialPaymentPendingDisposition(input: Readonly<{
  status: number;
  code?: string;
  committed: boolean;
  receiptOnly: boolean;
  hasAuthoritativeTaskRow: boolean;
  hasAuthoritativeProjection: boolean;
  expectedVersionsChanged?: boolean;
}>): "retain" | "clear" | "retry" {
  if (input.status === 409 && input.code === "version_conflict") {
    return input.expectedVersionsChanged ? "retry" : "retain";
  }
  if ([403, 404].includes(input.status)
    || (input.status === 409 && ["idempotency_conflict", "invalid_completion"].includes(input.code ?? ""))) return "clear";
  return input.status >= 200 && input.status < 300
    && input.committed
    && (input.receiptOnly
      || (input.hasAuthoritativeTaskRow && input.hasAuthoritativeProjection))
    ? "clear"
    : "retain";
}
