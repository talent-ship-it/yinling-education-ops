/**
 * Crash/reload recovery for the student-creation atomic command.
 *
 * The browser stores only the reviewed semantic intent, the original OCC
 * versions, and the command key.  It never stores a server row or projection.
 * Every envelope is actor-scoped, versioned, size bounded, and fail-closed.
 */

export const STUDENT_CREATION_PENDING_NAMESPACE = "insider-leads:student-creation" as const;
export const STUDENT_CREATION_PENDING_SCHEMA = 1 as const;
export const STUDENT_CREATION_PENDING_LIMIT = 8;
export const STUDENT_CREATION_PENDING_MAX_BYTES = 32 * 1024;

const COMMAND_KEY = /^student-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION_KEYS = ["students", "tasks"] as const;
const FIELD_KEYS = [
  "name",
  "course",
  "segment",
  "guardianWechat",
  "lpNeed",
  "owner",
  "planner",
  "grade",
  "location",
  "timezone",
  "notes",
] as const;
const FIELD_KEYS_WITH_REMAINING_HOURS = [...FIELD_KEYS, "remainingHours"] as const;
const SEGMENTS = new Set(["试听", "已报名"]);
const LP_NEEDS = new Set(["待确认", "无需LP", "试听LP", "新生LP", "老生新LP", "代课LP", "LP修改"]);

export type StudentCreationExpectedVersions = Readonly<{
  students: number;
  tasks: number;
}>;

export type StudentCreationPendingCommand = Readonly<{
  /** JSON object containing exactly `{ studentFields }`. */
  intent: string;
  /** JSON object containing exactly `{ studentFields, expectedVersions }`. */
  commandIntent: string;
  commandKey: string;
  expectedVersions: StudentCreationExpectedVersions;
}>;

export type StudentCreationPendingStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

type JsonRecord = Record<string, unknown>;

/** Only a definitive client result or a complete authoritative commit clears. */
export function studentCreationPendingDisposition(input: Readonly<{
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

function validVersions(value: unknown): value is StudentCreationExpectedVersions {
  return isRecord(value)
    && hasExactKeys(value, VERSION_KEYS)
    && VERSION_KEYS.every((key) => (
      typeof value[key] === "number"
      && Number.isSafeInteger(value[key])
      && value[key] >= 1
    ));
}

function validTrimmedText(value: unknown, max: number, allowEmpty = false) {
  return typeof value === "string"
    && value === value.trim()
    && value.length <= max
    && (allowEmpty || value.length > 0);
}

function validStudentFields(value: unknown): value is JsonRecord {
  if (!isRecord(value)
    || (!hasExactKeys(value, FIELD_KEYS) && !hasExactKeys(value, FIELD_KEYS_WITH_REMAINING_HOURS))) return false;
  if (!validTrimmedText(value.name, 240, true)
    || !validTrimmedText(value.course, 240)
    || typeof value.segment !== "string"
    || !SEGMENTS.has(value.segment)
    || !validTrimmedText(value.guardianWechat, 240, true)
    || typeof value.lpNeed !== "string"
    || !LP_NEEDS.has(value.lpNeed)
    || !validTrimmedText(value.owner, 120)
    || !validTrimmedText(value.planner, 120)
    || !validTrimmedText(value.grade, 120)
    || !validTrimmedText(value.location, 120)
    || !validTrimmedText(value.timezone, 100)
    || !validTrimmedText(value.notes, 4_000, true)) return false;
  return !Object.prototype.hasOwnProperty.call(value, "remainingHours")
    || (typeof value.remainingHours === "number" && Number.isFinite(value.remainingHours) && value.remainingHours >= 0);
}

function parseJson(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || byteLength(value) > STUDENT_CREATION_PENDING_MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseIntent(value: unknown) {
  const parsed = parseJson(value);
  return parsed && hasExactKeys(parsed, ["studentFields"]) && validStudentFields(parsed.studentFields)
    ? parsed
    : null;
}

function parseCommandIntent(value: unknown, expectedVersions: StudentCreationExpectedVersions) {
  const parsed = parseJson(value);
  return parsed
    && hasExactKeys(parsed, ["studentFields", "expectedVersions"])
    && validStudentFields(parsed.studentFields)
    && validVersions(parsed.expectedVersions)
    && canonical(parsed.expectedVersions) === canonical(expectedVersions)
    ? parsed
    : null;
}

function parseStoredEntry(value: unknown): StudentCreationPendingCommand | null {
  if (!isRecord(value) || !hasExactKeys(value, ["intent", "commandIntent", "commandKey", "expectedVersions"])) return null;
  if (typeof value.commandKey !== "string" || !COMMAND_KEY.test(value.commandKey)) return null;
  if (!validVersions(value.expectedVersions)) return null;
  const intent = parseIntent(value.intent);
  const commandIntent = parseCommandIntent(value.commandIntent, value.expectedVersions);
  if (!intent || !commandIntent || canonical(intent.studentFields) !== canonical(commandIntent.studentFields)) return null;
  return {
    intent: value.intent as string,
    commandIntent: value.commandIntent as string,
    commandKey: value.commandKey,
    expectedVersions: value.expectedVersions,
  };
}

function intentFingerprint(entry: StudentCreationPendingCommand) {
  const parsed = parseJson(entry.intent);
  return parsed ? canonical(parsed) : entry.intent;
}

function storageKey(actor: string) {
  return `${STUDENT_CREATION_PENDING_NAMESPACE}:v${STUDENT_CREATION_PENDING_SCHEMA}:${encodeURIComponent(actor.trim().toLocaleLowerCase())}`;
}

function boundedMap(entries: Iterable<StudentCreationPendingCommand>) {
  const result = new Map<string, StudentCreationPendingCommand>();
  for (const entry of entries) {
    result.delete(entry.intent);
    result.set(entry.intent, entry);
  }
  while (result.size > STUDENT_CREATION_PENDING_LIMIT) {
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
  const valid = parsed as StudentCreationPendingCommand[];
  if (new Set(valid.map(intentFingerprint)).size !== valid.length
    || new Set(valid.map((entry) => entry.commandKey)).size !== valid.length) return null;
  return valid;
}

function removeStorage(storage: StudentCreationPendingStorage, key: string) {
  try { storage.removeItem(key); } catch { /* unusable storage remains empty */ }
}

export function readStudentCreationPendingCommands(
  storage: StudentCreationPendingStorage | undefined,
  actor: string,
) {
  const empty = new Map<string, StudentCreationPendingCommand>();
  if (!storage || !actor.trim()) return empty;
  const key = storageKey(actor);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return empty;
    if (byteLength(raw) > STUDENT_CREATION_PENDING_MAX_BYTES) {
      removeStorage(storage, key);
      return empty;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)
      || !hasExactKeys(parsed, ["namespace", "schema", "entries"])
      || parsed.namespace !== STUDENT_CREATION_PENDING_NAMESPACE
      || parsed.schema !== STUDENT_CREATION_PENDING_SCHEMA
      || !Array.isArray(parsed.entries)
      || parsed.entries.length > STUDENT_CREATION_PENDING_LIMIT) {
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

export function persistStudentCreationPendingCommands(
  storage: StudentCreationPendingStorage | undefined,
  actor: string,
  entries: Iterable<StudentCreationPendingCommand>,
) {
  if (!storage || !actor.trim()) return;
  const valid = validateEntries(entries);
  if (!valid) return;
  const bounded = boundedMap(valid);
  const payload = JSON.stringify({
    namespace: STUDENT_CREATION_PENDING_NAMESPACE,
    schema: STUDENT_CREATION_PENDING_SCHEMA,
    entries: Array.from(bounded.values()),
  });
  if (byteLength(payload) > STUDENT_CREATION_PENDING_MAX_BYTES) return;
  try {
    if (bounded.size === 0) storage.removeItem(storageKey(actor));
    else storage.setItem(storageKey(actor), payload);
  } catch {
    // Storage failure must not trigger a network retry or invent a new command.
  }
}

export function upsertStudentCreationPendingCommand(
  entries: Iterable<StudentCreationPendingCommand>,
  entry: StudentCreationPendingCommand,
) {
  const current = validateEntries(entries);
  const parsedEntry = parseStoredEntry(entry);
  if (!current || !parsedEntry) return new Map<string, StudentCreationPendingCommand>();
  const parsedIntentFingerprint = intentFingerprint(parsedEntry);
  const withoutIntent = current.filter((candidate) => intentFingerprint(candidate) !== parsedIntentFingerprint);
  if (withoutIntent.some((candidate) => candidate.commandKey === parsedEntry.commandKey)) {
    return new Map<string, StudentCreationPendingCommand>();
  }
  return boundedMap([...withoutIntent, parsedEntry]);
}

export function removeStudentCreationPendingCommand(
  entries: Iterable<StudentCreationPendingCommand>,
  intent: string,
) {
  const current = validateEntries(entries);
  if (!current || typeof intent !== "string") return new Map<string, StudentCreationPendingCommand>();
  return boundedMap(current.filter((entry) => entry.intent !== intent));
}

export function clearStudentCreationPendingCommands(
  storage: StudentCreationPendingStorage | undefined,
  actor: string,
) {
  if (!storage || !actor.trim()) return;
  removeStorage(storage, storageKey(actor));
}
