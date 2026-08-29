import {
  JIAOWUBAO_TRIAL_SYNC_MAX_MATCHES,
  jiaowubaoTrialSyncIntent,
  type JiaowubaoTrialSyncCommand,
  type JiaowubaoTrialSyncMatchRef,
  type JiaowubaoTrialSyncWindow,
} from "./jiaowubao-trial-sync";
import { prepareJiaowubaoTrialSyncProjection } from "./jiaowubao-trial-sync-projection";
import type {
  JiaowubaoOpenApiScheduleSnapshotWindow,
  JiaowubaoTrialSyncCommitResult,
  OpsStateRow,
} from "./ops-store";

const AUTHORITY_ENTITIES = ["bookings", "students", "teachers", "lpItems", "tasks"] as const;
const MELBOURNE_TIME_ZONE = "Australia/Melbourne";
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

type RawScheduleEvent = JiaowubaoOpenApiScheduleSnapshotWindow["events"][number];

export class JiaowubaoTrialAutoSyncError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

function zonedParts(value: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

function localMidnight(date: string, timeZone: string) {
  if (!DATE.test(date)) throw new TypeError("source window date is invalid");
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const adjustment = target - actualUtc;
    candidate += adjustment;
    if (!adjustment) break;
  }
  const result = new Date(candidate);
  const roundTrip = zonedParts(result, timeZone);
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day
    || roundTrip.hour !== 0 || roundTrip.minute !== 0) {
    throw new TypeError("source window timezone boundary is invalid");
  }
  return result;
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf())) throw new TypeError("source window date is invalid");
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Converts the snapshot's inclusive Melbourne dates to an exact UTC interval. */
export function jiaowubaoTrialProjectionWindow(
  sourceWindow: Readonly<{ start: string; end: string }>,
): JiaowubaoTrialSyncWindow {
  const startsAt = localMidnight(sourceWindow.start, MELBOURNE_TIME_ZONE).toISOString();
  const endsAt = localMidnight(addDays(sourceWindow.end, 1), MELBOURNE_TIME_ZONE).toISOString();
  const duration = new Date(endsAt).valueOf() - new Date(startsAt).valueOf();
  if (duration <= 0 || duration > 32 * 24 * 60 * 60 * 1_000) {
    throw new TypeError("source window duration is invalid");
  }
  return { startsAt, endsAt };
}

function stateRow(rows: readonly OpsStateRow[], entity: "lpItems" | "tasks") {
  const row = rows.find((candidate) => candidate.entity === entity);
  if (!row || !Array.isArray(row.payload) || !Number.isSafeInteger(row.version) || row.version < 1) {
    throw new JiaowubaoTrialAutoSyncError(`${entity} authority unavailable`, "invalid_shared_state");
  }
  return row;
}

function chunks<T>(items: readonly T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function samePayload(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function retryableConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Readonly<{ code?: unknown; message?: unknown }>;
  return candidate.code === "40001" || candidate.message === "version_conflict";
}

export type JiaowubaoTrialAutoSyncDependencies = Readonly<{
  getRows: (entities: string[]) => Promise<OpsStateRow[]>;
  readSource: (
    snapshotRevision: string,
    window: JiaowubaoTrialSyncWindow,
  ) => Promise<readonly RawScheduleEvent[]>;
  commit: (input: Readonly<{
    commandKey: string;
    commandIntent: Readonly<Record<string, unknown>>;
    snapshotRevision: string;
    matches: readonly JiaowubaoTrialSyncMatchRef[];
    expectedVersions: Readonly<{ lpItems: number; tasks: number }>;
    nextLpItems: readonly unknown[];
    nextTasks: readonly unknown[];
    actor: string;
  }>) => Promise<readonly JiaowubaoTrialSyncCommitResult[]>;
  uuid: () => string;
  now: () => Date;
}>;

export type JiaowubaoTrialAutoSyncResult = Readonly<{
  outcome: "no_match" | "no_change" | "applied";
  matchedCount: number;
  appliedCount: number;
  batchCount: number;
}>;

/** Reconciles every unambiguous trial match from one immutable source snapshot. */
export async function runJiaowubaoTrialAutoSyncCore(
  input: Readonly<{
    snapshotRevision: string;
    window: JiaowubaoTrialSyncWindow;
    actor?: "Ops Admin";
  }>,
  dependencies: JiaowubaoTrialAutoSyncDependencies,
): Promise<JiaowubaoTrialAutoSyncResult> {
  const actor = input.actor ?? "Ops Admin";
  const rawEvents = await dependencies.readSource(input.snapshotRevision, input.window);
  const discoveryRows = await dependencies.getRows([...AUTHORITY_ENTITIES]);
  const discovered = prepareJiaowubaoTrialSyncProjection({
    rows: discoveryRows,
    rawEvents,
    snapshotRevision: input.snapshotRevision,
    matchedAt: dependencies.now(),
  });
  const references = discovered.references;
  if (!references.length) return { outcome: "no_match", matchedCount: 0, appliedCount: 0, batchCount: 0 };

  let appliedCount = 0;
  let batchCount = 0;
  for (const matches of chunks<JiaowubaoTrialSyncMatchRef>(references, JIAOWUBAO_TRIAL_SYNC_MAX_MATCHES)) {
    let batchFinished = false;
    for (let attempt = 0; attempt < 3 && !batchFinished; attempt += 1) {
      const rows = await dependencies.getRows([...AUTHORITY_ENTITIES]);
      const lpRow = stateRow(rows, "lpItems");
      const tasksRow = stateRow(rows, "tasks");
      const projection = prepareJiaowubaoTrialSyncProjection({
        rows,
        references: matches,
        rawEvents,
        snapshotRevision: input.snapshotRevision,
        matchedAt: dependencies.now(),
      });
      if (samePayload(lpRow.payload, projection.nextLpItems)
        && samePayload(tasksRow.payload, projection.nextTasks)) {
        batchFinished = true;
        continue;
      }

      const command: JiaowubaoTrialSyncCommand = {
        commandKey: dependencies.uuid(),
        snapshotRevision: input.snapshotRevision,
        window: input.window,
        matches,
        expectedVersions: { lpItems: lpRow.version, tasks: tasksRow.version },
      };
      try {
        const saved = await dependencies.commit({
          commandKey: command.commandKey,
          commandIntent: jiaowubaoTrialSyncIntent(command),
          snapshotRevision: command.snapshotRevision,
          matches: command.matches,
          expectedVersions: command.expectedVersions,
          nextLpItems: projection.nextLpItems,
          nextTasks: projection.nextTasks,
          actor,
        });
        if (saved.length !== 1 || !saved[0]?.lp_items_row || !saved[0]?.tasks_row) {
          throw new JiaowubaoTrialAutoSyncError("trial auto-sync receipt incomplete", "invalid_commit_result");
        }
        batchCount += 1;
        if (saved[0].applied) appliedCount += projection.references.length;
        batchFinished = true;
      } catch (error) {
        if (attempt < 2 && retryableConflict(error)) continue;
        throw error;
      }
    }
    if (!batchFinished) {
      throw new JiaowubaoTrialAutoSyncError("trial auto-sync version conflict", "40001");
    }
  }

  return {
    outcome: appliedCount ? "applied" : "no_change",
    matchedCount: references.length,
    appliedCount,
    batchCount,
  };
}
