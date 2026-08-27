/**
 * Crash/reload recovery for teacher-absence atomic commands. The browser keeps
 * only the exact semantic intent, original OCC versions, and command UUID in a
 * strict actor-scoped sessionStorage envelope. Malformed storage is discarded
 * rather than becoming a command.
 */

export const TEACHER_ABSENCE_PENDING_NAMESPACE = "insider-leads:teacher-absence" as const;
export const TEACHER_ABSENCE_PENDING_SCHEMA = 1 as const;
export const TEACHER_ABSENCE_PENDING_LIMIT = 8;
const TEACHER_ABSENCE_PENDING_MAX_TEXT = 32_000;
const COMMAND_KEY = /^teacher-absence-create:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = new Set(["老师请假", "请假", "代课"]);

export type TeacherAbsenceExpectedVersions = Readonly<{
  bookings: number;
  operations: number;
  students: number;
  tasks: number;
  teachers: number;
}>;

export type TeacherAbsencePendingCommand = Readonly<{
  intent: string;
  commandKey: string;
  expectedVersions: TeacherAbsenceExpectedVersions;
}>;

export type TeacherAbsencePendingStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

/** Only an explicit conflict or a complete authoritative success is terminal. */
export function teacherAbsencePendingDisposition(input: Readonly<{
  status: number;
  committed: boolean;
  hasAuthoritativeRows: boolean;
}>): "retain" | "clear" {
  if (input.status === 409) return "clear";
  return input.status >= 200 && input.status < 300 && input.committed && input.hasAuthoritativeRows
    ? "clear"
    : "retain";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validDate(value: unknown) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validVersions(value: unknown): value is TeacherAbsenceExpectedVersions {
  const keys = ["bookings", "operations", "students", "tasks", "teachers"] as const;
  return isRecord(value)
    && hasExactKeys(value, keys)
    && keys.every((key) => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 1);
}

function validIntent(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > TEACHER_ABSENCE_PENDING_MAX_TEXT) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !hasExactKeys(parsed, ["sourceTeacherId", "eventStart", "eventEnd", "type", "detail"])) return false;
    return typeof parsed.sourceTeacherId === "string" && RECORD_ID.test(parsed.sourceTeacherId)
      && validDate(parsed.eventStart) && validDate(parsed.eventEnd) && String(parsed.eventStart) <= String(parsed.eventEnd)
      && typeof parsed.type === "string" && TYPES.has(parsed.type)
      && typeof parsed.detail === "string" && parsed.detail === parsed.detail.trim()
      && parsed.detail.length > 0 && parsed.detail.length <= 2_000;
  } catch {
    return false;
  }
}

function parseStoredEntry(value: unknown): TeacherAbsencePendingCommand | null {
  if (!isRecord(value) || !hasExactKeys(value, ["intent", "commandKey", "expectedVersions"])) return null;
  if (typeof value.commandKey !== "string" || !COMMAND_KEY.test(value.commandKey)) return null;
  if (!validIntent(value.intent) || !validVersions(value.expectedVersions)) return null;
  return {
    intent: value.intent as string,
    commandKey: value.commandKey,
    expectedVersions: value.expectedVersions,
  };
}

function storageKey(actor: string) {
  return `${TEACHER_ABSENCE_PENDING_NAMESPACE}:v${TEACHER_ABSENCE_PENDING_SCHEMA}:${encodeURIComponent(actor.trim().toLocaleLowerCase())}`;
}

function boundedMap(entries: Iterable<TeacherAbsencePendingCommand>) {
  const result = new Map<string, TeacherAbsencePendingCommand>();
  for (const entry of entries) {
    result.delete(entry.intent);
    result.set(entry.intent, entry);
  }
  while (result.size > TEACHER_ABSENCE_PENDING_LIMIT) {
    const oldest = result.keys().next().value;
    if (typeof oldest !== "string") break;
    result.delete(oldest);
  }
  return result;
}

export function readTeacherAbsencePendingCommands(
  storage: TeacherAbsencePendingStorage | undefined,
  actor: string,
) {
  const empty = new Map<string, TeacherAbsencePendingCommand>();
  if (!storage || !actor.trim()) return empty;
  const key = storageKey(actor);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return empty;
    if (raw.length > TEACHER_ABSENCE_PENDING_MAX_TEXT * TEACHER_ABSENCE_PENDING_LIMIT) {
      storage.removeItem(key);
      return empty;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !hasExactKeys(parsed, ["namespace", "schema", "entries"])
      || parsed.namespace !== TEACHER_ABSENCE_PENDING_NAMESPACE
      || parsed.schema !== TEACHER_ABSENCE_PENDING_SCHEMA
      || !Array.isArray(parsed.entries)
      || parsed.entries.length > TEACHER_ABSENCE_PENDING_LIMIT) {
      storage.removeItem(key);
      return empty;
    }
    const entries = parsed.entries.map(parseStoredEntry);
    if (entries.some((entry) => entry === null)) {
      storage.removeItem(key);
      return empty;
    }
    const validEntries = entries as TeacherAbsencePendingCommand[];
    if (new Set(validEntries.map((entry) => entry.intent)).size !== validEntries.length
      || new Set(validEntries.map((entry) => entry.commandKey)).size !== validEntries.length) {
      storage.removeItem(key);
      return empty;
    }
    return boundedMap(validEntries);
  } catch {
    try { storage.removeItem(key); } catch { /* malformed storage remains unusable */ }
    return empty;
  }
}

export function persistTeacherAbsencePendingCommands(
  storage: TeacherAbsencePendingStorage | undefined,
  actor: string,
  entries: Iterable<TeacherAbsencePendingCommand>,
) {
  if (!storage || !actor.trim()) return;
  const input = Array.from(entries);
  if (input.some((entry) => parseStoredEntry(entry) === null)) return;
  const bounded = boundedMap(input);
  const payload = JSON.stringify({
    namespace: TEACHER_ABSENCE_PENDING_NAMESPACE,
    schema: TEACHER_ABSENCE_PENDING_SCHEMA,
    entries: Array.from(bounded.values()),
  });
  if (payload.length > TEACHER_ABSENCE_PENDING_MAX_TEXT * TEACHER_ABSENCE_PENDING_LIMIT) return;
  try { storage.setItem(storageKey(actor), payload); } catch { /* in-memory retry remains available */ }
}

export function upsertTeacherAbsencePendingCommand(
  entries: Iterable<TeacherAbsencePendingCommand>,
  entry: TeacherAbsencePendingCommand,
) {
  return boundedMap([...entries, entry]);
}

export function removeTeacherAbsencePendingCommand(
  entries: Iterable<TeacherAbsencePendingCommand>,
  intent: string,
) {
  return boundedMap(Array.from(entries).filter((entry) => entry.intent !== intent));
}

export function clearTeacherAbsencePendingCommands(
  storage: TeacherAbsencePendingStorage | undefined,
  actor: string,
) {
  if (!storage || !actor.trim()) return;
  try { storage.removeItem(storageKey(actor)); } catch { /* fail closed */ }
}
