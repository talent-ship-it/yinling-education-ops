import type { AvaCalendarSnapshot, AvaCalendarWindow } from "./ava-calendar-snapshot";
import { validateAvaCalendarWindow } from "./ava-calendar-snapshot";
import type { OpsVersionRow } from "./ops-store";
import { JIAOWUBAO_AUTHORITY_SOURCE_ID, jiaowubaoAuthorityCadenceHealthy, parseJiaowubaoAuthorityStatus } from "./jiaowubao-authority-status";
import { localTimeToInstant } from "./teacher-availability";
import { shiftScheduleDate } from "./schedule-calendar";

export type AvaCalendarAvailabilitySnapshot = AvaCalendarSnapshot & Readonly<{
  sourceWindow?: Readonly<{ start: string; end: string }>;
  paginationComplete: boolean;
  invalidTimeEventCount: number;
}>;
export type AvaCalendarNativeVersions = Readonly<Record<"students" | "teachers" | "courses" | "bookings", number>>;
export type AvaCalendarHealthReason = "health_unavailable" | "source_incomplete" | "projection_pending" | "receipt_mismatch" | "native_version_mismatch";
export type AvaCalendarHealth =
  | Readonly<{ state: "not_ready"; reason: AvaCalendarHealthReason }>
  | Readonly<{
    state: "ready";
    revision: string;
    publishedAt: string;
    projectionRunId: string;
    nativeVersions: AvaCalendarNativeVersions;
    sourceWindow: Readonly<{ start: string; end: string }>;
    window: AvaCalendarWindow;
    evaluatedAt: string;
  }>;
export type AvaCalendarHealthInput = Readonly<{
  snapshot: AvaCalendarAvailabilitySnapshot;
  window: AvaCalendarWindow;
  target: unknown;
  sources: unknown;
  currentVersions: readonly Pick<OpsVersionRow, "entity" | "version">[];
  now: number;
}>;

class HealthFailure extends Error {
  constructor(readonly reason: AvaCalendarHealthReason) {
    super(reason);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseAvaCalendarInstant(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d{1,6}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match || /[+-]14:(?!00)/.test(match[3])) return null;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  const floor = Date.parse(value);
  if (!Number.isFinite(floor) || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== match[1]) return null;
  const remainder = Number((match[2] ?? "").padEnd(6, "0").slice(3));
  return { floor, ceil: floor + (remainder > 0 ? 1 : 0), microseconds: BigInt(floor) * BigInt(1000) + BigInt(remainder) };
}

function sameInstant(left: unknown, right: unknown) {
  const first = parseAvaCalendarInstant(left);
  const second = parseAvaCalendarInstant(right);
  return first !== null && second !== null && first.microseconds === second.microseconds;
}

function sameWindow(left: unknown, right: unknown) {
  const first = record(left);
  const second = record(right);
  return first !== null && second !== null && first.start === second.start && first.end === second.end;
}

function collectorComplete(snapshot: AvaCalendarAvailabilitySnapshot) {
  return snapshot && snapshot.freshness === "fresh" && snapshot.coverage === "complete" && snapshot.paginationComplete === true && snapshot.invalidTimeEventCount === 0;
}

function sourceCovered(input: AvaCalendarHealthInput) {
  const range = validateAvaCalendarWindow(input.window);
  const source = input.snapshot.sourceWindow;
  if (!source || typeof source.start !== "string" || typeof source.end !== "string" || source.end < source.start) return false;
  const start = localTimeToInstant(source.start, "00:00", "Australia/Melbourne", "earlier").valueOf();
  const end = localTimeToInstant(shiftScheduleDate(source.end, 1), "00:00", "Australia/Melbourne", "earlier").valueOf();
  return range.start >= start && range.end <= end;
}

function exactVersion(rows: AvaCalendarHealthInput["currentVersions"], receipt: Record<string, unknown>, entity: keyof AvaCalendarNativeVersions) {
  const matches = rows.filter((row) => record(row)?.entity === entity);
  const value = matches[0]?.version;
  return matches.length === 1 && Number.isSafeInteger(value) && value! >= 0 && Number.isSafeInteger(receipt[entity]) && receipt[entity] === value ? value! : null;
}

function exactNativeVersions(rows: AvaCalendarHealthInput["currentVersions"], expected: unknown): AvaCalendarNativeVersions | null {
  if (!Array.isArray(rows)) return null;
  const receipt = record(expected);
  if (!receipt) return null;
  const versions: Partial<Record<keyof AvaCalendarNativeVersions, number>> = {};
  for (const entity of ["students", "teachers", "courses", "bookings"] as const) {
    const value = exactVersion(rows, receipt, entity);
    if (value === null) return null;
    versions[entity] = value;
  }
  return versions as AvaCalendarNativeVersions;
}

function projectionTarget(value: unknown) {
  const target = record(value);
  if (!target || target.state !== "ready" || !["pending", "authority_done", "complete"].includes(target.projectionState as string)) throw new HealthFailure("health_unavailable");
  if (target.projectionState !== "complete") throw new HealthFailure("projection_pending");
  return target;
}

function authoritySource(sources: unknown, now: number) {
  if (!Array.isArray(sources)) throw new HealthFailure("health_unavailable");
  const matches = sources.filter((source) => record(source)?.source_id === JIAOWUBAO_AUTHORITY_SOURCE_ID);
  if (matches.length !== 1) throw new HealthFailure("health_unavailable");
  const source = record(matches[0])!;
  const payload = record(source.payload)!;
  const status = parseJiaowubaoAuthorityStatus(source);
  if (!status || status.coverage.nativeRecordsSynchronized !== true || !Number.isFinite(now) || !jiaowubaoAuthorityCadenceHealthy(status, now)) throw new HealthFailure("health_unavailable");
  if (![source.synced_at, payload.snapshotChangedAt, payload.checkedAt, payload.projectedAt].every((value) => parseAvaCalendarInstant(value))) throw new HealthFailure("health_unavailable");
  return { payload, status };
}

function revisionMatches(snapshot: AvaCalendarAvailabilitySnapshot, projection: Record<string, unknown>, payload: Record<string, unknown>, nativeApply: Record<string, unknown>) {
  return typeof snapshot.revision === "string" && /^sha256:[a-f0-9]{64}$/.test(snapshot.revision)
    && projection.revision === snapshot.revision && payload.snapshotRevision === snapshot.revision && nativeApply.snapshotRevision === snapshot.revision
    && nativeApply.schemaVersion === 1 && nativeApply.projectionRunId === payload.projectionRunId;
}

function publicationMatches(snapshot: AvaCalendarAvailabilitySnapshot, projection: Record<string, unknown>, payload: Record<string, unknown>) {
  return sameInstant(projection.publishedAt, snapshot.publishedAt) && sameInstant(payload.snapshotPublishedAt, snapshot.publishedAt)
    && sameWindow(projection.window, snapshot.sourceWindow) && sameWindow(payload.sourceWindow, snapshot.sourceWindow)
    && projection.rowCount === record(payload.coverage)?.snapshotRows;
}

function projectionHealth(input: AvaCalendarHealthInput): AvaCalendarHealth {
  const { snapshot, now } = input;
  if (!collectorComplete(snapshot)) throw new HealthFailure("source_incomplete");
  const projection = projectionTarget(input.target);
  const { payload, status } = authoritySource(input.sources, now);
  const nativeApply = record(payload.nativeApply);
  if (!nativeApply || !revisionMatches(snapshot, projection, payload, nativeApply) || !publicationMatches(snapshot, projection, payload)) throw new HealthFailure("receipt_mismatch");
  if (!sourceCovered(input)) throw new HealthFailure("source_incomplete");
  const nativeVersions = exactNativeVersions(input.currentVersions, nativeApply.nativeStateVersions);
  if (!nativeVersions) throw new HealthFailure("native_version_mismatch");
  const sourceWindow = { start: snapshot.sourceWindow!.start, end: snapshot.sourceWindow!.end };
  return { state: "ready", revision: snapshot.revision, publishedAt: snapshot.publishedAt, projectionRunId: status.projectionRunId, nativeVersions, sourceWindow, window: { start: input.window.start, end: input.window.end }, evaluatedAt: new Date(now).toISOString() };
}

export function evaluateAvaCalendarHealth(input: AvaCalendarHealthInput): AvaCalendarHealth {
  try {
    return projectionHealth(input);
  } catch (error) {
    return { state: "not_ready", reason: error instanceof HealthFailure ? error.reason : "health_unavailable" };
  }
}
