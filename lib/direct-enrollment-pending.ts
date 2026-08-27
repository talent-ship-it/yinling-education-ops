/**
 * Crash/reload recovery for the direct-enrollment command.  This is a small,
 * deliberately strict sessionStorage envelope: malformed or oversized data is
 * ignored and removed rather than being used to replay an unknown command.
 */

export const DIRECT_ENROLLMENT_PENDING_NAMESPACE = "insider-leads:direct-enrollment" as const;
export const DIRECT_ENROLLMENT_PENDING_SCHEMA = 1 as const;
export const DIRECT_ENROLLMENT_PENDING_LIMIT = 8;
const DIRECT_ENROLLMENT_PENDING_MAX_TEXT = 64_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STUDENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const WORKFLOW_TYPE = "学生直报（无试听）";

export type DirectEnrollmentExpectedVersions = Readonly<{
  students: number;
  lpItems: number;
  tasks: number;
}>;

export type DirectEnrollmentPendingCommand = Readonly<{
  /** Exact semantic form intent; versions are retained separately for replay. */
  intent: string;
  /** Exact command intent sent to the server, including expectedVersions. */
  commandIntent: string;
  commandKey: string;
  expectedVersions: DirectEnrollmentExpectedVersions;
}>;

export type DirectEnrollmentPendingStorage = Readonly<{
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

function validVersions(value: unknown): value is DirectEnrollmentExpectedVersions {
  if (!isRecord(value) || !hasExactKeys(value, ["students", "lpItems", "tasks"])) return false;
  return (["students", "lpItems", "tasks"] as const).every((key) => (
    typeof value[key] === "number"
    && Number.isSafeInteger(value[key])
    && value[key] >= 1
  ));
}

function validDraftIntent(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > DIRECT_ENROLLMENT_PENDING_MAX_TEXT) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !hasExactKeys(parsed, ["studentId", "workflowType", "fields", "purchasedHours", "bonusHours", "subject"])) return false;
    return parsed.workflowType === WORKFLOW_TYPE
      && typeof parsed.studentId === "string" && STUDENT_ID.test(parsed.studentId) && !parsed.studentId.toLocaleLowerCase().includes("temp")
      && isRecord(parsed.fields)
      && typeof parsed.purchasedHours === "number" && Number.isFinite(parsed.purchasedHours) && parsed.purchasedHours >= 0
      && typeof parsed.bonusHours === "number" && Number.isFinite(parsed.bonusHours) && parsed.bonusHours >= 0
      && typeof parsed.subject === "string" && parsed.subject.length > 0
      && parsed.purchasedHours + parsed.bonusHours > 0;
  } catch {
    return false;
  }
}

function validCommandIntent(value: unknown, expectedVersions: DirectEnrollmentExpectedVersions) {
  if (typeof value !== "string" || value.length < 1 || value.length > DIRECT_ENROLLMENT_PENDING_MAX_TEXT) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !hasExactKeys(parsed, ["studentId", "workflowType", "fields", "purchasedHours", "bonusHours", "subject", "expectedVersions"])) return false;
    const parsedVersions = parsed.expectedVersions;
    if (!validVersions(parsedVersions)) return false;
    return parsed.workflowType === WORKFLOW_TYPE
      && typeof parsed.studentId === "string" && STUDENT_ID.test(parsed.studentId) && !parsed.studentId.toLocaleLowerCase().includes("temp")
      && isRecord(parsed.fields)
      && typeof parsed.purchasedHours === "number" && Number.isFinite(parsed.purchasedHours) && parsed.purchasedHours >= 0
      && typeof parsed.bonusHours === "number" && Number.isFinite(parsed.bonusHours) && parsed.bonusHours >= 0
      && typeof parsed.subject === "string" && parsed.subject.length > 0
      && parsed.purchasedHours + parsed.bonusHours > 0
      && (["students", "lpItems", "tasks"] as const).every((key) => parsedVersions[key] === expectedVersions[key]);
  } catch {
    return false;
  }
}

function parseStoredEntry(value: unknown): DirectEnrollmentPendingCommand | null {
  if (!isRecord(value) || !hasExactKeys(value, ["intent", "commandIntent", "commandKey", "expectedVersions"])) return null;
  if (typeof value.commandKey !== "string" || !UUID_V4.test(value.commandKey)) return null;
  if (!validVersions(value.expectedVersions) || !validDraftIntent(value.intent)) return null;
  if (!validCommandIntent(value.commandIntent, value.expectedVersions)) return null;
  const rawCommandIntent = value.commandIntent as string;
  const rawIntent = value.intent as string;
  try {
    const parsedCommandIntent = JSON.parse(rawCommandIntent) as Record<string, unknown>;
    const draftIntent = { ...parsedCommandIntent };
    delete draftIntent.expectedVersions;
    if (JSON.stringify(draftIntent) !== rawIntent) return null;
  } catch {
    return null;
  }
  const intent = rawIntent;
  const commandIntent = rawCommandIntent;
  const commandKey = value.commandKey as string;
  return {
    intent,
    commandIntent,
    commandKey,
    expectedVersions: value.expectedVersions,
  };
}

function storageKey(actor: string) {
  return `${DIRECT_ENROLLMENT_PENDING_NAMESPACE}:v${DIRECT_ENROLLMENT_PENDING_SCHEMA}:${encodeURIComponent(actor.trim().toLocaleLowerCase())}`;
}

function boundedMap(entries: Iterable<DirectEnrollmentPendingCommand>) {
  const result = new Map<string, DirectEnrollmentPendingCommand>();
  for (const entry of entries) {
    result.delete(entry.intent);
    result.set(entry.intent, entry);
  }
  while (result.size > DIRECT_ENROLLMENT_PENDING_LIMIT) {
    const oldest = result.keys().next().value;
    if (typeof oldest !== "string") break;
    result.delete(oldest);
  }
  return result;
}

export function readDirectEnrollmentPendingCommands(
  storage: DirectEnrollmentPendingStorage | undefined,
  actor: string,
) {
  const result = new Map<string, DirectEnrollmentPendingCommand>();
  if (!storage || !actor.trim()) return result;
  const key = storageKey(actor);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return result;
    if (raw.length > DIRECT_ENROLLMENT_PENDING_MAX_TEXT * DIRECT_ENROLLMENT_PENDING_LIMIT) {
      storage.removeItem(key);
      return result;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !hasExactKeys(parsed, ["namespace", "schema", "entries"])
      || parsed.namespace !== DIRECT_ENROLLMENT_PENDING_NAMESPACE
      || parsed.schema !== DIRECT_ENROLLMENT_PENDING_SCHEMA
      || !Array.isArray(parsed.entries)
      || parsed.entries.length > DIRECT_ENROLLMENT_PENDING_LIMIT) {
      storage.removeItem(key);
      return result;
    }
    const entries = parsed.entries.map(parseStoredEntry);
    if (entries.some((entry) => entry === null)) {
      storage.removeItem(key);
      return result;
    }
    const validEntries = entries as DirectEnrollmentPendingCommand[];
    if (new Set(validEntries.map((entry) => entry.intent)).size !== validEntries.length
      || new Set(validEntries.map((entry) => entry.commandKey)).size !== validEntries.length) {
      storage.removeItem(key);
      return result;
    }
    return boundedMap(validEntries);
  } catch {
    return result;
  }
}

export function persistDirectEnrollmentPendingCommands(
  storage: DirectEnrollmentPendingStorage | undefined,
  actor: string,
  entries: Iterable<DirectEnrollmentPendingCommand>,
) {
  if (!storage || !actor.trim()) return;
  const input = Array.from(entries);
  if (input.some((entry) => parseStoredEntry(entry) === null)) return;
  const bounded = boundedMap(input);
  const payload = JSON.stringify({
    namespace: DIRECT_ENROLLMENT_PENDING_NAMESPACE,
    schema: DIRECT_ENROLLMENT_PENDING_SCHEMA,
    entries: Array.from(bounded.values()),
  });
  if (payload.length > DIRECT_ENROLLMENT_PENDING_MAX_TEXT * DIRECT_ENROLLMENT_PENDING_LIMIT) return;
  try {
    storage.setItem(storageKey(actor), payload);
  } catch {
    // The in-memory map still protects same-page retries when storage is blocked.
  }
}

export function upsertDirectEnrollmentPendingCommand(
  entries: Iterable<DirectEnrollmentPendingCommand>,
  entry: DirectEnrollmentPendingCommand,
) {
  return boundedMap([...entries, entry]);
}

export function removeDirectEnrollmentPendingCommand(
  entries: Iterable<DirectEnrollmentPendingCommand>,
  intent: string,
) {
  const next = new Map<string, DirectEnrollmentPendingCommand>();
  for (const entry of entries) {
    if (entry.intent !== intent) next.set(entry.intent, entry);
  }
  return next;
}

export function clearDirectEnrollmentPendingCommands(
  storage: DirectEnrollmentPendingStorage | undefined,
  actor: string,
) {
  if (!storage || !actor.trim()) return;
  try { storage.removeItem(storageKey(actor)); } catch { /* fail closed */ }
}
