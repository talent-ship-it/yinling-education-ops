/** Strict actor-scoped envelope for an uncertain atomic booking response. */
export const BOOKING_PROJECTION_PENDING_NAMESPACE = "insider-leads:booking-projection" as const;
export const BOOKING_PROJECTION_PENDING_SCHEMA = 1 as const;
export const BOOKING_PROJECTION_PENDING_LIMIT = 8;
const MAX_TEXT = 64_000;
const BOOKING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MEETING_ID = /^yinling-occ-[0-9a-f]{48}$/;

export type BookingProjectionExpectedVersions = Readonly<{
  bookings: number;
  students: number;
  lpItems: number;
  tasks: number;
  teachers: number;
}>;

export type BookingProjectionPendingCommand = Readonly<{
  /** Stable semantic command without OCC versions. */
  intent: string;
  /** Exact narrow browser command, including the original OCC versions. */
  command: string;
  expectedVersions: BookingProjectionExpectedVersions;
}>;

export type BookingProjectionPendingStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, fields: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function validVersions(value: unknown): value is BookingProjectionExpectedVersions {
  if (!record(value) || !exact(value, ["bookings", "students", "lpItems", "tasks", "teachers"])) return false;
  return (["bookings", "students", "lpItems", "tasks", "teachers"] as const)
    .every((field) => Number.isSafeInteger(value[field]) && Number(value[field]) >= 1);
}

function parseEntry(value: unknown): BookingProjectionPendingCommand | null {
  if (!record(value) || !exact(value, ["intent", "command", "expectedVersions"])
    || typeof value.intent !== "string" || typeof value.command !== "string"
    || value.intent.length < 1 || value.intent.length > MAX_TEXT
    || value.command.length < 1 || value.command.length > MAX_TEXT
    || !validVersions(value.expectedVersions)) return null;
  try {
    const intent = JSON.parse(value.intent) as unknown;
    const command = JSON.parse(value.command) as unknown;
    if (!record(intent) || !record(command)) return null;
    const action = command.action;
    if (action !== "upsert" && action !== "upsert_bind_classroom" && action !== "delete" && action !== "cancel_occurrence" && action !== "update_occurrence" && action !== "bind_classroom") return null;
    const intentFields = action === "delete"
      ? ["action", "bookingId"]
      : action === "cancel_occurrence"
        ? ["action", "bookingId", "occurrenceId"]
        : action === "update_occurrence"
          ? ["action", "bookingId", "occurrenceId", "occurrence"]
          : action === "bind_classroom"
            ? ["action", "bookingId", "occurrenceId", "classroom"]
            : action === "upsert_bind_classroom"
              ? ["action", "bookingId", "occurrenceId", "booking", "classroom"]
          : ["action", "bookingId", "booking"];
    if (!record(intent) || !record(command)
      || !exact(intent, intentFields)
      || !exact(command, [...intentFields, "expectedVersions"])
      || command.action !== intent.action
      || typeof command.bookingId !== "string" || !BOOKING_ID.test(command.bookingId)
      || command.bookingId !== intent.bookingId
      || !validVersions(command.expectedVersions)
      || JSON.stringify(command.expectedVersions) !== JSON.stringify(value.expectedVersions)) return null;
    const semantic = { ...command };
    delete semantic.expectedVersions;
    if (JSON.stringify(semantic) !== value.intent) return null;
    if ((action === "upsert" || action === "upsert_bind_classroom") && (!record(command.booking) || JSON.stringify(command.booking) !== JSON.stringify(intent.booking))) return null;
    if (action === "delete" && (command.booking !== undefined || command.occurrenceId !== undefined || command.occurrence !== undefined)) return null;
    if (action === "cancel_occurrence" || action === "update_occurrence" || action === "bind_classroom" || action === "upsert_bind_classroom") {
      if (typeof command.occurrenceId !== "string") return null;
      const sourceDate = command.occurrenceId.slice(-10);
      if (!DATE.test(sourceDate) || command.occurrenceId !== `${command.bookingId}:${sourceDate}`) return null;
    }
    if (action === "cancel_occurrence" && command.occurrence !== undefined) return null;
    if (action === "bind_classroom") {
      if (command.booking !== undefined || command.occurrence !== undefined
        || !record(command.classroom) || !exact(command.classroom, ["meetingId", "status"])
        || typeof command.classroom.meetingId !== "string"
        || !MEETING_ID.test(command.classroom.meetingId)
        || !["ready", "running", "ended"].includes(String(command.classroom.status))) return null;
    }
    if (action === "upsert_bind_classroom") {
      if (!record(command.classroom) || !exact(command.classroom, ["meetingId", "status"])
        || typeof command.classroom.meetingId !== "string"
        || !MEETING_ID.test(command.classroom.meetingId)
        || !["ready", "running", "ended"].includes(String(command.classroom.status))) return null;
    }
    if (action === "update_occurrence") {
      if (!record(command.occurrence) || !exact(command.occurrence, ["date", "start", "duration", "status"])
        || typeof command.occurrence.date !== "string" || !DATE.test(command.occurrence.date)
        || typeof command.occurrence.start !== "string" || !TIME.test(command.occurrence.start)
        || ![60, 90, 120].includes(Number(command.occurrence.duration))
        || command.occurrence.status !== "confirmed") return null;
    }
  } catch {
    return null;
  }
  return value as BookingProjectionPendingCommand;
}

function storageKey(actor: string) {
  return `${BOOKING_PROJECTION_PENDING_NAMESPACE}:v${BOOKING_PROJECTION_PENDING_SCHEMA}:${encodeURIComponent(actor.trim().toLocaleLowerCase("en-AU"))}`;
}

function bounded(entries: Iterable<BookingProjectionPendingCommand>) {
  const result = new Map<string, BookingProjectionPendingCommand>();
  for (const entry of entries) {
    result.delete(entry.intent);
    result.set(entry.intent, entry);
  }
  while (result.size > BOOKING_PROJECTION_PENDING_LIMIT) {
    const oldest = result.keys().next().value;
    if (typeof oldest !== "string") break;
    result.delete(oldest);
  }
  return result;
}

export function readBookingProjectionPendingCommands(
  storage: BookingProjectionPendingStorage | undefined,
  actor: string,
) {
  if (!storage || !actor.trim()) return new Map<string, BookingProjectionPendingCommand>();
  try {
    const raw = storage.getItem(storageKey(actor));
    if (!raw) return new Map<string, BookingProjectionPendingCommand>();
    if (raw.length > MAX_TEXT * BOOKING_PROJECTION_PENDING_LIMIT) {
      storage.removeItem(storageKey(actor));
      return new Map<string, BookingProjectionPendingCommand>();
    }
    const payload = JSON.parse(raw) as unknown;
    if (!record(payload) || !exact(payload, ["namespace", "schema", "entries"])
      || payload.namespace !== BOOKING_PROJECTION_PENDING_NAMESPACE
      || payload.schema !== BOOKING_PROJECTION_PENDING_SCHEMA
      || !Array.isArray(payload.entries)
      || payload.entries.length > BOOKING_PROJECTION_PENDING_LIMIT) throw new Error("invalid pending envelope");
    const entries = payload.entries.map(parseEntry);
    if (entries.some((entry) => entry === null)) throw new Error("invalid pending entry");
    const valid = entries as BookingProjectionPendingCommand[];
    if (new Set(valid.map((entry) => entry.intent)).size !== valid.length) throw new Error("duplicate pending intent");
    return bounded(valid);
  } catch {
    try { storage.removeItem(storageKey(actor)); } catch { /* fail closed */ }
    return new Map<string, BookingProjectionPendingCommand>();
  }
}

export function persistBookingProjectionPendingCommands(
  storage: BookingProjectionPendingStorage | undefined,
  actor: string,
  entries: Iterable<BookingProjectionPendingCommand>,
) {
  if (!storage || !actor.trim()) return;
  const valid = [...entries];
  if (valid.some((entry) => parseEntry(entry) === null)) return;
  const payload = JSON.stringify({
    namespace: BOOKING_PROJECTION_PENDING_NAMESPACE,
    schema: BOOKING_PROJECTION_PENDING_SCHEMA,
    entries: [...bounded(valid).values()],
  });
  if (payload.length > MAX_TEXT * BOOKING_PROJECTION_PENDING_LIMIT) return;
  try { storage.setItem(storageKey(actor), payload); } catch { /* in-memory retry remains */ }
}

export function upsertBookingProjectionPendingCommand(
  entries: Iterable<BookingProjectionPendingCommand>,
  entry: BookingProjectionPendingCommand,
) {
  return bounded([...entries, entry]);
}

export function removeBookingProjectionPendingCommand(
  entries: Iterable<BookingProjectionPendingCommand>,
  intent: string,
) {
  return bounded([...entries].filter((entry) => entry.intent !== intent));
}

export function clearBookingProjectionPendingCommands(
  storage: BookingProjectionPendingStorage | undefined,
  actor: string,
) {
  if (!storage || !actor.trim()) return;
  try { storage.removeItem(storageKey(actor)); } catch { /* fail closed */ }
}
