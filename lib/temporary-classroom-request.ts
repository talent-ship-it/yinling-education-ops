import { displayTimezoneOptions } from "@/lib/display-preferences";

export const TEMPORARY_CLASSROOM_REQUEST_SCHEMA_VERSION = 1 as const;
export const TEMPORARY_CLASSROOM_REQUEST_STORAGE_PREFIX = "insider-leads:temporary-classroom:v1:";
export const TEMPORARY_CLASSROOM_REQUEST_MAX_BYTES = 8_192;
export const TEMPORARY_CLASSROOM_REQUEST_MAX_ENTRIES = 8;

const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[^\u0000-\u001f\u007f]{1,120}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SUPPORTED_TIMEZONES = new Set<string>(displayTimezoneOptions.map((option) => option.id));

type RecordValue = Record<string, unknown>;

export type TemporaryClassroomRecordedPayload = Readonly<{
  mode: "recorded";
  studentId: string;
  teacherId: string;
  subjectId: string;
  teacherSubjectId: string;
  packageId: string;
  duration: 60 | 90 | 120;
  date: string;
  start: string;
  timezone: string;
}>;

export type TemporaryClassroomTestPayload = Readonly<{
  mode: "test";
}>;

export type TemporaryClassroomRequestPayload = TemporaryClassroomRecordedPayload | TemporaryClassroomTestPayload;

export type TemporaryClassroomPending = Readonly<{
  schemaVersion: typeof TEMPORARY_CLASSROOM_REQUEST_SCHEMA_VERSION;
  actor: string;
  mode: TemporaryClassroomRequestPayload["mode"];
  requestKey: string;
  /** Canonical actor-independent intent. Generated date/start live in payload. */
  intent: string;
  payload: TemporaryClassroomRequestPayload;
}>;

export type TemporaryClassroomPendingLedger = Readonly<{
  schemaVersion: typeof TEMPORARY_CLASSROOM_REQUEST_SCHEMA_VERSION;
  actor: string;
  entries: readonly TemporaryClassroomPending[];
}>;

export type TemporaryClassroomStorage = Readonly<{
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: RecordValue, expected: readonly string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function text(value: unknown, maxLength = 120) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function actorText(value: unknown) {
  const normalized = text(value);
  return normalized && ACTOR.test(normalized) ? normalized : null;
}

function validDate(value: unknown) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTimezone(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_TIMEZONES.has(value);
}

function normalizeRecordedPayload(value: unknown): TemporaryClassroomRecordedPayload | null {
  if (!isRecord(value) || !exactKeys(value, [
    "mode", "studentId", "teacherId", "subjectId", "teacherSubjectId", "packageId",
    "duration", "date", "start", "timezone",
  ])) return null;
  const studentId = text(value.studentId);
  const teacherId = text(value.teacherId);
  const subjectId = text(value.subjectId);
  const teacherSubjectId = text(value.teacherSubjectId);
  const packageId = text(value.packageId);
  const duration = value.duration;
  const date = value.date;
  const start = value.start;
  const timezone = value.timezone;
  const dateValue = typeof date === "string" ? date : "";
  const startValue = typeof start === "string" ? start : "";
  if (value.mode !== "recorded"
    || !studentId || !teacherId || !subjectId || !teacherSubjectId || !packageId
    || ![60, 90, 120].includes(duration as number)
    || !validDate(dateValue) || !TIME.test(startValue)
    || !validTimezone(timezone)) return null;
  return {
    mode: "recorded",
    studentId,
    teacherId,
    subjectId,
    teacherSubjectId,
    packageId,
    duration: duration as 60 | 90 | 120,
    date: dateValue,
    start: startValue,
    timezone,
  };
}

function normalizeTestPayload(value: unknown): TemporaryClassroomTestPayload | null {
  return isRecord(value) && exactKeys(value, ["mode"]) && value.mode === "test"
    ? { mode: "test" }
    : null;
}

/**
 * Returns the canonical intent used to decide whether a retry can reuse a
 * request key. The current minute is deliberately not part of this value:
 * it is generated once and retained in the pending payload across reloads.
 */
export function normalizeTemporaryClassroomIntent(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value.mode === "test" && exactKeys(value, ["mode"])) return JSON.stringify({ mode: "test" });
  if (value.mode !== "recorded") return null;
  const studentId = text(value.studentId);
  const teacherId = text(value.teacherId);
  const subjectId = text(value.subjectId);
  const teacherSubjectId = text(value.teacherSubjectId);
  const packageId = text(value.packageId);
  const duration = value.duration;
  const timezone = value.timezone;
  if (!exactKeys(value, ["mode", "studentId", "teacherId", "subjectId", "teacherSubjectId", "packageId", "duration", "timezone"])
    || !studentId || !teacherId || !subjectId || !teacherSubjectId || !packageId
    || ![60, 90, 120].includes(duration as number)
    || !validTimezone(timezone)) return null;
  return JSON.stringify({
    mode: "recorded",
    studentId,
    teacherId,
    subjectId,
    teacherSubjectId,
    packageId,
    duration,
    timezone,
  });
}

export function temporaryClassroomActorStorageKey(actor: string) {
  return `${TEMPORARY_CLASSROOM_REQUEST_STORAGE_PREFIX}${encodeURIComponent(actor.trim())}`;
}

function browserSessionStorage(): TemporaryClassroomStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function parseTemporaryClassroomPending(value: unknown): TemporaryClassroomPending | null {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "actor", "mode", "requestKey", "intent", "payload"])) return null;
  if (value.schemaVersion !== TEMPORARY_CLASSROOM_REQUEST_SCHEMA_VERSION) return null;
  const actor = actorText(value.actor);
  const requestKey = text(value.requestKey);
  const intent = text(value.intent, 1_024);
  if (!actor || !requestKey || !REQUEST_KEY.test(requestKey) || !intent) return null;
  const payload = value.mode === "recorded"
    ? normalizeRecordedPayload(value.payload)
    : value.mode === "test"
      ? normalizeTestPayload(value.payload)
      : null;
  if (!payload || payload.mode !== value.mode) return null;
  const expectedIntent = payload.mode === "recorded"
    ? normalizeTemporaryClassroomIntent({
      mode: "recorded",
      studentId: payload.studentId,
      teacherId: payload.teacherId,
      subjectId: payload.subjectId,
      teacherSubjectId: payload.teacherSubjectId,
      packageId: payload.packageId,
      duration: payload.duration,
      timezone: payload.timezone,
    })
    : normalizeTemporaryClassroomIntent({ mode: "test" });
  if (!expectedIntent || intent !== expectedIntent) return null;
  const parsed = {
    schemaVersion: TEMPORARY_CLASSROOM_REQUEST_SCHEMA_VERSION,
    actor,
    mode: payload.mode,
    requestKey,
    intent,
    payload,
  } satisfies TemporaryClassroomPending;
  if (JSON.stringify(parsed).length > TEMPORARY_CLASSROOM_REQUEST_MAX_BYTES) return null;
  return parsed;
}

export function parseTemporaryClassroomPendingLedger(value: unknown): TemporaryClassroomPendingLedger | null {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "actor", "entries"])) return null;
  if (value.schemaVersion !== TEMPORARY_CLASSROOM_REQUEST_SCHEMA_VERSION) return null;
  const actor = actorText(value.actor);
  if (!actor || !Array.isArray(value.entries) || value.entries.length > TEMPORARY_CLASSROOM_REQUEST_MAX_ENTRIES) return null;
  const entries = value.entries
    .map((entry) => parseTemporaryClassroomPending(entry))
    .filter((entry): entry is TemporaryClassroomPending => Boolean(entry));
  // A malformed entry must fail closed rather than silently weakening the
  // actor/intent binding of the remaining retry ledger.
  if (entries.length !== value.entries.length || entries.some((entry) => entry.actor !== actor)) return null;
  const uniqueIntents = new Set(entries.map((entry) => entry.intent));
  if (uniqueIntents.size !== entries.length) return null;
  const parsed = { schemaVersion: TEMPORARY_CLASSROOM_REQUEST_SCHEMA_VERSION, actor, entries } satisfies TemporaryClassroomPendingLedger;
  return JSON.stringify(parsed).length <= TEMPORARY_CLASSROOM_REQUEST_MAX_BYTES ? parsed : null;
}

export function createTemporaryClassroomPending(input: {
  actor: string;
  requestKey: string;
  payload: TemporaryClassroomRequestPayload;
}): TemporaryClassroomPending | null {
  const actor = actorText(input.actor);
  const requestKey = text(input.requestKey);
  const payload = input.payload.mode === "recorded"
    ? normalizeRecordedPayload(input.payload)
    : normalizeTestPayload(input.payload);
  if (!actor || !requestKey || !REQUEST_KEY.test(requestKey) || !payload) return null;
  const intent = payload.mode === "recorded"
    ? normalizeTemporaryClassroomIntent({
      mode: "recorded",
      studentId: payload.studentId,
      teacherId: payload.teacherId,
      subjectId: payload.subjectId,
      teacherSubjectId: payload.teacherSubjectId,
      packageId: payload.packageId,
      duration: payload.duration,
      timezone: payload.timezone,
    })
    : normalizeTemporaryClassroomIntent({ mode: "test" });
  if (!intent) return null;
  return parseTemporaryClassroomPending({
    schemaVersion: TEMPORARY_CLASSROOM_REQUEST_SCHEMA_VERSION,
    actor,
    mode: payload.mode,
    requestKey,
    intent,
    payload,
  });
}

export function readTemporaryClassroomPending(actor: string, storage = browserSessionStorage()) {
  const normalizedActor = actorText(actor);
  if (!normalizedActor || !storage) return [];
  const key = temporaryClassroomActorStorageKey(normalizedActor);
  const discard = () => {
    try { storage.removeItem(key); } catch { /* no-op */ }
  };
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  if (raw.length > TEMPORARY_CLASSROOM_REQUEST_MAX_BYTES) {
    discard();
    return [];
  }
  try {
    const parsed = parseTemporaryClassroomPendingLedger(JSON.parse(raw));
    if (!parsed || parsed.actor !== normalizedActor) {
      discard();
      return [];
    }
    return [...parsed.entries];
  } catch {
    discard();
    return [];
  }
}

export function writeTemporaryClassroomPending(value: TemporaryClassroomPending, storage = browserSessionStorage()) {
  if (!storage) return false;
  const parsed = parseTemporaryClassroomPending(value);
  if (!parsed) return false;
  const existing = readTemporaryClassroomPending(parsed.actor, storage);
  const entries = [parsed, ...existing.filter((entry) => entry.intent !== parsed.intent)]
    .slice(0, TEMPORARY_CLASSROOM_REQUEST_MAX_ENTRIES);
  let ledger: TemporaryClassroomPendingLedger = {
    schemaVersion: TEMPORARY_CLASSROOM_REQUEST_SCHEMA_VERSION,
    actor: parsed.actor,
    entries,
  };
  while (ledger.entries.length && JSON.stringify(ledger).length > TEMPORARY_CLASSROOM_REQUEST_MAX_BYTES) {
    if (ledger.entries.length === 1) return false;
    ledger = { ...ledger, entries: ledger.entries.slice(0, -1) };
  }
  try {
    storage.setItem(temporaryClassroomActorStorageKey(parsed.actor), JSON.stringify(ledger));
    return true;
  } catch {
    return false;
  }
}

export function clearTemporaryClassroomPending(actor: string, intent?: string, storage = browserSessionStorage()) {
  const normalizedActor = actorText(actor);
  if (!normalizedActor || !storage) return;
  if (!intent) {
    try { storage.removeItem(temporaryClassroomActorStorageKey(normalizedActor)); } catch { /* no-op */ }
    return;
  }
  const remaining = readTemporaryClassroomPending(normalizedActor, storage).filter((entry) => entry.intent !== intent);
  try {
    if (!remaining.length) {
      storage.removeItem(temporaryClassroomActorStorageKey(normalizedActor));
      return;
    }
    const ledger: TemporaryClassroomPendingLedger = {
      schemaVersion: TEMPORARY_CLASSROOM_REQUEST_SCHEMA_VERSION,
      actor: normalizedActor,
      entries: remaining,
    };
    storage.setItem(temporaryClassroomActorStorageKey(normalizedActor), JSON.stringify(ledger));
  } catch {
    // Browser storage can be unavailable in private mode.
  }
}

export function newTemporaryClassroomRequestKey() {
  try {
    const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "";
    return UUID_V4.test(uuid) ? `temporary-${uuid}` : null;
  } catch {
    return null;
  }
}
