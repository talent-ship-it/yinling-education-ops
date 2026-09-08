export const JIAOWUBAO_TRIAL_SYNC_PENDING_NAMESPACE = "insider-leads:jiaowubao-trial-sync" as const;
export const JIAOWUBAO_TRIAL_SYNC_PENDING_SCHEMA = 1 as const;
export const JIAOWUBAO_TRIAL_SYNC_MAX_MATCHES = 24;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SNAPSHOT_REVISION = /^sha256:[a-f0-9]{64}$/;
const LP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_STORAGE_BYTES = 32 * 1024;
const MAX_PENDING = 8;

export type JiaowubaoTrialSyncExpectedVersions = Readonly<{
  lpItems: number;
  tasks: number;
}>;

export type JiaowubaoTrialSyncWindow = Readonly<{
  startsAt: string;
  endsAt: string;
}>;

export type JiaowubaoTrialSyncMatchRef = Readonly<{
  lpItemId: string;
  eventId: string;
  startsAt: string;
}>;

export type JiaowubaoTrialSyncCommand = Readonly<{
  commandKey: string;
  snapshotRevision: string;
  window: JiaowubaoTrialSyncWindow;
  matches: readonly JiaowubaoTrialSyncMatchRef[];
  /** Missing future source events, re-proved by the server and database. */
  revocations?: readonly JiaowubaoTrialSyncMatchRef[];
  expectedVersions: JiaowubaoTrialSyncExpectedVersions;
}>;

export type JiaowubaoTrialSyncPendingCommand = JiaowubaoTrialSyncCommand & Readonly<{
  scope: string;
}>;

export type JiaowubaoTrialSyncStorage = Readonly<{
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}>;

export class JiaowubaoTrialSyncError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new JiaowubaoTrialSyncError("invalid_command", `${field} 包含未允许的字段。`);
  }
}

function canonicalInstant(value: unknown) {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value ? null : value;
}

function parseVersions(value: unknown): JiaowubaoTrialSyncExpectedVersions {
  if (!record(value)) throw new JiaowubaoTrialSyncError("invalid_command", "expectedVersions 必须是对象。");
  exactKeys(value, ["lpItems", "tasks"], "expectedVersions");
  if (!Number.isSafeInteger(value.lpItems) || Number(value.lpItems) < 1
    || !Number.isSafeInteger(value.tasks) || Number(value.tasks) < 1) {
    throw new JiaowubaoTrialSyncError("invalid_command", "试听同步版本号无效。");
  }
  return { lpItems: Number(value.lpItems), tasks: Number(value.tasks) };
}

function parseWindow(value: unknown): JiaowubaoTrialSyncWindow {
  if (!record(value)) throw new JiaowubaoTrialSyncError("invalid_command", "window 必须是对象。");
  exactKeys(value, ["startsAt", "endsAt"], "window");
  const startsAt = canonicalInstant(value.startsAt);
  const endsAt = canonicalInstant(value.endsAt);
  if (!startsAt || !endsAt) throw new JiaowubaoTrialSyncError("invalid_command", "试听同步窗口无效。");
  const duration = new Date(endsAt).valueOf() - new Date(startsAt).valueOf();
  if (duration <= 0 || duration > 32 * 24 * 60 * 60 * 1_000) {
    throw new JiaowubaoTrialSyncError("invalid_command", "试听同步窗口超出允许范围。");
  }
  return { startsAt, endsAt };
}

function parseMatches(value: unknown, allowEmpty = false, uniqueEvents = true): JiaowubaoTrialSyncMatchRef[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > JIAOWUBAO_TRIAL_SYNC_MAX_MATCHES) {
    throw new JiaowubaoTrialSyncError("invalid_command", "试听同步匹配数量无效。");
  }
  const matches = value.map((candidate) => {
    if (!record(candidate)) throw new JiaowubaoTrialSyncError("invalid_command", "试听同步匹配格式无效。");
    exactKeys(candidate, ["lpItemId", "eventId", "startsAt"], "match");
    const lpItemId = typeof candidate.lpItemId === "string" ? candidate.lpItemId.trim() : "";
    const eventId = typeof candidate.eventId === "string" ? candidate.eventId.trim() : "";
    const startsAt = canonicalInstant(candidate.startsAt);
    if (!LP_ID.test(lpItemId) || !EVENT_ID.test(eventId) || !startsAt) {
      throw new JiaowubaoTrialSyncError("invalid_command", "试听同步匹配身份或时间无效。");
    }
    return { lpItemId, eventId, startsAt };
  }).sort((left, right) => left.lpItemId.localeCompare(right.lpItemId) || left.eventId.localeCompare(right.eventId));
  if (new Set(matches.map((match) => match.lpItemId)).size !== matches.length
    || uniqueEvents && new Set(matches.map((match) => match.eventId)).size !== matches.length) {
    throw new JiaowubaoTrialSyncError("invalid_command", "同一 LP 或教务宝排课不能重复匹配。");
  }
  return matches;
}

export function parseJiaowubaoTrialSyncCommand(value: unknown): JiaowubaoTrialSyncCommand {
  if (!record(value)) throw new JiaowubaoTrialSyncError("invalid_command", "试听同步命令必须是对象。");
  exactKeys(value, ["commandKey", "snapshotRevision", "window", "matches", "expectedVersions", ...("revocations" in value ? ["revocations"] : [])], "command");
  const commandKey = typeof value.commandKey === "string" ? value.commandKey.trim().toLowerCase() : "";
  const snapshotRevision = typeof value.snapshotRevision === "string" ? value.snapshotRevision.trim() : "";
  if (!UUID_V4.test(commandKey)) throw new JiaowubaoTrialSyncError("invalid_command", "commandKey 必须是 UUID v4。");
  if (!SNAPSHOT_REVISION.test(snapshotRevision)) throw new JiaowubaoTrialSyncError("invalid_command", "教务宝快照版本无效。");
  const window = parseWindow(value.window);
  const revocations = "revocations" in value ? parseMatches(value.revocations, true, false) : undefined;
  const matches = parseMatches(value.matches, Boolean(revocations?.length));
  const references = [...matches, ...(revocations ?? [])];
  if (references.length > JIAOWUBAO_TRIAL_SYNC_MAX_MATCHES
    || new Set(references.map((reference) => reference.lpItemId)).size !== references.length) {
    throw new JiaowubaoTrialSyncError("invalid_command", "同一 LP 不能同时匹配和撤销，且批次不能超过上限。");
  }
  if (references.some((match) => match.startsAt < window.startsAt || match.startsAt >= window.endsAt)) {
    throw new JiaowubaoTrialSyncError("invalid_command", "试听匹配不在固定课表窗口内。");
  }
  return {
    commandKey,
    snapshotRevision,
    window,
    matches,
    ...(revocations ? { revocations } : {}),
    expectedVersions: parseVersions(value.expectedVersions),
  };
}

export function jiaowubaoTrialSyncIntent(command: JiaowubaoTrialSyncCommand) {
  return {
    snapshotRevision: command.snapshotRevision,
    window: command.window,
    matches: command.matches,
    ...(command.revocations ? { revocations: command.revocations } : {}),
    expectedVersions: command.expectedVersions,
  } as const;
}

export function jiaowubaoTrialSyncScope(input: Pick<JiaowubaoTrialSyncCommand, "snapshotRevision" | "window" | "matches" | "revocations">) {
  return JSON.stringify({ snapshotRevision: input.snapshotRevision, window: input.window, matches: input.matches,
    ...(input.revocations ? { revocations: input.revocations } : {}) });
}

/** Call only with a freshly read COMPLETE source window; absence is not proof outside it. */
export function jiaowubaoTrialMissingScheduleRefs(input: Readonly<{
  lpItems: readonly Readonly<{ id: string; workflowType?: string; stage?: string; trialSchedule?: unknown }>[];
  eventIds: ReadonlySet<string>;
  window: JiaowubaoTrialSyncWindow;
  now: Date;
}>) {
  const now = input.now.toISOString();
  return input.lpItems.flatMap((item): JiaowubaoTrialSyncMatchRef[] => {
    const schedule = item.trialSchedule;
    if (!["试听 LP", "换老师试听"].includes(item.workflowType ?? "") || item.stage === "完成"
      || !record(schedule) || schedule.source !== "jiaowubao-open-api"
      || typeof schedule.sourceRevision !== "string" || !SNAPSHOT_REVISION.test(schedule.sourceRevision)
      || typeof schedule.eventId !== "string" || !EVENT_ID.test(schedule.eventId)
      || !LP_ID.test(item.id)) return [];
    const startsAt = canonicalInstant(schedule.startsAt);
    if (!startsAt || startsAt <= now || startsAt < input.window.startsAt || startsAt >= input.window.endsAt
      || input.eventIds.has(schedule.eventId)) return [];
    return [{ lpItemId: item.id, eventId: schedule.eventId, startsAt }];
  }).sort((left, right) => left.lpItemId.localeCompare(right.lpItemId));
}

export function jiaowubaoTrialSyncPendingDisposition(input: Readonly<{
  status: number;
  committed: boolean;
  hasAuthoritativeRows: boolean;
}>) {
  if ([400, 403, 404, 409].includes(input.status)) return "clear" as const;
  return input.status >= 200 && input.status < 300 && input.committed && input.hasAuthoritativeRows
    ? "clear" as const
    : "retain" as const;
}

function storageKey(actor: string) {
  return `${JIAOWUBAO_TRIAL_SYNC_PENDING_NAMESPACE}:v${JIAOWUBAO_TRIAL_SYNC_PENDING_SCHEMA}:${encodeURIComponent(actor.trim().toLocaleLowerCase())}`;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function parsePending(value: unknown): JiaowubaoTrialSyncPendingCommand | null {
  if (!record(value)) return null;
  try {
    exactKeys(value, ["scope", "commandKey", "snapshotRevision", "window", "matches", "expectedVersions", ...("revocations" in value ? ["revocations"] : [])], "pending");
    if (typeof value.scope !== "string" || !value.scope || byteLength(value.scope) > 16 * 1024) return null;
    const command = parseJiaowubaoTrialSyncCommand({
      commandKey: value.commandKey,
      snapshotRevision: value.snapshotRevision,
      window: value.window,
      matches: value.matches,
      ...("revocations" in value ? { revocations: value.revocations } : {}),
      expectedVersions: value.expectedVersions,
    });
    if (value.scope !== jiaowubaoTrialSyncScope(command)) return null;
    return { scope: value.scope, ...command };
  } catch {
    return null;
  }
}

function bounded(entries: Iterable<JiaowubaoTrialSyncPendingCommand>) {
  const result = new Map<string, JiaowubaoTrialSyncPendingCommand>();
  for (const entry of entries) {
    const parsed = parsePending(entry);
    if (!parsed) continue;
    result.delete(parsed.scope);
    result.set(parsed.scope, parsed);
  }
  while (result.size > MAX_PENDING) result.delete(result.keys().next().value!);
  return result;
}

export function readJiaowubaoTrialSyncPendingCommands(storage: JiaowubaoTrialSyncStorage | undefined, actor: string) {
  const empty = new Map<string, JiaowubaoTrialSyncPendingCommand>();
  if (!storage || !actor.trim()) return empty;
  const key = storageKey(actor);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return empty;
    if (byteLength(raw) > MAX_STORAGE_BYTES) throw new Error("oversize");
    const parsed = JSON.parse(raw) as unknown;
    if (!record(parsed)) throw new Error("invalid");
    exactKeys(parsed, ["namespace", "schema", "entries"], "pending storage");
    if (parsed.namespace !== JIAOWUBAO_TRIAL_SYNC_PENDING_NAMESPACE
      || parsed.schema !== JIAOWUBAO_TRIAL_SYNC_PENDING_SCHEMA
      || !Array.isArray(parsed.entries)
      || parsed.entries.length > MAX_PENDING) throw new Error("invalid");
    const entries = parsed.entries.map(parsePending);
    if (entries.some((entry) => !entry)) throw new Error("invalid");
    const valid = entries as JiaowubaoTrialSyncPendingCommand[];
    if (new Set(valid.map((entry) => entry.scope)).size !== valid.length
      || new Set(valid.map((entry) => entry.commandKey)).size !== valid.length) throw new Error("invalid");
    return bounded(valid);
  } catch {
    try { storage.removeItem(key); } catch { /* unavailable storage stays empty */ }
    return empty;
  }
}

export function persistJiaowubaoTrialSyncPendingCommands(
  storage: JiaowubaoTrialSyncStorage | undefined,
  actor: string,
  entries: Iterable<JiaowubaoTrialSyncPendingCommand>,
) {
  if (!storage || !actor.trim()) return;
  const valid = bounded(entries);
  const payload = JSON.stringify({
    namespace: JIAOWUBAO_TRIAL_SYNC_PENDING_NAMESPACE,
    schema: JIAOWUBAO_TRIAL_SYNC_PENDING_SCHEMA,
    entries: [...valid.values()],
  });
  if (byteLength(payload) > MAX_STORAGE_BYTES) return;
  try {
    if (valid.size) storage.setItem(storageKey(actor), payload);
    else storage.removeItem(storageKey(actor));
  } catch { /* retry state is best-effort; the server remains idempotent */ }
}

export function upsertJiaowubaoTrialSyncPendingCommand(
  entries: Iterable<JiaowubaoTrialSyncPendingCommand>,
  entry: JiaowubaoTrialSyncPendingCommand,
) {
  return bounded([...entries, entry]);
}

export function removeJiaowubaoTrialSyncPendingCommand(
  entries: Iterable<JiaowubaoTrialSyncPendingCommand>,
  scope: string,
) {
  return bounded([...entries].filter((entry) => entry.scope !== scope));
}
