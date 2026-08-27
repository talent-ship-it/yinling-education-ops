/**
 * Crash/reload recovery for the legacy-operation task atomic command.
 *
 * Only the exact semantic intent, original OCC versions, and command key are
 * retained in an actor-scoped sessionStorage envelope.  Server rows and
 * projections are intentionally not accepted by this parser.
 */

export const LEGACY_OPERATION_TASK_PENDING_NAMESPACE = "insider-leads:legacy-operation-task" as const;
export const LEGACY_OPERATION_TASK_PENDING_SCHEMA = 1 as const;
export const LEGACY_OPERATION_TASK_PENDING_LIMIT = 8;
export const LEGACY_OPERATION_TASK_PENDING_MAX_BYTES = 32 * 1024;

const COMMAND_KEY = /^operation-task-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION_KEYS = ["bookings", "operations", "students", "tasks", "teachers"] as const;
const REQUIRED_INTENT_KEYS = ["type", "detail", "eventStart", "eventEnd"] as const;
const OPTIONAL_INTENT_KEYS = ["studentId", "teacherId", "sourceBookingId"] as const;
const TYPES = new Set(["学生请假", "停课", "换老师"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export type LegacyOperationTaskExpectedVersions = Readonly<{
  bookings: number;
  operations: number;
  students: number;
  tasks: number;
  teachers: number;
}>;

export type LegacyOperationTaskPendingCommand = Readonly<{
  /** JSON object containing the complete semantic operation intent. */
  intent: string;
  /** JSON object containing exactly the same semantic operation intent. */
  commandIntent: string;
  commandKey: string;
  expectedVersions: LegacyOperationTaskExpectedVersions;
}>;

export type LegacyOperationTaskPendingStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

type JsonRecord = Record<string, unknown>;

/** Definitive client validation or a complete authoritative commit is terminal. */
export function legacyOperationTaskPendingDisposition(input: Readonly<{
  status: number;
  committed: boolean;
  receiptOnly?: boolean;
  hasAuthoritativeRows: boolean;
}>): "retain" | "clear" {
  if ([400, 403, 404, 409].includes(input.status)) return "clear";
  return input.status >= 200
    && input.status < 300
    && input.committed
    && (input.receiptOnly === true || input.hasAuthoritativeRows)
    ? "clear"
    : "retain";
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validVersions(value: unknown): value is LegacyOperationTaskExpectedVersions {
  return isRecord(value)
    && hasExactKeys(value, VERSION_KEYS)
    && VERSION_KEYS.every((key) => (
      typeof value[key] === "number"
      && Number.isSafeInteger(value[key])
      && value[key] >= 1
    ));
}

function validDate(value: unknown) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validId(value: unknown) {
  return typeof value === "string" && RECORD_ID.test(value) && value === value.trim();
}

function validIntentObject(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  const allowedKeys: readonly string[] = [...REQUIRED_INTENT_KEYS, ...OPTIONAL_INTENT_KEYS];
  const keys = Object.keys(value);
  if (keys.some((key) => !allowedKeys.includes(key))
    || REQUIRED_INTENT_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
  if (typeof value.type !== "string" || !TYPES.has(value.type)
    || typeof value.detail !== "string"
    || value.detail !== value.detail.trim()
    || value.detail.length < 1
    || value.detail.length > 2_000
    || !validDate(value.eventStart)
    || !validDate(value.eventEnd)
    || String(value.eventStart) > String(value.eventEnd)) return false;
  for (const key of OPTIONAL_INTENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key) && !validId(value[key])) return false;
  }
  if ((value.type === "学生请假" || value.type === "停课")
    && (typeof value.studentId !== "string" || !validId(value.studentId))) return false;
  if (value.type === "换老师"
    && (typeof value.studentId !== "string" || !validId(value.studentId)
      || typeof value.teacherId !== "string" || !validId(value.teacherId))) return false;
  return true;
}

function parseJson(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || byteLength(value) > LEGACY_OPERATION_TASK_PENDING_MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseIntent(value: unknown) {
  const parsed = parseJson(value);
  return parsed && validIntentObject(parsed) ? parsed : null;
}

function parseStoredEntry(value: unknown): LegacyOperationTaskPendingCommand | null {
  if (!isRecord(value) || !hasExactKeys(value, ["intent", "commandIntent", "commandKey", "expectedVersions"])) return null;
  if (typeof value.commandKey !== "string" || !COMMAND_KEY.test(value.commandKey)) return null;
  if (!validVersions(value.expectedVersions)) return null;
  const intent = parseIntent(value.intent);
  const commandIntent = parseIntent(value.commandIntent);
  if (!intent || !commandIntent || canonical(intent) !== canonical(commandIntent)) return null;
  return {
    intent: value.intent as string,
    commandIntent: value.commandIntent as string,
    commandKey: value.commandKey,
    expectedVersions: value.expectedVersions,
  };
}

function intentFingerprint(entry: LegacyOperationTaskPendingCommand) {
  const parsed = parseJson(entry.intent);
  return parsed ? canonical(parsed) : entry.intent;
}

function storageKey(actor: string) {
  return `${LEGACY_OPERATION_TASK_PENDING_NAMESPACE}:v${LEGACY_OPERATION_TASK_PENDING_SCHEMA}:${encodeURIComponent(actor.trim().toLocaleLowerCase())}`;
}

function boundedMap(entries: Iterable<LegacyOperationTaskPendingCommand>) {
  const result = new Map<string, LegacyOperationTaskPendingCommand>();
  for (const entry of entries) {
    result.delete(entry.intent);
    result.set(entry.intent, entry);
  }
  while (result.size > LEGACY_OPERATION_TASK_PENDING_LIMIT) {
    const oldest = result.keys().next().value;
    if (typeof oldest !== "string") break;
    result.delete(oldest);
  }
  return result;
}

function validateEntries(entries: Iterable<unknown>) {
  let input: unknown[];
  try {
    input = Array.from(entries);
  } catch {
    return null;
  }
  const parsed = input.map(parseStoredEntry);
  if (parsed.some((entry) => entry === null)) return null;
  const valid = parsed as LegacyOperationTaskPendingCommand[];
  if (new Set(valid.map(intentFingerprint)).size !== valid.length
    || new Set(valid.map((entry) => entry.commandKey)).size !== valid.length) return null;
  return valid;
}

function removeStorage(storage: LegacyOperationTaskPendingStorage, key: string) {
  try { storage.removeItem(key); } catch { /* unusable storage remains empty */ }
}

export function readLegacyOperationTaskPendingCommands(
  storage: LegacyOperationTaskPendingStorage | undefined,
  actor: string,
) {
  const empty = new Map<string, LegacyOperationTaskPendingCommand>();
  if (!storage || !actor.trim()) return empty;
  const key = storageKey(actor);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return empty;
    if (byteLength(raw) > LEGACY_OPERATION_TASK_PENDING_MAX_BYTES) {
      removeStorage(storage, key);
      return empty;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)
      || !hasExactKeys(parsed, ["namespace", "schema", "entries"])
      || parsed.namespace !== LEGACY_OPERATION_TASK_PENDING_NAMESPACE
      || parsed.schema !== LEGACY_OPERATION_TASK_PENDING_SCHEMA
      || !Array.isArray(parsed.entries)
      || parsed.entries.length > LEGACY_OPERATION_TASK_PENDING_LIMIT) {
      removeStorage(storage, key);
      return empty;
    }
    const entries = validateEntries(parsed.entries);
    if (!entries) {
      removeStorage(storage, key);
      return empty;
    }
    return boundedMap(entries);
  } catch {
    removeStorage(storage, key);
    return empty;
  }
}

export function persistLegacyOperationTaskPendingCommands(
  storage: LegacyOperationTaskPendingStorage | undefined,
  actor: string,
  entries: Iterable<LegacyOperationTaskPendingCommand>,
) {
  if (!storage || !actor.trim()) return;
  const valid = validateEntries(entries);
  if (!valid) return;
  const bounded = boundedMap(valid);
  const payload = JSON.stringify({
    namespace: LEGACY_OPERATION_TASK_PENDING_NAMESPACE,
    schema: LEGACY_OPERATION_TASK_PENDING_SCHEMA,
    entries: Array.from(bounded.values()),
  });
  if (byteLength(payload) > LEGACY_OPERATION_TASK_PENDING_MAX_BYTES) return;
  try {
    if (bounded.size === 0) storage.removeItem(storageKey(actor));
    else storage.setItem(storageKey(actor), payload);
  } catch {
    // A blocked storage API must not cause an automatic network retry.
  }
}

export function upsertLegacyOperationTaskPendingCommand(
  entries: Iterable<LegacyOperationTaskPendingCommand>,
  entry: LegacyOperationTaskPendingCommand,
) {
  const current = validateEntries(entries);
  const parsedEntry = parseStoredEntry(entry);
  if (!current || !parsedEntry) return new Map<string, LegacyOperationTaskPendingCommand>();
  const parsedIntentFingerprint = intentFingerprint(parsedEntry);
  const withoutIntent = current.filter((candidate) => intentFingerprint(candidate) !== parsedIntentFingerprint);
  if (withoutIntent.some((candidate) => candidate.commandKey === parsedEntry.commandKey)) {
    return new Map<string, LegacyOperationTaskPendingCommand>();
  }
  return boundedMap([...withoutIntent, parsedEntry]);
}

export function removeLegacyOperationTaskPendingCommand(
  entries: Iterable<LegacyOperationTaskPendingCommand>,
  intent: string,
) {
  const current = validateEntries(entries);
  if (!current || typeof intent !== "string") return new Map<string, LegacyOperationTaskPendingCommand>();
  return boundedMap(current.filter((entry) => entry.intent !== intent));
}

export function clearLegacyOperationTaskPendingCommands(
  storage: LegacyOperationTaskPendingStorage | undefined,
  actor: string,
) {
  if (!storage || !actor.trim()) return;
  removeStorage(storage, storageKey(actor));
}
