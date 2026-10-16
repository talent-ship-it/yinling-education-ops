import type { AvaCalendarAvailabilitySnapshot } from "./ava-calendar-health";
import { parseAvaCalendarInstant } from "./ava-calendar-health";
import type { AvaCalendarWindow } from "./ava-calendar-snapshot";
import { localTimeToInstant } from "./teacher-availability";
import { shiftScheduleDate } from "./schedule-calendar";

export type AvaCalendarSync = { state: "fresh" | "stale" | "sync_failed" | "unknown"; lastSuccessAt: string | null; staleAfterMinutes: number };
export type AvaCalendarDisplay = { canSubtract: boolean; evaluatedAt: string; sync: AvaCalendarSync };
const STALE_AFTER_MINUTES = 90;
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function successfulTime(value: unknown, now: number) {
  const instant = parseAvaCalendarInstant(value);
  return instant && instant.floor <= now + 300000 ? new Date(instant.floor).toISOString() : null;
}
function syncSource(sources: unknown) {
  const matches = Array.isArray(sources) ? sources.filter((source) => record(source)?.source_id === "jiaowubao-open-api-schedule") : [];
  return matches.length === 1 ? record(matches[0]) : null;
}
function snapshotExpired(snapshot: AvaCalendarAvailabilitySnapshot, lastSuccessAt: string | null, now: number) {
  return snapshot.freshness === "stale" || !lastSuccessAt || now - Date.parse(lastSuccessAt) >= STALE_AFTER_MINUTES * 60000;
}
function syncStatus(source: Record<string, unknown> | null, expired: boolean): AvaCalendarSync["state"] {
  if (expired) return "stale";
  if (!source) return "unknown";
  return source.status === "synced" ? "fresh" : "sync_failed";
}
function syncState(snapshot: AvaCalendarAvailabilitySnapshot, sources: unknown, now: number): AvaCalendarSync {
  const source = syncSource(sources);
  const lastSuccessAt = successfulTime(source?.synced_at, now) ?? successfulTime(snapshot.publishedAt, now);
  return { state: syncStatus(source, snapshotExpired(snapshot, lastSuccessAt, now)), lastSuccessAt, staleAfterMinutes: STALE_AFTER_MINUTES };
}
function covered(snapshot: AvaCalendarAvailabilitySnapshot, window: AvaCalendarWindow) {
  if (!snapshot.sourceWindow) return false;
  const start = localTimeToInstant(snapshot.sourceWindow.start, "00:00", "Australia/Melbourne", "earlier").valueOf();
  const end = localTimeToInstant(shiftScheduleDate(snapshot.sourceWindow.end, 1), "00:00", "Australia/Melbourne", "earlier").valueOf();
  return Date.parse(window.start) >= start && Date.parse(window.end) <= end;
}
export function evaluateAvaCalendarDisplay(snapshot: AvaCalendarAvailabilitySnapshot, window: AvaCalendarWindow, sources: unknown, now: number): AvaCalendarDisplay {
  const canSubtract = Number.isFinite(now) && snapshot.coverage === "complete" && snapshot.paginationComplete === true && snapshot.invalidTimeEventCount === 0
    && ["fresh", "stale"].includes(snapshot.freshness) && /^sha256:[a-f0-9]{64}$/.test(snapshot.revision) && successfulTime(snapshot.publishedAt, now) !== null && covered(snapshot, window);
  return { canSubtract, evaluatedAt: new Date(now).toISOString(), sync: syncState(snapshot, sources, now) };
}
